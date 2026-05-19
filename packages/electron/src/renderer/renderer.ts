import {
  isMarkedOverlayVisible,
  visibleOverlayRect,
} from "./overlay-rects.js";
import { markdownToHtml } from "./markdown.js";

type Selection =
  | null
  | {
      boundingRect?: { height: number; width: number; x: number; y: number };
      kind: "text";
      text: string;
    };

type Viewport = {
  contentSize: { height: number; width: number };
  scrollOffset: { x: number; y: number };
  visibleRect: { height: number; width: number; x: number; y: number };
  zoomLevel: number;
};

type StrokePoint = {
  pressure?: number;
  timestamp: number;
  x: number;
  y: number;
};

type Stroke = {
  points: StrokePoint[];
  strokeId: string;
  tool: "finger" | "mouse" | "pencil";
};

type OverlayCapture = "pointer_axis" | "pointer_button" | "pointer_hover";
type OverlayRegionReport = {
  captures: OverlayCapture[];
  kind: "annotation_control" | "history_back" | "history_forward" | "other" | "pane_badge" | "pane_handle";
  paneId: string;
  paneInstanceId: string;
  rect: { height: number; width: number; x: number; y: number };
  regionId: string;
  zIndex?: number;
};

type ImageContent = { alt?: string; data: string; mediaType: string };
type PdfContent = { data: string };
type HtmlContent = { baseUrl?: string; html: string };
type TerminalContent = { lines: string[]; scrollback: number };
type MarkdownContent = { markdown: string };
type VideoContent = string;
type CanvasContent = "" | { color?: string; grid?: boolean };
type BrowserUrlContent = { url: string };
type ContentReloadSource = { kind: "file"; path: string };
type BrowserUrlWebViewElement = HTMLElement & {
  executeJavaScript?: (code: string) => Promise<unknown>;
  getWebContentsId?: () => number;
  reload?: () => void;
  src: string;
  stop?: () => void;
};
type BrowserContentIpcEvent = Event & {
  args?: unknown[];
  channel?: string;
};
type BrowserContentNavigationEvent = Event & {
  isMainFrame?: boolean;
  url?: string;
};
type BrowserUrlWebViewErrorEvent = Event & {
  errorDescription?: string;
  isMainFrame?: boolean;
};
type BrowserUrlDiagnosticReason =
  | "did-attach"
  | "did-fail-load"
  | "did-finish-load"
  | "did-finish-load:guest-viewport"
  | "dom-ready"
  | "dom-ready:guest-viewport"
  | "guest-viewport-retry"
  | "navigation-assigned"
  | "pre-navigation"
  | "resize";
type BrowserUrlGuestMetrics = {
  bodyRect: { height: number; width: number; x: number; y: number } | null;
  devicePixelRatio: number;
  innerHeight: number;
  innerWidth: number;
  location: string;
  rootClientHeight: number | null;
  rootClientWidth: number | null;
  scrollX: number;
  scrollY: number;
  rootScrollHeight: number | null;
  rootScrollWidth: number | null;
  visualViewport: { height: number; scale: number; width: number } | null;
};
type PaneContentValue =
  | null
  | BrowserUrlContent
  | CanvasContent
  | HtmlContent
  | ImageContent
  | MarkdownContent
  | PdfContent
  | TerminalContent
  | VideoContent;

type RendererPaneState = {
  activeKeyboardPane: boolean;
  annotationBorderVisible: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  content: {
    content: PaneContentValue;
    contentId: string | null;
    contentType: "browser_url" | "canvas" | "html" | "image" | "markdown" | "pdf" | "terminal" | "video" | null;
    display?: {
      interactive?: boolean;
      provenance?: {
        agentId?: string;
        displayName?: string;
        sessionKey?: string;
        source?: string;
        streamLabel?: string;
      };
      scrollable?: boolean;
      title?: string;
    };
    reloadable: boolean;
    reloadSource?: ContentReloadSource;
    renderVersion: number;
    revision: number;
  };
  drawings: Stroke[];
  externalNative: boolean;
  flushInFlight: boolean;
  label: string;
  name: string | null;
  ownerName: string | null;
  paneId: number;
  displayId: string;
  provenanceName: string | null;
  visibleAddress: string;
  showDone: boolean;
  toast: string | null;
};

type LayoutNode =
  | { paneId: number; type: "pane"; weight?: number }
  | { children: LayoutNode[]; direction: "horizontal" | "vertical"; type: "split"; weight?: number };

type RendererWindowState = {
  connectionBar: "connected" | "connecting" | "disconnected";
  geometryRevision?: number;
  layout: LayoutNode | null;
  name: string;
  panes: RendererPaneState[];
  providerName: string | null;
  surfaceId: string;
  topologyRevision: number;
  viewport: { height: number; scale: number; width: number };
  windowLabel: string;
};

type Bootstrap = {
  compositorHosted?: boolean;
  overlayDebugBorders?: boolean;
  state: RendererWindowState;
  surfaceId: string;
};

type KeyboardScrollIntent = {
  amount: "line" | "page";
  direction: "down" | "left" | "right" | "up";
  paneId: number;
  type: "scroll";
};

type BrowserUrlKeyboardScrollResult = {
  viewport: Viewport;
  visibleText: string;
};

type NavigationMemo = {
  at: number;
  url: string;
};

type PaneView = {
  annotationCanvas: HTMLCanvasElement;
  annotationShield: HTMLDivElement;
  contentEl: HTMLElement;
  controlsEl: HTMLDivElement;
  currentContentKey: string;
  currentDrawingsKey: string;
  currentHtmlFrameCleanup: (() => void) | null;
  currentRenderToken: number;
  currentScrollHandler: (() => void) | null;
  currentWebViewResizeObserver: ResizeObserver | null;
  lastNavigation: NavigationMemo | null;
  paneId: number;
  rootEl: HTMLDivElement;
  scrollEl: HTMLDivElement;
  toastTimeout: number | null;
};

type PdfJsModule = {
  getDocument: (source: { data: Uint8Array; disableWorker: boolean }) => {
    promise: Promise<PdfDocument>;
  };
};

type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
};

type PdfPage = {
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
  getViewport: (params: { scale: number }) => { height: number; width: number };
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { height: number; width: number };
  }) => { promise: Promise<void> };
};

const appRoot = document.querySelector("#app") as HTMLDivElement;
const paneViews = new Map<number, PaneView>();
let bootstrap: Bootstrap | null = null;
let latestState: RendererWindowState | null = null;
let latestLayoutKey: string | null = null;
let overlayRegionsFrame: number | null = null;
let overlayRegionsTimer: number | null = null;
let overlayRevision = 0;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

const OVERLAY_CAPTURES: OverlayCapture[] = ["pointer_hover", "pointer_button", "pointer_axis"];
const OVERLAY_MARKER_ATTRIBUTE = "data-surf-ace-overlay";
type SurfAceOverlayKind =
  | "annotation-control"
  | "history-back"
  | "keyboard-focus-edge"
  | "history-forward"
  | "pane-label"
  | "pane-handle"
  | "reload";

function errorDiagnosticFields(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorName: error.name,
      errorStack: error.stack?.slice(0, 600) ?? "",
    };
  }
  return { errorMessage: String(error) };
}

function rendererDiagnostic(event: string, fields: Record<string, unknown> = {}): void {
  try {
    window.surfAce.reportRendererDiagnostic({
      ...fields,
      event,
    });
  } catch (error) {
    console.warn(`[surf-ace] renderer diagnostic failed: ${error}`);
  }
}

window.addEventListener("error", (event) => {
  rendererDiagnostic("window_error", {
    colno: event.colno,
    filename: event.filename,
    lineno: event.lineno,
    message: event.message,
    ...errorDiagnosticFields(event.error),
  });
});

window.addEventListener("unhandledrejection", (event) => {
  rendererDiagnostic("unhandled_rejection", errorDiagnosticFields(event.reason));
});

function contentKey(pane: RendererPaneState): string {
  return `${pane.externalNative ? "native" : "renderer"}:${pane.content.contentType ?? "empty"}:${pane.content.contentId ?? "none"}:${pane.content.revision}:${pane.content.renderVersion}`;
}

function paneRenderKey(state: RendererWindowState, pane: RendererPaneState): string {
  return JSON.stringify({
    activeKeyboardPane: pane.activeKeyboardPane,
    annotationBorderVisible: pane.annotationBorderVisible,
    canGoBack: pane.canGoBack,
    canGoForward: pane.canGoForward,
    content: contentKey(pane),
    displayId: pane.displayId,
    drawings: drawingsKey(pane.drawings),
    externalNative: pane.externalNative,
    flushInFlight: pane.flushInFlight,
    label: pane.label,
    name: pane.name,
    ownerName: pane.ownerName,
    provenanceName: pane.provenanceName,
    reloadable: pane.content.reloadable,
    showDone: pane.showDone,
    toast: pane.toast,
    visibleAddress: pane.visibleAddress,
    windowLabel: state.windowLabel,
  });
}

function drawingsKey(drawings: Stroke[]): string {
  return drawings.map((stroke) => stroke.strokeId).join(",");
}

function paneStateById(paneId: number): RendererPaneState | null {
  return latestState?.panes.find((pane) => pane.paneId === paneId) ?? null;
}

function paneStateFor(view: PaneView): RendererPaneState | null {
  return paneStateById(view.paneId);
}

function isBrowserUrlPane(pane: RendererPaneState): boolean {
  return pane.content.contentType === "browser_url";
}

function rememberPaneContext(paneId: number): void {
  if (paneId <= 0) {
    return;
  }
  window.surfAce.command({ paneId, type: "focus-pane" });
}

function paneBounds(view: PaneView) {
  const rect = view.rootEl.getBoundingClientRect();
  return {
    height: rect.height,
    width: rect.width,
    x: rect.x,
    y: rect.y,
  };
}

function reportPaneSnapshot(view: PaneView): void {
  const frame = currentPaneFrameElement(view);
  if (frame?.matches("webview.content-browser-url-frame")) {
    window.surfAce.reportSnapshot({
      bounds: paneBounds(view),
      paneId: view.paneId,
    });
    return;
  }
  const visibleText = currentVisibleText(view);
  const selection = currentSelectionWithin(view);
  const viewport = currentViewport(view);
  window.surfAce.reportSnapshot({
    bounds: paneBounds(view),
    paneId: view.paneId,
    selection,
    viewport,
    visibleText,
  });
}

function reportAllPaneSnapshots(): void {
  if (!latestState) {
    return;
  }
  for (const pane of latestState.panes) {
    const view = paneViews.get(pane.paneId);
    if (view) {
      reportPaneSnapshot(view);
    }
  }
}

function overlayRegionForElement(
  pane: RendererPaneState,
  element: HTMLElement,
  idSuffix: string,
  kind: OverlayRegionReport["kind"],
  zIndex: number,
  captures: OverlayCapture[] = OVERLAY_CAPTURES,
): OverlayRegionReport | null {
  const marker = element.getAttribute(OVERLAY_MARKER_ATTRIBUTE) ?? undefined;
  const rect = visibleOverlayRect(element, marker);
  if (!rect || !latestState) {
    return null;
  }
  return {
    captures,
    kind,
    paneId: String(pane.paneId),
    paneInstanceId: `${latestState.surfaceId}:${pane.paneId}:${pane.content.contentId ?? "none"}`,
    rect,
    regionId: `surf-ace-pane-${pane.paneId}-${idSuffix}`,
    zIndex,
  };
}

function overlayMetadataForMarker(
  marker: string | undefined,
): { captures: OverlayCapture[]; kind: OverlayRegionReport["kind"]; suffix: string; zIndex: number } {
  switch (marker) {
    case "annotation-control":
      return { captures: OVERLAY_CAPTURES, kind: "annotation_control", suffix: marker, zIndex: 20 };
    case "history-back":
      return { captures: OVERLAY_CAPTURES, kind: "history_back", suffix: marker, zIndex: 20 };
    case "history-forward":
      return { captures: OVERLAY_CAPTURES, kind: "history_forward", suffix: marker, zIndex: 20 };
    case "reload":
      return { captures: OVERLAY_CAPTURES, kind: "other", suffix: marker, zIndex: 20 };
    case "keyboard-focus-edge":
      return { captures: ["pointer_hover"], kind: "other", suffix: marker, zIndex: 25 };
    case "pane-label":
      return { captures: ["pointer_hover"], kind: "pane_badge", suffix: marker, zIndex: 15 };
    case "pane-handle":
      return { captures: OVERLAY_CAPTURES, kind: "pane_handle", suffix: marker, zIndex: 10 };
    default:
      return { captures: OVERLAY_CAPTURES, kind: "other", suffix: marker || "overlay", zIndex: 10 };
  }
}

function surfAceOverlay<T extends HTMLElement>(element: T, kind: SurfAceOverlayKind): T {
  element.setAttribute(OVERLAY_MARKER_ATTRIBUTE, kind);
  return element;
}

function collectMarkedOverlayRegions(pane: RendererPaneState, view: PaneView): OverlayRegionReport[] {
  const markerSelector = `[${OVERLAY_MARKER_ATTRIBUTE}]`;
  return [...view.rootEl.querySelectorAll<HTMLElement>(markerSelector)].flatMap((element, index) => {
    if (!isMarkedOverlayVisible(element, view.rootEl)) {
      return [];
    }
    const marker = element.getAttribute(OVERLAY_MARKER_ATTRIBUTE) ?? undefined;
    const metadata = overlayMetadataForMarker(marker);
    const region = overlayRegionForElement(
      pane,
      element,
      `${metadata.suffix}-${index}`,
      metadata.kind,
      metadata.zIndex,
      metadata.captures,
    );
    return region ? [region] : [];
  });
}

function reportCompositorOverlayRegions(updateReason: "layout" | "resize" | "visibility"): void {
  overlayRevision += 1;
  if (!latestState) {
    window.surfAce.reportOverlayRegions({
      coordinateSpace: "surface_logical",
      regions: [],
      revision: overlayRevision,
      topologyEpoch: "0",
      updateReason,
    });
    return;
  }

  const regions: OverlayRegionReport[] = [];
  for (const pane of latestState.panes) {
    const view = paneViews.get(pane.paneId);
    if (view) {
      regions.push(...collectMarkedOverlayRegions(pane, view));
    }
  }
  window.surfAce.reportOverlayRegions({
    coordinateSpace: "surface_logical",
    regions,
    revision: latestState.geometryRevision ?? overlayRevision,
    topologyEpoch: String(latestState.topologyRevision),
    updateReason,
  });
}

function scheduleCompositorOverlayRegionReport(updateReason: "layout" | "resize" | "visibility"): void {
  if (overlayRegionsFrame !== null) {
    window.cancelAnimationFrame(overlayRegionsFrame);
  }
  if (overlayRegionsTimer !== null) {
    window.clearTimeout(overlayRegionsTimer);
  }
  overlayRegionsFrame = window.requestAnimationFrame(() => {
    overlayRegionsFrame = null;
    reportCompositorOverlayRegions(updateReason);
  });
  overlayRegionsTimer = window.setTimeout(() => {
    overlayRegionsTimer = null;
    reportCompositorOverlayRegions(updateReason);
  }, 80);
}

function currentViewport(view: PaneView): Viewport {
  const scrollEl = view.scrollEl;
  return {
    contentSize: {
      height: scrollEl.scrollHeight,
      width: scrollEl.scrollWidth,
    },
    scrollOffset: {
      x: scrollEl.scrollLeft,
      y: scrollEl.scrollTop,
    },
    visibleRect: {
      height: scrollEl.clientHeight,
      width: scrollEl.clientWidth,
      x: scrollEl.scrollLeft,
      y: scrollEl.scrollTop,
    },
    zoomLevel: 1,
  };
}

function currentVisiblePdfPage(view: PaneView): HTMLElement | null {
  const pages = [...view.contentEl.querySelectorAll<HTMLElement>(".content-pdf-page")];
  if (pages.length === 0) {
    return null;
  }

  const viewportTop = view.scrollEl.scrollTop;
  const viewportBottom = viewportTop + view.scrollEl.clientHeight;
  let bestPage = pages[0] ?? null;
  let bestVisibleHeight = -1;

  for (const page of pages) {
    const top = page.offsetTop;
    const bottom = top + page.offsetHeight;
    const visibleHeight = Math.min(bottom, viewportBottom) - Math.max(top, viewportTop);
    if (visibleHeight > bestVisibleHeight) {
      bestVisibleHeight = visibleHeight;
      bestPage = page;
    }
  }

  return bestPage;
}

function currentVisibleText(view: PaneView): string {
  const currentPdfPage = currentVisiblePdfPage(view);
  if (currentPdfPage) {
    return (currentPdfPage.dataset.pageText ?? "").slice(0, 4096);
  }
  return (view.contentEl.textContent ?? "").slice(0, 4096);
}

function currentSelectionWithin(view: PaneView): Selection {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!view.rootEl.contains(range.commonAncestorContainer)) {
    return null;
  }
  const text = selection.toString().trim();
  if (!text) {
    return null;
  }
  const paneRect = view.rootEl.getBoundingClientRect();
  const rect = range.getBoundingClientRect();
  return {
    boundingRect: {
      height: rect.height,
      width: rect.width,
      x: rect.x - paneRect.x,
      y: rect.y - paneRect.y,
    },
    kind: "text",
    text: text.slice(0, 4096),
  };
}

function resizeAnnotationCanvas(view: PaneView): void {
  const ratio = window.devicePixelRatio || 1;
  const rect = view.rootEl.getBoundingClientRect();
  view.annotationCanvas.width = Math.max(1, Math.floor(rect.width * ratio));
  view.annotationCanvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = view.annotationCanvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = "#ffb36b";
}

function redrawDrawings(view: PaneView, drawings: Stroke[]): void {
  resizeAnnotationCanvas(view);
  const ctx = view.annotationCanvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.clearRect(0, 0, view.annotationCanvas.width, view.annotationCanvas.height);
  for (const stroke of drawings) {
    if (stroke.points.length === 0) {
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(stroke.points[0]!.x, stroke.points[0]!.y);
    if (stroke.points.length === 1) {
      ctx.lineTo(stroke.points[0]!.x + 0.001, stroke.points[0]!.y + 0.001);
    } else {
      for (const point of stroke.points.slice(1)) {
        ctx.lineTo(point.x, point.y);
      }
    }
    ctx.stroke();
  }
}

function createButton(label: string, className: string, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `control-button ${className}`;
  button.disabled = disabled;
  button.textContent = label;
  return button;
}

function createLucideIcon(name: "pen-line" | "rotate-cw"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `lucide lucide-${name}`);
  svg.setAttribute("fill", "none");
  svg.setAttribute("height", "22");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  const pathsByIcon: Record<typeof name, string[]> = {
    "pen-line": [
      "M12 20h9",
      "M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z",
    ],
    "rotate-cw": [
      "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1.06 6.63 2.92",
      "M21 3v6h-6",
    ],
  };
  for (const pathData of pathsByIcon[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
  }
  return svg;
}

function createIconButton(iconName: "pen-line" | "rotate-cw", accessibleLabel: string, className: string, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `control-button icon-button ${className}`;
  button.disabled = disabled;
  button.setAttribute("aria-label", accessibleLabel);
  button.title = accessibleLabel;
  button.appendChild(createLucideIcon(iconName));
  return button;
}

function setPaneChromeMetrics(view: PaneView): void {
  const rect = view.rootEl.getBoundingClientRect();
  const paneNumberSize = Math.max(1, Math.min(rect.width, rect.height) / 4);
  view.rootEl.style.setProperty("--pane-number-size", `${paneNumberSize}px`);
}

function setAllPaneChromeMetrics(): void {
  for (const view of paneViews.values()) {
    setPaneChromeMetrics(view);
  }
}

function blockInteractionWhileAnnotating(view: PaneView, event: Event): void {
  if (!paneStateFor(view)?.annotationBorderVisible) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

function bindDrawing(view: PaneView): void {
  let activeStroke: Stroke | null = null;
  const canvas = view.annotationCanvas;
  const pointFromEvent = (event: PointerEvent): Stroke["points"][number] => {
    const rect = canvas.getBoundingClientRect();
    return {
      pressure: event.pressure > 0 ? event.pressure : undefined,
      timestamp: Date.now(),
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  canvas.addEventListener(
    "wheel",
    (event) => {
      blockInteractionWhileAnnotating(view, event);
    },
    { passive: false },
  );
  view.annotationShield.addEventListener(
    "wheel",
    (event) => {
      blockInteractionWhileAnnotating(view, event);
    },
    { passive: false },
  );
  view.annotationShield.addEventListener(
    "touchmove",
    (event) => {
      blockInteractionWhileAnnotating(view, event);
    },
    { passive: false },
  );

  canvas.addEventListener("pointerdown", (event) => {
    rememberPaneContext(view.paneId);
    const paneState = paneStateFor(view);
    if (!paneState?.annotationBorderVisible || event.button !== 0) {
      return;
    }
    activeStroke = {
      points: [pointFromEvent(event)],
      strokeId: `stroke_${crypto.getRandomValues(new Uint32Array(3)).join("")}`,
      tool: event.pointerType === "pen" ? "pencil" : event.pointerType === "touch" ? "finger" : "mouse",
    };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!activeStroke) {
      return;
    }
    activeStroke.points.push(pointFromEvent(event));
    redrawDrawings(view, [...(paneStateFor(view)?.drawings ?? []), activeStroke]);
    event.preventDefault();
  });

  const finishStroke = (event: PointerEvent) => {
    if (!activeStroke) {
      return;
    }
    const stroke = activeStroke;
    activeStroke = null;
    if (stroke.points.length > 0) {
      window.surfAce.command({
        paneId: view.paneId,
        stroke,
        type: "draw-stroke",
      });
    }
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    const pane = paneStateFor(view);
    redrawDrawings(view, pane?.drawings ?? []);
    event.preventDefault();
  };

  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
}

function attachCommonEvents(view: PaneView): void {
  view.rootEl.addEventListener("pointerdown", () => {
    rememberPaneContext(view.paneId);
  });
  view.scrollEl.addEventListener("scroll", () => {
    reportPaneSnapshot(view);
    view.currentScrollHandler?.();
    window.surfAce.command({
      paneId: view.paneId,
      type: "scroll",
      viewport: currentViewport(view),
      visibleText: currentVisibleText(view),
    });
  });
  view.scrollEl.addEventListener("mouseup", () => {
    const selection = currentSelectionWithin(view);
    if (selection) {
      window.surfAce.command({
        paneId: view.paneId,
        selection,
        type: "selection",
      });
    }
    reportPaneSnapshot(view);
  });
}

function ensurePaneView(paneId: number): PaneView {
  const existing = paneViews.get(paneId);
  if (existing) {
    return existing;
  }
  rendererDiagnostic("pane_view_create", {
    paneId,
  });
  const rootEl = document.createElement("div");
  rootEl.className = "pane-shell";
  const scrollEl = document.createElement("div");
  scrollEl.className = "pane-scroll";
  const contentEl = document.createElement("div");
  contentEl.className = "pane-content";
  scrollEl.appendChild(contentEl);
  const shieldEl = document.createElement("div");
  shieldEl.className = "annotation-shield";
  const labelEl = document.createElement("div");
  labelEl.className = "pane-label";
  surfAceOverlay(labelEl, "pane-label");
  const windowLabelEl = document.createElement("span");
  windowLabelEl.className = "pane-label__window";
  const provenanceLabelEl = document.createElement("span");
  provenanceLabelEl.className = "pane-label__sender";
  const labelTextEl = document.createElement("span");
  labelTextEl.className = "pane-label__number";
  labelEl.append(provenanceLabelEl, windowLabelEl, labelTextEl);
  const focusOverlayEl = document.createElement("div");
  focusOverlayEl.className = "keyboard-focus-overlay";
  for (const edge of ["top", "right", "bottom", "left"]) {
    const edgeEl = document.createElement("div");
    edgeEl.className = `keyboard-focus-edge keyboard-focus-edge--${edge}`;
    surfAceOverlay(edgeEl, "keyboard-focus-edge");
    focusOverlayEl.appendChild(edgeEl);
  }
  const canvas = document.createElement("canvas");
  canvas.className = "annotation-layer";
  const controlsEl = document.createElement("div");
  controlsEl.className = "control-cluster";
  surfAceOverlay(controlsEl, "pane-handle");
  const toastEl = document.createElement("div");
  toastEl.className = "pane-toast";
  toastEl.hidden = true;

  rootEl.append(scrollEl, shieldEl, canvas, focusOverlayEl, labelEl, controlsEl, toastEl);

  const view: PaneView = {
    annotationCanvas: canvas,
    annotationShield: shieldEl,
    contentEl,
    controlsEl,
    currentContentKey: "",
    currentDrawingsKey: "",
    currentHtmlFrameCleanup: null,
    currentRenderToken: 0,
    currentScrollHandler: null,
    currentWebViewResizeObserver: null,
    lastNavigation: null,
    paneId,
    rootEl,
    scrollEl,
    toastTimeout: null,
  };
  bindDrawing(view);
  attachCommonEvents(view);
  paneViews.set(paneId, view);
  return view;
}

function setToast(view: PaneView, message: string | null): void {
  const toast = view.rootEl.querySelector(".pane-toast") as HTMLDivElement;
  if (!message) {
    toast.hidden = true;
    if (view.toastTimeout) {
      window.clearTimeout(view.toastTimeout);
      view.toastTimeout = null;
    }
    return;
  }
  toast.hidden = false;
  toast.textContent = message;
  if (view.toastTimeout) {
    window.clearTimeout(view.toastTimeout);
  }
  view.toastTimeout = window.setTimeout(() => {
    window.surfAce.clearToast(view.paneId);
    view.toastTimeout = null;
  }, 2200);
}

function buildControls(view: PaneView, pane: RendererPaneState): void {
  view.controlsEl.replaceChildren();
  const hasPushedContent = pane.content.contentId !== null;
  if (hasPushedContent || pane.canGoBack || pane.canGoForward || pane.content.reloadable) {
    const navigationPill = document.createElement("div");
    navigationPill.className = "control-pill navigation-pill";
    if (pane.content.reloadable && !pane.showDone) {
      const reload = surfAceOverlay(createIconButton("rotate-cw", "Reload", "reload"), "reload");
      reload.addEventListener("click", () => {
        rememberPaneContext(pane.paneId);
        if (isBrowserUrlPane(pane)) {
          const browserView = currentPaneFrameElement(view) as BrowserUrlWebViewElement | null;
          browserView?.reload?.();
        } else {
          window.surfAce.command({ paneId: pane.paneId, type: "reload" });
        }
      });
      navigationPill.appendChild(reload);
    }
    if (pane.canGoBack) {
      const back = surfAceOverlay(createButton("◀", "back"), "history-back");
      back.addEventListener("click", () => {
        rememberPaneContext(pane.paneId);
        window.surfAce.command({ direction: "back", paneId: pane.paneId, type: "history" });
      });
      navigationPill.appendChild(back);
    }
    if (pane.canGoForward) {
      const forward = surfAceOverlay(createButton("▶", "forward"), "history-forward");
      forward.addEventListener("click", () => {
        rememberPaneContext(pane.paneId);
        window.surfAce.command({ direction: "forward", paneId: pane.paneId, type: "history" });
      });
      navigationPill.appendChild(forward);
    }
    const navigationOwnerName = pane.provenanceName;
    if (navigationOwnerName) {
      const ownerName = document.createElement("span");
      ownerName.className = "navigation-pill__owner";
      ownerName.textContent = navigationOwnerName;
      navigationPill.appendChild(ownerName);
    }
    if (navigationPill.childElementCount > 0) {
      view.controlsEl.appendChild(navigationPill);
    }
  }
  const annotationPill = document.createElement("div");
  annotationPill.className = "control-pill annotation-pill";
  const annotate = surfAceOverlay(createIconButton("pen-line", "Sketch", "annotate"), "annotation-control");
  annotate.addEventListener("click", () => {
    rememberPaneContext(pane.paneId);
    window.surfAce.command({ enabled: true, paneId: pane.paneId, type: "annotate" });
  });
  annotate.classList.toggle("active", pane.showDone);
  annotationPill.appendChild(annotate);

  if (pane.showDone) {
    const done = surfAceOverlay(createButton("Done", "done"), "annotation-control");
    done.addEventListener("click", () => {
      rememberPaneContext(pane.paneId);
      window.surfAce.command({ enabled: false, paneId: pane.paneId, type: "annotate" });
    });
    annotationPill.appendChild(done);
  }
  view.controlsEl.appendChild(annotationPill);
}

function sendNavigationIntent(view: PaneView, paneId: number, url: string): void {
  if (!url) {
    return;
  }
  const now = Date.now();
  if (view.lastNavigation && view.lastNavigation.url === url && now - view.lastNavigation.at < 300) {
    return;
  }
  view.lastNavigation = { at: now, url };
  window.surfAce.command({ paneId, type: "navigation", url });
}

function clearWebViewSizer(view: PaneView): void {
  view.currentWebViewResizeObserver?.disconnect();
  view.currentWebViewResizeObserver = null;
}

function currentPaneFrameElement(view: PaneView): HTMLElement | null {
  return view.contentEl.querySelector<HTMLElement>(".content-html-frame");
}

function isKeyboardScrollIntent(intent: unknown): intent is KeyboardScrollIntent {
  if (!intent || typeof intent !== "object") {
    return false;
  }
  const candidate = intent as Partial<KeyboardScrollIntent>;
  return (
    candidate.type === "scroll" &&
    typeof candidate.paneId === "number" &&
    (candidate.amount === "line" || candidate.amount === "page") &&
    (candidate.direction === "down" ||
      candidate.direction === "left" ||
      candidate.direction === "right" ||
      candidate.direction === "up")
  );
}

function keyboardScrollDelta(view: PaneView, intent: KeyboardScrollIntent): { left: number; top: number } {
  const lineDistance = 64;
  const pageDistance = Math.max(1, Math.floor(
    (intent.direction === "left" || intent.direction === "right"
      ? view.scrollEl.clientWidth
      : view.scrollEl.clientHeight) * 0.85,
  ));
  const distance = intent.amount === "page" ? pageDistance : lineDistance;
  switch (intent.direction) {
    case "left":
      return { left: -distance, top: 0 };
    case "right":
      return { left: distance, top: 0 };
    case "up":
      return { left: 0, top: -distance };
    case "down":
      return { left: 0, top: distance };
  }
}

function isViewport(value: unknown): value is Viewport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const viewport = value as Partial<Viewport>;
  return (
    typeof viewport.zoomLevel === "number" &&
    isRectSize(viewport.contentSize) &&
    isPoint(viewport.scrollOffset) &&
    isViewportRect(viewport.visibleRect)
  );
}

function isRectSize(value: unknown): value is { height: number; width: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const size = value as { height?: unknown; width?: unknown };
  return typeof size.height === "number" && typeof size.width === "number";
}

function isPoint(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const point = value as { x?: unknown; y?: unknown };
  return typeof point.x === "number" && typeof point.y === "number";
}

function isViewportRect(value: unknown): value is { height: number; width: number; x: number; y: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rect = value as { height?: unknown; width?: unknown; x?: unknown; y?: unknown };
  return (
    typeof rect.height === "number" &&
    typeof rect.width === "number" &&
    typeof rect.x === "number" &&
    typeof rect.y === "number"
  );
}

function isBrowserUrlKeyboardScrollResult(value: unknown): value is BrowserUrlKeyboardScrollResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<BrowserUrlKeyboardScrollResult>;
  return isViewport(result.viewport) && typeof result.visibleText === "string";
}

function reportBrowserUrlKeyboardScroll(view: PaneView, result: BrowserUrlKeyboardScrollResult): void {
  window.surfAce.command({
    paneId: view.paneId,
    type: "scroll",
    viewport: result.viewport,
    visibleText: result.visibleText,
  });
  window.surfAce.reportSnapshot({
    bounds: paneBounds(view),
    paneId: view.paneId,
    selection: null,
    viewport: result.viewport,
    visibleText: result.visibleText,
  });
}

function scrollPaneByKeyboard(intent: KeyboardScrollIntent): void {
  const view = paneViews.get(intent.paneId);
  if (!view) {
    return;
  }
  if (paneStateFor(view)?.annotationBorderVisible) {
    return;
  }
  rememberPaneContext(intent.paneId);
  const delta = keyboardScrollDelta(view, intent);
  const frame = currentPaneFrameElement(view);
  if (frame?.matches("webview.content-browser-url-frame")) {
    const webview = frame as BrowserUrlWebViewElement;
    const scrollPromise = webview.executeJavaScript?.(
      `(() => {
        window.scrollBy({ left: ${JSON.stringify(delta.left)}, top: ${JSON.stringify(delta.top)}, behavior: "auto" });
        const root = document.documentElement;
        const body = document.body;
        const contentHeight = Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0);
        const contentWidth = Math.max(root?.scrollWidth ?? 0, body?.scrollWidth ?? 0);
        const visibleText = (body?.innerText ?? root?.innerText ?? "").slice(0, 4000);
        return {
          viewport: {
            contentSize: { height: contentHeight, width: contentWidth },
            scrollOffset: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
            visibleRect: {
              height: Math.round(window.innerHeight),
              width: Math.round(window.innerWidth),
              x: Math.round(window.scrollX),
              y: Math.round(window.scrollY)
            },
            zoomLevel: window.visualViewport?.scale ?? 1
          },
          visibleText
        };
      })()`,
    );
    void scrollPromise
      ?.then((result) => {
        if (!webview.isConnected || currentPaneFrameElement(view) !== webview) {
          return;
        }
        if (isBrowserUrlKeyboardScrollResult(result)) {
          reportBrowserUrlKeyboardScroll(view, result);
          return;
        }
        reportPaneSnapshot(view);
      })
      .catch(() => {});
    return;
  }
  view.scrollEl.scrollBy({ behavior: "auto", left: delta.left, top: delta.top });
}

function paneFrameRect(view: PaneView): { height: number; width: number } | null {
  if (!view.rootEl.isConnected) {
    return null;
  }
  const rootRect = view.rootEl.getBoundingClientRect();
  const scrollRect = view.scrollEl.getBoundingClientRect();
  const width = scrollRect.width > 0 ? scrollRect.width : rootRect.width;
  const height = scrollRect.height > 0 ? scrollRect.height : rootRect.height;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { height, width };
}

function applyPaneFrameSize(view: PaneView, element: HTMLElement): boolean {
  const rect = paneFrameRect(view);
  if (!rect) {
    return false;
  }
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  view.contentEl.style.height = `${height}px`;
  view.contentEl.style.minHeight = `${height}px`;
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  if (element.matches("webview.content-browser-url-frame")) {
    element.setAttribute("autosize", "on");
    element.setAttribute("minwidth", String(width));
    element.setAttribute("minheight", String(height));
    element.setAttribute("maxwidth", String(width));
    element.setAttribute("maxheight", String(height));
  }
  return true;
}

function schedulePaneFrameSizeRefresh(view: PaneView, element: HTMLElement): void {
  const refresh = () => {
    if (!element.isConnected || currentPaneFrameElement(view) !== element) {
      return;
    }
    applyPaneFrameSize(view, element);
  };
  window.requestAnimationFrame(refresh);
  window.setTimeout(refresh, 50);
  window.setTimeout(refresh, 200);
}

function sizeWebViewToPane(view: PaneView, element: HTMLElement): void {
  clearWebViewSizer(view);

  applyPaneFrameSize(view, element);
  const observer = new ResizeObserver(() => {
    applyPaneFrameSize(view, element);
    if (element.matches("webview.content-browser-url-frame")) {
      reportBrowserUrlDiagnostics(view, element as BrowserUrlWebViewElement, "resize");
    }
  });
  observer.observe(view.rootEl);
  observer.observe(view.scrollEl);
  view.currentWebViewResizeObserver = observer;
  schedulePaneFrameSizeRefresh(view, element);
}

function rectDiagnostics(rect: DOMRect): Record<string, number> {
  return {
    bottom: Math.round(rect.bottom),
    height: Math.round(rect.height),
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    x: Math.round(rect.x),
    y: Math.round(rect.y),
  };
}

function elementDiagnostics(element: HTMLElement): Record<string, unknown> {
  const style = window.getComputedStyle(element);
  return {
    boundingRect: rectDiagnostics(element.getBoundingClientRect()),
    client: { height: element.clientHeight, width: element.clientWidth },
    computed: {
      display: style.display,
      height: style.height,
      inset: style.inset,
      maxHeight: style.maxHeight,
      maxWidth: style.maxWidth,
      minHeight: style.minHeight,
      minWidth: style.minWidth,
      overflow: style.overflow,
      position: style.position,
      transform: style.transform,
      width: style.width,
    },
    offset: { height: element.offsetHeight, width: element.offsetWidth },
    scroll: { height: element.scrollHeight, width: element.scrollWidth, x: element.scrollLeft, y: element.scrollTop },
  };
}

async function browserUrlGuestDiagnostics(webview: BrowserUrlWebViewElement): Promise<unknown> {
  if (!webview.executeJavaScript) {
    return null;
  }
  try {
    return await webview.executeJavaScript(`(() => {
      const root = document.documentElement;
      const body = document.body;
      const bodyRect = body ? body.getBoundingClientRect() : null;
      return {
        bodyRect: bodyRect ? {
          height: Math.round(bodyRect.height),
          width: Math.round(bodyRect.width),
          x: Math.round(bodyRect.x),
          y: Math.round(bodyRect.y)
        } : null,
        devicePixelRatio: window.devicePixelRatio,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        location: window.location.href,
        rootClientHeight: root ? root.clientHeight : null,
        rootClientWidth: root ? root.clientWidth : null,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        rootScrollHeight: root ? root.scrollHeight : null,
        rootScrollWidth: root ? root.scrollWidth : null,
        visualViewport: window.visualViewport ? {
          height: Math.round(window.visualViewport.height),
          scale: window.visualViewport.scale,
          width: Math.round(window.visualViewport.width)
        } : null
      };
    })()`);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function resetBrowserUrlGuestScroll(webview: BrowserUrlWebViewElement): Promise<void> {
  if (!webview.executeJavaScript) {
    return;
  }
  try {
    await webview.executeJavaScript(`(() => {
      if ("scrollRestoration" in window.history) {
        window.history.scrollRestoration = "manual";
      }
      window.scrollTo(0, 0);
      document.documentElement?.scrollTo?.(0, 0);
      document.body?.scrollTo?.(0, 0);
    })()`);
  } catch {
    // Guest scripting can reject during navigation churn; viewport verification still reports diagnostics.
  }
}

function isBrowserUrlGuestMetrics(value: unknown): value is BrowserUrlGuestMetrics {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metrics = value as Partial<BrowserUrlGuestMetrics>;
  return typeof metrics.innerHeight === "number" && typeof metrics.innerWidth === "number";
}

function browserUrlWebContentsId(webview: BrowserUrlWebViewElement): number | null {
  try {
    return webview.getWebContentsId?.() ?? null;
  } catch {
    return null;
  }
}

function browserUrlViewportMismatch(
  webview: BrowserUrlWebViewElement,
  guest: unknown,
): Record<string, number | string> | null {
  if (!isBrowserUrlGuestMetrics(guest)) {
    return null;
  }
  const hostHeight = webview.clientHeight || Math.round(webview.getBoundingClientRect().height);
  const hostWidth = webview.clientWidth || Math.round(webview.getBoundingClientRect().width);
  const tolerance = 2;
  if (hostHeight <= 0 || hostWidth <= 0) {
    return null;
  }
  const heightDelta = Math.abs(guest.innerHeight - hostHeight);
  const widthDelta = Math.abs(guest.innerWidth - hostWidth);
  if (heightDelta <= tolerance && widthDelta <= tolerance) {
    return null;
  }
  return {
    guestHeight: guest.innerHeight,
    guestWidth: guest.innerWidth,
    heightDelta,
    hostHeight,
    hostWidth,
    tolerance,
    widthDelta,
  };
}

function nudgeBrowserUrlWebViewResize(view: PaneView, webview: BrowserUrlWebViewElement): void {
  const rect = paneFrameRect(view);
  if (!rect) {
    return;
  }
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  webview.style.display = "flex";
  webview.style.width = `${Math.max(1, width - 1)}px`;
  webview.style.height = `${Math.max(1, height - 1)}px`;
  void webview.offsetHeight;
  applyPaneFrameSize(view, webview);
}

async function verifyBrowserUrlGuestViewport(
  view: PaneView,
  webview: BrowserUrlWebViewElement,
  reason: BrowserUrlDiagnosticReason,
): Promise<{ guest: unknown; mismatch: Record<string, number | string> | null }> {
  const delays = [0, 50, 150, 300, 600];
  let guest: unknown = null;
  let mismatch: Record<string, number | string> | null = null;
  for (const delay of delays) {
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, delay);
      });
    }
    if (!webview.isConnected || currentPaneFrameElement(view) !== webview) {
      return { guest, mismatch: null };
    }
    applyPaneFrameSize(view, webview);
    guest = await browserUrlGuestDiagnostics(webview);
    mismatch = browserUrlViewportMismatch(webview, guest);
    reportBrowserUrlDiagnostics(view, webview, delay === 0 ? reason : "guest-viewport-retry", guest, mismatch);
    if (!mismatch) {
      return { guest, mismatch: null };
    }
    nudgeBrowserUrlWebViewResize(view, webview);
  }
  return { guest, mismatch };
}

function reportBrowserUrlDiagnostics(
  view: PaneView,
  webview: BrowserUrlWebViewElement,
  reason: BrowserUrlDiagnosticReason,
  guest?: unknown,
  viewportMismatch?: Record<string, number | string> | null,
): void {
  if (!webview.isConnected || currentPaneFrameElement(view) !== webview) {
    return;
  }
  const payload = {
    attributes: {
      autosize: webview.getAttribute("autosize"),
      maxheight: webview.getAttribute("maxheight"),
      maxwidth: webview.getAttribute("maxwidth"),
      minheight: webview.getAttribute("minheight"),
      minwidth: webview.getAttribute("minwidth"),
    },
    content: elementDiagnostics(view.contentEl),
    devicePixelRatio: window.devicePixelRatio,
    inner: { height: window.innerHeight, width: window.innerWidth },
    pane: elementDiagnostics(view.rootEl),
    paneId: view.paneId,
    reason,
    scroll: elementDiagnostics(view.scrollEl),
    type: "browser-url-diagnostics",
    visualViewport: window.visualViewport
      ? {
          height: Math.round(window.visualViewport.height),
          scale: window.visualViewport.scale,
          width: Math.round(window.visualViewport.width),
        }
      : null,
    webContentsId: browserUrlWebContentsId(webview),
    webview: elementDiagnostics(webview),
    ...(guest === undefined ? {} : { guest }),
    ...(viewportMismatch ? { viewportMismatch } : {}),
  };
  window.surfAce.command(payload);
  if (reason === "dom-ready" || reason === "did-finish-load") {
    void browserUrlGuestDiagnostics(webview).then((guest) => {
      if (!webview.isConnected || currentPaneFrameElement(view) !== webview) {
        return;
      }
      const mismatch = browserUrlViewportMismatch(webview, guest);
      window.surfAce.command({
        ...payload,
        guest,
        ...(mismatch ? { viewportMismatch: mismatch } : {}),
        reason: `${reason}:guest`,
      });
    });
  }
}

function refreshDynamicPaneFrames(): void {
  if (!latestState) {
    return;
  }
  for (const pane of latestState.panes) {
    const view = paneViews.get(pane.paneId);
    if (!view?.rootEl.isConnected) {
      continue;
    }
    const frame = currentPaneFrameElement(view);
    if (frame) {
      applyPaneFrameSize(view, frame);
      reportPaneSnapshot(view);
    }
  }
}

function deferUntilPaneFrameReady(
  view: PaneView,
  element: HTMLElement,
  renderToken: number,
  callback: () => void,
): void {
  let attempts = 0;
  const tick = () => {
    if (renderToken !== view.currentRenderToken || currentPaneFrameElement(view) !== element) {
      return;
    }
    if (applyPaneFrameSize(view, element) || attempts >= 12) {
      callback();
      return;
    }
    attempts += 1;
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

function htmlDocumentForBrowser(html: HtmlContent): string {
  const isFullDocument = /^\s*<!doctype\s+html/i.test(html.html) || /^\s*<html[\s>]/i.test(html.html);
  if (isFullDocument) {
    return html.html;
  }
  return `<!doctype html><html><head>${
    html.baseUrl ? `<base href="${html.baseUrl}">` : ""
  }<style>html,body{margin:0;padding:0;font-family:"Avenir Next","Segoe UI",sans-serif;background:#fff;color:#111;}</style></head><body>${html.html}</body></html>`;
}

function htmlDocumentDataUrl(html: HtmlContent): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(htmlDocumentForBrowser(html))}`;
}

function wireBrowserContentEvents(view: PaneView, paneId: number, webview: BrowserUrlWebViewElement): void {
  const onIpcMessage = (event: Event) => {
    const message = event as BrowserContentIpcEvent;
    if (message.channel !== "surf-ace-content") {
      return;
    }
    const payload = message.args?.[0] as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }
    if (payload.type === "scroll") {
      window.surfAce.command({
        paneId,
        type: "scroll",
        viewport: payload.viewport,
        visibleText: payload.visibleText,
      });
      window.surfAce.reportSnapshot({
        bounds: paneBounds(view),
        paneId,
        selection: null,
        viewport: payload.viewport,
        visibleText: payload.visibleText,
      });
    } else if (payload.type === "selection") {
      window.surfAce.command({
        paneId,
        selection: payload.selection ?? null,
        type: "selection",
      });
    } else if (payload.type === "tap") {
      window.surfAce.command({
        kind: payload.kind,
        nearestContent: payload.nearestContent,
        paneId,
        position: payload.position,
        type: "tap",
      });
    } else if (payload.type === "focus") {
      rememberPaneContext(paneId);
    } else if (payload.type === "navigation") {
      sendNavigationIntent(view, paneId, String(payload.url ?? ""));
    } else if (payload.type === "ready") {
      window.surfAce.reportSnapshot({
        bounds: paneBounds(view),
        paneId,
        selection: null,
        viewport: payload.viewport,
        visibleText: payload.visibleText,
      });
    }
  };

  webview.addEventListener("ipc-message", onIpcMessage);
  view.currentHtmlFrameCleanup = () => {
    webview.removeEventListener("ipc-message", onIpcMessage);
  };
}

function renderCenteredState(view: PaneView, title: string, detail?: string): void {
  const empty = document.createElement("div");
  empty.className = "content-empty";
  const titleEl = document.createElement("strong");
  titleEl.textContent = title;
  empty.appendChild(titleEl);
  if (detail) {
    const detailEl = document.createElement("p");
    detailEl.textContent = detail;
    empty.appendChild(detailEl);
  }
  view.contentEl.appendChild(empty);
  reportPaneSnapshot(view);
}

function base64ToBytes(value: string): Uint8Array {
  const decoded = window.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

async function loadPdfJs(): Promise<PdfJsModule> {
  pdfJsModulePromise ??= import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfJsModule>;
  return pdfJsModulePromise;
}

function visiblePdfPageReport(view: PaneView, paneId: number, totalPages: number, force = false): void {
  const pageEl = currentVisiblePdfPage(view);
  if (!pageEl) {
    return;
  }
  const page = Number(pageEl.dataset.pageNumber ?? "1");
  const reportKey = `${page}/${totalPages}`;
  if (!force && view.rootEl.dataset.pdfReportKey === reportKey) {
    return;
  }
  view.rootEl.dataset.pdfReportKey = reportKey;
  window.surfAce.reportPage({
    page,
    pageText: pageEl.dataset.pageText || undefined,
    paneId,
    totalPages,
  });
}

async function renderPdfContent(view: PaneView, pane: RendererPaneState, token: number): Promise<void> {
  const container = document.createElement("div");
  container.className = "content-pdf-stack";
  view.contentEl.appendChild(container);

  try {
    const pdfJs = await loadPdfJs();
    if (token !== view.currentRenderToken) {
      return;
    }
    const documentProxy = await pdfJs.getDocument({
      data: base64ToBytes((pane.content.content as PdfContent).data),
      disableWorker: true,
    }).promise;
    if (token !== view.currentRenderToken) {
      return;
    }

    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      const page = await documentProxy.getPage(pageNumber);
      if (token !== view.currentRenderToken) {
        return;
      }

      const viewport = page.getViewport({ scale: 1.5 });
      const pageEl = document.createElement("section");
      pageEl.className = "content-pdf-page";
      pageEl.dataset.pageNumber = String(pageNumber);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) {
        continue;
      }
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      pageEl.appendChild(canvas);
      container.appendChild(pageEl);

      await page.render({ canvasContext: context, viewport }).promise;
      const textContent = await page.getTextContent();
      pageEl.dataset.pageText = textContent.items
        .map((item) => item.str ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4096);
    }

    if (token !== view.currentRenderToken) {
      return;
    }

    view.currentScrollHandler = () => {
      visiblePdfPageReport(view, pane.paneId, documentProxy.numPages);
    };
    visiblePdfPageReport(view, pane.paneId, documentProxy.numPages, true);
    reportPaneSnapshot(view);
  } catch {
    if (token !== view.currentRenderToken) {
      return;
    }
    view.contentEl.replaceChildren();
    renderCenteredState(view, "PDF unavailable", "This PDF could not be rendered on Electron.");
  }
}

function resetDynamicContent(view: PaneView): number {
  view.currentRenderToken += 1;
  view.currentHtmlFrameCleanup?.();
  view.currentHtmlFrameCleanup = null;
  clearWebViewSizer(view);
  view.currentScrollHandler = null;
  view.scrollEl.scrollLeft = 0;
  view.scrollEl.scrollTop = 0;
  view.rootEl.dataset.pdfReportKey = "";
  view.contentEl.style.height = "";
  view.contentEl.style.minHeight = "";
  view.contentEl.replaceChildren();
  return view.currentRenderToken;
}

function renderBrowserContent(
  view: PaneView,
  pane: RendererPaneState,
  renderToken: number,
  url: string,
  options?: { allowPopups?: boolean; navigationReport?: { targetId: string | null; url: string }; staticHtmlSourceUrl?: string },
): void {
  rendererDiagnostic("browser_content_create", {
    contentType: pane.content.contentType,
    paneId: pane.paneId,
    urlPrefix: url.slice(0, 80),
  });
  const browserView = document.createElement("webview") as BrowserUrlWebViewElement;
  browserView.className = "content-html-frame content-browser-url-frame";
  if (options?.allowPopups) {
    browserView.setAttribute("allowpopups", "true");
  }
  browserView.setAttribute("preload", window.surfAce.guestPreloadPath);
  wireBrowserContentEvents(view, pane.paneId, browserView);
  view.contentEl.appendChild(browserView);
  sizeWebViewToPane(view, browserView);
  reportBrowserUrlDiagnostics(view, browserView, "pre-navigation");
  let reported = false;
  const reportNavigation = (status: "applied" | "failed", errorMessage?: string) => {
    const navigationReport = options?.navigationReport;
    if (!navigationReport || reported || renderToken !== view.currentRenderToken) {
      return;
    }
    reported = true;
    window.surfAce.command({
      ...(errorMessage ? { errorMessage } : {}),
      paneId: pane.paneId,
      status,
      targetId: navigationReport.targetId,
      type: "browser-url-navigation",
      url: navigationReport.url,
    });
  };
  const blockStaticHtmlNavigation = (event: Event) => {
    if (!options?.staticHtmlSourceUrl) {
      return;
    }
    const navigation = event as BrowserContentNavigationEvent;
    if (navigation.isMainFrame === false) {
      return;
    }
    const nextUrl = String(navigation.url ?? "");
    if (!nextUrl || nextUrl === options.staticHtmlSourceUrl) {
      return;
    }
    event.preventDefault();
    sendNavigationIntent(view, pane.paneId, nextUrl);
    window.setTimeout(() => {
      if (renderToken === view.currentRenderToken && currentPaneFrameElement(view) === browserView) {
        browserView.stop?.();
        browserView.src = options.staticHtmlSourceUrl ?? url;
      }
    }, 0);
  };
  const verifyAndReportNavigation = (reason: BrowserUrlDiagnosticReason) => {
    void resetBrowserUrlGuestScroll(browserView).finally(() => {
      const eventReason = reason === "dom-ready:guest-viewport" ? "dom-ready" : "did-finish-load";
      reportBrowserUrlDiagnostics(view, browserView, eventReason);
      void verifyBrowserUrlGuestViewport(view, browserView, reason).then(({ mismatch }) => {
        if (renderToken !== view.currentRenderToken) {
          return;
        }
        if (mismatch) {
          reportNavigation(
            "failed",
            `webview guest viewport stuck at ${mismatch.guestHeight}x${mismatch.guestWidth} for host ${mismatch.hostHeight}x${mismatch.hostWidth}`,
          );
          return;
        }
        reportNavigation("applied");
        window.setTimeout(() => {
          reportPaneSnapshot(view);
        }, 0);
      });
    });
  };
  browserView.addEventListener(
    "did-attach",
    () => {
      rendererDiagnostic("browser_content_did_attach", {
        paneId: pane.paneId,
        webContentsId: browserUrlWebContentsId(browserView),
      });
      reportBrowserUrlDiagnostics(view, browserView, "did-attach");
    },
  );
  browserView.addEventListener(
    "dom-ready",
    () => {
      rendererDiagnostic("browser_content_dom_ready", {
        paneId: pane.paneId,
        webContentsId: browserUrlWebContentsId(browserView),
      });
      verifyAndReportNavigation("dom-ready:guest-viewport");
    },
  );
  browserView.addEventListener(
    "did-finish-load",
    () => {
      rendererDiagnostic("browser_content_did_finish_load", {
        paneId: pane.paneId,
        webContentsId: browserUrlWebContentsId(browserView),
      });
      verifyAndReportNavigation("did-finish-load:guest-viewport");
    },
    { once: true },
  );
  browserView.addEventListener("will-navigate", blockStaticHtmlNavigation);
  browserView.addEventListener("will-frame-navigate", blockStaticHtmlNavigation);
  browserView.addEventListener(
    "did-fail-load",
    (event) => {
      const failure = event as BrowserUrlWebViewErrorEvent;
      if (failure.isMainFrame === false) {
        return;
      }
      rendererDiagnostic("browser_content_did_fail_load", {
        errorCode: failure.errorDescription ?? "",
        paneId: pane.paneId,
        webContentsId: browserUrlWebContentsId(browserView),
      });
      reportBrowserUrlDiagnostics(view, browserView, "did-fail-load");
      const description = failure.errorDescription ? `: ${failure.errorDescription}` : "";
      reportNavigation("failed", `webview navigation failed${description}`);
    },
    { once: true },
  );
  deferUntilPaneFrameReady(view, browserView, renderToken, () => {
    browserView.src = url;
    rendererDiagnostic("browser_content_navigation_assigned", {
      paneId: pane.paneId,
      webContentsId: browserUrlWebContentsId(browserView),
    });
    reportBrowserUrlDiagnostics(view, browserView, "navigation-assigned");
  });
}

function renderPaneContent(view: PaneView, pane: RendererPaneState): void {
  const key = contentKey(pane);
  if (key === view.currentContentKey) {
    return;
  }

  view.currentContentKey = key;
  const renderToken = resetDynamicContent(view);
  view.contentEl.className = `pane-content type-${pane.content.contentType ?? "empty"}`;
  rendererDiagnostic("pane_content_render", {
    contentType: pane.content.contentType ?? "empty",
    hasContent: pane.content.content !== null,
    paneId: pane.paneId,
    renderVersion: pane.content.renderVersion,
  });

  if (pane.externalNative && (!pane.content.contentType || pane.content.content === null)) {
    reportPaneSnapshot(view);
    return;
  }

  if (!pane.content.contentType || pane.content.content === null) {
    reportPaneSnapshot(view);
    return;
  }

  if (pane.content.contentType === "html") {
    const htmlUrl = htmlDocumentDataUrl(pane.content.content as HtmlContent);
    renderBrowserContent(view, pane, renderToken, htmlUrl, { staticHtmlSourceUrl: htmlUrl });
    return;
  }

  if (pane.content.contentType === "browser_url") {
    const browserUrl = pane.content.content as BrowserUrlContent;
    renderBrowserContent(view, pane, renderToken, browserUrl.url, {
      allowPopups: true,
      navigationReport: {
        targetId: pane.content.contentId,
        url: browserUrl.url,
      },
    });
    return;
  }

  if (pane.content.contentType === "image") {
    const imageContent = pane.content.content as ImageContent;
    const image = document.createElement("img");
    image.className = "content-image";
    image.alt = imageContent.alt ?? "";
    image.src = `data:${imageContent.mediaType};base64,${imageContent.data}`;
    view.contentEl.appendChild(image);
    reportPaneSnapshot(view);
    return;
  }

  if (pane.content.contentType === "pdf") {
    void renderPdfContent(view, pane, renderToken);
    return;
  }

  if (pane.content.contentType === "markdown") {
    const article = document.createElement("article");
    article.className = "content-markdown";
    article.innerHTML = markdownToHtml((pane.content.content as MarkdownContent).markdown);
    view.contentEl.appendChild(article);
    reportPaneSnapshot(view);
    return;
  }

  if (pane.content.contentType === "terminal") {
    const pre = document.createElement("pre");
    pre.className = "content-terminal";
    pre.textContent = (pane.content.content as TerminalContent).lines.join("\n");
    view.contentEl.appendChild(pre);
    reportPaneSnapshot(view);
    return;
  }

  if (pane.content.contentType === "video") {
    renderCenteredState(view, "Video");
    return;
  }

  if (pane.content.contentType === "canvas") {
    renderCenteredState(view, "Canvas");
  }
}

function updatePane(view: PaneView, pane: RendererPaneState): void {
  setPaneChromeMetrics(view);
  view.rootEl.classList.toggle("native-backed", pane.externalNative);
  view.rootEl.classList.toggle("keyboard-active", pane.activeKeyboardPane);
  view.rootEl.classList.toggle("annotating", pane.annotationBorderVisible);
  view.rootEl.classList.toggle("flush-in-flight", pane.flushInFlight);
  view.annotationCanvas.classList.toggle("enabled", pane.annotationBorderVisible);
  view.annotationShield.classList.toggle("enabled", pane.annotationBorderVisible);
  const labelWrap = view.rootEl.querySelector(".pane-label") as HTMLDivElement;
  const windowLabel = labelWrap.querySelector(".pane-label__window") as HTMLSpanElement;
  const provenanceLabel = labelWrap.querySelector(".pane-label__sender") as HTMLSpanElement;
  const label = labelWrap.querySelector(".pane-label__number") as HTMLSpanElement;
  const visibleAddress = pane.displayId || pane.visibleAddress || pane.label;
  const visibleWindowLabel = latestState?.windowLabel ?? "";
  provenanceLabel.textContent = pane.provenanceName ?? "";
  provenanceLabel.hidden = !pane.provenanceName;
  windowLabel.textContent = visibleWindowLabel ? visibleWindowLabel.toUpperCase() : "";
  windowLabel.hidden = !visibleWindowLabel;
  label.textContent = visibleAddress.toUpperCase();
  labelWrap.hidden = !visibleAddress;
  labelWrap.title = [pane.provenanceName, visibleWindowLabel ? `window ${visibleWindowLabel}` : null, visibleAddress ? `pane ${visibleAddress}` : null]
    .filter(Boolean)
    .join(" ");
  labelWrap.setAttribute(
    "aria-label",
    visibleAddress
      ? `Surf Ace${visibleWindowLabel ? ` window ${visibleWindowLabel}` : ""} pane ${visibleAddress}${pane.provenanceName ? ` ${pane.provenanceName}` : ""}`
      : "",
  );
  buildControls(view, pane);
  renderPaneContent(view, pane);

  const nextDrawingsKey = drawingsKey(pane.drawings);
  if (nextDrawingsKey !== view.currentDrawingsKey) {
    view.currentDrawingsKey = nextDrawingsKey;
    redrawDrawings(view, pane.drawings);
  }
  setToast(view, pane.toast);
  reportPaneSnapshot(view);
}

function layoutWeight(node: LayoutNode): number {
  return typeof node.weight === "number" && Number.isFinite(node.weight) && node.weight > 0 ? node.weight : 1;
}

function attachResizeHandle(handle: HTMLElement, split: HTMLElement, node: Extract<LayoutNode, { type: "split" }>, path: number[], index: number): void {
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const start = node.direction === "vertical" ? event.clientX : event.clientY;
    const splitRect = split.getBoundingClientRect();
    const extent = node.direction === "vertical" ? splitRect.width : splitRect.height;
    const weights = node.children.map(layoutWeight);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const before = weights[index] ?? 1;
    const after = weights[index + 1] ?? 1;
    const minWeight = Math.max(0.05, totalWeight * 0.05);
    const onMove = (moveEvent: PointerEvent) => {
      const current = node.direction === "vertical" ? moveEvent.clientX : moveEvent.clientY;
      const deltaWeight = extent > 0 ? ((current - start) / extent) * totalWeight : 0;
      const pairTotal = before + after;
      const nextBefore = Math.min(Math.max(minWeight, before + deltaWeight), Math.max(minWeight, pairTotal - minWeight));
      const nextWeights = [...weights];
      nextWeights[index] = nextBefore;
      nextWeights[index + 1] = Math.max(minWeight, pairTotal - nextBefore);
      window.surfAce.command({ path, type: "resize-split", weights: nextWeights });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      scheduleCompositorOverlayRegionReport("layout");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  });
}

function renderLayout(node: LayoutNode, panesById: Map<number, RendererPaneState>, path: number[] = []): HTMLElement {
  if (node.type === "pane") {
    const pane = panesById.get(node.paneId);
    if (!pane) {
      const fallback = document.createElement("div");
      return fallback;
    }
    const view = ensurePaneView(node.paneId);
    updatePane(view, pane);
    view.rootEl.style.flexGrow = String(layoutWeight(node));
    return view.rootEl;
  }
  const split = document.createElement("div");
  split.className = `layout-split direction-${node.direction}`;
  split.style.flexGrow = String(layoutWeight(node));
  const totalWeight = node.children.reduce((sum, child) => sum + layoutWeight(child), 0);
  let cumulativeWeight = 0;
  for (const [index, child] of node.children.entries()) {
    const childEl = renderLayout(child, panesById, [...path, index]);
    childEl.style.flexGrow = String(layoutWeight(child));
    split.appendChild(childEl);
    cumulativeWeight += layoutWeight(child);
    if (index < node.children.length - 1) {
      const handle = document.createElement("div");
      handle.className = `split-resize-handle split-resize-handle-${node.direction}`;
      const percent = totalWeight > 0 ? (cumulativeWeight / totalWeight) * 100 : 0;
      if (node.direction === "vertical") {
        handle.style.left = `${percent}%`;
      } else {
        handle.style.top = `${percent}%`;
      }
      attachResizeHandle(handle, split, node, path, index);
      split.appendChild(handle);
    }
  }
  return split;
}

function layoutKey(state: RendererWindowState): string {
  return JSON.stringify(state.layout);
}

function patchSameLayoutWindow(previousState: RendererWindowState, state: RendererWindowState): boolean {
  const wrapper = appRoot.firstElementChild as HTMLDivElement | null;
  if (!wrapper?.classList.contains("surface-window")) {
    return false;
  }
  const nextLayoutKey = layoutKey(state);
  if (latestLayoutKey !== nextLayoutKey) {
    return false;
  }

  wrapper.className = `surface-window connection-${state.connectionBar}`;
  const previousPanes = new Map(previousState.panes.map((pane) => [pane.paneId, pane]));
  const viewportChanged = JSON.stringify(previousState.viewport) !== JSON.stringify(state.viewport);
  const overlayStateChanged = previousState.geometryRevision !== state.geometryRevision ||
    previousState.topologyRevision !== state.topologyRevision ||
    previousState.windowLabel !== state.windowLabel ||
    viewportChanged;
  let patchedPaneCount = 0;
  for (const pane of state.panes) {
    const previousPane = previousPanes.get(pane.paneId);
    const view = paneViews.get(pane.paneId);
    if (!previousPane || !view?.rootEl.isConnected) {
      return false;
    }
    if (paneRenderKey(previousState, previousPane) !== paneRenderKey(state, pane)) {
      updatePane(view, pane);
      patchedPaneCount += 1;
    }
  }
  if (viewportChanged) {
    setAllPaneChromeMetrics();
    refreshDynamicPaneFrames();
    reportAllPaneSnapshots();
    window.requestAnimationFrame(() => {
      setAllPaneChromeMetrics();
      refreshDynamicPaneFrames();
      reportAllPaneSnapshots();
    });
  }
  if (patchedPaneCount > 0) {
    for (const pane of state.panes) {
      const previousPane = previousPanes.get(pane.paneId);
      const view = paneViews.get(pane.paneId);
      if (previousPane && view && paneRenderKey(previousState, previousPane) !== paneRenderKey(state, pane)) {
        reportPaneSnapshot(view);
      }
    }
  }
  if (patchedPaneCount > 0 || overlayStateChanged) {
    scheduleCompositorOverlayRegionReport("layout");
  }
  return true;
}

function renderWindow(state: RendererWindowState): void {
  rendererDiagnostic("render_window_start", {
    hasAppRoot: Boolean(appRoot),
    hasLayout: Boolean(state.layout),
    paneCount: state.panes.length,
    surfaceId: state.surfaceId,
    windowLabel: state.windowLabel,
  });
  const previousState = latestState;
  if (previousState) {
    latestState = state;
    if (patchSameLayoutWindow(previousState, state)) {
      return;
    }
  }
  latestState = state;
  latestLayoutKey = layoutKey(state);
  const panesById = new Map(state.panes.map((pane) => [pane.paneId, pane]));
  const wrapper = document.createElement("div");
  wrapper.className = `surface-window connection-${state.connectionBar}`;
  const layoutRoot = document.createElement("div");
  layoutRoot.className = "layout-root";
  if (state.layout) {
    layoutRoot.appendChild(renderLayout(state.layout, panesById));
  } else {
  }
  wrapper.append(layoutRoot);
  appRoot.replaceChildren(wrapper);
  rendererDiagnostic("render_window_committed", {
    appChildCount: appRoot.childElementCount,
    contentHostCount: appRoot.querySelectorAll(".pane-content").length,
    paneShellCount: appRoot.querySelectorAll(".pane-shell").length,
    surfaceWindowCount: appRoot.querySelectorAll(".surface-window").length,
    webviewCount: appRoot.querySelectorAll("webview").length,
  });
  setAllPaneChromeMetrics();
  refreshDynamicPaneFrames();
  reportAllPaneSnapshots();
  window.requestAnimationFrame(() => {
    setAllPaneChromeMetrics();
    refreshDynamicPaneFrames();
    reportAllPaneSnapshots();
  });
  scheduleCompositorOverlayRegionReport("layout");
}

async function init(): Promise<void> {
  rendererDiagnostic("bootstrap_start", {
    appRootPresent: Boolean(appRoot),
    bodyChildCount: document.body.childElementCount,
    locationSearch: window.location.search,
  });
  try {
    bootstrap = (await window.surfAce.getBootstrap()) as Bootstrap | null;
    if (!bootstrap?.state) {
      rendererDiagnostic("bootstrap_invalid", {
        bootstrapType: bootstrap === null ? "null" : typeof bootstrap,
      });
      return;
    }
    rendererDiagnostic("bootstrap_received", {
      compositorHosted: Boolean(bootstrap.compositorHosted),
      hasLayout: Boolean(bootstrap.state.layout),
      paneCount: bootstrap.state.panes.length,
      surfaceId: bootstrap.surfaceId,
      windowLabel: bootstrap.state.windowLabel,
    });
    document.documentElement.classList.toggle("compositor-hosted", Boolean(bootstrap.compositorHosted));
    document.body.classList.toggle("compositor-hosted", Boolean(bootstrap.compositorHosted));
    document.body.classList.toggle("overlay-debug-borders", Boolean(bootstrap.overlayDebugBorders));
    latestState = bootstrap.state;
    renderWindow(bootstrap.state);
  } catch (error) {
    rendererDiagnostic("bootstrap_error", errorDiagnosticFields(error));
    throw error;
  }

  window.surfAce.onState((nextState) => {
    renderWindow(nextState as RendererWindowState);
  });

  window.surfAce.onKeyboardIntent((intent) => {
    if (isKeyboardScrollIntent(intent)) {
      scrollPaneByKeyboard(intent);
    }
  });

  window.addEventListener("resize", () => {
    if (!latestState) {
      return;
    }
    for (const pane of latestState.panes) {
      const view = paneViews.get(pane.paneId);
      if (view) {
        redrawDrawings(view, pane.drawings);
        setPaneChromeMetrics(view);
        view.currentScrollHandler?.();
        const frame = currentPaneFrameElement(view);
        if (frame) {
          applyPaneFrameSize(view, frame);
        }
        reportPaneSnapshot(view);
      }
    }
    window.requestAnimationFrame(setAllPaneChromeMetrics);
    scheduleCompositorOverlayRegionReport("resize");
  });

  document.addEventListener("visibilitychange", () => {
    scheduleCompositorOverlayRegionReport("visibility");
  });

  window.addEventListener("pointermove", () => {
    scheduleCompositorOverlayRegionReport("visibility");
  }, { passive: true });
}

void init();
