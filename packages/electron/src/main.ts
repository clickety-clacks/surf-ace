import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, Menu, ipcMain, screen, type WebContents } from "electron";

import type { NativePaneMaterialization, Stroke } from "../../protocol/src/index.js";
import { BonjourAdvertiser } from "./bonjour-advertiser.js";
import { loadOrCreateIdentity } from "./identity.js";
import {
  type CompositorControlRequest,
  type CompositorControlResponse,
  type CompositorOverlayRegion,
  type ResolvedNativePaneGeometry,
  compositorFailureMessage,
  nativePaneInstanceIdsForCompositor,
  overlayRegionsClearRequestForCompositor,
  overlayRegionsSetRequestForCompositor,
  resolveCompositorControlSocketPath,
  resolvedOverlayRegionsForCompositor,
  sendCompositorControl,
} from "./native-pane-bridge.js";
import {
  SurfaceCore,
  type PersistentSurfaceState,
  type RendererWindowState,
} from "./surface-core.js";
import { isAddressInUse, isPortBoundOnIpv6Any } from "./port-selection.js";
import { SurfaceWsServer } from "./ws-server.js";
import { surfaceWindowOptions } from "./window-options.js";

const DEFAULT_WS_PORT = 19001;
const WS_PORT = Number(process.env.SURF_ACE_PORT ?? DEFAULT_WS_PORT);
const EXPLICIT_WS_PORT = process.env.SURF_ACE_PORT != null;
const STATE_FILE_NAME = "surface-core-state.json";
const BIND_ADDRESS = process.env.SURF_ACE_BIND?.trim() || "0.0.0.0";

function advertisingDisabled(): boolean {
  const value = process.env.SURF_ACE_DISABLE_ADVERTISING?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function gpuDisableRequested(): boolean {
  const value = process.env.SURF_ACE_DISABLE_GPU?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// Prefer GPU compositing by default. Set SURF_ACE_DISABLE_GPU=1 only on hosts that
// reproduce the original GPU-process crash path.
if (gpuDisableRequested()) {
  app.commandLine.appendSwitch("disable-gpu");
}

const windows = new Map<string, BrowserWindow>();
const pendingWindowStates = new Map<string, RendererWindowState>();
const readyWindows = new Set<string>();
const overlayDiagnostics = new Map<string, Record<string, unknown>>();
const nativePaneInstances = new Map<string, Map<string, ResolvedNativePaneGeometry>>();
const singleInstanceLock = app.requestSingleInstanceLock();
let advertiser: BonjourAdvertiser | null = null;
let core: SurfaceCore;
let distDir = "";
let identityFingerprint = "";
let isQuitting = false;
let server: SurfaceWsServer;
let stateDir = "";
let stateWrite = Promise.resolve();

function candidatePorts(preferredPort: number): number[] {
  if (EXPLICIT_WS_PORT) {
    return [preferredPort];
  }
  const ports = [preferredPort];
  for (let offset = 1; offset <= 10; offset += 1) {
    ports.push(preferredPort + offset);
  }
  return ports;
}

async function createAndStartServer(coreValue: SurfaceCore): Promise<{ port: number; server: SurfaceWsServer }> {
  const ports = candidatePorts(WS_PORT);
  let lastError: unknown;
  for (const port of ports) {
    if (BIND_ADDRESS === "0.0.0.0" && await isPortBoundOnIpv6Any(port)) {
      lastError = Object.assign(new Error(`Port ${port} is already bound on IPv6`), { code: "EADDRINUSE" });
      if (port === ports.at(-1)) {
        throw lastError;
      }
      continue;
    }
    const candidate = new SurfaceWsServer({
      bindAddress: BIND_ADDRESS,
      capturePaneImage,
      core: coreValue,
      endpointName: endpointName(),
      hostName: shortHostName(),
      onBusyChanged: () => advertiser?.refresh(),
      getOverlayDiagnostics: (surfaceId) => overlayDiagnostics.get(surfaceId) ?? null,
      onNativeMaterialized: (surfaceId, materialization) => {
        recordNativePaneInstances(surfaceId, materialization);
        broadcastSurfaceState(surfaceId);
      },
      port,
      viewport: () => displayViewport(),
    });
    try {
      await candidate.start();
      if (port !== WS_PORT) {
        console.warn(
          `[surf-ace] WS port ${WS_PORT} unavailable; using ${port} for this Electron surface on ${shortHostName()}.`,
        );
      }
      return { port, server: candidate };
    } catch (error) {
      lastError = error;
      if (!isAddressInUse(error) || port === ports.at(-1)) {
        throw error;
      }
    }
  }
  throw lastError;
}

app.on("child-process-gone", (_event, details) => {
  if (details.type !== "GPU") {
    return;
  }
  console.warn(
    `[surf-ace] GPU process exited (${details.reason}); relaunch with SURF_ACE_DISABLE_GPU=1 if this host cannot keep GPU compositing alive.`,
  );
});

function displayViewport() {
  const display = screen.getPrimaryDisplay();
  return {
    height: Math.floor(display.workAreaSize.height),
    scale: display.scaleFactor || 1,
    width: Math.floor(display.workAreaSize.width),
  };
}

function endpointName(): string {
  const hostname = os.hostname().replace(/\..*$/, "");
  return process.env.SURF_ACE_NAME?.trim() || `${hostname} Surf Ace`;
}

function shortHostName(): string {
  return os.hostname().replace(/\..*$/, "");
}

function syncWindowViewport(surfaceId: string, window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
  const bounds = window.getContentBounds();
  const display = screen.getDisplayMatching(bounds);
  core.setViewport(surfaceId, {
    height: Math.max(1, Math.floor(bounds.height)),
    scale: display.scaleFactor || 1,
    width: Math.max(1, Math.floor(bounds.width)),
  });
}

async function loadPersistentState(): Promise<PersistentSurfaceState | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(stateDir, STATE_FILE_NAME), "utf8")) as PersistentSurfaceState;
  } catch {
    return undefined;
  }
}

async function persistState(): Promise<void> {
  stateWrite = stateWrite
    .catch(() => {})
    .then(async () => {
      await fs.writeFile(
        path.join(stateDir, STATE_FILE_NAME),
        JSON.stringify(core.getPersistentState(), null, 2),
      );
    });
  await stateWrite;
}

function surfaceIdForSender(contents: WebContents): string | null {
  for (const [surfaceId, window] of windows) {
    if (window.webContents.id === contents.id) {
      return surfaceId;
    }
  }
  return null;
}

function flushPendingWindowState(surfaceId: string): void {
  const window = windows.get(surfaceId);
  if (!window || window.isDestroyed() || !readyWindows.has(surfaceId)) {
    return;
  }
  const pendingState = pendingWindowStates.get(surfaceId);
  if (!pendingState) {
    return;
  }
  pendingWindowStates.delete(surfaceId);
  window.webContents.send("surface:state", pendingState);
}

function broadcastSurfaceState(surfaceId: string): void {
  const window = windows.get(surfaceId);
  if (!window || window.isDestroyed()) {
    return;
  }
  const state = core.getRendererWindowState(surfaceId);
  const windowLabel = core.surfaceWindowLabel(surfaceId);
  window.setTitle(windowLabel ? `${endpointName()} · ${windowLabel}` : endpointName());
  if (!readyWindows.has(surfaceId)) {
    pendingWindowStates.set(surfaceId, state);
    return;
  }
  window.webContents.send("surface:state", state);
}

async function sendCompositorOverlayRequest(request: CompositorControlRequest): Promise<void> {
  const socketPath = resolveCompositorControlSocketPath();
  if (!socketPath) {
    return;
  }
  await sendCompositorControl(socketPath, request);
}

function recordNativePaneInstances(surfaceId: string, materialization: NativePaneMaterialization): void {
  const current = nativePaneInstances.get(surfaceId) ?? new Map<string, ResolvedNativePaneGeometry>();
  const paneInstanceIds = nativePaneInstanceIdsForCompositor(materialization);
  for (const pane of materialization.panes) {
    const paneId = String(pane.id);
    current.set(paneId, {
      geometry: {
        geometryRevision: pane.geometry.geometryRevision,
        height: pane.geometry.height,
        paneInstanceId: pane.geometry.paneInstanceId,
        surfaceEpoch: pane.geometry.surfaceEpoch,
        topologyEpoch: pane.geometry.topologyEpoch,
        width: pane.geometry.width,
        x: pane.geometry.x,
        y: pane.geometry.y,
        coordinateSpace: pane.geometry.coordinateSpace,
      },
      id: paneId,
      paneInstanceId: paneInstanceIds.get(paneId) ?? `${paneId}:${pane.content_id ?? "none"}`,
    });
  }
  nativePaneInstances.set(surfaceId, current);
}

function compositorOverlayRegions(surfaceId: string, regions: unknown[]): CompositorOverlayRegion[] {
  const instances = nativePaneInstances.get(surfaceId);
  return resolvedOverlayRegionsForCompositor(
    regions as CompositorOverlayRegion[],
    instances?.values() ?? [],
  );
}

async function forwardRendererOverlayRegions(surfaceId: string, payload: Record<string, unknown>): Promise<void> {
  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  const socketPath = resolveCompositorControlSocketPath();
  const rendererTopologyEpoch = payload.topologyEpoch == null ? "0" : String(payload.topologyEpoch);
  const diagnostic: Record<string, unknown> = {
    compositorSocketConfigured: Boolean(socketPath),
    lastRendererReportAt: new Date().toISOString(),
    regionCount: regions.length,
    revision: Number(payload.revision ?? 0),
    topologyEpoch: rendererTopologyEpoch,
    updateReason: typeof payload.updateReason === "string" ? payload.updateReason : null,
  };
  overlayDiagnostics.set(surfaceId, diagnostic);
  if (!socketPath) {
    diagnostic.forwardStatus = "skipped_no_socket";
    return;
  }
  const requestForEpoch = (topologyEpoch: string) => overlayRegionsSetRequestForCompositor({
    regions: compositorOverlayRegions(surfaceId, regions),
    revision: Number(payload.revision ?? 0),
    surfaceId,
    topologyEpoch,
    updateReason: typeof payload.updateReason === "string" ? payload.updateReason as never : undefined,
    windowId: surfaceId,
  });
  const request = requestForEpoch(rendererTopologyEpoch);
  diagnostic.forwardRequest = request;
  try {
    let response: CompositorControlResponse = await sendCompositorControl(socketPath, request);
    const retryTopologyEpoch = staleOverlayTopologyEpoch(response);
    if (retryTopologyEpoch) {
      const retryRequest = requestForEpoch(retryTopologyEpoch);
      diagnostic.retryReason = compositorFailureMessage(response);
      diagnostic.retryRequest = retryRequest;
      response = await sendCompositorControl(socketPath, retryRequest);
      diagnostic.retryResponse = response;
      diagnostic.topologyEpoch = retryTopologyEpoch;
    }
    const failure = compositorFailureMessage(response);
    if (failure) {
      throw new Error(failure);
    }
    diagnostic.forwardedAt = new Date().toISOString();
    diagnostic.forwardResponse = response;
    diagnostic.forwardStatus = "ok";
  } catch (error) {
    diagnostic.forwardError = error instanceof Error ? error.message : String(error);
    diagnostic.forwardStatus = "error";
    throw error;
  }
}

function staleOverlayTopologyEpoch(response: CompositorControlResponse): string | null {
  const message = compositorFailureMessage(response);
  if (!message) {
    return null;
  }
  const match = /stale overlay topology epoch:\s*\S+\s*!=\s*(\S+)/.exec(message);
  return match?.[1] ?? null;
}

function focusExistingWindow(): void {
  for (const window of windows.values()) {
    if (window.isDestroyed()) {
      continue;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    return;
  }
}

function wireWindowShortcuts(surfaceId: string, window: BrowserWindow): void {
  window.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") {
      return;
    }
    const state = core.getRendererWindowState(surfaceId);
    const activePaneId = core.activeKeyboardPaneId(surfaceId);
    if (!activePaneId || !state.panes.some((pane) => pane.paneId === activePaneId)) {
      return;
    }
    if (input.key.toLowerCase() === "a" && !input.meta) {
      core.setAnnotating(surfaceId, activePaneId, true);
      void persistState();
      return;
    }
    if (input.key.toLowerCase() === "d" && !input.meta) {
      core.setAnnotating(surfaceId, activePaneId, false);
      void persistState();
      return;
    }
    if (input.meta && input.key === "[") {
      core.navigateHistory(surfaceId, activePaneId, "back");
      return;
    }
    if (input.meta && input.key === "]") {
      core.navigateHistory(surfaceId, activePaneId, "forward");
    }
  });
}

async function createWindowForSurface(surfaceId: string): Promise<BrowserWindow> {
  const existing = windows.get(surfaceId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const surface = core.getSurface(surfaceId);
  const window = new BrowserWindow({
    ...surfaceWindowOptions({
      compositorSocketPath: resolveCompositorControlSocketPath(),
      endpointName: endpointName(),
      viewport: surface.viewport,
      windowLabel: surface.windowLabel,
    }),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(distDir, "preload.cjs"),
      webviewTag: true,
    },
  });

  windows.set(surfaceId, window);
  readyWindows.delete(surfaceId);
  wireWindowShortcuts(surfaceId, window);
  window.once("ready-to-show", () => {
    syncWindowViewport(surfaceId, window);
    window.show();
  });
  window.webContents.once("did-finish-load", () => {
    syncWindowViewport(surfaceId, window);
    readyWindows.add(surfaceId);
    flushPendingWindowState(surfaceId);
  });
  window.on("resize", () => {
    syncWindowViewport(surfaceId, window);
  });
  window.on("maximize", () => {
    syncWindowViewport(surfaceId, window);
  });
  window.on("unmaximize", () => {
    syncWindowViewport(surfaceId, window);
  });
  window.on("enter-full-screen", () => {
    syncWindowViewport(surfaceId, window);
  });
  window.on("leave-full-screen", () => {
    syncWindowViewport(surfaceId, window);
  });
  window.on("closed", () => {
    windows.delete(surfaceId);
    pendingWindowStates.delete(surfaceId);
    readyWindows.delete(surfaceId);
    void sendCompositorOverlayRequest(overlayRegionsClearRequestForCompositor(surfaceId)).catch((error) => {
      console.warn(`[surf-ace] compositor overlay region clear failed: ${error}`);
    });
    if (!isQuitting) {
      void server.broadcastSurfaceRemoved(surfaceId);
      server.disconnectSurface(surfaceId, "provider_shutdown");
      core.removeSurface(surfaceId);
      void persistState();
    }
  });

  await window.loadFile(path.join(distDir, "renderer", "index.html"), {
    query: { surfaceId },
  });
  return window;
}

async function capturePaneImage(surfaceId: string, paneId: number): Promise<string | null> {
  const window = windows.get(surfaceId);
  if (!window || window.isDestroyed()) {
    return null;
  }
  const bounds = core.paneBounds(surfaceId, paneId);
  if (!bounds) {
    return null;
  }
  const image = await window.capturePage({
    height: Math.max(1, Math.floor(bounds.height)),
    width: Math.max(1, Math.floor(bounds.width)),
    x: Math.max(0, Math.floor(bounds.x)),
    y: Math.max(0, Math.floor(bounds.y)),
  });
  return image.toPNG().toString("base64");
}

async function createAdditionalWindow(): Promise<void> {
  const surface = core.createAdditionalSurface(endpointName(), displayViewport());
  await persistState();
  await createWindowForSurface(surface.surfaceId);
  await server.broadcastSurfaceAppeared(surface.surfaceId);
}

function installMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "Surf Ace",
      submenu: [
        {
          accelerator: "CmdOrCtrl+N",
          click: () => {
            void createAdditionalWindow();
          },
          label: "New Window",
        },
        { role: "quit" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

function installIpc(): void {
  ipcMain.handle("surface:get-bootstrap", async (event) => {
    const surfaceId = surfaceIdForSender(event.sender);
    if (!surfaceId) {
      return null;
    }
    const state = core.getRendererWindowState(surfaceId);
    return {
      compositorHosted: Boolean(resolveCompositorControlSocketPath()),
      overlayDebugBorders: Boolean(resolveCompositorControlSocketPath()),
      state,
      surfaceId,
    };
  });

  ipcMain.on("surface:snapshot", (event, payload) => {
    const surfaceId = surfaceIdForSender(event.sender);
    if (!surfaceId || !payload || typeof payload !== "object") {
      return;
    }
    try {
      core.updatePaneSnapshot(surfaceId, Number(payload.paneId), {
        bounds: payload.bounds as { height: number; width: number; x: number; y: number } | null,
        selection: (payload.selection ?? null) as never,
        viewport: payload.viewport as never,
        visibleText: String(payload.visibleText ?? ""),
      });
    } catch {
      // Renderer snapshot updates are best-effort; stale pane ids should not crash the app.
    }
  });

  ipcMain.on("surface:page", (event, payload) => {
    const surfaceId = surfaceIdForSender(event.sender);
    if (!surfaceId || !payload || typeof payload !== "object") {
      return;
    }
    void server.emitPage(surfaceId, Number(payload.paneId), {
      page: Number(payload.page),
      pageText: payload.pageText ? String(payload.pageText) : undefined,
      totalPages: Number(payload.totalPages),
    });
  });

  ipcMain.on("surface:overlay-regions", (event, payload) => {
    const surfaceId = surfaceIdForSender(event.sender);
    if (!surfaceId || !payload || typeof payload !== "object") {
      return;
    }
    void forwardRendererOverlayRegions(surfaceId, payload as Record<string, unknown>).catch((error) => {
      console.warn(`[surf-ace] compositor overlay region update failed: ${error}`);
    });
  });

  ipcMain.on("surface:clear-toast", (event, payload) => {
    const surfaceId = surfaceIdForSender(event.sender);
    if (!surfaceId) {
      return;
    }
    try {
      core.clearToast(surfaceId, Number(payload?.paneId));
    } catch {
      // Renderer commands can race a pane reset during reconnect.
    }
  });

  ipcMain.on("surface:command", (event, payload) => {
    const surfaceId = surfaceIdForSender(event.sender);
    if (!surfaceId || !payload || typeof payload !== "object") {
      return;
    }

    const paneId = Number(payload.paneId ?? 0);
    if (paneId > 0) {
      core.setActiveKeyboardPane(surfaceId, paneId);
    }
    switch (payload.type) {
      case "focus-pane":
        break;
      case "annotate":
        try {
          core.setAnnotating(surfaceId, paneId, Boolean(payload.enabled));
        } catch {
          // Renderer commands can race a pane reset during reconnect.
        }
        break;
      case "history":
        try {
          core.navigateHistory(surfaceId, paneId, payload.direction === "forward" ? "forward" : "back");
        } catch {
          // Renderer commands can race a pane reset during reconnect.
        }
        break;
      case "tap":
        void server.emitTap(surfaceId, paneId, {
          kind: payload.kind === "long_press" ? "long_press" : "tap",
          nearestContent: payload.nearestContent ? String(payload.nearestContent) : undefined,
          position: payload.position as { x: number; y: number },
        });
        break;
      case "selection":
        void server.emitSelection(surfaceId, paneId, (payload.selection ?? null) as never);
        break;
      case "scroll":
        void server.emitScroll(surfaceId, paneId, payload.viewport as never, String(payload.visibleText ?? ""));
        break;
      case "navigation": {
        const url = String(payload.url ?? "");
        let result: { blocked: boolean };
        try {
          result = core.applyNavigation(surfaceId, paneId, url);
        } catch {
          break;
        }
        if (!result.blocked) {
          void server.emitNavigation(surfaceId, paneId, url);
        }
        break;
      }
      case "browser-url-navigation": {
        const status = payload.status === "applied" ? "applied" : "failed";
        server.resolveBrowserUrlNavigation(surfaceId, paneId, {
          errorMessage: payload.errorMessage ? String(payload.errorMessage) : undefined,
          status,
          targetId: String(payload.targetId ?? ""),
          url: String(payload.url ?? ""),
        });
        break;
      }
      case "draw-stroke":
        try {
          core.addStroke(surfaceId, paneId, payload.stroke as Stroke);
        } catch {
          // Renderer can keep running even if the active pane no longer accepts drawing.
        }
        break;
      default:
        break;
    }
  });
}

async function boot(): Promise<void> {
  stateDir = app.getPath("userData");
  await fs.mkdir(stateDir, { recursive: true });
  distDir = path.resolve(__dirname);

  const persistentState = await loadPersistentState();
  const identity = await loadOrCreateIdentity(stateDir);
  identityFingerprint = identity.fingerprintPrefix;

  core = new SurfaceCore({ persistentState });
  const primarySurface = core.ensurePrimarySurface(endpointName(), displayViewport());

  const serverStart = await createAndStartServer(core);
  server = serverStart.server;

  core.subscribe((coreEvent) => {
    if (coreEvent.type === "surface-changed") {
      broadcastSurfaceState(coreEvent.surfaceId);
      void persistState();
    }
  });

  installMenu();
  installIpc();

  if (!advertisingDisabled()) {
    advertiser = new BonjourAdvertiser({
      name: `${endpointName()} (${shortHostName()})`,
      port: serverStart.port,
      txtProvider: () => server.advertisedTxt(identityFingerprint),
    });
    advertiser.start();
  }

  await createWindowForSurface(primarySurface.surfaceId);
}

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusExistingWindow();
  });

  app.whenReady().then(async () => {
    await boot();
    app.on("activate", async () => {
      if (windows.size > 0) {
        focusExistingWindow();
        return;
      }
      const primary = core.ensurePrimarySurface(endpointName(), displayViewport());
      await createWindowForSurface(primary.surfaceId);
    });
  });

  app.on("before-quit", async () => {
    isQuitting = true;
    await Promise.allSettled(
      [...windows.keys()].map((surfaceId) =>
        sendCompositorOverlayRequest(overlayRegionsClearRequestForCompositor(surfaceId))),
    );
    advertiser?.refresh();
    await advertiser?.stop();
    await server.stop();
  });
}
