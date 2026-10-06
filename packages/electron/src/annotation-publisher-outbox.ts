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
export type AnnotationPublisherSurface = {
  acceptedCursor: AnnotationCursor | null;
  diagnostic: { code: string; sequence: string } | null;
  fifo: AnnotationPublisherEntry[];
  nextSequence: string;
  trailingGap: PendingGap | null;
};
export type PersistentAnnotationPublisher = {
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
      version: 1, sourceEpoch: randomBytes(16).toString("hex"), surfaces: {},
    });
    this.validateState();
  }

  snapshot(): PersistentAnnotationPublisher { return structuredClone(this.state); }

  private surface(surfaceId: string): AnnotationPublisherSurface {
    const existing = this.state.surfaces[surfaceId];
    if (existing) return existing;
    if (Buffer.byteLength(surfaceId, "utf8") < 1 || Buffer.byteLength(surfaceId, "utf8") > 128) {
      throw new RangeError("invalid annotation surface ID");
    }
    const created: AnnotationPublisherSurface = {
      acceptedCursor: null, diagnostic: null, fifo: [], nextSequence: "1", trailingGap: null,
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
    return Buffer.byteLength(JSON.stringify({ version: 1, sourceEpoch: this.state.sourceEpoch, ...surface }), "utf8") +
      2 * GAP_SLOT_BYTES <= this.maxBytes;
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
    if (this.state.version !== 1 || !/^[0-9a-f]{32}$/.test(this.state.sourceEpoch) ||
        !this.state.surfaces || typeof this.state.surfaces !== "object") {
      throw new TypeError("invalid persisted annotation publisher state");
    }
    for (const [surfaceId, surface] of Object.entries(this.state.surfaces)) {
      parseAnnotationSequence(surface.nextSequence);
      if (!Array.isArray(surface.fifo) || surface.fifo.length > this.maxRecords || !this.fits(surfaceId)) {
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
