import { PairedPanePaintService } from "./paired-pane-paint-service.js";
import { validPanePaintMessage, validPanePaintOutcome, validPanePaintError } from "./pane-paint-contract.js";
import type { PaintAdapter, PaintClock } from "./pane-painted-observation.js";

const OP = "diagnostics.pane_paint.get";
const EGRESS = 8 * 1024 * 1024;
type Reply = Record<string, unknown>;
type Delivery = { handled: boolean; enqueued: boolean; completed: boolean; reason: string };
/** Prepared private routing only. No capability or protocol registration is implied. */
export class PanePaintWsRoute<C extends object> {
  private readonly service: PairedPanePaintService<C>;
  private readonly publishing = new WeakSet<C>();
  private readonly epochs = new WeakMap<C, object>();
  constructor(private readonly ports: {
    enabled?: boolean;
    clock: PaintClock;
    pairedSurface: (connection: C) => string | null;
    ordinaryIdRetained: (connection: C, id: string) => boolean;
    adapter: (surfaceId: string, paneId: number) => PaintAdapter | null;
    open: (connection: C) => boolean;
    bufferedBytes: (connection: C) => number;
    send: (connection: C, encoded: string) => Promise<boolean>;
    encode?: (reply: Reply) => string; // trusted local serializer seam; never request-supplied
    terminate: (connection: C) => void;
  }) {
    this.service = new PairedPanePaintService({
      enabled: ports.enabled, clock: ports.clock,
      pairedSurface: ports.pairedSurface,
      ordinaryIdRetained: ports.ordinaryIdRetained,
      transportBytes: connection => this.available(connection), adapter: (surfaceId, paneId) => ports.adapter(surfaceId, paneId),
    });
  }
  private available(connection: C): number {
    const bytes = this.ports.bufferedBytes(connection);
    return this.ports.open(connection) && Number.isSafeInteger(bytes) && bytes >= 0 ? Math.max(0, EGRESS - bytes) : 0;
  }
  hasDiagnosticId(connection: C, id: string): boolean { return this.service.hasDiagnosticId(connection, id); }
  activeCount(): number { return this.service.activeCount(); }
  close(connection: C): void {
    this.epochs.delete(connection); this.publishing.delete(connection); this.service.close(connection);
  }
  async handle(connection: C, input: unknown): Promise<Delivery> {
    const no = (reason: string, enqueued = false): Delivery => ({ handled: true, enqueued, completed: false, reason });
    if (this.ports.enabled !== true || !input || typeof input !== "object" || (input as Reply).op !== OP)
      return { handled: false, enqueued: false, completed: false, reason: "disabled-or-other-operation" };
    // Strict contract and pairing precede native admission. Invalid requests are not logged/cached here.
    const validRequest = (input as Reply).type === "request" && validPanePaintMessage(input);
    const request = structuredClone(input) as { id: string; payload?: { action: string; timeoutMs?: number; surfaceId?: string; expected?: { binding: { surfaceId: string } } } };
    const surface = this.ports.pairedSurface(connection);
    if (!this.ports.open(connection)) return no("closed");
    const forceBusy = this.publishing.has(connection);
    let epoch = this.epochs.get(connection);
    if (!epoch) { epoch = {}; this.epochs.set(connection, epoch); }
    const current = () => this.epochs.get(connection) === epoch && this.ports.open(connection) && this.ports.pairedSurface(connection) === surface;
    let last: number;
    try { last = this.ports.clock.now(); } catch { return no("internal_error"); }
    if (!Number.isFinite(last) || last < 0 || last > Number.MAX_SAFE_INTEGER) return no("internal_error");
    const origin = last, budget = validRequest && request.payload?.action === "observe" ? request.payload.timeoutMs! : 2000;
    const deadline = origin + budget;
    if (!Number.isFinite(deadline) || deadline > Number.MAX_SAFE_INTEGER) return no("internal_error");
    let failed = false;
    const now = () => {
      if (failed) throw Error("clock invalid");
      let value: number;
      try { value = this.ports.clock.now(); } catch { failed = true; throw Error("clock invalid"); }
      if (!Number.isFinite(value) || value < last || value > Number.MAX_SAFE_INTEGER) { failed = true; throw Error("clock invalid"); }
      last = value; return value;
    };
    const clock = { now, schedule: (callback: () => void, ms: number) => this.ports.clock.schedule(callback, ms) };
    if (!forceBusy) this.publishing.add(connection);
    let enqueued = false;
    let cancelSend = () => {};
    let finishKernel = () => {};
    let sendDrain: Promise<boolean> | undefined;
    const stop = (reason: string) => { this.close(connection); this.ports.terminate(connection); return no(reason, enqueued); };
    try {
      const reply = await this.service.handle(connection, input, { origin, clock, forceBusy, deferCompletion: finish => { finishKernel = finish; } });
      if (!reply || !current()) return no("closed");
      // Serialization consumes the same deadline, not a new timeout. No image response enters ordinary cache.
      const prepare = () => {
        if (reply.ok === true) {
          const payload = reply.payload as Reply;
          const time = now();
          payload.elapsedMs = time - origin;
          if ((payload.outcome === "observed" || payload.outcome === "described") && time >= deadline) {
            const described = payload.outcome === "described";
            delete payload.expectation; delete payload.expiresAfterMs;
            delete payload.midpointSkewMs; delete payload.consistency;
            Object.assign(payload, { outcome: "refused", reason: "timeout", stage: described ? "describe" : "publish",
              captures: payload.captures ?? [], checks: payload.checks ?? [], nativeDrain: { state: "not-required" } });
          }
        }
        if (reply.ok === true ? !validPanePaintOutcome(reply, input) : !validPanePaintError(reply)) throw Error("invalid outcome");
        return this.ports.encode?.(reply) ?? JSON.stringify(reply);
      };
      let encoded = prepare();
      // A synchronous encoding overrun changes success into a truthful refusal before queueing.
      if (now() >= deadline && reply.ok === true && (reply.payload as Reply).outcome !== "refused") encoded = prepare();
      if (!current()) return no("closed");
      if (Buffer.byteLength(encoded) > this.available(connection)) {
        encoded = JSON.stringify({ v: 1, type: "response", op: OP, id: request.id, sentAt: Date.now(), ok: false,
          error: { code: "content_too_large", message: "Diagnostic response exceeds remaining transport capacity" } });
        if (Buffer.byteLength(encoded) > this.available(connection)) return stop("transport-limit");
      }
      // Refusal/errors may truthfully overrun the configured budget; native/success cannot be certified late.
      const sent = this.ports.send(connection, encoded); sendDrain = sent; enqueued = true;
      const completion = await new Promise<boolean>(resolve => {
        const arm = () => {
          cancelSend = clock.schedule(() => {
            try { if (now() < deadline && current()) { arm(); return; } } catch { /* fail closed */ }
            resolve(false);
          }, Math.max(0, deadline - now()));
        };
        arm();
        void sent.then(ok => {
          try { resolve(ok && current() && now() < deadline); } catch { resolve(false); }
        }, () => resolve(false));
      });
      cancelSend();
      if (!completion) {
        // A queued frame cannot be retracted. Stop this private connection; never send a second response.
        this.close(connection); this.ports.terminate(connection); return no("publication-incomplete", true);
      }
      return { handled: true, enqueued: true, completed: true, reason: "published" };
    } catch { return stop("internal_error"); }
    finally {
      cancelSend();
      // Neither timeout nor close proves send/native drain. Retain app capacity until actual settlement.
      if (sendDrain) void sendDrain.then(finishKernel, finishKernel); else finishKernel();
      if (!forceBusy) this.publishing.delete(connection);
    }
  }
}
