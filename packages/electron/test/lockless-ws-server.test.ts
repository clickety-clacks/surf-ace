import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import WebSocket, { WebSocketServer } from "ws";

import {
  LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
  LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES,
  SURF_ACE_LOCKLESS_V1_CAPABILITY,
  locklessPaneScopeId,
} from "../../protocol/src/lockless.js";
import { SurfaceCore } from "../src/surface-core.js";
import { compositorPaneIdForSurface } from "../src/native-pane-bridge.js";
import {
  DEFAULT_LOCKLESS_LIMITS,
  LocklessAuthorityError,
  createEmptyLocklessClientState,
} from "../src/lockless-client-authority.js";
import { PersistentStateOutcomeUnknownError } from "../src/persistent-state-file.js";
import {
  loadPersistentStateFile,
  writePersistentStateFile,
} from "../src/persistent-state-file.js";
import { SurfaceWsServer } from "../src/ws-server.js";
import { ConfiguredServerRegistration } from "../src/configured-server.js";

let nextPort = 25901;
let nextTestRegistryPaneLabel = 100_000;
const claimTestRegistryPaneLabel = async (): Promise<number> => nextTestRegistryPaneLabel++;

function initializeRegistryBootstrapPanes(core: SurfaceCore): void {
  const assignments = core.listSurfaces().map(({ surfaceId }, surfaceIndex) => {
    const paneLabel = nextTestRegistryPaneLabel++;
    core.resetProviderBootstrapTopology(surfaceId, {
      initialPaneId: 1,
      initialPaneLabel: paneLabel,
      windowLabel: String.fromCharCode(97 + surfaceIndex),
    });
    return {
      surfaceId,
      panes: core.panesList(surfaceId).panes.map((pane) => ({
        paneId: String(pane.paneId),
        paneLineageId: pane.paneLineageId,
        paneLabel,
      })),
    };
  });
  if (assignments.length > 0) {
    core.applyRegistryPaneLabels(assignments);
    core.confirmRegistryPaneLabels(assignments);
  }
}

function authorityVectorUrl(): URL {
  const candidates = [
    new URL("../../protocol/vectors/authority-conformance.json", import.meta.url),
    new URL("../../../protocol/vectors/authority-conformance.json", import.meta.url),
  ];
  const found = candidates.find((candidate) => existsSync(fileURLToPath(candidate)));
  assert.ok(found, "authority conformance vectors not found from source or compiled test layout");
  return found;
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

type TargetAdmissionVectorCase = {
  id: string;
  input: {
    annotationPolicy: "allow" | "deny";
    controllerScenario: "single" | "two_same_request_id";
    paneLineage: "current" | "stale";
    replaySemantics: "navigate" | "replace";
    requiredCapability: "supported" | "missing";
    surfaceState: "live" | "tombstoned";
    targetPayload: "safe_https" | "unsafe_file";
  };
  expected: {
    materializerCalls: number;
    notCommitted: boolean;
    receiptDelta: number;
    receiptSyncOutcome: "not_committed" | "resolved_success";
    resultDelta: number;
    targetErrorCode: string | null;
    topLevelCode: string | null;
    workDelta: number;
  };
};

function targetAdmissionVectorCases(): TargetAdmissionVectorCase[] {
  const vectors = JSON.parse(
    readFileSync(
      authorityVectorUrl(),
      "utf8",
    ),
  ) as { vectors: Array<{ cases?: TargetAdmissionVectorCase[]; id: string }> };
  const vector = vectors.vectors.find(
    (candidate) => candidate.id === "lockless-target-precommit-rejection-classification",
  );
  assert.ok(vector?.cases);
  return vector.cases;
}

function targetAuthorityCounts(core: SurfaceCore): {
  receipts: number;
  results: number;
  work: number;
} {
  const state = core.locklessAuthority.exportState();
  return {
    receipts: Object.values(state.controllers).reduce(
      (total, controller) =>
        total + Object.keys(controller.pendingOperationReceipts).length,
      0,
    ),
    results: Object.values(state.scopes).reduce(
      (total, scope) =>
        total + scope.records.filter(
          (record) => record.recordClass === "target_result",
        ).length,
      0,
    ),
    work: Object.keys(state.targetApplyWorkItems).length,
  };
}

async function waitForTargetCounts(
  core: SurfaceCore,
  expected: { results: number; work: number },
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const counts = targetAuthorityCounts(core);
    if (counts.results === expected.results && counts.work === expected.work) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.deepEqual(
    {
      results: targetAuthorityCounts(core).results,
      work: targetAuthorityCounts(core).work,
    },
    expected,
  );
}

test("pane focus changes reach the compositor through its runtime focus target API", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const paneId = 7;
  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: paneId,
    initialPaneLabel: paneId,
    windowLabel: "a",
  });
  core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "vertical",
    newPaneIds: [9],
    newPaneLabels: [9],
    paneId,
  });
  const geometryIdentity = core.resolvedPaneGeometryIdentity(surface.surfaceId);
  core.updatePaneSnapshot(surface.surfaceId, paneId, {
    bounds: { height: 800, width: 600, x: 0, y: 0 },
    ...geometryIdentity,
  });
  core.updatePaneSnapshot(surface.surfaceId, 9, {
    bounds: { height: 800, width: 600, x: 600, y: 0 },
    ...geometryIdentity,
  });
  const nativePane = core.pairState(surface.surfaceId).panes.find((pane) => Number(pane.paneId) === paneId)!;
  const materialization = core.projectNativePaneMaterialization(surface.surfaceId, {
    paneLineageId: nativePane.paneLineageId,
    requestId: "native-focus-fixture",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "launch_equivalent",
      requiredCapabilities: ["target.native_app.v1"],
      safeToLogFields: ["appId"],
      safetyClass: "process",
      summary: "native focus fixture",
    },
    targetId: "target_native_focus_fixture",
    targetKind: "native_app",
    targetPayload: { appId: "native-focus-fixture", args: [], launchMode: "new_instance" },
  });
  core.markNativePaneMaterialized(surface.surfaceId, materialization);

  const socketDir = await mkdtemp(path.join(tmpdir(), "surf-ace-native-pane-focus-"));
  const compositorSocketPath = path.join(socketDir, "control.sock");
  let resolveWebFocusRequest!: (request: Record<string, unknown>) => void;
  const webFocusRequest = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("compositor did not receive pane focus")), 2_000);
    resolveWebFocusRequest = (request) => {
      clearTimeout(timeout);
      resolve(request);
    };
  });
  let resolveNativeFocusRequest!: (request: Record<string, unknown>) => void;
  const nativeFocusRequest = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("compositor did not receive native pane focus")), 2_000);
    resolveNativeFocusRequest = (request) => {
      clearTimeout(timeout);
      resolve(request);
    };
  });
  const nativeCompositorStatus = {
    runtime: {
      active_focus_target: { native_pane: { pane_id: compositorPaneIdForSurface(surface.surfaceId, 7) } },
      last_diagnostic: null,
    },
    native_pane_window_groups: [],
  };
  const compositorRequestTypes: string[] = [];
  let focusRequestCount = 0;
  const focusGenerationForCurrentPane = (): Record<string, unknown> => {
    const focus = core.projectNativePaneFocus(surface.surfaceId);
    return {
      focus_revision: focus.focusRevision ?? 0,
      focused_pane_id: focus.focusedPaneId === null
        ? null
        : compositorPaneIdForSurface(surface.surfaceId, Number(focus.focusedPaneId)),
      focused_pane_instance_id: focus.focusedPaneId === null ? null : focus.focusedPaneInstanceId,
      geometry_revision: Number(focus.geometryRevision),
      surface_epoch: focus.surfaceEpoch,
      surface_id: surface.surfaceId,
      topology_epoch: Number(focus.topologyEpoch),
    };
  };
  const compositor = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      compositorRequestTypes.push(String(request.type));
      if (request.type === "set_runtime_focus_target") {
        if (focusRequestCount === 0) {
          resolveWebFocusRequest(request);
        } else if (focusRequestCount === 1) {
          resolveNativeFocusRequest(request);
        }
        focusRequestCount += 1;
      }
      socket.end(`${JSON.stringify({
        ok: true,
        status: request.type === "get_status" ? nativeCompositorStatus : {},
      })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.once("error", reject);
    compositor.listen(compositorSocketPath, resolve);
  });

  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port: nextPort++,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  let client: WebSocket | null = null;
  try {
    await server.start();
    core.setActiveKeyboardPane(surface.surfaceId, 9);
    const webFocusRequestPayload = await webFocusRequest;

    assert.deepEqual(webFocusRequestPayload, {
      focus_generation: focusGenerationForCurrentPane(),
      target: "main_app",
      type: "set_runtime_focus_target",
    });

    core.setActiveKeyboardPane(surface.surfaceId, 7);
    const nativeFocusRequestPayload = await nativeFocusRequest;
    assert.deepEqual(nativeFocusRequestPayload, {
      focus_generation: focusGenerationForCurrentPane(),
      target: { native_pane: { pane_id: compositorPaneIdForSurface(surface.surfaceId, 7) } },
      type: "set_runtime_focus_target",
    });

    client = await connect(`ws://127.0.0.1:${server.port}/ws`);
    const paired = await pair(client, "native-focus-status-client", surface.surfaceId);
    assert.equal(paired.ok, true);
    const paneList = await request(client, "panes.list", { surfaceId: surface.surfaceId });
    assert.deepEqual(paneList.payload.nativeCompositorStatus, {
      activeFocusTarget: { native_pane: { pane_id: compositorPaneIdForSurface(surface.surfaceId, 7) } },
      lastDiagnostic: null,
    }, `compositor requests: ${JSON.stringify(compositorRequestTypes)}; panes.list response: ${JSON.stringify(paneList)}`);
  } finally {
    client?.close();
    await server.stop();
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(socketDir, { force: true, recursive: true });
  }
});

test("next panes.list converges after the compositor rejects a stale pane focus intent", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const nativePaneId = 7;
  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: nativePaneId,
    initialPaneLabel: nativePaneId,
    windowLabel: "a",
  });
  core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "vertical",
    newPaneIds: [9],
    newPaneLabels: [9],
    paneId: nativePaneId,
  });
  const geometryIdentity = core.resolvedPaneGeometryIdentity(surface.surfaceId);
  core.updatePaneSnapshot(surface.surfaceId, nativePaneId, {
    bounds: { height: 800, width: 600, x: 0, y: 0 },
    ...geometryIdentity,
  });
  core.updatePaneSnapshot(surface.surfaceId, 9, {
    bounds: { height: 800, width: 600, x: 600, y: 0 },
    ...geometryIdentity,
  });
  const nativePane = core.panesList(surface.surfaceId).panes.find(
    (pane) => Number(pane.paneId) === nativePaneId,
  )!;
  const materialization = core.projectNativePaneMaterialization(surface.surfaceId, {
    paneLineageId: nativePane.paneLineageId,
    requestId: "native-focus-stale-intent-fixture",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "launch_equivalent",
      requiredCapabilities: ["target.native_app.v1"],
      safeToLogFields: ["appId"],
      safetyClass: "process",
      summary: "native stale focus fixture",
    },
    targetId: "target_native_stale_focus_fixture",
    targetKind: "native_app",
    targetPayload: { appId: "native-stale-focus-fixture", args: [], launchMode: "new_instance" },
  });
  core.markNativePaneMaterialized(surface.surfaceId, materialization);

  const socketDir = await mkdtemp(path.join(tmpdir(), "surf-ace-native-pane-stale-focus-"));
  const compositorSocketPath = path.join(socketDir, "control.sock");
  const compositorRequestTypes: string[] = [];
  let resolveStaleIntent!: (request: Record<string, unknown>) => void;
  const staleIntentReceived = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("compositor did not receive stale pane intent")), 2_000);
    resolveStaleIntent = (request) => {
      clearTimeout(timeout);
      resolve(request);
    };
  });
  let resolveStaleIntentReply!: () => void;
  const staleIntentReplySent = new Promise<void>((resolve) => {
    resolveStaleIntentReply = resolve;
  });
  let compositorStatus: Record<string, unknown> = {
    native_pane_window_groups: [],
    runtime: {
      active_focus_generation: null,
      active_focus_target: null,
      last_diagnostic: null,
    },
  };
  const compositor = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      const requestType = String(request.type);
      compositorRequestTypes.push(requestType);
      if (requestType === "set_runtime_focus_target") {
        const staleGeneration = request.focus_generation as Record<string, unknown>;
        const clickGeneration = {
          ...staleGeneration,
          focus_revision: Number(staleGeneration.focus_revision) + 1,
          focused_pane_id: compositorPaneIdForSurface(surface.surfaceId, nativePaneId),
          focused_pane_instance_id: nativePane.paneLineageId,
        };
        compositorStatus = {
          native_pane_window_groups: [],
          runtime: {
            active_focus_generation: clickGeneration,
            active_focus_target: {
              native_pane: { pane_id: compositorPaneIdForSurface(surface.surfaceId, nativePaneId) },
            },
            last_diagnostic: null,
          },
        };
        resolveStaleIntent(request);
        socket.end(JSON.stringify({
          error: "stale native pane focus generation",
          ok: false,
        }) + "\n", resolveStaleIntentReply);
        return;
      }
      socket.end(JSON.stringify({
        ok: true,
        status: requestType === "get_status" ? compositorStatus : {},
      }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.once("error", reject);
    compositor.listen(compositorSocketPath, resolve);
  });

  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port: nextPort++,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  let client: WebSocket | null = null;
  try {
    await server.start();
    client = await connect("ws://127.0.0.1:" + server.port + "/ws");
    const paired = await pair(client, "native-stale-focus-return-client", surface.surfaceId);
    assert.equal(paired.ok, true);

    core.setActiveKeyboardPane(surface.surfaceId, 9);
    const staleRequest = await staleIntentReceived;
    assert.equal(staleRequest.type, "set_runtime_focus_target");
    assert.equal(staleRequest.target, "main_app");
    assert.equal(core.activeKeyboardPaneId(surface.surfaceId), 9);
    await staleIntentReplySent;

    const paneList = await request(client, "panes.list", { surfaceId: surface.surfaceId });
    assert.equal(paneList.ok, true, JSON.stringify(paneList));
    assert.equal(
      core.activeKeyboardPaneId(surface.surfaceId),
      nativePaneId,
      "the next existing status read should adopt the compositor's newer physical-click focus",
    );
    assert.equal(
      core.getRendererWindowState(surface.surfaceId).panes.find((pane) => pane.paneId === nativePaneId)?.activeKeyboardPane,
      true,
    );
    assert.equal(
      paneList.payload.nativeCompositorStatus.activeFocusGeneration.focusedPaneId,
      compositorPaneIdForSurface(surface.surfaceId, nativePaneId),
    );
    assert.ok(compositorRequestTypes.includes("get_status"));
    assert.equal(
      compositorRequestTypes.filter((type) => type === "set_runtime_focus_target").length,
      1,
      "adopting the compositor click must not push stale client focus back",
    );
  } finally {
    client?.close();
    await server.stop();
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(socketDir, { force: true, recursive: true });
  }
});

test("compositor status polling adopts click focus, stops after read failure, recovers on demand, and stops when groups close", async (t) => {
  const core = new SurfaceCore();
  const viewport = { height: 800, scale: 2, width: 1200 };
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  const nativePaneId = 7;
  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: nativePaneId,
    initialPaneLabel: nativePaneId,
    windowLabel: "a",
  });
  core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "vertical",
    newPaneIds: [9],
    newPaneLabels: [9],
    paneId: nativePaneId,
  });
  const geometryIdentity = core.resolvedPaneGeometryIdentity(surface.surfaceId);
  core.updatePaneSnapshot(surface.surfaceId, nativePaneId, {
    bounds: { height: 800, width: 600, x: 0, y: 0 },
    ...geometryIdentity,
  });
  core.updatePaneSnapshot(surface.surfaceId, 9, {
    bounds: { height: 800, width: 600, x: 600, y: 0 },
    ...geometryIdentity,
  });
  const nativePane = core.panesList(surface.surfaceId).panes.find(
    (pane) => Number(pane.paneId) === nativePaneId,
  )!;
  const materialization = core.projectNativePaneMaterialization(surface.surfaceId, {
    paneLineageId: nativePane.paneLineageId,
    requestId: "native-focus-polling-fixture",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "launch_equivalent",
      requiredCapabilities: ["target.native_app.v1"],
      safeToLogFields: ["appId"],
      safetyClass: "process",
      summary: "native focus polling fixture",
    },
    targetId: "target_native_focus_polling_fixture",
    targetKind: "native_app",
    targetPayload: { appId: "native-focus-polling-fixture", args: [], launchMode: "new_instance" },
  });
  core.markNativePaneMaterialized(surface.surfaceId, materialization);
  core.setActiveKeyboardPane(surface.surfaceId, 9);

  const compositorPaneId = compositorPaneIdForSurface(surface.surfaceId, nativePaneId);
  const launchToken = materialization.panes[0]!.windowGroup!.launchIdentity.launchToken;
  let groupOpen = true;
  let nativePaneFocused = false;
  let clickFocusGeneration: Record<string, unknown> | null = null;
  let getStatusRequests = 0;
  const makeCompositorStatus = (): Record<string, unknown> => ({
    native_pane_window_groups: groupOpen
      ? [{
        accepted_secondary_count: 0,
        clipping_status: "unclipped",
        denied_reasons: [],
        denied_toplevel_count: 0,
        focused_pane_id: nativePaneFocused ? compositorPaneId : null,
        focused_window_id: nativePaneFocused ? "native-primary" : null,
        interaction_state: "idle",
        launch_token: launchToken,
        lifecycle_diagnostic: null,
        members: [{
          accepts_input: nativePaneFocused,
          bounds: { height: 800, width: 600, x: 0, y: 0 },
          clipped_to_pane: false,
          destroyed_while_hidden: false,
          focused: nativePaneFocused,
          hidden_reason: null,
          id: "native-primary",
          lifecycle: "live",
          restoration_state: "not_applicable",
          role: "primary",
          visibility: "visible",
          z_order: 0,
        }],
        pane_focused: nativePaneFocused,
        pane_id: compositorPaneId,
        pane_instance_id: nativePane.paneLineageId,
        pane_local_bounds: { height: 800, width: 600, x: 0, y: 0 },
        primary_visible: true,
        primary_window_id: "native-primary",
        surface_focus: nativePaneFocused ? "native_primary" : "surf_ace",
      }]
      : [],
    runtime: {
      active_focus_generation: clickFocusGeneration,
      active_focus_target: nativePaneFocused
        ? { native_pane: { pane_id: compositorPaneId } }
        : "main_app",
      last_diagnostic: null,
    },
  });

  const socketDir = await mkdtemp(path.join(tmpdir(), "surf-ace-native-focus-polling-"));
  const compositorSocketPath = path.join(socketDir, "control.sock");
  // The local socket fixture models a physical compositor click by changing the returned live status.
  const createCompositorServer = () => createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const compositorRequest = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      if (compositorRequest.type === "get_status") {
        getStatusRequests += 1;
      }
      socket.end(JSON.stringify({ ok: true, status: makeCompositorStatus() }) + "\n");
    });
  });
  let compositor = createCompositorServer();
  await new Promise<void>((resolve, reject) => {
    compositor.once("error", reject);
    compositor.listen(compositorSocketPath, resolve);
  });

  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port: nextPort++,
    viewport: () => viewport,
  });
  let client: WebSocket | null = null;
  let unsubscribeFocus: (() => void) | null = null;
  let unsubscribeGroups: (() => void) | null = null;
  try {
    await server.start();
    assert.equal(getStatusRequests, 0, "status polling stays idle until a compositor group is observed");
    client = await connect("ws://127.0.0.1:" + server.port + "/ws");
    assert.equal((await pair(client, "native-focus-polling-client", surface.surfaceId)).ok, true);
    const paneList = await request(client, "panes.list", { surfaceId: surface.surfaceId });
    assert.equal(paneList.ok, true, JSON.stringify(paneList));
    assert.ok(core.panesList(surface.surfaceId).panes.find(
      (pane) => Number(pane.paneId) === nativePaneId,
    )?.nativeWindowGroup);

    let clickStartedAt = 0;
    const indicatorUpdate = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribeFocus?.();
        reject(new Error("focus indicator did not adopt the compositor click"));
      }, 2_000);
      unsubscribeFocus = core.subscribe((event) => {
        if (
          event.type === "surface-changed" &&
          event.surfaceId === surface.surfaceId &&
          core.activeKeyboardPaneId(surface.surfaceId) === nativePaneId
        ) {
          clearTimeout(timeout);
          unsubscribeFocus?.();
          unsubscribeFocus = null;
          resolve(Date.now() - clickStartedAt);
        }
      });
    });
    const projectedFocus = core.projectNativePaneFocus(surface.surfaceId);
    clickFocusGeneration = {
      focus_revision: Number(projectedFocus.focusRevision ?? 0) + 1,
      focused_pane_id: compositorPaneId,
      focused_pane_instance_id: nativePane.paneLineageId,
      geometry_revision: Number(projectedFocus.geometryRevision),
      surface_epoch: projectedFocus.surfaceEpoch,
      surface_id: surface.surfaceId,
      topology_epoch: Number(projectedFocus.topologyEpoch),
    };
    clickStartedAt = Date.now();
    nativePaneFocused = true;

    const indicatorDelayMs = await indicatorUpdate;
    t.diagnostic("click-to-indicator delay: " + indicatorDelayMs + " ms");
    assert.ok(
      indicatorDelayMs <= 250,
      "compositor click reached the renderer's existing surface-state source in " + indicatorDelayMs + " ms",
    );
    assert.equal(
      core.getRendererWindowState(surface.surfaceId).panes.find((pane) => pane.paneId === nativePaneId)?.activeKeyboardPane,
      true,
    );
    assert.ok(getStatusRequests >= 2, "the compositor click was discovered by a status poll without a client request");

    const diagnosticWarnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      diagnosticWarnings.push(args.map(String).join(" "));
    };
    try {
      await new Promise<void>((resolve) => compositor.close(() => resolve()));
      await rm(compositorSocketPath, { force: true });
      await new Promise<void>((resolve) => setTimeout(resolve, 160));
      assert.equal(
        diagnosticWarnings.filter((line) => line.includes("event=native_window_group_refresh_failed")).length,
        1,
        "one warning records the transition to an unavailable compositor",
      );

      const requestsBeforeRecovery = getStatusRequests;
      compositor = createCompositorServer();
      await new Promise<void>((resolve, reject) => {
        compositor.once("error", reject);
        compositor.listen(compositorSocketPath, resolve);
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      assert.equal(
        getStatusRequests,
        requestsBeforeRecovery,
        "periodic polling stays stopped after a failed read until a later signal succeeds",
      );

      const recoveredList = await request(client, "panes.list", { surfaceId: surface.surfaceId });
      assert.equal(recoveredList.ok, true, JSON.stringify(recoveredList));
      const requestsAfterRecovery = getStatusRequests;
      const pollDeadline = Date.now() + 1_000;
      while (getStatusRequests === requestsAfterRecovery && Date.now() < pollDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(
        getStatusRequests > requestsAfterRecovery,
        "a successful on-demand read resumes periodic polling for the open group",
      );
      assert.equal(
        diagnosticWarnings.filter((line) => line.includes("event=native_window_group_refresh_failed")).length,
        1,
        "the failed-read warning is not repeated for each poll interval",
      );
    } finally {
      console.warn = originalWarn;
    }

    const groupsCleared = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribeGroups?.();
        reject(new Error("native group polling did not stop after the group disappeared"));
      }, 2_000);
      unsubscribeGroups = core.subscribe((event) => {
        if (
          event.type === "surface-changed" &&
          event.surfaceId === surface.surfaceId &&
          core.panesList(surface.surfaceId).panes.find(
            (pane) => Number(pane.paneId) === nativePaneId,
          )?.nativeWindowGroup === undefined
        ) {
          clearTimeout(timeout);
          unsubscribeGroups?.();
          unsubscribeGroups = null;
          resolve();
        }
      });
    });
    groupOpen = false;
    await groupsCleared;
    const requestsAfterClose = getStatusRequests;
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    assert.equal(getStatusRequests, requestsAfterClose, "polling stops when the compositor reports no open native groups");
  } finally {
    unsubscribeFocus?.();
    unsubscribeGroups?.();
    client?.close();
    await server.stop();
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(socketDir, { force: true, recursive: true });
  }
});

test("native readiness maps T316 lifecycle and focus status using compositor-qualified pane IDs", async () => {
  const core = new SurfaceCore();
  const viewport = { height: 800, scale: 2, width: 1200 };
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  const otherSurface = core.createAdditionalSurface("Other Surf Ace", viewport);
  const paneId = 7;
  for (const [index, currentSurface] of [surface, otherSurface].entries()) {
    core.applyProviderBootstrapTopology(currentSurface.surfaceId, {
      initialPaneId: paneId,
      initialPaneLabel: paneId,
      windowLabel: index === 0 ? "a" : "b",
    });
  }
  core.updatePaneSnapshot(surface.surfaceId, paneId, {
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    ...core.resolvedPaneGeometryIdentity(surface.surfaceId),
  });

  const currentPaneId = compositorPaneIdForSurface(surface.surfaceId, paneId);
  const otherPaneId = compositorPaneIdForSurface(otherSurface.surfaceId, paneId);
  // Source-derived status fragments from frozen T316 ccc0002. This fixture does not capture
  // live compositor output.
  const cases = [
    {
      name: "attached and focused",
      lifecycle: { state: "attached", pid: 101 },
      focus: "current",
      expectedLifecycle: "running",
      expectedInputFocus: "ready",
    },
    {
      name: "launching with main app focus",
      lifecycle: { state: "launching", pid: 102 },
      focus: "main_app",
      expectedLifecycle: "launch_requested",
      expectedInputFocus: "not_ready",
    },
    {
      name: "failed with another pane focused",
      lifecycle: { state: "failed", reason: "fixture launch failed" },
      focus: "other",
      expectedLifecycle: "failed",
      expectedInputFocus: "not_ready",
    },
    {
      name: "exited with overlay focus",
      lifecycle: { state: "exited", pid: 104, exit_code: 1 },
      focus: "overlay_native",
      expectedLifecycle: "exited",
      expectedInputFocus: "not_ready",
    },
    {
      name: "absent with no active focus target",
      lifecycle: { state: "absent" },
      focus: "none",
      expectedLifecycle: "unknown",
      expectedInputFocus: "not_ready",
    },
    {
      name: "attached with no runtime object",
      lifecycle: { state: "attached", pid: 106 },
      focus: "missing_runtime",
      expectedLifecycle: "running",
      expectedInputFocus: "unknown",
    },
    {
      name: "attached with unknown focus variant",
      lifecycle: { state: "attached", pid: 107 },
      focus: "unknown_variant",
      expectedLifecycle: "running",
      expectedInputFocus: "unknown",
    },
  ] as const;
  let currentCase: typeof cases[number] = cases[0];
  let status: Record<string, any> = {
    logical_surface_height: 800,
    logical_surface_width: 1200,
    native_pane_window_groups: [],
    pane_geometry_coordinate_space: "compositor_logical",
    panes: [],
  };
  const socketDir = await mkdtemp(path.join(tmpdir(), "surf-ace-native-pane-readiness-"));
  const compositorSocketPath = path.join(socketDir, "control.sock");
  const compositor = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const compositorRequest = JSON.parse(buffer.slice(0, newline)) as Record<string, any>;
      if (compositorRequest.type === "native_pane.host") {
        const pane = compositorRequest.panes[0] as Record<string, any>;
        const bindingId = String(pane.binding_id);
        const contentId = String(pane.content_id);
        const nativeApp = pane.nativeApp as Record<string, any>;
        const otherLifecycle = { state: "attached", pid: 202 };
        const otherFocus = currentCase.focus === "other";
        const currentFocus = currentCase.focus === "current";
        const focusTarget = currentCase.focus === "current"
          ? { native_pane: { pane_id: currentPaneId } }
          : currentCase.focus === "other"
          ? { native_pane: { pane_id: otherPaneId } }
          : currentCase.focus === "main_app"
          ? "main_app"
          : currentCase.focus === "overlay_native"
          ? "overlay_native"
          : currentCase.focus === "unknown_variant"
          ? "future_target"
          : undefined;
        const runtime = currentCase.focus === "missing_runtime"
          ? undefined
          : focusTarget === undefined
          ? {}
          : { active_focus_target: focusTarget };
        const process = {
          args: Array.isArray(nativeApp.args) ? nativeApp.args : [],
          command: typeof nativeApp.appId === "string" ? nativeApp.appId : "native-readiness-fixture",
        };
        const otherProcess = { args: ["wrong"], command: "other-surface-app" };
        const currentGroup = {
          acceptedSecondaryCount: 0,
          clippingStatus: "clipped",
          deniedReasons: [],
          deniedToplevelCount: 0,
          focusedWindowId: currentFocus ? bindingId : undefined,
          launchToken: String(pane.launchToken),
          members: [{
            focused: currentFocus,
            id: bindingId,
            lifecycle: "live",
            role: "primary",
          }],
          paneId: currentPaneId,
          primaryWindowId: bindingId,
        };
        const otherGroup = {
          acceptedSecondaryCount: 0,
          clippingStatus: "clipped",
          deniedReasons: [],
          deniedToplevelCount: 0,
          focusedWindowId: otherFocus ? "other-surface-primary" : undefined,
          launchToken: "other-surface-launch",
          members: [{
            focused: otherFocus,
            id: "other-surface-primary",
            lifecycle: "live",
            role: "primary",
          }],
          paneId: otherPaneId,
          primaryWindowId: "other-surface-primary",
        };
        const currentPaneStatus = {
          external_native_state: currentCase.lifecycle,
          id: currentPaneId,
          nativeHost: {
            bindingId,
            contentId,
            lifecycle: currentCase.lifecycle,
            paneId: currentPaneId,
            process,
            revision: 1,
          },
        };
        const otherPaneStatus = {
          external_native_state: otherLifecycle,
          id: otherPaneId,
          nativeHost: {
            bindingId: "other-surface-binding",
            contentId: "other-surface-content",
            lifecycle: otherLifecycle,
            paneId: otherPaneId,
            process: otherProcess,
            revision: 1,
          },
        };
        status = {
          native_pane_window_groups: currentCase.lifecycle.state === "attached"
            ? [otherGroup, currentGroup]
            : [otherGroup],
          panes: [otherPaneStatus, currentPaneStatus],
          ...(runtime === undefined ? {} : { runtime }),
        };
      }
      socket.end(`${JSON.stringify({ ok: true, status })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.once("error", reject);
    compositor.listen(compositorSocketPath, resolve);
  });

  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath,
    core,
    endpointName: "Surf Ace",
    getRuntimeAppBinding: () => ({
      acknowledgement: "accepted",
      bindingAuthority: "trusted",
      bindingDegradedReasons: [],
      diagnosticDrift: [],
      expectedBundleId: null,
      expectedPackageName: null,
      expectedRuntimeId: "native-readiness-fixture",
      launchTokenStatus: "matched",
      observedUiLabel: null,
      observedWaylandAppId: null,
      observedWindowTitle: null,
      processLineageStatus: "matched",
      ready: true,
      reportedBundleId: null,
      reportedPackageName: null,
      reportedRuntimeId: "native-readiness-fixture",
    }),
    hostName: "localhost",
    nativeOverlayLivenessRetryCount: 0,
    port,
    viewport: () => viewport,
  });
  let client: WebSocket | null = null;
  try {
    await server.start();
    client = await connect(`ws://127.0.0.1:${server.port}/ws`);
    assert.equal((await pair(client, "native-readiness-status-client", surface.surfaceId)).ok, true);
    const pane = core.pairState(surface.surfaceId).panes.find((candidate) => Number(candidate.paneId) === paneId)!;
    assert.notEqual(currentPaneId, otherPaneId);
    assert.ok(currentPaneId.endsWith(":1:7"));
    assert.ok(otherPaneId.endsWith(":1:7"));
    for (const [index, readinessCase] of cases.entries()) {
      currentCase = readinessCase;
      const appId = `native-readiness-${readinessCase.name.replaceAll(" ", "-")}`;
      const resultEvent = nextEvent(client, "event.target_apply_result");
      const accepted = await request(client, "target.apply", {
        paneId,
        paneLineageId: pane.paneLineageId,
        requestId: `native-readiness-${index}`,
        restoreReason: "initial",
        surfaceId: surface.surfaceId,
        targetEpoch: index + 1,
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.native_app.v1"],
          safeToLogFields: ["appId"],
          safetyClass: "process",
          summary: `T316 lifecycle and focus case: ${readinessCase.name}`,
        },
        targetId: `target_native_readiness_fixture_${index}`,
        targetKind: "native_app",
        targetPayload: { appId, args: [], launchMode: "new_instance" },
      });
      assert.equal(accepted.payload.status, "intent_committed", JSON.stringify(accepted));
      const result = await resultEvent;
      assert.equal(result.payload.status, "applied", JSON.stringify(result));
      assert.equal(result.payload.materializedState.lifecycle, readinessCase.expectedLifecycle, readinessCase.name);
      assert.equal(result.payload.materializedState.inputFocus, readinessCase.expectedInputFocus, readinessCase.name);
      if (readinessCase.focus === "current") {
        assert.equal(result.payload.materializedState.proof?.appId, appId);
        assert.equal(result.payload.materializedState.proof?.paneId, currentPaneId);
      }
    }
  } finally {
    client?.close();
    await server.stop();
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(socketDir, { force: true, recursive: true });
  }
});

test("canonical target-admission cases execute Electron authority semantics", async () => {
  for (const vectorCase of targetAdmissionVectorCases()) {
    const core = new SurfaceCore();
    const surface = core.ensurePrimarySurface("Surf Ace", {
      height: 800,
      scale: 2,
      width: 1200,
    });
    initializeRegistryBootstrapPanes(core);
    const port = nextPort++;
    const server = new SurfaceWsServer({
      capturePaneImage: async () => null,
      claimPaneLabel: claimTestRegistryPaneLabel,
      compositorSocketPath: null,
      core,
      endpointName: "Surf Ace",
      hostName: "localhost",
      port,
      viewport: () => ({ height: 800, scale: 2, width: 1200 }),
    });
    let materializerCalls = 0;
    const targetApply = core.targetApply.bind(core);
    core.targetApply = ((...arguments_: Parameters<SurfaceCore["targetApply"]>) => {
      materializerCalls += 1;
      return targetApply(...arguments_);
    }) as SurfaceCore["targetApply"];
    await server.start();
    const first = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
    const second = vectorCase.input.controllerScenario === "two_same_request_id"
      ? await connect(`ws://127.0.0.1:${port}${server.wsPath}`)
      : null;
    try {
      assert.equal((await pair(first, "controller-a", surface.surfaceId)).ok, true);
      if (second) {
        assert.equal((await pair(second, "controller-b", surface.surfaceId)).ok, true);
      }
      let panes = (await request(first, "panes.list", {
        surfaceId: surface.surfaceId,
      })).payload.panes as Array<{ paneId: number; paneLineageId: string }>;
      if (second) {
        const split = await request(first, "pane.split", {
          count: 2,
          direction: "horizontal",
          expectedTopologyRevision: 0,
          paneId: panes[0]!.paneId,
          surfaceId: surface.surfaceId,
        });
        assert.equal(split.ok, true, `${vectorCase.id}: ${JSON.stringify(split)}`);
        panes = (await request(first, "panes.list", {
          surfaceId: surface.surfaceId,
        })).payload.panes;
      }
      if (vectorCase.input.annotationPolicy === "deny") {
        core.setAnnotating(surface.surfaceId, panes[0]!.paneId, true);
      }
      if (vectorCase.input.surfaceState === "tombstoned") {
        const record = core.captureSurfaceTombstonePayload(surface.surfaceId);
        const paneTombstones = core.locklessAuthority.takePaneTombstonesForSurface(
          surface.surfaceId,
        );
        core.locklessAuthority.createTombstone({
          kind: "surface",
          payload: { paneTombstones, surface: record },
          surfaceId: surface.surfaceId,
        });
        core.removeSurface(surface.surfaceId);
      }
      const before = targetAuthorityCounts(core);
      const operationRequestId = second
        ? "rq-shared-controller-scoped"
        : `rq-${vectorCase.id}`;
      const payloadFor = (pane: { paneId: number; paneLineageId: string }, suffix: string) => ({
        paneLineageId: vectorCase.input.paneLineage === "current"
          ? pane.paneLineageId
          : "pl_stale",
        requestId: `target-${vectorCase.id}-${suffix}`,
        restoreReason: "initial",
        surfaceId: surface.surfaceId,
        targetEpoch: 1,
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: vectorCase.input.replaySemantics,
          requiredCapabilities: [vectorCase.input.requiredCapability === "supported"
            ? "target.browser_url.v1"
            : "target.missing.v1"],
          safeToLogFields: ["url"],
          safetyClass: "network",
          summary: vectorCase.id,
        },
        targetId: `target-${vectorCase.id}-${suffix}`,
        targetKind: "browser_url",
        targetPayload: {
          url: vectorCase.input.targetPayload === "safe_https"
            ? `https://example.com/${suffix}`
            : "file:///etc/passwd",
        },
      });
      const responses = await Promise.all([
        request(first, "target.apply", payloadFor(panes[0]!, "a"), {
          id: operationRequestId,
        }),
        ...(second
          ? [request(second, "target.apply", payloadFor(panes[1]!, "b"), {
              id: operationRequestId,
            })]
          : []),
      ]);
      for (const response of responses) {
        assert.equal(
          response.ok ? null : response.error.code,
          vectorCase.expected.topLevelCode,
          `${vectorCase.id}: ${JSON.stringify(response)}`,
        );
        assert.equal(
          response.error?.details?.targetErrorCode ?? null,
          vectorCase.expected.targetErrorCode,
          `${vectorCase.id}: ${JSON.stringify(response)}`,
        );
      }
      if (!vectorCase.expected.notCommitted) {
        await waitForTargetCounts(core, {
          results: before.results,
          work: before.work + responses.length,
        });
        for (const [index, pane] of panes.slice(0, responses.length).entries()) {
          server.resolveBrowserUrlNavigation(surface.surfaceId, pane.paneId, {
            status: "applied",
            targetId: `target-${vectorCase.id}-${index === 0 ? "a" : "b"}`,
            url: `https://example.com/${index === 0 ? "a" : "b"}`,
          });
        }
      }
      await waitForTargetCounts(core, {
        results: before.results + vectorCase.expected.resultDelta,
        work: before.work + vectorCase.expected.workDelta,
      });
      const after = targetAuthorityCounts(core);
      assert.equal(after.receipts - before.receipts, vectorCase.expected.receiptDelta, vectorCase.id);
      assert.equal(after.work - before.work, vectorCase.expected.workDelta, vectorCase.id);
      assert.equal(after.results - before.results, vectorCase.expected.resultDelta, vectorCase.id);
      assert.equal(materializerCalls, vectorCase.expected.materializerCalls, vectorCase.id);
      for (const socket of [first, ...(second ? [second] : [])]) {
        const sync = await request(socket, "operation.receipt.sync", {
          requestIds: [operationRequestId],
        });
        assert.equal(
          sync.payload.resolutions[0].outcome,
          vectorCase.expected.receiptSyncOutcome,
          vectorCase.id,
        );
      }
    } finally {
      first.close();
      second?.close();
      await server.stop();
    }
  }
});

test("AC-TOPO-04: split rename resize close restore and realization share stable IDs and one topology revision seam", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  initializeRegistryBootstrapPanes(core);
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    claimPaneLabel: claimTestRegistryPaneLabel,
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
      friendlyChatName: "OpenClaw",
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
    const renamed = await request(second, "pane.rename", {
      expectedTopologyRevision: restoredTopologyPane.payload.topologyRevision,
      name: "Stable allocated pane",
      paneId: allocatedPaneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    assert.equal(renamed.payload.paneId, allocatedPaneId);
    assert.equal(renamed.payload.name, "Stable allocated pane");
    assert.equal(
      renamed.payload.topologyRevision,
      restoredTopologyPane.payload.topologyRevision + 1,
    );
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("new panes stay unnumbered when the registry rejects a pane claim and recover by lineage on client.register", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  initializeRegistryBootstrapPanes(core);
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    claimPaneLabel: async () => { throw new Error("surface_not_registered"); },
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const controller = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const registry = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => registry.once("listening", resolve));
  const registryAddress = `ws://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
  const clientRegistration = new ConfiguredServerRegistration(
    registryAddress, "allocator-recovery-client", core, async () => {}, () => {}, 500,
  );
  try {
    assert.equal((await pair(controller, "allocator-recovery-controller", surface.surfaceId)).ok, true);

    const base = (await request(controller, "panes.list", { surfaceId: surface.surfaceId })).payload;
    const split = await request(controller, "pane.split", {
      count: 2,
      direction: "horizontal",
      expectedTopologyRevision: base.topology.topologyRevision,
      paneId: Number(base.panes[0].paneId),
      surfaceId: surface.surfaceId,
    });
    assert.equal(split.ok, true, JSON.stringify(split));
    let panes = (await request(controller, "panes.list", { surfaceId: surface.surfaceId })).payload.panes;
    const splitPane = panes.find((pane: any) => pane.paneId !== base.panes[0].paneId);
    assert.ok(splitPane?.paneLineageId);
    assert.equal(splitPane.paneLabel, null);

    const topology = await request(controller, "topology.apply", {
      allowDestroyPaneIds: [],
      desired: {
        children: [
          { paneId: Number(base.panes[0].paneId), type: "pane" },
          { paneId: Number(splitPane.paneId), type: "pane" },
          { name: "Unnumbered until registry recovery", type: "pane" },
        ],
        direction: "horizontal",
        type: "split",
      },
      expectedTopologyRevision: split.payload.topologyRevision,
      surfaceId: surface.surfaceId,
      target: { root: true },
    });
    assert.equal(topology.ok, true, JSON.stringify(topology));
    panes = (await request(controller, "panes.list", { surfaceId: surface.surfaceId })).payload.panes;
    const topologyPane = panes.find((pane: any) => ![base.panes[0].paneId, splitPane.paneId].includes(pane.paneId));
    assert.ok(topologyPane?.paneLineageId);
    assert.equal(topologyPane.paneLabel, null);

    const closed = await request(controller, "pane.close", {
      expectedTopologyRevision: topology.payload.topologyRevision,
      paneId: Number(topologyPane.paneId),
      surfaceId: surface.surfaceId,
    });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    const restored = await request(controller, "pane.restore", {
      anchorPaneId: Number(base.panes[0].paneId),
      direction: "vertical",
      expectedTopologyRevision: closed.payload.topologyRevision,
      surfaceId: surface.surfaceId,
      tombstoneId: closed.payload.tombstoneId,
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    panes = (await request(controller, "panes.list", { surfaceId: surface.surfaceId })).payload.panes;
    const restoredPane = panes.find((pane: any) => pane.paneId === topologyPane.paneId);
    assert.equal(restoredPane.paneLineageId, topologyPane.paneLineageId);
    assert.equal(restoredPane.paneLabel, null);

    const unnumberedLineages = new Set(
      panes.filter((pane: any) => pane.paneLabel === null).map((pane: any) => pane.paneLineageId),
    );
    assert.ok(unnumberedLineages.has(splitPane.paneLineageId));
    assert.ok(unnumberedLineages.has(restoredPane.paneLineageId));
    const registrationRequestPromise = new Promise<{ socket: WebSocket; message: any }>((resolve) => {
      registry.once("connection", (socket) => {
        socket.once("message", (raw) => resolve({ socket, message: JSON.parse(String(raw)) }));
      });
    });
    const synchronize = clientRegistration.synchronize();
    const { socket: registrationSocket, message: registrationRequest } = await registrationRequestPromise;
    assert.equal(registrationRequest.op, "client.register");
    const registrationPanes = registrationRequest.payload.surfaces[0].panes;
    assert.deepEqual(
      new Set(registrationPanes.filter((pane: any) => pane.paneLabel === 0).map((pane: any) => pane.paneLineageId)),
      unnumberedLineages,
    );
    const labelsByLineage = new Map<string, number>();
    let nextLabel = 900;
    for (const pane of registrationPanes) labelsByLineage.set(pane.paneLineageId, nextLabel++);
    registrationSocket.send(JSON.stringify({
      id: registrationRequest.id,
      ok: true,
      op: "client.register",
      payload: {
        clientId: registrationRequest.payload.clientId,
        surfaces: registrationRequest.payload.surfaces.map((entry: any) => ({
          surfaceId: entry.surfaceId,
          windowLabel: "a",
          panes: entry.panes.map((pane: any) => ({
            ...pane,
            paneLabel: labelsByLineage.get(pane.paneLineageId),
          })),
        })),
      },
      type: "response",
      v: 1,
    }));
    await synchronize;
    const recovered = core.panesList(surface.surfaceId).panes;
    for (const pane of recovered) {
      assert.equal(pane.paneLabel, labelsByLineage.get(pane.paneLineageId));
    }
    assert.equal(new Set(recovered.map((pane) => pane.paneLabel)).size, recovered.length);
  } finally {
    await clientRegistration.stop();
    controller.close();
    for (const socket of registry.clients) socket.terminate();
    await new Promise<void>((resolve) => registry.close(() => resolve()));
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
    const paneId = Number(panes.payload.topology.panes[0].paneId);
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

test("unknown persistence outcome preserves direct reads while fencing dependent mutation", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const other = core.createAdditionalSurface("Other", { height: 800, scale: 2, width: 1200 });
  for (const [shown, markdown] of [[surface, "# retained first"], [other, "# retained second"]] as const) {
    core.contentSet(shown.surfaceId, {
      content: { markdown },
      contentId: `ct_${shown.surfaceId}` as never,
      contentType: "markdown",
      historyOwnerToken: `hot_${shown.surfaceId}` as never,
      paneId: core.panesList(shown.surfaceId).panes[0]!.paneId,
      revision: 1 as never,
    });
  }
  const visibleBefore = [surface, other].map(({ surfaceId }) => core.getRendererWindowState(surfaceId).panes[0]!.content);
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
    failPersistence = true;
    const rejected = await request(socket, "content.set", {
      content: { markdown: "# uncertain replacement" },
      contentId: "ct_uncertain_replacement",
      contentType: "markdown",
      paneId: Number(panes.payload.panes[0].paneId),
      surfaceId: surface.surfaceId,
    }, { id: "target-persistence-outcome-unknown" });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error.message, /unknown|paused/i);
    assert.equal(materializationInvocations, 0);
    assert.deepEqual(core.getRendererWindowState(other.surfaceId).panes[0]!.content, visibleBefore[1]);
    const afterFault = core.getRendererWindowState(surface.surfaceId).panes[0]!.content;
    assert.equal(afterFault.contentId, "ct_uncertain_replacement");
    assert.equal((await request(socket, "panes.list", { surfaceId: surface.surfaceId })).ok, true);
    const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
    try {
      const listed = await request(second, "surfaces.list", {});
      assert.equal(listed.ok, true);
      assert(listed.payload.surfaces.some((item: { surfaceId: string }) => item.surfaceId === other.surfaceId));
    } finally {
      second.close();
    }
  } finally {
    socket.close();
    await server.stop();
  }
});

test("listener bind failure can retry on the same server without changing restored surfaces", async () => {
  const core = new SurfaceCore();
  const first = core.ensurePrimarySurface("First", { height: 800, scale: 1, width: 1200 });
  const second = core.createAdditionalSurface("Second", { height: 800, scale: 1, width: 1200 });
  for (const [surface, content] of [[first, "# first"], [second, "# second"]] as const) {
    const paneId = core.panesList(surface.surfaceId).panes[0]!.paneId;
    core.contentSet(surface.surfaceId, {
      content: { markdown: content },
      contentId: `ct_${surface.surfaceId}` as never,
      contentType: "markdown",
      historyOwnerToken: `hot_${surface.surfaceId}` as never,
      paneId,
      revision: 1 as never,
    });
  }
  const before = core.getPersistentState();
  const port = nextPort++;
  const occupant = createServer();
  await new Promise<void>((resolve) => occupant.listen(port, "127.0.0.1", resolve));
  const server = new SurfaceWsServer({
    bindAddress: "127.0.0.1",
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 1, width: 1200 }),
  });
  try {
    await assert.rejects(server.start(), (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE");
    assert.deepEqual(core.getPersistentState(), before);
    await new Promise<void>((resolve) => occupant.close(() => resolve()));
    await server.start();
    const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
    try {
      const listed = await request(socket, "surfaces.list", {});
      assert.equal(listed.ok, true);
      assert(listed.payload.surfaces.some((item: { surfaceId: string }) => item.surfaceId === first.surfaceId));
      assert(listed.payload.surfaces.some((item: { surfaceId: string }) => item.surfaceId === second.surfaceId));
      assert.deepEqual(core.getPersistentState(), before);
      assert.equal(core.getRendererWindowState(first.surfaceId).panes[0]?.content.contentType, "markdown");
      assert.equal(core.getRendererWindowState(second.surfaceId).panes[0]?.content.contentType, "markdown");
    } finally {
      socket.close();
    }
  } finally {
    if (occupant.listening) await new Promise<void>((resolve) => occupant.close(() => resolve()));
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
  initializeRegistryBootstrapPanes(core);
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
    claimPaneLabel: claimTestRegistryPaneLabel,
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
      // Pairing now makes THREE durable writes, not two: prepare, the
      // durable witness transition to "started" (B2), and the terminal
      // outcome. So the mutation's own first write is call #4, not #3.
      if (persistenceCalls === 4) {
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
    assert.equal(persistenceCalls, 4);
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
    assert.equal(persistenceCalls, 5);
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
    assert.equal(persistenceCalls, 6);
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
    assert.equal(surfacePair.payload.admissionAttempt.outcome, "succeeded");
    const duplicate = await pair(
      duplicateSurface,
      "tight-beam",
      surface.surfaceId,
    );
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, "duplicate_controller_instance");
    assert.deepEqual(
      core.listSurfaceAdmissionAttempts().map((attempt) => ({
        outcome: attempt.outcome,
        reasonCode: attempt.reasonCode,
        stage: attempt.stage,
      })),
      [
        { outcome: "succeeded", reasonCode: null, stage: "mode_commit" },
        {
          outcome: "failed",
          reasonCode: "duplicate_controller_instance",
          stage: "controller_admission",
        },
      ],
    );

    const listed = await request(lifecycle, "surfaces.list", {});
    const surfaceScopedList = await request(surfaceSession, "surfaces.list", {});
    assert.equal(surfaceScopedList.payload.admissionAttempts, undefined);
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

test("consumable acknowledgements use durable controller scope ownership across admitted connection slots", async () => {
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
  const firstPaneScope = locklessPaneScopeId(
    firstSurface.surfaceId,
    1,
  );
  const secondSurfaceScope =
    `surface:${encodeURIComponent(secondSurface.surfaceId)}`;
  core.locklessAuthority.ensureScope(firstPaneScope, "pane");
  core.locklessAuthority.ensureScope(secondSurfaceScope, "surface");

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
  const firstSurfaceSession = await connect(
    `ws://127.0.0.1:${port}${server.wsPath}`,
  );
  try {
    assert.equal((await pair(lifecycle, "durable-controller")).ok, true);
    assert.equal(
      (await pair(
        firstSurfaceSession,
        "durable-controller",
        firstSurface.surfaceId,
      )).ok,
      true,
    );
    core.locklessAuthority.appendConsumable({
      payload: { value: "pane" },
      recordClass: "tap",
      scopeId: firstPaneScope,
      scopeKind: "pane",
      triggerOperation: "test.lifecycle-ack",
    });
    core.locklessAuthority.appendConsumable({
      payload: { value: "other-surface" },
      recordClass: "target_result",
      scopeId: secondSurfaceScope,
      scopeKind: "surface",
      triggerOperation: "test.cross-surface-ack",
    });

    const lifecycleAck = await request(lifecycle, "consumable.ack", {
      cursor: 2,
      scopeId: firstPaneScope,
    });
    assert.equal(lifecycleAck.ok, true, JSON.stringify(lifecycleAck));
    assert.equal(lifecycleAck.payload.acceptedCursor, 2);

    const crossSurfaceAck = await request(
      firstSurfaceSession,
      "consumable.ack",
      {
        cursor: 2,
        scopeId: secondSurfaceScope,
      },
    );
    assert.equal(crossSurfaceAck.ok, true, JSON.stringify(crossSurfaceAck));
    assert.equal(crossSurfaceAck.payload.acceptedCursor, 2);

    const lifecycleSync = await request(lifecycle, "consumable.sync", {
      scopeIds: [firstPaneScope],
    });
    assert.equal(lifecycleSync.ok, false);
    assert.equal(lifecycleSync.error.code, "not_paired");

    const foreignSurfaceList = await request(
      firstSurfaceSession,
      "panes.list",
      { surfaceId: secondSurface.surfaceId },
    );
    assert.equal(foreignSurfaceList.ok, false);
    assert.equal(foreignSurfaceList.error.code, "not_paired");
  } finally {
    lifecycle.close();
    firstSurfaceSession.close();
    await server.stop();
  }
});

test("unknown-surface admission is bounded, durable, and lifecycle-only", async () => {
  let durable: ReturnType<SurfaceCore["getPersistentState"]> | null = null;
  const core = new SurfaceCore();
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      durable = core.getPersistentState();
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const unknown = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const lifecycle = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const oversizedController = await request(
      unknown,
      "pair.request",
      {
        controllerInstanceId: "c".repeat(65),
        projectionCapacityBytes: 1,
        protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
        protocolVersion: 1,
        surfaceId: "sf_unknown",
      },
      { id: "rq_oversized_controller" },
    );
    assert.equal(oversizedController.ok, false);
    assert.equal(core.listSurfaceAdmissionAttempts().length, 0);

    const missing = await request(
      unknown,
      "pair.request",
      {
        controllerInstanceId: "unknown_surface_controller",
        projectionCapacityBytes: 1,
        protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
        protocolVersion: 1,
        surfaceId: "sf_unknown",
      },
      { id: "rq_unknown_surface" },
    );
    assert.equal(missing.ok, false, JSON.stringify(missing));
    assert.equal(missing.error.code, "invalid_payload");
    assert(durable);
    assert.equal(durable.admissionAttempts?.length, 1);
    assert.equal(durable.admissionAttempts?.[0]?.surfaceId, "sf_unknown");
    assert.equal(durable.admissionAttempts?.[0]?.outcome, "failed");

    const lifecyclePair = await pair(lifecycle, "lifecycle_controller");
    assert.equal(lifecyclePair.ok, true, JSON.stringify(lifecyclePair));
    const discovered = await request(lifecycle, "surfaces.list", {});
    assert.equal(discovered.ok, true, JSON.stringify(discovered));
    assert.equal(discovered.payload.admissionAttempts.length, 1);
    assert(
      Buffer.byteLength(
        JSON.stringify(discovered.payload.admissionAttempts),
        "utf8",
      ) <= LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES,
    );

    const surfaceScoped = await connect(
      `ws://127.0.0.1:${port}${server.wsPath}`,
    );
    try {
      const scopedPair = await pair(
        surfaceScoped,
        "surface_scoped_controller",
        "sf_unknown",
      );
      assert.equal(scopedPair.ok, false);
      assert.equal(
        (scopedPair.payload as Record<string, unknown> | undefined)
          ?.admissionAttempts,
        undefined,
      );
    } finally {
      surfaceScoped.close();
    }
  } finally {
    lifecycle.close();
    unknown.close();
    await server.stop();
  }

  assert(durable);
  const restarted = new SurfaceCore({ persistentState: durable });
  assert.equal(restarted.listSurfaceAdmissionAttempts().length, 2);
  assert.deepEqual(
    restarted.listSurfaceAdmissionAttempts().map((attempt) => attempt.outcome),
    ["failed", "failed"],
  );
});

test("three surfaces recover independently and complete the offline push-capture path", async () => {
  const core = new SurfaceCore();
  const surfaces = [
    core.ensurePrimarySurface("Already Lockless", {
      height: 800,
      scale: 2,
      width: 1200,
    }),
    core.createAdditionalSurface("Second Surface", {
      height: 800,
      scale: 2,
      width: 1200,
    }),
    core.createAdditionalSurface("Third Surface", {
      height: 800,
      scale: 2,
      width: 1200,
    }),
  ];
  const port = nextPort++;
  let imageCaptureCount = 0;
  const server = new SurfaceWsServer({
    capturePaneImage: async (surfaceId, paneId) => {
      imageCaptureCount += 1;
      return Buffer.from(`${surfaceId}:${paneId}`).toString("base64");
    },
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const lifecycle = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const surfaceSockets = await Promise.all(
    surfaces.map(() => connect(`ws://127.0.0.1:${port}${server.wsPath}`)),
  );
  try {
    assert.equal((await pair(lifecycle, "three-surface-controller")).ok, true);

    const firstAdmission = await pair(
      surfaceSockets[0]!,
      "three-surface-controller",
      surfaces[0]!.surfaceId,
    );
    assert.equal(firstAdmission.ok, true, JSON.stringify(firstAdmission));

    for (const index of [1, 2]) {
      const admitted = await pair(
        surfaceSockets[index]!,
        "three-surface-controller",
        surfaces[index]!.surfaceId,
      );
      assert.equal(admitted.ok, true, JSON.stringify(admitted));
    }

    for (const [index, surface] of surfaces.entries()) {
      const panes = await request(surfaceSockets[index]!, "panes.list", {
        surfaceId: surface.surfaceId,
      });
      assert.equal(panes.ok, true, JSON.stringify(panes));
      const paneId = panes.payload.panes[0].paneId;
      assert(Number(paneId) > 0);
      const contentId = `three-surface-${index + 1}`;
      const pushed = await request(surfaceSockets[index]!, "content.set", {
        content: { markdown: `# ${contentId}` },
        contentId,
        contentType: "markdown",
        paneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(pushed.ok, true, JSON.stringify(pushed));
      const captured = await request(surfaceSockets[index]!, "snapshot.get", {
        paneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(captured.ok, true, JSON.stringify(captured));
      assert.equal(captured.payload.contentId, contentId);
      assert.equal(
        captured.payload.image,
        Buffer.from(`${surface.surfaceId}:${paneId}`).toString("base64"),
      );
      assert.equal(captured.payload.revision, pushed.payload.revision);
      assert.equal(imageCaptureCount, index + 1);

      const suppressed = await request(surfaceSockets[index]!, "snapshot.get", {
        includeImage: false,
        paneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(suppressed.ok, false, "removed flag cannot suppress screenshot capture");
      assert.equal(imageCaptureCount, index + 1, "rejected flag does not reach the renderer");
    }

    assert.deepEqual(
      core.listSurfaceAdmissionAttempts().map((attempt) => attempt.outcome),
      ["succeeded", "succeeded", "succeeded"],
    );
  } finally {
    for (const socket of surfaceSockets) socket.close();
    lifecycle.close();
    await server.stop();
  }
});

test("snapshot.get fails rather than returning success without a screenshot", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("No screenshot", {
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
    const paired = await pair(socket, "missing-screenshot-controller", surface.surfaceId);
    assert.equal(paired.ok, true, JSON.stringify(paired));
    const panes = await request(socket, "panes.list", { surfaceId: surface.surfaceId });
    const paneId = Number(panes.payload.topology.panes[0].paneId);
    const captured = await request(socket, "snapshot.get", {
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(captured.ok, false, JSON.stringify(captured));
    assert.equal(captured.error.code, "render_failed");
  } finally {
    socket.close();
    await server.stop();
  }
});

test("pair admission requires the lockless protocol capability", async () => {
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
    const response = await request(socket, "pair.request", {
      controllerInstanceId: "missing-capability-controller",
      controllerProductName: "OpenClaw",
      projectionCapacityBytes: 5 * 1024 * 1024,
      protocolFeatures: [],
      protocolVersion: 1,
      surfaceId: surface.surfaceId,
    });
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, "capability_mismatch");
    assert.match(response.error.message, /lockless-multi-controller/);
  } finally {
    socket.close();
    await server.stop();
  }
});

test("AC-SURF-02: complete surface close persists a tombstone before zero-live socket teardown and restores exact identity after restart", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  initializeRegistryBootstrapPanes(core);
  const firstPort = nextPort++;
  const firstServer = new SurfaceWsServer({
    capturePaneImage: async () => null,
    claimPaneLabel: claimTestRegistryPaneLabel,
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
  const panes = await request(surfaceSession, "panes.list", {
    surfaceId: surface.surfaceId,
  });
  const anchorPaneId = panes.payload.panes[0].paneId;
  const split = await request(surfaceSession, "pane.split", {
    count: 2,
    direction: "horizontal",
    expectedTopologyRevision: panes.payload.topology.topologyRevision,
    paneId: anchorPaneId,
    surfaceId: surface.surfaceId,
  });
  assert.equal(split.ok, true, JSON.stringify(split));
  const nestedPaneId = split.payload.panes.find(
    (pane: { paneId: number }) => pane.paneId !== anchorPaneId,
  ).paneId;
  const content = await request(surfaceSession, "content.set", {
    content: { markdown: "# retained nested material" },
    contentId: "nested-retained-content",
    contentType: "markdown",
    paneId: nestedPaneId,
    surfaceId: surface.surfaceId,
  });
  assert.equal(content.ok, true, JSON.stringify(content));
  core.locklessAuthority.appendConsumable({
    payload: { value: "nested-unread" },
    recordClass: "tap",
    scopeId: locklessPaneScopeId(surface.surfaceId, nestedPaneId),
    scopeKind: "pane",
    triggerOperation: "test.surface-close",
  });
  const nestedClosed = await request(surfaceSession, "pane.close", {
    expectedTopologyRevision: split.payload.topologyRevision,
    paneId: nestedPaneId,
    surfaceId: surface.surfaceId,
  });
  assert.equal(nestedClosed.ok, true, JSON.stringify(nestedClosed));
  const closed = await request(surfaceSession, "surface.window.close", {
    expectedSurfaceSetRevision: listed.payload.surfaceSetRevision,
    expectedTopologyRevision: nestedClosed.payload.topologyRevision,
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
  const retainedSurface = restarted.locklessAuthority
    .listTombstones("surface")[0]!;
  const retainedPayload = retainedSurface.payload as {
    paneTombstones: Array<{
      payload: { pane: { history: Array<{ contentId: string }> } };
      scopes: Record<string, { records: Array<{ payload: unknown }> }>;
      tombstoneId: string;
    }>;
  };
  assert.equal(
    retainedPayload.paneTombstones[0]?.tombstoneId,
    nestedClosed.payload.tombstoneId,
  );
  assert.equal(
    retainedPayload.paneTombstones[0]?.payload.pane.history.some(
      (entry) => entry.contentId === "nested-retained-content",
    ),
    true,
  );
  assert.equal(
    retainedPayload.paneTombstones[0]?.scopes[
      locklessPaneScopeId(surface.surfaceId, nestedPaneId)
    ]?.records.length,
    2,
  );
  const secondPort = nextPort++;
  const secondServer = new SurfaceWsServer({
    capturePaneImage: async () => null,
    claimPaneLabel: claimTestRegistryPaneLabel,
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
  const secondControllerSession = await connect(
    `ws://127.0.0.1:${secondPort}${secondServer.wsPath}`,
  );
  try {
    const admitted = await pair(resumed, "tight-beam");
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(admitted.payload.resumed, true);
    const secondController = await pair(secondControllerSession, "openclaw");
    assert.equal(secondController.ok, true, JSON.stringify(secondController));
    // A new controller adds cursors to retained nested pane scopes. The
    // resulting persisted generation must remain restart-valid before restore.
    assert.doesNotThrow(
      () => new SurfaceCore({ persistentState: restarted.getPersistentState() }),
    );
    const empty = await request(resumed, "surfaces.list", {});
    assert.deepEqual(empty.payload.surfaces, []);
    const restored = await request(resumed, "surface.window.restore", {
      expectedSurfaceSetRevision: closed.payload.surfaceSetRevision,
      tombstoneId: closed.payload.tombstoneId,
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.payload.surfaceId, surface.surfaceId);
    assert.equal(
      restarted.locklessAuthority.listTombstones("pane")[0]?.tombstoneId,
      nestedClosed.payload.tombstoneId,
    );
  } finally {
    resumed.close();
    secondControllerSession.close();
    await secondServer.stop();
  }
});

test("AC-SURF-01: controller and local-user surface lifecycle share the persisted client authority seam", async () => {
  const core = new SurfaceCore();
  core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  let persistedRevision = -1;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      persistedRevision = core.locklessAuthority.surfaceSetRevision;
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const lifecycle = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    assert.equal((await pair(lifecycle, "lifecycle-controller")).ok, true);
    const initial = await request(lifecycle, "surfaces.list", {});
    const opened = await request(lifecycle, "surface.window.open", {
      expectedSurfaceSetRevision: initial.payload.surfaceSetRevision,
    });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.payload.surfaceSetRevision, initial.payload.surfaceSetRevision + 1);
    assert.equal(persistedRevision, opened.payload.surfaceSetRevision);

    const localOpened = await server.openSurfaceFromLocalUser();
    assert.equal(localOpened.surfaceSetRevision, opened.payload.surfaceSetRevision + 1);
    assert.equal(persistedRevision, localOpened.surfaceSetRevision);
    const localClosed = await server.closeSurfaceFromLocalUser(localOpened.surfaceId);
    assert.equal(localClosed.surfaceSetRevision, localOpened.surfaceSetRevision + 1);
    assert.equal(persistedRevision, localClosed.surfaceSetRevision);
    assert.equal(
      core.locklessAuthority.listTombstones("surface")
        .some((entry) => entry.tombstoneId === localClosed.tombstoneId),
      true,
    );
  } finally {
    lifecycle.close();
    await server.stop();
  }
});

test("AC-SURF-04: concurrent lifecycle requests serialize once and stale callers must recompute with a new request ID", async () => {
  const core = new SurfaceCore();
  core.ensurePrimarySurface("Surf Ace", {
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
    assert.equal((await pair(first, "lifecycle-first")).ok, true);
    assert.equal((await pair(second, "lifecycle-second")).ok, true);
    const initialRevision = core.locklessAuthority.surfaceSetRevision;
    const [left, right] = await Promise.all([
      request(first, "surface.window.open", {
        expectedSurfaceSetRevision: initialRevision,
      }, { id: "rq_surface_open_left" }),
      request(second, "surface.window.open", {
        expectedSurfaceSetRevision: initialRevision,
      }, { id: "rq_surface_open_right" }),
    ]);
    const winner = [left, right].find((response) => response.ok)!;
    const stale = [left, right].find((response) => !response.ok)!;
    assert.equal(stale.error.code, "stale_surface_set");
    assert.equal(core.listSurfaces().length, 2);
    const retrySocket = stale.id === "rq_surface_open_left" ? first : second;
    const retried = await request(retrySocket, "surface.window.open", {
      expectedSurfaceSetRevision: winner.payload.surfaceSetRevision,
    }, { id: "rq_surface_open_recomputed" });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(
      retried.payload.surfaceSetRevision,
      winner.payload.surfaceSetRevision + 1,
    );
    assert.equal(core.listSurfaces().length, 3);
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("copied Electron roots cold-start the production lockless server and admit a client", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "surf-ace-copied-composition-"));
  const electronSourceRoot = path.join(root, "electron-source");
  const electronCopiedRoot = path.join(root, "electron-copy");
  const electronStateFile = "surf-ace-state.json";
  let electronWrites = Promise.resolve();
  const settleElectronWrites = async (): Promise<void> => await electronWrites;
  const createServer = (core: SurfaceCore, port: number, stateRoot: string) =>
    new SurfaceWsServer({
      capturePaneImage: async () => null,
      compositorSocketPath: null,
      core,
      endpointName: "Surf Ace",
      hostName: "localhost",
      persistLocklessState: async () => {
        const state = core.getPersistentState();
        electronWrites = electronWrites.then(async () => {
          await writePersistentStateFile(stateRoot, electronStateFile, state);
        });
        await electronWrites;
      },
      port,
      viewport: () => ({ height: 800, scale: 2, width: 1200 }),
    });
  try {
    const sourceCore = new SurfaceCore({ clientIdentity: "electron-copied-root" });
    const sourceSurface = sourceCore.ensurePrimarySurface("Surf Ace", {
      height: 800,
      scale: 2,
      width: 1200,
    });
    const sourcePort = nextPort++;
    const sourceServer = createServer(sourceCore, sourcePort, electronSourceRoot);
    await writePersistentStateFile(electronSourceRoot, electronStateFile, sourceCore.getPersistentState());
    await sourceServer.start();
    const sourceSocket = await connect(`ws://127.0.0.1:${sourcePort}${sourceServer.wsPath}`);
    assert.equal((await pair(sourceSocket, "electron-source", sourceSurface.surfaceId)).ok, true);
    sourceSocket.close();
    await sourceServer.stop();
    await settleElectronWrites();
    await writePersistentStateFile(electronSourceRoot, electronStateFile, sourceCore.getPersistentState());

    await cp(electronSourceRoot, electronCopiedRoot, { recursive: true });
    const loaded = await loadPersistentStateFile(electronCopiedRoot, electronStateFile);
    assert.equal(loaded.writeGuard, false);
    assert.ok(loaded.state);
    const copiedCore = new SurfaceCore({
      clientIdentity: "electron-copied-root",
      persistentState: loaded.state,
    });
    copiedCore.restorePersistedSurfaces("Surf Ace", {
      height: 800,
      scale: 2,
      width: 1200,
    });
    const copiedPort = nextPort++;
    const copiedServer = createServer(copiedCore, copiedPort, electronCopiedRoot);
    await copiedServer.start();
    const copiedSocket = await connect(`ws://127.0.0.1:${copiedPort}${copiedServer.wsPath}`);
    try {
      assert.equal((await pair(copiedSocket, "electron-source", sourceSurface.surfaceId)).ok, true);
      assert.ok(Object.values(copiedCore.locklessAuthority.exportState().controllers)
        .some((controller) => controller.status === "live"));
    } finally {
      copiedSocket.close();
      await copiedServer.stop();
      await settleElectronWrites();
    }
  } finally {
    await settleElectronWrites();
    await rm(root, { force: true, recursive: true });
  }
});

test("copied clean Electron, iPhone, and iPad product roots admit through unchanged production authority semantics", async (t) => {
  const products = [
    { clientIdentity: "surf-ace-electron", endpointName: "Surf Ace Electron", product: "Electron" },
    { clientIdentity: "surf-ace-iphone", endpointName: "Surf Ace iPhone", product: "iPhone" },
    { clientIdentity: "surf-ace-ipad", endpointName: "Surf Ace iPad", product: "iPad" },
  ] as const;
  for (const product of products) {
    await t.test(product.product, async () => {
      const root = await mkdtemp(path.join(tmpdir(), `surf-ace-${product.product.toLowerCase()}-copy-`));
      const sourceRoot = path.join(root, "source");
      const copiedRoot = path.join(root, "copy");
      const stateFile = "surf-ace-state.json";
      let writes = Promise.resolve();
      try {
        const sourceCore = new SurfaceCore({ clientIdentity: product.clientIdentity });
        const sourceSurface = sourceCore.ensurePrimarySurface(product.endpointName, {
          height: 800,
          scale: 2,
          width: 1200,
        });
        await writePersistentStateFile(sourceRoot, stateFile, sourceCore.getPersistentState());
        await cp(sourceRoot, copiedRoot, { recursive: true });
        const loaded = await loadPersistentStateFile(copiedRoot, stateFile);
        assert.equal(loaded.writeGuard, false);
        assert.ok(loaded.state);
        const core = new SurfaceCore({
          clientIdentity: product.clientIdentity,
          persistentState: loaded.state,
        });
        core.restorePersistedSurfaces(product.endpointName, {
          height: 800,
          scale: 2,
          width: 1200,
        });
        const port = nextPort++;
        const server = new SurfaceWsServer({
          capturePaneImage: async () => null,
          compositorSocketPath: null,
          core,
          endpointName: product.endpointName,
          hostName: "localhost",
          persistLocklessState: async () => {
            const state = core.getPersistentState();
            writes = writes.then(async () => {
              await writePersistentStateFile(copiedRoot, stateFile, state);
            });
            await writes;
          },
          port,
          viewport: () => ({ height: 800, scale: 2, width: 1200 }),
        });
        await server.start();
        const client = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
        try {
          assert.equal((await pair(client, product.clientIdentity, sourceSurface.surfaceId)).ok, true);
        } finally {
          client.close();
          await server.stop();
          await writes;
        }
      } finally {
        await writes;
        await rm(root, { force: true, recursive: true });
      }
    });
  }
});

// --- V3 s8E: operation coverage over a saturated terminal ledger ---

function seedFullTerminalLedger(core: SurfaceCore): number {
  for (
    let index = 1;
    index <= LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS;
    index++
  ) {
    const attempt = core.beginSurfaceAdmissionAttempt({
      controllerInstanceId: `seed_controller_${index}`,
      requestId: `rq_seed_${index}`,
      surfaceId: `sf_seed${String(index % 3)}aaaaaa`,
    });
    core.succeedSurfaceAdmissionAttempt(attempt.attemptSequence);
  }
  return core.listSurfaceAdmissionAttempts().length;
}

test("a saturated terminal ledger still admits push, capture, close and cleanup", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  initializeRegistryBootstrapPanes(core);
  const seeded = seedFullTerminalLedger(core);
  assert.equal(seeded, LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS);

  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => "cG5n",
    claimPaneLabel: claimTestRegistryPaneLabel,
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
    // pairing itself is what the baseline refused forever once the ledger filled
    const paired = await pair(socket, "openclaw", surface.surfaceId);
    assert.equal(paired.ok, true, JSON.stringify(paired));
    assert(
      core.listSurfaceAdmissionAttempts().length <=
        LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
    );

    const panes = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const paneId = Number(panes.payload.topology.panes[0].paneId);

    // push
    const marker = "saturated ledger marker";
    const pushed = await request(socket, "content.set", {
      content: { html: `<p>${marker}</p>` },
      contentId: "content-saturated",
      contentType: "html",
      friendlyChatName: "OpenClaw",
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));

    const captured = await request(socket, "snapshot.get", {
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    assert.equal(Object.hasOwn(captured.payload, "visibleText"), false);
    assert.equal(captured.payload.contentId, "content-saturated");
    assert.equal(captured.payload.revision > 0, true);
    assert.equal(captured.payload.image, "cG5n");

    // split then close, so pane close and cleanup close both run paired
    const split = await request(socket, "pane.split", {
      count: 2,
      direction: "horizontal",
      expectedTopologyRevision: (
        await request(socket, "panes.list", { surfaceId: surface.surfaceId })
      ).payload.topology.topologyRevision,
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(split.ok, true, JSON.stringify(split));
    const afterSplit = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const created = afterSplit.payload.topology.panes
      .map((pane: { paneId: number }) => Number(pane.paneId))
      .find((candidate: number) => candidate !== paneId);
    assert(created !== undefined);

    const closed = await request(socket, "pane.close", {
      expectedTopologyRevision: split.payload.topologyRevision,
      paneId: created,
      surfaceId: surface.surfaceId,
    });
    assert.equal(closed.ok, true, JSON.stringify(closed));

    // back to the original one-pane topology, bounds still held
    const finalPanes = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    assert.equal(finalPanes.payload.topology.panes.length, 1);
    assert(
      core.listSurfaceAdmissionAttempts().length <=
        LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
    );
  } finally {
    socket.close();
    await server.stop();
  }
});

test("cumulative content above 1 MiB keeps every individual push valid and the base policy unchanged", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  seedFullTerminalLedger(core);

  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => "cG5n",
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
    const paired = await pair(socket, "openclaw", surface.surfaceId);
    assert.equal(paired.ok, true, JSON.stringify(paired));
    const panes = await request(socket, "panes.list", {
      surfaceId: surface.surfaceId,
    });
    const paneId = Number(panes.payload.topology.panes[0].paneId);

    const chunk = "y".repeat(64 * 1024);
    let cumulative = 0;
    let lastMarker = "";
    let lastContentId = "";
    for (let index = 0; cumulative <= 1024 * 1024; index++) {
      lastMarker = `cumulative ${index} ${chunk}`;
      lastContentId = `content-cumulative-${index}`;
      const pushed = await request(socket, "content.set", {
        content: { html: `<p>${lastMarker}</p>` },
        contentId: `content-cumulative-${index}`,
        contentType: "html",
        friendlyChatName: "OpenClaw",
        paneId,
        surfaceId: surface.surfaceId,
      });
      assert.equal(pushed.ok, true, JSON.stringify(pushed));
      cumulative += lastMarker.length;
    }
    assert(cumulative > 1024 * 1024);

    // exact final content, after more than a megabyte of cumulative input
    const captured = await request(socket, "snapshot.get", {
      paneId,
      surfaceId: surface.surfaceId,
    });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    assert.equal(Object.hasOwn(captured.payload, "visibleText"), false);
    assert.equal(captured.payload.contentId, lastContentId);
    assert.equal(captured.payload.revision > 0, true);
    assert.equal(captured.payload.image, "cG5n");
  } finally {
    socket.close();
    await server.stop();
  }
});

test("a saturated ledger persisted and restarted still pairs and serves content", async () => {
  const seed = new SurfaceCore();
  const surface = seed.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  seedFullTerminalLedger(seed);
  const persisted = seed.getPersistentState();

  // restart from the exact persisted form the baseline could not recover from
  const restored = new SurfaceCore({ persistentState: persisted });
  const restoredSurface = restored.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => "cG5n",
    compositorSocketPath: null,
    core: restored,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const paired = await pair(socket, "openclaw", restoredSurface.surfaceId);
    assert.equal(paired.ok, true, JSON.stringify(paired));
    const panes = await request(socket, "panes.list", {
      surfaceId: restoredSurface.surfaceId,
    });
    const paneId = Number(panes.payload.topology.panes[0].paneId);
    const marker = "restored after saturation";
    const pushed = await request(socket, "content.set", {
      content: { html: `<p>${marker}</p>` },
      contentId: "content-restored",
      contentType: "html",
      friendlyChatName: "OpenClaw",
      paneId,
      surfaceId: restoredSurface.surfaceId,
    });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    const captured = await request(socket, "snapshot.get", {
      paneId,
      surfaceId: restoredSurface.surfaceId,
    });
    assert.equal(Object.hasOwn(captured.payload, "visibleText"), false);
    assert.equal(captured.payload.contentId, "content-restored");
    assert.equal(captured.payload.image, "cG5n");
  } finally {
    socket.close();
    await server.stop();
  }
});

test("concurrent pair.requests are serialized through the global durable boundary", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800,
    scale: 2,
    width: 1200,
  });
  seedFullTerminalLedger(core);
  const before = core.getPersistentState().nextAdmissionAttemptSequence;

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
    // fire both without awaiting the first, so they contend for the boundary
    const [a, b] = await Promise.all([
      pair(first, "openclaw", surface.surfaceId),
      pair(second, "tight-beam", surface.surfaceId),
    ]);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));

    // two attempts were committed, with distinct strictly increasing
    // sequences, and no attempt was lost to the race
    const after = core.getPersistentState().nextAdmissionAttemptSequence;
    assert.equal(after, before + 2);
    const sequences = core
      .listSurfaceAdmissionAttempts()
      .map((attempt) => attempt.attemptSequence);
    assert.equal(new Set(sequences).size, sequences.length);
    assert.deepEqual([...sequences].sort((x, y) => x - y), sequences);
    assert(
      core.listSurfaceAdmissionAttempts().length <=
        LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
    );
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("socket-path known pre-state persistence failure rolls back and reuses the sequence", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800, scale: 2, width: 1200,
  });
  seedFullTerminalLedger(core);
  const provisional = core.getPersistentState().nextAdmissionAttemptSequence;
  let failNext = true;
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      if (failNext) {
        failNext = false;
        throw new Error("nothing written");
      }
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const failed = await pair(socket, "openclaw", surface.surfaceId);
    assert.equal(failed.ok, false, JSON.stringify(failed));
    // exact pre-state: the provisional sequence was never consumed
    assert.equal(
      core.getPersistentState().nextAdmissionAttemptSequence,
      provisional,
    );
    assert.equal(core.isAdmissionFailStopped(), false);

    const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
    const retried = await pair(second, "tight-beam", surface.surfaceId);
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(
      core.getPersistentState().nextAdmissionAttemptSequence,
      provisional + 1,
    );
    second.close();
  } finally {
    socket.close();
    await server.stop();
  }
});

// REMOVED PENDING A SERVER FIX, defect recorded on asg_2107e9db:
// an unknown-outcome persistence failure during pair.request never produces a
// response envelope, so the client hangs forever rather than receiving an
// error. The test that proves it hangs the whole suite, so it is not left
// armed here. Reproduction: supply persistLocklessState that throws a plain
// Error, pair, and observe no response. The known-pre-state case above is
// mapped correctly and passes.

test("unknown-outcome persistence still answers pair.request with exactly one bounded error envelope", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800, scale: 2, width: 1200,
  });
  seedFullTerminalLedger(core);
  const before = core.getPersistentState().nextAdmissionAttemptSequence;
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      const unknown = new Error("Persistent state commit outcome is unknown");
      unknown.name = "PersistentStateOutcomeUnknownError";
      throw unknown;
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const envelopes: Record<string, any>[] = [];
  socket.on("message", (raw: WebSocket.RawData) => {
    const message = JSON.parse(String(raw)) as Record<string, any>;
    if (message.type === "response") envelopes.push(message);
  });
  try {
    // Bounded on purpose: the defect is that no response ever arrives, so an
    // unbounded await would hang the suite instead of failing it.
    const answered = await Promise.race([
      pair(socket, "openclaw", surface.surfaceId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    assert(answered !== null, "pair.request never received a response envelope");
    assert.equal(answered.ok, false, JSON.stringify(answered));
    assert.equal(typeof answered.error?.code, "string");

    // Fail-stopped, and it STAYS fail-stopped until a reload.
    assert.equal(core.isAdmissionFailStopped(), true);
    // The in-memory high-water is deliberately NOT rolled back on an unknown
    // outcome: we do not know whether the durable commit happened, so we touch
    // nothing and require a reload to decide. Asserting it reverted would be
    // asserting a rollback the contract forbids here.
    assert.equal(
      core.getPersistentState().nextAdmissionAttemptSequence,
      before + 1,
    );
    // reload is the escape hatch, and only reload
    const reloaded = new SurfaceCore({
      persistentState: core.getPersistentState(),
    });
    assert.equal(reloaded.isAdmissionFailStopped(), false);
    // exactly one envelope for that request id
    await new Promise((resolve) => setTimeout(resolve, 300));
    const forRequest = envelopes.filter((e) => e.id === answered.id);
    assert.equal(forRequest.length, 1, JSON.stringify(forRequest));
  } finally {
    socket.close();
    await server.stop();
  }
});

test("a second pair.request while fail-stopped is answered, not left hanging", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800, scale: 2, width: 1200,
  });
  seedFullTerminalLedger(core);
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      const unknown = new Error("Persistent state commit outcome is unknown");
      unknown.name = "PersistentStateOutcomeUnknownError";
      throw unknown;
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const first = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const one = await Promise.race([
      pair(first, "openclaw", surface.surfaceId),
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    assert(one !== null, "first pair.request never answered");
    assert.equal(core.isAdmissionFailStopped(), true);

    // This is the case the original harness awaited without a timeout.
    const two = await Promise.race([
      pair(second, "tight-beam", surface.surfaceId),
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    assert(two !== null, "second pair.request while fail-stopped never answered");
    assert.equal(two.ok, false, JSON.stringify(two));
    assert.equal(typeof two.error?.code, "string");
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("a successful saturated pair survives a FRESH-CORE reload with no unresolved row", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800, scale: 2, width: 1200,
  });
  seedFullTerminalLedger(core);
  // Capture what actually reaches disk, not what the live core believes.
  let persisted: string | null = null;
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    persistLocklessState: async () => {
      persisted = JSON.stringify(core.getPersistentState());
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    const paired = await pair(socket, "openclaw", surface.surfaceId);
    assert.equal(paired.ok, true, JSON.stringify(paired));
    assert(persisted !== null, "nothing was ever persisted");

    // THE CHECK THAT WAS MISSING: reload a fresh core from the persisted bytes.
    // Reading the live core hides the defect, because it reflects in-memory
    // terminalization that may never have reached disk.
    const reloaded = new SurfaceCore({
      persistentState: JSON.parse(persisted as string),
    });
    assert.deepEqual(
      reloaded.listUnresolvedSurfaceAdmissionAttempts(),
      [],
      "a successful pair left an unresolved row in durable state",
    );

    // and the reloaded core must still admit, i.e. it is not bricked
    const admitted = reloaded.beginSurfaceAdmissionAttempt({
      controllerInstanceId: "controller_after_reload",
      requestId: "rq_after_reload",
      surfaceId: "sf_other0aaaaa",
    });
    assert(admitted.attemptSequence > 0);
  } finally {
    socket.close();
    await server.stop();
  }
});

// DISCOVERY REGRESSION STILL NOT PROVEN, blocker recorded on asg_2107e9db.
// Second attempt built the trigger through supported APIs only: a fresh
// surface already holds BOOTSTRAP_PANE_ID (0), the pane-id-below-1 condition
// that makes surfaces.list call admitSurfaceForDiscovery. But the test PASSED
// at pre-fix 5692243 as well as after 968d811, so it does NOT discriminate and
// proves nothing about B1. Most likely pair.request materialises the bootstrap
// pane before surfaces.list runs, so admitSurfaceForDiscovery never executes.
// A real discovery regression must first prove that path actually ran, for
// example by observing the ledger grow by a discovery-created row.
// Not left armed: a non-discriminating regression is worse than none, because
// it reads as coverage it does not provide.

test("a successful DISCOVERY admission is durably terminal and leaves admission open", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Surf Ace", {
    height: 800, scale: 2, width: 1200,
  });
  assert(
    core.activePaneIds(surface.surfaceId).some((paneId) => paneId < 1),
    "expected the bootstrap pane id below 1",
  );
  seedFullTerminalLedger(core);

  let persisted: string | null = null;
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    compositorSocketPath: null,
    core,
    endpointName: "Surf Ace",
    hostName: "localhost",
    port,
    persistLocklessState: async () => {
      persisted = JSON.stringify(core.getPersistentState());
    },
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  try {
    // Lifecycle pairing WITHOUT a surfaceId, so the bootstrap pane is not
    // materialised and the pane-id-below-1 discovery trigger survives.
    const paired = await pair(socket, "openclaw");
    assert.equal(paired.ok, true, JSON.stringify(paired));
    assert(
      core.activePaneIds(surface.surfaceId).some((paneId) => paneId < 1),
      "pairing materialised the bootstrap pane; discovery would not run",
    );

    const beforeSeq = core.getPersistentState().nextAdmissionAttemptSequence;
    const listed = await request(socket, "surfaces.list", {});
    assert.equal(listed.ok, true, JSON.stringify(listed));

    // PRECONDITION: prove admitSurfaceForDiscovery actually ran. Without this
    // the rest is unattributable and the test would not discriminate.
    const afterSeq = core.getPersistentState().nextAdmissionAttemptSequence;
    assert(
      afterSeq > beforeSeq,
      `discovery created no admission row (${beforeSeq} -> ${afterSeq})`,
    );
    assert(persisted !== null, "nothing reached disk");

    // Fresh core from the bytes that actually reached disk.
    const reloaded = new SurfaceCore({
      persistentState: JSON.parse(persisted as string),
    });
    assert.deepEqual(
      reloaded.listUnresolvedSurfaceAdmissionAttempts(),
      [],
      "successful discovery left an unresolved row in durable state",
    );
    const admitted = reloaded.beginSurfaceAdmissionAttempt({
      controllerInstanceId: "controller_post_discovery",
      requestId: "rq_post_discovery",
      surfaceId: "sf_other0aaaaa",
    });
    assert(admitted.attemptSequence > 0);
  } finally {
    socket.close();
    await server.stop();
  }
});
// --- Witness-driven never-began recovery: real socket-path regressions
// (V6 scope, capacity review item 7) ---
//
// These reuse the already-proven unknown-outcome fail-stop mechanism to
// interrupt a real admission at an exact, known point, rather than
// hand-constructing a persisted-state object. Each row is produced by a real
// pair.request through a real SurfaceWsServer; only the merge step for the
// two-owner cases (explicitly marked) assembles independently-produced real
// rows into one ledger, since two owners genuinely mid-flight at once is not
// reachable through the serialized boundary by design — one caller fully
// releases the boundary before the next may enter it.

async function admitOneNotStartedOwner(
  requestIdSuffix: string,
): Promise<{ attempt: LocklessSurfaceAdmissionAttempt; state: any }> {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface(`Surf Ace ${requestIdSuffix}`, {
    height: 800, scale: 2, width: 1200,
  });
  let persisted: string | null = null;
  let calls = 0;
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null, compositorSocketPath: null, core,
    endpointName: "Surf Ace", hostName: "localhost", port,
    persistLocklessState: async () => {
      calls += 1;
      if (calls === 1) {
        // Real prepare persist: candidate durably not_started. Captured.
        persisted = JSON.stringify(core.getPersistentState());
        return;
      }
      // Interrupt before markSurfaceAdmissionAttemptStarted's own persist
      // ever succeeds, so the candidate never advances past not_started.
      throw new PersistentStateOutcomeUnknownError(new Error(`crash-${requestIdSuffix}`));
    },
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  socket.on("error", () => {});
  await Promise.race([
    pair(socket, `openclaw-${requestIdSuffix}`, surface.surfaceId),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  socket.close();
  await server.stop();
  assert(persisted, "prepare's own persist never captured");
  const state = JSON.parse(persisted as string);
  const attempt = state.admissionAttempts[0] as LocklessSurfaceAdmissionAttempt;
  assert.equal(attempt.outcome, "pending");
  assert.equal(attempt.witness, "not_started");
  return { attempt, state };
}

async function admitOneStartedNoReceiptOwner(
  requestIdSuffix: string,
): Promise<{ attempt: LocklessSurfaceAdmissionAttempt; state: any }> {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface(`Surf Ace ${requestIdSuffix}`, {
    height: 800, scale: 2, width: 1200,
  });
  let persisted: string | null = null;
  let calls = 0;
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null, compositorSocketPath: null, core,
    endpointName: "Surf Ace", hostName: "localhost", port,
    persistLocklessState: async () => {
      calls += 1;
      if (calls <= 2) {
        // Real prepare (1) then real markSurfaceAdmissionAttemptStarted (2):
        // the candidate is durably "started". Captured after call 2.
        persisted = JSON.stringify(core.getPersistentState());
        return;
      }
      // Interrupt the terminal write: no receipt evidence will ever exist.
      throw new PersistentStateOutcomeUnknownError(new Error(`crash-${requestIdSuffix}`));
    },
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  socket.on("error", () => {});
  await Promise.race([
    pair(socket, `openclaw-${requestIdSuffix}`, surface.surfaceId),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  socket.close();
  await server.stop();
  assert(persisted, "markSurfaceAdmissionAttemptStarted's own persist never captured");
  const state = JSON.parse(persisted as string);
  const attempt = state.admissionAttempts[0] as LocklessSurfaceAdmissionAttempt;
  assert.equal(attempt.outcome, "pending");
  assert.equal(attempt.witness, "started");
  return { attempt, state };
}

test("real socket-path: a not_started candidate survives a fresh reload, recovers as never-began, and admission resumes", async () => {
  const { attempt } = await admitOneNotStartedOwner("solo-a");
  const reloaded = new SurfaceCore({
    persistentState: {
      admissionAttempts: [attempt],
      nextAdmissionAttemptSequence: attempt.attemptSequence + 1,
      primarySurfaceId: null,
      version: 1,
    },
  });
  const admitted = reloaded.beginSurfaceAdmissionAttempt({
    controllerInstanceId: "controller_after_never_began",
    requestId: "rq_after_never_began",
    surfaceId: "sf_other0aaaaa",
  });
  assert(admitted.attemptSequence > 0);
  const recovered = reloaded
    .listSurfaceAdmissionAttempts()
    .find((row) => row.attemptSequence === attempt.attemptSequence);
  assert.equal(recovered?.outcome, "failed");
  // The only remaining pending row is the NEW candidate itself, still
  // in-flight from this call; the never-began row is gone from that list.
  assert.deepEqual(
    reloaded.listUnresolvedSurfaceAdmissionAttempts(),
    [admitted.attemptSequence],
  );
});

test("real socket-path: a started-without-receipt candidate survives a fresh reload as indeterminate and blocks admission", async () => {
  const { attempt } = await admitOneStartedNoReceiptOwner("solo-b");
  const reloaded = new SurfaceCore({
    persistentState: {
      admissionAttempts: [attempt],
      nextAdmissionAttemptSequence: attempt.attemptSequence + 1,
      primarySurfaceId: null,
      version: 1,
    },
  });
  let raised: unknown = null;
  try {
    reloaded.beginSurfaceAdmissionAttempt({
      controllerInstanceId: "controller_blocked",
      requestId: "rq_blocked",
      surfaceId: "sf_other0aaaaa",
    });
  } catch (error) {
    raised = error;
  }
  assert(raised instanceof LocklessAuthorityError);
  assert.equal(raised.code, "admission_recovery_pending");
  const still = reloaded
    .listSurfaceAdmissionAttempts()
    .find((row) => row.attemptSequence === attempt.attemptSequence);
  assert.equal(still?.outcome, "pending");
  assert.equal(still?.witness, "started");
});

async function twoOwnerMixedOrdering(
  firstKind: "not_started" | "started",
): Promise<void> {
  // Two owners genuinely mid-flight at the same instant is not reachable
  // through the serialized boundary by construction: one caller's admission
  // work fully releases the boundary before the next may enter it. Each
  // row below is produced by its OWN real socket-path admission, exactly as
  // the single-owner tests above; only this merge step is a test
  // construction, assembling two independently real rows into the ledger a
  // restart would actually reload — content each row carries is real,
  // production-produced bytes.
  const first = firstKind === "not_started"
    ? await admitOneNotStartedOwner("mix-first")
    : await admitOneStartedNoReceiptOwner("mix-first");
  const second = firstKind === "not_started"
    ? await admitOneStartedNoReceiptOwner("mix-second")
    : await admitOneNotStartedOwner("mix-second");
  const rowA = { ...first.attempt, attemptSequence: 1 };
  const rowB = { ...second.attempt, attemptSequence: 2 };

  let reloaded = new SurfaceCore({
    persistentState: {
      admissionAttempts: [rowA, rowB],
      nextAdmissionAttemptSequence: 3,
      primarySurfaceId: null,
      version: 1,
    },
  });

  // Every row has a defined outcome field going in; none is silently
  // undefined or guessed.
  for (const row of reloaded.listSurfaceAdmissionAttempts()) {
    assert(["failed", "pending", "succeeded"].includes(row.outcome));
  }

  const notStartedSeq = rowA.witness === "not_started"
    ? rowA.attemptSequence
    : rowB.attemptSequence;
  const startedSeq = rowA.witness === "started"
    ? rowA.attemptSequence
    : rowB.attemptSequence;

  // Admission stays blocked: the not_started row auto-resolves as
  // never-began, but the started row has no receipt and stays
  // indeterminate, and ANY unresolved row blocks admission regardless of
  // capacity (V5).
  let raised: unknown = null;
  try {
    reloaded.beginSurfaceAdmissionAttempt({
      controllerInstanceId: "controller_mixed",
      requestId: "rq_mixed",
      surfaceId: "sf_other0aaaaa",
    });
  } catch (error) {
    raised = error;
  }
  assert(raised instanceof LocklessAuthorityError);
  assert.equal(raised.code, "admission_recovery_pending");

  const afterFirstAttempt = reloaded.listSurfaceAdmissionAttempts();
  const notStartedRow = afterFirstAttempt.find(
    (row) => row.attemptSequence === notStartedSeq,
  );
  const startedRow = afterFirstAttempt.find(
    (row) => row.attemptSequence === startedSeq,
  );
  // The not_started row DID resolve, in the same recovery pass, even though
  // the started row blocked the candidate.
  assert.equal(notStartedRow?.outcome, "failed");
  assert.equal(startedRow?.outcome, "pending");
  assert.deepEqual(reloaded.listUnresolvedSurfaceAdmissionAttempts(), [startedSeq]);

  // Supply real evidence for the started row (a durable receipt), reload
  // fresh again, and confirm admission now resumes. Capture the state ONCE:
  // getPersistentState() clones on every call, so mutating a second,
  // separately-fetched clone would silently go nowhere.
  const stateWithEvidence = reloaded.getPersistentState();
  const lockless = stateWithEvidence.lockless;
  (lockless as any).controllers["ctl_mixed_evidence"] = {
    controllerInstanceId: "ctl_mixed_evidence",
    controllerProductName: null,
    disconnectedAt: null,
    dormantSequence: null,
    pendingOperationReceipts: {
      [startedRow!.requestId]: (() => {
        // `bytes` is validated against the serialized receipt that CONTAINS
        // it, so solve the self-reference by iterating to a fixed point.
        const shape = (bytes: number) => ({
          bytes,
          operation: "pair.request",
          operationReceipt: { commitSequence: 1, requestId: startedRow!.requestId },
          outcome: "resolved_success" as const,
          requestId: startedRow!.requestId,
          status: "terminal" as const,
          terminalResponse: null,
        });
        let bytes = 0;
        for (let pass = 0; pass < 6; pass++) {
          bytes = Buffer.byteLength(
            JSON.stringify({ version: 1, ...shape(bytes) }),
            "utf8",
          );
        }
        return shape(bytes);
      })(),
    },
    projectionCapacityBytes: 1024,
    status: "dormant",
  };
  const withEvidence = new SurfaceCore({
    persistentState: stateWithEvidence,
  });
  const admitted = withEvidence.beginSurfaceAdmissionAttempt({
    controllerInstanceId: "controller_after_evidence",
    requestId: "rq_after_evidence",
    surfaceId: "sf_other0aaaaa",
  });
  assert(admitted.attemptSequence > 0);
  // Only the new candidate itself remains pending, in-flight from this call.
  assert.deepEqual(
    withEvidence.listUnresolvedSurfaceAdmissionAttempts(),
    [admitted.attemptSequence],
  );
}

test("real socket-path, two owners, ordering A (not_started first): mixed recovery resolves one, blocks on the other, then resumes with evidence", async () => {
  await twoOwnerMixedOrdering("not_started");
});

test("real socket-path, two owners, ordering B (started first): mixed recovery resolves one, blocks on the other, then resumes with evidence", async () => {
  await twoOwnerMixedOrdering("started");
});

// --- Real-import unknown-outcome socket regression (forensic att_04cb7234) ---
//
// The earlier hang-lane tests (8408f0e, 5692243) threw a name-tagged plain
// Error, which satisfies SurfaceCore's own name-string check but is NOT an
// instanceof match against the REAL PersistentStateOutcomeUnknownError class.
// SurfaceWsServer's own constructor wraps persistLocklessState with a real
// instanceof check that, on match, calls failStopPersistence, which used to
// close every connected socket SYNCHRONOUSLY — before dispatch ever reached
// the point of sending a response. Those earlier tests never exercised that
// path at all. This one imports the real class.

test("real-import unknown-outcome: pair.request gets a bounded envelope and read transport remains", async () => {
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
    persistLocklessState: async () => {
      // The REAL class, not a duck-typed stand-in.
      throw new PersistentStateOutcomeUnknownError(new Error("selector commit ambiguous"));
    },
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });
  await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
  socket.on("error", () => {});
  const envelopes: Record<string, any>[] = [];
  let closeCode: number | null = null;
  let closeReason = "";
  socket.on("message", (raw: WebSocket.RawData) => {
    const message = JSON.parse(String(raw)) as Record<string, any>;
    if (message.type === "response") envelopes.push(message);
  });
  socket.on("close", (code: number, reason: Buffer) => {
    closeCode = code;
    closeReason = reason.toString();
  });
  try {
    // Bounded on purpose: before the fix this never resolves and the test
    // must fail cleanly rather than hang the suite.
    const answered = await Promise.race([
      pair(socket, "openclaw", surface.surfaceId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    assert(
      answered !== null,
      "pair.request never received a response envelope " +
        `(socket closed: ${JSON.stringify({ closeCode, closeReason })})`,
    );
    assert.equal(answered.ok, false, JSON.stringify(answered));
    assert.equal(typeof answered.error?.code, "string");
    // Stable, specific detail, not an opaque catch-all.
    assert.match(
      String(answered.error?.message ?? ""),
      /commit outcome is unknown/i,
    );

    // Fail-stopped, and stays fail-stopped.
    assert.equal(core.isAdmissionFailStopped(), true);

    const second = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
    try {
      const listed = await request(second, "surfaces.list", {});
      assert.equal(listed.ok, true);
      const paused = await pair(second, "tight-beam", surface.surfaceId);
      assert.equal(paused.ok, false);
      assert.match(paused.error.message, /paused/i);
    } finally {
      second.close();
    }

    // Exactly one envelope for the original request id.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const forFirstRequest = envelopes.filter((e) => e.id === answered.id);
    assert.equal(forFirstRequest.length, 1, JSON.stringify(forFirstRequest));

    // Reload is the only escape: a fresh core is not fail-stopped.
    const reloaded = new SurfaceCore({
      persistentState: core.getPersistentState(),
    });
    assert.equal(reloaded.isAdmissionFailStopped(), false);
  } finally {
    socket.close();
    await server.stop();
  }
});

test("direct controller admission and closure never determine central connection status", async () => {
  const core = new SurfaceCore();
  const surface = core.ensurePrimarySurface("Direct", { width: 800, height: 600, scale: 1 });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null, compositorSocketPath: null, core,
    endpointName: "Direct", hostName: "localhost", port,
    viewport: () => ({ width: 800, height: 600, scale: 1 }),
  });
  await server.start();
  try {
    for (const status of ["disconnected", "connecting", "connected"] as const) {
      core.setConnectionBar(surface.surfaceId, status);
      const socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
      try {
        assert.equal((await pair(socket, `direct-${status}`, surface.surfaceId)).ok, true);
        assert.equal(core.getRendererWindowState(surface.surfaceId).connectionBar, status);
      } finally {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.close();
        await closed;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(core.getRendererWindowState(surface.surfaceId).connectionBar, status);
    }
  } finally {
    await server.stop();
  }
});
