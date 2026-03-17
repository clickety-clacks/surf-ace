import {
  pairRequestSchema,
  contentSetRequestSchema,
  snapshotGetRequestSchema,
  pairResponseSchema,
  drawingFlushEventSchema,
} from "./schemas.js";

export const SURF_ACE_PROTOCOL_SCHEMAS = {
  "pair.request": pairRequestSchema,
  "content.set": contentSetRequestSchema,
  "snapshot.get": snapshotGetRequestSchema,
  "pair.response": pairResponseSchema,
  "event.drawing_flush": drawingFlushEventSchema,
} as const;

export type SurfAceSchemaName = keyof typeof SURF_ACE_PROTOCOL_SCHEMAS;
