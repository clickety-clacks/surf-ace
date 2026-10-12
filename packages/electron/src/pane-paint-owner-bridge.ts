import { randomBytes } from "node:crypto";
import type { PaintClock, PaintRect } from "./pane-painted-observation.js";

export type RendererPaintRequest = { nonce: string; paneId: number; surfaceId: string; windowInstanceId: string };
export type RendererPaintDescriptor = {
  paneId: number; surfaceId: string; surfaceEpoch: string; topologyRevision: number; geometryRevision: number;
  contentId: string; contentRevision: number; contentType: "html" | "browser_url"; contentKey: string;
  rendererFrameInstanceId: string; renderGeneration: number; guestId: number;
  paneRect: PaintRect; frameRect: PaintRect; clipRect: PaintRect;
  frameCssWidth: number; frameCssHeight: number; transform: string; transformOrigin: string;
  opacity: number; hostVisible: boolean; devicePixelRatio: number;
  scaleMode: "host-transform" | "public-terminal-font"; scaleSequence: number; scaleNonce: string; scaleRevision: number;
};
export type RendererPaintReply = RendererPaintRequest & { descriptor: RendererPaintDescriptor | null };
export type PaintOwner<W extends object, H extends object, F extends object> = {
  window: W; host: H; frame: F; surfaceId: string; windowInstanceId: string; hostId: number;
};
const defaultClock: PaintClock = { now: () => performance.now(), schedule: (f, ms) => { const t = setTimeout(f, ms); return () => clearTimeout(t); } };
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const integer = (v: unknown) => number(v) && Number.isSafeInteger(v);
const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256;
const rect = (v: unknown) => {
  const r = v as PaintRect | null; return r !== null && typeof r === "object" && Object.keys(r).sort().join() === "height,width,x,y"
    && [r.x, r.y].every(n => typeof n === "number" && Number.isFinite(n)) && number(r.width) && r.width > 0 && number(r.height) && r.height > 0;
};
export function validRendererPaintDescriptor(value: unknown): value is RendererPaintDescriptor {
  const d = value as RendererPaintDescriptor | null;
  if (!d || typeof d !== "object") return false;
  const fields = "paneId surfaceId surfaceEpoch topologyRevision geometryRevision contentId contentRevision contentType contentKey rendererFrameInstanceId renderGeneration guestId paneRect frameRect clipRect frameCssWidth frameCssHeight transform transformOrigin opacity hostVisible devicePixelRatio scaleMode scaleSequence scaleNonce scaleRevision".split(" ");
  if (Object.keys(d).length !== fields.length || fields.some(key => !Object.hasOwn(d, key))) return false;
  return [d.paneId, d.contentRevision, d.topologyRevision, d.geometryRevision, d.renderGeneration, d.guestId, d.scaleSequence, d.scaleRevision].every(integer)
    && d.paneId > 0 && d.guestId > 0 && [d.surfaceId, d.surfaceEpoch, d.contentId, d.contentKey, d.rendererFrameInstanceId, d.scaleNonce].every(text)
    && ["html", "browser_url"].includes(d.contentType) && ["host-transform", "public-terminal-font"].includes(d.scaleMode)
    && [d.paneRect, d.frameRect, d.clipRect].every(rect) && number(d.frameCssWidth) && d.frameCssWidth > 0 && number(d.frameCssHeight) && d.frameCssHeight > 0
    && text(d.transform) && text(d.transformOrigin) && number(d.opacity) && d.opacity <= 1 && typeof d.hostVisible === "boolean" && number(d.devicePixelRatio) && d.devicePixelRatio > 0;
}

/** Internal only: a reply must come from the exact requesting host and its same main-frame object. */
export class FreshPanePaintReads<W extends object, H extends object, F extends object> {
  private pending = new Map<string, { owner: PaintOwner<W,H,F>; paneId: number; finish: (value: RendererPaintDescriptor | null) => void }>();
  constructor(private ports: { owner(surfaceId: string): PaintOwner<W,H,F> | null; send(owner: PaintOwner<W,H,F>, request: RendererPaintRequest): void; clock?: PaintClock; nonce?: () => string }) {}
  private same(a: PaintOwner<W,H,F>, b: PaintOwner<W,H,F> | null): boolean {
    return !!b && a.window === b.window && a.host === b.host && a.frame === b.frame && a.surfaceId === b.surfaceId && a.windowInstanceId === b.windowInstanceId && a.hostId === b.hostId;
  }
  invalidate(host: H): void { for (const slot of [...this.pending.values()]) if (slot.owner.host === host) slot.finish(null); }
  async read(surfaceId: string, paneId: number, signal: AbortSignal, timeoutMs: number): Promise<RendererPaintDescriptor | null> {
    if (signal.aborted || !integer(paneId) || paneId < 1 || !number(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2000 || this.pending.size >= 2) return null;
    let owner: PaintOwner<W,H,F> | null;
    try { owner = this.ports.owner(surfaceId); } catch { return null; }
    if (!owner || [...this.pending.values()].some(p => p.owner.host === owner!.host)) return null;
    const clock = this.ports.clock ?? defaultClock;
    let now: number, nonce: string;
    try { now = clock.now(); nonce = this.ports.nonce?.() ?? randomBytes(16).toString("hex"); } catch { return null; }
    if (!number(now) || !/^[a-f0-9]{32}$/.test(nonce) || this.pending.has(nonce) || !number(now + timeoutMs)) return null;
    const deadline = now + timeoutMs; let last = now;
    return new Promise(resolve => {
      let cancel = () => {}, finished = false;
      const finish = (value: RendererPaintDescriptor | null) => {
        if (finished) return; finished = true; this.pending.delete(nonce); cancel(); signal.removeEventListener("abort", abort); resolve(value);
      };
      const abort = () => finish(null);
      this.pending.set(nonce, { owner: owner!, paneId, finish: value => {
        try { const t = clock.now(); if (!number(t) || t < last || t >= deadline || !this.same(owner!, this.ports.owner(surfaceId))) value = null; last = t; } catch { value = null; }
        finish(value);
      } });
      signal.addEventListener("abort", abort, { once: true });
      try {
        const arm = () => {
          cancel = clock.schedule(() => {
            try { const t = clock.now(); if (!number(t) || t < last || t >= deadline) { finish(null); return; } last = t; arm(); }
            catch { finish(null); }
          }, Math.max(0, deadline - last));
        };
        arm();
        if (signal.aborted || !this.same(owner!, this.ports.owner(surfaceId))) { finish(null); return; }
        this.ports.send(owner!, { nonce, paneId, surfaceId, windowInstanceId: owner!.windowInstanceId });
      } catch { finish(null); }
    });
  }
  accept(host: H, senderFrame: F, input: unknown): void {
    if (!input || typeof input !== "object") return;
    const reply = input as RendererPaintReply;
    const slot = this.pending.get(reply.nonce);
    if (!slot || slot.owner.host !== host || slot.owner.frame !== senderFrame || reply.surfaceId !== slot.owner.surfaceId
      || reply.windowInstanceId !== slot.owner.windowInstanceId || reply.paneId !== slot.paneId) return;
    if (reply.descriptor === null) { slot.finish(null); return; }
    if (!validRendererPaintDescriptor(reply.descriptor) || reply.descriptor.surfaceId !== reply.surfaceId || reply.descriptor.paneId !== reply.paneId) { slot.finish(null); return; }
    try { slot.finish(structuredClone(reply.descriptor)); } catch { slot.finish(null); }
  }
}

/** An attachment event, actual object membership and current native main frame are all mandatory. */
export class NativePanePaintOwners<W extends object,H extends object,F extends object,G extends object> {
  private entries = new Map<number, { owner: PaintOwner<W,H,F>; guest: G; frame: F; frameKey: string; frameInstanceId: string; documentGeneration: number }>();
  constructor(private ports: { owner(surfaceId: string): PaintOwner<W,H,F> | null; guestId(guest: G): number; host(guest: G): H | null; frame(guest: G): F | null; frameKey(frame: F): string; alive(guest: G): boolean; nonce?: () => string }) {}
  private fresh(owner: PaintOwner<W,H,F>): boolean {
    const current = this.ports.owner(owner.surfaceId);
    return !!current && current.window === owner.window && current.host === owner.host && current.frame === owner.frame && current.windowInstanceId === owner.windowInstanceId && current.hostId === owner.hostId;
  }
  attach(surfaceId: string, guest: G): boolean {
    try {
      const owner = this.ports.owner(surfaceId), frame = this.ports.frame(guest), id = this.ports.guestId(guest);
      if (!owner || !frame || !integer(id) || id < 1 || !this.ports.alive(guest) || this.ports.host(guest) !== owner.host) return false;
      const existing = this.entries.get(id);
      if (existing?.guest === guest) return !!this.read(surfaceId,id);
      this.entries.set(id, { owner, guest, frame, frameKey: this.ports.frameKey(frame), frameInstanceId: this.ports.nonce?.() ?? randomBytes(16).toString("hex"), documentGeneration: 0 });
      return true;
    } catch { return false; }
  }
  retire(guest: G): void { for (const [id, entry] of this.entries) if (entry.guest === guest) this.entries.delete(id); }
  retireHost(host: H): void { for (const [id, entry] of this.entries) if (entry.owner.host === host) this.entries.delete(id); }
  navigation(guest: G): void {
    for (const entry of this.entries.values()) if (entry.guest === guest) {
      if (entry.documentGeneration >= Number.MAX_SAFE_INTEGER) { this.retire(guest); return; }
      entry.documentGeneration++;
    }
  }
  read(surfaceId: string, guestId: number): { owner: PaintOwner<W,H,F>; guest: G; frame: F; frameInstanceId: string; documentGeneration: number } | null {
    const entry = this.entries.get(guestId);
    if (!entry || entry.owner.surfaceId !== surfaceId) return null;
    try {
      if (!this.fresh(entry.owner) || !this.ports.alive(entry.guest) || this.ports.guestId(entry.guest) !== guestId || this.ports.host(entry.guest) !== entry.owner.host) return null;
      const frame = this.ports.frame(entry.guest); if (!frame) return null;
      const key = this.ports.frameKey(frame);
      if (frame !== entry.frame || key !== entry.frameKey) {
        entry.frame = frame; entry.frameKey = key; entry.frameInstanceId = this.ports.nonce?.() ?? randomBytes(16).toString("hex");
        if (entry.documentGeneration >= Number.MAX_SAFE_INTEGER) { this.retire(entry.guest); return null; }
        entry.documentGeneration++;
      }
      return { owner: { ...entry.owner }, guest: entry.guest, frame, frameInstanceId: entry.frameInstanceId, documentGeneration: entry.documentGeneration };
    } catch { return null; }
  }
}

export type PanePaintAuthority = {
  surfaceId: string; surfaceEpoch: string; paneId: number; paneLineageId: string;
  topologyRevision: number; geometryRevision: number; contentId: string; contentType: "html" | "browser_url";
  contentRevision: number; renderVersion: number; paneRect: PaintRect;
};
/** Canonical snapshot revision qualification is mandatory before a rectangle can authorize a HOST crop. */
export function rendererPaintMatchesAuthority(d: RendererPaintDescriptor, a: PanePaintAuthority): boolean {
  return validRendererPaintDescriptor(d) && d.surfaceId === a.surfaceId && d.surfaceEpoch === a.surfaceEpoch && d.paneId === a.paneId
    && d.topologyRevision === a.topologyRevision && d.geometryRevision === a.geometryRevision
    && d.contentId === a.contentId && d.contentType === a.contentType && d.contentRevision === a.contentRevision
    && d.contentKey === `renderer:${a.contentType}:${a.contentId}:${a.contentRevision}:${a.renderVersion}`
    && text(a.paneLineageId) && rect(a.paneRect) && ["x", "y", "width", "height"].every(k => d.paneRect[k as keyof PaintRect] === a.paneRect[k as keyof PaintRect]);
}
