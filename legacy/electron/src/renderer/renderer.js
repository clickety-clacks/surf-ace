const elements = {
  contentRoot: document.getElementById('content-root'),
  contentStage: document.getElementById('content-stage'),
  fingerprint: document.getElementById('fingerprint'),
  flushIndicator: document.getElementById('flush-indicator'),
  markupCanvas: document.getElementById('markup-canvas'),
  markupToggle: document.getElementById('markup-toggle'),
  screenName: document.getElementById('screen-name'),
  screenStatus: document.getElementById('screen-status'),
  standbyCard: document.getElementById('standby-card'),
  viewport: document.getElementById('viewport')
};

const state = {
  activeFrame: null,
  markupEnabled: false,
  pointerDown: null,
  renderedStrokes: [],
  scrollTimer: null,
  session: null,
  zoomLevel: 1
};

const markupCtx = elements.markupCanvas.getContext('2d');
let activeStroke = null;

function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function markdownToHtml(markdown) {
  const escaped = escapeHtml(markdown);
  const lines = escaped.split('\n');
  const rendered = lines.map((line) => {
    if (/^###\s+/.test(line)) {
      return `<h3>${line.replace(/^###\s+/, '')}</h3>`;
    }
    if (/^##\s+/.test(line)) {
      return `<h2>${line.replace(/^##\s+/, '')}</h2>`;
    }
    if (/^#\s+/.test(line)) {
      return `<h1>${line.replace(/^#\s+/, '')}</h1>`;
    }
    if (/^-\s+/.test(line)) {
      return `<li>${line.replace(/^-\s+/, '')}</li>`;
    }
    if (!line.trim()) {
      return '<p></p>';
    }

    let withInline = line
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');

    withInline = withInline.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
    return `<p>${withInline}</p>`;
  });

  return rendered.join('\n').replace(/(<li>.*<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`);
}

function setStatusLabel() {
  if (!state.session?.busy) {
    elements.screenStatus.textContent = 'Standby';
    return;
  }

  if (state.activeFrame) {
    elements.screenStatus.textContent = 'Displaying';
    return;
  }

  elements.screenStatus.textContent = 'Connected (idle)';
}

function clearRenderedStrokes() {
  state.renderedStrokes = [];
  markupCtx.clearRect(0, 0, elements.markupCanvas.width, elements.markupCanvas.height);
}

function renderStroke(stroke) {
  const points = stroke.points;
  if (!Array.isArray(points) || points.length === 0) {
    return;
  }

  markupCtx.beginPath();
  markupCtx.moveTo(points[0].x, points[0].y);

  if (points.length === 1) {
    markupCtx.lineTo(points[0].x + 0.001, points[0].y + 0.001);
  } else {
    for (let index = 1; index < points.length; index += 1) {
      markupCtx.lineTo(points[index].x, points[index].y);
    }
  }

  markupCtx.stroke();
}

function redrawAllStrokes() {
  markupCtx.clearRect(0, 0, elements.markupCanvas.width, elements.markupCanvas.height);
  for (const stroke of state.renderedStrokes) {
    renderStroke(stroke);
  }
}

function setFlushIndicatorVisible(visible) {
  if (!elements.flushIndicator) {
    return;
  }

  elements.flushIndicator.hidden = !visible;
  elements.flushIndicator.classList.toggle('visible', visible);
}

function renderFrame(frame) {
  const previousFrameId = state.activeFrame?.frameId || null;

  state.activeFrame = frame;
  elements.contentRoot.classList.toggle('content-root-html', frame?.contentType === 'html');
  elements.contentRoot.replaceChildren();

  const nextFrameId = frame?.frameId || null;
  if (previousFrameId !== nextFrameId) {
    clearRenderedStrokes();
  }

  if (!frame) {
    elements.contentStage.hidden = true;
    elements.standbyCard.hidden = false;
    setStatusLabel();
    emitSnapshot();
    return;
  }

  elements.contentStage.hidden = false;
  elements.standbyCard.hidden = true;

  if (frame.contentType === 'html') {
    const iframe = document.createElement('iframe');
    let hasLoadedOnce = false;
    const baseTag = frame.content.baseUrl
      ? `<base href="${escapeHtml(frame.content.baseUrl)}">`
      : '';
    iframe.style.height = '100%';

    iframe.srcdoc = `<!doctype html><html><head>${baseTag}
      <style>
        :root {
          --surf-ace-bg: #ffffff;
          --surf-ace-fg: #111111;
          --surf-ace-accent: #0468bf;
          --surf-ace-font-size: 18px;
          --surf-ace-width: 100%;
          --surf-ace-height: 100%;
        }
        html, body {
          margin: 0;
          padding: 0;
          min-height: 100%;
          background: var(--surf-ace-bg);
          color: var(--surf-ace-fg);
          font-size: var(--surf-ace-font-size);
          font-family: 'Avenir Next', 'Gill Sans', sans-serif;
        }
      </style>
    </head><body>${frame.content.html}</body></html>`;

    iframe.addEventListener('load', () => {
      try {
        const currentUrl = iframe.contentWindow?.location?.href || '';
        if (hasLoadedOnce && currentUrl && currentUrl !== 'about:srcdoc') {
          emitSurfaceEvent({
            event: 'navigation',
            url: currentUrl
          });
        }
      } catch {
        // Ignore cross-origin access errors and still refresh snapshot.
      }

      hasLoadedOnce = true;
      emitSnapshot();
    });

    elements.contentRoot.appendChild(iframe);
  } else if (frame.contentType === 'image') {
    const image = document.createElement('img');
    image.src = `data:${frame.content.mediaType};base64,${frame.content.data}`;
    image.alt = frame.content.alt || '';
    elements.contentRoot.appendChild(image);
  } else if (frame.contentType === 'markdown') {
    const wrapper = document.createElement('article');
    wrapper.className = 'markdown-frame';
    wrapper.innerHTML = markdownToHtml(frame.content.markdown);
    elements.contentRoot.appendChild(wrapper);
  } else if (frame.contentType === 'pdf') {
    const pdfFrame = document.createElement('iframe');
    pdfFrame.className = 'pdf-frame';
    pdfFrame.src = `data:application/pdf;base64,${frame.content.data}`;
    pdfFrame.title = frame.display?.title || 'Surf Ace PDF';
    elements.contentRoot.appendChild(pdfFrame);
  } else if (frame.contentType === 'terminal') {
    const terminal = document.createElement('pre');
    terminal.className = 'terminal-frame';
    terminal.textContent = frame.content.lines.join('\n');
    elements.contentRoot.appendChild(terminal);

    requestAnimationFrame(() => {
      elements.contentStage.scrollTop = elements.contentStage.scrollHeight;
    });
  } else {
    const unsupported = document.createElement('pre');
    unsupported.textContent = `Unsupported content type: ${frame.contentType}`;
    elements.contentRoot.appendChild(unsupported);
  }

  setStatusLabel();
  emitSnapshot();
}

function updateSession(session) {
  state.session = session;
  setStatusLabel();
}

function getViewportSnapshot() {
  const stage = elements.contentStage;
  const visibleRect = {
    height: stage.clientHeight,
    width: stage.clientWidth,
    x: stage.scrollLeft,
    y: stage.scrollTop
  };

  return {
    contentSize: {
      height: stage.scrollHeight,
      width: stage.scrollWidth
    },
    scrollOffset: {
      x: stage.scrollLeft,
      y: stage.scrollTop
    },
    visibleRect,
    zoomLevel: state.zoomLevel
  };
}

function getVisibleText() {
  if (!state.activeFrame) {
    return '';
  }

  if (state.activeFrame.contentType === 'image') {
    return (state.activeFrame.content.alt || '').slice(0, 4096);
  }

  if (state.activeFrame.contentType === 'html') {
    const iframe = elements.contentRoot.querySelector('iframe');
    const text = iframe?.contentDocument?.body?.innerText || '';
    return text.slice(0, 4096);
  }

  if (state.activeFrame.contentType === 'terminal') {
    return (state.activeFrame.content.lines || []).join('\n').slice(0, 4096);
  }

  if (state.activeFrame.contentType === 'pdf') {
    return (state.activeFrame.content.extractedText || '').slice(0, 4096);
  }

  return (elements.contentRoot.innerText || '').slice(0, 4096);
}

function windowSelectionSnapshot(selectionWindow) {
  const selection = selectionWindow.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const text = selection.toString().trim();
  if (!text) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const viewportRect = elements.viewport.getBoundingClientRect();
  const selectionWindowRect =
    selectionWindow === window
      ? { x: 0, y: 0 }
      : selectionWindow.frameElement?.getBoundingClientRect() || { x: 0, y: 0 };

  return {
    boundingRect: {
      height: rect.height,
      width: rect.width,
      x: rect.x + selectionWindowRect.x - viewportRect.x,
      y: rect.y + selectionWindowRect.y - viewportRect.y
    },
    kind: 'text',
    text: text.slice(0, 4096)
  };
}

function getSelectionSnapshot() {
  if (state.activeFrame?.contentType === 'html') {
    const iframe = elements.contentRoot.querySelector('iframe');
    const iframeWindow = iframe?.contentWindow;
    if (iframeWindow) {
      const iframeSelection = windowSelectionSnapshot(iframeWindow);
      if (iframeSelection) {
        return iframeSelection;
      }
    }
  }

  return windowSelectionSnapshot(window);
}

function buildSnapshot() {
  return {
    annotations: [],
    frameId: state.activeFrame?.frameId || null,
    selection: getSelectionSnapshot(),
    viewport: getViewportSnapshot(),
    visibleText: getVisibleText()
  };
}

function emitSnapshot() {
  window.surfAce.emitSnapshot(buildSnapshot());
}

function emitSurfaceEvent(payload) {
  if (!state.activeFrame) {
    return;
  }

  window.surfAce.emitSurfaceEvent({
    ...payload,
    timestamp: Date.now()
  });
}

function emitSelectionEvent() {
  const selection = getSelectionSnapshot();
  if (!selection) {
    return;
  }

  emitSurfaceEvent({
    event: 'selection',
    selection
  });
}

function updateViewportReport() {
  window.surfAce.emitViewport({
    height: window.innerHeight,
    scale: window.devicePixelRatio || 1,
    width: window.innerWidth
  });
}

function nearestTextFromEventTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return '';
  }

  return (target.innerText || target.textContent || '').trim().slice(0, 240);
}

function handlePointOrRegion(pointerEvent) {
  if (!state.pointerDown || state.markupEnabled || !state.activeFrame) {
    return;
  }

  const start = state.pointerDown;
  state.pointerDown = null;

  const end = {
    x: pointerEvent.clientX,
    y: pointerEvent.clientY
  };

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const viewportRect = elements.viewport.getBoundingClientRect();

  if (distance >= 12) {
    const rect = {
      height: Math.abs(dy),
      width: Math.abs(dx),
      x: Math.min(start.x, end.x) - viewportRect.x,
      y: Math.min(start.y, end.y) - viewportRect.y
    };

    emitSurfaceEvent({
      event: 'selection',
      selection: {
        kind: 'region',
        rect,
        text: getVisibleText()
      }
    });
    return;
  }

  emitSurfaceEvent({
    event: 'tap',
    kind: 'tap',
    nearestContent: nearestTextFromEventTarget(pointerEvent.target),
    position: {
      x: end.x - viewportRect.x,
      y: end.y - viewportRect.y
    }
  });
}

function scheduleScrollEvent() {
  if (state.scrollTimer) {
    clearTimeout(state.scrollTimer);
  }

  state.scrollTimer = setTimeout(() => {
    state.scrollTimer = null;
    emitSurfaceEvent({
      event: 'scroll',
      viewport: getViewportSnapshot(),
      visibleText: getVisibleText()
    });
  }, 120);
}

function resizeMarkupCanvas() {
  const rect = elements.markupCanvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;

  elements.markupCanvas.width = Math.max(1, Math.floor(rect.width * ratio));
  elements.markupCanvas.height = Math.max(1, Math.floor(rect.height * ratio));

  markupCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  markupCtx.lineWidth = 2.2;
  markupCtx.lineCap = 'round';
  markupCtx.lineJoin = 'round';
  markupCtx.strokeStyle = '#eb4f14';

  redrawAllStrokes();
}

function toolForPointerType(pointerType) {
  if (pointerType === 'pen') {
    return 'pencil';
  }
  if (pointerType === 'touch') {
    return 'finger';
  }
  return 'mouse';
}

function pointFromEvent(event) {
  const rect = elements.markupCanvas.getBoundingClientRect();
  return {
    pressure: event.pressure > 0 ? event.pressure : undefined,
    timestamp: Date.now(),
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function drawStrokePoint(stroke, point) {
  const points = stroke.points;
  if (points.length === 1) {
    markupCtx.beginPath();
    markupCtx.moveTo(point.x, point.y);
    markupCtx.lineTo(point.x + 0.001, point.y + 0.001);
    markupCtx.stroke();
    return;
  }

  const previous = points[points.length - 2];
  markupCtx.beginPath();
  markupCtx.moveTo(previous.x, previous.y);
  markupCtx.lineTo(point.x, point.y);
  markupCtx.stroke();
}

function generateStrokeId() {
  const randomBytes = new Uint8Array(12);
  window.crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `stroke_${hex}`;
}

function enableMarkup(enabled) {
  state.markupEnabled = enabled;
  elements.markupCanvas.classList.toggle('enabled', enabled);
  elements.markupToggle.classList.toggle('enabled', enabled);
  elements.markupToggle.textContent = enabled ? 'Markup On' : 'Markup Off';
}

function applyAnnotationsRemove(payload) {
  const strokeIds = Array.isArray(payload?.strokeIds) ? payload.strokeIds : [];
  if (strokeIds.length === 0) {
    return;
  }

  const toRemove = new Set(strokeIds);
  state.renderedStrokes = state.renderedStrokes.filter((stroke) => !toRemove.has(stroke.strokeId));
  redrawAllStrokes();
}

function bindEvents() {
  elements.markupToggle.addEventListener('click', () => {
    enableMarkup(!state.markupEnabled);
  });

  elements.contentStage.addEventListener('scroll', () => {
    emitSnapshot();
    scheduleScrollEvent();
  });

  elements.contentStage.addEventListener('mouseup', () => {
    emitSelectionEvent();
    emitSnapshot();
  });

  elements.contentStage.addEventListener('pointerdown', (event) => {
    if (state.markupEnabled || event.button !== 0) {
      return;
    }

    state.pointerDown = {
      x: event.clientX,
      y: event.clientY
    };
  });

  elements.contentStage.addEventListener('pointerup', (event) => {
    handlePointOrRegion(event);
    emitSnapshot();
  });

  elements.contentStage.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();
      const next = state.zoomLevel + (event.deltaY < 0 ? 0.1 : -0.1);
      state.zoomLevel = Math.min(3, Math.max(0.5, Number(next.toFixed(2))));
      elements.contentRoot.style.transform = `scale(${state.zoomLevel})`;
      elements.contentRoot.style.transformOrigin = 'top left';
      emitSnapshot();
    },
    { passive: false }
  );

  elements.markupCanvas.addEventListener('pointerdown', (event) => {
    if (!state.markupEnabled || event.button !== 0) {
      return;
    }

    activeStroke = {
      points: [],
      tool: toolForPointerType(event.pointerType)
    };

    const point = pointFromEvent(event);
    activeStroke.points.push(point);
    drawStrokePoint(activeStroke, point);

    elements.markupCanvas.setPointerCapture(event.pointerId);
  });

  elements.markupCanvas.addEventListener('pointermove', (event) => {
    if (!state.markupEnabled || !activeStroke) {
      return;
    }

    const point = pointFromEvent(event);
    activeStroke.points.push(point);
    drawStrokePoint(activeStroke, point);
  });

  const finishStroke = (event) => {
    if (!state.markupEnabled || !activeStroke) {
      return;
    }

    const stroke = activeStroke;
    activeStroke = null;

    if (stroke.points.length > 0) {
      const committedStroke = {
        points: stroke.points,
        strokeId: generateStrokeId(),
        tool: stroke.tool
      };

      state.renderedStrokes.push(committedStroke);
      window.surfAce.emitStrokeCommitted({
        ...committedStroke,
        frameId: state.activeFrame?.frameId || null,
        revision: state.activeFrame?.revision || null,
        timestamp: Date.now()
      });
    }

    if (event.pointerId) {
      elements.markupCanvas.releasePointerCapture(event.pointerId);
    }
  };

  elements.markupCanvas.addEventListener('pointerup', finishStroke);
  elements.markupCanvas.addEventListener('pointercancel', finishStroke);

  window.addEventListener('resize', () => {
    resizeMarkupCanvas();
    emitSnapshot();
    updateViewportReport();
  });
}

async function init() {
  bindEvents();
  resizeMarkupCanvas();

  const bootstrap = await window.surfAce.getBootstrap();
  elements.screenName.textContent = bootstrap.screenName;
  elements.fingerprint.textContent = `pk ${bootstrap.fingerprint}`;

  updateSession(bootstrap.session || { busy: false });
  renderFrame(bootstrap.frame || null);

  window.surfAce.onSession((session) => {
    updateSession(session);
  });

  window.surfAce.onFrame((frame) => {
    renderFrame(frame);
  });

  window.surfAce.onAnnotationsRemove((payload) => {
    applyAnnotationsRemove(payload);
  });

  window.surfAce.onFlushIndicator((payload) => {
    setFlushIndicatorVisible(Boolean(payload?.visible));
  });

  emitSnapshot();
  updateViewportReport();

  setInterval(() => {
    emitSnapshot();
  }, 1000);
}

init().catch((error) => {
  console.error('Failed to initialize renderer:', error);
});
