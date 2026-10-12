import base64,copy,hashlib,importlib.util,json,unittest
from pathlib import Path
from jsonschema import Draft202012Validator
root=Path(__file__).parent
spec=importlib.util.spec_from_file_location('model',root/'semantic_model.py');model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)
state={'binding':{'surfaceId':'sf_abc','surfaceEpoch':'epoch','windowInstanceId':'window','paneLineageId':'lineage','contentId':'ct_1234abcd','frameInstanceId':'frame','hostWebContentsId':1,'paneId':9,'guestId':11,'contentRevision':9,'topologyRevision':523,'geometryRevision':10,'renderGeneration':2,'documentGeneration':3,'contentType':'html'},'projection':{'coordinateSpace':'surface-css-px','guestCoordinateSpace':'guest-css-px','hostRect':{'x':0,'y':0,'width':100,'height':80},'clipRect':{'x':0,'y':0,'width':100,'height':80},'guestViewport':{'width':100,'height':80,'scrollX':0,'scrollY':0},'guestToSurface':[1,0,0,1,0,0],'devicePixelRatio':2,'scaleMode':'host-transform','scaleSequence':1,'scaleNonce':'nonce','scaleRevision':1,'hostVisible':True,'opacity':1}}
expect={'observationToken':'a'*32,**copy.deepcopy(state)}
flags={'atomic':False,'paintFreshness':'not-established','physicalDisplay':'not-observed'}
def env(payload,t='response',id='request'):return {'v':1,'type':t,'op':'diagnostics.pane_paint.get','id':id,'sentAt':1,**({'ok':True} if t=='response' else {}),'payload':payload}
def observe(id='request',expected=None,budget=2000):return env({'action':'observe','expected':copy.deepcopy(expected or expect),'timeoutMs':budget},'request',id)
def describe(id='describe'):return env({'action':'describe','surfaceId':'sf_abc','paneId':9},'request',id)
def image(target,start,end):
 raw=b'opaque bytes: shape/hash model only, not PNG validation'
 return {'target':target,'binding':copy.deepcopy(state['binding']),'coordinateSpace':'guest-capture-pixels' if target=='GUEST' else 'host-capture-pixels','pngBase64':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest(),'pixelWidth':2,'pixelHeight':1,'startedOffsetMs':start,'endedOffsetMs':end}
def checks():return [{'stage':s,'receivedOffsetMs':t,'state':{'hostAttached':True,'guestAttached':True,**copy.deepcopy(state)}} for s,t in [('before',0),('GUEST:before',0),('GUEST:after',4),('HOST:before',4),('HOST:after',10),('publish',10)]]
def observed(req=None):
 req=req or observe()
 return env({'outcome':'observed','request':copy.deepcopy(req['payload']),'configuredBudgetMs':req['payload']['timeoutMs'],'captures':[image('GUEST',0,4),image('HOST',4,10)],'checks':checks(),'midpointSkewMs':5,'elapsedMs':10,'consistency':'binding-and-projection-stable-at-observation-checks',**flags},id=req['id'])
def refusal(reason='invalid-image',stage='HOST:png',images=None,reads=None,elapsed=10,req=None,drain=None):
 req=req or observe()
 return env({'outcome':'refused','request':copy.deepcopy(req['payload']),'configuredBudgetMs':req['payload'].get('timeoutMs',2000),'reason':reason,'stage':stage,'captures':copy.deepcopy(images or []),'checks':copy.deepcopy(reads or []),'elapsedMs':elapsed,'nativeDrain':drain or {'state':'not-required'},**flags},id=req['id'])
def setup_ledger():
 l=model.Ledger();q=describe();assert l.begin(q)=='started';l.finish(q,outcome='described',expectation=copy.deepcopy(expect));return l
class Contract(unittest.TestCase):
 def reject(self,m,req=None):
  with self.assertRaises(Exception):model.validate(m,req or observe())
 def test_schema_and_canonical_definitions(self):
  Draft202012Validator.check_schema(model.schema)
  old=json.loads((root.parent.parent/'packages/protocol/schema.json').read_text())['$defs']
  for k in ['RequestId','SurfaceId','ContentId']:self.assertEqual(model.schema['$defs'][k],old[k])
 def test_canonical_positives(self):
  for id in ['id','A.z_9:-','x'*64]:model.validate(observe(id));model.validate(describe(id))
 def test_id_negatives(self):
  for id in ['with space','x'*65,'','/bad']:self.reject(observe(id))
  for key,bad in [('surfaceId','surface'),('surfaceId','sf_a'),('contentId','content'),('contentId','ct_ABCDef00')]:
   q=observe();q['payload']['expected']['binding'][key]=bad;self.reject(q)
 def test_requests_and_described(self):
  q=describe();model.validate(q)
  m=env({'outcome':'described','request':q['payload'],'configuredBudgetMs':2000,'expectation':expect,'expiresAfterMs':5000,'elapsedMs':2,**flags},id=q['id']);model.validate(m,q)
 def test_observed(self):model.validate(observed(),observe())
 def test_all_zero_checks_negative(self):
  for t in [0,10]:
   m=observed()
   for c in m['payload']['checks']:c['receivedOffsetMs']=t
   self.reject(m)
 def test_each_check_misordered(self):
  for i,t in [(0,1),(1,2),(2,3),(3,7),(4,9),(5,9)]:
   m=observed();m['payload']['checks'][i]['receivedOffsetMs']=t;self.reject(m)
 def test_request_correlation(self):
  for change in [lambda m:m.update(id='other'),lambda m:m['payload']['request']['expected']['binding'].update(contentRevision=10),lambda m:m['payload'].update(configuredBudgetMs=1999)]:
   m=observed();change(m);self.reject(m)
 def test_observed_changed_identity_projection_and_target(self):
  for change in [lambda p:p['checks'][2]['state']['binding'].update(documentGeneration=9),lambda p:p['checks'][3]['state']['projection']['clipRect'].update(width=1),lambda p:p['checks'][5]['state'].update(guestAttached=False),lambda p:p['captures'].reverse(),lambda p:p.update(atomic=True),lambda p:p.update(physicalDisplay='observed')]:
   m=observed();change(m['payload']);self.reject(m)
 def test_invalid_guest_and_host_partials(self):
  model.validate(refusal(stage='GUEST:png',reads=checks()[:2]),observe())
  m=refusal(images=[image('GUEST',0,4)],reads=checks()[:4]);model.validate(m,observe())
  for change in [lambda p:p['captures'][0]['binding'].update(guestId=99),lambda p:p['captures'][0].update(coordinateSpace='host-capture-pixels'),lambda p:p['captures'][0].update(sha256='b'*64),lambda p:p['captures'][0].update(startedOffsetMs=5),lambda p:p['checks'][1]['state'].update(hostAttached=False),lambda p:p['checks'][2].update(receivedOffsetMs=3)]:
   bad=copy.deepcopy(m);change(bad['payload']);self.reject(bad)
 def test_host_failure_cannot_drop_valid_guest(self):
  self.reject(refusal('invalid-image','HOST:png',reads=checks()[:4]))
  self.reject(refusal('capture-failed','HOST:capture',reads=checks()[:4]))
 def test_pre_capture_refusals_no_images_or_checks(self):
  for reason in ['unsupported','busy','transport-limit','stale']:
   m=refusal(reason,stage='admission');model.validate(m,observe())
   for key,value in [('captures',[image('GUEST',0,4)]),('checks',checks()[:1])]:
    bad=copy.deepcopy(m);bad['payload'][key]=value;self.reject(bad)
 def test_reason_stage_caps(self):
  cases=[('invalid-image','GUEST:png',1),('invalid-image','HOST:png',2),('capture-failed','GUEST:capture',1),('capture-failed','HOST:capture',2),('stale','before',1),('stale','GUEST:before',1),('read-failed','HOST:before',2)]
  for reason,stage,count in cases:self.reject(refusal(reason,stage,images=[image('GUEST',0,4),image('HOST',4,10)][:count],reads=checks()))
  for reason,stage in [('busy','publish'),('transport-limit','publish'),('unsupported','HOST:png'),('invalid-image','publish'),('capture-failed','HOST:after')]:self.reject(refusal(reason,stage))
 def test_failed_state_retained_partial_not_passing(self):
  r=checks()[:3];r[2]['state']['binding']['documentGeneration']=4
  m=refusal('stale','GUEST:after',[image('GUEST',0,4)],r);model.validate(m,observe())
  m=refusal('unavailable','GUEST:after',[image('GUEST',0,4)],checks()[:3]);m['payload']['checks'][2]['state']=None;model.validate(m,observe())
 def test_two_partial_images_at_final_fence(self):
  r=checks();r[-1]['state']['projection']['clipRect']['width']=1
  model.validate(refusal('stale','publish',[image('GUEST',0,4),image('HOST',4,10)],r),observe())
 def test_describe_refusals(self):
  q=describe()
  for reason,stage in [('unsupported','admission'),('busy','admission'),('read-failed','describe'),('unavailable','describe')]:model.validate(refusal(reason,stage,req=q),q)
  self.reject(refusal('invalid-image','HOST:png',req=q),q)
 def test_measured_scheduling_overrun(self):
  model.validate(refusal('timeout','GUEST:capture',reads=checks()[:2],elapsed=2001,drain={'state':'pending'}),observe())
 def test_synchronous_decode_overrun(self):
  model.validate(refusal('timeout','HOST:png',images=[image('GUEST',0,4)],reads=checks()[:4],elapsed=2600),observe())
 def test_late_native_drain_truthful(self):
  model.validate(refusal('timeout','GUEST:capture',reads=checks()[:2],elapsed=7100,drain={'state':'complete','completedOffsetMs':7000}),observe())
  self.reject(refusal('timeout','GUEST:capture',elapsed=2500,drain={'state':'complete','completedOffsetMs':7000}))
 def test_success_and_partial_bound_to_budget(self):
  q=observe(budget=9);self.reject(observed(q),q)
  m=refusal('timeout','HOST:after',[image('GUEST',0,4),image('HOST',4,2001)],checks()[:4],elapsed=2005);self.reject(m)
 def test_false_timeout_or_nonfinite(self):
  self.reject(refusal('timeout','GUEST:capture',elapsed=1999))
  self.reject(refusal('timeout','GUEST:capture',elapsed=float('inf')))
 def test_duplicate_pending_completed_and_changed_payload(self):
  l=setup_ledger();q=observe();self.assertEqual(l.begin(q),'started');self.assertEqual(l.begin(q),'invalid_request_id_reuse');l.finish(q)
  self.assertEqual(l.begin(q),'invalid_request_id_reuse');q['payload']['timeoutMs']=1;self.assertEqual(l.begin(q),'invalid_request_id_reuse')
 def test_cross_operation_collisions(self):
  l=setup_ledger();self.assertEqual(l.ordinary_request('shared'),'ordinary-accepted');self.assertEqual(l.begin(observe('shared')),'invalid_request_id_reuse')
  q=observe('diag');self.assertEqual(l.begin(q),'started');l.finish(q);self.assertEqual(l.ordinary_request('diag'),'invalid_request_id_reuse')
  self.assertEqual(l.ordinary_request('shared'),'replay');self.assertEqual(l.ordinary_request('shared',payload='changed'),'invalid_request_id_reuse')
 def test_reused_id_with_fresh_token_rejected(self):
  l=setup_ledger();q=observe('once');self.assertEqual(l.begin(q),'started');l.finish(q)
  new=copy.deepcopy(expect);new['observationToken']='b'*32;d=describe('newdescribe');self.assertEqual(l.begin(d),'started');l.finish(d,outcome='described',expectation=new)
  self.assertEqual(l.begin(observe('once',new)),'invalid_request_id_reuse');self.assertFalse(l.token['used'])
 def test_token_supersession_and_expiry(self):
  l=setup_ledger();new=copy.deepcopy(expect);new['observationToken']='b'*32;d=describe('new');self.assertEqual(l.begin(d),'started');l.finish(d,expectation=new,outcome='described')
  self.assertEqual(l.begin(observe('old')),'stale');self.assertFalse(l.token['used']);self.assertEqual(l.begin(observe('expired',new),now=5001),'stale');self.assertEqual(l.begin(observe('atExpiry',new),now=5000),'stale')
 def test_busy_does_not_consume_token_but_records_id(self):
  l=setup_ledger();q=observe('busy');self.assertEqual(l.begin(q,app_capacity=False),'busy');self.assertFalse(l.token['used']);self.assertEqual(l.begin(q),'invalid_request_id_reuse');self.assertEqual(l.begin(observe('fresh')),'started')
 def test_unsupported_does_not_consume_token(self):
  l=setup_ledger();self.assertEqual(l.begin(observe('unsupported'),supported=False),'unsupported');self.assertFalse(l.token['used'])
 def test_failed_observe_stays_consumed(self):
  l=setup_ledger();q=observe();self.assertEqual(l.begin(q),'started');l.finish(q,outcome='timeout',native_pending=True)
  self.assertEqual(l.begin(observe('duringDrain')),'busy');l.drain();self.assertEqual(l.begin(observe('afterDrain')),'stale')
 def test_failed_describe_preserves_prior_token(self):
  l=setup_ledger();q=describe('failed');self.assertEqual(l.begin(q),'started');l.finish(q,outcome='read-failed');self.assertEqual(l.begin(observe()),'started')
 def test_saturation_no_eviction_no_token_change(self):
  l=setup_ledger()
  for i in range(1023):self.assertEqual(l.begin(observe('reject'+str(i)),supported=False),'unsupported')
  self.assertEqual(len(l.ids),1024);self.assertEqual(l.begin(observe('overflow')),'busy-saturation');self.assertNotIn('overflow',l.ids);self.assertFalse(l.token['used']);self.assertIn('describe',l.ids)
 def test_ordinary_eviction_scope(self):
  l=setup_ledger()
  for i in range(1025):self.assertEqual(l.ordinary_request('ordinary'+str(i)),'ordinary-accepted')
  self.assertEqual(len(l.ordinary),1024);self.assertEqual(l.begin(observe('ordinary0')),'started');self.assertEqual(l.begin(observe('ordinary1')),'invalid_request_id_reuse')
 def test_disconnect_repair_old_tokens_refuse(self):
  l=setup_ledger();l.disconnect();self.assertEqual(l.begin(observe()),'not_paired');l.reconnect();self.assertEqual(l.begin(observe()),'stale')
  d=describe('describe');self.assertEqual(l.begin(d),'started');new=copy.deepcopy(expect);new['observationToken']='c'*32;l.finish(d,outcome='described',expectation=new);self.assertEqual(l.begin(observe('request',new)),'invalid_request_id_reuse');self.assertEqual(l.begin(observe('newrequest',new)),'started')
 def test_disconnect_pending_native_holds_capacity(self):
  l=setup_ledger();q=observe();self.assertEqual(l.begin(q),'started');l.disconnect();l.reconnect();self.assertEqual(l.begin(describe('repaired')),'busy');l.drain();self.assertEqual(l.begin(describe('afterdrain')),'started')
 def test_foreign_controller_and_malformed_no_side_effect(self):
  l=setup_ledger();prior=copy.deepcopy(l.ids)
  self.assertEqual(l.begin(observe(),requester='B'),'not_paired');q=observe();q['payload']['script']='evil';self.assertEqual(l.begin(q),'invalid_payload');self.assertEqual(l.ids,prior);self.assertFalse(l.token['used'])
if __name__=='__main__':unittest.main(verbosity=2)
