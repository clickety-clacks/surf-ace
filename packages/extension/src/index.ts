import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import {
  resolveSurfAceToolContextFromOpenClawContext,
  surfAceToolContextFromOpenClawContext,
} from "./openclaw-tool-context.js";
import { OpenClawLocklessController } from "./openclaw-lockless-controller.js";
import { assertProviderHostAllowed } from "./provider-host-guard.js";
import {
  resolveDefaultSurfAceStateDir,
  type SurfAceRuntime,
} from "./surf-ace-runtime.js";
import { createSurfAceTools } from "./surf-ace-tools.js";
import {
  acquireSharedRuntime,
  releaseSharedRuntime,
  startSharedRuntime,
} from "./shared-runtime.js";

const plugin = {
  id: "surf-ace",
  name: "Surf Ace",
  description: "Surf Ace lockless discovery, persistent controller connections, and pane tools for OpenClaw.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["allocator"],
    properties: {
      allocator: {
        type: "object", additionalProperties: false,
        required: ["url", "fleetId", "expectedAllocatorId"],
        properties: {
          url: { type: "string" },
          fleetId: { type: "string" },
          expectedAllocatorId: { type: "string" },
        },
      },
    },
  },
  register(api: OpenClawPluginApi) {
    const allocator = api.pluginConfig?.allocator as {
      url?: unknown; fleetId?: unknown; expectedAllocatorId?: unknown;
    } | undefined;
    if (!allocator || typeof allocator.url !== "string" ||
      typeof allocator.fleetId !== "string" || !allocator.fleetId ||
      typeof allocator.expectedAllocatorId !== "string" || !allocator.expectedAllocatorId) {
      throw new Error("Surf Ace central provider requires its allocator binding");
    }
    const allocatorUrl = new URL(allocator.url);
    if (!["ws:", "wss:"].includes(allocatorUrl.protocol)) {
      throw new Error("Surf Ace allocator binding requires a WebSocket URL");
    }
    const binding = {
      url: allocator.url, fleetId: allocator.fleetId,
      expectedAllocatorId: allocator.expectedAllocatorId,
    };
    const logger = (api.logger ?? console) as Console;
    assertProviderHostAllowed(logger);
    const openClawStateDir = api.runtime.state?.resolveStateDir?.();
    const stateDir = resolveDefaultSurfAceStateDir(openClawStateDir);
    const shared = acquireSharedRuntime(
      stateDir,
      () => new OpenClawLocklessController({ allocator: binding, logger, stateDir }) as SurfAceRuntime,
    );
    const runtime = shared.runtime;

    startSharedRuntime(shared).catch((error) => {
      logger.warn?.(
        `[surf-ace] runtime.start() failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    api.registerService({
      id: "surf-ace-extension",
      start: async () => {
        await startSharedRuntime(shared);
      },
      stop: async () => {
        await releaseSharedRuntime(stateDir, shared);
      },
    });

    for (const tool of createSurfAceTools(runtime)) {
      api.registerTool(
        (context) => {
          const toolContext = surfAceToolContextFromOpenClawContext(context);
          return {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            execute: async (_id: string, params: unknown) => {
              const resolvedToolContext = await resolveSurfAceToolContextFromOpenClawContext(
                context,
                {
                  baseContext: toolContext,
                  clawlineChatNames: { openClawStateDir },
                },
              );
              const result = await tool.execute(params as never, resolvedToolContext);
              const noSurfaces = tool.name === "surf_ace_list" &&
                Array.isArray(result) && result.length === 0 &&
                Object.keys((params ?? {}) as object).length === 0;
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      result,
                      null,
                      2,
                    ),
                  },
                  ...(noSurfaces
                    ? [{ type: "text" as const, text: "No surfaces discovered." }]
                    : []),
                ],
              };
            },
          };
        },
        { names: [tool.name] },
      );
    }
  },
};

export default plugin;

export { buildSurfAceAgentInstructions } from "./agent-instructions.js";
export {
  deliverSettledAnnotationIntentTurn,
  __test as annotationIntentDeliveryTestHelpers,
} from "./annotation-intent-delivery.js";
export {
  type SurfAceAnnotationIntentTurn,
  type SurfAceClosePaneResult,
  type SurfAceConnectionState,
  type SurfAceLocalEvent,
  type SurfAcePaneSummary,
  type SurfAcePushInput,
  type SurfAcePushResult,
  type SurfAceReadResult,
  type SurfAceRuntime,
  type SurfAceRuntimeOptions,
  type SurfAceScreenSummary,
  type SurfAceSnapshotResult,
  type SurfAceSplitInput,
  type SurfAceSplitResult,
  resolveDefaultSurfAceStateDir,
} from "./surf-ace-runtime.js";
export {
  surfAceToolNames,
  type SurfAceToolContext,
  type SurfAceToolDefinition,
  type SurfAceToolName,
} from "./surf-ace-tools.js";
