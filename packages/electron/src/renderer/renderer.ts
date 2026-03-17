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

type RendererPaneState = {
  annotationBorderVisible: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  content: {
    content:
      | null
      | { alt?: string; data: string; mediaType: string }
      | { data: string }
      | { html: string; baseUrl?: string }
      | { lines: string[]; scrollback: number }
      | { markdown: string };
    contentId: string | null;
    contentType: "html" | "image" | "markdown" | "pdf" | "terminal" | null;
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
  layout: LayoutNode;
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

type PaneView = {
  annotationCanvas: HTMLCanvasElement;
  contentEl: HTMLElement;
  controlsEl: HTMLDivElement;
  currentContentKey: string;
  currentDrawingsKey: string;
  currentScrollHandler: (() => void) | null;
  currentWebView: Electron.WebviewTag | null;
  paneId: number;
  rootEl: HTMLDivElement;
  scrollEl: HTMLDivElement;
  toastTimeout: number | null;
};

const appRoot = document.querySelector("#app") as HTMLDivElement;
const paneViews = new Map<number, PaneView>();
let bootstrap: Bootstrap | null = null;
let latestState: RendererWindowState | null = null;
let labelsHideTimer: number | null = null;

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

function reportPaneSnapshot(view: PaneView): void {
  const paneRect = view.rootEl.getBoundingClientRect();
  const visibleText = currentVisibleText(view);
  const selection = currentSelectionWithin(view);
  const viewport = currentViewport(view);
  window.surfAce.reportSnapshot({
    bounds: {
      height: paneRect.height,
      width: paneRect.width,
      x: paneRect.x,
      y: paneRect.y,
    },
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

function currentVisibleText(view: PaneView): string {
  const webview = view.currentWebView;
  if (webview) {
    return "";
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

  canvas.addEventListener("pointerdown", (event) => {
    const paneState = latestState?.panes.find((pane) => pane.paneId === view.paneId);
    if (!paneState?.annotationBorderVisible || event.button !== 0) {
      return;
    }
    activeStroke = {
      points: [pointFromEvent(event)],
      strokeId: `stroke_${crypto.getRandomValues(new Uint32Array(3)).join("")}`,
      tool: event.pointerType === "pen" ? "pencil" : event.pointerType === "touch" ? "finger" : "mouse",
    };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!activeStroke) {
      return;
    }
    activeStroke.points.push(pointFromEvent(event));
    redrawDrawings(view, [...(latestState?.panes.find((pane) => pane.paneId === view.paneId)?.drawings ?? []), activeStroke]);
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
    const pane = latestState?.panes.find((entry) => entry.paneId === view.paneId);
    redrawDrawings(view, pane?.drawings ?? []);
  };

  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
}

function attachCommonEvents(view: PaneView): void {
  view.rootEl.addEventListener("pointermove", scheduleLabelsHide, { passive: true });
  view.controlsEl.addEventListener("mouseenter", () => {
    document.body.classList.remove("labels-hidden");
  });
  view.scrollEl.addEventListener("scroll", () => {
    reportPaneSnapshot(view);
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

  rootEl.append(scrollEl, canvas, labelEl, controlsEl, toastEl);

  const view: PaneView = {
    annotationCanvas: canvas,
    contentEl,
    controlsEl,
    currentContentKey: "",
    currentDrawingsKey: "",
    currentScrollHandler: null,
    currentWebView: null,
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
  if (pane.showDone) {
    const done = createButton("Done", "done");
    done.addEventListener("click", () => {
      window.surfAce.command({ enabled: false, paneId: pane.paneId, type: "annotate" });
    });
    view.controlsEl.appendChild(done);
    return;
  }

  const back = createButton("◀", "back", !pane.canGoBack);
  back.addEventListener("click", () => {
    window.surfAce.command({ direction: "back", paneId: pane.paneId, type: "history" });
  });
  const forward = createButton("▶", "forward", !pane.canGoForward);
  forward.addEventListener("click", () => {
    window.surfAce.command({ direction: "forward", paneId: pane.paneId, type: "history" });
  });
  const annotate = createButton("👆", "annotate");
  annotate.addEventListener("click", () => {
    window.surfAce.command({ enabled: true, paneId: pane.paneId, type: "annotate" });
  });
  view.controlsEl.append(back, forward, annotate);
}

function wireWebView(view: PaneView, pane: RendererPaneState, webview: Electron.WebviewTag): void {
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
        paneId: pane.paneId,
        type: "scroll",
        viewport: payload.viewport,
        visibleText: payload.visibleText,
      });
      window.surfAce.reportSnapshot({
        bounds: paneBounds(view),
        paneId: pane.paneId,
        selection: null,
        viewport: payload.viewport,
        visibleText: payload.visibleText,
      });
    } else if (payload.type === "selection") {
      window.surfAce.command({
        paneId: pane.paneId,
        selection: payload.selection ?? null,
        type: "selection",
      });
    } else if (payload.type === "tap") {
      window.surfAce.command({
        kind: payload.kind,
        nearestContent: payload.nearestContent,
        paneId: pane.paneId,
        position: payload.position,
        type: "tap",
      });
    } else if (payload.type === "ready") {
      window.surfAce.reportSnapshot({
        bounds: paneBounds(view),
        paneId: pane.paneId,
        selection: null,
        viewport: payload.viewport,
        visibleText: payload.visibleText,
      });
    }
  });

  webview.addEventListener("did-navigate", (event) => {
    if (pane.annotationBorderVisible) {
      return;
    }
    window.surfAce.command({ paneId: pane.paneId, type: "navigation", url: event.url });
  });
  webview.addEventListener("did-navigate-in-page", (event) => {
    if (pane.annotationBorderVisible) {
      return;
    }
    window.surfAce.command({ paneId: pane.paneId, type: "navigation", url: event.url });
  });
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

function renderPaneContent(view: PaneView, pane: RendererPaneState): void {
  const key = contentKey(pane);
  if (key === view.currentContentKey) {
    return;
  }

  view.currentContentKey = key;
  view.currentWebView = null;
  view.contentEl.className = `pane-content type-${pane.content.contentType ?? "empty"}`;
  view.contentEl.replaceChildren();

  if (!pane.content.contentType || !pane.content.content) {
    const empty = document.createElement("div");
    empty.className = "content-empty";
    empty.textContent = "Surface ready";
    view.contentEl.appendChild(empty);
    reportPaneSnapshot(view);
    return;
  }

  if (pane.content.contentType === "html") {
    const webview = document.createElement("webview");
    webview.className = "content-html-webview";
    webview.setAttribute("preload", bootstrap!.guestPreloadUrl);
    webview.src = `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><html><head>${
        pane.content.content.baseUrl ? `<base href="${pane.content.content.baseUrl}">` : ""
      }<style>html,body{margin:0;padding:0;font-family:"Avenir Next","Segoe UI",sans-serif;background:#fff;color:#111;}</style></head><body>${pane.content.content.html}</body></html>`,
    )}`;
    view.contentEl.appendChild(webview);
    view.currentWebView = webview;
    wireWebView(view, pane, webview);
    return;
  }

  if (pane.content.contentType === "image") {
    const image = document.createElement("img");
    image.className = "content-image";
    image.alt = pane.content.content.alt ?? "";
    image.src = `data:${pane.content.content.mediaType};base64,${pane.content.content.data}`;
    view.contentEl.appendChild(image);
    reportPaneSnapshot(view);
    return;
  }

  if (pane.content.contentType === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "content-pdf-frame";
    frame.src = `data:application/pdf;base64,${pane.content.content.data}`;
    frame.addEventListener("load", () => {
      reportPaneSnapshot(view);
      window.surfAce.reportPage({
        page: 1,
        paneId: pane.paneId,
        totalPages: 1,
      });
    });
    view.contentEl.appendChild(frame);
    return;
  }

  if (pane.content.contentType === "markdown") {
    const article = document.createElement("article");
    article.className = "content-markdown";
    article.innerHTML = markdownToHtml(pane.content.content.markdown);
    view.contentEl.appendChild(article);
    reportPaneSnapshot(view);
    return;
  }

  if (pane.content.contentType === "terminal") {
    const pre = document.createElement("pre");
    pre.className = "content-terminal";
    pre.textContent = pane.content.content.lines.join("\n");
    view.contentEl.appendChild(pre);
    reportPaneSnapshot(view);
  }
}

function updatePane(view: PaneView, pane: RendererPaneState): void {
  view.rootEl.classList.toggle("annotating", pane.annotationBorderVisible);
  view.rootEl.classList.toggle("flush-in-flight", pane.flushInFlight);
  view.annotationCanvas.classList.toggle("enabled", pane.annotationBorderVisible);
  const label = view.rootEl.querySelector(".pane-label span") as HTMLSpanElement;
  label.textContent = pane.label;
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
  const windowName = document.createElement("div");
  windowName.className = "window-name";
  windowName.textContent = state.name;
  const layoutRoot = document.createElement("div");
  layoutRoot.className = "layout-root";
  layoutRoot.appendChild(renderLayout(state.layout, panesById));
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
        reportPaneSnapshot(view);
      }
    }
  });

  window.addEventListener("pointermove", scheduleLabelsHide, { passive: true });
}

void init();
