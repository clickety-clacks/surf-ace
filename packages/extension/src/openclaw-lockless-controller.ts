import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  BoundedControllerProjection,
  type ControllerStateStore,
  type ControllerWire,
  ControllerIdentity,
  FileControllerStateStore,
  MultiSurfaceController,
  PublicControllerWireClient,
} from "@surf-ace/controller";
import {
  locklessPaneScopeId,
  SURF_ACE_LOCKLESS_V1_CAPABILITY,
} from "@surf-ace/protocol";

import {
  createBonjourSurfAceDiscoveryService,
  type SurfAceDiscoveryEndpoint,
  type SurfAceDiscoveryService,
  type SurfAceLogger,
} from "./surf-ace-discovery.js";
import type {
  PaneId,
  SurfAceAnnotateRemoveInput,
  SurfAceAnnotateRemoveResult,
  SurfAceClearResult,
  SurfAceClosePaneResult,
  SurfAceLaunchNativeAppInput,
  SurfAcePaneCaptureResult,
  SurfAcePushInput,
  SurfAcePushResult,
  SurfAceReadResult,
  SurfAceRealizeTopologyInput,
  SurfAceRealizeTopologyResult,
  SurfAceRealizeTopologiesInput,
  SurfAceRealizeTopologiesResult,
  SurfAceReattemptConnectionsInput,
  SurfAceReattemptConnectionsResult,
  SurfAceScreenSummary,
  SurfAceSessionContext,
  SurfAceSnapshotResult,
  SurfAceTargetRegisterInput,
  SurfAceTargetRegisterResult,
  SurfAceTargetRestoreResult,
  SurfAceSplitInput,
  SurfAceSplitResult,
} from "./surf-ace-runtime.js";

type LocklessEndpoint = {
  controller: MultiSurfaceController;
  endpoint: SurfAceDiscoveryEndpoint;
  screens: SurfAceScreenSummary[];
};

type EndpointMode = "legacy" | "lockless" | "probing";

function endpointStateKey(endpoint: SurfAceDiscoveryEndpoint): string {
  return createHash("sha256").update(endpoint.endpointId).digest("hex").slice(0, 16);
}

function endpointUrl(endpoint: SurfAceDiscoveryEndpoint): string {
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `ws://${host}:${endpoint.port}${endpoint.wsPath}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function locklessContentPayload(input: SurfAcePushInput): unknown {
  switch (input.contentType) {
    case "html":
      return { html: input.content };
    case "markdown":
      return { markdown: input.content };
    case "pdf":
      return { data: input.content };
    case "image":
      return { data: input.content, mediaType: "image/png" };
    case "terminal":
      return { lines: input.content.split("\n"), scrollback: 0 };
    case "browser_url":
      return { url: input.content };
    case "canvas":
      if (!input.content.trim()) {
        return "";
      }
      try {
        return JSON.parse(input.content) as unknown;
      } catch {
        return "";
      }
    default:
      return input.content;
  }
}

export function advertisesLocklessCapability(payload: unknown): boolean {
  const capabilities = asRecord(asRecord(payload).capabilities);
  const features = Array.isArray(capabilities.protocolFeatures)
    ? capabilities.protocolFeatures
    : [];
  return features.includes(SURF_ACE_LOCKLESS_V1_CAPABILITY);
}

export class OpenClawLocklessController {
  private readonly discovery: SurfAceDiscoveryService;
  private readonly alertedScopes = new Set<string>();
  private readonly endpointModes = new Map<string, EndpointMode>();
  private readonly endpoints = new Map<string, LocklessEndpoint>();
  private readonly identity: ControllerIdentity;
  private readonly legacyListeners =
    new Set<(endpoints: SurfAceDiscoveryEndpoint[]) => void>();
  private reconcileWork: Promise<void> = Promise.resolve();
  private started = false;
  private unsubscribeDiscovery: (() => void) | null = null;

  constructor(private readonly options: {
    discovery?: SurfAceDiscoveryService;
    logger?: SurfAceLogger;
    projectionCapacityBytes?: number;
    stateDir: string;
    storeFactory?: (filePath: string) => ControllerStateStore;
    wireFactory?: (url: string) => ControllerWire;
    alertDelivery?: (message: string) => Promise<void>;
  }) {
    this.discovery = options.discovery ??
      createBonjourSurfAceDiscoveryService({ logger: options.logger });
    this.identity = new ControllerIdentity(
      this.options.storeFactory?.(
        path.join(options.stateDir, "lockless-controller-identity.json"),
      ) ?? new FileControllerStateStore(
        path.join(options.stateDir, "lockless-controller-identity.json"),
      ),
    );
  }

  legacyDiscovery(): SurfAceDiscoveryService {
    return {
      getSnapshot: () => this.legacySnapshot(),
      refreshNow: async () => await this.discovery.refreshNow(),
      start: async () => await this.start(),
      stop: async () => {},
      subscribe: (listener) => {
        this.legacyListeners.add(listener);
        listener(this.legacySnapshot());
        return () => this.legacyListeners.delete(listener);
      },
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubscribeDiscovery = this.discovery.subscribe((endpoints) => {
      this.reconcileWork = this.reconcileWork.then(async () => {
        await this.reconcile(endpoints);
      });
    });
    await this.discovery.start();
    this.reconcileWork = this.reconcileWork.then(async () => {
      await this.reconcile(this.discovery.getSnapshot());
    });
    await this.reconcileWork;
  }

  async stop(): Promise<void> {
    this.unsubscribeDiscovery?.();
    this.unsubscribeDiscovery = null;
    await this.reconcileWork;
    await Promise.all(
      [...this.endpoints.values()].map(async (endpoint) => {
        await endpoint.controller.stop();
      }),
    );
    this.endpoints.clear();
    await this.discovery.stop();
    this.started = false;
  }

  hasFingerprint(fingerprint: string): boolean {
    return this.findScreen(fingerprint) !== null;
  }

  hasEndpoint(endpointId: string): boolean {
    return this.endpoints.has(endpointId);
  }

  async listScreens(): Promise<SurfAceScreenSummary[]> {
    await Promise.all(
      [...this.endpoints.values()].map(async (endpoint) => {
        endpoint.screens = await this.loadScreens(endpoint);
      }),
    );
    return [...this.endpoints.values()].flatMap((endpoint) =>
      structuredClone(endpoint.screens)
    );
  }

  async reattemptConnections(
    input?: SurfAceReattemptConnectionsInput,
  ): Promise<SurfAceReattemptConnectionsResult> {
    const selected = [...this.endpoints.values()].filter((endpoint) =>
      !input?.fingerprint ||
      endpoint.screens.some((screen) =>
        screen.fingerprint === input.fingerprint
      )
    );
    await Promise.all(selected.map(async (endpoint) => {
      await endpoint.controller.refreshSurfaceSessions();
      endpoint.screens = await this.loadScreens(endpoint);
    }));
    return {
      endpointProbes: selected.map((endpoint) => ({
        circuitState: "closed",
        endpointId: endpoint.endpoint.endpointId,
        name: endpoint.endpoint.name,
      })),
      surfaces: selected.flatMap((endpoint) =>
        endpoint.screens.map((screen) => ({
          circuitState: "closed" as const,
          fingerprint: screen.fingerprint,
          name: screen.name,
          windowLabel: screen.windowLabel,
        }))
      ),
    };
  }

  async push(
    input: SurfAcePushInput,
    context?: SurfAceSessionContext,
  ): Promise<SurfAcePushResult> {
    const resolved = this.requireSurface(input.fingerprint);
    const paneId = Number(input.paneId);
    const response = asRecord(await resolved.endpoint.controller.push(
      resolved.surfaceId,
      {
        content: locklessContentPayload(input),
        contentId: `ct_${randomUUID().replaceAll("-", "")}`,
        contentType: input.contentType,
        friendlyChatName:
          context?.displayName ??
          context?.sessionDisplayName ??
          context?.streamLabel,
        paneId,
      },
    ));
    await this.refreshEndpoint(resolved.endpoint);
    const screen = this.requireSurface(input.fingerprint).screen;
    const pane = screen.panes.find((candidate) =>
      Number(candidate.paneId) === paneId
    );
    return {
      contentId: stringValue(response.contentId),
      displayId: pane?.displayId ?? `${screen.fingerprint}:${paneId}`,
      fingerprint: screen.fingerprint,
      paneAddress: pane?.paneAddress ?? `${screen.fingerprint}:${paneId}`,
      paneId: (pane?.paneId ?? String(paneId)) as PaneId,
      paneLabel: pane?.paneLabel ?? paneId,
      revision: numberValue(response.revision),
      operationReceipt: response.operationReceipt as never,
    };
  }

  async read(input: {
    fingerprint: string;
    paneId: PaneId;
  }): Promise<SurfAceReadResult> {
    const resolved = this.requireSurface(input.fingerprint);
    const scopeId = locklessPaneScopeId(
      resolved.surfaceId,
      Number(input.paneId),
    );
    const local = await resolved.endpoint.controller.readLocal(scopeId);
    const pane = this.requirePane(resolved.screen, input.paneId);
    const readAt = Date.now();
    const projected = projectConsumableRecords(
      local.records,
      pane,
      input.fingerprint,
      readAt,
    );
    return {
      browserUrl: null,
      contentSnapshot: projected.contentSnapshot,
      displayId: pane.displayId,
      fingerprint: input.fingerprint,
      frames: projected.frames,
      lastNavigation: projected.lastNavigation,
      liveDirtyStrokeIds: projected.liveDirtyStrokeIds,
      liveFrame: projected.liveFrame,
      liveSeq: projected.liveSeq,
      page: projected.page,
      paneAddress: pane.paneAddress,
      paneId: pane.paneId,
      paneLabel: pane.paneLabel,
      pendingFrames: local.records.length,
      playbackPosition: projected.playbackPosition,
      playbackState: projected.playbackState,
      readAt,
      acknowledgementPending: local.acknowledgement !== null,
      cacheStatus: local.cacheStatus,
      consumableGap: local.gap,
      consumableLoss: local.consumableLoss,
      consumableRecords: local.records,
      repairScheduled: local.repairScheduled,
      scrollPosition: projected.scrollPosition,
      selection: projected.selection,
      taps: projected.taps,
      windowLabel: resolved.screen.windowLabel,
    };
  }

  async split(input: SurfAceSplitInput): Promise<SurfAceSplitResult> {
    const resolved = this.requireSurface(input.fingerprint);
    const expectedTopologyRevision = input.expectedTopologyRevision;
    if (!Number.isSafeInteger(expectedTopologyRevision)) {
      throw new Error("expectedTopologyRevision is required in lockless mode");
    }
    const response = asRecord(await resolved.endpoint.controller.splitPane(
      resolved.surfaceId,
      {
        count: input.count,
        direction: input.direction ?? "vertical",
        expectedTopologyRevision: expectedTopologyRevision!,
        paneId: Number(input.paneId),
      },
    ));
    await this.refreshEndpoint(resolved.endpoint);
    const panes = Array.isArray(response.panes) ? response.panes : [];
    return panes.map((value) => {
      const pane = asRecord(value);
      const paneId = String(pane.paneId) as PaneId;
      const paneLabel = numberValue(pane.paneLabel, Number(pane.paneId));
      return {
        displayId: `${input.fingerprint}:${paneId}`,
        paneAddress: `${input.fingerprint}:${paneId}`,
        paneId,
        paneLabel,
        operationReceipt: response.operationReceipt as never,
      };
    });
  }

  async realizeTopology(
    input: SurfAceRealizeTopologyInput,
  ): Promise<SurfAceRealizeTopologyResult> {
    const resolved = this.requireSurface(input.fingerprint);
    const response = asRecord(
      await resolved.endpoint.controller.requestSurface(
        resolved.surfaceId,
        "topology.apply",
        {
          allowDestroyPaneIds: input.allowDestroyPaneIds.map(Number),
          desired: input.desired,
          expectedTopologyRevision: input.expectedTopologyRevision,
          target: input.target.root
            ? { root: true }
            : { paneId: Number(input.target.paneId) },
        },
      ),
    );
    await this.refreshEndpoint(resolved.endpoint);
    return {
      createdPaneIds: Array.isArray(response.createdPaneIds)
        ? response.createdPaneIds.map(String) as PaneId[]
        : [],
      destroyedPaneIds: Array.isArray(response.destroyedPaneIds)
        ? response.destroyedPaneIds.map(String) as PaneId[]
        : [],
      destroyedPaneTombstones: Array.isArray(
        response.destroyedPaneTombstones,
      )
        ? response.destroyedPaneTombstones.map((value) => {
            const tombstone = asRecord(value);
            return {
              closedSequence: numberValue(tombstone.closedSequence),
              paneId: String(tombstone.paneId) as PaneId,
              tombstoneId: stringValue(tombstone.tombstoneId),
            };
          })
        : [],
      ok: true,
      panes: Array.isArray(response.panes)
        ? response.panes.map((value) => {
            const pane = asRecord(value);
            const paneId = String(pane.paneId) as PaneId;
            return {
              activeContentId: typeof pane.activeContentId === "string"
                ? pane.activeContentId
                : null,
              contentType: (pane.contentType ?? null) as never,
              displayId: `${input.fingerprint}:${paneId}`,
              name: typeof pane.name === "string" ? pane.name : null,
              paneAddress: `${input.fingerprint}:${paneId}`,
              paneId,
              paneLabel: numberValue(pane.paneLabel),
            };
          })
        : [],
      preservedPaneIds: Array.isArray(response.preservedPaneIds)
        ? response.preservedPaneIds.map(String) as PaneId[]
        : [],
      target: input.target,
      topology: response.topology as never,
      topologyRevision: numberValue(response.topologyRevision),
      operationReceipt: response.operationReceipt as never,
    };
  }

  async realizeTopologies(
    input: SurfAceRealizeTopologiesInput,
  ): Promise<SurfAceRealizeTopologiesResult> {
    const applied: any[] = [];
    for (const [index, operation] of input.operations.entries()) {
      try {
        if ("action" in operation) {
          if (operation.action === "openWindow") {
            const endpoint = this.endpoints.get(operation.fingerprint);
            if (!endpoint) throw new Error("Unknown Surf Ace endpoint");
            const listed = asRecord(await endpoint.controller.listSurfaces());
            const result = asRecord(await endpoint.controller.openSurface({
              expectedSurfaceSetRevision: numberValue(
                listed.surfaceSetRevision,
              ),
            }));
            applied.push({
              accepted: true,
              action: "openWindow",
              fingerprint: operation.fingerprint,
              openedSurfaceId: stringValue(result.surfaceId),
              operationId: operation.operationId,
              windowLabel: operation.windowLabel ?? "",
            });
          } else {
            const resolved = this.requireSurface(operation.fingerprint);
            const listed = asRecord(
              await resolved.endpoint.controller.listSurfaces(),
            );
            const result = asRecord(
              await resolved.endpoint.controller.closeSurface(
                resolved.surfaceId,
                {
                  expectedSurfaceSetRevision: numberValue(
                    listed.surfaceSetRevision,
                  ),
                  expectedTopologyRevision:
                    resolved.screen.topologyRevision,
                },
              ),
            );
            applied.push({
              action: "closeWindow",
              closed: true,
              fingerprint: operation.fingerprint,
              operationId: operation.operationId,
              operationReceipt: result.operationReceipt,
              windowLabel:
                operation.windowLabel ?? resolved.screen.windowLabel,
            });
          }
        } else {
          const result = await this.realizeTopology(operation);
          applied.push({
            ...result,
            action: "realizeTopology",
            fingerprint: operation.fingerprint,
            operationId: operation.operationId,
            windowLabel: operation.windowLabel ??
              this.requireSurface(operation.fingerprint).screen.windowLabel,
          });
        }
      } catch (error) {
        const staleTopology = String(error).includes("stale_topology");
        let message = String(error);
        if (staleTopology && this.hasFingerprint(operation.fingerprint)) {
          const resolved = this.requireSurface(operation.fingerprint);
          await this.refreshEndpoint(resolved.endpoint);
          const current = this.requireSurface(operation.fingerprint).screen;
          message = `${message}; authoritative topology is ${
            JSON.stringify({
              currentTopology: current.topology,
              currentTopologyRevision: current.topologyRevision,
            })
          }; recompute the intent and submit a new request`;
        }
        return {
          applied,
          failed: {
            code: staleTopology ? "stale_topology" : "operation_failed",
            fingerprint: operation.fingerprint,
            index,
            message,
            operationId: operation.operationId,
            windowLabel: operation.windowLabel,
          },
          ok: false,
          skipped: input.operations.slice(index + 1).map((skipped, offset) => ({
            fingerprint: skipped.fingerprint,
            index: index + offset + 1,
            operationId: skipped.operationId,
            windowLabel: skipped.windowLabel,
          })),
        };
      }
    }
    return { applied, ok: true };
  }

  async registerTarget(
    input: SurfAceTargetRegisterInput,
  ): Promise<SurfAceTargetRegisterResult> {
    const resolved = this.requireSurface(input.fingerprint);
    const response = asRecord(
      await resolved.endpoint.controller.requestSurface(
        resolved.surfaceId,
        "target.register",
        {
          expectedPreviousTargetEpoch: input.expectedPreviousTargetEpoch,
          idempotencyKey: input.idempotencyKey,
          launchedAt: input.launchedAt ?? new Date().toISOString(),
          paneId: Number(input.paneId),
          paneLineageId: input.paneLineageId,
          registrationState: input.registrationState,
          restorePolicy: input.restorePolicy,
          targetHeader: input.targetHeader,
          targetKind: input.targetKind,
          targetPayload: input.targetPayload,
        },
      ),
    );
    const target = asRecord(response.target);
    return {
      idempotencyKey: input.idempotencyKey,
      status: "registered",
      targetEpoch: numberValue(target.targetEpoch),
      targetId: stringValue(target.targetId),
    };
  }

  async restoreTarget(input: {
    confirmed?: boolean;
    fingerprint: string;
    paneId: PaneId;
    targetId?: string;
  }): Promise<SurfAceTargetRestoreResult> {
    const resolved = this.requireSurface(input.fingerprint);
    const session = resolved.endpoint.controller.surfaceSession(
      resolved.surfaceId,
    );
    const listed = asRecord(await session.requestPublic("panes.list", {
      surfaceId: resolved.surfaceId,
    }));
    const pane = (Array.isArray(listed.panes) ? listed.panes : [])
      .map(asRecord)
      .find((candidate) =>
        Number(candidate.paneId) === Number(input.paneId)
      );
    const target = asRecord(pane?.currentTarget);
    const targetId = input.targetId ?? stringValue(target.targetId);
    const evidence = asRecord(await session.requestPublic("target.apply", {
      paneId: Number(input.paneId),
      paneLineageId: pane?.paneLineageId,
      requestId: `target_apply_${randomUUID()}`,
      restoreReason: "explicit_request",
      surfaceId: resolved.surfaceId,
      targetEpoch: numberValue(target.targetEpoch),
      targetHeader: target.targetHeader,
      targetId,
      targetKind: target.targetKind,
      targetPayload: target.targetPayload,
    }));
    return {
      blockedReason: (evidence.blockedReason ?? null) as never,
      evidence: evidence as never,
      targetId,
    };
  }

  async clear(input: {
    fingerprint: string;
    paneId: PaneId;
  }): Promise<SurfAceClearResult> {
    const resolved = this.requireSurface(input.fingerprint);
    const pane = this.requirePane(resolved.screen, input.paneId);
    const response = asRecord(await resolved.endpoint.controller
      .surfaceSession(resolved.surfaceId).requestPublic(
      "content.clear",
      {
        expectedRevision: pane.activeContent?.revision ?? 0,
        paneId: Number(input.paneId),
        surfaceId: resolved.surfaceId,
      },
    ));
    await this.refreshEndpoint(resolved.endpoint);
    return {
      displayId: pane.displayId,
      fingerprint: input.fingerprint,
      paneAddress: pane.paneAddress,
      paneId: input.paneId,
      paneLabel: pane.paneLabel,
      revision: numberValue(
        response.currentRevision,
        numberValue(response.revision),
      ),
      operationReceipt: response.operationReceipt as never,
    };
  }

  async launchNativeApp(
    input: SurfAceLaunchNativeAppInput,
  ): Promise<SurfAcePushResult> {
    if (input.confirmed !== true) {
      throw new Error("confirmed:true is required for native app launch");
    }
    const resolved = this.requireSurface(input.fingerprint);
    const session = resolved.endpoint.controller.surfaceSession(
      resolved.surfaceId,
    );
    const panes = asRecord(await session.requestPublic("panes.list", {
      surfaceId: resolved.surfaceId,
    }));
    const pane = (Array.isArray(panes.panes) ? panes.panes : [])
      .map(asRecord)
      .find((candidate) =>
        Number(candidate.paneId) === Number(input.paneId)
      );
    if (!pane || typeof pane.paneLineageId !== "string") {
      throw new Error("lockless pane lineage is unavailable");
    }
    const currentTarget = asRecord(pane.currentTarget);
    const targetHeader = {
      payloadSchemaVersion: 1,
      replaySemantics: "launch_equivalent",
      requiredCapabilities: ["target.native_app.v1"],
      safeToLogFields: ["appId", "args", "cwd", "launchMode"],
      safetyClass: "process",
      summary: input.summary?.trim() ||
        [input.appId, ...(input.args ?? [])].join(" "),
    };
    const targetPayload = {
      appId: input.appId,
      args: input.args ?? [],
      cwd: input.cwd,
      env: input.env,
      launchMode: input.launchMode ?? "new_instance",
    };
    const idempotencyKey = input.idempotencyKey ??
      `native_app:${resolved.surfaceId}:${input.paneId}:${input.appId}:${JSON.stringify(targetPayload)}`;
    const registered = asRecord(
      await session.requestPublic("target.register", {
        expectedPreviousTargetEpoch:
          typeof currentTarget.targetEpoch === "number"
            ? currentTarget.targetEpoch
            : null,
        idempotencyKey,
        launchedAt: new Date().toISOString(),
        paneId: Number(input.paneId),
        paneLineageId: pane.paneLineageId,
        registrationState: "attached",
        restorePolicy: "manual",
        surfaceId: resolved.surfaceId,
        targetHeader,
        targetKind: "native_app",
        targetPayload,
      }),
    );
    const target = asRecord(registered.target);
    const targetId = stringValue(target.targetId);
    const targetEpoch = numberValue(target.targetEpoch);
    const applied = asRecord(await session.requestPublic("target.apply", {
      paneId: Number(input.paneId),
      paneLineageId: pane.paneLineageId,
      requestId: `target_apply_${randomUUID()}`,
      restoreReason: "explicit_request",
      surfaceId: resolved.surfaceId,
      targetEpoch,
      targetHeader,
      targetId,
      targetKind: "native_app",
      targetPayload,
    }));
    const summary = this.requirePane(resolved.screen, input.paneId);
    return {
      blockedReason: (applied.blockedReason ?? null) as never,
      contentId: null,
      displayId: summary.displayId,
      fingerprint: input.fingerprint,
      operationReceipt: applied.operationReceipt as never,
      paneAddress: summary.paneAddress,
      paneId: input.paneId,
      paneLabel: summary.paneLabel,
      revision: summary.activeContent?.revision ?? 0,
      targetApplyEvidence: applied as never,
      targetId,
      targetKind: "native_app",
    };
  }

  async annotateRemove(
    input: SurfAceAnnotateRemoveInput,
  ): Promise<SurfAceAnnotateRemoveResult> {
    const resolved = this.requireSurface(input.fingerprint);
    const pane = this.requirePane(resolved.screen, input.paneId);
    const response = asRecord(await resolved.endpoint.controller
      .surfaceSession(resolved.surfaceId).requestPublic(
      "annotations.remove",
      {
        contentId: input.contentId,
        paneId: Number(input.paneId),
        strokeIds: input.strokeIds,
        surfaceId: resolved.surfaceId,
      },
    ));
    return {
      displayId: pane.displayId,
      fingerprint: input.fingerprint,
      notFoundStrokeIds: Array.isArray(response.notFoundStrokeIds)
        ? response.notFoundStrokeIds.map(String)
        : [],
      paneAddress: pane.paneAddress,
      paneId: input.paneId,
      paneLabel: pane.paneLabel,
      remainingStrokeCount: numberValue(response.remainingStrokeCount),
      removedStrokeIds: Array.isArray(response.removedStrokeIds)
        ? response.removedStrokeIds.map(String)
        : [],
      operationReceipt: response.operationReceipt as never,
    };
  }

  async snapshot(input: {
    fingerprint: string;
    paneId: PaneId;
  }): Promise<SurfAceSnapshotResult> {
    return await this.snapshotWithOptions(input, {
      includeDrawings: true,
      includeVisibleText: true,
    });
  }

  async capturePane(input: {
    fingerprint: string;
    paneId: PaneId;
  }): Promise<SurfAcePaneCaptureResult> {
    const capturedAt = Date.now();
    const result = await this.snapshotWithOptions(input, {
      includeDrawings: true,
      includeImage: true,
      includeVisibleText: true,
    });
    const pane = this.requirePane(
      this.requireSurface(input.fingerprint).screen,
      input.paneId,
    );
    const snapshot = result.snapshot;
    const visibleRect = asRecord(snapshot?.viewport?.visibleRect);
    return {
      capture: {
        browserUrl: null,
        bytesBase64: snapshot?.image ?? null,
        capturedAt,
        contentType: snapshot?.contentType ?? null,
        dimensions: {
          height: numberValue(visibleRect.height, pane.viewport.height),
          width: numberValue(visibleRect.width, pane.viewport.width),
        },
        displayId: pane.displayId,
        failureReason: snapshot?.image ? null : "client returned no rendered image for pane capture",
        fingerprint: input.fingerprint,
        paneAddress: pane.paneAddress,
        paneId: input.paneId,
        paneLabel: pane.paneLabel,
        scale: pane.viewport.scale,
        topologyRevision: this.requireSurface(input.fingerprint).screen
          .topologyRevision,
        visibleContentId: (snapshot?.contentId ?? null) as never,
        windowLabel: result.windowLabel,
      },
      operationReceipt: result.operationReceipt,
    };
  }

  async closePane(input: {
    expectedTopologyRevision?: number;
    fingerprint: string;
    paneId: PaneId;
  }): Promise<SurfAceClosePaneResult> {
    const resolved = this.requireSurface(input.fingerprint);
    if (!Number.isSafeInteger(input.expectedTopologyRevision)) {
      throw new Error("expectedTopologyRevision is required in lockless mode");
    }
    const pane = this.requirePane(resolved.screen, input.paneId);
    const response = asRecord(await resolved.endpoint.controller.closePane(
      resolved.surfaceId,
      {
        expectedTopologyRevision: input.expectedTopologyRevision!,
        paneId: Number(input.paneId),
      },
    ));
    await this.refreshEndpoint(resolved.endpoint);
    return {
      displayId: pane.displayId,
      ok: true,
      paneAddress: pane.paneAddress,
      paneId: pane.paneId,
      paneLabel: pane.paneLabel,
      operationReceipt: response.operationReceipt as never,
    };
  }

  async renamePane(input: {
    expectedTopologyRevision: number;
    fingerprint: string;
    name: string | null;
    paneId: PaneId;
  }): Promise<unknown> {
    const resolved = this.requireSurface(input.fingerprint);
    return await resolved.endpoint.controller.requestSurface(
      resolved.surfaceId,
      "pane.rename",
      {
        expectedTopologyRevision: input.expectedTopologyRevision,
        name: input.name,
        paneId: Number(input.paneId),
      },
    );
  }

  async restorePane(input: {
    anchorPaneId: PaneId;
    direction: "horizontal" | "vertical";
    expectedTopologyRevision: number;
    fingerprint: string;
    tombstoneId: string;
  }): Promise<unknown> {
    const resolved = this.requireSurface(input.fingerprint);
    return await resolved.endpoint.controller.restorePane(
      resolved.surfaceId,
      {
        anchorPaneId: Number(input.anchorPaneId),
        direction: input.direction,
        expectedTopologyRevision: input.expectedTopologyRevision,
        tombstoneId: input.tombstoneId,
      },
    );
  }

  async surfaceIntent(
    input: Record<string, unknown> & {
      action: "open" | "close" | "restore";
    },
  ): Promise<unknown> {
    if (input.action === "open") {
      const endpoint = this.endpoints.get(stringValue(input.endpointId));
      if (!endpoint) throw new Error("No lockless Surf Ace endpoint");
      return await endpoint.controller.openSurface({
        expectedSurfaceSetRevision: numberValue(
          input.expectedSurfaceSetRevision,
        ),
        placement: asRecord(input.placement),
      });
    }
    if (input.action === "restore") {
      const endpoint = this.endpoints.get(stringValue(input.endpointId));
      if (!endpoint) throw new Error("No lockless Surf Ace endpoint");
      return await endpoint.controller.restoreSurface(
        stringValue(input.tombstoneId),
        {
          expectedSurfaceSetRevision: numberValue(
            input.expectedSurfaceSetRevision,
          ),
          placement: asRecord(input.placement),
        },
      );
    }
    const resolved = this.requireSurface(stringValue(input.fingerprint));
    return await resolved.endpoint.controller.closeSurface(
      resolved.surfaceId,
      {
        expectedSurfaceSetRevision: numberValue(
          input.expectedSurfaceSetRevision,
        ),
        expectedTopologyRevision: numberValue(
          input.expectedTopologyRevision,
        ),
      },
    );
  }

  private async reconcile(endpoints: SurfAceDiscoveryEndpoint[]): Promise<void> {
    const liveIds = new Set(endpoints.map((endpoint) => endpoint.endpointId));
    for (const [endpointId, active] of this.endpoints) {
      if (!liveIds.has(endpointId)) {
        await active.controller.stop();
        this.endpoints.delete(endpointId);
        this.endpointModes.delete(endpointId);
      }
    }
    for (const endpoint of endpoints) {
      if (this.endpointModes.has(endpoint.endpointId)) {
        continue;
      }
      this.endpointModes.set(endpoint.endpointId, "probing");
      try {
        const stateRoot = path.join(
          this.options.stateDir,
          "lockless-endpoints",
          endpointStateKey(endpoint),
        );
        const controller = new MultiSurfaceController({
          controllerProductName: "Clawline",
          createProjection: (scopeKey) => {
            const projectionPath = path.join(
              stateRoot,
              createHash("sha256").update(scopeKey).digest("hex").slice(0, 16),
              "projection.json",
            );
            const store = this.options.storeFactory?.(projectionPath) ??
              new FileControllerStateStore(projectionPath);
            return new BoundedControllerProjection(
              store,
              this.options.projectionCapacityBytes ?? 16 * 1024 * 1024,
            );
          },
          createWire: () =>
            this.options.wireFactory?.(endpointUrl(endpoint)) ??
              new PublicControllerWireClient(endpointUrl(endpoint)),
          identity: this.identity,
          onConsumableAvailable: (_surfaceId, scopeId) => {
            void this.presentConsumableAlert(endpoint, scopeId);
          },
          onConsumableAcknowledged: (_surfaceId, scopeId) => {
            this.alertedScopes.delete(
              this.alertScopeKey(endpoint.endpointId, scopeId),
            );
          },
        });
        await controller.start();
        const active: LocklessEndpoint = {
          controller,
          endpoint,
          screens: [],
        };
        active.screens = await this.loadScreens(active);
        this.endpoints.set(endpoint.endpointId, active);
        this.endpointModes.set(endpoint.endpointId, "lockless");
      } catch (error) {
        const reason = String(error);
        this.options.logger?.info?.(
          `[surf-ace:lockless] endpoint ${endpoint.endpointId} admission failed: ${reason}`,
        );
        if (reason.includes("lockless_capability_not_advertised")) {
          this.endpointModes.set(endpoint.endpointId, "legacy");
        } else {
          this.endpointModes.delete(endpoint.endpointId);
        }
      }
    }
    this.notifyLegacyListeners();
  }

  private async loadScreens(
    endpoint: LocklessEndpoint,
  ): Promise<SurfAceScreenSummary[]> {
    const listed = asRecord(await endpoint.controller.listSurfaces());
    const surfaces = Array.isArray(listed.surfaces) ? listed.surfaces : [];
    const screens: SurfAceScreenSummary[] = [];
    for (const value of surfaces) {
      const surface = asRecord(value);
      const surfaceId = stringValue(surface.surfaceId);
      const panePayload = asRecord(
        await endpoint.controller.surfaceSession(surfaceId).requestPublic(
          "panes.list",
          { surfaceId },
        ),
      );
      const panes = Array.isArray(panePayload.panes)
        ? panePayload.panes.map((paneValue) => {
          const pane = asRecord(paneValue);
          const paneId = String(pane.paneId) as PaneId;
          const paneLabel = numberValue(pane.paneLabel, Number(pane.paneId));
          return {
            activeContent: pane.activeContentId
              ? {
                  contentId: stringValue(pane.activeContentId),
                  contentType: stringValue(pane.contentType) as never,
                  revision: numberValue(pane.currentRevision),
                }
              : null,
            displayId: stringValue(
              pane.displayId,
              `${surfaceId}:${paneId}`,
            ),
            historySummary: {
              backCount: numberValue(pane.backCount),
              forwardCount: numberValue(pane.forwardCount),
              visibleContentId: typeof pane.activeContentId === "string"
                ? pane.activeContentId
                : null,
            },
            name: typeof pane.name === "string" ? pane.name : null,
            paneAddress: stringValue(
              pane.paneAddress,
              `${surfaceId}:${paneId}`,
            ),
            paneId,
            paneLabel,
            target: null,
            viewport: asRecord(pane.viewport) as never,
          };
        })
        : [];
      screens.push({
        authority: {
          actionable: true,
          admitted: true,
          blockers: [],
          reason: null,
        },
        connectionDiagnostics: {
          circuitOpen: false,
          circuitState: "closed",
          failureCount: 0,
          givenUp: false,
          openedAt: null,
          reason: null,
          reconnectAttempt: 0,
        },
        connectionState: "connected",
        endpointId: endpoint.endpoint.endpointId,
        fingerprint: surfaceId,
        lastSeenAt: endpoint.endpoint.lastSeenAt,
        name: stringValue(surface.name, endpoint.endpoint.name),
        panes,
        pendingEvents: 0,
        topology: (asRecord(panePayload.topology).layout ?? null) as never,
        topologyRevision: numberValue(
          asRecord(panePayload.topology).topologyRevision,
        ),
        viewport: asRecord(surface.viewport) as never,
        windowLabel: stringValue(surface.windowLabel),
      });
    }
    return screens;
  }

  private async refreshEndpoint(endpoint: LocklessEndpoint): Promise<void> {
    endpoint.screens = await this.loadScreens(endpoint);
  }

  private requirePane(
    screen: SurfAceScreenSummary,
    paneId: PaneId,
  ): SurfAceScreenSummary["panes"][number] {
    const pane = screen.panes.find((candidate) =>
      String(candidate.paneId) === String(paneId)
    );
    if (!pane) {
      throw new Error(
        `Unknown lockless Surf Ace pane: ${screen.fingerprint}/${paneId}`,
      );
    }
    return pane;
  }

  private async snapshotWithOptions(
    input: { fingerprint: string; paneId: PaneId },
    options: {
      includeDrawings?: boolean;
      includeImage?: boolean;
      includeVisibleText?: boolean;
    },
  ): Promise<SurfAceSnapshotResult> {
    const resolved = this.requireSurface(input.fingerprint);
    const pane = this.requirePane(resolved.screen, input.paneId);
    const response = asRecord(
      await resolved.endpoint.controller.surfaceSession(
        resolved.surfaceId,
      ).requestPublic("snapshot.get", {
        ...options,
        paneId: Number(input.paneId),
        surfaceId: resolved.surfaceId,
      }),
    );
    return {
      displayId: pane.displayId,
      fingerprint: input.fingerprint,
      paneAddress: pane.paneAddress,
      paneId: input.paneId,
      paneLabel: pane.paneLabel,
      snapshot: {
        contentId: typeof response.contentId === "string"
          ? response.contentId
          : null,
        contentType: (response.contentType ?? null) as never,
        drawings: Array.isArray(response.drawings)
          ? response.drawings as never
          : undefined,
        image: typeof response.image === "string" ? response.image : undefined,
        revision: numberValue(response.revision),
        selection: response.selection as never,
        viewport: response.viewport as never,
        visibleText: typeof response.visibleText === "string"
          ? response.visibleText
          : undefined,
      },
      operationReceipt: response.operationReceipt as never,
      windowLabel: resolved.screen.windowLabel,
    };
  }

  private findScreen(fingerprint: string): {
    endpoint: LocklessEndpoint;
    screen: SurfAceScreenSummary;
    surfaceId: string;
  } | null {
    for (const endpoint of this.endpoints.values()) {
      const screen = endpoint.screens.find((candidate) =>
        candidate.fingerprint === fingerprint
      );
      if (screen) {
        return { endpoint, screen, surfaceId: screen.fingerprint };
      }
    }
    return null;
  }

  private requireSurface(fingerprint: string): NonNullable<
    ReturnType<OpenClawLocklessController["findScreen"]>
  > {
    const resolved = this.findScreen(fingerprint);
    if (!resolved) {
      throw new Error(`Unknown lockless Surf Ace surface: ${fingerprint}`);
    }
    return resolved;
  }

  private legacySnapshot(): SurfAceDiscoveryEndpoint[] {
    return this.discovery.getSnapshot().filter(
      (endpoint) => this.endpointModes.get(endpoint.endpointId) === "legacy",
    );
  }

  private notifyLegacyListeners(): void {
    const snapshot = this.legacySnapshot();
    for (const listener of this.legacyListeners) {
      listener(snapshot);
    }
  }

  private alertScopeKey(endpointId: string, scopeId: string): string {
    return `${endpointId}\n${scopeId}`;
  }

  private async presentConsumableAlert(
    endpoint: SurfAceDiscoveryEndpoint,
    scopeId: string,
  ): Promise<void> {
    const key = this.alertScopeKey(endpoint.endpointId, scopeId);
    if (this.alertedScopes.has(key)) {
      return;
    }
    this.alertedScopes.add(key);
    const message =
      `Surf Ace updates pending on ${endpoint.name} (${scopeId})`;
    try {
      await this.options.alertDelivery?.(message);
    } catch {
      // Presentation delivery never changes client-owned pending truth.
    }
  }
}

function projectConsumableRecords(
  records: import("@surf-ace/protocol").ConsumableRecord[],
  pane: SurfAceScreenSummary["panes"][number],
  fingerprint: string,
  readAt: number,
): Pick<
  SurfAceReadResult,
  | "contentSnapshot"
  | "frames"
  | "lastNavigation"
  | "liveDirtyStrokeIds"
  | "liveFrame"
  | "liveSeq"
  | "page"
  | "playbackPosition"
  | "playbackState"
  | "scrollPosition"
  | "selection"
  | "taps"
> {
  const frames: SurfAceReadResult["frames"] = [];
  const taps: SurfAceReadResult["taps"] = [];
  let lastNavigation: SurfAceReadResult["lastNavigation"] = null;
  let page: SurfAceReadResult["page"] = null;
  let playbackPosition: SurfAceReadResult["playbackPosition"] = null;
  let playbackState: SurfAceReadResult["playbackState"] = null;
  let scrollPosition: SurfAceReadResult["scrollPosition"] = null;
  let selection: SurfAceReadResult["selection"] = null;
  let snapshotViewport: unknown = null;
  let snapshotSelection: unknown = null;
  for (const record of records) {
    const payload = asRecord(record.payload);
    switch (record.recordClass) {
      case "annotation_frame": {
        const legacyFrame = asRecord(payload.legacyFrame);
        if (typeof legacyFrame.frameId === "string") {
          frames.push(structuredClone(legacyFrame) as never);
          break;
        }
        const strokes = Array.isArray(payload.strokes)
          ? payload.strokes.map((value) => {
              const stroke = asRecord(value);
              const points = Array.isArray(stroke.points)
                ? stroke.points.map(asRecord)
                : [];
              const xs = points.map((point) => numberValue(point.x));
              const ys = points.map((point) => numberValue(point.y));
              const minX = xs.length ? Math.min(...xs) : 0;
              const maxX = xs.length ? Math.max(...xs) : 0;
              const minY = ys.length ? Math.min(...ys) : 0;
              const maxY = ys.length ? Math.max(...ys) : 0;
              return {
                bbox: {
                  height: maxY - minY,
                  width: maxX - minX,
                  x: minX,
                  y: minY,
                },
                endedAt: numberValue(points.at(-1)?.timestamp, readAt),
                points: points.map((point) => ({
                  pressure: typeof point.pressure === "number"
                    ? point.pressure
                    : undefined,
                  x: numberValue(point.x),
                  y: numberValue(point.y),
                })),
                startedAt: numberValue(points[0]?.timestamp, readAt),
                strokeId: stringValue(stroke.strokeId),
              };
            })
          : [];
        frames.push({
          contentId: stringValue(
            payload.contentId,
            pane.activeContent?.contentId ?? "",
          ),
          contextKey: `${fingerprint}:${pane.paneId}`,
          frameId: stringValue(payload.flushId, record.recordId),
          image: stringValue(payload.image),
          openedAt: numberValue(payload.firstStrokeAt, readAt),
          scrollOffset: { x: 0, y: 0 },
          strokes,
          updatedAt: numberValue(payload.lastStrokeAt, readAt),
          viewport: pane.viewport,
        });
        break;
      }
      case "tap": {
        const position = asRecord(payload.position);
        taps.push({
          eventId: stringValue(payload.legacyEventId, record.recordId),
          kind: payload.kind === "long_press" ? "long_press" : "tap",
          nearestText: typeof payload.nearestContent === "string"
            ? payload.nearestContent
            : undefined,
          timestamp: numberValue(payload.timestamp, readAt),
          x: numberValue(position.x),
          y: numberValue(position.y),
        });
        break;
      }
      case "scroll": {
        const viewport = asRecord(payload.viewport);
        const visibleRect = asRecord(viewport.visibleRect);
        scrollPosition = {
          visibleRect: viewport.visibleRect as never,
          x: numberValue(visibleRect.x),
          y: numberValue(visibleRect.y),
        };
        snapshotViewport = payload.viewport;
        break;
      }
      case "selection":
        selection = payload.selection as never;
        snapshotSelection = payload.selection;
        break;
      case "page":
        page = {
          pageCount: numberValue(payload.totalPages),
          pageLabel: typeof payload.pageText === "string"
            ? payload.pageText
            : undefined,
          pageNumber: numberValue(payload.page),
        };
        break;
      case "playback":
        playbackPosition =
          payload.playbackPosition === null || payload.position === null
            ? null
            : numberValue(payload.playbackPosition ?? payload.position);
        playbackState =
          payload.playbackState === "ended" ||
            payload.playbackState === "paused" ||
            payload.playbackState === "playing"
            ? payload.playbackState
            : null;
        break;
      case "navigation":
        lastNavigation = {
          navigatedAt: numberValue(payload.navigatedAt, readAt),
          url: stringValue(payload.url),
        };
        break;
      case "content":
      case "history":
      case "topology":
        break;
    }
  }
  const liveFrame = frames.at(-1) ?? null;
  return {
    contentSnapshot: pane.activeContent
      ? {
          cachedAt: readAt,
          contentId: pane.activeContent.contentId,
          contentType: pane.activeContent.contentType,
          revision: pane.activeContent.revision,
          selection: (snapshotSelection ?? {
            anchorEnd: null,
            anchorStart: null,
            selectedText: "",
          }) as never,
          viewport: (snapshotViewport ?? {
            contentSize: pane.viewport,
            visibleRect: {
              height: pane.viewport.height,
              width: pane.viewport.width,
              x: 0,
              y: 0,
            },
          }) as never,
        }
      : null,
    frames,
    lastNavigation,
    liveDirtyStrokeIds: liveFrame?.strokes.map((stroke) => stroke.strokeId) ??
      [],
    liveFrame,
    liveSeq: liveFrame ? records.at(-1)?.sequence ?? null : null,
    page,
    playbackPosition,
    playbackState,
    scrollPosition,
    selection,
    taps,
  };
}
