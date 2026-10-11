import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(
  process.env.SURF_ACE_SCALE_SOURCE || new URL("../src/renderer/browser-content-scale.ts", import.meta.url),
  "utf8",
);
const mod = { exports: {} };
vm.runInNewContext(ts.transpile(source, { module: ts.ModuleKind.CommonJS }), { module: mod, exports: mod.exports });
const script = mod.exports.browserContentScaleScript;

function setup() {
  const frames = [];
  const events = [];
  const fits = [];
  const renders = [];
  const timers = new Map();
  const observers = [];
  let timerId = 0;
  class Element {
    isConnected = true;
    matches() { return true; }
    querySelector() { return {}; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  const document = {
    documentElement: { style: { zoom: "0.85" } },
    body: { style: { setProperty() {} } },
    querySelectorAll: () => [element],
  };
  const element = new Element();
  element.ownerDocument = document;
  const term = {
    element,
    options: { fontSize: 16 },
    fit() { fits.push(this.options.fontSize); },
    onRender(callback) {
      renders.push(callback);
      return { dispose() { const index = renders.indexOf(callback); if (index >= 0) renders.splice(index, 1); } };
    },
  };
  const window = { term, dispatchEvent: (event) => events.push(event) };
  const context = vm.createContext({
    window,
    document,
    HTMLElement: Element,
    MutationObserver,
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    Event: class { constructor(type) { this.type = type; } },
  });
  return {
    window, document, term, frames, events, fits, renders, timers,
    run: (scale, nonce, revision) => vm.runInContext(script(scale, nonce, revision), context),
    render: () => [...renders].forEach((callback) => callback()),
    mutate: () => [...observers].forEach((observer) => observer.callback([])),
    tick: () => {
      const entry = timers.entries().next().value;
      if (entry) { timers.delete(entry[0]); entry[1](); }
    },
  };
}

test("compatible public terminal scales through fontSize and fit at unit root zoom", () => {
  const s = setup();
  const old = s.term;
  const result = s.run(0.935, "nonce-a", 3);
  assert.equal(result.mode, "public-terminal-font");
  assert.equal(result.sequence, 1);
  assert.equal(s.term.options.fontSize, 14.96);
  assert.equal(s.document.documentElement.style.zoom, "");
  assert.equal(s.window.term, old);
  assert.deepEqual(s.fits, [14.96]);
  s.frames.shift()();
  assert.deepEqual(s.fits, [14.96, 14.96]);
  assert.deepEqual(JSON.parse(JSON.stringify(s.events[0].detail)), {
    mode: "public-terminal-font", nonce: "nonce-a", revision: 3, sequence: 1,
  });
  assert.ok(s.events.some((event) => event.type === "resize"));
});

test("ordinary pages select host scaling without changing authored root zoom", () => {
  const s = setup();
  delete s.window.term;
  const result = s.run(0.935, "nonce-generic", 7);
  assert.equal(result.mode, "host-transform");
  assert.equal(result.scale, 0.935);
  assert.equal(result.sequence, 1);
  assert.equal(s.document.documentElement.style.zoom, "0.85");
  assert.equal(s.fits.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(s.events[0].detail)), {
    mode: "host-transform", nonce: "nonce-generic", revision: 7, sequence: 1,
  });
});

test("repeated scale and reset derive from original font and skip obsolete deferred fits", () => {
  const s = setup();
  s.run(0.85);
  s.run(0.935);
  s.run(0.85);
  assert.equal(s.term.options.fontSize, 13.6);
  const before = s.fits.length;
  s.frames[0]();
  s.frames[1]();
  assert.equal(s.fits.length, before);
  s.frames[2]();
  assert.equal(s.fits.length, before + 1);
});

test("separate guests retain independent terminal preferences and scales", () => {
  const a = setup();
  const b = setup();
  a.run(0.85);
  b.run(0.935);
  a.run(1.1);
  assert.equal(a.term.options.fontSize, 17.6);
  assert.equal(b.term.options.fontSize, 14.96);
});

test("unsupported, stale, ambiguous, or incomplete terminals select host scaling", () => {
  for (const change of [
    (s) => delete s.window.term,
    (s) => { s.term.element.isConnected = false; },
    (s) => { s.term.element.ownerDocument = {}; },
    (s) => { s.term.fit = null; },
    (s) => { s.term.onRender = null; },
    (s) => { s.document.querySelectorAll = () => [s.term.element, s.term.element]; },
    (s) => { s.term.options.fontSize = NaN; },
  ]) {
    const s = setup();
    change(s);
    assert.equal(s.run(0.935).mode, "host-transform");
    assert.equal(s.document.documentElement.style.zoom, "0.85");
    assert.equal(s.fits.length, 0);
  }
});

test("late terminal readiness reports a revision-bound transition from host to font scaling", () => {
  const s = setup();
  delete s.window.term;
  s.run(0.85, "old", 1);
  s.run(0.935, "current", 2);
  assert.equal(s.timers.size, 1);
  s.window.term = s.term;
  s.tick();
  assert.equal(s.term.options.fontSize, 14.96);
  assert.equal(s.document.documentElement.style.zoom, "");
  assert.equal(s.timers.size, 0);
  assert.deepEqual(s.events.map((event) => event.detail).filter(Boolean).map((detail) => JSON.parse(JSON.stringify(detail))), [
    { mode: "host-transform", nonce: "old", revision: 1, sequence: 1 },
    { mode: "host-transform", nonce: "current", revision: 2, sequence: 1 },
    { mode: "public-terminal-font", nonce: "current", revision: 2, sequence: 2 },
  ]);
});

test("terminal removal after readiness unwinds owned font and reports host mode", () => {
  const s = setup();
  s.run(0.85, "mode-switch", 4);
  s.term.element.isConnected = false;
  s.mutate();
  assert.equal(s.term.options.fontSize, 16);
  assert.deepEqual(JSON.parse(JSON.stringify(s.events.at(-1).detail)), {
    mode: "host-transform", nonce: "mode-switch", revision: 4, sequence: 2,
  });
});

test("terminal replacement cancels the old fit and captures the replacement font baseline", () => {
  const s = setup();
  s.run(0.85);
  const previous = s.term;
  s.window.term = { ...previous, options: { fontSize: 20 } };
  s.frames[0]();
  assert.equal(previous.options.fontSize, 16);
  s.run(0.935);
  assert.ok(Math.abs(s.window.term.options.fontSize - 18.7) < 1e-9);
  assert.equal(previous.options.fontSize, 16);
});

test("bounded readiness expiry does not create an unbounded fallback retry", () => {
  const s = setup();
  delete s.window.term;
  s.run(0.935);
  for (let i = 0; i < 45; i += 1) s.tick();
  assert.equal(s.timers.size, 0);
  assert.equal(s.fits.length, 0);
  s.window.term = s.term;
  s.tick();
  assert.equal(s.fits.length, 0);
});

test("preferences before and after application remain the independent baseline", () => {
  const s = setup();
  s.term.options.fontSize = 20;
  s.run(0.85);
  assert.equal(s.term.options.fontSize, 17);
  s.term.options.fontSize = 24;
  s.render();
  assert.equal(s.term.options.fontSize, 20.4);
  s.run(0.935);
  assert.ok(Math.abs(s.term.options.fontSize - 22.44) < 1e-9);
  s.run(0.85);
  assert.equal(s.term.options.fontSize, 20.4);
});

test("invalid scale or revision refuses before producing a script", () => {
  for (const scale of [0, -1, NaN, Infinity, 5]) assert.throws(() => script(scale), /Invalid guest/);
  for (const revision of [-1, 1.5, Infinity]) {
    assert.throws(() => script(0.85, "nonce", revision), /Invalid guest content scale revision/);
  }
});

test("failed terminal fit restores the font and root zoom without scheduling candidate effects", () => {
  const s = setup();
  let calls = 0;
  s.term.fit = () => { if (++calls === 1) throw new Error("refit failed"); };
  assert.throws(() => s.run(0.935), /refit failed/);
  assert.equal(s.term.options.fontSize, 16);
  assert.equal(s.document.documentElement.style.zoom, "0.85");
  assert.equal(s.frames.length, 0);
  assert.equal(s.events.length, 0);
  assert.equal(calls, 2);
});

test("terminal fallback unwinds owned font and invalidates held fits", () => {
  const s = setup();
  s.run(0.85);
  const held = s.frames[0];
  s.document.querySelectorAll = () => [s.term.element, s.term.element];
  s.run(0.935);
  assert.equal(s.term.options.fontSize, 16);
  assert.equal(s.document.documentElement.style.zoom, "");
  assert.equal(s.renders.length, 0);
  const before = s.fits.length;
  held();
  assert.equal(s.fits.length, before);
  s.document.querySelectorAll = () => [s.term.element];
  s.run(0.935);
  assert.equal(s.term.options.fontSize, 14.96);
  assert.equal(s.document.documentElement.style.zoom, "");
});

test("fallback preserves a changed font and does not call a replaced fit", () => {
  const s = setup();
  s.run(0.85);
  const held = s.frames[0];
  s.term.options.fontSize = 20;
  s.term.fit = null;
  s.run(0.935);
  assert.equal(s.term.options.fontSize, 20);
  const before = s.fits.length;
  held();
  assert.equal(s.fits.length, before);
  s.term.fit = function () { s.fits.push(this.options.fontSize); };
  s.run(0.85);
  assert.equal(s.term.options.fontSize, 17);
});

test("held fit detects an ambiguous terminal before another host scale request", () => {
  const s = setup();
  s.run(0.85);
  s.document.querySelectorAll = () => [s.term.element, s.term.element];
  s.frames[0]();
  assert.equal(s.term.options.fontSize, 16);
  assert.equal(s.document.documentElement.style.zoom, "");
  assert.deepEqual(s.fits, [13.6]);
});

test("held refit observes newer page preference without overwriting its baseline", () => {
  const s = setup();
  s.run(0.85);
  s.term.options.fontSize = 20;
  s.frames[0]();
  assert.equal(s.term.options.fontSize, 17);
  s.run(0.935);
  assert.ok(Math.abs(s.term.options.fontSize - 18.7) < 1e-9);
});

function successfulThenFailed() {
  const s = setup();
  let fail = false;
  s.term.fit = function () {
    s.fits.push(this.options.fontSize);
    if (fail) { fail = false; throw new Error("transient fit"); }
  };
  s.run(0.85);
  const held = s.frames[0];
  fail = true;
  assert.throws(() => s.run(0.935), /transient fit/);
  assert.equal(s.term.options.fontSize, 13.6);
  assert.equal(s.document.documentElement.style.zoom, "");
  return { s, held };
}

test("a failed update after success preserves the baseline through render and reset", () => {
  const { s, held } = successfulThenFailed();
  const before = s.fits.length;
  s.render();
  held();
  assert.equal(s.fits.length, before);
  assert.equal(s.term.options.fontSize, 13.6);
  s.run(0.85);
  assert.equal(s.term.options.fontSize, 13.6);
  s.run(0.935);
  assert.equal(s.term.options.fontSize, 14.96);
});

test("a failed update still unwinds owned font when terminal support disappears", () => {
  const { s, held } = successfulThenFailed();
  s.document.querySelectorAll = () => [s.term.element, s.term.element];
  s.run(0.935);
  assert.equal(s.term.options.fontSize, 16);
  assert.equal(s.document.documentElement.style.zoom, "");
  const before = s.fits.length;
  held();
  assert.equal(s.fits.length, before);
  s.document.querySelectorAll = () => [s.term.element];
  s.run(0.85);
  assert.equal(s.term.options.fontSize, 13.6);
});

test("failed update after an independent font change preserves the preference", () => {
  const { s } = successfulThenFailed();
  s.term.options.fontSize = 20;
  let fail = true;
  s.term.fit = function () {
    if (fail) { fail = false; throw new Error("preference fit"); }
  };
  assert.throws(() => s.run(0.935), /preference fit/);
  assert.equal(s.term.options.fontSize, 20);
  s.document.querySelectorAll = () => [s.term.element, s.term.element];
  s.run(0.935);
  assert.equal(s.term.options.fontSize, 20);
  s.document.querySelectorAll = () => [s.term.element];
  s.run(0.85);
  assert.equal(s.term.options.fontSize, 17);
});
