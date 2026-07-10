import assert from "node:assert/strict";
import test from "node:test";

import { parseHTML } from "linkedom";

import {
  bindContentScaleControls,
  contentScalePercentage,
  projectConnectionChrome,
  projectContentScaleIndicator,
  toggleContentScalePopup,
} from "../src/renderer/ui-projection.js";

function connectionChromeFixture() {
  const { document } = parseHTML(`
    <div class="pane-label">
      <span class="pane-label__window">W1</span>
      <svg class="pane-label__disconnected"></svg>
      <span class="pane-label__number">P1</span>
    </div>
  `);
  const labelWrap = document.querySelector(".pane-label")!;
  const windowLabel = document.querySelector(".pane-label__window")!;
  const disconnectedGlyph = document.querySelector(".pane-label__disconnected")!;
  const paneLabel = document.querySelector(".pane-label__number")!;
  return { disconnectedGlyph, labelWrap, paneLabel, windowLabel };
}

test("connection chrome transitions render mutually exclusive identity and disconnected SVG states", () => {
  const chrome = connectionChromeFixture();

  projectConnectionChrome(chrome, "connected", true, true);
  assert.equal(chrome.windowLabel.hasAttribute("hidden"), false);
  assert.equal(chrome.paneLabel.hasAttribute("hidden"), false);
  assert.equal(chrome.disconnectedGlyph.hasAttribute("hidden"), true);
  assert.equal(chrome.labelWrap.hasAttribute("hidden"), false);

  projectConnectionChrome(chrome, "connecting", true, true);
  assert.equal(chrome.windowLabel.hasAttribute("hidden"), true);
  assert.equal(chrome.paneLabel.hasAttribute("hidden"), true);
  assert.equal(chrome.disconnectedGlyph.hasAttribute("hidden"), false);
  assert.equal(chrome.disconnectedGlyph.classList.contains("is-connecting"), true);
  assert.equal(chrome.disconnectedGlyph.classList.contains("is-disconnected"), false);

  projectConnectionChrome(chrome, "disconnected", true, true);
  assert.equal(chrome.windowLabel.hasAttribute("hidden"), true);
  assert.equal(chrome.paneLabel.hasAttribute("hidden"), true);
  assert.equal(chrome.disconnectedGlyph.hasAttribute("hidden"), false);
  assert.equal(chrome.disconnectedGlyph.classList.contains("is-connecting"), false);
  assert.equal(chrome.disconnectedGlyph.classList.contains("is-disconnected"), true);

  projectConnectionChrome(chrome, "connected", true, true);
  assert.equal(chrome.windowLabel.hasAttribute("hidden"), false);
  assert.equal(chrome.paneLabel.hasAttribute("hidden"), false);
  assert.equal(chrome.disconnectedGlyph.hasAttribute("hidden"), true);
});

test("same-client panes can render connected and disconnected chrome without mixing either target", () => {
  const connected = connectionChromeFixture();
  const disconnected = connectionChromeFixture();

  projectConnectionChrome(connected, "connected", true, true);
  projectConnectionChrome(disconnected, "disconnected", true, true);

  assert.deepEqual(
    {
      glyphHidden: connected.disconnectedGlyph.hasAttribute("hidden"),
      paneHidden: connected.paneLabel.hasAttribute("hidden"),
      windowHidden: connected.windowLabel.hasAttribute("hidden"),
    },
    { glyphHidden: true, paneHidden: false, windowHidden: false },
  );
  assert.deepEqual(
    {
      glyphHidden: disconnected.disconnectedGlyph.hasAttribute("hidden"),
      paneHidden: disconnected.paneLabel.hasAttribute("hidden"),
      windowHidden: disconnected.windowLabel.hasAttribute("hidden"),
    },
    { glyphHidden: false, paneHidden: true, windowHidden: true },
  );
});

test("every non-push-capable renderer state projects glyph-only chrome through the shared DOM path", () => {
  const cases = [
    ["connecting", "connecting"],
    ["gave-up", "disconnected"],
    ["restored", "disconnected"],
    ["unadmitted", "disconnected"],
    ["authority-not-actionable", "connecting"],
    ["socket-not-open", "disconnected"],
  ] as const;

  for (const [source, connectionBar] of cases) {
    const chrome = connectionChromeFixture();
    projectConnectionChrome(chrome, connectionBar, true, true);
    assert.equal(chrome.windowLabel.hasAttribute("hidden"), true, `${source}: window identity`);
    assert.equal(chrome.paneLabel.hasAttribute("hidden"), true, `${source}: pane identity`);
    assert.equal(chrome.disconnectedGlyph.hasAttribute("hidden"), false, `${source}: glyph`);
  }
});

test("font-size indicator projects current pane scale through repeated changes, rebuild, and reset", () => {
  const { document } = parseHTML(`<button class="font-size-reset"><span class="control-button__label"></span></button>`);
  const indicator = document.querySelector(".font-size-reset")!;

  for (const [scale, expected] of [[1, "100"], [0.9, "90"], [0.8, "80"], [0.9, "90"], [1, "100"]] as const) {
    projectContentScaleIndicator(indicator, scale);
    assert.equal(indicator.textContent, expected);
    assert.equal(indicator.querySelector(".control-button__label")?.textContent, expected);
  }

  const rebuilt = document.createElement("button");
  projectContentScaleIndicator(rebuilt, 0.8);
  assert.equal(rebuilt.textContent, "80");
  assert.equal(contentScalePercentage(1), "100");
});

test("real font-size controls keep one pane popup open, synchronized, isolated, and dismissible", () => {
  const { document } = parseHTML(`<main><section id="pane-1"></section><section id="pane-2"></section></main>`);
  const scales = new Map([[1, 1], [2, 0.8]]);
  let openPaneId: number | null = null;

  function scalePane(paneId: number, action: "decrease" | "increase" | "reset"): void {
    const current = scales.get(paneId)!;
    const next = action === "reset"
      ? 1
      : Math.round((current + (action === "increase" ? 0.1 : -0.1)) * 10) / 10;
    scales.set(paneId, next);
    renderPane(paneId);
  }

  function renderPane(paneId: number): void {
    const root = document.querySelector(`#pane-${paneId}`)!;
    root.replaceChildren();
    const annotationPill = document.createElement("div");
    const toggle = document.createElement("button");
    toggle.className = "font-size-toggle";
    const popupOpen = openPaneId === paneId;
    const popover = popupOpen ? document.createElement("div") : null;
    if (popover) popover.className = "font-size-popover";
    const decrease = popupOpen ? document.createElement("button") : null;
    if (decrease) decrease.className = "decrease";
    const reset = popupOpen ? document.createElement("button") : null;
    if (reset) reset.className = "font-size-reset";
    const increase = popupOpen ? document.createElement("button") : null;
    if (increase) increase.className = "increase";
    bindContentScaleControls({
      annotationPill,
      decrease,
      fontSizePopover: popover,
      fontSizeToggle: toggle,
      increase,
      onScale: (action) => scalePane(paneId, action),
      onToggle: () => {
        const popup = toggleContentScalePopup(openPaneId, paneId);
        openPaneId = popup.openPaneId;
        for (const affectedPaneId of popup.rebuildPaneIds) renderPane(affectedPaneId);
      },
      reset,
      scale: scales.get(paneId)!,
    });
    root.appendChild(annotationPill);
  }

  function closePopup(): void {
    const paneId = openPaneId;
    openPaneId = null;
    if (paneId !== null) renderPane(paneId);
  }

  renderPane(1);
  renderPane(2);
  (document.querySelector("#pane-1 .font-size-toggle") as HTMLElement).click();
  assert.equal(document.querySelector("#pane-1 .font-size-reset")?.textContent, "100");

  (document.querySelector("#pane-1 .decrease") as HTMLElement).click();
  assert.equal(document.querySelector("#pane-1 .font-size-reset")?.textContent, "90");
  (document.querySelector("#pane-1 .decrease") as HTMLElement).click();
  assert.equal(document.querySelector("#pane-1 .font-size-reset")?.textContent, "80");
  assert.ok(document.querySelector("#pane-1 .font-size-popover"));

  (document.querySelector("#pane-2 .font-size-toggle") as HTMLElement).click();
  assert.equal(document.querySelector("#pane-1 .font-size-popover"), null);
  assert.equal(document.querySelector("#pane-2 .font-size-reset")?.textContent, "80");

  (document.querySelector("#pane-2 .increase") as HTMLElement).click();
  assert.equal(document.querySelector("#pane-2 .font-size-reset")?.textContent, "90");
  (document.querySelector("#pane-2 .font-size-reset") as HTMLElement).click();
  assert.equal(document.querySelector("#pane-2 .font-size-reset")?.textContent, "100");
  assert.ok(document.querySelector("#pane-2 .font-size-popover"));

  closePopup();
  assert.equal(document.querySelector(".font-size-popover"), null);
  (document.querySelector("#pane-1 .font-size-toggle") as HTMLElement).click();
  assert.equal(document.querySelector("#pane-1 .font-size-reset")?.textContent, "80");

  scalePane(1, "increase");
  assert.equal(document.querySelector("#pane-1 .font-size-reset")?.textContent, "90");
  closePopup();
  assert.equal(document.querySelector(".font-size-popover"), null);
});
