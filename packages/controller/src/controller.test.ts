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

test("legacy migration clears only after an accepted receipt for the exact pair request", async () => {
  const material = {
    gaps: [{
      gap: {
        cause: "legacy_overflow" as const,
        droppedBytes: null,
        droppedEventCount: null,
        droppedFrameCount: null,
        droppedRecordCount: null,
        firstLostSequence: null,
        lastLostSequence: null,
        lossExtent: "unknown" as const,
        recordClasses: ["tap" as const],
      },
      scopeId: "pane:sf_1:41" as LocklessScopeId,
    }],
    scopes: [{
      records: [],
      scopeId: "pane:sf_1:41" as LocklessScopeId,
      scopeKind: "pane" as const,
    }],
  };
  let accepted = 0;
  let rejected = 0;
  let observedPairId = "";
  const acceptedWire: ControllerWire = {
    async close() {},
    async connect() {},
    onEvent() {
      return () => {};
    },
    async request(op, payload, id) {
      assert.equal(op, "pair.request");
      observedPairId = id ?? "";
      assert.deepEqual(
        (payload as { migrationMaterial?: unknown }).migrationMaterial,
        material,
      );
      return {
        id,
        ok: true,
        op,
        payload: {
          capabilities: {},
          controllerInstanceId: "ci_migration",
          limits: {},
          migrationAccepted: true,
          migrationReceiptId: id,
          mode: "lockless",
          receiptResolutions: [{
            cause: "controller_reclaimed",
            outcome: "receipt_unavailable",
            requestId: "rq_reclaimed",
          }],
          resumed: false,
          scopes: [],
          sessionId: "lockless_ci_migration",
          state: null,
          surfaceId: null,
          surfaceSetRevision: 1,
        },
        type: "response",
      };
    },
  };
  const acceptedSession = new LocklessControllerSession({
    identity: new ControllerIdentity(
      new MemoryStore(),
      () => "ci_migration" as ControllerInstanceId,
    ),
    prepareMigration: async () => ({
      accept: async () => {
        accepted += 1;
      },
      material,
      reject: async () => {
        rejected += 1;
      },
    }),
    preflightComplete: true,
    projection: new BoundedControllerProjection(new MemoryStore(), 4096),
    wire: acceptedWire,
  });
  const migrationPair = await acceptedSession.start();
  assert.deepEqual(migrationPair.receiptResolutions, [{
    cause: "controller_reclaimed",
    outcome: "receipt_unavailable",
    requestId: "rq_reclaimed",
  }]);
  assert.match(observedPairId, /^rq_pair_/);
  assert.equal(accepted, 1);
  assert.equal(rejected, 0);
  await acceptedSession.stop();

  const refusedWire: ControllerWire = {
    async close() {},
    async connect() {},
    onEvent() {
      return () => {};
    },
    async request(op, _payload, id) {
      return {
        id,
        ok: true,
        op,
        payload: {
          capabilities: {},
          controllerInstanceId: "ci_migration",
          limits: {},
          migrationAccepted: true,
          migrationReceiptId: "rq_different",
          mode: "lockless",
          receiptResolutions: [],
          resumed: false,
          scopes: [],
          sessionId: "lockless_ci_migration",
          state: null,
          surfaceId: null,
          surfaceSetRevision: 1,
        },
        type: "response",
      };
    },
  };
  await assert.rejects(
    new LocklessControllerSession({
      identity: new ControllerIdentity(
        new MemoryStore(),
        () => "ci_migration" as ControllerInstanceId,
      ),
      prepareMigration: async () => ({
        accept: async () => {
          accepted += 1;
        },
        material,
        reject: async () => {
          rejected += 1;
        },
      }),
      preflightComplete: true,
      projection: new BoundedControllerProjection(new MemoryStore(), 4096),
      wire: refusedWire,
    }).start(),
    /lockless_migration_not_accepted/,
  );
  assert.equal(accepted, 1);
  assert.equal(rejected, 1);
});
