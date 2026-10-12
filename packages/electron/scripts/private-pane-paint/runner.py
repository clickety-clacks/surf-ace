#!/usr/bin/env python3
"""Prepared private Mac controller. No launch without an exact new owner admission."""
import argparse,datetime,hashlib,json,os,pathlib,signal,stat,subprocess,sys,tempfile,time
PRODUCT='6212cff8c99ffaecac5934bb14adb41676cf0c09'
def digest(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def remaining(deadline,now,reserve=15):
    value=deadline-now-reserve
    if value<10: raise ValueError('insufficient common deadline reserve')
    return min(60,value)
def validate_admission(a,utc):
    if a.get('executionAuthorized') is not True or a.get('productSource')!=PRODUCT: raise ValueError('no exact execution admission')
    if not a.get('slotId') or a.get('consoleUser')!='mike': raise ValueError('slot/console identity')
    if not isinstance(a.get('startEpoch'),(float,int)) or not isinstance(a.get('endEpoch'),(float,int)) or not a['startEpoch']<=utc or a['endEpoch']-utc<120: raise ValueError('expired/short slot')
    for key in ['manifestSha256','electronSha256','censusSha256','nodeSha256']:
        v=a.get(key)
        if not isinstance(v,str) or len(v)!=64 or any(c not in '0123456789abcdef' for c in v): raise ValueError('missing exact pin '+key)
    for key in ['electron','census']:
        p=a.get(key,'')
        if not isinstance(p,str) or not p.startswith('/private/tmp/') or os.path.normpath(p)!=p: raise ValueError('private executable path required')
    if not isinstance(a.get('node'),str) or not a['node'].startswith('/opt/homebrew/') or os.path.normpath(a['node'])!=a['node']: raise ValueError('pinned Node interpreter required')
    if not isinstance(a.get('electronVersion'),str) or not a['electronVersion'].startswith('42.'): raise ValueError('SDK version')
def census_receipt(value,nonce,utc):
    if value.get('nonce')!=nonce or value.get('runtimeQualified') is not True or value.get('clear') is not True: raise ValueError('unqualified/contested census')
    seen=value.get('observedEpoch')
    if not isinstance(seen,(int,float)) or not 0<=utc-seen<=2: raise ValueError('stale census')
    if value.get('conflicts')!=[] or value.get('ownedRemaining')!=[]: raise ValueError('census not empty')
def leader_exited(pid):
    # Never reap the stable process-group leader before the last cleanup signal.
    return os.waitid(os.P_PID,pid,os.WEXITED|os.WNOWAIT|os.WNOHANG) is not None
def scratch_size(root):
    size=0
    for p in pathlib.Path(root).rglob('*'):
        if p.is_symlink():
            size+=p.lstat().st_size
            continue  # account for the link itself; never follow SDK singleton links outside private scratch
        if p.is_file(): size+=p.stat().st_size
        if size>256*1024*1024: raise ValueError('scratch exceeds256MiB')
    return size
def control_group(proc,deadline):
    while time.monotonic()<deadline and not leader_exited(proc.pid): time.sleep(.02)
    exited=leader_exited(proc.pid)
    # The Popen-created, unreaped session leader anchors PGID lifetime through these signals.
    if os.getpgid(proc.pid)!=proc.pid: raise ValueError('owned session identity lost')
    try: os.killpg(proc.pid,signal.SIGTERM)
    except ProcessLookupError: pass
    end=min(deadline+2,time.monotonic()+2)
    while time.monotonic()<end and not leader_exited(proc.pid): time.sleep(.02)
    # The leader is still unreaped even when it has exited; do not signal a saved numeric PGID after wait().
    try: os.killpg(proc.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    code=proc.wait(timeout=2)
    return code,exited
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--admission',required=True);parser.add_argument('--payload',required=True);args=parser.parse_args()
    root=None;proc=None;a=None;receipt={'productSource':PRODUCT,'outerExit':1,'childExit':None,'launched':False,'phase':'preflight'};start=time.monotonic();deadline=start+75
    try:
        if sys.platform!='darwin' or not sys.flags.isolated or not hasattr(os,'WNOWAIT'): raise ValueError('absolute Mac Python -I/WNOWAIT required')
        admission_path=pathlib.Path(args.admission)
        info=admission_path.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077: raise ValueError('admission must be own regular0600 file')
        a=json.loads(admission_path.read_text());validate_admission(a,time.time())
        payload=pathlib.Path(args.payload)
        if not payload.is_absolute() or payload.resolve()!=payload: raise ValueError('payload provenance')
        manifest=payload/'manifest.json'
        if digest(manifest)!=a['manifestSha256']: raise ValueError('manifest mismatch')
        for name,sha in json.loads(manifest.read_text()).items():
            p=payload/name
            if pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts or p.is_symlink() or p.resolve()!=p or not p.resolve().is_relative_to(payload) or not p.is_file() or digest(p)!=sha: raise ValueError('payload mismatch '+name)
        for name in ['electron','census','node']:
            if digest(a[name])!=a[name+'Sha256']: raise ValueError('executable mismatch '+name)
        for name,sha in a.get('frameworkPins',{}).items():
            if digest(name)!=sha: raise ValueError('framework mismatch')
        if not a.get('frameworkPins'): raise ValueError('framework pins missing')
        check=subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(pathlib.Path(a['electron']).parents[2])],capture_output=True,text=True,timeout=5)
        receipt['codesign']={'exit':check.returncode,'stderr':check.stderr[-4000:]}
        if check.returncode: raise ValueError('strict SDK verification failed; no signing/security modification')
        console=subprocess.run(['/usr/bin/stat','-f','%Su','/dev/console'],capture_output=True,text=True,timeout=2)
        if console.returncode or console.stdout.strip()!='mike': raise ValueError('Aqua console not mike')
        nonce=os.urandom(16).hex()
        c=subprocess.run([a['census'],'--nonce',nonce],capture_output=True,text=True,timeout=3);receipt['preCensus']={'exit':c.returncode,'output':c.stdout[-10000:]}
        if c.returncode: raise ValueError('census command failed')
        census_receipt(json.loads(c.stdout),nonce,time.time())
        root=pathlib.Path(tempfile.mkdtemp(prefix='private-pane-paint-',dir='/private/tmp')).resolve();os.chmod(root,0o700)
        runtime={**a,'root':str(root)};(root/'runtime.json').write_text(json.dumps(runtime));os.chmod(root/'runtime.json',0o600)
        env={k:v for k,v in os.environ.items() if k not in ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH']};env.update({'PRIVATE_PANE_PAINT_ROOT':str(root),'SURF_ACE_CLIENT_DIAGNOSTIC_LOG':str(root/'flight.log')})
        seconds=remaining(deadline,time.monotonic());validate_admission(a,time.time())
        # Last budget gate follows all pin/census/root work, immediately before Popen.
        with (root/'fixture.log').open('wb') as log:
            proc=subprocess.Popen([a['electron'],'--user-data-dir='+str(root/'profile'),str(payload/'app')],stdout=log,stderr=subprocess.STDOUT,env=env,start_new_session=True);receipt.update(launched=True,phase='fixture',pid=proc.pid,pgid=proc.pid,root=str(root))
            until=min(deadline-15,time.monotonic()+seconds)
            while time.monotonic()<until and not leader_exited(proc.pid): scratch_size(root);time.sleep(.03)
            code,natural=control_group(proc,until);receipt.update(childExit=code,naturalExit=natural);proc=None
        remaining(deadline,time.monotonic(),reserve=0)
        f=root/'fixture-result.json'
        if receipt['childExit']!=0 or not f.is_file(): raise ValueError('fixture failed or result absent')
        result=json.loads(f.read_text())
        if result.get('exit')!=0 or result.get('productSource')!=PRODUCT or result.get('forbiddenRequests')!=[] or len(result.get('phases',[]))!=9 or not all(p.get('pass') is True for p in result['phases']): raise ValueError('incomplete fixture evidence')
        validation=subprocess.run([a['node'],str(payload/'collector.mjs'),str(root)],capture_output=True,text=True,timeout=min(3,deadline-time.monotonic()));receipt['collector']={'exit':validation.returncode,'stdout':validation.stdout[-2000:],'stderr':validation.stderr[-2000:]}
        if validation.returncode: raise ValueError('raw-image/phase collector failed')
        receipt.update(outerExit=0,phase='complete',scratchBytes=scratch_size(root),fixtureResultSha256=digest(f))
    except Exception as e: receipt['error']=str(e)
    finally:
        if proc is not None:
            try: receipt['childExit'],receipt['naturalExit']=control_group(proc,min(deadline-5,time.monotonic()+1))
            except Exception as e: receipt['cleanupError']=str(e)
        if receipt['launched'] and a is not None:
            try:
                if deadline-time.monotonic()<3: raise ValueError('final census deadline exhausted')
                nonce=os.urandom(16).hex();c=subprocess.run([a['census'],'--nonce',nonce],capture_output=True,text=True,timeout=min(3,deadline-time.monotonic()));receipt['postCensus']={'exit':c.returncode,'output':c.stdout[-10000:]}
                if c.returncode: raise ValueError('post-census failed')
                census_receipt(json.loads(c.stdout),nonce,time.time())
            except Exception as e: receipt['outerExit']=1;receipt['censusError']=str(e)
        receipt['elapsedSeconds']=time.monotonic()-start
        # Only the controller-created root is writable; a rejected root/admission never receives evidence.
        if root is not None: (root/'controller-receipt.json').write_text(json.dumps(receipt,indent=2))
        print(json.dumps(receipt));return receipt['outerExit']
if __name__=='__main__': sys.exit(main())
