// Compare calibrated raw pixels, without assuming the platform's channel order.
// DOM completion is deliberately not an input to painted-frame admission.
import assert from "node:assert/strict";
export const PAINT_TOLERANCE = 2;

export function assertPaintReferences(references, tolerance = PAINT_TOLERANCE) {
  assert.ok(references.length >= 2, "paint calibration needs multiple owners");
  assert.ok(Number.isFinite(tolerance) && tolerance >= 0, "invalid paint tolerance");
  for (const p of references) assert.ok(p.length === 4 && p.every(v => Number.isInteger(v) && v >= 0 && v <= 255),
    "invalid calibrated reference pixel");
  for (let a = 0; a < references.length; a++) for (let b = a + 1; b < references.length; b++) {
    // Exact inequality is insufficient: accepted neighborhoods must not overlap.
    assert.ok(references[a].some((v, channel) => Math.abs(v - references[b][channel]) > 2 * tolerance),
      "ambiguous paint calibration: tolerance neighborhoods overlap");
  }
}

function raster(image, viewport) {
  const { width, height } = image.getSize(1);
  assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0,
    "capture has no pixel dimensions");
  assert.ok(viewport.width > 0 && viewport.height > 0, "invalid logical viewport");
  const bytes = image.toBitmap({ scaleFactor: 1 });
  assert.equal(bytes.length, width * height * 4,
    "unsupported capture bitmap format; do not infer pixel completion");
  return { bytes, width, height, viewport };
}

function pixel(r, x, y) {
  assert.ok(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 &&
    x < r.viewport.width && y < r.viewport.height, "pixel oracle point outside viewport");
  const px = Math.floor(x * r.width / r.viewport.width);
  const py = Math.floor(y * r.height / r.viewport.height);
  return [...r.bytes.subarray((py * r.width + px) * 4, (py * r.width + px) * 4 + 4)];
}

export function referencePixel(image, x, y) {
  return pixel(raster(image, image.getSize(1)), x, y);
}

export function paintedFrameEvidence(image, checks, viewport, tolerance = PAINT_TOLERANCE) {
  assert.ok(checks.length > 0, "pixel oracle needs independent paint samples");
  const r = raster(image, viewport);
  const samples = checks.map(({ x, y, expected }) => {
    assert.equal(expected.length, 4, "missing calibrated reference pixel");
    const observed = [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => pixel(r, x + dx, y + dy)));
    return { x, y, expected, observed,
      matches: observed.every(p => p.every((v, channel) => Math.abs(v - expected[channel]) <= tolerance)) };
  });
  return { width: r.width, height: r.height, samples, matches: samples.every(s => s.matches) };
}

export async function paintedSoloBeforeResize({ enter, paint, resize }) {
  await enter();
  await paint(); // A stale enter must never reach window/geometry mutation.
  await resize();
  await paint(); // The resized presentation has its own paint admission.
}

export async function waitForPaintedFrame(capture, checks, viewport,
  { attempts = 40, pause = () => new Promise(resolve => setTimeout(resolve, 50)) } = {}) {
  assert.ok(Number.isInteger(attempts) && attempts > 0, "invalid paint attempt bound");
  let evidence;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const image = await capture();
    evidence = paintedFrameEvidence(image, checks, viewport);
    if (evidence.matches) return { image, evidence, attempts: attempt };
    if (attempt < attempts) await pause();
  }
  throw new Error(`Timed out awaiting captured guest pixels: ${JSON.stringify(evidence)}`);
}
