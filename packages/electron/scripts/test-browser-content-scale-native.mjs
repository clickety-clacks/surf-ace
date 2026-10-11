// Private native-input fixture for the browser-content host transform.
// Build this exact worktree, then launch with Electron in an admitted private GUI slot:
//   ./node_modules/.bin/electron --no-sandbox scripts/test-browser-content-scale-native.mjs
// It opens one temporary BrowserWindow/profile, loads only local renderer assets and a data: guest,
// and never starts the Surf Ace app, discovery, network services, or an existing user profile.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session } from "electron";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(packageDir, "../..");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
const pinnedSources = [
  "packages/electron/src/guest-preload.ts",
  "packages/electron/src/renderer/browser-content-scale.ts",
  "packages/electron/src/renderer/renderer.ts",
];
const sourceDigests = {};
for (const relativePath of pinnedSources) {
  const bytes = await fs.readFile(path.join(repoDir, relativePath));
  sourceDigests[relativePath] = createHash("sha256").update(bytes).digest("hex");
}
console.log("NATIVE_SCALE_SOURCE=" + JSON.stringify({ head, sourceDigests }));

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-electron-scale-native-"));
app.setPath("userData", path.join(scratch, "profile"));

const iframeHtml = `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#d9e8ff}</style></head>
<body onpointermove="parent.postMessage({type:'iframe-pointer',x:event.clientX,y:event.clientY}, '*')"></body></html>`;
const guestHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{box-sizing:border-box;margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#fff}
#marker{position:fixed;left:-20px;top:-20px;width:8px;height:8px;background:#e22;pointer-events:none}
#edge-frame{position:fixed;right:0;bottom:0;width:130px;height:100px;border:0}
</style></head><body><div id="marker"></div><iframe id="edge-frame"></iframe><script>
window.__pointerSamples=[];window.__iframePointer=null;window.__iframePointerCount=0;
const marker=document.querySelector('#marker');
window.addEventListener('pointermove',event=>{
  marker.style.left=event.clientX+'px';marker.style.top=event.clientY+'px';
  window.__pointerSamples.push({x:event.clientX,y:event.clientY});
});
window.addEventListener('message',event=>{if(event.data?.type==='iframe-pointer'){window.__iframePointer=event.data;window.__iframePointerCount++}});
document.querySelector('#edge-frame').srcdoc=${JSON.stringify(iframeHtml)};
</script></body></html>`;
const guestUrl = `data:text/html;charset=utf-8,${encodeURIComponent(guestHtml)}`;

const pane = {
  paneId: 1,
  label: "1",
  displayId: "scale-native-fixture",
  visibleAddress: "data:scale-native-fixture",
  activeKeyboardPane: true,
  annotationBorderVisible: false,
  drawings: [],
  externalNative: false,
  flushInFlight: false,
  showDone: false,
  toast: null,
  canGoBack: false,
  canGoForward: false,
  name: null,
  ownerName: null,
  provenance: null,
  provenanceName: null,
  content: {
    content: { url: guestUrl },
    contentId: "native-scale-fixture",
    contentType: "browser_url",
    reloadable: false,
    renderVersion: 1,
    revision: 1,
  },
};
const state = {
  connectionBar: "disconnected",
  geometryRevision: 1,
  topologyRevision: 1,
  surfaceEpoch: "private-native-scale-fixture",
  surfaceId: "private-native-scale-fixture",
  windowLabel: "private-native-scale-fixture",
  name: "Private native scale fixture",
  providerName: null,
  panes: [pane],
  viewport: { height: 760, width: 1100, scale: 1 },
  layout: { type: "pane", paneId: 1, weight: 1 },
};

const preloadPath = path.join(scratch, "fixture-preload.cjs");
await fs.writeFile(preloadPath, `window.fixtureState=${JSON.stringify(state)};
window.fixtureCommands=[];
window.surfAce={
  guestPreloadPath:${JSON.stringify(path.join(packageDir, "dist/guest-preload.cjs"))},
  getBootstrap:async()=>({state:window.fixtureState,surfaceId:'private-native-scale-fixture'}),
  onState:callback=>{window.fixtureStateUpdate=callback},
  onKeyboardIntent:callback=>{window.fixtureKeyboard=callback},
  command:command=>window.fixtureCommands.push(command),
  reportSnapshot(){},reportOverlayRegions(){},reportRendererDiagnostic(){},clearToast(){},
};`);

let win;
let stage = "setup";
const blockedRequests = [];
const consoleErrors = [];
const watchdog = setTimeout(() => {
  console.error("FAIL native scale fixture exceeded 90 seconds at " + stage);
  app.exit(1);
}, 90_000);

async function evaluate(label, code) {
  stage = label;
  return win.webContents.executeJavaScript(code);
}

async function waitFor(label, predicate, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evaluate(label, predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out at ${label}: ${predicate}`);
}

function decodePng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "capturePage returns PNG data");
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const imageData = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === "IDAT") {
      imageData.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  assert.equal(bitDepth, 8, "capturePage PNG should use 8-bit channels");
  assert.ok(colorType === 2 || colorType === 6, `capturePage PNG should use RGB/RGBA channels, got ${colorType}`);
  assert.equal(interlace, 0, "capturePage PNG should be non-interlaced");
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(imageData));
  const pixels = Buffer.alloc(height * stride);
  let inputOffset = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[inputOffset++];
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[inputOffset++];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      else assert.equal(filter, 0, `unsupported PNG filter ${filter}`);
      pixels[y * stride + x] = (raw + predictor) & 0xff;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      assert.ok(x >= 0 && x < width && y >= 0 && y < height, `PNG sample ${x},${y} is in bounds`);
      const offset = (y * width + x) * channels;
      return [pixels[offset], pixels[offset + 1], pixels[offset + 2], channels === 4 ? pixels[offset + 3] : 255];
    },
  };
}

async function capturePixel(label, hostX, hostY, predicate) {
  await new Promise((resolve) => setTimeout(resolve, 80));
  const image = await win.webContents.capturePage();
  const decoded = decodePng(image.toPNG());
  const viewport = await evaluate("capture-viewport", "({width:window.innerWidth,height:window.innerHeight})");
  const pixelX = Math.floor((hostX + 1) * decoded.width / viewport.width);
  const pixelY = Math.floor((hostY + 1) * decoded.height / viewport.height);
  const rgba = decoded.pixel(pixelX, pixelY);
  assert.ok(predicate(rgba), `${label}: captured pixel ${pixelX},${pixelY} was ${rgba.join(",")}`);
  console.log("NATIVE_CAPTURE_PIXEL=" + JSON.stringify({ label, png: { width: decoded.width, height: decoded.height },
    sample: { x: pixelX, y: pixelY, rgba } }));
}

async function paneMetrics() {
  return evaluate("pane-metrics", `(()=>{
    const view=document.querySelector('webview');if(!view)return null;
    const rect=view.getBoundingClientRect(),clip=view.parentElement.getBoundingClientRect();
    return {transform:view.style.transform,origin:view.style.transformOrigin,width:view.style.width,height:view.style.height,
      minHeight:view.style.minHeight,rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height},
      minWidth:view.style.minWidth,inset:view.style.inset,autosize:view.getAttribute('autosize'),
      minwidth:view.getAttribute('minwidth'),minheight:view.getAttribute('minheight'),
      clip:{left:clip.left,top:clip.top,right:clip.right,bottom:clip.bottom,width:clip.width,height:clip.height}};})()`);
}

async function guestState() {
  return evaluate("guest-state", `(async()=>{
    const view=document.querySelector('webview');if(!view)return null;
    return view.executeJavaScript(` + JSON.stringify(`(()=>{
      const marker=document.querySelector('#marker'),rect=marker.getBoundingClientRect();
      return {zoom:document.documentElement.style.zoom,innerWidth,innerHeight,
        samples:window.__pointerSamples.length,last:window.__pointerSamples.at(-1)||null,
        marker:{x:rect.x,y:rect.y},iframePointer:window.__iframePointer,iframeCount:window.__iframePointerCount};
    })()`) + `);
  })()`);
}

async function sendMove(relativeX, relativeY, previousSamples) {
  const metrics = await paneMetrics();
  assert.ok(metrics, "renderer should have a browser guest");
  const x = Math.round(metrics.rect.left + relativeX);
  const y = Math.round(metrics.rect.top + relativeY);
  win.webContents.sendInputEvent({ type: "mouseMove", x, y });
  const end = Date.now() + 5_000;
  let current = null;
  while (Date.now() < end) {
    current = await guestState();
    if (current && current.samples > previousSamples) return { current, metrics, x, y, relativeX, relativeY };
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`No guest pointermove after host sendInputEvent at ${x},${y}`);
}

async function assertPoint(label, relativeX, relativeY, scale) {
  const before = await guestState();
  const moved = await sendMove(relativeX, relativeY, before.samples);
  const { current, metrics } = moved;
  assert.equal(current.zoom, "", `${label}: generic document root zoom remains untouched`);
  assert.ok(current.last, `${label}: guest should report a native pointer event`);
  const expectedX = moved.x - metrics.rect.left;
  const expectedY = moved.y - metrics.rect.top;
  const actualX = current.last.x * scale;
  const actualY = current.last.y * scale;
  const markerX = current.marker.x * scale;
  const markerY = current.marker.y * scale;
  assert.ok(Math.abs(actualX - expectedX) <= 1.5,
    `${label}: guest x ${current.last.x} * ${scale} should map to host x ${expectedX}`);
  assert.ok(Math.abs(actualY - expectedY) <= 1.5,
    `${label}: guest y ${current.last.y} * ${scale} should map to host y ${expectedY}`);
  assert.ok(Math.abs(markerX - expectedX) <= 1.5,
    `${label}: fixed marker x ${current.marker.x} * ${scale} should remain under host pointer x ${expectedX}`);
  assert.ok(Math.abs(markerY - expectedY) <= 1.5,
    `${label}: fixed marker y ${current.marker.y} * ${scale} should remain under host pointer y ${expectedY}`);
  console.log("NATIVE_POINTER=" + JSON.stringify({ label, host: { x: expectedX, y: expectedY },
    guest: current.last, markerHost: { x: markerX, y: markerY }, scale }));
  if (label.endsWith("top-left")) {
    await capturePixel(`${label}-marker`, moved.x + 1, moved.y + 1, ([red, green, blue]) => red > 180 && green < 100 && blue < 100);
  }
}

async function run() {
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = /^(file:|data:|about:)/.test(details.url);
      if (!allowed) blockedRequests.push(details.url);
      callback({ cancel: !allowed });
    });
    win = new BrowserWindow({ width: 1100, height: 760, show: true, title: "Private Surf Ace scale fixture",
      webPreferences: { preload: preloadPath, webviewTag: true, contextIsolation: false, sandbox: false,
        backgroundThrottling: false } });
    win.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") consoleErrors.push(details.message);
    });
    win.show();
    win.focus();
    await win.loadFile(path.join(packageDir, "dist/renderer/index.html"));
    await waitFor("initial-host-ready", `Boolean(window.fixtureKeyboard&&document.querySelector('webview')&&
      document.querySelector('webview').dataset.guestReady==='true'&&document.querySelector('webview').style.transform==='scale(0.85)')`);
    let metrics = await paneMetrics();
    assert.equal(metrics.transform, "scale(0.85)");
    assert.equal(metrics.origin, "0 0");
    assert.ok(Math.abs(metrics.rect.width - metrics.clip.width) <= 1.5, "scaled guest should fill pane width");
    assert.ok(Math.abs(metrics.rect.height - metrics.clip.height) <= 1.5, "scaled guest should fill pane height");
    assert.ok(Math.abs(Number.parseFloat(metrics.width) * 0.85 - metrics.clip.width) <= 1.5);
    assert.ok(Math.abs(Number.parseFloat(metrics.minHeight) * 0.85 - metrics.clip.height) <= 1.5);
    assert.equal(metrics.autosize, "on");
    assert.ok(Math.abs(Number.parseInt(metrics.minwidth, 10) - Math.ceil(metrics.clip.width / 0.85)) <= 1);
    assert.ok(Math.abs(Number.parseInt(metrics.minheight, 10) - Math.ceil(metrics.clip.height / 0.85)) <= 1);
    assert.ok(metrics.inset.startsWith("0px") && metrics.inset.endsWith("0px"), `webview origin should be zero: ${metrics.inset}`);
    const initialGuest = await guestState();
    assert.equal(initialGuest.zoom, "");
    await assertPoint("scale-0.85-top-left", 24, 26, 0.85);
    metrics = await paneMetrics();
    await assertPoint("scale-0.85-middle", Math.round(metrics.clip.width * 0.45), Math.round(metrics.clip.height * 0.42), 0.85);

    for (let index = 0; index < 5; index += 1) {
      await evaluate(`scale-up-${index + 1}`, `window.fixtureKeyboard({action:'increase',paneId:1,type:'content-scale'});true`);
      await waitFor(`scale-up-${index + 1}-ready`, `document.querySelector('webview')?.style.transform==='scale(${[0.935, 1.02, 1.105, 1.19, 1.275][index]})`);
    }
    metrics = await paneMetrics();
    assert.equal(metrics.transform, "scale(1.275)");
    assert.ok(Math.abs(metrics.rect.width - metrics.clip.width) <= 1.5, "logical min width must still fill pane after scale > 1");
    assert.ok(Math.abs(metrics.rect.height - metrics.clip.height) <= 1.5, "logical min height must not overfill pane after scale > 1");
    assert.ok(Math.abs(Number.parseFloat(metrics.width) * 1.275 - metrics.clip.width) <= 1.5);
    assert.ok(Math.abs(Number.parseFloat(metrics.minHeight) * 1.275 - metrics.clip.height) <= 1.5);
    assert.equal(metrics.autosize, "on");
    assert.ok(Math.abs(Number.parseInt(metrics.minwidth, 10) - Math.ceil(metrics.clip.width / 1.275)) <= 1);
    assert.ok(Math.abs(Number.parseInt(metrics.minheight, 10) - Math.ceil(metrics.clip.height / 1.275)) <= 1);
    assert.ok(metrics.inset.startsWith("0px") && metrics.inset.endsWith("0px"), `webview origin should be zero: ${metrics.inset}`);
    await assertPoint("scale-1.275-top-left", 24, 26, 1.275);
    metrics = await paneMetrics();
    await assertPoint("scale-1.275-middle", Math.round(metrics.clip.width * 0.45), Math.round(metrics.clip.height * 0.42), 1.275);

    const beforeEdge = await guestState();
    metrics = await paneMetrics();
    const edgeX = Math.max(1, metrics.clip.width - 2);
    const edgeY = Math.max(1, metrics.clip.height - 2);
    const x = Math.round(metrics.rect.left + edgeX);
    const y = Math.round(metrics.rect.top + edgeY);
    win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    let edgeState = null;
    const edgeDeadline = Date.now() + 5_000;
    while (Date.now() < edgeDeadline) {
      edgeState = await guestState();
      if (edgeState && edgeState.iframeCount > beforeEdge.iframeCount) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(edgeState && edgeState.iframeCount > beforeEdge.iframeCount, "iframe should receive a fresh native edge pointer message");
    assert.ok(edgeState.iframePointer, "native input at the clipped pane corner should reach its bottom-right iframe");
    assert.ok(edgeState.iframePointer.x >= 0 && edgeState.iframePointer.y >= 0,
      `iframe edge should receive in-bounds coordinates: ${JSON.stringify(edgeState.iframePointer)}`);
    assert.ok(Math.abs(metrics.rect.right - metrics.clip.right) <= 1.5);
    assert.ok(Math.abs(metrics.rect.bottom - metrics.clip.bottom) <= 1.5);
    await capturePixel("scale-1.275-bottom-right-iframe", x - 3, y - 3,
      ([red, green, blue]) => red < 245 && green > 190 && blue > 220);
    console.log("NATIVE_IFRAME_EDGE=" + JSON.stringify({ scale: 1.275,
      host: { x, y }, guest: edgeState.iframePointer,
      paneRight: metrics.clip.right, paneBottom: metrics.clip.bottom }));

    assert.deepEqual(blockedRequests, []);
    assert.deepEqual(consoleErrors, []);
    console.log("PASS Electron guest native host mouse mapping at 0.85 and 1.275, multiple positions, and bottom-right iframe edge");
  } catch (error) {
    console.error("NATIVE_SCALE_FAILED_STAGE=" + stage);
    console.error(error);
    process.exitCode = 1;
  } finally {
    console.log("NATIVE_SCALE_EXTERNAL_REQUESTS=" + JSON.stringify(blockedRequests));
    console.log("NATIVE_SCALE_CONSOLE_ERRORS=" + JSON.stringify(consoleErrors));
    clearTimeout(watchdog);
    win?.destroy();
    await fs.rm(scratch, { recursive: true, force: true });
    app.exit(process.exitCode === 1 ? 1 : 0);
  }
}

void run();
