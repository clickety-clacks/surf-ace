/**
 * JSON Schema scaffolds derived from DESIGN.md.
 * These are v1 cores; additional operations will be added incrementally.
 */

export const pairRequestSchema = {
  $id: "surf-ace/pair.request",
  type: "object",
  additionalProperties: false,
  required: ["type", "payload"],
  properties: {
    type: { const: "pair.request" },
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "connectionId", "surfaceId", "protocolVersion"],
      properties: {
        providerId: { type: "string", minLength: 1 },
        connectionId: { type: "string", minLength: 1 },
        surfaceId: { type: "string", minLength: 1 },
        protocolVersion: { const: 1 },
        resume: { type: "string" },
        takeover: { type: "boolean" },
        providerName: { type: "string" },
        eventProfile: { type: "string" },
        drawingFlushConfig: {
          type: "object",
          additionalProperties: false,
          properties: {
            idleWindowMs: { type: "number", minimum: 0 },
            maxIntervalMs: { type: "number", minimum: 0 },
          },
        },
      },
    },
  },
} as const;

export const contentSetRequestSchema = {
  $id: "surf-ace/content.set",
  type: "object",
  additionalProperties: false,
  required: ["type", "payload"],
  properties: {
    type: { const: "content.set" },
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["contentId", "revision", "contentType", "content"],
      properties: {
        paneId: { type: "string" },
        contentId: { type: "string", minLength: 1 },
        revision: { type: "number", minimum: 0 },
        contentType: {
          enum: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"],
        },
        content: {},
      },
    },
  },
} as const;

export const snapshotGetRequestSchema = {
  $id: "surf-ace/snapshot.get",
  type: "object",
  additionalProperties: false,
  required: ["type", "payload"],
  properties: {
    type: { const: "snapshot.get" },
    payload: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeVisibleText: { type: "boolean" },
        includeDrawings: { type: "boolean" },
        includeImage: { type: "boolean" },
      },
    },
  },
} as const;
