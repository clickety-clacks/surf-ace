import assert from "node:assert/strict";

// Serialized into the private renderer; no Electron/Surf Ace runtime imports.
export function readPopOutControl(root) {
  const button = root.querySelector(".pane-pop-out");
  if (!button) return { missing: true };
  const rect = button.getBoundingClientRect();
  const style = getComputedStyle(button);
  const icon = button.querySelector("svg");
  const iconStyle = icon ? getComputedStyle(icon) : null;
  const backgroundStyle = getComputedStyle(button, "::before");
  const x = Math.round(rect.x + rect.width / 2);
  const y = Math.round(rect.y + rect.height / 2);
  return {
    label: button.getAttribute("aria-label"),
    expanded: button.getAttribute("aria-expanded"),
    pressed: button.getAttribute("aria-pressed"),
    bounds: [rect.x, rect.y, rect.width, rect.height], x, y,
    inViewport: rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
    hit: document.elementFromPoint(x, y)?.closest(".pane-pop-out") === button,
    inert: Boolean(button.closest("[inert]")),
    toolbar: Boolean(button.closest(".annotation-pill")),
    visible: style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0,
    icon: Boolean(icon), foreground: iconStyle?.stroke ?? "none",
    strokeWidth: Number.parseFloat(iconStyle?.strokeWidth ?? "0"),
    foregroundAboveBackground: Number.parseInt(iconStyle?.zIndex ?? "0", 10) >
      Number.parseInt(backgroundStyle.zIndex, 10),
  };
}

export function assertPopOutControl(evidence, action) {
  assert.equal(evidence.missing, undefined, "Solo/Restore exists");
  assert.match(evidence.label, new RegExp(`^${action} pane `));
  assert.equal(evidence.expanded, String(action === "Restore"));
  assert.equal(evidence.pressed, String(action === "Restore"));
  assert.equal(evidence.toolbar, true, "control belongs to bottom annotation toolbar");
  assert.equal(evidence.visible, true, "control is visible");
  assert.equal(evidence.inViewport, true, "entire target is inside viewport");
  assert.equal(evidence.hit, true, "real center point hits retained control");
  assert.equal(evidence.inert, false, "control is outside inert ancestors");
  assert.ok(evidence.bounds[2] >= 44 && evidence.bounds[3] >= 44, "44px input target");
  assert.equal(evidence.icon, true, "decorative icon exists");
  assert.ok(!["none", "transparent", "rgba(0, 0, 0, 0)"].includes(evidence.foreground), "icon has painted stroke");
  assert.ok(evidence.strokeWidth > 0, "icon stroke has positive width");
  assert.equal(evidence.foregroundAboveBackground, true, "icon foreground is above button background");
}
