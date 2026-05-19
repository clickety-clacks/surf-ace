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
  const textRects = new WeakMap<Element, DOMRect[]>();
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    value: (element: HTMLElement) => ({
      display: element.style.display || "block",
      opacity: element.style.opacity || "1",
      visibility: element.style.visibility || "visible",
    }),
  });
  Object.defineProperty(document, "createRange", {
    configurable: true,
    value: () => {
      let selected: Element | null = null;
      return {
        detach: () => {},
        getClientRects: () => selected ? textRects.get(selected) ?? [] : [],
        selectNodeContents: (element: Element) => {
          selected = element;
        },
      };
    },
  });
  Object.assign(globalThis, { document, window });
  return {
    document,
    setTextRect: (element: Element, rect: { height: number; width: number; x: number; y: number }) => {
      textRects.set(element, [{
        bottom: rect.y + rect.height,
        height: rect.height,
        left: rect.x,
        right: rect.x + rect.width,
        top: rect.y,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      } as DOMRect]);
    },
  };
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

test("pane label overlay region uses tight combined label affordance bounds", () => {
  const { document, setTextRect } = installDOM();
  const wrapper = document.createElement("div");
  wrapper.className = "pane-label";
  const windowId = document.createElement("span");
  windowId.className = "pane-label__window";
  windowId.textContent = "FK";
  const paneNumber = document.createElement("span");
  paneNumber.className = "pane-label__number";
  paneNumber.textContent = "4";
  wrapper.append(windowId, paneNumber);
  document.body.appendChild(wrapper);

  setRect(wrapper, { height: 114, width: 124, x: 1032, y: 3688 });
  setRect(windowId, { height: 630, width: 2090, x: 0, y: 3209 });
  setRect(paneNumber, { height: 630, width: 2090, x: 0, y: 3209 });
  setTextRect(windowId, { height: 18, width: 34, x: 1040, y: 3720 });
  setTextRect(paneNumber, { height: 90, width: 60, x: 1088, y: 3690 });

  assert.deepEqual(visibleOverlayRect(wrapper, "pane-label"), {
    height: 94,
    width: 124,
    x: 1032,
    y: 3688,
  });
});

test("pane label overlay region ignores hidden identity children", () => {
  const { document, setTextRect } = installDOM();
  const wrapper = document.createElement("div");
  wrapper.className = "pane-label";
  const windowId = document.createElement("span");
  windowId.className = "pane-label__window";
  windowId.hidden = true;
  windowId.textContent = "FK";
  const paneNumber = document.createElement("span");
  paneNumber.className = "pane-label__number";
  paneNumber.textContent = "4";
  wrapper.append(windowId, paneNumber);
  document.body.appendChild(wrapper);

  setRect(wrapper, { height: 114, width: 124, x: 1032, y: 3688 });
  setRect(windowId, { height: 630, width: 2090, x: 0, y: 3209 });
  setRect(paneNumber, { height: 630, width: 2090, x: 0, y: 3209 });
  setTextRect(windowId, { height: 18, width: 34, x: 1040, y: 3720 });
  setTextRect(paneNumber, { height: 90, width: 60, x: 1088, y: 3690 });

  assert.deepEqual(visibleOverlayRect(wrapper, "pane-label"), {
    height: 94,
    width: 76,
    x: 1080,
    y: 3688,
  });
});

test("pane label overlay region is omitted when identity text is hidden", () => {
  const { document, setTextRect } = installDOM();
  const wrapper = document.createElement("div");
  wrapper.className = "pane-label";
  const windowId = document.createElement("span");
  windowId.className = "pane-label__window";
  windowId.hidden = true;
  windowId.textContent = "FK";
  const paneNumber = document.createElement("span");
  paneNumber.className = "pane-label__number";
  paneNumber.hidden = true;
  paneNumber.textContent = "4";
  wrapper.append(windowId, paneNumber);
  document.body.appendChild(wrapper);

  setRect(wrapper, { height: 114, width: 124, x: 1032, y: 3688 });
  setRect(windowId, { height: 630, width: 2090, x: 0, y: 3209 });
  setRect(paneNumber, { height: 630, width: 2090, x: 0, y: 3209 });
  setTextRect(windowId, { height: 18, width: 34, x: 1040, y: 3720 });
  setTextRect(paneNumber, { height: 90, width: 60, x: 1088, y: 3690 });

  assert.equal(visibleOverlayRect(wrapper, "pane-label"), null);
});

test("keyboard focus outline stays visible over light and dark pane content", async () => {
  const css = await rendererStyles();
  const activeRule = declarationBlock(css, ".pane-shell.keyboard-active .keyboard-focus-overlay");
  const edgeRule = declarationBlock(css, ".keyboard-focus-edge");

  assert.match(activeRule, /opacity:\s*1\s*;/);
  assert.match(edgeRule, /background:\s*rgb\(128,\s*128,\s*128\)\s*;/);
});
