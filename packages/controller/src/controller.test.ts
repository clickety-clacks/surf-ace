import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConsumableScopeSnapshot,
  ControllerInstanceId,
  LocklessScopeId,
} from "@surf-ace/protocol";

import { ControllerIdentity } from "./identity.js";
import { BoundedControllerProjection } from "./projection.js";
import {
  type ControllerWire,
  LocklessControllerSession,
} from "./session.js";
import type { ControllerStateStore } from "./state-store.js";
import type { ControllerWireEnvelope } from "./wire.js";

class MemoryStore implements ControllerStateStore {
  failNextSave = false;
  value: unknown = null;

  async load(): Promise<unknown | null> {
    return structuredClone(this.value);
  }

  async save(value: unknown): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("persist_failed");
    }
    this.value = structuredClone(value);
  }
}

test("controller identity is stable across controller instances", async () => {
  const store = new MemoryStore();
  const first = new ControllerIdentity(
    store,
    () => "ci_stable" as ControllerInstanceId,
  );
  assert.equal(await first.loadOrCreate(), "ci_stable");
  const restarted = new ControllerIdentity(
    store,
    () => "ci_regenerated" as ControllerInstanceId,
  );
  assert.equal(await restarted.loadOrCreate(), "ci_stable");
});

test("operation receipt exposes the client commit sequence from the wire receipt", async () => {
  const wire: ControllerWire = {
    async close() {},
    async connect() {},
    onEvent() {
      return () => {};
    },
    async request(op, _payload, id): Promise<ControllerWireEnvelope> {
      if (op === "pair.request") {
        return {
          id,
          ok: true,
          op,
          payload: {
            capabilities: {},
            controllerInstanceId: "ci_receipt",
            limits: {},
            mode: "lockless",
            receiptResolutions: [{
              outcome: "still_pending",
              requestId: "rq_pending",
            }],
            resumed: false,
            scopes: [],
            sessionId: "lockless_ci_receipt",
            state: null,
            surfaceId: null,
            surfaceSetRevision: 1,
          },
          type: "response",
        };
      }
      return {
        id,
        ok: true,
        op,
        payload: {
          contentId: "ct_receipt",
          receipt: {
            commitSequence: 41,
            requestId: id,
          },
        },
        type: "response",
      };
    },
  };
  const session = new LocklessControllerSession({
    identity: new ControllerIdentity(
      new MemoryStore(),
      () => "ci_receipt" as ControllerInstanceId,
    ),
    preflightComplete: true,
    projection: new BoundedControllerProjection(new MemoryStore(), 4096),
    wire,
  });
  const pair = await session.start();
  assert.deepEqual(pair.receiptResolutions, [{
    outcome: "still_pending",
    requestId: "rq_pending",
  }]);
  const response = await session.requestPublic("content.set") as {
    operationReceipt: {
      clientResultIds: Record<string, number | string>;
    };
  };
  assert.equal(response.operationReceipt.clientResultIds.commitSequence, 41);
  await session.stop();
});

test("local read persists consumption and an idempotent acknowledgement", async () => {
  const store = new MemoryStore();
  const projection = new BoundedControllerProjection(store, 4096);
  await projection.start();
  const scopeId = "pane:sf_1:1" as LocklessScopeId;
  await projection.applySnapshot({
    cursor: { cursor: 1, gap: null, gapGeneration: 0 },
    firstRetainedSequence: 1,
    lastRetainedSequence: 2,
    records: [
      {
        bytes: 5,
        payload: "one",
        recordClass: "content",
        recordId: "cr_1",
        sequence: 1,
      },
      {
        bytes: 5,
        payload: "two",
        recordClass: "content",
        recordId: "cr_2",
        sequence: 2,
      },
    ],
    scopeId,
    version: 1,
  } satisfies ConsumableScopeSnapshot);

  const read = await projection.readLocal(scopeId);
  assert.deepEqual(read.records.map((record) => record.sequence), [1, 2]);
  assert.equal(read.cacheStatus, "current");
  assert.equal(read.acknowledgement?.cursor, 3);
  assert.equal(projection.pendingAcknowledgements().length, 1);
  assert.equal(projection.canRearmAlert(scopeId), false);

  const restarted = new BoundedControllerProjection(store, 4096);
  await restarted.start();
  const repeat = await restarted.readLocal(scopeId);
  assert.deepEqual(repeat.records, []);
  assert.equal(restarted.pendingAcknowledgements()[0]?.idempotencyKey,
    read.acknowledgement?.idempotencyKey);

  await restarted.confirmAcknowledgement(
    read.acknowledgement!.idempotencyKey,
  );
  assert.deepEqual(restarted.pendingAcknowledgements(), []);
  assert.equal(restarted.canRearmAlert(scopeId), true);
});

test("delta projection mirrors client latest-wins and live-frame replacement", async () => {
  const projection = new BoundedControllerProjection(new MemoryStore(), 4096);
  await projection.start();
  const scopeId = "pane:sf_1:1" as LocklessScopeId;
  await projection.applySnapshot({
    cursor: { cursor: 1, gap: null, gapGeneration: 0 },
    firstRetainedSequence: 1,
    lastRetainedSequence: 3,
    records: [
      {
        bytes: 5,
        payload: { y: 1 },
        recordClass: "scroll",
        recordId: "cr_scroll_1",
        sequence: 1,
      },
      {
        bytes: 5,
        payload: { strokes: ["old"] },
        recordClass: "annotation_frame",
        recordId: "frame_1",
        sequence: 2,
      },
      {
        bytes: 5,
        payload: { strokes: ["other"] },
        recordClass: "annotation_frame",
        recordId: "frame_2",
        sequence: 3,
      },
    ],
    scopeId,
    version: 1,
  });

  await projection.applyDelta(scopeId, [
    {
      bytes: 5,
      payload: { y: 2 },
      recordClass: "scroll",
      recordId: "cr_scroll_2",
      sequence: 4,
    },
    {
      bytes: 5,
      payload: { strokes: ["new"] },
      recordClass: "annotation_frame",
      recordId: "frame_1",
      sequence: 5,
    },
  ]);
  await projection.applyDelta(scopeId, [{
    bytes: 5,
    payload: {
      flushId: "frame_1",
      strokes: ["final"],
    },
    recordClass: "annotation_frame",
    recordId: "cr_closed_frame_1",
    sequence: 6,
  }]);

  const read = await projection.readLocal(scopeId);
  assert.deepEqual(
    read.records.map(({ payload, recordId, sequence }) => ({
      payload,
      recordId,
      sequence,
    })),
    [
      {
        payload: { strokes: ["other"] },
        recordId: "frame_2",
        sequence: 3,
      },
      {
        payload: { y: 2 },
        recordId: "cr_scroll_2",
        sequence: 4,
      },
      {
        payload: {
          flushId: "frame_1",
          strokes: ["final"],
        },
        recordId: "cr_closed_frame_1",
        sequence: 6,
      },
    ],
  );
  assert.equal(read.acknowledgement?.cursor, 7);
});

test("projection rejects discontinuous deltas and exact persisted over-capacity state", async () => {
  const store = new MemoryStore();
  const projection = new BoundedControllerProjection(store, 1024);
  await projection.start();
  const scopeId = "pane:sf_1:1" as LocklessScopeId;
  await projection.applySnapshot({
    cursor: { cursor: 1, gap: null, gapGeneration: 0 },
    firstRetainedSequence: 1,
    lastRetainedSequence: 1,
    records: [{
      bytes: 5,
      payload: "one",
      recordClass: "content",
      recordId: "cr_1",
      sequence: 1,
    }],
    scopeId,
    version: 1,
  });
  await assert.rejects(
    projection.applyDelta(scopeId, [{
      bytes: 1,
      payload: "three",
      recordClass: "content",
      recordId: "cr_3",
      sequence: 3,
    }]),
    /projection_delta_gap/,
  );
  const constrained = new BoundedControllerProjection(new MemoryStore(), 256);
  await constrained.start();
  await assert.rejects(
    constrained.applySnapshot({
      cursor: { cursor: 1, gap: null, gapGeneration: 0 },
      firstRetainedSequence: 1,
      lastRetainedSequence: 1,
      records: [{
      bytes: 1,
      payload: "x".repeat(512),
      recordClass: "content",
      recordId: "cr_2",
      sequence: 1,
      }],
      scopeId,
      version: 1,
    }),
    /projection_capacity/,
  );
});

test("missing scopes are explicitly unsynchronized and malformed state is not discarded", async () => {
  const projection = new BoundedControllerProjection(new MemoryStore(), 1024);
  await projection.start();
  const read = await projection.readLocal("pane:missing:1" as LocklessScopeId);
  assert.equal(read.cacheStatus, "unsynchronized");
  assert.equal(read.repairScheduled, true);

  const malformed = new MemoryStore();
  malformed.value = { version: 2, scopes: {}, acknowledgementOutbox: [] };
  await assert.rejects(
    new BoundedControllerProjection(malformed, 1024).start(),
    /projection_desynchronized/,
  );
});

test("ordinary read queues repair without client I/O and background sync performs it", async () => {
  const requests: string[] = [];
  const wire: ControllerWire = {
    async close() {},
    async connect() {},
    onEvent() {
      return () => {};
    },
    async request(op): Promise<ControllerWireEnvelope> {
      requests.push(op);
      if (op === "pair.request") {
        return {
          ok: true,
          op,
          payload: {
            capabilities: {},
            controllerInstanceId: "ci_local",
            limits: {},
            mode: "lockless",
            receiptResolutions: [],
            resumed: false,
            scopes: [],
            sessionId: "lockless_ci_local",
            state: null,
            surfaceId: null,
            surfaceSetRevision: 1,
          },
          type: "response",
        };
      }
      if (op === "consumable.sync") {
        return {
          ok: true,
          op,
          payload: {
            snapshots: [{
              cursor: { cursor: 1, gap: null, gapGeneration: 0 },
              firstRetainedSequence: 1,
              lastRetainedSequence: 0,
              records: [],
              scopeId: "pane:sf_1:1",
              version: 1,
            }],
          },
          type: "response",
        };
      }
      throw new Error(`unexpected request ${op}`);
    },
  };
  const session = new LocklessControllerSession({
    identity: new ControllerIdentity(
      new MemoryStore(),
      () => "ci_local" as ControllerInstanceId,
    ),
    projection: new BoundedControllerProjection(new MemoryStore(), 4096),
    preflightComplete: true,
    wire,
  });
  await session.start();
  requests.length = 0;

  const read = await session.readLocal(
    "pane:sf_1:1" as LocklessScopeId,
  );
  assert.equal(read.cacheStatus, "unsynchronized");
  assert.deepEqual(requests, []);

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(requests, ["consumable.sync"]);
  await session.stop();
});

test("failed local persistence publishes no consumption or acknowledgement", async () => {
  const store = new MemoryStore();
  const projection = new BoundedControllerProjection(store, 4096);
  await projection.start();
  const scopeId = "pane:sf_1:1" as LocklessScopeId;
  await projection.applySnapshot({
    cursor: { cursor: 1, gap: null, gapGeneration: 0 },
    firstRetainedSequence: 1,
    lastRetainedSequence: 1,
    records: [{
      bytes: 3,
      payload: "one",
      recordClass: "content",
      recordId: "cr_1",
      sequence: 1,
    }],
    scopeId,
    version: 1,
  });
  store.failNextSave = true;
  await assert.rejects(projection.readLocal(scopeId), /persist_failed/);
  assert.deepEqual(projection.pendingAcknowledgements(), []);

  const retry = await projection.readLocal(scopeId);
  assert.deepEqual(retry.records.map((record) => record.sequence), [1]);
  assert.equal(retry.acknowledgement?.cursor, 2);
});

test("failed admission closes its wire so the stable identity can retry", async () => {
  const identityStore = new MemoryStore();
  const projectionStore = new MemoryStore();
  let rejectedCloseCount = 0;
  const rejectedWire: ControllerWire = {
    async close() {
      rejectedCloseCount += 1;
    },
    async connect() {},
    onEvent() {
      return () => {};
    },
    async request(op) {
      return {
        ok: true,
        op,
        payload: { surfaces: [] },
        type: "response",
      };
    },
  };
  const identity = new ControllerIdentity(
    identityStore,
    () => "ci_retry" as ControllerInstanceId,
  );
  await assert.rejects(
    new LocklessControllerSession({
      identity,
      projection: new BoundedControllerProjection(projectionStore, 4096),
      wire: rejectedWire,
    }).start(),
    /lockless_capability_not_advertised/,
  );
  assert.equal(rejectedCloseCount, 1);

  let admittedCloseCount = 0;
  const admittedWire: ControllerWire = {
    async close() {
      admittedCloseCount += 1;
    },
    async connect() {},
    onEvent() {
      return () => {};
    },
    async request(op, payload) {
      if (op === "surfaces.list") {
        return {
          ok: true,
          op,
          payload: {
            capabilities: {
              protocolFeatures: [
                "surf-ace.lockless-multi-controller.v1",
              ],
            },
          },
          type: "response",
        };
      }
      const pair = payload as { controllerInstanceId: string };
      return {
        ok: true,
        op,
        payload: {
          capabilities: {},
          controllerInstanceId: pair.controllerInstanceId,
          limits: {},
          mode: "lockless",
          receiptResolutions: [],
          resumed: false,
          scopes: [],
          sessionId: `lockless_${pair.controllerInstanceId}`,
          state: null,
          surfaceId: null,
          surfaceSetRevision: 1,
        },
        type: "response",
      };
    },
  };
  const retry = new LocklessControllerSession({
    identity,
    projection: new BoundedControllerProjection(projectionStore, 4096),
    wire: admittedWire,
  });
  const result = await retry.start();
  assert.equal(result.controllerInstanceId, "ci_retry");
  await retry.stop();
  assert.equal(admittedCloseCount, 1);
});

test("a transport closed during admission is never a live direct session", async () => {
  let closeListener: (() => void) | undefined;
  const wire: ControllerWire = {
    async connect() {},
    async close() {},
    onClose(listener) {
      closeListener = listener;
      return () => { closeListener = undefined; };
    },
    onEvent() { return () => {}; },
    async request(op, payload) {
      const { controllerInstanceId } = payload as { controllerInstanceId: string };
      closeListener?.();
      return {
        type: "response", op, ok: true,
        payload: { controllerInstanceId, mode: "lockless", scopes: [], receiptResolutions: [] },
      };
    },
  };
  const session = new LocklessControllerSession({
    wire,
    preflightComplete: true,
    identity: new ControllerIdentity(new MemoryStore()),
    projection: new BoundedControllerProjection(new MemoryStore(), 4096),
  });
  await assert.rejects(session.start(), /controller_wire_closed/);
  assert.equal(session.hasLiveDirectSession(), false);
});

test("transport loss marks projection unsynchronized and reconciles with the same identity", async () => {
  let closeListener: (() => void) | null = null;
  let connectCount = 0;
  const wire: ControllerWire = {
    async close() {},
    async connect() {
      connectCount += 1;
    },
    onClose(listener) {
      closeListener = listener;
      return () => {
        closeListener = null;
      };
    },
    onEvent() {
      return () => {};
    },
    async request(op, payload) {
      if (op === "surfaces.list") {
        return {
          ok: true,
          op,
          payload: {
            capabilities: {
              protocolFeatures: [
                "surf-ace.lockless-multi-controller.v1",
              ],
            },
          },
          type: "response",
        };
      }
      if (op === "pair.request") {
        const pair = payload as { controllerInstanceId: string };
        return {
          ok: true,
          op,
          payload: {
            capabilities: {},
            controllerInstanceId: pair.controllerInstanceId,
            limits: {},
            mode: "lockless",
            receiptResolutions: [],
            resumed: connectCount > 1,
            scopes: [{
              cursor: { cursor: 1, gap: null, gapGeneration: 0 },
              firstRetainedSequence: 1,
              lastRetainedSequence: 0,
              records: [],
              scopeId: "pane:sf_1:1",
              version: 1,
            }],
            sessionId: `lockless_${pair.controllerInstanceId}`,
            state: null,
            surfaceId: null,
            surfaceSetRevision: 1,
          },
          type: "response",
        };
      }
      throw new Error(`unexpected request:${op}`);
    },
  };
  const session = new LocklessControllerSession({
    heartbeatIntervalMs: 60_000,
    identity: new ControllerIdentity(
      new MemoryStore(),
      () => "ci_partition" as ControllerInstanceId,
    ),
    projection: new BoundedControllerProjection(new MemoryStore(), 4096),
    reconnectInitialDelayMs: 50,
    wire,
  });
  await session.start();
  closeListener?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await session.readLocal("pane:sf_1:1" as LocklessScopeId)).cacheStatus,
    "unsynchronized",
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(connectCount, 2);
  assert.equal(
    (await session.readLocal("pane:sf_1:1" as LocklessScopeId)).cacheStatus,
    "current",
  );
  await session.stop();
});
// DESIGN §4.5: only consecutive missed pongs cause loss, and a late pong
// cannot satisfy a later heartbeat. Short intervals exercise the same path.
for (const lateReply of [false, true]) {
  test(`two missed pongs reconnect with stable identity (late reply: ${lateReply})`, { timeout: 5_000 }, async () => {
    let pings = 0;
    let connects = 0;
    let aborts = 0;
    let firstReply: ((response: ControllerWireEnvelope) => void) | undefined;
    let firstNonce: unknown;
    let reconnected!: () => void;
    const recovered = new Promise<void>((resolve) => { reconnected = resolve; });
    const wire: ControllerWire = {
      abort() {
        aborts += 1;
        assert.equal(pings, 4, "a successful second pong resets the missed count");
      },
      async close() {},
      async connect() { connects += 1; },
      onEvent() { return () => {}; },
      async request(op, payload) {
        if (op === "pair.request") {
          assert.equal((payload as { controllerInstanceId: string }).controllerInstanceId, "ci_heartbeat");
          if (connects === 2) setImmediate(reconnected);
          return {
            type: "response", op, ok: true,
            payload: {
              capabilities: {}, controllerInstanceId: "ci_heartbeat", limits: {},
              mode: "lockless", receiptResolutions: [], scopes: [], sessionId: "session-test",
            },
          };
        }
        assert.equal(op, "heartbeat.ping");
        pings += 1;
        if (pings === 2) return { type: "response", op, ok: true, payload };
        if (pings === 4 && lateReply) {
          firstReply?.({ type: "response", op, ok: true, payload: { nonce: firstNonce } });
        }
        return await new Promise<ControllerWireEnvelope>((resolve) => {
          if (pings === 1) {
            firstReply = resolve;
            firstNonce = (payload as { nonce: unknown }).nonce;
          }
        });
      },
    };
    const session = new LocklessControllerSession({
      heartbeatIntervalMs: 30, heartbeatTimeoutMs: 5, reconnectInitialDelayMs: 1,
      preflightComplete: true,
      identity: new ControllerIdentity(new MemoryStore(), () => "ci_heartbeat" as ControllerInstanceId),
      projection: new BoundedControllerProjection(new MemoryStore(), 4096), wire,
    });
    try {
      await session.start();
      await recovered;
      assert.equal(aborts, 1);
      assert.equal(connects, 2);
    } finally {
      await session.stop();
    }
  });
}

test("registry presence refuses a missing direct session and leaves a paired session usable", async () => {
  const { once } = await import("node:events");
  const { WebSocketServer } = await import("ws");
  const registry = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(registry, "listening");
  const address = registry.address();
  assert.ok(address && typeof address !== "string");
  const clientId = "7".repeat(64);
  let offline = true;
  let registryReads = 0;
  registry.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(String(data));
      assert.equal(request.op, "fleet.topology");
      registryReads++;
      socket.send(JSON.stringify({
        type: "response", v: 1, id: request.id, op: request.op, ok: true,
        payload: { clients: [{
          clientId, presence: offline ? "offline" : "online", lastSeenAtMs: offline ? 123 : null,
        }] },
      }));
    });
  });
  const controllerInstanceId = "ci_presence" as ControllerInstanceId;
  let directConnects = 0;
  const wire: ControllerWire = {
    async close() {},
    async connect() { directConnects++; },
    onEvent() { return () => {}; },
    async request(op) {
      const payload = op === "pair.request"
        ? { capabilities: {}, controllerInstanceId, limits: {}, mode: "lockless",
            receiptResolutions: [], scopes: [], sessionId: "session-test" }
        : { surfaces: [] };
      return { type: "response", op, ok: true, payload };
    },
  };
  const session = new LocklessControllerSession({
    preflightComplete: true,
    registryTarget: { url: `ws://127.0.0.1:${address.port}`, clientId },
    identity: new ControllerIdentity(new MemoryStore(), () => controllerInstanceId),
    projection: new BoundedControllerProjection(new MemoryStore(), 4096), wire,
  });
  try {
    await assert.rejects(session.start(), { code: "client_offline", clientId, lastSeenAtMs: 123 });
    assert.equal(directConnects, 0);
    offline = false;
    await session.start();
    assert.equal(directConnects, 1);
    offline = true;
    assert.deepEqual((await session.listSurfaces() as { surfaces: unknown[] }).surfaces, []);
    assert.equal(registryReads, 2, "the paired direct request did not depend on the registry");
  } finally {
    await session.stop();
    await new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
  }
});
