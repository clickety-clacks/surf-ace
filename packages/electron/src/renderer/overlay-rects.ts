export type OverlayRect = { height: number; width: number; x: number; y: number };

export const PANE_LABEL_VISIBLE_CHILD_SELECTOR = ".pane-label__window, .pane-label__number";

export function elementRect(element: Element): OverlayRect | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    height: rect.height,
    width: rect.width,
    x: rect.x,
    y: rect.y,
  };
}

export function outsetRect(rect: OverlayRect, amount: number): OverlayRect {
  return {
    height: rect.height + (amount * 2),
    width: rect.width + (amount * 2),
    x: rect.x - amount,
    y: rect.y - amount,
  };
}

export function unionRects(rects: OverlayRect[]): OverlayRect | null {
  if (rects.length === 0) {
    return null;
  }
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    height: bottom - top,
    width: right - left,
    x: left,
    y: top,
  };
}

export function isMarkedOverlayVisible(element: HTMLElement, rootEl: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden) {
      return false;
    }
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    if (current === rootEl) {
      return true;
    }
  }
  return false;
}

function visibleChildRects(
  element: HTMLElement,
  selector: string,
  outset: number,
): OverlayRect[] {
  return [...element.querySelectorAll<HTMLElement>(selector)]
    .filter((child) => isMarkedOverlayVisible(child, element))
    .flatMap((child) => {
      const rect = elementRect(child);
      return rect ? [outset > 0 ? outsetRect(rect, outset) : rect] : [];
    });
}

export function visibleOverlayRect(
  element: HTMLElement,
  marker: string | undefined,
): OverlayRect | null {
  if (element.classList.contains("control-button")) {
    const rect = elementRect(element);
    return rect ? outsetRect(rect, 2) : null;
  }
  if (marker === "pane-label") {
    return unionRects(visibleChildRects(element, PANE_LABEL_VISIBLE_CHILD_SELECTOR, 0));
  }
  if (marker === "pane-handle") {
    return unionRects(visibleChildRects(element, ".control-pill", 2));
  }
  return elementRect(element);
}
