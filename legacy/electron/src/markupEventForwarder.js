function createMarkupEventForwarder({
  callbackDispatcher,
  getActiveFrameId,
  now = Date.now
}) {
  return {
    async handleLong(payload) {
      if (!payload || !Array.isArray(payload.strokesSinceLastSnapshot)) {
        return;
      }

      const image = await callbackDispatcher.captureFullScreenshotBase64();
      const eventPayload = {
        event: 'surf ace_snapshot',
        frameId: payload.frameId || getActiveFrameId(),
        image,
        strokesSinceLastSnapshot: payload.strokesSinceLastSnapshot,
        timestamp: payload.timestamp || now()
      };

      await callbackDispatcher.dispatchEvent(eventPayload, {
        respectWatchFilter: false
      });
    },

    async handleShort(payload) {
      if (!payload || !payload.cropRect || !Array.isArray(payload.strokes)) {
        return;
      }

      const crop = await callbackDispatcher.captureCropScreenshotBase64(payload.cropRect);
      const eventPayload = {
        crop,
        cropRect: payload.cropRect,
        event: 'strokes',
        frameId: payload.frameId || getActiveFrameId(),
        strokes: payload.strokes,
        timestamp: payload.timestamp || now()
      };

      await callbackDispatcher.dispatchEvent(eventPayload, {
        respectWatchFilter: false
      });
    }
  };
}

module.exports = {
  createMarkupEventForwarder
};
