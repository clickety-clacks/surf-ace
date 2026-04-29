import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { parseHTML } from "linkedom";

import { visibleOverlayRect } from "../src/renderer/overlay-rects.js";

async function rendererStyles(): Promise<string> {
  return fs.readFile(new URL("../renderer/styles.css", import.meta.url), "utf8");
}

function declarationBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing ${selector} rule`);
  return match[1]!;
}

function installDOM() {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    value: (element: HTMLElement) => ({
      display: element.style.display || "block",
      opacity: element.style.opacity || "1",
      visibility: element.style.visibility || "visible",
    }),
  });
  Object.assign(globalThis, { document, window });
  return { document };
}

function setRect(element: Element, rect: { height: number; width: number; x: number; y: number }): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: rect.y + rect.height,
      height: rect.height,
      left: rect.x,
      right: rect.x + rect.width,
      top: rect.y,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    }),
  });
}

test("pane label overlay region uses tight visible identity glyph bounds", () => {
  const { document } = installDOM();
  const wrapper = document.createElement("div");
  wrapper.className = "pane-label";
  const windowId = document.createElement("span");
  windowId.className = "pane-label__window";
  const paneNumber = document.createElement("span");
  paneNumber.className = "pane-label__number";
  wrapper.append(windowId, paneNumber);
  document.body.appendChild(wrapper);

  setRect(wrapper, { height: 612, width: 1530, x: 0, y: 0 });
  setRect(windowId, { height: 96, width: 90, x: 1130, y: 500 });
  setRect(paneNumber, { height: 180, width: 154, x: 1228, y: 416 });

  assert.deepEqual(visibleOverlayRect(wrapper, "pane-label"), {
    height: 180,
    width: 252,
    x: 1130,
    y: 416,
  });
});

test("pane label overlay region ignores hidden identity children", () => {
  const { document } = installDOM();
  const wrapper = document.createElement("div");
  wrapper.className = "pane-label";
  const windowId = document.createElement("span");
  windowId.className = "pane-label__window";
  windowId.hidden = true;
  const paneNumber = document.createElement("span");
  paneNumber.className = "pane-label__number";
  wrapper.append(windowId, paneNumber);
  document.body.appendChild(wrapper);

  setRect(wrapper, { height: 612, width: 1530, x: 0, y: 0 });
  setRect(windowId, { height: 96, width: 90, x: 1130, y: 500 });
  setRect(paneNumber, { height: 180, width: 154, x: 1228, y: 416 });

  assert.deepEqual(visibleOverlayRect(wrapper, "pane-label"), {
    height: 180,
    width: 154,
    x: 1228,
    y: 416,
  });
});

test("keyboard focus outline stays visible over light and dark pane content", async () => {
  const css = await rendererStyles();
  const activeRule = declarationBlock(css, ".pane-shell.keyboard-active .keyboard-focus-overlay");
  const edgeRule = declarationBlock(css, ".keyboard-focus-edge");

  assert.match(activeRule, /opacity:\s*1\s*;/);
  assert.match(edgeRule, /background:\s*rgb\(128,\s*128,\s*128\)\s*;/);
});
