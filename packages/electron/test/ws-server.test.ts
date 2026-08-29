import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import WebSocket from "ws";
import { parseHTML } from "linkedom";

import type { PairRequest, Request, Response, RuntimeAppBindingDiagnostics } from "../../protocol/src/index.js";
import { projectConnectionChrome } from "../src/renderer/ui-projection.js";
import { SurfaceCore } from "../src/surface-core.js";
import { SurfaceWsServer, __test } from "../src/ws-server.js";

let nextPort = 24301;

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

async function closeSocket(socket: WebSocket, code = 1000, reason = "test_done"): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.close(code, reason);
  });
}

async function captureInfoLines(run: () => Promise<void>): Promise<string[]> {
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
    originalInfo(...args);
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
    originalWarn(...args);
  };
  try {
    await run();
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
  return lines;
}

function waitForSocketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function request(socket: WebSocket, payload: Request): Promise<Response> {
  const response = new Promise<Response>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(String(data)) as Response | { id?: string; type?: string };
        if (message.type !== "response" || message.id !== payload.id) {
          return;
        }
        cleanup();
        resolve(message as Response);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`socket closed before response ${payload.id}`));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
  socket.send(JSON.stringify(payload));
  return await response;
}

async function collectEvents(
  socket: WebSocket,
  count: number,
  acceptedOps: string[],
): Promise<Array<{ op: string; payload: Record<string, unknown> }>> {
  return await new Promise((resolve, reject) => {
    const events: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(String(data)) as {
          op?: string;
          payload?: Record<string, unknown>;
          type?: string;
        };
        if (message.type !== "event" || !message.op || !acceptedOps.includes(message.op)) {
          return;
        }
        events.push({ op: message.op, payload: message.payload ?? {} });
        if (events.length >= count) {
          cleanup();
          resolve(events);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before expected events"));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function surfacesListRequest(): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "surfaces.list",
    payload: {},
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function pairRequest(
  surfaceId: string,
  providerId: string,
  options: {
    initialPaneId?: number;
    initialPaneLabel?: number;
    providerName?: string | null;
    resumeSessionId?: string;
    takeover?: boolean;
    windowLabel?: string;
  } = {},
): PairRequest {
  const payload: PairRequest["payload"] = {
    connectionId: `conn_${Math.random().toString(16).slice(2)}` as never,
    initialPaneId: (options.initialPaneId ?? 1) as never,
    initialPaneLabel: options.initialPaneLabel ?? 1,
    protocolVersion: 1,
    providerId: providerId as never,
    providerName: options.providerName ?? "test-harness",
    resume: options.resumeSessionId
      ? { sessionId: options.resumeSessionId as never }
      : undefined,
    surfaceId: surfaceId as never,
    takeover: options.takeover ?? false,
    windowLabel: options.windowLabel ?? "a",
  };
  if (options.providerName === null) {
    delete (payload as { providerName?: string }).providerName;
  }
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "pair.request",
    payload,
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function relinquishRequest(): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "ownership.relinquish",
    payload: {},
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function contentSetRequest(paneId: number, revision = 1): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "content.set",
    payload: {
      content: { html: "<p>annotate</p>" },
      contentId: "ct_snapshot" as never,
      contentType: "html",
      historyOwnerToken: "hot_snapshot" as never,
      paneId: paneId as never,
      revision: revision as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function contentClearRequest(paneId: number, revision: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "content.clear",
    payload: {
      paneId: paneId as never,
      revision: revision as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function topologyApplyRequest(): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "topology.apply",
    payload: {
      layout: {
        children: [
          { paneId: 1 as never, type: "pane" },
          { paneId: 2 as never, type: "pane" },
        ],
        direction: "horizontal",
        type: "split",
      },
      panes: [
        { name: "Left", paneId: 1 as never, paneLabel: 41 },
        { name: "Right", paneId: 2 as never, paneLabel: 42 },
      ],
      topologyRevision: 7 as never,
      windowLabel: "a",
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function seedHorizontalSplitSnapshots(core: SurfaceCore, surfaceId: string, topPaneId = 1, bottomPaneId = 2): void {
  updateResolvedPaneSnapshot(core, surfaceId, topPaneId, {
    bounds: { height: 400, width: 1200, x: 0, y: 0 },
  });
  updateResolvedPaneSnapshot(core, surfaceId, bottomPaneId, {
    bounds: { height: 400, width: 1200, x: 0, y: 400 },
  });
}

function seedSinglePaneSnapshot(core: SurfaceCore, surfaceId: string, paneId = 1): void {
  updateResolvedPaneSnapshot(core, surfaceId, paneId, {
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
  });
}

function updateResolvedPaneSnapshot(
  core: SurfaceCore,
  surfaceId: string,
  paneId: number,
  snapshot: Parameters<SurfaceCore["updatePaneSnapshot"]>[2],
): void {
  core.updatePaneSnapshot(surfaceId, paneId, {
    ...snapshot,
    ...core.resolvedPaneGeometryIdentity(surfaceId),
  });
}

async function waitForRendererPaneSet(core: SurfaceCore, surfaceId: string, paneIds: number[]): Promise<void> {
  const expected = new Set(paneIds);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const live = new Set(core.getRendererWindowState(surfaceId).panes.map((pane) => pane.paneId));
    if ([...expected].every((paneId) => live.has(paneId))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`renderer pane set did not include ${paneIds.join(",")}`);
}

async function waitForGeometryRevisionAfter(
  core: SurfaceCore,
  surfaceId: string,
  previousRevision: number,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (core.resolvedPaneGeometryIdentity(surfaceId).geometryRevision > previousRevision) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`renderer geometry revision did not advance after ${previousRevision}`);
}

async function waitForRendererConnectionBar(
  core: SurfaceCore,
  surfaceId: string,
  connectionBar: "connected" | "connecting" | "disconnected",
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (core.getRendererWindowState(surfaceId).connectionBar === connectionBar) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`renderer connection bar did not become ${connectionBar}`);
}

function assertRendererConnectionChrome(
  state: ReturnType<SurfaceCore["getRendererWindowState"]>,
  expected: "connected" | "connecting" | "disconnected",
  source: string,
): void {
  const { document } = parseHTML(`
    <div class="pane-label">
      <span class="pane-label__window"></span>
      <svg class="pane-label__disconnected"></svg>
      <span class="pane-label__number"></span>
    </div>
  `);
  const windowLabel = document.querySelector(".pane-label__window")!;
  const disconnectedGlyph = document.querySelector(".pane-label__disconnected")!;
  const paneLabel = document.querySelector(".pane-label__number")!;
  projectConnectionChrome(
    { disconnectedGlyph, paneLabel, windowLabel },
    state.connectionBar,
    Boolean(state.panes[0]?.displayId),
    Boolean(state.windowLabel),
  );

  assert.equal(state.connectionBar, expected, `${source}: authoritative state`);
  assert.equal(disconnectedGlyph.hasAttribute("hidden"), expected === "connected", `${source}: glyph`);
  assert.equal(paneLabel.hasAttribute("hidden"), expected !== "connected", `${source}: pane identity`);
  assert.equal(windowLabel.hasAttribute("hidden"), expected !== "connected", `${source}: window identity`);
  assert.equal(disconnectedGlyph.classList.contains("is-connecting"), expected === "connecting", `${source}: connecting class`);
  assert.equal(disconnectedGlyph.classList.contains("is-disconnected"), expected === "disconnected", `${source}: disconnected class`);
}

function contentApplyRequest(paneId: number, revision: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "content.apply",
    payload: {
      content: { markdown: "# Applied" },
      contentId: "ct_applied" as never,
      contentType: "markdown",
      historyOwnerToken: "hot_apply",
      paneId: paneId as never,
      revision: revision as never,
      topologyRevision: 7 as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function contentApplyClearRequest(paneId: number, revision: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "content.apply",
    payload: {
      clear: true,
      paneId: paneId as never,
      revision: revision as never,
      topologyRevision: 7 as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function targetApplyRequest(
  overrides: Partial<{
    ownershipEpoch: number;
    ownershipSessionId: string;
    paneLineageId: string;
    surfaceId: string;
  }> = {},
): Request {
  const surfaceId = overrides.surfaceId ?? "sf_test";
  const paneLineageId = overrides.paneLineageId ?? "pl_118";
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "target.apply",
    payload: {
      ownershipEpoch: overrides.ownershipEpoch ?? 1,
      ownershipSessionId: overrides.ownershipSessionId ?? "sa_test",
      paneLineageId,
      restoreReason: "resume_restore",
      requestId: "restore_top_118",
      surfaceId: surfaceId as never,
      targetEpoch: 3,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "launch_equivalent",
        requiredCapabilities: ["target.terminal_app.v1"],
        safeToLogFields: [],
        safetyClass: "process",
        summary: "top",
      },
      targetId: "target_top_118",
      targetKind: "terminal_app",
      targetPayload: { args: ["top"], command: "foot" },
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function nativeAppTargetApplyRequest(
  overrides: Partial<{
    appId: string;
    args: string[];
    ownershipEpoch: number;
    ownershipSessionId: string;
    paneLineageId: string;
    surfaceId: string;
    targetId: string;
  }> = {},
): Request {
  const appId = overrides.appId ?? "foot";
  const args = overrides.args ?? ["-e", "top"];
  const surfaceId = overrides.surfaceId ?? "sf_test";
  const paneLineageId = overrides.paneLineageId ?? "pl_118";
  const targetId = overrides.targetId ?? "target_native_118";
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "target.apply",
    payload: {
      ownershipEpoch: overrides.ownershipEpoch ?? 1,
      ownershipSessionId: overrides.ownershipSessionId ?? "sa_test",
      paneLineageId,
      restoreReason: "resume_restore",
      requestId: "restore_native_118",
      surfaceId: surfaceId as never,
      targetEpoch: 3,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "launch_equivalent",
        requiredCapabilities: ["target.native_app.v1"],
        safeToLogFields: [],
        safetyClass: "process",
        summary: [appId, ...args].join(" "),
      },
      targetId,
      targetKind: "native_app",
      targetPayload: { appId, args, launchMode: "new_instance" },
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function trustedRuntimeAppBinding(): RuntimeAppBindingDiagnostics {
  return {
    acknowledgement: "accepted",
    bindingAuthority: "trusted",
    bindingDegradedReasons: [],
    diagnosticDrift: [],
    expectedBundleId: null,
    expectedPackageName: "@surf-ace/electron",
    expectedRuntimeId: "surf-ace-runtime",
    launchTokenStatus: "matched",
    observedUiLabel: null,
    observedWaylandAppId: "@surf-ace/electron",
    observedWindowTitle: null,
    processLineageStatus: "matched",
    ready: true,
    reportedBundleId: null,
    reportedPackageName: "@surf-ace/electron",
    reportedRuntimeId: "surf-ace-runtime",
  };
}

function browserUrlTargetApplyRequest(
  options: {
    ownershipSessionId: string;
    ownershipEpoch?: number;
    paneLineageId: string;
    surfaceId: string;
    targetId?: string;
    url?: string;
  },
): Request {
  const targetUrl = options.url ?? "https://example.com/";
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "target.apply",
    payload: {
      ownershipEpoch: options.ownershipEpoch ?? 1,
      ownershipSessionId: options.ownershipSessionId as never,
      paneLineageId: options.paneLineageId as never,
      restoreReason: "initial_apply",
      requestId: "restore_url",
      surfaceId: options.surfaceId as never,
      targetEpoch: 3,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "navigate",
        requiredCapabilities: ["target.browser_url.v1"],
        safeToLogFields: ["url"],
        safetyClass: "network",
        summary: targetUrl,
      },
      targetId: options.targetId ?? "target_url",
      targetKind: "browser_url",
      targetPayload: { url: targetUrl },
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function paneSplitRequest(
  paneId: number,
  options: {
    count?: number;
    direction?: "horizontal" | "vertical";
    newPaneIds?: number[];
    newPaneLabels?: number[];
  } = {},
): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "pane.split",
    payload: {
      count: options.count ?? 2,
      direction: options.direction ?? "horizontal",
      newPaneIds: (options.newPaneIds ?? [2]).map((value) => value as never),
      newPaneLabels: options.newPaneLabels ?? [2],
      paneId: paneId as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function paneCloseRequest(paneId: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "pane.close",
    payload: { paneId: paneId as never },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function snapshotGetRequest(paneId: number): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "snapshot.get",
    payload: {
      includeDrawings: true,
      includeImage: false,
      includeVisibleText: true,
      paneId: paneId as never,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function heartbeatRequest(): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "heartbeat.ping",
    payload: {
      nonce: `hb_${Math.random().toString(16).slice(2)}`,
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function authorityStateRequest(
  paired: Extract<Response, { op: "pair.request"; ok: true }>,
  options: {
    actionable?: boolean;
    paneLabel?: number;
    panes?: Array<{ paneId: number; paneLabel: number; paneLineageId: string }>;
    reason?: string | null;
    windowLabel?: string;
  } = {},
): Request {
  const pane = paired.payload.state.panes[0]!;
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "authority.state",
    payload: {
      actionable: options.actionable ?? true,
      ownershipEpoch: paired.payload.ownershipEpoch,
      panes: options.panes ?? [{
        paneId: pane.paneId,
        paneLabel: options.paneLabel ?? pane.paneLabel,
        paneLineageId: pane.paneLineageId,
      }],
      providerId: "pv_alpha" as never,
      reason: options.reason ?? null,
      sessionId: paired.payload.sessionId,
      surfaceId: paired.payload.surfaceId,
      windowLabel: options.windowLabel ?? "a",
    },
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

function overlayDiagnosticsRequest(): Request {
  return {
    id: `rq_${Math.random().toString(16).slice(2)}` as never,
    op: "diagnostics.overlay_regions" as never,
    payload: {},
    sentAt: Date.now() as never,
    type: "request",
    v: 1,
  };
}

async function withServer(
  run: (ctx: { core: SurfaceCore; surfaceId: string; url: string; server: SurfaceWsServer }) => Promise<void>,
  options: {
    capturePaneImage?: (surfaceId: string, paneId: number) => Promise<string | null>;
    compositorSocketPath?: string | null;
    getRuntimeAppBinding?: () => Promise<RuntimeAppBindingDiagnostics | null> | RuntimeAppBindingDiagnostics | null;
    getOverlayDiagnostics?: (surfaceId: string) => Record<string, unknown> | null;
    nativeOverlayLivenessRetryCount?: number;
    nativeOverlayLivenessRetryDelayMs?: number;
    onNativeMaterialized?: (surfaceId: string) => void;
    onNativeReleased?: (surfaceId: string, paneIds: string[]) => void;
  } = {},
): Promise<void> {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: options.capturePaneImage ?? (async () => null),
    core,
    endpointName: "Surf Ace",
    getRuntimeAppBinding: options.getRuntimeAppBinding,
    getOverlayDiagnostics: options.getOverlayDiagnostics,
    hostName: "localhost",
    compositorSocketPath: options.compositorSocketPath ?? null,
    nativeOverlayLivenessRetryCount: options.nativeOverlayLivenessRetryCount,
    nativeOverlayLivenessRetryDelayMs: options.nativeOverlayLivenessRetryDelayMs,
    onNativeMaterialized: options.onNativeMaterialized,
    onNativeReleased: options.onNativeReleased,
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });

  await server.start();
  try {
    await run({
      core,
      server,
      surfaceId: surface.surfaceId,
      url: `ws://127.0.0.1:${port}${server.wsPath}`,
    });
  } finally {
    await server.stop();
  }
}

test("ws server snapshot.get captures explicit rendered pane image", async () => {
  const captureRequests: Array<{ paneId: number; surfaceId: string }> = [];
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const response = await request(owner, {
      ...snapshotGetRequest(1),
      payload: {
        includeDrawings: true,
        includeImage: true,
        includeVisibleText: true,
        paneId: 1 as never,
      },
    });

    assert.equal(response.ok, true);
    assert.equal(response.op, "snapshot.get");
    assert.equal(response.payload.paneId, 1);
    assert.equal(response.payload.image, "cG5nLWJ5dGVz");
    assert.deepEqual(captureRequests, [{ paneId: 1, surfaceId }]);

    await closeSocket(owner);
  }, {
    capturePaneImage: async (surfaceId, paneId) => {
      captureRequests.push({ paneId, surfaceId });
      return "cG5nLWJ5dGVz";
    },
  });
});

test("ws server keeps ownership lock after owner socket closes", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    assert.equal(first.payload.ownershipEpoch, 1);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const probe = await connect(url);
    const listed = await request(probe, surfacesListRequest());
    assert.equal(listed.ok, true);
    assert.equal(listed.op, "surfaces.list");
    assert.equal(listed.payload.surfaces[0]?.paired, true);
    await closeSocket(probe);
  });
});

test("ws server surfaces.list remains discovery-only before pairing", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const probe = await connect(url);
    try {
      const listed = await request(probe, surfacesListRequest());
      assert.equal(listed.ok, true);
      assert.equal(listed.op, "surfaces.list");

      const surface = listed.payload.surfaces.find((entry) => entry.surfaceId === surfaceId);
      assert.ok(surface);
      assert.equal("windowLabel" in surface, false);
      assert.equal("initialPaneId" in surface, false);
      assert.equal("initialPaneLabel" in surface, false);
    } finally {
      await closeSocket(probe);
    }
  });
});

test("ws server diagnostics format concise structured fields", () => {
  assert.equal(
    __test.serverDiagnostic("pair_request_begin", {
      provider_id: "pv_alpha",
      surface_id: "sf_main",
      takeover: false,
    }),
    "[surf-ace:server] event=pair_request_begin provider_id=pv_alpha surface_id=sf_main takeover=false",
  );
});

test("ws server browser_url diagnostics expose scheme host and port", () => {
  assert.deepEqual(
    __test.browserUrlDiagnosticFields("http://provider-a.example.test:18800/www/smoke-alarm/index.html"),
    {
      url: "http://provider-a.example.test:18800/www/smoke-alarm/index.html",
      url_host: "provider-a.example.test",
      url_port: "18800",
      url_scheme: "http",
    },
  );
  assert.deepEqual(
    __test.browserUrlDiagnosticFields("https://provider-a.example.test:19443/www/smoke-alarm/index.html"),
    {
      url: "https://provider-a.example.test:19443/www/smoke-alarm/index.html",
      url_host: "provider-a.example.test",
      url_port: "19443",
      url_scheme: "https",
    },
  );
});

test("ws server rejects human strings as provider-supplied visible window IDs", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    try {
      for (const label of ["DOCS", "portrait-display GRAPHICAL NATIVE"]) {
        const invalid = pairRequest(surfaceId, "pv_alpha");
        invalid.payload.windowLabel = label as never;

        const rejected = await request(socket, invalid);

        assert.equal(rejected.ok, false);
        assert.equal(rejected.op, "pair.request");
        assert.equal(rejected.error.code, "invalid_payload");
        assert.match(rejected.error.message, /windowLabel must be a lowercase alphabetic provider identity label/);
      }
    } finally {
      await closeSocket(socket);
    }
  });
});

test("ws server accepts provider window labels beyond zz", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const socket = await connect(url);
    try {
      const accepted = await request(socket, pairRequest(surfaceId, "pv_alpha", {
        windowLabel: "aaa",
      }));

      assert.equal(accepted.ok, true);
      assert.equal(accepted.op, "pair.request");
      assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "aaa");
    } finally {
      await closeSocket(socket);
    }
  });
});

test("ws server rejects invalid provider bootstrap without leaving an ownership lock", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    try {
      const invalid = pairRequest(surfaceId, "pv_alpha", {
        initialPaneId: 0,
        initialPaneLabel: 1,
        windowLabel: "a",
      });

      const rejected = await request(socket, invalid);

      assert.equal(rejected.ok, false);
      assert.equal(rejected.op, "pair.request");
      assert.equal(rejected.error.code, "invalid_payload");

      const listed = await request(socket, surfacesListRequest());
      assert.equal(listed.ok, true);
      assert.equal(listed.payload.surfaces.find((entry) => entry.surfaceId === surfaceId)?.paired, false);
    } finally {
      await closeSocket(socket);
    }
  });
});

test("ws server does not commit pair ownership when pair.response is not delivered", async () => {
  await withServer(async ({ server, surfaceId, url }) => {
    const originalReply = (server as unknown as {
      reply: (socket: WebSocket, response: Response) => Promise<boolean>;
    }).reply.bind(server);
    let dropPairResponse = true;
    (server as unknown as {
      reply: (socket: WebSocket, response: Response) => Promise<boolean>;
    }).reply = async (socket: WebSocket, response: Response) => {
      if (dropPairResponse && response.op === "pair.request" && response.ok) {
        dropPairResponse = false;
        return false;
      }
      return await originalReply(socket, response);
    };

    const owner = await connect(url);
    owner.send(JSON.stringify(pairRequest(surfaceId, "pv_alpha")));
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const probe = await connect(url);
    const listed = await request(probe, surfacesListRequest());
    assert.equal(listed.ok, true);
    assert.equal(listed.op, "surfaces.list");
    assert.equal(listed.payload.surfaces.find((entry) => entry.surfaceId === surfaceId)?.paired, false);

    await closeSocket(probe);
    await closeSocket(owner);
  });
});

test("ws server rejects invalid topology.apply authority payloads before provider relabel", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    try {
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const invalid = topologyApplyRequest();
      invalid.payload.windowLabel = "docs" as never;
      invalid.payload.panes[1]!.paneLabel = 41;

      const rejected = await request(owner, invalid);

      assert.equal(rejected.ok, false);
      assert.equal(rejected.op, "topology.apply");
      assert.equal(rejected.error.code, "invalid_payload");
      assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "a");
    } finally {
      await closeSocket(owner);
    }
  });
});

test("ws server adopts provider window relabels on topology.apply", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    try {
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha", {
        windowLabel: "h",
      }));
      assert.equal(paired.ok, true);
      assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "h");

      const rejectedRelabel = topologyApplyRequest();
      rejectedRelabel.payload.windowLabel = "a";
      rejectedRelabel.payload.panes[1]!.paneLabel = 41;

      const rejected = await request(owner, rejectedRelabel);

      assert.equal(rejected.ok, false);
      assert.equal(rejected.op, "topology.apply");
      assert.equal(rejected.error.code, "invalid_payload");
      assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "h");

      const relabeled = topologyApplyRequest();
      relabeled.payload.windowLabel = "a";

      const acceptedPromise = request(owner, relabeled);
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const accepted = await acceptedPromise;

      assert.equal(accepted.ok, true);
      assert.equal(accepted.op, "topology.apply");
      assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "a");
    } finally {
      await closeSocket(owner);
    }
  });
});

test("ws server adopts provider window relabels on resumed pair", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha", {
      windowLabel: "h",
    }));
    assert.equal(first.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "h");
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const resumedSocket = await connect(url);
    const resumed = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", {
        resumeSessionId: first.payload.sessionId,
        windowLabel: "a",
      }),
    );

    assert.equal(resumed.ok, true);
    assert.equal(resumed.op, "pair.request");
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.sessionId, first.payload.sessionId);
    assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "a");

    await closeSocket(resumedSocket);
  });
});

test("ws server allows the lock owner to resume after disconnect", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const resumedSocket = await connect(url);
    const resumed = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", { resumeSessionId: first.payload.sessionId }),
    );

    assert.equal(resumed.ok, true);
    assert.equal(resumed.op, "pair.request");
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.sessionId, first.payload.sessionId);
    assert.equal(resumed.payload.ownershipEpoch, first.payload.ownershipEpoch);

    await closeSocket(resumedSocket);
  });
});

test("ws server keeps visible pane content during passive provider absence and obeys explicit clear", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    const pane = first.payload.state.panes[0]!;
    const applied = await request(owner, contentApplyRequest(Number(pane.paneId), 1));
    assert.equal(applied.ok, true);
    assert.equal(core.pairState(surfaceId).panes[0]?.currentContentId, "ct_applied");

    await closeSocket(owner, 1000, "provider_shutdown");
    await waitForRendererConnectionBar(core, surfaceId, "disconnected");

    assert.equal(core.pairState(surfaceId).panes[0]?.currentContentId, "ct_applied");

    const replacement = await connect(url);
    const admitted = await request(
      replacement,
      pairRequest(surfaceId, "pv_alpha", {
        initialPaneId: 77,
        initialPaneLabel: 77,
      }),
    );
    assert.equal(admitted.ok, true);
    assert.equal(admitted.op, "pair.request");
    assert.equal(admitted.payload.state.panes[0]?.paneId, pane.paneId);
    assert.equal(admitted.payload.state.panes[0]?.currentContentId, "ct_applied");

    const cleared = await request(replacement, contentClearRequest(Number(pane.paneId), 2));
    assert.equal(cleared.ok, true);
    assert.equal(core.pairState(surfaceId).panes[0]?.currentContentId, null);

    await closeSocket(replacement);
  });
});

test("ws server recovers a resume-bearing admission after relaunch without clearing restored topology", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    const topologyPromise = request(owner, topologyApplyRequest());
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId, 1, 2);
    const topology = await topologyPromise;
    assert.equal(topology.ok, true);
    const content = await request(owner, contentApplyRequest(2, 1));
    assert.equal(content.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    server.disconnectSurface(surfaceId, "test_relaunch");

    const resumedSocket = await connect(url);
    const resumed = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", {
        initialPaneId: 7,
        initialPaneLabel: 77,
        resumeSessionId: first.payload.sessionId,
      }),
    );

    assert.equal(resumed.ok, true);
    assert.equal(resumed.op, "pair.request");
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.sessionId, first.payload.sessionId);
    assert.deepEqual(
      resumed.payload.state.panes.map((pane) => pane.paneId),
      [1, 2],
    );
    assert.equal(resumed.payload.state.panes[1]?.currentContentId, "ct_applied");
    assert.deepEqual(core.pairState(surfaceId).layout, {
      children: [
        { paneId: 1, type: "pane" },
        { paneId: 2, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    });

    await closeSocket(resumedSocket);
  });
});

test("ws server rejects lockless invalid resume without clearing restored topology", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    const topologyPromise = request(owner, topologyApplyRequest());
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId, 1, 2);
    const topology = await topologyPromise;
    assert.equal(topology.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    server.disconnectSurface(surfaceId, "test_relaunch");

    const resumedSocket = await connect(url);
    const rejected = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", {
        initialPaneId: 7,
        initialPaneLabel: 77,
        resumeSessionId: "sa_invalid",
      }),
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "invalid_resume");
    assert.deepEqual(core.pairState(surfaceId).layout, {
      children: [
        { paneId: 1, type: "pane" },
        { paneId: 2, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    });

    await closeSocket(resumedSocket);
  });
});

test("ws server admits lockless same-provider admission without clearing restored topology", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    const topologyPromise = request(owner, topologyApplyRequest());
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId, 1, 2);
    const topology = await topologyPromise;
    assert.equal(topology.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    server.disconnectSurface(surfaceId, "test_relaunch");

    const replacement = await connect(url);
    const replacementResponse = await request(
      replacement,
      pairRequest(surfaceId, "pv_alpha", {
        initialPaneId: 7,
        initialPaneLabel: 77,
      }),
    );

    assert.equal(replacementResponse.ok, true);
    assert.equal(replacementResponse.op, "pair.request");
    assert.equal(replacementResponse.payload.resumed, false);
    assert.notEqual(replacementResponse.payload.sessionId, first.payload.sessionId);
    assert.equal(replacementResponse.payload.ownershipEpoch, first.payload.ownershipEpoch + 1);
    assert.deepEqual(
      replacementResponse.payload.state.panes.map((pane) => pane.paneId),
      [1, 2],
    );
    assert.deepEqual(core.pairState(surfaceId).layout, {
      children: [
        { paneId: 1, type: "pane" },
        { paneId: 2, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    });

    await closeSocket(replacement);
  });
});

test("ws server rejects lockless foreign provider resume without clearing restored topology", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    const topologyPromise = request(owner, topologyApplyRequest());
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId, 1, 2);
    const topology = await topologyPromise;
    assert.equal(topology.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    server.disconnectSurface(surfaceId, "test_relaunch");

    const resumedSocket = await connect(url);
    const rejected = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_bravo", {
        initialPaneId: 7,
        initialPaneLabel: 77,
        resumeSessionId: first.payload.sessionId,
      }),
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "busy");
    assert.deepEqual(core.pairState(surfaceId).layout, {
      children: [
        { paneId: 1, type: "pane" },
        { paneId: 2, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    });

    await closeSocket(resumedSocket);
  });
});

test("ws server recovers persisted provider ownership after serialized relaunch restore", async () => {
  let persistedState: ReturnType<SurfaceCore["getPersistentState"]> | null = null;
  let restoredSurfaceId = "";
  let restoredSessionId = "";

  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    restoredSurfaceId = surfaceId;
    restoredSessionId = first.payload.sessionId;
    const topologyPromise = request(owner, topologyApplyRequest());
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId, 1, 2);
    const topology = await topologyPromise;
    assert.equal(topology.ok, true);
    const content = await request(owner, contentApplyRequest(2, 1));
    assert.equal(content.ok, true);
    persistedState = core.getPersistentState();
    await closeSocket(owner, 1000, "provider_shutdown");
  });

  assert.ok(persistedState);
  const restoredCore = new SurfaceCore({ persistentState: persistedState });
  const restoredSurfaces = restoredCore.restorePersistedSurfaces("Surf Ace", { height: 800, scale: 2, width: 1200 });
  assert.equal(restoredSurfaces.some((surface) => surface.surfaceId === restoredSurfaceId), true);

  const port = nextPort++;
  const server = new SurfaceWsServer({
    capturePaneImage: async () => null,
    core: restoredCore,
    endpointName: "Surf Ace",
    hostName: "localhost",
    compositorSocketPath: null,
    port,
    viewport: () => ({ height: 800, scale: 2, width: 1200 }),
  });

  await server.start();
  try {
    let socket: WebSocket | null = null;
    let resumed: Response | null = null;
    let listed: Response | null = null;
    const lines = await captureInfoLines(async () => {
      socket = await connect(`ws://127.0.0.1:${port}${server.wsPath}`);
      resumed = await request(
        socket,
        pairRequest(restoredSurfaceId, "pv_alpha", {
          initialPaneId: 7,
          initialPaneLabel: 77,
          resumeSessionId: restoredSessionId,
        }),
      );
      listed = await request(socket, {
        id: "rq_panes_after_relaunch" as never,
        op: "panes.list",
        payload: {},
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
    });

    assert.ok(resumed);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.op, "pair.request");
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.sessionId, restoredSessionId);
    assert.deepEqual(
      resumed.payload.state.panes.map((pane) => pane.paneId),
      [1, 2],
    );
    assert.equal(resumed.payload.state.panes[1]?.currentContentId, "ct_applied");
    assert.deepEqual(
      resumed.payload.state.panes.map((pane) => pane.paneLabel),
      [41, 42],
    );
    assert.deepEqual(resumed.payload.state.layout, {
      children: [
        { paneId: 1, type: "pane" },
        { paneId: 2, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    });

    assert.ok(listed);
    assert.equal(listed.ok, true);
    assert.equal(listed.op, "panes.list");
    assert.deepEqual(
      listed.payload.panes.map((pane) => [pane.paneId, pane.paneLabel, pane.activeContentId]),
      [[1, 41, null], [2, 42, "ct_applied"]],
    );
    assert.ok(lines.some((line) =>
      line.includes("event=pair_recoverable_state_decision") &&
      line.includes("result=true") &&
      line.includes("pane_count=2") &&
      line.includes("pair_state=") &&
      line.includes("2:42:ct_applied")
    ));
    assert.ok(lines.some((line) =>
      line.includes("event=pair_response_ok") &&
      line.includes("pane_count=2") &&
      line.includes("pane_ids=1,2") &&
      line.includes("pane_labels=41,42") &&
      line.includes("pair_state=")
    ));
    assert.ok(lines.some((line) =>
      line.includes("event=panes_list_summary") &&
      line.includes("pane_count=2") &&
      line.includes("pane_ids=1,2") &&
      line.includes("pane_labels=41,42") &&
      line.includes("pane_content_ids=nil,ct_applied")
    ));

    if (socket) {
      await closeSocket(socket);
    }
  } finally {
    await server.stop();
  }
});

test("ws server re-admits same-provider reconnect with an invalid resume token", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    const topologyPromise = request(owner, topologyApplyRequest());
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId, 1, 2);
    const topology = await topologyPromise;
    assert.equal(topology.ok, true);
    const content = await request(owner, contentApplyRequest(2, 1));
    assert.equal(content.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const resumedSocket = await connect(url);
    const invalid = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", {
        initialPaneId: 7,
        initialPaneLabel: 77,
        resumeSessionId: `sa_invalid` as never,
      }),
    );

    assert.equal(invalid.ok, true);
    assert.equal(invalid.op, "pair.request");
    assert.equal(invalid.payload.resumed, false);
    assert.notEqual(invalid.payload.sessionId, first.payload.sessionId);
    assert.equal(invalid.payload.ownershipEpoch, first.payload.ownershipEpoch + 1);
    assert.deepEqual(
      invalid.payload.state.panes.map((pane) => pane.paneId),
      [1, 2],
    );
    assert.equal(invalid.payload.state.panes[1]?.currentContentId, "ct_applied");
    assert.deepEqual(invalid.payload.state.layout, {
      children: [
        { paneId: 1, type: "pane" },
        { paneId: 2, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    });
    assert.deepEqual(core.pairState(surfaceId).layout, {
      children: [
        { paneId: 1, type: "pane" },
        { paneId: 2, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    });

    await closeSocket(resumedSocket);
  });
});

test("ws server fresh same-provider admission clears native-hosted state for the same initial pane", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(first.ok, true);
      const pane = first.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));
      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: first.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: first.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      await closeSocket(owner, 1000, "provider_shutdown");

      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });

      const replacement = await connect(url);
      const admitted = await request(
        replacement,
        pairRequest(surfaceId, "pv_alpha", {
          initialPaneId: Number(pane.paneId),
          initialPaneLabel: 42,
          resumeSessionId: `sa_invalid` as never,
        }),
      );

      assert.equal(admitted.ok, true);
      assert.equal(admitted.payload.resumed, false);
      assert.equal(admitted.payload.state.panes.length, 1);
      assert.equal(admitted.payload.state.panes[0]?.paneId, pane.paneId);
      assert.equal(admitted.payload.state.panes[0]?.paneLabel, 42);
      assert.equal(admitted.payload.state.panes[0]?.currentContentId, null);
      const rendererPane = core.getRendererWindowState(surfaceId).panes[0]!;
      assert.equal(rendererPane.externalNative, false);
      assert.equal(rendererPane.content.contentType, null);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);
      assert.deepEqual(received[3], {
        pane_ids: [String(pane.paneId)],
        type: "native_pane.release",
      });

      await closeSocket(replacement);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server re-admits same-provider reconnects without a resume token after disconnect", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const replacement = await connect(url);
    const resumed = await request(
      replacement,
      pairRequest(surfaceId, "pv_alpha"),
    );

    assert.equal(resumed.ok, true);
    assert.equal(resumed.op, "pair.request");
    assert.equal(resumed.payload.resumed, false);
    assert.notEqual(resumed.payload.sessionId, first.payload.sessionId);
    assert.equal(resumed.payload.ownershipEpoch, first.payload.ownershipEpoch + 1);

    await closeSocket(replacement);
  });
});

test("ws server allows explicit same-provider takeover of a disconnected stale lock", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const replacement = await connect(url);
    const reclaimed = await request(
      replacement,
      pairRequest(surfaceId, "pv_alpha", { takeover: true }),
    );

    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.op, "pair.request");
    assert.equal(reclaimed.payload.resumed, false);
    assert.notEqual(reclaimed.payload.sessionId, first.payload.sessionId);
    assert.equal(reclaimed.payload.ownershipEpoch, first.payload.ownershipEpoch + 1);

    await closeSocket(replacement);
  });
});

test("ws server allows explicit same-provider takeover without the old resume session while the old socket is active", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const takeover = await connect(url);
    const superseded = new Promise<{ code: number; reason: string }>((resolve) => {
      owner.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    const second = await request(
      takeover,
      pairRequest(surfaceId, "pv_alpha", { takeover: true }),
    );

    assert.equal(second.ok, true);
    assert.equal(second.op, "pair.request");
    assert.equal(second.payload.resumed, false);
    assert.notEqual(second.payload.sessionId, first.payload.sessionId);
    assert.equal(second.payload.ownershipEpoch, first.payload.ownershipEpoch + 1);
    assert.deepEqual(await superseded, { code: 1000, reason: "superseded" });

    await closeSocket(takeover);
  });
});

test("ws server lets same-provider reconnect without resume supersede an active socket", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const duplicate = await connect(url);
    const ownerClosed = waitForSocketClose(owner);
    const admitted = await request(duplicate, pairRequest(surfaceId, "pv_alpha"));

    assert.equal(admitted.ok, true);
    assert.equal(admitted.op, "pair.request");
    assert.equal(admitted.payload.resumed, false);
    assert.notEqual(admitted.payload.sessionId, first.payload.sessionId);
    assert.equal(admitted.payload.ownershipEpoch, first.payload.ownershipEpoch + 1);
    assert.deepEqual(await ownerClosed, { code: 1000, reason: "superseded" });

    const panes = await request(duplicate, {
      id: `rq_${Math.random().toString(16).slice(2)}` as never,
      op: "panes.list",
      payload: {},
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    });
    assert.equal(panes.ok, true);
    assert.equal(panes.op, "panes.list");

    await closeSocket(duplicate);
  });
});

test("ws server resumes same-provider pair requests with a valid resume token while the old socket is active", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const ownerClosed = waitForSocketClose(owner);
    const resumedSocket = await connect(url);
    const resumed = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", { resumeSessionId: first.payload.sessionId }),
    );

    assert.equal(resumed.ok, true);
    assert.equal(resumed.op, "pair.request");
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.sessionId, first.payload.sessionId);
    assert.equal(resumed.payload.ownershipEpoch, first.payload.ownershipEpoch);
    assert.deepEqual(await ownerClosed, { code: 1000, reason: "superseded" });

    await closeSocket(resumedSocket);
  });
});

test("ws server rejects foreign providers without takeover while locked", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const foreign = await connect(url);
    const busy = await request(foreign, pairRequest(surfaceId, "pv_bravo"));

    assert.equal(busy.ok, false);
    assert.equal(busy.op, "pair.request");
    assert.equal(busy.error.code, "busy");

    await closeSocket(foreign);
  });
});

test("ws server accepts explicit takeover from a different provider while locked", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);
    await closeSocket(owner, 1000, "provider_shutdown");

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const takeover = await connect(url);
    const second = await request(
      takeover,
      pairRequest(surfaceId, "pv_bravo", { takeover: true }),
    );

    assert.equal(second.ok, true);
    assert.equal(second.op, "pair.request");
    assert.equal(second.payload.resumed, false);
    assert.notEqual(second.payload.sessionId, first.payload.sessionId);

    await closeSocket(takeover);
  });
});

test("ws server scopes explicit takeover to the requested surface only", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const otherSurface = core.createAdditionalSurface("Surf Ace B", { height: 700, scale: 2, width: 1000 });
    const ownerA = await connect(url);
    const firstA = await request(ownerA, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(firstA.ok, true);
    const ownerB = await connect(url);
    const firstB = await request(
      ownerB,
      pairRequest(otherSurface.surfaceId, "pv_alpha", {
        windowLabel: "b",
      }),
    );
    assert.equal(firstB.ok, true);

    const takeoverA = await connect(url);
    const supersededA = new Promise<{ code: number; reason: string }>((resolve) => {
      ownerA.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    const secondA = await request(
      takeoverA,
      pairRequest(surfaceId, "pv_bravo", { takeover: true }),
    );

    assert.equal(secondA.ok, true);
    assert.notEqual(secondA.payload.sessionId, firstA.payload.sessionId);
    assert.deepEqual(await supersededA, { code: 1000, reason: "superseded" });
    assert.equal(ownerB.readyState, WebSocket.OPEN);

    const panesB = await request(ownerB, {
      id: `rq_${Math.random().toString(16).slice(2)}` as never,
      op: "panes.list",
      payload: {},
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    });
    assert.equal(panesB.ok, true);
    assert.equal(panesB.op, "panes.list");

    await closeSocket(takeoverA);
    await closeSocket(ownerB);
  });
});

test("ws server rejects duplicate-label takeover before detaching the active owner", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const otherSurface = core.createAdditionalSurface("Surf Ace B", { height: 700, scale: 2, width: 1000 });
    const ownerA = await connect(url);
    const firstA = await request(ownerA, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(firstA.ok, true);

    const ownerB = await connect(url);
    const firstB = await request(
      ownerB,
      pairRequest(otherSurface.surfaceId, "pv_alpha", {
        windowLabel: "b",
      }),
    );
    assert.equal(firstB.ok, true);

    const takeoverB = await connect(url);
    const rejected = await request(
      takeoverB,
      pairRequest(otherSurface.surfaceId, "pv_bravo", {
        takeover: true,
        windowLabel: "a",
      }),
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "invalid_payload");
    assert.match(rejected.error.message, /Duplicate windowLabel in live surface set: a/);
    assert.equal(ownerB.readyState, WebSocket.OPEN);

    const panesB = await request(ownerB, {
      id: `rq_${Math.random().toString(16).slice(2)}` as never,
      op: "panes.list",
      payload: {},
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    });
    assert.equal(panesB.ok, true);
    assert.equal(core.getRendererWindowState(otherSurface.surfaceId).windowLabel, "b");

    await closeSocket(takeoverB);
    await closeSocket(ownerB);
    await closeSocket(ownerA);
  });
});

test("ws server clears the ownership lock on ownership.relinquish", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const relinquished = await request(owner, relinquishRequest());
    assert.equal(relinquished.ok, true);
    assert.equal(relinquished.op, "ownership.relinquish");
    assert.equal(relinquished.payload.relinquished, true);

    await new Promise((resolve) => {
      owner.once("close", () => resolve(undefined));
    });

    const probe = await connect(url);
    const listed = await request(probe, surfacesListRequest());
    assert.equal(listed.ok, true);
    assert.equal(listed.payload.surfaces[0]?.paired, false);
    await closeSocket(probe);
  });
});

test("ws server exposes providerName while connected and clears it on relinquish", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha", { providerName: "OpenClaw / Surf Ace" }));
    assert.equal(paired.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connecting");
    assert.equal(core.getRendererWindowState(surfaceId).providerName, "OpenClaw / Surf Ace");

    const heartbeat = await request(owner, heartbeatRequest());
    assert.equal(heartbeat.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connecting");

    const authority = await request(owner, authorityStateRequest(paired as Extract<Response, { op: "pair.request"; ok: true }>));
    assert.equal(authority.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");

    const relinquished = await request(owner, relinquishRequest());
    assert.equal(relinquished.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).providerName, null);

    await closeSocket(owner);
  });
});

test("production connection sources project the complete mutually exclusive chrome matrix", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    assertRendererConnectionChrome(core.getRendererWindowState(surfaceId), "disconnected", "unadmitted");

    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    assertRendererConnectionChrome(core.getRendererWindowState(surfaceId), "connecting", "pair connecting");

    const notActionable = await request(
      owner,
      authorityStateRequest(paired as Extract<Response, { op: "pair.request"; ok: true }>, {
        actionable: false,
        reason: "provider_not_actionable",
      }),
    );
    assert.equal(notActionable.ok, true);
    assert.equal(notActionable.op, "authority.state");
    assert.equal(notActionable.payload.accepted, false);
    assertRendererConnectionChrome(core.getRendererWindowState(surfaceId), "connecting", "authority not actionable");

    const accepted = await request(
      owner,
      authorityStateRequest(paired as Extract<Response, { op: "pair.request"; ok: true }>),
    );
    assert.equal(accepted.ok, true);
    assertRendererConnectionChrome(core.getRendererWindowState(surfaceId), "connected", "push capable");

    const staleWindow = core.createAdditionalSurface("Surf Ace B", { height: 800, scale: 2, width: 1200 });
    assertRendererConnectionChrome(core.getRendererWindowState(surfaceId), "connected", "same client admitted window");
    assertRendererConnectionChrome(core.getRendererWindowState(staleWindow.surfaceId), "disconnected", "same client stale window");

    await closeSocket(owner, 1001, "network_lost");
    await waitForRendererConnectionBar(core, surfaceId, "disconnected");
    assertRendererConnectionChrome(core.getRendererWindowState(surfaceId), "disconnected", "socket not open");

    server.disconnectSurface(surfaceId, "gave_up");
    assertRendererConnectionChrome(core.getRendererWindowState(surfaceId), "disconnected", "gave up");

    const restoredCore = new SurfaceCore({ persistentState: core.getPersistentState() });
    const restored = restoredCore.restorePersistedSurfaces("Surf Ace", { height: 800, scale: 2, width: 1200 });
    const restoredSurface = restored.find((surface) => surface.surfaceId === surfaceId)!;
    assert.ok(restoredSurface);
    assertRendererConnectionChrome(restoredCore.getRendererWindowState(surfaceId), "disconnected", "restored");
  });
});

test("ws server clears green connection bar when accepted provider socket closes", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha", { providerName: "OpenClaw / Surf Ace" }));
    assert.equal(paired.ok, true);

    const authority = await request(owner, authorityStateRequest(paired as Extract<Response, { op: "pair.request"; ok: true }>));
    assert.equal(authority.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");
    assert.equal(core.getRendererWindowState(surfaceId).providerName, "OpenClaw / Surf Ace");

    await closeSocket(owner, 1001, "network_lost");
    await waitForRendererConnectionBar(core, surfaceId, "disconnected");

    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "disconnected");
    assert.equal(core.getRendererWindowState(surfaceId).providerName, null);
  });
});

test("ws server adopts provider authority pane identity before showing green", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connecting");

    const heartbeat = await request(owner, heartbeatRequest());
    assert.equal(heartbeat.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connecting");

    const providerPane = core.pairState(surfaceId).panes[0]!;
    const repairedAuthority = await request(owner, authorityStateRequest(
      paired as Extract<Response, { op: "pair.request"; ok: true }>,
      {
        panes: [{
          paneId: Number(providerPane.paneId),
          paneLabel: 99,
          paneLineageId: "pl_authority_provider_truth",
        }],
      },
    ));
    assert.equal(repairedAuthority.ok, true);
    assert.equal(repairedAuthority.op, "authority.state");
    assert.equal(repairedAuthority.payload.accepted, true);
    assert.equal(core.pairState(surfaceId).panes[0]?.paneLabel, 99);
    assert.equal(core.pairState(surfaceId).panes[0]?.paneLineageId, "pl_authority_provider_truth");
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");
    assert.equal(core.getRendererWindowState(surfaceId).providerName, "test-harness");

    const acceptedAuthority = await request(owner, authorityStateRequest(paired as Extract<Response, { op: "pair.request"; ok: true }>));
    assert.equal(acceptedAuthority.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");
    assert.equal(core.getRendererWindowState(surfaceId).providerName, "test-harness");

    await closeSocket(owner);
  });
});

test("ws server applies adopted native pane identity from one resolved snapshot revision", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: Array<Record<string, unknown>> = [];
  const compositor = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const message = JSON.parse(String(chunk).trim()) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 800,
              logical_surface_width: 1200,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          }
        : { ok: true })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));
      const applied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(applied.ok, true);

      received.length = 0;
      const beforeRevision = core.resolvedPaneGeometryIdentity(surfaceId).geometryRevision;
      const adoptedLineageId = "pl_authority_native_truth";
      const authorityPromise = request(owner, authorityStateRequest(
        paired as Extract<Response, { op: "pair.request"; ok: true }>,
        {
          panes: [{
            paneId: Number(pane.paneId),
            paneLabel: pane.paneLabel,
            paneLineageId: adoptedLineageId,
          }],
        },
      ));
      await waitForGeometryRevisionAfter(core, surfaceId, beforeRevision);
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));
      const authority = await authorityPromise;
      assert.equal(authority.ok, true);
      assert.equal(authority.payload.accepted, true);

      assert.deepEqual(received.map((message) => message.type), [
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const listedGeometry = core.panesList(surfaceId).panes[0]!.geometry;
      assert.ok(!("geometryUnavailable" in listedGeometry));
      const nativeGeometry = (received[1] as { panes: Array<{ geometry: { geometryRevision: number; paneInstanceId: string } }> })
        .panes[0]!.geometry;
      const overlay = received[2] as {
        regions: Array<{ rect: { height: number; width: number; x: number; y: number } }>;
        revision: number;
      };
      assert.equal(nativeGeometry.geometryRevision, listedGeometry.geometryRevision);
      assert.equal(nativeGeometry.paneInstanceId, adoptedLineageId);
      assert.equal(overlay.revision, listedGeometry.geometryRevision);
      assert.deepEqual(overlay.regions[0]!.rect, listedGeometry.contentViewport);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server accepts provider authority panes independent of order", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const topology = topologyApplyRequest();
    topology.payload.layout = {
      children: [
        { paneId: 2 as never, type: "pane" },
        { paneId: 1 as never, type: "pane" },
      ],
      direction: "vertical",
      type: "split",
    };
    const topologyPromise = request(owner, topology);
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId, 2, 1);
    const applied = await topologyPromise;
    assert.equal(applied.ok, true);

    const pairStatePanes = core.pairState(surfaceId).panes;
    assert.deepEqual(new Set(pairStatePanes.map((pane) => pane.paneId)), new Set([1, 2]));
    const duplicatePane = pairStatePanes[0]!;
    const duplicateAuthority = await request(owner, authorityStateRequest(
      paired as Extract<Response, { op: "pair.request"; ok: true }>,
      {
        panes: [duplicatePane, duplicatePane].map((pane) => ({
          paneId: Number(pane.paneId),
          paneLabel: pane.paneLabel,
          paneLineageId: pane.paneLineageId,
        })),
      },
    ));
    assert.equal(duplicateAuthority.ok, true);
    assert.equal(duplicateAuthority.op, "authority.state");
    assert.equal(duplicateAuthority.payload.accepted, true);
    assert.equal(duplicateAuthority.payload.reason, null);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");

    const providerOrderedPanes = [...pairStatePanes].reverse().map((pane) => ({
      paneId: Number(pane.paneId),
      paneLabel: pane.paneLabel,
      paneLineageId: pane.paneLineageId,
    }));
    const authority = await request(owner, authorityStateRequest(
      paired as Extract<Response, { op: "pair.request"; ok: true }>,
      { panes: providerOrderedPanes },
    ));

    assert.equal(authority.ok, true);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");

    await closeSocket(owner);
  });
});

test("ws server repairs same-session provider window label disagreement at authority state", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    core.applyWindowLabelOnly(surfaceId, "b");
    assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "b");

    const authority = await request(owner, authorityStateRequest(
      paired as Extract<Response, { op: "pair.request"; ok: true }>,
      { windowLabel: "a" },
    ));

    assert.equal(authority.ok, true);
    assert.equal(authority.op, "authority.state");
    assert.equal(authority.payload.accepted, true);
    assert.equal(authority.payload.reason, null);
    assert.equal(core.getRendererWindowState(surfaceId).windowLabel, "a");
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");

    await closeSocket(owner);
  });
});

test("ws server accepts same-provider authority when session metadata is stale", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const staleAuthority = authorityStateRequest(paired as Extract<Response, { op: "pair.request"; ok: true }>);
    staleAuthority.payload.sessionId = `sa_stale` as never;
    staleAuthority.payload.ownershipEpoch = 0 as never;
    const accepted = await request(owner, staleAuthority);

    assert.equal(accepted.ok, true);
    assert.equal(accepted.op, "authority.state");
    assert.equal(accepted.payload.accepted, true);
    assert.equal(accepted.payload.reason, null);
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");

    await closeSocket(owner);
  });
});

test("ws server repairs same-session provider pane label and lineage disagreement at authority state", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const pane = core.pairState(surfaceId).panes[0]!;
    const authority = await request(owner, authorityStateRequest(
      paired as Extract<Response, { op: "pair.request"; ok: true }>,
      {
        panes: [{
          paneId: Number(pane.paneId),
          paneLabel: pane.paneLabel + 10,
          paneLineageId: "pl_provider_truth",
        }],
      },
    ));

    assert.equal(authority.ok, true);
    assert.equal(authority.op, "authority.state");
    assert.equal(authority.payload.accepted, true);
    assert.equal(authority.payload.reason, null);
    assert.equal(core.pairState(surfaceId).panes[0]?.paneLabel, pane.paneLabel + 10);
    assert.equal(core.pairState(surfaceId).panes[0]?.paneLineageId, "pl_provider_truth");
    assert.equal(core.getRendererWindowState(surfaceId).connectionBar, "connected");

    await closeSocket(owner);
  });
});

test("ws server still blocks a different provider while a surface is owned", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const foreign = await connect(url);
    const rejected = await request(foreign, pairRequest(surfaceId, "pv_beta"));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.op, "pair.request");
    assert.equal(rejected.error.code, "busy");

    await closeSocket(owner);
    await closeSocket(foreign);
  });
});

test("ws server rejects pair requests without providerName", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    const rejected = await request(socket, pairRequest(surfaceId, "pv_alpha", { providerName: null }));

    assert.equal(rejected.ok, false);
    assert.equal(rejected.op, "pair.request");
    assert.equal(rejected.error.code, "missing_provider_name");

    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
  });
});

test("ws server advertises terminal targets when compositor bridge is configured", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));

    assert.equal(paired.ok, true);
    assert.deepEqual(paired.payload.capabilities.protocolFeatures, ["authority.state.v1"]);
    assert.deepEqual(paired.payload.capabilities.targetCapabilities, ["target.browser_url.v1", "target.native_app.v1"]);

    await closeSocket(socket);
  }, { compositorSocketPath: "/tmp/surf-ace-compositor-test.sock" });
});

test("ws server rejects target.apply with stale ownership epoch", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const owner = await connect(url);
    const first = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(first.ok, true);

    const takeover = await connect(url);
    const second = await request(takeover, pairRequest(surfaceId, "pv_alpha", { takeover: true }));
    assert.equal(second.ok, true);

    const rejected = await request(takeover, targetApplyRequest({
      ownershipEpoch: first.payload.ownershipEpoch,
      ownershipSessionId: second.payload.sessionId,
      paneLineageId: second.payload.state.panes[0]!.paneLineageId,
      surfaceId: second.payload.surfaceId,
    }));

    assert.equal(rejected.ok, true);
    assert.equal(rejected.op, "target.apply.result");
    assert.equal(rejected.payload.status, "rejected");
    assert.equal(rejected.payload.errorCode, "ownership_epoch_mismatch");

    await closeSocket(takeover);
  });
});

test("ws server returns browser_url applied only after renderer load confirmation", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    assert.deepEqual(paired.payload.capabilities.protocolFeatures, ["authority.state.v1"]);
    assert.deepEqual(paired.payload.capabilities.targetCapabilities, ["target.browser_url.v1"]);

    const apply = browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_example",
      url: "https://example.com/",
    });
    const responsePromise = request(owner, apply);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentType, "browser_url");

    server.resolveBrowserUrlNavigation(surfaceId, Number(paired.payload.state.panes[0]!.paneId), {
      status: "applied",
      targetId: "target_example",
      url: "https://example.com/",
    });

    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.equal(response.op, "target.apply.result");
    assert.equal(response.payload.status, "applied");
    assert.equal(response.payload.materializedState?.navigationStatus, "loaded");
    assert.equal(core.captureSnapshot(surfaceId, Number(paired.payload.state.panes[0]!.paneId)).contentType, null);
    await closeSocket(owner);
  });
});

test("ws server accepts browser_url navigation evidence that arrives before apply wait registration", async () => {
  await withServer(async ({ server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    const pane = paired.payload.state.panes[0]!;

    server.resolveBrowserUrlNavigation(surfaceId, Number(pane.paneId), {
      status: "applied",
      targetId: "target_fast",
      url: "http://127.0.0.1:19139/t338-browser-url.html",
    });

    const response = await request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: pane.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_fast",
      url: "http://127.0.0.1:19139/t338-browser-url.html",
    }));

    assert.equal(response.ok, true);
    assert.equal(response.op, "target.apply.result");
    assert.equal(response.payload.status, "applied");
    assert.equal(response.payload.materializedState?.navigationStatus, "loaded");
    await closeSocket(owner);
  });
});

test("ws server rejects browser_url load confirmation after ownership changes", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    const pane = paired.payload.state.panes[0]!;

    const responsePromise = request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: pane.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_raced",
      url: "https://race.example/",
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentType, "browser_url");

    const takeover = await request(owner, pairRequest(surfaceId, "pv_bravo", { takeover: true }));
    assert.equal(takeover.ok, true);
    server.resolveBrowserUrlNavigation(surfaceId, Number(pane.paneId), {
      status: "applied",
      targetId: "target_raced",
      url: "https://race.example/",
    });

    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.equal(response.op, "target.apply.result");
    assert.equal(response.payload.status, "rejected");
    assert.equal(response.payload.errorCode, "ownership_session_mismatch");
    await closeSocket(owner);
  });
});

test("ws server releases a native-hosted pane before browser_url replacement", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, server, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      seedSinglePaneSnapshot(core, surfaceId, Number(paired.payload.state.panes[0]!.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      const browserApply = browserUrlTargetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
        targetId: "target_replacement",
        url: "https://example.com/replacement",
      });
      const responsePromise = request(owner, browserApply);
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);
      assert.deepEqual(received[3], {
        pane_ids: [String(paired.payload.state.panes[0]!.paneId)],
        type: "native_pane.release",
      });
      const pane = core.getRendererWindowState(surfaceId).panes[0]!;
      assert.equal(pane.externalNative, false);
      assert.equal(pane.content.contentType, "browser_url");

      server.resolveBrowserUrlNavigation(surfaceId, Number(paired.payload.state.panes[0]!.paneId), {
        status: "applied",
        targetId: "target_replacement",
        url: "https://example.com/replacement",
      });

      const response = await responsePromise;
      assert.equal(response.payload.status, "applied");
      assert.equal(response.payload.materializedState?.navigationStatus, "loaded");
      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rejects renderer replacement when native release overlay resync fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 3840,
              logical_surface_width: 2160,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          }
        : { ok: true })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.ok, true);
      assert.equal(nativeApplied.payload.status, "applied");

      const replaced = await request(owner, contentApplyRequest(Number(pane.paneId), 1));
      assert.equal(replaced.ok, false);
      assert.equal(replaced.error.code, "render_failed");
      await closeSocket(owner);
    }, {
      compositorSocketPath: socketPath,
      onNativeReleased: () => {
        throw new Error("overlay resync rejected");
      },
    });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server preserves native-hosted pane when browser_url release fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status" || message.type === "native_pane.host" || message.type === "overlay_regions.set") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ error: "release denied", ok: false })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      seedSinglePaneSnapshot(core, surfaceId, Number(paired.payload.state.panes[0]!.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");

      const rejected = await request(owner, browserUrlTargetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(rejected.payload.status, "rejected");
      assert.equal(rejected.payload.errorCode, "materialization_failed");
      assert.equal(rejected.payload.message, "Target materialization failed");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentType, null);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server releases native-hosted pane before renderer content.apply", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const released: Array<{ paneIds: string[]; surfaceId: string }> = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      const applied = await request(owner, contentApplyRequest(Number(pane.paneId), 1));
      assert.equal(applied.ok, true);
      assert.equal(applied.op, "content.apply");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);
      assert.deepEqual(received[3], {
        pane_ids: [String(pane.paneId)],
        type: "native_pane.release",
      });
      assert.deepEqual(released, [{ paneIds: [String(pane.paneId)], surfaceId }]);
      const rendererPane = core.getRendererWindowState(surfaceId).panes[0]!;
      assert.equal(rendererPane.externalNative, false);
      assert.equal(rendererPane.content.contentType, "markdown");

      await closeSocket(owner);
    }, {
      compositorSocketPath: socketPath,
      onNativeReleased: (releasedSurfaceId, paneIds) => released.push({ paneIds, surfaceId: releasedSurfaceId }),
    });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server preserves native-hosted pane when renderer content release fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status" || message.type === "native_pane.host" || message.type === "overlay_regions.set") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ error: "release denied", ok: false })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");

      const rejected = await request(owner, contentApplyRequest(Number(pane.paneId), 1));
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "render_failed");
      assert.equal(rejected.error.message, "release denied");
      const rendererPane = core.getRendererWindowState(surfaceId).panes[0]!;
      assert.equal(rendererPane.externalNative, true);
      assert.equal(rendererPane.content.contentType, null);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server releases native-hosted pane for content.apply clear next revision", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      const cleared = await request(owner, contentApplyClearRequest(Number(pane.paneId), 1));
      assert.equal(cleared.ok, true);
      assert.equal(cleared.op, "content.apply");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, false);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server does not release native-hosted pane before invalid topology.apply validation", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      const rejected = await request(owner, {
        id: `rq_${Math.random().toString(16).slice(2)}` as never,
        op: "topology.apply",
        payload: {
          layout: { paneId: 2 as never, type: "pane" },
          panes: [
            { name: "Two", paneId: 2 as never, paneLabel: 7 },
            { name: "Three", paneId: 3 as never, paneLabel: 7 },
          ],
          topologyRevision: 8 as never,
          windowLabel: "a",
        },
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "invalid_payload");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server preserves native-hosted pane for topology.apply with unchanged geometry", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      updateResolvedPaneSnapshot(core, surfaceId, Number(pane.paneId), {
        bounds: { height: 800, width: 1200, x: 0, y: 0 },
      });

      const beforeTopologyRevision = core.resolvedPaneGeometryIdentity(surfaceId).geometryRevision;
      const topologyPromise = request(owner, {
        id: `rq_${Math.random().toString(16).slice(2)}` as never,
        op: "topology.apply",
        payload: {
          layout: { paneId: pane.paneId, type: "pane" },
          panes: [
            { name: "Renamed", paneId: pane.paneId, paneLabel: pane.paneLabel },
          ],
          topologyRevision: 9 as never,
          windowLabel: "a",
        },
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      await waitForGeometryRevisionAfter(core, surfaceId, beforeTopologyRevision);
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));
      const topology = await topologyPromise;
      assert.equal(topology.ok, true);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server updates retained native-hosted panes after topology.apply changes geometry", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      updateResolvedPaneSnapshot(core, surfaceId, Number(pane.paneId), {
        bounds: { height: 400, width: 1200, x: 0, y: 0 },
      });

      const topologyPromise = request(owner, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const topology = await topologyPromise;
      assert.equal(topology.ok, true);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const splitGeometry = core.panesList(surfaceId).panes.find((candidate) => Number(candidate.paneId) === Number(pane.paneId))!.geometry;
      const splitNativeUpdate = received[4] as { panes: Array<{ geometry: { geometryRevision: number }; id: string }> };
      const splitOverlayUpdate = received[5] as { regions: Array<{ rect: unknown }>; revision: number };
      assert.equal(splitNativeUpdate.panes[0]!.id, String(pane.paneId));
      assert.equal(splitNativeUpdate.panes[0]!.geometry.geometryRevision, splitGeometry.geometryRevision);
      assert.equal(splitOverlayUpdate.revision, splitGeometry.geometryRevision);
      assert.deepEqual(splitOverlayUpdate.regions[0]!.rect, splitGeometry.contentViewport);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      assert.equal(core.getRendererWindowState(surfaceId).panes.length, 2);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rejects retained native topology.apply when compositor geometry update fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "native_pane.update") {
        socket.write(`${JSON.stringify({ error: "update denied", ok: false })}\n`);
      } else if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");

      const rejectedPromise = request(owner, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const rejected = await rejectedPromise;
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "render_failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
      ]);
      const state = core.getRendererWindowState(surfaceId);
      assert.equal(state.panes.length, 1);
      assert.equal(state.panes[0]!.label, "1");
      assert.equal(state.panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rolls back retained native topology geometry when overlay update fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let overlayRequests = 0;
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else if (message.type === "overlay_regions.set") {
        overlayRequests += 1;
        socket.write(`${JSON.stringify(
          overlayRequests === 2
            ? { error: "failed to parse request: missing field `target`", ok: false }
            : { ok: true },
        )}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");

      const rejectedPromise = request(owner, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const rejected = await rejectedPromise;
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "render_failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const state = core.getRendererWindowState(surfaceId);
      assert.equal(state.panes.length, 1);
      assert.equal(state.panes[0]!.label, "1");
      assert.equal(state.panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rejects same-provider resume when resolved native relabel update fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let overlayRequests = 0;
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else if (message.type === "overlay_regions.set") {
        overlayRequests += 1;
        socket.write(`${JSON.stringify(overlayRequests === 2 ? { error: "overlay denied", ok: false } : { ok: true })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha", {
        windowLabel: "h",
      }));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      await closeSocket(owner, 1000, "provider_shutdown");

      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });

      const resumedSocket = await connect(url);
      const beforeRelabelRevision = core.resolvedPaneGeometryIdentity(surfaceId).geometryRevision;
      const admittedPromise = request(
        resumedSocket,
        pairRequest(surfaceId, "pv_alpha", {
          resumeSessionId: paired.payload.sessionId,
          windowLabel: "a",
        }),
      );
      await waitForGeometryRevisionAfter(core, surfaceId, beforeRelabelRevision);
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));
      const admitted = await admittedPromise;

      assert.equal(admitted.ok, false);
      assert.equal(admitted.op, "pair.request");
      assert.equal(admitted.error.code, "render_failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const state = core.getRendererWindowState(surfaceId);
      assert.equal(state.windowLabel, "h");
      assert.equal(state.panes.length, 1);
      assert.equal(state.panes[0]!.externalNative, true);

      await closeSocket(resumedSocket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rolls back retained native topology geometry when source geometry changes during update", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let mutateDuringUpdate: (() => void) | null = null;
  let updateRequests = 0;
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "native_pane.update") {
        updateRequests += 1;
        if (updateRequests === 1) {
          mutateDuringUpdate?.();
        }
      }
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      mutateDuringUpdate = () => {
        core.setViewport(surfaceId, { height: 800, scale: 2, width: 1300 });
      };

      const rejectedPromise = request(owner, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const rejected = await rejectedPromise;
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "render_failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const state = core.getRendererWindowState(surfaceId);
      assert.equal(state.panes.length, 1);
      assert.equal(state.panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server updates native-hosted pane after pane.split changes geometry", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      updateResolvedPaneSnapshot(core, surfaceId, Number(pane.paneId), {
        bounds: { height: 400, width: 1200, x: 0, y: 0 },
      });

      const splitPromise = request(owner, {
        id: `rq_${Math.random().toString(16).slice(2)}` as never,
        op: "pane.split",
        payload: {
          count: 2,
          direction: "horizontal",
          newPaneIds: [2 as never],
          newPaneLabels: [42],
          paneId: Number(pane.paneId) as never,
        },
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const split = await splitPromise;
      assert.equal(split.ok, true);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      assert.equal((received[4] as { panes: Array<{ id: string }> }).panes[0]!.id, String(pane.paneId));
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server updates retained native-hosted panes from resolved pane.close geometry", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      updateResolvedPaneSnapshot(core, surfaceId, Number(pane.paneId), {
        bounds: { height: 400, width: 1200, x: 0, y: 0 },
      });

      const topologyPromise = request(owner, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      updateResolvedPaneSnapshot(core, surfaceId, 2, {
        bounds: { height: 400, width: 1200, x: 0, y: 400 },
      });
      updateResolvedPaneSnapshot(core, surfaceId, Number(pane.paneId), {
        bounds: { height: 800, width: 1200, x: 0, y: 0 },
      });
      const topology = await topologyPromise;
      assert.equal(topology.ok, true);

      const beforeCloseRevision = core.resolvedPaneGeometryIdentity(surfaceId).geometryRevision;
      const closePromise = request(owner, paneCloseRequest(2));
      await waitForGeometryRevisionAfter(core, surfaceId, beforeCloseRevision);
      updateResolvedPaneSnapshot(core, surfaceId, Number(pane.paneId), {
        bounds: { height: 800, width: 1200, x: 0, y: 0 },
      });
      const close = await closePromise;
      assert.equal(close.ok, true);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const update = received[7] as { panes: Array<{ geometry: { height: number; width: number; x: number; y: number }; id: string }> };
      const closedGeometry = core.panesList(surfaceId).panes[0]!.geometry;
      assert.equal(update.panes[0]!.id, String(pane.paneId));
      assert.deepEqual({
        coordinateSpace: update.panes[0]!.geometry.coordinateSpace,
        height: update.panes[0]!.geometry.height,
        paneInstanceId: update.panes[0]!.geometry.paneInstanceId,
        topologyEpoch: update.panes[0]!.geometry.topologyEpoch,
        width: update.panes[0]!.geometry.width,
        x: update.panes[0]!.geometry.x,
        y: update.panes[0]!.geometry.y,
      }, {
        coordinateSpace: "compositor_logical",
        height: 800,
        paneInstanceId: pane.paneLineageId,
        topologyEpoch: closedGeometry.topologyEpoch,
        width: 1200,
        x: 0,
        y: 0,
      });
      const state = core.getRendererWindowState(surfaceId);
      assert.equal(state.panes.length, 1);
      assert.equal(state.panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server serializes native target.apply against renderer content replacement", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let releaseHost!: () => void;
  const hostRelease = new Promise<void>((resolve) => {
    releaseHost = resolve;
  });
  let hostSeen!: () => void;
  const hostSeenPromise = new Promise<void>((resolve) => {
    hostSeen = resolve;
  });
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      const reply = () => {
        if (message.type === "get_status") {
          socket.write(`${JSON.stringify({
            ok: true,
            status: {
              logical_surface_height: 3840,
              logical_surface_width: 2160,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          })}\n`);
        } else {
          socket.write(`${JSON.stringify({ ok: true })}\n`);
        }
        socket.end();
      };
      if (message.type === "native_pane.host") {
        hostSeen();
        void hostRelease.then(reply);
        return;
      }
      reply();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativePromise = request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      await hostSeenPromise;

      const contentPromise = request(owner, contentApplyRequest(Number(pane.paneId), 1));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentId, null);

      releaseHost();
      const nativeApplied = await nativePromise;
      assert.equal(nativeApplied.payload.status, "applied");
      const contentApplied = await contentPromise;
      assert.equal(contentApplied.ok, true);
      assert.equal(contentApplied.payload.currentContentId, "ct_applied");
      const finalPane = core.getRendererWindowState(surfaceId).panes[0]!;
      assert.equal(finalPane.externalNative, false);
      assert.equal(finalPane.content.contentId, "ct_applied");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "native_pane.release",
      ]);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server releases native host when ownership changes during native target.apply", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let triggerTakeover: (() => void) | null = null;
  let takeoverComplete: Promise<void> = Promise.resolve();
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
        socket.end();
        return;
      }
      if (message.type === "native_pane.host") {
        triggerTakeover?.();
        void takeoverComplete.then(() => {
          socket.write(`${JSON.stringify({ ok: true })}\n`);
          socket.end();
        });
        return;
      }
      socket.write(`${JSON.stringify({ ok: true })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));
      triggerTakeover = () => {
        takeoverComplete = request(owner, pairRequest(surfaceId, "pv_bravo", { takeover: true })).then((takeover) => {
          assert.equal(takeover.ok, true);
        });
      };

      const rejected = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(rejected.ok, true);
      assert.equal(rejected.op, "target.apply.result");
      assert.equal(rejected.payload.status, "failed");
      assert.equal(rejected.payload.errorCode, "materialization_failed");
      assert.equal(rejected.payload.materializedState?.nativeHost, "released_after_failure");
      assert.equal(rejected.payload.materializedState?.overlayRegions, "not_requested");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "native_pane.release",
      ]);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, false);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server does not release native-hosted last pane before pane.close validation", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      const rejected = await request(owner, {
        id: `rq_${Math.random().toString(16).slice(2)}` as never,
        op: "pane.close",
        payload: { paneId: Number(pane.paneId) as never },
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "invalid_operation");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server does not release native-hosted pane for invalid browser_url payloads", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const owner = await connect(url);
      const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      seedSinglePaneSnapshot(core, surfaceId, Number(paired.payload.state.panes[0]!.paneId));

      const nativeApplied = await request(owner, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(nativeApplied.payload.status, "applied");

      const rejected = await request(owner, browserUrlTargetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
        url: "file:///tmp/not-allowed.html",
      }));

      assert.equal(rejected.payload.status, "rejected");
      assert.equal(rejected.payload.errorCode, "unsafe_payload");
      assert.equal(rejected.payload.message, "browser_url targetPayload.url must be http or https");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, true);
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentType, null);
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);

      await closeSocket(owner);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server returns browser_url failed when renderer reports blocked navigation", async () => {
  await withServer(async ({ server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const responsePromise = request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_blocked",
      url: "https://example.com/blocked",
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    server.resolveBrowserUrlNavigation(surfaceId, Number(paired.payload.state.panes[0]!.paneId), {
      errorMessage: "webview navigation failed: blocked",
      status: "failed",
      targetId: "target_blocked",
      url: "https://example.com/blocked",
    });

    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.equal(response.op, "target.apply.result");
    assert.equal(response.payload.status, "failed");
    assert.equal(response.payload.errorCode, "materialization_failed");
    assert.equal(response.payload.materializedState?.navigationStatus, "failed");
    await closeSocket(owner);
  });
});

test("ws server fails an earlier browser_url apply when a later URL supersedes it", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    const pane = paired.payload.state.panes[0]!;

    const firstResponsePromise = request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: pane.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_first",
      url: "https://first.example/",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondResponsePromise = request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: pane.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_second",
      url: "https://second.example/",
    }));
    const firstResponse = await firstResponsePromise;
    assert.equal(firstResponse.ok, true);
    assert.equal(firstResponse.op, "target.apply.result");
    assert.equal(firstResponse.payload.status, "failed");
    assert.equal(firstResponse.payload.errorCode, "materialization_failed");
    assert.equal(firstResponse.payload.message, "browser_url navigation superseded before verification");

    server.resolveBrowserUrlNavigation(surfaceId, Number(pane.paneId), {
      status: "applied",
      targetId: "target_first",
      url: "https://first.example/",
    });
    assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentId, "target_second");

    server.resolveBrowserUrlNavigation(surfaceId, Number(pane.paneId), {
      status: "applied",
      targetId: "target_second",
      url: "https://second.example/",
    });
    const secondResponse = await secondResponsePromise;
    assert.equal(secondResponse.ok, true);
    assert.equal(secondResponse.op, "target.apply.result");
    assert.equal(secondResponse.payload.status, "applied");
    assert.equal(secondResponse.payload.materializedState?.navigationStatus, "loaded");
    await closeSocket(owner);
  });
});

test("ws server rejects stale browser_url load evidence after pane content changes", async () => {
  await withServer(async ({ core, server, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);
    const pane = paired.payload.state.panes[0]!;

    const responsePromise = request(owner, browserUrlTargetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: pane.paneLineageId,
      surfaceId: paired.payload.surfaceId,
      targetId: "target_stale",
      url: "https://stale.example/",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replaced = await request(owner, contentSetRequest(Number(pane.paneId), 4));
    assert.equal(replaced.ok, true);

    server.resolveBrowserUrlNavigation(surfaceId, Number(pane.paneId), {
      status: "applied",
      targetId: "target_stale",
      url: "https://stale.example/",
    });

    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.equal(response.op, "target.apply.result");
    assert.equal(response.payload.status, "failed");
    assert.equal(response.payload.errorCode, "materialization_failed");
    assert.equal(response.payload.message, "browser_url navigation was superseded before verification");
    assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.content.contentType, "html");
    await closeSocket(owner);
  });
});

test("ws server exposes renderer overlay forwarding diagnostics to the paired owner", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const diagnostics = await request(socket, overlayDiagnosticsRequest());
    assert.equal(diagnostics.ok, true);
    assert.equal(diagnostics.op, "diagnostics.overlay_regions");
    assert.deepEqual((diagnostics as never as { payload: unknown }).payload, {
      diagnostics: { forwardStatus: "ok", regionCount: 6 },
      surfaceId,
    });

    await closeSocket(socket);
  }, {
    getOverlayDiagnostics: (surfaceId) => ({ forwardStatus: "ok", regionCount: surfaceId ? 6 : 0 }),
  });
});

test("ws server derives target.apply native pane host materialization for compositor", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let observedLaunchToken = "";
  let statusRequestCount = 0;
  const windowGroupStatus = (acceptedSecondaryCount: number) => ({
    accepted_secondary_count: acceptedSecondaryCount,
    clipping_status: "clipped",
    denied_reasons: ["foreign_launch_token"],
    denied_toplevel_count: 1,
    focused_window_id: "dialog-1",
    launch_token: observedLaunchToken,
    members: [{
      bounds: { height: 120, width: 160, x: 24, y: 32 },
      clipped_to_pane: true,
      focused: true,
      id: "dialog-1",
      lifecycle: "live",
      role: "dialog",
    }],
    pane_id: "1",
    pane_instance_id: "live-native-pane-1",
    pane_local_bounds: { height: 800, width: 1200, x: 0, y: 0 },
    primary_window_id: "primary-1",
  });
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      const message = JSON.parse(line) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        statusRequestCount += 1;
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            ...(observedLaunchToken && statusRequestCount === 2 ? { native_pane_window_groups: [windowGroupStatus(2)] } : {}),
            pane_geometry_coordinate_space: "compositor_logical",
            physical_output_height: 2160,
            physical_output_width: 3840,
          },
        })}\n`);
      } else if (message.type === "native_pane.host") {
        const panes = Array.isArray(message.panes) ? message.panes : [];
        const firstPane = panes[0] as { launchToken?: string } | undefined;
        observedLaunchToken = firstPane?.launchToken ?? "";
        socket.write(`${JSON.stringify({ ok: true, status: { overlay_regions: { topologyEpoch: "topology-hosted" }, panes: [{ id: "1" }] } })}\n`);
      } else {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            native_pane_window_groups: [windowGroupStatus(1)],
            panes: [{ id: "1" }],
          },
        })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    const nativeMaterializedSurfaces: string[] = [];
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      seedSinglePaneSnapshot(core, surfaceId, Number(paired.payload.state.panes[0]!.paneId));

      const applyRequest = targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      });
      assert.equal("materialization" in applyRequest.payload, false);

      const applied = await request(socket, applyRequest);

      assert.equal(applied.ok, true);
      assert.equal(applied.op, "target.apply.result");
      assert.equal(applied.payload.status, "applied");
      assert.deepEqual(received[0], { type: "get_status" });
      assert.equal((received[1] as { type: string }).type, "native_pane.host");
      assert.equal((received[2] as { topologyEpoch?: string }).topologyEpoch, "topology-hosted");
      assert.equal((received[2] as { regions: Array<{ kind: string }> }).regions[0]?.kind, "other");
      const hostPane = (received[1] as { panes: Array<Record<string, unknown>> }).panes[0]!;
      const resolvedGeometry = core.panesList(surfaceId).panes[0]!.geometry;
      assert.ok(!("geometryUnavailable" in resolvedGeometry));
      assert.deepEqual(hostPane, {
        binding_id: "1:target_top_118",
        content_id: "target_top_118",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: resolvedGeometry.geometryRevision,
          height: 800,
          paneInstanceId: hostPane.geometry && (hostPane.geometry as Record<string, unknown>).paneInstanceId,
          surfaceEpoch: `${surfaceId}:1`,
          topologyEpoch: 0,
          width: 1200,
          x: 0,
          y: 0,
        },
        id: "1",
        launchToken: `${surfaceId}:1:target_top_118:3`,
        process: { args: ["top"], command: "foot" },
        revision: 3,
        target: "terminal",
        windowGroup: {
          launchIdentity: {
            launchToken: `${surfaceId}:1:target_top_118:3`,
            paneId: "1",
            paneInstanceId: hostPane.geometry && (hostPane.geometry as Record<string, unknown>).paneInstanceId,
            surfaceId,
            targetId: "target_top_118",
          },
          policy: {
            chromeInsets: { bottom: 44, left: 44, right: 44, top: 44 },
            clipToPane: true,
            constrainToPane: true,
            denyForeignToplevels: true,
            sameLaunchSecondaryToplevels: "accept",
          },
        },
      });
      assert.match(String((hostPane.geometry as Record<string, unknown>).paneInstanceId), /^pl_/);
      assert.equal(applied.payload.materializedState?.nativeHost, "applied");
      assert.equal(applied.payload.materializedState?.overlayRegions, "applied");
      assert.equal("hostRequest" in applied.payload.materializedState!, false);
      assert.equal("preflightStatus" in applied.payload.materializedState!, false);
      assert.equal("preflightStatusSummary" in applied.payload.materializedState!, false);
      assert.deepEqual(nativeMaterializedSurfaces, [surfaceId]);
      assert.equal(core.panesList(surfaceId).panes[0]?.nativeWindowGroup?.acceptedSecondaryCount, 1);
      assert.equal(core.panesList(surfaceId).panes[0]?.nativeWindowGroup?.focusedWindowId, "dialog-1");
      const refreshed = await request(socket, {
        id: `rq_${Math.random().toString(16).slice(2)}` as never,
        op: "panes.list",
        payload: {},
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      assert.equal(refreshed.ok, true);
      assert.equal(refreshed.op, "panes.list");
      assert.equal(refreshed.payload.panes[0]?.nativeWindowGroup?.acceptedSecondaryCount, 2);
      const cleared = await request(socket, {
        id: `rq_${Math.random().toString(16).slice(2)}` as never,
        op: "panes.list",
        payload: {},
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      assert.equal(cleared.ok, true);
      assert.equal(cleared.op, "panes.list");
      assert.equal(cleared.payload.panes[0]?.nativeWindowGroup, undefined);

      await closeSocket(socket);
    }, {
      compositorSocketPath: socketPath,
      onNativeMaterialized: (surfaceId) => nativeMaterializedSurfaces.push(surfaceId),
    });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server derives native app readiness proof from matched compositor pane status", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let observedLaunchToken = "";
  const emptyEnvDigest = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
  const nestedNativeHostPane = () => ({
    id: "1",
    nativeHost: {
      bindingId: "1:target_native_118",
      contentId: "target_native_118",
      lifecycle: {
        pid: 4242,
        state: "running",
      },
      process: {
        args: ["-e", "top"],
        command: "foot",
      },
    },
  });
  const windowGroupStatus = () => ({
    accepted_secondary_count: 0,
    clipping_status: "clipped",
    denied_reasons: [],
    denied_toplevel_count: 0,
    focused_window_id: "foot-primary",
    launch_token: observedLaunchToken,
    members: [{
      bounds: { height: 800, width: 1200, x: 0, y: 0 },
      clipped_to_pane: true,
      focused: true,
      id: "foot-primary",
      lifecycle: "live",
      role: "primary",
    }],
    pane_id: "1",
    pane_instance_id: "live-native-pane-1",
    pane_local_bounds: { height: 800, width: 1200, x: 0, y: 0 },
    primary_window_id: "foot-primary",
  });
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            overlay_regions: { topologyEpoch: "topology-live" },
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else if (message.type === "native_pane.host") {
        const panes = Array.isArray(message.panes) ? message.panes : [];
        const firstPane = panes[0] as { windowGroup?: { launchIdentity?: { launchToken?: string } } } | undefined;
        observedLaunchToken = firstPane?.windowGroup?.launchIdentity?.launchToken ?? "";
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            overlay_regions: { topologyEpoch: "topology-hosted" },
            panes: [nestedNativeHostPane()],
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            native_pane_window_groups: [windowGroupStatus()],
            overlay_regions: { regionCount: 1, topologyEpoch: "topology-live" },
            panes: [nestedNativeHostPane()],
          },
        })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      seedSinglePaneSnapshot(core, surfaceId, Number(paired.payload.state.panes[0]!.paneId));

      const applied = await request(socket, nativeAppTargetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(applied.ok, true);
      assert.equal(applied.op, "target.apply.result");
      assert.equal(applied.payload.status, "applied");
      assert.equal(applied.payload.materializedState?.nativeHost, "applied");
      assert.equal(applied.payload.materializedState?.overlayRegions, "applied");
      assert.equal(applied.payload.materializedState?.lifecycle, "running");
      assert.deepEqual(applied.payload.materializedState?.proof, {
        appId: "foot",
        args: ["-e", "top"],
        bindingId: "1:target_native_118",
        contentId: "target_native_118",
        envDigest: emptyEnvDigest,
        launchMode: "new_instance",
        paneId: "1",
      });
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);

      await closeSocket(socket);
    }, {
      compositorSocketPath: socketPath,
      getRuntimeAppBinding: trustedRuntimeAppBinding,
    });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server retries native pane overlay until compositor reports the hosted pane live", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let overlayAttempt = 0;
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 800,
            logical_surface_width: 1200,
            overlay_regions: { topologyEpoch: "topology-live" },
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else if (message.type === "native_pane.host") {
        socket.write(`${JSON.stringify({ ok: true, status: { overlay_regions: { topologyEpoch: "topology-hosted" }, panes: [{ id: "1" }] } })}\n`);
      } else if (message.type === "overlay_regions.set") {
        overlayAttempt += 1;
        socket.write(`${JSON.stringify(overlayAttempt === 1
          ? { error: "invalid overlay region: pane PaneId(\"1\") is not a live native-hosted pane", ok: false }
          : { ok: true, status: { overlay_regions: { regionCount: 1, topologyEpoch: "topology-live" } } })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      seedSinglePaneSnapshot(core, surfaceId, Number(paired.payload.state.panes[0]!.paneId));

      const applied = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(applied.payload.status, "applied");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "get_status",
        "overlay_regions.set",
      ]);
      assert.equal((received[2] as { topologyEpoch?: string }).topologyEpoch, "topology-hosted");
      assert.equal((received[4] as { topologyEpoch?: string }).topologyEpoch, "topology-live");
      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server waits long enough for slower GUI native pane attachment before overlaying", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let overlayAttempt = 0;
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 800,
            logical_surface_width: 1200,
            overlay_regions: { topologyEpoch: "topology-live" },
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else if (message.type === "native_pane.host") {
        socket.write(`${JSON.stringify({ ok: true, status: { overlay_regions: { topologyEpoch: "topology-hosted" }, panes: [{ id: "1" }] } })}\n`);
      } else if (message.type === "overlay_regions.set") {
        overlayAttempt += 1;
        socket.write(`${JSON.stringify(overlayAttempt <= 12
          ? { error: "invalid overlay region: pane PaneId(\"1\") is not a live native-hosted pane", ok: false }
          : { ok: true, status: { overlay_regions: { regionCount: 1, topologyEpoch: "topology-live" } } })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      seedSinglePaneSnapshot(core, surfaceId, Number(paired.payload.state.panes[0]!.paneId));

      const applied = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(applied.payload.status, "applied");
      assert.equal(received.filter((message) => (message as { type: string }).type === "overlay_regions.set").length, 13);
      assert.equal(received.filter((message) => (message as { type: string }).type === "get_status").length, 13);
      await closeSocket(socket);
    }, {
      compositorSocketPath: socketPath,
      nativeOverlayLivenessRetryCount: 12,
      nativeOverlayLivenessRetryDelayMs: 0,
    });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server retries native pane overlay with live compositor pane instance authority", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let overlayAttempt = 0;
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 800,
            logical_surface_width: 1200,
            overlay_regions: { topologyEpoch: "topology-live" },
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else if (message.type === "native_pane.host") {
        socket.write(`${JSON.stringify({ ok: true, status: { overlay_regions: { topologyEpoch: "topology-hosted" }, panes: [{ id: "1" }] } })}\n`);
      } else if (message.type === "overlay_regions.set") {
        overlayAttempt += 1;
        socket.write(`${JSON.stringify(overlayAttempt === 1
          ? { error: "invalid overlay region: pane PaneId(\"1\") pane instance '1:target_top_118' does not match live pane instance 'live-native-pane-1'", ok: false }
          : { ok: true, status: { overlay_regions: { regionCount: 1, topologyEpoch: "topology-hosted" } } })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      seedSinglePaneSnapshot(core, surfaceId, Number(paired.payload.state.panes[0]!.paneId));

      const applied = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(applied.payload.status, "applied");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
        "overlay_regions.set",
      ]);
      assert.equal((received[2] as { regions: Array<{ paneInstanceId: string }> }).regions[0]?.paneInstanceId, "1:target_top_118");
      assert.equal((received[3] as { regions: Array<{ paneInstanceId: string }> }).regions[0]?.paneInstanceId, "live-native-pane-1");
      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server derives target.apply native pane geometry from resolved topology snapshot", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 800,
              logical_surface_width: 1200,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          }
        : { ok: true })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const topologyPromise = request(socket, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const topology = await topologyPromise;
      assert.equal(topology.ok, true);
      const paneLineageId = topology.payload.panes.find((pane) => Number(pane.paneId) === 1)?.paneLineageId;
      assert.ok(paneLineageId);

      const applyRequest = targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId,
        surfaceId: paired.payload.surfaceId,
      });
      assert.equal("materialization" in applyRequest.payload, false);

      const applied = await request(socket, applyRequest);

      assert.equal(applied.ok, true);
      assert.equal(applied.op, "target.apply.result");
      assert.equal(applied.payload.status, "applied");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);
      const hostPane = (received[1] as { panes: Array<Record<string, unknown>> }).panes[0]!;
      const resolvedGeometry = core.panesList(surfaceId).panes.find((pane) => Number(pane.paneId) === 1)?.geometry;
      assert.ok(resolvedGeometry && !("geometryUnavailable" in resolvedGeometry));
      assert.deepEqual(hostPane.geometry, {
        coordinateSpace: "compositor_logical",
        geometryRevision: resolvedGeometry.geometryRevision,
        height: 400,
        paneInstanceId: paneLineageId,
        surfaceEpoch: resolvedGeometry.surfaceEpoch,
        topologyEpoch: resolvedGeometry.topologyEpoch,
        width: 1200,
        x: 0,
        y: 0,
      });
      assert.equal(hostPane.id, "1");
      assert.equal(hostPane.binding_id, "1:target_top_118");

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server derives target.apply native pane identity from pane lineage", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const message = JSON.parse(String(chunk).trim()) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 800,
              logical_surface_width: 1200,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          }
        : { ok: true })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);

      const topologyPromise = request(socket, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const topology = await topologyPromise;
      assert.equal(topology.ok, true);
      const secondPaneLineageId = topology.payload.panes.find((pane) => Number(pane.paneId) === 2)?.paneLineageId;
      assert.ok(secondPaneLineageId);

      const applied = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: secondPaneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(applied.ok, true);
      assert.equal(applied.op, "target.apply.result");
      assert.equal(applied.payload.status, "applied");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "overlay_regions.set",
      ]);
      const hostPane = (received[1] as { panes: Array<Record<string, unknown>> }).panes[0]!;
      assert.equal(hostPane.id, "2");
      assert.equal(hostPane.binding_id, "2:target_top_118");
      const resolvedGeometry = core.panesList(surfaceId).panes.find((pane) => Number(pane.paneId) === 2)?.geometry;
      assert.ok(resolvedGeometry && !("geometryUnavailable" in resolvedGeometry));
      assert.deepEqual(hostPane.geometry, {
        coordinateSpace: "compositor_logical",
        geometryRevision: resolvedGeometry.geometryRevision,
        height: 400,
        paneInstanceId: secondPaneLineageId,
        surfaceEpoch: resolvedGeometry.surfaceEpoch,
        topologyEpoch: resolvedGeometry.topologyEpoch,
        width: 1200,
        x: 0,
        y: 400,
      });

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server projects pane resize native, overlay, and panes.list geometry from one revision", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 800,
              logical_surface_width: 1200,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          }
        : { ok: true })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, server, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      const topologyPromise = request(socket, topologyApplyRequest());
      await waitForRendererPaneSet(core, surfaceId, [1, 2]);
      seedHorizontalSplitSnapshots(core, surfaceId);
      const topology = await topologyPromise;
      assert.equal(topology.ok, true);
      const nativePane = topology.payload.panes.find((pane) => Number(pane.paneId) === 1)!;
      const applied = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: nativePane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(applied.payload.status, "applied");
      received.length = 0;

      const beforeResizeRevision = core.resolvedPaneGeometryIdentity(surfaceId).geometryRevision;
      const resizePromise = server.resizeSplit(surfaceId, [], [1, 3]);
      await waitForGeometryRevisionAfter(core, surfaceId, beforeResizeRevision);
      updateResolvedPaneSnapshot(core, surfaceId, 1, {
        bounds: { height: 200, width: 1200, x: 0, y: 0 },
      });
      updateResolvedPaneSnapshot(core, surfaceId, 2, {
        bounds: { height: 600, width: 1200, x: 0, y: 200 },
      });
      assert.equal(await resizePromise, true);

      const listedGeometry = core.panesList(surfaceId).panes.find((pane) => Number(pane.paneId) === 1)!.geometry;
      const nativeUpdate = received[1] as {
        panes: Array<{ geometry: { geometryRevision: number; height: number; topologyEpoch: number; width: number; x: number; y: number } }>;
      };
      const overlayUpdate = received[2] as {
        regions: Array<{ rect: { height: number; width: number; x: number; y: number } }>;
        revision: number;
        topologyEpoch: number;
      };
      assert.deepEqual(nativeUpdate.panes[0]!.geometry, {
        coordinateSpace: "compositor_logical",
        geometryRevision: listedGeometry.geometryRevision,
        height: listedGeometry.contentViewport.height,
        paneInstanceId: listedGeometry.paneInstanceId,
        surfaceEpoch: listedGeometry.surfaceEpoch,
        topologyEpoch: listedGeometry.topologyEpoch,
        width: listedGeometry.contentViewport.width,
        x: listedGeometry.contentViewport.x,
        y: listedGeometry.contentViewport.y,
      });
      assert.equal(overlayUpdate.revision, listedGeometry.geometryRevision);
      assert.equal(overlayUpdate.topologyEpoch, listedGeometry.topologyEpoch);
      assert.deepEqual(overlayUpdate.regions[0]!.rect, listedGeometry.contentViewport);

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server updates native host geometry from the resolved viewport snapshot", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 800,
              logical_surface_width: 1200,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          }
        : { ok: true })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, server, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));

      const applied = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));
      assert.equal(applied.ok, true);
      received.length = 0;
      const beforeViewportRevision = core.resolvedPaneGeometryIdentity(surfaceId).geometryRevision;
      const viewportPromise = server.setViewport(surfaceId, { height: 400, scale: 2, width: 600 });
      await waitForGeometryRevisionAfter(core, surfaceId, beforeViewportRevision);
      updateResolvedPaneSnapshot(core, surfaceId, Number(pane.paneId), {
        bounds: { height: 400, width: 600, x: 0, y: 0 },
      });

      assert.equal(await viewportPromise, true);

      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.update",
        "overlay_regions.set",
      ]);
      const updatedPane = (received[1] as { panes: Array<Record<string, unknown>> }).panes[0]!;
      const viewportGeometry = core.panesList(surfaceId).panes[0]!.geometry;
      assert.deepEqual(updatedPane.geometry, {
        coordinateSpace: "compositor_logical",
        geometryRevision: viewportGeometry.geometryRevision,
        height: 400,
        paneInstanceId: pane.paneLineageId,
        surfaceEpoch: `${surfaceId}:2`,
        topologyEpoch: 0,
        width: 600,
        x: 0,
        y: 0,
      });

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rejects and releases stale native host plan after async geometry change", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  let mutateDuringHost: (() => void) | null = null;
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, unknown>;
      received.push(message);
      if (message.type === "native_pane.host") {
        mutateDuringHost?.();
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      } else if (message.type === "get_status") {
        socket.write(`${JSON.stringify({
          ok: true,
          status: {
            logical_surface_height: 3840,
            logical_surface_width: 2160,
            pane_geometry_coordinate_space: "compositor_logical",
          },
        })}\n`);
      } else {
        socket.write(`${JSON.stringify({ ok: true })}\n`);
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      const pane = paired.payload.state.panes[0]!;
      seedSinglePaneSnapshot(core, surfaceId, Number(pane.paneId));
      mutateDuringHost = () => {
        core.contentSet(surfaceId, {
          content: { markdown: "# replacement" },
          contentId: "ct_replacement" as never,
          contentType: "markdown",
          historyOwnerToken: "hot_replacement",
          paneId: pane.paneId,
          revision: 1 as never,
        });
      };

      const failed = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: pane.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(failed.ok, true);
      assert.equal(failed.op, "target.apply.result");
      assert.equal(failed.payload.status, "failed");
      assert.equal(failed.payload.errorCode, "materialization_failed");
      assert.equal(failed.payload.message, "Target materialization failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), [
        "get_status",
        "native_pane.host",
        "native_pane.release",
      ]);
      assert.equal(failed.payload.materializedState?.nativeHost, "released_after_failure");
      assert.equal(failed.payload.materializedState?.overlayRegions, "not_requested");
      assert.equal(core.getRendererWindowState(surfaceId).panes[0]!.externalNative, false);

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rejects stale target.apply lineage before compositor materialization", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const socket = await connect(url);
    const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const rejected = await request(socket, targetApplyRequest({
      ownershipSessionId: paired.payload.sessionId,
      paneLineageId: "pl_stale",
      surfaceId: paired.payload.surfaceId,
    }));

    assert.equal(rejected.ok, true);
    assert.equal(rejected.op, "target.apply.result");
    assert.equal(rejected.payload.status, "rejected");
    assert.equal(rejected.payload.errorCode, "pane_lineage_missing");

    await closeSocket(socket);
  }, { compositorSocketPath: "/tmp/surf-ace-compositor-test.sock" });
});

test("ws server reports compositor target.apply rejection as materialization failure", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify(message.type === "get_status"
        ? {
            ok: true,
            status: {
              logical_surface_height: 3840,
              logical_surface_width: 2160,
              pane_geometry_coordinate_space: "compositor_logical",
            },
          }
        : { error: { message: "invalid pane 1" }, ok: false })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      seedSinglePaneSnapshot(core, surfaceId, Number(paired.payload.state.panes[0]!.paneId));

      const failed = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(failed.ok, true);
      assert.equal(failed.op, "target.apply.result");
      assert.equal(failed.payload.status, "failed");
      assert.equal(failed.payload.errorCode, "materialization_failed");
      assert.equal(failed.payload.message, "Target materialization failed");
      assert.deepEqual(received.map((message) => (message as { type: string }).type), ["get_status", "native_pane.host"]);
      assert.equal(failed.payload.materializedState?.nativeHost, "not_applied");
      assert.equal(failed.payload.materializedState?.overlayRegions, "not_requested");

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server rejects target.apply geometry outside compositor logical status bounds", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "surf-ace-compositor-"));
  const socketPath = path.join(tempDir, "compositor.sock");
  const received: unknown[] = [];
  const compositor = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) {
        return;
      }
      const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, unknown>;
      received.push(message);
      socket.write(`${JSON.stringify({
        ok: true,
        status: {
          logical_surface_height: 700,
          logical_surface_width: 1100,
          pane_geometry_coordinate_space: "compositor_logical",
          physical_output_height: 2160,
          physical_output_width: 3840,
        },
      })}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    compositor.listen(socketPath, resolve);
    compositor.once("error", reject);
  });
  try {
    await withServer(async ({ core, surfaceId, url }) => {
      const socket = await connect(url);
      const paired = await request(socket, pairRequest(surfaceId, "pv_alpha"));
      assert.equal(paired.ok, true);
      seedSinglePaneSnapshot(core, surfaceId, Number(paired.payload.state.panes[0]!.paneId));

      const failed = await request(socket, targetApplyRequest({
        ownershipSessionId: paired.payload.sessionId,
        paneLineageId: paired.payload.state.panes[0]!.paneLineageId,
        surfaceId: paired.payload.surfaceId,
      }));

      assert.equal(failed.ok, true);
      assert.equal(failed.op, "target.apply.result");
      assert.equal(failed.payload.status, "failed");
      assert.equal(failed.payload.errorCode, "materialization_failed");
      assert.equal(failed.payload.message, "Target materialization failed");
      assert.deepEqual(received, [{ type: "get_status" }]);
      assert.equal(failed.payload.materializedState?.nativeHost, "not_applied");
      assert.equal(failed.payload.materializedState?.overlayRegions, "not_requested");

      await closeSocket(socket);
    }, { compositorSocketPath: socketPath });
  } finally {
    await new Promise<void>((resolve) => compositor.close(() => resolve()));
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ws server ignores reply races when the requester closes before the response", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const transient = await connect(url);
    transient.send(JSON.stringify(pairRequest(surfaceId, "pv_alpha")));
    transient.terminate();

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const stable = await connect(url);
    const response = await request(stable, surfacesListRequest());
    assert.equal(response.ok, true);
    assert.equal(response.op, "surfaces.list");
    await closeSocket(stable);
  });
});

test("ws server logs recoverability, bootstrap reset, pair response, and panes.list summaries", async () => {
  await withServer(async ({ surfaceId, url }) => {
    const lines = await captureInfoLines(async () => {
      const socket = await connect(url);
      const paired = await request(
        socket,
        pairRequest(surfaceId, "pv_alpha", {
          initialPaneId: 7,
          initialPaneLabel: 77,
        }),
      );
      assert.equal(paired.ok, true);
      const listed = await request(socket, {
        id: "rq_diag_panes_list" as never,
        op: "panes.list",
        payload: {},
        sentAt: Date.now() as never,
        type: "request",
        v: 1,
      });
      assert.equal(listed.ok, true);
      await closeSocket(socket);
    });

    const captured = lines.join("\n");
    const recoverabilityLine = lines.find((line) => line.includes("event=pair_recoverable_state_decision"));
    assert.ok(recoverabilityLine);
    assert.match(recoverabilityLine, /result=false/);
    assert.match(recoverabilityLine, /pane_count=1/);
    assert.match(recoverabilityLine, /topology_revision=0/);
    assert.match(recoverabilityLine, /pair_state=/);
    const bootstrapResetLine = lines.find((line) => line.includes("event=pair_request_bootstrap_topology_reset"));
    assert.ok(bootstrapResetLine);
    assert.match(bootstrapResetLine, /before_state=/);
    assert.match(bootstrapResetLine, /after_state=/);
    assert.match(bootstrapResetLine, /7:77:nil/);
    assert.match(captured, /event=pair_response_ok .*pane_count=1 .*pane_ids=7 .*pane_labels=77 .*pair_state=/);
    assert.match(captured, /event=panes_list_summary .*pane_count=1 .*pane_ids=7 .*pane_labels=77 .*pane_content_ids=nil/);
  });
});

test("ws server sanitizes stale layout pane ids before pane.split responds", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const surface = core.getSurface(surfaceId) as unknown as {
      layout: {
        children: Array<{ paneId: number; type: "pane" }>;
        direction: "horizontal" | "vertical";
        type: "split";
      };
    };
    surface.layout = {
      children: [
        { paneId: 1, type: "pane" },
        { paneId: 9999, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    };

    const contentSet = await request(owner, contentSetRequest(1));
    assert.equal(contentSet.ok, true);

    const contentClear = await request(owner, contentClearRequest(1, 2));
    assert.equal(contentClear.ok, true);

    const splitPromise = request(owner, paneSplitRequest(1, { newPaneIds: [2], newPaneLabels: [2] }));
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId);
    const split = await splitPromise;
    assert.equal(split.ok, true);
    assert.equal(split.op, "pane.split");
    assert.deepEqual(split.payload.panes, [
      { paneId: 1, paneLabel: 1 },
      { paneId: 2, paneLabel: 2 },
    ]);

    await closeSocket(owner);
  });
});

test("ws server snapshot.get preserves pane drawings across owner resume", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const contentSet = await request(owner, contentSetRequest(1));
    assert.equal(contentSet.ok, true);

    core.setAnnotating(surfaceId, 1, true);
    core.addStroke(surfaceId, 1, {
      points: [
        { pressure: 0.2, timestamp: 100, x: 10, y: 20 },
        { pressure: 0.3, timestamp: 120, x: 30, y: 40 },
      ],
      strokeId: "stroke_reconnect" as never,
      tool: "mouse",
    });

    const beforeDisconnect = await request(owner, snapshotGetRequest(1));
    assert.equal(beforeDisconnect.ok, true);
    assert.deepEqual(
      beforeDisconnect.payload.drawings?.map((stroke) => stroke.strokeId),
      ["stroke_reconnect"],
    );

    await closeSocket(owner, 1000, "provider_shutdown");
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const resumedSocket = await connect(url);
    const resumed = await request(
      resumedSocket,
      pairRequest(surfaceId, "pv_alpha", { resumeSessionId: paired.payload.sessionId }),
    );
    assert.equal(resumed.ok, true);
    assert.equal(resumed.payload.resumed, true);

    const afterResume = await request(resumedSocket, snapshotGetRequest(1));
    assert.equal(afterResume.ok, true);
    assert.equal(afterResume.payload.contentId, "ct_snapshot");
    assert.deepEqual(
      afterResume.payload.drawings?.map((stroke) => stroke.strokeId),
      ["stroke_reconnect"],
    );

    await closeSocket(resumedSocket);
  });
});

test("ws server emits annotation_committed after the final drawing flush when annotation exits", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const contentSet = await request(owner, contentSetRequest(1));
    assert.equal(contentSet.ok, true);

    core.setAnnotating(surfaceId, 1, true);
    core.addStroke(surfaceId, 1, {
      points: [
        { pressure: 0.2, timestamp: 100, x: 10, y: 20 },
        { pressure: 0.3, timestamp: 120, x: 30, y: 40 },
      ],
      strokeId: "stroke_commit" as never,
      tool: "mouse",
    });

    const eventsPromise = collectEvents(owner, 2, [
      "event.drawing_flush",
      "event.annotation_committed",
    ]);
    core.setAnnotating(surfaceId, 1, false);

    const events = await eventsPromise;
    assert.equal(events[0]?.op, "event.drawing_flush");
    assert.equal(events[1]?.op, "event.annotation_committed");
    assert.equal(events[0]?.payload.paneId, 1);
    assert.equal(events[1]?.payload.paneId, 1);
    assert.equal(events[1]?.payload.contentId, "ct_snapshot");

    await closeSocket(owner);
  });
});

test("ws server accepts topology.apply and content.apply over the paired surface session", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    const topologyPromise = request(owner, topologyApplyRequest());
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    seedHorizontalSplitSnapshots(core, surfaceId);
    const topology = await topologyPromise;
    assert.equal(topology.ok, true);
    assert.equal(topology.op, "topology.apply");
    assert.equal(topology.payload.topologyRevision, 7);
    assert.equal(topology.payload.panes[0]?.name, "Left");
    assert.equal(topology.payload.panes[0]?.paneId, 1);
    assert.equal(topology.payload.panes[0]?.paneLabel, 41);
    assert.match(topology.payload.panes[0]?.paneLineageId ?? "", /^pl_[a-f0-9]{32}$/);
    assert.equal(topology.payload.panes[1]?.name, "Right");
    assert.equal(topology.payload.panes[1]?.paneId, 2);
    assert.equal(topology.payload.panes[1]?.paneLabel, 42);
    assert.match(topology.payload.panes[1]?.paneLineageId ?? "", /^pl_[a-f0-9]{32}$/);
    assert.notEqual(topology.payload.panes[0]?.paneLineageId, topology.payload.panes[1]?.paneLineageId);

    const content = await request(owner, contentApplyRequest(1, 1));
    assert.equal(content.ok, true);
    assert.equal(content.op, "content.apply");
    assert.equal(content.payload.currentContentId, "ct_applied");
    assert.equal(content.payload.topologyRevision, 7);

    const panes = await request(owner, {
      id: `rq_${Math.random().toString(16).slice(2)}` as never,
      op: "panes.list",
      payload: {},
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    });
    assert.equal(panes.ok, true);
    assert.deepEqual(panes.payload.panes.map((pane) => [pane.paneId, pane.paneLabel, pane.name]), [
      [1, 41, "Left"],
      [2, 42, "Right"],
    ]);

    await closeSocket(owner);
  });
});

test("ws server acknowledges topology.apply only after panes.list identity has resolved geometry", async () => {
  await withServer(async ({ core, surfaceId, url }) => {
    const owner = await connect(url);
    const paired = await request(owner, pairRequest(surfaceId, "pv_alpha"));
    assert.equal(paired.ok, true);

    let topologySettled = false;
    const topologyPromise = request(owner, topologyApplyRequest()).finally(() => {
      topologySettled = true;
    });
    await waitForRendererPaneSet(core, surfaceId, [1, 2]);
    assert.equal(topologySettled, false);

    seedHorizontalSplitSnapshots(core, surfaceId);
    const topology = await topologyPromise;
    assert.equal(topology.ok, true);

    const panes = await request(owner, {
      id: `rq_${Math.random().toString(16).slice(2)}` as never,
      op: "panes.list",
      payload: {},
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    });
    assert.equal(panes.ok, true);
    assert.deepEqual(panes.payload.panes.map((pane) => [pane.paneId, pane.paneLabel]), [
      [1, 41],
      [2, 42],
    ]);

    await closeSocket(owner);
  });
});
