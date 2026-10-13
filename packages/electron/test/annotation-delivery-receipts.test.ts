import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationPublisherOutbox, ANNOTATION_DELIVERY_RECEIPT_LIMIT } from "../src/annotation-publisher-outbox.js";
const client = "c".repeat(64), surface = "sf_delivery", cursor = { epoch: "a".repeat(32), sequence: "1" };
const record = (paneId = 1, frameId = "frame-one") => ({ paneId, frameId, kind: "live_delta" as const,
  contentId: "content-one", revision: 1, contentType: "html", sourceTimestamp: "2026-10-13T02:00:00Z",
  viewport: { scrollOffset: { x: 0, y: 0 }, visibleRect: { x: 0, y: 0, width: 10, height: 10 },
    contentSize: { width: 10, height: 10 }, zoomLevel: 1 }, payload: { strokes: [] } });
const receipt = (box: AnnotationPublisherOutbox, paneId = 1, lineage = "lineage-one") =>
  box.deliveryReceiptFor(surface, paneId, lineage, "content-one", 1);
test("durable per-pane receipt moves from waiting to registry accepted and restores without claiming processed", () => {
  const box = new AnnotationPublisherOutbox(client);
  box.append(surface, record(), "lineage-one");
  assert.equal(receipt(box)?.phase, "waiting");
  const head = box.head(surface)!; const canonical = head.canonical;
  assert.equal(JSON.parse(canonical).paneLineageId, undefined); // no public source-wire mutation
  box.accepted(surface, head, cursor);
  const restored = new AnnotationPublisherOutbox(client, box.snapshot());
  assert.equal(receipt(restored)?.phase, "sent");
  assert.deepEqual(receipt(restored)?.acceptedCursor, cursor);
  assert.equal("processed" in receipt(restored)!, false);
  assert.equal(restored.head(surface), null);
  const copy = receipt(restored)!; copy.phase = "waiting";
  assert.equal(receipt(restored)?.phase, "sent");
});
test("another pane, lineage, content or revision cannot borrow an acceptance", () => {
  const box = new AnnotationPublisherOutbox(client); box.append(surface, record(), "lineage-one");
  box.accepted(surface, box.head(surface)!, cursor);
  assert.equal(receipt(box, 2), null); assert.equal(receipt(box, 1, "replacement"), null);
  assert.equal(box.deliveryReceiptFor(surface, 1, "lineage-one", "replacement", 1), null);
  assert.equal(box.deliveryReceiptFor(surface, 1, "lineage-one", "content-one", 2), null);
});
test("older-frame acceptance cannot overwrite the latest pending frame", () => {
  const box = new AnnotationPublisherOutbox(client); box.append(surface, record(), "lineage-one");
  const older = box.head(surface)!;
  box.append(surface, record(1, "new-frame"), "lineage-one");
  const pending = receipt(box)!;
  box.accepted(surface, older, cursor);
  assert.deepEqual(receipt(box), pending);
  box.accepted(surface, box.head(surface)!, { ...cursor, sequence: "2" });
  assert.equal(receipt(box)?.phase, "sent");
});
test("record rejection and accepted loss-gap never become a sent annotation receipt", () => {
  const box = new AnnotationPublisherOutbox(client); box.append(surface, record(), "lineage-one");
  box.rejectHead(surface, "annotation_context_image_invalid");
  box.accepted(surface, box.head(surface)!, cursor);
  const restored = new AnnotationPublisherOutbox(client, box.snapshot());
  assert.equal(receipt(restored)?.phase, "rejected");
  assert.equal(receipt(restored)?.errorCode, "annotation_context_image_invalid");
  assert.equal(receipt(restored)?.acceptedCursor, undefined);
});
test("legacy source rows and global accepted cursor do not manufacture per-pane acceptance", () => {
  const box = new AnnotationPublisherOutbox(client); box.append(surface, record());
  box.accepted(surface, box.head(surface)!, cursor);
  assert.equal(receipt(new AnnotationPublisherOutbox(client, box.snapshot())), null);
});
test("bounded UI receipt eviction preserves every queued canonical source row", () => {
  const box = new AnnotationPublisherOutbox(client);
  for (let pane = 1; pane <= ANNOTATION_DELIVERY_RECEIPT_LIMIT + 2; pane++) box.append(surface, record(pane), "lineage-one");
  const snapshot = box.snapshot();
  assert.equal(snapshot.surfaces[surface]!.deliveryReceipts!.length, ANNOTATION_DELIVERY_RECEIPT_LIMIT);
  assert.equal(snapshot.surfaces[surface]!.fifo.length, ANNOTATION_DELIVERY_RECEIPT_LIMIT + 2);
  assert.equal(receipt(box), null);
  const restored = new AnnotationPublisherOutbox(client, snapshot);
  assert.deepEqual(restored.snapshot().surfaces[surface]!.fifo, snapshot.surfaces[surface]!.fifo);
});
test("invalid persisted receipt or duplicate pane ownership fails closed", () => {
  const box = new AnnotationPublisherOutbox(client); box.append(surface, record(), "lineage-one");
  for (const mutate of [
    (r: any) => { r.phase = "processed"; },
    (r: any) => { r.phase = "sent"; },
    (r: any) => { r.paneLineageId = ""; },
    (r: any) => { r.sourceEventId = "d".repeat(32); },
    (r: any) => { r.revision = 2; },
  ]) {
    const snapshot = box.snapshot(); mutate(snapshot.surfaces[surface]!.deliveryReceipts![0]);
    assert.throws(() => new AnnotationPublisherOutbox(client, snapshot), /delivery receipts/);
  }
  const duplicate = box.snapshot(); duplicate.surfaces[surface]!.deliveryReceipts!.push(structuredClone(duplicate.surfaces[surface]!.deliveryReceipts![0]!));
  assert.throws(() => new AnnotationPublisherOutbox(client, duplicate), /delivery receipts/);
});
