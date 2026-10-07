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

  append(surfaceId: string, value: Omit<AnnotationSourceRecord, "protocolVersion" | "clientId" | "sourceEpoch" | "surfaceId" | "sourceSequence" | "sourceEventId">): string {
    const surface = this.surface(surfaceId);
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
    if (!this.fits(surfaceId)) {
      surface.fifo.pop();
      this.extendGap(surface, sourceSequence, "source_retention_overflow");
    }
    return sourceSequence;
  }

  frameId(surfaceId: string, paneId: number): string {
    const surface = this.surface(surfaceId);
    const key = String(paneId);
    if (surface.frames[key]) return surface.frames[key];
    const frameId = `fr_${randomBytes(16).toString("hex")}`;
    surface.frames[key] = frameId;
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
    const frameId = this.frameId(surfaceId, paneId);
    const frame: AnnotationOpenFrame = {
      ...structuredClone(capture), frameId, updatedAt: capture.openedAt, strokes: [],
      sourceStrokeCount: 0, publishedStrokeCount: 0,
    };
    surface.openFrames ??= {};
    surface.openFrames[key] = frame;
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
  }

  private validateState(): void {
    if (this.state.version !== 1 || this.state.clientId !== this.clientId ||
        !/^[0-9a-f]{32}$/.test(this.state.sourceEpoch) ||
        !this.state.surfaces || typeof this.state.surfaces !== "object") {
      throw new TypeError("invalid persisted annotation publisher state");
    }
    for (const [surfaceId, surface] of Object.entries(this.state.surfaces)) {
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
    }
  }
}
