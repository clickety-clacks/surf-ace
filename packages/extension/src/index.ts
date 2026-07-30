import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { deliverSettledAnnotationIntentTurn } from "./annotation-intent-delivery.js";
import {
  resolveSurfAceToolContextFromOpenClawContext,
  surfAceToolContextFromOpenClawContext,
} from "./openclaw-tool-context.js";
import { assertProviderHostAllowed } from "./provider-host-guard.js";
import { OpenClawLocklessController } from "./openclaw-lockless-controller.js";
import {
  createSurfAceRuntime,
  resolveDefaultSurfAceStateDir,
  type SurfAceRuntime,
} from "./surf-ace-runtime.js";
import { createSurfAceTools, type SurfAceToolContext } from "./surf-ace-tools.js";
import {
  acquireSharedRuntime,
  releaseSharedRuntime,
  startSharedRuntime,
} from "./shared-runtime.js";

const plugin = {
  id: "surf-ace",
  name: "Surf Ace",
  description: "Surf Ace discovery, persistent surface connections, and pane tools for OpenClaw.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const logger = (api.logger ?? console) as Console;
    assertProviderHostAllowed(logger);
    const openClawStateDir = api.runtime.state?.resolveStateDir?.();
    const stateDir = resolveDefaultSurfAceStateDir(openClawStateDir);
    const shared = acquireSharedRuntime(
      stateDir,
      () => {
        const locklessController = new OpenClawLocklessController({
          logger,
          stateDir,
        });
        const legacyRuntime = createSurfAceRuntime({
          deliverSettledAnnotationTurn: async (turn) => {
            await deliverSettledAnnotationIntentTurn(api.runtime, turn);
          },
          discovery: locklessController.legacyDiscovery(),
          logger,
          openClawStateDir,
          providerName: "CLU / Surf Ace",
        });
        locklessController.setLegacyMigrationSource(legacyRuntime);
        return capabilityGatedRuntime(
          legacyRuntime,
          locklessController,
        );
      },
    );
    const runtime = shared.runtime;

    // Start eagerly — the gateway does not call registerService lifecycle
    // hooks, so relying on them leaves the runtime uninitialized.
    startSharedRuntime(shared).catch((error) => {
      (logger as Console).warn?.(
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
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      await tool.execute(params as never, resolvedToolContext),
                      null,
                      2,
                    ),
                  },
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

function capabilityGatedRuntime(
  legacyRuntime: SurfAceRuntime,
  locklessController: OpenClawLocklessController,
): SurfAceRuntime {
  return new Proxy(legacyRuntime, {
    get(target, property, receiver) {
      switch (property) {
        case "start":
          return async () => {
            await locklessController.start();
            await target.start();
          };
        case "stop":
          return async () => {
            await target.stop();
            await locklessController.stop();
          };
        case "listScreens":
          return async () => [
            ...(await locklessController.listScreens()),
            ...(await target.listScreens()),
          ];
        case "push":
          return async (
            input: Parameters<SurfAceRuntime["push"]>[0],
            context?: Parameters<SurfAceRuntime["push"]>[1],
          ) => locklessController.hasFingerprint(input.fingerprint)
            ? await locklessController.push(input, context)
            : await target.push(input, context);
        case "read":
          return async (input: Parameters<SurfAceRuntime["read"]>[0]) =>
            locklessController.hasFingerprint(input.fingerprint)
              ? await locklessController.read(input)
              : await target.read(input);
        case "split":
          return async (input: Parameters<SurfAceRuntime["split"]>[0]) =>
            locklessController.hasFingerprint(input.fingerprint)
              ? await locklessController.split(input)
              : await target.split(input);
        case "closePane":
          return async (
            input: Parameters<SurfAceRuntime["closePane"]>[0] & {
              expectedTopologyRevision?: number;
            },
          ) => locklessController.hasFingerprint(input.fingerprint)
            ? await locklessController.closePane(input)
            : await target.closePane(input);
        case "renamePane":
          return async (
            input: Parameters<SurfAceRuntime["renamePane"]>[0],
          ) => locklessController.hasFingerprint(input.fingerprint)
            ? await locklessController.renamePane(input)
            : await target.renamePane(input);
        case "restorePane":
          return async (
            input: Parameters<SurfAceRuntime["restorePane"]>[0],
          ) => locklessController.hasFingerprint(input.fingerprint)
            ? await locklessController.restorePane(input)
            : await target.restorePane(input);
        case "surfaceIntent":
          return async (
            input: Parameters<SurfAceRuntime["surfaceIntent"]>[0],
          ) => {
            const fingerprint = typeof input.fingerprint === "string"
              ? input.fingerprint
              : "";
            const endpointId = typeof input.endpointId === "string"
              ? input.endpointId
              : "";
            return (
                (input.action === "close" &&
                  locklessController.hasFingerprint(fingerprint)) ||
                (input.action !== "close" &&
                  locklessController.hasEndpoint(endpointId))
              )
              ? await locklessController.surfaceIntent(input)
              : await target.surfaceIntent(input);
          };
        case "clear":
          return async (input: Parameters<SurfAceRuntime["clear"]>[0]) =>
            locklessController.hasFingerprint(input.fingerprint)
              ? await locklessController.clear(input)
              : await target.clear(input);
        case "annotateRemove":
          return async (
            input: Parameters<SurfAceRuntime["annotateRemove"]>[0],
          ) => locklessController.hasFingerprint(input.fingerprint)
            ? await locklessController.annotateRemove(input)
            : await target.annotateRemove(input);
        case "capturePane":
          return async (
            input: Parameters<SurfAceRuntime["capturePane"]>[0],
          ) => locklessController.hasFingerprint(input.fingerprint)
            ? await locklessController.capturePane(input)
            : await target.capturePane(input);
        case "snapshot":
          return async (input: Parameters<SurfAceRuntime["snapshot"]>[0]) =>
            locklessController.hasFingerprint(input.fingerprint)
              ? await locklessController.snapshot(input)
              : await target.snapshot(input);
        case "realizeTopology":
          return async (
            input: Parameters<SurfAceRuntime["realizeTopology"]>[0],
          ) => locklessController.hasFingerprint(input.fingerprint)
            ? await locklessController.realizeTopology(input)
            : await target.realizeTopology(input);
        case "realizeTopologies":
          return async (
            input: Parameters<SurfAceRuntime["realizeTopologies"]>[0],
          ) => await realizeCapabilityGatedTopologies(
            input,
            target,
            locklessController,
          );
        case "launchNativeApp":
          return async (
            input: Parameters<SurfAceRuntime["launchNativeApp"]>[0],
            context?: Parameters<SurfAceRuntime["launchNativeApp"]>[1],
          ) => locklessController.hasFingerprint(input.fingerprint)
            ? await locklessController.launchNativeApp(input)
            : await target.launchNativeApp(input, context);
        case "registerTarget":
          return async (
            input: Parameters<SurfAceRuntime["registerTarget"]>[0],
          ) => locklessController.hasFingerprint(input.fingerprint)
            ? await locklessController.registerTarget(input)
            : await target.registerTarget(input);
        case "restoreTarget":
          return async (
            input: Parameters<SurfAceRuntime["restoreTarget"]>[0],
          ) => locklessController.hasFingerprint(input.fingerprint)
            ? await locklessController.restoreTarget(input)
            : await target.restoreTarget(input);
        case "relinquish":
          return async (...args: unknown[]) => {
            const input = args[0] as { fingerprint?: string } | undefined;
            if (
              input?.fingerprint &&
              locklessController.hasFingerprint(input.fingerprint)
            ) {
              throw new Error(
                `${String(property)} is not advertised by the lockless capability`,
              );
            }
            const method = Reflect.get(target, property, receiver) as
              (...methodArgs: unknown[]) => unknown;
            return await method.apply(target, args);
          };
        case "reattemptConnections":
          return async (
            input?: Parameters<SurfAceRuntime["reattemptConnections"]>[0],
          ) => {
            if (
              input?.fingerprint &&
              locklessController.hasFingerprint(input.fingerprint)
            ) {
              return await locklessController.reattemptConnections(input);
            }
            if (input?.fingerprint) {
              return await target.reattemptConnections(input);
            }
            const [lockless, legacy] = await Promise.all([
              locklessController.reattemptConnections(),
              target.reattemptConnections(),
            ]);
            return {
              endpointProbes: [
                ...lockless.endpointProbes,
                ...legacy.endpointProbes,
              ],
              surfaces: [...lockless.surfaces, ...legacy.surfaces],
            };
          };
        default: {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  });
}

async function realizeCapabilityGatedTopologies(
  input: Parameters<SurfAceRuntime["realizeTopologies"]>[0],
  legacyRuntime: SurfAceRuntime,
  locklessController: OpenClawLocklessController,
): Promise<Awaited<ReturnType<SurfAceRuntime["realizeTopologies"]>>> {
  const applied: Awaited<
    ReturnType<SurfAceRuntime["realizeTopologies"]>
  >["applied"] = [];
  for (const [index, operation] of input.operations.entries()) {
    const lockless = "action" in operation &&
        operation.action === "openWindow"
      ? locklessController.hasEndpoint(operation.fingerprint)
      : locklessController.hasFingerprint(operation.fingerprint);
    const result = await (
      lockless ? locklessController : legacyRuntime
    ).realizeTopologies({ operations: [operation] });
    applied.push(...result.applied);
    if (!result.ok) {
      return {
        applied,
        failed: {
          ...result.failed,
          index,
        },
        ok: false,
        skipped: input.operations.slice(index + 1).map(
          (skipped, offset) => ({
            fingerprint: skipped.fingerprint,
            index: index + offset + 1,
            operationId: skipped.operationId,
            windowLabel: skipped.windowLabel,
          }),
        ),
      };
    }
  }
  return { applied, ok: true };
}

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
  resolveDefaultSurfAceStateDir,
} from "./surf-ace-runtime.js";
export {
  surfAceToolNames,
  type SurfAceToolContext,
  type SurfAceToolDefinition,
  type SurfAceToolName,
} from "./surf-ace-tools.js";
