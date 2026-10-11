import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import vm from'node:vm';import ts from'typescript';
const source=fs.readFileSync(new URL('../src/renderer/browser-content-scale.ts',import.meta.url),'utf8');const mod={exports:{}};
vm.runInNewContext(ts.transpile(source,{module:ts.ModuleKind.CommonJS}),{module:mod,exports:mod.exports});
const script=mod.exports.browserContentScaleScript;
function setup(){const frames=[],events=[],fits=[];class Element{isConnected=true;matches(){return true}querySelector(){return{}}}
 const document={documentElement:{style:{zoom:'0.85'}},body:{style:{setProperty(){}}},querySelectorAll:()=>[element]};
 const element=new Element();element.ownerDocument=document;
 const term={element,options:{fontSize:16},fit(){fits.push(this.options.fontSize)}};const window={term,dispatchEvent:e=>events.push(e)};
 const context=vm.createContext({window,document,HTMLElement:Element,requestAnimationFrame:f=>frames.push(f),Event:class{constructor(type){this.type=type}}});
 return{window,document,term,frames,events,fits,run:s=>vm.runInContext(script(s),context)};
}
test('supported one owned public terminal changes font at unit root zoom without replacing terminal',()=>{
 const s=setup(),old=s.term;const result=s.run(.935);assert.equal(result.mode,'public-terminal-font');assert.equal(s.term.options.fontSize,14.96);assert.equal(s.document.documentElement.style.zoom,'');assert.equal(s.window.term,old);assert.deepEqual(s.fits,[14.96]);s.frames.shift()();assert.deepEqual(s.fits,[14.96,14.96]);assert.equal(s.events[0].type,'resize');
});
test('repeated zoom/reset derives from captured original font and skips obsolete deferred fits',()=>{
 const s=setup();s.run(.85);s.run(.935);s.run(.85);assert.equal(s.term.options.fontSize,13.6);const before=s.fits.length;s.frames[0]();s.frames[1]();assert.equal(s.fits.length,before);s.frames[2]();assert.equal(s.fits.length,before+1);
});
test('other guests remain independent despite same source and scales',()=>{
 const a=setup(),b=setup();a.run(.85);b.run(.935);a.run(1.1);assert.equal(a.term.options.fontSize,17.6);assert.equal(b.term.options.fontSize,14.96);
});
test('ordinary page and unsupported/stale/multiple terminal keep prior document zoom contract',()=>{
 for(const change of [s=>delete s.window.term,s=>s.term.element.isConnected=false,s=>s.term.element.ownerDocument={},s=>s.term.fit=null,s=>s.document.querySelectorAll=()=>[s.term.element,s.term.element],s=>s.term.options.fontSize=NaN]){
  const s=setup();change(s);assert.equal(s.run(.935).mode,'document-zoom');assert.equal(s.document.documentElement.style.zoom,'0.935');assert.equal(s.fits.length,0);
 }
});
test('native terminal replacement cancels old deferred fit and captures new baseline',()=>{
 const s=setup();s.run(.85);const previous=s.term;s.window.term={...previous,options:{fontSize:20}};s.frames[0]();assert.equal(s.fits.length,1);s.run(.935);assert.ok(Math.abs(s.window.term.options.fontSize-18.7)<1e-9);assert.equal(previous.options.fontSize,13.6);
});
test('invalid content scale refuses before generating or applying any script',()=>{
 for(const scale of [0,-1,NaN,Infinity,5])assert.throws(()=>script(scale),/Invalid guest/);
});

test('failed public fit restores font and zoom without scheduling later candidate effects',()=>{
 const s=setup();let calls=0;s.term.fit=()=>{if(++calls===1)throw new Error('refit failed')};
 assert.throws(()=>s.run(.935),/refit failed/);assert.equal(s.term.options.fontSize,16);assert.equal(s.document.documentElement.style.zoom,'0.85');assert.equal(s.frames.length,0);assert.equal(s.events.length,0);assert.equal(calls,2);
});
