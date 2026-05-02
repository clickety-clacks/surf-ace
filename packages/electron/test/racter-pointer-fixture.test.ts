import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function demoSource(): Promise<string> {
  return fs.readFile(path.join(process.cwd(), "scripts", "racter-native-pane-demo.mjs"), "utf8");
}

async function nativePointerSource(): Promise<string> {
  return fs.readFile(path.join(process.cwd(), "scripts", "surf-ace-native-pointer-tester.mjs"), "utf8");
}

test("Racter pointer proof fixture uses real web and native pointer targets", async () => {
  const source = await demoSource();
  const modeIndex = source.indexOf("mode === \"pointer-proof\"");
  const scenarioIndex = source.indexOf("async function runPointerProofScenario");

  assert.ok(modeIndex > -1);
  assert.ok(scenarioIndex > modeIndex);
  assert.match(source.slice(scenarioIndex), /client\.request\("content\.apply"/);
  assert.match(source.slice(scenarioIndex), /contentType: "html"/);
  assert.match(source.slice(scenarioIndex), /target_racter_native_pointer/);
  assert.match(source.slice(scenarioIndex), /surf-ace-native-pointer-tester\.mjs/);
});

test("web pointer proof draws at event-local coordinates", async () => {
  const source = await demoSource();
  const htmlIndex = source.indexOf("function pointerProofHtml");

  assert.ok(htmlIndex > -1);
  assert.match(source.slice(htmlIndex), /dot\.style\.left = event\.clientX \+ "px"/);
  assert.match(source.slice(htmlIndex), /dot\.style\.top = event\.clientY \+ "px"/);
  assert.match(source.slice(htmlIndex), /WEB POINTER/);
});

test("native pointer proof enables SGR mouse tracking and preserves the full title", async () => {
  const source = await nativePointerSource();

  assert.match(source, /NATIVE POINTER/);
  assert.doesNotMatch(source, /NATIVE OINTER/);
  assert.match(source, /\?1006h/);
  assert.match(source, /\\x1b\\\[<\(\\d\+\);\(\\d\+\);\(\\d\+\)\(\[Mm\]\)/);
  assert.match(source, /writeAt\(x, y,/);
});
