import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { parseHTML } from "linkedom";

import { visibleOverlayRect } from "../src/renderer/overlay-rects.js";

async function rendererStyles(): Promise<string> {
  return fs.readFile(new URL("../renderer/styles.css", import.meta.url), "utf8");
}

async function rendererSource(): Promise<string> {
  return fs.readFile(new URL("../renderer/renderer.js", import.meta.url), "utf8");
}

function declarationBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g"))];
  assert.ok(matches.length > 0, `missing ${selector} rule`);
  return matches[matches.length - 1]![1]!;
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
  const topRule = declarationBlock(css, ".keyboard-focus-edge--top");
  const bottomRule = declarationBlock(css, ".keyboard-focus-edge--bottom");
  const leftRule = declarationBlock(css, ".keyboard-focus-edge--left");
  const rightRule = declarationBlock(css, ".keyboard-focus-edge--right");
  const horizontalRule = declarationBlock(css, ".keyboard-focus-edge--top,\n.keyboard-focus-edge--bottom");
  const verticalRule = declarationBlock(css, ".keyboard-focus-edge--left,\n.keyboard-focus-edge--right");

  assert.match(activeRule, /opacity:\s*1\s*;/);
  assert.match(edgeRule, /--keyboard-focus-edge-color:\s*rgba\(128,\s*128,\s*128,\s*0\.25\)\s*;/);
  assert.match(edgeRule, /--keyboard-focus-clear-color:\s*rgba\(128,\s*128,\s*128,\s*0\)\s*;/);
  assert.match(horizontalRule, /height:\s*20px\s*;/);
  assert.match(verticalRule, /width:\s*20px\s*;/);
  assert.match(topRule, /linear-gradient\(to bottom,\s*var\(--keyboard-focus-edge-color\),\s*var\(--keyboard-focus-clear-color\)\)/);
  assert.match(bottomRule, /linear-gradient\(to top,\s*var\(--keyboard-focus-edge-color\),\s*var\(--keyboard-focus-clear-color\)\)/);
  assert.match(leftRule, /linear-gradient\(to right,\s*var\(--keyboard-focus-edge-color\),\s*var\(--keyboard-focus-clear-color\)\)/);
  assert.match(rightRule, /linear-gradient\(to left,\s*var\(--keyboard-focus-edge-color\),\s*var\(--keyboard-focus-clear-color\)\)/);
});

test("keyboard focus band is not reported as a compositor input overlay", async () => {
  const source = await rendererSource();
  const focusEdgeClassIndex = source.indexOf("keyboard-focus-edge keyboard-focus-edge--");

  assert.notEqual(focusEdgeClassIndex, -1);
  assert.doesNotMatch(source.slice(focusEdgeClassIndex, focusEdgeClassIndex + 240), /surfAceOverlay/);
  assert.doesNotMatch(source, /case "keyboard-focus-edge"/);
});
