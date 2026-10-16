import test from 'node:test';import assert from 'node:assert/strict';
import {AnnotationDoneFence} from '../src/annotation-done-state.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('pending paints immediately and two taps share exactly one held operation',async()=>{
 const held=deferred();let calls=0;const phases=[];const gate=new AnnotationDoneFence(()=>phases.push(gate.snapshot('pane','frame').phase));
 const operation=async saved=>{calls++;await held.promise;saved();};
 const a=gate.finish('pane','frame',()=>true,operation),b=gate.finish('pane','frame',()=>true,operation);
 assert.equal(a,b);assert.equal(gate.snapshot('pane','frame').phase,'saving');assert.equal(gate.snapshot('pane','frame').busy,true);
 await Promise.resolve();assert.equal(calls,1);held.resolve();const r=await a;assert.equal(r.phase,'saved');assert.deepEqual(phases,['saving','finishing','saved']);
});
test('unknown local write and failure after durable save remain distinct and never registry/processed claims',async()=>{
 const gate=new AnnotationDoneFence();const first=await gate.finish('a','frame',()=>true,async()=>{throw Error('outcome unknown');});assert.deepEqual(first,{phase:'unknown',busy:false,localSaved:false});
 const second=await gate.finish('b','frame',()=>true,async saved=>{saved();throw Error('direct delivery pending');});assert.deepEqual(second,{phase:'waiting',busy:false,localSaved:true});assert.equal('registryAccepted' in second,false);assert.equal('processedAck' in second,false);
});
test('a resolved operation without an explicit durable boundary never invents Saved',async()=>{
 const gate=new AnnotationDoneFence();assert.equal((await gate.finish('a','frame',()=>true,async()=>{})).phase,'unknown');
});
test('changed context is refused while previous work is held; sibling pane can finish independently',async()=>{
 const gate=new AnnotationDoneFence(),held=deferred();let wrongCalls=0;const old=gate.finish('a','old',()=>true,async saved=>{await held.promise;saved();});
 const wrong=await gate.finish('a','new',()=>true,async()=>{wrongCalls++;});assert.equal(wrong.phase,'busy');assert.equal(wrong.localSaved,false);assert.equal(wrongCalls,0);
 assert.equal((await gate.finish('b','other',()=>true,async saved=>saved())).phase,'saved');held.resolve();await old;
});
test('stale before entry or after held completion cannot become current Saved; state is returned by value',async()=>{
 const gate=new AnnotationDoneFence();let calls=0;assert.equal((await gate.finish('a','old',()=>false,async()=>{calls++;})).phase,'stale');assert.equal(calls,0);
 const held=deferred();let current=true;const work=gate.finish('a','old',()=>current,async saved=>{await held.promise;saved();});await Promise.resolve();current=false;held.resolve();const result=await work;assert.equal(result.phase,'stale');assert.equal(result.localSaved,false);result.phase='saved';assert.equal(gate.snapshot('a','old').phase,'stale');assert.equal(gate.snapshot('a','new').phase,'idle');
});
test('notification failure cannot undo saved boundary and retained busy entry cannot be forgotten',async()=>{
 const gate=new AnnotationDoneFence(()=>{throw Error('UI failure');}),held=deferred();const work=gate.finish('a','frame',()=>true,async saved=>{await held.promise;saved();});gate.forget('a');assert.equal(gate.snapshot('a','frame').busy,true);held.resolve();assert.equal((await work).phase,'saved');gate.forget('a');assert.equal(gate.snapshot('a','frame').phase,'idle');
});
test('late saved callback after settled unknown cannot reopen a pending fence or invent Saved',async()=>{
 const gate=new AnnotationDoneFence();let late;const result=await gate.finish('a','frame',()=>true,async saved=>{late=saved;});assert.equal(result.phase,'unknown');late();assert.deepEqual(gate.snapshot('a','frame'),{phase:'unknown',busy:false,localSaved:false});
});
test('context read failure refuses entry or retires held work without leaving a busy fence',async()=>{
 const gate=new AnnotationDoneFence();let calls=0;assert.equal((await gate.finish('a','frame',()=>{throw Error('pane gone');},async()=>{calls++;})).phase,'stale');assert.equal(calls,0);
 const held=deferred();let broken=false;const work=gate.finish('a','frame',()=>{if(broken)throw Error('pane gone');return true;},async saved=>{await held.promise;saved();});await Promise.resolve();broken=true;held.resolve();assert.equal((await work).phase,'stale');assert.equal(gate.snapshot('a','frame').busy,false);
});
test('bounded spinner expiry retains submit ownership until the real operation settles',async()=>{
 let expire;let cancelled=0;const held=deferred();let calls=0;
 const gate=new AnnotationDoneFence(()=>{},{schedule:cb=>{expire=cb;return 1;},cancel:()=>{cancelled++;}});
 const operation=async saved=>{calls++;await held.promise;saved();};
 const work=gate.finish('a','frame',()=>true,operation);await Promise.resolve();expire();
 assert.deepEqual(gate.snapshot('a','frame'),{phase:'waiting',busy:true,localSaved:false});
 assert.equal(gate.finish('a','frame',()=>true,operation),work);assert.equal(calls,1);
 held.resolve();assert.equal((await work).phase,'saved');assert.equal(cancelled,1);
});
test('late local-save proof cannot restart an expired spinner while later delivery remains held',async()=>{
 let expire,saved;const held=deferred();
 const gate=new AnnotationDoneFence(()=>{},{schedule:cb=>{expire=cb;return 1;},cancel:()=>{}});
 const work=gate.finish('a','frame',()=>true,async proof=>{saved=proof;await held.promise;});
 await Promise.resolve();expire();saved();
 assert.deepEqual(gate.snapshot('a','frame'),{phase:'waiting',busy:true,localSaved:true});
 held.resolve();assert.equal((await work).phase,'saved');
});
