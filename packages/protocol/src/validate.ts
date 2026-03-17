import {
  SURF_ACE_PROTOCOL_SCHEMAS,
  type SurfAceSchemaName,
} from "./schemas-manifest.js";
import {
  EVENT_MESSAGES,
  REQUEST_MESSAGES,
  RESPONSE_MESSAGES,
} from "./message-names.js";

const REQUEST_MESSAGE_SET = new Set<string>(REQUEST_MESSAGES);
const RESPONSE_MESSAGE_SET = new Set<string>(RESPONSE_MESSAGES);
const EVENT_MESSAGE_SET = new Set<string>(EVENT_MESSAGES);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateEnvelopeType(
  schemaName: SurfAceSchemaName,
  envelope: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!SURF_ACE_PROTOCOL_SCHEMAS[schemaName]) {
    return { ok: false, reason: "schema_missing" };
  }
  if (!isObject(envelope)) {
    return { ok: false, reason: "envelope_not_object" };
  }
  const actualOp = typeof envelope.op === "string" ? envelope.op : "";
  if (actualOp !== schemaName) {
    return { ok: false, reason: `op_mismatch:${actualOp || "missing"}` };
  }
  const expectedType = REQUEST_MESSAGE_SET.has(schemaName)
    ? "request"
    : RESPONSE_MESSAGE_SET.has(schemaName)
      ? "response"
      : EVENT_MESSAGE_SET.has(schemaName)
        ? "event"
        : null;
  if (expectedType === null) {
    return { ok: false, reason: "schema_type_unknown" };
  }
  const actualType = typeof envelope.type === "string" ? envelope.type : "";
  if (actualType !== expectedType) {
    return { ok: false, reason: `type_mismatch:${actualType || "missing"}` };
  }
  if (envelope.v !== 1) {
    return { ok: false, reason: `version_mismatch:${String(envelope.v ?? "missing")}` };
  }
  if (actualType === "event") {
    if (typeof envelope.eventId !== "string" || envelope.eventId.length === 0) {
      return { ok: false, reason: "event_id_missing" };
    }
  } else if (typeof envelope.id !== "string" || envelope.id.length === 0) {
    return { ok: false, reason: "request_id_missing" };
  }
  if (!isObject(envelope.payload)) {
    return { ok: false, reason: "payload_not_object" };
  }
  return { ok: true };
}
