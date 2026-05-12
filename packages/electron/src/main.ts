import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, Menu, ipcMain, screen, type WebContents } from "electron";

import type { ContentSetRequest, Stroke } from "../../protocol/src/index.js";
import { BonjourAdvertiser } from "./bonjour-advertiser.js";
import { loadOrCreateIdentity } from "./identity.js";
import {
  type CompositorControlRequest,
  type CompositorControlResponse,
  type NativePaneMaterialization,
  type CompositorOverlayRegion,
  type ResolvedNativePaneGeometry,
  compositorFailureMessage,
  isOverlayNativePaneLivenessFailure,
  nativePaneInstanceIdsForCompositor,
  nativePaneReleaseRequestForCompositor,
  overlayRegionsClearRequestForCompositor,
  overlayRequestForCompositor,
  overlayRegionsSetRequestForCompositor,
  resolveCompositorControlSocketPath,
  resolvedOverlayRegionsForCompositor,
  sendCompositorControl,
} from "./native-pane-bridge.js";
import {
  SurfaceCore,
  type PersistentSurfaceState,
  type ReloadEntryIdentity,
  type RendererWindowState,
} from "./surface-core.js";
import { isAddressInUse, isPortBoundOnIpv6Any } from "./port-selection.js";
import { SurfaceWsServer } from "./ws-server.js";
import { surfaceWindowLoadQuery, surfaceWindowOptions } from "./window-options.js";

const DEFAULT_WS_PORT = 19001;
const WS_PORT = Number(process.env.SURF_ACE_PORT ?? DEFAULT_WS_PORT);
const EXPLICIT_WS_PORT = process.env.SURF_ACE_PORT != null;
const STATE_FILE_NAME = "surface-core-state.json";
const BIND_ADDRESS = process.env.SURF_ACE_BIND?.trim() || "0.0.0.0";
const ADVERTISER_TXT_REFRESH_DEBOUNCE_MS = 500;

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
const overlayForwardState = new Map<string, { revision: number; topologyEpoch: string | null }>();
const latestRendererOverlayPayloads = new Map<string, Record<string, unknown>>();
const nativePaneInstances = new Map<string, Map<string, ResolvedNativePaneGeometry>>();
const rendererOverlaySnapshots = new Map<string, {
  regions: CompositorOverlayRegion[];
  revision: number;
  topologyEpoch: string;
  updateReason?: string;
}>();
const nativeOverlaySnapshots = new Map<string, {
  regions: CompositorOverlayRegion[];
  revision: number;
  topologyEpoch: string;
}>();
const singleInstanceLock = app.requestSingleInstanceLock();
let advertiser: BonjourAdvertiser | null = null;
let advertiserTxtRefreshTimer: NodeJS.Timeout | null = null;
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
      onBusyChanged: scheduleAdvertiserTxtRefresh,
      getOverlayDiagnostics: (surfaceId) => overlayDiagnostics.get(surfaceId) ?? null,
      onNativeMaterialized: (surfaceId, materialization) => {
        recordNativePaneInstances(surfaceId, materialization);
        broadcastSurfaceState(surfaceId);
      },
	      onNativeReleased: async (surfaceId, paneIds) => {
	        forgetNativePaneInstances(surfaceId, paneIds);
	        await syncNativeOverlayRegionsAfterRelease(surfaceId, "native release");
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

function scheduleAdvertiserTxtRefresh(): void {
  if (!advertiser) {
    return;
  }
  if (advertiserTxtRefreshTimer) {
    clearTimeout(advertiserTxtRefreshTimer);
  }
  advertiserTxtRefreshTimer = setTimeout(() => {
    advertiserTxtRefreshTimer = null;
    advertiser?.refreshTxt();
  }, ADVERTISER_TXT_REFRESH_DEBOUNCE_MS);
  advertiserTxtRefreshTimer.unref?.();
}

function clearAdvertiserTxtRefreshTimer(): void {
  if (!advertiserTxtRefreshTimer) {
    return;
  }
  clearTimeout(advertiserTxtRefreshTimer);
  advertiserTxtRefreshTimer = null;
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
  const viewport = {
    height: Math.max(1, Math.floor(bounds.height)),
    scale: display.scaleFactor || 1,
    width: Math.max(1, Math.floor(bounds.width)),
  };
  void server.setViewport(surfaceId, viewport).then((applied) => {
    if (!applied) {
      console.warn("[surf-ace] viewport resize native pane geometry update failed; preserving prior viewport");
    }
  }).catch((error) => {
    console.warn(`[surf-ace] viewport resize failed: ${error}`);
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
  const response = await sendCompositorControl(socketPath, request);
  const failure = compositorFailureMessage(response);
  if (failure) {
    throw new Error(failure);
  }
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
  const latestOverlayPayload = latestRendererOverlayPayloads.get(surfaceId);
  if (latestOverlayPayload) {
    void forwardRendererOverlayRegions(surfaceId, latestOverlayPayload).catch((error) => {
      console.warn(`[surf-ace] overlay region replay after native pane materialization failed: ${error}`);
    });
  }
  const overlayRequest = overlayRequestForCompositor(materialization);
  if (overlayRequest?.type === "overlay_regions.set") {
    const nativePaneIds = new Set(materialization.panes.map((pane) => String(pane.id)));
    const previous = nativeOverlaySnapshots.get(surfaceId)?.regions ?? [];
    nativeOverlaySnapshots.set(surfaceId, {
      regions: [
        ...previous.filter((region) => !nativePaneIds.has(String(region.paneId))),
        ...structuredClone(overlayRequest.regions) as CompositorOverlayRegion[],
      ],
      revision: Number(overlayRequest.revision ?? 0),
      topologyEpoch: String(overlayRequest.topologyEpoch ?? "0"),
    });
  }
}

function forgetNativePaneInstances(surfaceId: string, paneIds: string[]): void {
  const current = nativePaneInstances.get(surfaceId);
  if (!current) {
    return;
  }
  const releasedPaneIds = new Set(paneIds.map(String));
  for (const paneId of paneIds) {
    current.delete(String(paneId));
  }
  for (const snapshots of [rendererOverlaySnapshots, nativeOverlaySnapshots]) {
    const snapshot = snapshots.get(surfaceId);
    if (!snapshot) {
      continue;
    }
    snapshots.set(surfaceId, {
      ...snapshot,
      regions: snapshot.regions.filter((region) => !releasedPaneIds.has(String(region.paneId))),
    });
  }
  if (current.size === 0) {
    nativePaneInstances.delete(surfaceId);
    nativeOverlaySnapshots.delete(surfaceId);
    return;
  }
  nativePaneInstances.set(surfaceId, current);
}

async function syncNativeOverlayRegionsAfterRelease(surfaceId: string, operation: string): Promise<void> {
  const current = nativePaneInstances.get(surfaceId);
  const latestOverlay = rendererOverlaySnapshots.get(surfaceId) ?? nativeOverlaySnapshots.get(surfaceId);
  const overlayResolution = latestOverlay ? compositorOverlayRegions(surfaceId, latestOverlay.regions) : null;
  const request = current && current.size > 0 && latestOverlay
    ? overlayRegionsSetRequestForCompositor({
      regions: overlayResolution?.resolved ?? [],
      revision: latestOverlay.revision,
      surfaceId,
      topologyEpoch: latestOverlay.topologyEpoch,
      updateReason: "native_detach",
      windowId: core.surfaceWindowLabel(surfaceId),
    })
    : overlayRegionsClearRequestForCompositor(surfaceId);
  await sendCompositorOverlayRequest(request);
}

async function releaseNativePaneInstancesForSurface(surfaceId: string, operation: string): Promise<void> {
  const instances = nativePaneInstances.get(surfaceId);
  const paneIds = [...(instances?.keys() ?? [])];
  if (paneIds.length === 0) {
    await sendCompositorOverlayRequest(overlayRegionsClearRequestForCompositor(surfaceId));
    nativeOverlaySnapshots.delete(surfaceId);
    rendererOverlaySnapshots.delete(surfaceId);
    return;
  }
  const socketPath = resolveCompositorControlSocketPath();
  if (!socketPath) {
    throw new Error(`${operation} cannot release live native-hosted panes without compositor control`);
  }
  const releaseResponse = await sendCompositorControl(socketPath, nativePaneReleaseRequestForCompositor(paneIds));
  const releaseFailure = compositorFailureMessage(releaseResponse);
  if (releaseFailure) {
    throw new Error(releaseFailure);
  }
  core.markNativePaneReleased(surfaceId, paneIds.map((paneId) => Number(paneId)));
  forgetNativePaneInstances(surfaceId, paneIds);
  await sendCompositorOverlayRequest(overlayRegionsClearRequestForCompositor(surfaceId));
  nativeOverlaySnapshots.delete(surfaceId);
  rendererOverlaySnapshots.delete(surfaceId);
}

async function navigateHistoryAfterNativeRelease(
  surfaceId: string,
  paneId: number,
  direction: "back" | "forward",
): Promise<void> {
  const applied = await server.navigateHistoryAfterNativeRelease(surfaceId, paneId, direction);
  if (!applied) {
    throw new Error("native pane release failed before history navigation");
  }
}

function compositorOverlayRegions(
  surfaceId: string,
  regions: unknown[],
): { resolved: CompositorOverlayRegion[]; unresolvedPaneIds: string[] } {
  const typedRegions = regions as CompositorOverlayRegion[];
  const instances = nativePaneInstances.get(surfaceId);
  const nativeResolved = resolvedOverlayRegionsForCompositor(
    typedRegions,
    instances?.values() ?? [],
  );
  const nativeByRegionId = new Map(nativeResolved.map((region) => [String(region.regionId), region]));
  const livePaneIds = new Set([...(instances?.keys() ?? [])].map((paneId) => String(paneId)));
  const resolved = typedRegions
    .filter((region) => livePaneIds.size > 0
      ? livePaneIds.has(String(region.paneId))
      : String(region.paneInstanceId ?? "").endsWith(":none"))
    .map((region) => nativeByRegionId.get(String(region.regionId)) ?? region);
  const unresolvedPaneIds = [...new Set(
    typedRegions
      .map((region) => String(region?.paneId ?? ""))
      .filter((paneId) => paneId.length > 0 && !livePaneIds.has(paneId)),
  )];
  return { resolved, unresolvedPaneIds };
}

async function forwardRendererOverlayRegions(surfaceId: string, payload: Record<string, unknown>): Promise<void> {
  latestRendererOverlayPayloads.set(surfaceId, payload);
  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  const socketPath = resolveCompositorControlSocketPath();
  const rendererTopologyEpoch = payload.topologyEpoch == null ? "0" : String(payload.topologyEpoch);
  const requestedRevision = Number(payload.revision ?? 0);
  const previousForward = overlayForwardState.get(surfaceId);
  rendererOverlaySnapshots.set(surfaceId, {
    regions: structuredClone(regions) as CompositorOverlayRegion[],
    revision: requestedRevision,
    topologyEpoch: rendererTopologyEpoch,
    ...(typeof payload.updateReason === "string" ? { updateReason: payload.updateReason } : {}),
  });
  const currentDiagnostic = overlayDiagnostics.get(surfaceId) ?? {};
  const diagnostic: Record<string, unknown> = {
    ...(currentDiagnostic.browserUrlDiagnostics ? { browserUrlDiagnostics: currentDiagnostic.browserUrlDiagnostics } : {}),
    compositorSocketConfigured: Boolean(socketPath),
    lastRendererReportAt: new Date().toISOString(),
    regionCount: regions.length,
    rendererRevision: requestedRevision,
    rendererTopologyEpoch,
    revision: requestedRevision,
    topologyEpoch: previousForward?.topologyEpoch ?? rendererTopologyEpoch,
    updateReason: typeof payload.updateReason === "string" ? payload.updateReason : null,
  };
  overlayDiagnostics.set(surfaceId, diagnostic);
  if (!socketPath) {
    diagnostic.forwardStatus = "skipped_no_socket";
    return;
  }

  let activeTopologyEpoch = previousForward?.topologyEpoch ?? rendererTopologyEpoch;
  let activeRevision = Math.max(requestedRevision, (previousForward?.revision ?? 0) + 1);
  const overlayResolution = compositorOverlayRegions(surfaceId, regions);
  diagnostic.rendererPaneIds = [...new Set(
    regions
      .map((region) => (region && typeof region === "object" && "paneId" in region) ? String((region as { paneId?: unknown }).paneId ?? "") : "")
      .filter((paneId) => paneId.length > 0),
  )];
  diagnostic.nativePaneIds = [...(nativePaneInstances.get(surfaceId)?.keys() ?? [])];
  diagnostic.resolvedRegionCount = overlayResolution.resolved.length;
  diagnostic.unresolvedPaneIds = overlayResolution.unresolvedPaneIds;
  const requestFor = (topologyEpoch: string, revision: number) => overlayRegionsSetRequestForCompositor({
    regions: overlayResolution.resolved,
    revision,
    surfaceId,
    topologyEpoch,
    updateReason: typeof payload.updateReason === "string" ? payload.updateReason as never : undefined,
    windowId: core.surfaceWindowLabel(surfaceId),
  });
  let activeRequest = requestFor(activeTopologyEpoch, activeRevision);
  diagnostic.forwardRequest = activeRequest;
  try {
    let response: CompositorControlResponse = { ok: false, error: "overlay forwarding was not attempted" };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      response = await sendCompositorControl(socketPath, activeRequest);
      const retryTopologyEpoch = staleOverlayTopologyEpoch(response);
      if (retryTopologyEpoch) {
        activeTopologyEpoch = retryTopologyEpoch;
        activeRevision += 1;
        const retryRequest = requestFor(activeTopologyEpoch, activeRevision);
        diagnostic.retryReason = compositorFailureMessage(response);
        diagnostic.retryRequest = retryRequest;
        diagnostic.retryResponse = response;
        diagnostic.topologyEpoch = activeTopologyEpoch;
        diagnostic.revision = activeRevision;
        activeRequest = retryRequest;
        continue;
      }
      const retryRevisionFloor = staleOverlayRevisionFloor(response);
      if (retryRevisionFloor !== null) {
        activeRevision = Math.max(activeRevision + 1, retryRevisionFloor + 1);
        const retryRequest = requestFor(activeTopologyEpoch, activeRevision);
        diagnostic.retryReason = compositorFailureMessage(response);
        diagnostic.retryRequest = retryRequest;
        diagnostic.retryResponse = response;
        diagnostic.revision = activeRevision;
        activeRequest = retryRequest;
        continue;
      }
      const mismatchedLivePaneInstanceId = liveOverlayPaneInstanceId(response);
      if (mismatchedLivePaneInstanceId) {
        activeRevision += 1;
        activeRequest = {
          ...activeRequest,
          revision: activeRevision,
          regions: activeRequest.regions.map((region) => ({
            ...region,
            paneInstanceId: mismatchedLivePaneInstanceId,
          })),
        };
        diagnostic.lifecycleRetryReason = compositorFailureMessage(response);
        diagnostic.lifecycleRetryRequest = activeRequest;
        diagnostic.revision = activeRevision;
        continue;
      }
      if (isOverlayNativePaneLivenessFailure(response)) {
        diagnostic.lifecycleRetryReason = compositorFailureMessage(response);
        diagnostic.lifecycleRetryAttempts = attempt + 1;
        const livePaneInstanceId = liveOverlayPaneInstanceId(response);
        if (livePaneInstanceId) {
          activeRevision += 1;
          activeRequest = {
            ...activeRequest,
            revision: activeRevision,
            regions: activeRequest.regions.map((region) => ({
              ...region,
              paneInstanceId: livePaneInstanceId,
            })),
          };
          diagnostic.lifecycleRetryRequest = activeRequest;
          diagnostic.revision = activeRevision;
          continue;
        }
        await sleep(50);
        continue;
      }
      break;
    }
    const failure = compositorFailureMessage(response);
    if (failure) {
      throw new Error(failure);
    }
    overlayForwardState.set(surfaceId, { revision: activeRevision, topologyEpoch: activeTopologyEpoch });
    diagnostic.forwardedAt = new Date().toISOString();
    diagnostic.forwardResponse = response;
    diagnostic.forwardStatus = "ok";
    diagnostic.revision = activeRevision;
    diagnostic.topologyEpoch = activeTopologyEpoch;
  } catch (error) {
    diagnostic.forwardError = error instanceof Error ? error.message : String(error);
    diagnostic.forwardStatus = "error";
    throw error;
  }
}

function recordBrowserUrlDiagnostics(surfaceId: string, paneId: number, payload: Record<string, unknown>): void {
  const current = overlayDiagnostics.get(surfaceId) ?? {};
  const existingByPane =
    current.browserUrlDiagnostics && typeof current.browserUrlDiagnostics === "object"
      ? current.browserUrlDiagnostics as Record<string, unknown>
      : {};
  const diagnostic = {
    ...current,
    browserUrlDiagnostics: {
      ...existingByPane,
      [String(paneId)]: {
        ...payload,
        receivedAt: new Date().toISOString(),
      },
    },
  };
  overlayDiagnostics.set(surfaceId, diagnostic);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function staleOverlayTopologyEpoch(response: CompositorControlResponse): string | null {
  const message = compositorFailureMessage(response);
  if (!message) {
    return null;
  }
  const match = /stale overlay topology epoch:\s*\S+\s*!=\s*(\S+)/.exec(message);
  return match?.[1] ?? null;
}


function liveOverlayPaneInstanceId(response: CompositorControlResponse): string | null {
  const message = compositorFailureMessage(response);
  if (!message) {
    return null;
  }
  const match = /does not match live pane instance '([^']+)'/.exec(message);
  return match?.[1] ?? null;
}

function staleOverlayRevisionFloor(response: CompositorControlResponse): number | null {
  const message = compositorFailureMessage(response);
  if (!message) {
    return null;
  }
  const match = /stale overlay region revision:\s*(\d+)\s*<=\s*(\d+)/.exec(message);
  const floor = Number(match?.[2] ?? NaN);
  return Number.isFinite(floor) ? floor : null;
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
      void navigateHistoryAfterNativeRelease(surfaceId, activePaneId, "back").catch((error) => {
        console.warn(`[surf-ace] history navigation failed: ${error}`);
      });
      return;
    }
    if (input.meta && input.key === "]") {
      void navigateHistoryAfterNativeRelease(surfaceId, activePaneId, "forward").catch((error) => {
        console.warn(`[surf-ace] history navigation failed: ${error}`);
      });
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
    if (!isQuitting) {
      void (async () => {
        try {
          await releaseNativePaneInstancesForSurface(surfaceId, "window close");
        } catch (error) {
          console.warn(`[surf-ace] compositor native pane release failed on window close: ${error}`);
          await sendCompositorOverlayRequest(overlayRegionsClearRequestForCompositor(surfaceId)).catch((overlayError) => {
            console.warn(`[surf-ace] compositor overlay region clear failed: ${overlayError}`);
          });
        }
        void server.broadcastSurfaceRemoved(surfaceId);
        server.disconnectSurface(surfaceId, "provider_shutdown");
        core.removeSurface(surfaceId);
        void persistState();
      })();
    }
  });

  await window.loadFile(path.join(distDir, "renderer", "index.html"), {
    query: surfaceWindowLoadQuery({
      compositorSocketPath: resolveCompositorControlSocketPath(),
      surfaceId,
    }),
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

async function reloadPaneFromSource(surfaceId: string, paneId: number): Promise<void> {
  const source = core.reloadSource(surfaceId, paneId);
  if (!source || source.kind !== "file") {
    return;
  }
  const pane = core.getRendererWindowState(surfaceId).panes.find((candidate) => candidate.paneId === paneId);
  if (!pane?.content.contentType || pane.content.contentType === "browser_url") {
    return;
  }
  const expected: ReloadEntryIdentity = {
    contentId: pane.content.contentId,
    contentType: pane.content.contentType,
    reloadSource: source,
    renderVersion: pane.content.renderVersion,
    revision: pane.content.revision,
  };
  const content = await contentPayloadFromFile(source.path, pane.content);
  if (!content) {
    return;
  }
  const currentPane = core.getRendererWindowState(surfaceId).panes.find((candidate) => candidate.paneId === paneId);
  const currentSource = currentPane?.content.reloadSource;
  if (
    !currentPane ||
    currentPane.content.contentId !== expected.contentId ||
    currentPane.content.contentType !== expected.contentType ||
    currentPane.content.renderVersion !== expected.renderVersion ||
    currentPane.content.revision !== expected.revision ||
    !currentSource ||
    currentSource.kind !== expected.reloadSource.kind ||
    currentSource.path !== expected.reloadSource.path
  ) {
    return;
  }
  core.replaceCurrentContentFromReloadSource(surfaceId, paneId, content, expected);
}

async function contentPayloadFromFile(
  filePath: string,
  current: RendererWindowState["panes"][number]["content"],
): Promise<ContentSetRequest["payload"]["content"] | null> {
  switch (current.contentType) {
    case "html":
      return {
        ...(current.content && "baseUrl" in current.content && current.content.baseUrl ? { baseUrl: current.content.baseUrl } : {}),
        html: await fs.readFile(filePath, "utf8"),
      };
    case "markdown":
      return { markdown: await fs.readFile(filePath, "utf8") };
    case "terminal":
      return {
        lines: (await fs.readFile(filePath, "utf8")).split(/\r?\n/),
        scrollback:
          current.content && "scrollback" in current.content && typeof current.content.scrollback === "number"
            ? current.content.scrollback
            : 1000,
      };
    case "image": {
      const existing = current.content && typeof current.content === "object" && "mediaType" in current.content
        ? current.content as { mediaType?: string; alt?: string }
        : {};
      return {
        data: (await fs.readFile(filePath)).toString("base64"),
        mediaType: existing.mediaType ?? "application/octet-stream",
        ...(existing.alt ? { alt: existing.alt } : {}),
      };
    }
    case "pdf":
      return { data: (await fs.readFile(filePath)).toString("base64") };
    default:
      return null;
  }
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
    if (payload.type === "browser-url-diagnostics") {
      recordBrowserUrlDiagnostics(surfaceId, paneId, payload as Record<string, unknown>);
      return;
    }
    if (paneId > 0) {
      core.setActiveKeyboardPane(surfaceId, paneId);
    }
    switch (payload.type) {
      case "focus-pane":
        break;
      case "resize-split":
        try {
          const path = Array.isArray(payload.path) ? payload.path.map((entry) => Number(entry)) : [];
          const weights = Array.isArray(payload.weights) ? payload.weights.map((entry) => Number(entry)) : [];
          if (server) {
            void server.resizeSplit(surfaceId, path, weights);
          } else {
            core.resizeSplit(surfaceId, path, weights);
          }
        } catch {
          // Renderer commands can race a pane reset during reconnect.
        }
        break;
      case "annotate":
        try {
          core.setAnnotating(surfaceId, paneId, Boolean(payload.enabled));
        } catch {
          // Renderer commands can race a pane reset during reconnect.
        }
        break;
      case "history":
        void (async () => {
          try {
            const direction = payload.direction === "forward" ? "forward" : "back";
            await navigateHistoryAfterNativeRelease(surfaceId, paneId, direction);
          } catch {
            // Renderer commands can race a pane reset during reconnect.
          }
        })();
        break;
      case "reload":
        void reloadPaneFromSource(surfaceId, paneId).catch((error) => {
          console.warn(`[surf-ace] reload failed: ${error}`);
        });
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
          void server.emitNavigation(surfaceId, paneId, result.url ?? url, result.contentId && result.revision !== undefined
            ? { contentId: result.contentId, revision: result.revision }
            : undefined);
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
  const restoredSurfaces = core.restorePersistedSurfaces(endpointName(), displayViewport());
  const primarySurface = restoredSurfaces.find((surface) => surface.surfaceId === persistentState?.primarySurfaceId)
    ?? restoredSurfaces[0]
    ?? core.ensurePrimarySurface(endpointName(), displayViewport());

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

  const surfacesToOpen = core.listSurfaces();
  for (const surface of surfacesToOpen) {
    await createWindowForSurface(surface.surfaceId);
  }
  if (surfacesToOpen.length === 0) {
    await createWindowForSurface(primarySurface.surfaceId);
  }
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
    clearAdvertiserTxtRefreshTimer();
    await Promise.allSettled(
      [...windows.keys()].map((surfaceId) => releaseNativePaneInstancesForSurface(surfaceId, "app quit")),
    );
    await advertiser?.stop();
    await server.stop();
  });
}
