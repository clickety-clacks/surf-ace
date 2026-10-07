/** Public v1 annotation journal record validation. No source identity is authentication. */
export const ANNOTATION_MAX_RECORD_BYTES = 16_777_216;
export const ANNOTATION_MAX_IMAGE_BYTES = 10_485_760;
export const ANNOTATION_MAX_SEQUENCE = 9_223_372_036_854_775_807n;

const epochPattern = /^[0-9a-f]{32}$/;
const sequencePattern = /^(?:0|[1-9][0-9]*)$/;
const timestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const contentTypes = new Set(["html", "image", "pdf", "terminal", "markdown", "video", "canvas"]);

export type AnnotationCursor = { epoch: string; sequence: string };
export type AnnotationSourceRecord = Record<string, unknown> & {
  clientId: string;
  sourceEpoch: string;
  surfaceId: string;
  sourceSequence: string;
  sourceEventId: string;
  kind: "live_delta" | "frame_commit";
};
export type AnnotationSourceGap = Record<string, unknown> & {
  clientId: string;
  sourceEpoch: string;
  surfaceId: string;
  sourceSequence: string;
  sourceEventId: string;
  lostFromSequence: string;
  lostThroughSequence: string;
  reason: "source_retention_overflow" | "source_record_rejected";
};

export class AnnotationValidationError extends Error {
  constructor(readonly code: "annotation_invalid_request" | "annotation_context_image_invalid" | "annotation_record_too_large", message: string) {
    super(message);
    this.name = "AnnotationValidationError";
  }
}

function invalid(message: string): never {
  throw new AnnotationValidationError("annotation_invalid_request", message);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("expected object");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const key of required) if (!(key in value)) invalid(`missing ${key}`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`unknown ${key}`);
}

function identifier(value: unknown, name: string): void {
  if (typeof value !== "string" || new TextEncoder().encode(value).length < 1 || new TextEncoder().encode(value).length > 128) {
    invalid(`${name} must contain 1–128 UTF-8 bytes`);
  }
}

export function parseAnnotationSequence(value: unknown, allowZero = false): bigint {
  if (typeof value !== "string" || !sequencePattern.test(value) || (!allowZero && value === "0")) invalid("invalid sequence");
  const sequence = BigInt(value);
  if (sequence > ANNOTATION_MAX_SEQUENCE) invalid("sequence overflow");
  return sequence;
}

export function parseAnnotationCursor(value: unknown, allowZero = false): AnnotationCursor {
  const cursor = object(value);
  exact(cursor, ["epoch", "sequence"]);
  if (typeof cursor.epoch !== "string" || !epochPattern.test(cursor.epoch)) invalid("invalid cursor epoch");
  parseAnnotationSequence(cursor.sequence, allowZero);
  return cursor as AnnotationCursor;
}

export function parseAnnotationCursorText(value: string, allowZero = false): AnnotationCursor {
  const match = /^ann1:([0-9a-f]{32}):((?:0|[1-9][0-9]*))$/.exec(value);
  if (!match) invalid("invalid cursor spelling");
  return parseAnnotationCursor({ epoch: match![1], sequence: match![2] }, allowZero);
}

export function formatAnnotationCursor(cursor: AnnotationCursor): string {
  parseAnnotationCursor(cursor, true);
  return `ann1:${cursor.epoch}:${cursor.sequence}`;
}

function finite(value: unknown, name: string, minimum?: number, integer = false): void {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) ||
      (minimum !== undefined && value < minimum)) invalid(`invalid ${name}`);
}

function point(value: unknown): void {
  const p = object(value);
  exact(p, ["x", "y"]);
  finite(p.x, "x"); finite(p.y, "y");
}

function viewport(value: unknown, surface: boolean): void {
  const v = object(value);
  if (surface) {
    exact(v, ["width", "height", "scale"]);
    finite(v.width, "width", 1, true); finite(v.height, "height", 1, true); finite(v.scale, "scale", Number.MIN_VALUE);
  } else {
    exact(v, ["scrollOffset", "visibleRect", "contentSize", "zoomLevel"]);
    point(v.scrollOffset);
    const rect = object(v.visibleRect);
    exact(rect, ["x", "y", "width", "height"]);
    finite(rect.x, "x"); finite(rect.y, "y"); finite(rect.width, "width", 0); finite(rect.height, "height", 0);
    const size = object(v.contentSize);
    exact(size, ["width", "height"]);
    finite(size.width, "width", 0); finite(size.height, "height", 0); finite(v.zoomLevel, "zoomLevel", Number.MIN_VALUE);
  }
}

function validateFrame(record: Record<string, unknown>): void {
  const payload = object(record.payload);
  exact(payload, ["frame", "imageSha256"]);
  if (typeof payload.imageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(payload.imageSha256)) invalid("invalid image hash");
  const frame = object(payload.frame);
  exact(frame, ["frameId", "contextKey", "contentId", "scrollOffset", "viewport", "openedAt", "updatedAt", "image", "strokes"], ["url"]);
  identifier(frame.frameId, "frameId"); identifier(frame.contextKey, "contextKey"); identifier(frame.contentId, "contentId");
  if (frame.frameId !== record.frameId || frame.contentId !== record.contentId) invalid("frame context mismatch");
  if (frame.url !== undefined && typeof frame.url !== "string") invalid("invalid frame URL");
  point(frame.scrollOffset); viewport(frame.viewport, true);
  const openViewport = frame.viewport as Record<string, unknown>;
  const recordViewport = record.viewport as Record<string, unknown>;
  if (["width", "height", "scale"].some((key) => openViewport[key] !== recordViewport[key])) invalid("frame viewport mismatch");
  finite(frame.openedAt, "openedAt", 0, true); finite(frame.updatedAt, "updatedAt", 0, true);
  if (!Array.isArray(frame.strokes)) invalid("invalid frame strokes");
  for (const item of frame.strokes as unknown[]) {
    const stroke = object(item);
    exact(stroke, ["strokeId", "points", "bbox", "startedAt", "endedAt"]);
    identifier(stroke.strokeId, "strokeId");
    if (!Array.isArray(stroke.points) || stroke.points.length === 0) invalid("invalid stroke points");
    for (const item of stroke.points as unknown[]) {
      const p = object(item); exact(p, ["x", "y"], ["pressure"]);
      finite(p.x, "x"); finite(p.y, "y"); if (p.pressure !== undefined) finite(p.pressure, "pressure");
    }
    const box = object(stroke.bbox); exact(box, ["x", "y", "width", "height"]);
    for (const key of ["x", "y", "width", "height"]) finite(box[key], key);
    finite(stroke.startedAt, "startedAt", 0, true); finite(stroke.endedAt, "endedAt", 0, true);
  }
  if (typeof frame.image !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.image)) {
    throw new AnnotationValidationError("annotation_context_image_invalid", "invalid Base64 PNG");
  }
}

export function validateAnnotationSource(value: unknown): AnnotationSourceRecord | AnnotationSourceGap {
  const record = object(value);
  const common = ["protocolVersion", "clientId", "sourceEpoch", "surfaceId", "sourceSequence", "sourceEventId"];
  if ("reason" in record) {
    exact(record, [...common, "lostFromSequence", "lostThroughSequence", "reason"]);
    if (record.reason !== "source_retention_overflow" && record.reason !== "source_record_rejected") invalid("invalid gap reason");
    const from = parseAnnotationSequence(record.lostFromSequence);
    const through = parseAnnotationSequence(record.lostThroughSequence);
    if (from > through || record.sourceSequence !== record.lostThroughSequence) invalid("invalid gap range");
  } else {
    exact(record, [...common, "paneId", "frameId", "kind", "contentId", "revision", "contentType", "viewport", "sourceTimestamp", "payload"]);
    finite(record.paneId, "paneId", 1, true); identifier(record.frameId, "frameId"); identifier(record.contentId, "contentId");
    finite(record.revision, "revision", 0, true);
    if (!contentTypes.has(record.contentType as string)) invalid("invalid content type");
    if (record.kind !== "live_delta" && record.kind !== "frame_commit") invalid("invalid record kind");
    viewport(record.viewport, record.kind === "frame_commit");
    if (typeof record.sourceTimestamp !== "string" || !timestampPattern.test(record.sourceTimestamp) ||
        Number.isNaN(Date.parse(record.sourceTimestamp))) invalid("invalid source timestamp");
    if (record.kind === "frame_commit") validateFrame(record);
    else object(record.payload);
  }
  if (record.protocolVersion !== 1) invalid("invalid protocol version");
  for (const key of ["clientId", "surfaceId", "sourceEventId"]) identifier(record[key], key);
  if (typeof record.sourceEpoch !== "string" || !epochPattern.test(record.sourceEpoch)) invalid("invalid source epoch");
  parseAnnotationSequence(record.sourceSequence);
  return record as AnnotationSourceRecord | AnnotationSourceGap;
}
