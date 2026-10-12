#!/usr/bin/env python3
"""Scope B prepared controller: no native/GUI SDK, no launch without fresh owner grant."""
import argparse,hashlib,json,math,os,pathlib,signal,stat,subprocess,sys,tempfile,time
SCHEMA_SHA='2a7043f4d1400ba964fe896ce19241bccc7c1765e64bd9b94696899e535a2ceb'
PRODUCT='8b667c345ef2f50f57a94aa91d3bdc4e4ec4f28e'
def digest(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def number(v):
    if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v): raise ValueError('invalid clock')
    return v
def admission(a,utc):
    number(utc)
    if a.get('executionAuthorized') is not True or a.get('productSource')!=PRODUCT or a.get('scope')!='B-actual-paired-ws-synthetic-capture' or not a.get('slotId'): raise ValueError('exact B admission required')
    if not number(a.get('startEpoch'))<=utc or number(a.get('endEpoch'))-utc<120: raise ValueError('slot expired/short')
    for key in ['nodeSha256','censusSha256','supervisorSha256','manifestSha256']:
        v=a.get(key)
        if not isinstance(v,str) or len(v)!=64 or any(c not in '0123456789abcdef' for c in v): raise ValueError('missing pin '+key)
    for key in ['node','census','supervisor']:
        p=a.get(key)
        if not isinstance(p,str) or not p.startswith('/') or os.path.normpath(p)!=p: raise ValueError('absolute pinned executable')
    if not isinstance(a.get('nodeVersion'),str) or not a['nodeVersion'].startswith('v24.'): raise ValueError('Node24 version required')
def budget(deadline,now,reserve=15):
    value=number(deadline)-number(now)-reserve
    if value<10: raise ValueError('insufficient common budget')
    return min(60,value)
def census(value,nonce,utc):
    if value.get('nonce')!=nonce or value.get('runtimeQualified') is not True or value.get('clear') is not True or value.get('conflicts')!=[] or value.get('ownedRemaining')!=[] or not 0<=number(utc)-number(value.get('observedEpoch'))<=2: raise ValueError('unqualified/stale/contested census')
def census_command(a,policy,nonce,owned_pgid=None):
    args=[sys.executable,'-I',a['census'],'--nonce',nonce,'--policy',str(policy)]
    if owned_pgid is not None: args += ['--owned-pgid',str(owned_pgid)]
    return args
def leader_exited(pid): return os.waitid(os.P_PID,pid,os.WEXITED|os.WNOWAIT|os.WNOHANG) is not None
def cleanup(proc,deadline):
    # The held anchor is required to be live at EACH signal, not merely unreaped.
    for sig in [signal.SIGTERM,signal.SIGKILL]:
        if leader_exited(proc.pid): raise ValueError('owned live anchor exited before cleanup')
        if os.getpgid(proc.pid)!=proc.pid: raise ValueError('owned group identity lost')
        try: os.killpg(proc.pid,sig)
        except ProcessLookupError: pass
        if sig==signal.SIGTERM:
            end=min(deadline,time.monotonic()+1)
            while time.monotonic()<end and not leader_exited(proc.pid): time.sleep(.02)
    code=proc.wait(timeout=2)
    if proc.stdin is not None: proc.stdin.close()
    return code
def child_receipt(path,anchor):
    if path.resolve()!=path: raise ValueError('untrusted child receipt path')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_size>2048: raise ValueError('untrusted child receipt file')
        raw=os.read(fd,2049)
        if len(raw)>2048: raise ValueError('oversized child receipt')
        value=json.loads(raw)
    finally: os.close(fd)
    if not isinstance(value,dict): raise ValueError('invalid child receipt object')
    if value.get('anchorPID')!=anchor or value.get('pgid')!=anchor: raise ValueError('unowned child receipt')
    pid=value.get('childPID');code=value.get('childExit')
    if isinstance(pid,bool) or not isinstance(pid,int) or pid<=1 or pid==anchor or isinstance(code,bool) or not isinstance(code,int): raise ValueError('invalid child receipt')
    return value
def supervisor_command(a,status,seconds,payload):
    return [sys.executable,'-I',a['supervisor'],'--receipt',str(status),'--hold-seconds',str(seconds+5),a['node'],str(payload/'app/fixture.mjs')]
def scratch(root):
    total=0
    for p in root.rglob('*'):
        if p.is_symlink(): raise ValueError('unexpected scratch symlink')
        if p.is_file(): total+=p.stat().st_size
        if total>256*1024*1024: raise ValueError('scratch256MiB exceeded')
    return total
def verify_payload(payload,a):
    if not payload.is_absolute() or payload.resolve()!=payload: raise ValueError('payload origin')
    if digest(payload/'manifest.json')!=a['manifestSha256']: raise ValueError('manifest mismatch')
    manifest=json.loads((payload/'manifest.json').read_text())
    if set(manifest)!=set(['app/fixture.mjs','collector.mjs','schema.json']): raise ValueError('manifest file set')
    for name,sha in manifest.items():
        file=payload/name
        if file.resolve()!=file or digest(file)!=sha: raise ValueError('payload mismatch')
    if digest(payload/'schema.json')!=SCHEMA_SHA: raise ValueError('protocol schema source mismatch')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--admission',required=True);parser.add_argument('--payload',required=True);args=parser.parse_args();root=None;proc=None;a=None
    start=time.monotonic();deadline=start+75;r={'scope':'B-actual-paired-ws-synthetic-capture','outerExit':1,'childExit':None,'launched':False,'fixtureLaunchConfirmed':False}
    try:
        if not sys.flags.isolated or not hasattr(os,'WNOWAIT'): raise ValueError('absolute Python -I/WNOWAIT required')
        p=pathlib.Path(args.admission);info=p.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077: raise ValueError('own regular0600 admission')
        a=json.loads(p.read_text());admission(a,time.time());payload=pathlib.Path(args.payload)
        verify_payload(payload,a)
        for key in ['node','census','supervisor']:
            if digest(a[key])!=a[key+'Sha256']: raise ValueError('binary pin mismatch')
        v=subprocess.run([a['node'],'--version'],capture_output=True,text=True,timeout=2)
        if v.returncode or v.stdout.strip()!=a['nodeVersion']: raise ValueError('Node version mismatch')
        nonce=os.urandom(16).hex();c=subprocess.run(census_command(a,p,nonce),capture_output=True,text=True,timeout=3);r['preCensus']={'exit':c.returncode,'output':c.stdout}
        if c.returncode: raise ValueError('pre-census failed')
        census(json.loads(c.stdout),nonce,time.time())
        root=pathlib.Path(tempfile.mkdtemp(prefix='paired-ws-B-',dir='/tmp')).resolve();os.chmod(root,0o700);(root/'runtime.json').write_text(json.dumps(a));os.chmod(root/'runtime.json',0o600)
        env={k:v for k,v in os.environ.items() if k not in ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE']};env.update(PRIVATE_PAIRED_WS_ROOT=str(root),SURF_ACE_CLIENT_DIAGNOSTIC_LOG=str(root/'flight.log'))
        # Final gate after all preflight/root work; retain cleanup, collector, census and persistence reserve.
        admission(a,time.time());seconds=budget(deadline,time.monotonic())
        with (root/'fixture.log').open('wb') as log:
            status=root/'child-receipt.json'
            proc=subprocess.Popen(supervisor_command(a,status,seconds,payload),env=env,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);r.update(launched=True,pid=proc.pid,pgid=proc.pid,root=str(root));until=min(deadline-15,time.monotonic()+seconds)
            while time.monotonic()<until and not status.exists() and not leader_exited(proc.pid): scratch(root);time.sleep(.02)
            if status.exists():
                value=child_receipt(status,proc.pid);r.update(childExit=value['childExit'],fixturePID=value['childPID'],fixtureLaunchConfirmed=True)
            r['anchorExit']=cleanup(proc,min(deadline-10,time.monotonic()+2));proc=None
        if r['childExit']!=0: raise ValueError('fixture failed')
        budget(deadline,time.monotonic(),reserve=5);v=subprocess.run([a['node'],str(payload/'collector.mjs'),str(root)],capture_output=True,text=True,timeout=min(3,deadline-time.monotonic()-5));r['collector']={'exit':v.returncode,'stdout':v.stdout,'stderr':v.stderr}
        if v.returncode: raise ValueError('collector refused')
        r.update(outerExit=0,scratchBytes=scratch(root),resultSha256=digest(root/'fixture-result.json'))
    except Exception as e: r['error']=str(e)
    finally:
        if proc is not None:
            try: r['anchorExit']=cleanup(proc,min(deadline-5,time.monotonic()+2))
            except Exception as e: r['cleanupError']=str(e)
        if r['launched']:
            try:
                if deadline-time.monotonic()<3: raise ValueError('final census reserve exhausted')
                nonce=os.urandom(16).hex();c=subprocess.run(census_command(a,p,nonce,r['pgid']),capture_output=True,text=True,timeout=3);r['postCensus']={'exit':c.returncode,'output':c.stdout}
                if c.returncode: raise ValueError('final census failed')
                census(json.loads(c.stdout),nonce,time.time())
            except Exception as e: r['outerExit']=1;r['censusError']=str(e)
        r['elapsedSeconds']=time.monotonic()-start
        if root is not None: (root/'controller-receipt.json').write_text(json.dumps(r,indent=2))
        print(json.dumps(r));return r['outerExit']
if __name__=='__main__': sys.exit(main())
