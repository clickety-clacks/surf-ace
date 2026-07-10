import assert from "node:assert/strict";
import test from "node:test";

import { parseHTML } from "linkedom";

import {
  contentScalePercentage,
  projectConnectionChrome,
  projectContentScaleIndicator,
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

test("font-size indicator projects current pane scale through repeated changes, rebuild, and reset", () => {
  const { document } = parseHTML(`<button class="font-size-reset"></button>`);
  const indicator = document.querySelector(".font-size-reset")!;

  for (const [scale, expected] of [[1, "100"], [0.9, "90"], [0.8, "80"], [0.9, "90"], [1, "100"]] as const) {
    projectContentScaleIndicator(indicator, scale);
    assert.equal(indicator.textContent, expected);
  }

  const rebuilt = document.createElement("button");
  projectContentScaleIndicator(rebuilt, 0.8);
  assert.equal(rebuilt.textContent, "80");
  assert.equal(contentScalePercentage(1), "100");
});
