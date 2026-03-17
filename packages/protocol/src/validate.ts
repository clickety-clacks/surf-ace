import {
  SURF_ACE_PROTOCOL_SCHEMAS,
  type SurfAceSchemaName,
} from "./schemas-manifest.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function schemaRequiresPayload(schema: Record<string, unknown>): boolean {
  return Array.isArray(schema.required) && schema.required.includes("payload");
}

export function validateEnvelopeType(
  schemaName: SurfAceSchemaName,
  envelope: unknown,
): { ok: true } | { ok: false; reason: string } {
  const manifestEntry = SURF_ACE_PROTOCOL_SCHEMAS[schemaName];
  if (!manifestEntry) {
    return { ok: false, reason: "schema_missing" };
  }
  if (!isObject(envelope)) {
    return { ok: false, reason: "envelope_not_object" };
  }
  const actualOp = typeof envelope.op === "string" ? envelope.op : "";
  if (actualOp !== schemaName) {
    return { ok: false, reason: `op_mismatch:${actualOp || "missing"}` };
  }
  const actualType = typeof envelope.type === "string" ? envelope.type : "";
  const selectedSchema = actualType === "request"
    ? "request" in manifestEntry
      ? manifestEntry.request
      : null
    : actualType === "response"
      ? "response" in manifestEntry
        ? envelope.ok === false
          ? manifestEntry.errorResponse
          : manifestEntry.response
        : null
      : actualType === "event"
        ? "event" in manifestEntry
          ? manifestEntry.event
          : null
        : null;
  if (!selectedSchema) {
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
  if ("payload" in envelope) {
    if (!isObject(envelope.payload)) {
      return { ok: false, reason: "payload_not_object" };
    }
    return { ok: true };
  }
  if (schemaRequiresPayload(selectedSchema as Record<string, unknown>)) {
    return { ok: false, reason: "payload_not_object" };
  }
  return { ok: true };
}
