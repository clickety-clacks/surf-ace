import type { TightBeamAdapterTool } from "./adapter.js";

export type AgentToolDefinition = {
  description: string;
  inputSchema: Record<string, unknown>;
  name: TightBeamAdapterTool;
};

const nonNegativeInteger = {
  minimum: 0,
  type: "integer",
};

const positiveInteger = {
  minimum: 1,
  type: "integer",
};

export const tightBeamSurfAceTools: AgentToolDefinition[] = [
  {
    description:
      "List authoritative Surf Ace surfaces and their current client-assigned pane and topology state.",
    inputSchema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    name: "surf_ace_list",
  },
  {
    description:
      "Push content intent to a client-assigned Surf Ace pane. The client allocates revision and history identity.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        content: {},
        contentId: { minLength: 1, type: "string" },
        contentType: { minLength: 1, type: "string" },
        display: { type: "object" },
        friendlyChatName: { type: "string" },
        paneId: positiveInteger,
        surfaceId: { minLength: 1, type: "string" },
      },
      required: ["surfaceId", "paneId", "contentId", "contentType", "content"],
      type: "object",
    },
    name: "surf_ace_push",
  },
  {
    description:
      "Read only the durable local controller projection for one negotiated consumable scope and queue its acknowledgement in the background.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        scopeId: { minLength: 1, type: "string" },
      },
      required: ["scopeId"],
      type: "object",
    },
    name: "surf_ace_read",
  },
  {
    description:
      "Submit split, close, restore, or rename topology intent using the latest client-assigned expected topology revision.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        action: { enum: ["split", "close", "restore", "rename"], type: "string" },
        anchorPaneId: positiveInteger,
        count: { minimum: 2, type: "integer" },
        direction: {
          enum: ["horizontal", "vertical"],
          type: "string",
        },
        expectedTopologyRevision: nonNegativeInteger,
        paneId: positiveInteger,
        name: { type: ["string", "null"] },
        surfaceId: { minLength: 1, type: "string" },
        tombstoneId: { minLength: 1, type: "string" },
      },
      required: ["surfaceId", "action", "expectedTopologyRevision"],
      type: "object",
    },
    name: "surf_ace_topology_intent",
  },
  {
    description: "Realize a desired topology using the current client topology revision; missing pane identities are allocated only by the client.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        allowDestroyPaneIds: {
          items: positiveInteger,
          type: "array",
        },
        desired: { type: "object" },
        expectedTopologyRevision: nonNegativeInteger,
        surfaceId: { minLength: 1, type: "string" },
        target: { type: "object" },
      },
      required: [
        "surfaceId",
        "expectedTopologyRevision",
        "target",
        "desired",
        "allowDestroyPaneIds",
      ],
      type: "object",
    },
    name: "surf_ace_topology_realize",
  },
  {
    description: "Clear a pane at the latest client-reported content revision.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        expectedRevision: nonNegativeInteger,
        paneId: positiveInteger,
        surfaceId: { minLength: 1, type: "string" },
      },
      required: ["surfaceId", "paneId", "expectedRevision"],
      type: "object",
    },
    name: "surf_ace_clear",
  },
  {
    description: "Remove persistent annotations from client-owned pane state.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        contentId: { minLength: 1, type: "string" },
        paneId: positiveInteger,
        strokeIds: { items: { type: "string" }, type: "array" },
        surfaceId: { minLength: 1, type: "string" },
      },
      required: ["surfaceId", "paneId", "contentId", "strokeIds"],
      type: "object",
    },
    name: "surf_ace_annotations_remove",
  },
  {
    description: "Explicitly request a pane snapshot/capture over the public wire.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        includeDrawings: { type: "boolean" },
        includeImage: { type: "boolean" },
        includeVisibleText: { type: "boolean" },
        paneId: positiveInteger,
        surfaceId: { minLength: 1, type: "string" },
      },
      required: ["surfaceId", "paneId"],
      type: "object",
    },
    name: "surf_ace_capture_pane",
  },
  {
    description: "Open, recoverably close, or restore a surface through the lifecycle/target-surface connection.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        action: { enum: ["open", "close", "restore"], type: "string" },
        endpointId: { minLength: 1, type: "string" },
        expectedSurfaceSetRevision: nonNegativeInteger,
        expectedTopologyRevision: nonNegativeInteger,
        placement: { type: "object" },
        surfaceId: { minLength: 1, type: "string" },
        tombstoneId: { minLength: 1, type: "string" },
      },
      required: ["action", "expectedSurfaceSetRevision"],
      type: "object",
    },
    name: "surf_ace_surface_intent",
  },
  {
    description: "Apply a native/browser target without ownership epochs through the target surface connection.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        display: { type: "object" },
        paneId: positiveInteger,
        paneLineageId: { minLength: 1, type: "string" },
        requestId: { minLength: 1, type: "string" },
        restoreReason: { minLength: 1, type: "string" },
        surfaceId: { minLength: 1, type: "string" },
        targetEpoch: nonNegativeInteger,
        targetHeader: { type: "object" },
        targetId: { minLength: 1, type: "string" },
        targetKind: { minLength: 1, type: "string" },
        targetPayload: {},
      },
      required: ["surfaceId", "paneId"],
      type: "object",
    },
    name: "surf_ace_target_apply",
  },
  {
    description: "Register target restoration metadata without ownership fields through the target surface connection.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        expectedPreviousTargetEpoch: {
          type: ["integer", "null"],
        },
        idempotencyKey: { minLength: 1, type: "string" },
        launchedAt: { minLength: 1, type: "string" },
        paneId: positiveInteger,
        paneLineageId: { minLength: 1, type: "string" },
        registrationState: { minLength: 1, type: "string" },
        restorePolicy: { minLength: 1, type: "string" },
        surfaceId: { minLength: 1, type: "string" },
        targetHeader: { type: "object" },
        targetKind: { minLength: 1, type: "string" },
        targetPayload: {},
      },
      required: ["surfaceId", "paneId", "idempotencyKey"],
      type: "object",
    },
    name: "surf_ace_target_register",
  },
];
