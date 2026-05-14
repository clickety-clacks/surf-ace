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

test("renderer patches same-layout history updates without replacing sibling panes", async () => {
  const source = await rendererSource();
  const patchIndex = source.indexOf("function patchSameLayoutWindow");
  const renderIndex = source.indexOf("function renderWindow");
  const fastPathIndex = source.indexOf("patchSameLayoutWindow(previousState, state)", renderIndex);
  const replaceIndex = source.indexOf("appRoot.replaceChildren(wrapper);", renderIndex);

  assert.ok(patchIndex > -1);
  assert.ok(fastPathIndex > renderIndex);
  assert.ok(replaceIndex > fastPathIndex);
  assert.match(source.slice(patchIndex, renderIndex), /latestLayoutKey !== nextLayoutKey/);
  assert.match(source.slice(patchIndex, renderIndex), /paneRenderKey\(previousState, previousPane\) !== paneRenderKey\(state, pane\)[\s\S]*updatePane\(view, pane\)/);
  assert.doesNotMatch(source.slice(patchIndex, renderIndex), /replaceChildren/);
});

test("renderer reports pane snapshots after layout commits", async () => {
  const source = await rendererSource();
  const helperIndex = source.indexOf("function reportAllPaneSnapshots");
  const renderIndex = source.indexOf("function renderWindow");
  const replaceIndex = source.indexOf("appRoot.replaceChildren(wrapper);", renderIndex);
  const immediateReportIndex = source.indexOf("reportAllPaneSnapshots();", replaceIndex);
  const rafIndex = source.indexOf("window.requestAnimationFrame", immediateReportIndex);
  const rafReportIndex = source.indexOf("reportAllPaneSnapshots();", rafIndex);

  assert.ok(helperIndex > -1);
  assert.ok(renderIndex > helperIndex);
  assert.ok(immediateReportIndex > replaceIndex);
  assert.ok(rafIndex > immediateReportIndex);
  assert.ok(rafReportIndex > rafIndex);
});

test("content replacement resets the pane scroll origin before browser_url mounts", async () => {
  const source = await rendererSource();
  const resetIndex = source.indexOf("function resetDynamicContent");
  const renderIndex = source.indexOf("function renderPaneContent");

  assert.ok(resetIndex > -1);
  assert.ok(renderIndex > resetIndex);
  assert.match(source.slice(resetIndex, renderIndex), /view\.scrollEl\.scrollLeft = 0;/);
  assert.match(source.slice(resetIndex, renderIndex), /view\.scrollEl\.scrollTop = 0;/);
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
  assert.match(source.slice(browserUrlIndex), /reason === "dom-ready:guest-viewport" \? "dom-ready" : "did-finish-load"/);
  assert.match(source.slice(browserUrlIndex), /reportBrowserUrlDiagnostics\(view, browserView, eventReason\)/);
});

test("browser_url render resets guest scroll before verification", async () => {
  const source = await rendererSource();
  const diagnosticsIndex = source.indexOf("async function browserUrlGuestDiagnostics");
  const resetGuestIndex = source.indexOf("function resetBrowserUrlGuestScroll");
  const browserUrlIndex = source.indexOf("if (pane.content.contentType === \"browser_url\")");

  assert.ok(diagnosticsIndex > -1);
  assert.ok(resetGuestIndex > -1);
  assert.ok(resetGuestIndex > diagnosticsIndex);
  assert.match(source.slice(resetGuestIndex, browserUrlIndex), /window\.history\.scrollRestoration = "manual"/);
  assert.match(source.slice(resetGuestIndex, browserUrlIndex), /window\.scrollTo\(0, 0\)/);
  assert.match(source.slice(diagnosticsIndex, resetGuestIndex), /scrollY: Math\.round\(window\.scrollY\)/);
  assert.match(source.slice(browserUrlIndex), /resetBrowserUrlGuestScroll\(browserView\)[\s\S]*verifyBrowserUrlGuestViewport\(view, browserView, reason\)/);
});

test("browser_url navigation verifies the guest viewport before reporting success", async () => {
  const source = await rendererSource();
  const mismatchIndex = source.indexOf("function browserUrlViewportMismatch");
  const verifierIndex = source.indexOf("function verifyBrowserUrlGuestViewport");
  const browserUrlIndex = source.indexOf("if (pane.content.contentType === \"browser_url\")");
  const helperIndex = source.indexOf("const verifyAndReportNavigation", browserUrlIndex);
  const domReadyIndex = source.indexOf("\"dom-ready\"", browserUrlIndex);
  const finishIndex = source.indexOf("\"did-finish-load\"", browserUrlIndex);

  assert.ok(mismatchIndex > -1);
  assert.ok(verifierIndex > -1);
  assert.ok(helperIndex > -1);
  assert.match(source.slice(mismatchIndex, verifierIndex), /Math\.abs\(guest\.innerHeight - hostHeight\)/);
  assert.match(source.slice(mismatchIndex, verifierIndex), /Math\.abs\(guest\.innerWidth - hostWidth\)/);
  assert.match(source.slice(verifierIndex, browserUrlIndex), /browserUrlViewportMismatch\(webview, guest\)/);
  assert.match(source.slice(verifierIndex, browserUrlIndex), /nudgeBrowserUrlWebViewResize\(view, webview\)/);
  assert.match(source.slice(helperIndex), /verifyBrowserUrlGuestViewport\(view, browserView, reason\)/);
  assert.match(source.slice(helperIndex), /webview guest viewport stuck at/);
  assert.match(source.slice(helperIndex), /reportNavigation\("applied"\)/);
  assert.match(source.slice(domReadyIndex), /verifyAndReportNavigation\("dom-ready:guest-viewport"\)/);
  assert.match(source.slice(finishIndex), /verifyAndReportNavigation\("did-finish-load:guest-viewport"\)/);
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

test("keyboard shortcuts route pane navigation and focused pane scroll intents", async () => {
  const source = await mainSource();
  const shortcutIndex = source.indexOf("function wireWindowShortcuts");

  assert.ok(shortcutIndex > -1);
  assert.match(source.slice(shortcutIndex), /keyboardDirectionForPhysicalKey\(input\.code\)/);
  assert.match(source.slice(shortcutIndex), /command && input\.alt && input\.shift && !input\.control && paneNavigationDirection/);
  assert.match(source.slice(shortcutIndex), /core\.navigateActiveKeyboardPane\(surfaceId, paneNavigationDirection\)/);
  assert.match(source.slice(shortcutIndex), /core\.navigateActiveKeyboardPane\(surfaceId, paneNavigationDirection\);[\s\S]*event\.preventDefault\(\);[\s\S]*return;/);
  assert.match(source.slice(shortcutIndex), /activePane\.annotationBorderVisible/);
  assert.match(source.slice(shortcutIndex), /command && !input\.alt && !input\.shift && !input\.control && vimDirection/);
  assert.match(source.slice(shortcutIndex), /sendKeyboardScrollIntent\(window, activePaneId, vimDirection, "line"\)/);
  assert.match(source.slice(shortcutIndex), /keyboardDirectionForArrowKey\(input\.key\)/);
  assert.match(source.slice(shortcutIndex), /input\.key === "PageUp" \|\| input\.key === "PageDown"/);
});

test("custom window cycling is not installed on macOS where Cmd-backtick is platform-owned", async () => {
  const source = await mainSource();
  const shortcutIndex = source.indexOf("function wireWindowShortcuts");

  assert.ok(shortcutIndex > -1);
  assert.match(source.slice(shortcutIndex), /process\.platform !== "darwin"[\s\S]*input\.key === "`"[\s\S]*focusNextWindow\(surfaceId\)/);
});

test("renderer applies keyboard scroll intents to regular, html, and browser_url pane content", async () => {
  const source = await rendererSource();
  const intentIndex = source.indexOf("function scrollPaneByKeyboard");
  const initIndex = source.indexOf("async function init");

  assert.ok(intentIndex > -1);
  assert.match(source.slice(intentIndex, initIndex), /webview\.executeJavaScript\?\.\(/);
  assert.match(source.slice(intentIndex, initIndex), /paneStateFor\(view\)\?\.annotationBorderVisible/);
  assert.match(source.slice(intentIndex, initIndex), /reportBrowserUrlKeyboardScroll\(view, result\)/);
  assert.match(source.slice(intentIndex, initIndex), /scrollPromise[\s\S]*\.catch\(\(\) => \{\}\)/);
  assert.match(source.slice(intentIndex, initIndex), /frame\.contentWindow\.scrollBy/);
  assert.match(source.slice(intentIndex, initIndex), /view\.scrollEl\.scrollBy/);
  assert.match(source.slice(initIndex), /window\.surfAce\.onKeyboardIntent/);
});

test("html and browser_url frames have a non-auto CSS height fallback", async () => {
  const styles = await rendererStyles();
  const frameRule = styles.match(/\.content-html-frame\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";

  assert.match(frameRule, /height:\s*100%;/);
  assert.match(frameRule, /min-height:\s*100%;/);
  assert.doesNotMatch(frameRule, /height:\s*auto;/);
});

test("html frames relay host pointer events into iframe content", async () => {
  const source = await rendererSource();
  const styles = await rendererStyles();

  assert.match(source, /function relayHtmlFramePointerEvents/);
  assert.match(source, /channel: "surf-ace-host-relay"/);
  assert.match(source, /new PointerEvent\(payload\.eventType/);
  assert.match(source, /frame\.className = "content-html-frame content-html-frame--host-relay"/);
  assert.match(styles, /\.content-html-frame--host-relay\s*\{[\s\S]*pointer-events:\s*none;/);
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

test("renderer chrome shows separate session, window, and global pane identity fields", async () => {
  const source = await rendererSource();
  const styles = await rendererStyles();

  assert.match(source, /provenanceName: string \| null/);
  assert.match(source, /const navigationOwnerName = pane\.provenanceName \?\? pane\.ownerName/);
  assert.match(source, /ownerName\.textContent = navigationOwnerName/);
  assert.match(source, /provenanceLabelEl\.className = "pane-label__sender"/);
  assert.match(source, /labelEl\.append\(provenanceLabelEl, windowLabelEl, labelTextEl\)/);
  assert.match(source, /windowLabel\.hidden = !visibleWindowLabel/);
  assert.doesNotMatch(source, /windowLabel\.hidden = true/);
  assert.match(source, /label\.textContent = visibleAddress\.toUpperCase\(\)/);
  assert.match(source, /` window \$\{visibleWindowLabel\}`/);
  assert.match(source, /`Surf Ace\$\{visibleWindowLabel/);
  assert.match(source, /pane \$\{visibleAddress\}/);
  assert.doesNotMatch(source, /displayId:\s*`\$\{surface\.windowLabel\}\$\{pane\.paneLabel\}`/);
  assert.doesNotMatch(source, /visibleAddress:\s*`\$\{surface\.windowLabel\}\$\{pane\.paneLabel\}`/);

  assert.match(styles, /\.pane-label__sender\s*\{/);
});

test("renderer exposes split resize handles and reports resize-split commands", async () => {
  const source = await rendererSource();
  const styles = await rendererStyles();

  assert.match(source, /type:\s*"resize-split"/);
  assert.match(source, /weights:\s*nextWeights/);
  assert.match(source, /style\.flexGrow = String\(layoutWeight/);
  assert.match(styles, /\.split-resize-handle\s*\{/);
  assert.match(styles, /cursor:\s*col-resize;/);
  assert.match(styles, /cursor:\s*row-resize;/);
});
