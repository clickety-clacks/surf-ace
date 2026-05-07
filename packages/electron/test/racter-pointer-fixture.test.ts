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

test("Racter native pane demo cannot register production-trusted Surf Ace surfaces", async () => {
  const source = await demoSource();

  assert.match(source, /racter-native-pane-demo is disabled/);
  assert.match(source, /must not pair with production-trusted Surf Ace surfaces/);
  assert.doesNotMatch(source, /new WebSocket|connectWebSocket|pair\.request|topology\.apply|target\.apply|content\.apply/);
});

test("Racter native pane demo cannot smuggle caller-controlled visible IDs", async () => {
  const source = await demoSource();

  assert.doesNotMatch(source, /windowLabel|initialPaneId|initialPaneLabel|paneLabel|paneId/);
  assert.doesNotMatch(source, /RACTER Graphical Native/);
  assert.doesNotMatch(source, /DOCS/);
  assert.doesNotMatch(source, /RACTER Overlay Verify/);
});

test("Racter native pane demo no longer contains executable pointer proof behavior", async () => {
  const source = await demoSource();

  assert.doesNotMatch(source, /function pointerProofHtml/);
  assert.doesNotMatch(source, /dot\.style\.left|dot\.style\.top/);
  assert.doesNotMatch(source, /WEB POINTER|NATIVE POINTER/);
});

test("native pointer proof enables SGR mouse tracking and preserves the full title", async () => {
  const source = await nativePointerSource();

  assert.match(source, /NATIVE POINTER/);
  assert.doesNotMatch(source, /NATIVE OINTER/);
  assert.match(source, /\?1006h/);
  assert.match(source, /\\x1b\\\[<\(\\d\+\);\(\\d\+\);\(\\d\+\)\(\[Mm\]\)/);
  assert.match(source, /writeAt\(x, y,/);
});
