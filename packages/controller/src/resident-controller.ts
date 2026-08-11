import { createHash } from "node:crypto";
import path from "node:path";

import type {
  LocklessContentPush,
  LocklessPaneCloseIntent,
  LocklessPaneRestoreIntent,
  LocklessPaneSplitIntent,
  LocklessScopeId,
  LocklessSurfaceCloseIntent,
  LocklessSurfaceOpenIntent,
  LocklessSurfaceRestoreIntent,
} from "@surf-ace/protocol";

import {
  createBonjourSurfAceDiscoveryService,
  type SurfAceDiscoveryEndpoint,
  type SurfAceDiscoveryService,
  type SurfAceLogger,
} from "./discovery.js";
import { ControllerIdentity } from "./identity.js";
import { MultiSurfaceController } from "./multi-surface-controller.js";
import { BoundedControllerProjection } from "./projection.js";
import {
  FileControllerStateStore,
  type ControllerStateStore,
} from "./state-store.js";
import { PublicControllerWireClient } from "./wire.js";

export interface ResidentEndpointController {
  closePane(surfaceId: string, input: LocklessPaneCloseIntent): Promise<unknown>;
  closeSurface(
    surfaceId: string,
    input: Omit<LocklessSurfaceCloseIntent, "surfaceId">,
  ): Promise<unknown>;
  listSurfaces(): Promise<unknown>;
  openSurface(input: LocklessSurfaceOpenIntent): Promise<unknown>;
  push(surfaceId: string, input: LocklessContentPush): Promise<unknown>;
  readLocal(scopeId: LocklessScopeId): Promise<unknown>;
  requestSurface(
    surfaceId: string,
    op: string,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  restorePane(surfaceId: string, input: LocklessPaneRestoreIntent): Promise<unknown>;
  restoreSurface(
    tombstoneId: string,
    input: Omit<LocklessSurfaceRestoreIntent, "tombstoneId">,
  ): Promise<unknown>;
  splitPane(surfaceId: string, input: LocklessPaneSplitIntent): Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type ResidentFleetEndpoint = {
  discovered: boolean;
  endpointId: string;
  fingerprintPrefix: string;
  host: string;
  instanceName: string;
  lastError: string | null;
  lastSeenAt: number;
  name: string;
  panesListedAt: number | null;
  port: number;
  stableKey: string;
  surfaces: Array<Record<string, unknown>>;
  wsPath: string;
};

export type ResidentFleetTopology = {
  endpoints: Record<string, ResidentFleetEndpoint>;
  version: 1;
};

export type ResidentControllerOptions = {
  controllerProductName: string;
  createEndpointController?: (
    endpoint: SurfAceDiscoveryEndpoint,
    stableKey: string,
  ) => ResidentEndpointController;
  discovery?: SurfAceDiscoveryService;
  identity?: ControllerIdentity;
  logger?: SurfAceLogger;
  now?: () => number;
  projectionCapacityBytes?: number;
  stateDir: string;
  topologyStore?: ControllerStateStore;
};

type ActiveEndpoint = {
  controller: ResidentEndpointController;
  url: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isFleetEndpoint(value: unknown): value is ResidentFleetEndpoint {
  const candidate = asRecord(value);
  return typeof candidate.discovered === "boolean" &&
    typeof candidate.endpointId === "string" &&
    typeof candidate.fingerprintPrefix === "string" &&
    typeof candidate.host === "string" &&
    typeof candidate.instanceName === "string" &&
    (candidate.lastError === null || typeof candidate.lastError === "string") &&
    typeof candidate.lastSeenAt === "number" &&
    typeof candidate.name === "string" &&
    (candidate.panesListedAt === null || typeof candidate.panesListedAt === "number") &&
    typeof candidate.port === "number" &&
    typeof candidate.stableKey === "string" &&
    Array.isArray(candidate.surfaces) &&
    typeof candidate.wsPath === "string";
}

function parseTopology(value: unknown | null): ResidentFleetTopology {
  if (value === null) {
    return { endpoints: {}, version: 1 };
  }
  const candidate = asRecord(value);
  const endpoints = asRecord(candidate.endpoints);
  if (
    candidate.version !== 1 ||
    Object.values(endpoints).some((endpoint) => !isFleetEndpoint(endpoint))
  ) {
    throw new Error("invalid_resident_fleet_topology");
  }
  return value as ResidentFleetTopology;
}

function endpointStableKey(endpoint: SurfAceDiscoveryEndpoint): string {
  const identity = endpoint.fingerprintPrefix.trim().toLowerCase() ||
    endpoint.instanceName.trim();
  if (!identity) {
    throw new Error("discovery_endpoint_missing_stable_identity");
  }
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

function endpointUrl(endpoint: SurfAceDiscoveryEndpoint): string {
  const host = endpoint.host.includes(":")
    ? `[${endpoint.host}]`
    : endpoint.host;
  return `ws://${host}:${endpoint.port}${endpoint.wsPath}`;
}

function surfaceId(value: unknown): string {
  const id = asRecord(value).surfaceId;
  return typeof id === "string" ? id : "";
}

function without(
  value: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}

export class ResidentController {
  private readonly active = new Map<string, ActiveEndpoint>();
  private readonly createEndpointController: NonNullable<
    ResidentControllerOptions["createEndpointController"]
  >;
  private readonly discovery: SurfAceDiscoveryService;
  private readonly identity: ControllerIdentity;
  private readonly logger: SurfAceLogger;
  private readonly now: () => number;
  private readonly topologyStore: ControllerStateStore;
  private topology: ResidentFleetTopology = { endpoints: {}, version: 1 };
  private unsubscribe: (() => void) | null = null;
  private transition = Promise.resolve();

  constructor(private readonly options: ResidentControllerOptions) {
    this.discovery = options.discovery ?? createBonjourSurfAceDiscoveryService();
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => Date.now());
    this.topologyStore = options.topologyStore ?? new FileControllerStateStore(
      path.join(options.stateDir, "fleet-topology.json"),
    );
    this.identity = options.identity ?? new ControllerIdentity(
      new FileControllerStateStore(
        path.join(options.stateDir, "controller-identity.json"),
      ),
    );
    const projectionCapacityBytes = options.projectionCapacityBytes ??
      16 * 1024 * 1024;
    this.createEndpointController = options.createEndpointController ??
      ((endpoint, stableKey) => new MultiSurfaceController({
        controllerProductName: options.controllerProductName,
        createProjection: (scopeKey) => {
          const projectionKey = createHash("sha256")
            .update(`${stableKey}:${scopeKey}`)
            .digest("hex")
            .slice(0, 24);
          return new BoundedControllerProjection(
            new FileControllerStateStore(
              path.join(
                options.stateDir,
                "projections",
                projectionKey,
                "state.json",
              ),
            ),
            projectionCapacityBytes,
          );
        },
        createWire: () => new PublicControllerWireClient(endpointUrl(endpoint)),
        identity: this.identity,
      }));
  }

  async start(): Promise<void> {
    this.topology = parseTopology(await this.topologyStore.load());
    await this.identity.loadOrCreate();
    this.unsubscribe = this.discovery.subscribe((endpoints) => {
      void this.enqueueDiscovery(endpoints);
    });
    await this.discovery.start();
    await this.enqueueDiscovery(this.discovery.getSnapshot());
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.discovery.stop();
    await this.transition;
    await Promise.all(
      [...this.active.values()].map(({ controller }) => controller.stop()),
    );
    this.active.clear();
  }

  async call(
    command: string,
    inputValue: unknown,
  ): Promise<Record<string, unknown>> {
    const input = asRecord(inputValue);
    const result = await this.dispatch(command, input);
    return {
      command,
      controllerInstanceId: await this.identity.loadOrCreate(),
      ok: true,
      reconciliations: [],
      result,
    };
  }

  snapshot(): ResidentFleetTopology {
    return structuredClone(this.topology);
  }

  private enqueueDiscovery(
    endpoints: SurfAceDiscoveryEndpoint[],
  ): Promise<void> {
    const next = this.transition.then(async () => {
      await this.reconcileDiscovery(endpoints);
    });
    this.transition = next.catch((error) => {
      this.logger.error?.(
        `[surf-ace:resident-controller] discovery reconcile failed: ${String(error)}`,
      );
    });
    return next;
  }

  private async reconcileDiscovery(
    endpoints: SurfAceDiscoveryEndpoint[],
  ): Promise<void> {
    const discoveredKeys = new Set<string>();
    for (const endpoint of endpoints) {
      const stableKey = endpointStableKey(endpoint);
      discoveredKeys.add(stableKey);
      const previous = this.topology.endpoints[stableKey];
      this.topology.endpoints[stableKey] = {
        discovered: true,
        endpointId: endpoint.endpointId,
        fingerprintPrefix: endpoint.fingerprintPrefix,
        host: endpoint.host,
        instanceName: endpoint.instanceName,
        lastError: previous?.lastError ?? null,
        lastSeenAt: endpoint.lastSeenAt,
        name: endpoint.name,
        panesListedAt: previous?.panesListedAt ?? null,
        port: endpoint.port,
        stableKey,
        surfaces: previous?.surfaces ?? [],
        wsPath: endpoint.wsPath,
      };
      await this.connectEndpoint(stableKey, endpoint);
    }
    for (const [stableKey, endpoint] of Object.entries(this.topology.endpoints)) {
      if (!discoveredKeys.has(stableKey)) {
        endpoint.discovered = false;
      }
    }
    await this.topologyStore.save(this.topology);
  }

  private async connectEndpoint(
    stableKey: string,
    endpoint: SurfAceDiscoveryEndpoint,
  ): Promise<void> {
    const url = endpointUrl(endpoint);
    const current = this.active.get(stableKey);
    if (current?.url === url) {
      await this.refreshEndpoint(stableKey, current.controller);
      return;
    }
    if (current) {
      await current.controller.stop();
      this.active.delete(stableKey);
    }
    const controller = this.createEndpointController(endpoint, stableKey);
    try {
      await controller.start();
      this.active.set(stableKey, { controller, url });
      await this.refreshEndpoint(stableKey, controller);
    } catch (error) {
      await controller.stop().catch(() => {});
      const durable = this.topology.endpoints[stableKey];
      if (durable) {
        durable.lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  private async refreshEndpoint(
    stableKey: string,
    controller: ResidentEndpointController,
  ): Promise<void> {
    const listed = asRecord(await controller.listSurfaces());
    const surfaces = Array.isArray(listed.surfaces) ? listed.surfaces : [];
    const complete: Array<Record<string, unknown>> = [];
    for (const surface of surfaces) {
      const id = surfaceId(surface);
      if (!id) {
        throw new Error("surfaces_list_missing_surface_id");
      }
      const panes = await controller.requestSurface(id, "panes.list", {});
      complete.push({ ...asRecord(surface), panes: asRecord(panes) });
    }
    const durable = this.topology.endpoints[stableKey];
    if (!durable) {
      throw new Error(`missing_durable_endpoint:${stableKey}`);
    }
    durable.lastError = null;
    durable.panesListedAt = this.now();
    durable.surfaces = complete;
    await this.topologyStore.save(this.topology);
  }

  private controllerForSurface(surface: string): ResidentEndpointController {
    for (const [stableKey, endpoint] of Object.entries(this.topology.endpoints)) {
      if (!endpoint.surfaces.some((candidate) => surfaceId(candidate) === surface)) {
        continue;
      }
      const active = this.active.get(stableKey);
      if (!active) {
        throw new Error(`surface_controller_disconnected:${surface}`);
      }
      return active.controller;
    }
    throw new Error(`unknown_surface:${surface}`);
  }

  private lifecycleController(
    input: Record<string, unknown>,
  ): ResidentEndpointController {
    const endpointId = input.endpointId;
    if (typeof endpointId === "string") {
      for (const [stableKey, endpoint] of Object.entries(this.topology.endpoints)) {
        if (endpoint.endpointId === endpointId || stableKey === endpointId) {
          const active = this.active.get(stableKey);
          if (!active) {
            throw new Error(`endpoint_controller_disconnected:${endpointId}`);
          }
          return active.controller;
        }
      }
      throw new Error(`unknown_endpoint:${endpointId}`);
    }
    if (this.active.size !== 1) {
      throw new Error("endpoint_id_required");
    }
    return this.active.values().next().value!.controller;
  }

  private async dispatch(
    command: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (command === "list") {
      await this.discovery.refreshNow();
      await this.transition;
      const topology = this.snapshot();
      return {
        endpoints: Object.values(topology.endpoints),
        surfaces: Object.values(topology.endpoints).flatMap((endpoint) =>
          endpoint.surfaces.map((surface) => ({
            ...surface,
            controllerEndpointId: endpoint.endpointId,
            controllerEndpointStableKey: endpoint.stableKey,
            discovered: endpoint.discovered,
          }))
        ),
      };
    }
    if (command === "read") {
      const scopeId = requiredString(input, "scopeId") as LocklessScopeId;
      const match = scopeId.match(/^(?:surface|pane):([^:]+)/);
      if (!match?.[1]) {
        throw new Error("invalid_input:scopeId");
      }
      return await this.controllerForSurface(decodeURIComponent(match[1]))
        .readLocal(scopeId);
    }
    if (command === "surface-intent") {
      const action = requiredString(input, "action");
      if (action === "open") {
        return await this.lifecycleController(input).openSurface(
          without(input, ["action", "endpointId"]) as LocklessSurfaceOpenIntent,
        );
      }
      if (action === "restore") {
        return await this.lifecycleController(input).restoreSurface(
          requiredString(input, "tombstoneId"),
          without(input, ["action", "endpointId", "tombstoneId"]) as Omit<
            LocklessSurfaceRestoreIntent,
            "tombstoneId"
          >,
        );
      }
      const surface = requiredString(input, "surfaceId");
      return await this.controllerForSurface(surface).closeSurface(
        surface,
        without(input, ["action", "surfaceId"]) as Omit<
          LocklessSurfaceCloseIntent,
          "surfaceId"
        >,
      );
    }
    const surface = requiredString(input, "surfaceId");
    const controller = this.controllerForSurface(surface);
    switch (command) {
      case "push":
        return await controller.push(
          surface,
          without(input, ["surfaceId"]) as unknown as LocklessContentPush,
        );
      case "topology-intent":
        return await this.topologyIntent(controller, surface, input);
      case "topology-realize":
        return await controller.requestSurface(
          surface,
          "topology.apply",
          without(input, ["surfaceId"]),
        );
      case "clear":
        return await controller.requestSurface(
          surface,
          "content.clear",
          without(input, ["surfaceId"]),
        );
      case "annotations-remove":
        return await controller.requestSurface(
          surface,
          "annotations.remove",
          without(input, ["surfaceId"]),
        );
      case "capture-pane":
        return await controller.requestSurface(
          surface,
          "snapshot.get",
          without(input, ["surfaceId"]),
        );
      case "target-register":
        return await controller.requestSurface(
          surface,
          "target.register",
          withoutLegacyOwnership(input),
        );
      case "target-apply":
        return await controller.requestSurface(
          surface,
          "target.apply",
          withoutLegacyOwnership(input),
        );
      default:
        throw new Error(`unknown_controller_command:${command}`);
    }
  }

  private async topologyIntent(
    controller: ResidentEndpointController,
    surface: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const expectedTopologyRevision = requiredInteger(
      input,
      "expectedTopologyRevision",
    );
    switch (requiredString(input, "action")) {
      case "split":
        return await controller.splitPane(surface, {
          count: requiredInteger(input, "count"),
          direction: requiredDirection(input.direction),
          expectedTopologyRevision,
          paneId: requiredInteger(input, "paneId"),
        });
      case "close":
        return await controller.closePane(surface, {
          expectedTopologyRevision,
          paneId: requiredInteger(input, "paneId"),
        });
      case "restore":
        return await controller.restorePane(surface, {
          anchorPaneId: requiredInteger(input, "anchorPaneId"),
          direction: requiredDirection(input.direction),
          expectedTopologyRevision,
          tombstoneId: requiredString(input, "tombstoneId"),
        });
      case "rename":
        return await controller.requestSurface(surface, "pane.rename", {
          expectedTopologyRevision,
          name: input.name,
          paneId: requiredInteger(input, "paneId"),
        });
      default:
        throw new Error("invalid_topology_action");
    }
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`invalid_input:${key}`);
  }
  return value[key] as string;
}

function requiredInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  if (!Number.isSafeInteger(value[key])) {
    throw new Error(`invalid_input:${key}`);
  }
  return value[key] as number;
}

function requiredDirection(value: unknown): "horizontal" | "vertical" {
  if (value !== "horizontal" && value !== "vertical") {
    throw new Error("invalid_input:direction");
  }
  return value;
}

function withoutLegacyOwnership(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return without(value, [
    "connectionId",
    "ownershipEpoch",
    "ownershipSessionId",
    "providerId",
    "surfaceId",
  ]);
}
