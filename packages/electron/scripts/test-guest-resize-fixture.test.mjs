// Source-only fixture checks: no Electron import, application, network or guest launch.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./test-guest-resize.mjs", import.meta.url), "utf8");
const split = source.match(/await evaluate\("split-projection", `([\s\S]*?)`\);/)[1]
  .replace("${JSON.stringify(makePane(4))}", '{"paneId":4}');
const reorder = JSON.parse(source.match(/await evaluate\("reorder-projection", ("[^\n]*")\);/)[1]);
const divider = JSON.parse(source.match(/await evaluate\("divider-geometry", ("[^\n]*")\);/)[1]);
const projectionContext = () => {
  const context = vm.createContext({
    structuredClone,
    fixtureState: { panes: [{ paneId: 1 }, { paneId: 2 }, { paneId: 3 }],
      layout: { children: [{ original: true }, {}] }, topologyRevision: 1, geometryRevision: 1 },
    fixtureUpdate() {},
  });
  context.window = context;
  return context;
};

test("unscoped projection control reproduces duplicate const in one host context", () => {
  const context = projectionContext();
  const unscoped = (script) => script.slice("(()=>{".length, -"})()".length);
  vm.runInContext(unscoped(split), context);
  assert.throws(() => vm.runInContext(unscoped(reorder), context),
    (error) => error.name === "SyntaxError" && error.message.includes("Identifier 'next' has already been declared"));
});

test("fixture split and reorder execute repeatedly without sharing lexical declarations", () => {
  const context = projectionContext();
  vm.runInContext(split, context);
  const added = context.fixtureState.panes[3];
  assert.equal(added.paneId, 4);
  const original = context.fixtureState.layout.children[0];
  vm.runInContext(reorder, context);
  assert.equal(context.fixtureState.layout.children[1].original, original.original);
  vm.runInContext(reorder, context);
  assert.equal(context.fixtureState.layout.children[0].original, original.original);
  assert.equal(context.fixtureState.topologyRevision, 4);
  assert.equal(context.fixtureState.geometryRevision, 2);
  assert.equal(context.next, undefined);
});

test("missing divider returns diagnostic inventory instead of dereferencing null", () => {
  const result = vm.runInNewContext(divider, { document: {
    querySelector: () => null,
    querySelectorAll: () => [{ className: "split-resize-handle-vertical" }],
  } });
  assert.equal(result.error, "Missing horizontal divider");
  assert.deepEqual(Array.from(result.handles), ["split-resize-handle-vertical"]);
});

const evaluatorContext = (executeJavaScript) => {
  const logs = [];
  const context = vm.createContext({ Date, Error, win: { webContents: { executeJavaScript } },
    console: { log: (message) => logs.push(message), error: (message) => logs.push(message) } });
  const stage = source.slice(source.indexOf('  let fixtureStage = "setup";'), source.indexOf("  const blockedRequests = []"));
  const evaluate = source.slice(source.indexOf("    const evaluate = async"), source.indexOf("    const printGuestDiagnostics"));
  vm.runInContext(`${stage}\n${evaluate}\nglobalThis.evaluate = evaluate;`, context);
  return { context, logs };
};

test("failed evaluation records exact stage and code and preserves the original cause", async () => {
  const cause = new Error("synthetic guest failure");
  const { context, logs } = evaluatorContext(async () => { throw cause; });
  await assert.rejects(context.evaluate("retained-after-drag:history", "privateHistoryProbe()"), (error) => {
    assert.equal(error.message, "Fixture evaluation failed at retained-after-drag:history");
    assert.equal(error.cause, cause);
    return true;
  });
  const failure = JSON.parse(logs.find((line) => line.startsWith("FIXTURE_EVALUATION_FAILURE=")).split("=", 2)[1]);
  assert.equal(failure.label, "retained-after-drag:history");
  assert.equal(failure.code, "privateHistoryProbe()");
  assert.equal(failure.error, "Error: synthetic guest failure");
  assert.ok(failure.elapsedMs >= 0);
});

test("evaluation success preserves result and reports its stage", async () => {
  const result = { token: "private" };
  const { context, logs } = evaluatorContext(async () => result);
  assert.equal(await context.evaluate("zoom-after", "privateZoomProbe()"), result);
  assert.ok(logs.some((line) => line.includes('"label":"zoom-after"')));
  assert.equal(logs.some((line) => line.startsWith("FIXTURE_EVALUATION_FAILURE=")), false);
});
