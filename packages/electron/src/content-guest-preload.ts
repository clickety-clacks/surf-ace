import { ipcRenderer } from "electron";

type ContentTelemetry =
  | {
      type: "scroll";
      viewport: {
        contentSize: { height: number; width: number };
        scrollOffset: { x: number; y: number };
        visibleRect: { height: number; width: number; x: number; y: number };
        zoomLevel: number;
      };
      visibleText: string;
    }
  | {
      selection: {
        boundingRect?: { height: number; width: number; x: number; y: number };
        kind: "text";
        text: string;
      } | null;
      type: "selection";
    }
  | {
      kind: "tap" | "long_press";
      nearestContent?: string;
      position: { x: number; y: number };
      type: "tap";
    }
  | {
      type: "ready";
      visibleText: string;
      viewport: {
        contentSize: { height: number; width: number };
        scrollOffset: { x: number; y: number };
        visibleRect: { height: number; width: number; x: number; y: number };
        zoomLevel: number;
      };
    };

const MAX_VISIBLE_TEXT_BYTES = 4096;
let longPressTimer: NodeJS.Timeout | null = null;

function emit(payload: ContentTelemetry): void {
  ipcRenderer.sendToHost("surf-ace-content", payload);
}

function visibleText(): string {
  return (document.body?.innerText ?? "").slice(0, MAX_VISIBLE_TEXT_BYTES);
}

function currentViewport() {
  const scrolling = document.scrollingElement ?? document.documentElement;
  return {
    contentSize: {
      height: scrolling.scrollHeight,
      width: scrolling.scrollWidth,
    },
    scrollOffset: {
      x: scrolling.scrollLeft,
      y: scrolling.scrollTop,
    },
    visibleRect: {
      height: window.innerHeight,
      width: window.innerWidth,
      x: scrolling.scrollLeft,
      y: scrolling.scrollTop,
    },
    zoomLevel: window.visualViewport?.scale ?? 1,
  };
}

function currentSelection() {
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
    boundingRect: {
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    },
    kind: "text" as const,
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

let scrollTimer: NodeJS.Timeout | null = null;
window.addEventListener(
  "scroll",
  () => {
    if (scrollTimer) {
      clearTimeout(scrollTimer);
    }
    scrollTimer = setTimeout(() => {
      emit({
        type: "scroll",
        viewport: currentViewport(),
        visibleText: visibleText(),
      });
    }, 120);
  },
  { passive: true },
);

document.addEventListener("selectionchange", () => {
  emit({
    selection: currentSelection(),
    type: "selection",
  });
});

document.addEventListener("pointerdown", (event) => {
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

window.addEventListener("DOMContentLoaded", () => {
  emit({
    type: "ready",
    viewport: currentViewport(),
    visibleText: visibleText(),
  });
});
