export async function waitForScreenshotPixels(capture, inspect, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (true) {
    const result = await capture();
    attempts += 1;
    options.onAttempt?.(result, attempts);
    try {
      inspect(result);
      return result;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("capture_screenshot_expected_pixels_missing:")) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`capture_screenshot_pixels_timeout:${attempts}:${error.message}`, { cause: error });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
