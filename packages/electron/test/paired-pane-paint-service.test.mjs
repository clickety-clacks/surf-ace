import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {deflateSync} from 'node:zlib';
import ts from 'typescript';
const cache=new Map(),nativeRequire=createRequire(import.meta.url);
function load(name){if(cache.has(name))return cache.get(name);const module={exports:{}};cache.set(name,module.exports);const src=fs.readFileSync(new URL('../src/'+name+'.ts',import.meta.url),'utf8');vm.runInNewContext(ts.transpile(src,{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}),{module,exports:module.exports,require:id=>id.startsWith('./')?load(id.slice(2,-3)):nativeRequire(id),Buffer,Uint8Array,AbortController,AbortSignal,structuredClone,performance,setTimeout,clearTimeout},{filename:name});return module.exports;}
const {PairedPanePaintService}=load('paired-pane-paint-service');
const {validPanePaintMessage,validPanePaintOutcome}=load('pane-paint-contract');
const fixtureSource=fs.readFileSync(new URL('pane-painted-observation.test.mjs',import.meta.url),'utf8');
const ast=ts.createSourceFile('fixture.mjs',fixtureSource,ts.ScriptTarget.ES2022,true);
const functions=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&['chunk','png','state','setup'].includes(n.name?.text));
assert.equal(functions.length,4);
const fixtures={Buffer,Uint8Array,deflateSync,observePanePaint:load('pane-painted-observation').observePanePaint};vm.createContext(fixtures);vm.runInContext(functions.map(n=>n.getText(ast)).join('\n')+'\nthis.make=setup;',fixtures);
function setup(enabled=true){const f=fixtures.make();f.current.binding.surfaceId='sf_abc';f.current.binding.contentId='ct_1234abcd';const timers=new Map(),clock={now:f.clock.now,schedule:(cb,ms)=>{const t={};timers.set(t,{cb,at:f.clock.now()+ms});return()=>timers.delete(t);}};let token=0;const connection={},paired=new Map([[connection,'sf_abc']]),ordinary=new Set();const ports={enabled,pairedSurface:c=>paired.get(c)||null,ordinaryIdRetained:(_c,id)=>ordinary.has(id),transportBytes:()=>8*1024*1024,adapter:()=>f.adapter,clock,token:()=>String(++token).padStart(32,'0')};const service=new PairedPanePaintService(ports);const request=(id,payload)=>({v:1,type:'request',op:'diagnostics.pane_paint.get',id,sentAt:1,payload});const describe=(id='describe',c=connection)=>service.handle(c,request(id,{action:'describe',surfaceId:'sf_abc',paneId:9}));const observe=(expected,id='observe',c=connection,budget=2000)=>service.handle(c,request(id,{action:'observe',expected,timeoutMs:budget}));const advance=n=>{f.advance(n);for(const [key,t] of [...timers])if(t.at<=clock.now()){timers.delete(key);t.cb();}};return {...f,clock,ports,service,connection,paired,ordinary,timers,describe,observe,request,advance};}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
async function expected(s){const r=await s.describe();assert.equal(r.payload.outcome,'described');assert.equal(validPanePaintMessage(r),true);return r.payload.expectation;}
function refusal(r,reason){assert.equal(r.ok,true);assert.equal(r.payload.outcome,'refused');assert.equal(r.payload.reason,reason);assert.equal(validPanePaintMessage(r),true);}
test('disabled default refuses without adapter access',async()=>{const s=setup(false);s.ports.adapter=()=>{throw Error('must not enter');};refusal(await s.describe(),'unsupported');assert.deepEqual([...s.calls],[]);});
test('paired describe and observe yield strict valid pair and timers drain',async()=>{const s=setup(),e=await expected(s),r=await s.observe(e);assert.equal(r.payload.outcome,'observed');assert.equal(validPanePaintMessage(r),true);assert.deepEqual([...s.calls],['GUEST','HOST']);assert.equal(r.payload.checks.length,6);assert.equal(r.payload.midpointSkewMs,5);assert.equal(s.service.activeCount(),0);s.service.close(s.connection);assert.equal(s.timers.size,0);});
test('unpaired, other surface and canonical ID errors refuse without capture',async()=>{const s=setup();s.paired.delete(s.connection);assert.equal((await s.describe()).error.code,'not_paired');s.paired.set(s.connection,'sf_other');assert.equal((await s.describe()).error.code,'not_paired');s.paired.set(s.connection,'sf_abc');assert.equal((await s.service.handle(s.connection,s.request('bad id',{action:'describe',surfaceId:'surface',paneId:9}))).error.code,'invalid_payload');assert.deepEqual([...s.calls],[]);});
test('completed request and ordinary-cache collisions never replay images',async()=>{const s=setup(),e=await expected(s);await s.observe(e);assert.equal((await s.observe(e)).error.code,'invalid_request_id_reuse');s.ordinary.add('ordinary');assert.equal((await s.observe(e,'ordinary')).error.code,'invalid_request_id_reuse');assert.equal(s.service.hasDiagnosticId(s.connection,'observe'),true);});
test('expiry and superseding describe invalidate previous tokens',async()=>{const s=setup(),old=await expected(s),next=(await s.describe('new')).payload.expectation;refusal(await s.observe(old,'old'),'stale');s.advance(5000);refusal(await s.observe(next,'expired'),'stale');assert.deepEqual([...s.calls],[]);assert.equal(s.timers.size,0);});
test('reply mutation cannot mutate server token expectation',async()=>{const s=setup(),e=await expected(s);e.binding.contentRevision++;refusal(await s.observe(e),'stale');assert.deepEqual([...s.calls],[]);});
test('projection changed after describe fails before capture',async()=>{const s=setup(),e=await expected(s);s.current.projection.clipRect.width--;const r=await s.observe(e);refusal(r,'stale');assert.equal(r.payload.stage,'before');assert.deepEqual([...s.calls],[]);});
test('frame incarnation changed after describe fails before capture',async()=>{const s=setup(),e=await expected(s);s.current.binding.frameInstanceId='replaced';refusal(await s.observe(e),'stale');assert.deepEqual([...s.calls],[]);});
test('bad guest stops host and bad host retains only valid guest',async()=>{for(const target of ['GUEST','HOST']){const s=setup(),e=await expected(s),capture=s.adapter.capture;s.adapter.capture=async(...args)=>{const r=await capture(...args);if(args[0]===target)r.png=Buffer.alloc(40);return r;};const r=await s.observe(e);refusal(r,'invalid-image');assert.equal(r.payload.stage,target+':png');assert.equal(r.payload.captures.length,target==='GUEST'?0:1);assert.deepEqual([...s.calls],target==='GUEST'?['GUEST']:['GUEST','HOST']);}});
test('transport refusal does not consume token',async()=>{const s=setup(),e=await expected(s);s.ports.transportBytes=()=>100;refusal(await s.observe(e,'small'),'transport-limit');s.ports.transportBytes=()=>8*1024*1024;assert.equal((await s.observe(e,'larger')).payload.outcome,'observed');});
test('metadata ledger saturates1024 without evicting or retaining images',async()=>{const s=setup(false);for(let i=0;i<1024;i++)refusal(await s.describe('id'+i),'unsupported');refusal(await s.describe('overflow'),'busy');assert.equal(s.service.hasDiagnosticId(s.connection,'overflow'),false);assert.equal((await s.describe('id0')).error.code,'invalid_request_id_reuse');});
test('native timeout reports overrun and holds capacity until safe drain',async()=>{const s=setup(),e=await expected(s);let release,started;const entered=new Promise(resolve=>{started=resolve;});s.adapter.capture=()=>new Promise(resolve=>{release=resolve;started();});const pending=s.observe(e);await entered;s.advance(2001);const r=await pending;refusal(r,'timeout');assert.equal(r.payload.elapsedMs,2001);assert.equal(r.payload.nativeDrain.state,'pending');assert.equal(s.service.activeCount(),1);refusal(await s.describe('during'),'busy');release({target:'GUEST',binding:s.current.binding,png:fixtures.png(),pixelWidth:2,pixelHeight:1});await new Promise(setImmediate);assert.equal(s.service.activeCount(),0);});
test('disconnect suppresses late pixels and keeps native capacity until drain',async()=>{const s=setup(),e=await expected(s);let release,started;const entered=new Promise(resolve=>{started=resolve;});s.adapter.capture=()=>new Promise(resolve=>{release=resolve;started();});const pending=s.observe(e);await entered;s.service.close(s.connection);s.paired.delete(s.connection);s.advance(2001);assert.equal(await pending,null);assert.equal(s.service.activeCount(),1);release({target:'GUEST',binding:s.current.binding,png:fixtures.png(),pixelWidth:2,pixelHeight:1});await new Promise(setImmediate);assert.equal(s.service.activeCount(),0);assert.equal(s.timers.size,0);});
test('two application slots cap simultaneous native work across connections',async()=>{const s=setup(),b={},c={};s.paired.set(b,'sf_abc');s.paired.set(c,'sf_abc');const ea=await expected(s),eb=(await s.describe('db',b)).payload.expectation,releases=[];let started;const entered=new Promise(resolve=>{started=resolve;});s.adapter.capture=()=>new Promise(resolve=>{releases.push(resolve);if(releases.length===2)started();});const a=s.observe(ea,'a'),bb=s.observe(eb,'b',b);await entered;refusal(await s.describe('c',c),'busy');s.advance(2001);await a;await bb;assert.equal(s.service.activeCount(),2);for(const release of releases)release({target:'GUEST',binding:s.current.binding,png:fixtures.png(),pixelWidth:2,pixelHeight:1});await new Promise(setImmediate);assert.equal(s.service.activeCount(),0);});

test('close aborts owned signal and prevents HOST after a guest completes before deadline',async()=>{const s=setup(),e=await expected(s);let release,entered,seenSignal;const started=new Promise(r=>{entered=r;});s.adapter.capture=(target,_frame,signal)=>{s.calls.push(target);seenSignal=signal;entered();return new Promise(r=>{release=r;});};const pending=s.observe(e);await started;s.service.close(s.connection);assert.equal(seenSignal.aborted,true);release({target:'GUEST',binding:s.current.binding,png:fixtures.png(),pixelWidth:2,pixelHeight:1});assert.equal(await pending,null);assert.deepEqual([...s.calls],['GUEST']);assert.equal(s.service.activeCount(),0);});
test('slow token creation yields truthful timeout and preserves previous token',async()=>{const s=setup(),e=await expected(s);s.ports.token=()=>{s.advance(2001);return 'b'.repeat(32);};const r=await s.describe('slow');refusal(r,'timeout');assert.equal(r.payload.stage,'describe');assert.equal(r.payload.elapsedMs,2001);assert.equal((await s.observe(e,'oldstillvalid')).payload.outcome,'observed');});
test('pending duplicate and busy rejection cannot consume another connection token',async()=>{const s=setup(),e=await expected(s);let release,entered;const started=new Promise(r=>{entered=r;});s.adapter.capture=()=>{entered();return new Promise(r=>{release=r;});};const pending=s.observe(e);await started;assert.equal((await s.observe(e)).error.code,'invalid_request_id_reuse');refusal(await s.describe('busy'),'busy');s.advance(2001);await pending;release({target:'GUEST',binding:s.current.binding,png:fixtures.png(),pixelWidth:2,pixelHeight:1});await new Promise(setImmediate);refusal(await s.observe(e,'used'),'stale');});
test('embedded contract is exact PR97 reference and canonical protocol IDs',()=>{const schema=load('pane-paint-contract').panePaintSchemaReference();const crypto=nativeRequire('node:crypto');assert.equal(crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex'),'e36bd549a9cbabf0ce652c9b608e81d50a32dc200ee64cec21fa571ceb0578ee');const protocol=JSON.parse(fs.readFileSync(new URL('../../protocol/schema.json',import.meta.url),'utf8'));for(const key of ['RequestId','SurfaceId','ContentId'])assert.deepEqual(structuredClone(schema.$defs[key]),protocol.$defs[key]);});
test('request unknown fields, malformed tokens and missing projection are invalid before state',async()=>{for(const mutate of [q=>q.payload.script='arbitrary',q=>q.payload.expected.observationToken='bad',q=>delete q.payload.expected.projection]){const s=setup(),e=await expected(s),q=s.request('new',{action:'observe',expected:e,timeoutMs:2000});mutate(q);assert.equal((await s.service.handle(s.connection,q)).error.code,'invalid_payload');assert.deepEqual([...s.calls],[]);assert.equal(s.service.hasDiagnosticId(s.connection,'new'),false);}});
test('byte cap prevents oversized raw guest evidence',async()=>{const s=setup(),e=await expected(s),capture=s.adapter.capture;s.adapter.capture=async(...args)=>({...await capture(...args),png:Buffer.alloc(2*1024*1024+1)});const r=await s.observe(e);refusal(r,'invalid-image');assert.equal(r.payload.captures.length,0);assert.deepEqual([...s.calls],['GUEST']);});

test('malformed authority state cannot issue an observation token',async()=>{const s=setup();s.current.projection.hostRect.width=0;refusal(await s.describe(),'unavailable');assert.deepEqual([...s.calls],[]);assert.equal(s.timers.size,0);});

function semanticReply(request,response){
 assert.equal(validPanePaintOutcome(response,request),true);
 const {spawnSync}=nativeRequire('node:child_process');
 const reference=new URL('pane-paint-contract-reference/',import.meta.url).pathname;
 const result=spawnSync('python3',['-c','import json,sys;sys.path.insert(0,sys.argv[1]);from semantic_model import validate;pair=json.load(sys.stdin);validate(pair[1],pair[0])',reference],{input:JSON.stringify([request,response]),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stderr);
}
test('one millisecond budget retains fractional admission and uses original absolute deadline',async()=>{
 const s=setup(),e=await expected(s);s.ports.adapter=()=>{s.advance(.25);return s.adapter;};
 s.adapter.capture=async target=>{s.calls.push(target);return {target,binding:s.current.binding,png:fixtures.png(),pixelWidth:2,pixelHeight:1};};
 const q=s.request('fractional-fast',{action:'observe',expected:e,timeoutMs:1}),r=await s.service.handle(s.connection,q);
 assert.equal(r.payload.outcome,'observed');assert.equal(r.payload.elapsedMs,.25);assert.deepEqual([...s.calls],['GUEST','HOST']);semanticReply(q,r);s.service.close(s.connection);
});
test('fractional pending native capture cannot timeout before configured public deadline',async()=>{
 const s=setup(),e=await expected(s);let release,entered;const started=new Promise(r=>entered=r);
 s.ports.adapter=()=>{s.advance(.25);return s.adapter;};s.adapter.capture=()=>{entered();return new Promise(r=>release=r);};
 const q=s.request('fractional-pending',{action:'observe',expected:e,timeoutMs:2000});let settled=false;const pending=s.service.handle(s.connection,q).then(r=>{settled=true;return r;});await started;
 s.advance(1999);await new Promise(setImmediate);assert.equal(settled,false);s.advance(.75);const r=await pending;
 refusal(r,'timeout');assert.equal(r.payload.elapsedMs,2000);semanticReply(q,r);assert.equal(s.service.activeCount(),1);
 release({target:'GUEST',binding:s.current.binding,png:fixtures.png(),pixelWidth:2,pixelHeight:1});await new Promise(setImmediate);assert.equal(s.service.activeCount(),0);s.service.close(s.connection);
});
test('early timer delivery rearms without certifying budget exhaustion',async()=>{
 const s=setup(),e=await expected(s);let release,entered;const started=new Promise(r=>entered=r);s.adapter.capture=()=>{entered();return new Promise(r=>release=r);};
 const q=s.request('early',{action:'observe',expected:e,timeoutMs:1});let settled=false;const pending=s.service.handle(s.connection,q).then(r=>{settled=true;return r;});await started;
 const [key,t]=[...s.timers].find(([,t])=>t.at<=1);s.timers.delete(key);s.advance(.5);t.cb();await new Promise(setImmediate);assert.equal(settled,false);
 s.advance(.5);const r=await pending;semanticReply(q,r);assert.equal(r.payload.elapsedMs,1);release(null);await new Promise(setImmediate);s.service.close(s.connection);
});
test('backward positive clock suppresses all diagnostic evidence rather than reporting timeout',async()=>{
 const s=setup(),e=await expected(s),read=s.adapter.readState,capture=s.adapter.capture;
 s.adapter.readState=async(...a)=>{s.advance(10);return read(...a);};s.adapter.capture=async(...a)=>{const r=await capture(...a);s.advance(-10);return r;};
 const r=await s.observe(e);assert.equal(r.ok,false);assert.equal(r.error.code,'internal_error');assert.equal('payload' in r,false);assert.deepEqual([...s.calls],['GUEST']);assert.equal(s.service.activeCount(),0);s.service.close(s.connection);assert.equal(s.timers.size,0);
});
test('nonfinite throwing and unrepresentable clocks suppress payload and retain pending drain safely',async()=>{
 for(const fault of [()=>NaN,()=>Infinity,()=>Number.MAX_SAFE_INTEGER+1,()=>{throw Error('clock');}]){
  const s=setup(),e=await expected(s);let release,entered;const started=new Promise(r=>entered=r);s.adapter.capture=()=>{entered();return new Promise(r=>release=r);};
  const pending=s.observe(e);await started;s.clock.now=fault;
  const [key,t]=[...s.timers].find(([,t])=>t.at===2000);s.timers.delete(key);t.cb();const r=await pending;
  assert.equal(r.ok,false);assert.equal(r.error.code,'internal_error');assert.equal('payload' in r,false);assert.equal(s.service.activeCount(),1);
  release(null);await new Promise(setImmediate);assert.equal(s.service.activeCount(),0);s.service.close(s.connection);assert.equal(s.timers.size,0);
 }
});

test('publication semantic fence rejects premature and contradictory retained receipts',async()=>{
 const s=setup(),e=await expected(s),q=s.request('semantic',{action:'observe',expected:e,timeoutMs:2000}),r=await s.service.handle(s.connection,q);
 semanticReply(q,r);
 for(const change of [p=>{p.outcome='refused';p.reason='timeout';p.stage='publish';p.nativeDrain={state:'not-required'};delete p.consistency;delete p.midpointSkewMs;},p=>p.elapsedMs=1,p=>p.checks[1].receivedOffsetMs=30,p=>p.captures[0].endedOffsetMs=50,p=>p.checks[2].state.binding.guestId=99,p=>p.request.timeoutMs=1]){
  const bad=structuredClone(r);change(bad.payload);assert.equal(validPanePaintOutcome(bad,q),false);
 }s.service.close(s.connection);
});

test('one invalid clock read stays fatal even if subsequent describe clock reads recover',async()=>{
 const s=setup();let entered,release;const started=new Promise(r=>entered=r);s.adapter.readState=()=>{entered();return new Promise(r=>release=r);};
 const pending=s.describe();await started;const read=s.clock.now;let once=true;s.clock.now=()=>{if(once){once=false;return NaN;}return read();};
 const [key,t]=[...s.timers].find(([,t])=>t.at===2000);s.timers.delete(key);t.cb();const r=await pending;assert.equal(r.ok,false);assert.equal(r.error.code,'internal_error');assert.equal('payload' in r,false);assert.equal(s.service.activeCount(),1);release(s.current);await new Promise(setImmediate);assert.equal(s.service.activeCount(),0);s.service.close(s.connection);
});

for(const origin of [0,.1,1000.1,100000.1,10000000.123,12345678.123456]) test(`fractional capture origin ${origin} publishes normative relative-offset midpoint`,async()=>{
 const s=setup();s.advance(origin);const e=await expected(s);
 s.adapter.capture=async target=>{s.calls.push(target);s.advance(target==='GUEST'?.13:.27);return {target,binding:s.current.binding,png:fixtures.png(),pixelWidth:2,pixelHeight:1};};
 const q=s.request('fractional-origin',{action:'observe',expected:e,timeoutMs:2000}),r=await s.service.handle(s.connection,q);
 assert.equal(r.ok,true);assert.equal(r.payload.outcome,'observed');assert.deepEqual([...s.calls],['GUEST','HOST']);
 const[a,b]=r.payload.captures;assert.equal(r.payload.midpointSkewMs,(b.startedOffsetMs+b.endedOffsetMs-a.startedOffsetMs-a.endedOffsetMs)/2);
 semanticReply(q,r);s.service.close(s.connection);assert.equal(s.timers.size,0);
});
