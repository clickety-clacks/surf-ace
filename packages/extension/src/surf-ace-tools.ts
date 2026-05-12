import { buildSurfAceAgentInstructions } from "./agent-instructions.js";
import type { PusherProvenance } from "../../protocol/src/index.js";
import {
  type SurfAceAnnotateRemoveInput,
  type SurfAceLaunchTerminalInput,
  type PaneId,
  type SurfAceRealizeTopologyInput,
  type SurfAceRealizeTopologiesInput,
  type SurfAceReattemptConnectionsInput,
  type SurfAceSplitInput,
  type SurfAcePushInput,
  type SurfAceRuntime,
  type SurfAceRuntimeOptions,
  createSurfAceRuntime,
} from "./surf-ace-runtime.js";

export const surfAceToolNames = [
  "surf_ace_list",
  "surf_ace_authority_diagnostics",
  "surf_ace_push",
  "surf_ace_launch_terminal",
  "surf_ace_clear",
  "surf_ace_relinquish",
  "surf_ace_reattempt_connections",
  "surf_ace_split",
  "surf_ace_realize_topology",
  "surf_ace_realize_topologies",
  "surf_ace_close_pane",
  "surf_ace_read",
  "surf_ace_capture_pane",
  "surf_ace_annotations_remove",
] as const;

export type SurfAceToolName = (typeof surfAceToolNames)[number];

export type SurfAceToolContext = {
  agentId?: string;
  displayName?: string;
  provenance?: PusherProvenance;
  pushedBy?: PusherProvenance;
  source?: string | PusherProvenance;
  sourceProvenance?: PusherProvenance;
  sessionDisplayName?: string;
  sessionKey?: string;
  streamLabel?: string;
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
  description: "Required internal opaque pane id returned by `surf_ace_list` after resolving the visible `paneLabel`.",
  type: "string",
};

const realizeTopologyTargetSchema = {
  anyOf: [
    {
      additionalProperties: false,
      properties: {
        root: {
          enum: [true],
          type: "boolean",
        },
      },
      required: ["root"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        paneId: paneIdParam,
      },
      required: ["paneId"],
      type: "object",
    },
  ],
  description: "Use `{ root: true }` to replace the whole layout, or `{ paneId }` to replace one pane slot.",
};

const realizeTopologyInputProperties = {
  allowDestroyPaneIds: {
    description: "Existing internal pane ids that this call is explicitly allowed to destroy. Use [] for non-destructive realization.",
    items: paneIdParam,
    type: "array",
  },
  expectedTopologyRevision: {
    description: "Required topologyRevision from the latest `surf_ace_list` read.",
    minimum: 0,
    type: "integer",
  },
  fingerprint: fingerprintParam,
  target: {
    ...realizeTopologyTargetSchema,
  },
};

const realizeTopologyRequiredProperties = [
  "fingerprint",
  "target",
  "expectedTopologyRevision",
  "allowDestroyPaneIds",
  "desired",
];

function createRealizeTopologyNodeSchema(depth = 8): Record<string, unknown> {
  const paneNodeSchema = {
    additionalProperties: false,
    properties: {
      name: {
        type: ["string", "null"],
      },
      paneId: paneIdParam,
      type: {
        enum: ["pane"],
        type: "string",
      },
      weight: {
        description: "Optional relative size within the parent split. Omitted means equal share.",
        exclusiveMinimum: 0,
        type: "number",
      },
    },
    type: "object",
  };
  if (depth <= 0) {
    return paneNodeSchema;
  }
  return {
    anyOf: [
      {
        additionalProperties: false,
        properties: {
          children: {
            items: createRealizeTopologyNodeSchema(depth - 1),
            minItems: 2,
            type: "array",
          },
          direction: {
            enum: ["horizontal", "vertical"],
            type: "string",
          },
          type: {
            enum: ["split"],
            type: "string",
          },
          weight: {
            description: "Optional relative size within the parent split. Omitted means equal share.",
            exclusiveMinimum: 0,
            type: "number",
          },
        },
        required: ["direction", "children"],
        type: "object",
      },
      paneNodeSchema,
    ],
    description: "Recursive desired subtree. Split nodes use `{ type:\"split\", direction, children }`; pane leaves use `{ type:\"pane\", paneId?, name? }`. Leaves without paneId allocate provider-owned pane ids/labels.",
  };
}

const realizeTopologyDesiredSchema = createRealizeTopologyNodeSchema();

export function createSurfAceTools(runtime: SurfAceRuntime): SurfAceToolDefinition<any>[] {
  return [
    {
      description: "List all discovered Surf Ace surfaces, including the unique user-facing `displayId` / `paneAddress`, `windowLabel` / `paneLabel`, and internal pane ids for subsequent pane-scoped calls.",
      execute: async () => await runtime.listScreens(),
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      name: "surf_ace_list",
    },
    {
      description: "Return provider authority diagnostics for stale persisted surfaces, live surfaces, runtime screen snapshots, target/window records, tombstones, pane counters, blockers, and runtime owner state.",
      execute: async () => await runtime.providerAuthorityDiagnostics(),
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      name: "surf_ace_authority_diagnostics",
    },
    {
      description: "Push content or a live browser URL target to a Surf Ace pane, replacing whatever is currently visible.",
      execute: async (args: SurfAcePushInput, context?: SurfAceToolContext) =>
        await runtime.push(args, {
          agentId: context?.agentId,
          displayName: context?.displayName,
          provenance: context?.provenance,
          pushedBy: context?.pushedBy,
          source: context?.source,
          sourceProvenance: context?.sourceProvenance,
          sessionDisplayName: context?.sessionDisplayName,
          sessionKey: context?.sessionKey,
          streamLabel: context?.streamLabel,
        }),
      inputSchema: {
        additionalProperties: false,
        properties: {
          content: {
            description: "Required content payload string. For browser_url this is the live URL to navigate; it is not static HTML.",
            type: "string",
          },
          contentType: {
            enum: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas", "browser_url"],
            type: "string",
          },
          diagnostic: {
            additionalProperties: false,
            properties: {
              derivedFromTargetId: { type: "string" },
              kind: { enum: ["placeholder", "status", "error"], type: "string" },
              summary: { type: "string" },
            },
            required: ["kind", "summary"],
            type: "object",
          },
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
          sourcePath: {
            description: "Optional file path for file-backed content. When present, the surface reload control re-reads this path instead of repainting pushed bytes.",
            type: "string",
          },
        },
        required: ["fingerprint", "paneId", "contentType", "content"],
        type: "object",
      },
      name: "surf_ace_push",
    },
    {
      description: "Launch a provider-owned process-backed terminal target in a pane through Surf Ace native hosting, applying Surf Ace chrome/overlay regions. Requires confirmed:true.",
      execute: async (args: SurfAceLaunchTerminalInput, context?: SurfAceToolContext) =>
        await runtime.launchTerminal(args, {
          agentId: context?.agentId,
          displayName: context?.displayName,
          provenance: context?.provenance,
          pushedBy: context?.pushedBy,
          source: context?.source,
          sourceProvenance: context?.sourceProvenance,
          sessionDisplayName: context?.sessionDisplayName,
          sessionKey: context?.sessionKey,
          streamLabel: context?.streamLabel,
        }),
      inputSchema: {
        additionalProperties: false,
        properties: {
          args: {
            items: { type: "string" },
            type: "array",
          },
          command: {
            description: "Executable command to launch inside the Surf Ace-owned terminal pane.",
            minLength: 1,
            type: "string",
          },
          confirmed: {
            description: "Must be true to apply a process-backed terminal target.",
            enum: [true],
            type: "boolean",
          },
          cwd: {
            type: ["string", "null"],
          },
          fingerprint: fingerprintParam,
          idempotencyKey: {
            description: "Optional stable caller key used to make repeated launches idempotent for the same pane/command.",
            type: "string",
          },
          paneId: paneIdParam,
          restartPolicy: {
            default: "manual_only",
            enum: ["restore_new_process", "manual_only"],
            type: "string",
          },
          summary: {
            description: "Optional human-readable target summary shown in diagnostics.",
            type: "string",
          },
        },
        required: ["fingerprint", "paneId", "command", "confirmed"],
        type: "object",
      },
      name: "surf_ace_launch_terminal",
    },
    {
      description: "Clear the currently visible content in a pane.",
      execute: async (args: { fingerprint: string; paneId: PaneId }) => await runtime.clear(args),
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
      description: "Operator tool to reset Surf Ace connection circuits and reattempt stopped reconnect/probe workers.",
      execute: async (args: SurfAceReattemptConnectionsInput = {}) => await runtime.reattemptConnections(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          fingerprint: {
            ...fingerprintParam,
            description: "Optional window-scoped surface identity. Omit to reattempt all surfaces and endpoint probes.",
          },
        },
        type: "object",
      },
      name: "surf_ace_reattempt_connections",
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
            description: "Optional. vertical creates side-by-side panes; horizontal creates top/bottom panes. When omitted, Surf Ace chooses from the target pane geometry.",
            enum: ["horizontal", "vertical"],
            type: "string",
          },
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
        },
        required: ["fingerprint", "paneId", "count"],
        type: "object",
      },
      name: "surf_ace_split",
    },
    {
      description: "Realize a desired Surf Ace root layout or pane subtree in one provider-side topology operation.",
      execute: async (args: SurfAceRealizeTopologyInput) => await runtime.realizeTopology(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          ...realizeTopologyInputProperties,
          desired: {
            ...realizeTopologyDesiredSchema,
          },
        },
        required: realizeTopologyRequiredProperties,
        type: "object",
      },
      name: "surf_ace_realize_topology",
    },
    {
      description: "Realize desired Surf Ace topology changes across multiple surfaces in one CLU-facing operation.",
      execute: async (args: SurfAceRealizeTopologiesInput) => await runtime.realizeTopologies(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          operations: {
            items: {
              additionalProperties: false,
              properties: {
                ...realizeTopologyInputProperties,
                desired: {
                  ...realizeTopologyDesiredSchema,
                },
                operationId: {
                  description: "Optional caller-supplied identifier echoed in per-surface results.",
                  type: "string",
                },
                windowLabel: {
                  description: "Optional current window label guard from `surf_ace_list`.",
                  type: "string",
                },
              },
              required: realizeTopologyRequiredProperties,
              type: "object",
            },
            minItems: 1,
            type: "array",
          },
        },
        required: ["operations"],
        type: "object",
      },
      name: "surf_ace_realize_topologies",
    },
    {
      description: "Close an existing Surf Ace pane.",
      execute: async (args: { fingerprint: string; paneId: PaneId }) => await runtime.closePane(args),
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
      description: "Read the local Surf Ace buffer for a pane, including the current cached content snapshot and locally known pushed content. No live network call is made.",
      execute: async (args: { fingerprint: string; paneId: PaneId }) => await runtime.read(args),
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
      description: "Capture the actual rendered contents of one explicit Surf Ace pane and return PNG bytes plus surface, pane, topology, content, dimension, scale, timestamp, and failure metadata.",
      execute: async (args: { fingerprint: string; paneId: PaneId }) => await runtime.capturePane(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
        },
        required: ["fingerprint", "paneId"],
        type: "object",
      },
      name: "surf_ace_capture_pane",
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
