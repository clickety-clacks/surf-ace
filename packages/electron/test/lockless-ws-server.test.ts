import assert from "node:assert/strict";
import test from "node:test";

import WebSocket from "ws";

import { SURF_ACE_LOCKLESS_V1_CAPABILITY } from "../../protocol/src/lockless.js";
import { SurfaceCore } from "../src/surface-core.js";
import {
  DEFAULT_LOCKLESS_LIMITS,
  createEmptyLocklessClientState,
} from "../src/lockless-client-authority.js";
import { PersistentStateOutcomeUnknownError } from "../src/persistent-state-file.js";
import { SurfaceWsServer } from "../src/ws-server.js";

let nextPort = 25901;

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function request(
  socket: WebSocket,
  op: string,
  payload: Record<string, unknown>,
  options?: { id?: string; sentAt?: number },
): Promise<Record<string, any>> {
  const id =
    options?.id ?? `rq_${Math.random().toString(16).slice(2)}`;
  const result = new Promise<Record<string, any>>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as Record<string, any>;
      if (message.type !== "response" || message.id !== id) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
  socket.send(
    JSON.stringify({
      id,
      op,
      payload,
      sentAt: options?.sentAt ?? Date.now(),
      type: "request",
      v: 1,
    }),
  );
  return result;
}

function nextEvent(
  socket: WebSocket,
  op: string,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as Record<string, any>;
      if (message.type !== "event" || message.op !== op) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function pair(
  socket: WebSocket,
  controllerInstanceId: string,
  surfaceId?: string,
): Promise<Record<string, any>> {
  return request(socket, "pair.request", {
    controllerInstanceId,
    controllerProductName:
      controllerInstanceId === "tight-beam" ? "Tight Beam" : "OpenClaw",
    projectionCapacityBytes: 5 * 1024 * 1024,
    protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    protocolVersion: 1,
    ...(surfaceId ? { surfaceId } : {}),
  });
}

test("websocket integration harness admits concurrent controllers and fans out client commits", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const first = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const firstPair = await pair(first, "openclaw", surface.surfaceId);
    const secondPair = await pair(second, "tight-beam", surface.surfaceId);
    assert.equal(firstPair.ok, true, JSON.stringify(firstPair));
    assert.equal(secondPair.ok, true, JSON.stringify(secondPair));
    assert.equal(firstPair.payload.mode, "lockless");
    assert.equal(
      firstPair.payload.capabilities.protocolFeatures.includes(
        SURF_ACE_LOCKLESS_V1_CAPABILITY,
      ),
      true,
    );

    const listed = await request(first, "surfaces.list", {});
    assert.equal(listed.payload.surfaces[0].surfaceId, surface.surfaceId);
    const panes = await request(first, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const paneId = Number(panes.payload.panes[0].paneId);

    const observedBySecond = nextEvent(
      second,
      "event.lockless_content_committed",
    );
    const committed = await request(first, "content.set", {
      content: { markdown: "# shared" },
      contentId: "content-shared",
      contentType: "markdown",
      friendlyChatName: "CLU",
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.equal(committed.payload.revision, 1);
    assert.match(committed.payload.historyEntryId, /^he_/);
    assert.equal(committed.payload.operationReceipt.requestId.startsWith("rq_"), true);
    assert.equal(committed.payload.operationReceipt.commitSequence > 0, true);
    const observedCommit = await observedBySecond;
    assert.equal(observedCommit.payload.contentId, "content-shared");
    assert.equal(
      observedCommit.payload.historyEntryId,
      committed.payload.historyEntryId,
    );

    for (const [contentId, revision] of [
      ["content-second", 2],
      ["content-third", 3],
    ] as const) {
      const next = await request(first, "content.set", {
        content: { markdown: `# ${contentId}` },
        contentId,
        contentType: "markdown",
        paneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.equal(next.payload.revision, revision);
    }
    core.navigateHistory(surface.surfaceId, paneId, "back");
    const divergentPayload = {
      content: { markdown: "# divergent" },
      contentId: "content-divergent",
      contentType: "markdown",
      paneId,
      surfaceId: surface.surfaceId,
    };
    const divergent = await request(
      first,
      "content.set",
      divergentPayload,
      { id: "rq-divergent-replay", sentAt: 100 },
    );
    assert.equal(divergent.ok, true, JSON.stringify(divergent));
    assert.equal(divergent.payload.revision, 4);
    const replayed = await request(
      first,
      "content.set",
      divergentPayload,
      { id: "rq-divergent-replay", sentAt: 200 },
    );
    assert.deepEqual(replayed, divergent);

    const split = await request(second, "pane.split", {
      count: 2,
      direction: "horizontal",
      expectedTopologyRevision: panes.payload.topology.topologyRevision,
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(split.ok, true, JSON.stringify(split));
    assert.equal(split.payload.panes.length, 2);
    const createdPaneId = split.payload.panes.find(
      (pane: { paneId: number }) => pane.paneId !== paneId,
    ).paneId;
    const closed = await request(first, "pane.close", {
      expectedTopologyRevision: split.payload.topologyRevision,
      paneId: createdPaneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(closed.payload.recoverable, true);
    const restored = await request(second, "pane.restore", {
      anchorPaneId: paneId,
      direction: "vertical",
      expectedTopologyRevision: closed.payload.topologyRevision,
      surfaceId: surface.surfaceId,
      tombstoneId: closed.payload.tombstoneId,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.payload.paneId, createdPaneId);

    const createdLifecycleEvent = nextEvent(
      second,
      "event.pane_created",
    );
    const realized = await request(first, "topology.apply", {
      allowDestroyPaneIds: [],
      desired: {
        children: [
          { paneId, type: "pane" },
          { paneId: createdPaneId, type: "pane" },
          { name: "Allocated by Surf Ace", type: "pane" },
        ],
        direction: "horizontal",
        type: "split",
      },
      expectedTopologyRevision: restored.payload.topologyRevision,
      surfaceId: surface.surfaceId,
      target: { root: true },
    });
    assert.equal(realized.ok, true, JSON.stringify(realized));
    assert.equal(realized.payload.topologyRevision, 4);
    assert.equal(realized.payload.panes.length, 3);
    const allocatedPaneId = realized.payload.panes.find(
      (candidate: { paneId: number }) =>
        candidate.paneId !== paneId &&
        candidate.paneId !== createdPaneId,
    ).paneId;
    assert.deepEqual(realized.payload.createdPaneIds, [allocatedPaneId]);
    assert.deepEqual(realized.payload.destroyedPaneIds, []);
    assert.deepEqual(realized.payload.destroyedPaneTombstones, []);
    assert.deepEqual(
      [...realized.payload.preservedPaneIds].sort((a, b) => a - b),
      [paneId, createdPaneId].sort((a, b) => a - b),
    );
    assert.deepEqual(realized.payload.topology, {
      children: [
        { paneId, type: "pane" },
        { paneId: createdPaneId, type: "pane" },
        { paneId: allocatedPaneId, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    });
    assert.equal(
      (await createdLifecycleEvent).payload.paneId,
      allocatedPaneId,
    );

    const registered = await request(second, "target.register", {
      expectedPreviousTargetEpoch: null,
      idempotencyKey: "register-existing-pane",
      launchedAt: new Date().toISOString(),
      paneId,
      registrationState: "before_attach",
      surfaceId: surface.surfaceId,
      targetHeader: {},
      targetKind: "markdown",
      targetPayload: { markdown: "# target" },
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    assert.equal(registered.payload.registered, true);
    assert.equal(registered.payload.paneId, paneId);
    assert.match(registered.payload.paneLineageId, /^pl_/);
    assert.match(registered.payload.target.targetId, /^tg_/);
    assert.equal(registered.payload.target.targetEpoch, 1);
    assert.equal(registered.payload.target.targetKind, "markdown");
    assert.deepEqual(registered.payload.target.targetPayload, {
      markdown: "# target",
    });
    const registeredProjection = await request(first, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    assert.equal(
      registeredProjection.payload.panes.find(
        (candidate: { paneId: number }) =>
          Number(candidate.paneId) === paneId,
      ).currentTarget.targetId,
      registered.payload.target.targetId,
    );
    const duplicateRegistration = await request(
      first,
      "target.register",
      {
        expectedPreviousTargetEpoch: null,
        idempotencyKey: "register-existing-pane",
        launchedAt: new Date().toISOString(),
        paneId,
        registrationState: "before_attach",
        surfaceId: surface.surfaceId,
        targetHeader: {},
        targetKind: "markdown",
        targetPayload: { markdown: "# target" },
      },
    );
    assert.equal(
      duplicateRegistration.payload.target.targetId,
      registered.payload.target.targetId,
    );

    const rejectedPreflight = await request(first, "target.apply", {
      paneId,
      requestId: "target-routing-proof",
      restoreReason: "initial",
      surfaceId: surface.surfaceId,
      targetEpoch: 1,
      targetHeader: {},
      targetId: "target-routing-proof",
      targetKind: "unsupported.for-test",
      targetPayload: {},
    });
    assert.equal(rejectedPreflight.ok, false, JSON.stringify(rejectedPreflight));
    assert.equal(rejectedPreflight.error.code, "unsupported_operation");
    const rejectedReceipt = await request(first, "operation.receipt.sync", {
      requestIds: [rejectedPreflight.id],
    });
    assert.equal(rejectedReceipt.payload.resolutions[0].outcome, "not_committed");

    let materializationInvocations = 0;
    const applyTarget = core.targetApply.bind(core);
    core.targetApply = ((...arguments_: Parameters<SurfaceCore["targetApply"]>) => {
      materializationInvocations += 1;
      return applyTarget(...arguments_);
    }) as SurfaceCore["targetApply"];
    const materializationResult = nextEvent(
      second,
      "event.target_apply_result",
    );
    const targetApply = await request(first, "target.apply", {
      paneId,
      requestId: "target-browser-materialization",
      restoreReason: "initial",
      surfaceId: surface.surfaceId,
      targetEpoch: 2,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "DEC-TA-01A proof",
      },
      targetId: "target-browser-proof",
      targetKind: "browser_url",
      targetPayload: { url: "https://example.com/" },
    });
    assert.equal(targetApply.ok, true, JSON.stringify(targetApply));
    assert.deepEqual(
      {
        operationRequestId: targetApply.payload.operationRequestId,
        status: targetApply.payload.status,
        surfaceId: targetApply.payload.surfaceId,
        targetEpoch: targetApply.payload.targetEpoch,
        targetId: targetApply.payload.targetId,
        targetRequestId: targetApply.payload.targetRequestId,
      },
      {
        operationRequestId: targetApply.id,
        status: "intent_committed",
        surfaceId: surface.surfaceId,
        targetEpoch: 2,
        targetId: "target-browser-proof",
        targetRequestId: "target-browser-materialization",
      },
    );
    assert.equal(targetApply.payload.operationReceipt.commitSequence > 0, true);
    for (let attempt = 0; materializationInvocations === 0 && attempt < 50; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(materializationInvocations, 1);
    await (server as unknown as {
      continueTargetApplyWorkItem: (
        controllerInstanceId: string,
        operationRequestId: string,
        request: Record<string, unknown>,
        socket: WebSocket,
      ) => Promise<void>;
    }).continueTargetApplyWorkItem(
      "openclaw",
      targetApply.id,
      {
        id: targetApply.id,
        op: "target.apply",
        payload: {
          ownershipEpoch: 0,
          ownershipSessionId: "",
          paneLineageId: registered.paneLineageId,
          requestId: "target-browser-materialization",
          restoreReason: "initial",
          surfaceId: surface.surfaceId,
          targetEpoch: 2,
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "navigate",
            requiredCapabilities: ["target.browser_url.v1"],
            safeToLogFields: ["url"],
            safetyClass: "network",
            summary: "DEC-TA-01A proof",
          },
          targetId: "target-browser-proof",
          targetKind: "browser_url",
          targetPayload: { url: "https://example.com/" },
        },
        sentAt: Date.now(),
        type: "request",
        v: 1,
      },
      first,
    );
    assert.equal(materializationInvocations, 1);
    server.resolveBrowserUrlNavigation(surface.surfaceId, paneId, {
      status: "applied",
      targetId: "target-browser-proof",
      url: "https://example.com/",
    });
    const result = await materializationResult;
    assert.equal(result.payload.status, "applied");
    assert.equal(materializationInvocations, 1);
    assert.equal(
      result.payload.intentCommitSequence,
      targetApply.payload.operationReceipt.commitSequence,
    );
    assert.equal(result.payload.operationRequestId, targetApply.id);
    assert.equal(result.payload.targetRequestId, "target-browser-materialization");
    assert.match(result.payload.recordId, /^cr_/);
    assert.equal(result.payload.consumableSequence > 0, true);
    const receiptReplay = await request(first, "operation.receipt.sync", {
      requestIds: [targetApply.id],
    });
    assert.deepEqual(
      receiptReplay.payload.resolutions[0].terminalResponse,
      targetApply,
    );
    const targetProjection = await request(first, "consumable.sync", {
      scopeIds: [`surface:${encodeURIComponent(surface.surfaceId)}`],
    });
    const projectedResult = targetProjection.payload.snapshots[0].records.find(
      (record: { recordClass: string }) => record.recordClass === "target_result",
    );
    assert.equal(projectedResult.recordId, result.payload.recordId);
    assert.equal(projectedResult.payload.status, "applied");

    const removedLifecycleEvent = nextEvent(
      second,
      "event.pane_removed",
    );
    const removedByTopology = await request(first, "topology.apply", {
      allowDestroyPaneIds: [allocatedPaneId],
      desired: {
        children: [
          { paneId, type: "pane" },
          { paneId: createdPaneId, type: "pane" },
        ],
        direction: "horizontal",
        type: "split",
      },
      expectedTopologyRevision: 4,
      surfaceId: surface.surfaceId,
      target: { root: true },
    });
    assert.equal(removedByTopology.ok, true, JSON.stringify(removedByTopology));
    assert.deepEqual(removedByTopology.payload.createdPaneIds, []);
    assert.deepEqual(removedByTopology.payload.destroyedPaneIds, [
      allocatedPaneId,
    ]);
    assert.deepEqual(
      removedByTopology.payload.preservedPaneIds,
      [paneId, createdPaneId],
    );
    const [removedTombstone] =
      removedByTopology.payload.destroyedPaneTombstones;
    assert.equal(removedTombstone.paneId, allocatedPaneId);
    assert.match(removedTombstone.tombstoneId, /^pt_/);
    assert.equal(removedTombstone.closedSequence > 0, true);
    assert.equal(
      (await removedLifecycleEvent).payload.paneId,
      allocatedPaneId,
    );
    const restoredTopologyPane = await request(first, "pane.restore", {
      anchorPaneId: paneId,
      direction: "horizontal",
      expectedTopologyRevision:
        removedByTopology.payload.topologyRevision,
      surfaceId: surface.surfaceId,
      tombstoneId: removedTombstone.tombstoneId,
    });
    assert.equal(restoredTopologyPane.ok, true, JSON.stringify(restoredTopologyPane));
    assert.equal(restoredTopologyPane.payload.paneId, allocatedPaneId);
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("restart from materializing terminalizes unknown without re-invoking target materialization", async () => {
  const seed = new SurfaceCore();
  const surface = seed.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  seed.admitSurfaceToLockless(surface.surfaceId);
  seed.locklessAuthority.admit(
    {
      controllerInstanceId: "tight-beam-restart",
      projectionCapacityBytes: 5 * 1024 * 1024,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    },
    "seed-token",
    "seed-admission",
    `surface:${surface.surfaceId}`,
  );
  const pane = seed.panesList(surface.surfaceId).panes[0];
  const requestId = "target-restart-operation";
  const intent = seed.locklessAuthority.auditAccepted(
    requestId,
    "target.apply",
    "tight-beam-restart",
    surface.surfaceId,
  );
  seed.locklessAuthority.admitTargetApplyWorkItem({
    controllerInstanceId: "tight-beam-restart",
    currentSurfaceBase: seed.captureSurfaceTombstonePayload(
      surface.surfaceId,
    ),
    intentCommitSequence: intent.commitSequence,
    operationRequestId: requestId,
    request: {
      paneId: Number(pane.paneId),
      paneLineageId: String(pane.paneLineageId),
      requestId: "target-restart-materialization",
      restoreReason: "initial",
      surfaceId: surface.surfaceId,
      targetEpoch: 1,
      targetHeader: {},
      targetId: "target-restart",
      targetKind: "native_app",
      targetPayload: { appId: "must-not-run" },
    },
  });
  seed.locklessAuthority.markTargetApplyMaterializing(
    "tight-beam-restart",
    requestId,
  );

  const restored = new SurfaceCore({
    persistentState: seed.getPersistentState(),
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core: restored,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  try {
    assert.deepEqual(restored.locklessAuthority.targetApplyWorkItems(), []);
    const records = restored.locklessAuthority.scopeSnapshot(
      "tight-beam-restart",
      `surface:${encodeURIComponent(surface.surfaceId)}`,
    ).records;
    const result = records.find(
      (record) => record.recordClass === "target_result",
    );
    assert.equal(result?.payload.status, "failed");
    assert.equal(
      result?.payload.errorCode,
      "materialization_outcome_unknown",
    );
    assert.equal(result?.payload.operationRequestId, requestId);
    assert.equal(
      result?.payload.intentCommitSequence,
      intent.commitSequence,
    );
  } finally {
    await server.stop();
  }
});

test("restart from committed target intent persists materializing and invokes exactly once", async () => {
  const seed = new SurfaceCore();
  const surface = seed.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  seed.admitSurfaceToLockless(surface.surfaceId);
  seed.locklessAuthority.admit(
    {
      controllerInstanceId: "tight-beam-restart-intent",
      projectionCapacityBytes: 5 * 1024 * 1024,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    },
    "seed-intent-token",
    "seed-intent-admission",
    `surface:${surface.surfaceId}`,
  );
  const pane = seed.panesList(surface.surfaceId).panes[0];
  const requestId = "target-restart-intent-operation";
  const intent = seed.locklessAuthority.auditAccepted(
    requestId,
    "target.apply",
    "tight-beam-restart-intent",
    surface.surfaceId,
  );
  seed.locklessAuthority.admitTargetApplyWorkItem({
    controllerInstanceId: "tight-beam-restart-intent",
    currentSurfaceBase: seed.captureSurfaceTombstonePayload(
      surface.surfaceId,
    ),
    intentCommitSequence: intent.commitSequence,
    operationRequestId: requestId,
    request: {
      paneId: Number(pane.paneId),
      paneLineageId: String(pane.paneLineageId),
      requestId: "target-restart-native-materialization",
      restoreReason: "initial",
      surfaceId: surface.surfaceId,
      targetEpoch: 1,
      targetHeader: {},
      targetId: "target-restart-native",
      targetKind: "native_app",
      targetPayload: { appId: "restart-native-proof" },
    },
  });

  const restored = new SurfaceCore({
    persistentState: seed.getPersistentState(),
  });
  let materializationInvocations = 0;
  const projectMaterialization =
    restored.projectNativePaneMaterialization.bind(restored);
  restored.projectNativePaneMaterialization = ((
    ...arguments_: Parameters<SurfaceCore["projectNativePaneMaterialization"]>
  ) => {
    materializationInvocations += 1;
    return projectMaterialization(...arguments_);
  }) as SurfaceCore["projectNativePaneMaterialization"];
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core: restored,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  try {
    assert.deepEqual(restored.locklessAuthority.targetApplyWorkItems(), []);
    const records = restored.locklessAuthority.scopeSnapshot(
      "tight-beam-restart-intent",
      `surface:${encodeURIComponent(surface.surfaceId)}`,
    ).records;
    const results = records.filter(
      (record) => record.recordClass === "target_result",
    );
    assert.equal(results.length, 1);
    assert.equal(materializationInvocations, 1);
    assert.notEqual(
      results[0]?.payload.errorCode,
      "materialization_outcome_unknown",
    );
    assert.equal(results[0]?.payload.operationRequestId, requestId);
    assert.equal(
      results[0]?.payload.intentCommitSequence,
      intent.commitSequence,
    );
  } finally {
    await server.stop();
  }
});

test("target intent persistence completes before response and materialization callback", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  let gatePersistence = false;
  let releasePersistence: (() => void) | null = null;
  let materializationInvocations = 0;
  const targetApply = core.targetApply.bind(core);
  core.targetApply = ((...arguments_: Parameters<SurfaceCore["targetApply"]>) => {
    materializationInvocations += 1;
    return targetApply(...arguments_);
  }) as SurfaceCore["targetApply"];
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      if (!gatePersistence) return;
      await new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(socket, "tight-beam", surface.surfaceId)).ok, true);
    const panes = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const paneId = Number(panes.payload.panes[0].paneId);
    gatePersistence = true;
    const resultEvent = nextEvent(socket, "event.target_apply_result");
    const responsePromise = request(socket, "target.apply", {
      paneId,
      requestId: "target-persistence-materialization",
      restoreReason: "initial",
      surfaceId: surface.surfaceId,
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "persistence gate",
      },
      targetId: "target-persistence",
      targetKind: "browser_url",
      targetPayload: { url: "https://example.com/" },
    });
    const early = await Promise.race([
      responsePromise.then(() => "response"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("withheld"), 25)
      ),
    ]);
    assert.equal(early, "withheld");
    assert.equal(materializationInvocations, 0);
    assert.ok(releasePersistence);
    gatePersistence = false;
    releasePersistence();
    const response = await responsePromise;
    assert.equal(response.payload.status, "intent_committed");
    server.resolveBrowserUrlNavigation(surface.surfaceId, paneId, {
      status: "applied",
      targetId: "target-persistence",
      url: "https://example.com/",
    });
    const result = await resultEvent;
    assert.equal(materializationInvocations, 1);
    assert.equal(result.payload.status, "applied");
    assert.equal(
      result.payload.intentCommitSequence,
      response.payload.operationReceipt.commitSequence,
    );
  } finally {
    socket.close();
    await server.stop();
  }
});

test("unknown persistence outcome closes transport without a terminal answer and fail-stops later authority", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  let failPersistence = false;
  let materializationInvocations = 0;
  const targetApply = core.targetApply.bind(core);
  core.targetApply = ((...arguments_: Parameters<SurfaceCore["targetApply"]>) => {
    materializationInvocations += 1;
    return targetApply(...arguments_);
  }) as SurfaceCore["targetApply"];
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      if (failPersistence) {
        throw new PersistentStateOutcomeUnknownError(new Error("injected selector ambiguity"));
      }
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(socket, "tight-beam", surface.surfaceId)).ok, true);
    const panes = await request(socket, "panes.list", { surfaceId: surface.surfaceId });
    const requestId = "target-persistence-outcome-unknown";
    const received: Record<string, any>[] = [];
    socket.on("message", (raw) => received.push(JSON.parse(String(raw))));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: String(reason) }));
    });
    failPersistence = true;
    socket.send(JSON.stringify({
      id: requestId,
      op: "target.apply",
      payload: {
        paneId: Number(panes.payload.panes[0].paneId),
        requestId: "target-materialization-must-not-run",
        restoreReason: "initial",
        surfaceId: surface.surfaceId,
        targetEpoch: 1,
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "navigate",
          requiredCapabilities: ["target.browser_url.v1"],
          safeToLogFields: ["url"],
          safetyClass: "network",
          summary: "must fail stop",
        },
        targetId: "target-fail-stop",
        targetKind: "browser_url",
        targetPayload: { url: "https://example.com/" },
      },
      sentAt: Date.now(),
      type: "request",
      v: 1,
    }));
    const close = await closed;
    assert.equal(close.code, 1011);
    assert.equal(close.reason, "persistence_outcome_unknown");
    assert.equal(received.some((message) => message.id === requestId), false);
    assert.equal(materializationInvocations, 0);
    await assert.rejects(connect(`ws://127.0.0.1:${port}${server.wsPath}`));
  } finally {
    socket.close();
    await server.stop();
  }
});

test("blocked persistence serializes concurrent target intents, ordinary mutation, and acknowledgements", async () => {
  const core = new SurfaceCore();
  const firstSurface = core.ensurePrimarySurface("First", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const secondSurface = core.createAdditionalSurface("Second", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  let gatePersistence = false;
  let releasePersistence = (): void => {};
  let persistenceStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    persistenceStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let blocked = false;
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      if (!gatePersistence || blocked) return;
      blocked = true;
      persistenceStarted();
      await gate;
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const first = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(first, "controller-first", firstSurface.surfaceId)).ok, true);
    assert.equal((await pair(second, "controller-second", secondSurface.surfaceId)).ok, true);
    const firstPane = Number((await request(first, "panes.list", {
      surfaceId: firstSurface.surfaceId,
    })).payload.panes[0].paneId);
    const secondPane = Number((await request(second, "panes.list", {
      surfaceId: secondSurface.surfaceId,
    })).payload.panes[0].paneId);
    gatePersistence = true;
    const firstTarget = request(first, "target.apply", {
      paneId: firstPane,
      requestId: "materialize-first",
      restoreReason: "initial",
      surfaceId: firstSurface.surfaceId,
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "first",
      },
      targetId: "target-first",
      targetKind: "browser_url",
      targetPayload: { url: "https://first.example/" },
    }, { id: "operation-first" });
    await started;
    const secondTarget = request(second, "target.apply", {
      paneId: secondPane,
      requestId: "materialize-second",
      restoreReason: "initial",
      surfaceId: secondSurface.surfaceId,
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "second",
      },
      targetId: "target-second",
      targetKind: "browser_url",
      targetPayload: { url: "https://second.example/" },
    }, { id: "operation-second" });
    const ordinary = request(second, "content.set", {
      content: { markdown: "queued" },
      contentId: "queued-content",
      contentType: "markdown",
      paneId: secondPane,
      surfaceId: secondSurface.surfaceId,
    }, { id: "operation-ordinary" });
    const early = await Promise.race([
      Promise.any([firstTarget, secondTarget, ordinary]).then(() => "response"),
      new Promise<string>((resolve) => setTimeout(() => resolve("withheld"), 25)),
    ]);
    assert.equal(early, "withheld");
    releasePersistence();
    const [firstResponse, secondResponse, ordinaryResponse] = await Promise.all([
      firstTarget,
      secondTarget,
      ordinary,
    ]);
    assert.equal(firstResponse.payload.status, "intent_committed");
    assert.equal(secondResponse.payload.status, "intent_committed");
    assert.equal(ordinaryResponse.ok, true, JSON.stringify(ordinaryResponse));
    assert.ok(
      firstResponse.payload.operationReceipt.commitSequence <
        secondResponse.payload.operationReceipt.commitSequence,
    );
    assert.ok(
      secondResponse.payload.operationReceipt.commitSequence <
        ordinaryResponse.payload.operationReceipt.commitSequence,
    );
    assert.notEqual(firstResponse.error?.code, "internal_error");
    assert.notEqual(secondResponse.error?.code, "internal_error");

    const receiptAck = request(first, "operation.receipt.ack", {
      requestId: "operation-first",
    });
    const consumableAck = request(second, "consumable.ack", {
      cursor: 1,
      scopeId: `surface:${encodeURIComponent(secondSurface.surfaceId)}`,
    });
    assert.equal((await receiptAck).payload.accepted, true);
    assert.equal((await consumableAck).ok, true);

    const firstResult = nextEvent(first, "event.target_apply_result");
    const secondResult = nextEvent(second, "event.target_apply_result");
    server.resolveBrowserUrlNavigation(firstSurface.surfaceId, firstPane, {
      status: "applied",
      targetId: "target-first",
      url: "https://first.example/",
    });
    server.resolveBrowserUrlNavigation(secondSurface.surfaceId, secondPane, {
      status: "applied",
      targetId: "target-second",
      url: "https://second.example/",
    });
    assert.equal((await firstResult).payload.status, "applied");
    assert.equal((await secondResult).payload.status, "applied");
    const firstResultRecords = core.locklessAuthority.scopeSnapshot(
      "controller-first",
      `surface:${encodeURIComponent(firstSurface.surfaceId)}`,
    ).records.filter((record) => record.recordClass === "target_result");
    const secondResultRecords = core.locklessAuthority.scopeSnapshot(
      "controller-second",
      `surface:${encodeURIComponent(secondSurface.surfaceId)}`,
    ).records.filter((record) => record.recordClass === "target_result");
    assert.equal(firstResultRecords.length, 1);
    assert.equal(firstResultRecords[0].payload.operationRequestId, "operation-first");
    assert.equal(secondResultRecords.length, 1);
    assert.equal(secondResultRecords[0].payload.operationRequestId, "operation-second");
    assert.deepEqual(core.locklessAuthority.targetApplyWorkItems(), []);
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("queued topology mutation invalidates a later target before FIFO admission", async () => {
  const core = new SurfaceCore();
  const firstSurface = core.ensurePrimarySurface("First", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const secondSurface = core.createAdditionalSurface("Second", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  let gatePersistence = false;
  let persistenceBlocked = false;
  let releasePersistence = (): void => {};
  let persistenceStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    persistenceStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      if (!gatePersistence || persistenceBlocked) return;
      persistenceBlocked = true;
      persistenceStarted();
      await gate;
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const first = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(first, "controller-first", firstSurface.surfaceId)).ok, true);
    assert.equal((await pair(second, "controller-second", secondSurface.surfaceId)).ok, true);
    const firstPane = Number((await request(first, "panes.list", {
      surfaceId: firstSurface.surfaceId,
    })).payload.panes[0].paneId);
    const initialSecondPane = Number((await request(second, "panes.list", {
      surfaceId: secondSurface.surfaceId,
    })).payload.panes[0].paneId);
    const split = await request(second, "pane.split", {
      count: 2,
      direction: "horizontal",
      expectedTopologyRevision: 0,
      paneId: initialSecondPane,
      surfaceId: secondSurface.surfaceId,
    });
    assert.equal(split.ok, true, JSON.stringify(split));
    const closingPane = Number(split.payload.panes.find(
      (pane: { paneId: number }) => pane.paneId !== initialSecondPane,
    ).paneId);

    gatePersistence = true;
    const firstTarget = request(first, "target.apply", {
      paneId: firstPane,
      requestId: "materialize-gate",
      restoreReason: "initial",
      surfaceId: firstSurface.surfaceId,
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "gate",
      },
      targetId: "target-gate",
      targetKind: "browser_url",
      targetPayload: { url: "https://gate.example/" },
    }, { id: "operation-gate" });
    await started;
    const close = request(second, "pane.close", {
      expectedTopologyRevision: split.payload.topologyRevision,
      paneId: closingPane,
      surfaceId: secondSurface.surfaceId,
    }, { id: "operation-close" });
    const invalidatedTarget = request(second, "target.apply", {
      paneId: closingPane,
      requestId: "materialize-invalidated",
      restoreReason: "initial",
      surfaceId: secondSurface.surfaceId,
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: "invalidated",
      },
      targetId: "target-invalidated",
      targetKind: "browser_url",
      targetPayload: { url: "https://invalidated.example/" },
    }, { id: "operation-invalidated" });
    releasePersistence();
    const [firstResponse, closeResponse, invalidatedResponse] = await Promise.all([
      firstTarget,
      close,
      invalidatedTarget,
    ]);
    assert.equal(firstResponse.payload.status, "intent_committed");
    assert.equal(closeResponse.ok, true, JSON.stringify(closeResponse));
    assert.equal(invalidatedResponse.ok, false, JSON.stringify(invalidatedResponse));
    assert.equal(invalidatedResponse.error.code, "invalid_payload");

    const firstResult = nextEvent(first, "event.target_apply_result");
    server.resolveBrowserUrlNavigation(firstSurface.surfaceId, firstPane, {
      status: "applied",
      targetId: "target-gate",
      url: "https://gate.example/",
    });
    assert.equal((await firstResult).payload.status, "applied");
    assert.deepEqual(core.locklessAuthority.targetApplyWorkItems(), []);
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("terminal mutation response waits for durable receipt persistence and replays until ack", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  let releasePersistence: (() => void) | null = null;
  let persistenceCalls = 0;
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      persistenceCalls += 1;
      if (persistenceCalls === 1) {
        await new Promise<void>((resolve) => {
          releasePersistence = resolve;
        });
      }
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(socket, "tight-beam", surface.surfaceId)).ok, true);
    const panes = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const requestId = "receipt-persistence-gate";
    const mutation = request(socket, "content.set", {
      content: { markdown: "# durable" },
      contentId: "durable-content",
      contentType: "markdown",
      paneId: Number(panes.payload.panes[0].paneId),
      surfaceId: surface.surfaceId,
    }, { id: requestId });
    const early = await Promise.race([
      mutation.then(() => "response"),
      new Promise<string>((resolve) => setTimeout(() => resolve("withheld"), 25)),
    ]);
    assert.equal(early, "withheld");
    assert.equal(persistenceCalls, 1);
    assert.ok(releasePersistence);
    releasePersistence();
    const terminal = await mutation;
    assert.equal(terminal.ok, true, JSON.stringify(terminal));
    assert.deepEqual(terminal.payload.operationReceipt, {
      commitSequence: terminal.payload.operationReceipt.commitSequence,
      requestId,
    });

    const synced = await request(socket, "operation.receipt.sync", {
      requestIds: [requestId, "never-committed"],
    });
    assert.deepEqual(
      synced.payload.resolutions.map((entry: { outcome: string }) => entry.outcome),
      ["resolved_success", "not_committed"],
    );
    assert.deepEqual(
      synced.payload.resolutions[0].terminalResponse,
      terminal,
    );
    const acknowledged = await request(socket, "operation.receipt.ack", {
      requestId,
    });
    assert.equal(acknowledged.payload.accepted, true);
    assert.equal(persistenceCalls, 2);
    const afterAck = await request(socket, "operation.receipt.sync", {
      requestIds: [requestId],
    });
    assert.equal(afterAck.payload.resolutions[0].outcome, "resolved_success");
    const released = await request(socket, "operation.receipt.ack", {
      release: true,
      requestId,
    });
    assert.equal(released.payload.accepted, true);
    assert.equal(released.payload.release, true);
    assert.equal(persistenceCalls, 3);
    const afterRelease = await request(socket, "operation.receipt.sync", {
      requestIds: [requestId],
    });
    assert.equal(afterRelease.payload.resolutions[0].outcome, "not_committed");
    const repeatedRelease = await request(socket, "operation.receipt.ack", {
      release: true,
      requestId,
    });
    assert.equal(repeatedRelease.payload.accepted, true);
  } finally {
    socket.close();
    await server.stop();
  }
});

test("exact terminal receipt capacity rolls back the mutation before commit", async () => {
  const lockless = createEmptyLocklessClientState({
    ...DEFAULT_LOCKLESS_LIMITS,
    maxPendingOperationReceiptBytesPerController: 256,
  });
  const core = new SurfaceCore({
    persistentState: {
      lockless,
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(socket, "tight-beam", surface.surfaceId)).ok, true);
    const before = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const paneId = Number(before.payload.panes[0].paneId);
    const rejected = await request(socket, "content.set", {
      content: { markdown: "# must roll back" },
      contentId: "too-large-receipt",
      contentType: "markdown",
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.error.code, "receipt_capacity");
    const after = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    assert.deepEqual(after.payload.panes, before.payload.panes);
    assert.deepEqual(after.payload.topology, before.payload.topology);
    assert.deepEqual(
      core.locklessAuthority.resolveOperationReceipts(
        "tight-beam",
        [rejected.id],
      ),
      [{ outcome: "not_committed", requestId: rejected.id }],
    );
  } finally {
    socket.close();
    await server.stop();
  }
});

test("one stable controller may hold lifecycle and surface sessions but not duplicate a target", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const lifecycle = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const surfaceSession = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const duplicateSurface = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const lifecyclePair = await pair(lifecycle, "tight-beam");
    assert.equal(lifecyclePair.ok, true, JSON.stringify(lifecyclePair));
    const surfacePair = await pair(
      surfaceSession,
      "tight-beam",
      surface.surfaceId,
    );
    assert.equal(
      surfacePair.ok,
      true,
      JSON.stringify(surfacePair),
    );
    const duplicate = await pair(
      duplicateSurface,
      "tight-beam",
      surface.surfaceId,
    );
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, "duplicate_controller_instance");

    const listed = await request(lifecycle, "surfaces.list", {});
    const removal = nextEvent(lifecycle, "event.surface_removed");
    const closed = await request(surfaceSession, "surface.window.close", {
      expectedSurfaceSetRevision: listed.payload.surfaceSetRevision,
      expectedTopologyRevision:
        listed.payload.surfaces[0].topology.topologyRevision,
      surfaceId: surface.surfaceId,
    });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal((await removal).payload.surfaceId, surface.surfaceId);
    surfaceSession.close();
    await new Promise<void>((resolve) =>
      surfaceSession.once("close", () => resolve()),
    );
    const appeared = nextEvent(lifecycle, "event.surface_appeared");
    const restored = await request(
      lifecycle,
      "surface.window.restore",
      {
        expectedSurfaceSetRevision: closed.payload.surfaceSetRevision,
        tombstoneId: closed.payload.tombstoneId,
      },
    );
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.payload.surfaceId, surface.surfaceId);
    assert.equal((await appeared).payload.surfaceId, surface.surfaceId);
  } finally {
    lifecycle.close();
    surfaceSession.close();
    duplicateSurface.close();
    await server.stop();
  }
});

test("migration admission rejects foreign and remapped bootstrap scopes", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    for (const scopeId of [
      "pane:foreign-surface:1",
      `pane:${encodeURIComponent(surface.surfaceId)}:0`,
    ]) {
      const response = await request(socket, "pair.request", {
        controllerInstanceId: "tight-beam",
        migrationMaterial: {
          scopes: [
            {
              records: [{ payload: { x: 1 }, recordClass: "tap" }],
              scopeId,
              scopeKind: "pane",
            },
          ],
        },
        projectionCapacityBytes: 5 * 1024 * 1024,
        protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
        protocolVersion: 1,
        surfaceId: surface.surfaceId,
      });
      assert.equal(response.ok, false, JSON.stringify(response));
      assert.equal(response.error.code, "invalid_payload");
    }
    assert.deepEqual(core.activePaneIds(surface.surfaceId), [0]);
  } finally {
    socket.close();
    await server.stop();
  }
});

test("zero-live-surface restart retains lifecycle authority and restores a surface tombstone", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const firstPort = nextPort++;
  const firstServer = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port: firstPort,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await firstServer.start();
  const lifecycle = await connect(
    `ws://127.0.0.1:${firstPort}${firstServer.wsPath}`,
  );
  const surfaceSession = await connect(
    `ws://127.0.0.1:${firstPort}${firstServer.wsPath}`,
  );
  const lifecyclePair = await pair(lifecycle, "tight-beam");
  const surfacePair = await pair(
    surfaceSession,
    "tight-beam",
    surface.surfaceId,
  );
  assert.equal(lifecyclePair.ok, true, JSON.stringify(lifecyclePair));
  assert.equal(surfacePair.ok, true, JSON.stringify(surfacePair));
  const listed = await request(lifecycle, "surfaces.list", {});
  const closed = await request(surfaceSession, "surface.window.close", {
    expectedSurfaceSetRevision: listed.payload.surfaceSetRevision,
    expectedTopologyRevision:
      listed.payload.surfaces[0].topology.topologyRevision,
    surfaceId: surface.surfaceId,
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  lifecycle.close();
  surfaceSession.close();
  await firstServer.stop();

  const restarted = new SurfaceCore({
    persistentState: core.getPersistentState(),
  });
  assert.deepEqual(
    restarted.restorePersistedSurfaces("Surf Ace", {
      height: 800,
      scale: 2,
      width: 1200,
    }),
    [],
  );
  assert.equal(restarted.listSurfaces().length, 0);
  const secondPort = nextPort++;
  const secondServer = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core: restarted,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port: secondPort,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await secondServer.start();
  const resumed = await connect(
    `ws://127.0.0.1:${secondPort}${secondServer.wsPath}`,
  );
  try {
    const admitted = await pair(resumed, "tight-beam");
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(admitted.payload.resumed, true);
    const empty = await request(resumed, "surfaces.list", {});
    assert.deepEqual(empty.payload.surfaces, []);
    const restored = await request(resumed, "surface.window.restore", {
      expectedSurfaceSetRevision: closed.payload.surfaceSetRevision,
      tombstoneId: closed.payload.tombstoneId,
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.payload.surfaceId, surface.surfaceId);
  } finally {
    resumed.close();
    await secondServer.stop();
  }
});
