import { createHash } from "node:crypto";

export const STATE_VERSION = 1 as const;

export const ALLOCATOR_OPERATIONS = [
  "authority.bind",
  "label.claim",
  "label.reconfirm",
] as const;

export const ALLOCATOR_ERROR_CODES = [
  "allocator_identity_mismatch",
  "allocator_state_corrupt",
  "allocator_state_unsupported_version",
  "allocator_uninitialized",
  "assignment_conflict",
  "authority_ownership_conflict",
  "fleet_destroyed",
  "fleet_identity_mismatch",
  "internal_error",
  "invalid_payload",
  "invalid_request_id_reuse",
  "persistence_failed",
  "persistence_outcome_unknown",
  "unsupported_protocol_version",
  "writer_fence_unavailable",
] as const;

export type AllocatorOperation = (typeof ALLOCATOR_OPERATIONS)[number];
export type AllocatorErrorCode = (typeof ALLOCATOR_ERROR_CODES)[number];
export type LeaseMode = "recovery" | "writer";

export type LeaseToken<M extends LeaseMode = LeaseMode> = {
  leaseGeneration: number;
  leaseId: string;
  mode: M;
};

export type Assignment = {
  authorityId: string;
  committed: true;
  fleetId: string;
  allocatorId: string;
  ordinal: number;
  ownerAnchorId: string;
  stateVersion: number;
  surfaceId: string;
  windowLabel: string;
};

export type AuthorityBindPayload = {
  authorityId: string;
  expectedAllocatorId?: string;
  fleetId: string;
  ownerAnchorId: string;
  protocolVersion: 1;
};

export type LabelClaimPayload = AuthorityBindPayload & {
  surfaceId: string;
};

export type ExpectedAssignment = {
  committed: true;
  ordinal: number;
  windowLabel: string;
};

export type LabelReconfirmPayload = Omit<LabelClaimPayload, "expectedAllocatorId"> & {
  expectedAllocatorId: string;
  expectedAssignment: ExpectedAssignment;
};

export type AllocatorRequest = {
  id: string;
  op: AllocatorOperation;
  payload: AuthorityBindPayload | LabelClaimPayload | LabelReconfirmPayload;
  sentAt: number;
  type: "request";
  v: 1;
};

export type AllocatorSuccessResponse = {
  id: string;
  ok: true;
  op: AllocatorOperation;
  payload: Record<string, unknown>;
  sentAt: number;
  type: "response";
  v: 1;
};

export type AllocatorErrorResponse = {
  error: {
    code: AllocatorErrorCode;
    details?: { allocatorId: string };
    message: string;
  };
  id: string;
  ok: false;
  op: AllocatorOperation;
  sentAt: number;
  type: "response";
  v: 1;
};

export class AllocatorError extends Error {
  constructor(
    readonly code: AllocatorErrorCode,
    message: string,
    readonly allocatorId?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AllocatorError";
  }
}

export function ordinalToWindowLabel(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new RangeError("ordinal must be a non-negative safe integer");
  }
  let remainder = ordinal;
  let label = "";
  do {
    label = String.fromCharCode(97 + (remainder % 26)) + label;
    remainder = Math.floor(remainder / 26) - 1;
  } while (remainder >= 0);
  return label;
}

export function windowLabelToOrdinal(label: string): number {
  if (!/^[a-z]+$/.test(label)) {
    throw new RangeError("window label must contain only lowercase a-z");
  }
  let ordinal = 0;
  for (const character of label) {
    ordinal = ordinal * 26 + character.charCodeAt(0) - 96;
    if (!Number.isSafeInteger(ordinal)) {
      throw new RangeError("window label exceeds the safe ordinal range");
    }
  }
  return ordinal - 1;
}

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

/** RFC 8785 JSON canonicalization for the allocator's JSON data model. */
export function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON does not permit non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const members = Object.keys(value)
    .sort((left, right) => compareUtf16(left, right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`);
  return `{${members.join(",")}}`;
}

export function journalHeadHash(
  previousHeadHash: Buffer,
  event: CanonicalJson,
): { eventBytes: Buffer; headHash: Buffer } {
  if (previousHeadHash.length !== 32) {
    throw new RangeError("previous journal head hash must be 32 bytes");
  }
  const eventBytes = Buffer.from(canonicalJson(event), "utf8");
  const headHash = createHash("sha256")
    .update(previousHeadHash)
    .update(eventBytes)
    .digest();
  return { eventBytes, headHash };
}

function compareUtf16(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}
