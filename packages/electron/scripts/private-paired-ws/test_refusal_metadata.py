import contextlib,ctypes,errno,importlib.util,io,json,os,pathlib,tempfile,time,types,unittest,unittest.mock as mock
def module(name):
    key='PRIVATE_CENSUS_SOURCE' if name=='census' else 'PRIVATE_RUNNER_SOURCE'
    path=pathlib.Path(os.environ.get(key,str(pathlib.Path(__file__).with_name(name+'.py'))))
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
c=module('census');r=module('runner')
def row(pid=777,state='S'):
    return dict(pid=pid,ppid=11,pgid=22,uid=os.getuid(),state=state,started='Mon Oct 12 13:59:00 2026',argv='SYNTHETIC_PRIVATE_ARG_NOT_FOR_OUTPUT')
def failure():
    value=ValueError('unresolved executable PID 777');value.kernelAPI='proc_pidpath';value.kernelErrno=errno.ESRCH;value.apiReturn=0;return value
class Controls(unittest.TestCase):
    def test_fake_kernel_errno_bound_to_actual_pid_call(self):
        def call(pid,buf,size):ctypes.set_errno(errno.ESRCH);return 0
        fn=mock.Mock(side_effect=call)
        with mock.patch.object(c.ctypes,'CDLL',return_value=types.SimpleNamespace(proc_pidpath=fn)):
            with self.assertRaisesRegex(ValueError,'PID 777') as caught:c.executable(777)
        self.assertEqual(fn.call_args.args[0],777)
        self.assertEqual(getattr(caught.exception,'kernelErrno',None),errno.ESRCH)
        self.assertEqual(getattr(caught.exception,'kernelAPI',None),'proc_pidpath')
        self.assertEqual(getattr(caught.exception,'apiReturn',None),0)
    def test_prior_errno_does_not_leak_when_api_sets_none(self):
        ctypes.set_errno(errno.EACCES)
        with mock.patch.object(c.ctypes,'CDLL',return_value=types.SimpleNamespace(proc_pidpath=mock.Mock(return_value=0))):
            with self.assertRaises(ValueError) as caught:c.executable(777)
        self.assertEqual(getattr(caught.exception,'kernelErrno',None),0)
    def test_successful_path_result_unchanged(self):
        def call(pid,buf,size):buf.value=b'/opt/node';return 9
        with mock.patch.object(c.ctypes,'CDLL',return_value=types.SimpleNamespace(proc_pidpath=mock.Mock(side_effect=call))):self.assertEqual(c.executable(777),'/opt/node')
    def test_invalid_path_retains_original_refusal_and_actual_return(self):
        def call(pid,buf,size):buf.value=b'not-absolute';return 12
        with mock.patch.object(c.ctypes,'CDLL',return_value=types.SimpleNamespace(proc_pidpath=mock.Mock(side_effect=call))):
            with self.assertRaisesRegex(ValueError,'invalid kernel') as caught:c.executable(777)
        self.assertEqual(caught.exception.apiReturn,12)
    def tables(self,rows):
        def call(args,trace=None):
            if trace is not None:trace.append(dict(queryAPI='ps',queryChildPID=55+len(trace),childPresentInSnapshot=True))
            return rows
        return call
    def test_main_preserves_false_flags_and_bound_context(self):
        with tempfile.TemporaryDirectory() as d:
            policy=pathlib.Path(d)/'policy.json';policy.write_text(json.dumps(dict(startEpoch=time.time()-5,endEpoch=time.time()+100,residentProcesses=[])));policy.chmod(0o600)
            out=io.StringIO();error=failure()
            with mock.patch.object(c.sys,'platform','darwin'),mock.patch.object(c.sys,'argv',['census','--nonce','a'*32,'--policy',str(policy)]),mock.patch.object(c,'process_table',side_effect=self.tables({777:row()})),mock.patch.object(c,'executable',side_effect=error),mock.patch.object(c.os,'getpid',return_value=1000),mock.patch.object(c,'listeners') as listen,contextlib.redirect_stdout(out):
                code=c.main()
            value=json.loads(out.getvalue());self.assertEqual(code,1);self.assertFalse(value['runtimeQualified']);self.assertFalse(value['clear']);listen.assert_not_called()
            context=value.get('failureContext');self.assertIsInstance(context,dict)
            self.assertEqual(context['requestedPID'],777);self.assertEqual(context['enumeratedProcess'],{k:v for k,v in row().items() if k!='argv'})
            self.assertEqual(context['helperPID'],1000);self.assertTrue(context['enumeratedPIDMatchesCall'])
            self.assertFalse(context['failedIsHelper']);self.assertFalse(context['failedIsSnapshotQueryChild'])
            self.assertEqual(context['snapshotQueries'][0]['queryChildPID'],55);self.assertEqual(context['kernelErrno'],errno.ESRCH)
            self.assertNotIn(row()['argv'],out.getvalue())
            with self.assertRaises(ValueError):r.census(value,'a'*32,time.time())
    def test_after_resolution_failure_binds_later_stage_and_row(self):
        first={777:row()};second={777:row(state='R')};queries=[]
        def tables(args,trace=None):
            trace.append(dict(queryAPI='ps',queryChildPID=55+len(trace),childPresentInSnapshot=True));queries.append(1)
            return first if len(queries)==1 else second
        with mock.patch.object(c,'process_table',side_effect=tables),mock.patch.object(c,'executable',side_effect=['/opt/node',failure()]):
            with self.assertRaises(ValueError) as caught:c.snapshot()
        context=caught.exception.failureContext;self.assertEqual(context['operationStage'],'after_resolution')
        self.assertEqual(context['enumeratedProcess']['state'],'R');self.assertEqual(len(context['snapshotQueries']),2)
    def test_mismatched_enumerated_identity_not_silently_rebound(self):
        with mock.patch.object(c,'executable',side_effect=failure()):
            with self.assertRaises(ValueError) as caught:c.resolve_process(777,row(888),'before_resolution',[])
        context=caught.exception.failureContext;self.assertEqual(context['requestedPID'],777)
        self.assertEqual(context['enumeratedProcess']['pid'],888);self.assertFalse(context['enumeratedPIDMatchesCall'])
    def test_helper_and_snapshot_child_comparison_are_exact(self):
        with mock.patch.object(c.os,'getpid',return_value=777),mock.patch.object(c,'executable',side_effect=failure()):
            with self.assertRaises(ValueError) as caught:c.resolve_process(777,row(),'before_resolution',[dict(queryAPI='ps',queryChildPID=777,childPresentInSnapshot=True)])
        self.assertTrue(caught.exception.failureContext['failedIsHelper']);self.assertTrue(caught.exception.failureContext['failedIsSnapshotQueryChild'])
    def test_api_load_failure_keeps_errno_unknown_and_primary_error(self):
        error=OSError('library unavailable')
        with mock.patch.object(c,'executable',side_effect=error):
            with self.assertRaisesRegex(OSError,'library unavailable') as caught:c.resolve_process(777,row(),'before_resolution',[])
        self.assertIs(caught.exception,error);self.assertIsNone(error.failureContext['kernelErrno']);self.assertIsNone(error.failureContext['apiReturn'])
    def test_trace_copies_do_not_change_after_refusal(self):
        trace=[dict(queryAPI='ps',queryChildPID=55,childPresentInSnapshot=True)]
        with mock.patch.object(c,'executable',side_effect=failure()):
            with self.assertRaises(ValueError) as caught:c.resolve_process(777,row(),'before_resolution',trace)
        trace[0]['queryChildPID']=999;self.assertEqual(caught.exception.failureContext['snapshotQueries'][0]['queryChildPID'],55)
    def test_actual_snapshot_child_recorded_without_changing_exclusion(self):
        text='55 11 55 '+str(os.getuid())+' R Mon Oct 12 13:59:00 2026 ps\n777 11 22 '+str(os.getuid())+' S Mon Oct 12 13:59:00 2026 ordinary'
        trace=[]
        with mock.patch.object(c,'command',return_value=(text,55)):rows=c.process_table([],trace)
        self.assertEqual(set(rows),{777});self.assertEqual(trace,[dict(queryAPI='ps',queryChildPID=55,childPresentInSnapshot=True)])
if __name__=='__main__':unittest.main()
