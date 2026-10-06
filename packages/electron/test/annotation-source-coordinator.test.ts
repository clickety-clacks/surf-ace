import assert from "node:assert/strict";
import test from "node:test";

import { AnnotationSourceCoordinator } from "../src/annotation-source-coordinator.js";
import { SurfaceCore } from "../src/surface-core.js";

const clientId = "c".repeat(64);
const viewport = { width: 640, height: 480, scale: 1 };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";

test("gated source flush precedes a self-contained at-open frame commit", async () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.admitSurfaceToLockless(surface.surfaceId);
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  assert.ok(paneId > 0);
  core.locklessContentPush(surface.surfaceId, {
    content: { markdown: "annotation fixture" }, contentId: "content-one",
    contentType: "markdown", friendlyChatName: "Fixture", paneId,
  }, "Fixture");
  let durable = core.getPersistentState();
  let notified = 0;
  const source = new AnnotationSourceCoordinator(core, async () => {
    durable = core.getPersistentState();
  }, () => { notified += 1; }, (error) => { throw error; });
  await source.setAnnotating(surface.surfaceId, paneId, true);
  const open = core.annotationPublisher!.openFrame(surface.surfaceId, paneId, {
    contentId: "content-one", contextKey: "content-one", image: png,
    openedAt: 100, scrollOffset: { x: 4, y: 5 }, viewport,
  });
  core.addStroke(surface.surfaceId, paneId, {
    strokeId: "stroke-one" as never, tool: "mouse",
    points: [{ x: 6, y: 7, timestamp: 110 }, { x: 2, y: 3, timestamp: 120 }],
  });
  assert.equal(core.annotationPublisher!.pendingSurfaceIds().length, 0);
  await source.flushPending(surface.surfaceId, paneId);
  assert.equal(notified, 1);
  const afterFlush = core.annotationPublisher!.snapshot().surfaces[surface.surfaceId]!;
  assert.ok(afterFlush.fifo[0], JSON.stringify(afterFlush));
  const live = JSON.parse(afterFlush.fifo[0]!.canonical);
  assert.equal(live.kind, "live_delta");
  assert.equal(live.frameId, open.frameId);
  assert.equal(live.payload.strokes[0].strokeId, "stroke-one");
  await source.setAnnotating(surface.surfaceId, paneId, false);
  const fifo = core.annotationPublisher!.snapshot().surfaces[surface.surfaceId]!.fifo;
  assert.equal(fifo.length, 2);
  const commit = JSON.parse(fifo[1]!.canonical);
  assert.equal(commit.kind, "frame_commit");
  assert.equal(commit.frameId, open.frameId);
  assert.equal(commit.payload.frame.image, open.image);
  assert.deepEqual(commit.payload.frame.scrollOffset, { x: 4, y: 5 });
  assert.equal(commit.payload.frame.strokes[0].strokeId, "stroke-one");
  assert.equal(notified, 2);
  assert.equal(core.annotationPublisher!.openFrameFor(surface.surfaceId, paneId), null);
  const restarted = new SurfaceCore({ annotationClientId: clientId, persistentState: durable });
  assert.equal(restarted.annotationPublisher!.snapshot().surfaces[surface.surfaceId]!.fifo.length, 2);
  source.stop();
});
