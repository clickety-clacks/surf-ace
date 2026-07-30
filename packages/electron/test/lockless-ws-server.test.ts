import assert from "node:assert/strict";
import test from "node:test";

import WebSocket from "ws";

import { SURF_ACE_LOCKLESS_V1_CAPABILITY } from "../../protocol/src/lockless.js";
import { SurfaceCore } from "../src/surface-core.js";
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
    assert.equal(committed.payload.receipt.requestId.startsWith("rq_"), true);
    assert.equal(committed.payload.receipt.commitSequence > 0, true);
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

    const targetApply = await request(first, "target.apply", {
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
    assert.equal(targetApply.ok, true, JSON.stringify(targetApply));
    assert.equal(targetApply.payload.requestId, "target-routing-proof");
    assert.equal(targetApply.payload.status, "rejected");
    assert.equal(
      targetApply.payload.errorCode,
      "unsupported_target_kind",
    );
    assert.equal(targetApply.payload.receipt.commitSequence > 0, true);

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
