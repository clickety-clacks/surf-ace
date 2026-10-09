// Run with a private Electron binary after building; never loads Surf Ace main.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session } from "electron";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-popout-fixture-"));
app.setPath("userData", path.join(scratch, "profile"));
const html = '<input id="input" value="retained"><script>window.token=Math.random();window.ticks=0;window.clicks=0;document.addEventListener("click",()=>window.clicks++);setInterval(()=>window.ticks++,20)</script>';
const panes = [1, 2, 3].map((paneId) => ({
  paneId, label: String(paneId), displayId: `a${paneId}`, visibleAddress: `a${paneId}`,
  activeKeyboardPane: paneId === 1, annotationBorderVisible: false, drawings: [],
  externalNative: false, flushInFlight: false, showDone: false, toast: null,
  canGoBack: false, canGoForward: false, name: null, ownerName: null,
  provenance: null, provenanceName: null,
  content: { content: { html }, contentId: `fixture-${paneId}`, contentType: "html",
    reloadable: false, renderVersion: 1, revision: 1 },
}));
const state = {
  connectionBar: "disconnected", geometryRevision: 1, topologyRevision: 1,
  surfaceEpoch: "fixture-epoch", surfaceId: "fixture", windowLabel: "a",
  name: "isolated fixture", providerName: null, panes,
  viewport: { height: 700, width: 1000, scale: 1 },
  layout: { type: "split", direction: "vertical", children: [
    { type: "pane", paneId: 1, weight: 2 },
    { type: "split", direction: "horizontal", weight: 5, children: [
      { type: "pane", paneId: 2, weight: 3 }, { type: "pane", paneId: 3, weight: 7 },
    ] },
  ] },
};
const preload = path.join(scratch, "fixture.cjs");
const guest = path.join(scratch, "guest.cjs");
await fs.writeFile(guest, "// No network or host bridge in fixture guest.\n");
await fs.writeFile(preload, `window.fixtureState=${JSON.stringify(state)};
window.fixtureCommands=[];window.fixtureSnapshots=[];
window.surfAce={guestPreloadPath:${JSON.stringify(guest)},
getBootstrap:async()=>({state:window.fixtureState,surfaceId:'fixture'}),
onState:f=>window.fixtureUpdate=f,onPanePresentationOwnership: () => () => {},
      onKeyboardIntent:f=>window.fixtureKeyboard=f,
command:c=>window.fixtureCommands.push(c),reportSnapshot:s=>window.fixtureSnapshots.push(s),
setPanePresentation:async()=>({ok:true}),
reportDiagnostics(){},reportOverlayRegions(){},reportRendererDiagnostic(){},clearToast(){}};`);
// Electron waits for its ESM entry to finish loading before emitting ready.
async function run() {
let win;
const blockedRequests = [];
const watchdog = setTimeout(() => {
  console.error("FAIL private fixture exceeded its 60-second bound");
  app.exit(1);
}, 60_000);
try {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(file:|data:|about:)/.test(details.url);
    if (!allowed) blockedRequests.push(details.url);
    callback({ cancel: !allowed });
  });
  win = new BrowserWindow({ width: 1000, height: 700, show: false,
    webPreferences: { preload, webviewTag: true, contextIsolation: false, sandbox: false,
      backgroundThrottling: false } });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const wait = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(code)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${code}`);
  };
  await win.loadFile(fileURLToPath(new URL("../dist/renderer/index.html", import.meta.url)));
  await wait("document.querySelectorAll('webview').length===3 && [...document.querySelectorAll('webview')].every(v=>{try{return v.getWebContentsId()>0&&v.getURL().startsWith('data:text/html')&&!v.isLoading()}catch{return false}})");
  await evaluate(`window.hosts=[...document.querySelectorAll('webview')];
    window.roots=[...document.querySelectorAll('.pane-shell')];
    window.slots=roots.map(r=>r.parentElement);
    window.rects=()=>roots.map(r=>{const b=r.getBoundingClientRect();return [b.x,b.y,b.width,b.height]});void 0;`);
  const initial = await evaluate("rects()");
  const identities = await evaluate("Promise.all(hosts.map(v=>v.executeJavaScript('window.token'))) ");
  assert.ok(identities.every(token => typeof token === "number"));
  await evaluate("hosts[1].executeJavaScript(\"document.querySelector('input').value='edited';history.pushState({},'', '#retained')\")");
  for (let i = 0; i < 3; i++) {
    const beforeTick = await evaluate("hosts[0].executeJavaScript('window.ticks')");
    await evaluate("roots[1].querySelector('.pane-pop-out').click()");
    await wait("roots[1].getBoundingClientRect().width>900");
    assert.equal(await evaluate("document.activeElement===roots[1].querySelector('.pane-pop-out')"), true);
    assert.equal(await evaluate("roots[0].inert&&roots[2].inert&&roots[0].getAttribute('aria-hidden')==='true'"), true);
    assert.equal(await evaluate("roots.every((r,i)=>r.parentElement===slots[i])&&hosts.every(v=>v.isConnected)"), true);
    const expanded = await evaluate("rects()");
    assert.ok(expanded[1][2] > initial[1][2]);
    assert.ok(expanded[1][3] > initial[1][3]);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(await evaluate("hosts[0].executeJavaScript('window.ticks')") > beforeTick);
    assert.deepEqual(await evaluate("Promise.all(hosts.map(v=>v.executeJavaScript('window.token')))"), identities);
    assert.equal(await evaluate("hosts[1].executeJavaScript(\"document.querySelector('input').value+'|'+location.hash\")"), "edited|#retained");
    assert.equal(await evaluate("document.elementFromPoint(500,10)?.closest('.pane-shell')===roots[0]"), false);
    const siblingClicks = await evaluate("hosts[0].executeJavaScript('window.clicks')");
    // This is outside the overlay, on the retained first pane's original slot.
    win.webContents.sendInputEvent({ type: "mouseDown", x: 2, y: 2, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: 2, y: 2, button: "left", clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await evaluate("hosts[0].executeJavaScript('window.clicks')"), siblingClicks);
    await evaluate("roots[1].querySelector('.pane-pop-out').click()");
    assert.deepEqual(await evaluate("rects()"), initial);
    assert.equal(await evaluate("roots.some(r=>r.inert)"), false);
  }
  await evaluate("roots[1].querySelector('.pane-pop-out').click()");
  win.setSize(1100, 800);
  await wait("roots[1].getBoundingClientRect().width>1000");
  await evaluate("roots[1].querySelector('.pane-pop-out').click()");
  assert.equal(await evaluate("slots.map(s=>s.style.flexGrow).join(',')"), "2,3,7");
  await evaluate("roots[1].querySelector('.pane-pop-out').click();const next=structuredClone(fixtureState);next.topologyRevision++;fixtureUpdate(next)");
  assert.equal(await evaluate("document.querySelectorAll('.pane-popped-out').length"), 0);
  assert.equal(await evaluate("fixtureCommands.some(c=>['resize-split','split-pane','close-pane','reload'].includes(c.type))"), false);
  assert.deepEqual(blockedRequests, [], "fixture must not attempt external requests");
  console.log("PASS retained guest identity/input/history; covered guest keeps ticking; weighted nested layout restores; resize/topology/input/focus; zero external requests");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  console.log("FIXTURE_EXTERNAL_REQUESTS=" + JSON.stringify(blockedRequests));
  clearTimeout(watchdog);
  win?.destroy();
  app.exit(process.exitCode === 1 ? 1 : 0);
}
}
void run();
