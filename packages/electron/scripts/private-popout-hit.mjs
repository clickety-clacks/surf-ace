import assert from "node:assert/strict";

// Serialized into the private renderer; no Electron/Surf Ace runtime imports.
export function readPopOutControl(root) {
  const visibleChain = (element) => {
    for (let current = element; current; current = current.parentElement) {
      const computed = getComputedStyle(current);
      if (computed.display === "none" || computed.visibility !== "visible" || Number(computed.opacity) <= 0) return false;
    }
    return true;
  };
  const paintedStroke = (computed) => !["none", "transparent", "rgba(0, 0, 0, 0)"].includes(computed.stroke) &&
    Number.parseFloat(computed.strokeWidth) > 0 && Number(computed.strokeOpacity) > 0;
  const button = root.querySelector(".pane-pop-out");
  if (!button) return { missing: true };
  const rect = button.getBoundingClientRect();
  const icon = button.querySelector("svg");
  const iconStyle = icon ? getComputedStyle(icon) : null;
  const backgroundStyle = getComputedStyle(button, "::before");
  const iconRect = icon?.getBoundingClientRect();
  const iconGeometry = Boolean(iconRect && iconRect.width > 0 && iconRect.height > 0 &&
    iconRect.x >= rect.x && iconRect.y >= rect.y && iconRect.right <= rect.right && iconRect.bottom <= rect.bottom);
  const drawablePath = Boolean(icon && [...icon.querySelectorAll("path")].some((path) => {
    const bounds = path.getBBox();
    return (bounds.width > 0 || bounds.height > 0) && visibleChain(path) && paintedStroke(getComputedStyle(path));
  }));
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
    visible: visibleChain(button),
    icon: Boolean(icon), foreground: iconStyle?.stroke ?? "none",
    iconBounds: iconRect ? [iconRect.x, iconRect.y, iconRect.width, iconRect.height] : null,
    iconVisible: Boolean(icon && visibleChain(icon) && iconGeometry && drawablePath),
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
  assert.equal(evidence.iconVisible, true, "icon and drawable path have visible geometry through all ancestors");
  assert.ok(!["none", "transparent", "rgba(0, 0, 0, 0)"].includes(evidence.foreground), "icon has painted stroke");
  assert.ok(evidence.strokeWidth > 0, "icon stroke has positive width");
  assert.equal(evidence.foregroundAboveBackground, true, "icon foreground is above button background");
}

// Serialized into the same renderer, observing the completed UI projection.
export function readPopOutState(root) {
  const button = root.querySelector(".pane-pop-out");
  return {
    expanded: root.classList.contains("pane-popped-out"),
    pending: root.classList.contains("pane-presentation-pending"),
    inert: root.hasAttribute("inert"),
    ariaExpanded: button?.getAttribute("aria-expanded"),
    ariaPressed: button?.getAttribute("aria-pressed"),
    label: button?.getAttribute("aria-label"),
  };
}

export async function waitForPopOutState(evaluate, expanded, { attempts = 100,
  pause = () => new Promise(resolve => setTimeout(resolve, 50)) } = {}) {
  let observed;
  for (let attempt = 0; attempt < attempts; attempt++) {
    observed = await evaluate(`(${readPopOutState.toString()})(roots[1])`);
    if (observed.expanded === expanded && !observed.pending && !observed.inert &&
        observed.ariaExpanded === String(expanded) && observed.ariaPressed === String(expanded) &&
        observed.label?.startsWith(expanded ? "Restore pane " : "Solo pane ")) return observed;
    if (attempt + 1 < attempts) await pause();
  }
  throw new Error(`Timed out completing ${expanded ? "Solo" : "Restore"}: ${JSON.stringify(observed)}`);
}
