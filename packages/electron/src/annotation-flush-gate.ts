export type AnnotationFlushReason = "idle_window" | "max_interval";

type Timer = ReturnType<typeof setTimeout>;
export type AnnotationFlushScheduler = {
  schedule: (callback: () => void, delayMs: number) => Timer;
  cancel: (timer: Timer) => void;
};
type PaneGate = {
  dirty: boolean;
  generation: number;
  idleDueAt: number;
  maxDueAt: number;
  lastFlushAt: number;
  timer: Timer | null;
  active: Promise<void> | null;
};

/** Schedules one flush per pane after the trailing idle or maximum interval gate. */
export class AnnotationFlushGate {
  private readonly panes = new Map<string, PaneGate>();
  private stopped = false;

  constructor(
    private readonly onFlush: (surfaceId: string, paneId: number, reason: AnnotationFlushReason) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly idleWindowMs = 8_000,
    private readonly maxIntervalMs = 30_000,
    private readonly scheduler: AnnotationFlushScheduler = {
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (timer) => clearTimeout(timer),
    },
  ) {
    if (!Number.isSafeInteger(idleWindowMs) || idleWindowMs < 5_000 || idleWindowMs > 10_000 ||
        !Number.isSafeInteger(maxIntervalMs) || maxIntervalMs < 10_000) {
      throw new RangeError("invalid annotation flush gate limits");
    }
  }

  strokeEnded(surfaceId: string, paneId: number): void {
    if (this.stopped) return;
    const key = JSON.stringify([surfaceId, paneId]);
    const now = this.now();
    const state = this.panes.get(key) ?? {
      dirty: false, generation: 0, idleDueAt: 0, maxDueAt: now + this.maxIntervalMs,
      lastFlushAt: now, timer: null, active: null,
    };
    state.dirty = true;
    state.generation += 1;
    state.idleDueAt = now + this.idleWindowMs;
    this.panes.set(key, state);
    this.arm(key, state);
  }

  private arm(key: string, state: PaneGate): void {
    if (state.timer) this.scheduler.cancel(state.timer);
    state.timer = null;
    if (this.stopped || !state.dirty || state.active) return;
    const delay = Math.max(0, Math.min(state.idleDueAt, state.maxDueAt) - this.now());
    state.timer = this.scheduler.schedule(() => {
      state.timer = null;
      void this.fire(key, state);
    }, delay);
  }

  private async fire(key: string, state: PaneGate): Promise<void> {
    if (this.stopped || !state.dirty || state.active) return;
    const now = this.now();
    if (now < state.idleDueAt && now < state.maxDueAt) {
      this.arm(key, state);
      return;
    }
    const reason: AnnotationFlushReason = now >= state.maxDueAt ? "max_interval" : "idle_window";
    const generation = state.generation;
    const [surfaceId, paneId] = JSON.parse(key) as [string, number];
    state.active = this.onFlush(surfaceId, paneId, reason);
    let succeeded = false;
    try {
      await state.active;
      succeeded = true;
      state.lastFlushAt = this.now();
      state.maxDueAt = state.lastFlushAt + this.maxIntervalMs;
      if (state.generation === generation) state.dirty = false;
    } catch (error) {
      this.onError(error);
      // Failure leaves the dirty work intact; a later stroke or explicit retry
      // must re-arm it after the caller resolves its persistence condition.
      return;
    } finally {
      state.active = null;
      if (state.dirty && succeeded && !this.stopped) this.arm(key, state);
    }
  }

  async flushPending(surfaceId: string, paneId: number): Promise<void> {
    const key = JSON.stringify([surfaceId, paneId]);
    const state = this.panes.get(key);
    if (!state?.dirty) return;
    if (state.active) await state.active;
    if (!state.dirty) return;
    state.idleDueAt = this.now();
    await this.fire(key, state);
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.panes.values()) if (state.timer) this.scheduler.cancel(state.timer);
    this.panes.clear();
  }
}
