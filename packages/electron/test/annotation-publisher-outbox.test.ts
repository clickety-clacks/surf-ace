import assert from "node:assert/strict";
import test from "node:test";

import { AnnotationPublisherOutbox } from "../src/annotation-publisher-outbox.js";

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
