import assert from "node:assert/strict";
import test from "node:test";
import type { ControllerWireEnvelope } from "../../controller/src/wire.js";
import { AnnotationRegistryPublisher, type AnnotationPublisherWire } from "../src/annotation-registry-publisher.js";
import { SurfaceCore, type PersistentSurfaceState } from "../src/surface-core.js";

const clientId = "c".repeat(64);
const surfaceId = "sf_publisher-test";
const event = {
  paneId: 1, frameId: "frame-one", kind: "live_delta" as const,
  contentId: "content-one", revision: 1, contentType: "html",
  viewport: { scrollOffset: { x: 0, y: 0 }, visibleRect: { x: 0, y: 0, width: 10, height: 10 },
    contentSize: { width: 10, height: 10 }, zoomLevel: 1 },
  sourceTimestamp: "2026-10-06T21:00:00Z", payload: { strokes: [] },
};

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("publisher did not reach the expected state");
}

test("registry publisher sends only persisted source bytes and removes them after durable acceptance", async () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  core.annotationPublisher!.append(surfaceId, event);
  let persisted: PersistentSurfaceState = core.getPersistentState();
  const calls: string[] = [];
  const wire: AnnotationPublisherWire = {
    connect: async () => { calls.push("connect"); },
    onClose: () => () => {},
    abort: () => {},
    close: async () => {},
    request: async (op, payload): Promise<ControllerWireEnvelope> => {
      calls.push(op);
      if (op === "annotation.hello") return { type: "response", op, ok: true, payload: {}, id: "hello" };
      const saved = persisted.annotationPublisher!.surfaces[surfaceId]!.fifo[0]!;
      assert.deepEqual((payload as { record: unknown }).record, JSON.parse(saved.canonical));
      return { type: "response", op, ok: true, id: "ingest",
        payload: { serverCursor: { epoch: "a".repeat(32), sequence: "1" }, duplicate: false,
          committedAt: "2026-10-06T21:00:01Z" } };
    },
  };
  const errors: unknown[] = [];
  const publisher = new AnnotationRegistryPublisher("ws://127.0.0.1:19001/ws", core,
    async () => { persisted = core.getPersistentState(); }, (error) => errors.push(error), () => wire);
  publisher.start();
  await until(() => persisted.annotationPublisher!.surfaces[surfaceId]!.fifo.length === 0);
  assert.deepEqual(calls, ["connect", "annotation.hello", "annotation.ingest"]);
  assert.deepEqual(errors, []);
  assert.equal(persisted.annotationPublisher!.surfaces[surfaceId]!.fifo.length, 0);
  assert.equal(persisted.annotationPublisher!.surfaces[surfaceId]!.acceptedCursor?.sequence, "1");
  await publisher.stop();
});

test("ambiguous transport failure leaves original canonical FIFO head for retry", async () => {
  const core = new SurfaceCore({ annotationClientId: clientId });
  core.annotationPublisher!.append(surfaceId, event);
  const original = core.annotationPublisher!.head(surfaceId)!.canonical;
  const errors: unknown[] = [];
  const wire: AnnotationPublisherWire = {
    connect: async () => {}, onClose: () => () => {}, abort: () => {}, close: async () => {},
    request: async (op): Promise<ControllerWireEnvelope> => {
      if (op === "annotation.hello") return { type: "response", op, ok: true, payload: {}, id: "hello" };
      throw new Error("reply_lost");
    },
  };
  const publisher = new AnnotationRegistryPublisher("ws://127.0.0.1:19001/ws", core,
    async () => {}, (error) => errors.push(error), () => wire);
  publisher.start();
  await until(() => errors.length > 0);
  assert.equal(core.annotationPublisher!.head(surfaceId)!.canonical, original);
  await publisher.stop();
});
