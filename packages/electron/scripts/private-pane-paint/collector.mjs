import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { validateWhole,paintProof,phasePalette } from './guards.mjs';
import { validPanePaintOutcome } from '../../src/pane-paint-contract.ts';
export function collect(root){
 const result=JSON.parse(fs.readFileSync(path.join(root,'fixture-result.json'),'utf8'));validateWhole(result);
 for(const [index,name] of ['baseline','scaled','restored'].entries()){
  const receipt=JSON.parse(fs.readFileSync(path.join(root,`${name}-reply.json`),'utf8'));
  assert(validPanePaintOutcome(receipt.r,receipt.q));assert.equal(receipt.r.payload.outcome,'observed');const p=receipt.q.payload.expected.projection,factor=index===1?.85:1,palette=phasePalette(index+1);
  const phase=result.phases[index];assert.equal(phase.evidence.length,2);
  for(const image of receipt.r.payload.captures){const file=`${name}-${image.target}.png`,png=fs.readFileSync(path.join(root,file)),digest=createHash('sha256').update(png).digest('hex');assert.equal(digest,image.sha256);assert(Buffer.from(image.pngBase64,'base64').equals(png));const e=phase.evidence.find(v=>v.target===image.target);assert(e&&e.file===file&&e.sha256===digest);assert.deepEqual(e.projection,p);
   const points=image.target==='GUEST'?[{x:32,y:32,rgb:palette[0]},{x:176,y:112,rgb:palette[1]}]:[{x:32*factor,y:32*factor,rgb:palette[0]},{x:176*factor,y:112*factor,rgb:palette[1]},{x:20,y:300,rgb:[32,40,64]}];paintProof(png,image.target==='GUEST'?p.guestViewport:p.hostRect,p.devicePixelRatio,points);
  }
 }
 for(const phase of result.phases.slice(3)){assert(phase.receipt,'missing raw negative receipt');if(phase.name==='native-drain'){assert(validPanePaintOutcome(phase.receipt.r,phase.receipt.q));assert.equal(phase.receipt.r.payload.reason,'timeout');assert.equal(phase.receipt.r.payload.nativeDrain.state,'pending');}else if(phase.name==='invalid-guest'){assert(validPanePaintOutcome(phase.receipt.r,phase.receipt.q));assert.equal(phase.receipt.r.payload.reason,'invalid-image');}else if(phase.name==='stale-geometry'){assert(validPanePaintOutcome(phase.receipt.r,phase.receipt.q));assert.equal(phase.receipt.r.payload.reason,'stale');}else if(phase.name==='duplicate')assert.equal(phase.receipt.r.error.code,'invalid_request_id_reuse');else if(phase.name==='wrong-surface')assert.equal(phase.receipt.r.error.code,'not_paired');else if(phase.name==='delayed-send'){assert.equal(phase.afterOpen,false);assert(result.deliveries.some(v=>v.fault==='delayed-send'&&v.completedOffset-v.queuedOffset>=2000));}}
 return {pass:true,root,phases:result.phases.map(v=>v.name),images:6,physicalDisplay:'not-observed',productionMainRenderer:false};
}
if(process.argv[1]&&path.resolve(process.argv[1]).endsWith('collector.mjs'))console.log(JSON.stringify(collect(process.argv[2])));
