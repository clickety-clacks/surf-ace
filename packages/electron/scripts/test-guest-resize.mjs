// Bounded private fixture. Never loads Surf Ace main or its discovery/server runtime.
// Run only in an authorized private Electron slot after building this exact tree.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session } from "electron";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-issue80-fixture-"));
app.setPath("userData", path.join(scratch, "profile"));
const html = `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}
#cell{position:absolute;visibility:hidden;font:16px monospace}</style>
<input id="input" value="retained"><span id="cell">M</span><pre id="grid"></pre>
<script>window.token=Math.random();window.ticks=0;window.refits=0;
function fit(){const cell=document.querySelector('#cell').getBoundingClientRect();
const viewport=document.documentElement.getBoundingClientRect();
window.grid={cols:Math.floor(viewport.width/cell.width),rows:Math.floor(viewport.height/cell.height)};
window.refits++;document.querySelector('#grid').textContent=grid.cols+'x'+grid.rows}
window.addEventListener('resize',fit);fit();setInterval(()=>window.ticks++,20)</script>`;
const makePane = (paneId) => ({
  paneId, label: String(paneId), displayId: `a${paneId}`, visibleAddress: `a${paneId}`,
  activeKeyboardPane: paneId === 1, annotationBorderVisible: false, drawings: [],
  externalNative: false, flushInFlight: false, showDone: false, toast: null,
  canGoBack: false, canGoForward: false, name: null, ownerName: null, provenance: null, provenanceName: null,
  content: { content: { html }, contentId: `private-${paneId}`, contentType: "html",
    reloadable: false, renderVersion: 1, revision: 1 },
});
const state = { connectionBar: "disconnected", geometryRevision: 1, topologyRevision: 1,
  surfaceEpoch: "private-epoch", surfaceId: "private", windowLabel: "a", name: "private", providerName: null,
  panes: [makePane(1), makePane(2), makePane(3)], viewport: { height: 700, width: 1000, scale: 1 },
  layout: { type: "split", direction: "vertical", children: [
    { type: "split", direction: "horizontal", weight: 2, children: [
      { type: "pane", paneId: 1, weight: 3 }, { type: "pane", paneId: 2, weight: 2 },
    ] }, { type: "pane", paneId: 3, weight: 1 },
  ] },
};
const preload = path.join(scratch, "fixture.cjs");
const guest = path.join(scratch, "guest.cjs");
await fs.writeFile(guest, "// No guest network or host bridge.\n");
await fs.writeFile(preload, `window.fixtureState=${JSON.stringify(state)};
window.fixtureCommits=[];window.fixtureSnapshots=[];window.fixtureCommands=[];
window.surfAce={guestPreloadPath:${JSON.stringify(guest)},
getBootstrap:async()=>({state:fixtureState,surfaceId:'private'}),
onState:f=>window.fixtureUpdate=f,onKeyboardIntent:f=>window.fixtureKeyboard=f,
command:c=>fixtureCommands.push(c),reportSnapshot:s=>fixtureSnapshots.push(s),
resizeSplit:async p=>{fixtureCommits.push(p);const next=structuredClone(fixtureState);
if(JSON.stringify(p.expected.layout)!==JSON.stringify(next.layout)||p.expected.topologyRevision!==next.topologyRevision)return false;
let node=next.layout;for(const i of p.path)node=node.children[i];
node.children.forEach((child,i)=>child.weight=p.weights[i]);next.topologyRevision++;next.geometryRevision++;
window.fixtureState=next;fixtureUpdate(next);return true},
reportOverlayRegions(){},reportRendererDiagnostic(){},clearToast(){}};`);

async function run() {
  let win;
  const blockedRequests = [];
  const errors = [];
  const watchdog = setTimeout(() => { console.error("FAIL fixture exceeded 60 seconds"); app.exit(1); }, 60_000);
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = /^(file:|data:|about:)/.test(details.url);
      if (!allowed) blockedRequests.push(details.url);
      callback({ cancel: !allowed });
    });
    win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: {
      preload, webviewTag: true, contextIsolation: false, sandbox: false, backgroundThrottling: false,
    } });
    win.webContents.on("console-message", (_event, details) => { if (details.level === "error") errors.push(details.message); });
    const evaluate = (code) => win.webContents.executeJavaScript(code);
    const printGuestDiagnostics = async (label) => {
      let timer;
      try {
        const diagnostics = await Promise.race([
          evaluate(`Promise.all([...document.querySelectorAll('webview')].map(async(v,i)=>{
            const result={index:i,connected:v.isConnected,ready:v.dataset.guestReady??null,attachmentCount:window.attachCounts?.[i]??null};
            try{result.webContentsId=v.getWebContentsId();result.loading=v.isLoading();
              result.guest=await v.executeJavaScript('({zoom:document.documentElement.style.zoom,grid:window.grid,refits:window.refits,token:window.token})');
            }catch(error){result.error=String(error)}return result}))`),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("diagnostics exceeded 2 seconds")), 2000); }),
        ]);
        console.log(label + "=" + JSON.stringify(diagnostics));
      } catch (error) { console.log(label + "=" + JSON.stringify({ error: String(error) })); }
      finally { clearTimeout(timer); }
    };
    const wait = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await printGuestDiagnostics("GUEST_TIMEOUT_DIAGNOSTICS");
      throw new Error(`Timed out: ${code}`);
    };
    await win.loadFile(fileURLToPath(new URL("../dist/renderer/index.html", import.meta.url)));
    await wait("document.querySelectorAll('webview').length===3&&[...document.querySelectorAll('webview')].every(v=>{try{return v.getWebContentsId()>0&&!v.isLoading()&&v.dataset.guestReady==='true'}catch{return false}})");
    await evaluate(`window.hosts=[...document.querySelectorAll('webview')];window.roots=[...document.querySelectorAll('.pane-shell')];
      window.hostParents=roots.map(r=>r.parentElement);window.attachCounts=hosts.map(()=>0);
      hosts.forEach((v,i)=>v.addEventListener('did-attach',()=>attachCounts[i]++));void 0`);
    await printGuestDiagnostics("GUEST_INITIAL_DIAGNOSTICS");
    const ids = await evaluate("hosts.map(v=>v.getWebContentsId())");
    const tokens = await evaluate("Promise.all(hosts.map(v=>v.executeJavaScript('window.token')))");
    assert.ok(tokens.every((token) => typeof token === "number"));
    await evaluate("hosts[0].executeJavaScript(\"document.querySelector('#input').value='edited';history.pushState({},'', '#retained')\")");
    const retained = async () => {
      assert.deepEqual(await evaluate("hosts.map(v=>v.getWebContentsId())"), ids);
      assert.deepEqual(await evaluate("Promise.all(hosts.map(v=>v.executeJavaScript('window.token')))"), tokens);
      assert.equal(await evaluate("roots.every((r,i)=>r.parentElement===hostParents[i])&&hosts.every(v=>v.isConnected)"), true);
      assert.deepEqual(await evaluate("attachCounts"), [0, 0, 0]);
      assert.equal(await evaluate("hosts[0].executeJavaScript(\"document.querySelector('#input').value+'|'+location.hash\")"), "edited|#retained");
    };
    const before = await evaluate("Promise.all(hosts.map(v=>v.executeJavaScript('({zoom:document.documentElement.style.zoom,grid,refits,ticks})')))");
    await evaluate("fixtureKeyboard({action:'increase',paneId:1,type:'content-scale'})");
    console.log("ZOOM_BEFORE=" + JSON.stringify(before));
    await printGuestDiagnostics("GUEST_AFTER_ZOOM_INTENT");
    await wait("hosts[0].executeJavaScript(\"Math.abs(Number(document.documentElement.style.zoom)-0.935)<1e-6\")");
    const zoomed = await evaluate("Promise.all(hosts.map(v=>v.executeJavaScript('({zoom:document.documentElement.style.zoom,grid,refits,ticks})')))");
    assert.ok(zoomed[0].refits > before[0].refits);
    assert.ok(zoomed[0].grid.cols < before[0].grid.cols);
    assert.equal(zoomed[1].zoom, before[1].zoom);
    await retained();
    const point = await evaluate("(()=>{const r=document.querySelector('.split-resize-handle-horizontal').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
    win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
    for (let i = 1; i <= 20; i++) win.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y + i * 2, button: "left" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await evaluate("fixtureCommits.length"), 0);
    win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y + 40, button: "left", clickCount: 1 });
    await wait("fixtureCommits.length===1");
    await retained();
    await evaluate(`const next=structuredClone(fixtureState);next.panes.push(${JSON.stringify(makePane(4))});
      next.layout.children[1]={type:'split',direction:'horizontal',weight:1,children:[{type:'pane',paneId:3},{type:'pane',paneId:4}]};
      next.topologyRevision++;next.geometryRevision++;window.fixtureState=next;fixtureUpdate(next);void 0`);
    await wait("document.querySelectorAll('webview').length===4");
    await retained();
    await evaluate("const next=structuredClone(fixtureState);next.layout.children.reverse();next.topologyRevision++;window.fixtureState=next;fixtureUpdate(next);void 0");
    await retained();
    assert.deepEqual(blockedRequests, []);
    assert.deepEqual(errors, []);
    console.log("PASS actual retained guest IDs/DOM/session/history; guest zoom/refit and sibling isolation; 20 drag moves produce one release; split/reorder continuity");
    console.log("FIXTURE_IDS=" + JSON.stringify(ids));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    console.log("FIXTURE_EXTERNAL_REQUESTS=" + JSON.stringify(blockedRequests));
    console.log("FIXTURE_CONSOLE_ERRORS=" + JSON.stringify(errors));
    clearTimeout(watchdog);
    win?.destroy();
    app.exit(process.exitCode === 1 ? 1 : 0);
  }
}
void run();
