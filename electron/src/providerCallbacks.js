class ProviderCallbacks {
  constructor({ getMainWindow, logger, state }) {
    this.getMainWindow = getMainWindow;
    this.logger = logger;
    this.state = state;
  }

  async dispatchEvent(payload, { respectWatchFilter = true } = {}) {
    const watch = this.state.watchSubscription;
    if (!watch || !watch.callbackUrl) {
      return;
    }

    if (
      respectWatchFilter &&
      Array.isArray(watch.events) &&
      watch.events.length > 0 &&
      !watch.events.includes(payload.event)
    ) {
      return;
    }

    const body = JSON.stringify(payload);
    await this.#postWithOneRetry(watch.callbackUrl, body);
  }

  async captureFullScreenshotBase64() {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return this.#transparentPng1x1();
    }

    const image = await mainWindow.webContents.capturePage();
    return image.toPNG().toString('base64');
  }

  async captureCropScreenshotBase64(cropRect) {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return this.#transparentPng1x1();
    }

    const fullImage = await mainWindow.webContents.capturePage();
    const imageSize = fullImage.getSize();

    const rect = {
      height: Math.max(1, Math.min(imageSize.height, Math.floor(cropRect.h || 1))),
      width: Math.max(1, Math.min(imageSize.width, Math.floor(cropRect.w || 1))),
      x: Math.max(0, Math.min(imageSize.width - 1, Math.floor(cropRect.x || 0))),
      y: Math.max(0, Math.min(imageSize.height - 1, Math.floor(cropRect.y || 0)))
    };

    if (rect.x + rect.width > imageSize.width) {
      rect.width = imageSize.width - rect.x;
    }
    if (rect.y + rect.height > imageSize.height) {
      rect.height = imageSize.height - rect.y;
    }

    const cropped = fullImage.crop(rect);
    return cropped.toPNG().toString('base64');
  }

  async #postWithOneRetry(url, body) {
    let firstError = null;

    try {
      const response = await fetch(url, {
        body,
        headers: {
          'content-type': 'application/json'
        },
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error(`Callback returned ${response.status}`);
      }

      return;
    } catch (error) {
      firstError = error;
      this.logger.warn(`Callback failed; retrying once: ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const response = await fetch(url, {
        body,
        headers: {
          'content-type': 'application/json'
        },
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error(`Callback returned ${response.status}`);
      }
    } catch (error) {
      this.logger.warn(
        `Callback dropped after retry: ${error.message}; first failure: ${firstError?.message || 'unknown'}`
      );
    }
  }

  #transparentPng1x1() {
    return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9qNfzmQAAAABJRU5ErkJggg==';
  }
}

module.exports = {
  ProviderCallbacks
};
