import {
  SURF_ACE_PROTOCOL_SCHEMAS,
  type SurfAceSchemaName,
} from "./schemas-manifest";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateEnvelopeType(
  schemaName: SurfAceSchemaName,
  envelope: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!isObject(envelope)) {
    return { ok: false, reason: "envelope_not_object" };
  }
  const expectedType = schemaName;
  const actualType = typeof envelope.type === "string" ? envelope.type : "";
  if (actualType !== expectedType) {
    return { ok: false, reason: `type_mismatch:${actualType || "missing"}` };
  }
  if (!isObject(envelope.payload)) {
    return { ok: false, reason: "payload_not_object" };
  }
  // Placeholder until full JSON-schema runtime validator is wired.
  // Existence check keeps provider/client contract aligned now.
  if (!SURF_ACE_PROTOCOL_SCHEMAS[schemaName]) {
    return { ok: false, reason: "schema_missing" };
  }
  return { ok: true };
}
