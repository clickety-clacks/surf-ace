import assert from "node:assert/strict";
import test from "node:test";

import { restoreWindowPlacement, sanitizeWindowPlacement } from "../src/window-placement.js";

test("window placement restores saved bounds on the matching display", () => {
  const restored = restoreWindowPlacement(
    {
      bounds: { height: 700, width: 900, x: 2100, y: 120 },
      displayId: 2,
      fullscreen: true,
    },
    [
      { id: 1, workArea: { height: 900, width: 1440, x: 0, y: 0 } },
      { id: 2, workArea: { height: 1080, width: 1920, x: 1440, y: 0 } },
    ],
    { id: 1, workArea: { height: 900, width: 1440, x: 0, y: 0 } },
  );

  assert.deepEqual(restored, {
    bounds: { height: 700, width: 900, x: 2100, y: 120 },
    displayId: 2,
    fullscreen: true,
  });
});

test("window placement falls back to primary work area when the saved display is missing", () => {
  const restored = restoreWindowPlacement(
    {
      bounds: { height: 1000, width: 1600, x: 4000, y: 1800 },
      displayId: 99,
      fullscreen: false,
    },
    [{ id: 1, workArea: { height: 900, width: 1440, x: 0, y: 0 } }],
    { id: 1, workArea: { height: 900, width: 1440, x: 0, y: 0 } },
  );

  assert.deepEqual(restored, {
    bounds: { height: 900, width: 1440, x: 0, y: 0 },
    displayId: 1,
    fullscreen: false,
  });
});

test("window placement rejects invalid persisted geometry", () => {
  assert.equal(sanitizeWindowPlacement({ bounds: { height: 100, width: 100, x: 0, y: 0 } }), null);
  assert.equal(sanitizeWindowPlacement({ bounds: { height: 600, width: Number.NaN, x: 0, y: 0 } }), null);
});
