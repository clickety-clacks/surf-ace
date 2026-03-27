import { buildSurfAceAgentInstructions } from "./agent-instructions.js";
import {
  type SurfAceAnnotateRemoveInput,
  type SurfAceSplitInput,
  type SurfAcePushInput,
  type SurfAceRuntime,
  type SurfAceRuntimeOptions,
  createSurfAceRuntime,
} from "./surf-ace-runtime.js";

export const surfAceToolNames = [
  "surf_ace_list",
  "surf_ace_push",
  "surf_ace_clear",
  "surf_ace_relinquish",
  "surf_ace_split",
  "surf_ace_close_pane",
  "surf_ace_read",
  "surf_ace_annotations_remove",
] as const;

export type SurfAceToolName = (typeof surfAceToolNames)[number];

export type SurfAceToolContext = {
  sessionKey?: string;
};

export type SurfAceToolDefinition<TArgs = unknown, TResult = unknown> = {
  description: string;
  execute: (args: TArgs, context?: SurfAceToolContext) => Promise<TResult>;
  inputSchema: Record<string, unknown>;
  name: SurfAceToolName;
};

export type SurfAceExtensionRegistration = {
  agentInstructions: string;
  runtime: SurfAceRuntime;
  tools: SurfAceToolDefinition<any>[];
};

const fingerprintParam = {
  description: "Window-scoped Surf Ace surface identity (`surfaceId`, exposed as `fingerprint`).",
  type: "string",
};

const paneIdParam = {
  description: "Required numeric pane id.",
  minimum: 1,
  type: "integer",
};

export function createSurfAceTools(runtime: SurfAceRuntime): SurfAceToolDefinition<any>[] {
  return [
    {
      description: "List all discovered Surf Ace surfaces, visible window labels, pane topology, and local provider state.",
      execute: async () => await runtime.listScreens(),
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      name: "surf_ace_list",
    },
    {
      description: "Push content to a Surf Ace pane, replacing whatever is currently visible.",
      execute: async (args: SurfAcePushInput, context?: SurfAceToolContext) =>
        await runtime.push(args, { sessionKey: context?.sessionKey }),
      inputSchema: {
        additionalProperties: false,
        properties: {
          baseUrl: {
            description: "Optional base URL for HTML content so relative URLs and fetches resolve against a real origin.",
            type: "string",
          },
          content: {
            description: "Required content payload string, encoded per content type as defined in the spec.",
            type: "string",
          },
          contentType: {
            enum: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"],
            type: "string",
          },
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
        },
        required: ["fingerprint", "paneId", "contentType", "content"],
        type: "object",
      },
      name: "surf_ace_push",
    },
    {
      description: "Clear the currently visible content in a pane.",
      execute: async (args: { fingerprint: string; paneId: number }) => await runtime.clear(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
        },
        required: ["fingerprint", "paneId"],
        type: "object",
      },
      name: "surf_ace_clear",
    },
    {
      description: "Relinquish ownership of a Surf Ace surface and stop automatic reconnects for it.",
      execute: async (args: { fingerprint: string }) => await runtime.relinquish(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          fingerprint: fingerprintParam,
        },
        required: ["fingerprint"],
        type: "object",
      },
      name: "surf_ace_relinquish",
    },
    {
      description: "Split an existing Surf Ace pane into a larger pane layout.",
      execute: async (args: SurfAceSplitInput) => await runtime.split(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          count: {
            minimum: 2,
            type: "integer",
          },
          direction: {
            enum: ["horizontal", "vertical"],
            type: "string",
          },
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
        },
        required: ["fingerprint", "paneId", "count", "direction"],
        type: "object",
      },
      name: "surf_ace_split",
    },
    {
      description: "Close an existing Surf Ace pane.",
      execute: async (args: { fingerprint: string; paneId: number }) => await runtime.closePane(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
        },
        required: ["fingerprint", "paneId"],
        type: "object",
      },
      name: "surf_ace_close_pane",
    },
    {
      description: "Read the local dual-channel Surf Ace buffer for a pane. No live network call is made.",
      execute: async (args: { fingerprint: string; paneId: number }) => await runtime.read(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
        },
        required: ["fingerprint", "paneId"],
        type: "object",
      },
      name: "surf_ace_read",
    },
    {
      description: "Remove specific annotation strokes from the currently rendered Surf Ace overlay.",
      execute: async (args: SurfAceAnnotateRemoveInput) => await runtime.annotateRemove(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          contentId: { type: "string" },
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
          strokeIds: {
            items: { type: "string" },
            minItems: 1,
            type: "array",
          },
        },
        required: ["fingerprint", "paneId", "contentId", "strokeIds"],
        type: "object",
      },
      name: "surf_ace_annotations_remove",
    },
  ];
}

export function register(options: SurfAceRuntimeOptions = {}): SurfAceExtensionRegistration {
  const runtime = createSurfAceRuntime(options);
  return {
    agentInstructions: buildSurfAceAgentInstructions(),
    runtime,
    tools: createSurfAceTools(runtime),
  };
}
