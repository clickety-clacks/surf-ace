const { CAPABILITY_BITMASK, PROTOCOL_VERSION } = require('./constants');

class SurfAceState {
  constructor({ identity, screenName, viewport, wsPath = '/ws', tlsEnabled = false }) {
    this.identity = identity;
    this.surfaceId = `sf_${identity.fingerprint}`;
    this.screenName = screenName;
    this.viewport = { ...viewport };
    this.wsPath = wsPath;
    this.tlsEnabled = tlsEnabled;

    this.session = null;
    this.activeFrame = null;
    this.currentRevision = 0;
    this.changeStack = [];
    this.lastSnapshot = null;
    this.lastSelection = null;

    this.drawings = [];
    this.drawingsById = new Map();
  }

  setSession(session) {
    this.session = session ? { ...session } : null;
  }

  clearSession() {
    this.session = null;
  }

  setBusy(busy) {
    if (busy) {
      this.session = this.session || {};
      this.session.busy = true;
      return;
    }

    if (this.session) {
      this.session.busy = false;
    }
  }

  isBusy() {
    return Boolean(this.session?.busy);
  }

  updateViewport(viewport) {
    this.viewport = {
      ...this.viewport,
      ...viewport
    };
  }

  setFrame(frame, revision, { pushStack = true } = {}) {
    this.activeFrame = frame;
    this.currentRevision = revision;
    if (pushStack) {
      this.changeStack.push(frame);
    }
  }

  clearFrame(revision) {
    this.activeFrame = null;
    this.currentRevision = revision;
  }

  clearAllState() {
    this.activeFrame = null;
    this.currentRevision = 0;
    this.lastSnapshot = null;
    this.lastSelection = null;
    this.clearDrawings();
  }

  expectedRevision() {
    return this.currentRevision + 1;
  }

  setSnapshot(snapshot) {
    this.lastSnapshot = snapshot;
    this.lastSelection = snapshot.selection ?? null;
    if (snapshot.viewport) {
      this.updateViewport({
        height: snapshot.viewport.visibleRect?.height ?? this.viewport.height,
        width: snapshot.viewport.visibleRect?.width ?? this.viewport.width
      });
    }
  }

  addDrawingStroke(stroke) {
    const strokeId = stroke?.strokeId;
    if (!strokeId || this.drawingsById.has(strokeId)) {
      return false;
    }

    this.drawings.push(stroke);
    this.drawingsById.set(strokeId, stroke);
    return true;
  }

  getDrawingsByIds(strokeIds) {
    return strokeIds
      .map((strokeId) => this.drawingsById.get(strokeId))
      .filter(Boolean);
  }

  getAllDrawings() {
    return [...this.drawings];
  }

  removeDrawingStrokes(strokeIds) {
    const removedStrokeIds = [];
    const notFoundStrokeIds = [];
    const removeSet = new Set(strokeIds);

    for (const strokeId of strokeIds) {
      if (!this.drawingsById.has(strokeId)) {
        notFoundStrokeIds.push(strokeId);
        continue;
      }

      this.drawingsById.delete(strokeId);
      removedStrokeIds.push(strokeId);
    }

    if (removedStrokeIds.length > 0) {
      this.drawings = this.drawings.filter((stroke) => !removeSet.has(stroke.strokeId));
    }

    return {
      notFoundStrokeIds,
      remainingStrokeCount: this.drawings.length,
      removedStrokeIds
    };
  }

  clearDrawings() {
    const removedStrokeIds = this.drawings.map((stroke) => stroke.strokeId);
    this.drawings = [];
    this.drawingsById.clear();
    return removedStrokeIds;
  }

  getSnapshot({ includeDrawings = false, includeVisibleText = true } = {}) {
    const viewport =
      this.lastSnapshot?.viewport || {
        contentSize: {
          height: this.viewport.height,
          width: this.viewport.width
        },
        scrollOffset: { x: 0, y: 0 },
        visibleRect: {
          height: this.viewport.height,
          width: this.viewport.width,
          x: 0,
          y: 0
        },
        zoomLevel: 1
      };

    const contentId = this.activeFrame?.frameId || null;

    const snapshot = {
      contentId,
      contentType: this.activeFrame?.contentType || null,
      frameId: contentId,
      revision: this.currentRevision,
      selection: this.lastSnapshot?.selection || null,
      viewport
    };

    if (includeDrawings) {
      snapshot.drawings = this.getAllDrawings();
    }

    if (includeVisibleText) {
      snapshot.visibleText = (this.lastSnapshot?.visibleText || '').slice(0, 4096);
    }

    return snapshot;
  }

  getSessionView() {
    return {
      busy: this.isBusy(),
      providerId: this.session?.providerId || null,
      sessionId: this.session?.sessionId || null
    };
  }

  getSurfaceDescriptor() {
    return {
      name: this.screenName,
      surfaceId: this.surfaceId,
      viewport: {
        height: Math.max(1, Math.floor(this.viewport.height)),
        scale: Number(this.viewport.scale) || 1,
        width: Math.max(1, Math.floor(this.viewport.width))
      }
    };
  }

  getTxtRecords() {
    return {
      busy: this.isBusy() ? '1' : '0',
      cap: String(CAPABILITY_BITMASK),
      h: String(this.viewport.height),
      name: this.screenName,
      pk: this.identity.fingerprint,
      s: String(this.viewport.scale),
      tls: this.tlsEnabled ? '1' : '0',
      v: String(PROTOCOL_VERSION),
      w: String(this.viewport.width),
      ws: this.wsPath
    };
  }
}

module.exports = {
  SurfAceState
};
