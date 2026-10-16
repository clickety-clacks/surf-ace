import { randomBytes } from "node:crypto";
import {
  ANNOTATION_MAX_RECORD_BYTES,
  ANNOTATION_MAX_SEQUENCE,
  canonicalJson,
  parseAnnotationCursor,
  parseAnnotationSequence,
  validateAnnotationSource,
  type AnnotationCursor,
  type AnnotationSourceGap,
  type AnnotationSourceRecord,
  type CanonicalJson,
  type Stroke,
} from "@surf-ace/protocol";

export const ANNOTATION_PUBLISHER_MAX_BYTES = 67_108_864;
export const ANNOTATION_PUBLISHER_MAX_RECORDS = 256;
const GAP_SLOT_BYTES = 8_192;
export const ANNOTATION_DELIVERY_RECEIPT_LIMIT = 64;
export type AnnotationDeliveryReceipt = {
  kind: "live_delta" | "frame_commit";
  paneId: number;
  paneLineageId: string;
  contentId: string;
  revision: number;
  frameId: string;
  sourceEventId: string;
  sourceSequence: string;
  phase: "waiting" | "sent" | "rejected";
  acceptedCursor?: AnnotationCursor;
  errorCode?: string;
};

type GapReason = AnnotationSourceGap["reason"];
export type AnnotationPublisherEntry = {
  canonical: string;
  kind: "payload" | "gap";
  sourceEventId: string;
  sourceSequence: string;
};
type PendingGap = {
  from: string;
  through: string;
  sourceEventId: string;
  reason: GapReason;
};
export type AnnotationOpenFrame = {
  paneLineageId?: string;
  contentRevision?: number;
  frameId: string;
  contextKey: string;
  contentId: string;
  commitRequested?: boolean;
  directCommitDelivered?: boolean;
  url?: string;
  scrollOffset: { x: number; y: number };
  viewport: { width: number; height: number; scale: number };
  openedAt: number;
  updatedAt: number;
  image: string;
  failed?: true;
  sourceStrokeCount?: number;
  publishedStrokeCount?: number;
  strokes: Array<{
    strokeId: string;
    points: Array<{ x: number; y: number; pressure?: number }>;
    bbox: { x: number; y: number; width: number; height: number };
    startedAt: number;
    endedAt: number;
  }>;
};
export type AnnotationPublisherSurface = {
  acceptedCursor: AnnotationCursor | null;
  diagnostic: { code: string; sequence: string } | null;
  unhealthy?: { code: string; sequence: string } | null;
  fifo: AnnotationPublisherEntry[];
  frames: Record<string, string>;
  openFrames?: Record<string, AnnotationOpenFrame>;
  deliveryReceipts?: AnnotationDeliveryReceipt[];
  nextSequence: string;
  trailingGap: PendingGap | null;
};
export type PersistentAnnotationPublisher = {
  clientId: string;
  sourceEpoch: string;
  surfaces: Record<string, AnnotationPublisherSurface>;
  version: 1;
};

/** State mutations must be durably committed by the caller before `head` is sent. */
export class AnnotationPublisherOutbox {
  private state: PersistentAnnotationPublisher;

  constructor(
    private readonly clientId: string,
    state?: PersistentAnnotationPublisher,
    private readonly maxBytes = ANNOTATION_PUBLISHER_MAX_BYTES,
    private readonly maxRecords = ANNOTATION_PUBLISHER_MAX_RECORDS,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes > ANNOTATION_PUBLISHER_MAX_BYTES || maxBytes < 2 * GAP_SLOT_BYTES + 1024 ||
        !Number.isSafeInteger(maxRecords) || maxRecords < 2 || maxRecords > ANNOTATION_PUBLISHER_MAX_RECORDS) {
      throw new RangeError("invalid annotation publisher limits");
    }
    this.state = structuredClone(state ?? {
      version: 1, clientId, sourceEpoch: randomBytes(16).toString("hex"), surfaces: {},
    });
    this.validateState();
  }

  snapshot(): PersistentAnnotationPublisher { return structuredClone(this.state); }

  partitionBytes(surfaceId: string): number {
    const surface = this.state.surfaces[surfaceId];
    if (!surface) return 0;
    return Buffer.byteLength(JSON.stringify({ version: 1, clientId: this.clientId,
      sourceEpoch: this.state.sourceEpoch, ...surface }), "utf8");
  }

  pendingSurfaceIds(): string[] {
    return Object.entries(this.state.surfaces)
      .filter(([, surface]) => surface.fifo.length > 0 || surface.trailingGap !== null)
      .map(([surfaceId]) => surfaceId);
  }

  publishableSurfaceIds(): string[] {
    return this.pendingSurfaceIds().filter((surfaceId) => !this.state.surfaces[surfaceId]?.unhealthy);
  }

  unhealthySurfaceIds(): string[] {
    return Object.entries(this.state.surfaces).filter(([, surface]) => !!surface.unhealthy).map(([id]) => id);
  }

  markUnhealthy(surfaceId: string, code: string): void {
    const surface = this.surface(surfaceId);
    const sequence = surface.fifo[0]?.sourceSequence ?? surface.trailingGap?.from ?? surface.nextSequence;
    surface.unhealthy = { code: /^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : "annotation_protocol_invalid",
      sequence };
    if (!this.fits(surfaceId)) throw new RangeError("annotation publisher unhealthy state capacity");
  }

  needsSeal(surfaceId: string): boolean {
    const surface = this.state.surfaces[surfaceId];
    return !!surface?.trailingGap && !surface.fifo.some((entry) => entry.kind === "gap");
  }

  restore(state: PersistentAnnotationPublisher): void {
    const previous = this.state;
    this.state = structuredClone(state);
    try { this.validateState(); }
    catch (error) { this.state = previous; throw error; }
  }

  private surface(surfaceId: string): AnnotationPublisherSurface {
    const existing = this.state.surfaces[surfaceId];
    if (existing) return existing;
    if (Buffer.byteLength(surfaceId, "utf8") < 1 || Buffer.byteLength(surfaceId, "utf8") > 128) {
      throw new RangeError("invalid annotation surface ID");
    }
    const created: AnnotationPublisherSurface = {
      acceptedCursor: null, diagnostic: null, fifo: [], frames: {}, nextSequence: "1", trailingGap: null,
    };
    this.state.surfaces[surfaceId] = created;
    if (!this.fits(surfaceId)) {
      delete this.state.surfaces[surfaceId];
      throw new RangeError("annotation publisher state capacity");
    }
    return created;
  }

  private fits(surfaceId: string): boolean {
    const surface = this.state.surfaces[surfaceId];
    if (!surface || surface.fifo.length > this.maxRecords ||
        surface.fifo.some((entry) => Buffer.byteLength(entry.canonical, "utf8") > ANNOTATION_MAX_RECORD_BYTES)) return false;
    return this.partitionBytes(surfaceId) + 2 * GAP_SLOT_BYTES <= this.maxBytes;
  }

  append(surfaceId: string, value: Omit<AnnotationSourceRecord, "protocolVersion" | "clientId" | "sourceEpoch" | "surfaceId" | "sourceSequence" | "sourceEventId">,
    paneLineageId?: string): string {
    const surface = this.surface(surfaceId);
    if (Number.isSafeInteger(value.paneId)) this.forgetDeliveryReceipt(surfaceId, value.paneId as number);
    const sequence = parseAnnotationSequence(surface.nextSequence);
    if (sequence >= ANNOTATION_MAX_SEQUENCE) throw new RangeError("annotation source sequence exhausted");
    const sourceSequence = sequence.toString();
    surface.nextSequence = (sequence + 1n).toString();
    if (surface.trailingGap || surface.fifo.some((entry) => entry.kind === "gap")) {
      this.extendGap(surface, sourceSequence, "source_retention_overflow");
      return sourceSequence;
    }
    const sourceEventId = randomBytes(16).toString("hex");
    const record = {
      ...value, protocolVersion: 1, clientId: this.clientId,
      sourceEpoch: this.state.sourceEpoch, surfaceId, sourceSequence, sourceEventId,
    };
    let canonical: string;
    try {
      validateAnnotationSource(record);
      canonical = canonicalJson(record as never);
    } catch {
      this.extendGap(surface, sourceSequence, "source_record_rejected");
      surface.diagnostic = { code: "annotation_invalid_request", sequence: sourceSequence };
      return sourceSequence;
    }
    if (Buffer.byteLength(canonical, "utf8") > ANNOTATION_MAX_RECORD_BYTES ||
        surface.fifo.length >= this.maxRecords - 1) {
      this.extendGap(surface, sourceSequence, "source_retention_overflow");
      return sourceSequence;
    }
    surface.fifo.push({ canonical, kind: "payload", sourceEventId, sourceSequence });
    this.trimDeliveryReceipts(surfaceId);
    if (!this.fits(surfaceId)) {
      surface.fifo.pop();
      this.extendGap(surface, sourceSequence, "source_retention_overflow");
    }
    if (paneLineageId && surface.fifo.some((entry) => entry.sourceEventId === sourceEventId && entry.kind === "payload")) {
      // Local metadata only: never change the canonical registry record. Missing
      // legacy ownership means unknown UI status, not a fabricated receipt.
      const receipt: AnnotationDeliveryReceipt = {
        kind: value.kind as "live_delta" | "frame_commit",
        paneId: value.paneId as number, paneLineageId, contentId: value.contentId as string,
        revision: value.revision as number, frameId: value.frameId as string,
        sourceEventId, sourceSequence, phase: "waiting",
      };
      if (this.validDeliveryReceipt(receipt)) {
        surface.deliveryReceipts = (surface.deliveryReceipts ?? []).filter((r) => r.paneId !== receipt.paneId);
        surface.deliveryReceipts.push(receipt);
        this.trimDeliveryReceipts(surfaceId);
      }
    }
    return sourceSequence;
  }

  deliveryReceiptFor(surfaceId: string, paneId: number, paneLineageId: string,
    contentId: string, revision: number): AnnotationDeliveryReceipt | null {
    const receipt = this.state.surfaces[surfaceId]?.deliveryReceipts?.find((r) =>
      r.paneId === paneId && r.paneLineageId === paneLineageId && r.contentId === contentId && r.revision === revision);
    return receipt ? structuredClone(receipt) : null;
  }

  deliveryReceiptsSnapshot(): Record<string, AnnotationDeliveryReceipt[]> {
    return Object.fromEntries(Object.entries(this.state.surfaces).map(([surfaceId, surface]) =>
      [surfaceId, structuredClone(surface.deliveryReceipts ?? [])]));
  }

  pendingDeliveryFramesSnapshot(): Record<string, Array<{ paneId: number; paneLineageId?: string;
    contentId: string; contentRevision?: number; frameId: string; commitRequested: boolean }>> {
    return Object.fromEntries(Object.entries(this.state.surfaces).map(([id, surface]) => [id,
      Object.entries(surface.openFrames ?? {}).map(([paneId, frame]) => ({ paneId: Number(paneId),
        paneLineageId: frame.paneLineageId, contentId: frame.contentId, contentRevision: frame.contentRevision,
        frameId: frame.frameId, commitRequested: frame.commitRequested === true }))]));
  }

  forgetDeliveryReceipt(surfaceId: string, paneId: number): void {
    const surface = this.state.surfaces[surfaceId];
    if (surface?.deliveryReceipts) surface.deliveryReceipts = surface.deliveryReceipts.filter((r) => r.paneId !== paneId);
  }

  private trimDeliveryReceipts(surfaceId: string): void {
    const surface = this.state.surfaces[surfaceId]!;
    // Evict UI metadata only, never FIFO/image/source data. Eviction means
    // unknown delivery on restoration; it cannot imply acceptance or no work.
    while (surface.deliveryReceipts?.length &&
      (surface.deliveryReceipts.length > ANNOTATION_DELIVERY_RECEIPT_LIMIT || !this.fits(surfaceId))) {
      surface.deliveryReceipts.shift();
    }
  }

  private validDeliveryReceipt(receipt: AnnotationDeliveryReceipt): boolean {
    try {
      if (!Number.isSafeInteger(receipt.paneId) || receipt.paneId <= 0 ||
          !["live_delta", "frame_commit"].includes(receipt.kind) ||
          typeof receipt.paneLineageId !== "string" || !receipt.paneLineageId || receipt.paneLineageId.length > 256 ||
          typeof receipt.contentId !== "string" || !receipt.contentId || receipt.contentId.length > 512 ||
          !Number.isSafeInteger(receipt.revision) || receipt.revision < 0 ||
          typeof receipt.frameId !== "string" || !receipt.frameId || receipt.frameId.length > 256 ||
          typeof receipt.sourceEventId !== "string" || !/^[0-9a-f]{32}$/.test(receipt.sourceEventId) ||
          !["waiting", "sent", "rejected"].includes(receipt.phase)) return false;
      parseAnnotationSequence(receipt.sourceSequence);
      if (receipt.phase === "sent") return !!receipt.acceptedCursor && !!parseAnnotationCursor(receipt.acceptedCursor) && receipt.errorCode === undefined;
      return receipt.acceptedCursor === undefined && (receipt.phase === "waiting"
        ? receipt.errorCode === undefined : typeof receipt.errorCode === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(receipt.errorCode));
    } catch { return false; }
  }

  frameId(surfaceId: string, paneId: number): string {
    const surface = this.surface(surfaceId);
    const key = String(paneId);
    if (surface.frames[key]) return surface.frames[key];
    const frameId = `fr_${randomBytes(16).toString("hex")}`;
    surface.frames[key] = frameId;
    this.trimDeliveryReceipts(surfaceId);
    if (!this.fits(surfaceId)) {
      delete surface.frames[key];
      throw new RangeError("annotation publisher frame state capacity");
    }
    return frameId;
  }

  /** The caller persists this before allowing the first point to render. */
  openFrame(surfaceId: string, paneId: number, capture: Omit<AnnotationOpenFrame, "frameId" | "updatedAt" | "strokes">): AnnotationOpenFrame {
    const surface = this.surface(surfaceId);
    const key = String(paneId);
    const existing = surface.openFrames?.[key];
    if (existing) return structuredClone(existing);
    this.forgetDeliveryReceipt(surfaceId, paneId);
    const frameId = this.frameId(surfaceId, paneId);
    const frame: AnnotationOpenFrame = {
      ...structuredClone(capture), frameId, updatedAt: capture.openedAt, strokes: [],
      sourceStrokeCount: 0, publishedStrokeCount: 0,
    };
    surface.openFrames ??= {};
    surface.openFrames[key] = frame;
    this.trimDeliveryReceipts(surfaceId);
    if (!this.fits(surfaceId)) {
      delete surface.openFrames[key];
      throw new RangeError("annotation at-open frame exceeds publisher state capacity");
    }
    return structuredClone(frame);
  }

  openFrameFor(surfaceId: string, paneId: number): AnnotationOpenFrame | null {
    const frame = this.state.surfaces[surfaceId]?.openFrames?.[String(paneId)];
    return frame ? structuredClone(frame) : null;
  }

  requestFrameCommit(surfaceId: string, paneId: number, requested: boolean): void {
    const frame = this.state.surfaces[surfaceId]?.openFrames?.[String(paneId)];
    if (!frame || frame.directCommitDelivered) return;
    frame.commitRequested = requested;
  }

  markDirectCommitDelivered(surfaceId: string, paneId: number): void {
    const frame = this.state.surfaces[surfaceId]?.openFrames?.[String(paneId)];
    if (!frame?.commitRequested) throw new Error("annotation direct commit has no durable intent");
    frame.directCommitDelivered = true;
  }

  appendFrameStroke(surfaceId: string, paneId: number, stroke: AnnotationOpenFrame["strokes"][number]): void {
    const surface = this.surface(surfaceId);
    const frame = surface.openFrames?.[String(paneId)];
    if (!frame) throw new Error("annotation at-open frame is absent");
    if (frame.strokes.some((entry) => entry.strokeId === stroke.strokeId)) return;
    const previousUpdatedAt = frame.updatedAt;
    frame.strokes.push(structuredClone(stroke));
    frame.updatedAt = Math.max(frame.updatedAt, stroke.endedAt);
    this.trimDeliveryReceipts(surfaceId);
    if (!this.fits(surfaceId)) {
      frame.strokes.pop();
      frame.updatedAt = previousUpdatedAt;
      throw new RangeError("annotation frame strokes exceed publisher state capacity");
    }
  }

  /** Keep the direct-client stroke even if the bounded publisher copy is lost. */
  recordStroke(surfaceId: string, paneId: number, stroke: Stroke): void {
    const frame = this.state.surfaces[surfaceId]?.openFrames?.[String(paneId)];
    if (!frame) return;
    if (!frame.failed && frame.strokes.some((entry) => entry.strokeId === stroke.strokeId)) return;
    frame.sourceStrokeCount = (frame.sourceStrokeCount ?? frame.strokes.length) + 1;
    if (frame.failed) return;
    try {
      if (stroke.points.length === 0) throw new RangeError("empty annotation stroke");
      const xs = stroke.points.map((point) => point.x);
      const ys = stroke.points.map((point) => point.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const last = stroke.points[stroke.points.length - 1]!;
      this.appendFrameStroke(surfaceId, paneId, {
        strokeId: stroke.strokeId,
        points: stroke.points.map((point) => ({ x: point.x, y: point.y,
          ...(point.pressure === undefined ? {} : { pressure: point.pressure }) })),
        bbox: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
        startedAt: stroke.points[0]!.timestamp, endedAt: last.timestamp,
      });
    } catch {
      frame.failed = true;
      frame.image = "";
      frame.strokes = [];
      this.state.surfaces[surfaceId]!.diagnostic = {
        code: "annotation_frame_source_overflow",
        sequence: this.state.surfaces[surfaceId]!.nextSequence,
      };
    }
  }

  markFramePublished(surfaceId: string, paneId: number): void {
    const frame = this.state.surfaces[surfaceId]?.openFrames?.[String(paneId)];
    if (!frame) return;
    frame.publishedStrokeCount = frame.sourceStrokeCount ?? frame.strokes.length;
  }

  closeFrame(surfaceId: string, paneId: number): void {
    const surface = this.surface(surfaceId);
    delete surface.frames[String(paneId)];
    if (surface.openFrames) delete surface.openFrames[String(paneId)];
  }

  lose(surfaceId: string, code: string): string {
    const surface = this.surface(surfaceId);
    const sequence = parseAnnotationSequence(surface.nextSequence);
    if (sequence >= ANNOTATION_MAX_SEQUENCE) throw new RangeError("annotation source sequence exhausted");
    const sourceSequence = sequence.toString();
    surface.nextSequence = (sequence + 1n).toString();
    this.extendGap(surface, sourceSequence, "source_retention_overflow");
    surface.diagnostic = { code, sequence: sourceSequence };
    return sourceSequence;
  }

  private extendGap(surface: AnnotationPublisherSurface, sequence: string, reason: GapReason): void {
    if (surface.trailingGap) {
      surface.trailingGap.through = sequence;
      return;
    }
    surface.trailingGap = { from: sequence, through: sequence,
      sourceEventId: randomBytes(16).toString("hex"), reason };
  }

  /** Seal before first send; later losses use the second reserved gap slot. */
  head(surfaceId: string): AnnotationPublisherEntry | null {
    const surface = this.surface(surfaceId);
    if (!surface.fifo.some((entry) => entry.kind === "gap") && surface.trailingGap) {
      const gap = surface.trailingGap;
      const record: AnnotationSourceGap = {
        protocolVersion: 1, clientId: this.clientId, sourceEpoch: this.state.sourceEpoch,
        surfaceId, sourceSequence: gap.through, sourceEventId: gap.sourceEventId,
        lostFromSequence: gap.from, lostThroughSequence: gap.through, reason: gap.reason,
      };
      validateAnnotationSource(record);
      const canonical = canonicalJson(record as unknown as CanonicalJson);
      surface.fifo.push({ canonical, kind: "gap", sourceEventId: gap.sourceEventId, sourceSequence: gap.through });
      surface.trailingGap = null;
      if (!this.fits(surfaceId)) throw new RangeError("annotation gap reserve violated");
    }
    return surface.fifo[0] ? structuredClone(surface.fifo[0]) : null;
  }

  accepted(surfaceId: string, entry: AnnotationPublisherEntry, cursor: AnnotationCursor): void {
    const surface = this.surface(surfaceId);
    if (surface.fifo[0]?.canonical !== entry.canonical || surface.fifo[0]?.sourceEventId !== entry.sourceEventId) {
      throw new Error("annotation acceptance is not the FIFO head");
    }
    parseAnnotationCursor(cursor);
    surface.fifo.shift();
    surface.acceptedCursor = structuredClone(cursor);
    const receipt = surface.deliveryReceipts?.find((r) => r.sourceEventId === entry.sourceEventId);
    if (entry.kind === "payload" && receipt) {
      receipt.phase = "sent";
      receipt.acceptedCursor = structuredClone(cursor);
      delete receipt.errorCode;
      this.trimDeliveryReceipts(surfaceId);
    }
  }

  /** Only a definite record-specific rejection may replace an unaccepted payload. */
  rejectHead(surfaceId: string, code: "annotation_record_too_large" | "annotation_context_image_invalid"): void {
    const surface = this.surface(surfaceId);
    const head = surface.fifo[0];
    if (!head || head.kind !== "payload") throw new Error("no rejectable annotation payload");
    const record: AnnotationSourceGap = {
      protocolVersion: 1, clientId: this.clientId, sourceEpoch: this.state.sourceEpoch,
      surfaceId, sourceSequence: head.sourceSequence, sourceEventId: head.sourceEventId,
      lostFromSequence: head.sourceSequence, lostThroughSequence: head.sourceSequence,
      reason: "source_record_rejected",
    };
    const canonical = canonicalJson(record as unknown as CanonicalJson);
    surface.fifo[0] = { canonical, kind: "gap", sourceEventId: head.sourceEventId,
      sourceSequence: head.sourceSequence };
    surface.diagnostic = { code, sequence: head.sourceSequence };
    const receipt = surface.deliveryReceipts?.find((r) => r.sourceEventId === head.sourceEventId);
    if (receipt) { receipt.phase = "rejected"; receipt.errorCode = code; this.trimDeliveryReceipts(surfaceId); }
  }

  private validateState(): void {
    if (this.state.version !== 1 || this.state.clientId !== this.clientId ||
        !/^[0-9a-f]{32}$/.test(this.state.sourceEpoch) ||
        !this.state.surfaces || typeof this.state.surfaces !== "object") {
      throw new TypeError("invalid persisted annotation publisher state");
    }
    for (const [surfaceId, surface] of Object.entries(this.state.surfaces)) {
      if (surface.deliveryReceipts !== undefined && (!Array.isArray(surface.deliveryReceipts) ||
          surface.deliveryReceipts.length > ANNOTATION_DELIVERY_RECEIPT_LIMIT ||
          surface.deliveryReceipts.some((r) => !r || !this.validDeliveryReceipt(r)) ||
          new Set(surface.deliveryReceipts.map((r) => r.paneId)).size !== surface.deliveryReceipts.length)) {
        throw new TypeError("invalid persisted annotation delivery receipts");
      }
      parseAnnotationSequence(surface.nextSequence);
      if (!surface.frames || typeof surface.frames !== "object" ||
          (surface.unhealthy != null &&
            (!/^[a-z][a-z0-9_]{0,127}$/.test(surface.unhealthy.code) ||
             typeof surface.unhealthy.sequence !== "string" ||
             !/^[1-9][0-9]*$/.test(surface.unhealthy.sequence))) ||
          Object.values(surface.frames).some((id) => !/^fr_[0-9a-f]{32}$/.test(id)) ||
          (surface.openFrames !== undefined && (typeof surface.openFrames !== "object" ||
            Object.entries(surface.openFrames).some(([key, frame]) =>
              surface.frames[key] !== frame.frameId || typeof frame.image !== "string" ||
              (frame.paneLineageId !== undefined && (typeof frame.paneLineageId !== "string" || !frame.paneLineageId || frame.paneLineageId.length > 256)) ||
              (frame.contentRevision !== undefined && (!Number.isSafeInteger(frame.contentRevision) || frame.contentRevision < 0)) ||
              !Array.isArray(frame.strokes) ||
              (frame.commitRequested !== undefined && typeof frame.commitRequested !== "boolean") ||
              (frame.directCommitDelivered !== undefined &&
                (typeof frame.directCommitDelivered !== "boolean" ||
                 (frame.directCommitDelivered && frame.commitRequested !== true)))))) ||
          !Array.isArray(surface.fifo) || surface.fifo.length > this.maxRecords || !this.fits(surfaceId)) {
        throw new RangeError("persisted annotation publisher state exceeds capacity");
      }
      if (surface.acceptedCursor) parseAnnotationCursor(surface.acceptedCursor);
      for (const entry of surface.fifo) {
        if (typeof entry.canonical !== "string" || canonicalJson(JSON.parse(entry.canonical)) !== entry.canonical) {
          throw new TypeError("persisted annotation source bytes are not canonical");
        }
        validateAnnotationSource(JSON.parse(entry.canonical));
      }
      for (const receipt of surface.deliveryReceipts ?? []) {
        if (parseAnnotationSequence(receipt.sourceSequence) >= parseAnnotationSequence(surface.nextSequence)) {
          throw new TypeError("invalid persisted annotation delivery receipts");
        }
        if (receipt.phase === "waiting") {
          const entry = surface.fifo.find((e) => e.kind === "payload" && e.sourceEventId === receipt.sourceEventId);
          const record = entry && JSON.parse(entry.canonical);
          if (!record || record.surfaceId !== surfaceId || record.clientId !== this.clientId ||
              record.sourceEpoch !== this.state.sourceEpoch || record.sourceSequence !== receipt.sourceSequence ||
              record.kind !== receipt.kind ||
              record.paneId !== receipt.paneId || record.frameId !== receipt.frameId ||
              record.contentId !== receipt.contentId || record.revision !== receipt.revision) {
            throw new TypeError("invalid persisted annotation delivery receipts");
          }
        }
      }
    }
  }
}
