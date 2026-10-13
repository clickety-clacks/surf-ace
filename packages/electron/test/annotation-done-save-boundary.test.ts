import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationSourceCoordinator } from "../src/annotation-source-coordinator.js";
import { AnnotationDoneFence } from "../src/annotation-done-state.js";
import type { SurfaceCore } from "../src/surface-core.js";

function fixture(persist: () => Promise<void>, afterTransaction = () => {}) {
  const core = {
    annotationPublisher: null,
    subscribe: () => () => {}, listSurfaces: () => [],
    getRendererWindowState: () => ({ panes: [] }),
    setAnnotating: () => {}, hasPendingAnnotationCommit: () => false,
    transactionAsync: async (work: () => Promise<void>) => { await work(); afterTransaction(); },
  } as unknown as SurfaceCore;
  return new AnnotationSourceCoordinator(core, persist, () => {}, () => {});
}

test("Done reports saving until its actual persistence promise settles", async () => {
  let release!: () => void;
  const source = fixture(() => new Promise<void>((resolve) => { release = resolve; }));
  const fence = new AnnotationDoneFence();
  const work = fence.finish("surface/pane", "content/frame", () => true,
    (saved) => source.setAnnotating("surface", 1, false, saved));
  await Promise.resolve();
  assert.deepEqual(fence.snapshot("surface/pane", "content/frame"),
    { phase: "saving", busy: true, localSaved: false });
  release();
  assert.deepEqual(await work, { phase: "saved", busy: false, localSaved: true });
  source.stop();
});

test("a rejected persistence promise never supplies definite local-save proof", async () => {
  const source = fixture(async () => { throw new Error("ambiguous write outcome"); });
  const fence = new AnnotationDoneFence();
  assert.deepEqual(await fence.finish("surface/pane", "content/frame", () => true,
    (saved) => source.setAnnotating("surface", 1, false, saved)),
  { phase: "unknown", busy: false, localSaved: false });
  source.stop();
});

test("post-save notification failure retains local save proof but reports waiting", async () => {
  const source = fixture(async () => {}, () => { throw new Error("post-save notification"); });
  const fence = new AnnotationDoneFence();
  assert.deepEqual(await fence.finish("surface/pane", "content/frame", () => true,
    (saved) => source.setAnnotating("surface", 1, false, saved)),
  { phase: "waiting", busy: false, localSaved: true });
  source.stop();
});

test("a throwing observer cannot turn a completed local save into failure", async () => {
  const source = fixture(async () => {});
  await source.setAnnotating("surface", 1, false, () => { throw new Error("UI observer"); });
  source.stop();
});

test("annotation entry does not emit a Done save receipt", async () => {
  const source = fixture(async () => {});
  let saved = 0;
  await source.setAnnotating("surface", 1, true, () => saved++);
  assert.equal(saved, 0);
  source.stop();
});

test("a changed context at the final queued turn cannot save or mutate another pane", async () => {
  let enter!: () => void;
  let current = true;
  let writes = 0;
  let mutations = 0;
  const core = {
    annotationPublisher: null, subscribe: () => () => {}, listSurfaces: () => [],
    setAnnotating: () => mutations++, hasPendingAnnotationCommit: () => false,
    transactionAsync: async (work: () => Promise<void>) => {
      await new Promise<void>((resolve) => { enter = resolve; });
      await work();
    },
  } as unknown as SurfaceCore;
  const source = new AnnotationSourceCoordinator(core, async () => { writes++; }, () => {}, () => {});
  const work = source.setAnnotating("surface", 1, false, () => {}, () => current);
  current = false;
  enter();
  await assert.rejects(work, /context changed/);
  assert.equal(mutations, 0);
  assert.equal(writes, 0);
  source.stop();
});
