import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationPublisherOutbox } from "../src/annotation-publisher-outbox.js";
import { AnnotationRegistryPublisher, type AnnotationPublisherWire } from "../src/annotation-registry-publisher.js";
import type { SurfaceCore } from "../src/surface-core.js";
const client = "c".repeat(64), surface = "sf_delivery";
const event = { paneId: 1, frameId: "frame-one", kind: "live_delta" as const, contentId: "content-one",
  revision: 1, contentType: "html", sourceTimestamp: "2026-10-13T02:00:00Z", payload: { strokes: [] },
  viewport: { scrollOffset: { x: 0, y: 0 }, visibleRect: { x: 0, y: 0, width: 10, height: 10 },
    contentSize: { width: 10, height: 10 }, zoomLevel: 1 } };
const cursor = { epoch: "a".repeat(32), sequence: "1" };
const status = (p: AnnotationRegistryPublisher) => p.deliveryStatus(surface, 1, "lineage-one", "content-one", 1);
function setup(persist: () => Promise<void>, ingest: () => Promise<any>, onError = (_e: unknown) => {}, onStatus = () => {}) {
  const outbox = new AnnotationPublisherOutbox(client); outbox.append(surface, event, "lineage-one");
  const core = { annotationPublisher: outbox, transactionAsync: async (work: () => Promise<void>) => work() } as unknown as SurfaceCore;
  const wire: AnnotationPublisherWire = { connect: async () => {}, abort() {}, close: async () => {}, onClose: () => () => {},
    request: async (op) => op === "annotation.hello" ? { type: "response", op, id: "hello", ok: true, payload: {} } : ingest() };
  const publisher = new AnnotationRegistryPublisher("ws://127.0.0.1:1/ws", core, persist, onError, () => wire, onStatus);
  return { publisher, outbox };
}
const accepted = async () => ({ type: "response", op: "annotation.ingest", id: "ingest", ok: true,
  payload: { duplicate: false, committedAt: "2026-10-13T02:00:01Z", serverCursor: cursor } });
test("matching server acceptance remains waiting until actual local receipt persistence completes", async () => {
  let writes = 0, release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => { entered = resolve; });
  const { publisher } = setup(async () => { if (++writes === 2) { entered(); await new Promise<void>((r) => { release = r; }); } }, accepted);
  let sent!: () => void; const notified = new Promise<void>((resolve) => { sent = resolve; });
  // Predicate sampling does not infer success from a response or cursor alone.
  publisher.start(); await held;
  assert.equal(status(publisher)?.phase, "waiting");
  release();
  for (let i = 0; i < 12 && status(publisher)?.phase !== "sent"; i++) await Promise.resolve();
  assert.equal(status(publisher)?.phase, "sent"); sent(); await notified;
  await publisher.stop();
});
test("uncertain receipt save retaining a sent candidate cannot refresh UI to Sent on retry", async () => {
  let writes = 0, failed!: () => void;
  const failure = new Promise<void>((resolve) => { failed = resolve; });
  const { publisher, outbox } = setup(async () => { if (++writes === 2) throw Error("ambiguous save"); }, accepted, () => failed());
  publisher.start(); await failure;
  assert.equal(outbox.deliveryReceiptFor(surface, 1, "lineage-one", "content-one", 1)?.phase, "sent");
  assert.deepEqual(status(publisher), { phase: "waiting", error: true });
  publisher.notify();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.deepEqual(status(publisher), { phase: "waiting", error: true });
  await publisher.stop();
});
test("lost transport reply retains exact FIFO and truthful pending outcome", async () => {
  let failed!: () => void; const failure = new Promise<void>((resolve) => { failed = resolve; });
  const { publisher, outbox } = setup(async () => {}, async () => { throw Error("reply lost"); }, () => failed());
  const before = outbox.head(surface)!.canonical; publisher.start(); await failure;
  assert.equal(outbox.head(surface)!.canonical, before);
  assert.deepEqual(status(publisher), { phase: "waiting", error: true });
  await publisher.stop();
});
test("throwing status observer cannot poison durable acceptance or advertise processed ACK", async () => {
  let saved!: () => void; const durable = new Promise<void>((resolve) => { saved = resolve; }); let writes = 0;
  const { publisher, outbox } = setup(async () => { if (++writes === 2) saved(); }, accepted, () => {}, () => { throw Error("observer"); });
  publisher.start(); await durable;
  for (let i = 0; i < 12 && status(publisher)?.phase !== "sent"; i++) await Promise.resolve();
  assert.deepEqual(status(publisher), { phase: "sent" }); assert.equal(outbox.head(surface), null);
  assert.equal(publisher.deliveryStatus(surface, 1, "replacement", "content-one", 1), null);
  assert.equal(publisher.deliveryStatus(surface, 1, "lineage-one", "content-one", 1, "new-frame"), null);
  await publisher.stop();
});
test("accepted live delta cannot stand in for Done frame-commit acceptance", async () => {
  const { publisher, outbox } = setup(async () => {}, accepted);
  const frame = outbox.openFrame(surface, 1, {
    paneLineageId: "lineage-one", contentRevision: 1, contentId: "content-one", contextKey: "content-one",
    image: "", openedAt: 1, scrollOffset: { x: 0, y: 0 }, viewport: { width: 10, height: 10, scale: 1 },
  });
  outbox.append(surface, { ...event, frameId: frame.frameId }, "lineage-one");
  outbox.accepted(surface, outbox.head(surface)!, cursor);
  outbox.accepted(surface, outbox.head(surface)!, { ...cursor, sequence: "2" });
  outbox.requestFrameCommit(surface, 1, true);
  publisher.localSaved(); // explicitly acknowledged local save; no transport drain
  assert.equal(publisher.deliveryStatus(surface, 1, "lineage-one", "content-one", 1, frame.frameId)?.phase, "sent");
  assert.equal(publisher.deliveryStatus(surface, 1, "lineage-one", "content-one", 1, frame.frameId, true)?.phase, "waiting");
  assert.equal(publisher.deliveryStatus(surface, 1, "lineage-one", "content-one", 2, frame.frameId, true), null);
  await publisher.stop();
});
test("restored unhealthy delivery is visibly pending with an error and causes no recovery replay", async () => {
  const box = new AnnotationPublisherOutbox(client); box.append(surface, event, "lineage-one");
  box.markUnhealthy(surface, "internal_error");
  const restored = new AnnotationPublisherOutbox(client, box.snapshot());
  let requests = 0;
  const core = { annotationPublisher: restored } as unknown as SurfaceCore;
  const wire: AnnotationPublisherWire = { connect: async () => { requests++; }, abort() {}, close: async () => {}, onClose: () => () => {}, request: async () => { throw Error("unexpected recovery"); } };
  const publisher = new AnnotationRegistryPublisher("ws://127.0.0.1:1/ws", core, async () => {}, () => {}, () => wire);
  assert.deepEqual(status(publisher), { phase: "waiting", error: true });
  publisher.start(); for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(requests, 0); assert.deepEqual(restored.snapshot(), box.snapshot());
  await publisher.stop();
});
