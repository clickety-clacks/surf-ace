function createWatchEventDispatcher({
  clearTimer = clearTimeout,
  defaultDebounceMs = 500,
  dispatchEvent,
  getWatchSubscription,
  setTimer = setTimeout
}) {
  const timers = new Map();

  async function handle(payload) {
    const watch = getWatchSubscription();
    if (!watch) {
      return;
    }

    const event = payload?.event;
    if (event !== 'scroll_settle' && event !== 'zoom_settle') {
      await dispatchEvent(payload);
      return;
    }

    const configuredMs = Number(watch?.debounce?.[event]);
    const debounceMs = Number.isFinite(configuredMs) ? configuredMs : defaultDebounceMs;

    const existing = timers.get(event);
    if (existing) {
      clearTimer(existing);
    }

    const timeout = setTimer(async () => {
      timers.delete(event);
      await dispatchEvent(payload);
    }, debounceMs);

    timers.set(event, timeout);
  }

  function clear() {
    for (const timeout of timers.values()) {
      clearTimer(timeout);
    }
    timers.clear();
  }

  return {
    clear,
    handle
  };
}

module.exports = {
  createWatchEventDispatcher
};
