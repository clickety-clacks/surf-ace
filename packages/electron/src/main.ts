import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, Menu, ipcMain, screen, type WebContents } from "electron";

import type { Stroke } from "../../protocol/src/index.js";
import { BonjourAdvertiser } from "./bonjour-advertiser.js";
import { loadOrCreateIdentity } from "./identity.js";
import { SurfaceCore, type PersistentSurfaceState } from "./surface-core.js";
import { SurfaceWsServer } from "./ws-server.js";

const WS_PORT = Number(process.env.SURF_ACE_PORT ?? 18791);
const STATE_FILE_NAME = "surface-core-state.json";

const windows = new Map<string, BrowserWindow>();
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

function broadcastSurfaceState(surfaceId: string): void {
  const window = windows.get(surfaceId);
  if (!window || window.isDestroyed()) {
    return;
  }
  window.webContents.send("surface:state", core.getRendererWindowState(surfaceId));
}

function wireWindowShortcuts(surfaceId: string, window: BrowserWindow): void {
  window.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") {
      return;
    }
    const state = core.getRendererWindowState(surfaceId);
    const firstPaneId = state.panes[0]?.paneId;
    if (!firstPaneId) {
      return;
    }
    if (input.key.toLowerCase() === "a" && !input.meta) {
      core.setAnnotating(surfaceId, firstPaneId, true);
      void persistState();
      return;
    }
    if (input.key.toLowerCase() === "d" && !input.meta) {
      core.setAnnotating(surfaceId, firstPaneId, false);
      void persistState();
      return;
    }
    if (input.meta && input.key === "[") {
      core.navigateHistory(surfaceId, firstPaneId, "back");
      return;
    }
    if (input.meta && input.key === "]") {
      core.navigateHistory(surfaceId, firstPaneId, "forward");
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
    title: `${endpointName()} · ${surface.windowLabel}`,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(distDir, "preload.cjs"),
      webviewTag: true,
    },
    width: Math.max(960, surface.viewport.width),
  });

  windows.set(surfaceId, window);
  wireWindowShortcuts(surfaceId, window);
  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    windows.delete(surfaceId);
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
    core.updatePaneSnapshot(surfaceId, Number(payload.paneId), {
      bounds: payload.bounds as { height: number; width: number; x: number; y: number } | null,
      selection: (payload.selection ?? null) as never,
      viewport: payload.viewport as never,
      visibleText: String(payload.visibleText ?? ""),
    });
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
    core.clearToast(surfaceId, Number(payload?.paneId));
  });

  ipcMain.on("surface:command", (event, payload) => {
    const surfaceId = surfaceIdForSender(event.sender);
    if (!surfaceId || !payload || typeof payload !== "object") {
      return;
    }

    const paneId = Number(payload.paneId ?? 0);
    switch (payload.type) {
      case "annotate":
        core.setAnnotating(surfaceId, paneId, Boolean(payload.enabled));
        break;
      case "history":
        core.navigateHistory(surfaceId, paneId, payload.direction === "forward" ? "forward" : "back");
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
        const result = core.applyNavigation(surfaceId, paneId, url);
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
