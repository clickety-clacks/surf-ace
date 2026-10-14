import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { assertPaintReferences, paintedFrameEvidence, paintedSoloBeforeResize,
  referencePixel, waitForPaintedFrame } from "../scripts/private-popout-pixels.mjs";

const colors = [[31, 61, 91, 255], [41, 151, 101, 255], [171, 51, 121, 255]];
const viewport = { width: 100, height: 70 };
function image(expanded, scale = 1, order = [0, 1, 2, 3], palette = colors) {
  const width = viewport.width * scale, height = viewport.height * scale;
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const owner = expanded ? 1 : x < 30 * scale ? 0 : y < 21 * scale ? 1 : 2;
    bytes.set(order.map(channel => palette[owner][channel]), (y * width + x) * 4);
  }
  return { getSize: () => ({ width, height }), toBitmap: () => bytes };
}
const tiledChecks = expected => [
  { x: 10, y: 30, expected: expected[0] }, { x: 60, y: 10, expected: expected[1] },
  { x: 60, y: 40, expected: expected[2] },
];
const expandedChecks = expected => [
  { x: 15, y: 15, expected: expected[1] }, // Previously sibling 1.
  { x: 60, y: 40, expected: expected[1] }, // Previously sibling 3.
  { x: 80, y: 10, expected: expected[1] },
];

test("captured pixels reject tiled siblings even when caller reports expanded DOM", () => {
  assert.equal(paintedFrameEvidence(image(false), expandedChecks(colors), viewport).matches, false);
  assert.equal(paintedFrameEvidence(image(true), expandedChecks(colors), viewport).matches, true);
  assert.equal(paintedFrameEvidence(image(false), tiledChecks(colors), viewport).matches, true);
});

test("actual bitmap observer maps logical coordinates at 2x and uses calibrated channel order", () => {
  const initial = image(false, 2, [2, 1, 0, 3]);
  const calibrated = [referencePixel(initial, 20, 60), referencePixel(initial, 120, 20), referencePixel(initial, 120, 80)];
  assert.equal(new Set(calibrated.map(p => p.join(","))).size, 3);
  assert.equal(paintedFrameEvidence(image(true, 2, [2, 1, 0, 3]), expandedChecks(calibrated), viewport).matches, true);
  assert.equal(paintedFrameEvidence(initial, expandedChecks(calibrated), viewport).matches, false);
});

test("paint admission waits through delayed expansion and restoration, saving only matching image", async () => {
  for (const expanded of [true, false]) {
    let captures = 0, pauses = 0;
    const checks = expanded ? expandedChecks(colors) : tiledChecks(colors);
    const painted = await waitForPaintedFrame(async () => image(++captures < 4 ? !expanded : expanded), checks, viewport,
      { attempts: 5, pause: async () => { pauses++; } });
    assert.equal(painted.attempts, 4); assert.equal(captures, 4); assert.equal(pauses, 3);
    assert.equal(paintedFrameEvidence(painted.image, checks, viewport).matches, true);
  }
});

test("permanent stale capture fails boundedly and cannot advance the next transition", async () => {
  let captures = 0, advances = 0;
  await assert.rejects(async () => {
    await waitForPaintedFrame(async () => { captures++; return image(false); }, expandedChecks(colors), viewport,
      { attempts: 3, pause: async () => {} });
    advances++;
  }, /Timed out awaiting captured guest pixels.*observed/);
  assert.equal(captures, 3); assert.equal(advances, 0);
});

test("unsupported or absent capture data and out-of-viewport samples fail closed", () => {
  assert.throws(() => paintedFrameEvidence(image(true), [], viewport), /needs independent/);
  assert.throws(() => paintedFrameEvidence({ getSize: () => ({ width: 0, height: 0 }) }, expandedChecks(colors), viewport), /no pixel/);
  assert.throws(() => paintedFrameEvidence({ getSize: () => ({ width: 100, height: 70 }), toBitmap: () => Buffer.alloc(1) },
    expandedChecks(colors), viewport), /unsupported capture bitmap/);
  assert.throws(() => paintedFrameEvidence(image(true), [{ x: -1, y: 10, expected: colors[1] }], viewport), /outside viewport/);
});

test("close-but-distinct references cannot admit stale tiled or uniform paint", () => {
  const close = [[10, 10, 10, 255], [11, 10, 10, 255], [12, 10, 10, 255]];
  // These inputs demonstrate why the old exact-inequality guard was unsafe.
  assert.equal(paintedFrameEvidence(image(false, 1, undefined, close), expandedChecks(close), viewport).matches, true);
  assert.equal(paintedFrameEvidence(image(true, 1, undefined, close), tiledChecks(close), viewport).matches, true);
  for (const capture of [image(false, 1, undefined, close), image(true, 1, undefined, close)]) {
    let admissions = 0;
    assert.throws(() => { assertPaintReferences(close); paintedFrameEvidence(capture, expandedChecks(close), viewport); admissions++; },
      /ambiguous paint calibration/);
    assert.equal(admissions, 0);
  }
  assert.throws(() => assertPaintReferences([[10, 10, 10, 255], [14, 10, 10, 255]]), /overlap/);
  assertPaintReferences([[10, 10, 10, 255], [15, 10, 10, 255]]);
});

test("separated calibration rejects uniform host paint as the retained tiled negative", () => {
  assertPaintReferences(colors);
  assert.equal(paintedFrameEvidence(image(true), tiledChecks(colors), viewport).matches, false);
  assert.equal(paintedFrameEvidence(image(false), expandedChecks(colors), viewport).matches, false);
  assert.throws(() => assertPaintReferences([[10, 10, 10, 255], [10, 10, 10, 255]]), /ambiguous/);
});

test("actual fixture pre-resize block cannot mutate window or geometry while Solo paint stays stale", async () => {
  const source = await fs.readFile(new URL("../scripts/test-pane-popout.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  await paintedSoloBeforeResize({");
  const end = source.indexOf('  await clickControl("Restore");', start);
  assert.ok(start > 0 && end > start, "prepared fixture must route this scenario through paint admission");
  const block = source.slice(start, end);
  for (const stale of [true, false]) {
    const calls = [];
    const run = runInNewContext(`(async () => { ${block} })`, {
      paintedSoloBeforeResize,
      clickControl: async () => { calls.push("enter"); },
      capturePaint: async () => {
        calls.push("paint");
        return waitForPaintedFrame(async () => image(!stale), expandedChecks(colors), viewport,
          { attempts: 3, pause: async () => {} });
      },
      win: { setContentSize: () => { calls.push("resize"); } },
      evaluate: async () => { calls.push("geometry"); },
      wait: async () => { calls.push("bounds"); },
      waitForPopOutState: async () => { calls.push("settled"); },
    });
    if (stale) {
      await assert.rejects(run(), /Timed out awaiting captured guest pixels/);
      assert.deepEqual(calls, ["enter", "paint"], "no resize or authority mutation before paint admission");
    } else {
      await run();
      assert.deepEqual(calls, ["enter", "paint", "resize", "geometry", "bounds", "settled", "paint"]);
    }
  }
});
