import assert from "node:assert/strict";
import test from "node:test";
import { assertPopOutControl } from "../scripts/private-popout-hit.mjs";

const visible = { label: "Solo pane 2", expanded: "false", pressed: "false", toolbar: true,
  visible: true, inViewport: true, hit: true, inert: false, bounds: [14, 14, 44, 44],
  icon: true, foreground: "rgb(226, 232, 240)", strokeWidth: 2, foregroundAboveBackground: true };
test("private control proof admits visible Solo and Restore", () => {
  assertPopOutControl(visible, "Solo");
  assertPopOutControl({ ...visible, label: "Restore pane 2", expanded: "true", pressed: "true" }, "Restore");
});
test("private control proof rejects obscured, clipped, inert and unpainted targets", () => {
  for (const mutation of [{ hit: false }, { inViewport: false }, { inert: true },
    { visible: false }, { foreground: "none" }, { strokeWidth: 0 }, { bounds: [0, 0, 1, 1] },
    { toolbar: false }, { label: "Pop out pane 2" }, { foregroundAboveBackground: false }]) {
    assert.throws(() => assertPopOutControl({ ...visible, ...mutation }, "Solo"));
  }
});
