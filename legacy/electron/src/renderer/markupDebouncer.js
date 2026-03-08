(function buildMarkupDebouncer(globalScope) {
  function noOp() {}

  function createMarkupDebouncer(options) {
    const shortDebounceMs = options?.shortDebounceMs ?? 500;
    const longDebounceMs = options?.longDebounceMs ?? 3500;
    const setTimer = options?.setTimer ?? setTimeout;
    const clearTimer = options?.clearTimer ?? clearTimeout;
    const now = options?.now ?? Date.now;
    const onShortDebounce = options?.onShortDebounce ?? noOp;
    const onLongDebounce = options?.onLongDebounce ?? noOp;
    const computeCropRect = options?.computeCropRect ?? (() => ({ h: 1, w: 1, x: 0, y: 0 }));

    let pendingShortStrokes = [];
    let strokesSinceLastSnapshot = [];
    let shortTimer = null;
    let longTimer = null;
    let latestFrameId = null;

    function clearShortTimer() {
      if (!shortTimer) {
        return;
      }
      clearTimer(shortTimer);
      shortTimer = null;
    }

    function clearLongTimer() {
      if (!longTimer) {
        return;
      }
      clearTimer(longTimer);
      longTimer = null;
    }

    function flushShort() {
      shortTimer = null;
      if (pendingShortStrokes.length === 0) {
        return;
      }

      const strokes = pendingShortStrokes;
      pendingShortStrokes = [];
      onShortDebounce({
        cropRect: computeCropRect(strokes),
        frameId: latestFrameId,
        strokes,
        timestamp: now()
      });
    }

    function flushLong() {
      longTimer = null;
      if (strokesSinceLastSnapshot.length === 0) {
        return;
      }

      const payloadStrokes = strokesSinceLastSnapshot;
      strokesSinceLastSnapshot = [];
      onLongDebounce({
        frameId: latestFrameId,
        strokesSinceLastSnapshot: payloadStrokes,
        timestamp: now()
      });
    }

    function scheduleShort() {
      clearShortTimer();
      shortTimer = setTimer(flushShort, shortDebounceMs);
    }

    function scheduleLong() {
      clearLongTimer();
      longTimer = setTimer(flushLong, longDebounceMs);
    }

    return {
      commitStroke({ frameId, stroke }) {
        if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) {
          return;
        }

        latestFrameId = frameId ?? latestFrameId ?? null;
        pendingShortStrokes.push(stroke);
        strokesSinceLastSnapshot.push(stroke);
        scheduleShort();
      },

      noteStrokeActivity(frameId) {
        latestFrameId = frameId ?? latestFrameId ?? null;
        scheduleLong();
      },

      reset() {
        pendingShortStrokes = [];
        strokesSinceLastSnapshot = [];
        clearShortTimer();
        clearLongTimer();
      }
    };
  }

  const api = { createMarkupDebouncer };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  globalScope.SurfAceMarkupDebouncer = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
