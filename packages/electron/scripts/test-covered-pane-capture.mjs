// Build the protocol and Electron packages, then run with Electron under X11/Xvfb in default GPU mode.
// This isolates BrowserWindow.capturePage and never starts the Surf Ace app.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { referencePixel } from "./private-popout-pixels.mjs";
import { captureWindowPageForPane, surfaceWindowCaptureMode } from "../dist/test/src/window-options.js";

const pixelPoints = (rgb) => [
  [...rgb, 255],
  [rgb[2], rgb[1], rgb[0], 255],
];
const fixtureStartedAt = Date.now();

function reportFixturePhase(name, fields = {}) {
  console.log("FIXTURE_PHASE=" + JSON.stringify({ name, elapsedMs: Date.now() - fixtureStartedAt, ...fields }));
}

function matches(actual, expected, tolerance = 3) {
  return actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);
}

async function capturePixel(window, x, y, keepFramesForCoveredCapture, label, attempt) {
  const crop = { height: 24, width: 24, x: x - 12, y: y - 12 };
  const startedAt = Date.now();
  reportFixturePhase("capture-start", { label, attempt });
  const image = await captureWindowPageForPane(window, crop, keepFramesForCoveredCapture);
  reportFixturePhase("capture-finished", { label, attempt, durationMs: Date.now() - startedAt });
  return referencePixel(image, 12, 12);
}

async function waitForPixel(window, x, y, expectedPixels, label, keepFramesForCoveredCapture) {
  let observed;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    observed = await capturePixel(window, x, y, keepFramesForCoveredCapture, label, attempt);
    const expected = expectedPixels.find((candidate) => matches(observed, candidate));
    if (expected) {
      return { attempt, expected, observed };
    }
    if (attempt < 40) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${label}: expected ${JSON.stringify(expectedPixels)}, observed ${JSON.stringify(observed)}`);
}

async function waitForPanePixels(window, width, height, expectedPixels, label, keepFramesForCoveredCapture) {
  const left = await waitForPixel(window, Math.floor(width / 4), Math.floor(height / 2), expectedPixels.left,
    `${label} left`, keepFramesForCoveredCapture);
  const right = await waitForPixel(window, Math.floor(width * 3 / 4), Math.floor(height / 2), expectedPixels.right,
    `${label} right`, keepFramesForCoveredCapture);
  return { left, right };
}

function dataHtmlUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function fixtureWindow({ x, y, backgroundThrottling }) {
  return new BrowserWindow({
    backgroundColor: "#000000",
    frame: false,
    height: 260,
    show: false,
    useContentSize: true,
    width: 360,
    x,
    y,
    webPreferences: { backgroundThrottling, webviewTag: true },
  });
}

async function run() {
  console.log("FIXTURE_RUNTIME=" + JSON.stringify({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));
  reportFixturePhase("app-starting");
  assert.equal(app.commandLine.hasSwitch("disable-gpu"), false,
    "the fixture must run without an explicit --disable-gpu switch");
  assert.equal(["1", "true", "yes"].includes(process.env.SURF_ACE_DISABLE_GPU?.trim().toLowerCase()), false,
    "the fixture must run without the software-capture override");
  const captureMode = surfaceWindowCaptureMode({
    compositorSocketPath: null,
    gpuDisabled: false,
    platform: process.platform,
  });
  assert.equal(captureMode.keepFramesForCoveredCapture, true,
    "Linux default-GPU capture mode must refresh frames while covered captures run");
  assert.equal(captureMode.offscreen, false, "the fixture must exercise the visible default-GPU path");
  const keepFramesForCoveredCapture = process.env.SURF_ACE_TEST_FORCE_DIRECT_CAPTURE !== "1"
    && captureMode.keepFramesForCoveredCapture;

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-covered-capture-"));
  app.setPath("userData", path.join(scratch, "profile"));
  await app.whenReady();
  reportFixturePhase("app-ready");
  let target;
  let cover;
  try {
    const x = 120;
    const y = 100;
    const leftPaneColor = "#d93636";
    const rightPaneColor = "#246bce";
    const coverColor = "#2040dc";
    const targetPixels = {
      left: pixelPoints([217, 54, 54]),
      right: pixelPoints([36, 107, 206]),
    };
    const coverPixels = pixelPoints([32, 64, 220]);

    // Match pane content from the Linux baseline: red and blue HTML inside Surf Ace's webview path.
    target = fixtureWindow({ backgroundThrottling: true, x, y });
    reportFixturePhase("target-created");
    const paneHtml = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{box-sizing:border-box;margin:0;width:100%;height:100%;overflow:hidden}.left,.right{position:absolute;top:0;bottom:0;width:50%}.left{left:0;background:${leftPaneColor}}.right{right:0;background:${rightPaneColor}}</style></head><body><div class="left"></div><div class="right"></div></body></html>`;
    const paneUrl = dataHtmlUrl(paneHtml);
    const targetHtml = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{box-sizing:border-box;margin:0;width:100%;height:100%;overflow:hidden}webview{position:absolute;inset:0;width:100%;height:100%;border:0}</style></head><body><webview src="${paneUrl}"></webview></body></html>`;
    const guestReady = new Promise((resolve, reject) => {
      target.webContents.once("did-attach-webview", (_event, guest) => {
        guest.once("did-finish-load", resolve);
        guest.once("did-fail-load", (_event, errorCode, errorDescription) => {
          reject(new Error(`pane webview failed to load (${errorCode}): ${errorDescription}`));
        });
      });
    });
    await target.loadURL(dataHtmlUrl(targetHtml));
    reportFixturePhase("target-loaded");
    await guestReady;
    reportFixturePhase("target-webview-ready");
    target.show();
    await target.focus();
    reportFixturePhase("target-shown");
    const viewport = await target.webContents.executeJavaScript("({width:innerWidth,height:innerHeight})");
    reportFixturePhase("target-viewport-ready", viewport);
    const uncovered = await waitForPanePixels(target, viewport.width, viewport.height, targetPixels, "uncovered target capture",
      keepFramesForCoveredCapture);
    assert.equal(target.webContents.getBackgroundThrottling(), true, "uncovered capture restores the prior throttling state");
    console.log("CAPTURE_CASE=" + JSON.stringify({ label: "uncovered", ...uncovered }));

    cover = fixtureWindow({ backgroundThrottling: true, x, y });
    cover.setAlwaysOnTop(true);
    reportFixturePhase("cover-created");
    await cover.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{box-sizing:border-box;margin:0;width:100%;height:100%;overflow:hidden;background:${coverColor}}</style></head><body></body></html>`)}`);
    reportFixturePhase("cover-loaded");
    cover.show();
    cover.focus();
    cover.moveTop();
    reportFixturePhase("cover-shown");
    assert.equal(cover.isVisible(), true);
    assert.deepEqual(cover.getBounds(), target.getBounds(), "the second window covers the target bounds");

    const coveredOverlay = await waitForPixel(cover, Math.floor(viewport.width / 2), Math.floor(viewport.height / 2),
      coverPixels, "covering window capture", false);
    console.log("CAPTURE_CASE=" + JSON.stringify({ label: "cover-window", ...coveredOverlay }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const coveredTarget = await waitForPanePixels(target, viewport.width, viewport.height, targetPixels, "covered target capture",
      keepFramesForCoveredCapture);
    assert.equal(target.webContents.getBackgroundThrottling(), true, "covered capture restores the prior throttling state");
    console.log("CAPTURE_CASE=" + JSON.stringify({ label: "covered", ...coveredTarget }));

    cover.hide();
    const uncoveredAgain = await waitForPanePixels(target, viewport.width, viewport.height, targetPixels,
      "uncovered target capture after cover", keepFramesForCoveredCapture);
    assert.equal(target.webContents.getBackgroundThrottling(), true, "post-cover capture restores the prior throttling state");
    console.log("CAPTURE_CASE=" + JSON.stringify({ label: "uncovered-again", ...uncoveredAgain }));
  } finally {
    cover?.destroy();
    target?.destroy();
    await fs.rm(scratch, { force: true, recursive: true });
    app.quit();
  }
}

if (process.platform !== "linux") {
  console.log("SKIP: covered-pane occlusion capture regression requires Linux/X11.");
  app.quit();
} else {
  void run().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
