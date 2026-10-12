import ast,importlib.util,pathlib,unittest,unittest.mock as mock,tempfile,json,signal,os,time,subprocess,sys
def module(name):
    key='PRIVATE_CENSUS_SOURCE' if name=='census' else 'PRIVATE_RUNNER_SOURCE'
    path=pathlib.Path(os.environ.get(key,str(pathlib.Path(__file__).with_name(name+'.py'))))
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
c=module('census');r=module('runner')
def row(pid=10,state='S',pgid=10):return dict(pid=pid,ppid=1,pgid=pgid,uid=501,state=state,started='Wed Oct 7 09:44:57 2026',argv='<defunct>' if state=='Z' else 'ordinary',executable=None if state=='Z' else '/bin/sleep')
class Controls(unittest.TestCase):
    def test_actual_retained_zombie_status_pattern(self):
        value=c.parse_processes('35136 62859 35136 501 Z Wed Oct 7 09:44:57 2026 <defunct>')
        self.assertEqual(value[35136]['state'],'Z');self.assertEqual(value[35136]['started'],'Wed Oct 7 09:44:57 2026')
    def test_missing_and_unknown_status_refuse(self):
        for raw in ['20 1 20 501 Mon Oct 12 11:50:00 2026 ordinary','20 1 20 501 Q Mon Oct 12 11:50:00 2026 ordinary']:
            with self.assertRaises(ValueError):c.parse_processes(raw)
    def test_stable_zombie_never_resolves_missing_executable(self):
        rows={10:{k:v for k,v in row(10,'Z').items() if k!='executable'}}
        with mock.patch.object(c,'process_table',return_value=rows),mock.patch.object(c.os,'getuid',return_value=501),mock.patch.object(c,'executable',side_effect=ValueError('dead text')) as resolve:
            try: outcome=c.snapshot()[10]['executable']
            except ValueError: outcome='refused'
            self.assertIsNone(outcome);resolve.assert_not_called()
    def test_nonowned_zombie_no_listener_is_not_active_conflict(self):
        self.assertEqual(c.evaluate({10:row(),20:row(20,'Z')},[],{},10),([],[]))
    def test_owned_zombie_still_blocks(self):
        self.assertEqual(c.evaluate({10:row(),20:row(20,'Z',999)},[],{},10,999)[1],[20])
    def test_zombie_listener_owner_refuses(self):
        with self.assertRaisesRegex(ValueError,'zombie ownership'):c.evaluate({10:row(),20:row(20,'Z')},[dict(pid=20,endpoint='*:12345')],{},10)
    def test_inconsistent_zombie_executable_refuses(self):
        zombie={**row(20,'Z'),'executable':'/opt/node'}
        with self.assertRaisesRegex(ValueError,'zombie ownership'):c.evaluate({10:row(),20:zombie},[],{},10)
    def test_live_dead_and_dead_live_transitions_refuse(self):
        for a,b in [('S','Z'),('Z','S')]:
            before={10:{k:v for k,v in row(10,a).items() if k!='executable'}};after={10:{**before[10],'state':b}}
            with mock.patch.object(c,'process_table',side_effect=[before,after]),mock.patch.object(c.os,'getuid',return_value=501),mock.patch.object(c,'executable',return_value='/bin/sleep'):
                with self.assertRaisesRegex(ValueError,'zombie state changed'):c.snapshot()
    def test_active_unresolved_path_still_refuses(self):
        before={10:{k:v for k,v in row().items() if k!='executable'}}
        with mock.patch.object(c,'process_table',return_value=before),mock.patch.object(c.os,'getuid',return_value=501),mock.patch.object(c,'executable',side_effect=ValueError('permission')):
            with self.assertRaisesRegex(ValueError,'permission'):c.snapshot()
    def test_normal_scheduling_state_change_preserves_identity(self):
        before={10:{k:v for k,v in row().items() if k!='executable'}};after={10:{**before[10],'state':'R'}}
        with mock.patch.object(c,'process_table',side_effect=[before,after]),mock.patch.object(c.os,'getuid',return_value=501),mock.patch.object(c,'executable',return_value='/bin/sleep'):
            self.assertEqual(c.snapshot()[10]['executable'],'/bin/sleep')
    def test_exited_anchor_refuses_every_group_signal(self):
        p=mock.Mock(pid=123)
        with mock.patch.object(r,'leader_exited',return_value=True),mock.patch.object(r.os,'killpg') as kill,mock.patch.object(r.os,'getpgid') as group:
            with self.assertRaisesRegex(ValueError,'anchor exited'):r.cleanup(p,0)
            kill.assert_not_called();group.assert_not_called();p.wait.assert_not_called()
    def test_esrch_anchor_refuses_without_saved_group_fallback(self):
        p=mock.Mock(pid=123)
        with mock.patch.object(r,'leader_exited',return_value=False),mock.patch.object(r.os,'getpgid',side_effect=ProcessLookupError()),mock.patch.object(r.os,'killpg') as kill:
            with self.assertRaises(ProcessLookupError):r.cleanup(p,0)
            kill.assert_not_called();p.wait.assert_not_called()
    def test_anchor_dies_between_term_and_kill_no_second_signal(self):
        p=mock.Mock(pid=123);seen=[]
        with mock.patch.object(r,'leader_exited',side_effect=[False,True]),mock.patch.object(r.os,'getpgid',return_value=123),mock.patch.object(r.os,'killpg',side_effect=lambda *args:seen.append(args)):
            with self.assertRaisesRegex(ValueError,'anchor exited'):r.cleanup(p,0)
            self.assertEqual(seen,[(123,signal.SIGTERM)]);p.wait.assert_not_called()
    def test_forged_child_exit_and_owner_receipts_refuse(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'receipt.json';valid=dict(childPID=321,childExit=0,anchorPID=123,pgid=123)
            p.write_text(json.dumps(valid));self.assertEqual(r.child_receipt(p,123),valid)
            for change in [dict(anchorPID=999),dict(pgid=999),dict(childPID=123),dict(childExit=True),dict(childExit=None)]:
                p.write_text(json.dumps({**valid,**change}))
                with self.assertRaises(ValueError):r.child_receipt(p,123)
    def test_child_receipt_symlink_and_oversize_refuse(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);outside=root/'outside.json';outside.write_text('{}');link=root/'receipt.json';link.symlink_to(outside)
            with self.assertRaises(ValueError):r.child_receipt(link,123)
            link.unlink();link.write_text(' '*2049)
            with self.assertRaisesRegex(ValueError,'untrusted'):r.child_receipt(link,123)
    def test_actual_runner_launch_uses_single_supervisor_command(self):
        calls=[n for n in ast.walk(ast.parse(pathlib.Path(r.__file__).read_text())) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and ast.unparse(n.func)=='subprocess.Popen']
        self.assertEqual(len(calls),1);self.assertEqual(ast.unparse(calls[0].args[0]),'supervisor_command(a, status, seconds, payload)')
        flags={n.arg:ast.unparse(n.value) for n in calls[0].keywords}
        self.assertEqual(flags['stdin'],'subprocess.PIPE');self.assertEqual(flags['start_new_session'],'True')
    def actual_anchor(self,release=False):
        # Harmless SOURCE lifecycle control, not a Node/socket/GUI fixture. READY
        # is child receipt publication; parent-held stdin owns the anchor lifetime.
        with tempfile.TemporaryDirectory() as d:
            receipt=pathlib.Path(d)/'receipt.json'
            a=dict(supervisor=str(pathlib.Path(__file__).with_name('supervisor.py')),node='/usr/bin/true')
            # Execute the actual runner command builder; true is an explicit harmless
            # stand-in that ignores the fixture path argument, never a Node fixture.
            p=subprocess.Popen(r.supervisor_command(a,receipt,60,pathlib.Path(d)),stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,start_new_session=True)
            try:
                deadline=time.monotonic()+3
                while not receipt.exists() and time.monotonic()<deadline:
                    if r.leader_exited(p.pid):self.fail('anchor exited before READY')
                    time.sleep(.01)
                self.assertTrue(receipt.exists(),'bounded explicit READY admission')
                value=r.child_receipt(receipt,p.pid);self.assertEqual(value['childExit'],0)
                self.assertFalse(r.leader_exited(p.pid));self.assertEqual(os.getpgid(p.pid),p.pid)
                if release:
                    p.stdin.close();anchor_exit=p.wait(timeout=3)
                else:anchor_exit=r.cleanup(p,time.monotonic()+.05)
                self.assertEqual(anchor_exit,-signal.SIGKILL)
                print(json.dumps(dict(scope='harmless-Linux-source-lifecycle',releasedPipe=release,readyReceipt=value,anchorExit=anchor_exit,reaped=p.returncode is not None)))
                self.assertIsNotNone(p.returncode)
            finally:
                if p.returncode is None:
                    # Direct Popen-owned PID only; never reap before group signaling.
                    if p.stdin is not None:p.stdin.close()
                    p.wait(timeout=3)
                if p.stderr is not None:p.stderr.close()
    def test_actual_owned_linux_anchor_held_after_true_child_exit(self):self.actual_anchor()
    def test_actual_owned_linux_anchor_eof_self_cleanup(self):self.actual_anchor(release=True)
if __name__=='__main__':unittest.main()
