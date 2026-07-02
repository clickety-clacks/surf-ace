export type OverlayRect = { height: number; width: number; x: number; y: number };

export const PANE_LABEL_VISIBLE_CHILD_SELECTOR = ".pane-label__window, .pane-label__disconnected, .pane-label__number";

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

function rangeRectForElementText(element: HTMLElement): OverlayRect | null {
  if (!element.textContent?.trim() || typeof document.createRange !== "function") {
    return null;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects = [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    }));
  range.detach();
  return unionRects(rects);
}

function clampRectToRect(rect: OverlayRect, bounds: OverlayRect): OverlayRect {
  const x = Math.max(bounds.x, rect.x);
  const y = Math.max(bounds.y, rect.y);
  const right = Math.min(bounds.x + bounds.width, rect.x + rect.width);
  const bottom = Math.min(bounds.y + bounds.height, rect.y + rect.height);
  return {
    height: Math.max(1, bottom - y),
    width: Math.max(1, right - x),
    x,
    y,
  };
}

function expandedAffordanceRect(
  rect: OverlayRect,
  bounds: OverlayRect,
  options: { minHeight: number; minWidth: number; padX: number; padY: number },
): OverlayRect {
  const width = Math.min(bounds.width, Math.max(options.minWidth, rect.width + (options.padX * 2)));
  const height = Math.min(bounds.height, Math.max(options.minHeight, rect.height + (options.padY * 2)));
  return clampRectToRect({
    height,
    width,
    x: rect.x + (rect.width / 2) - (width / 2),
    y: rect.y + (rect.height / 2) - (height / 2),
  }, bounds);
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

function visibleTextAffordanceRect(element: HTMLElement): OverlayRect | null {
  const bounds = elementRect(element);
  const textRect = rangeRectForElementText(element);
  if (bounds && textRect) {
    return expandedAffordanceRect(textRect, bounds, { minHeight: 54, minWidth: 48, padX: 8, padY: 2 });
  }
  return textRect ?? bounds;
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
    return unionRects([...element.querySelectorAll<HTMLElement>(PANE_LABEL_VISIBLE_CHILD_SELECTOR)]
      .filter((child) => isMarkedOverlayVisible(child, element))
      .flatMap((child) => {
        const rect = visibleTextAffordanceRect(child);
        return rect ? [rect] : [];
      }));
  }
  if (marker === "pane-handle") {
    return unionRects(visibleChildRects(element, ".control-pill", 2));
  }
  return elementRect(element);
}
