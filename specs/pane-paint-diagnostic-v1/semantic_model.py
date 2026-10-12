"""Proposed contract semantics only. No WS/adapter/capture or production caller."""
import base64,hashlib,json,math,copy
from pathlib import Path
from jsonschema import Draft202012Validator
root=Path(__file__).parent
schema=json.loads((root/'schema.json').read_text())
validator=Draft202012Validator(schema)
READS=['before','GUEST:before','GUEST:after','HOST:before','HOST:after','publish']
CAPS={'admission':0,'describe':0,'before':0,'GUEST:before':0,'GUEST:capture':0,'GUEST:png':0,'GUEST:after':1,'HOST:before':1,'HOST:capture':1,'HOST:png':1,'HOST:after':2,'publish':2}
MATRIX={'unsupported':{'admission'},'busy':{'admission'},'transport-limit':{'admission'},'stale':{'admission',*READS},'unavailable':{'describe',*READS},'read-failed':{'describe',*READS},'capture-failed':{'GUEST:capture','HOST:capture'},'invalid-image':{'GUEST:png','HOST:png'},'timeout':set(CAPS)}
def require(v):
 if not v: raise ValueError('contract violation')
def validate(message,request=None):
 def finite_json(v):
  if isinstance(v,float):require(math.isfinite(v))
  elif isinstance(v,dict):
   for x in v.values():finite_json(x)
  elif isinstance(v,list):
   for x in v:finite_json(x)
 finite_json(message)
 validator.validate(message)
 if message['type']=='request': return
 require(request is not None);validator.validate(request)
 p=message['payload'];q=request['payload']
 require(message['id']==request['id'] and p['request']==q)
 budget=q.get('timeoutMs',2000); require(p['configuredBudgetMs']==budget)
 elapsed=p['elapsedMs']; require(math.isfinite(elapsed))
 if p['outcome']=='described':
  require(q['action']=='describe' and elapsed<=budget)
  b=p['expectation']['binding']; require(b['surfaceId']==q['surfaceId'] and b['paneId']==q['paneId']);return
 if p['outcome']=='observed':
  require(q['action']=='observe' and elapsed<=budget)
  require(len(p['checks'])==6 and len(p['captures'])==2)
 else:
  stage=p['stage'];reason=p['reason'];require(stage in MATRIX[reason])
  require(len(p['captures'])==CAPS[stage])
  if q['action']=='describe': require(not p['captures'] and stage in {'admission','describe'} and not p['checks'])
  else: require(stage!='describe')
  if stage=='admission': require(not p['captures'] and not p['checks'])
  if p['nativeDrain']['state']=='complete': require(p['nativeDrain']['completedOffsetMs']<=elapsed)
  if reason=='timeout': require(elapsed>=budget)
 checks=p['checks']; imgs=p['captures']; require([c['stage'] for c in checks]==READS[:len(checks)])
 require([c['receivedOffsetMs'] for c in checks]==sorted(c['receivedOffsetMs'] for c in checks))
 require(all(math.isfinite(c['receivedOffsetMs']) and c['receivedOffsetMs']<=elapsed for c in checks))
 require([i['target'] for i in imgs]==['GUEST','HOST'][:len(imgs)])
 if q['action']=='describe':return
 expected=q['expected']; byStage={c['stage']:c for c in checks}
 def passing(stage):
  require(stage in byStage); s=byStage[stage]['state']
  require(s is not None and s['hostAttached'] and s['guestAttached'] and s['binding']==expected['binding'] and s['projection']==expected['projection'])
 if p['outcome']=='observed':
  for stage in READS: passing(stage)
 else:
  if p['stage'] in READS: require(len(checks)<=READS.index(p['stage'])+1)
  elif p['stage'].startswith('GUEST:'): require(len(checks)<=2)
  elif p['stage'].startswith('HOST:'): require(len(checks)<=4)
  ranges={'before':(0,1),'GUEST:before':(1,2),'GUEST:capture':(2,2),'GUEST:png':(2,2),'GUEST:after':(2,3),'HOST:before':(3,4),'HOST:capture':(4,4),'HOST:png':(4,4),'HOST:after':(4,5),'publish':(5,6)}
  if p['stage'] in ranges:
   lo,hi=ranges[p['stage']];require(lo<=len(checks)<=hi)
  if p['stage'] not in {'admission','before'}:passing('before')
  if p['stage'] in {'GUEST:capture','GUEST:png','GUEST:after','HOST:before','HOST:capture','HOST:png','HOST:after','publish'}:passing('GUEST:before')
  if p['stage'].startswith('HOST:') or p['stage']=='publish':passing('GUEST:after')
  if p['stage'] in {'HOST:capture','HOST:png','HOST:after','publish'}:passing('HOST:before')
  if p['stage']=='publish':passing('HOST:after')
 for i in imgs:
  target=i['target']; require(i['binding']==expected['binding'])
  require(i['coordinateSpace']==('guest-capture-pixels' if target=='GUEST' else 'host-capture-pixels'))
  require(math.isfinite(i['startedOffsetMs']) and math.isfinite(i['endedOffsetMs']))
  require(0<=i['startedOffsetMs']<=i['endedOffsetMs']<=min(elapsed,budget))
  raw=base64.b64decode(i['pngBase64'],validate=True);require(len(raw)<=2*1024*1024)
  require(hashlib.sha256(raw).hexdigest()==i['sha256'])
  passing('before');passing(target+':before')
  require(byStage[target+':before']['receivedOffsetMs']<=i['startedOffsetMs'])
  if target+':after' in byStage: require(i['endedOffsetMs']<=byStage[target+':after']['receivedOffsetMs'])
  if target=='HOST':
   passing('GUEST:after');require(imgs[0]['endedOffsetMs']<=byStage['GUEST:after']['receivedOffsetMs']<=byStage['HOST:before']['receivedOffsetMs'])
 if p['outcome']=='observed':
  a,b=imgs
  timeline=[checks[0]['receivedOffsetMs'],checks[1]['receivedOffsetMs'],a['startedOffsetMs'],a['endedOffsetMs'],checks[2]['receivedOffsetMs'],checks[3]['receivedOffsetMs'],b['startedOffsetMs'],b['endedOffsetMs'],checks[4]['receivedOffsetMs'],checks[5]['receivedOffsetMs'],elapsed]
  require(timeline==sorted(timeline))
  require(p['midpointSkewMs']==(b['startedOffsetMs']+b['endedOffsetMs']-a['startedOffsetMs']-a['endedOffsetMs'])/2)

def digest(req):return hashlib.sha256(json.dumps({'op':req['op'],'payload':req['payload']},sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
class Ledger:
 """Stateful design reference; token generation is injected, not a security implementation."""
 def __init__(self,owner='A'):
  self.owner=owner;self.ids={};self.ordinary={};self.token=None;self.active=False;self.draining=False;self.connected=True
 def ordinary_request(self,id,op='snapshot.get',payload=None):
  if id in self.ids:return 'invalid_request_id_reuse'
  value=(op,payload)
  if id in self.ordinary:return 'replay' if self.ordinary[id]==value else 'invalid_request_id_reuse'
  self.ordinary[id]=value
  if len(self.ordinary)>1024:del self.ordinary[next(iter(self.ordinary))]
  return 'ordinary-accepted'
 def begin(self,req,requester='A',now=0,supported=True,app_capacity=True):
  if not self.connected or requester!=self.owner:return 'not_paired'
  try:validate(req)
  except Exception:return 'invalid_payload'
  id=req['id'];q=req['payload']
  if id in self.ids or id in self.ordinary:return 'invalid_request_id_reuse'
  if len(self.ids)>=1024:return 'busy-saturation'
  self.ids[id]={'op':req['op'],'digest':digest(req),'state':'completed','reason':None}
  if self.active or self.draining or not app_capacity:self.ids[id]['reason']='busy';return 'busy'
  if not supported:self.ids[id]['reason']='unsupported';return 'unsupported'
  if q['action']=='observe':
   t=self.token
   if t is None or t['owner']!=requester or now>=t['expires'] or now<t['issued'] or t['used'] or q['expected']!=t['expectation']:
    self.ids[id]['reason']='stale';return 'stale'
   t['used']=True
  self.active=True;self.ids[id]['state']='pending';return 'started'
 def finish(self,req,now=0,expectation=None,outcome='observed',native_pending=False):
  id=req['id']; require(self.ids[id]['state']=='pending')
  if req['payload']['action']=='describe' and outcome=='described':
   self.token={'owner':self.owner,'issued':now,'expires':now+5000,'used':False,'expectation':copy.deepcopy(expectation)}
  self.ids[id].update(state='completed',reason=outcome);self.active=False;self.draining=native_pending
 def drain(self):self.draining=False
 def disconnect(self):
  self.connected=False;self.ids.clear();self.ordinary.clear();self.token=None
  if self.active:self.draining=True
  self.active=False
 def reconnect(self):require(not self.connected);self.connected=True
