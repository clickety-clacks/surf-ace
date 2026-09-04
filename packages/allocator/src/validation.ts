import {
  ALLOCATOR_OPERATIONS,
  AllocatorError,
  type AllocatorOperation,
  type AllocatorRequest,
  type AuthorityBindPayload,
  type ExpectedAssignment,
  type LabelClaimPayload,
  type LabelReconfirmPayload,
  windowLabelToOrdinal,
} from "./domain.js";

const FLEET_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ALLOCATOR_ID = /^alloc_[A-Za-z0-9._:-]{3,64}$/;
const AUTHORITY_ID = /^auth_[A-Za-z0-9._:-]{22,64}$/;
const OWNER_ANCHOR_ID = /^owner_[A-Za-z0-9._:-]{22,64}$/;
const SURFACE_ID = /^sf_[A-Za-z0-9._:-]{3,64}$/;

export function parseAllocatorRequest(input: unknown): AllocatorRequest {
  const envelope = object(input, "request envelope");
  exactKeys(envelope, ["v", "type", "op", "id", "sentAt", "payload"]);
  if (envelope.v !== 1 || envelope.type !== "request") {
    invalid("request envelope version or type is invalid");
  }
  const op = string(envelope.op, "op") as AllocatorOperation;
  if (!(ALLOCATOR_OPERATIONS as readonly string[]).includes(op)) {
    invalid("request operation is not supported");
  }
  const id = string(envelope.id, "id");
  if (id.length === 0) {
    invalid("request id is empty");
  }
  const sentAt = number(envelope.sentAt, "sentAt");
  const payload = op === "authority.bind"
    ? parseBindPayload(envelope.payload)
    : op === "label.claim"
      ? parseClaimPayload(envelope.payload)
      : parseReconfirmPayload(envelope.payload);
  return { id, op, payload, sentAt, type: "request", v: 1 };
}

export function parseBindPayload(input: unknown): AuthorityBindPayload {
  const value = object(input, "authority.bind payload");
  exactKeys(value, [
    "protocolVersion",
    "fleetId",
    "authorityId",
    "ownerAnchorId",
    "expectedAllocatorId",
  ], ["expectedAllocatorId"]);
  identityFields(value);
  const result: AuthorityBindPayload = {
    authorityId: string(value.authorityId, "authorityId"),
    fleetId: string(value.fleetId, "fleetId"),
    ownerAnchorId: string(value.ownerAnchorId, "ownerAnchorId"),
    protocolVersion: 1,
  };
  if (value.expectedAllocatorId !== undefined) {
    result.expectedAllocatorId = expectedAllocatorId(value.expectedAllocatorId);
  }
  return result;
}

export function parseClaimPayload(input: unknown): LabelClaimPayload {
  const value = object(input, "label.claim payload");
  exactKeys(value, [
    "protocolVersion",
    "fleetId",
    "authorityId",
    "ownerAnchorId",
    "surfaceId",
    "expectedAllocatorId",
  ], ["expectedAllocatorId"]);
  identityFields(value);
  const result: LabelClaimPayload = {
    authorityId: string(value.authorityId, "authorityId"),
    fleetId: string(value.fleetId, "fleetId"),
    ownerAnchorId: string(value.ownerAnchorId, "ownerAnchorId"),
    protocolVersion: 1,
    surfaceId: patterned(value.surfaceId, SURFACE_ID, "surfaceId"),
  };
  if (value.expectedAllocatorId !== undefined) {
    result.expectedAllocatorId = expectedAllocatorId(value.expectedAllocatorId);
  }
  return result;
}

export function parseReconfirmPayload(input: unknown): LabelReconfirmPayload {
  const value = object(input, "label.reconfirm payload");
  exactKeys(value, [
    "protocolVersion",
    "fleetId",
    "authorityId",
    "ownerAnchorId",
    "surfaceId",
    "expectedAllocatorId",
    "expectedAssignment",
  ]);
  identityFields(value);
  const expected = object(value.expectedAssignment, "expectedAssignment");
  exactKeys(expected, ["ordinal", "windowLabel", "committed"]);
  const ordinal = integer(expected.ordinal, "expectedAssignment.ordinal");
  const windowLabel = patterned(
    expected.windowLabel,
    /^[a-z]+$/,
    "expectedAssignment.windowLabel",
  );
  if (ordinal < 0 || expected.committed !== true) {
    invalid("expectedAssignment is invalid");
  }
  if (windowLabelToOrdinal(windowLabel) !== ordinal) {
    invalid("expectedAssignment label does not encode its ordinal");
  }
  const expectedAssignment: ExpectedAssignment = {
    committed: true,
    ordinal,
    windowLabel,
  };
  return {
    authorityId: string(value.authorityId, "authorityId"),
    expectedAllocatorId: expectedAllocatorId(value.expectedAllocatorId),
    expectedAssignment,
    fleetId: string(value.fleetId, "fleetId"),
    ownerAnchorId: string(value.ownerAnchorId, "ownerAnchorId"),
    protocolVersion: 1,
    surfaceId: patterned(value.surfaceId, SURFACE_ID, "surfaceId"),
  };
}

function identityFields(value: Record<string, unknown>): void {
  if (value.protocolVersion !== 1) {
    throw new AllocatorError(
      "unsupported_protocol_version",
      "only allocator protocol version 1 is supported",
    );
  }
  patterned(value.fleetId, FLEET_ID, "fleetId");
  patterned(value.authorityId, AUTHORITY_ID, "authorityId");
  patterned(value.ownerAnchorId, OWNER_ANCHOR_ID, "ownerAnchorId");
}

function expectedAllocatorId(value: unknown): string {
  return patterned(value, ALLOCATOR_ID, "expectedAllocatorId");
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      invalid(`unknown property: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!optionalSet.has(key) && !(key in value)) {
      invalid(`missing required property: ${key}`);
    }
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") {
    invalid(`${name} must be a string`);
  }
  return value as string;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${name} must be a finite number`);
  }
  return value as number;
}

function integer(value: unknown, name: string): number {
  const result = number(value, name);
  if (!Number.isSafeInteger(result)) {
    invalid(`${name} must be a safe integer`);
  }
  return result;
}

function patterned(value: unknown, pattern: RegExp, name: string): string {
  const result = string(value, name);
  if (!pattern.test(result)) {
    invalid(`${name} has an invalid format`);
  }
  return result;
}

function invalid(message: string): never {
  throw new AllocatorError("invalid_payload", message);
}
