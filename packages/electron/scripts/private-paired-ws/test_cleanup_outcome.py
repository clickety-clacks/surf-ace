import contextlib,errno,hashlib,importlib.util,io,json,os,pathlib,shutil,signal,subprocess,sys,tempfile,time,unittest,unittest.mock as mock
path=pathlib.Path(os.environ.get('PRIVATE_RUNNER_SOURCE',str(pathlib.Path(__file__).with_name('runner.py'))))
spec=importlib.util.spec_from_file_location('runner',path);r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class Controls(unittest.TestCase):
    def proc(self,code=-signal.SIGKILL):
        p=mock.Mock(pid=777,returncode=None)
        def wait(timeout):p.returncode=code;return code
        p.wait.side_effect=wait;return p
    def test_final_signal_disappears_still_failure_with_bounded_reap(self):
        p=self.proc(-signal.SIGUSR1);seen=[]
        def kill(pid,sig):
            seen.append((pid,sig))
            if sig==signal.SIGKILL:raise ProcessLookupError(errno.ESRCH,'final group vanished')
        with mock.patch.object(r,'leader_exited',return_value=False),mock.patch.object(r.os,'getpgid',return_value=p.pid),mock.patch.object(r.os,'killpg',side_effect=kill):
            with self.assertRaises(ProcessLookupError) as caught:r.cleanup(p,0)
        self.assertEqual(getattr(caught.exception,'anchorExit',None),-signal.SIGUSR1)
        self.assertEqual(seen,[(777,signal.SIGTERM),(777,signal.SIGKILL)])
        p.wait.assert_called_once_with(timeout=2);p.stdin.close.assert_called_once()
    def test_unexpected_terminal_anchor_status_refuses(self):
        for code in [-signal.SIGUSR1,0,-signal.SIGTERM,-9.0,True,None]:
            p=self.proc(code)
            with mock.patch.object(r,'leader_exited',return_value=False),mock.patch.object(r.os,'getpgid',return_value=p.pid),mock.patch.object(r.os,'killpg'):
                with self.assertRaisesRegex(ValueError,'terminal status'):r.cleanup(p,0)
            p.wait.assert_called_once_with(timeout=2);p.stdin.close.assert_called_once()
    def test_reap_timeout_preserves_original_signal_failure(self):
        p=self.proc();p.wait.side_effect=subprocess.TimeoutExpired('owned-anchor',2)
        with mock.patch.object(r,'leader_exited',return_value=False),mock.patch.object(r.os,'getpgid',return_value=p.pid),mock.patch.object(r.os,'killpg',side_effect=ProcessLookupError(errno.ESRCH,'primary signal failure')) as kill:
            with self.assertRaisesRegex(ProcessLookupError,'primary signal failure') as caught:r.cleanup(p,0)
        self.assertIsNone(caught.exception.anchorExit);self.assertIn('timed out',caught.exception.reapError)
        self.assertEqual(kill.call_count,1);p.wait.assert_called_once_with(timeout=2);p.stdin.close.assert_called_once()
    def test_esrch_even_with_expected_exit_cannot_certify_signal(self):
        p=self.proc()
        with mock.patch.object(r,'leader_exited',return_value=False),mock.patch.object(r.os,'getpgid',return_value=p.pid),mock.patch.object(r.os,'killpg',side_effect=ProcessLookupError(errno.ESRCH,'missing')):
            with self.assertRaises(ProcessLookupError):r.cleanup(p,0)
        self.assertEqual(p.returncode,-signal.SIGKILL)
    def test_actual_main_propagates_cleanup_failure_without_group_retry(self):
        # All process APIs are mocked: execute actual main orchestration and actual
        # cleanup; no Node/helper/collector or OS process is launched/signaled.
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d).resolve();root=base/'runtime';root.mkdir();payload=base/'payload'
            packet=pathlib.Path(os.environ.get('PRIVATE_PAIRED_WS_PAYLOAD',str(pathlib.Path(__file__).with_name('payload')))).resolve()
            # Frozen packet's adjacent payload, or explicit source-test payload;
            # actual validator still requires canonical manifest/schema hashes.
            shutil.copytree(packet,payload)
            a=dict(executionAuthorized=True,productSource=r.PRODUCT,scope='B-actual-paired-ws-synthetic-capture',slotId='mock-owned',startEpoch=time.time()-5,endEpoch=time.time()+300,nodeVersion='v24.7.0',manifestSha256=r.digest(payload/'manifest.json'))
            for key in ['node','census','supervisor']:
                p=base/key;p.write_text('not executed');a[key]=str(p);a[key+'Sha256']=r.digest(p)
            policy=base/'policy.json';policy.write_text(json.dumps(a));policy.chmod(0o600)
            p=self.proc(-signal.SIGUSR1);calls=[];signals=[]
            def popen(*args,**kwargs):
                (root/'child-receipt.json').write_text(json.dumps(dict(childPID=778,childExit=0,anchorPID=777,pgid=777)))
                (root/'fixture-result.json').write_text('{"synthetic":true}')
                return p
            def run(args,**kwargs):
                if args==[a['node'],'--version']:return mock.Mock(returncode=0,stdout='v24.7.0\n',stderr='')
                if args[:3]==[r.sys.executable,'-I',a['census']]:
                    calls.append('census')
                    return mock.Mock(returncode=0,stdout=json.dumps(dict(nonce=args[4],runtimeQualified=True,clear=True,conflicts=[],ownedRemaining=[],observedEpoch=time.time())),stderr='')
                calls.append('collector');return mock.Mock(returncode=0,stdout='{"validated":true}',stderr='')
            def kill(pid,sig):
                signals.append((pid,sig))
                if sig==signal.SIGKILL:raise ProcessLookupError(errno.ESRCH,'final group vanished')
            out=io.StringIO()
            with mock.patch.object(r.sys,'argv',['runner','--admission',str(policy),'--payload',str(payload)]),mock.patch.object(r.tempfile,'mkdtemp',return_value=str(root)),mock.patch.object(r.subprocess,'run',side_effect=run),mock.patch.object(r.subprocess,'Popen',side_effect=popen),mock.patch.object(r,'leader_exited',return_value=False),mock.patch.object(r.os,'getpgid',return_value=777),mock.patch.object(r.os,'killpg',side_effect=kill),mock.patch.object(r.time,'sleep'),contextlib.redirect_stdout(out):
                code=r.main()
            value=json.loads(out.getvalue());self.assertEqual(code,1);self.assertEqual(value['outerExit'],1)
            self.assertIn('final group vanished',value['error']);self.assertEqual(value['anchorExit'],-signal.SIGUSR1)
            self.assertEqual(value['childExit'],0);self.assertEqual(calls,['census','census'])
            self.assertEqual(signals,[(777,signal.SIGTERM),(777,signal.SIGKILL)])
            self.assertEqual(json.loads((root/'controller-receipt.json').read_text())['outerExit'],1)
            print(json.dumps(dict(scope='mocked-actual-main',outerExit=value['outerExit'],childExit=value['childExit'],anchorExit=value['anchorExit'],error=value['error'],calls=calls,signals=signals)))
if __name__=='__main__':unittest.main()
