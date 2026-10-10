import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertPopOutControl, readPopOutControl, waitForPopOutState } from "../scripts/private-popout-hit.mjs";

const visible = { label: "Solo pane 2", expanded: "false", pressed: "false", toolbar: true,
  visible: true, inViewport: true, hit: true, inert: false, bounds: [14, 14, 44, 44],
  icon: true, iconVisible: true, foreground: "rgb(226, 232, 240)", strokeWidth: 2, foregroundAboveBackground: true };
test("private control proof admits visible Solo and Restore", () => {
  assertPopOutControl(visible, "Solo");
  assertPopOutControl({ ...visible, label: "Restore pane 2", expanded: "true", pressed: "true" }, "Restore");
});

function observe(mutate = () => {}) {
  const style = () => ({ display: "block", visibility: "visible", opacity: "1",
    stroke: "rgb(226, 232, 240)", strokeWidth: "2", strokeOpacity: "1", zIndex: "1" });
  const rect = (x, y, width, height) => ({ x, y, width, height, right: x + width, bottom: y + height });
  const ancestor = { parentElement: null, style: style() };
  const path = { style: style(), getBBox: () => ({ width: 8, height: 8 }) };
  const icon = { parentElement: null, style: style(), getBoundingClientRect: () => rect(28, 28, 16, 16),
    querySelectorAll: () => [path] };
  const button = { parentElement: ancestor, style: style(), getBoundingClientRect: () => rect(14, 14, 44, 44),
    querySelector: () => icon, closest: selector => selector === "[inert]" ? null : ancestor,
    getAttribute: name => ({ "aria-label": "Solo pane 2", "aria-expanded": "false", "aria-pressed": "false" })[name] };
  icon.parentElement = button; path.parentElement = icon;
  mutate({ ancestor, button, icon, path, rect });
  return runInNewContext(`(${readPopOutControl.toString()})(root)`, {
    root: { querySelector: () => button }, innerWidth: 1000, innerHeight: 700,
    getComputedStyle: (node, pseudo) => pseudo ? { zIndex: "0" } : node.style,
    document: { elementFromPoint: () => ({ closest: () => button }) },
  });
}

test("observer rejects invisible, zero-size and undrawable glyphs through actual style/geometry reads", () => {
  assertPopOutControl(observe(), "Solo");
  for (const mutate of [
    ({ icon }) => { icon.style.opacity = "0"; },
    ({ icon }) => { icon.style.visibility = "hidden"; },
    ({ icon, rect }) => { icon.getBoundingClientRect = () => rect(28, 28, 0, 16); },
    ({ ancestor }) => { ancestor.style.opacity = "0"; },
    ({ ancestor }) => { ancestor.style.display = "none"; },
    ({ path }) => { path.style.opacity = "0"; },
    ({ path }) => { path.style.strokeOpacity = "0"; },
    ({ path }) => { path.getBBox = () => ({ width: 0, height: 0 }); },
  ]) assert.throws(() => assertPopOutControl(observe(mutate), "Solo"));
});

test("completed-state polling waits through delayed Solo and Restore and fails absent completion", async () => {
  const settled = expanded => ({ expanded, pending: false, inert: false,
    ariaExpanded: String(expanded), ariaPressed: String(expanded), label: expanded ? "Restore pane 2" : "Solo pane 2" });
  for (const expanded of [true, false]) {
    let polls = 0, pauses = 0;
    const actual = await waitForPopOutState(async () => {
      polls++; return polls < 4 ? { ...settled(!expanded), pending: true } : settled(expanded);
    }, expanded, { attempts: 5, pause: async () => { pauses++; } });
    assert.equal(actual.expanded, expanded); assert.equal(polls, 4); assert.equal(pauses, 3);
    let advances = 0;
    await assert.rejects(async () => {
      await waitForPopOutState(async () => settled(!expanded), expanded, { attempts: 3, pause: async () => {} });
      advances++;
    }, /Timed out completing/);
    assert.equal(advances, 0, "failed transition cannot advance resize/topology scenario");
  }
});
test("private control proof rejects obscured, clipped, inert and unpainted targets", () => {
  for (const mutation of [{ hit: false }, { inViewport: false }, { inert: true },
    { visible: false }, { foreground: "none" }, { strokeWidth: 0 }, { bounds: [0, 0, 1, 1] },
    { toolbar: false }, { label: "Pop out pane 2" }, { foregroundAboveBackground: false }]) {
    assert.throws(() => assertPopOutControl({ ...visible, ...mutation }, "Solo"));
  }
});
