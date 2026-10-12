import { createHash, randomBytes } from "node:crypto";
import { validPanePaintMessage } from "./pane-paint-contract.js";
import { observePanePaint, isPaintState, type PaintAdapter, type PaintBinding, type PaintClock, type PaintState } from "./pane-painted-observation.js";

export type PaintExpectation = { observationToken: string; binding: PaintBinding; projection: PaintState["projection"] };
export type PanePaintRequest = { v: 1; type: "request"; op: "diagnostics.pane_paint.get"; id: string; sentAt: number; payload:
  | { action: "describe"; surfaceId: string; paneId: number }
  | { action: "observe"; expected: PaintExpectation; timeoutMs: number } };
type RecordEntry = { digest: string; state: "pending" | "completed"; reason: string };
type Token = { value: PaintExpectation; expires: number; used: boolean; cancel: () => void };
type Connection = { surfaceId: string; ids: Map<string, RecordEntry>; token?: Token; slot?: Slot; closed: boolean };
type Slot = { owner: Connection; controller: AbortController; pending: Set<Promise<unknown>>; finished: boolean; released: boolean };
type Reply = Record<string, unknown>;
const OP = "diagnostics.pane_paint.get";
const FLAGS = { atomic: false, paintFreshness: "not-established", physicalDisplay: "not-observed" };
const PREFLIGHT = 8 * 1024 * 1024;
const clockDefault: PaintClock = { now: () => performance.now(), schedule: (f, ms) => { const t = setTimeout(f, ms); return () => clearTimeout(t); } };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function equal(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function stageName(stage: string): string {
  return stage.replace(/:(start|end)$/, ":capture").replace(/:(capture-binding|image)$/, ":png");
}

/** Optional kernel only: no WS registration, concrete Electron adapter or capability advertisement. */
export class PairedPanePaintService<C extends object> {
  private connections = new WeakMap<C, Connection>();
  private active = 0;
  private readonly enabled: boolean;
  private readonly clock: PaintClock;
  constructor(private readonly ports: {
    enabled?: boolean;
    pairedSurface: (connection: C) => string | null;
    ordinaryIdRetained: (connection: C, id: string) => boolean;
    transportBytes: (connection: C) => number;
    adapter: (surfaceId: string, paneId: number) => PaintAdapter | null;
    clock?: PaintClock;
    token?: () => string;
  }) { this.enabled = ports.enabled === true; this.clock = ports.clock ?? clockDefault; }
  hasDiagnosticId(connection: C, id: string): boolean { return this.connections.get(connection)?.ids.has(id) ?? false; }
  activeCount(): number { return this.active; }
  close(connection: C): void {
    const state = this.connections.get(connection);
    if (!state) return;
    state.closed = true; state.token?.cancel(); state.token = undefined;
    state.slot?.controller.abort(); state.ids.clear(); this.connections.delete(connection);
    // A native promise is not made cancellable by AbortSignal. Its slot survives disconnect until safe drain.
  }
  private release(slot: Slot): void {
    if (!slot.finished || slot.pending.size || slot.released) return;
    slot.released = true; this.active--;
    if (slot.owner.slot === slot) slot.owner.slot = undefined;
  }
  private track<T>(slot: Slot, operation: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(operation); slot.pending.add(promise);
    const drain = () => { slot.pending.delete(promise); this.release(slot); };
    void promise.then(drain, drain); return promise;
  }
  async handle(connection: C, input: unknown): Promise<Reply | null> {
    const object = input && typeof input === "object" ? input as Record<string, unknown> : null;
    const error = (code: string): Reply => ({ v: 1, type: "response", op: OP, id: typeof object?.id === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(object.id) ? object.id : "invalid", sentAt: Date.now(), ok: false, error: { code, message: code } });
    const surfaceId = this.ports.pairedSurface(connection);
    if (!surfaceId) return error("not_paired");
    if (object?.type !== "request" || !validPanePaintMessage(input)) return error("invalid_payload");
    const request = structuredClone(input) as PanePaintRequest;
    const payload = request.payload;
    const targetSurface = payload.action === "describe" ? payload.surfaceId : payload.expected.binding.surfaceId;
    if (targetSurface !== surfaceId) return error("not_paired");
    let state = this.connections.get(connection);
    if (state && state.surfaceId !== surfaceId) { this.close(connection); state = undefined; }
    if (!state) { state = { surfaceId, ids: new Map(), closed: false }; this.connections.set(connection, state); }
    if (state.ids.has(request.id) || this.ports.ordinaryIdRetained(connection, request.id)) return error("invalid_request_id_reuse");
    let origin: number;
    try { origin = this.clock.now(); } catch { return error("internal_error"); }
    if (!Number.isFinite(origin) || origin < 0) return error("internal_error");
    const budget = payload.action === "describe" ? 2000 : payload.timeoutMs;
    const elapsed = () => { const t = this.clock.now() - origin; if (!Number.isFinite(t) || t < 0 || t > Number.MAX_SAFE_INTEGER) throw Error("invalid clock"); return t; };
    const success = (result: Reply): Reply => ({ v: 1, type: "response", op: OP, id: request.id, sentAt: Date.now(), ok: true, payload: { request: payload, configuredBudgetMs: budget, ...FLAGS, ...result } });
    const refusal = (reason: string, stage = "admission", captures: unknown[] = [], checks: unknown[] = [], drain: string = "not-required") => success({ outcome: "refused", reason, stage, captures, checks, elapsedMs: elapsed(), nativeDrain: { state: drain } });
    if (state.ids.size >= 1024) return refusal("busy");
    const entry: RecordEntry = { digest: createHash("sha256").update(canonical({ op: OP, payload })).digest("hex"), state: "completed", reason: "admission" };
    state.ids.set(request.id, entry);
    if (state.slot || this.active >= 2) { entry.reason = "busy"; return refusal("busy"); }
    const paneId = payload.action === "describe" ? payload.paneId : payload.expected.binding.paneId;
    const adapter = this.enabled ? this.ports.adapter(surfaceId, paneId) : null;
    if (!adapter) { entry.reason = "unsupported"; return refusal("unsupported"); }
    if (this.ports.transportBytes(connection) < PREFLIGHT) { entry.reason = "transport-limit"; return refusal("transport-limit"); }
    if (payload.action === "observe") {
      const token = state.token;
      if (!token || token.used || this.clock.now() >= token.expires || !equal(token.value, payload.expected)) { entry.reason = "stale"; return refusal("stale"); }
      token.used = true;
    }
    const slot: Slot = { owner: state, controller: new AbortController(), pending: new Set(), finished: false, released: false };
    state.slot = slot; this.active++; entry.state = "pending";
    const current = () => !state!.closed && this.connections.get(connection) === state && this.ports.pairedSurface(connection) === surfaceId;
    const tracked: PaintAdapter = {
      readState: signal => this.track(slot, () => {
        if (!current() || slot.controller.signal.aborted || signal.aborted) throw Error("cancelled");
        return adapter.readState(AbortSignal.any([signal, slot.controller.signal]));
      }),
      capture: (target, frame, signal) => this.track(slot, () => {
        if (!current() || slot.controller.signal.aborted || signal.aborted) throw Error("cancelled");
        return adapter.capture(target, frame, AbortSignal.any([signal, slot.controller.signal]));
      }),
    };
    try {
      let reply: Reply;
      let tokenToIssue: PaintExpectation | undefined;
      if (payload.action === "describe") {
        let cancel = () => {};
        let frame: PaintState | null;
        try {
          frame = await new Promise<PaintState | null>((resolve, reject) => {
            cancel = this.clock.schedule(() => { slot.controller.abort(); reject(Error("timeout")); }, Math.max(0, budget - elapsed()));
            void tracked.readState(slot.controller.signal).then(resolve, () => reject(Error("read-failed")));
          });
        } catch (failure) {
          const reason = elapsed() >= budget ? "timeout" : "read-failed";
          reply = refusal(reason, "describe", [], [], slot.pending.size ? "pending" : "not-required");
          entry.reason = reason; return current() ? reply : null;
        } finally { cancel(); }
        if (elapsed() >= budget) { entry.reason = "timeout"; return current() ? refusal("timeout", "describe", [], [], slot.pending.size ? "pending" : "not-required") : null; }
        if (!isPaintState(frame) || !frame.hostAttached || !frame.guestAttached || frame.binding.surfaceId !== surfaceId || frame.binding.paneId !== paneId) { entry.reason = "unavailable"; return current() ? refusal("unavailable", "describe") : null; }
        let value: string;
        try {
          value = "";
          for (let attempt = 0; attempt < 4; attempt++) {
            value = this.ports.token?.() ?? randomBytes(16).toString("hex");
            if (/^[a-f0-9]{32}$/.test(value) && value !== state.token?.value.observationToken) break;
            value = "";
          }
          if (!value) throw Error("token collision");
        } catch { entry.reason = "internal_error"; return current() ? error("internal_error") : null; }
        const expected: PaintExpectation = { observationToken: value, binding: structuredClone(frame.binding), projection: structuredClone(frame.projection) };
        reply = success({ outcome: "described", expectation: expected, expiresAfterMs: 5000, elapsedMs: elapsed() });
        if (!validPanePaintMessage(reply)) { entry.reason = "unsupported"; return current() ? refusal("unsupported") : null; }
        if (!current()) return null;
        tokenToIssue = expected; entry.reason = "described";
      } else {
        const remaining = Math.floor(budget - elapsed());
        if (remaining < 1) { entry.reason = "timeout"; return current() ? refusal("timeout", "before") : null; }
        const result = await observePanePaint(payload.expected.binding, tracked, {
          clock: this.clock, timeoutMs: remaining, expectedProjection: payload.expected.projection,
          maxImageBytes: 2 * 1024 * 1024, maxDecodedBytes: 32 * 1024 * 1024, maxDimension: 8192,
        });
        if (!current()) return null;
        const captures = result.captures.map(image => ({ target: image.target, binding: image.binding, coordinateSpace: image.coordinateSpace, pngBase64: Buffer.from(image.png).toString("base64"), sha256: image.sha256, pixelWidth: image.pixelWidth, pixelHeight: image.pixelHeight, startedOffsetMs: image.startedMonotonicMs - origin, endedOffsetMs: image.endedMonotonicMs - origin }));
        const checks = result.stateReads.map(read => ({ stage: read.stage, receivedOffsetMs: read.receivedMonotonicMs - origin, state: { binding: read.state.binding, projection: read.state.projection, hostAttached: read.state.hostAttached, guestAttached: read.state.guestAttached } }));
        if (result.kind === "observed" && elapsed() < budget) {
          reply = success({ outcome: "observed", captures, checks, elapsedMs: elapsed(), midpointSkewMs: result.midpointSkewMs, consistency: result.consistency }); entry.reason = "observed";
        } else {
          const rawReason = result.kind === "refused" ? result.reason : "timeout";
          const rawStage = result.kind === "refused" ? result.stage : "publish";
          const reason = rawStage.endsWith(":capture-binding") ? "invalid-image" : rawReason;
          if (!["unavailable", "stale", "read-failed", "capture-failed", "invalid-image", "timeout"].includes(reason)) { entry.reason = "internal_error"; return error("internal_error"); }
          reply = refusal(reason, stageName(rawStage), captures, checks, slot.pending.size ? "pending" : "not-required"); entry.reason = reason;
        }
      }
      if (!validPanePaintMessage(reply)) { entry.reason = "internal_error"; return current() ? error("internal_error") : null; }
      if (Buffer.byteLength(JSON.stringify(reply)) > this.ports.transportBytes(connection)) { entry.reason = "content_too_large"; return current() ? error("content_too_large") : null; }
      const resultPayload = reply.payload as Record<string, unknown>;
      const finalElapsed = elapsed();
      if ((resultPayload.outcome === "observed" || resultPayload.outcome === "described") && finalElapsed >= budget) {
        entry.reason = "timeout";
        reply = refusal("timeout", resultPayload.outcome === "described" ? "describe" : "publish",
          resultPayload.captures as unknown[] ?? [], resultPayload.checks as unknown[] ?? [], slot.pending.size ? "pending" : "not-required");
        tokenToIssue = undefined;
      } else resultPayload.elapsedMs = finalElapsed;
      if (!current()) return null;
      if (tokenToIssue) {
        const issued: Token = { value: structuredClone(tokenToIssue), expires: this.clock.now() + 5000, used: false, cancel: () => {} };
        issued.cancel = this.clock.schedule(() => { if (state!.token === issued) state!.token = undefined; }, 5000);
        state.token?.cancel(); state.token = issued;
      }
      return reply;
    } catch { entry.reason = "internal_error"; return current() ? error("internal_error") : null; }
    finally { entry.state = "completed"; slot.finished = true; this.release(slot); }
  }
}
