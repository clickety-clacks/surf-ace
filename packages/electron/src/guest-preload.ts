import { ipcRenderer } from "electron";

type ContentEventPayload =
  | { type: "focus" }
  | { type: "navigation"; url: string }
  | { selection: SelectionPayload | null; type: "selection" }
  | { kind: "long_press" | "tap"; nearestContent?: string; position: { x: number; y: number }; type: "tap" }
  | { type: "ready"; viewport: ViewportPayload; visibleText: string }
  | { type: "scroll"; viewport: ViewportPayload; visibleText: string };

type SelectionPayload = {
  boundingRect: { height: number; width: number; x: number; y: number };
  kind: "text";
  text: string;
};

type ViewportPayload = {
  contentSize: { height: number; width: number };
  scrollOffset: { x: number; y: number };
  visibleRect: { height: number; width: number; x: number; y: number };
  zoomLevel: number;
};

const MAX_VISIBLE_TEXT_BYTES = 4096;
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function emit(payload: ContentEventPayload): void {
  ipcRenderer.sendToHost("surf-ace-content", payload);
}

function visibleText(): string {
  return (document.body?.innerText ?? "").slice(0, MAX_VISIBLE_TEXT_BYTES);
}

function currentViewport(): ViewportPayload {
  const scrolling = document.scrollingElement ?? document.documentElement;
  return {
    contentSize: { height: scrolling.scrollHeight, width: scrolling.scrollWidth },
    scrollOffset: { x: scrolling.scrollLeft, y: scrolling.scrollTop },
    visibleRect: {
      height: window.innerHeight,
      width: window.innerWidth,
      x: scrolling.scrollLeft,
      y: scrolling.scrollTop,
    },
    zoomLevel: window.visualViewport?.scale ?? 1,
  };
}

function currentSelection(): SelectionPayload | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const text = selection.toString().trim();
  if (!text) {
    return null;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return {
    boundingRect: { height: rect.height, width: rect.width, x: rect.x, y: rect.y },
    kind: "text",
    text: text.slice(0, MAX_VISIBLE_TEXT_BYTES),
  };
}

function nearestText(target: EventTarget | null): string | undefined {
  if (!(target instanceof HTMLElement)) {
    return undefined;
  }
  const text = (target.innerText || target.textContent || "").trim();
  return text ? text.slice(0, 240) : undefined;
}

function navigationTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest("a[href],button,[role='button'],input[type='button'],input[type='submit'],summary");
}

function linkTarget(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  const match = target.closest("a[href]");
  return match instanceof HTMLAnchorElement ? match : null;
}

window.addEventListener("scroll", () => {
  if (scrollTimer) {
    clearTimeout(scrollTimer);
  }
  scrollTimer = setTimeout(() => {
    emit({ type: "scroll", viewport: currentViewport(), visibleText: visibleText() });
  }, 120);
}, { passive: true });

window.addEventListener("resize", () => {
  if (resizeTimer) {
    clearTimeout(resizeTimer);
  }
  resizeTimer = setTimeout(() => {
    emit({ type: "scroll", viewport: currentViewport(), visibleText: visibleText() });
  }, 120);
});

document.addEventListener("selectionchange", () => {
  emit({ selection: currentSelection(), type: "selection" });
});

document.addEventListener("pointerdown", (event) => {
  emit({ type: "focus" });
  if (navigationTarget(event.target)) {
    return;
  }
  longPressTimer = setTimeout(() => {
    emit({
      kind: "long_press",
      nearestContent: nearestText(event.target),
      position: { x: event.clientX, y: event.clientY },
      type: "tap",
    });
    longPressTimer = null;
  }, 500);
});

document.addEventListener("pointerup", (event) => {
  if (navigationTarget(event.target)) {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    return;
  }
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    emit({
      kind: "tap",
      nearestContent: nearestText(event.target),
      position: { x: event.clientX, y: event.clientY },
      type: "tap",
    });
  }
});

document.addEventListener("pointercancel", () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
});

document.addEventListener("click", (event) => {
  const link = linkTarget(event.target);
  if (!link?.href) {
    return;
  }
  if (window.location.protocol === "data:") {
    event.preventDefault();
  }
  emit({ type: "navigation", url: link.href });
}, { capture: true });

document.addEventListener("submit", (event) => {
  if (!(event.target instanceof HTMLFormElement)) {
    return;
  }
  if (window.location.protocol === "data:") {
    event.preventDefault();
  }
  emit({ type: "navigation", url: event.target.action || window.location.href });
}, { capture: true });

window.addEventListener("DOMContentLoaded", () => {
  emit({ type: "ready", viewport: currentViewport(), visibleText: visibleText() });
});
