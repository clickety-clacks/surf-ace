import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationSourceCoordinator } from "../src/annotation-source-coordinator.js";
import { SurfaceCore, type PersistentSurfaceState } from "../src/surface-core.js";
import { parseAnnotationDoneContext } from "../src/annotation-done-context.js";
import { ConfirmedAnnotationLocalSaves, parseAnnotationLocalSave } from "../src/annotation-local-save.js";
const viewport = { width: 640, height: 480, scale: 1 };
function setup() {
  const core = new SurfaceCore(); const id = core.ensurePrimarySurface("Local", viewport).surfaceId;
  core.admitSurfaceToLockless(id); const paneId = core.activePaneIds(id)[0]!;
  core.locklessContentPush(id, { paneId, contentId: "content-local", contentType: "markdown",
    content: { markdown: "local" }, friendlyChatName: "Local" }, "Local");
  return { core, id, paneId };
}
function context(core: SurfaceCore, id: string, paneId: number) {
  const p = core.getRendererWindowState(id).panes.find(p => p.paneId === paneId)!;
  return parseAnnotationDoneContext({ ...p.content, paneId, paneLineageId: p.paneLineageId })!;
}
function saved(proof: ConfirmedAnnotationLocalSaves, core: SurfaceCore, id: string, paneId: number) {
  return proof.has(id, context(core,id,paneId),core.localAnnotationFrameId(id,paneId));
}
test("actual direct-only queued Done and restart retain local proof, never registry acceptance", async () => {
  const {core,id,paneId}=setup(); let durable!: PersistentSurfaceState; const proof=new ConfirmedAnnotationLocalSaves();
  const source=new AnnotationSourceCoordinator(core,async()=>{durable=core.getPersistentState();proof.confirm(durable);},()=>{},()=>{});
  try {
    await source.setAnnotating(id,paneId,true);
    core.addStroke(id,paneId,{strokeId:"s1" as never,tool:"mouse",points:[{x:1,y:2,timestamp:1 as never}]});
    const frame=core.localAnnotationFrameId(id,paneId); assert.ok(frame);
    assert.equal(saved(proof,core,id,paneId),false);
    await source.setAnnotating(id,paneId,false);
    assert.equal(core.annotationPublisher,null);assert.equal(saved(proof,core,id,paneId),true);
    const restart=new SurfaceCore({persistentState:JSON.parse(JSON.stringify(durable))});restart.restorePersistedSurfaces("Local",viewport);
    const restored=new ConfirmedAnnotationLocalSaves();restored.confirm(durable);
    assert.equal(saved(restored,restart,id,paneId),true);
    assert.equal(restart.localAnnotationFrameId(id,paneId),frame);
    assert.deepEqual(restart.getRendererWindowState(id).panes[0]!.drawings,core.getRendererWindowState(id).panes[0]!.drawings);
    assert.equal(restart.annotationPublisher,null);
    assert.equal("acceptedCursor" in durable.surfaces![0]!.panes[0]!.annotationLocalSave!,false);
  } finally {source.stop();}
});
test("staged candidate is not confirmed while persistence is held, rejected or ambiguous", async () => {
 const {core,id,paneId}=setup();const proof=new ConfirmedAnnotationLocalSaves();let reject!:(e:Error)=>void;
 const source=new AnnotationSourceCoordinator(core,()=>new Promise<void>((_,r)=>{reject=r;}),()=>{},()=>{});
 core.setAnnotating(id,paneId,true);let local=false;
 const work=source.setAnnotating(id,paneId,false,()=>{local=true;}); await Promise.resolve();await Promise.resolve();
 const candidate=core.getPersistentState();assert.ok(candidate.surfaces![0]!.panes[0]!.annotationLocalSave);
 assert.equal(saved(proof,core,id,paneId),false);reject(Error("unknown write outcome"));await assert.rejects(work);
 assert.equal(local,false);assert.equal(saved(proof,core,id,paneId),false);
 // Only exact verified candidate confirmation (the main reconciliation seam) promotes it.
 proof.confirm(candidate);assert.equal(saved(proof,core,id,paneId),true);source.stop();
});
test("new Sketch frame retires old local proof even before its write; old confirmation cannot borrow new generation",()=>{
 const {core,id,paneId}=setup();const proof=new ConfirmedAnnotationLocalSaves();core.setAnnotating(id,paneId,true);core.setAnnotating(id,paneId,false);
 const old=core.getPersistentState();proof.confirm(old);assert.equal(saved(proof,core,id,paneId),true);
 const frame=core.localAnnotationFrameId(id,paneId);core.setAnnotating(id,paneId,true);
 assert.notEqual(core.localAnnotationFrameId(id,paneId),frame);assert.equal(saved(proof,core,id,paneId),false);
 core.setAnnotating(id,paneId,false);assert.equal(saved(proof,core,id,paneId),false);
 proof.confirm(core.getPersistentState());assert.equal(saved(proof,core,id,paneId),true);
});
test("legacy restored ink/mode/pending and direct flush bits alone never establish Saved",()=>{
 const {core,id,paneId}=setup();core.setAnnotating(id,paneId,true);core.setAnnotating(id,paneId,false);
 const old=core.getPersistentState();delete old.surfaces![0]!.panes[0]!.annotationLocalSave;
 delete old.surfaces![0]!.panes[0]!.annotationLocalFrameId;
 const restart=new SurfaceCore({persistentState:old});restart.restorePersistedSurfaces("Local",viewport);
 const proof=new ConfirmedAnnotationLocalSaves();proof.confirm(old);assert.equal(saved(proof,restart,id,paneId),false);
});
test("restored wrong pane/lineage/content/revision/render/frame proof cannot advertise Saved",()=>{
 const {core,id,paneId}=setup();core.setAnnotating(id,paneId,true);core.setAnnotating(id,paneId,false);
 const state=core.getPersistentState();const ctx=context(core,id,paneId);
 const proof=new ConfirmedAnnotationLocalSaves();proof.confirm(state);
 for(const change of [{paneId:paneId+1},{paneLineageId:"other"},{contentId:"other"},{revision:ctx.revision+1},{renderVersion:ctx.renderVersion+1}])
  assert.equal(proof.has(id,{...ctx,...change},core.localAnnotationFrameId(id,paneId)),false);
 assert.equal(proof.has(id,ctx,"lf_"+"0".repeat(32)),false);assert.equal(proof.has("other",ctx,core.localAnnotationFrameId(id,paneId)),false);
 const wrong=structuredClone(state);wrong.surfaces![0]!.panes[0]!.annotationLocalSave!.context.paneLineageId="other";
 proof.confirm(wrong);assert.equal(saved(proof,core,id,paneId),false);
});
test("invalid/oversized optional save metadata is discarded without losing authoritative history",()=>{
 const {core,id,paneId}=setup();core.setAnnotating(id,paneId,true);core.setAnnotating(id,paneId,false);
 const state=core.getPersistentState();const marker=state.surfaces![0]!.panes[0]!.annotationLocalSave!;
 for(const invalid of [{...marker,version:2},{...marker,frameId:"bare"},{...marker,extra:true},
  {...marker,context:{...marker.context,contentId:"x".repeat(5000)}}]) {
  assert.equal(parseAnnotationLocalSave(invalid),null);
  const bad=structuredClone(state);bad.surfaces![0]!.panes[0]!.annotationLocalSave=invalid as any;
  const restart=new SurfaceCore({persistentState:bad});restart.restorePersistedSurfaces("Local",viewport);
  const proof=new ConfirmedAnnotationLocalSaves();proof.confirm(bad);
  assert.equal(saved(proof,restart,id,paneId),false);
  assert.deepEqual(restart.getRendererWindowState(id).panes[0]!.content,core.getRendererWindowState(id).panes[0]!.content);
 }
});
test("confirmed record is copied and mutable candidate/result cannot rewrite its proof",()=>{
 const {core,id,paneId}=setup();core.setAnnotating(id,paneId,true);core.setAnnotating(id,paneId,false);
 const state=core.getPersistentState(),proof=new ConfirmedAnnotationLocalSaves();proof.confirm(state);
 state.surfaces![0]!.panes[0]!.annotationLocalSave!.context.paneLineageId="changed";
 assert.equal(saved(proof,core,id,paneId),true);
});

test("restoration caps optional per-surface save markers without evicting panes/history",()=>{
 const {core,id,paneId}=setup();core.setAnnotating(id,paneId,true);core.setAnnotating(id,paneId,false);
 const state=core.getPersistentState(),surface=state.surfaces![0]!,original=surface.panes[0]!;
 for(let n=2;n<=66;n++) {
  const copy=structuredClone(original);copy.paneId=n;copy.paneLabel=n;copy.paneLineageId=`lineage-${n}`;
  copy.annotationLocalFrameId=`lf_${n.toString(16).padStart(32,"0")}`;
  copy.annotationLocalSave!.context.paneId=n;copy.annotationLocalSave!.context.paneLineageId=copy.paneLineageId;
  copy.annotationLocalSave!.frameId=copy.annotationLocalFrameId;
  surface.panes.push(copy);surface.paneOrder.push(n);
 }
 const restart=new SurfaceCore({persistentState:state});restart.restorePersistedSurfaces("Local",viewport);
 const actual=restart.getPersistentState().surfaces![0]!;
 assert.equal(actual.panes.length,66);
 assert.equal(actual.panes.filter(p=>p.annotationLocalSave).length,64);
 assert.ok(actual.panes.every(p=>JSON.stringify(p.history)===JSON.stringify(original.history)));
});
