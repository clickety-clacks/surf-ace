import ast, os, importlib.util, pathlib, unittest, unittest.mock as mock, tempfile, hashlib
spec=importlib.util.spec_from_file_location('census',pathlib.Path(os.environ.get('PRIVATE_CENSUS_SOURCE',str(pathlib.Path(__file__).with_name('census.py')))))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
spec2=importlib.util.spec_from_file_location('runner',pathlib.Path(__file__).with_name('runner.py'))
r=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(r)
def row(pid=10,ppid=1,pgid=10,exe='/bin/sleep',argv='sleep'):
    return dict(pid=pid,ppid=ppid,pgid=pgid,uid=501,state='S',started='Mon Oct 12 11:50:00 2026',executable=exe,argv=argv)
class Controls(unittest.TestCase):
    def base(self):return {10:row(exe='/opt/python3',argv='census'),20:row(20,exe='/bin/sleep')}
    def test_clean_nonruntime_snapshot(self):self.assertEqual(c.evaluate(self.base(),[],{},10),([],[]))
    def test_renamed_argv_node_still_conflicts(self):
        rows=self.base();rows[20]=row(20,exe='/opt/homebrew/bin/node',argv='innocent')
        self.assertEqual(c.evaluate(rows,[],{},10)[0][0]['pid'],20)
    def test_unapproved_electron_helper_only_without_main_or_marker(self):
        rows=self.base();rows[20]=row(20,exe='/Applications/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)',argv='--type=renderer --lang=en-US')
        self.assertEqual([v['pid'] for v in c.evaluate(rows,[],{},10)[0]],[20])
    def test_unapproved_renamed_private_main_and_helpers(self):
        for path in ['/private/tmp/sdk/MyApp.app/Contents/MacOS/MyApp','/private/tmp/sdk/MyApp.app/Contents/Frameworks/MyApp Helper.app/Contents/MacOS/MyApp Helper','/private/tmp/sdk/MyApp.app/Contents/Frameworks/MyApp Helper (GPU).app/Contents/MacOS/MyApp Helper (GPU)','/opt/sdk/Electron Helper (Renderer)']:
            rows=self.base();rows[20]=row(20,exe=path,argv='--type=utility')
            self.assertTrue(c.evaluate(rows,[],{},10)[0],path)
    def test_ambiguous_non_electron_app_bundle_requires_exact_resident(self):
        rows=self.base();rows[20]=row(20,exe='/Applications/Other.app/Contents/MacOS/Other',argv='Other')
        self.assertTrue(c.evaluate(rows,[],{},10)[0])
    def test_approved_helper_retains_exact_resident_exemption(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'App.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper';p.parent.mkdir(parents=True);p.write_bytes(b'pinned')
            rows=self.base();rows[20]=row(20,exe=str(p),argv='--type=renderer')
            resident={**rows[20],'executableSha256':hashlib.sha256(p.read_bytes()).hexdigest()}
            self.assertEqual(c.evaluate(rows,[],{'residentProcesses':[resident]},10)[0],[])
            rows[20]['started']='replacement';self.assertTrue(c.evaluate(rows,[],{'residentProcesses':[resident]},10)[0])
    def test_private_argument_with_other_executable_conflicts(self):
        rows=self.base();rows[20]['argv']='other /tmp/private-paired-ws/fixture'
        self.assertTrue(c.evaluate(rows,[],{},10)[0])
    def test_owned_survivor_even_with_renamed_exec(self):
        rows=self.base();rows[20]['pgid']=999
        self.assertEqual(c.evaluate(rows,[],{},10,999)[1],[20])
    def test_unrelated_recycled_group_refuses_without_signal(self):
        rows=self.base();rows[20]['pgid']=20
        self.assertEqual(c.evaluate(rows,[],{},10,20)[1],[20])
        self.assertNotIn('killpg',pathlib.Path(c.__file__).read_text())
    def test_missing_self_refuses(self):
        with self.assertRaisesRegex(ValueError,'absent'):c.evaluate({},[],{},10)
    def test_ancestor_cycle_refuses(self):
        rows=self.base();rows[10]['ppid']=20;rows[20]['ppid']=10
        with self.assertRaisesRegex(ValueError,'cycle'):c.evaluate(rows,[],{},10)
    def test_missing_listener_owner_refuses(self):
        with self.assertRaisesRegex(ValueError,'owner absent'):c.evaluate(self.base(),[dict(pid=99,endpoint='127.0.0.1:1')],{},10)
    def test_exact_resident_identity_and_binary_hash_only(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'node';p.write_bytes(b'pinned');rows=self.base();rows[20]=row(20,exe=str(p),argv='resident')
            resident={**rows[20],'executableSha256':hashlib.sha256(p.read_bytes()).hexdigest()}
            self.assertEqual(c.evaluate(rows,[],{'residentProcesses':[resident]},10)[0],[])
            rows[20]['started']='new incarnation';self.assertTrue(c.evaluate(rows,[],{'residentProcesses':[resident]},10)[0])
    def test_resident_argv_change_is_not_exempt(self):
        rows=self.base();rows[20]=row(20,exe='/opt/node',argv='private');old={**rows[20],'argv':'resident','executableSha256':'a'*64}
        self.assertTrue(c.evaluate(rows,[],{'residentProcesses':[old]},10)[0])
    def test_incomplete_resident_refuses(self):
        with self.assertRaisesRegex(ValueError,'incomplete'):c.evaluate(self.base(),[],{'residentProcesses':[{'pid':20}]},10)
    def test_wrong_resident_binary_hash_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'node';p.write_bytes(b'changed');rows=self.base();rows[20]=row(20,exe=str(p))
            with self.assertRaisesRegex(ValueError,'changed'):c.evaluate(rows,[],{'residentProcesses':[{**rows[20],'executableSha256':'a'*64}]},10)
    def test_missing_malformed_duplicate_process_rows(self):
        for text in ['', '1 2', '1 0 1 501 S Mon Oct 12 11:50:00 2026 node\n1 0 1 501 S Mon Oct 12 11:50:00 2026 node']:
            with self.assertRaises(ValueError):c.parse_processes(text)
    def test_actual_ps_row_parser(self):
        value=c.parse_processes('20 1 20 501 S Mon Oct 12 11:50:00 2026 renamed --arg')
        self.assertEqual(value[20]['argv'],'renamed --arg');self.assertEqual(value[20]['started'],'Mon Oct 12 11:50:00 2026')
    def test_changed_pid_incarnation_snapshot_refuses(self):
        before={10:{k:v for k,v in row().items() if k!='executable'}};after={10:{**before[10],'started':'replacement'}}
        with mock.patch.object(c,'process_table',side_effect=[before,after]),mock.patch.object(c.os,'getuid',return_value=501),mock.patch.object(c,'executable',return_value='/bin/sleep'):
            with self.assertRaisesRegex(ValueError,'changed'):c.snapshot()
    def test_new_same_uid_process_refuses(self):
        before={10:{k:v for k,v in row().items() if k!='executable'}};after={**before,20:{k:v for k,v in row(20).items() if k!='executable'}}
        with mock.patch.object(c,'process_table',side_effect=[before,after]),mock.patch.object(c.os,'getuid',return_value=501),mock.patch.object(c,'executable',return_value='/bin/sleep'):
            with self.assertRaisesRegex(ValueError,'set changed'):c.snapshot()
    def test_unresolved_executable_refuses(self):
        before={10:{k:v for k,v in row().items() if k!='executable'}}
        with mock.patch.object(c,'process_table',return_value=before),mock.patch.object(c.os,'getuid',return_value=501),mock.patch.object(c,'executable',side_effect=ValueError('unresolved')):
            with self.assertRaisesRegex(ValueError,'unresolved'):c.snapshot()
    def test_changed_kernel_executable_with_same_ps_row_refuses(self):
        before={10:{k:v for k,v in row().items() if k!='executable'}}
        with mock.patch.object(c,'process_table',return_value=before),mock.patch.object(c.os,'getuid',return_value=501),mock.patch.object(c,'executable',side_effect=['/opt/node','/bin/sleep']):
            with self.assertRaisesRegex(ValueError,'executable changed'):c.snapshot()
    def test_exact_popen_snapshot_child_only_excluded(self):
        text='10 1 10 501 R Mon Oct 12 11:50:00 2026 ps\n20 1 20 501 S Mon Oct 12 11:50:00 2026 ps'
        with mock.patch.object(c,'command',return_value=(text,10)):
            self.assertEqual(set(c.process_table([])),{20})
    def test_os_command_failure_not_clear(self):
        with mock.patch.object(c,'command',side_effect=ValueError('failed')):
            with self.assertRaisesRegex(ValueError,'failed'):c.snapshot()
    def test_listener_failure_and_unknown_fields_refuse(self):
        for value in [mock.Mock(returncode=2,stdout='',stderr='denied'),mock.Mock(returncode=0,stdout='xunexpected\n',stderr='')]:
            with mock.patch.object(c.subprocess,'run',return_value=value):
                with self.assertRaises(ValueError):c.listeners()
    def test_empty_and_owned_listener_snapshots(self):
        with mock.patch.object(c.subprocess,'run',return_value=mock.Mock(returncode=1,stdout='',stderr='')):self.assertEqual(c.listeners(),[])
        with mock.patch.object(c.subprocess,'run',return_value=mock.Mock(returncode=0,stdout='p20\nn127.0.0.1:54321\n',stderr='')):
            self.assertEqual(c.listeners(),[dict(pid=20,endpoint='127.0.0.1:54321')])
    def test_incomplete_final_listener_pid_refuses(self):
        with mock.patch.object(c.subprocess,'run',return_value=mock.Mock(returncode=0,stdout='p99\n',stderr='')):
            with self.assertRaisesRegex(ValueError,'incomplete'):c.listeners()
    def test_incomplete_before_complete_listener_pid_refuses(self):
        with mock.patch.object(c.subprocess,'run',return_value=mock.Mock(returncode=0,stdout='p99\np20\nn127.0.0.1:12345\n',stderr='')):
            with self.assertRaisesRegex(ValueError,'incomplete'):c.listeners()
    def test_multiple_owners_and_multiple_listener_endpoints_retained(self):
        raw='p20\nn127.0.0.1:12345\nn[::1]:23456\np30\nn*:34567\n'
        with mock.patch.object(c.subprocess,'run',return_value=mock.Mock(returncode=0,stdout=raw,stderr='')):
            self.assertEqual(c.listeners(),[dict(pid=20,endpoint='127.0.0.1:12345'),dict(pid=20,endpoint='[::1]:23456'),dict(pid=30,endpoint='*:34567')])
    def test_final_census_uses_actual_owned_group(self):
        args=r.census_command({'census':'/tmp/helper.py'},'/tmp/owner.json','n',123)
        self.assertEqual(args[-2:],['--owned-pgid','123']);self.assertIn('-I',args);self.assertEqual(args[1],'-I')
    def test_actual_pre_and_final_runner_callsite_provenance(self):
        path=pathlib.Path(os.environ.get('PRIVATE_CENSUS_RUNNER_SOURCE',r.__file__))
        calls=[n for n in ast.walk(ast.parse(path.read_text())) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='census_command']
        self.assertEqual(len(calls),2,'both real census call sites must carry reviewed policy')
        self.assertTrue(all(ast.unparse(n.args[1])=='p' for n in calls))
        self.assertEqual(sorted(len(n.args) for n in calls),[3,4])
        final=next(n for n in calls if len(n.args)==4)
        self.assertEqual(ast.unparse(final.args[3]),"r['pgid']")
    def test_stale_failed_and_ambiguous_receipts_refused_by_actual_runner(self):
        good=dict(nonce='n',runtimeQualified=True,clear=True,observedEpoch=99,conflicts=[],ownedRemaining=[])
        for update in [dict(observedEpoch=96),dict(runtimeQualified=False),dict(ownedRemaining=[20]),dict(conflicts=[20]),dict(nonce='wrong')]:
            with self.assertRaises(ValueError):r.census({**good,**update},'n',100)
if __name__=='__main__':unittest.main()
