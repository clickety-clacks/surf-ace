import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

import { PersistenceWriteReadiness } from "../src/persistence-write-readiness.js";
import { SurfaceCore } from "../src/surface-core.js";
import { SurfaceWsServer } from "../src/ws-server.js";

test("readiness remains closed until every queued durable write settles", async () => {
  const readiness = new PersistenceWriteReadiness();
  let resolveFirst!: () => void;
  let rejectSecond!: (error: Error) => void;
  const firstWrite = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const secondWrite = new Promise<void>((_resolve, reject) => { rejectSecond = reject; });

  const first = readiness.track(() => firstWrite);
  const second = readiness.track(() => secondWrite);
  assert.equal(readiness.isReady, false);
  resolveFirst();
  await first;
  assert.equal(readiness.isReady, false);
  rejectSecond(new Error("write failed"));
  await assert.rejects(second, /write failed/);
  assert.equal(readiness.isReady, true);
});

test("readiness remains closed through overlapping authority mutations", () => {
  const readiness = new PersistenceWriteReadiness();
  const finishFirst = readiness.beginAuthorityMutation();
  const finishSecond = readiness.beginAuthorityMutation();

  assert.equal(readiness.isReady, false);
  finishFirst();
  assert.equal(readiness.isReady, false);
  finishFirst();
  assert.equal(readiness.isReady, false, "a mutation lease is released only once");
  finishSecond();
  assert.equal(readiness.isReady, true);
});

test("lockless mutation readiness spans dispatch and releases after failure", async () => {
  const readiness = new PersistenceWriteReadiness();
  const core = new SurfaceCore();
  const server = new SurfaceWsServer({
    beginApplicationStateMutation: () => readiness.beginAuthorityMutation(),
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "readiness dispatch fixture",
    hostName: "localhost",
    isApplicationStateReady: () => readiness.isReady,
    port: 0,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  const fakeSocket = {} as unknown as WebSocket;
  const direct = server as unknown as {
    locklessSessions: Map<WebSocket, {
      connectionSlot: string;
      connectionToken: string;
      controllerInstanceId: string;
      controllerProductName: string | null;
      socket: WebSocket;
      surfaceId: string | null;
    }>;
    handleOrdinaryLocklessMessage: (
      socket: WebSocket,
      request: Record<string, unknown>,
    ) => Promise<void>;
    handleOrdinaryLocklessMessageBody: (
      socket: WebSocket,
      request: Record<string, unknown>,
    ) => Promise<void>;
  };
  direct.locklessSessions.set(fakeSocket, {
    connectionSlot: "surface:readiness-dispatch-fixture",
    connectionToken: "readiness-dispatch-token",
    controllerInstanceId: "readiness-dispatch-controller",
    controllerProductName: null,
    socket: fakeSocket,
    surfaceId: "sf_readiness_dispatch_fixture",
  });
  let signalStarted!: () => void;
  let releaseBody!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const body = new Promise<void>((resolve) => { releaseBody = resolve; });
  direct.handleOrdinaryLocklessMessageBody = async () => {
    signalStarted();
    await body;
    throw new Error("dispatch failure");
  };

  const dispatch = direct.handleOrdinaryLocklessMessage(fakeSocket, {
    id: "rq_readiness_dispatch_failure",
    op: "pane.split",
    payload: {},
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  await started;
  assert.equal(readiness.isReady, false);
  releaseBody();
  await assert.rejects(dispatch, /dispatch failure/);
  assert.equal(readiness.isReady, true);
});

test("pre-pair describe hides candidate topology through held geometry and rollback", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("readiness geometry fixture", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  core.resetProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: 1,
    initialPaneLabel: 1,
    windowLabel: "a",
  });
  const binding = {
    allocatorId: "alloc_readiness_geometry_fixture",
    clientId: "a".repeat(64),
    fleetId: "fleet_readiness_geometry_fixture",
  };
  const now = Date.now();
  core.bindRegistryIdentity(binding);
  core.setRegistryEndpointLease({
    leaseGeneration: 17,
    registrationObservedAtMs: now - 1_000,
    leaseExpiresAtMs: now + 14_000,
  });
  const readiness = new PersistenceWriteReadiness();
  const server = new SurfaceWsServer({
    beginApplicationStateMutation: () => readiness.beginAuthorityMutation(),
    capturePaneImage: async () => null,
    claimPaneLabel: async (_surfaceId, paneId) => ({ allocationGeneration: paneId, paneLabel: paneId }),
    compositorSocketPath: null,
    core,
    endpointName: "readiness geometry fixture",
    hostName: "localhost",
    isApplicationStateReady: () => readiness.isReady,
    port: 0,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  const fakeSocket = {} as unknown as WebSocket;
  const direct = server as unknown as {
    socketMeta: WeakMap<WebSocket, {
      cache: Map<string, unknown>;
      pairedSurfaceId: string | null;
      remoteAddress: string;
      socketId: string;
    }>;
    handlePaneSplit: (socket: WebSocket, request: Record<string, unknown>) => Promise<Record<string, any>>;
    handleSurfaceDescribe: (request: Record<string, unknown>) => Record<string, any>;
    waitForResolvedPaneGeometry: (...args: unknown[]) => Promise<void>;
  };
  direct.socketMeta.set(fakeSocket, {
    cache: new Map(),
    pairedSurfaceId: surface.surfaceId,
    remoteAddress: "127.0.0.1",
    socketId: "readiness-geometry-fixture",
  });

  type GeometryGate = {
    entered: Promise<void>;
    signalEntered: () => void;
    wait: Promise<void>;
    release: () => void;
    failure?: Error;
  };
  let nextGeometryGate: GeometryGate | null = null;
  direct.waitForResolvedPaneGeometry = async (...args: unknown[]) => {
    const gate = nextGeometryGate;
    assert.ok(gate, "split must reach the held geometry phase");
    nextGeometryGate = null;
    gate.signalEntered();
    await gate.wait;
    if (gate.failure) throw gate.failure;
    const surfaceId = String(args[0]);
    const identity = core.resolvedPaneGeometryIdentity(surfaceId);
    const panes = core.panesList(surfaceId).panes;
    const paneWidth = 1200 / panes.length;
    for (const [index, pane] of panes.entries()) {
      core.updatePaneSnapshot(surfaceId, Number(pane.paneId), {
        ...identity,
        bounds: { height: 800, width: paneWidth, x: index * paneWidth, y: 0 },
      });
    }
  };
  const holdGeometry = (failure?: Error): GeometryGate => {
    let signalEntered!: () => void;
    let release!: () => void;
    const gate: GeometryGate = {
      entered: new Promise<void>((resolve) => { signalEntered = resolve; }),
      signalEntered: () => signalEntered(),
      wait: new Promise<void>((resolve) => { release = resolve; }),
      release: () => release(),
      ...(failure ? { failure } : {}),
    };
    nextGeometryGate = gate;
    return gate;
  };
  const describe = (id: string) => direct.handleSurfaceDescribe({
    id,
    op: "surface.describe",
    payload: {
      clientId: binding.clientId,
      endpointLeaseGeneration: 17,
      nonce: "a".repeat(32),
      registryIdentity: { allocatorId: binding.allocatorId, fleetId: binding.fleetId },
      surfaceId: surface.surfaceId,
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  const runSplit = async (
    id: string,
    paneId: number,
    newPaneId: number,
    direction: "horizontal" | "vertical",
  ) => {
    const finishMutation = readiness.beginAuthorityMutation();
    try {
      return await core.locklessAuthority.transactionAsync(() =>
        core.transactionAsync(async () => {
          let response: Record<string, any>;
          try {
            response = await direct.handlePaneSplit(fakeSocket, {
              id,
              op: "pane.split",
              payload: {
                count: 2,
                direction,
                newPaneIds: [newPaneId],
                newPaneLabels: [0],
                paneId,
              },
              sentAt: Date.now(),
              type: "request",
              v: 1,
            });
          } catch (error) {
            response = {
              error: { code: "render_failed", message: error instanceof Error ? error.message : String(error) },
              ok: false,
            };
          }
          await readiness.track(async () => {});
          return response;
        }),
      );
    } finally {
      finishMutation();
    }
  };

  const initial = core.pairState(surface.surfaceId);
  const successfulGeometry = holdGeometry();
  const successfulSplit = runSplit(
    "rq_held_split_success",
    Number(initial.panes[0]!.paneId),
    2,
    "horizontal",
  );
  await successfulGeometry.entered;
  assert.equal(readiness.isReady, false);
  assert.equal(core.panesList(surface.surfaceId).panes.length, 2,
    "SurfaceCore contains the candidate topology while geometry is held");
  const duringSuccessfulGeometry = describe("rq_describe_success_during_geometry");
  assert.equal(duringSuccessfulGeometry.ok, false, JSON.stringify(duringSuccessfulGeometry));
  assert.equal(duringSuccessfulGeometry.error.code, "not_ready");
  assert.equal(duringSuccessfulGeometry.payload, undefined);

  successfulGeometry.release();
  const split = await successfulSplit;
  assert.equal(split.ok, true, JSON.stringify(split));
  assert.equal(readiness.isReady, true);
  const committed = describe("rq_describe_success_after_commit");
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.payload.applicationReadiness.status, "ready");
  assert.equal(committed.payload.topologyRevision, core.pairState(surface.surfaceId).topologyRevision);
  assert.equal(committed.payload.panes.length, 2);

  const beforeFailedSplit = core.pairState(surface.surfaceId);
  const failedGeometry = holdGeometry(new Error("held geometry rejected"));
  const failedSplit = runSplit(
    "rq_held_split_failure",
    Number(beforeFailedSplit.panes[0]!.paneId),
    3,
    "vertical",
  );
  await failedGeometry.entered;
  assert.equal(readiness.isReady, false);
  assert.equal(core.panesList(surface.surfaceId).panes.length, 3,
    "SurfaceCore contains the second candidate before its rollback");
  const duringFailedGeometry = describe("rq_describe_failure_during_geometry");
  assert.equal(duringFailedGeometry.ok, false, JSON.stringify(duringFailedGeometry));
  assert.equal(duringFailedGeometry.error.code, "not_ready");
  assert.equal(duringFailedGeometry.payload, undefined);

  failedGeometry.release();
  const rejectedSplit = await failedSplit;
  assert.equal(rejectedSplit.ok, false, JSON.stringify(rejectedSplit));
  assert.equal(readiness.isReady, true);
  const afterRollback = core.pairState(surface.surfaceId);
  assert.equal(afterRollback.topologyRevision, beforeFailedSplit.topologyRevision);
  assert.deepEqual(
    afterRollback.panes.map((pane) => Number(pane.paneId)),
    beforeFailedSplit.panes.map((pane) => Number(pane.paneId)),
  );
  const restoredObservation = describe("rq_describe_after_rollback");
  assert.equal(restoredObservation.ok, true, JSON.stringify(restoredObservation));
  assert.equal(restoredObservation.payload.applicationReadiness.status, "ready");
  assert.equal(restoredObservation.payload.topologyRevision, beforeFailedSplit.topologyRevision);
  assert.equal(restoredObservation.payload.panes.length, 2);
});
