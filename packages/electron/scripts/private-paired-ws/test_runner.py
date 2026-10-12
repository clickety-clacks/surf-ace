import importlib.util,pathlib,unittest,unittest.mock as mock,signal,tempfile,json,hashlib
spec=importlib.util.spec_from_file_location('runner',pathlib.Path(__file__).with_name('runner.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
def valid(): return dict(executionAuthorized=True,productSource=r.PRODUCT,scope='B-actual-paired-ws-synthetic-capture',slotId='owned-test',startEpoch=0,endEpoch=300,node='/opt/homebrew/bin/node',census='/private/tmp/owned-census',nodeVersion='v24.3.0',nodeSha256='a'*64,censusSha256='b'*64,manifestSha256='c'*64)
class Controls(unittest.TestCase):
    def test_exact_scope_and_source(self):
        r.admission(valid(),100)
        for key,value in [('executionAuthorized',False),('scope','A'),('productSource','stale'),('nodeVersion','v22.0.0'),('nodeSha256','')]:
            a=valid();a[key]=value
            with self.assertRaises(ValueError):r.admission(a,100)
    def test_nonfinite_expired_slot(self):
        for v in [float('nan'),float('inf'),True,None,110]:
            a=valid();a['endEpoch']=v
            with self.assertRaises(ValueError):r.admission(a,100)
    def test_common_budget(self):
        self.assertEqual(r.budget(75,0),60)
        self.assertEqual(r.budget(75,50),10)
        with self.assertRaises(ValueError):r.budget(75,50.01)
        with self.assertRaises(ValueError):r.budget(float('nan'),0)
    def test_fresh_owner_census(self):
        v=dict(nonce='n',runtimeQualified=True,clear=True,observedEpoch=99,conflicts=[],ownedRemaining=[]);r.census(v,'n',100)
        for key,value in [('nonce','stale'),('runtimeQualified',False),('observedEpoch',90),('observedEpoch',float('nan')),('conflicts',[8]),('ownedRemaining',[8])]:
            bad={**v,key:value}
            with self.assertRaises(ValueError):r.census(bad,'n',100)
    def test_group_signals_before_reaping_exited_leader(self):
        events=[];p=mock.Mock(pid=123);p.wait.side_effect=lambda timeout:events.append('wait') or 0
        with mock.patch.object(r.os,'getpgid',return_value=123),mock.patch.object(r.os,'killpg',side_effect=lambda pid,sig:events.append(sig)),mock.patch.object(r,'leader_exited',return_value=True):self.assertEqual(r.cleanup(p,0),0)
        self.assertEqual(events,[signal.SIGTERM,signal.SIGKILL,'wait'])
    def test_lost_group_refuses_signal(self):
        p=mock.Mock(pid=123)
        with mock.patch.object(r.os,'getpgid',return_value=999),mock.patch.object(r.os,'killpg') as kill:
            with self.assertRaises(ValueError):r.cleanup(p,0)
            kill.assert_not_called();p.wait.assert_not_called()
    def test_actual_entrypoint_final_gate_precedes_popen(self):
        text=pathlib.Path(r.__file__).read_text();self.assertLess(text.index('seconds=budget(deadline,time.monotonic())'),text.index('proc=subprocess.Popen'))
    def test_final_census_independent_of_collector_failure(self):
        text=pathlib.Path(r.__file__).read_text();self.assertLess(text.index('finally:'),text.index("r['postCensus']"));self.assertIn("if r['launched']:",text)
    def payload(self,root):
        (root/'app').mkdir();(root/'app/fixture.mjs').write_text('not launched');(root/'collector.mjs').write_text('not launched')
        source=pathlib.Path(__file__).resolve().parents[3]/'protocol/schema.json'
        (root/'schema.json').write_bytes(source.read_bytes());return self.manifest(root)
    def manifest(self,root):
        names=['app/fixture.mjs','collector.mjs','schema.json'];value={n:r.digest(root/n) for n in names if (root/n).exists()}
        (root/'manifest.json').write_text(json.dumps(value));return {'manifestSha256':r.digest(root/'manifest.json')}
    def test_actual_payload_validator_accepts_source_bound_schema(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();a=self.payload(root);r.verify_payload(root,a)
    def test_missing_schema_refuses_before_launch(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();a=self.payload(root);(root/'schema.json').unlink()
            with self.assertRaises(Exception):r.verify_payload(root,a)
    def test_wrong_schema_even_with_rehashed_manifest_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();self.payload(root);(root/'schema.json').write_text('{}');a=self.manifest(root)
            with self.assertRaisesRegex(ValueError,'schema source mismatch'):r.verify_payload(root,a)
    def test_ambient_neighbor_or_symlink_schema_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            parent=pathlib.Path(d).resolve();root=parent/'payload';root.mkdir();a=self.payload(root);(parent/'schema.json').write_bytes((root/'schema.json').read_bytes());(root/'schema.json').unlink();(root/'schema.json').symlink_to(parent/'schema.json')
            with self.assertRaisesRegex(ValueError,'payload mismatch'):r.verify_payload(root,a)
if __name__=='__main__':unittest.main()
