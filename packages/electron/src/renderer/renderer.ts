import {
  isMarkedOverlayVisible,
  visibleOverlayRect,
} from "./overlay-rects.js";
import { markdownToHtml } from "./markdown.js";
import {
  bindContentScaleControls,
  projectConnectionChrome,
  toggleContentScalePopup,
  visibleWindowLabelText,
} from "./ui-projection.js";

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
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  executeJavaScript?: (code: string) => Promise<unknown>;
  getTitle?: () => string;
  getURL?: () => string;
  goBack?: () => void;
  goForward?: () => void;
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
  errorCode?: number;
  errorDescription?: string;
  isMainFrame?: boolean;
  validatedURL?: string;
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
const BROWSER_URL_DIAGNOSTIC_READBACK_TIMEOUT_MS = 500;
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
  paneLineageId: string;
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
  provenance: {
    controllerProductName: string | null;
    friendlyChatName: string | null;
  } | null;
  visibleAddress: string;
  showDone: boolean;
  toast: string | null;
};

type LayoutNode =
  | { paneId: number; type: "pane"; weight?: number }
  | { children: LayoutNode[]; direction: "horizontal" | "vertical"; type: "split"; weight?: number };

type RendererWindowState = {
  capabilityStatus?: string;
  connectionBar: "connected" | "connecting" | "disconnected";
  connectionError?: string;
  geometryRevision: number;
  layout: LayoutNode | null;
  name: string;
  panes: RendererPaneState[];
  providerName: string | null;
  surfaceId: string;
  surfaceEpoch: string;
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

type ContentScaleIntent = {
  action: "decrease" | "increase" | "reset";
  paneId: number;
  type: "content-scale";
};

type BrowserUrlKeyboardScrollResult = {
  viewport: Viewport;
  visibleText: string;
};

type NavigationMemo = {
  at: number;
  url: string;
};

type DuplicateRepushKind = "HTML" | "URL";

type DuplicateRepushSignature = {
  kind: DuplicateRepushKind;
  value: string;
};

type PaneView = {
  annotationCanvas: HTMLCanvasElement;
  annotationShield: HTMLDivElement;
  contentEl: HTMLElement;
  controlsEl: HTMLDivElement;
  currentContentKey: string;
  currentContentSignature: DuplicateRepushSignature | null;
  currentDrawingsKey: string;
  currentHtmlFrameCleanup: (() => void) | null;
  currentRenderToken: number;
  currentScrollHandler: (() => void) | null;
  currentWebViewResizeObserver: ResizeObserver | null;
  duplicateRepushEl: HTMLDivElement;
  dismissedDuplicateRepushKey: string | null;
  dockEl: HTMLButtonElement;
  lastNavigation: NavigationMemo | null;
  paneId: number;
  slotEl: HTMLDivElement;
  popOutButton: HTMLButtonElement;
  rootEl: HTMLDivElement;
  scale: number;
  scrollEl: HTMLDivElement;
  toolbarCollapsed: boolean;
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
const provenanceAnnouncer = document.querySelector(
  "#provenance-announcer",
) as HTMLDivElement | null;
const paneViews = new Map<number, PaneView>();
let poppedOutPaneId: number | null = null;
const pendingStrokeDelivery = new Map<number, Promise<void>>();
const annotationIntentEpoch = new Map<number, number>();
const pendingHistoryAnnouncements = new Map<number, string>();
const provenanceLabels = new Set<HTMLElement>();
let bootstrap: Bootstrap | null = null;
let latestState: RendererWindowState | null = null;
let latestLayoutKey: string | null = null;
let latestChromeKey: string | null = null;
let overlayRegionsFrame: number | null = null;
const WEB_CONTENT_BASE_SCALE = 0.85;
let openFontSizePaneId: number | null = null;
let overlayRegionsTimer: number | null = null;
let overlayRevision = 0;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

const OVERLAY_CAPTURES: OverlayCapture[] = ["pointer_hover", "pointer_button", "pointer_axis"];
const OVERLAY_MARKER_ATTRIBUTE = "data-surf-ace-overlay";
const PANE_LABEL_EDGE_MARGIN_RATIO = 0.04;
const PANE_LABEL_MAX_EDGE_MARGIN_PX = 24;
const PANE_LABEL_MIN_EDGE_MARGIN_PX = 8;
const PANE_LABEL_MIN_NUMBER_SIZE_PX = 10;
const CONTENT_SCALE_DEFAULT = 1;
const CONTENT_SCALE_MAX = 2.25;
const CONTENT_SCALE_MIN = 0.5;
const CONTENT_SCALE_STEP = 0.1;
type SurfAceOverlayKind =
  | "browser-back"
  | "browser-forward"
  | "annotation-control"
  | "history-back"
  | "history-forward"
  | "pane-label"
  | "pane-handle"
  | "reload"
  | "pane-pop-out"
  | "duplicate-repush-close";

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

function duplicateRepushSignature(pane: RendererPaneState): DuplicateRepushSignature | null {
  if (pane.content.contentType === "browser_url" && pane.content.content && "url" in pane.content.content) {
    return {
      kind: "URL",
      value: String(pane.content.content.url ?? ""),
    };
  }
  if (pane.content.contentType === "html" && pane.content.content && "html" in pane.content.content) {
    const html = pane.content.content as HtmlContent;
    return {
      kind: "HTML",
      value: JSON.stringify({ baseUrl: html.baseUrl ?? null, html: html.html }),
    };
  }
  return null;
}

function isDuplicateRepush(view: PaneView, pane: RendererPaneState, nextSignature: DuplicateRepushSignature | null): boolean {
  if (!nextSignature || !view.currentContentSignature) {
    return false;
  }
  return view.currentContentSignature.kind === nextSignature.kind &&
    view.currentContentSignature.value === nextSignature.value &&
    view.currentContentKey !== contentKey(pane);
}

function paneRenderKey(state: RendererWindowState, pane: RendererPaneState): string {
  return JSON.stringify({
    annotationBorderVisible: pane.annotationBorderVisible,
    canGoBack: pane.canGoBack,
    canGoForward: pane.canGoForward,
    connectionBar: state.connectionBar,
    content: contentKey(pane),
    displayId: pane.displayId,
    drawings: drawingsKey(pane.drawings),
    externalNative: pane.externalNative,
    flushInFlight: pane.flushInFlight,
    label: pane.label,
    name: pane.name,
    ownerName: pane.ownerName,
    provenanceName: pane.provenanceName,
    provenance: pane.provenance,
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

function tiledPaneBounds(view: PaneView) {
  const rect = view.slotEl.getBoundingClientRect();
  return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
}

function paneSnapshotGeometryIdentity(): {
  geometryRevision: number;
  surfaceEpoch: string;
  topologyRevision: number;
} {
  if (!latestState) {
    throw new Error("pane snapshot requires renderer window state");
  }
  return {
    geometryRevision: latestState.geometryRevision,
    surfaceEpoch: latestState.surfaceEpoch,
    topologyRevision: latestState.topologyRevision,
  };
}

function reportSnapshot(payload: Record<string, unknown>): void {
  window.surfAce.reportSnapshot({ ...payload, displayOnly: payload.paneId === poppedOutPaneId });
}

function reportPaneSnapshot(view: PaneView): void {
  if (resizeGesture || resizeCommitPending || panePresentationTransitionsPending > 0 || panePresentationAuthorityBlocked) return; // Provisional geometry must never become an authoritative snapshot.
  const frame = currentPaneFrameElement(view);
  if (frame?.matches("webview.content-browser-url-frame")) {
    reportSnapshot({
      bounds: paneBounds(view),
      ...paneSnapshotGeometryIdentity(),
      paneId: view.paneId,
    });
    return;
  }
  const selection = currentSelectionWithin(view);
  const viewport = currentViewport(view);
  reportSnapshot({
    bounds: paneBounds(view),
    ...paneSnapshotGeometryIdentity(),
    paneId: view.paneId,
    selection,
    viewport,
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
    case "browser-back":
    case "browser-forward":
      return { captures: OVERLAY_CAPTURES, kind: "other", suffix: marker, zIndex: 20 };
    case "history-back":
      return { captures: OVERLAY_CAPTURES, kind: "history_back", suffix: marker, zIndex: 20 };
    case "history-forward":
      return { captures: OVERLAY_CAPTURES, kind: "history_forward", suffix: marker, zIndex: 20 };
    case "reload":
      return { captures: OVERLAY_CAPTURES, kind: "other", suffix: marker, zIndex: 20 };
    case "duplicate-repush-close":
      return { captures: OVERLAY_CAPTURES, kind: "other", suffix: marker, zIndex: 30 };
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
    if (panePresentationResizePending && view.paneId === poppedOutPaneId && marker !== "pane-pop-out") return [];
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
  if (resizeGesture || resizeCommitPending || panePresentationTransitionsPending > 0 || panePresentationAuthorityBlocked) return;
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
    if (view && (poppedOutPaneId === null || pane.paneId === poppedOutPaneId)) {
      regions.push(...collectMarkedOverlayRegions(pane, view).map((region) => ({
        ...region,
        zIndex: (region.zIndex ?? 0) + (poppedOutPaneId === null ? 0 : 100),
      })));
    }
  }
  window.surfAce.reportOverlayRegions({
    coordinateSpace: "surface_logical",
    regions,
    revision: latestState.geometryRevision,
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
  const labelEl = document.createElement("span");
  labelEl.className = "control-button__label";
  labelEl.textContent = label;
  button.appendChild(labelEl);
  return button;
}

type ProvenanceStrings = {
  pushedBy: (chat: string, provider: string) => string;
  unknownChat: string;
  unknownProvider: string;
};

type ResolvedProvenance = {
  accessibleName: string;
  chat: string;
  provider: string;
};

const PROVENANCE_WIDTH_CLASSES = [
  "navigation-pill__provenance--composite",
  "navigation-pill__provenance--collapsed",
  "navigation-pill__provenance--zero-width",
] as const;

const BIDI_ISOLATE_START = "\u2068";
const BIDI_ISOLATE_END = "\u2069";
let provenanceResizeObserver: ResizeObserver | null = null;
let provenanceMetricObserversInstalled = false;
let observedProvenanceLanguage = "";

function activeProvenanceLanguage(): string {
  return (
    document.documentElement.lang ||
    globalThis.navigator?.language ||
    "en"
  ).toLowerCase();
}

function provenanceStrings(): ProvenanceStrings {
  const language = activeProvenanceLanguage();
  if (language.startsWith("es")) {
    return {
      pushedBy: (chat, provider) =>
        `Enviado por ${chat}, usando ${provider}`,
      unknownChat: "Chat desconocido",
      unknownProvider: "Proveedor desconocido",
    };
  }
  if (language.startsWith("fr")) {
    return {
      pushedBy: (chat, provider) =>
        `Envoyé par ${chat}, avec ${provider}`,
      unknownChat: "Discussion inconnue",
      unknownProvider: "Fournisseur inconnu",
    };
  }
  if (language.startsWith("de")) {
    return {
      pushedBy: (chat, provider) =>
        `Gesendet von ${chat}, mit ${provider}`,
      unknownChat: "Unbekannter Chat",
      unknownProvider: "Unbekannter Anbieter",
    };
  }
  if (language.startsWith("ja")) {
    return {
      pushedBy: (chat, provider) =>
        `${chat} が ${provider} を使用して送信`,
      unknownChat: "不明なチャット",
      unknownProvider: "不明なプロバイダー",
    };
  }
  return {
    pushedBy: (chat, provider) =>
      `Pushed by ${chat}, using ${provider}`,
    unknownChat: "Unknown chat",
    unknownProvider: "Unknown provider",
  };
}

function trimUnicodeWhitespace(value: string | null | undefined): string {
  return value?.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "") ?? "";
}

function bidiIsolate(value: string): string {
  return `${BIDI_ISOLATE_START}${value}${BIDI_ISOLATE_END}`;
}

function resolveProvenance(
  provenance: RendererPaneState["provenance"],
): ResolvedProvenance {
  const strings = provenanceStrings();
  const suppliedChat = trimUnicodeWhitespace(provenance?.friendlyChatName);
  const suppliedProvider = trimUnicodeWhitespace(
    provenance?.controllerProductName,
  );
  const chat = suppliedChat || strings.unknownChat;
  const provider = suppliedProvider || strings.unknownProvider;
  return {
    accessibleName: strings.pushedBy(
      bidiIsolate(chat),
      bidiIsolate(provider),
    ),
    chat,
    provider,
  };
}

function measuredTextWidth(element: HTMLElement, text: string): number {
  const style = getComputedStyle(element);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return text.length * 8;
  context.font = [
    style.fontStyle,
    style.fontWeight,
    style.fontSize,
    style.fontFamily,
  ].join(" ");
  return context.measureText(text).width;
}

function updateProvenanceWidthClass(element: HTMLElement): void {
  for (const className of PROVENANCE_WIDTH_CLASSES) {
    element.classList.remove(className);
  }
  const components = element.querySelectorAll<HTMLElement>(
    ".navigation-pill__provenance-component",
  );
  for (const component of components) {
    component.style.removeProperty("flex-basis");
    component.style.removeProperty("inline-size");
    component.style.removeProperty("max-inline-size");
  }

  const width = element.getBoundingClientRect().width;
  const ellipsisWidth = measuredTextWidth(element, "…");
  const separatorWidth = measuredTextWidth(element, " — ");
  const compositeMinimumWidth = ellipsisWidth * 2 + separatorWidth;
  element.dataset.collapsedMinimumWidth = String(ellipsisWidth);
  element.dataset.compositeMinimumWidth = String(compositeMinimumWidth);

  if (width < ellipsisWidth) {
    element.classList.add("navigation-pill__provenance--zero-width");
    return;
  }
  if (width < compositeMinimumWidth) {
    element.classList.add("navigation-pill__provenance--collapsed");
    return;
  }

  element.classList.add("navigation-pill__provenance--composite");
  const chatElement = components[0];
  const providerElement = components[1];
  if (!chatElement || !providerElement) {
    return;
  }
  const distributableWidth = Math.max(0, width - separatorWidth);
  const equalShare = distributableWidth / 2;
  const chatWidth = measuredTextWidth(element, chatElement.textContent ?? "");
  const providerWidth = measuredTextWidth(
    element,
    providerElement.textContent ?? "",
  );
  let chatShare = equalShare;
  let providerShare = equalShare;
  if (chatWidth < equalShare && providerWidth < equalShare) {
    chatShare = chatWidth;
    providerShare = providerWidth;
  } else if (chatWidth < equalShare) {
    chatShare = chatWidth;
    providerShare = distributableWidth - chatShare;
  } else if (providerWidth < equalShare) {
    providerShare = providerWidth;
    chatShare = distributableWidth - providerShare;
  }
  for (const [component, share] of [
    [chatElement, chatShare],
    [providerElement, providerShare],
  ] as const) {
    const pixels = `${Math.max(0, share)}px`;
    component.style.setProperty("flex-basis", pixels);
    component.style.setProperty("inline-size", pixels);
    component.style.setProperty("max-inline-size", pixels);
  }
}

function refreshProvenanceWidths(): void {
  for (const label of provenanceLabels) {
    if (!label.isConnected) {
      provenanceLabels.delete(label);
      continue;
    }
    updateProvenanceWidthClass(label);
  }
}

function registerProvenanceLabel(label: HTMLElement): void {
  provenanceLabels.add(label);
  queueMicrotask(() => {
    if (!label.isConnected) {
      provenanceLabels.delete(label);
      return;
    }
    updateProvenanceWidthClass(label);
    if (typeof ResizeObserver !== "undefined") {
      provenanceResizeObserver ??= new ResizeObserver(() => {
        refreshProvenanceWidths();
      });
      provenanceResizeObserver.observe(label.parentElement ?? label);
    }
  });
}

function rebuildAllPaneControls(): void {
  for (const paneId of paneViews.keys()) {
    rebuildPaneControls(paneId);
  }
}

function installProvenanceMetricObservers(): void {
  if (provenanceMetricObserversInstalled) {
    return;
  }
  provenanceMetricObserversInstalled = true;
  observedProvenanceLanguage = activeProvenanceLanguage();
  if (typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => {
      const language = activeProvenanceLanguage();
      if (language !== observedProvenanceLanguage) {
        observedProvenanceLanguage = language;
        rebuildAllPaneControls();
        return;
      }
      refreshProvenanceWidths();
    });
    observer.observe(document.documentElement, {
      attributeFilter: ["class", "dir", "lang", "style"],
      attributes: true,
    });
    observer.observe(document.body, {
      attributeFilter: ["class", "style"],
      attributes: true,
    });
  }
  const fonts = document.fonts;
  if (fonts) {
    void fonts.ready.then(() => refreshProvenanceWidths());
    fonts.addEventListener("loadingdone", refreshProvenanceWidths);
  }
}

function createProvenanceLabel(
  paneId: number,
  provenance: RendererPaneState["provenance"],
): HTMLElement {
  const resolved = resolveProvenance(provenance);
  const label = document.createElement("span");
  label.className = "navigation-pill__provenance";
  label.id = `pane-${paneId}-provenance`;
  label.setAttribute("aria-label", resolved.accessibleName);
  label.setAttribute("role", "group");
  const chatElement = document.createElement("bdi");
  chatElement.className = "navigation-pill__provenance-component";
  chatElement.dir = "auto";
  chatElement.setAttribute("aria-hidden", "true");
  chatElement.textContent = resolved.chat;
  const separator = document.createElement("span");
  separator.className = "navigation-pill__provenance-separator";
  separator.setAttribute("aria-hidden", "true");
  separator.textContent = " — ";
  const providerElement = document.createElement("bdi");
  providerElement.className = "navigation-pill__provenance-component";
  providerElement.dir = "auto";
  providerElement.setAttribute("aria-hidden", "true");
  providerElement.textContent = resolved.provider;
  label.append(chatElement, separator, providerElement);
  return label;
}

function historyEntrySignature(pane: RendererPaneState): string {
  return JSON.stringify({
    content: contentKey(pane),
    provenance: pane.provenance,
  });
}

function queueHistoryAnnouncement(pane: RendererPaneState): void {
  pendingHistoryAnnouncements.set(pane.paneId, historyEntrySignature(pane));
}

function announceReachedHistoryEntries(state: RendererWindowState): void {
  for (const pane of state.panes) {
    const previousSignature = pendingHistoryAnnouncements.get(pane.paneId);
    if (
      previousSignature === undefined ||
      previousSignature === historyEntrySignature(pane)
    ) {
      continue;
    }
    pendingHistoryAnnouncements.delete(pane.paneId);
    if (!provenanceAnnouncer) {
      continue;
    }
    const announcement = resolveProvenance(pane.provenance).accessibleName;
    provenanceAnnouncer.textContent = "";
    window.setTimeout(() => {
      provenanceAnnouncer.textContent = announcement;
    }, 0);
  }
}

type LucideIconName =
  | "chevron-left"
  | "chevron-right"
  | "minus"
  | "panel-bottom-open"
  | "pen-line"
  | "plus"
  | "rotate-cw"
  | "text"
  | "wifi-off"
  | "x";

function createLucideIcon(name: LucideIconName): SVGSVGElement {
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
    "chevron-left": [
      "m15 18-6-6 6-6",
    ],
    "chevron-right": [
      "m9 18 6-6-6-6",
    ],
    minus: [
      "M5 12h14",
    ],
    "panel-bottom-open": [
      "M3 5h18",
      "M3 19h18",
      "M3 5v14",
      "M21 5v14",
      "M8 14h8",
      "M8 14l4-4 4 4",
    ],
    "pen-line": [
      "M12 20h9",
      "M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z",
    ],
    plus: [
      "M5 12h14",
      "M12 5v14",
    ],
    "rotate-cw": [
      "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1.06 6.63 2.92",
      "M21 3v6h-6",
    ],
    text: [
      "M4 7V4h16v3",
      "M9 20h6",
      "M12 4v16",
    ],
    "wifi-off": [
      "M12 20h.01",
      "M8.5 16.429a5 5 0 0 1 7 0",
      "M5 12.859a10 10 0 0 1 5.17-2.69",
      "M19 12.859a10 10 0 0 0-2.007-1.523",
      "M2 8.82a15 15 0 0 1 4.177-2.643",
      "M22 8.82a15 15 0 0 0-11.288-3.764",
      "m2 2 20 20",
    ],
    x: [
      "M18 6 6 18",
      "m6 6 12 12",
    ],
  };
  for (const pathData of pathsByIcon[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
  }
  return svg;
}

function createIconButton(iconName: LucideIconName, accessibleLabel: string, className: string, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `control-button icon-button ${className}`;
  button.disabled = disabled;
  button.setAttribute("aria-label", accessibleLabel);
  button.title = accessibleLabel;
  button.appendChild(createLucideIcon(iconName));
  return button;
}

function browserUrlCanGoBack(webview: BrowserUrlWebViewElement | null): boolean {
  try {
    return Boolean(webview?.canGoBack?.());
  } catch {
    return false;
  }
}

function browserUrlCanGoForward(webview: BrowserUrlWebViewElement | null): boolean {
  try {
    return Boolean(webview?.canGoForward?.());
  } catch {
    return false;
  }
}

function currentBrowserUrlWebView(view: PaneView): BrowserUrlWebViewElement | null {
  const frame = currentPaneFrameElement(view);
  return frame?.matches("webview.content-browser-url-frame") ? frame as BrowserUrlWebViewElement : null;
}

function syncBrowserControlButtons(view: PaneView): void {
  const webview = currentBrowserUrlWebView(view);
  const canGoBack = browserUrlCanGoBack(webview);
  const canGoForward = browserUrlCanGoForward(webview);
  const back = view.controlsEl.querySelector<HTMLButtonElement>(".browser-back");
  const forward = view.controlsEl.querySelector<HTMLButtonElement>(".browser-forward");
  if (back) {
    back.disabled = !canGoBack;
  }
  if (forward) {
    forward.disabled = !canGoForward;
  }
}

function duplicateRepushCulpritLines(pane: RendererPaneState): string[] {
  const provenance = pane.content.display?.provenance;
  const lines = [
    pane.provenanceName ? `Sender: ${pane.provenanceName}` : null,
    provenance?.source ? `Source: ${provenance.source}` : null,
    provenance?.sessionKey ? `Session: ${provenance.sessionKey}` : null,
    provenance?.agentId ? `Agent: ${provenance.agentId}` : null,
    provenance?.streamLabel ? `Stream: ${provenance.streamLabel}` : null,
    pane.content.contentId ? `Content: ${pane.content.contentId} r${pane.content.revision}` : null,
  ];
  return lines.filter((line): line is string => Boolean(line));
}

function hideDuplicateRepushOverlay(view: PaneView): void {
  view.duplicateRepushEl.hidden = true;
  view.duplicateRepushEl.replaceChildren();
  scheduleCompositorOverlayRegionReport("visibility");
}

function showDuplicateRepushOverlay(view: PaneView, pane: RendererPaneState, signature: DuplicateRepushSignature): void {
  const duplicateKey = `${contentKey(pane)}:${signature.kind}:${signature.value}`;
  if (view.dismissedDuplicateRepushKey === duplicateKey) {
    return;
  }

  const title = document.createElement("strong");
  title.textContent = "Unnecessary re-push";
  const message = document.createElement("span");
  message.textContent = `Same ${signature.kind === "URL" ? "URL" : "HTML"} pushed again. Scroll position preserved.`;
  const culprit = document.createElement("span");
  culprit.className = "duplicate-repush-overlay__culprit";
  const culpritLines = duplicateRepushCulpritLines(pane);
  culprit.textContent = culpritLines.length > 0 ? culpritLines.join(" · ") : "Source unavailable";
  const close = surfAceOverlay(createIconButton("x", "Dismiss duplicate re-push notice", "duplicate-repush-overlay__close"), "duplicate-repush-close");
  close.addEventListener("click", () => {
    view.dismissedDuplicateRepushKey = duplicateKey;
    hideDuplicateRepushOverlay(view);
  });

  view.duplicateRepushEl.replaceChildren(title, message, culprit, close);
  view.duplicateRepushEl.hidden = false;
  scheduleCompositorOverlayRegionReport("visibility");
}

function reportDuplicateBrowserUrlNavigation(pane: RendererPaneState): void {
  if (pane.content.contentType !== "browser_url" || !pane.content.content) {
    return;
  }
  const browserUrl = pane.content.content as BrowserUrlContent;
  window.surfAce.command({
    paneId: pane.paneId,
    status: "applied",
    targetId: pane.content.contentId,
    type: "browser-url-navigation",
    url: browserUrl.url,
  });
}

function setPaneChromeMetrics(view: PaneView): void {
  const rect = view.rootEl.getBoundingClientRect();
  const paneNumberSize = Math.max(1, Math.min(rect.width, rect.height) / 4);
  view.rootEl.style.setProperty("--pane-number-size", `${paneNumberSize}px`);
}

function fitPaneLabelToVisibleBounds(view: PaneView): void {
  const labelWrap = view.rootEl.querySelector(".pane-label") as HTMLDivElement | null;
  if (!labelWrap || labelWrap.hidden) {
    return;
  }
  const paneRect = view.rootEl.getBoundingClientRect();
  if (paneRect.width <= 0 || paneRect.height <= 0) {
    return;
  }

  const basePaneNumberSize = Math.max(1, Math.min(paneRect.width, paneRect.height) / 4);
  view.rootEl.style.setProperty("--pane-number-size", `${basePaneNumberSize}px`);

  const edgeMargin = Math.min(
    PANE_LABEL_MAX_EDGE_MARGIN_PX,
    Math.max(PANE_LABEL_MIN_EDGE_MARGIN_PX, Math.min(paneRect.width, paneRect.height) * PANE_LABEL_EDGE_MARGIN_RATIO),
  );
  const availableWidth = Math.max(1, paneRect.width - edgeMargin * 2);
  const availableHeight = Math.max(1, paneRect.height - edgeMargin * 2);
  const labelRect = labelWrap.getBoundingClientRect();
  if (labelRect.width <= 0 || labelRect.height <= 0) {
    return;
  }

  const widthScale = labelRect.width > availableWidth ? availableWidth / labelRect.width : 1;
  const heightScale = labelRect.height > availableHeight ? availableHeight / labelRect.height : 1;
  const scale = Math.min(widthScale, heightScale);
  if (scale >= 1) {
    return;
  }

  const fittedPaneNumberSize = Math.max(PANE_LABEL_MIN_NUMBER_SIZE_PX, Math.floor(basePaneNumberSize * scale));
  view.rootEl.style.setProperty("--pane-number-size", `${fittedPaneNumberSize}px`);
}

function setAllPaneChromeMetrics(): void {
  for (const view of paneViews.values()) {
    setPaneChromeMetrics(view);
    fitPaneLabelToVisibleBounds(view);
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
  let captureReady = false;
  let activeCapture: Promise<boolean> | null = null;
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
    captureReady = false;
    const stroke = activeStroke;
    activeCapture = (pendingStrokeDelivery.get(view.paneId) ?? Promise.resolve())
      .then(() => window.surfAce.captureAnnotationOpen(view.paneId, stroke.points[0]!.timestamp))
      .catch(() => false)
      .then((captured) => {
        if (activeStroke === stroke) {
          captureReady = true;
          redrawDrawings(view, [...(paneStateFor(view)?.drawings ?? []), stroke]);
        }
        return captured;
      });
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!activeStroke) {
      return;
    }
    activeStroke.points.push(pointFromEvent(event));
    if (captureReady) redrawDrawings(view, [...(paneStateFor(view)?.drawings ?? []), activeStroke]);
    event.preventDefault();
  });

  const finishStroke = (event: PointerEvent) => {
    if (!activeStroke) {
      return;
    }
    const stroke = activeStroke;
    const capture = activeCapture;
    activeStroke = null;
    activeCapture = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    const delivery = (async () => {
      await capture;
      if (stroke.points.length > 0) {
        window.surfAce.command({ paneId: view.paneId, stroke, type: "draw-stroke" });
      }
      const pane = paneStateFor(view);
      if (!activeStroke) redrawDrawings(view, pane?.drawings ?? []);
    })();
    pendingStrokeDelivery.set(view.paneId, delivery);
    void delivery.finally(() => {
      if (pendingStrokeDelivery.get(view.paneId) === delivery) pendingStrokeDelivery.delete(view.paneId);
    });
  };

  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
}

function isPaneChromeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".control-cluster, .toolbar-dock, .pane-pop-out"));
}

function applyPanePopOut(): void {
  for (const view of paneViews.values()) {
    const expanded = view.paneId === poppedOutPaneId;
    const covered = poppedOutPaneId !== null && !expanded;
    view.rootEl.classList.toggle("pane-popped-out", expanded);
    const pending = panePresentationTransitionsPending > 0 || panePresentationAuthorityBlocked ||
      (expanded && panePresentationResizePending);
    view.rootEl.classList.toggle("pane-presentation-pending", pending);
    for (const element of [view.contentEl, view.scrollEl, view.controlsEl, view.annotationCanvas, view.annotationShield]) {
      element.toggleAttribute("inert", pending);
    }
    const bounds = expanded ? acknowledgedPopOutBounds : null;
    for (const [property, value] of Object.entries({ left: bounds?.x, top: bounds?.y,
      width: bounds?.width, height: bounds?.height })) {
      if (value === undefined) view.rootEl.style.removeProperty(property);
      else view.rootEl.style.setProperty(property, `${value}px`);
    }
    view.slotEl.classList.toggle("pane-covered", covered);
    view.rootEl.toggleAttribute("inert", covered);
    if (covered) view.rootEl.setAttribute("aria-hidden", "true");
    else view.rootEl.removeAttribute("aria-hidden");
    view.popOutButton.textContent = expanded ? "Restore" : "Pop out";
    view.popOutButton.title = expanded ? "Restore pane to its tile" : "Pop out pane within this window";
    view.popOutButton.setAttribute("aria-label", `${expanded ? "Restore" : "Pop out"} pane ${view.paneId}`);
    view.popOutButton.setAttribute("aria-expanded", String(expanded));
  }
  appRoot.classList.toggle("has-pane-pop-out", poppedOutPaneId !== null);
  positionPaneHosts();
}

let panePresentationTransitionsPending = 0;
let panePresentationAuthorityBlocked = false;
let panePresentationIntent = 0;
let panePresentationMainRevision = 0;
let panePresentationConfirmedClearRevision = 0;
let panePresentationAuthorityRevision = 0;
let panePresentationAuthorityClearRevision = 0;
let acknowledgedPopOutBounds: { x: number; y: number; width: number; height: number } | null = null;
let panePresentationResizePending = false;
async function togglePanePopOut(view: PaneView): Promise<void> {
  await requestPanePopOut(view, panePresentationAuthorityBlocked || poppedOutPaneId === view.paneId ? null : view.paneId);
}

async function requestPanePopOut(view: PaneView, selected: number | null): Promise<void> {
  if (!latestState) return;
  if (resizeCommitPending) {
    view.popOutButton.title = "Wait for the divider resize to finish";
    return;
  }
  cancelResizeGesture();
  const intent = ++panePresentationIntent;
  panePresentationTransitionsPending++;
  applyPanePopOut();
  let failureTitle: string | null = null;
  try {
    const identity = paneSnapshotGeometryIdentity();
    const surfaceId = latestState.surfaceId;
    const selectedLineage = paneStateFor(view)?.paneLineageId;
    const width = latestState.viewport.width;
    const height = latestState.viewport.height;
    const inset = Math.max(8, Math.min(24, Math.min(width, height) * 0.02));
    const bounds = { x: inset, y: inset, width: width - inset * 2, height: height - inset * 2 };
    const viewport = currentViewport(view);
    viewport.visibleRect.width = Math.max(0, bounds.width - 4);
    viewport.visibleRect.height = Math.max(0, bounds.height - 4);
    let response: { ok: boolean; error?: string; presentationCleared?: boolean; presentationBlocked?: boolean; revision?: number; authorityRevision?: number };
    try {
      response = await window.surfAce.setPanePresentation({ identity, paneId: selected,
        ...(selected === null ? {} : { bounds, viewport }) });
    } catch (error) {
      response = { ok: false, presentationBlocked: true, error: error instanceof Error ? error.message : "Pane presentation failed" };
    }
    // Native authority outlives a stale display request. A geometry change may
    // invalidate this reply's pixels without retiring its acknowledged selection.
    const currentAuthority = latestState?.surfaceId === surfaceId &&
      latestState.surfaceEpoch === identity.surfaceEpoch;
    const responseRevision = response.authorityRevision;
    const revisionIsCurrent = Number.isSafeInteger(responseRevision) &&
      Number(responseRevision) >= panePresentationAuthorityRevision;
    if (currentAuthority && !response.ok) {
      if (response.presentationBlocked && (responseRevision === undefined ||
          (revisionIsCurrent && Number(responseRevision) > panePresentationAuthorityClearRevision))) {
        panePresentationAuthorityBlocked = true;
        cancelResizeGesture();
      } else if (response.presentationCleared && revisionIsCurrent) {
        panePresentationAuthorityBlocked = false;
        panePresentationAuthorityClearRevision = Number(responseRevision);
      }
      if (revisionIsCurrent) panePresentationAuthorityRevision = Number(responseRevision);
    }
    if (intent !== panePresentationIntent || !latestState || latestState.surfaceId !== surfaceId ||
        JSON.stringify(paneSnapshotGeometryIdentity()) !== JSON.stringify(identity) ||
        paneViews.get(view.paneId) !== view || paneStateFor(view)?.paneLineageId !== selectedLineage) return;
    if (!response.ok) {
      if (response.presentationCleared) {
        if (responseRevision !== undefined && !revisionIsCurrent) return;
        panePresentationAuthorityBlocked = false;
        poppedOutPaneId = null;
        acknowledgedPopOutBounds = null;
        panePresentationResizePending = false;
        applyPanePopOut();
        setAllPaneChromeMetrics();
        refreshDynamicPaneFrames();
        reportAllPaneSnapshots();
        scheduleCompositorOverlayRegionReport("layout");
      }
      failureTitle = response.error ?? "Pane presentation is unavailable";
      return;
    }
    if (response.revision !== undefined) {
      if (!Number.isSafeInteger(response.revision) || response.revision < panePresentationMainRevision) return;
      panePresentationMainRevision = response.revision;
    }
    if (response.authorityRevision !== undefined && !revisionIsCurrent) return;
    if (revisionIsCurrent) panePresentationAuthorityRevision = Number(responseRevision);
    cancelResizeGesture(); // Defense against a gesture introduced outside divider admission.
    panePresentationAuthorityBlocked = false;
    if (selected === null && response.revision !== undefined) {
      panePresentationConfirmedClearRevision = response.revision;
    }
    if (selected === null && revisionIsCurrent) panePresentationAuthorityClearRevision = Number(responseRevision);
    poppedOutPaneId = selected;
    acknowledgedPopOutBounds = selected === null ? null : bounds;
    panePresentationResizePending = false;
    applyPanePopOut();
    // Focusing the pane changes input ownership, never the split tree or content.
    rememberPaneContext(view.paneId);
    view.popOutButton.focus();
    setAllPaneChromeMetrics();
    refreshDynamicPaneFrames();
    reportAllPaneSnapshots();
    scheduleCompositorOverlayRegionReport("layout");
  } finally {
    panePresentationTransitionsPending--;
    applyPanePopOut();
    if (failureTitle && intent === panePresentationIntent && paneViews.get(view.paneId) === view) {
      view.popOutButton.title = failureTitle;
    }
    if (panePresentationTransitionsPending === 0) {
      reportAllPaneSnapshots();
      scheduleCompositorOverlayRegionReport("layout");
    }
  }
}

function attachCommonEvents(view: PaneView): void {
  view.rootEl.addEventListener("pointerdown", (event) => {
    rememberPaneContext(view.paneId);
    if (!isPaneChromeTarget(event.target)) {
      collapsePaneToolbar(view);
    }
  });
  view.scrollEl.addEventListener("scroll", () => {
    collapsePaneToolbar(view);
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

function rebuildPaneControls(paneId: number): void {
  const view = paneViews.get(paneId);
  const pane = latestState?.panes.find((candidate) => candidate.paneId === paneId);
  if (!view || !pane) {
    return;
  }
  buildControls(view, pane);
}

function collapsePaneToolbar(view: PaneView): void {
  if (view.toolbarCollapsed || paneStateFor(view)?.annotationBorderVisible) {
    return;
  }
  view.toolbarCollapsed = true;
  view.rootEl.classList.add("toolbar-collapsed");
  if (openFontSizePaneId === view.paneId) {
    openFontSizePaneId = null;
  }
  rebuildPaneControls(view.paneId);
}

function restorePaneToolbar(view: PaneView): void {
  view.toolbarCollapsed = false;
  view.rootEl.classList.remove("toolbar-collapsed");
  rebuildPaneControls(view.paneId);
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
  const slotEl = document.createElement("div");
  slotEl.className = "pane-slot";
  // Tiled slot and retained content host live in separate layers.
  const popOutButton = surfAceOverlay(document.createElement("button"), "pane-pop-out");
  popOutButton.type = "button";
  popOutButton.className = "pane-pop-out control-button";
  popOutButton.textContent = "Pop out";
  popOutButton.setAttribute("aria-label", `Pop out pane ${paneId}`);
  popOutButton.setAttribute("aria-expanded", "false");
  popOutButton.addEventListener("click", (event) => {
    event.stopPropagation();
    void togglePanePopOut(view);
  });
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
  const disconnectedGlyphEl = createLucideIcon("wifi-off");
  disconnectedGlyphEl.classList.add("pane-label__disconnected");
  disconnectedGlyphEl.setAttribute("aria-hidden", "true");
  disconnectedGlyphEl.setAttribute("hidden", "");
  const labelTextEl = document.createElement("span");
  labelTextEl.className = "pane-label__number";
  labelEl.append(windowLabelEl, disconnectedGlyphEl, labelTextEl);
  const focusOverlayEl = document.createElement("div");
  focusOverlayEl.className = "keyboard-focus-overlay";
  for (const edge of ["top", "right", "bottom", "left"]) {
    const edgeEl = document.createElement("div");
    edgeEl.className = `keyboard-focus-edge keyboard-focus-edge--${edge}`;
    focusOverlayEl.appendChild(edgeEl);
  }
  const canvas = document.createElement("canvas");
  canvas.className = "annotation-layer";
  const controlsEl = document.createElement("div");
  controlsEl.className = "control-cluster";
  surfAceOverlay(controlsEl, "pane-handle");
  const dockEl = document.createElement("button");
  dockEl.className = "toolbar-dock control-button icon-button";
  dockEl.type = "button";
  dockEl.title = "Restore toolbar";
  dockEl.setAttribute("aria-label", "Restore toolbar");
  dockEl.appendChild(createLucideIcon("panel-bottom-open"));
  dockEl.addEventListener("click", (event) => {
    event.stopPropagation();
    rememberPaneContext(paneId);
    restorePaneToolbar(view);
  });
  const toastEl = document.createElement("div");
  toastEl.className = "pane-toast";
  toastEl.hidden = true;
  const duplicateRepushEl = document.createElement("div");
  duplicateRepushEl.className = "duplicate-repush-overlay";
  duplicateRepushEl.hidden = true;

  rootEl.append(scrollEl, shieldEl, canvas, focusOverlayEl, labelEl, controlsEl, dockEl, toastEl, duplicateRepushEl, popOutButton);

  const view: PaneView = {
    annotationCanvas: canvas,
    annotationShield: shieldEl,
    contentEl,
    controlsEl,
    currentContentKey: "",
    currentContentSignature: null,
    currentDrawingsKey: "",
    currentHtmlFrameCleanup: null,
    currentRenderToken: 0,
    currentScrollHandler: null,
    currentWebViewResizeObserver: null,
    dismissedDuplicateRepushKey: null,
    dockEl,
    duplicateRepushEl,
    lastNavigation: null,
    paneId,
    slotEl,
    popOutButton,
    rootEl,
    scale: CONTENT_SCALE_DEFAULT,
    scrollEl,
    toolbarCollapsed: false,
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
  view.controlsEl.classList.toggle("collapsed", view.toolbarCollapsed);
  view.dockEl.hidden = !view.toolbarCollapsed;
  view.dockEl.setAttribute("aria-expanded", String(view.toolbarCollapsed));
  const hasPushedContent = pane.content.contentId !== null;
  if (isBrowserUrlPane(pane) && !pane.showDone) {
    const browserPill = document.createElement("div");
    browserPill.className = "control-pill browser-navigation-pill";
    const browserBack = surfAceOverlay(createIconButton("chevron-left", "Browser Back", "browser-back", true), "browser-back");
    browserBack.addEventListener("click", () => {
      rememberPaneContext(pane.paneId);
      currentBrowserUrlWebView(view)?.goBack?.();
      window.setTimeout(() => syncBrowserControlButtons(view), 0);
    });
    const browserForward = surfAceOverlay(createIconButton("chevron-right", "Browser Forward", "browser-forward", true), "browser-forward");
    browserForward.addEventListener("click", () => {
      rememberPaneContext(pane.paneId);
      currentBrowserUrlWebView(view)?.goForward?.();
      window.setTimeout(() => syncBrowserControlButtons(view), 0);
    });
    const browserReload = surfAceOverlay(createIconButton("rotate-cw", "Browser Reload", "browser-reload"), "reload");
    browserReload.addEventListener("click", () => {
      rememberPaneContext(pane.paneId);
      currentBrowserUrlWebView(view)?.reload?.();
    });
    browserPill.append(browserBack, browserForward, browserReload);
    view.controlsEl.appendChild(browserPill);
    syncBrowserControlButtons(view);
  }
  if (hasPushedContent || pane.canGoBack || pane.canGoForward || pane.content.reloadable) {
    const navigationPill = document.createElement("div");
    navigationPill.className = "control-pill navigation-pill";
    if (pane.content.reloadable && !pane.showDone && !isBrowserUrlPane(pane)) {
      const reload = surfAceOverlay(createIconButton("rotate-cw", "Reload", "reload"), "reload");
      reload.addEventListener("click", () => {
        rememberPaneContext(pane.paneId);
        window.surfAce.command({ paneId: pane.paneId, type: "reload" });
      });
      navigationPill.appendChild(reload);
    }
    if (pane.canGoBack) {
      const back = surfAceOverlay(createButton("◀", "back"), "history-back");
      back.setAttribute("aria-label", "Back");
      back.addEventListener("click", () => {
        queueHistoryAnnouncement(pane);
        rememberPaneContext(pane.paneId);
        window.surfAce.command({ direction: "back", paneId: pane.paneId, type: "history" });
      });
      navigationPill.appendChild(back);
    }
    if (pane.canGoForward) {
      const forward = surfAceOverlay(createButton("▶", "forward"), "history-forward");
      forward.setAttribute("aria-label", "Forward");
      forward.addEventListener("click", () => {
        queueHistoryAnnouncement(pane);
        rememberPaneContext(pane.paneId);
        window.surfAce.command({ direction: "forward", paneId: pane.paneId, type: "history" });
      });
      navigationPill.appendChild(forward);
    }
    if (hasPushedContent) {
      const provenanceLabel = createProvenanceLabel(
        pane.paneId,
        pane.provenance,
      );
      navigationPill.appendChild(provenanceLabel);
      registerProvenanceLabel(provenanceLabel);
    } else if (pane.provenanceName) {
      const ownerName = document.createElement("span");
      ownerName.className = "navigation-pill__owner";
      ownerName.textContent = pane.provenanceName;
      navigationPill.appendChild(ownerName);
    }
    if (navigationPill.childElementCount > 0) {
      view.controlsEl.appendChild(navigationPill);
    }
  }
  const annotationPill = document.createElement("div");
  annotationPill.className = "control-pill annotation-pill";
  const fontSizeToggle = surfAceOverlay(createIconButton("text", "Font Size", "font-size-toggle"), "annotation-control");
  const popupOpen = openFontSizePaneId === pane.paneId;
  const fontSizePopover = popupOpen ? document.createElement("div") : null;
  if (fontSizePopover) {
    fontSizePopover.className = "font-size-popover";
  }
  bindContentScaleControls({
    annotationPill,
    decrease: popupOpen
      ? surfAceOverlay(createIconButton("minus", "Decrease font size", "font-size-step"), "annotation-control")
      : null,
    fontSizePopover,
    fontSizeToggle,
    increase: popupOpen
      ? surfAceOverlay(createIconButton("plus", "Increase font size", "font-size-step"), "annotation-control")
      : null,
    onScale: (action) => scalePaneContent({ action, paneId: pane.paneId, type: "content-scale" }),
    onToggle: () => {
      rememberPaneContext(pane.paneId);
      const popup = toggleContentScalePopup(openFontSizePaneId, pane.paneId);
      openFontSizePaneId = popup.openPaneId;
      for (const paneId of popup.rebuildPaneIds) {
        rebuildPaneControls(paneId);
      }
    },
    reset: popupOpen
      ? surfAceOverlay(createButton("", "font-size-reset"), "annotation-control")
      : null,
    scale: view.scale,
  });
  const annotate = surfAceOverlay(createIconButton("pen-line", "Sketch", "annotate"), "annotation-control");
  annotate.addEventListener("click", () => {
    rememberPaneContext(pane.paneId);
    annotationIntentEpoch.set(pane.paneId, (annotationIntentEpoch.get(pane.paneId) ?? 0) + 1);
    window.surfAce.command({ enabled: true, paneId: pane.paneId, type: "annotate" });
  });
  annotate.classList.toggle("active", pane.showDone);
  annotationPill.appendChild(annotate);

  if (pane.showDone) {
    const done = surfAceOverlay(createButton("Done", "done"), "annotation-control");
    done.addEventListener("click", () => {
      rememberPaneContext(pane.paneId);
      const epoch = (annotationIntentEpoch.get(pane.paneId) ?? 0) + 1;
      annotationIntentEpoch.set(pane.paneId, epoch);
      void (pendingStrokeDelivery.get(pane.paneId) ?? Promise.resolve()).then(() => {
        if (annotationIntentEpoch.get(pane.paneId) === epoch) {
          window.surfAce.command({ enabled: false, paneId: pane.paneId, type: "annotate" });
        }
      });
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

function isContentScaleIntent(intent: unknown): intent is ContentScaleIntent {
  if (!intent || typeof intent !== "object") {
    return false;
  }
  const candidate = intent as Partial<ContentScaleIntent>;
  return (
    candidate.type === "content-scale" &&
    typeof candidate.paneId === "number" &&
    (candidate.action === "decrease" || candidate.action === "increase" || candidate.action === "reset")
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
  if (resizeGesture) return;
  window.surfAce.command({
    paneId: view.paneId,
    type: "scroll",
    viewport: result.viewport,
    visibleText: result.visibleText,
  });
  reportSnapshot({
    bounds: paneBounds(view),
    ...paneSnapshotGeometryIdentity(),
    paneId: view.paneId,
    selection: null,
    viewport: result.viewport,
  });
}

function nextContentScale(current: number, action: ContentScaleIntent["action"]): number {
  if (action === "reset") {
    return CONTENT_SCALE_DEFAULT;
  }
  const delta = action === "increase" ? CONTENT_SCALE_STEP : -CONTENT_SCALE_STEP;
  return Math.min(CONTENT_SCALE_MAX, Math.max(CONTENT_SCALE_MIN, Math.round((current + delta) * 10) / 10));
}

function isRendererScalableContentType(pane: RendererPaneState | null): boolean {
  return (
    pane?.content.contentType === "browser_url" ||
    pane?.content.contentType === "html" ||
    pane?.content.contentType === "image" ||
    pane?.content.contentType === "markdown" ||
    pane?.content.contentType === "pdf" ||
    pane?.content.contentType === "terminal"
  );
}

function runReadyGuestScript(view: PaneView, webview: BrowserUrlWebViewElement, code: string): void {
  if (webview.dataset.guestReady !== "true" || !webview.isConnected || currentPaneFrameElement(view) !== webview) return;
  try {
    void webview.executeJavaScript?.(code)?.catch(() => {});
  } catch {
    // A guest can disappear while its host-side ready notification is queued.
  }
}

function applyBrowserContentScale(view: PaneView, webview: BrowserUrlWebViewElement): void {
  const scale = Math.round(WEB_CONTENT_BASE_SCALE * view.scale * 1000) / 1000;
  runReadyGuestScript(view, webview,
    `(() => {
      const scale = ${JSON.stringify(scale)};
      document.documentElement.style.zoom = scale === 1 ? "" : String(scale);
      document.body?.style.setProperty("--surf-ace-content-scale", String(scale));
      window.dispatchEvent(new Event("resize"));
    })()`,
  );
}

function applyContentScale(view: PaneView): void {
  view.contentEl.style.setProperty("--surf-ace-content-scale", String(view.scale));
  const frame = currentPaneFrameElement(view);
  if (frame?.matches("webview.content-browser-url-frame")) {
    applyBrowserContentScale(view, frame as BrowserUrlWebViewElement);
  }
  reportPaneSnapshot(view);
}

function scalePaneContent(intent: ContentScaleIntent): void {
  const view = paneViews.get(intent.paneId);
  if (!view) {
    return;
  }
  const pane = paneStateFor(view);
  if (pane?.annotationBorderVisible || !isRendererScalableContentType(pane)) {
    return;
  }
  rememberPaneContext(intent.paneId);
  view.scale = nextContentScale(view.scale, intent.action);
  applyContentScale(view);
  rebuildPaneControls(intent.paneId);
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
  const changed = element.style.width !== `${width}px` || element.style.height !== `${height}px`;
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  if (element.matches("webview.content-browser-url-frame")) {
    element.setAttribute("autosize", "on");
    element.setAttribute("minwidth", String(width));
    element.setAttribute("minheight", String(height));
    element.setAttribute("maxwidth", String(width));
    element.setAttribute("maxheight", String(height));
    if (changed && element.dataset.guestReady === "true") {
      runReadyGuestScript(view, element as BrowserUrlWebViewElement,
        `window.dispatchEvent(new Event("resize"))`,
      );
    }
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

async function browserUrlGuestDiagnosticsWithTimeout(webview: BrowserUrlWebViewElement): Promise<unknown> {
  let timeoutId = 0;
  try {
    return await Promise.race([
      browserUrlGuestDiagnostics(webview),
      new Promise<unknown>((resolve) => {
        timeoutId = window.setTimeout(() => {
          resolve({ error: "timeout" });
        }, BROWSER_URL_DIAGNOSTIC_READBACK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
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

function browserUrlDiagnosticFields(url: string): Record<string, string> {
  try {
    const parsed = new URL(url);
    return {
      url,
      urlHost: parsed.hostname,
      urlPort: parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : ""),
      urlScheme: parsed.protocol.replace(/:$/, ""),
    };
  } catch {
    return {
      url,
      urlHost: "invalid",
      urlPort: "",
      urlScheme: "invalid",
    };
  }
}

function browserUrlElementCurrentUrl(webview: BrowserUrlWebViewElement): string {
  try {
    return String(webview.getURL?.() ?? webview.src ?? "");
  } catch {
    return "";
  }
}

function browserUrlElementTitle(webview: BrowserUrlWebViewElement): string {
  try {
    return String(webview.getTitle?.() ?? "");
  } catch {
    return "";
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
    guest = await browserUrlGuestDiagnosticsWithTimeout(webview);
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
    webviewCurrentUrl: browserUrlElementCurrentUrl(webview),
    webviewTitle: browserUrlElementTitle(webview),
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
      void browserUrlGuestDiagnosticsWithTimeout(webview).then((guest) => {
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
    if (resizeGesture && (payload.type === "scroll" || payload.type === "ready")) return;
    if (payload.type === "scroll") {
      collapsePaneToolbar(view);
      window.surfAce.command({
        paneId,
        type: "scroll",
        viewport: payload.viewport,
        visibleText: payload.visibleText,
      });
      reportSnapshot({
        bounds: paneBounds(view),
        ...paneSnapshotGeometryIdentity(),
        paneId,
        selection: null,
        viewport: payload.viewport,
        visibleText: payload.visibleText,
      });
    } else if (payload.type === "selection") {
      collapsePaneToolbar(view);
      window.surfAce.command({
        paneId,
        selection: payload.selection ?? null,
        type: "selection",
      });
    } else if (payload.type === "tap") {
      collapsePaneToolbar(view);
      window.surfAce.command({
        kind: payload.kind,
        nearestContent: payload.nearestContent,
        paneId,
        position: payload.position,
        type: "tap",
      });
    } else if (payload.type === "focus") {
      collapsePaneToolbar(view);
      rememberPaneContext(paneId);
    } else if (payload.type === "navigation") {
      collapsePaneToolbar(view);
      sendNavigationIntent(view, paneId, String(payload.url ?? ""));
    } else if (payload.type === "ready") {
      reportSnapshot({
        bounds: paneBounds(view),
        ...paneSnapshotGeometryIdentity(),
        paneId,
        selection: null,
        viewport: payload.viewport,
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
    applyContentScale(view);
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
    targetId: options?.navigationReport?.targetId ?? "",
    ...browserUrlDiagnosticFields(url),
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
    void browserUrlGuestDiagnosticsWithTimeout(browserView).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    })).then((guest) => {
      const readbackResult = guest && typeof guest === "object" && "error" in guest
        ? `error:${String((guest as { error?: unknown }).error ?? "")}`
        : "ok";
      window.surfAce.command({
        ...(errorMessage ? { errorMessage } : {}),
        currentUrl: browserUrlElementCurrentUrl(browserView),
        pageTitle: browserUrlElementTitle(browserView),
        paneId: pane.paneId,
        readbackResult,
        status,
        targetId: navigationReport.targetId,
        type: "browser-url-navigation",
        url: navigationReport.url,
        ...browserUrlDiagnosticFields(navigationReport.url),
      });
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
    syncBrowserControlButtons(view);
    void resetBrowserUrlGuestScroll(browserView).finally(() => {
      const eventReason = reason === "dom-ready:guest-viewport" ? "dom-ready" : "did-finish-load";
      reportBrowserUrlDiagnostics(view, browserView, eventReason);
      applyBrowserContentScale(view, browserView);
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
        targetId: options?.navigationReport?.targetId ?? "",
        ...browserUrlDiagnosticFields(url),
        webContentsId: browserUrlWebContentsId(browserView),
      });
      reportBrowserUrlDiagnostics(view, browserView, "did-attach");
      // Guest scale initialization runs from dom-ready, when guest methods are available.
    },
  );
  let guestLoadGeneration = 0;
  browserView.addEventListener(
    "did-start-loading",
    () => {
      guestLoadGeneration += 1;
      delete browserView.dataset.guestReady;
      syncBrowserControlButtons(view);
      rendererDiagnostic("browser_content_did_start_loading", {
        currentUrl: browserUrlElementCurrentUrl(browserView),
        paneId: pane.paneId,
        targetId: options?.navigationReport?.targetId ?? "",
        ...browserUrlDiagnosticFields(url),
        webContentsId: browserUrlWebContentsId(browserView),
      });
    },
  );
  browserView.addEventListener(
    "page-title-updated",
    (event) => {
      rendererDiagnostic("browser_content_page_title_updated", {
        currentUrl: browserUrlElementCurrentUrl(browserView),
        paneId: pane.paneId,
        targetId: options?.navigationReport?.targetId ?? "",
        title: String((event as { title?: unknown }).title ?? "").slice(0, 160),
        ...browserUrlDiagnosticFields(url),
        webContentsId: browserUrlWebContentsId(browserView),
      });
    },
  );
  browserView.addEventListener(
    "console-message",
    (event) => {
      rendererDiagnostic("browser_content_console_message", {
        currentUrl: browserUrlElementCurrentUrl(browserView),
        level: String((event as { level?: unknown }).level ?? ""),
        message: String((event as { message?: unknown }).message ?? "").slice(0, 240),
        paneId: pane.paneId,
        sourceId: String((event as { sourceId?: unknown }).sourceId ?? "").slice(0, 160),
        targetId: options?.navigationReport?.targetId ?? "",
        ...browserUrlDiagnosticFields(url),
        webContentsId: browserUrlWebContentsId(browserView),
      });
    },
  );
  browserView.addEventListener(
    "dom-ready",
    () => {
      browserView.dataset.guestReady = "true";
      syncBrowserControlButtons(view);
      rendererDiagnostic("browser_content_dom_ready", {
        currentUrl: browserUrlElementCurrentUrl(browserView),
        paneId: pane.paneId,
        targetId: options?.navigationReport?.targetId ?? "",
        title: browserUrlElementTitle(browserView),
        ...browserUrlDiagnosticFields(url),
        webContentsId: browserUrlWebContentsId(browserView),
      });
      verifyAndReportNavigation("dom-ready:guest-viewport");
    },
  );
  browserView.addEventListener(
    "did-finish-load",
    () => {
      syncBrowserControlButtons(view);
      rendererDiagnostic("browser_content_did_finish_load", {
        currentUrl: browserUrlElementCurrentUrl(browserView),
        paneId: pane.paneId,
        targetId: options?.navigationReport?.targetId ?? "",
        title: browserUrlElementTitle(browserView),
        ...browserUrlDiagnosticFields(url),
        webContentsId: browserUrlWebContentsId(browserView),
      });
      verifyAndReportNavigation("did-finish-load:guest-viewport");
    },
    { once: true },
  );
  browserView.addEventListener("will-navigate", blockStaticHtmlNavigation);
  browserView.addEventListener("will-frame-navigate", blockStaticHtmlNavigation);
  browserView.addEventListener("did-navigate", () => syncBrowserControlButtons(view));
  browserView.addEventListener("did-navigate-in-page", () => syncBrowserControlButtons(view));
  browserView.addEventListener("did-stop-loading", () => {
    syncBrowserControlButtons(view);
    // A loading cycle can finish without replacing the document or emitting
    // dom-ready. Recover readiness from the guest, never from the spinner alone.
    const generation = guestLoadGeneration;
    try {
      void browserView.executeJavaScript?.("document.readyState").then((readyState) => {
        if (generation !== guestLoadGeneration || renderToken !== view.currentRenderToken ||
            currentPaneFrameElement(view) !== browserView || !browserView.isConnected ||
            (readyState !== "interactive" && readyState !== "complete")) return;
        browserView.dataset.guestReady = "true";
        applyBrowserContentScale(view, browserView);
      }).catch(() => {});
    } catch {
      // A detached guest or one still navigating cannot establish readiness.
    }
  });
  browserView.addEventListener(
    "did-fail-load",
    (event) => {
      const failure = event as BrowserUrlWebViewErrorEvent;
      if (failure.isMainFrame === false) {
        return;
      }
      rendererDiagnostic("browser_content_did_fail_load", {
        currentUrl: browserUrlElementCurrentUrl(browserView),
        errorCode: failure.errorCode ?? "",
        errorDescription: failure.errorDescription ?? "",
        failedUrl: failure.validatedURL ?? "",
        isMainFrame: failure.isMainFrame ?? true,
        paneId: pane.paneId,
        targetId: options?.navigationReport?.targetId ?? "",
        title: browserUrlElementTitle(browserView),
        ...browserUrlDiagnosticFields(url),
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
      currentUrl: browserUrlElementCurrentUrl(browserView),
      paneId: pane.paneId,
      targetId: options?.navigationReport?.targetId ?? "",
      ...browserUrlDiagnosticFields(url),
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

  const nextSignature = duplicateRepushSignature(pane);
  if (isDuplicateRepush(view, pane, nextSignature)) {
    view.currentContentKey = key;
    view.currentContentSignature = nextSignature;
    showDuplicateRepushOverlay(view, pane, nextSignature!);
    reportDuplicateBrowserUrlNavigation(pane);
    reportPaneSnapshot(view);
    return;
  }

  view.currentContentKey = key;
  view.currentContentSignature = nextSignature;
  hideDuplicateRepushOverlay(view);
  const renderToken = resetDynamicContent(view);
  view.contentEl.className = `pane-content type-${pane.content.contentType ?? "empty"}`;
  view.contentEl.style.setProperty("--surf-ace-content-scale", String(view.scale));
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
    applyContentScale(view);
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
    applyContentScale(view);
    reportPaneSnapshot(view);
    return;
  }

  if (pane.content.contentType === "terminal") {
    const pre = document.createElement("pre");
    pre.className = "content-terminal";
    pre.textContent = (pane.content.content as TerminalContent).lines.join("\n");
    view.contentEl.appendChild(pre);
    applyContentScale(view);
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
  if (pane.annotationBorderVisible && view.toolbarCollapsed) {
    restorePaneToolbar(view);
  }
  if (pane.annotationBorderVisible && openFontSizePaneId === pane.paneId) {
    openFontSizePaneId = null;
  }
  view.annotationCanvas.classList.toggle("enabled", pane.annotationBorderVisible);
  view.annotationShield.classList.toggle("enabled", pane.annotationBorderVisible);
  const labelWrap = view.rootEl.querySelector(".pane-label") as HTMLDivElement;
  const windowLabel = labelWrap.querySelector(".pane-label__window") as HTMLSpanElement;
  const disconnectedGlyph = labelWrap.querySelector(".pane-label__disconnected") as SVGSVGElement;
  const label = labelWrap.querySelector(".pane-label__number") as HTMLSpanElement;
  const visibleAddress = pane.displayId || pane.visibleAddress || pane.label;
  const visibleWindowLabel = latestState?.windowLabel ?? "";
  const connectionBar = latestState?.connectionBar ?? "disconnected";
  windowLabel.textContent = visibleWindowLabelText(visibleWindowLabel);
  label.textContent = pane.label.toUpperCase();
  projectConnectionChrome(
    { disconnectedGlyph, paneLabel: label, windowLabel },
    connectionBar,
    Boolean(pane.label),
    Boolean(visibleWindowLabel),
  );
  const identityDescription = [
    visibleWindowLabel ? ` window ${visibleWindowLabel}` : null,
    pane.label ? `pane ${visibleAddress}` : null,
    !visibleWindowLabel || !pane.label ? "labels pending" : null,
  ].filter(Boolean).join(" ");
  const connectionError = latestState?.connectionError?.trim();
  const connectionDescription = connectionBar === "connected"
    ? null
    : connectionError ? `${connectionBar}: ${connectionError}` : connectionBar;
  const accessibleIdentity = pane.label
    ? `Surf Ace${visibleWindowLabel ? ` window ${visibleWindowLabel}` : ""} pane ${visibleAddress}`
    : `Surf Ace${visibleWindowLabel ? ` window ${visibleWindowLabel}` : ""}`;
  labelWrap.title = `${identityDescription}${connectionDescription ? ` ${connectionDescription}` : ""}`.trim() || "Surf Ace";
  labelWrap.setAttribute(
    "aria-label",
    [accessibleIdentity, !visibleWindowLabel || !pane.label ? "labels pending" : null, connectionDescription]
      .filter(Boolean).join(" "),
  );
  if (connectionError) labelWrap.setAttribute("aria-description", connectionError);
  else labelWrap.removeAttribute("aria-description");
  fitPaneLabelToVisibleBounds(view);
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

type ResizeGesture = {
  expected: { surfaceEpoch: string; topologyRevision: number; geometryRevision: number; layout: LayoutNode | null };
  path: number[];
  weights: number[];
  stop: () => void;
};
let resizeGesture: ResizeGesture | null = null;
let resizeCommitPending = false;
let resizeStatus = "";

function layoutNodeAt(node: LayoutNode | null, path: number[]): LayoutNode | null {
  for (const index of path) {
    if (node?.type !== "split") return null;
    node = node.children[index] ?? null;
  }
  return node;
}

function layoutIdentity(state: RendererWindowState): string {
  return JSON.stringify([state.surfaceId, state.surfaceEpoch, state.topologyRevision, state.geometryRevision, state.viewport, state.layout]);
}

function positionPaneHosts(): void {
  const wrapper = appRoot.firstElementChild as HTMLElement | null;
  const layer = wrapper?.querySelector(".pane-host-layer") as HTMLElement | null;
  if (!layer) return;
  const origin = layer.getBoundingClientRect();
  for (const slot of wrapper!.querySelectorAll<HTMLElement>(".pane-layout-slot")) {
    const view = paneViews.get(Number(slot.dataset.paneId));
    if (!view || !view.rootEl.isConnected) continue;
    if (view.paneId === poppedOutPaneId) continue;
    const rect = slot.getBoundingClientRect();
    Object.assign(view.rootEl.style, {
      left: `${rect.left - origin.left}px`, top: `${rect.top - origin.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
      borderTop: slot.dataset.borderTop ? "1px solid rgba(116, 141, 182, 0.14)" : "",
      borderLeft: slot.dataset.borderLeft ? "1px solid rgba(116, 141, 182, 0.14)" : "",
    });
  }
}

function updateSplitElement(split: HTMLElement, node: Extract<LayoutNode, { type: "split" }>): void {
  const children = [...split.children].filter((child) => !child.classList.contains("split-resize-handle")) as HTMLElement[];
  const handles = [...split.children].filter((child) => child.classList.contains("split-resize-handle")) as HTMLElement[];
  const total = node.children.reduce((sum, child) => sum + layoutWeight(child), 0);
  let cumulative = 0;
  node.children.forEach((child, index) => {
    children[index]!.style.flexGrow = String(layoutWeight(child));
    cumulative += layoutWeight(child);
    const handle = handles[index];
    if (handle) handle.style[node.direction === "vertical" ? "left" : "top"] = `${cumulative / total * 100}%`;
    if (child.type === "split") updateSplitElement(children[index]!, child);
  });
}

function refreshLayoutGeometry(): void {
  positionPaneHosts();
  setAllPaneChromeMetrics();
  refreshDynamicPaneFrames();
  if (!resizeGesture) reportAllPaneSnapshots();
}

function restoreCommittedLayout(): void {
  const node = latestState?.layout;
  const element = appRoot.querySelector(".layout-root")?.firstElementChild as HTMLElement | null;
  if (node?.type === "split" && element) updateSplitElement(element, node);
  refreshLayoutGeometry();
}

function cancelResizeGesture(): void {
  const gesture = resizeGesture;
  if (!gesture) return;
  resizeGesture = null;
  gesture.stop();
  restoreCommittedLayout();
  scheduleCompositorOverlayRegionReport("layout");
}

function showResizeStatus(): void {
  const wrapper = appRoot.firstElementChild;
  if (!wrapper) return;
  let status = wrapper.querySelector(".resize-status") as HTMLElement | null;
  if (!resizeStatus) { status?.remove(); return; }
  if (!status) {
    status = document.createElement("div");
    status.className = "resize-status";
    status.setAttribute("role", "status");
    wrapper.appendChild(status);
  }
  status.textContent = resizeStatus;
}

function attachResizeHandle(handle: HTMLElement, split: HTMLElement, _node: Extract<LayoutNode, { type: "split" }>, path: number[], index: number): void {
  handle.addEventListener("pointerdown", (event) => {
    if (poppedOutPaneId !== null || panePresentationTransitionsPending > 0 || panePresentationAuthorityBlocked ||
        resizeCommitPending || resizeGesture || !latestState) return;
    const node = layoutNodeAt(latestState.layout, path);
    if (node?.type !== "split") return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    resizeStatus = "";
    showResizeStatus();
    const initialIdentity = layoutIdentity(latestState);
    const start = node.direction === "vertical" ? event.clientX : event.clientY;
    const splitRect = split.getBoundingClientRect();
    const extent = node.direction === "vertical" ? splitRect.width : splitRect.height;
    const weights = node.children.map(layoutWeight);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const before = weights[index] ?? 1;
    const after = weights[index + 1] ?? 1;
    const pairTotal = before + after;
    const minWeight = Math.min(pairTotal / 2, Math.max(0.05, totalWeight * 0.05));
    let frame: number | null = null;
    const gesture: ResizeGesture = {
      expected: { surfaceEpoch: latestState.surfaceEpoch, topologyRevision: latestState.topologyRevision, geometryRevision: latestState.geometryRevision,
        layout: structuredClone(latestState.layout) },
      path: [...path], weights: [...weights], stop: () => {},
    };
    const updateWeights = (moveEvent: PointerEvent) => {
      const current = node.direction === "vertical" ? moveEvent.clientX : moveEvent.clientY;
      if (current === start) {
        gesture.weights[index] = before;
        gesture.weights[index + 1] = after;
        return;
      }
      const deltaWeight = extent > 0 ? ((current - start) / extent) * totalWeight : 0;
      const nextBefore = Math.min(Math.max(minWeight, before + deltaWeight), pairTotal - minWeight);
      gesture.weights[index] = nextBefore;
      gesture.weights[index + 1] = pairTotal - nextBefore;
    };
    const preview = () => {
      frame = null;
      if (resizeGesture !== gesture || !latestState || layoutIdentity(latestState) !== initialIdentity) return;
      const provisional = { ...node, children: node.children.map((child, i) => ({ ...child, weight: gesture.weights[i] })) };
      updateSplitElement(split, provisional);
      refreshLayoutGeometry();
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      updateWeights(moveEvent);
      if (frame === null) frame = window.requestAnimationFrame(preview);
    };
    const cancel = () => cancelResizeGesture();
    const onKey = (key: KeyboardEvent) => { if (key.key === "Escape") cancel(); };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== event.pointerId || resizeGesture !== gesture) return;
      if (poppedOutPaneId !== null || panePresentationTransitionsPending > 0 || panePresentationAuthorityBlocked) {
        cancelResizeGesture();
        return;
      }
      updateWeights(upEvent);
      // Measure final flex geometry without publishing provisional snapshots or topology.
      const finalNode = { ...node, children: node.children.map((child, i) => ({ ...child, weight: gesture.weights[i] })) };
      updateSplitElement(split, finalNode);
      refreshLayoutGeometry();
      const geometry = latestState!.panes.map((pane) => ({ paneId: pane.paneId, bounds: tiledPaneBounds(paneViews.get(pane.paneId)!) }));
      resizeGesture = null;
      gesture.stop();
      // Restore authoritative bounds before sending the one final mutation.
      restoreCommittedLayout();
      if (gesture.weights.every((weight, i) => Math.abs(weight - weights[i]!) < 1e-9)) return;
      resizeCommitPending = true;
      void window.surfAce.resizeSplit({ path: gesture.path, weights: gesture.weights, expected: gesture.expected, geometry })
        .then((ok) => { resizeStatus = ok ? "" : "Resize couldn’t be confirmed"; })
        .catch(() => { resizeStatus = "Resize couldn’t be confirmed"; })
        .finally(() => {
          resizeCommitPending = false;
          restoreCommittedLayout();
          showResizeStatus();
          scheduleCompositorOverlayRegionReport("layout");
        });
    };
    gesture.stop = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onKey);
      handle.removeEventListener("lostpointercapture", cancel);
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    resizeGesture = gesture;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKey);
    handle.addEventListener("lostpointercapture", cancel);
  });
}

function renderLayout(node: LayoutNode, panesById: Map<number, RendererPaneState>, path: number[] = []): HTMLElement {
  if (node.type === "pane") {
    const view = ensurePaneView(node.paneId);
    view.slotEl.className = "pane-slot pane-layout-slot";
    view.slotEl.dataset.paneId = String(node.paneId);
    view.slotEl.style.flexGrow = String(layoutWeight(node));
    return view.slotEl;
  }
  const split = document.createElement("div");
  split.className = `layout-split direction-${node.direction}`;
  split.style.flexGrow = String(layoutWeight(node));
  for (const [index, child] of node.children.entries()) {
    const childEl = renderLayout(child, panesById, [...path, index]);
    if (index > 0 && child.type === "pane") {
      childEl.dataset[node.direction === "vertical" ? "borderLeft" : "borderTop"] = "true";
    }
    split.appendChild(childEl);
    if (index < node.children.length - 1) {
      const handle = document.createElement("div");
      handle.className = `split-resize-handle split-resize-handle-${node.direction}`;
      attachResizeHandle(handle, split, node, path, index);
      split.appendChild(handle);
    }
  }
  updateSplitElement(split, node);
  return split;
}

function layoutKey(state: RendererWindowState): string {
  const shape = (node: LayoutNode | null): unknown => node?.type === "split"
    ? [node.direction, node.children.map(shape)] : node?.type === "pane" ? node.paneId : null;
  return JSON.stringify([state.surfaceId, state.surfaceEpoch, shape(state.layout)]);
}

function chromeKey(state: RendererWindowState): string {
  return JSON.stringify({
    capabilityStatus: state.capabilityStatus ?? null,
    connectionBar: state.connectionBar,
    connectionError: state.connectionError ?? null,
    windowLabel: state.windowLabel,
  });
}

function updateConnectionErrorBanner(wrapper: HTMLElement, state: RendererWindowState): void {
  let banner = wrapper.querySelector(".connection-status-banner") as HTMLDivElement | null;
  const registryMessage = state.connectionBar === "connected" ? "" : state.connectionError?.trim() ?? "";
  const message = [state.capabilityStatus, registryMessage && `Registry ${state.connectionBar}: ${registryMessage}`]
    .filter(Boolean).join(" · ");
  if (!message) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "connection-status-banner";
    banner.setAttribute("role", "status");
    wrapper.appendChild(banner);
  }
  banner.textContent = message;
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
  updateConnectionErrorBanner(wrapper, state);
  const layoutChanged = JSON.stringify(previousState.layout) !== JSON.stringify(state.layout);
  const split = wrapper.querySelector(".layout-root")?.firstElementChild as HTMLElement | null;
  if (state.layout?.type === "split" && split && !resizeGesture) updateSplitElement(split, state.layout);
  const nextChromeKey = chromeKey(state);
  const chromeStateChanged = latestChromeKey !== nextChromeKey;
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
    view.rootEl.classList.toggle("keyboard-active", pane.activeKeyboardPane);
    if (chromeStateChanged || paneRenderKey(previousState, previousPane) !== paneRenderKey(state, pane)) {
      updatePane(view, pane);
      patchedPaneCount += 1;
    }
  }
  latestChromeKey = nextChromeKey;
  if (viewportChanged || layoutChanged || previousState.geometryRevision !== state.geometryRevision) {
    positionPaneHosts();
    if (poppedOutPaneId !== null) {
      const selected = paneViews.get(poppedOutPaneId);
      panePresentationResizePending = true;
      applyPanePopOut();
      if (selected) void requestPanePopOut(selected, selected.paneId);
    }
    setAllPaneChromeMetrics();
    refreshDynamicPaneFrames();
    reportAllPaneSnapshots();
    window.requestAnimationFrame(() => {
      positionPaneHosts();
      setAllPaneChromeMetrics();
      refreshDynamicPaneFrames();
      reportAllPaneSnapshots();
    });
  }
  if (patchedPaneCount > 0) {
    for (const pane of state.panes) {
      const previousPane = previousPanes.get(pane.paneId);
      const view = paneViews.get(pane.paneId);
      if (previousPane && view && (chromeStateChanged || paneRenderKey(previousState, previousPane) !== paneRenderKey(state, pane))) {
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
  announceReachedHistoryEntries(state);
  const previousState = latestState;
  if (previousState && (previousState.surfaceId !== state.surfaceId ||
      previousState.surfaceEpoch !== state.surfaceEpoch ||
      previousState.topologyRevision !== state.topologyRevision ||
      layoutKey(previousState) !== layoutKey(state) ||
      (poppedOutPaneId !== null && !state.panes.some((pane) => pane.paneId === poppedOutPaneId &&
        pane.paneLineageId === previousState.panes.find((previous) => previous.paneId === poppedOutPaneId)?.paneLineageId)))) {
    poppedOutPaneId = null;
    acknowledgedPopOutBounds = null;
    panePresentationResizePending = false;
    panePresentationIntent++;
    applyPanePopOut();
  }

  if (resizeGesture && previousState && layoutIdentity(previousState) !== layoutIdentity(state)) cancelResizeGesture();
  if (previousState) {
    latestState = state;
    if (patchSameLayoutWindow(previousState, state)) {
      return;
    }
  }
  latestState = state;
  latestLayoutKey = layoutKey(state);
  latestChromeKey = chromeKey(state);
  const panesById = new Map(state.panes.map((pane) => [pane.paneId, pane]));
  let wrapper = appRoot.firstElementChild as HTMLDivElement | null;
  if (!wrapper?.classList.contains("surface-window")) {
    wrapper = document.createElement("div");
    wrapper.className = "surface-window";
    const layoutRoot = document.createElement("div");
    layoutRoot.className = "layout-root";
    const hosts = document.createElement("div");
    hosts.className = "pane-host-layer";
    wrapper.append(layoutRoot, hosts);
    appRoot.replaceChildren(wrapper);
  }
  wrapper.className = `surface-window connection-${state.connectionBar}`;
  updateConnectionErrorBanner(wrapper, state);
  const layoutRoot = wrapper.querySelector(".layout-root")!;
  const hosts = wrapper.querySelector(".pane-host-layer")!;
  // Only the cheap layout skeleton is rebuilt. Guest ancestors never move.
  layoutRoot.replaceChildren(...(state.layout ? [renderLayout(state.layout, panesById)] : []));
  for (const [id, view] of paneViews) {
    if (!panesById.has(id) || (previousState &&
        (previousState.surfaceEpoch !== state.surfaceEpoch || previousState.surfaceId !== state.surfaceId))) {
      resetDynamicContent(view);
      view.rootEl.remove();
      paneViews.delete(id);
    }
  }
  for (const pane of state.panes) {
    const view = ensurePaneView(pane.paneId);
    if (view.rootEl.parentElement !== hosts) hosts.appendChild(view.rootEl);
    const previousPane = previousState?.panes.find((previous) => previous.paneId === pane.paneId);
    if (!previousState || !previousPane || view.currentContentKey === "" ||
        paneRenderKey(previousState, previousPane) !== paneRenderKey(state, pane)) {
      updatePane(view, pane);
    } else {
      view.rootEl.classList.toggle("keyboard-active", pane.activeKeyboardPane);
    }
  }
  positionPaneHosts();
  showResizeStatus();
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
    positionPaneHosts();
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
    installProvenanceMetricObservers();
    latestState = bootstrap.state;
    renderWindow(bootstrap.state);
  } catch (error) {
    rendererDiagnostic("bootstrap_error", errorDiagnosticFields(error));
    throw error;
  }

  window.surfAce.onState((nextState) => {
    renderWindow(nextState as RendererWindowState);
  });

  window.surfAce.onPanePresentationOwnership((payload) => {
    if (!payload || typeof payload !== "object" || !latestState) return;
    const notice = payload as { surfaceId?: unknown; surfaceEpoch?: unknown; revision?: unknown; authorityRevision?: unknown; phase?: unknown };
    if (notice.surfaceId !== latestState.surfaceId || notice.surfaceEpoch !== latestState.surfaceEpoch ||
        !Number.isSafeInteger(notice.revision) || Number(notice.revision) <= 0 ||
        Number(notice.revision) < panePresentationMainRevision ||
        (notice.phase !== "blocked" && notice.phase !== "cleared")) return;
    if (notice.phase === "blocked" && Number(notice.revision) <= panePresentationConfirmedClearRevision) return;
    if (notice.authorityRevision !== undefined) {
      if (!Number.isSafeInteger(notice.authorityRevision) || Number(notice.authorityRevision) < panePresentationAuthorityRevision) return;
      if (notice.phase === "blocked" && Number(notice.authorityRevision) <= panePresentationAuthorityClearRevision) return;
      panePresentationAuthorityRevision = Number(notice.authorityRevision);
      if (notice.phase === "cleared") panePresentationAuthorityClearRevision = Number(notice.authorityRevision);
    }
    panePresentationMainRevision = Number(notice.revision);
    panePresentationIntent++;
    cancelResizeGesture();
    panePresentationAuthorityBlocked = notice.phase === "blocked";
    if (notice.phase === "cleared") {
      panePresentationConfirmedClearRevision = Number(notice.revision);
      poppedOutPaneId = null;
      acknowledgedPopOutBounds = null;
      panePresentationResizePending = false;
    } else {
      panePresentationResizePending = poppedOutPaneId !== null;
    }
    applyPanePopOut();
    setAllPaneChromeMetrics();
    refreshDynamicPaneFrames();
    reportAllPaneSnapshots();
    scheduleCompositorOverlayRegionReport("layout");
  });

  window.surfAce.onKeyboardIntent((intent) => {
    if (panePresentationResizePending) return;
    if (poppedOutPaneId !== null && intent && typeof intent === "object" &&
        "paneId" in intent && intent.paneId !== poppedOutPaneId) return;
    if (isKeyboardScrollIntent(intent)) {
      scrollPaneByKeyboard(intent);
      return;
    }
    if (isContentScaleIntent(intent)) {
      scalePaneContent(intent);
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (openFontSizePaneId === null) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".font-size-popover, .font-size-toggle")) {
      return;
    }
    const paneId = openFontSizePaneId;
    openFontSizePaneId = null;
    rebuildPaneControls(paneId);
  });

  window.addEventListener("resize", () => {
    if (poppedOutPaneId !== null) {
      panePresentationResizePending = true;
      panePresentationIntent++; // Retire any ack for the preceding window size.
      applyPanePopOut();
    }

    cancelResizeGesture();
    positionPaneHosts();
    refreshProvenanceWidths();
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
