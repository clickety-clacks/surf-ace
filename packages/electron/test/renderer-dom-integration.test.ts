import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { parseHTML } from "linkedom";

type ConnectionBar = "connected" | "connecting" | "disconnected";

function pane(paneId: number, annotationBorderVisible = false) {
  return {
    activeKeyboardPane: paneId === 1,
    annotationBorderVisible,
    canGoBack: false,
    canGoForward: false,
    content: {
      content: { markdown: `pane ${paneId}` },
      contentId: `content-${paneId}`,
      contentType: "markdown",
      reloadable: false,
      renderVersion: 1,
      revision: 1,
    },
    displayId: String(paneId),
    drawings: [],
    externalNative: false,
    flushInFlight: false,
    label: String(paneId),
    name: null,
    ownerName: null,
    paneId,
    provenanceName: null,
    showDone: annotationBorderVisible,
    toast: null,
    visibleAddress: String(paneId),
  };
}

function state(connectionBar: ConnectionBar, twoPanes = false, annotatingPane = 0) {
  return {
    connectionBar,
    geometryRevision: 1,
    layout: twoPanes
      ? { children: [{ paneId: 1, type: "pane" }, { paneId: 2, type: "pane" }], direction: "vertical", type: "split" }
      : { paneId: 1, type: "pane" },
    name: "test",
    panes: twoPanes ? [pane(1, annotatingPane === 1), pane(2, annotatingPane === 2)] : [pane(1, annotatingPane === 1)],
    providerName: connectionBar === "connected" ? "test-provider" : null,
    surfaceEpoch: "epoch-1",
    surfaceId: "surface-1",
    topologyRevision: twoPanes ? 2 : 1,
    viewport: { height: 800, scale: 1, width: 1200 },
    windowLabel: "a",
  };
}

test("renderer DOM integrates authoritative connection states and live scale controls", async () => {
  const { document, window } = parseHTML("<!doctype html><html><body><div id=\"app\"></div></body></html>");
  let stateListener: ((next: unknown) => void) | null = null;
  let keyboardListener: ((intent: unknown) => void) | null = null;
  const surfAce = {
    clearToast() {},
    command() {},
    getBootstrap: async () => ({ state: state("disconnected"), surfaceId: "surface-1" }),
    onKeyboardIntent(listener: (intent: unknown) => void) { keyboardListener = listener; },
    onState(listener: (next: unknown) => void) { stateListener = listener; },
    reportDiagnostics() {},
    reportOverlayRegions() {},
    reportRendererDiagnostic() {},
    reportSnapshot() {},
  };

  Object.assign(window, {
    cancelAnimationFrame() {},
    location: { search: "" },
    getComputedStyle: () => ({ display: "block", opacity: "1", visibility: "visible" }),
    getSelection: () => null,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    surfAce,
  });
  Object.assign(globalThis, {
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLCanvasElement: window.HTMLCanvasElement,
    ResizeObserver: class { disconnect() {} observe() {} },
    window,
  });
  Object.assign(document, {
    createRange: () => ({ detach() {}, getClientRects: () => [], selectNodeContents() {} }),
  });
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ bottom: 100, height: 100, left: 0, right: 200, top: 0, width: 200, x: 0, y: 0 }),
  });
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ clearRect() {}, lineTo() {}, moveTo() {}, stroke() {} }),
  });

  const rendererUrl = pathToFileURL(new URL("../renderer/renderer.js", import.meta.url).pathname).href;
  await import(`${rendererUrl}?integration=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const chrome = () => ({
    glyph: document.querySelector(".pane-label__disconnected")!,
    pane: document.querySelector(".pane-label__number")!,
    window: document.querySelector(".pane-label__window")!,
  });
  assert.equal(chrome().glyph.hasAttribute("hidden"), false);
  assert.equal(chrome().pane.hasAttribute("hidden"), true);

  stateListener!(state("connecting"));
  assert.equal(chrome().glyph.classList.contains("is-connecting"), true);
  assert.equal(chrome().pane.hasAttribute("hidden"), true);
  stateListener!(state("connected"));
  assert.equal(chrome().glyph.hasAttribute("hidden"), true);
  assert.equal(chrome().pane.hasAttribute("hidden"), false);
  assert.equal(chrome().window.hasAttribute("hidden"), false);
  stateListener!(state("disconnected"));
  assert.equal(chrome().glyph.hasAttribute("hidden"), false);
  assert.equal(chrome().pane.hasAttribute("hidden"), true);

  (document.querySelector(".font-size-toggle") as HTMLElement).click();
  (document.querySelector(".font-size-step") as HTMLElement).click();
  (document.querySelector(".font-size-step") as HTMLElement).click();
  assert.equal(document.querySelector(".font-size-reset")?.textContent, "80");
  assert.ok(document.querySelector(".font-size-popover"));

  keyboardListener!({ action: "increase", paneId: 1, type: "content-scale" });
  assert.equal(document.querySelector(".font-size-reset")?.textContent, "90");
  assert.ok(document.querySelector(".font-size-popover"));
  (document.querySelector(".font-size-toggle") as HTMLElement).click();
  assert.equal(document.querySelector(".font-size-popover"), null);
  (document.querySelector(".font-size-toggle") as HTMLElement).click();
  assert.equal(document.querySelector(".font-size-reset")?.textContent, "90");
  (document.querySelector(".font-size-reset") as HTMLElement).click();
  assert.equal(document.querySelector(".font-size-reset")?.textContent, "100");

  stateListener!(state("connected", true));
  const paneShells = document.querySelectorAll(".pane-shell");
  (paneShells[1]!.querySelector(".font-size-toggle") as HTMLElement).click();
  assert.equal(paneShells[0]!.querySelector(".font-size-popover"), null);
  assert.ok(paneShells[1]!.querySelector(".font-size-popover"));
  stateListener!(state("connected", true, 2));
  assert.equal(document.querySelector(".font-size-popover"), null);

  stateListener!(state("connected", true));
  (document.querySelectorAll(".pane-shell")[0]!.querySelector(".font-size-toggle") as HTMLElement).click();
  document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.equal(document.querySelector(".font-size-popover"), null);
  (document.querySelectorAll(".pane-shell")[0]!.querySelector(".font-size-toggle") as HTMLElement).click();
  document.querySelectorAll(".pane-shell")[0]!.querySelector(".pane-scroll")!
    .dispatchEvent(new window.Event("scroll"));
  assert.equal(document.querySelector(".font-size-popover"), null);
});
