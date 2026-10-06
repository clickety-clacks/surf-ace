import assert from "node:assert/strict";
import test from "node:test";

import { AnnotationPublisherOutbox } from "../src/annotation-publisher-outbox.js";
import { SurfaceCore } from "../src/surface-core.js";

const clientId = "c".repeat(64);
const surfaceId = "sf_annotation-test";
const live = (event: string) => ({
  paneId: 1, frameId: "frame-one", kind: "live_delta" as const,
  contentId: "content-one", revision: 1, contentType: "html",
  viewport: { scrollOffset: { x: 0, y: 0 }, visibleRect: { x: 0, y: 0, width: 10, height: 10 },
    contentSize: { width: 10, height: 10 }, zoomLevel: 1 },
  sourceTimestamp: "2026-10-06T21:00:00Z", payload: { flushId: event, strokes: [] },
});

test("annotation publisher retains exact retry bytes and seals overflow without evicting an unaccepted head", () => {
  const outbox = new AnnotationPublisherOutbox(clientId, undefined, undefined, 2);
  assert.equal(outbox.append(surfaceId, live("first")), "1");
  const first = outbox.head(surfaceId)!;
  assert.equal(JSON.parse(first.canonical).sourceSequence, "1");
  assert.equal(outbox.append(surfaceId, live("second")), "2");
  assert.equal(outbox.head(surfaceId)!.canonical, first.canonical);
  const sealed = outbox.snapshot().surfaces[surfaceId]!.fifo[1]!;
  assert.equal(sealed.kind, "gap");
  assert.deepEqual(JSON.parse(sealed.canonical).lostFromSequence, "2");
  assert.equal(outbox.append(surfaceId, live("third")), "3");
  const restored = new AnnotationPublisherOutbox(clientId, outbox.snapshot(), undefined, 2);
  assert.equal(restored.head(surfaceId)!.canonical, first.canonical);
  restored.accepted(surfaceId, first, { epoch: "a".repeat(32), sequence: "10" });
  assert.equal(restored.head(surfaceId)!.canonical, sealed.canonical);
  restored.accepted(surfaceId, sealed, { epoch: "a".repeat(32), sequence: "11" });
  const tail = restored.head(surfaceId)!;
  assert.equal(tail.kind, "gap");
  assert.equal(JSON.parse(tail.canonical).lostFromSequence, "3");
  assert.equal(JSON.parse(tail.canonical).lostThroughSequence, "3");
});

test("definite record rejection replaces only its FIFO slot and persists diagnosis", () => {
  const outbox = new AnnotationPublisherOutbox(clientId);
  outbox.append(surfaceId, live("first"));
  outbox.append(surfaceId, live("second"));
  const second = outbox.snapshot().surfaces[surfaceId]!.fifo[1]!.canonical;
  outbox.rejectHead(surfaceId, "annotation_record_too_large");
  const state = outbox.snapshot().surfaces[surfaceId]!;
  assert.equal(state.fifo[0]!.kind, "gap");
  assert.equal(JSON.parse(state.fifo[0]!.canonical).reason, "source_record_rejected");
  assert.equal(state.fifo[1]!.canonical, second);
  assert.deepEqual(state.diagnostic, { code: "annotation_record_too_large", sequence: "1" });
});

test("publisher partition survives the Electron surface state serialization boundary", () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  core.annotationPublisher!.append(surfaceId, live("durable"));
  const persisted = core.getPersistentState();
  const restarted = new SurfaceCore({ annotationClientId: clientId, persistentState: persisted });
  assert.equal(restarted.annotationPublisher!.head(surfaceId)!.canonical,
    core.annotationPublisher!.head(surfaceId)!.canonical);
  assert.throws(() => new SurfaceCore({ annotationClientId: "another-client", persistentState: persisted }),
    /invalid persisted annotation publisher state/);
});

test("frame identity survives restart until explicit close and unavailable events become a sticky gap", () => {
  const outbox = new AnnotationPublisherOutbox(clientId);
  const firstFrame = outbox.frameId(surfaceId, 1);
  assert.equal(outbox.frameId(surfaceId, 1), firstFrame);
  assert.equal(outbox.lose(surfaceId, "frame_image_unavailable"), "1");
  const restored = new AnnotationPublisherOutbox(clientId, outbox.snapshot());
  assert.equal(restored.frameId(surfaceId, 1), firstFrame);
  const gap = restored.head(surfaceId)!;
  assert.equal(gap.kind, "gap");
  assert.equal(JSON.parse(gap.canonical).lostFromSequence, "1");
  assert.equal(restored.lose(surfaceId, "frame_image_unavailable"), "2");
  assert.equal(restored.snapshot().surfaces[surfaceId]!.trailingGap?.through, "2");
  restored.closeFrame(surfaceId, 1);
  assert.notEqual(restored.frameId(surfaceId, 1), firstFrame);
});

test("at-open image and viewport survive restart and cannot be replaced by a later capture", () => {
  const outbox = new AnnotationPublisherOutbox(clientId);
  const first = outbox.openFrame(surfaceId, 1, {
    contextKey: "content-one", contentId: "content-one", image: "at-open-image",
    openedAt: 100, scrollOffset: { x: 2, y: 3 },
    viewport: { width: 640, height: 480, scale: 1 },
  });
  const restarted = new AnnotationPublisherOutbox(clientId, outbox.snapshot());
  assert.deepEqual(restarted.openFrame(surfaceId, 1, {
    contextKey: "different", contentId: "different", image: "later-image",
    openedAt: 200, scrollOffset: { x: 0, y: 0 },
    viewport: { width: 100, height: 100, scale: 2 },
  }), first);
  restarted.appendFrameStroke(surfaceId, 1, {
    strokeId: "stroke-one", points: [{ x: 4, y: 5 }],
    bbox: { x: 4, y: 5, width: 0, height: 0 }, startedAt: 110, endedAt: 120,
  });
  const committed = new AnnotationPublisherOutbox(clientId, restarted.snapshot()).openFrameFor(surfaceId, 1)!;
  assert.equal(committed.image, "at-open-image");
  assert.deepEqual(committed.scrollOffset, { x: 2, y: 3 });
  assert.equal(committed.updatedAt, 120);
  assert.equal(committed.strokes.length, 1);
  restarted.closeFrame(surfaceId, 1);
  assert.equal(restarted.openFrameFor(surfaceId, 1), null);
  assert.notEqual(restarted.frameId(surfaceId, 1), first.frameId);
});

test("completed source stroke is copied into the at-open frame with bounded geometry", () => {
  const outbox = new AnnotationPublisherOutbox(clientId);
  outbox.openFrame(surfaceId, 1, {
    contextKey: "content-one", contentId: "content-one", image: "at-open-image",
    openedAt: 100, scrollOffset: { x: 0, y: 0 }, viewport: { width: 10, height: 10, scale: 1 },
  });
  outbox.recordStroke(surfaceId, 1, { strokeId: "stroke-one", tool: "mouse", points: [
    { x: 6, y: 7, timestamp: 110 }, { x: 2, y: 3, timestamp: 120, pressure: 0.5 },
  ] } as never);
  const frame = new AnnotationPublisherOutbox(clientId, outbox.snapshot()).openFrameFor(surfaceId, 1)!;
  assert.equal(frame.failed, undefined);
  assert.equal(frame.updatedAt, 120);
  assert.deepEqual(frame.strokes[0], {
    strokeId: "stroke-one", points: [{ x: 6, y: 7 }, { x: 2, y: 3, pressure: 0.5 }],
    bbox: { x: 2, y: 3, width: 4, height: 4 }, startedAt: 110, endedAt: 120,
  });
});
