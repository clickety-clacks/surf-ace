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

type ImageContent = { alt?: string; data: string; mediaType: string };
type PdfContent = { data: string };
type HtmlContent = { baseUrl?: string; html: string };
type TerminalContent = { lines: string[]; scrollback: number };
type MarkdownContent = { markdown: string };
type VideoContent = string;
type CanvasContent = "" | { color?: string; grid?: boolean };
type PaneContentValue =
  | null
  | CanvasContent
  | HtmlContent
  | ImageContent
  | MarkdownContent
  | PdfContent
  | TerminalContent
  | VideoContent;

type RendererPaneState = {
  annotationBorderVisible: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  content: {
    content: PaneContentValue;
    contentId: string | null;
    contentType: "canvas" | "html" | "image" | "markdown" | "pdf" | "terminal" | "video" | null;
    display?: { interactive?: boolean; scrollable?: boolean; title?: string };
    revision: number;
  };
  drawings: Stroke[];
  flushInFlight: boolean;
  label: string;
  paneId: number;
  showDone: boolean;
  toast: string | null;
};

type LayoutNode =
  | { paneId: number; type: "pane" }
  | { children: LayoutNode[]; direction: "horizontal" | "vertical"; type: "split" };

type RendererWindowState = {
  connectionBar: "connected" | "connecting" | "disconnected";
  layout: LayoutNode | null;
  name: string;
  panes: RendererPaneState[];
  surfaceId: string;
  viewport: { height: number; scale: number; width: number };
  windowLabel: string;
};

type Bootstrap = {
  guestPreloadUrl: string;
  state: RendererWindowState;
  surfaceId: string;
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
  currentRenderToken: number;
  currentScrollHandler: (() => void) | null;
  currentWebView: Electron.WebviewTag | null;
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
let labelsHideTimer: number | null = null;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownToHtml(markdown: string): string {
  const escaped = escapeHtml(markdown);
  const rendered = escaped.split("\n").map((line) => {
    if (!line.trim()) {
      return "<p></p>";
    }
    if (line.startsWith("# ")) {
      return `<h1>${line.slice(2)}</h1>`;
    }
    if (line.startsWith("## ")) {
      return `<h2>${line.slice(3)}</h2>`;
    }
    if (line.startsWith("### ")) {
      return `<h3>${line.slice(4)}</h3>`;
    }
    return `<p>${line
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>")}</p>`;
  });
  return rendered.join("");
}

function contentKey(pane: RendererPaneState): string {
  return `${pane.content.contentType ?? "empty"}:${pane.content.contentId ?? "none"}:${pane.content.revision}`;
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

function rememberPaneContext(paneId: number): void {
  if (paneId <= 0) {
    return;
  }
  window.surfAce.command({ paneId, type: "focus-pane" });
}

function scheduleLabelsHide(): void {
  document.body.classList.add("labels-hidden");
  if (labelsHideTimer) {
    window.clearTimeout(labelsHideTimer);
  }
  labelsHideTimer = window.setTimeout(() => {
    document.body.classList.remove("labels-hidden");
    labelsHideTimer = null;
  }, 900);
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
  if (view.currentWebView) {
    return "";
  }
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
  view.rootEl.addEventListener("pointermove", scheduleLabelsHide, { passive: true });
  view.controlsEl.addEventListener("mouseenter", () => {
    document.body.classList.remove("labels-hidden");
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
  labelEl.innerHTML = "<span></span>";
  const canvas = document.createElement("canvas");
  canvas.className = "annotation-layer";
  const controlsEl = document.createElement("div");
  controlsEl.className = "control-cluster";
  const toastEl = document.createElement("div");
  toastEl.className = "pane-toast";
  toastEl.hidden = true;

  rootEl.append(scrollEl, shieldEl, canvas, labelEl, controlsEl, toastEl);

  const view: PaneView = {
    annotationCanvas: canvas,
    annotationShield: shieldEl,
    contentEl,
    controlsEl,
    currentContentKey: "",
    currentDrawingsKey: "",
    currentRenderToken: 0,
    currentScrollHandler: null,
    currentWebView: null,
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
  const paneLabel = createButton(pane.label || `Pane ${pane.paneId}`, "pane-label-chip", true);

  const back = createButton("◀", "back", !pane.canGoBack);
  back.addEventListener("click", () => {
    rememberPaneContext(pane.paneId);
    window.surfAce.command({ direction: "back", paneId: pane.paneId, type: "history" });
  });
  const forward = createButton("▶", "forward", !pane.canGoForward);
  forward.addEventListener("click", () => {
    rememberPaneContext(pane.paneId);
    window.surfAce.command({ direction: "forward", paneId: pane.paneId, type: "history" });
  });
  const annotate = createButton("👆", "annotate");
  annotate.addEventListener("click", () => {
    rememberPaneContext(pane.paneId);
    window.surfAce.command({ enabled: true, paneId: pane.paneId, type: "annotate" });
  });
  annotate.classList.toggle("active", pane.showDone);

  view.controlsEl.append(paneLabel, back, forward, annotate);

  if (pane.showDone) {
    const done = createButton("Done", "done");
    done.addEventListener("click", () => {
      rememberPaneContext(pane.paneId);
      window.surfAce.command({ enabled: false, paneId: pane.paneId, type: "annotate" });
    });
    view.controlsEl.appendChild(done);
  }
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

function wireWebView(view: PaneView, paneId: number, webview: Electron.WebviewTag): void {
  webview.addEventListener("ipc-message", (event) => {
    if (event.channel !== "surf-ace-content") {
      return;
    }
    const [payload] = event.args as Array<Record<string, unknown>>;
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
  });

  const handleWillNavigate = (event: Event & { preventDefault?: () => void; url?: string }) => {
    const url = String(event.url ?? "");
    if (paneStateById(paneId)?.annotationBorderVisible) {
      event.preventDefault?.();
    }
    sendNavigationIntent(view, paneId, url);
  };

  webview.addEventListener("will-navigate", handleWillNavigate as EventListener);
  webview.addEventListener("will-frame-navigate", handleWillNavigate as EventListener);
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
  view.currentWebView = null;
  view.currentScrollHandler = null;
  view.rootEl.dataset.pdfReportKey = "";
  view.contentEl.replaceChildren();
  return view.currentRenderToken;
}

function renderPaneContent(view: PaneView, pane: RendererPaneState): void {
  const key = contentKey(pane);
  if (key === view.currentContentKey) {
    return;
  }

  view.currentContentKey = key;
  const renderToken = resetDynamicContent(view);
  view.contentEl.className = `pane-content type-${pane.content.contentType ?? "empty"}`;

  if (!pane.content.contentType || pane.content.content === null) {
    renderCenteredState(view, "Surface ready");
    return;
  }

  if (pane.content.contentType === "html") {
    const html = pane.content.content as HtmlContent;
    const webview = document.createElement("webview");
    webview.className = "content-html-webview";
    webview.setAttribute("preload", bootstrap!.guestPreloadUrl);
    webview.src = `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><html><head>${
        html.baseUrl ? `<base href="${html.baseUrl}">` : ""
      }<style>html,body{margin:0;padding:0;font-family:"Avenir Next","Segoe UI",sans-serif;background:#fff;color:#111;}</style></head><body>${html.html}</body></html>`,
    )}`;
    view.contentEl.appendChild(webview);
    view.currentWebView = webview;
    wireWebView(view, pane.paneId, webview);
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
    renderCenteredState(view, "Video", "No preview is available for this pane.");
    return;
  }

  if (pane.content.contentType === "canvas") {
    renderCenteredState(view, "Canvas", "No preview is available for this pane.");
  }
}

function updatePane(view: PaneView, pane: RendererPaneState): void {
  view.rootEl.classList.toggle("annotating", pane.annotationBorderVisible);
  view.rootEl.classList.toggle("flush-in-flight", pane.flushInFlight);
  view.annotationCanvas.classList.toggle("enabled", pane.annotationBorderVisible);
  view.annotationShield.classList.toggle("enabled", pane.annotationBorderVisible);
  const labelWrap = view.rootEl.querySelector(".pane-label") as HTMLDivElement;
  const label = labelWrap.querySelector("span") as HTMLSpanElement;
  label.textContent = pane.label;
  labelWrap.hidden = !pane.label;
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

function renderLayout(node: LayoutNode, panesById: Map<number, RendererPaneState>): HTMLElement {
  if (node.type === "pane") {
    const pane = panesById.get(node.paneId);
    if (!pane) {
      const fallback = document.createElement("div");
      return fallback;
    }
    const view = ensurePaneView(node.paneId);
    updatePane(view, pane);
    return view.rootEl;
  }
  const split = document.createElement("div");
  split.className = `layout-split direction-${node.direction}`;
  for (const child of node.children) {
    split.appendChild(renderLayout(child, panesById));
  }
  return split;
}

function renderWindow(state: RendererWindowState): void {
  latestState = state;
  const panesById = new Map(state.panes.map((pane) => [pane.paneId, pane]));
  const wrapper = document.createElement("div");
  wrapper.className = `surface-window connection-${state.connectionBar}`;
  const windowLabel = document.createElement("div");
  windowLabel.className = "window-label";
  windowLabel.textContent = state.windowLabel;
  windowLabel.hidden = !state.windowLabel;
  const windowName = document.createElement("div");
  windowName.className = "window-name";
  windowName.textContent = state.name;
  const layoutRoot = document.createElement("div");
  layoutRoot.className = "layout-root";
  if (state.layout) {
    layoutRoot.appendChild(renderLayout(state.layout, panesById));
  }
  wrapper.append(windowLabel, windowName, layoutRoot);
  appRoot.replaceChildren(wrapper);
}

async function init(): Promise<void> {
  bootstrap = (await window.surfAce.getBootstrap()) as Bootstrap;
  latestState = bootstrap.state;
  renderWindow(bootstrap.state);

  window.surfAce.onState((nextState) => {
    renderWindow(nextState as RendererWindowState);
  });

  window.addEventListener("resize", () => {
    if (!latestState) {
      return;
    }
    for (const pane of latestState.panes) {
      const view = paneViews.get(pane.paneId);
      if (view) {
        redrawDrawings(view, pane.drawings);
        view.currentScrollHandler?.();
        reportPaneSnapshot(view);
      }
    }
  });

  window.addEventListener("pointermove", scheduleLabelsHide, { passive: true });
}

void init();
