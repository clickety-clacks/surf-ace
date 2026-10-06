import { createHash } from "node:crypto";

import {
  ANNOTATION_MAX_IMAGE_BYTES,
  ANNOTATION_MAX_RECORD_BYTES,
  AnnotationValidationError,
  validateAnnotationSource,
} from "@surf-ace/protocol";

import { AllocatorError, canonicalJson, type CanonicalJson } from "./domain.js";
import { PostgresCustodyAdapter } from "./custody.js";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class AnnotationJournal {
  constructor(private readonly custody: PostgresCustodyAdapter<"writer">) {}

  async ingest(value: unknown): Promise<{
    serverCursor: { epoch: string; sequence: string };
    duplicate: boolean;
    committedAt: string;
  }> {
    let record;
    try {
      record = validateAnnotationSource(value);
    } catch (error) {
      if (error instanceof AnnotationValidationError) throw new AllocatorError(error.code, error.message);
      throw error;
    }
    if (record.kind === "frame_commit") validateImage(record);
    const canonicalBytes = Buffer.from(canonicalJson(record as CanonicalJson), "utf8");
    if (canonicalBytes.length > ANNOTATION_MAX_RECORD_BYTES) {
      throw new AllocatorError("annotation_record_too_large", "canonical annotation record exceeds 16 MiB");
    }
    const accepted = await this.custody.appendAnnotation({
      clientId: record.clientId,
      sourceEpoch: record.sourceEpoch,
      surfaceId: record.surfaceId,
      sourceSequence: record.sourceSequence,
      sourceEventId: record.sourceEventId,
      lostFromSequence: "lostFromSequence" in record ? record.lostFromSequence as string : undefined,
      kind: "kind" in record ? record.kind as string : "source_gap",
    }, canonicalBytes);
    return {
      serverCursor: { epoch: accepted.serverEpoch, sequence: accepted.serverSequence },
      duplicate: accepted.duplicate,
      committedAt: accepted.committedAt,
    };
  }
}

function validateImage(record: Record<string, unknown>): void {
  const payload = record.payload as { frame: { image: string }; imageSha256: string };
  const bytes = Buffer.from(payload.frame.image, "base64");
  if (bytes.length > ANNOTATION_MAX_IMAGE_BYTES || bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(pngSignature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new AllocatorError("annotation_context_image_invalid", "frame image is not a bounded PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 33_554_432 ||
      createHash("sha256").update(bytes).digest("hex") !== payload.imageSha256) {
    throw new AllocatorError("annotation_context_image_invalid", "frame image dimensions or hash are invalid");
  }
}
