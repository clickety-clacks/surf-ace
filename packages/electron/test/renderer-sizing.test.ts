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

async function guestPreloadSource(): Promise<string> {
  return fs.readFile(new URL("../../src/guest-preload.ts", import.meta.url), "utf8");
}

async function preloadSource(): Promise<string> {
  return fs.readFile(new URL("../../src/preload.ts", import.meta.url), "utf8");
}

test("browser_url webviews defer navigation until the pane has a measured frame", async () => {
  const source = await rendererSource();
  const deferIndex = source.indexOf("function deferUntilPaneFrameReady");
  const renderBrowserIndex = source.indexOf("function renderBrowserContent");
  const browserUrlIndex = source.indexOf("if (pane.content.contentType === \"browser_url\")");
  const srcAssignmentIndex = source.indexOf("browserView.src = url", renderBrowserIndex);

  assert.ok(deferIndex > -1);
  assert.ok(renderBrowserIndex > -1);
  assert.ok(browserUrlIndex > -1);
  assert.ok(srcAssignmentIndex > renderBrowserIndex);
  assert.match(source.slice(renderBrowserIndex, srcAssignmentIndex), /deferUntilPaneFrameReady/);
  assert.match(source.slice(browserUrlIndex), /renderBrowserContent\(view, pane, renderToken, browserUrl\.url/);
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

test("main preserves omitted browser-hosted snapshot fields", async () => {
  const source = await mainSource();
  const snapshotIndex = source.indexOf("ipcMain.on(\"surface:snapshot\"");
  const pageIndex = source.indexOf("ipcMain.on(\"surface:page\"", snapshotIndex);
  const handlerSource = source.slice(snapshotIndex, pageIndex);

  assert.ok(snapshotIndex > -1);
  assert.ok(pageIndex > snapshotIndex);
  assert.match(handlerSource, /const snapshot: Parameters<SurfaceCore\["updatePaneSnapshot"\]>\[2\] = \{\};/);
  for (const key of ["bounds", "selection", "viewport", "visibleText"]) {
    assert.match(handlerSource, new RegExp(`if \\("${key}" in payload\\)`));
  }
  assert.doesNotMatch(handlerSource, /selection:\s*\(payload\.selection \?\? null\)/);
  assert.doesNotMatch(handlerSource, /visibleText:\s*String\(payload\.visibleText \?\? ""\)/);
});

test("changed content replacement resets the pane scroll origin before browser_url mounts", async () => {
  const source = await rendererSource();
  const resetIndex = source.indexOf("function resetDynamicContent");
  const renderIndex = source.indexOf("function renderPaneContent");
  const duplicateIndex = source.indexOf("isDuplicateRepush(view, pane, nextSignature)", renderIndex);

  assert.ok(resetIndex > -1);
  assert.ok(renderIndex > resetIndex);
  assert.ok(duplicateIndex > renderIndex);
  assert.match(source.slice(resetIndex, renderIndex), /view\.scrollEl\.scrollLeft = 0;/);
  assert.match(source.slice(resetIndex, renderIndex), /view\.scrollEl\.scrollTop = 0;/);
  assert.match(source.slice(duplicateIndex), /showDuplicateRepushOverlay\(view, pane, nextSignature!\)/);
  assert.match(source.slice(duplicateIndex), /return;/);
  assert.match(source.slice(duplicateIndex), /const renderToken = resetDynamicContent\(view\)/);
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
  const renderBrowserIndex = source.indexOf("function renderBrowserContent");

  assert.ok(diagnosticsIndex > -1);
  assert.match(source.slice(diagnosticsIndex, renderBrowserIndex), /pane: elementDiagnostics\(view\.rootEl\)/);
  assert.match(source.slice(diagnosticsIndex, renderBrowserIndex), /scroll: elementDiagnostics\(view\.scrollEl\)/);
  assert.match(source.slice(diagnosticsIndex, renderBrowserIndex), /webview: elementDiagnostics\(webview\)/);
  assert.match(source.slice(diagnosticsIndex, renderBrowserIndex), /browserUrlGuestDiagnosticsWithTimeout\(webview\)/);
  assert.match(source.slice(diagnosticsIndex, renderBrowserIndex), /webviewCurrentUrl: browserUrlElementCurrentUrl\(webview\)/);
  assert.match(source.slice(diagnosticsIndex, renderBrowserIndex), /webviewTitle: browserUrlElementTitle\(webview\)/);
  assert.match(source.slice(renderBrowserIndex), /reason === "dom-ready:guest-viewport" \? "dom-ready" : "did-finish-load"/);
  assert.match(source.slice(renderBrowserIndex), /reportBrowserUrlDiagnostics\(view, browserView, eventReason\)/);
});

test("browser_url diagnostics report URL scheme, load errors, and readback result", async () => {
  const source = await rendererSource();
  const renderBrowserIndex = source.indexOf("function renderBrowserContent");

  assert.ok(renderBrowserIndex > -1);
  assert.match(source.slice(renderBrowserIndex), /browserUrlDiagnosticFields\(url\)/);
  assert.match(source.slice(renderBrowserIndex), /browser_content_did_start_loading/);
  assert.match(source.slice(renderBrowserIndex), /browser_content_page_title_updated/);
  assert.match(source.slice(renderBrowserIndex), /browser_content_console_message/);
  assert.match(source.slice(renderBrowserIndex), /browserUrlGuestDiagnosticsWithTimeout\(browserView\)\.catch/);
  assert.match(source, /BROWSER_URL_DIAGNOSTIC_READBACK_TIMEOUT_MS = 500/);
  assert.match(source.slice(renderBrowserIndex), /errorCode: failure\.errorCode/);
  assert.match(source.slice(renderBrowserIndex), /failedUrl: failure\.validatedURL/);
  assert.match(source.slice(renderBrowserIndex), /isMainFrame: failure\.isMainFrame/);
  assert.match(source.slice(renderBrowserIndex), /currentUrl: browserUrlElementCurrentUrl\(browserView\)/);
  assert.match(source.slice(renderBrowserIndex), /pageTitle: browserUrlElementTitle\(browserView\)/);
  assert.match(source.slice(renderBrowserIndex), /readbackResult/);
});

test("browser_url render resets guest scroll before verification", async () => {
  const source = await rendererSource();
  const diagnosticsIndex = source.indexOf("async function browserUrlGuestDiagnostics");
  const resetGuestIndex = source.indexOf("function resetBrowserUrlGuestScroll");
  const renderBrowserIndex = source.indexOf("function renderBrowserContent");

  assert.ok(diagnosticsIndex > -1);
  assert.ok(resetGuestIndex > -1);
  assert.ok(resetGuestIndex > diagnosticsIndex);
  assert.match(source.slice(resetGuestIndex, renderBrowserIndex), /window\.history\.scrollRestoration = "manual"/);
  assert.match(source.slice(resetGuestIndex, renderBrowserIndex), /window\.scrollTo\(0, 0\)/);
  assert.match(source.slice(diagnosticsIndex, resetGuestIndex), /scrollY: Math\.round\(window\.scrollY\)/);
  assert.match(source.slice(renderBrowserIndex), /resetBrowserUrlGuestScroll\(browserView\)[\s\S]*verifyBrowserUrlGuestViewport\(view, browserView, reason\)/);
});

test("browser_url navigation verifies the guest viewport before reporting success", async () => {
  const source = await rendererSource();
  const mismatchIndex = source.indexOf("function browserUrlViewportMismatch");
  const verifierIndex = source.indexOf("function verifyBrowserUrlGuestViewport");
  const renderBrowserIndex = source.indexOf("function renderBrowserContent");
  const helperIndex = source.indexOf("const verifyAndReportNavigation", renderBrowserIndex);
  const domReadyIndex = source.indexOf("\"dom-ready\"", renderBrowserIndex);
  const finishIndex = source.indexOf("\"did-finish-load\"", renderBrowserIndex);

  assert.ok(mismatchIndex > -1);
  assert.ok(verifierIndex > -1);
  assert.ok(helperIndex > -1);
  assert.match(source.slice(mismatchIndex, verifierIndex), /Math\.abs\(guest\.innerHeight - hostHeight\)/);
  assert.match(source.slice(mismatchIndex, verifierIndex), /Math\.abs\(guest\.innerWidth - hostWidth\)/);
  assert.match(source.slice(verifierIndex, renderBrowserIndex), /browserUrlViewportMismatch\(webview, guest\)/);
  assert.match(source.slice(verifierIndex, renderBrowserIndex), /nudgeBrowserUrlWebViewResize\(view, webview\)/);
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

test("browser_url navigation command forwards renderer readback evidence", async () => {
  const source = await mainSource();
  const navigationIndex = source.indexOf("case \"browser-url-navigation\"");
  const drawIndex = source.indexOf("case \"draw-stroke\"", navigationIndex);

  assert.ok(navigationIndex > -1);
  assert.match(source.slice(navigationIndex, drawIndex), /currentUrl: payload\.currentUrl/);
  assert.match(source.slice(navigationIndex, drawIndex), /pageTitle: payload\.pageTitle/);
  assert.match(source.slice(navigationIndex, drawIndex), /readbackResult: payload\.readbackResult/);
});

test("keyboard shortcuts route pane navigation and focused pane scroll intents", async () => {
  const source = await mainSource();
  const shortcutIndex = source.indexOf("function handleShortcutInput");
  const windowWireIndex = source.indexOf("function wireWindowShortcuts");

  assert.ok(shortcutIndex > -1);
  assert.ok(windowWireIndex > shortcutIndex);
  assert.match(source.slice(shortcutIndex, windowWireIndex), /focusedPaneId && focusedPaneId > 0[\s\S]*core\.setActiveKeyboardPane\(surfaceId, focusedPaneId\)/);
  assert.match(source.slice(shortcutIndex), /keyboardDirectionForPhysicalKey\(input\.code\)/);
  assert.match(source.slice(shortcutIndex), /command && input\.alt && input\.shift && !input\.control && paneNavigationDirection/);
  assert.match(source.slice(shortcutIndex), /core\.navigateActiveKeyboardPane\(surfaceId, paneNavigationDirection\)/);
  assert.match(source.slice(shortcutIndex), /core\.navigateActiveKeyboardPane\(surfaceId, paneNavigationDirection\);[\s\S]*event\.preventDefault\(\);[\s\S]*return;/);
  assert.match(source.slice(shortcutIndex), /activePane\.annotationBorderVisible/);
  assert.match(source.slice(shortcutIndex), /command && !input\.alt && !input\.shift && !input\.control && vimDirection/);
  assert.match(source.slice(shortcutIndex), /sendKeyboardScrollIntent\(window, activePaneId, vimDirection, "line"\)/);
  assert.match(source.slice(shortcutIndex), /keyboardDirectionForArrowKey\(input\.key\)/);
  assert.match(source.slice(shortcutIndex), /input\.key === "PageUp" \|\| input\.key === "PageDown"/);
  assert.match(source.slice(windowWireIndex), /wireWebContentsShortcuts\(surfaceId, window, window\.webContents, \(\) => null\)/);
});

test("font-size shortcuts route focused pane content scale intents", async () => {
  const source = await mainSource();
  const shortcutIndex = source.indexOf("function handleShortcutInput");
  const windowWireIndex = source.indexOf("function wireWindowShortcuts");

  assert.ok(shortcutIndex > -1);
  assert.ok(windowWireIndex > shortcutIndex);
  assert.match(source.slice(shortcutIndex, windowWireIndex), /contentScaleActionForInput\(input\)/);
  assert.match(source, /function contentScaleActionForInput[\s\S]*!input\.meta \|\| input\.alt \|\| input\.control/);
  assert.match(source, /function contentScaleActionForInput[\s\S]*input\.key === "\+" \|\| input\.key === "="/);
  assert.match(source, /function contentScaleActionForInput[\s\S]*if \(input\.shift\)[\s\S]*return null/);
  assert.match(source, /function contentScaleActionForInput[\s\S]*input\.key === "-"/);
  assert.match(source, /function contentScaleActionForInput[\s\S]*input\.key === "0"/);
  assert.match(source.slice(shortcutIndex, windowWireIndex), /sendContentScaleIntent\(window, activePaneId, contentScaleAction\)/);
  assert.match(source.slice(shortcutIndex, windowWireIndex), /sendContentScaleIntent\(window, activePaneId, contentScaleAction\);[\s\S]*event\.preventDefault\(\);[\s\S]*return;/);
});

test("custom window cycling is not installed on macOS where Cmd-backtick is platform-owned", async () => {
  const source = await mainSource();
  const shortcutIndex = source.indexOf("function handleShortcutInput");

  assert.ok(shortcutIndex > -1);
  assert.match(source.slice(shortcutIndex), /process\.platform !== "darwin"[\s\S]*input\.key === "`"[\s\S]*focusNextWindow\(surfaceId\)/);
});

test("application menu preserves native clipboard and selection edit roles", async () => {
  const source = await mainSource();
  const menuIndex = source.indexOf("function installMenu");
  const ipcIndex = source.indexOf("function installIpc");
  const menuSource = source.slice(menuIndex, ipcIndex);

  assert.ok(menuIndex > -1);
  assert.ok(ipcIndex > menuIndex);
  assert.match(menuSource, /label: "Edit"/);
  for (const role of ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]) {
    assert.match(menuSource, new RegExp(`role: "${role}"`));
  }
});

test("editable contexts show native text input context menu in renderer and browser_url webviews", async () => {
  const source = await mainSource();
  const templateIndex = source.indexOf("function editableContextMenuTemplate");
  const contextWireIndex = source.indexOf("function wireEditableContextMenu");
  const shortcutIndex = source.indexOf("function wireWindowShortcuts");
  const wireIndex = source.indexOf("function wireWindowInputMenus");
  const createWindowIndex = source.indexOf("async function createWindowForSurface");
  const templateSource = source.slice(templateIndex, shortcutIndex);
  const contextWireSource = source.slice(contextWireIndex, shortcutIndex);
  const wireSource = source.slice(wireIndex, createWindowIndex);
  const createWindowSource = source.slice(createWindowIndex);

  assert.ok(templateIndex > -1);
  assert.ok(contextWireIndex > templateIndex);
  assert.ok(shortcutIndex > templateIndex);
  assert.ok(wireIndex > shortcutIndex);
  assert.ok(createWindowIndex > wireIndex);
  assert.match(templateSource, /role: "cut"/);
  assert.match(templateSource, /role: "copy"/);
  assert.match(templateSource, /role: "paste"/);
  assert.match(templateSource, /role: "pasteAndMatchStyle"/);
  assert.match(templateSource, /role: "delete"/);
  assert.match(templateSource, /role: "selectAll"/);
  assert.match(contextWireSource, /if \(!params\.isEditable\)/);
  assert.match(contextWireSource, /event\.preventDefault\(\)/);
  assert.match(contextWireSource, /Menu\.buildFromTemplate\(editableContextMenuTemplate\(params\)\)\.popup\(\{ window \}\)/);
  assert.match(wireSource, /window\.webContents\.on\("did-attach-webview"[\s\S]*wireEditableContextMenu\(webContents, window\)/);
  assert.match(createWindowSource, /wireWindowInputMenus\(surfaceId, window\)/);
});

test("browser_url guest webContents route Surf Ace shortcuts through the owning pane", async () => {
  const source = await mainSource();
  const recordIndex = source.indexOf("function recordBrowserUrlDiagnostics");
  const shortcutIndex = source.indexOf("function handleShortcutInput");
  const wireIndex = source.indexOf("function wireWindowInputMenus");
  const createWindowIndex = source.indexOf("async function createWindowForSurface");

  assert.ok(recordIndex > -1);
  assert.match(source.slice(recordIndex, shortcutIndex), /browserUrlWebContentsPanes\.set\(webContentsId, \{ paneId, surfaceId \}\)/);
  assert.ok(shortcutIndex > recordIndex);
  assert.match(source.slice(shortcutIndex, wireIndex), /focusedPaneId && focusedPaneId > 0[\s\S]*core\.setActiveKeyboardPane\(surfaceId, focusedPaneId\)/);
  assert.match(source.slice(shortcutIndex, wireIndex), /focusedPaneId && focusedPaneId > 0 \? focusedPaneId : core\.activeKeyboardPaneId\(surfaceId\)/);
  assert.ok(wireIndex > shortcutIndex);
  assert.match(source.slice(wireIndex, createWindowIndex), /window\.webContents\.on\("did-attach-webview"[\s\S]*wireWebContentsShortcuts\(surfaceId, window, webContents/);
  assert.match(source.slice(wireIndex, createWindowIndex), /browserUrlWebContentsPanes\.get\(webContents\.id\)/);
  assert.match(source.slice(wireIndex, createWindowIndex), /browserUrlWebContentsPanes\.delete\(webContents\.id\)/);
  assert.match(source.slice(createWindowIndex), /wireWindowInputMenus\(surfaceId, window\)/);
});

test("browser_url guest webContents route Surf Ace content-scale shortcuts through the owning pane", async () => {
  const source = await mainSource();
  const shortcutIndex = source.indexOf("function handleShortcutInput");
  const wireIndex = source.indexOf("function wireWindowInputMenus");
  const createWindowIndex = source.indexOf("async function createWindowForSurface");

  assert.ok(shortcutIndex > -1);
  assert.ok(wireIndex > shortcutIndex);
  assert.match(source.slice(shortcutIndex, wireIndex), /focusedPaneId && focusedPaneId > 0 \? focusedPaneId : core\.activeKeyboardPaneId\(surfaceId\)/);
  assert.match(source.slice(shortcutIndex, wireIndex), /sendContentScaleIntent\(window, activePaneId, contentScaleAction\)/);
  assert.match(source.slice(wireIndex, createWindowIndex), /wireWebContentsShortcuts\(surfaceId, window, webContents/);
  assert.match(source.slice(wireIndex, createWindowIndex), /browserUrlWebContentsPanes\.get\(webContents\.id\)/);
});

test("renderer applies keyboard scroll intents to regular and browser-hosted pane content", async () => {
  const source = await rendererSource();
  const intentIndex = source.indexOf("function scrollPaneByKeyboard");
  const initIndex = source.indexOf("async function init");

  assert.ok(intentIndex > -1);
  assert.match(source.slice(intentIndex, initIndex), /webview\.executeJavaScript\?\.\(/);
  assert.match(source.slice(intentIndex, initIndex), /paneStateFor\(view\)\?\.annotationBorderVisible/);
  assert.match(source.slice(intentIndex, initIndex), /reportBrowserUrlKeyboardScroll\(view, result\)/);
  assert.match(source.slice(intentIndex, initIndex), /scrollPromise[\s\S]*\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(source.slice(intentIndex, initIndex), /frame\.contentWindow\.scrollBy/);
  assert.match(source.slice(intentIndex, initIndex), /view\.scrollEl\.scrollBy/);
  assert.match(source.slice(initIndex), /window\.surfAce\.onKeyboardIntent/);
});

test("renderer scales every source-proven scalable content type", async () => {
  const source = await rendererSource();
  const styles = await rendererStyles();
  const scalableIndex = source.indexOf("function isRendererScalableContentType");
  const scaleIndex = source.indexOf("function scalePaneContent");
  const renderIndex = source.indexOf("function renderPaneContent");
  const initIndex = source.indexOf("async function init");

  assert.ok(scalableIndex > -1);
  assert.ok(scaleIndex > scalableIndex);
  for (const contentType of ["browser_url", "html", "image", "markdown", "pdf", "terminal"]) {
    assert.match(source.slice(scalableIndex, scaleIndex), new RegExp(`contentType === "${contentType}"`));
  }
  assert.doesNotMatch(source.slice(scalableIndex, scaleIndex), /contentType === "video"/);
  assert.doesNotMatch(source.slice(scalableIndex, scaleIndex), /contentType === "canvas"/);
  assert.match(source.slice(scaleIndex, renderIndex), /pane\?\.annotationBorderVisible/);
  assert.match(source.slice(scaleIndex, renderIndex), /view\.scale = nextContentScale\(view\.scale, intent\.action\)/);
  assert.match(source.slice(scaleIndex, renderIndex), /applyContentScale\(view\)/);
  assert.match(source.slice(renderIndex), /view\.contentEl\.style\.setProperty\("--surf-ace-content-scale", String\(view\.scale\)\)/);
  assert.match(source.slice(initIndex), /isContentScaleIntent\(intent\)[\s\S]*scalePaneContent\(intent\)/);
  assert.match(styles, /--surf-ace-content-scale:\s*1;/);
  assert.match(styles, /\.content-markdown\s*\{[\s\S]*font-size:\s*calc\(17px \* var\(--surf-ace-content-scale\)\)/);
  assert.match(styles, /\.content-terminal\s*\{[\s\S]*font:\s*calc\(14px \* var\(--surf-ace-content-scale\)\)\/1\.45/);
  assert.match(styles, /\.content-image\s*\{[\s\S]*width:\s*calc\(100% \* var\(--surf-ace-content-scale\)\)/);
  assert.match(styles, /\.content-pdf-stack\s*\{[\s\S]*width:\s*calc\(100% \* var\(--surf-ace-content-scale\)\)/);
});

test("html and browser_url content scale through guest document zoom", async () => {
  const source = await rendererSource();
  const scaleIndex = source.indexOf("function applyBrowserContentScale");
  const renderBrowserIndex = source.indexOf("function renderBrowserContent");
  const renderPaneIndex = source.indexOf("function renderPaneContent");

  assert.ok(scaleIndex > -1);
  assert.ok(renderBrowserIndex > scaleIndex);
  assert.match(source.slice(scaleIndex, renderBrowserIndex), /document\.documentElement\.style\.zoom = scale === 1 \? "" : String\(scale\)/);
  assert.match(source.slice(scaleIndex, renderBrowserIndex), /document\.body\?\.style\.setProperty\("--surf-ace-content-scale", String\(scale\)\)/);
  assert.match(source.slice(renderBrowserIndex, renderPaneIndex), /reportBrowserUrlDiagnostics\(view, browserView, "did-attach"\);[\s\S]*applyBrowserContentScale\(view, browserView\)/);
  assert.match(source.slice(renderBrowserIndex, renderPaneIndex), /reportBrowserUrlDiagnostics\(view, browserView, eventReason\);[\s\S]*applyBrowserContentScale\(view, browserView\)/);
});

test("html and browser_url frames have a non-auto CSS height fallback", async () => {
  const styles = await rendererStyles();
  const frameRule = styles.match(/\.content-html-frame\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";

  assert.match(frameRule, /height:\s*100%;/);
  assert.match(frameRule, /min-height:\s*100%;/);
  assert.doesNotMatch(frameRule, /height:\s*auto;/);
});

test("html content is loaded through the browser webview surface", async () => {
  const source = await rendererSource();
  const styles = await rendererStyles();
  const guestPreload = await guestPreloadSource();
  const preload = await preloadSource();

  const htmlIndex = source.indexOf("if (pane.content.contentType === \"html\")");
  const browserUrlIndex = source.indexOf("if (pane.content.contentType === \"browser_url\")");

  assert.ok(htmlIndex > -1);
  assert.ok(browserUrlIndex > htmlIndex);
  assert.match(source.slice(htmlIndex, browserUrlIndex), /const htmlUrl = htmlDocumentDataUrl/);
  assert.match(source.slice(htmlIndex, browserUrlIndex), /renderBrowserContent\(view, pane, renderToken, htmlUrl, \{ staticHtmlSourceUrl: htmlUrl \}\)/);
  assert.match(source, /document\.createElement\("webview"\)/);
  assert.match(source, /browserView\.setAttribute\("preload", window\.surfAce\.guestPreloadPath\)/);
  assert.match(preload, /ipcRenderer\.sendSync\("surface:get-guest-preload-path"\)/);
  assert.match(preload, /guestPreloadPath,/);
  assert.doesNotMatch(preload, /from "node:/);
  assert.match(source, /if \(options\?\.allowPopups\)[\s\S]*browserView\.setAttribute\("allowpopups", "true"\)/);
  assert.match(source.slice(browserUrlIndex), /allowPopups: true/);
  assert.doesNotMatch(source.slice(htmlIndex, browserUrlIndex), /allowPopups: true/);
  assert.match(source, /const blockStaticHtmlNavigation = \(event: Event\) =>[\s\S]*sendNavigationIntent\(view, pane\.paneId, nextUrl\)/);
  assert.match(source, /window\.surfAce\.reportSnapshot\(\{\s*bounds: paneBounds\(view\),\s*paneId: view\.paneId,\s*\}\)/);
  assert.match(source, /webview\.addEventListener\("ipc-message", onIpcMessage\)/);
  assert.match(guestPreload, /ipcRenderer\.sendToHost\("surf-ace-content", payload\)/);
  assert.match(guestPreload, /if \(window\.location\.protocol === "data:"\)[\s\S]*event\.preventDefault\(\)/);
  assert.doesNotMatch(source, /document\.createElement\("iframe"\)/);
  assert.doesNotMatch(source, /\.srcdoc\b/);
  assert.doesNotMatch(source, /HTMLIFrameElement/);
  assert.doesNotMatch(source, /function relayHtmlFramePointerEvents/);
  assert.doesNotMatch(source, /channel: "surf-ace-host-relay"/);
  assert.doesNotMatch(source, /new PointerEvent\(payload\.eventType/);
  assert.doesNotMatch(source, /content-html-frame--host-relay/);
  assert.doesNotMatch(styles, /\.content-html-frame--host-relay/);
});

test("duplicate html and browser_url pushes preserve the mounted guest and show culprit overlay", async () => {
  const source = await rendererSource();
  const styles = await rendererStyles();
  const signatureIndex = source.indexOf("function duplicateRepushSignature");
  const duplicateIndex = source.indexOf("function isDuplicateRepush");
  const culpritIndex = source.indexOf("function duplicateRepushCulpritLines");
  const overlayIndex = source.indexOf("function showDuplicateRepushOverlay");
  const renderIndex = source.indexOf("function renderPaneContent");
  const resetIndex = source.indexOf("const renderToken = resetDynamicContent(view)", renderIndex);

  assert.ok(signatureIndex > -1);
  assert.ok(duplicateIndex > signatureIndex);
  assert.ok(culpritIndex > duplicateIndex);
  assert.ok(overlayIndex > culpritIndex);
  assert.ok(renderIndex > overlayIndex);
  assert.ok(resetIndex > renderIndex);
  assert.match(source.slice(signatureIndex, duplicateIndex), /pane\.content\.contentType === "browser_url"[\s\S]*url/);
  assert.match(source.slice(signatureIndex, duplicateIndex), /pane\.content\.contentType === "html"[\s\S]*baseUrl[\s\S]*html\.html/);
  assert.match(source.slice(duplicateIndex, overlayIndex), /view\.currentContentSignature\.kind === nextSignature\.kind/);
  assert.match(source.slice(duplicateIndex, overlayIndex), /view\.currentContentSignature\.value === nextSignature\.value/);
  assert.match(
    source.slice(renderIndex, resetIndex),
    /view\.currentContentKey = key;[\s\S]*showDuplicateRepushOverlay\(view, pane, nextSignature!\)[\s\S]*reportDuplicateBrowserUrlNavigation\(pane\)[\s\S]*return;/,
  );
  assert.doesNotMatch(source.slice(renderIndex, resetIndex), /resetDynamicContent\(view\)/);
  assert.match(source.slice(overlayIndex, renderIndex), /type: "browser-url-navigation"/);
  assert.match(source.slice(overlayIndex, renderIndex), /status: "applied"/);
  assert.match(source.slice(overlayIndex, renderIndex), /targetId: pane\.content\.contentId/);
  assert.match(source.slice(culpritIndex, overlayIndex), /provenance\?\.sessionKey/);
  assert.match(source.slice(culpritIndex, overlayIndex), /provenance\?\.source/);
  assert.match(source.slice(culpritIndex, overlayIndex), /provenance\?\.agentId/);
  assert.match(source.slice(culpritIndex, overlayIndex), /provenance\?\.streamLabel/);
  assert.doesNotMatch(source.slice(overlayIndex, renderIndex), /duplicate_repush_preserved_scroll/);
  assert.match(source.slice(overlayIndex, renderIndex), /createIconButton\("x", "Dismiss duplicate re-push notice"/);
  assert.match(styles, /\.duplicate-repush-overlay\s*\{/);
  assert.match(styles, /\.duplicate-repush-overlay__close\s*\{/);
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

test("renderer chrome keeps session names in navigation chrome, not pane identity overlay", async () => {
  const source = await rendererSource();
  const styles = await rendererStyles();

  assert.match(source, /provenanceName: string \| null/);
  assert.match(source, /ownerName: string \| null/);
  assert.match(source, /const navigationOwnerName = pane\.provenanceName/);
  assert.match(source, /ownerName\.className = "navigation-pill__owner"/);
  assert.match(source, /ownerName\.textContent = navigationOwnerName/);
  assert.doesNotMatch(source, /pane-label__sender/);
  assert.doesNotMatch(source, /provenanceLabelEl/);
  assert.match(source, /labelEl\.append\(windowLabelEl, labelTextEl\)/);
  assert.match(source, /connectionBar: state\.connectionBar/);
  assert.doesNotMatch(source, /const showProviderIdentity = latestState\?\.connectionBar === "connected"/);
  assert.match(source, /const visibleAddress = pane\.displayId \|\| pane\.visibleAddress \|\| pane\.label/);
  assert.match(source, /windowLabel\.hidden = !visibleWindowLabel/);
  assert.doesNotMatch(source, /windowLabel\.hidden = true/);
  assert.match(source, /label\.textContent = visibleAddress\.toUpperCase\(\)/);
  assert.match(source, /` window \$\{visibleWindowLabel\}`/);
  assert.match(source, /`Surf Ace\$\{visibleWindowLabel/);
  assert.match(source, /pane \$\{visibleAddress\}/);
  assert.doesNotMatch(source, /displayId:\s*`\$\{surface\.windowLabel\}\$\{pane\.paneLabel\}`/);
  assert.doesNotMatch(source, /visibleAddress:\s*`\$\{surface\.windowLabel\}\$\{pane\.paneLabel\}`/);

  assert.doesNotMatch(styles, /\.pane-label__sender\s*\{/);
  assert.match(styles, /\.navigation-pill__owner\s*\{[\s\S]*font-size:\s*calc\(13px \+ 3pt\)/);
});

test("renderer fits pane identity labels inside pane bounds for native and renderer panes", async () => {
  const source = await rendererSource();
  const styles = await rendererStyles();
  const metricsIndex = source.indexOf("function setPaneChromeMetrics");
  const fitIndex = source.indexOf("function fitPaneLabelToVisibleBounds");
  const updateIndex = source.indexOf("function updatePane");
  const textIndex = source.indexOf("label.textContent = visibleAddress.toUpperCase()", updateIndex);
  const fitCallIndex = source.indexOf("fitPaneLabelToVisibleBounds(view)", textIndex);
  const nativeToggleIndex = source.indexOf("view.rootEl.classList.toggle(\"native-backed\"", updateIndex);
  const allMetricsIndex = source.indexOf("function setAllPaneChromeMetrics");

  assert.ok(metricsIndex > -1);
  assert.ok(fitIndex > metricsIndex);
  assert.ok(allMetricsIndex > fitIndex);
  assert.ok(updateIndex > fitIndex);
  assert.ok(nativeToggleIndex > updateIndex);
  assert.ok(textIndex > nativeToggleIndex);
  assert.ok(fitCallIndex > textIndex);
  assert.match(source.slice(allMetricsIndex, updateIndex), /setPaneChromeMetrics\(view\);[\s\S]*fitPaneLabelToVisibleBounds\(view\);/);
  assert.match(source.slice(fitIndex, updateIndex), /basePaneNumberSize/);
  assert.match(source.slice(fitIndex, updateIndex), /availableWidth/);
  assert.match(source.slice(fitIndex, updateIndex), /availableHeight/);
  assert.match(source.slice(fitIndex, updateIndex), /labelWrap\.getBoundingClientRect\(\)/);
  assert.match(source.slice(fitIndex, updateIndex), /--pane-number-size/);
  assert.doesNotMatch(source.slice(fitIndex, updateIndex), /native-backed/);
  assert.match(styles, /\.pane-label__number\s*\{[\s\S]*letter-spacing:\s*0;/);
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
