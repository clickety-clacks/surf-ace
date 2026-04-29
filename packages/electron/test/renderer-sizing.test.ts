import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

async function rendererSource(): Promise<string> {
  return fs.readFile(new URL("../../src/renderer/renderer.ts", import.meta.url), "utf8");
}

async function rendererStyles(): Promise<string> {
  return fs.readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
}

test("browser_url webviews defer navigation until the pane has a measured frame", async () => {
  const source = await rendererSource();
  const deferIndex = source.indexOf("function deferUntilPaneFrameReady");
  const browserUrlIndex = source.indexOf("if (pane.content.contentType === \"browser_url\")");
  const srcAssignmentIndex = source.indexOf("browserView.src = browserUrl.url", browserUrlIndex);

  assert.ok(deferIndex > -1);
  assert.ok(browserUrlIndex > -1);
  assert.ok(srcAssignmentIndex > browserUrlIndex);
  assert.match(source.slice(browserUrlIndex, srcAssignmentIndex), /deferUntilPaneFrameReady/);
  assert.match(source.slice(deferIndex, srcAssignmentIndex), /applyPaneFrameSize\(view, element\)/);
});

test("renderer reapplies browser_url frame sizing after layout commits and window resizes", async () => {
  const source = await rendererSource();

  assert.match(source, /function refreshDynamicPaneFrames[\s\S]*if \(!latestState\)[\s\S]*for \(const pane of latestState\.panes\)/);
  assert.match(source, /function renderWindow[\s\S]*appRoot\.replaceChildren\(wrapper\);[\s\S]*refreshDynamicPaneFrames\(\)/);
  assert.match(source, /window\.addEventListener\("resize"[\s\S]*const frame = currentPaneFrameElement\(view\);[\s\S]*applyPaneFrameSize\(view, frame\)/);
});

test("html and browser_url frames have a non-auto CSS height fallback", async () => {
  const styles = await rendererStyles();
  const frameRule = styles.match(/\.content-html-frame\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";

  assert.match(frameRule, /height:\s*100%;/);
  assert.match(frameRule, /min-height:\s*100%;/);
  assert.doesNotMatch(frameRule, /height:\s*auto;/);
});
