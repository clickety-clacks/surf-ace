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

function matches(actual, expected, tolerance = 3) {
  return actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);
}

async function capturePixel(window, x, y, keepFramesForCoveredCapture) {
  const crop = { height: 24, width: 24, x: x - 12, y: y - 12 };
  return referencePixel(await captureWindowPageForPane(window, crop, keepFramesForCoveredCapture), 12, 12);
}

async function waitForPixel(window, x, y, expectedPixels, label, keepFramesForCoveredCapture) {
  let observed;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    observed = await capturePixel(window, x, y, keepFramesForCoveredCapture);
    const expected = expectedPixels.find((candidate) => matches(observed, candidate));
    if (expected) {
      return { attempt, expected, observed };
    }
    if (attempt < 40) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${label}: expected ${JSON.stringify(expectedPixels)}, observed ${JSON.stringify(observed)}`);
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
    webPreferences: { backgroundThrottling },
  });
}

async function run() {
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
  let target;
  let cover;
  try {
    const x = 120;
    const y = 100;
    const targetColor = "#dc2020";
    const coverColor = "#2040dc";
    const targetPixels = pixelPoints([220, 32, 32]);
    const coverPixels = pixelPoints([32, 64, 220]);

    // Use the production capture mode and helper while preserving normal window throttling.
    target = fixtureWindow({ backgroundThrottling: true, x, y });
    await target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{box-sizing:border-box;margin:0;width:100%;height:100%;overflow:hidden;background:${targetColor}}</style></head><body></body></html>`)}`);
    target.show();
    await target.focus();
    const viewport = await target.webContents.executeJavaScript("({width:innerWidth,height:innerHeight})");
    const point = { x: Math.floor(viewport.width / 2), y: Math.floor(viewport.height / 2) };

    const uncovered = await waitForPixel(target, point.x, point.y, targetPixels, "uncovered target capture",
      keepFramesForCoveredCapture);
    assert.equal(target.webContents.getBackgroundThrottling(), true, "uncovered capture restores the prior throttling state");
    console.log("CAPTURE_CASE=" + JSON.stringify({ label: "uncovered", ...uncovered }));

    cover = fixtureWindow({ backgroundThrottling: true, x, y });
    cover.setAlwaysOnTop(true);
    await cover.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{box-sizing:border-box;margin:0;width:100%;height:100%;overflow:hidden;background:${coverColor}}</style></head><body></body></html>`)}`);
    cover.show();
    cover.focus();
    cover.moveTop();
    assert.equal(cover.isVisible(), true);
    assert.deepEqual(cover.getBounds(), target.getBounds(), "the second window covers the target bounds");

    const coveredOverlay = await waitForPixel(cover, point.x, point.y, coverPixels, "covering window capture", false);
    console.log("CAPTURE_CASE=" + JSON.stringify({ label: "cover-window", ...coveredOverlay }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const coveredTarget = await waitForPixel(target, point.x, point.y, [uncovered.expected], "covered target capture",
      keepFramesForCoveredCapture);
    assert.equal(target.webContents.getBackgroundThrottling(), true, "covered capture restores the prior throttling state");
    console.log("CAPTURE_CASE=" + JSON.stringify({ label: "covered", ...coveredTarget }));

    cover.hide();
    const uncoveredAgain = await waitForPixel(target, point.x, point.y, [uncovered.expected], "uncovered target capture after cover",
      keepFramesForCoveredCapture);
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
  await run();
}
