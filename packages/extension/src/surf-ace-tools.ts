import { buildSurfAceAgentInstructions } from "./agent-instructions.js";
import {
  type SurfAceAnnotateRemoveInput,
  type SurfAcePushInput,
  type SurfAceRuntime,
  type SurfAceRuntimeOptions,
  createSurfAceRuntime,
} from "./surf-ace-runtime.js";

export const surfAceToolNames = [
  "surf_ace_list",
  "surf_ace_push",
  "surf_ace_read",
  "surf_ace_snapshot",
  "surf_ace_annotate_remove",
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
      description: "List all discovered Surf Ace surfaces, panes, labels, and local provider state.",
      execute: async () => await runtime.listScreens(),
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      name: "surf_ace_list",
    },
    {
      description:
        "Run a Surf Ace write operation. Defaults to `content.set`, and also supports `content.clear`, `content.append`, `content.patch`, `pane.split`, and `pane.rename`.",
      execute: async (args: SurfAcePushInput, context?: SurfAceToolContext) => {
        const normalized = {
          ...args,
          sessionKey: "sessionKey" in args ? (args.sessionKey ?? context?.sessionKey) : context?.sessionKey,
        } as SurfAcePushInput;
        return await runtime.push(normalized);
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          content: {
            description: "Required for `content.set`. Type-specific payload or the user-level string form from the spec.",
          },
          contentId: {
            description: "Optional current contentId override for append/patch. Defaults to the pane's active content.",
            type: "string",
          },
          contentType: {
            enum: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"],
            type: "string",
          },
          count: { minimum: 2, type: "integer" },
          direction: { enum: ["horizontal", "vertical"], type: "string" },
          display: {
            additionalProperties: false,
            properties: {
              interactive: { type: "boolean" },
              scrollable: { type: "boolean" },
              title: { type: "string" },
            },
            type: "object",
          },
          fingerprint: fingerprintParam,
          lines: {
            items: { type: "string" },
            type: "array",
          },
          name: {
            type: ["string", "null"],
          },
          op: {
            enum: [
              "content.set",
              "content.clear",
              "content.append",
              "content.patch",
              "pane.split",
              "pane.rename",
            ],
            type: "string",
          },
          paneId: paneIdParam,
          patch: {
            additionalProperties: false,
            properties: {
              action: {
                enum: [
                  "replace_inner",
                  "replace_outer",
                  "insert_before",
                  "insert_after",
                  "remove",
                ],
                type: "string",
              },
              html: { type: "string" },
              selector: { type: "string" },
            },
            required: ["action", "selector"],
            type: "object",
          },
        },
        required: ["fingerprint", "paneId"],
        type: "object",
      },
      name: "surf_ace_push",
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
      description: "Read the provider's cached Surf Ace snapshot for a pane. No live network call is made.",
      execute: async (args: { fingerprint: string; paneId: number }) => await runtime.snapshot(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
        },
        required: ["fingerprint", "paneId"],
        type: "object",
      },
      name: "surf_ace_snapshot",
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
      name: "surf_ace_annotate_remove",
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
