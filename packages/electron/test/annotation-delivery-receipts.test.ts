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

test("optional UI receipts are evicted before canonical byte pressure becomes source loss", () => {
 const plain = new AnnotationPublisherOutbox(client, undefined, 20000);
 const owned = new AnnotationPublisherOutbox(client, undefined, 20000);
 for (let pane=1;pane<=4;pane++) { plain.append(surface,record(pane));owned.append(surface,record(pane),"lineage-one"); }
 const actual=owned.snapshot().surfaces[surface]!;
 const payloads = (box: AnnotationPublisherOutbox) => box.snapshot().surfaces[surface]!.fifo.map(row => {
   const { sourceEpoch, sourceEventId, ...value } = JSON.parse(row.canonical); return value;
 });
 assert.deepEqual(payloads(owned), payloads(plain));
 assert.equal(actual.fifo.length,4);assert.ok(actual.fifo.every(row=>row.kind==="payload"));
 assert.equal(actual.trailingGap,null);assert.ok((actual.deliveryReceipts?.length ?? 0)<4);
 const restored=new AnnotationPublisherOutbox(client,owned.snapshot(),20000);
 assert.deepEqual(restored.snapshot(),owned.snapshot());
 // Genuine data exhaustion still produces loss, without discarding old payloads.
 const rows=actual.fifo.map(row=>row.canonical);
 for(let pane=5;pane<=20;pane++) owned.append(surface,record(pane),"lineage-one");
 const full=owned.snapshot().surfaces[surface]!;
 assert.deepEqual(full.fifo.filter(row=>row.kind==="payload").slice(0,4).map(row=>row.canonical),rows);
 assert.ok(full.trailingGap || full.fifo.some(row=>row.kind==="gap"));
 assert.equal(full.deliveryReceipts?.length ?? 0,0);
 assert.deepEqual(new AnnotationPublisherOutbox(client,owned.snapshot(),20000).snapshot(),owned.snapshot());
});

test("frame and stroke byte admission evicts only optional other-pane receipts first", () => {
 const seeded = new AnnotationPublisherOutbox(client);
 for(let pane=1;pane<=4;pane++) { seeded.append(surface,record(pane),"lineage-one");
   seeded.accepted(surface,seeded.head(surface)!,{...cursor,sequence:String(pane)}); }
 const capture = { contentId:"new-content",contextKey:"new-content",image:"x".repeat(1500),openedAt:1,
   scrollOffset:{x:0,y:0},viewport:{width:10,height:10,scale:1} };
 const without=seeded.snapshot();without.surfaces[surface]!.deliveryReceipts=[];
 const reference = new AnnotationPublisherOutbox(client,without);
 reference.openFrame(surface,5,capture);
 const bytes=reference.partitionBytes(surface)+16384;
 const withMetadata=new AnnotationPublisherOutbox(client,seeded.snapshot(),bytes);
 const frame=withMetadata.openFrame(surface,5,capture);
 assert.equal(frame.image,capture.image);
 assert.equal(withMetadata.snapshot().surfaces[surface]!.deliveryReceipts?.length ?? 0,0);
 assert.equal(withMetadata.head(surface),null);
 assert.deepEqual(new AnnotationPublisherOutbox(client,withMetadata.snapshot(),bytes).snapshot(),withMetadata.snapshot());
 const stroke={strokeId:"stroke-1",points:Array.from({length:60},()=>({x:1,y:1,pressure:1})),bbox:{x:1,y:1,width:0,height:0},startedAt:1,endedAt:2};
 const openSeed=new AnnotationPublisherOutbox(client,seeded.snapshot());openSeed.openFrame(surface,5,{...capture,image:"x".repeat(1100)});
 const noReceipts=openSeed.snapshot();noReceipts.surfaces[surface]!.deliveryReceipts=[];
 const plain=new AnnotationPublisherOutbox(client,noReceipts);plain.appendFrameStroke(surface,5,stroke);
 const strokeBytes=plain.partitionBytes(surface)+16384;
 const owned=new AnnotationPublisherOutbox(client,openSeed.snapshot(),strokeBytes);
 owned.appendFrameStroke(surface,5,stroke);
 assert.equal(owned.openFrameFor(surface,5)!.strokes.length,1);
 assert.equal(owned.snapshot().surfaces[surface]!.deliveryReceipts?.length ?? 0,0);
 assert.deepEqual(new AnnotationPublisherOutbox(client,owned.snapshot(),strokeBytes).snapshot(),owned.snapshot());
 // Genuine frame overflow still rejects and retains canonical state.
 assert.throws(()=>owned.openFrame(surface,6,{...capture,image:"x".repeat(30000)}),/capacity/);
 assert.equal(owned.openFrameFor(surface,5)!.strokes.length,1);
});
