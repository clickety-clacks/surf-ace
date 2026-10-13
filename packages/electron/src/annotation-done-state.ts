export type AnnotationDonePhase = "idle" | "saving" | "finishing" | "saved" | "waiting" | "unknown" | "stale" | "busy";
export type AnnotationDoneState = {
  phase: AnnotationDonePhase;
  busy: boolean;
  localSaved: boolean;
};
type Entry = {
  context: string;
  state: AnnotationDoneState;
  work: Promise<AnnotationDoneState>;
};

/** Local completion evidence only; never a registry or processed-ACK receipt. */
export class AnnotationDoneFence {
  private readonly entries = new Map<string, Entry>();
  private readonly changed: (scope: string) => void;
  private readonly scheduler: { schedule: (callback: () => void) => ReturnType<typeof setTimeout>; cancel: (timer: ReturnType<typeof setTimeout>) => void };
  constructor(changed: (scope: string) => void = () => {}, scheduler = {
    schedule: (callback: () => void) => setTimeout(callback, 30_000),
    cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  }) { this.changed = changed; this.scheduler = scheduler; }
  isBusy(scope: string): boolean { return this.entries.get(scope)?.state.busy === true; }

  snapshot(scope: string, context: string): AnnotationDoneState {
    const entry = this.entries.get(scope);
    return entry?.context === context ? { ...entry.state } : { phase: "idle", busy: false, localSaved: false };
  }

  finish(scope: string, context: string, isCurrent: () => boolean,
    operation: (savedDurably: () => void) => Promise<void>): Promise<AnnotationDoneState> {
    const current = (): boolean => { try { return isCurrent(); } catch { return false; } };
    const pending = this.entries.get(scope);
    if (pending?.state.busy) {
      return pending.context === context ? pending.work : Promise.resolve({ phase: "busy", busy: true, localSaved: false });
    }
    if (!current()) return Promise.resolve({ phase: "stale", busy: false, localSaved: false });
    const entry: Entry = { context, state: { phase: "saving", busy: true, localSaved: false }, work: Promise.resolve({ phase: "idle", busy: false, localSaved: false }) };
    this.entries.set(scope, entry);
    // Stop the spinner without dropping ownership or allowing another submit.
    // A slow save/delivery remains pending until its real operation settles.
    const timer = this.scheduler.schedule(() => {
      if (this.entries.get(scope) === entry && entry.state.busy) {
        entry.state = { ...entry.state, phase: "waiting" };
        this.notify(scope);
      }
    });
    // Install the fence and paint pending state before work can enter or suspend.
    entry.work = Promise.resolve().then(async () => {
      if (!current()) { this.scheduler.cancel(timer); entry.state = { phase: "stale", busy: false, localSaved: false }; return { ...entry.state }; }
      try {
        await operation(() => {
          if (this.entries.get(scope) !== entry || !entry.state.busy) return;
          entry.state = { phase: entry.state.phase === "waiting" ? "waiting" : "finishing", busy: true, localSaved: true };
          this.notify(scope);
        });
        entry.state = { phase: entry.state.localSaved ? "saved" : "unknown", busy: false, localSaved: entry.state.localSaved };
      } catch {
        // A rejection alone cannot prove that a write never committed.
        entry.state = { phase: entry.state.localSaved ? "waiting" : "unknown", busy: false, localSaved: entry.state.localSaved };
      }
      if (!current()) entry.state = { phase: "stale", busy: false, localSaved: false };
      this.scheduler.cancel(timer);
      this.notify(scope);
      return { ...entry.state };
    });
    this.notify(scope);
    return entry.work;
  }

  forget(scope: string): void {
    const entry = this.entries.get(scope);
    if (!entry?.state.busy) this.entries.delete(scope);
  }
  private notify(scope: string): void {
    try { this.changed(scope); } catch { /* UI notification cannot undo durable evidence. */ }
  }
}
