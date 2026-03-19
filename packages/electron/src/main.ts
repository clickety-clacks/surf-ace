import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, Menu, ipcMain, screen, type WebContents } from "electron";

import type { Stroke } from "../../protocol/src/index.js";
import { BonjourAdvertiser } from "./bonjour-advertiser.js";
import { loadOrCreateIdentity } from "./identity.js";
import {
  SurfaceCore,
  type PersistentSurfaceState,
  type RendererWindowState,
} from "./surface-core.js";
import { SurfaceWsServer } from "./ws-server.js";

const WS_PORT = Number(process.env.SURF_ACE_PORT ?? 18791);
const STATE_FILE_NAME = "surface-core-state.json";

const windows = new Map<string, BrowserWindow>();
const lastExplicitPaneIds = new Map<string, number>();
const pendingWindowStates = new Map<string, RendererWindowState>();
const readyWindows = new Set<string>();
let advertiser: BonjourAdvertiser | null = null;
let core: SurfaceCore;
let distDir = "";
let guestPreloadUrl = "";
let identityFingerprint = "";
let isQuitting = false;
let server: SurfaceWsServer;
let stateDir = "";
let stateWrite = Promise.resolve();

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
  const activePaneId = lastExplicitPaneIds.get(surfaceId);
  if (activePaneId && !state.panes.some((pane) => pane.paneId === activePaneId)) {
    lastExplicitPaneIds.delete(surfaceId);
  }
  const windowLabel = core.surfaceWindowLabel(surfaceId);
  window.setTitle(windowLabel ? `${endpointName()} · ${windowLabel}` : endpointName());
  if (!readyWindows.has(surfaceId)) {
    pendingWindowStates.set(surfaceId, state);
    return;
  }
  window.webContents.send("surface:state", state);
}

function wireWindowShortcuts(surfaceId: string, window: BrowserWindow): void {
  window.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") {
      return;
    }
    const state = core.getRendererWindowState(surfaceId);
    const activePaneId = lastExplicitPaneIds.get(surfaceId);
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
    backgroundColor: "#0b1324",
    height: Math.max(720, surface.viewport.height),
    show: false,
    title: surface.windowLabel ? `${endpointName()} · ${surface.windowLabel}` : endpointName(),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(distDir, "preload.cjs"),
      webviewTag: true,
    },
    width: Math.max(960, surface.viewport.width),
  });

  windows.set(surfaceId, window);
  readyWindows.delete(surfaceId);
  wireWindowShortcuts(surfaceId, window);
  window.once("ready-to-show", () => {
    window.show();
  });
  window.webContents.once("did-finish-load", () => {
    readyWindows.add(surfaceId);
    flushPendingWindowState(surfaceId);
  });
  window.on("closed", () => {
    windows.delete(surfaceId);
    lastExplicitPaneIds.delete(surfaceId);
    pendingWindowStates.delete(surfaceId);
    readyWindows.delete(surfaceId);
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
    return {
      guestPreloadUrl,
      state: core.getRendererWindowState(surfaceId),
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
      lastExplicitPaneIds.set(surfaceId, paneId);
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
  guestPreloadUrl = pathToFileURL(path.join(distDir, "content-guest-preload.cjs")).toString();

  const persistentState = await loadPersistentState();
  const identity = await loadOrCreateIdentity(stateDir);
  identityFingerprint = identity.fingerprintPrefix;

  core = new SurfaceCore({ persistentState });
  const primarySurface = core.ensurePrimarySurface(endpointName(), displayViewport());

  server = new SurfaceWsServer({
    capturePaneImage,
    core,
    endpointName: endpointName(),
    hostName: shortHostName(),
    onBusyChanged: () => advertiser?.refresh(),
    port: WS_PORT,
    viewport: () => displayViewport(),
  });

  core.subscribe((coreEvent) => {
    if (coreEvent.type === "surface-changed") {
      broadcastSurfaceState(coreEvent.surfaceId);
      void persistState();
    }
  });

  installMenu();
  installIpc();
  await server.start();

  advertiser = new BonjourAdvertiser({
    name: `${endpointName()} (${shortHostName()})`,
    port: WS_PORT,
    txtProvider: () => server.advertisedTxt(identityFingerprint),
  });
  advertiser.start();

  await createWindowForSurface(primarySurface.surfaceId);
}

app.whenReady().then(async () => {
  await boot();
  app.on("activate", async () => {
    if (windows.size > 0) {
      return;
    }
    const primary = core.ensurePrimarySurface(endpointName(), displayViewport());
    await createWindowForSurface(primary.surfaceId);
  });
});

app.on("before-quit", async () => {
  isQuitting = true;
  advertiser?.refresh();
  await advertiser?.stop();
  await server.stop();
});
