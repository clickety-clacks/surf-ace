import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

/** Internal, unwired diagnostic contract. This is not a snapshot.get extension. */
export type PaintBinding = {
  surfaceId: string;
  surfaceEpoch: string;
  windowInstanceId: string;
  hostWebContentsId: number;
  paneId: number;
  paneLineageId: string;
  contentId: string;
  contentType: "html" | "browser_url";
  contentRevision: number;
  topologyRevision: number;
  geometryRevision: number;
  guestId: number;
  frameInstanceId: string;
  renderGeneration: number;
  documentGeneration: number;
};
export type PaintRect = { x: number; y: number; width: number; height: number };
export type PaintState = {
  binding: PaintBinding;
  hostAttached: boolean;
  guestAttached: boolean;
  guestDocument: {
    navigationUrlSha256: string;
    readyState: "loading" | "interactive" | "complete";
    bodyRect: PaintRect | null;
    backgroundColor: string;
  };
  projection: {
    coordinateSpace: "surface-css-px";
    guestCoordinateSpace: "guest-css-px";
    hostRect: PaintRect;
    clipRect: PaintRect;
    guestViewport: { width: number; height: number; scrollX: number; scrollY: number };
    guestToSurface: [number, number, number, number, number, number];
    devicePixelRatio: number;
    scaleMode: "host-transform" | "public-terminal-font";
    scaleSequence: number;
    scaleNonce: string;
    scaleRevision: number;
    hostVisible: boolean;
    opacity: number;
  };
};
export type PaintTarget = "GUEST" | "HOST";
export type PaintCapture = {
  target: PaintTarget;
  binding: PaintBinding;
  png: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
};
export type PaintImageReceipt = {
  target: PaintTarget;
  binding: PaintBinding;
  coordinateSpace: "guest-capture-pixels" | "host-capture-pixels";
  png: Uint8Array;
  sha256: string;
  pixelWidth: number;
  pixelHeight: number;
  startedMonotonicMs: number;
  endedMonotonicMs: number;
};
export type PaintReadReceipt = { stage: string; receivedMonotonicMs: number; state: PaintState };
export type PaintRefusal = "invalid-request" | "unavailable" | "stale" | "read-failed" | "capture-failed" | "invalid-image" | "timeout";
export type PaintObservation =
  | { kind: "refused"; reason: PaintRefusal; stage: string; captures: PaintImageReceipt[]; stateReads: PaintReadReceipt[] }
  | {
      kind: "observed";
      binding: PaintBinding;
      projection: PaintState["projection"];
      captures: [PaintImageReceipt, PaintImageReceipt];
      stateReads: PaintReadReceipt[];
      startedMonotonicMs: number;
      endedMonotonicMs: number;
      midpointSkewMs: number;
      atomic: false;
      consistency: "binding-and-projection-stable-at-observation-checks";
      paintFreshness: "not-established";
      physicalDisplay: "not-observed";
    };
export type PaintAdapter = {
  // Implementations must use fixed internal reads and an ownership-validated guest,
  // not caller-provided JS, cached state or arbitrary WebContents IDs.
  readState(signal: AbortSignal): Promise<PaintState | null>;
  capture(target: PaintTarget, state: PaintState, signal: AbortSignal): Promise<PaintCapture>;
};
export type PaintClock = {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
};
const defaultClock: PaintClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
const bindingKeys = ["surfaceId", "surfaceEpoch", "windowInstanceId", "hostWebContentsId", "paneId", "paneLineageId", "contentId", "contentType", "contentRevision", "topologyRevision", "geometryRevision", "guestId", "frameInstanceId", "renderGeneration", "documentGeneration"] as const;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function validBinding(binding: PaintBinding): boolean {
  if (!binding || typeof binding !== "object") return false;
  return ["surfaceId", "surfaceEpoch", "windowInstanceId", "paneLineageId", "contentId", "frameInstanceId"].every(
    (key) => typeof binding[key as keyof PaintBinding] === "string" && String(binding[key as keyof PaintBinding]).length > 0,
  ) && [binding.paneId, binding.guestId, binding.hostWebContentsId].every((value) => revision(value) && value > 0)
    && [binding.contentRevision, binding.topologyRevision, binding.geometryRevision, binding.renderGeneration, binding.documentGeneration].every(revision)
    && ["html", "browser_url"].includes(binding.contentType);
}
function sameBinding(left: PaintBinding, right: PaintBinding): boolean {
  return bindingKeys.every((key) => left[key] === right[key]);
}
function validRect(rect: PaintRect, positive: boolean): boolean {
  return Boolean(rect) && [rect.x, rect.y, rect.width, rect.height].every(finite)
    && (positive ? rect.width > 0 && rect.height > 0 : rect.width >= 0 && rect.height >= 0);
}
function projectionValues(p: PaintState["projection"]): unknown[] {
  return [p.coordinateSpace, p.guestCoordinateSpace, p.hostRect.x, p.hostRect.y, p.hostRect.width, p.hostRect.height,
    p.clipRect.x, p.clipRect.y, p.clipRect.width, p.clipRect.height,
    p.guestViewport.width, p.guestViewport.height, p.guestViewport.scrollX, p.guestViewport.scrollY,
    ...p.guestToSurface, p.devicePixelRatio, p.scaleMode, p.scaleSequence, p.scaleNonce, p.scaleRevision, p.hostVisible, p.opacity];
}
function validState(state: PaintState): boolean {
  if (!state || !validBinding(state.binding) || typeof state.hostAttached !== "boolean" || typeof state.guestAttached !== "boolean") return false;
  const doc = state.guestDocument;
  if (!doc || !/^[a-f0-9]{64}$/.test(doc.navigationUrlSha256) || !["loading", "interactive", "complete"].includes(doc.readyState)
    || (doc.bodyRect !== null && !validRect(doc.bodyRect, false))
    || typeof doc.backgroundColor !== "string" || !doc.backgroundColor || doc.backgroundColor.length > 128) return false;
  return validProjection(state.projection);
}
function validProjection(p: PaintState["projection"]): boolean {
  return Boolean(p) && p.coordinateSpace === "surface-css-px" && p.guestCoordinateSpace === "guest-css-px"
    && validRect(p.hostRect, true) && validRect(p.clipRect, false) && Boolean(p.guestViewport)
    && [p.guestViewport.width, p.guestViewport.height].every((v) => finite(v) && v > 0)
    && [p.guestViewport.scrollX, p.guestViewport.scrollY].every(finite)
    && Array.isArray(p.guestToSurface) && p.guestToSurface.length === 6 && p.guestToSurface.every(finite)
    && finite(p.devicePixelRatio) && p.devicePixelRatio > 0
    && ["host-transform", "public-terminal-font"].includes(p.scaleMode) && revision(p.scaleSequence) && p.scaleSequence > 0
    && typeof p.scaleNonce === "string" && p.scaleNonce.length > 0 && revision(p.scaleRevision) && p.scaleRevision > 0
    && typeof p.hostVisible === "boolean" && finite(p.opacity) && p.opacity >= 0 && p.opacity <= 1;
}
export function isPaintState(value: unknown): value is PaintState {
  try { return validState(value as PaintState); } catch { return false; }
}
// Validate retained PNG bytes independently of adapter-reported dimensions.
function validPng(bytes: Buffer, width: number, height: number, maxDecodedBytes: number, maxDimension: number): boolean {
  try {
    if (width > maxDimension || height > maxDimension || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
    let offset = 8, channels = 0, ended = false;
    let paletteSeen = false, idatSeen = false, idatEnded = false;
    const compressed: Buffer[] = [];
    while (offset < bytes.length) {
      if (bytes.length - offset < 12) return false;
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length) return false;
      const name = bytes.toString("ascii", offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/.test(name) || (!/[a-z]/.test(name[0]) && !["IHDR", "IDAT", "IEND", "PLTE"].includes(name))
        || (name === "PLTE" && (length === 0 || length > 768 || length % 3 !== 0))) return false;
      let crc = 0xffffffff;
      for (const value of bytes.subarray(offset + 4, end - 4)) {
        crc ^= value;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) return false;
      if (offset === 8) {
        if (name !== "IHDR" || length !== 13 || bytes.readUInt32BE(offset + 8) !== width
          || bytes.readUInt32BE(offset + 12) !== height || bytes[offset + 16] !== 8
          || ![2, 6].includes(bytes[offset + 17]) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) return false;
        channels = bytes[offset + 17] === 6 ? 4 : 3;
      } else if (name === "IHDR") return false;
      if (name === "PLTE") {
        if (paletteSeen || idatSeen) return false;
        paletteSeen = true;
      }
      if (name === "IDAT") {
        if (idatEnded) return false;
        idatSeen = true;
        compressed.push(bytes.subarray(offset + 8, end - 4));
      } else if (idatSeen) idatEnded = true;
      if (name === "IEND") {
        if (length !== 0 || end !== bytes.length) return false;
        ended = true;
      }
      offset = end;
    }
    const rowBytes = 1 + width * channels, expectedBytes = rowBytes * height;
    if (!ended || !compressed.length || !channels || expectedBytes > maxDecodedBytes) return false;
    const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes });
    return decoded.length === expectedBytes && Array.from({ length: height }, (_, row) => decoded[row * rowBytes]).every((filter) => filter <= 4);
  } catch { return false; }
}

class Refused extends Error {
  constructor(readonly reason: PaintRefusal, readonly stage: string) { super(reason); }
}

/** Captures are sequential and independently fenced; they are never atomic or physical-screen proof. */
export async function observePanePaint(
  expected: PaintBinding,
  adapter: PaintAdapter,
  options: { timeoutMs?: number; maxImageBytes?: number; maxDecodedBytes?: number; maxDimension?: number; expectedProjection?: PaintState["projection"]; clock?: PaintClock } = {},
): Promise<PaintObservation> {
  const captures: PaintImageReceipt[] = [];
  const stateReads: PaintReadReceipt[] = [];
  const timeoutMs = options.timeoutMs ?? 2_000;
  const maxImageBytes = options.maxImageBytes ?? 16 * 1024 * 1024;
  const maxDecodedBytes = options.maxDecodedBytes ?? 64 * 1024 * 1024;
  const maxDimension = options.maxDimension ?? 16_384;
  if (!validBinding(expected) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000
    || !Number.isSafeInteger(maxImageBytes) || maxImageBytes < 33 || maxImageBytes > 32 * 1024 * 1024
    || !Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1 || maxDecodedBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(maxDimension) || maxDimension < 1 || maxDimension > 16_384
    || (options.expectedProjection !== undefined && !validProjection(options.expectedProjection))) {
    return { kind: "refused", reason: "invalid-request", stage: "request", captures, stateReads };
  }
  expected = structuredClone(expected);
  const expectedProjection = options.expectedProjection === undefined ? undefined : structuredClone(options.expectedProjection);
  const clock = options.clock ?? defaultClock;
  let started: number;
  try { started = clock.now(); } catch {
    return { kind: "refused", reason: "invalid-request", stage: "clock", captures, stateReads };
  }
  if (!finite(started)) return { kind: "refused", reason: "invalid-request", stage: "clock", captures, stateReads };
  let lastTime = started;
  const controller = new AbortController();
  const time = (stage: string) => {
    const now = clock.now();
    if (!finite(now) || now < lastTime || now - started >= timeoutMs) throw new Refused("timeout", stage);
    lastTime = now;
    return now;
  };
  const wait = async <T>(stage: string, operation: () => Promise<T>, error: PaintRefusal): Promise<T> => {
    time(stage);
    let cancel = () => {};
    let settled = false;
    try {
      return await new Promise<T>((resolve, reject) => {
        cancel = clock.schedule(() => {
          settled = true;
          controller.abort();
          reject(new Refused("timeout", stage));
        }, timeoutMs - (lastTime - started));
        Promise.resolve().then(operation).then((value) => {
          if (settled) return;
          try { time(stage); settled = true; resolve(value); }
          catch (failure) { settled = true; controller.abort(); reject(failure); }
        }, () => {
          if (!settled) { settled = true; reject(new Refused(error, stage)); }
        });
      });
    } finally { cancel(); }
  };
  const read = async (stage: string, initial?: PaintState): Promise<PaintState> => {
    const state = await wait(stage, () => adapter.readState(controller.signal), "read-failed");
    if (!state || !validState(state)) throw new Refused("unavailable", stage);
    stateReads.push({ stage, receivedMonotonicMs: time(stage), state: structuredClone(state) });
    if (!state.hostAttached || !state.guestAttached) throw new Refused("unavailable", stage);
    if (!sameBinding(expected, state.binding)) throw new Refused("stale", stage);
    if (expectedProjection && projectionValues(expectedProjection).some((v, i) => v !== projectionValues(state.projection)[i])) {
      throw new Refused("stale", stage);
    }
    if (initial && projectionValues(initial.projection).some((v, i) => v !== projectionValues(state.projection)[i])) {
      throw new Refused("stale", stage);
    }
    return structuredClone(state);
  };
  try {
    const baseline = await read("before");
    for (const target of ["GUEST", "HOST"] as const) {
      await read(`${target}:before`, baseline);
      const start = time(`${target}:start`);
      const image = await wait(`${target}:capture`, () => adapter.capture(target, structuredClone(baseline), controller.signal), "capture-failed");
      const end = time(`${target}:end`);
      if (!image || image.target !== target || !validBinding(image.binding) || !sameBinding(expected, image.binding)) {
        throw new Refused("stale", `${target}:capture-binding`);
      }
      if (!(image.png instanceof Uint8Array) || image.png.byteLength < 33 || image.png.byteLength > maxImageBytes
        || !revision(image.pixelWidth) || !revision(image.pixelHeight) || image.pixelWidth < 1 || image.pixelHeight < 1) {
        throw new Refused("invalid-image", `${target}:image`);
      }
      const bytes = Buffer.from(image.png);
      if (!validPng(bytes, image.pixelWidth, image.pixelHeight, maxDecodedBytes, maxDimension)) {
        throw new Refused("invalid-image", `${target}:png`);
      }
      captures.push({ target, binding: structuredClone(image.binding),
        coordinateSpace: target === "GUEST" ? "guest-capture-pixels" : "host-capture-pixels",
        png: new Uint8Array(bytes), sha256: createHash("sha256").update(bytes).digest("hex"),
        pixelWidth: image.pixelWidth, pixelHeight: image.pixelHeight,
        startedMonotonicMs: start, endedMonotonicMs: end });
      await read(`${target}:after`, baseline);
    }
    await read("publish", baseline);
    const ended = time("publish");
    const pair = captures as [PaintImageReceipt, PaintImageReceipt];
    return { kind: "observed", binding: structuredClone(expected), projection: structuredClone(baseline.projection), captures: pair, stateReads,
      startedMonotonicMs: started, endedMonotonicMs: ended,
      midpointSkewMs: Math.abs((pair[0].startedMonotonicMs + pair[0].endedMonotonicMs) / 2
        - (pair[1].startedMonotonicMs + pair[1].endedMonotonicMs) / 2),
      atomic: false, consistency: "binding-and-projection-stable-at-observation-checks",
      paintFreshness: "not-established", physicalDisplay: "not-observed" };
  } catch (error) {
    controller.abort();
    return { kind: "refused", reason: error instanceof Refused ? error.reason : "read-failed",
      stage: error instanceof Refused ? error.stage : "unexpected", captures, stateReads };
  }
}
