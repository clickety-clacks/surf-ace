const { app, BrowserWindow, ipcMain, screen } = require('electron');
const os = require('node:os');
const path = require('node:path');

const { createSurfAceWsServer } = require('./httpServer');
const { loadOrCreateIdentity } = require('./identity');
const { MdnsAdvertiser } = require('./mdnsAdvertiser');
const { SurfAceState } = require('./surfAceState');
const { buildMainWindowOptions, shouldUseKioskMode } = require('./windowOptions');

const DEFAULT_HTTP_PORT = Number(process.env.SURF_ACE_PORT || 18791);
const DEFAULT_WS_PATH = '/ws';

let advertiser = null;
let wsServer = null;
let mainWindow = null;
let state = null;

function clampNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function createMainWindow() {
  const win = new BrowserWindow(
    buildMainWindowOptions({
      kioskMode: shouldUseKioskMode(),
      preloadPath: path.join(__dirname, 'preload.js')
    })
  );

  win.loadFile(path.join(__dirname, 'renderer/index.html'));

  return win;
}

function getViewport() {
  const display = screen.getPrimaryDisplay();
  return {
    height: display.workAreaSize.height,
    scale: clampNumber(display.scaleFactor, 1),
    width: display.workAreaSize.width
  };
}

function getScreenName() {
  if (process.env.SURF_ACE_NAME) {
    return process.env.SURF_ACE_NAME;
  }

  const hostname = os.hostname().replace(/\..*$/, '');
  return `${hostname} Surf Ace`;
}

function sendFrameToRenderer(frame) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('surface:frame', frame);
}

function sendSessionToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('surface:session', state.getSessionView());
}

function sendAnnotationsRemoveToRenderer(strokeIds) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('surface:annotations-remove', { strokeIds });
}

function sendFlushIndicatorToRenderer(visible) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('surface:flush-indicator', { visible });
}

function refreshAdvertisement() {
  if (advertiser) {
    advertiser.refresh();
  }
}

function registerIpcHandlers() {
  ipcMain.handle('surface:get-bootstrap', () => ({
    fingerprint: state.identity.fingerprint,
    frame: state.activeFrame,
    screenName: state.screenName,
    session: state.getSessionView()
  }));

  ipcMain.on('surface:snapshot-update', (_event, snapshot) => {
    state.setSnapshot(snapshot || {});
  });

  ipcMain.on('surface:viewport-update', (_event, viewport) => {
    if (!viewport || typeof viewport !== 'object') {
      return;
    }

    state.updateViewport({
      height: clampNumber(Number(viewport.height), state.viewport.height),
      scale: clampNumber(Number(viewport.scale), state.viewport.scale),
      width: clampNumber(Number(viewport.width), state.viewport.width)
    });

    refreshAdvertisement();
  });

  ipcMain.on('surface:event', async (_event, payload) => {
    if (!wsServer) {
      return;
    }

    await wsServer.handleRendererEvent(payload);
  });

  ipcMain.on('surface:stroke-committed', async (_event, payload) => {
    if (!wsServer) {
      return;
    }

    await wsServer.handleRendererStroke(payload);
  });
}

async function captureSurfaceImageBase64() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  const image = await mainWindow.webContents.capturePage();
  return image.toPNG().toString('base64');
}

async function boot() {
  const identity = loadOrCreateIdentity(app.getPath('userData'));
  const viewport = getViewport();

  state = new SurfAceState({
    identity,
    screenName: getScreenName(),
    tlsEnabled: false,
    viewport,
    wsPath: DEFAULT_WS_PATH
  });

  mainWindow = createMainWindow();

  registerIpcHandlers();

  advertiser = new MdnsAdvertiser({
    logger: console,
    port: DEFAULT_HTTP_PORT,
    serviceName: `${state.screenName} (${state.identity.fingerprint})`,
    txtRecordsProvider: () => state.getTxtRecords()
  });

  wsServer = createSurfAceWsServer({
    captureSnapshotImage: captureSurfaceImageBase64,
    logger: console,
    onAnnotationsRemove: async (strokeIds) => {
      sendAnnotationsRemoveToRenderer(strokeIds);
    },
    onClearFrame: async () => {
      sendFrameToRenderer(null);
    },
    onFlushIndicator: async (visible) => {
      sendFlushIndicatorToRenderer(Boolean(visible));
    },
    onFrame: async (frame) => {
      sendFrameToRenderer(frame);
    },
    onSession: async () => {
      sendSessionToRenderer();
      refreshAdvertisement();
    },
    port: DEFAULT_HTTP_PORT,
    state,
    wsPath: DEFAULT_WS_PATH
  });

  await wsServer.start();
  advertiser.start();

  sendSessionToRenderer();

  console.log(
    `Surf Ace WS listening on ws://0.0.0.0:${DEFAULT_HTTP_PORT}${DEFAULT_WS_PATH} (health=http://0.0.0.0:${DEFAULT_HTTP_PORT}/health, fingerprint=${state.identity.fingerprint})`
  );
}

async function shutdown() {
  if (advertiser) {
    advertiser.stop();
  }

  if (wsServer) {
    await wsServer.close();
  }
}

app.whenReady().then(async () => {
  await boot();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      sendSessionToRenderer();
      if (state.activeFrame) {
        sendFrameToRenderer(state.activeFrame);
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  event.preventDefault();
  shutdown().finally(() => {
    app.exit(0);
  });
});
