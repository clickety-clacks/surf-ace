#!/usr/bin/env python3
"""Private native-runtime/Rust-CLI business integration; never connects to production."""
import json, os, re, signal, socket, struct, subprocess, sys, threading, time, traceback
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[3]
DEVICE=sys.argv[2]
REV=sys.argv[1]
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=SOURCE,text=True).strip()==REV
assert not subprocess.check_output(['git','status','--porcelain'],cwd=SOURCE,text=True).strip()
LOG=Path('/tmp/surf-control-native-'+REV[:7]+'.log')
REPORT=Path('/tmp/surf-control-interop-'+REV[:7]+'.json')
frames=[]; commands=[]; workers=[]; errors=[]
class Frames:
    def __init__(self,direction): self.buffer=b''; self.handshake=True; self.direction=direction; self.fragments=b''
    def feed(self,data):
        self.buffer+=data
        if self.handshake:
            cut=self.buffer.find(b'\r\n\r\n')
            if cut<0:return
            self.buffer=self.buffer[cut+4:];self.handshake=False
        while len(self.buffer)>=2:
            a,b=self.buffer[:2];n=b&127;off=2
            if n==126:
                if len(self.buffer)<4:return
                n=struct.unpack('!H',self.buffer[2:4])[0];off=4
            elif n==127:
                if len(self.buffer)<10:return
                n=struct.unpack('!Q',self.buffer[2:10])[0];off=10
            mask=b&128
            if len(self.buffer)<off+(4 if mask else 0)+n:return
            key=self.buffer[off:off+4] if mask else b'';off+=4 if mask else 0
            payload=self.buffer[off:off+n];self.buffer=self.buffer[off+n:]
            if mask:payload=bytes(v^key[i%4] for i,v in enumerate(payload))
            op=a&15
            if op in (1,0):
                self.fragments+=payload
                if a&128:
                    packet=self.fragments;self.fragments=b''
                    try:
                        obj=json.loads(packet); row={'direction':self.direction,'op':obj.get('op'),'type':obj.get('type'),'bytes':len(packet)}
                        if self.direction=='request' and obj.get('op') in ('consumable.sync','consumable.ack'):row['scope']=obj.get('payload',{})
                        frames.append(row)
                    except Exception as e:errors.append('frame parse: '+str(e))

def start_proxy(endpoint):
    port=int(endpoint.rsplit(':',1)[1].split('/')[0]); listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen()
    def relay(a,b,d):
        parser=Frames(d)
        try:
            while True:
                data=a.recv(65536)
                if not data:break
                parser.feed(data);b.sendall(data)
        except (ConnectionError,OSError):pass
        finally:
            try:b.shutdown(socket.SHUT_WR)
            except OSError:pass
    def accept():
        while True:
            try:a,_=listener.accept()
            except OSError:return
            b=socket.create_connection(('127.0.0.1',port));
            for x,y,d in [(a,b,'request'),(b,a,'response')]: threading.Thread(target=relay,args=(x,y,d),daemon=True).start()
    threading.Thread(target=accept,daemon=True).start()
    return 'ws://127.0.0.1:'+str(listener.getsockname()[1])+'/ws',listener

def run_cli(ready):
    Path(ready['completionPath']+'.claimed').write_text('actual Rust companion running')
    result={'ok':False};listener=None
    try:
        endpoint,listener=start_proxy(ready['endpoint'])
        root=Path('/tmp/surf-control-cli-'+REV[:7]); root.mkdir(exist_ok=False)
        def call(command,payload,local=False):
            args=[os.environ.get('SURF_ACE_CLI_BINARY',str(SOURCE/'packages/cli/target/debug/surf-ace')),'--state-root',str(root)]
            if not local:args+=['--endpoint',endpoint,'--product-label','B180 native integration']
            args+=[command,'--input-json',json.dumps(payload)]
            done=subprocess.run(args,capture_output=True,text=True,timeout=20)
            obj=json.loads(done.stdout);commands.append({'command':command,'exit':done.returncode,'output':obj if command!='read' else {'ok':obj.get('ok'),'cacheStatus':obj.get('result',{}).get('cacheStatus'),'currentContentId':(obj.get('result',{}).get('currentContentRecord') or {}).get('payload',{}).get('contentId')}})
            assert done.returncode==0, (command,obj,done.stderr)
            return obj
        listed=call('list',{});cid=listed['controllerInstanceId'];sid=ready['surfaceId']
        assert len(listed['result']['payload']['surfaces'])==1
        Path(ready['completionPath']+'.listed').write_text(cid)
        deadline=time.monotonic()+20
        while not Path(ready['completionPath']+'.unread').exists():
            if time.monotonic()>deadline:raise TimeoutError('native sibling unread append')
            time.sleep(.05)
        described=call('pane-describe',{'surfaceId':sid,'paneId':7,'expectedControllerInstanceId':cid})
        assert described['result']['paneId']==7
        assert described['result']['paneLineageId']
        scope='pane:'+sid+':7'
        cold=call('read',{'scopeId':scope},True)
        assert cold['result']['cacheStatus']=='unsynchronized'
        assert cold['result']['currentContentRecord'] is None
        call('sync',{'surfaceId':sid,'scopeIds':[scope]})
        assert not any(f['op']=='consumable.ack' for f in frames)
        initial=call('read',{'scopeId':scope},True)['result']['currentContentRecord']['payload']
        assert initial['contentId']=='content-7' and initial['content']['html']=='<p>Selected original source</p>'
        assert 'saved-stroke' in initial['annotations']['strokesById']
        earlier_intents=len(json.loads((root/'controller-state.json').read_text())['acknowledgementOutbox'])
        call('push',{'surfaceId':sid,'paneId':7,'contentId':'rust-new-content','contentType':'html','content':{'html':'<p>Rust native integration</p>'},'friendlyChatName':'B180 fixture'})
        # Receiving a snapshot does not read/ACK it.
        state=json.loads((root/'controller-state.json').read_text())
        assert state['scopes'][scope]['synchronized'] is True
        assert state['acknowledgementOutbox']==[]
        assert len([f for f in frames if f['direction']=='request' and f['op']=='consumable.ack'])==earlier_intents # only pre-existing explicit-read intents
        read=call('read',{'scopeId':scope},True)
        assert read['result']['cacheStatus']=='current'
        assert read['result']['currentContentRecord']['payload']['contentId']=='rust-new-content'
        assert json.loads((root/'controller-state.json').read_text())['acknowledgementOutbox']
        # Reconnect flushes only the read pane's durable ACK; sibling unread remains.
        call('pane-describe',{'surfaceId':sid,'paneId':7,'expectedControllerInstanceId':cid})
        state=json.loads((root/'controller-state.json').read_text())
        assert state['acknowledgementOutbox']==[]
        again=call('read',{'scopeId':scope},True)
        assert again['result']['currentContentRecord']['payload']['contentId']=='rust-new-content'
        assert 'pane:'+sid+':1' not in state['scopes']
        acks=[f for f in frames if f['direction']=='request' and f['op']=='consumable.ack']
        assert acks and all(f['scope']['scopeId']==scope for f in acks)
        syncs=[f for f in frames if f['direction']=='request' and f['op']=='consumable.sync']
        assert syncs and all(f['scope']['scopeIds']==[scope] for f in syncs)
        maximum=max(f['bytes'] for f in frames if f['direction']=='response')
        assert maximum<16*1024*1024
        result.update(ok=True,controllerId=cid,maxResponseBytes=maximum,authorityBytes=ready['authorityBytes'],frames=frames,commands=commands,stateAfter=state)
    except Exception as e:
        result.update(error=repr(e),traceback=traceback.format_exc(),frames=frames,commands=commands)
    finally:
        if listener:listener.close()
        REPORT.write_text(json.dumps(result,indent=2))
        Path(ready['completionPath']).write_text(json.dumps(result))
        print('RUST_NATIVE_RESULT '+json.dumps({'ok':result['ok'],'report':str(REPORT),'error':result.get('error')}),flush=True)

command=['xcodebuild','-project','packages/ios/SurfAce.xcodeproj','-scheme','SurfAce','-testPlan','SurfAceUnitTests','-configuration','Debug','-sdk','iphonesimulator','-destination','platform=iOS Simulator,id='+DEVICE,'-derivedDataPath','/tmp/surf-control-native-dd','-parallel-testing-enabled','NO','-maximum-concurrent-test-simulator-destinations','1','-test-timeouts-enabled','YES','-collect-test-diagnostics','never','-default-test-execution-time-allowance','120']
for test in ['SurfAceLocklessWebSocketIntegrationTests/testRustCLISevenPaneControlInterop','SurfAceLocklessWebSocketIntegrationTests/testSevenPaneControlFlowDoesNotTransmitRecoveryPayloads','SurfAceLocklessWebSocketIntegrationTests/testTwoControllersShareAuthorityReceiptsReadsEventsAndReconnectLocklessly','SurfAceLocklessRuntimeAdapterTests/testCompleteNativeTargetAdvertisesAndRejectsRequestsWithoutTheCurrentCapability']:
    command+=['-only-testing:SurfAceTests/'+test]
command+=['test']
process=subprocess.Popen(command,cwd=SOURCE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,start_new_session=True)
lines=[]
def reader():
    with LOG.open('w') as out:
        out.write('SOURCE='+REV+'\nCOMMAND='+json.dumps(command)+'\n');out.flush()
        for line in process.stdout:
            lines.append(line);out.write(line);out.flush()
            if 'B180_NATIVE_READY ' in line:
                ready=json.loads(line.split('B180_NATIVE_READY ',1)[1]);thread=threading.Thread(target=run_cli,args=(ready,),daemon=True);workers.append(thread);thread.start()
thread=threading.Thread(target=reader,daemon=True);thread.start()
try:code=process.wait(timeout=600)
except subprocess.TimeoutExpired:
    os.killpg(process.pid,signal.SIGTERM)
    try:code=process.wait(timeout=10)
    except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);code=process.wait()
thread.join(timeout=5)
for worker in workers:worker.join(timeout=5)
for app in ['co.clicketyclacks.SurfAce']:
    cleanup=subprocess.run(['xcrun','simctl','terminate',DEVICE,app],capture_output=True,text=True)
    print('OWNED_APP_CLEANUP='+str(cleanup.returncode))
shutdown=subprocess.run(['xcrun','simctl','shutdown',DEVICE],capture_output=True,text=True)
print('OWNED_SIM_SHUTDOWN='+str(shutdown.returncode))
print('XCODE_EXIT='+str(code)+' LOG='+str(LOG))
print(''.join(line for line in lines if 'error:' in line or 'Test Case' in line or 'Executed ' in line)[-7000:])
sys.exit(code if code else (0 if REPORT.exists() and json.loads(REPORT.read_text())['ok'] else 2))
