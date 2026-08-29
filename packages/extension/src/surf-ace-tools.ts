import { buildSurfAceAgentInstructions } from "./agent-instructions.js";
import type { PusherProvenance } from "../../protocol/src/index.js";
import {
  type SurfAceAnnotateRemoveInput,
  type SurfAceLaunchNativeAppInput,
  type PaneId,
  type SurfAceRealizeTopologyInput,
  type SurfAceRealizeTopologiesInput,
  type SurfAceReattemptConnectionsInput,
  type SurfAceSplitInput,
  type SurfAcePushInput,
  type SurfAceScreenSummary,
  type SurfAceRuntime,
  type SurfAceRuntimeOptions,
  createSurfAceRuntime,
} from "./surf-ace-runtime.js";

export const surfAceToolNames = [
  "surf_ace_list",
  "surf_ace_prepare_migration_now",
  "surf_ace_authority_diagnostics",
  "surf_ace_push",
  "surf_ace_launch_native_app",
  "surf_ace_clear",
  "surf_ace_relinquish",
  "surf_ace_reattempt_connections",
  "surf_ace_split",
  "surf_ace_realize_topology",
  "surf_ace_realize_topologies",
  "surf_ace_close_pane",
  "surf_ace_rename_pane",
  "surf_ace_restore_pane",
  "surf_ace_surface_intent",
  "surf_ace_target_register",
  "surf_ace_target_apply",
  "surf_ace_read",
  "surf_ace_capture_pane",
  "surf_ace_annotations_remove",
] as const;

export type SurfAceToolName = (typeof surfAceToolNames)[number];

export type SurfAceToolContext = {
  agentId?: string;
  displayName?: string;
  provenance?: PusherProvenance;
  pushedAt?: string;
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

type PublicSurfAceScreenSummary = Omit<SurfAceScreenSummary, "_debug">;

type SurfAceListInput = {
  actionableOnly?: boolean;
  fingerprint?: string;
  name?: string;
  paneAddress?: string;
  paneId?: PaneId | string | number;
  windowLabel?: string;
};

function compactSurfAceListOutput(
  screens: SurfAceScreenSummary[],
  input: SurfAceListInput = {},
): PublicSurfAceScreenSummary[] {
  const hasPaneFilter = input.paneAddress !== undefined || input.paneId !== undefined;
  return screens
    .filter((screen) => screenMatchesSurfAceListInput(screen, input))
    .map(({ _debug, ...screen }) => {
      const panes = hasPaneFilter
        ? screen.panes.filter((pane) => paneMatchesSurfAceListInput(pane, input))
        : screen.panes;
      return {
        ...screen,
        panes,
      };
    })
    .filter((screen) => !hasPaneFilter || screen.panes.length > 0);
}

function screenMatchesSurfAceListInput(screen: SurfAceScreenSummary, input: SurfAceListInput): boolean {
  if (input.actionableOnly === true && !screen.authority.actionable) {
    return false;
  }
  if (input.fingerprint !== undefined && screen.fingerprint !== input.fingerprint) {
    return false;
  }
  if (input.windowLabel !== undefined && screen.windowLabel !== input.windowLabel) {
    return false;
  }
  if (input.name !== undefined && !screenMatchesNameFilter(screen, input.name)) {
    return false;
  }
  return true;
}

function normalizedSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function screenSearchAliases(screen: SurfAceScreenSummary): string[] {
  const aliases = [
    screen.name,
    screen.fingerprint,
    screen.windowLabel,
    screen._debug?.endpointId,
    screen._debug?.localOwnership?.endpointHost,
    screen._debug?.localOwnership?.endpointName,
    screen._debug?.remoteOwnership?.endpointHost,
    screen._debug?.remoteOwnership?.endpointName,
  ];
  return aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0);
}

function screenMatchesNameFilter(screen: SurfAceScreenSummary, filter: string): boolean {
  const needle = normalizedSearchText(filter);
  if (!needle) {
    return true;
  }
  return screenSearchAliases(screen).some((alias) => normalizedSearchText(alias).includes(needle));
}

function paneMatchesSurfAceListInput(
  pane: PublicSurfAceScreenSummary["panes"][number],
  input: SurfAceListInput,
): boolean {
  if (input.paneAddress !== undefined && pane.paneAddress !== input.paneAddress && pane.displayId !== input.paneAddress) {
    return false;
  }
  if (input.paneId !== undefined && String(pane.paneId) !== String(input.paneId)) {
    return false;
  }
  return true;
}

const realizeTopologyTargetSchema = {
  additionalProperties: false,
  properties: {
    paneId: paneIdParam,
    root: {
      description: "Set to true to target the whole layout.",
      type: "boolean",
    },
  },
  required: ["root"],
  description: "Use `{ root: true }` to replace the whole layout, or `{ paneId }` to replace one pane slot.",
  type: "object",
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
      description: "List discovered Surf Ace surfaces, optionally narrowed by surface or pane identifiers, including the unique user-facing `displayId` / `paneAddress`, `windowLabel` / `paneLabel`, and internal pane ids for subsequent pane-scoped calls.",
      execute: async (args: SurfAceListInput = {}) => compactSurfAceListOutput(await runtime.listScreens(), args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          actionableOnly: {
            description: "When true, return only surfaces whose provider authority says they are actionable.",
            type: "boolean",
          },
          fingerprint: fingerprintParam,
          name: {
            description: "Case-insensitive substring match against the Surf Ace surface name, e.g. `workstation-a` or `Cyberbrain`.",
            type: "string",
          },
          paneAddress: {
            description: "Visible pane address/displayId returned by `surf_ace_list`, e.g. `b4`.",
            type: "string",
          },
          paneId: paneIdParam,
          windowLabel: {
            description: "Provider-assigned visible window label returned by `surf_ace_list`, e.g. `b`.",
            type: "string",
          },
        },
        type: "object",
      },
      name: "surf_ace_list",
    },
    {
      description: "Durably freeze the explicit post-read legacy-to-lockless migration boundary for one surface without network I/O.",
      execute: async (args: { fingerprint: string }) =>
        await runtime.prepareLegacyLocklessMigrationNow(args.fingerprint),
      inputSchema: {
        additionalProperties: false,
        properties: { fingerprint: fingerprintParam },
        required: ["fingerprint"],
        type: "object",
      },
      name: "surf_ace_prepare_migration_now",
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
      description: "Launch a provider-owned native app/process target in a pane through Surf Ace native hosting, applying Surf Ace chrome/overlay regions. This is the primitive process launch surface. Requires confirmed:true. Native GUI/app product proof must use this provider path; direct compositor/native-pane hosting is diagnostic only.",
      execute: async (args: SurfAceLaunchNativeAppInput, context?: SurfAceToolContext) =>
        await runtime.launchNativeApp(args, {
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
          appId: {
            description: "Canonical target app/process identity for the native hosted app.",
            minLength: 1,
            type: "string",
          },
          args: {
            description: "Optional argv entries for launch-capable native app hosts.",
            items: { type: "string" },
            type: "array",
          },
          confirmed: {
            description: "Must be true to apply a process-backed native app target.",
            enum: [true],
            type: "boolean",
          },
          cwd: {
            type: "string",
          },
          env: {
            additionalProperties: { type: "string" },
            description: "Optional explicit environment variables for launch-capable native app hosts.",
            type: "object",
          },
          fingerprint: fingerprintParam,
          idempotencyKey: {
            description: "Optional stable caller key used to make repeated launches idempotent for the same pane/app.",
            type: "string",
          },
          launchMode: {
            default: "new_instance",
            enum: ["new_instance", "attach_or_launch"],
            type: "string",
          },
          paneId: paneIdParam,
          summary: {
            description: "Optional human-readable target summary shown in diagnostics.",
            type: "string",
          },
        },
        required: ["fingerprint", "paneId", "appId", "confirmed"],
        type: "object",
      },
      name: "surf_ace_launch_native_app",
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
      description: "Realize desired Surf Ace topology changes and top-level Spatial surface-window lifecycle mutations across one or more surfaces.",
      execute: async (args: SurfAceRealizeTopologiesInput, context?: SurfAceToolContext) =>
        await runtime.realizeTopologies({
          operations: args.operations.map((operation) =>
            "action" in operation && !operation.requestedBy
              ? { ...operation, requestedBy: context?.displayName ?? context?.agentId ?? context?.sessionKey }
              : operation
          ),
        }),
      inputSchema: {
        additionalProperties: false,
        properties: {
          operations: {
            items: {
              anyOf: [
                {
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
                {
                  additionalProperties: false,
                  properties: {
                    action: {
                      description: "Top-level Surf Ace Spatial surface-window lifecycle mutation.",
                      enum: ["openWindow", "closeWindow"],
                      type: "string",
                    },
                    fingerprint: fingerprintParam,
                    operationId: {
                      description: "Optional caller-supplied identifier echoed in per-surface results.",
                      type: "string",
                    },
                    requestedBy: {
                      description: "Optional caller label forwarded to the app host for diagnostics.",
                      type: "string",
                    },
                    windowLabel: {
                      description: "Optional current window label guard from `surf_ace_list`.",
                      type: "string",
                    },
                  },
                  required: ["fingerprint", "action"],
                  type: "object",
                },
              ],
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
      execute: async (args: { expectedTopologyRevision: number; fingerprint: string; paneId: PaneId }) =>
        await runtime.closePane(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
          expectedTopologyRevision: {
            description: "Required in lockless mode; use topologyRevision from the latest surf_ace_list.",
            minimum: 0,
            type: "integer",
          },
        },
        required: ["fingerprint", "paneId", "expectedTopologyRevision"],
        type: "object",
      },
      name: "surf_ace_close_pane",
    },
    {
      description: "Rename a pane using the latest client topology revision.",
      execute: async (args: Parameters<SurfAceRuntime["renamePane"]>[0]) =>
        await runtime.renamePane(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          expectedTopologyRevision: { minimum: 0, type: "integer" },
          fingerprint: fingerprintParam,
          name: { type: ["string", "null"] },
          paneId: paneIdParam,
        },
        required: ["fingerprint", "paneId", "name", "expectedTopologyRevision"],
        type: "object",
      },
      name: "surf_ace_rename_pane",
    },
    {
      description: "Restore a retained pane tombstone beside an existing anchor pane.",
      execute: async (args: Parameters<SurfAceRuntime["restorePane"]>[0]) =>
        await runtime.restorePane(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          anchorPaneId: paneIdParam,
          direction: { enum: ["horizontal", "vertical"], type: "string" },
          expectedTopologyRevision: { minimum: 0, type: "integer" },
          fingerprint: fingerprintParam,
          tombstoneId: { type: "string" },
        },
        required: ["fingerprint", "anchorPaneId", "direction", "expectedTopologyRevision", "tombstoneId"],
        type: "object",
      },
      name: "surf_ace_restore_pane",
    },
    {
      description: "Open, recoverably close, or restore a Surf Ace surface through its endpoint lifecycle connection.",
      execute: async (args: Parameters<SurfAceRuntime["surfaceIntent"]>[0]) =>
        await runtime.surfaceIntent(args),
      inputSchema: {
        additionalProperties: true,
        properties: {
          action: { enum: ["open", "close", "restore"], type: "string" },
          endpointId: { type: "string" },
          expectedSurfaceSetRevision: { minimum: 0, type: "integer" },
          expectedTopologyRevision: { minimum: 0, type: "integer" },
          fingerprint: fingerprintParam,
          tombstoneId: { type: "string" },
        },
        required: ["action", "expectedSurfaceSetRevision"],
        type: "object",
      },
      name: "surf_ace_surface_intent",
    },
    {
      description: "Register client-restorable target material without legacy ownership fields.",
      execute: async (
        args: Parameters<SurfAceRuntime["registerTarget"]>[0],
      ) => await runtime.registerTarget(args),
      inputSchema: {
        additionalProperties: true,
        properties: {
          fingerprint: fingerprintParam,
          idempotencyKey: { minLength: 1, type: "string" },
          paneId: paneIdParam,
        },
        required: ["fingerprint", "paneId", "idempotencyKey"],
        type: "object",
      },
      name: "surf_ace_target_register",
    },
    {
      description: "Apply or restore a registered target through the client-owned target lifecycle.",
      execute: async (
        args: Parameters<SurfAceRuntime["restoreTarget"]>[0],
      ) => await runtime.restoreTarget(args),
      inputSchema: {
        additionalProperties: false,
        properties: {
          confirmed: { type: "boolean" },
          fingerprint: fingerprintParam,
          paneId: paneIdParam,
          targetId: { minLength: 1, type: "string" },
        },
        required: ["fingerprint", "paneId"],
        type: "object",
      },
      name: "surf_ace_target_apply",
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
