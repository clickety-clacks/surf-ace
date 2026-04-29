import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { deliverSettledAnnotationIntentTurn } from "./annotation-intent-delivery.js";
import { createSurfAceRuntime } from "./surf-ace-runtime.js";
import { createSurfAceTools } from "./surf-ace-tools.js";

const plugin = {
  id: "surf-ace",
  name: "Surf Ace",
  description: "Surf Ace discovery, persistent surface connections, and pane tools for OpenClaw.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const logger = (api.logger ?? console) as never;
    const runtime = createSurfAceRuntime({
      deliverSettledAnnotationTurn: async (turn) => {
        await deliverSettledAnnotationIntentTurn(api.runtime, turn);
      },
      logger,
      providerName: "CLU / Surf Ace",
    });

    // Start eagerly — the gateway does not call registerService lifecycle
    // hooks, so relying on them leaves the runtime uninitialized.
    runtime.start().catch((error) => {
      (logger as Console).warn?.(
        `[surf-ace] runtime.start() failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    api.registerService({
      id: "surf-ace-extension",
      start: async () => {
        await runtime.start();
      },
      stop: async () => {
        await runtime.stop();
      },
    });

    for (const tool of createSurfAceTools(runtime)) {
      api.registerTool((ctx) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (_id: string, params: unknown) => {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  await tool.execute(params as never, {
                    sessionDisplayName: ctx.sessionDisplayName,
                    sessionKey: ctx.sessionKey,
                  }),
                  null,
                  2,
                ),
              },
            ],
          };
        },
      }));
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
  type SurfAceConnectionState,
  type SurfAceClosePaneResult,
  type SurfAceLocalEvent,
  type SurfAcePaneSummary,
  type SurfAcePushInput,
  type SurfAcePushResult,
  type SurfAceReadResult,
  type SurfAceRuntime,
  type SurfAceRuntimeOptions,
  type SurfAceScreenSummary,
  type SurfAceSplitInput,
  type SurfAceSplitResult,
  type SurfAceSnapshotResult,
  SurfAceToolError,
  createSurfAceRuntime,
} from "./surf-ace-runtime.js";
export {
  surfAceToolNames,
  type SurfAceToolDefinition,
  type SurfAceToolName,
} from "./surf-ace-tools.js";
