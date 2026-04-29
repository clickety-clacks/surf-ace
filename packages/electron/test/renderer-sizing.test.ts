import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

async function rendererSource(): Promise<string> {
  return fs.readFile(new URL("../../src/renderer/renderer.ts", import.meta.url), "utf8");
}

async function rendererStyles(): Promise<string> {
  return fs.readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
}

async function mainSource(): Promise<string> {
  return fs.readFile(new URL("../../src/main.ts", import.meta.url), "utf8");
}

test("browser_url webviews defer navigation until the pane has a measured frame", async () => {
  const source = await rendererSource();
  const deferIndex = source.indexOf("function deferUntilPaneFrameReady");
  const browserUrlIndex = source.indexOf("if (pane.content.contentType === \"browser_url\")");
  const srcAssignmentIndex = source.indexOf("browserView.src = browserUrl.url", browserUrlIndex);

  assert.ok(deferIndex > -1);
  assert.ok(browserUrlIndex > -1);
  assert.ok(srcAssignmentIndex > browserUrlIndex);
  assert.match(source.slice(browserUrlIndex, srcAssignmentIndex), /deferUntilPaneFrameReady/);
  assert.match(source.slice(deferIndex, srcAssignmentIndex), /applyPaneFrameSize\(view, element\)/);
});

test("renderer reapplies browser_url frame sizing after layout commits and window resizes", async () => {
  const source = await rendererSource();

  assert.match(source, /function refreshDynamicPaneFrames[\s\S]*if \(!latestState\)[\s\S]*for \(const pane of latestState\.panes\)/);
  assert.match(source, /function renderWindow[\s\S]*appRoot\.replaceChildren\(wrapper\);[\s\S]*refreshDynamicPaneFrames\(\)/);
  assert.match(source, /window\.addEventListener\("resize"[\s\S]*const frame = currentPaneFrameElement\(view\);[\s\S]*applyPaneFrameSize\(view, frame\)/);
});

test("browser_url webviews constrain Electron guest bounds to the measured pane", async () => {
  const source = await rendererSource();
  const applyIndex = source.indexOf("function applyPaneFrameSize");
  const sizeIndex = source.indexOf("function sizeWebViewToPane");

  assert.ok(applyIndex > -1);
  assert.match(source.slice(applyIndex, sizeIndex), /element\.setAttribute\("autosize", "on"\)/);
  assert.match(source.slice(applyIndex, sizeIndex), /element\.setAttribute\("minwidth", String\(width\)\)/);
  assert.match(source.slice(applyIndex, sizeIndex), /element\.setAttribute\("maxheight", String\(height\)\)/);
});

test("browser_url diagnostics report host and guest sizing through surface commands", async () => {
  const source = await rendererSource();
  const diagnosticsIndex = source.indexOf("function reportBrowserUrlDiagnostics");
  const browserUrlIndex = source.indexOf("if (pane.content.contentType === \"browser_url\")");

  assert.ok(diagnosticsIndex > -1);
  assert.match(source.slice(diagnosticsIndex, browserUrlIndex), /pane: elementDiagnostics\(view\.rootEl\)/);
  assert.match(source.slice(diagnosticsIndex, browserUrlIndex), /scroll: elementDiagnostics\(view\.scrollEl\)/);
  assert.match(source.slice(diagnosticsIndex, browserUrlIndex), /webview: elementDiagnostics\(webview\)/);
  assert.match(source.slice(diagnosticsIndex, browserUrlIndex), /browserUrlGuestDiagnostics\(webview\)/);
  assert.match(source.slice(browserUrlIndex), /reportBrowserUrlDiagnostics\(view, browserView, "dom-ready"\)/);
  assert.match(source.slice(browserUrlIndex), /reportBrowserUrlDiagnostics\(view, browserView, "did-finish-load"\)/);
});

test("browser_url navigation verifies the guest viewport before reporting success", async () => {
  const source = await rendererSource();
  const mismatchIndex = source.indexOf("function browserUrlViewportMismatch");
  const verifierIndex = source.indexOf("function verifyBrowserUrlGuestViewport");
  const browserUrlIndex = source.indexOf("if (pane.content.contentType === \"browser_url\")");
  const finishIndex = source.indexOf("\"did-finish-load\"", browserUrlIndex);

  assert.ok(mismatchIndex > -1);
  assert.ok(verifierIndex > -1);
  assert.match(source.slice(mismatchIndex, verifierIndex), /Math\.abs\(guest\.innerHeight - hostHeight\)/);
  assert.match(source.slice(mismatchIndex, verifierIndex), /Math\.abs\(guest\.innerWidth - hostWidth\)/);
  assert.match(source.slice(verifierIndex, browserUrlIndex), /browserUrlViewportMismatch\(webview, guest\)/);
  assert.match(source.slice(verifierIndex, browserUrlIndex), /nudgeBrowserUrlWebViewResize\(view, webview\)/);
  assert.match(source.slice(finishIndex), /verifyBrowserUrlGuestViewport\(view, browserView, "did-finish-load:guest-viewport"\)/);
  assert.match(source.slice(finishIndex), /webview guest viewport stuck at/);
  assert.match(source.slice(finishIndex), /reportNavigation\("applied"\)/);
});

test("browser_url diagnostics do not change the active keyboard pane", async () => {
  const source = await mainSource();
  const commandHandlerIndex = source.indexOf("ipcMain.on(\"surface:command\"");
  const focusIndex = source.indexOf("core.setActiveKeyboardPane", commandHandlerIndex);
  const diagnosticsIndex = source.indexOf("payload.type === \"browser-url-diagnostics\"", commandHandlerIndex);

  assert.ok(commandHandlerIndex > -1);
  assert.ok(diagnosticsIndex > commandHandlerIndex);
  assert.ok(focusIndex > diagnosticsIndex);
  assert.match(source.slice(diagnosticsIndex, focusIndex), /recordBrowserUrlDiagnostics\(surfaceId, paneId/);
  assert.match(source.slice(diagnosticsIndex, focusIndex), /return;/);
});

test("html and browser_url frames have a non-auto CSS height fallback", async () => {
  const styles = await rendererStyles();
  const frameRule = styles.match(/\.content-html-frame\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";

  assert.match(frameRule, /height:\s*100%;/);
  assert.match(frameRule, /min-height:\s*100%;/);
  assert.doesNotMatch(frameRule, /height:\s*auto;/);
});

test("browser_url webviews preserve Electron's flex display for the OOPIF child", async () => {
  const styles = await rendererStyles();
  const browserUrlRule = styles.match(/\.content-browser-url-frame\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";

  assert.match(browserUrlRule, /display:\s*flex;/);
});

test("split flex children do not force every pane to full window height", async () => {
  const styles = await rendererStyles();
  const splitChildRule = styles.match(
    /\.layout-split > \.pane-shell,\n\.layout-split > \.layout-split\s*\{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body ?? "";

  assert.match(splitChildRule, /flex:\s*1 1 0;/);
  assert.match(splitChildRule, /height:\s*auto;/);
  assert.match(splitChildRule, /min-height:\s*0;/);
});
