import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import WebSocket from "ws";

import {
  DEFAULT_LOCKLESS_LIMITS,
  LocklessAuthorityError,
  LocklessClientAuthority,
  createEmptyLocklessClientState,
  exactDurableBytes,
  type AuthorityEvent,
} from "../src/lockless-client-authority.js";
import { SurfaceCore } from "../src/surface-core.js";
import { SurfaceWsServer } from "../src/ws-server.js";
import {
  SURF_ACE_LOCKLESS_V1_CAPABILITY,
  assertLocklessCapacityLimits,
  locklessRecoverableSurfaceMinimumBytes,
  type LocklessCapacityLimits,
} from "../../protocol/src/lockless.js";
import { PublicControllerWireClient } from "../../controller/src/wire.js";

const viewport = { height: 800, scale: 2, width: 1200 };

function acceptanceLimits(
  overrides: Partial<LocklessCapacityLimits> = {},
): LocklessCapacityLimits {
  const limits: LocklessCapacityLimits = {
    ...DEFAULT_LOCKLESS_LIMITS,
    maxPanesPerSurface: 2,
    maxRetainedTombstones: 2,
    ...overrides,
  };
  limits.maxRecoverableSurfaceBytes =
    locklessRecoverableSurfaceMinimumBytes(limits);
  limits.maxRetainedTombstoneBytes = Math.max(
    limits.maxRetainedTombstoneBytes,
    limits.maxRecoverableSurfaceBytes,
  );
  assertLocklessCapacityLimits(limits);
  return limits;
}

function coreWithLimits(limits = acceptanceLimits()): SurfaceCore {
  return new SurfaceCore({
    persistentState: {
      lockless: createEmptyLocklessClientState(limits),
      primarySurfaceId: null,
      version: 1,
    },
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
  return port;
}

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
  id = `rq_acceptance_${crypto.randomUUID().replaceAll("-", "")}`,
): Promise<Record<string, any>> {
  const response = new Promise<Record<string, any>>((resolve, reject) => {
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
  socket.send(JSON.stringify({
    id,
    op,
    payload,
    sentAt: Date.now(),
    type: "request",
    v: 1,
  }));
  return response;
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
      controllerInstanceId.includes("tight") ? "Tight Beam" : "OpenClaw",
    projectionCapacityBytes: 32 * 1024 * 1024,
    protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    protocolVersion: 1,
    ...(surfaceId ? { surfaceId } : {}),
  });
}

async function withServer<T>(
  core: SurfaceCore,
  operation: (
    context: { server: SurfaceWsServer; url: string },
  ) => Promise<T>,
): Promise<T> {
  const port = await freePort();
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace acceptance",
    hostName: "localhost",
    port,
    viewport: () => viewport,
  });
  await server.start();
  try {
    return await operation({
      server,
      url: `ws://127.0.0.1:${port}${server.wsPath}`,
    });
  } finally {
    await server.stop();
  }
}

function persistedPane(core: SurfaceCore, surfaceId: string) {
  const surface = core.getPersistentState().surfaces?.find(
    (candidate) => candidate.surfaceId === surfaceId,
  );
  assert(surface);
  assert.equal(surface.panes.length, 1);
  return surface.panes[0]!;
}

test("AC-MIG-02: renderer geometry does not preserve the non-positive bootstrap pane during lockless admission", () => {
  const core = coreWithLimits();
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  const bootstrapPaneId = core.activePaneIds(surface.surfaceId)[0]!;
  assert.equal(bootstrapPaneId, 0);

  const geometry = core.resolvedPaneGeometryIdentity(surface.surfaceId);
  core.updatePaneSnapshot(surface.surfaceId, bootstrapPaneId, {
    bounds: { height: 700, width: 1100, x: 20, y: 30 },
    geometryRevision: geometry.geometryRevision,
    surfaceEpoch: geometry.surfaceEpoch,
    topologyRevision: geometry.topologyRevision,
    viewport: {
      contentSize: { height: 700, width: 1100 },
      scrollOffset: { x: 0, y: 0 },
      visibleRect: { height: 700, width: 1100, x: 0, y: 0 },
      zoomLevel: 1,
    },
  });

  core.admitSurfaceToLockless(surface.surfaceId);

  const pane = persistedPane(core, surface.surfaceId);
  assert.equal(pane.paneId > 0, true);
  assert.deepEqual(pane.snapshot.bounds, {
    height: 700,
    width: 1100,
    x: 20,
    y: 30,
  });
});

test("AC-CAP-03 AC-SURF-06: SURF-12 is exact and rejects a one-byte-short recoverable envelope", () => {
  const exact = acceptanceLimits({
    maxAdmittedControllerEntries: 3,
    maxPaneAnnotationRestoreBytes: 601,
    maxPaneConsumableBytes: 311,
    maxPaneRecoverableStateBytes: 701,
    maxPanesPerSurface: 2,
    maxRetainedTombstones: 3,
    maxSurfaceConsumableBytes: 401,
    maxSurfaceRecoverableBaseBytes: 503,
    maxConsumableCursorStateBytesPerScope: 37,
  });
  const expected =
    exact.maxSurfaceRecoverableBaseBytes +
    exact.maxSurfaceConsumableBytes +
    exact.maxAdmittedControllerEntries *
      exact.maxConsumableCursorStateBytesPerScope +
    (exact.maxPanesPerSurface + exact.maxRetainedTombstones) *
      (
        exact.maxPaneRecoverableStateBytes +
        exact.maxPaneConsumableBytes +
        exact.maxAdmittedControllerEntries *
          exact.maxConsumableCursorStateBytesPerScope
      );
  assert.equal(exact.maxRecoverableSurfaceBytes, expected);
  assert.doesNotThrow(() => assertLocklessCapacityLimits(exact));
  assert.throws(
    () => assertLocklessCapacityLimits({
      ...exact,
      maxRecoverableSurfaceBytes: expected - 1,
    }),
    /invalid_lockless_limit:recoverable_surface_envelope/,
  );
});

test("AC-HIST-01..05: production SurfaceCore appends mixed-controller history, restores entry state, truncates Forward, and applies cross-controller LRU", () => {
  const core = coreWithLimits();
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  const authorityBefore = core.locklessAuthority.exportState();

  const a1 = core.locklessContentPush(
    surface.surfaceId,
    {
      content: { markdown: "A1" },
      contentId: "content-a1",
      contentType: "markdown",
      friendlyChatName: "Alpha",
      paneId,
    },
    "OpenClaw",
  );
  core.setAnnotating(surface.surfaceId, paneId, true);
  core.addStroke(surface.surfaceId, paneId, {
    points: [{ timestamp: 1, x: 10, y: 20 }],
    strokeId: "stroke-a1" as never,
    tool: "mouse",
  });
  core.setAnnotating(surface.surfaceId, paneId, false);
  const b1 = core.locklessContentPush(
    surface.surfaceId,
    {
      content: { markdown: "B1" },
      contentId: "content-b1",
      contentType: "markdown",
      friendlyChatName: "Beta",
      paneId,
    },
    "Tight Beam",
  );
  const a2 = core.locklessContentPush(
    surface.surfaceId,
    {
      content: { markdown: "A2" },
      contentId: "content-a2",
      contentType: "markdown",
      friendlyChatName: "Alpha",
      paneId,
    },
    "OpenClaw",
  );
  assert.deepEqual(
    [a1.revision, b1.revision, a2.revision],
    [1, 2, 3],
  );
  assert.equal(new Set([
    a1.historyEntryId,
    b1.historyEntryId,
    a2.historyEntryId,
  ]).size, 3);

  core.navigateHistory(surface.surfaceId, paneId, "back");
  let persisted = persistedPane(core, surface.surfaceId);
  assert.equal(
    persisted.history[persisted.historyIndex]?.contentId,
    "content-b1",
  );
  core.navigateHistory(surface.surfaceId, paneId, "back");
  persisted = persistedPane(core, surface.surfaceId);
  const restored = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(
    persisted.history[persisted.historyIndex]?.contentId,
    "content-a1",
  );
  assert.deepEqual(
    restored.drawings.map((stroke) => stroke.strokeId),
    ["stroke-a1"],
  );
  assert.equal(restored.provenance?.friendlyChatName, "Alpha");
  assert.deepEqual(core.locklessAuthority.exportState(), authorityBefore);

  const replacement = core.locklessContentPush(
    surface.surfaceId,
    {
      content: { markdown: "B2" },
      contentId: "content-b2",
      contentType: "markdown",
      friendlyChatName: "Beta",
      paneId,
    },
    "Tight Beam",
  );
  assert.equal(replacement.revision, 4);
  const afterTruncation = persistedPane(core, surface.surfaceId);
  assert.deepEqual(
    afterTruncation.history.map((entry) => entry.contentId),
    [null, "content-a1", "content-b2"],
  );

  for (let index = 0; index < 21; index += 1) {
    core.locklessContentPush(
      surface.surfaceId,
      {
        content: { markdown: `chatty-${index}` },
        contentId: `chatty-${index}`,
        contentType: "markdown",
        friendlyChatName: "Beta",
        paneId,
      },
      "Tight Beam",
    );
  }
  const bounded = persistedPane(core, surface.surfaceId);
  assert.equal(bounded.history.length, 21);
  assert.equal(
    bounded.history.some((entry) => entry.contentId === "content-a1"),
    false,
  );
  assert.equal(bounded.history.at(-1)?.contentId, "chatty-20");
});

test("AC-TOPO-01 AC-TOPO-02 AC-TOPO-05 AC-TOPO-06 AC-OPS-02: competing topology requests serialize with receipts and exact replay", async () => {
  const core = coreWithLimits(acceptanceLimits({ maxPanesPerSurface: 4 }));
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  await withServer(core, async ({ url }) => {
    const alpha = await connect(url);
    const beta = await connect(url);
    try {
      assert.equal((await pair(alpha, "openclaw-alpha", surface.surfaceId)).ok, true);
      assert.equal((await pair(beta, "tight-beta", surface.surfaceId)).ok, true);
      const listed = await request(alpha, "panes.list", {
        surfaceId: surface.surfaceId,
      });
      const paneId = listed.payload.panes[0].paneId;
      const initialRevision = listed.payload.topology.topologyRevision;
      const alphaId = "rq_topology_alpha";
      const betaId = "rq_topology_beta";
      const [alphaResult, betaResult] = await Promise.all([
        request(alpha, "pane.split", {
          count: 2,
          direction: "horizontal",
          expectedTopologyRevision: initialRevision,
          paneId,
          surfaceId: surface.surfaceId,
        }, alphaId),
        request(beta, "pane.split", {
          count: 2,
          direction: "vertical",
          expectedTopologyRevision: initialRevision,
          paneId,
          surfaceId: surface.surfaceId,
        }, betaId),
      ]);
      const winner = [alphaResult, betaResult].find((result) => result.ok);
      const loser = [alphaResult, betaResult].find((result) => !result.ok);
      assert(winner);
      assert(loser);
      assert.equal(loser.error.code, "stale_topology");
      assert.equal(
        loser.error.details.currentTopologyRevision,
        winner.payload.topologyRevision,
      );
      assert.deepEqual(
        winner.payload.operationReceipt,
        {
          commitSequence: winner.payload.operationReceipt.commitSequence,
          requestId: winner.id,
        },
      );
      assert.equal(Number.isSafeInteger(winner.payload.operationReceipt.commitSequence), true);
      assert.equal(core.activePaneIds(surface.surfaceId).length, 2);

      const winnerSocket = winner.id === alphaId ? alpha : beta;
      const winnerPayload = winner.id === alphaId
        ? {
            count: 2,
            direction: "horizontal",
            expectedTopologyRevision: initialRevision,
            paneId,
            surfaceId: surface.surfaceId,
          }
        : {
            count: 2,
            direction: "vertical",
            expectedTopologyRevision: initialRevision,
            paneId,
            surfaceId: surface.surfaceId,
          };
      const replay = await request(
        winnerSocket,
        "pane.split",
        winnerPayload,
        winner.id,
      );
      assert.deepEqual(replay, winner);
      const changedReuse = await request(
        winnerSocket,
        "pane.split",
        { ...winnerPayload, count: 3 },
        winner.id,
      );
      assert.equal(changedReuse.ok, false);
      assert.equal(changedReuse.error.code, "invalid_request_id_reuse");
      assert.equal(core.activePaneIds(surface.surfaceId).length, 2);
    } finally {
      alpha.close();
      beta.close();
    }
  });
});

test("AC-CAP-01 AC-CLOSE-01..08: P/T conservation permits exact restore over P and stale/invalid failures preserve tombstones atomically", async () => {
  const core = coreWithLimits(acceptanceLimits({
    maxPanesPerSurface: 2,
    maxRetainedTombstones: 3,
  }));
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  await withServer(core, async ({ url }) => {
    const socket = await connect(url);
    try {
      assert.equal((await pair(socket, "openclaw-capacity", surface.surfaceId)).ok, true);
      const initial = await request(socket, "panes.list", {
        surfaceId: surface.surfaceId,
      });
      const rootPaneId = initial.payload.panes[0].paneId;
      const split = await request(socket, "pane.split", {
        count: 2,
        direction: "horizontal",
        expectedTopologyRevision: initial.payload.topology.topologyRevision,
        paneId: rootPaneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(split.ok, true, JSON.stringify(split));
      const secondPaneId = split.payload.panes.find(
        (pane: { paneId: number }) => pane.paneId !== rootPaneId,
      ).paneId;
      const closed = await request(socket, "pane.close", {
        expectedTopologyRevision: split.payload.topologyRevision,
        paneId: secondPaneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(closed.ok, true, JSON.stringify(closed));
      assert.equal(core.locklessAuthority.listTombstones("pane").length, 1);

      const resplit = await request(socket, "pane.split", {
        count: 2,
        direction: "vertical",
        expectedTopologyRevision: closed.payload.topologyRevision,
        paneId: rootPaneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(resplit.ok, true, JSON.stringify(resplit));
      assert.equal(core.activePaneIds(surface.surfaceId).length, 2);

      const beforeStale = core.getPersistentState();
      const stale = await request(socket, "pane.restore", {
        anchorPaneId: rootPaneId,
        direction: "horizontal",
        expectedTopologyRevision: closed.payload.topologyRevision,
        surfaceId: surface.surfaceId,
        tombstoneId: closed.payload.tombstoneId,
      });
      assert.equal(stale.ok, false);
      assert.equal(stale.error.code, "stale_topology");
      const afterStale = core.getPersistentState();
      assert.deepEqual(afterStale.surfaces, beforeStale.surfaces);
      assert.deepEqual(
        afterStale.lockless?.tombstones,
        beforeStale.lockless?.tombstones,
      );
      assert.deepEqual(
        afterStale.lockless?.scopes,
        beforeStale.lockless?.scopes,
      );

      const beforeInvalid = core.getPersistentState();
      const invalid = await request(socket, "pane.restore", {
        anchorPaneId: 999_999,
        direction: "horizontal",
        expectedTopologyRevision: resplit.payload.topologyRevision,
        surfaceId: surface.surfaceId,
        tombstoneId: closed.payload.tombstoneId,
      });
      assert.equal(invalid.ok, false);
      const afterInvalid = core.getPersistentState();
      assert.deepEqual(afterInvalid.surfaces, beforeInvalid.surfaces);
      assert.deepEqual(
        afterInvalid.lockless?.tombstones,
        beforeInvalid.lockless?.tombstones,
      );
      assert.deepEqual(
        afterInvalid.lockless?.scopes,
        beforeInvalid.lockless?.scopes,
      );

      const restored = await request(socket, "pane.restore", {
        anchorPaneId: rootPaneId,
        direction: "horizontal",
        expectedTopologyRevision: resplit.payload.topologyRevision,
        surfaceId: surface.surfaceId,
        tombstoneId: closed.payload.tombstoneId,
      });
      assert.equal(restored.ok, true, JSON.stringify(restored));
      assert.equal(restored.payload.paneId, secondPaneId);
      assert.equal(core.activePaneIds(surface.surfaceId).length, 3);
      assert.equal(core.locklessAuthority.listTombstones("pane").length, 0);

      const refusedCreation = await request(socket, "pane.split", {
        count: 2,
        direction: "horizontal",
        expectedTopologyRevision: restored.payload.topologyRevision,
        paneId: rootPaneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(refusedCreation.ok, false);
      assert.equal(refusedCreation.error.code, "pane_capacity");
      assert.equal(core.activePaneIds(surface.surfaceId).length, 3);
    } finally {
      socket.close();
    }
  });
});

test("AC-CAP-02 AC-CLOSE-06 AC-CLOSE-07 AC-CLOSE-09: exact byte limits accept equality, reject +1 silently, and report oldest tombstone reclamation", () => {
  const paneValue = { content: "pane-at-limit".repeat(8) };
  const annotations = [{ stroke: "annotation-at-limit" }];
  const limits = acceptanceLimits({
    maxPaneAnnotationRestoreBytes: exactDurableBytes(annotations),
    maxPaneRecoverableStateBytes: exactDurableBytes(paneValue),
    maxRetainedTombstones: 2,
  });
  const target = new LocklessClientAuthority(
    createEmptyLocklessClientState(limits),
  );
  const events: AuthorityEvent[] = [];
  target.subscribe((event) => events.push(event));
  assert.doesNotThrow(() =>
    target.assertPaneRecoverableCapacity({}, paneValue, annotations)
  );
  const before = target.exportState();
  assert.throws(
    () =>
      target.assertPaneRecoverableCapacity(
        {},
        { content: `${paneValue.content}!` },
        annotations,
      ),
    (error) =>
      error instanceof LocklessAuthorityError &&
      error.code === "pane_state_capacity",
  );
  assert.deepEqual(target.exportState(), before);
  assert.deepEqual(events, []);

  const first = target.createTombstone({
    kind: "pane",
    payload: { pane: { paneId: 1 } },
    surfaceId: "surface-a",
  });
  const second = target.createTombstone({
    kind: "pane",
    payload: { pane: { paneId: 2 } },
    surfaceId: "surface-a",
  });
  target.createTombstone({
    kind: "pane",
    payload: { pane: { paneId: 3 } },
    surfaceId: "surface-a",
  });
  assert.deepEqual(
    target.listTombstones("pane").map((entry) => entry.tombstoneId),
    [second.tombstoneId, target.listTombstones("pane")[1]!.tombstoneId],
  );
  const reclaimed = events.find(
    (event) =>
      event.type === "event.tombstone_reclaimed" &&
      event.tombstoneId === first.tombstoneId,
  );
  assert(reclaimed && reclaimed.type === "event.tombstone_reclaimed");
  assert.equal(reclaimed.reason, "count_capacity");
  assert.equal(reclaimed.surfaceId, "surface-a");
  assert.equal(reclaimed.maxRetainedTombstones, 2);
  assert.equal(reclaimed.bytes, first.bytes);
});

test("CAP-3 websocket mutations reject exact surface and pane byte classes atomically", async () => {
  const surfaceProbe = coreWithLimits(acceptanceLimits());
  const probeSurface = surfaceProbe.ensurePrimarySurface("Surf Ace", viewport);
  surfaceProbe.admitSurfaceToLockless(probeSurface.surfaceId);
  const surfaceLimit = exactDurableBytes(
    surfaceProbe.captureSurfaceRecoverableBase(probeSurface.surfaceId),
  );
  const surfaceLimitedCore = coreWithLimits(acceptanceLimits({
    maxPanesPerSurface: 4,
    maxSurfaceRecoverableBaseBytes: surfaceLimit,
  }));
  const surface = surfaceLimitedCore.ensurePrimarySurface("Surf Ace", viewport);
  await withServer(surfaceLimitedCore, async ({ url }) => {
    const socket = await connect(url);
    try {
      assert.equal((await pair(socket, "tight-cap-surface", surface.surfaceId)).ok, true);
      const initial = await request(socket, "panes.list", {
        surfaceId: surface.surfaceId,
      });
      const before = surfaceLimitedCore.getPersistentState();
      const split = await request(socket, "pane.split", {
        count: 2,
        direction: "horizontal",
        expectedTopologyRevision: initial.payload.topology.topologyRevision,
        paneId: initial.payload.panes[0].paneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(split.ok, false);
      assert.equal(split.error.code, "surface_state_capacity");
      assert.deepEqual(
        surfaceLimitedCore.getPersistentState().surfaces,
        before.surfaces,
      );
      const topology = await request(socket, "topology.apply", {
        allowDestroyPaneIds: [],
        desired: {
          children: [
            { paneId: initial.payload.panes[0].paneId, type: "pane" },
            { type: "pane" },
          ],
          direction: "horizontal",
          type: "split",
        },
        expectedTopologyRevision: initial.payload.topology.topologyRevision,
        surfaceId: surface.surfaceId,
        target: { root: true },
      });
      assert.equal(topology.ok, false);
      assert.equal(topology.error.code, "surface_state_capacity");
      assert.deepEqual(
        surfaceLimitedCore.getPersistentState().surfaces,
        before.surfaces,
      );
      assert.equal(
        surfaceLimitedCore.locklessAuthority.listTombstones("pane").length,
        0,
      );
    } finally {
      socket.close();
    }
  });

  const paneProbe = coreWithLimits(acceptanceLimits());
  const probePaneSurface = paneProbe.ensurePrimarySurface("Surf Ace", viewport);
  paneProbe.admitSurfaceToLockless(probePaneSurface.surfaceId);
  const probePaneId = paneProbe.activePaneIds(probePaneSurface.surfaceId)[0]!;
  const paneLimit =
    exactDurableBytes(
      paneProbe.capturePaneTombstonePayload(
        probePaneSurface.surfaceId,
        probePaneId,
      ).pane,
    ) + 128;
  const paneLimitedCore = coreWithLimits(acceptanceLimits({
    maxPaneAnnotationRestoreBytes: paneLimit,
    maxPaneRecoverableStateBytes: paneLimit,
  }));
  const paneSurface = paneLimitedCore.ensurePrimarySurface("Surf Ace", viewport);
  await withServer(paneLimitedCore, async ({ url }) => {
    const socket = await connect(url);
    try {
      assert.equal((await pair(socket, "tight-cap-pane", paneSurface.surfaceId)).ok, true);
      const initial = await request(socket, "panes.list", {
        surfaceId: paneSurface.surfaceId,
      });
      const pane = initial.payload.panes[0];
      const before = paneLimitedCore.getPersistentState();
      const register = await request(socket, "target.register", {
        expectedPreviousTargetEpoch: null,
        idempotencyKey: "oversize-register",
        launchedAt: new Date().toISOString(),
        paneId: pane.paneId,
        registrationState: "before_attach",
        surfaceId: paneSurface.surfaceId,
        targetHeader: {},
        targetKind: "markdown",
        targetPayload: { markdown: "x".repeat(2_000) },
      });
      assert.equal(register.ok, false);
      assert.equal(register.error.code, "pane_state_capacity");
      assert.deepEqual(
        paneLimitedCore.getPersistentState().surfaces,
        before.surfaces,
      );
      const applyResult = nextEvent(socket, "event.target_apply_result");
      const apply = await request(socket, "target.apply", {
        paneId: pane.paneId,
        requestId: "oversize-apply",
        restoreReason: "initial",
        surfaceId: paneSurface.surfaceId,
        targetEpoch: 1,
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "navigate",
          requiredCapabilities: ["target.browser_url.v1"],
          safeToLogFields: ["url"],
          safetyClass: "network",
          summary: "oversize",
        },
        targetId: "oversize-apply",
        targetKind: "browser_url",
        targetPayload: {
          url: `https://example.com/${"x".repeat(2_000)}`,
        },
      });
      assert.equal(apply.ok, true, JSON.stringify(apply));
      assert.equal(apply.payload.status, "intent_committed");
      assert.equal(apply.payload.targetRequestId, "oversize-apply");
      const result = await applyResult;
      assert.equal(result.payload.status, "failed");
      assert.equal(result.payload.errorCode, "pane_state_capacity");
      assert.equal(
        result.payload.intentCommitSequence,
        apply.payload.operationReceipt.commitSequence,
      );
      assert.equal(
        result.payload.operationRequestId,
        apply.payload.operationRequestId,
      );
      assert.deepEqual(
        paneLimitedCore.getPersistentState().surfaces,
        before.surfaces,
      );
    } finally {
      socket.close();
    }
  });
});

test("global tombstone lifecycle seam serializes concurrent cross-surface pane closes", async () => {
  const core = coreWithLimits(acceptanceLimits({
    maxPanesPerSurface: 2,
    maxRetainedTombstones: 1,
  }));
  const firstSurface = core.ensurePrimarySurface("Surf Ace", viewport);
  const secondSurface = core.createAdditionalSurface("Surf Ace 2", viewport);
  await withServer(core, async ({ url }) => {
    const first = await connect(url);
    const second = await connect(url);
    try {
      assert.equal((await pair(first, "close-first", firstSurface.surfaceId)).ok, true);
      assert.equal((await pair(second, "close-second", secondSurface.surfaceId)).ok, true);
      const firstInitial = await request(first, "panes.list", {
        surfaceId: firstSurface.surfaceId,
      });
      const secondInitial = await request(second, "panes.list", {
        surfaceId: secondSurface.surfaceId,
      });
      const firstSplit = await request(first, "pane.split", {
        count: 2,
        direction: "horizontal",
        expectedTopologyRevision:
          firstInitial.payload.topology.topologyRevision,
        paneId: firstInitial.payload.panes[0].paneId,
        surfaceId: firstSurface.surfaceId,
      });
      const secondSplit = await request(second, "pane.split", {
        count: 2,
        direction: "horizontal",
        expectedTopologyRevision:
          secondInitial.payload.topology.topologyRevision,
        paneId: secondInitial.payload.panes[0].paneId,
        surfaceId: secondSurface.surfaceId,
      });
      const firstClosedPane = firstSplit.payload.panes.find(
        (pane: { paneId: number }) =>
          pane.paneId !== firstInitial.payload.panes[0].paneId,
      ).paneId;
      const secondClosedPane = secondSplit.payload.panes.find(
        (pane: { paneId: number }) =>
          pane.paneId !== secondInitial.payload.panes[0].paneId,
      ).paneId;
      const closed = await Promise.all([
        request(first, "pane.close", {
          expectedTopologyRevision: firstSplit.payload.topologyRevision,
          paneId: firstClosedPane,
          surfaceId: firstSurface.surfaceId,
        }),
        request(second, "pane.close", {
          expectedTopologyRevision: secondSplit.payload.topologyRevision,
          paneId: secondClosedPane,
          surfaceId: secondSurface.surfaceId,
        }),
      ]);
      assert.equal(closed.every((response) => response.ok), true);
      const ordered = closed
        .map((response, index) => ({
          anchorPaneId: index === 0
            ? firstInitial.payload.panes[0].paneId
            : secondInitial.payload.panes[0].paneId,
          response,
          socket: index === 0 ? first : second,
          surfaceId: index === 0
            ? firstSurface.surfaceId
            : secondSurface.surfaceId,
        }))
        .sort(
          (left, right) =>
            left.response.payload.closedSequence -
            right.response.payload.closedSequence,
        );
      assert.equal(
        ordered[1]!.response.payload.closedSequence,
        ordered[0]!.response.payload.closedSequence + 1,
      );
      const reclaimed = await request(
        ordered[0]!.socket,
        "pane.restore",
        {
          anchorPaneId: ordered[0]!.anchorPaneId,
          direction: "horizontal",
          expectedTopologyRevision:
            ordered[0]!.response.payload.topologyRevision,
          surfaceId: ordered[0]!.surfaceId,
          tombstoneId: ordered[0]!.response.payload.tombstoneId,
        },
      );
      assert.equal(reclaimed.ok, false);
      assert.equal(reclaimed.error.code, "tombstone_not_found");
      const retained = await request(
        ordered[1]!.socket,
        "pane.restore",
        {
          anchorPaneId: ordered[1]!.anchorPaneId,
          direction: "horizontal",
          expectedTopologyRevision:
            ordered[1]!.response.payload.topologyRevision,
          surfaceId: ordered[1]!.surfaceId,
          tombstoneId: ordered[1]!.response.payload.tombstoneId,
        },
      );
      assert.equal(retained.ok, true, JSON.stringify(retained));
    } finally {
      first.close();
      second.close();
    }
  });
});

test("AC-LIVEBUF-01 AC-LIVEBUF-02 AC-OPS-02: overflow targets only lagging cursors and emits ordered durable correlation", () => {
  const limits = acceptanceLimits({
    maxPaneConsumableBytes: 1_024,
    maxPaneConsumableRecords: 2,
    maxConsumableRecordBytes: 512,
  });
  let now = 1_000;
  const target = new LocklessClientAuthority(
    createEmptyLocklessClientState(limits),
    () => now++,
    "client-acceptance",
  );
  const events: AuthorityEvent[] = [];
  target.subscribe((event) => events.push(event));
  for (const id of ["controller-a", "controller-b"]) {
    target.admit({
      controllerInstanceId: id,
      projectionCapacityBytes: 8 * 1024 * 1024,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    }, `socket-${id}`, `admit-${id}`);
  }
  const scopeId = "pane:surface-a:1";
  const first = target.appendConsumable({
    payload: { value: 1 },
    recordClass: "tap",
    scopeId,
    scopeKind: "pane",
    triggerOperation: "tap",
  })!;
  target.acknowledge("controller-a", {
    cursor: first.sequence + 1,
    scopeId,
  });
  target.appendConsumable({
    payload: { value: 2 },
    recordClass: "tap",
    scopeId,
    scopeKind: "pane",
    triggerOperation: "tap",
  });
  target.appendConsumable({
    payload: { value: 3 },
    recordClass: "tap",
    scopeId,
    scopeKind: "pane",
    triggerOperation: "tap",
  });
  assert.equal(
    target.scopeSnapshot("controller-a", scopeId).cursor.gap,
    null,
  );
  const betaGap = target.scopeSnapshot("controller-b", scopeId).cursor.gap;
  assert(betaGap);
  assert.equal(betaGap.lossExtent, "exact");
  assert.equal(betaGap.droppedRecordCount, 1);
  const overflows = events.filter(
    (event) => event.type === "event.consumable_overflow",
  );
  assert.deepEqual(
    overflows.map((event) =>
      event.type === "event.consumable_overflow"
        ? event.controllerInstanceId
        : null
    ),
    ["controller-b"],
  );
  const audits = events
    .filter((event) => event.type === "diagnostic.lockless_audit")
    .map((event) =>
      event.type === "diagnostic.lockless_audit" ? event.record : null
    )
    .filter((record) => record !== null);
  assert.equal(
    audits.every((record, index) =>
      index === 0 ||
      record!.commitSequence > audits[index - 1]!.commitSequence
    ),
    true,
  );
  const overflowAudit = audits.find(
    (record) => record?.operation === "consumable_overflow:tap",
  );
  assert(overflowAudit);
  assert.match(overflowAudit.requestId, /^overflow_/);
  assert.equal(overflowAudit.controllerInstanceId, null);
  assert.equal(
    (
      overflowAudit.resultCorrelation?.affectedControllers as Array<{
        controllerInstanceId: string;
      }>
    )[0]?.controllerInstanceId,
    "controller-b",
  );
  assert.equal(
    overflows[0]?.type === "event.consumable_overflow"
      ? overflows[0].commitSequence
      : null,
    overflowAudit.commitSequence,
  );
  assert.deepEqual(
    overflowAudit.resultCorrelation?.resultingRetainedRange,
    {
      firstRetainedSequence: 2,
      lastRetainedSequence: 3,
    },
  );
  assert.equal(
    overflowAudit.resultCorrelation?.clientIdentity,
    "client-acceptance",
  );
});

test("AC-ARCH-01 AC-SYNC-01 AC-READ-02: a disconnected production wire refuses mutation while the other controller remains actionable", async () => {
  const core = coreWithLimits();
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  await withServer(core, async ({ url }) => {
    const disconnected = new PublicControllerWireClient(url);
    const survivor = new PublicControllerWireClient(url);
    await disconnected.connect();
    await survivor.connect();
    await disconnected.request("pair.request", {
      controllerInstanceId: "controller-disconnected",
      controllerProductName: "OpenClaw",
      projectionCapacityBytes: 32 * 1024 * 1024,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
      protocolVersion: 1,
      surfaceId: surface.surfaceId,
    });
    await survivor.request("pair.request", {
      controllerInstanceId: "controller-survivor",
      controllerProductName: "Tight Beam",
      projectionCapacityBytes: 32 * 1024 * 1024,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
      protocolVersion: 1,
      surfaceId: surface.surfaceId,
    });
    const paneId = core.activePaneIds(surface.surfaceId)[0]!;
    await disconnected.close();
    const before = core.getPersistentState();
    await assert.rejects(
      disconnected.request("content.set", {
        content: { markdown: "offline" },
        contentId: "offline",
        contentType: "markdown",
        paneId,
        surfaceId: surface.surfaceId,
      }),
      /controller_wire_not_connected/,
    );
    assert.deepEqual(core.getPersistentState(), before);

    const committed = await survivor.request("content.set", {
      content: { markdown: "survivor" },
      contentId: "survivor",
      contentType: "markdown",
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(committed.ok, true);
    assert.equal(
      (committed.payload as Record<string, any>).contentId,
      "survivor",
    );
    await survivor.close();
  });
});
