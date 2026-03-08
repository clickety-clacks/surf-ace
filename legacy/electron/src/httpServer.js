const crypto = require('node:crypto');
const http = require('node:http');
const { parseHTML } = require('linkedom');
const { WebSocket, WebSocketServer } = require('ws');

const { CONTENT_LIMITS, SUPPORTED_CONTENT_TYPES } = require('./constants');

const DEFAULT_WS_PATH = '/ws';
const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_VISIBLE_TEXT_BYTES = 4096;
const MAX_STROKE_POINTS_PER_FLUSH = 8192;
const MAX_DRAWING_FLUSH_BYTES = 2 * 1024 * 1024;
const DEFAULT_RESUME_GRACE_MS = 20_000;
const DEFAULT_PAIR_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DRAWING_FLUSH_CONFIG = {
  idleWindowMs: 8000,
  maxIntervalMs: 30000
};
const REQUEST_CACHE_LIMIT = 1024;
const SURF_READ_MAX_CLOSED_FRAMES = 5;
const SURF_READ_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024;
const SURF_READ_TAPS_LIMIT = 512;
const SURF_ALERT_RESET_MS = 10 * 60 * 1000;
const TRANSPARENT_PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9qNfzmQAAAABJRU5ErkJggg==';

const FRAME_ID_PATTERN = /^(?:ct|fr)_[0-9a-f]{8}$/;
const PROVIDER_ID_PATTERN = /^pv_[A-Za-z0-9._:-]{3,64}$/;
const CONNECTION_ID_PATTERN = /^cn_[A-Za-z0-9._:-]{3,64}$/;
const SESSION_ID_PATTERN = /^sa_[A-Za-z0-9._:-]{8,128}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const SURFACE_ID_PATTERN = /^sf_[A-Za-z0-9._:-]{3,64}$/;
const STROKE_ID_PATTERN = /^stroke_[0-9a-f]{6,64}$/;

const PATCH_ACTIONS = new Set([
  'replace_inner',
  'replace_outer',
  'insert_before',
  'insert_after',
  'remove'
]);

const EVENT_TYPES_BY_PROFILE = {
  deep_plus_scroll: [
    'event.drawing_flush',
    'event.tap',
    'event.selection',
    'event.page',
    'event.navigation',
    'event.snapshot_hint',
    'event.scroll'
  ],
  minimum_deep: [
    'event.drawing_flush',
    'event.tap',
    'event.selection',
    'event.page',
    'event.navigation',
    'event.snapshot_hint'
  ]
};

let pdfJsModulePromise = null;

function nowMs() {
  return Date.now();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPngBase64(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  const decoded = decodeBase64(value);
  if (!decoded || decoded.length < 8) {
    return false;
  }

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < pngSignature.length; index += 1) {
    if (decoded[index] !== pngSignature[index]) {
      return false;
    }
  }

  return true;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function byteLengthUtf8(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function decodeBase64(data) {
  try {
    const normalized = String(data).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      return null;
    }

    const decoded = Buffer.from(normalized, 'base64');
    if (decoded.length === 0 && normalized.length > 0) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function normalizedBase64Size(data) {
  return byteLengthUtf8(String(data).replace(/\s+/g, ''));
}

function normalizeNavigationUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function cloneStrokePoints(points) {
  if (!Array.isArray(points)) {
    return [];
  }

  return points.map((point) => ({
    ...(Number.isFinite(point.pressure) ? { pressure: point.pressure } : {}),
    x: Number(point.x),
    y: Number(point.y)
  }));
}

function strokeTimestamps(points) {
  let startedAt = null;
  let endedAt = null;

  for (const point of points) {
    if (!isInteger(point.timestamp)) {
      continue;
    }

    if (startedAt === null || point.timestamp < startedAt) {
      startedAt = point.timestamp;
    }

    if (endedAt === null || point.timestamp > endedAt) {
      endedAt = point.timestamp;
    }
  }

  return {
    endedAt: endedAt ?? nowMs(),
    startedAt: startedAt ?? nowMs()
  };
}

function strokeBoundingBox(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return {
      height: 0,
      width: 0,
      x: 0,
      y: 0
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return {
      height: 0,
      width: 0,
      x: 0,
      y: 0
    };
  }

  return {
    height: maxY - minY,
    width: maxX - minX,
    x: minX,
    y: minY
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sendJsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json'
  });
  res.end(body);
}

function errorBody(code, message, details) {
  const error = {
    code,
    message
  };

  if (isObject(details) && Object.keys(details).length > 0) {
    error.details = details;
  }

  return error;
}

function successResponse(op, id, payload) {
  return {
    id,
    ok: true,
    op,
    payload,
    sentAt: nowMs(),
    type: 'response',
    v: 1
  };
}

function failureResponse(op, id, code, message, details) {
  return {
    error: errorBody(code, message, details),
    id,
    ok: false,
    op,
    sentAt: nowMs(),
    type: 'response',
    v: 1
  };
}

function wsSendJson(ws, payload) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('socket_not_open'));
      return;
    }

    ws.send(JSON.stringify(payload), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function canonicalRequestSignature(message) {
  return `${message.op}|${JSON.stringify(message.payload ?? null)}`;
}

function validateRequestEnvelope(message) {
  if (!isObject(message)) {
    return false;
  }

  if (message.v !== 1 || message.type !== 'request') {
    return false;
  }

  if (typeof message.op !== 'string' || !REQUEST_ID_PATTERN.test(String(message.id || ''))) {
    return false;
  }

  if (!isInteger(message.sentAt) || !isObject(message.payload)) {
    return false;
  }

  return true;
}

function effectiveEventProfile(requestedProfile) {
  if (requestedProfile === 'deep_plus_scroll') {
    return 'deep_plus_scroll';
  }
  return 'minimum_deep';
}

function validateDrawingFlushConfig(input) {
  if (!isObject(input)) {
    return { value: { ...DEFAULT_DRAWING_FLUSH_CONFIG } };
  }

  const idleWindowMs = Number(input.idleWindowMs);
  const maxIntervalMs = Number(input.maxIntervalMs);

  if (!Number.isInteger(idleWindowMs) || idleWindowMs < 5000 || idleWindowMs > 10000) {
    return {
      error: errorBody(
        'invalid_payload',
        'drawingFlushConfig.idleWindowMs must be an integer between 5000 and 10000.'
      )
    };
  }

  if (!Number.isInteger(maxIntervalMs) || maxIntervalMs < 10000) {
    return {
      error: errorBody(
        'invalid_payload',
        'drawingFlushConfig.maxIntervalMs must be an integer >= 10000.'
      )
    };
  }

  return {
    value: {
      idleWindowMs,
      maxIntervalMs
    }
  };
}

function extractContentId(payload) {
  const contentId = payload?.contentId ?? payload?.frameId;
  if (!FRAME_ID_PATTERN.test(String(contentId || ''))) {
    return {
      error: errorBody('invalid_payload', 'payload.contentId is invalid.')
    };
  }

  return {
    value: contentId
  };
}

function validatePairPayload(payload) {
  if (!PROVIDER_ID_PATTERN.test(String(payload.providerId || ''))) {
    return {
      error: errorBody('invalid_payload', 'payload.providerId is invalid.')
    };
  }

  if (!CONNECTION_ID_PATTERN.test(String(payload.connectionId || ''))) {
    return {
      error: errorBody('invalid_payload', 'payload.connectionId is invalid.')
    };
  }

  if (payload.protocolVersion !== 1) {
    return {
      error: errorBody('unsupported_protocol_version', 'Only protocolVersion=1 is supported.')
    };
  }

  if (!SURFACE_ID_PATTERN.test(String(payload.surfaceId || ''))) {
    return {
      error: errorBody('invalid_payload', 'payload.surfaceId is invalid.')
    };
  }

  if (payload.resume !== undefined) {
    const resumeSessionId = payload.resume?.sessionId;
    if (!SESSION_ID_PATTERN.test(String(resumeSessionId || ''))) {
      return {
        error: errorBody('invalid_payload', 'payload.resume.sessionId is invalid.')
      };
    }
  }

  const drawingFlushConfig = validateDrawingFlushConfig(payload.drawingFlushConfig);
  if (drawingFlushConfig.error) {
    return drawingFlushConfig;
  }

  return {
    value: {
      connectionId: payload.connectionId,
      drawingFlushConfig: drawingFlushConfig.value,
      eventProfile: effectiveEventProfile(payload.eventProfile),
      providerId: payload.providerId,
      surfaceId: payload.surfaceId,
      takeOver: payload.takeover === true,
      resumeSessionId: payload.resume?.sessionId || null
    }
  };
}

function validateFrameSetPayload(payload) {
  const contentId = extractContentId(payload);
  if (contentId.error) {
    return contentId;
  }

  if (!isInteger(payload.revision)) {
    return {
      error: errorBody('invalid_payload', 'payload.revision must be a non-negative integer.')
    };
  }

  const { contentType } = payload;
  if (!SUPPORTED_CONTENT_TYPES.includes(contentType)) {
    return {
      error: errorBody('unsupported_content_type', `Unsupported contentType '${contentType}'.`)
    };
  }

  const content = payload.content;
  if (!isObject(content)) {
    return {
      error: errorBody('invalid_payload', 'payload.content must be an object.')
    };
  }

  const display = isObject(payload.display) ? payload.display : {};

  if (contentType === 'html') {
    const html = content.html;
    if (typeof html !== 'string') {
      return {
        error: errorBody('invalid_payload', 'content.html must be a string.')
      };
    }

    if (byteLengthUtf8(html) > CONTENT_LIMITS.htmlBytes || byteLengthUtf8(html) > MAX_FRAME_BYTES) {
      return {
        error: errorBody('content_too_large', 'HTML frame exceeds size limit.')
      };
    }

    return {
      value: {
        content: {
          baseUrl: typeof content.baseUrl === 'string' ? content.baseUrl : undefined,
          html
        },
        contentType,
        display,
        frameId: contentId.value,
        revision: payload.revision
      }
    };
  }

  if (contentType === 'image') {
    if (typeof content.data !== 'string' || typeof content.mediaType !== 'string') {
      return {
        error: errorBody('invalid_payload', 'Image content requires data and mediaType strings.')
      };
    }

    if (
      normalizedBase64Size(content.data) > CONTENT_LIMITS.imageBytes ||
      normalizedBase64Size(content.data) > MAX_FRAME_BYTES
    ) {
      return {
        error: errorBody('content_too_large', 'Image frame exceeds size limit.')
      };
    }

    if (!decodeBase64(content.data)) {
      return {
        error: errorBody('invalid_payload', 'Image content.data must be valid base64.')
      };
    }

    return {
      value: {
        content: {
          alt: typeof content.alt === 'string' ? content.alt : '',
          data: content.data,
          mediaType: content.mediaType
        },
        contentType,
        display,
        frameId: contentId.value,
        revision: payload.revision
      }
    };
  }

  if (contentType === 'pdf') {
    if (typeof content.data !== 'string') {
      return {
        error: errorBody('invalid_payload', 'PDF content requires data string.')
      };
    }

    if (
      normalizedBase64Size(content.data) > CONTENT_LIMITS.pdfBytes ||
      normalizedBase64Size(content.data) > MAX_FRAME_BYTES
    ) {
      return {
        error: errorBody('content_too_large', 'PDF frame exceeds size limit.')
      };
    }

    if (!decodeBase64(content.data)) {
      return {
        error: errorBody('invalid_payload', 'PDF content.data must be valid base64.')
      };
    }

    return {
      value: {
        content: {
          data: content.data
        },
        contentType,
        display,
        frameId: contentId.value,
        revision: payload.revision
      }
    };
  }

  if (contentType === 'terminal') {
    const lines = content.lines;
    const scrollback = content.scrollback;

    if (!Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
      return {
        error: errorBody('invalid_payload', 'Terminal content.lines must be an array of strings.')
      };
    }

    if (!Number.isInteger(scrollback) || scrollback < 0) {
      return {
        error: errorBody('invalid_payload', 'Terminal content.scrollback must be an integer >= 0.')
      };
    }

    if (lines.length > CONTENT_LIMITS.maxTerminalLines || scrollback > CONTENT_LIMITS.maxTerminalLines) {
      return {
        error: errorBody('content_too_large', 'Terminal frame exceeds 10,000 line limit.')
      };
    }

    return {
      value: {
        content: {
          lines,
          scrollback
        },
        contentType,
        display,
        frameId: contentId.value,
        revision: payload.revision
      }
    };
  }

  if (typeof content.markdown !== 'string') {
    return {
      error: errorBody('invalid_payload', 'Markdown content.markdown must be a string.')
    };
  }

  if (byteLengthUtf8(content.markdown) > CONTENT_LIMITS.markdownBytes) {
    return {
      error: errorBody('content_too_large', 'Markdown frame exceeds size limit.')
    };
  }

  return {
    value: {
      content: { markdown: content.markdown },
      contentType,
      display,
      frameId: contentId.value,
      revision: payload.revision
    }
  };
}

function validateFrameAppendPayload(payload) {
  const contentId = extractContentId(payload);
  if (contentId.error) {
    return contentId;
  }

  if (!isInteger(payload.revision)) {
    return {
      error: errorBody('invalid_payload', 'payload.revision must be a non-negative integer.')
    };
  }

  if (!Array.isArray(payload.lines) || payload.lines.some((line) => typeof line !== 'string')) {
    return {
      error: errorBody('invalid_payload', 'payload.lines must be an array of strings.')
    };
  }

  return {
    value: {
      frameId: contentId.value,
      lines: payload.lines,
      revision: payload.revision
    }
  };
}

function validateFramePatchPayload(payload) {
  const contentId = extractContentId(payload);
  if (contentId.error) {
    return contentId;
  }

  if (!isInteger(payload.revision)) {
    return {
      error: errorBody('invalid_payload', 'payload.revision must be a non-negative integer.')
    };
  }

  if (!isObject(payload.patch)) {
    return {
      error: errorBody('invalid_payload', 'payload.patch must be an object.')
    };
  }

  const { action, html, selector } = payload.patch;
  if (!PATCH_ACTIONS.has(action)) {
    return {
      error: errorBody('invalid_payload', 'payload.patch.action is invalid.')
    };
  }

  if (typeof selector !== 'string' || !selector.trim()) {
    return {
      error: errorBody('invalid_payload', 'payload.patch.selector must be a non-empty string.')
    };
  }

  if (action !== 'remove' && typeof html !== 'string') {
    return {
      error: errorBody('invalid_payload', 'payload.patch.html must be a string for this patch action.')
    };
  }

  return {
    value: {
      frameId: contentId.value,
      patch: {
        action,
        html,
        selector
      },
      revision: payload.revision
    }
  };
}

function validateFrameClearPayload(payload) {
  if (!isInteger(payload.revision)) {
    return {
      error: errorBody('invalid_payload', 'payload.revision must be a non-negative integer.')
    };
  }

  return {
    value: {
      revision: payload.revision
    }
  };
}

function validateAnnotationsRemovePayload(payload) {
  const contentId = extractContentId(payload);
  if (contentId.error) {
    return contentId;
  }

  if (!Array.isArray(payload.strokeIds) || payload.strokeIds.length === 0) {
    return {
      error: errorBody('invalid_payload', 'payload.strokeIds must be a non-empty array.')
    };
  }

  const unique = new Set();
  for (const strokeId of payload.strokeIds) {
    if (!STROKE_ID_PATTERN.test(String(strokeId || ''))) {
      return {
        error: errorBody('invalid_payload', 'payload.strokeIds contains an invalid strokeId.')
      };
    }

    unique.add(strokeId);
  }

  return {
    value: {
      frameId: contentId.value,
      strokeIds: [...unique]
    }
  };
}

function validateSnapshotGetPayload(payload) {
  if (!isObject(payload)) {
    return {
      error: errorBody('invalid_payload', 'payload must be an object.')
    };
  }

  for (const key of ['includeImage', 'includeVisibleText', 'includeDrawings']) {
    if (payload[key] !== undefined && typeof payload[key] !== 'boolean') {
      return {
        error: errorBody('invalid_payload', `payload.${key} must be boolean when provided.`)
      };
    }
  }

  return {
    value: {
      includeDrawings: payload.includeDrawings === true,
      includeImage: payload.includeImage === true,
      includeVisibleText: payload.includeVisibleText !== false
    }
  };
}

function validateHeartbeatPingPayload(payload) {
  if (typeof payload.nonce !== 'string' || payload.nonce.length === 0) {
    return {
      error: errorBody('invalid_payload', 'payload.nonce must be a non-empty string.')
    };
  }

  return {
    value: {
      nonce: payload.nonce
    }
  };
}

function validateSurfAceReadPayload(payload) {
  if (!isObject(payload)) {
    return {
      error: errorBody('invalid_payload', 'payload must be an object.')
    };
  }

  if (payload.fingerprint !== undefined && typeof payload.fingerprint !== 'string') {
    return {
      error: errorBody('invalid_payload', 'payload.fingerprint must be a string when provided.')
    };
  }

  return {
    value: {
      fingerprint: typeof payload.fingerprint === 'string' ? payload.fingerprint : null
    }
  };
}

function fragmentFromHtml(document, html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;

  const fragment = document.createDocumentFragment();
  while (wrapper.firstChild) {
    fragment.appendChild(wrapper.firstChild);
  }

  return fragment;
}

function applyHtmlPatchToFrameContent(currentHtml, patch) {
  try {
    const { document } = parseHTML(
      `<!doctype html><html><body><div id="sa-root">${currentHtml}</div></body></html>`
    );
    const root = document.getElementById('sa-root');
    const target = root.querySelector(patch.selector);

    if (!target) {
      return {
        error: errorBody('render_failed', `No element matched selector '${patch.selector}'.`)
      };
    }

    switch (patch.action) {
      case 'replace_inner': {
        target.innerHTML = patch.html;
        break;
      }
      case 'replace_outer': {
        target.replaceWith(fragmentFromHtml(document, patch.html));
        break;
      }
      case 'insert_before': {
        target.before(fragmentFromHtml(document, patch.html));
        break;
      }
      case 'insert_after': {
        target.after(fragmentFromHtml(document, patch.html));
        break;
      }
      case 'remove': {
        target.remove();
        break;
      }
      default:
        return {
          error: errorBody('render_failed', 'Unsupported patch action.')
        };
    }

    return {
      html: root.innerHTML
    };
  } catch (error) {
    return {
      error: errorBody('render_failed', error.message || 'Failed to apply HTML patch.')
    };
  }
}

async function extractPdfText(base64Data) {
  try {
    if (!pdfJsModulePromise) {
      pdfJsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
    }

    const pdfjs = await pdfJsModulePromise;
    const pdfBuffer = Buffer.from(String(base64Data).replace(/\s+/g, ''), 'base64');
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      disableWorker: true
    });

    const document = await loadingTask.promise;
    const chunks = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .trim();

      if (pageText) {
        chunks.push(pageText);
      }

      if (chunks.join('\n').length > MAX_VISIBLE_TEXT_BYTES) {
        break;
      }
    }

    return chunks.join('\n').slice(0, MAX_VISIBLE_TEXT_BYTES);
  } catch {
    return '';
  }
}

class RequestIdCache {
  constructor(limit = REQUEST_CACHE_LIMIT) {
    this.limit = limit;
    this.map = new Map();
  }

  get(id) {
    return this.map.get(id);
  }

  set(id, value) {
    if (this.map.has(id)) {
      this.map.delete(id);
    }

    this.map.set(id, value);

    while (this.map.size > this.limit) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }
}

function createSessionId() {
  return `sa_${crypto.randomBytes(16).toString('hex')}`;
}

function createSurfAceWsServer({
  logger,
  onAnnotationsRemove,
  onClearFrame,
  onFlushIndicator,
  onFrame,
  onSession,
  pairRequestTimeoutMs = DEFAULT_PAIR_REQUEST_TIMEOUT_MS,
  port,
  resumeGraceMs = DEFAULT_RESUME_GRACE_MS,
  state,
  wsPath = DEFAULT_WS_PATH,
  captureSnapshotImage = async () => null
}) {
  const log = logger || console;
  const sockets = new Set();

  let activeSession = null;
  let resumeGraceTimer = null;
  let eventCounter = 0;
  let flushCounter = 0;

  const drawingFlushState = {
    dirty: false,
    inFlight: false,
    inFlightStrokeIds: [],
    idleTimer: null,
    lastStrokeAt: 0,
    lastSuccessfulSendAt: 0,
    maxTimer: null,
    pendingOrder: [],
    pendingSet: new Set()
  };
  const surfReadState = {
    alertFired: false,
    closedFrames: [],
    liveDirtySet: new Set(),
    liveDirtyStrokeIds: [],
    liveFrame: null,
    liveSeq: 0,
    overflowed: false,
    page: null,
    playbackPosition: null,
    playbackState: null,
    scrollPosition: null,
    selection: null,
    taps: [],
    lastNavigation: null
  };

  let alertResetTimer = null;
  let captureFrameCounter = 0;
  let navigationContextUrl = null;

  function clearResumeGraceTimer() {
    if (!resumeGraceTimer) {
      return;
    }

    clearTimeout(resumeGraceTimer);
    resumeGraceTimer = null;
  }

  function clearDrawingTimers() {
    if (drawingFlushState.idleTimer) {
      clearTimeout(drawingFlushState.idleTimer);
      drawingFlushState.idleTimer = null;
    }

    if (drawingFlushState.maxTimer) {
      clearTimeout(drawingFlushState.maxTimer);
      drawingFlushState.maxTimer = null;
    }
  }

  function resetDrawingFlushState({ clearPending = false } = {}) {
    clearDrawingTimers();

    drawingFlushState.inFlight = false;
    drawingFlushState.inFlightStrokeIds = [];

    if (clearPending) {
      drawingFlushState.dirty = false;
      drawingFlushState.lastStrokeAt = 0;
      drawingFlushState.lastSuccessfulSendAt = 0;
      drawingFlushState.pendingOrder = [];
      drawingFlushState.pendingSet.clear();
    }

    if (typeof onFlushIndicator === 'function') {
      onFlushIndicator(false);
    }
  }

  function clearAlertResetTimer() {
    if (!alertResetTimer) {
      return;
    }

    clearTimeout(alertResetTimer);
    alertResetTimer = null;
  }

  function armAlertResetTimer() {
    clearAlertResetTimer();
    alertResetTimer = setTimeout(() => {
      alertResetTimer = null;
      surfReadState.alertFired = false;
    }, SURF_ALERT_RESET_MS);
  }

  function markUnreadAnnotationActivity() {
    if (surfReadState.alertFired) {
      armAlertResetTimer();
      return;
    }

    surfReadState.alertFired = true;
    armAlertResetTimer();
  }

  function nextCaptureFrameId() {
    captureFrameCounter += 1;
    return `fr_${captureFrameCounter.toString(16).padStart(8, '0')}`;
  }

  function currentViewportAtFrameOpen() {
    const snapshotViewport = state.lastSnapshot?.viewport;
    const visibleRect = snapshotViewport?.visibleRect || {};
    const scrollOffset = snapshotViewport?.scrollOffset || {};

    return {
      scrollOffset: {
        x: Number.isFinite(scrollOffset.x) ? scrollOffset.x : 0,
        y: Number.isFinite(scrollOffset.y) ? scrollOffset.y : 0
      },
      viewport: {
        height: Number.isFinite(visibleRect.height) ? visibleRect.height : state.viewport.height,
        scale: Number(state.viewport.scale) || 1,
        width: Number.isFinite(visibleRect.width) ? visibleRect.width : state.viewport.width
      }
    };
  }

  function currentContextDescriptor() {
    const currentFrame = state.activeFrame;
    if (!currentFrame) {
      return null;
    }

    if (currentFrame.contentType === 'html' && navigationContextUrl) {
      return {
        contentId: currentFrame.frameId,
        contextKey: navigationContextUrl,
        url: navigationContextUrl
      };
    }

    return {
      contentId: currentFrame.frameId,
      contextKey: currentFrame.frameId
    };
  }

  async function captureFrameImageAtOpen() {
    const captured = await captureSnapshotImage();
    if (isPngBase64(captured)) {
      return captured;
    }

    return TRANSPARENT_PNG_1X1;
  }

  function finalizeLiveFrame() {
    if (!surfReadState.liveFrame) {
      return null;
    }

    const finalized = deepClone(surfReadState.liveFrame);
    surfReadState.closedFrames.push(finalized);
    surfReadState.liveFrame = null;
    surfReadState.liveDirtySet.clear();
    surfReadState.liveDirtyStrokeIds = [];
    markUnreadAnnotationActivity();
    return finalized;
  }

  async function ensureLiveFrameForCurrentContext(strokeTimestamp) {
    const context = currentContextDescriptor();
    if (!context) {
      return null;
    }

    if (surfReadState.liveFrame && surfReadState.liveFrame.contextKey !== context.contextKey) {
      finalizeLiveFrame();
    }

    if (surfReadState.liveFrame) {
      if (context.url) {
        surfReadState.liveFrame.url = context.url;
      } else {
        delete surfReadState.liveFrame.url;
      }
      return surfReadState.liveFrame;
    }

    const openedAt = isInteger(strokeTimestamp) ? strokeTimestamp : nowMs();
    const { scrollOffset, viewport } = currentViewportAtFrameOpen();
    const image = await captureFrameImageAtOpen();
    surfReadState.liveSeq = 0;
    surfReadState.liveFrame = {
      ...(context.url ? { url: context.url } : {}),
      contentId: context.contentId,
      contextKey: context.contextKey,
      frameId: nextCaptureFrameId(),
      image,
      openedAt,
      scrollOffset,
      strokes: [],
      updatedAt: openedAt,
      viewport
    };
    surfReadState.liveDirtySet.clear();
    surfReadState.liveDirtyStrokeIds = [];
    return surfReadState.liveFrame;
  }

  function appendStrokeToLiveFrame(stroke) {
    if (!surfReadState.liveFrame) {
      return;
    }

    const timestamps = strokeTimestamps(stroke.points);
    const liveStroke = {
      bbox: strokeBoundingBox(stroke.points),
      endedAt: timestamps.endedAt,
      points: cloneStrokePoints(stroke.points),
      startedAt: timestamps.startedAt,
      strokeId: stroke.strokeId
    };
    surfReadState.liveFrame.strokes.push(liveStroke);
    surfReadState.liveFrame.updatedAt = Math.max(
      surfReadState.liveFrame.updatedAt || 0,
      liveStroke.endedAt
    );

    if (!surfReadState.liveDirtySet.has(liveStroke.strokeId)) {
      surfReadState.liveDirtySet.add(liveStroke.strokeId);
      surfReadState.liveDirtyStrokeIds.push(liveStroke.strokeId);
    }

    surfReadState.liveSeq += 1;
    markUnreadAnnotationActivity();
  }

  function removeStrokesFromLiveFrame(strokeIds) {
    if (!surfReadState.liveFrame || !Array.isArray(strokeIds) || strokeIds.length === 0) {
      return;
    }

    const removeSet = new Set(strokeIds);
    surfReadState.liveFrame.strokes = surfReadState.liveFrame.strokes.filter(
      (stroke) => !removeSet.has(stroke.strokeId)
    );

    for (const strokeId of strokeIds) {
      surfReadState.liveDirtySet.delete(strokeId);
    }

    surfReadState.liveDirtyStrokeIds = surfReadState.liveDirtyStrokeIds.filter(
      (strokeId) => !removeSet.has(strokeId)
    );
  }

  function appendTapRegister({ eventId, sentAt, payload }) {
    const point = payload?.position || {};
    surfReadState.taps.push({
      ...(typeof payload?.elementRole === 'string' ? { elementRole: payload.elementRole } : {}),
      ...(typeof payload?.nearestContent === 'string' ? { nearestText: payload.nearestContent } : {}),
      eventId,
      kind: payload?.kind === 'long_press' ? 'long_press' : 'tap',
      timestamp: isInteger(sentAt) ? sentAt : nowMs(),
      x: Number(point.x) || 0,
      y: Number(point.y) || 0
    });

    if (surfReadState.taps.length > SURF_READ_TAPS_LIMIT) {
      const overflowBy = surfReadState.taps.length - SURF_READ_TAPS_LIMIT;
      surfReadState.taps.splice(0, overflowBy);
      surfReadState.overflowed = true;
    }
  }

  async function syncSessionView() {
    if (activeSession) {
      state.setSession({
        busy: true,
        providerId: activeSession.providerId,
        sessionId: activeSession.sessionId
      });
    } else {
      state.clearSession();
    }

    if (typeof onSession === 'function') {
      await onSession();
    }
  }

  async function clearDrawingsFromRenderer() {
    const removedStrokeIds = state.clearDrawings();
    if (removedStrokeIds.length === 0 || typeof onAnnotationsRemove !== 'function') {
      return;
    }

    await onAnnotationsRemove(removedStrokeIds);
  }

  async function invalidateSession({ clearFrame = true } = {}) {
    clearResumeGraceTimer();
    clearAlertResetTimer();

    activeSession = null;
    resetDrawingFlushState({ clearPending: true });

    if (clearFrame) {
      state.clearAllState();
      if (typeof onClearFrame === 'function') {
        await onClearFrame();
      }
    }

    await syncSessionView();
  }

  function activeEventTypes() {
    if (!activeSession) {
      return EVENT_TYPES_BY_PROFILE.minimum_deep;
    }

    return EVENT_TYPES_BY_PROFILE[activeSession.eventProfile] || EVENT_TYPES_BY_PROFILE.minimum_deep;
  }

  function isEventActive(op) {
    return activeEventTypes().includes(op);
  }

  function nextEventId() {
    eventCounter += 1;
    return `ev_${nowMs()}_${eventCounter}`;
  }

  function nextFlushId() {
    flushCounter += 1;
    return `fl_${nowMs()}_${flushCounter}`;
  }

  function frameSummaryPayload() {
    const currentContentId = state.activeFrame?.frameId || null;
    return {
      contentType: state.activeFrame?.contentType || null,
      currentContentId,
      currentFrameId: currentContentId,
      currentRevision: state.currentRevision
    };
  }

  async function emitEvent(op, payload) {
    if (!activeSession?.socket || !isEventActive(op)) {
      return null;
    }

    const event = {
      eventId: nextEventId(),
      op,
      payload,
      sentAt: nowMs(),
      type: 'event',
      v: 1
    };

    try {
      await wsSendJson(activeSession.socket, event);
      return event;
    } catch {
      return null;
    }
  }

  async function emitSnapshotHint(reason) {
    await emitEvent('event.snapshot_hint', { reason });
  }

  function scheduleIdleFlush() {
    clearTimeout(drawingFlushState.idleTimer);

    if (!activeSession) {
      return;
    }

    drawingFlushState.idleTimer = setTimeout(() => {
      drawingFlushState.idleTimer = null;
      void attemptDrawingFlush('idle_window');
    }, activeSession.drawingFlushConfig.idleWindowMs);
  }

  function scheduleMaxFlush() {
    if (!activeSession || drawingFlushState.maxTimer) {
      return;
    }

    const baseTs = drawingFlushState.lastSuccessfulSendAt || nowMs();
    const waitMs = Math.max(0, baseTs + activeSession.drawingFlushConfig.maxIntervalMs - nowMs());

    drawingFlushState.maxTimer = setTimeout(() => {
      drawingFlushState.maxTimer = null;
      void attemptDrawingFlush('max_interval');
    }, waitMs);
  }

  function trimFlushStrokes(strokes, frameId, revision, flushReason, flushConfig) {
    const selected = [];
    let pointsCount = 0;

    for (const stroke of strokes) {
      const nextPoints = pointsCount + stroke.points.length;
      if (nextPoints > MAX_STROKE_POINTS_PER_FLUSH) {
        break;
      }

      selected.push(stroke);
      pointsCount = nextPoints;
    }

    while (selected.length > 0) {
      const payload = {
        contentId: frameId,
        firstStrokeAt: Math.min(...selected.map((stroke) => stroke.points[0]?.timestamp || nowMs())),
        flushId: nextFlushId(),
        flushReason,
        frameId,
        idleWindowMs: flushConfig.idleWindowMs,
        lastStrokeAt: Math.max(
          ...selected.map((stroke) => stroke.points[stroke.points.length - 1]?.timestamp || nowMs())
        ),
        maxIntervalMs: flushConfig.maxIntervalMs,
        pointsCount: selected.reduce((sum, stroke) => sum + stroke.points.length, 0),
        revision,
        strokeCount: selected.length,
        strokes: selected
      };

      const message = {
        eventId: 'ev_probe',
        op: 'event.drawing_flush',
        payload,
        sentAt: nowMs(),
        type: 'event',
        v: 1
      };

      if (byteLengthUtf8(JSON.stringify(message)) <= MAX_DRAWING_FLUSH_BYTES) {
        return payload;
      }

      selected.pop();
    }

    return null;
  }

  async function attemptDrawingFlush(flushReason) {
    if (drawingFlushState.inFlight || !drawingFlushState.dirty || !activeSession?.socket) {
      return;
    }

    const flushConfig = activeSession.drawingFlushConfig;
    const now = nowMs();

    if (flushReason === 'idle_window') {
      const idleElapsed = now - drawingFlushState.lastStrokeAt;
      const minSinceLastSend = drawingFlushState.lastSuccessfulSendAt
        ? now - drawingFlushState.lastSuccessfulSendAt
        : Number.POSITIVE_INFINITY;

      if (idleElapsed < flushConfig.idleWindowMs || minSinceLastSend < flushConfig.idleWindowMs) {
        scheduleIdleFlush();
        return;
      }
    }

    const currentFrameId = state.activeFrame?.frameId;
    if (!currentFrameId) {
      drawingFlushState.dirty = false;
      drawingFlushState.pendingOrder = [];
      drawingFlushState.pendingSet.clear();
      return;
    }

    const candidateStrokeIds = [...drawingFlushState.pendingOrder];
    const candidateStrokes = state.getDrawingsByIds(candidateStrokeIds);
    if (candidateStrokes.length === 0) {
      drawingFlushState.dirty = false;
      drawingFlushState.pendingOrder = [];
      drawingFlushState.pendingSet.clear();
      return;
    }

    const payload = trimFlushStrokes(
      candidateStrokes,
      currentFrameId,
      state.currentRevision,
      flushReason,
      flushConfig
    );

    if (!payload || payload.strokes.length === 0) {
      scheduleMaxFlush();
      return;
    }

    const sentStrokeIds = payload.strokes.map((stroke) => stroke.strokeId);

    drawingFlushState.inFlight = true;
    drawingFlushState.inFlightStrokeIds = sentStrokeIds;

    if (typeof onFlushIndicator === 'function') {
      onFlushIndicator(true);
    }

    try {
      await emitEvent('event.drawing_flush', payload);

      const sentSet = new Set(sentStrokeIds);
      drawingFlushState.pendingOrder = drawingFlushState.pendingOrder.filter(
        (strokeId) => !sentSet.has(strokeId)
      );
      for (const strokeId of sentStrokeIds) {
        drawingFlushState.pendingSet.delete(strokeId);
      }

      drawingFlushState.lastSuccessfulSendAt = nowMs();
      drawingFlushState.dirty = drawingFlushState.pendingOrder.length > 0;
    } finally {
      drawingFlushState.inFlight = false;
      drawingFlushState.inFlightStrokeIds = [];
      if (typeof onFlushIndicator === 'function') {
        onFlushIndicator(false);
      }
    }

    clearDrawingTimers();
    if (drawingFlushState.dirty) {
      scheduleIdleFlush();
      scheduleMaxFlush();
    }
  }

  async function handleRendererStroke(stroke) {
    if (!state.activeFrame || !isObject(stroke) || !STROKE_ID_PATTERN.test(String(stroke.strokeId || ''))) {
      return;
    }

    if (!Array.isArray(stroke.points) || stroke.points.length === 0) {
      return;
    }

    if (!['mouse', 'finger', 'pencil'].includes(stroke.tool)) {
      return;
    }

    const normalized = {
      points: stroke.points.map((point) => ({
        pressure: Number.isFinite(point.pressure) ? point.pressure : undefined,
        timestamp: isInteger(point.timestamp) ? point.timestamp : nowMs(),
        x: Number(point.x),
        y: Number(point.y)
      })),
      strokeId: stroke.strokeId,
      tool: stroke.tool
    };

    if (normalized.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      return;
    }

    if (!state.addDrawingStroke(normalized)) {
      return;
    }

    const liveFrame = await ensureLiveFrameForCurrentContext(normalized.points[0]?.timestamp);
    if (liveFrame) {
      appendStrokeToLiveFrame(normalized);
    }

    if (!activeSession?.socket || activeSession.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!drawingFlushState.pendingSet.has(normalized.strokeId)) {
      drawingFlushState.pendingSet.add(normalized.strokeId);
      drawingFlushState.pendingOrder.push(normalized.strokeId);
    }

    drawingFlushState.dirty = true;
    drawingFlushState.lastStrokeAt = nowMs();

    scheduleIdleFlush();
    scheduleMaxFlush();
  }

  async function handleRendererEvent(payload) {
    if (!state.activeFrame || !activeSession?.socket || !isObject(payload)) {
      return;
    }

    if (payload.event === 'tap' && isObject(payload.position)) {
      const emitted = await emitEvent('event.tap', {
        contentId: state.activeFrame.frameId,
        frameId: state.activeFrame.frameId,
        kind: payload.kind === 'long_press' ? 'long_press' : 'tap',
        nearestContent: typeof payload.nearestContent === 'string' ? payload.nearestContent : undefined,
        position: {
          x: Number(payload.position.x),
          y: Number(payload.position.y)
        },
        revision: state.currentRevision
      });

      if (emitted) {
        appendTapRegister({
          eventId: emitted.eventId,
          payload: emitted.payload,
          sentAt: emitted.sentAt
        });
      }
      return;
    }

    if (payload.event === 'selection') {
      const emitted = await emitEvent('event.selection', {
        contentId: state.activeFrame.frameId,
        frameId: state.activeFrame.frameId,
        revision: state.currentRevision,
        selection: payload.selection || null
      });

      if (emitted?.payload?.selection?.kind === 'text') {
        const selection = emitted.payload.selection;
        surfReadState.selection = {
          ...(typeof selection.anchorEnd === 'number' ? { anchorEnd: selection.anchorEnd } : {}),
          ...(typeof selection.anchorStart === 'number' ? { anchorStart: selection.anchorStart } : {}),
          bounds: selection.boundingRect || null,
          selectedText: typeof selection.text === 'string' ? selection.text : ''
        };
      }
      return;
    }

    if (payload.event === 'scroll' && isObject(payload.viewport)) {
      const emitted = await emitEvent('event.scroll', {
        contentId: state.activeFrame.frameId,
        frameId: state.activeFrame.frameId,
        phase: 'settled',
        revision: state.currentRevision,
        viewport: payload.viewport,
        visibleText: String(payload.visibleText || '').slice(0, MAX_VISIBLE_TEXT_BYTES)
      });

      if (emitted) {
        const scrollOffset = emitted.payload.viewport?.scrollOffset || {};
        surfReadState.scrollPosition = {
          visibleRect: emitted.payload.viewport?.visibleRect || null,
          x: Number(scrollOffset.x) || 0,
          y: Number(scrollOffset.y) || 0
        };
      }
      return;
    }

    if (payload.event === 'page') {
      const emitted = await emitEvent('event.page', {
        contentId: state.activeFrame.frameId,
        frameId: state.activeFrame.frameId,
        page: Number(payload.page),
        pageText: typeof payload.pageText === 'string' ? payload.pageText : undefined,
        revision: state.currentRevision,
        totalPages: Number(payload.totalPages)
      });

      if (emitted) {
        surfReadState.page = {
          ...(typeof emitted.payload.pageText === 'string' ? { pageLabel: emitted.payload.pageText } : {}),
          pageCount: Number.isFinite(emitted.payload.totalPages) ? emitted.payload.totalPages : null,
          pageNumber: Number.isFinite(emitted.payload.page) ? emitted.payload.page : null
        };
      }
      return;
    }

    if (
      payload.event === 'navigation' &&
      state.activeFrame.contentType === 'html' &&
      typeof payload.url === 'string' &&
      payload.url.length > 0
    ) {
      const normalizedUrl = normalizeNavigationUrl(payload.url) || payload.url;
      const emitted = await emitEvent('event.navigation', {
        contentId: state.activeFrame.frameId,
        frameId: state.activeFrame.frameId,
        revision: state.currentRevision,
        url: normalizedUrl
      });

      if (emitted) {
        navigationContextUrl = normalizedUrl;
        surfReadState.lastNavigation = {
          navigatedAt: emitted.sentAt,
          url: normalizedUrl
        };
      }
    }
  }

  async function respondAndCache(connection, message, responsePayload) {
    connection.requestCache.set(message.id, {
      responsePayload,
      signature: canonicalRequestSignature(message)
    });

    await wsSendJson(connection.ws, responsePayload);
  }

  function staleRevisionError(op, id) {
    return failureResponse(
      op,
      id,
      'stale_revision',
      `Expected revision ${state.expectedRevision()}.`,
      { expectedRevision: state.expectedRevision() }
    );
  }

  function isContentOp(op) {
    return typeof op === 'string' && op.startsWith('content.');
  }

  function staleContentError(message) {
    if (isContentOp(message.op)) {
      return failureResponse(message.op, message.id, 'stale_content', 'contentId is not current.');
    }

    return failureResponse(message.op, message.id, 'stale_frame', 'frameId is not current.');
  }

  function buildPairResponsePayload({ resumed }) {
    const descriptor = state.getSurfaceDescriptor();
    const currentContentId = state.activeFrame?.frameId || null;
    return {
      capabilities: {
        contentTypes: [...SUPPORTED_CONTENT_TYPES],
        eventTypes: [...EVENT_TYPES_BY_PROFILE.deep_plus_scroll]
      },
      eventConfig: {
        activeEvents: [...activeEventTypes()],
        drawingFlushConfig: {
          idleWindowMs: activeSession.drawingFlushConfig.idleWindowMs,
          maxIntervalMs: activeSession.drawingFlushConfig.maxIntervalMs
        },
        profile: activeSession.eventProfile
      },
      limits: {
        maxDrawingFlushBytes: MAX_DRAWING_FLUSH_BYTES,
        maxFrameBytes: MAX_FRAME_BYTES,
        maxMessageBytes: MAX_MESSAGE_BYTES,
        maxStrokePointsPerFlush: MAX_STROKE_POINTS_PER_FLUSH,
        maxVisibleTextBytes: MAX_VISIBLE_TEXT_BYTES
      },
      resumed,
      sessionId: activeSession.sessionId,
      state: {
        contentType: state.activeFrame?.contentType || null,
        currentContentId,
        currentFrameId: currentContentId,
        currentRevision: state.currentRevision
      },
      surfaceId: descriptor.surfaceId,
      surfaceName: descriptor.name,
      viewport: descriptor.viewport
    };
  }

  async function handleSurfacesList(message) {
    return successResponse(message.op, message.id, {
      surfaces: [state.getSurfaceDescriptor()]
    });
  }

  async function handlePairRequest(connection, message) {
    const validation = validatePairPayload(message.payload);
    if (validation.error) {
      return failureResponse(message.op, message.id, validation.error.code, validation.error.message, validation.error.details);
    }

    const payload = validation.value;
    let resumed = false;

    if (payload.surfaceId && payload.surfaceId !== state.surfaceId) {
      return failureResponse(message.op, message.id, 'invalid_payload', 'payload.surfaceId is unknown.');
    }

    if (!activeSession) {
      activeSession = {
        connectionId: payload.connectionId,
        drawingFlushConfig: payload.drawingFlushConfig,
        eventProfile: payload.eventProfile,
        providerId: payload.providerId,
        resumeUntil: null,
        sessionId: createSessionId(),
        socket: connection.ws
      };
    } else if (activeSession.providerId !== payload.providerId) {
      return failureResponse(message.op, message.id, 'busy', 'Surface is paired with a different provider.');
    } else if (activeSession.socket && activeSession.socket !== connection.ws) {
      if (!payload.takeOver) {
        return failureResponse(
          message.op,
          message.id,
          'busy',
          'Surface is already paired. Set takeover=true to replace stale same-provider sockets.'
        );
      }

      const previousSocket = activeSession.socket;
      activeSession.socket = connection.ws;
      activeSession.connectionId = payload.connectionId;
      activeSession.eventProfile = payload.eventProfile;
      activeSession.drawingFlushConfig = payload.drawingFlushConfig;
      resumed = true;

      if (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING) {
        previousSocket.close(1000, 'superseded');
      }
    } else {
      if (
        payload.resumeSessionId &&
        activeSession.sessionId !== payload.resumeSessionId
      ) {
        return failureResponse(message.op, message.id, 'invalid_payload', 'resume.sessionId did not match active session.');
      }

      activeSession.socket = connection.ws;
      activeSession.connectionId = payload.connectionId;
      activeSession.eventProfile = payload.eventProfile;
      activeSession.drawingFlushConfig = payload.drawingFlushConfig;
      resumed = true;
    }

    clearResumeGraceTimer();

    connection.paired = true;
    connection.providerId = activeSession.providerId;
    if (connection.pairTimer) {
      clearTimeout(connection.pairTimer);
      connection.pairTimer = null;
    }

    await syncSessionView();

    const response = successResponse('pair.request', message.id, buildPairResponsePayload({ resumed }));

    if (resumed) {
      setTimeout(() => {
        void emitSnapshotHint('after_reconnect');
        if (drawingFlushState.dirty) {
          scheduleIdleFlush();
          scheduleMaxFlush();
        }
      }, 0);
    }

    return response;
  }

  async function handleFrameSet(message) {
    const validation = validateFrameSetPayload(message.payload);
    if (validation.error) {
      return failureResponse(message.op, message.id, validation.error.code, validation.error.message, validation.error.details);
    }

    const frame = validation.value;

    if (frame.revision !== state.expectedRevision()) {
      return staleRevisionError(message.op, message.id);
    }

    if (frame.contentType === 'pdf') {
      frame.content.extractedText = await extractPdfText(frame.content.data);
    }

    finalizeLiveFrame();
    await clearDrawingsFromRenderer();
    resetDrawingFlushState({ clearPending: true });

    state.setFrame(
      {
        content: frame.content,
        contentType: frame.contentType,
        display: frame.display,
        frameId: frame.frameId
      },
      frame.revision
    );
    navigationContextUrl = null;

    if (typeof onFrame === 'function') {
      await onFrame(state.activeFrame);
    }

    await emitSnapshotHint('after_render');

    return successResponse(message.op, message.id, frameSummaryPayload());
  }

  async function handleFrameAppend(message) {
    const validation = validateFrameAppendPayload(message.payload);
    if (validation.error) {
      return failureResponse(message.op, message.id, validation.error.code, validation.error.message, validation.error.details);
    }

    const payload = validation.value;
    const currentFrame = state.activeFrame;
    if (!currentFrame || currentFrame.frameId !== payload.frameId) {
      return staleContentError(message);
    }

    if (currentFrame.contentType !== 'terminal') {
      return failureResponse(
        message.op,
        message.id,
        'unsupported_operation_for_content_type',
        `${isContentOp(message.op) ? 'content' : 'frame'}.append is only supported for terminal content.`
      );
    }

    if (payload.revision !== state.expectedRevision()) {
      return staleRevisionError(message.op, message.id);
    }

    const maxBufferSize = Math.min(
      CONTENT_LIMITS.maxTerminalLines,
      Number(currentFrame.content.scrollback) || CONTENT_LIMITS.maxTerminalLines
    );

    const nextLines = [...currentFrame.content.lines, ...payload.lines].slice(-maxBufferSize);

    const nextFrame = {
      ...currentFrame,
      content: {
        ...currentFrame.content,
        lines: nextLines
      }
    };

    state.setFrame(nextFrame, payload.revision, { pushStack: false });

    if (typeof onFrame === 'function') {
      await onFrame(nextFrame);
    }

    await emitSnapshotHint('after_render');

    return successResponse(message.op, message.id, frameSummaryPayload());
  }

  async function handleFramePatch(message) {
    const validation = validateFramePatchPayload(message.payload);
    if (validation.error) {
      return failureResponse(message.op, message.id, validation.error.code, validation.error.message, validation.error.details);
    }

    const payload = validation.value;
    const currentFrame = state.activeFrame;

    if (!currentFrame || currentFrame.frameId !== payload.frameId) {
      return staleContentError(message);
    }

    if (currentFrame.contentType !== 'html') {
      return failureResponse(
        message.op,
        message.id,
        'unsupported_operation_for_content_type',
        `${isContentOp(message.op) ? 'content' : 'frame'}.patch is only supported for html content.`
      );
    }

    if (payload.revision !== state.expectedRevision()) {
      return staleRevisionError(message.op, message.id);
    }

    const patched = applyHtmlPatchToFrameContent(currentFrame.content.html, payload.patch);
    if (patched.error) {
      return failureResponse(
        message.op,
        message.id,
        patched.error.code,
        patched.error.message,
        patched.error.details
      );
    }

    if (byteLengthUtf8(patched.html) > CONTENT_LIMITS.htmlBytes || byteLengthUtf8(patched.html) > MAX_FRAME_BYTES) {
      return failureResponse(message.op, message.id, 'content_too_large', 'Patched HTML exceeds size limit.');
    }

    const nextFrame = {
      ...currentFrame,
      content: {
        ...currentFrame.content,
        html: patched.html
      }
    };

    state.setFrame(nextFrame, payload.revision, { pushStack: false });

    if (typeof onFrame === 'function') {
      await onFrame(nextFrame);
    }

    await emitSnapshotHint('after_render');

    return successResponse(message.op, message.id, frameSummaryPayload());
  }

  async function handleFrameClear(message) {
    const validation = validateFrameClearPayload(message.payload);
    if (validation.error) {
      return failureResponse(message.op, message.id, validation.error.code, validation.error.message, validation.error.details);
    }

    const payload = validation.value;

    if (payload.revision !== state.expectedRevision()) {
      return staleRevisionError(message.op, message.id);
    }

    finalizeLiveFrame();
    await clearDrawingsFromRenderer();
    resetDrawingFlushState({ clearPending: true });

    state.clearFrame(payload.revision);
    navigationContextUrl = null;

    if (typeof onClearFrame === 'function') {
      await onClearFrame();
    }

    await emitSnapshotHint('after_render');

    return successResponse(message.op, message.id, frameSummaryPayload());
  }

  async function handleSnapshotGet(message) {
    const validation = validateSnapshotGetPayload(message.payload);
    if (validation.error) {
      return failureResponse(message.op, message.id, validation.error.code, validation.error.message, validation.error.details);
    }

    const payload = validation.value;
    const snapshot = state.getSnapshot({
      includeDrawings: payload.includeDrawings,
      includeVisibleText: payload.includeVisibleText
    });

    if (payload.includeImage) {
      const image = await captureSnapshotImage();
      if (isPngBase64(image)) {
        snapshot.image = image;
      }
    }

    if (snapshot.frameId && !snapshot.contentId) {
      snapshot.contentId = snapshot.frameId;
    }

    return successResponse('snapshot.get', message.id, snapshot);
  }

  async function handleAnnotationsRemove(message) {
    const validation = validateAnnotationsRemovePayload(message.payload);
    if (validation.error) {
      return failureResponse(message.op, message.id, validation.error.code, validation.error.message, validation.error.details);
    }

    const payload = validation.value;

    if (!state.activeFrame || state.activeFrame.frameId !== payload.frameId) {
      return staleContentError(message);
    }

    const result = state.removeDrawingStrokes(payload.strokeIds);
    removeStrokesFromLiveFrame(result.removedStrokeIds);

    if (result.removedStrokeIds.length > 0 && typeof onAnnotationsRemove === 'function') {
      await onAnnotationsRemove(result.removedStrokeIds);
    }

    for (const removedId of result.removedStrokeIds) {
      drawingFlushState.pendingSet.delete(removedId);
    }

    drawingFlushState.pendingOrder = drawingFlushState.pendingOrder.filter(
      (strokeId) => drawingFlushState.pendingSet.has(strokeId)
    );
    drawingFlushState.dirty = drawingFlushState.pendingOrder.length > 0;

    return successResponse('annotations.remove', message.id, {
      contentId: payload.frameId,
      frameId: payload.frameId,
      notFoundStrokeIds: result.notFoundStrokeIds,
      remainingStrokeCount: result.remainingStrokeCount,
      removedStrokeIds: result.removedStrokeIds
    });
  }

  async function handleHeartbeatPing(message) {
    const validation = validateHeartbeatPingPayload(message.payload);
    if (validation.error) {
      return failureResponse(message.op, message.id, validation.error.code, validation.error.message, validation.error.details);
    }

    return successResponse('heartbeat.ping', message.id, {
      nonce: validation.value.nonce
    });
  }

  async function handleSurfAceRead(message) {
    const validation = validateSurfAceReadPayload(message.payload);
    if (validation.error) {
      return failureResponse(message.op, message.id, validation.error.code, validation.error.message, validation.error.details);
    }

    const requestedFingerprint = validation.value.fingerprint;
    if (requestedFingerprint && requestedFingerprint !== state.identity.fingerprint) {
      return failureResponse(message.op, message.id, 'screen_not_found', 'Fingerprint is unknown to this surface.');
    }

    const readAt = nowMs();
    const response = {
      fingerprint: state.identity.fingerprint,
      liveFrame: surfReadState.liveFrame ? deepClone(surfReadState.liveFrame) : null,
      liveDirtyStrokeIds: [...surfReadState.liveDirtyStrokeIds],
      liveSeq: surfReadState.liveFrame ? surfReadState.liveSeq : null,
      frames: [],
      lastNavigation: surfReadState.lastNavigation,
      overflowed: surfReadState.overflowed,
      page: surfReadState.page,
      playbackPosition: surfReadState.playbackPosition,
      playbackState: surfReadState.playbackState,
      readAt,
      scrollPosition: surfReadState.scrollPosition,
      selection: surfReadState.selection,
      taps: [...surfReadState.taps]
    };

    let imageBudgetUsed = 0;
    let closedFrameCount = 0;
    for (const frame of surfReadState.closedFrames) {
      if (closedFrameCount >= SURF_READ_MAX_CLOSED_FRAMES) {
        break;
      }

      const frameImageBytes = normalizedBase64Size(frame.image || '');
      if (imageBudgetUsed + frameImageBytes > SURF_READ_IMAGE_BUDGET_BYTES) {
        break;
      }

      response.frames.push(deepClone(frame));
      imageBudgetUsed += frameImageBytes;
      closedFrameCount += 1;
    }

    if (closedFrameCount > 0) {
      surfReadState.closedFrames.splice(0, closedFrameCount);
    }

    if (surfReadState.closedFrames.length > 0) {
      response.pendingFrames = surfReadState.closedFrames.length;
    }

    surfReadState.liveDirtySet.clear();
    surfReadState.liveDirtyStrokeIds = [];
    surfReadState.scrollPosition = null;
    surfReadState.selection = null;
    surfReadState.page = null;
    surfReadState.playbackPosition = null;
    surfReadState.playbackState = null;
    surfReadState.lastNavigation = null;
    surfReadState.taps = [];
    surfReadState.overflowed = false;
    surfReadState.alertFired = false;
    clearAlertResetTimer();

    return successResponse('surf_ace_read', message.id, response);
  }

  async function routeRequest(connection, message) {
    if (
      message.op !== 'pair.request' &&
      message.op !== 'surfaces.list' &&
      message.op !== 'surf_ace_read' &&
      !connection.paired
    ) {
      return failureResponse(message.op, message.id, 'not_paired', 'Pair handshake is required first.');
    }

    if (message.op !== 'surf_ace_read' && connection.paired && activeSession?.socket !== connection.ws) {
      return failureResponse(message.op, message.id, 'not_paired', 'Connection no longer owns active session.');
    }

    switch (message.op) {
      case 'surfaces.list':
        return await handleSurfacesList(message);
      case 'pair.request':
        return await handlePairRequest(connection, message);
      case 'content.set':
      case 'frame.set':
        return await handleFrameSet(message);
      case 'content.append':
      case 'frame.append':
        return await handleFrameAppend(message);
      case 'content.patch':
      case 'frame.patch':
        return await handleFramePatch(message);
      case 'content.clear':
      case 'frame.clear':
        return await handleFrameClear(message);
      case 'snapshot.get':
        return await handleSnapshotGet(message);
      case 'annotations.remove':
        return await handleAnnotationsRemove(message);
      case 'heartbeat.ping':
        return await handleHeartbeatPing(message);
      case 'surf_ace_read':
        return await handleSurfAceRead(message);
      default:
        return failureResponse(message.op, message.id, 'invalid_payload', 'Unknown operation.');
    }
  }

  async function handleMessage(connection, rawMessage) {
    if (byteLengthUtf8(rawMessage) > MAX_MESSAGE_BYTES) {
      connection.ws.close(4413, 'payload_too_large');
      return;
    }

    const message = safeJsonParse(rawMessage);
    if (!validateRequestEnvelope(message)) {
      connection.ws.close(4410, 'protocol_violation');
      return;
    }

    const prior = connection.requestCache.get(message.id);
    const signature = canonicalRequestSignature(message);

    if (prior) {
      if (prior.signature !== signature) {
        const response = failureResponse(
          message.op,
          message.id,
          'invalid_request_id_reuse',
          'Request ID was reused with a different payload.'
        );
        await wsSendJson(connection.ws, response);
        return;
      }

      await wsSendJson(connection.ws, prior.responsePayload);
      return;
    }

    const response = await routeRequest(connection, message);
    await respondAndCache(connection, message, response);
  }

  async function handlePriorityHeartbeat(connection, rawMessage) {
    if (byteLengthUtf8(rawMessage) > MAX_MESSAGE_BYTES) {
      connection.ws.close(4413, 'payload_too_large');
      return true;
    }

    const message = safeJsonParse(rawMessage);
    if (!validateRequestEnvelope(message)) {
      connection.ws.close(4410, 'protocol_violation');
      return true;
    }

    if (message.op !== 'heartbeat.ping') {
      return false;
    }

    const prior = connection.requestCache.get(message.id);
    const signature = canonicalRequestSignature(message);

    if (prior) {
      if (prior.signature !== signature) {
        const response = failureResponse(
          message.op,
          message.id,
          'invalid_request_id_reuse',
          'Request ID was reused with a different payload.'
        );
        await wsSendJson(connection.ws, response);
        return true;
      }

      await wsSendJson(connection.ws, prior.responsePayload);
      return true;
    }

    const response = await routeRequest(connection, message);
    await respondAndCache(connection, message, response);
    return true;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJsonResponse(res, 200, {
        status: 'ok',
        wsPath
      });
      return;
    }

    sendJsonResponse(res, 404, { error: 'not_found' });
  });

  const wss = new WebSocketServer({
    maxPayload: MAX_MESSAGE_BYTES,
    noServer: true
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== wsPath) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const connection = {
      paired: false,
      providerId: null,
      queue: Promise.resolve(),
      requestCache: new RequestIdCache(),
      ws,
      pairTimer: null
    };

    sockets.add(ws);

    connection.pairTimer = setTimeout(() => {
      if (!connection.paired && ws.readyState === WebSocket.OPEN) {
        ws.close(4401, 'pair_timeout');
      }
    }, pairRequestTimeoutMs);

    ws.on('message', (raw) => {
      const rawMessage = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);

      void handlePriorityHeartbeat(connection, rawMessage)
        .then((handled) => {
          if (handled) {
            return;
          }

          connection.queue = connection.queue
            .then(async () => {
              await handleMessage(connection, rawMessage);
            })
            .catch((error) => {
              log.error(`WS message handling failure: ${error.stack || error.message}`);
              try {
                ws.close(4500, 'internal_error');
              } catch {}
            });
        })
        .catch((error) => {
          log.error(`WS heartbeat handling failure: ${error.stack || error.message}`);
          try {
            ws.close(4500, 'internal_error');
          } catch {}
        });
    });

    ws.on('close', (code, reasonBuffer) => {
      sockets.delete(ws);
      if (connection.pairTimer) {
        clearTimeout(connection.pairTimer);
        connection.pairTimer = null;
      }
      resetDrawingFlushState({ clearPending: true });

      if (!activeSession || activeSession.socket !== ws) {
        return;
      }

      const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf8') : '';

      if (code === 1000 && reason === 'provider_shutdown') {
        void invalidateSession({ clearFrame: true });
        return;
      }

      activeSession.socket = null;
      activeSession.resumeUntil = nowMs() + resumeGraceMs;

      clearResumeGraceTimer();
      resumeGraceTimer = setTimeout(() => {
        if (!activeSession || activeSession.socket) {
          return;
        }

        if (nowMs() < activeSession.resumeUntil) {
          return;
        }

        void invalidateSession({ clearFrame: true });
      }, resumeGraceMs);

      void syncSessionView();
    });
  });

  return {
    async close() {
      clearResumeGraceTimer();
      clearAlertResetTimer();
      resetDrawingFlushState({ clearPending: true });

      for (const ws of sockets) {
        try {
          ws.close(1001, 'server_shutdown');
        } catch {}
      }

      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },

    async handleRendererEvent(payload) {
      await handleRendererEvent(payload);
    },

    async handleRendererStroke(payload) {
      await handleRendererStroke(payload);
    },

    async start() {
      await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
    }
  };
}

module.exports = {
  DEFAULT_DRAWING_FLUSH_CONFIG,
  DEFAULT_PAIR_REQUEST_TIMEOUT_MS,
  DEFAULT_RESUME_GRACE_MS,
  MAX_DRAWING_FLUSH_BYTES,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_STROKE_POINTS_PER_FLUSH,
  MAX_VISIBLE_TEXT_BYTES,
  createSurfAceWsServer
};
