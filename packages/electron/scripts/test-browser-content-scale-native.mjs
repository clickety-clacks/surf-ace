// Private native-input fixture for the browser-content host transform.
// Build this exact worktree, then launch with Electron in an admitted private GUI slot:
//   ./node_modules/.bin/electron --no-sandbox scripts/test-browser-content-scale-native.mjs
// It opens one temporary BrowserWindow/profile, loads only local renderer assets and a data: guest,
// and never starts the Surf Ace app, discovery, network services, or an existing user profile.
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session } from "electron";
import { readNativeScalePinManifest, saveNativeScalePng, verifyNativeScalePins } from "./native-scale-runner-guard.mjs";
import {
  buildIframeChallengeAckHostProgram,
  buildIframeChallengeGuestProgram,
  buildIframeChallengeHostProgram,
  buildNativeScaleGuestHtml,
  buildNativeScaleIframeHtml,
} from "./native-scale-iframe-challenge.mjs";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(packageDir, "../..");
const runId = process.env.SURF_ACE_NATIVE_RUN_ID;
const evidencePath = path.resolve(process.env.SURF_ACE_NATIVE_EVIDENCE_DIR ?? "");
const scratchPath = path.resolve(process.env.SURF_ACE_NATIVE_SCRATCH_DIR ?? "");
assert.match(runId ?? "", /^[a-z0-9][a-z0-9._-]{2,95}$/i, "private runner must provide an admitted run identity");
assert.ok(process.env.SURF_ACE_NATIVE_SLOT_ID, "private runner must provide an admitted slot identity");
assert.ok(path.isAbsolute(process.env.SURF_ACE_NATIVE_EVIDENCE_DIR ?? ""), "evidence directory must be an absolute path");
assert.ok(path.isAbsolute(process.env.SURF_ACE_NATIVE_SCRATCH_DIR ?? ""), "scratch directory must be an absolute path");
const realRepoDir = await fs.realpath(repoDir);
const evidenceDir = await fs.realpath(evidencePath);
const scratch = await fs.realpath(scratchPath);
for (const [label, candidate] of [["evidence", evidenceDir], ["scratch", scratch]]) {
  const relative = path.relative(realRepoDir, candidate);
  assert.ok(relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)),
    `${label} directory must be external to the source worktree`);
}
const { pins, sha256: pinsManifestSha256 } = await readNativeScalePinManifest(
  process.env.SURF_ACE_NATIVE_PINS,
  process.env.SURF_ACE_NATIVE_PINS_SHA256,
  repoDir,
);
const sourcePin = await verifyNativeScalePins({ repoDir, packageDir, pins, electronVersion: process.versions.electron });
console.log("NATIVE_SCALE_SOURCE=" + JSON.stringify({ runId, slotId: process.env.SURF_ACE_NATIVE_SLOT_ID,
  pinsManifestSha256, head: sourcePin.head, tree: sourcePin.tree,
  distTreeSha256: sourcePin.distTreeSha256, electronVersion: sourcePin.electronVersion }));
app.setPath("userData", path.join(scratch, "profile"));

const iframeHtml = buildNativeScaleIframeHtml();
const guestHtml = buildNativeScaleGuestHtml(iframeHtml);
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
const pngEvidence = [];
const pointerEvidence = [];
const iframeEvidence = [];
let captureSequence = 0;
const watchdog = setTimeout(() => {
  console.error("FAIL native scale fixture exceeded 100 seconds at " + stage);
  process.exitCode = 1;
  win?.destroy();
}, 100_000);
watchdog.unref?.();

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

const challengePalette = [
  [230, 20, 70], [245, 125, 10], [150, 35, 210], [5, 170, 110], [0, 140, 230],
  [220, 170, 10], [20, 200, 190], [200, 50, 120], [100, 160, 20], [40, 70, 180],
  [240, 80, 160], [0, 180, 90], [140, 80, 20],
];

function nextCapturePhase(label) {
  captureSequence += 1;
  const phaseId = `phase-${String(captureSequence).padStart(3, "0")}-${label.replace(/[^a-z0-9._-]/gi, "-").slice(0, 48)}`;
  const rgb = challengePalette[(captureSequence - 1) % challengePalette.length];
  return { phaseId, paint: { challengeId: `${runId}/${label}/${phaseId}`, rgb } };
}

function rgbCss(rgb) { return `rgb(${rgb.join(", ")})`; }
function sameRgb(actual, expected) {
  return Array.isArray(actual) && actual.length >= 3 && actual.slice(0, 3).every((channel, index) => channel === expected[index]);
}

async function installMarkerChallenge(label) {
  const challenge = nextCapturePhase(label);
  const guestInstall = `(()=>{const challenge=${JSON.stringify(challenge.paint)};window.__nativeScaleChallenge=challenge;
    const marker=document.querySelector('#marker');marker.style.backgroundColor=${JSON.stringify(rgbCss(challenge.paint.rgb))};
    return {challengeId:challenge.challengeId,color:getComputedStyle(marker).backgroundColor};})()`;
  await evaluate("install-marker-challenge", `(async()=>{const view=document.querySelector('webview');
    return view.executeJavaScript(${JSON.stringify(guestInstall)});})()`);
  const guestCheck = `(()=>{const marker=document.querySelector('#marker'),challenge=window.__nativeScaleChallenge;
    return challenge?.challengeId===${JSON.stringify(challenge.paint.challengeId)}&&
      getComputedStyle(marker).backgroundColor===${JSON.stringify(rgbCss(challenge.paint.rgb))};})()`;
  await waitFor("marker-challenge-painted", `(async()=>{const view=document.querySelector('webview');
    return view.executeJavaScript(${JSON.stringify(guestCheck)});})()`);
  return challenge;
}

async function installIframeChallenge(label) {
  const challenge = nextCapturePhase(label);
  const guestProgram = buildIframeChallengeGuestProgram(challenge.paint);
  await evaluate("install-iframe-challenge", buildIframeChallengeHostProgram(guestProgram));
  await waitFor("iframe-challenge-painted", buildIframeChallengeAckHostProgram(challenge.paint.challengeId));
  return challenge;
}

async function capturePixels(label, points, { phaseId, paint, paintKind, paintSampleName }) {
  let bytes = null;
  let decoded = null;
  let samples = [];
  let viewport;
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    const image = await win.webContents.capturePage();
    bytes = image.toPNG();
    decoded = decodePng(bytes);
    viewport = await evaluate("capture-viewport", "({width:window.innerWidth,height:window.innerHeight})");
    samples = points.map(({ name, x, y }) => {
      const pixelX = Math.floor((x + 1) * decoded.width / viewport.width);
      const pixelY = Math.floor((y + 1) * decoded.height / viewport.height);
      return { name, host: { x, y }, pixel: { x: pixelX, y: pixelY }, rgba: decoded.pixel(pixelX, pixelY) };
    });
    const paintSample = samples.find(({ name }) => name === paintSampleName);
    if (paintSample && sameRgb(paintSample.rgba, paint.rgb)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(bytes && decoded, `${label}: BrowserWindow capturePage must return an image`);
  const saved = await saveNativeScalePng({ bytes, evidenceDir, phaseId, label,
    source: { runId, slotId: process.env.SURF_ACE_NATIVE_SLOT_ID, pinsManifestSha256,
      head: sourcePin.head, tree: sourcePin.tree, distTreeSha256: sourcePin.distTreeSha256,
      electronVersion: sourcePin.electronVersion } });
  const record = { ...saved, paint: { ...paint, kind: paintKind }, png: { width: decoded.width, height: decoded.height }, samples };
  if (points.length === 1) {
    const sample = samples[0];
    record.hostSample = sample.host;
    record.sample = { x: sample.pixel.x, y: sample.pixel.y, rgba: sample.rgba };
  }
  pngEvidence.push(record);
  console.log("NATIVE_CAPTURE_PIXELS=" + JSON.stringify(record));
  const paintSample = samples.find(({ name }) => name === paintSampleName);
  assert.ok(paintSample && sameRgb(paintSample.rgba, paint.rgb),
    `${label}: current challenge ${paint.rgb.join(",")} was not painted; sampled ${JSON.stringify(paintSample)}`);
  return record;
}

async function capturePixel(label, hostX, hostY, challenge, kind) {
  const record = await capturePixels(label, [{ name: "paint", x: hostX, y: hostY }], {
    ...challenge, paintKind: kind, paintSampleName: "paint",
  });
  return record;
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
        marker:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,color:getComputedStyle(marker).backgroundColor},
        challenge:window.__nativeScaleChallenge,iframeChallengeAck:window.__iframeChallengeAck,
        iframeRect:(()=>{const r=document.querySelector('#edge-frame').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})(),
        iframePointer:window.__iframePointer,iframeCount:window.__iframePointerCount};
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
  const capture = await installMarkerChallenge(`${label}-marker`);
  const before = await guestState();
  const moved = await sendMove(relativeX, relativeY, before.samples);
  const { current, metrics } = moved;
  assert.equal(current.zoom, "", `${label}: generic document root zoom remains untouched`);
  assert.ok(current.last, `${label}: guest should report a native pointer event`);
  assert.equal(current.challenge?.challengeId, capture.paint.challengeId, `${label}: marker must use this phase challenge`);
  assert.equal(current.last.challengeId, capture.paint.challengeId, `${label}: pointer event must be observed under this phase challenge`);
  assert.equal(current.marker.color, rgbCss(capture.paint.rgb), `${label}: guest marker must report the current challenge color`);
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
  pointerEvidence.push({ label, scale, challengeId: capture.paint.challengeId,
    host: { x: expectedX, y: expectedY }, guest: current.last, markerHost: { x: markerX, y: markerY } });
  await capturePixel(`${label}-marker`, moved.x + 1, moved.y + 1, capture, "marker");
}

async function assertIframePoint(label, relativeX, relativeY, scale) {
  const capture = await installIframeChallenge(`${label}-iframe-paint`);
  const before = await guestState();
  const metrics = await paneMetrics();
  const x = Math.round(metrics.rect.left + relativeX);
  const y = Math.round(metrics.rect.top + relativeY);
  win.webContents.sendInputEvent({ type: "mouseMove", x, y });
  const deadline = Date.now() + 5_000;
  let current = null;
  while (Date.now() < deadline) {
    current = await guestState();
    if (current && current.iframeCount > before.iframeCount) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.ok(current && current.iframeCount > before.iframeCount,
    `${label}: iframe must report a fresh native pointer message`);
  assert.ok(current.iframePointer, `${label}: iframe must report native pointer coordinates`);
  assert.equal(current.iframeChallengeAck?.challengeId, capture.paint.challengeId,
    `${label}: iframe must acknowledge this phase paint challenge`);
  assert.equal(current.iframePointer.challengeId, capture.paint.challengeId,
    `${label}: iframe event must carry this phase challenge`);
  assert.deepEqual(current.iframePointer.rgb, capture.paint.rgb,
    `${label}: iframe event must report this phase color`);
  const guestX = (x - metrics.rect.left) / scale;
  const guestY = (y - metrics.rect.top) / scale;
  const expectedLocalX = guestX - current.iframeRect.x;
  const expectedLocalY = guestY - current.iframeRect.y;
  const { iframePointer, iframeRect } = current;
  assert.ok(iframePointer.x >= 0 && iframePointer.y >= 0 &&
    iframePointer.x < iframeRect.width && iframePointer.y < iframeRect.height,
  `${label}: iframe coordinate must be inside ${JSON.stringify(iframeRect)}: ${JSON.stringify(iframePointer)}`);
  assert.ok(Math.abs(iframePointer.x - expectedLocalX) <= 2 && Math.abs(iframePointer.y - expectedLocalY) <= 2,
    `${label}: iframe coordinate ${JSON.stringify(iframePointer)} should match expected local point ${expectedLocalX},${expectedLocalY}`);
  assert.ok(Math.abs(metrics.rect.right - metrics.clip.right) <= 1.5,
    `${label}: transformed guest right edge should meet pane clip`);
  assert.ok(Math.abs(metrics.rect.bottom - metrics.clip.bottom) <= 1.5,
    `${label}: transformed guest bottom edge should meet pane clip`);
  iframeEvidence.push({ label, scale, challengeId: capture.paint.challengeId, host: { x, y }, guest: { x: guestX, y: guestY },
    iframeRect, iframePointer, expectedLocal: { x: expectedLocalX, y: expectedLocalY } });
  await capturePixel(`${label}-iframe-paint`, x - 3, y - 3, capture, "iframe");
  console.log("NATIVE_IFRAME_POINT=" + JSON.stringify(iframeEvidence.at(-1)));
}

async function assertLegacyRootZoomRejected() {
  const capture = await installMarkerChallenge("legacy-root-zoom-negative");
  const originalStyle = await evaluate("legacy-snapshot", `(()=>{const view=document.querySelector('webview');return {
    style:view.getAttribute('style'),autosize:view.getAttribute('autosize'),minwidth:view.getAttribute('minwidth'),minheight:view.getAttribute('minheight')};})()`);
  await evaluate("legacy-parent-style", `(()=>{const view=document.querySelector('webview'),clip=view.parentElement.getBoundingClientRect();
    view.style.transform='none';view.style.transformOrigin='0 0';view.style.width=clip.width+'px';view.style.height=clip.height+'px';
    view.style.minWidth=clip.width+'px';view.style.minHeight=clip.height+'px';view.style.inset='0px';
    view.setAttribute('autosize','on');view.setAttribute('minwidth',String(Math.ceil(clip.width)));
    view.setAttribute('minheight',String(Math.ceil(clip.height)));return true;})()`);
  await evaluate("legacy-root-zoom-enable", `(async()=>{
    return document.querySelector('webview').executeJavaScript("document.documentElement.style.zoom='0.85';true");})()`);
  await waitFor("legacy-root-zoom-enabled", `document.querySelector('webview')?.style.transform==='none'`);
  const pane = await paneMetrics();
  const relativeX = Math.round(pane.clip.width * 0.57);
  const relativeY = Math.round(pane.clip.height * 0.51);
  const before = await guestState();
  const moved = await sendMove(relativeX, relativeY, before.samples);
  const current = moved.current;
  assert.equal(current.zoom, "0.85", "legacy negative control should apply the old document root zoom");
  assert.equal(current.challenge?.challengeId, capture.paint.challengeId,
    "legacy negative control must retain the current guest paint challenge");
  assert.equal(current.last?.challengeId, capture.paint.challengeId,
    "legacy negative control pointer event must use the current challenge");
  assert.equal(current.marker.color, rgbCss(capture.paint.rgb),
    "legacy negative control marker must paint its current challenge color");
  const expectedX = moved.x - moved.metrics.rect.left;
  const expectedY = moved.y - moved.metrics.rect.top;
  const driftX = current.marker.x - expectedX;
  const driftY = current.marker.y - expectedY;
  assert.ok(Math.hypot(driftX, driftY) > 12,
    `old root CSS zoom should visibly move the pointer marker away; measured drift ${driftX},${driftY}`);
  const markerSample = { x: current.marker.x + current.marker.width / 2, y: current.marker.y + current.marker.height / 2 };
  const negativeCapture = await capturePixels("legacy-root-zoom-negative", [
    { name: "pointer-target", x: moved.x, y: moved.y },
    { name: "painted-marker", x: markerSample.x, y: markerSample.y },
  ], { ...capture, paintKind: "legacy-negative", paintSampleName: "painted-marker" });
  const pointerPixel = negativeCapture.samples.find(({ name }) => name === "pointer-target").rgba;
  const markerPixel = negativeCapture.samples.find(({ name }) => name === "painted-marker").rgba;
  assert.ok(!sameRgb(pointerPixel, capture.paint.rgb),
    `legacy root zoom control should leave pointer target unpainted with current challenge ${capture.paint.rgb}: ${pointerPixel}`);
  assert.ok(sameRgb(markerPixel, capture.paint.rgb),
    `legacy root zoom control should paint the current challenge at its displaced marker: ${markerPixel}`);
  console.log("NATIVE_LEGACY_ROOT_ZOOM_NEGATIVE=" + JSON.stringify({ host: { x: expectedX, y: expectedY },
    marker: { x: current.marker.x, y: current.marker.y }, drift: { x: driftX, y: driftY },
    challengeId: capture.paint.challengeId, pointerPixel, markerPixel, phaseId: negativeCapture.phaseId }));
  await evaluate("legacy-root-zoom-clear", `(async()=>document.querySelector('webview').executeJavaScript("document.documentElement.style.zoom='';true"))()`);
  await evaluate("legacy-restore-style", `(()=>{const view=document.querySelector('webview');
    view.setAttribute('style',${JSON.stringify(originalStyle.style)});
    for(const [key,value] of Object.entries({autosize:${JSON.stringify(originalStyle.autosize)},
      minwidth:${JSON.stringify(originalStyle.minwidth)},minheight:${JSON.stringify(originalStyle.minheight)}})){
      if(value===null)view.removeAttribute(key);else view.setAttribute(key,value)}return true;})()`);
  await waitFor("legacy-control-restored", `document.querySelector('webview')?.style.transform==='scale(1.275)'`);
  assert.equal((await guestState()).zoom, "", "negative control must restore an unzoomed guest");
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
    await assertPoint("scale-0.85-quarter", Math.round(metrics.clip.width * 0.25), Math.round(metrics.clip.height * 0.27), 0.85);
    metrics = await paneMetrics();
    await assertPoint("scale-0.85-middle", Math.round(metrics.clip.width * 0.45), Math.round(metrics.clip.height * 0.42), 0.85);
    metrics = await paneMetrics();
    await assertPoint("scale-0.85-right-upper", Math.round(metrics.clip.width * 0.78), Math.round(metrics.clip.height * 0.19), 0.85);
    metrics = await paneMetrics();
    await assertIframePoint("scale-0.85-iframe-center", metrics.clip.width - 0.85 * 65,
      metrics.clip.height - 0.85 * 50, 0.85);
    metrics = await paneMetrics();
    await assertIframePoint("scale-0.85-iframe-bottom-right", metrics.clip.width - 2,
      metrics.clip.height - 2, 0.85);

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
    await assertPoint("scale-1.275-quarter", Math.round(metrics.clip.width * 0.25), Math.round(metrics.clip.height * 0.27), 1.275);
    metrics = await paneMetrics();
    await assertPoint("scale-1.275-middle", Math.round(metrics.clip.width * 0.45), Math.round(metrics.clip.height * 0.42), 1.275);
    metrics = await paneMetrics();
    await assertPoint("scale-1.275-right-upper", Math.round(metrics.clip.width * 0.78), Math.round(metrics.clip.height * 0.19), 1.275);
    metrics = await paneMetrics();
    await assertIframePoint("scale-1.275-iframe-center", metrics.clip.width - 1.275 * 65,
      metrics.clip.height - 1.275 * 50, 1.275);
    metrics = await paneMetrics();
    await assertIframePoint("scale-1.275-iframe-bottom-right", metrics.clip.width - 2,
      metrics.clip.height - 2, 1.275);
    await assertLegacyRootZoomRejected();

    assert.deepEqual(blockedRequests, []);
    assert.deepEqual(consoleErrors, []);
    console.log("PASS Electron guest native host mouse mapping at 0.85 and 1.275, multi-position marker/iframe bounds, and legacy root-zoom negative control");
  } catch (error) {
    console.error("NATIVE_SCALE_FAILED_STAGE=" + stage);
    console.error(error);
    process.exitCode = 1;
  } finally {
    console.log("NATIVE_SCALE_EXTERNAL_REQUESTS=" + JSON.stringify(blockedRequests));
    console.log("NATIVE_SCALE_CONSOLE_ERRORS=" + JSON.stringify(consoleErrors));
    clearTimeout(watchdog);
    win?.destroy();
    await fs.writeFile(path.join(evidenceDir, "fixture-evidence.json"), JSON.stringify({
      schemaVersion: 1,
      runId,
      slotId: process.env.SURF_ACE_NATIVE_SLOT_ID,
      pinsManifestSha256,
      source: { head: sourcePin.head, tree: sourcePin.tree, distTreeSha256: sourcePin.distTreeSha256,
        electronVersion: sourcePin.electronVersion },
      result: process.exitCode === 1 ? "failed" : "passed",
      failedStage: process.exitCode === 1 ? stage : null,
      blockedRequests,
      consoleErrors,
      pointers: pointerEvidence,
      iframePoints: iframeEvidence,
      pngs: pngEvidence,
    }, null, 2) + "\n", { flag: "wx" }).catch((error) => {
      console.error("NATIVE_SCALE_EVIDENCE_WRITE_FAILED=" + String(error));
      process.exitCode = 1;
    });
    app.quit();
  }
}

void run();
