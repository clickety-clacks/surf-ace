import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocketServer } from "ws";
import type WebSocket from "ws";

import type { RuntimeAppBindingDiagnostics } from "../../protocol/src/index.js";
import type { SurfAceDiscoveryEndpoint, SurfAceDiscoveryService } from "./surf-ace-discovery.js";
import { SurfAceOwnershipRecoveryPolicy } from "./surf-ace-ownership-recovery-policy.js";
import {
  createSurfAceRuntime as createSurfAceRuntimeBase,
  providerProcessHealthFromProcessList,
  resolveDefaultSurfAceStateDir,
  type SurfAceProviderProcessHealth,
  type SurfAceRuntimeOptions,
} from "./surf-ace-runtime.js";

const singularProviderProcessHealth = (): SurfAceProviderProcessHealth => ({
  duplicateProviderProcesses: false,
  liveProviderProcessCount: 1,
  pids: [process.pid],
  source: "injected",
});

function createSurfAceRuntime(options: SurfAceRuntimeOptions = {}) {
  return createSurfAceRuntimeBase({
    ...options,
    providerProcessHealth: options.providerProcessHealth ?? singularProviderProcessHealth,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TestPane = {
  contentId: string | null;
  contentType: string | null;
  currentTarget?: Record<string, unknown> | null;
  display?: {
    interactive?: boolean;
    provenance?: Record<string, unknown>;
    scrollable?: boolean;
    senderDisplayName?: string;
    title?: string;
  };
  drawings: string[];
  externalNative?: boolean;
  frame: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  name: string | null;
  nativeWindowGroup?: Record<string, unknown>;
  paneLabel: number;
  paneLineageId: string;
  revision: number;
  viewport: {
    height: number;
    scale: number;
    width: number;
  };
};

function trustedRuntimeAppBinding(): RuntimeAppBindingDiagnostics {
  return {
    acknowledgement: "accepted",
    bindingAuthority: "trusted",
    bindingDegradedReasons: [],
    diagnosticDrift: ["wayland_app_id_mismatch"],
    expectedBundleId: "ai.surf-ace.electron",
    expectedPackageName: "@surf-ace/electron",
    expectedRuntimeId: "surf-ace.runtime.electron",
    launchTokenStatus: "matched",
    observedUiLabel: "Test Surface",
    observedWaylandAppId: "surf-ace-electron",
    observedWindowTitle: "Test Surface",
    processLineageStatus: "matched",
    ready: true,
    reportedBundleId: "ai.surf-ace.electron",
    reportedPackageName: "@surf-ace/electron",
    reportedRuntimeId: "surf-ace.runtime.electron",
  };
}

function stableStringRecordDigest(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const stableValue = Object.fromEntries(Object.keys(value)
    .filter((key) => typeof value[key] === "string")
    .sort()
    .map((key) => [key, value[key]]));
  return createHash("sha256").update(JSON.stringify(stableValue)).digest("hex");
}

function clientBrowserUrlTarget(input: {
  paneLineageId: string;
  targetEpoch?: number;
  targetId?: string;
  url: string;
}): Record<string, unknown> {
  const targetEpoch = input.targetEpoch ?? 1;
  const targetId = input.targetId ?? "tg_client_browser_url";
  const appliedAt = new Date().toISOString();
  return {
    currentState: "current",
    lastApplyEvidence: {
      appliedAt,
      materializedState: {
        navigationStatus: "loaded",
        replaySemantics: "navigate",
        url: input.url,
      },
      paneLineageId: input.paneLineageId,
      requestId: `tr_${targetId}`,
      status: "applied",
      targetEpoch,
      targetId,
    },
    paneLineageId: input.paneLineageId,
    restorePolicy: "auto",
    targetEpoch,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: input.url,
    },
    targetId,
    targetKind: "browser_url",
    targetPayload: { url: input.url },
  };
}

async function launchInternalTerminal(runtime: unknown, input: Record<string, unknown>, context?: Record<string, unknown>) {
  return await (runtime as any).launchTerminal(input, context);
}

type TestSurfaceState = {
  name: string;
  panes: Map<number, TestPane>;
  surfaceId: string;
  topologyLayout: Record<string, unknown>;
  topologyRevision: number;
  viewport: {
    height: number;
    scale: number;
    width: number;
  };
};

test("ownership recovery policy evaluates self-reclaim without file I/O", () => {
  const policy = new SurfAceOwnershipRecoveryPolicy();
  const state = {
    providerId: "pv_current",
    providerLineage: [{ providerId: "pv_legacy" }],
    selfOwnedSurfaceIds: {
      sf_active: { providerId: "pv_current", source: "current_local_ownership" },
      sf_foreign: { providerId: "pv_foreign", source: "current_local_ownership" },
      sf_legacy: { providerId: "pv_legacy", source: "legacy_local_ownership" },
      sf_relinquished: { providerId: "pv_current", relinquishedAt: 1, source: "current_local_ownership" },
    },
    targetStateBySurfaceId: {
      sf_legacy: {
        targetRecords: [
          { ownerProviderId: "pv_foreign", ownershipSessionId: "sa_foreign" },
          { ownerProviderId: "pv_legacy", ownershipSessionId: "sa_legacy" },
        ],
      },
      sf_foreign_current: {
        paneTargets: {
          pl_current: { currentTargetId: "tg_foreign_current" },
        },
        targetRecords: [
          {
            currentState: "current",
            ownerProviderId: "pv_foreign",
            ownershipSessionId: "sa_foreign_current",
            targetId: "tg_foreign_current",
          },
        ],
      },
      sf_foreign_stale: {
        paneTargets: {
          pl_stale: { currentTargetId: null },
        },
        targetRecords: [
          {
            currentState: "stale",
            ownerProviderId: "pv_foreign",
            ownershipSessionId: "sa_foreign_stale",
            targetId: "tg_foreign_stale",
          },
        ],
      },
    },
  };

  assert.equal(policy.isKnownSelfOwnedSurface(state, "sf_active", false), true);
  assert.equal(policy.isKnownSelfOwnedSurface(state, "sf_relinquished", false), false);
  assert.equal(policy.hasTrustedForeignLineageSelfOwnership(state, "sf_legacy"), true);
  assert.equal(policy.hasTrustedForeignLineageSelfOwnership(state, "sf_foreign"), false);
  assert.equal(policy.hasDurableDifferentProviderOwnership(state, "sf_foreign"), true);
  assert.equal(policy.hasDurableDifferentProviderOwnership(state, "sf_foreign_current"), true);
  assert.equal(policy.hasDurableDifferentProviderOwnership(state, "sf_foreign_stale"), false);
  assert.equal(policy.durableSelfReclaimResumeSessionId(state, "sf_legacy", null), "sa_legacy");
  assert.equal(policy.durableSelfReclaimResumeSessionId(state, "sf_active", "sa_live"), "sa_live");
});

class StaticDiscoveryService implements SurfAceDiscoveryService {
  private readonly listeners = new Set<(endpoints: SurfAceDiscoveryEndpoint[]) => void | Promise<void>>();
  private endpoints: SurfAceDiscoveryEndpoint[];

  constructor(endpoints: SurfAceDiscoveryEndpoint[]) {
    this.endpoints = endpoints;
  }

  async start(): Promise<void> {
    await this.refreshNow();
  }

  async stop(): Promise<void> {}

  async refreshNow(): Promise<void> {
    for (const listener of this.listeners) {
      await listener(this.getSnapshot());
    }
  }

  getSnapshot(): SurfAceDiscoveryEndpoint[] {
    return structuredClone(this.endpoints);
  }

  setEndpoints(endpoints: SurfAceDiscoveryEndpoint[]): void {
    this.endpoints = structuredClone(endpoints);
  }

  subscribe(listener: (endpoints: SurfAceDiscoveryEndpoint[]) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

class FakeSurfAceWsServer {
  activeSocketCount = 0;
  readonly annotationsRemoveRequests: Array<{ contentId: string; paneId: number; strokeIds: string[] }> = [];
  rejectAuthorityState = false;
  busyWithoutTakeoverResponsesRemaining = 0;
  readonly clearRequests: Array<{ paneId: number; revision: number }> = [];
  readonly closePaneRequests: Array<{ paneId: number }> = [];
  readonly contentSetRequests: Array<{
    content: unknown;
    contentId: string;
    contentType: string;
    displayProvenance?: unknown;
    displaySenderName?: string | null;
    displayTitle?: string | null;
    historyOwnerToken: string;
    paneId: number;
    reloadSource?: unknown;
    revision: number;
    restoredDrawings?: unknown;
  }> = [];
  readonly targetApplyRequests: Array<{
    ownershipEpoch: number;
    ownershipSessionId: string;
    paneLineageId: string;
    displayProvenance?: unknown;
    displaySenderName?: string | null;
    displayTitle?: string | null;
    restoreReason: string;
    targetHeader: unknown;
    targetId: string;
    targetKind: string;
    targetPayload: unknown;
  }> = [];
  readonly authorityStateRequests: Array<{
    actionable: boolean;
    paneIds: number[];
    paneLabels: number[];
    reason: string | null;
    surfaceId: string;
    windowLabel: string;
  }> = [];
  rejectAuthorityStateReason = "test_authority_rejected";
  targetApplyErrorCode: string | null = null;
  targetApplyErrorResponsesRemaining = Number.POSITIVE_INFINITY;
  targetApplyDelayMs = 0;
  readonly topologyApplyRequests: Array<{
    layout: unknown;
    paneIds: number[];
    paneLabels: number[];
    topologyRevision: number;
    windowLabel: string;
  }> = [];
  readonly surfaceWindowCloseRequests: Array<{ requestedBy: string | null; surfaceId: string }> = [];
  readonly surfaceWindowOpenRequests: Array<{ requestedBy: string | null; surfaceId: string }> = [];
  nextSurfaceWindowCloseResponse: { closed: boolean } = { closed: true };
  nextSurfaceWindowOpenResponse: { accepted: boolean; surfaceId?: string } = {
    accepted: true,
    surfaceId: "sf_surface-window-opened",
  };
  initialRemotePaneId: number;
  readonly pairAttemptDetails: Array<{
    providerId: string | null;
    providerName: string | null;
    restoreAttemptId: string | null;
    resumeSessionId: string | null;
    takeover: boolean;
  }> = [];
  readonly pairRequests: Array<{ initialPaneId: number; initialPaneLabel: number; windowLabel: string }> = [];
  readonly pairRequestSurfaceIds: string[] = [];
  heartbeatRequests = 0;
  panesListErrorCode: string | null = null;
  panesListRequests = 0;
  pairResponseOwnershipEpoch = 1;
  pairPaneStateMutator: ((paneState: Record<string, unknown>) => Record<string, unknown>) | null = null;
  readonly panes: Map<number, TestPane>;
  readonly splitRequests: Array<{
    count: number;
    direction: string;
    newPaneIds: number[];
    newPaneLabels: number[];
    paneId: number;
  }> = [];
  nextTopologyApplyError: { code: string; message: string } | null = null;
  nextTopologyApplyResponsePaneLabels: number[] | null = null;
  topologyApplyDelayMs = 0;
  nextContentApplyErrors: Array<{ code: string; details?: Record<string, unknown>; message: string }> = [];
  nextContentApplyError: { code: string; details?: Record<string, unknown>; message: string } | null = null;
  nextContentApplyRenderStatus: string | null = null;
  snapshotDelayMs = 0;
  snapshotImage = "aGVsbG8=";
  snapshotRequests: Array<{ includeImage: boolean; includeVisibleText: boolean; paneId: number }> = [];
  snapshotScrollOffset = { x: 0, y: 0 };
  targetApplyResultErrorCode: string | null = null;
  targetCapabilities = [
    "target.html.v1",
    "target.markdown.v1",
    "target.image.v1",
    "target.terminal_app.v1",
    "target.native_app.v1",
    "target.compositor_app.v1",
  ];
  protocolFeatures = ["authority.state.v1"];
  runtimeAppBinding: RuntimeAppBindingDiagnostics | null = null;
  runtimeAppBindingRequests = 0;
  readonly flightRecorderRequests: Array<{ maxLines: number; restoreAttemptId: string | null }> = [];
  flightRecorderLines = [
    "2026-06-26T00:00:00Z [surf-ace:lifecycle] event=scene_connect restore_attempt_id=ra_fixture persisted_content_count=1",
    "2026-06-26T00:00:01Z [surf-ace:gateway] event=incoming_content_apply clear=true restore_attempt_id=ra_fixture",
    "2026-06-26T00:00:02Z [surf-ace:lifecycle] event=render_transition_empty actor=content.apply.clear restore_attempt_id=ra_fixture",
  ];
  dropNextSplitRequest = false;
  forcedPairErrors: Array<{ code: string; message: string }> = [];
  addPaneAfterPairResponse: {
    paneId: number;
    paneLabel: number;
    surfaceId: string;
  } | null = null;
  busyWithoutTakeoverMessage = "Surface is already paired";
  invalidResumeWithoutTakeoverResponsesRemaining = 0;
  lockedProviderId: string | null = null;
  lockedSessionId: string | null = null;
  lockUntilNewProviderIdCode: "busy" | "invalid_resume" | null = null;
  lockUntilNewProviderIdProviderId: string | null = null;
  takeoverRequiresResumeSessionId: string | null = null;
  clearTakeoverResumeRequirementAfterMismatch = false;
  maxConcurrentSocketCount = 0;
  rejectNextResumePairWithSessionMismatch = false;
  resumePairMismatchResponsesRemaining = 0;
  resumePairMismatchMessage = "Resume session did not match active ownership lock";
  includePairPaneLineageIds = true;
  forceEmptyPairResponsePanes = false;
  omitPairPaneLabel = false;
  omitPanesListPaneLabel = false;
  omitTopologyApplyResponsePaneLabel = false;
  nativeTargetProofContentIdOverride: string | null | undefined = undefined;
  nativeTargetProofPaneIdOverride: string | null | undefined = undefined;
  browserUrlMaterializedStateOverride: unknown | undefined = undefined;
  surfacesListErrorCode: string | null = null;
  surfacesListRequests = 0;

  pairedSocket: import("ws").WebSocket | null = null;
  readonly surfaceId: string;

  private closed = false;
  private nextEventId = 1;
  private readonly pairedSocketsBySurfaceId = new Map<string, WebSocket>();
  private readonly socketSurfaceIds = new Map<WebSocket, string>();
  private readonly sockets = new Set<WebSocket>();
  private readonly surfaces = new Map<string, TestSurfaceState>();
  private readonly wss: WebSocketServer;

  constructor(port: number, options?: { initialPaneLabel?: number; initialRemotePaneId?: number; surfaceId?: string }) {
    this.initialRemotePaneId = options?.initialRemotePaneId ?? 41;
    this.surfaceId = options?.surfaceId ?? "sf_surface-a";
    this.panes = new Map<number, TestPane>([
      [
        this.initialRemotePaneId,
        {
          contentId: null,
          contentType: null,
          drawings: [],
          frame: {
            height: 768,
            width: 1024,
            x: 0,
            y: 0,
          },
          name: null,
          paneLabel: options?.initialPaneLabel ?? 1,
          paneLineageId: `pl_${this.surfaceId}_${this.initialRemotePaneId}`,
          revision: 0,
          viewport: {
            height: 768,
            scale: 2,
            width: 1024,
          },
        },
      ],
    ]);
    this.surfaces.set(this.surfaceId, {
      name: "Surface A",
      panes: this.panes,
      surfaceId: this.surfaceId,
      topologyLayout: { paneId: this.initialRemotePaneId, type: "pane" },
      topologyRevision: 0,
      viewport: {
        height: 768,
        scale: 2,
        width: 1024,
      },
    });
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (socket) => {
      this.sockets.add(socket);
      this.activeSocketCount = this.sockets.size;
      this.maxConcurrentSocketCount = Math.max(this.maxConcurrentSocketCount, this.activeSocketCount);
      socket.once("close", () => {
        this.sockets.delete(socket);
        this.activeSocketCount = this.sockets.size;
        const surfaceId = this.socketSurfaceIds.get(socket);
        if (surfaceId && this.pairedSocketsBySurfaceId.get(surfaceId) === socket) {
          this.pairedSocketsBySurfaceId.delete(surfaceId);
        }
        this.socketSurfaceIds.delete(socket);
        if (this.pairedSocket === socket) {
          this.pairedSocket = null;
        }
      });
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8")) as {
          id: string;
          op: string;
          payload?: Record<string, unknown>;
        };
        void this.handleMessage(socket, message);
      });
    });
  }

  setTopologyLayout(
    layout: Record<string, unknown>,
    topologyRevision = 1,
    surfaceId = this.surfaceId,
  ): void {
    const surface = this.requireSurface(surfaceId);
    surface.topologyLayout = structuredClone(layout);
    surface.topologyRevision = topologyRevision;
    this.applyTopologyFrames(surface, layout);
  }

  resetToSinglePane(paneId = this.initialRemotePaneId): void {
    this.panes.clear();
    this.panes.set(paneId, {
      contentId: null,
      contentType: null,
      drawings: [],
      frame: {
        height: 768,
        width: 1024,
        x: 0,
        y: 0,
      },
      name: null,
      paneLabel: 1,
      paneLineageId: `pl_${this.surfaceId}_${paneId}`,
      revision: 0,
      viewport: {
        height: 768,
        scale: 2,
        width: 1024,
      },
    });
    this.setTopologyLayout({ paneId, type: "pane" }, 0);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const socket of this.sockets) {
      socket.close(1000, "test_server_close");
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  addSurface(options: {
    initialPaneLabel?: number;
    initialRemotePaneId?: number;
    name?: string;
    surfaceId: string;
    viewport?: {
      height: number;
      scale: number;
      width: number;
    };
  }): void {
    const viewport = options.viewport ?? {
      height: 768,
      scale: 2,
      width: 1024,
    };
    const initialRemotePaneId = options.initialRemotePaneId ?? 41;
    this.surfaces.set(options.surfaceId, {
      name: options.name ?? `Surface ${options.surfaceId}`,
      panes: new Map<number, TestPane>([
        [
          initialRemotePaneId,
          {
            contentId: null,
            contentType: null,
            drawings: [],
            frame: {
              height: viewport.height,
              width: viewport.width,
              x: 0,
              y: 0,
            },
            name: null,
            paneLabel: options.initialPaneLabel ?? 1,
            paneLineageId: `pl_${options.surfaceId}_${initialRemotePaneId}`,
            revision: 0,
            viewport: { ...viewport },
          },
        ],
      ]),
      surfaceId: options.surfaceId,
      topologyLayout: { paneId: initialRemotePaneId, type: "pane" },
      topologyRevision: 0,
      viewport,
    });
  }

  pairedSocketFor(surfaceId: string): import("ws").WebSocket | null {
    return this.pairedSocketsBySurfaceId.get(surfaceId) ?? null;
  }

  markSurfacePairedForList(surfaceId: string): void {
    this.pairedSocketsBySurfaceId.set(surfaceId, {} as import("ws").WebSocket);
  }

  private topologyLayoutForPairPanes(panes: Array<{ paneId: number }>): Record<string, unknown> {
    if (panes.length === 1) {
      return { paneId: panes[0]!.paneId, type: "pane" };
    }
    return {
      children: panes.map((pane) => ({ paneId: pane.paneId, type: "pane" })),
      direction: "horizontal",
      type: "split",
    };
  }

  private topologyLayoutPaneIds(layout: Record<string, unknown>): number[] {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (layout.type === "pane") {
      return typeof layout.paneId === "number" ? [layout.paneId] : [];
    }
    if (layout.type === "split" && Array.isArray(layout.children)) {
      return layout.children.flatMap((child) =>
        isRecord(child) ? this.topologyLayoutPaneIds(child) : [],
      );
    }
    return [];
  }

  private topologyLayoutMatchesPairPanes(layout: Record<string, unknown>, panes: Array<{ paneId: number }>): boolean {
    const layoutPaneIds = this.topologyLayoutPaneIds(layout);
    const layoutPaneIdSet = new Set(layoutPaneIds);
    return layoutPaneIds.length === panes.length &&
      layoutPaneIdSet.size === layoutPaneIds.length &&
      panes.every((pane) => layoutPaneIdSet.has(pane.paneId));
  }

  setSurfaceViewport(viewport: { height: number; scale: number; width: number }): void {
    this.requireSurface(this.surfaceId).viewport = { ...viewport };
  }

  sendSurfaceAppeared(options: {
    fromSurfaceId?: string;
    initialRemotePaneId?: number;
    name?: string;
    surfaceId: string;
    viewport?: {
      height: number;
      scale: number;
      width: number;
    };
  }): void {
    if (!this.surfaces.has(options.surfaceId)) {
      this.addSurface(options);
    }
    const surface = this.requireSurface(options.surfaceId);
    this.pairedSocketFor(options.fromSurfaceId ?? this.surfaceId)?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.surface_appeared",
        payload: {
          name: surface.name,
          surfaceId: surface.surfaceId,
          viewport: surface.viewport,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
  }

  sendSurfaceRemoved(options: { fromSurfaceId?: string; surfaceId: string }): void {
    this.pairedSocketFor(options.fromSurfaceId ?? this.surfaceId)?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.surface_removed",
        payload: {
          surfaceId: options.surfaceId,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
    this.pairedSocketsBySurfaceId.get(options.surfaceId)?.close(1000, "surface_removed");
    this.surfaces.delete(options.surfaceId);
  }

  removeSurfaceWithoutEvent(surfaceId: string): void {
    this.pairedSocketsBySurfaceId.get(surfaceId)?.close(1000, "surface_removed");
    this.surfaces.delete(surfaceId);
  }

  omitSurfaceFromList(surfaceId: string): void {
    this.surfaces.delete(surfaceId);
  }

  private requireSurface(surfaceId: string): TestSurfaceState {
    const surface = this.surfaces.get(surfaceId);
    assert.ok(surface, `unknown test surface ${surfaceId}`);
    return surface;
  }

  private requirePairedSurface(socket: import("ws").WebSocket): TestSurfaceState {
    const surfaceId = this.socketSurfaceIds.get(socket) ?? this.surfaceId;
    return this.requireSurface(surfaceId);
  }

  sendDrawingFlush(paneId: number, contentId: string): void {
    const pane = this.panes.get(paneId);
    assert.ok(pane);
    this.pairedSocket?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.drawing_flush",
        payload: {
          contentId,
          firstStrokeAt: 100,
          flushId: "fl_test",
          flushReason: "idle_window",
          idleWindowMs: 8000,
          lastStrokeAt: 120,
          maxIntervalMs: 30000,
          paneId,
          pointsCount: 2,
          revision: pane.revision,
          strokeCount: 1,
          strokes: [
            {
              points: [
                { pressure: 0.2, timestamp: 100, x: 10, y: 20 },
                { pressure: 0.4, timestamp: 120, x: 30, y: 40 },
              ],
              strokeId: "stroke_abc123",
            },
          ],
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
    pane.drawings = ["stroke_abc123"];
  }

  sendAnnotationCommitted(paneId: number, contentId: string): void {
    const pane = this.panes.get(paneId);
    assert.ok(pane);
    this.pairedSocket?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.annotation_committed",
        payload: {
          committedAt: Date.now(),
          contentId,
          paneId,
          revision: pane.revision,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
  }

  sendNavigation(paneId: number, contentId: string, url: string): number {
    const pane = this.panes.get(paneId);
    assert.ok(pane);
    const sentAt = Date.now();
    this.pairedSocket?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.navigation",
        payload: {
          contentId,
          paneId,
          revision: pane.revision,
          url,
        },
        sentAt,
        type: "event",
        v: 1,
      }),
    );
    return sentAt;
  }

  sendHistoryNavigated(
    paneId: number,
    options: {
      contentId: string | null;
      direction: "back" | "forward";
      fromSurfaceId?: string;
      revision: number;
    },
  ): void {
    const surface = this.surfaces.get(options.fromSurfaceId ?? this.surfaceId);
    const pane = surface?.panes.get(paneId);
    if (pane) {
      pane.contentId = options.contentId;
      pane.revision = options.revision;
    }
    this.pairedSocketFor(options.fromSurfaceId ?? this.surfaceId)?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.history_navigated",
        payload: {
          contentId: options.contentId,
          direction: options.direction,
          paneId,
          revision: options.revision,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
  }

  sendSnapshotHint(reason: "after_reconnect" | "after_render" | "backpressure_drop"): void {
    this.pairedSocket?.send(
      JSON.stringify({
        eventId: `ev_${this.nextEventId++}`,
        op: "event.snapshot_hint",
        payload: { reason },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      }),
    );
  }

  private async handleMessage(
    socket: import("ws").WebSocket,
    message: { id: string; op: string; payload?: Record<string, unknown> },
  ): Promise<void> {
    switch (message.op) {
      case "surfaces.list":
        this.surfacesListRequests += 1;
        if (this.surfacesListErrorCode) {
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "surfaces.list",
                this.surfacesListErrorCode,
                "surfaces.list unavailable",
              ),
            ),
          );
          return;
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "surfaces.list", {
              surfaces: [...this.surfaces.values()].map((surface) => ({
                name: surface.name,
                paired: this.pairedSocketsBySurfaceId.has(surface.surfaceId),
                surfaceId: surface.surfaceId,
                viewport: surface.viewport,
              })),
            }),
          ),
        );
        return;
      case "runtime.app_binding":
        this.runtimeAppBindingRequests += 1;
        socket.send(
          JSON.stringify(
            this.response(message.id, "runtime.app_binding", {
              runtimeAppBinding: this.runtimeAppBinding,
            }),
          ),
        );
        return;
      case "diagnostics.flight_recorder":
        this.flightRecorderRequests.push({
          maxLines: Number(message.payload?.maxLines ?? 0),
          restoreAttemptId:
            typeof message.payload?.restoreAttemptId === "string"
              ? String(message.payload.restoreAttemptId)
              : null,
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "diagnostics.flight_recorder", {
              lines: this.flightRecorderLines,
              logPath: "/tmp/surf-ace-client-flight-recorder.log",
              restoreAttemptId: message.payload?.restoreAttemptId ?? null,
              surfaceId: this.surfaceId,
            }),
          ),
        );
        return;
      case "pair.request":
        this.pairRequestSurfaceIds.push(String(message.payload?.surfaceId ?? this.surfaceId));
        this.pairRequests.push({
          initialPaneId: Number(message.payload?.initialPaneId ?? 0),
          initialPaneLabel: Number(message.payload?.initialPaneLabel ?? 0),
          windowLabel: String(message.payload?.windowLabel ?? ""),
        });
        this.pairAttemptDetails.push({
          providerId:
            typeof message.payload?.providerId === "string"
              ? String(message.payload.providerId)
              : null,
          providerName:
            typeof message.payload?.providerName === "string"
              ? String(message.payload.providerName)
              : null,
          restoreAttemptId:
            typeof message.payload?.restoreAttemptId === "string"
              ? String(message.payload.restoreAttemptId)
              : null,
          resumeSessionId:
            typeof message.payload?.resume === "object" &&
            message.payload?.resume &&
            typeof (message.payload.resume as { sessionId?: unknown }).sessionId === "string"
              ? String((message.payload.resume as { sessionId: string }).sessionId)
              : null,
          takeover: Boolean(message.payload?.takeover),
        });
        if (
          this.lockUntilNewProviderIdCode &&
          this.lockUntilNewProviderIdProviderId &&
          this.pairAttemptDetails.at(-1)?.providerId === this.lockUntilNewProviderIdProviderId &&
          !message.payload?.takeover
        ) {
          const errorCode = this.lockUntilNewProviderIdCode;
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "pair.request",
                errorCode,
                errorCode === "busy"
                  ? "Surface is already paired"
                  : this.resumePairMismatchMessage,
              ),
            ),
          );
          return;
        }
        if (this.busyWithoutTakeoverResponsesRemaining > 0 && !message.payload?.takeover) {
          this.busyWithoutTakeoverResponsesRemaining -= 1;
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "pair.request",
                "busy",
                this.busyWithoutTakeoverMessage,
              ),
            ),
          );
          return;
        }
        if (this.invalidResumeWithoutTakeoverResponsesRemaining > 0 && !message.payload?.takeover) {
          this.invalidResumeWithoutTakeoverResponsesRemaining -= 1;
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "pair.request",
                "invalid_resume",
                this.resumePairMismatchMessage,
              ),
            ),
          );
          return;
        }
        if (
          (this.rejectNextResumePairWithSessionMismatch ||
            this.resumePairMismatchResponsesRemaining > 0) &&
          this.pairAttemptDetails.at(-1)?.resumeSessionId
        ) {
          this.rejectNextResumePairWithSessionMismatch = false;
          if (this.resumePairMismatchResponsesRemaining > 0) {
            this.resumePairMismatchResponsesRemaining -= 1;
          }
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "pair.request",
                "invalid_resume",
                this.resumePairMismatchMessage,
              ),
            ),
          );
          return;
        }
        const forcedPairError = this.forcedPairErrors.shift();
        if (forcedPairError) {
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "pair.request",
                forcedPairError.code,
                forcedPairError.message,
              ),
            ),
          );
          return;
        }
        const resumeSessionId =
          typeof message.payload?.resume === "object" &&
          message.payload.resume !== null &&
          typeof (message.payload.resume as { sessionId?: unknown }).sessionId === "string"
            ? String((message.payload.resume as { sessionId: string }).sessionId)
            : null;
        let pairResponseResumed = resumeSessionId !== null;
        let pairResponseSessionId = resumeSessionId ?? "sa_test_session";
        if (this.lockedProviderId && this.lockedSessionId) {
          const attemptedProviderId = this.pairAttemptDetails.at(-1)?.providerId;
          const attemptedResumeSessionId = this.pairAttemptDetails.at(-1)?.resumeSessionId;
          if (attemptedProviderId !== this.lockedProviderId && !message.payload?.takeover) {
            socket.send(
              JSON.stringify(
                this.errorResponse(
                  message.id,
                  "pair.request",
                  "busy",
                  this.busyWithoutTakeoverMessage,
                ),
              ),
            );
            return;
          }
          if (
            message.payload?.takeover &&
            this.takeoverRequiresResumeSessionId &&
            attemptedResumeSessionId !== this.takeoverRequiresResumeSessionId
          ) {
            if (this.clearTakeoverResumeRequirementAfterMismatch) {
              this.takeoverRequiresResumeSessionId = null;
            }
            socket.send(
              JSON.stringify(
                this.errorResponse(
                  message.id,
                  "pair.request",
                  "invalid_resume",
                  this.resumePairMismatchMessage,
                ),
              ),
            );
            return;
          }
          if (message.payload?.takeover) {
            pairResponseResumed = false;
            pairResponseSessionId = "sa_test_session";
            this.lockedProviderId = attemptedProviderId ?? this.lockedProviderId;
            this.lockedSessionId = pairResponseSessionId;
          } else if (attemptedResumeSessionId !== this.lockedSessionId) {
            socket.send(
              JSON.stringify(
                this.errorResponse(
                  message.id,
                  "pair.request",
                  "invalid_resume",
                  this.resumePairMismatchMessage,
                ),
              ),
            );
            return;
          } else {
            pairResponseResumed = true;
            pairResponseSessionId = this.lockedSessionId;
          }
        }
        const requestedSurface = this.requireSurface(String(message.payload?.surfaceId ?? this.surfaceId));
	        const pairResponsePanes = this.forceEmptyPairResponsePanes
	          ? []
	          : [...requestedSurface.panes.entries()].map(([paneId, pane]) => {
	              const paneState: Record<string, unknown> = {
              contentType: pane.contentType,
              currentContentId: pane.contentId,
              currentRevision: pane.revision,
              ...(pane.currentTarget ? { currentTarget: structuredClone(pane.currentTarget) } : {}),
              ...(pane.display ? { display: structuredClone(pane.display) } : {}),
              paneId,
              ...(this.includePairPaneLineageIds ? { paneLineageId: pane.paneLineageId } : {}),
              };
              if (!this.omitPairPaneLabel) {
                paneState.paneLabel = pane.paneLabel;
	              }
	              return this.pairPaneStateMutator ? this.pairPaneStateMutator(paneState) : paneState;
	            });
        const pairStateLayout = this.topologyLayoutMatchesPairPanes(requestedSurface.topologyLayout, pairResponsePanes)
          ? requestedSurface.topologyLayout
          : this.topologyLayoutForPairPanes(pairResponsePanes);
	        this.pairedSocketsBySurfaceId.set(requestedSurface.surfaceId, socket);
        this.socketSurfaceIds.set(socket, requestedSurface.surfaceId);
        if (requestedSurface.surfaceId === this.surfaceId) {
          this.pairedSocket = socket;
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "pair.request", {
              capabilities: {
                contentTypes: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"],
                eventTypes: [
                  "event.annotation_committed",
                  "event.drawing_flush",
                  "event.history_navigated",
                  "event.tap",
                  "event.selection",
                  "event.page",
                  "event.navigation",
                  "event.snapshot_hint",
                ],
                protocolFeatures: [...this.protocolFeatures],
                ...(this.runtimeAppBinding ? { runtimeAppBinding: this.runtimeAppBinding } : {}),
                targetCapabilities: [...this.targetCapabilities],
              },
              eventConfig: {
                activeEvents: [
                  "event.annotation_committed",
                  "event.drawing_flush",
                  "event.history_navigated",
                  "event.tap",
                  "event.selection",
                  "event.page",
                  "event.navigation",
                  "event.snapshot_hint",
                ],
                drawingFlushConfig: {
                  idleWindowMs: 8000,
                  maxIntervalMs: 30000,
                },
                profile: "minimum_deep",
              },
              limits: {
                maxDrawingFlushBytes: 2 * 1024 * 1024,
                maxFrameBytes: 10 * 1024 * 1024,
                maxMessageBytes: 12 * 1024 * 1024,
                maxStrokePointsPerFlush: 8192,
                maxVisibleTextBytes: 4096,
                resumeGraceMs: 20_000,
              },
              ownershipEpoch: this.pairResponseOwnershipEpoch,
              resumed: pairResponseResumed,
	              sessionId: pairResponseSessionId,
	              state: {
	                layout: structuredClone(pairStateLayout),
	                panes: pairResponsePanes,
	                topologyRevision: requestedSurface.topologyRevision,
	              },
              surfaceId: requestedSurface.surfaceId,
              surfaceName: requestedSurface.name,
              viewport: requestedSurface.viewport,
            }),
          ),
        );
        if (this.addPaneAfterPairResponse?.surfaceId === requestedSurface.surfaceId) {
          requestedSurface.panes.set(this.addPaneAfterPairResponse.paneId, {
            contentId: null,
            contentType: null,
            drawings: [],
            frame: {
              height: requestedSurface.viewport.height,
              width: requestedSurface.viewport.width,
              x: 0,
              y: 0,
            },
            name: null,
            paneLabel: this.addPaneAfterPairResponse.paneLabel,
            paneLineageId: `pl_${requestedSurface.surfaceId}_${this.addPaneAfterPairResponse.paneId}`,
            revision: 0,
            viewport: { ...requestedSurface.viewport },
          });
          this.addPaneAfterPairResponse = null;
        }
        return;
      case "surface.window.open": {
        const targetSurface = this.requirePairedSurface(socket);
        this.surfaceWindowOpenRequests.push({
          requestedBy: typeof message.payload?.requestedBy === "string" ? message.payload.requestedBy : null,
          surfaceId: targetSurface.surfaceId,
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "surface.window.open", {
              accepted: this.nextSurfaceWindowOpenResponse.accepted,
              ...(this.nextSurfaceWindowOpenResponse.surfaceId
                ? { surfaceId: this.nextSurfaceWindowOpenResponse.surfaceId }
                : {}),
            }),
          ),
        );
        return;
      }
      case "surface.window.close": {
        const targetSurface = this.requirePairedSurface(socket);
        this.surfaceWindowCloseRequests.push({
          requestedBy: typeof message.payload?.requestedBy === "string" ? message.payload.requestedBy : null,
          surfaceId: targetSurface.surfaceId,
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "surface.window.close", {
              closed: this.nextSurfaceWindowCloseResponse.closed,
              surfaceId: targetSurface.surfaceId,
            }),
          ),
        );
        return;
      }
      case "topology.apply": {
        const targetSurface = this.requirePairedSurface(socket);
        const panes = Array.isArray(message.payload?.panes)
          ? message.payload.panes.map((paneState) => ({
              name:
                typeof (paneState as { name?: unknown }).name === "string"
                  ? String((paneState as { name: string }).name)
                  : null,
              paneId: Number((paneState as { paneId?: unknown }).paneId ?? 0),
              paneLabel: Number((paneState as { paneLabel?: unknown }).paneLabel ?? 0),
            }))
          : [];
        if (this.dropNextSplitRequest) {
          this.dropNextSplitRequest = false;
          socket.close(1011, "drop_next_topology_apply");
          return;
        }
        this.topologyApplyRequests.push({
          layout: structuredClone(message.payload?.layout ?? null),
          paneIds: panes.map((pane) => pane.paneId),
          paneLabels: panes.map((pane) => pane.paneLabel),
          topologyRevision: Number(message.payload?.topologyRevision ?? 0),
          windowLabel: String(message.payload?.windowLabel ?? ""),
        });
        if (this.nextTopologyApplyError) {
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "topology.apply",
                this.nextTopologyApplyError.code,
                this.nextTopologyApplyError.message,
              ),
            ),
          );
          this.nextTopologyApplyError = null;
          return;
        }
        if (this.topologyApplyDelayMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, this.topologyApplyDelayMs);
          });
        }
        const previousPanes = new Map(targetSurface.panes);
        targetSurface.panes.clear();
        for (const paneState of panes) {
          const previousPane = previousPanes.get(paneState.paneId);
          targetSurface.panes.set(paneState.paneId, {
            contentId: previousPane?.contentId ?? null,
            contentType: previousPane?.contentType ?? null,
            currentTarget: previousPane?.currentTarget ? structuredClone(previousPane.currentTarget) : null,
            drawings: previousPane?.drawings ? [...previousPane.drawings] : [],
            frame: previousPane?.frame ?? {
              height: targetSurface.viewport.height,
              width: targetSurface.viewport.width,
              x: 0,
              y: 0,
            },
            name: paneState.name,
            paneLabel: paneState.paneLabel,
            paneLineageId: previousPane?.paneLineageId ?? `pl_${targetSurface.surfaceId}_${paneState.paneId}`,
            revision: previousPane?.revision ?? 0,
            viewport: previousPane?.viewport ?? { ...targetSurface.viewport },
          });
        }
        targetSurface.topologyLayout = structuredClone(message.payload?.layout) as Record<string, unknown>;
        targetSurface.topologyRevision = Number(message.payload?.topologyRevision ?? 0);
        this.applyTopologyFrames(targetSurface, message.payload?.layout);
        socket.send(
          JSON.stringify(
            this.response(message.id, "topology.apply", {
              panes: panes.map((pane, index) => {
                const paneState: Record<string, unknown> = {
                  name: pane.name,
                  paneId: pane.paneId,
                  paneLineageId: targetSurface.panes.get(pane.paneId)?.paneLineageId ?? `pl_${targetSurface.surfaceId}_${pane.paneId}`,
                };
                if (!this.omitTopologyApplyResponsePaneLabel) {
                  paneState.paneLabel = this.nextTopologyApplyResponsePaneLabels?.[index] ?? pane.paneLabel;
                }
                return paneState;
              }),
              topologyRevision: Number(message.payload?.topologyRevision ?? 0),
            }),
          ),
        );
        this.nextTopologyApplyResponsePaneLabels = null;
        return;
      }
      case "content.apply": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
        assert.ok(pane);
        const queuedContentApplyError = this.nextContentApplyErrors.shift() ?? null;
        if (queuedContentApplyError || this.nextContentApplyError) {
          const error = queuedContentApplyError ?? this.nextContentApplyError!;
          if (!queuedContentApplyError) {
            this.nextContentApplyError = null;
          }
          socket.send(
            JSON.stringify(
              this.errorResponse(
                message.id,
                "content.apply",
                error.code,
                error.message,
                error.details,
              ),
            ),
          );
          return;
        }
        if (message.payload && "clear" in message.payload) {
          pane.contentId = null;
          pane.contentType = null;
          pane.drawings = [];
          pane.externalNative = false;
          pane.revision = Number(message.payload.revision ?? pane.revision);
          this.clearRequests.push({
            paneId,
            revision: pane.revision,
          });
          socket.send(
            JSON.stringify(
              this.response(message.id, "content.apply", {
                contentId: null,
                currentContentId: null,
                currentRevision: pane.revision,
                paneId,
                topologyRevision: message.payload.topologyRevision,
              }),
            ),
          );
          return;
        }
        const nextContentId = String(message.payload?.contentId);
        const previousContentId = pane.contentId;
        pane.contentId = nextContentId;
        pane.contentType = String(message.payload?.contentType);
        pane.revision = Number(message.payload?.revision ?? pane.revision + 1);
        if (Array.isArray(message.payload?.restoredDrawings)) {
          pane.drawings = message.payload.restoredDrawings
            .map((stroke: any) => String(stroke?.strokeId ?? ""))
            .filter((strokeId: string) => strokeId.length > 0);
        } else if (previousContentId !== pane.contentId) {
          pane.drawings = [];
        }
        this.contentSetRequests.push({
          content: structuredClone(message.payload?.content),
          contentId: pane.contentId,
          contentType: pane.contentType,
          displayProvenance: structuredClone(message.payload?.display?.provenance ?? null),
          displaySenderName: typeof message.payload?.display?.senderDisplayName === "string" ? message.payload.display.senderDisplayName : null,
          displayTitle: typeof message.payload?.display?.title === "string" ? message.payload.display.title : null,
          historyOwnerToken: String(message.payload?.historyOwnerToken ?? ""),
          paneId,
          reloadSource: structuredClone(message.payload?.reloadSource),
          revision: pane.revision,
          restoredDrawings: structuredClone(message.payload?.restoredDrawings),
        });
        const renderStatus = this.nextContentApplyRenderStatus;
        this.nextContentApplyRenderStatus = null;
        const responsePayload: Record<string, unknown> = {
          contentId: pane.contentId,
          contentType: pane.contentType,
          currentContentId: pane.contentId,
          currentRevision: pane.revision,
          paneId,
          topologyRevision: message.payload?.topologyRevision,
        };
        if (renderStatus) {
          responsePayload.render = {
            bridgeAttached: renderStatus !== "pending_renderer",
            contentId: pane.contentId,
            contentType: pane.contentType,
            revision: pane.revision,
            status: renderStatus,
          };
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "content.apply", responsePayload),
          ),
        );
        return;
      }
      case "target.apply": {
        this.targetApplyRequests.push({
          ownershipEpoch: Number(message.payload?.ownershipEpoch ?? 0),
          ownershipSessionId: String(message.payload?.ownershipSessionId ?? ""),
          paneLineageId: String(message.payload?.paneLineageId ?? ""),
          ...(message.payload?.display
            ? {
                displayProvenance: structuredClone(message.payload.display.provenance ?? null),
                displaySenderName: typeof message.payload.display.senderDisplayName === "string" ? message.payload.display.senderDisplayName : null,
                displayTitle: typeof message.payload.display.title === "string" ? message.payload.display.title : null,
              }
            : {}),
          restoreReason: String(message.payload?.restoreReason ?? ""),
          targetHeader: structuredClone(message.payload?.targetHeader),
          targetId: String(message.payload?.targetId ?? ""),
          targetKind: String(message.payload?.targetKind ?? ""),
          targetPayload: structuredClone(message.payload?.targetPayload),
        });
        if (this.targetApplyDelayMs > 0) {
          await delay(this.targetApplyDelayMs);
        }
        if (this.targetApplyErrorCode && this.targetApplyErrorResponsesRemaining > 0) {
          if (Number.isFinite(this.targetApplyErrorResponsesRemaining)) {
            this.targetApplyErrorResponsesRemaining -= 1;
          }
          socket.send(
            JSON.stringify(
              this.errorResponse(message.id, "target.apply", this.targetApplyErrorCode, "target apply failed"),
            ),
          );
          return;
        }
        if (this.targetApplyResultErrorCode) {
          socket.send(
            JSON.stringify(
              this.response(message.id, "target.apply.result", {
                appliedAt: new Date().toISOString(),
                errorCode: this.targetApplyResultErrorCode,
                message: "target.apply ownershipEpoch does not match the active session",
                paneLineageId: String(message.payload?.paneLineageId ?? ""),
                requestId: String(message.payload?.requestId ?? message.id),
                status: "rejected",
                targetEpoch: Number(message.payload?.targetEpoch ?? 0),
                targetId: String(message.payload?.targetId ?? ""),
              }),
            ),
          );
          return;
        }
        let nativeHostPaneId: number | undefined;
        if (isNativeHostTargetKind(String(message.payload?.targetKind ?? ""))) {
          const targetSurface = this.requirePairedSurface(socket);
          const pane = [...targetSurface.panes.values()].find((candidate) =>
            candidate.paneLineageId === message.payload?.paneLineageId
          );
          if (pane) {
            nativeHostPaneId = [...targetSurface.panes.entries()].find(([, candidate]) => candidate === pane)?.[0];
            pane.contentId = null;
            pane.contentType = null;
            pane.externalNative = true;
          }
        }
        const targetPayload = message.payload?.targetPayload && typeof message.payload.targetPayload === "object"
          ? message.payload.targetPayload as Record<string, unknown>
          : {};
        const targetKind = String(message.payload?.targetKind ?? "");
        const env = targetPayload.env && typeof targetPayload.env === "object" && !Array.isArray(targetPayload.env)
          ? targetPayload.env as Record<string, unknown>
          : undefined;
        const responsePayload = {
          appliedAt: new Date().toISOString(),
          materializedState: isNativeHostTargetKind(targetKind)
            ? {
                inputFocus: "ready",
                lifecycle: "running",
                nativeHost: "applied",
                nativeTarget: {
                  ...(typeof targetPayload.appId === "string" ? { appId: targetPayload.appId } : {}),
                  ...(Array.isArray(targetPayload.args) ? { args: targetPayload.args } : {}),
                  ...(typeof targetPayload.command === "string" ? { command: targetPayload.command } : {}),
                  ...(typeof targetPayload.cwd === "string" ? { cwd: targetPayload.cwd } : {}),
                  ...(env ? { envDigest: stableStringRecordDigest(env), envKeys: Object.keys(env).sort() } : {}),
                  ...(typeof targetPayload.launchMode === "string" ? { launchMode: targetPayload.launchMode } : {}),
                  targetKind,
                },
                overlayRegions: "applied",
                proof: {
                  ...(typeof targetPayload.appId === "string" ? { appId: targetPayload.appId } : {}),
                  ...(Array.isArray(targetPayload.args) ? { args: targetPayload.args } : { args: [] }),
                  contentId: this.nativeTargetProofContentIdOverride === undefined
                    ? String(message.payload?.targetId ?? "")
                    : this.nativeTargetProofContentIdOverride,
                  ...(typeof targetPayload.cwd === "string" ? { cwd: targetPayload.cwd } : {}),
                  envDigest: stableStringRecordDigest(env) ?? stableStringRecordDigest({})!,
                  launchMode: typeof targetPayload.launchMode === "string" ? targetPayload.launchMode : "new_instance",
                  paneId: this.nativeTargetProofPaneIdOverride === undefined
                    ? String(nativeHostPaneId ?? "")
                    : this.nativeTargetProofPaneIdOverride,
                },
              }
            : targetKind === "browser_url" && typeof targetPayload.url === "string"
              ? this.browserUrlMaterializedStateOverride === undefined
                ? {
                  navigationStatus: "loaded",
                  replaySemantics: "navigate",
                  url: targetPayload.url,
                }
                : this.browserUrlMaterializedStateOverride
              : { paneLineageId: String(message.payload?.paneLineageId ?? "") },
          paneLineageId: String(message.payload?.paneLineageId ?? ""),
          requestId: String(message.payload?.requestId ?? message.id),
          status: "applied",
          targetEpoch: Number(message.payload?.targetEpoch ?? 0),
          targetId: String(message.payload?.targetId ?? ""),
        };
        if (targetKind === "browser_url") {
          const targetSurface = this.requirePairedSurface(socket);
          const pane = [...targetSurface.panes.values()].find((candidate) =>
            candidate.paneLineageId === message.payload?.paneLineageId
          );
          if (pane) {
            pane.contentId = null;
            pane.contentType = null;
            pane.currentTarget = {
              currentState: "current",
              lastApplyEvidence: structuredClone(responsePayload),
              paneLineageId: String(message.payload?.paneLineageId ?? ""),
              restorePolicy: "auto",
              targetEpoch: Number(message.payload?.targetEpoch ?? 0),
              targetHeader: structuredClone(message.payload?.targetHeader),
              targetId: String(message.payload?.targetId ?? ""),
              targetKind,
              targetPayload: structuredClone(targetPayload),
            };
          }
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "target.apply.result", responsePayload),
          ),
        );
        return;
      }
      case "panes.list": {
        this.panesListRequests += 1;
        if (this.panesListErrorCode) {
          socket.send(
            JSON.stringify(
              this.errorResponse(message.id, "panes.list", this.panesListErrorCode, "panes.list failed"),
            ),
          );
          return;
        }
        const targetSurface = this.requirePairedSurface(socket);
        socket.send(
          JSON.stringify(
            this.response(message.id, "panes.list", {
              panes: [...targetSurface.panes.entries()].map(([paneId, pane]) => {
                const paneState: Record<string, unknown> = {
                  activeContentId: pane.contentId,
                  contentType: pane.contentType,
                  ...(pane.currentTarget ? { currentTarget: structuredClone(pane.currentTarget) } : {}),
                  ...(pane.display ? { display: structuredClone(pane.display) } : {}),
                  externalNative: pane.externalNative ?? false,
                  geometry: this.paneGeometry(targetSurface, paneId, pane),
                  name: pane.name,
                  ...(pane.nativeWindowGroup ? { nativeWindowGroup: structuredClone(pane.nativeWindowGroup) } : {}),
                  paneId,
                  paneLineageId: pane.paneLineageId,
                  viewport: {
                    height: pane.frame.height,
                    scale: pane.viewport.scale,
                    width: pane.frame.width,
                  },
                };
                if (!this.omitPanesListPaneLabel) {
                  paneState.paneLabel = pane.paneLabel;
                }
                return paneState;
              }),
            }),
          ),
        );
        return;
      }
      case "snapshot.get": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
        assert.ok(pane);
        this.snapshotRequests.push({
          includeImage: Boolean(message.payload?.includeImage),
          includeVisibleText: Boolean(message.payload?.includeVisibleText),
          paneId,
        });
        if (this.snapshotDelayMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, this.snapshotDelayMs);
          });
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "snapshot.get", {
              contentId: pane.contentId,
              contentType: pane.contentType,
              drawings: pane.drawings.map((strokeId) => ({
                points: [],
                strokeId,
              })),
              image: this.snapshotImage,
              paneId,
              revision: pane.revision,
              selection: null,
              viewport: {
                contentSize: { height: 768, width: 1024 },
                scrollOffset: { ...this.snapshotScrollOffset },
                visibleRect: { height: 768, width: 1024, x: 0, y: 0 },
                zoomLevel: 1,
              },
              visibleText: pane.contentId ? "Visible text" : "",
            }),
          ),
        );
        return;
      }
      case "content.set": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
        assert.ok(pane);
        pane.contentId = String(message.payload?.contentId);
        pane.contentType = String(message.payload?.contentType);
        pane.display = message.payload?.display ? structuredClone(message.payload.display) : undefined;
        pane.externalNative = false;
        pane.revision = Number(message.payload?.revision ?? pane.revision + 1);
        pane.drawings = [];
        this.contentSetRequests.push({
          content: structuredClone(message.payload?.content),
          contentId: pane.contentId,
          contentType: pane.contentType,
          displayProvenance: structuredClone(message.payload?.display?.provenance ?? null),
          displaySenderName: typeof message.payload?.display?.senderDisplayName === "string" ? message.payload.display.senderDisplayName : null,
          displayTitle: typeof message.payload?.display?.title === "string" ? message.payload.display.title : null,
          historyOwnerToken: String(message.payload?.historyOwnerToken ?? ""),
          paneId,
          revision: pane.revision,
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "content.set", {
              contentId: pane.contentId,
              contentType: pane.contentType,
              currentContentId: pane.contentId,
              currentRevision: pane.revision,
              paneId,
              paneLabel: pane.paneLabel,
            }),
          ),
        );
        return;
      }
      case "content.clear": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
        assert.ok(pane);
        pane.contentId = null;
        pane.contentType = null;
        pane.display = undefined;
        pane.drawings = [];
        pane.externalNative = false;
        pane.revision = Number(message.payload?.revision ?? pane.revision + 1);
        this.clearRequests.push({
          paneId,
          revision: pane.revision,
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "content.clear", {
              contentId: null,
              currentContentId: null,
              currentRevision: pane.revision,
              paneId,
              paneLabel: pane.paneLabel,
            }),
          ),
        );
        return;
      }
      case "pane.split": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const sourcePane = targetSurface.panes.get(paneId);
        assert.ok(sourcePane);
        if (this.dropNextSplitRequest) {
          this.dropNextSplitRequest = false;
          socket.close();
          return;
        }
        const newPaneIds = Array.isArray(message.payload?.newPaneIds)
          ? message.payload.newPaneIds.map((value) => Number(value))
          : [];
        const newPaneLabels = Array.isArray(message.payload?.newPaneLabels)
          ? message.payload.newPaneLabels.map((value) => Number(value))
          : [];
        this.splitRequests.push({
          count: Number(message.payload?.count ?? 0),
          direction: String(message.payload?.direction ?? ""),
          newPaneIds,
          newPaneLabels,
          paneId,
        });
        const splitDirection = String(message.payload?.direction ?? "");
        const splitCount = newPaneIds.length + 1;
        const sourceFrame = { ...sourcePane.frame };
        const sourceViewport = { ...sourcePane.viewport };
        if (splitDirection === "horizontal") {
          const height = sourceFrame.height / splitCount;
          sourcePane.frame = { ...sourceFrame, height };
          sourcePane.viewport = { ...sourceViewport, height };
        } else {
          const width = sourceFrame.width / splitCount;
          sourcePane.frame = { ...sourceFrame, width };
          sourcePane.viewport = { ...sourceViewport, width };
        }
        for (const [index, newPaneId] of newPaneIds.entries()) {
          const segmentIndex = index + 1;
          const frame = splitDirection === "horizontal"
            ? {
                height: sourcePane.frame.height,
                width: sourceFrame.width,
                x: sourceFrame.x,
                y: sourceFrame.y + sourcePane.frame.height * segmentIndex,
              }
            : {
                height: sourceFrame.height,
                width: sourcePane.frame.width,
                x: sourceFrame.x + sourcePane.frame.width * segmentIndex,
                y: sourceFrame.y,
              };
          targetSurface.panes.set(newPaneId, {
            contentId: null,
            contentType: null,
            drawings: [],
            frame,
            name: null,
            paneLabel: newPaneLabels[index] ?? newPaneId,
            revision: 0,
            viewport: {
              height: frame.height,
              scale: sourcePane.viewport.scale,
              width: frame.width,
            },
          });
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "pane.split", {
              panes: [...targetSurface.panes.keys()].map((currentPaneId) => ({
                paneId: currentPaneId,
                paneLabel: targetSurface.panes.get(currentPaneId)?.paneLabel ?? currentPaneId,
              })),
            }),
          ),
        );
        return;
      }
      case "pane.close": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        assert.ok(targetSurface.panes.has(paneId));
        if (targetSurface.panes.size === 1) {
          socket.send(
            JSON.stringify({
              error: {
                code: "invalid_operation",
                message: "Cannot close the last remaining pane.",
              },
              id: message.id,
              ok: false,
              op: "pane.close",
              sentAt: Date.now(),
              type: "response",
              v: 1,
            }),
          );
          return;
        }
        targetSurface.panes.delete(paneId);
        this.closePaneRequests.push({ paneId });
        socket.send(
          JSON.stringify(
            this.response(message.id, "pane.close", {
              closedFramesDiscarded: 0,
              paneId,
            }),
          ),
        );
        return;
      }
      case "annotations.remove": {
        const targetSurface = this.requirePairedSurface(socket);
        const paneId = Number(message.payload?.paneId ?? 0);
        const pane = targetSurface.panes.get(paneId);
        assert.ok(pane);
        const strokeIds = Array.isArray(message.payload?.strokeIds)
          ? message.payload.strokeIds.map((value) => String(value))
          : [];
        const removedStrokeIds = strokeIds.filter((strokeId) => pane.drawings.includes(strokeId));
        pane.drawings = pane.drawings.filter((strokeId) => !removedStrokeIds.includes(strokeId));
        this.annotationsRemoveRequests.push({
          contentId: String(message.payload?.contentId ?? ""),
          paneId,
          strokeIds,
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "annotations.remove", {
              contentId: pane.contentId,
              notFoundStrokeIds: strokeIds.filter((strokeId) => !removedStrokeIds.includes(strokeId)),
              paneId,
              remainingStrokeCount: pane.drawings.length,
              removedStrokeIds,
            }),
          ),
        );
        return;
      }
      case "heartbeat.ping":
        this.heartbeatRequests += 1;
        socket.send(
          JSON.stringify(
            this.response(message.id, "heartbeat.ping", {
              nonce: message.payload?.nonce,
            }),
          ),
        );
        return;
      case "authority.state":
        this.authorityStateRequests.push({
          actionable: (message.payload?.actionable as boolean | undefined) === true,
          paneIds: Array.isArray(message.payload?.panes)
            ? message.payload.panes.map((pane) => Number((pane as { paneId?: unknown }).paneId ?? 0))
            : [],
          paneLabels: Array.isArray(message.payload?.panes)
            ? message.payload.panes.map((pane) => Number((pane as { paneLabel?: unknown }).paneLabel ?? 0))
            : [],
          reason: typeof message.payload?.reason === "string" ? message.payload.reason : null,
          surfaceId: String(message.payload?.surfaceId ?? ""),
          windowLabel: String(message.payload?.windowLabel ?? ""),
        });
        socket.send(
          JSON.stringify(
            this.response(message.id, "authority.state", {
              accepted: (message.payload?.actionable as boolean | undefined) === true && !this.rejectAuthorityState,
              reason: this.rejectAuthorityState ? this.rejectAuthorityStateReason : null,
            }),
          ),
        );
        return;
      case "ownership.relinquish": {
        const pairedSurfaceId = this.socketSurfaceIds.get(socket);
        if (pairedSurfaceId) {
          this.pairedSocketsBySurfaceId.delete(pairedSurfaceId);
          this.socketSurfaceIds.delete(socket);
          if (pairedSurfaceId === this.surfaceId) {
            this.pairedSocket = null;
          }
        }
        socket.send(
          JSON.stringify(
            this.response(message.id, "ownership.relinquish", {
              relinquished: true,
            }),
          ),
        );
        socket.close(1000, "relinquished");
        return;
      }
      default:
        throw new Error(`Unhandled op in test server: ${message.op}`);
    }
  }

  private response(id: string, op: string, payload: Record<string, unknown>) {
    return {
      id,
      ok: true,
      op,
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private paneGeometry(surface: TestSurfaceState, paneId: number, pane: TestPane) {
    const topologyEpoch = this.topologyApplyRequests.at(-1)?.topologyRevision ?? 0;
    const contentViewport = { ...pane.frame };
    return {
      contentViewport,
      coordinateSpace: "surface_logical",
      geometryRevision: topologyEpoch + 2,
      paneFrame: { ...pane.frame },
      paneId,
      paneInstanceId: `pl_${surface.surfaceId}_${paneId}`,
      protocolViewport: {
        coordinateSpace: "protocol_viewport",
        rect: { ...pane.frame },
        viewport: {
          height: pane.frame.height,
          scale: pane.viewport.scale,
          width: pane.frame.width,
        },
      },
      safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 },
      scale: pane.viewport.scale,
      splitSpacingInsets: { bottom: 0, left: 0, right: 0, top: 0 },
      surfaceBounds: {
        height: surface.viewport.height,
        width: surface.viewport.width,
        x: 0,
        y: 0,
      },
      surfaceEpoch: `${surface.surfaceId}:1`,
      topologyEpoch,
    };
  }

  private applyTopologyFrames(surface: TestSurfaceState, layout: unknown): void {
    const assign = (node: unknown, rect: { height: number; width: number; x: number; y: number }): void => {
      if (!node || typeof node !== "object") {
        return;
      }
      const record = node as Record<string, unknown>;
      if (record.type === "pane") {
        const paneId = Number(record.paneId ?? 0);
        const pane = surface.panes.get(paneId);
        if (!pane) {
          return;
        }
        pane.frame = { ...rect };
        pane.viewport = {
          height: rect.height,
          scale: surface.viewport.scale,
          width: rect.width,
        };
        return;
      }
      if (record.type !== "split" || !Array.isArray(record.children) || record.children.length === 0) {
        return;
      }
      const children = record.children;
      const weights = children.map((child) => {
        if (!child || typeof child !== "object") {
          return 1;
        }
        const weight = Number((child as Record<string, unknown>).weight ?? 1);
        return Number.isFinite(weight) && weight > 0 ? weight : 1;
      });
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      if (record.direction === "horizontal") {
        let y = rect.y;
        children.forEach((child, index) => {
          const height = rect.height * (weights[index] / totalWeight);
          assign(child, { height, width: rect.width, x: rect.x, y });
          y += height;
        });
        return;
      }
      let x = rect.x;
      children.forEach((child, index) => {
        const width = rect.width * (weights[index] / totalWeight);
        assign(child, { height: rect.height, width, x, y: rect.y });
        x += width;
      });
    };

    assign(layout, {
      height: surface.viewport.height,
      width: surface.viewport.width,
      x: 0,
      y: 0,
    });
  }

  private errorResponse(
    id: string,
    op: string,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    return {
      error: {
        code,
        ...(details ? { details } : {}),
        message,
      },
      id,
      ok: false,
      op,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("wait_for_timeout");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

let nextPort = 22000 + Math.floor(Math.random() * 10000);

function discoveryEndpoint(port: number, fingerprintPrefix = "abcd1234"): SurfAceDiscoveryEndpoint {
  return {
    busy: false,
    capabilitiesBitmask: 31,
    endpointId: `endpoint-${port}`,
    fingerprintPrefix,
    host: "127.0.0.1",
    instanceName: "Test Surface",
    lastSeenAt: Date.now(),
    name: "Test Surface",
    port,
    protocolVersion: 1,
    viewport: { height: 768, scale: 2, width: 1024 },
    wsPath: "/ws",
  };
}

function persistedLocalOwnership(input: {
  endpointHost?: string;
  endpointId?: string;
  endpointName?: string;
  endpointPort?: number;
  providerId: string;
  sessionId: string;
  surfaceId: string;
}) {
  return {
    acceptedAt: Date.now(),
    endpointHost: input.endpointHost ?? "127.0.0.1",
    endpointId: input.endpointId ?? "endpoint-before-provider-restart",
    endpointName: input.endpointName ?? "Test Surface",
    endpointPort: input.endpointPort ?? 0,
    providerId: input.providerId,
    sessionId: input.sessionId,
    source: "pair.response",
    surfaceId: input.surfaceId,
  };
}

async function withRuntimeHarness(
  optionsOrRun:
    | ((
        ctx: {
          alertBodies: Array<Record<string, unknown>>;
          annotationTurns: import("./surf-ace-runtime.js").SurfAceAnnotationIntentTurn[];
          discovery: StaticDiscoveryService;
          infos: string[];
          warnings: string[];
          runtime: ReturnType<typeof createSurfAceRuntime>;
          server: FakeSurfAceWsServer;
          stateDir: string;
        },
      ) => Promise<void>)
    | {
        configureServer?: (server: FakeSurfAceWsServer) => void;
        now?: () => number;
        providerProcessHealth?: SurfAceRuntimeOptions["providerProcessHealth"];
        providerName?: string;
        waitForAuthority?: boolean;
        waitForPair?: boolean;
        run: (ctx: {
          alertBodies: Array<Record<string, unknown>>;
          annotationTurns: import("./surf-ace-runtime.js").SurfAceAnnotationIntentTurn[];
          discovery: StaticDiscoveryService;
          infos: string[];
          warnings: string[];
          runtime: ReturnType<typeof createSurfAceRuntime>;
          server: FakeSurfAceWsServer;
          stateDir: string;
        }) => Promise<void>;
      },
): Promise<void> {
  const options =
    typeof optionsOrRun === "function"
      ? {
          configureServer: undefined,
          providerProcessHealth: undefined,
          run: optionsOrRun,
          now: undefined,
          providerName: undefined,
          waitForPair: true,
        }
      : optionsOrRun;
  const port = nextPort++;
  const server = new FakeSurfAceWsServer(port);
  options.configureServer?.(server);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-"));
  const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
  const infos: string[] = [];
  const warnings: string[] = [];
  const annotationTurns: import("./surf-ace-runtime.js").SurfAceAnnotationIntentTurn[] = [];
  const runtime = createSurfAceRuntime({
    deliverSettledAnnotationTurn: async (turn) => {
      annotationTurns.push(structuredClone(turn));
    },
    discovery,
    logger: {
      info: (message: string) => {
        infos.push(message);
      },
      warn: (message: string) => {
        warnings.push(message);
      },
    },
    now: options.now,
    providerProcessHealth: options.providerProcessHealth,
    providerName: options.providerName,
    stateDir,
  });
  const alertBodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (_input, init) => {
      alertBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await runtime.start();
    if (options.waitForPair !== false) {
      await waitFor(() => server.pairedSocket !== null);
      if (options.waitForAuthority !== false) {
        await waitFor(() => server.authorityStateRequests.some((request) => request.actionable === true));
      }
    }
    await options.run({ alertBodies, annotationTurns, discovery, infos, runtime, server, stateDir, warnings });
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.stop();
    await server.close();
    await fs.rm(stateDir, { force: true, recursive: true });
  }
}

function removeDurableSelfAuthority(runtime: unknown, surface: any, surfaceId: string): void {
  const internalRuntime = runtime as any;
  internalRuntime.markSelfOwnedSurfaceRelinquished(surfaceId);
  delete internalRuntime.persistentState.selfOwnedSurfaceIds?.[surfaceId];
  surface.hasPairedInGatewaySession = false;
  surface.sessionId = null;
  surface.localOwnership = null;
}

test("pane capture requests fresh rendered image and returns visual oracle metadata", async () => {
  await withRuntimeHarness({
    now: () => 1_777_000,
    run: async ({ runtime, server }) => {
      const screen = (await runtime.listScreens())[0];
      const paneId = screen?.panes[0]?.paneId;
      assert.ok(paneId);

      const pushed = await runtime.push({
        content: "<main>capture-marker-t272</main>",
        contentType: "html",
        fingerprint: server.surfaceId,
        paneId,
      });

      server.snapshotImage = "cG5nLWJ5dGVz";
      const result = await runtime.capturePane({ fingerprint: server.surfaceId, paneId });

      assert.deepEqual(server.snapshotRequests.at(-1), {
        includeImage: true,
        includeVisibleText: true,
        paneId: server.initialRemotePaneId,
      });
      assert.equal(result.capture.bytesBase64, "cG5nLWJ5dGVz");
      assert.equal(result.capture.failureReason, null);
      assert.equal(result.capture.fingerprint, server.surfaceId);
      assert.equal(result.capture.windowLabel, "a");
      assert.equal(result.capture.paneId, paneId);
      assert.equal(result.capture.paneLabel, 1);
      assert.equal(result.capture.topologyRevision, 0);
      assert.equal(result.capture.visibleContentId, pushed.contentId);
      assert.equal(result.capture.contentType, "html");
      assert.deepEqual(result.capture.dimensions, { height: 768, width: 1024 });
      assert.equal(result.capture.scale, 2);
      assert.equal(result.capture.capturedAt, 1_777_000);
    },
  });
});

test("pane capture returns failure metadata when client cannot provide image bytes", async () => {
  await withRuntimeHarness({
    configureServer: (server) => {
      server.snapshotImage = "";
    },
    run: async ({ runtime, server }) => {
      const screen = (await runtime.listScreens())[0];
      const paneId = screen?.panes[0]?.paneId;
      assert.ok(paneId);

      const result = await runtime.capturePane({ fingerprint: server.surfaceId, paneId });

      assert.equal(result.capture.bytesBase64, null);
      assert.equal(result.capture.failureReason, "client returned no rendered image for pane capture");
      assert.equal(result.capture.fingerprint, server.surfaceId);
      assert.equal(result.capture.windowLabel, "a");
      assert.equal(result.capture.paneId, paneId);
      assert.equal(result.capture.paneLabel, 1);
    },
  });
});

test("pane capture fails closed when authority changes during capture", async () => {
  await withRuntimeHarness({
    configureServer: (server) => {
      server.snapshotDelayMs = 50;
    },
    run: async ({ runtime, server }) => {
      const screen = (await runtime.listScreens())[0];
      const paneId = screen?.panes[0]?.paneId;
      assert.ok(paneId);

      const initialSnapshotRequestCount = server.snapshotRequests.length;
      const capture = runtime.capturePane({ fingerprint: server.surfaceId, paneId });
      await waitFor(() => server.snapshotRequests.length > initialSnapshotRequestCount);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      surface.connectionState = "unreachable";

      await assert.rejects(
        capture,
        /Surf Ace authority changed during capture; refresh surf_ace_list and retry\./,
      );
    },
  });
});

function assertAnnotationAlertBody(
  body: Record<string, unknown>,
  params: {
    image: string;
    message: string;
    paneId: string | number;
    sessionKey: string;
    surfaceId: string;
  },
): void {
  assert.equal(body.message, params.message);
  assert.equal(body.noOverlay, true);
  assert.equal(body.sessionKey, params.sessionKey);
  assert.ok(Array.isArray(body.attachments));
  assert.equal(body.attachments.length, 1);
  const [attachment] = body.attachments as Array<Record<string, unknown>>;
  assert.equal(attachment.type, "file");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.content, params.image);
  assert.equal(typeof attachment.fileName, "string");
  assert.match(
    String(attachment.fileName),
    new RegExp(`^surf-ace-${params.surfaceId}-pane-${params.paneId}-.+\\.png$`),
  );
}

function assertOpaquePaneId(paneId: unknown): asserts paneId is string {
  assert.equal(typeof paneId, "string");
  assert.match(paneId, /^pn_[0-9a-f]{32}$/);
}

function paneByLabel(
  screen: { panes: Array<{ paneId: string; paneLabel: number }> } | undefined,
  paneLabel: number,
): { paneId: string; paneLabel: number } {
  assert.ok(screen);
  const pane = screen.panes.find((candidate) => candidate.paneLabel === paneLabel);
  assert.ok(pane);
  assertOpaquePaneId(pane.paneId);
  return pane;
}

async function livePaneId(
  runtime: ReturnType<typeof createSurfAceRuntime>,
  fingerprint: string,
  paneLabel: number,
): Promise<string> {
  const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === fingerprint);
  return paneByLabel(screen, paneLabel).paneId;
}

function assertPaneLabelsWithOpaqueIds(
  panes: Array<{ paneId: string; paneLabel: number }>,
  expectedPaneLabels: number[],
): string[] {
  const paneIds = panes.map((pane) => {
    assertOpaquePaneId(pane.paneId);
    return pane.paneId;
  });
  assert.deepEqual(panes.map((pane) => pane.paneLabel), expectedPaneLabels);
  assert.equal(new Set(paneIds).size, paneIds.length);
  return paneIds;
}

function isNativeHostTargetKind(targetKind: string): boolean {
  return targetKind === "terminal_app" || targetKind === "native_app" || targetKind === "compositor_app";
}

function targetRegistrationOwnership(
  runtime: ReturnType<typeof createSurfAceRuntime>,
  surfaceId: string,
  paneId: string,
): { launchedAt: string; ownershipEpoch: number; ownershipSessionId: string; paneLineageId: string } {
  const surface = (runtime as any).surfaces.get(surfaceId);
  assert.ok(surface);
  const pane = surface.panes.get(paneId);
  assert.ok(pane);
  return {
    launchedAt: new Date().toISOString(),
    ownershipEpoch: surface.ownershipEpoch,
    ownershipSessionId: surface.sessionId,
    paneLineageId: pane.paneLineageId,
  };
}

test("surf ace runtime defaults to the OpenClaw extension state root", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  try {
    process.env.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), "openclaw-state-root");
    assert.equal(
      resolveDefaultSurfAceStateDir(),
      path.join(process.env.OPENCLAW_STATE_DIR, "extensions", "surf-ace"),
    );

    delete process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_HOME = path.join(os.tmpdir(), "openclaw-home-root");
    assert.equal(
      resolveDefaultSurfAceStateDir(),
      path.join(process.env.OPENCLAW_HOME, ".openclaw", "extensions", "surf-ace"),
    );

    const injectedRoot = path.join(os.tmpdir(), "openclaw-injected-state-root");
    const runtime = createSurfAceRuntime({ openClawStateDir: injectedRoot });
    assert.equal((runtime as any).stateDir, path.join(injectedRoot, "extensions", "surf-ace"));
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
  }
});

test("restore flight recorder correlates pair attempt with pulled Spatial recorder artifact", async () => {
  await withRuntimeHarness(async ({ runtime, server }) => {
    await waitFor(() => server.pairAttemptDetails.length > 0 && server.flightRecorderRequests.length > 0, 12_000);
    const restoreAttemptId = server.pairAttemptDetails[0]?.restoreAttemptId;
    assert.match(restoreAttemptId ?? "", /^ra_[0-9a-f]{16}$/);
    assert.equal(server.flightRecorderRequests[0]?.restoreAttemptId, restoreAttemptId);
    assert.equal(server.flightRecorderRequests[0]?.maxLines, 240);

    const artifactPath = path.join(
      "/tmp",
      "surf-ace",
      "restore-flight-recorder",
      `${restoreAttemptId}-${server.surfaceId}.json`,
    );
    await waitFor(async () => {
      try {
        await fs.access(artifactPath);
        return true;
      } catch {
        return false;
      }
    }, 12_000);
    const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8"));
    assert.equal(artifact.restoreAttemptId, restoreAttemptId);
    assert.equal(artifact.providerSurface.surfaceId, server.surfaceId);
    assert.equal(artifact.providerDecision.pairPaneCount, 1);
    assert.deepEqual(artifact.spatialFlightRecorder.lines, server.flightRecorderLines);
  });
});

test("pair current browser_url target survives provider target hydration", async () => {
  await withRuntimeHarness({
    configureServer: (server) => {
      server.targetCapabilities = [
        ...server.targetCapabilities,
        "target.browser_url.v1",
      ];
      const serverPane = server.panes.get(server.initialRemotePaneId);
      assert.ok(serverPane);
      serverPane.revision = 3;
      serverPane.currentTarget = clientBrowserUrlTarget({
        paneLineageId: serverPane.paneLineageId,
        targetEpoch: 3,
        targetId: "tg_pair_after_hydrate",
        url: "https://pair-after-hydrate.example/",
      });
    },
    waitForPair: false,
    run: async ({ runtime, server }) => {
      const serverPane = server.panes.get(server.initialRemotePaneId);
      assert.ok(serverPane);
      const internalRuntime = runtime as any;
      internalRuntime.persistentState.targetStateBySurfaceId = {
        [server.surfaceId]: {
          paneTargets: {
            [serverPane.paneLineageId]: {
              currentTargetId: "tg_pair_after_hydrate",
              diagnosticContent: null,
              lastRestoreBlockedReason: null,
              nonDurableTargetDiagnostic: null,
              paneLineageId: serverPane.paneLineageId,
              targetEpoch: 1,
            },
          },
          registeredTargetIdsByIdempotencyKey: {},
          targetRecords: [{
            appliedAt: new Date(Date.now() - 120_000).toISOString(),
            currentState: "current",
            ownerProviderId: internalRuntime.persistentState.providerId,
            ownershipEpoch: 1,
            ownershipSessionId: "sa_test_session",
            paneIdAtApply: "pn_stale_pair_after_hydrate",
            paneLabelAtApply: 1,
            paneLineageId: serverPane.paneLineageId,
            restorePolicy: "auto",
            surfaceId: server.surfaceId,
            surfaceInstanceId: null,
            targetEpoch: 1,
            targetHeader: structuredClone(serverPane.currentTarget.targetHeader),
            targetId: "tg_pair_after_hydrate",
            targetKind: "browser_url",
            targetPayload: structuredClone(serverPane.currentTarget.targetPayload),
          }],
        },
      };
      await waitFor(() => server.pairedSocket !== null);
      await waitFor(() => server.authorityStateRequests.some((request) => request.actionable === true));

      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      const pane = paneByLabel(screen, 1);
      assert.equal(pane?.target?.targetKind, "browser_url");
      assert.equal(pane?.target?.targetPayload.url, "https://pair-after-hydrate.example/");
      const read = await runtime.read({ fingerprint: server.surfaceId, paneId: pane.paneId });
      assert.equal(read.browserUrl?.url, "https://pair-after-hydrate.example/");
    },
  });
});

test("surf ace runtime creates durable provider identity and reuses it across state-root migrations", async () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const openClawHome = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-openclaw-home-"));
  const stateRootA = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-state-root-a-"));
  const stateRootB = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-state-root-b-"));
  process.env.OPENCLAW_HOME = openClawHome;
  delete process.env.OPENCLAW_STATE_DIR;
  const runtimeA = createSurfAceRuntime({
    discovery: new StaticDiscoveryService([]),
    openClawStateDir: stateRootA,
  });

  try {
    await runtimeA.start();
    await runtimeA.stop();

    const identityPath = path.join(
      openClawHome,
      ".openclaw",
      "extensions",
      "surf-ace",
      "surf-ace-provider-identity.json",
    );
    const firstIdentity = JSON.parse(await fs.readFile(identityPath, "utf8")) as { providerId: string };
    assert.match(firstIdentity.providerId, /^pv_[0-9a-f]{32}$/);

    const runtimeB = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      openClawStateDir: stateRootB,
    });
    await runtimeB.start();
    await runtimeB.stop();

    const migratedState = JSON.parse(
      await fs.readFile(
        path.join(stateRootB, "extensions", "surf-ace", "surf-ace-runtime-state.json"),
        "utf8",
      ),
    ) as { providerId: string };
    assert.equal(migratedState.providerId, firstIdentity.providerId);
  } finally {
    await runtimeA.stop().catch(() => {});
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    await fs.rm(openClawHome, { force: true, recursive: true });
    await fs.rm(stateRootA, { force: true, recursive: true });
    await fs.rm(stateRootB, { force: true, recursive: true });
  }
});

test("surf ace runtime prefers existing durable provider identity over migrated runtime state", async () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const openClawHome = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-openclaw-home-"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-state-root-"));
  const durableProviderId = "pv_d0000000000000000000000000000001";
  process.env.OPENCLAW_HOME = openClawHome;
  delete process.env.OPENCLAW_STATE_DIR;

  try {
    const identityDir = path.join(openClawHome, ".openclaw", "extensions", "surf-ace");
    await fs.mkdir(identityDir, { recursive: true });
    await fs.writeFile(
      path.join(identityDir, "surf-ace-provider-identity.json"),
      JSON.stringify({ providerId: durableProviderId, version: 1 }, null, 2),
    );
    const stateDir = path.join(stateRoot, "extensions", "surf-ace");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "surf-ace-runtime-state.json"),
      JSON.stringify(
        {
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
	          paneLabelsByPaneId: {},
	          providerLineage: [
	            {
	              providerId: "pv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	              source: "legacy_state_root",
	            },
	          ],
	          providerId: "pv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	          selfOwnedSurfaceIds: {
	            sf_rotated_current_snapshot: {
	              providerId: "pv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	              source: "legacy_local_ownership",
	            },
	          },
	          version: 1,
	          windowLabels: {},
	        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(stateDir, "surf-ace-runtime-screens.json"),
      JSON.stringify(
        {
          screens: [
            {
              _debug: {
                hasPairedInGatewaySession: true,
                localOwnership: {
                  providerId: "pv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  sessionId: "sa_rotated_current_snapshot",
                  source: "pair.response",
                  surfaceId: "sf_rotated_current_snapshot",
                },
                sessionId: "sa_rotated_current_snapshot",
              },
              fingerprint: "sf_rotated_current_snapshot",
              panes: [],
            },
          ],
          updatedAt: Date.now(),
          version: 1,
        },
        null,
        2,
      ),
    );

    const runtime = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      openClawStateDir: stateRoot,
    });
    await runtime.start();
    await runtime.stop();

    const reconciledState = JSON.parse(
      await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
    ) as {
      providerId: string;
      providerLineage?: Array<{ providerId: string; source: string }>;
      selfOwnedSurfaceIds?: Record<string, { providerId: string; source: string }>;
    };
    assert.equal(reconciledState.providerId, durableProviderId);
    assert.equal(
      reconciledState.providerLineage?.some((entry) =>
        entry.providerId === "pv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      false,
    );
    assert.equal(reconciledState.selfOwnedSurfaceIds?.sf_rotated_current_snapshot, undefined);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    await fs.rm(openClawHome, { force: true, recursive: true });
    await fs.rm(stateRoot, { force: true, recursive: true });
  }
});

test("surf ace runtime repairs malformed durable provider identity from known local state", async () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const openClawHome = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-openclaw-home-"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-state-root-"));
  const stateProviderId = "pv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  process.env.OPENCLAW_HOME = openClawHome;
  delete process.env.OPENCLAW_STATE_DIR;

  try {
    const identityDir = path.join(openClawHome, ".openclaw", "extensions", "surf-ace");
    await fs.mkdir(identityDir, { recursive: true });
    await fs.writeFile(
      path.join(identityDir, "surf-ace-provider-identity.json"),
      JSON.stringify({ providerId: "Aleph", version: 1 }, null, 2),
    );
    const stateDir = path.join(stateRoot, "extensions", "surf-ace");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "surf-ace-runtime-state.json"),
      JSON.stringify(
        {
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId: stateProviderId,
          version: 1,
          windowLabels: {},
        },
        null,
        2,
      ),
    );

    const runtime = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      openClawStateDir: stateRoot,
    });
    await runtime.start();
    await runtime.stop();

    const repairedIdentity = JSON.parse(
      await fs.readFile(path.join(identityDir, "surf-ace-provider-identity.json"), "utf8"),
    ) as { providerId: string };
    const repairedState = JSON.parse(
      await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
    ) as { providerId: string };
    assert.equal(repairedIdentity.providerId, stateProviderId);
    assert.equal(repairedState.providerId, stateProviderId);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    await fs.rm(openClawHome, { force: true, recursive: true });
    await fs.rm(stateRoot, { force: true, recursive: true });
  }
});

test("surf ace runtime creates durable provider identity with exclusive first-writer semantics", async () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const openClawHome = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-openclaw-home-"));
  const stateRootA = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-state-root-a-"));
  const stateRootB = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-state-root-b-"));
  process.env.OPENCLAW_HOME = openClawHome;
  delete process.env.OPENCLAW_STATE_DIR;
  const runtimeA = createSurfAceRuntime({
    discovery: new StaticDiscoveryService([]),
    openClawStateDir: stateRootA,
  });
  const runtimeB = createSurfAceRuntime({
    discovery: new StaticDiscoveryService([]),
    openClawStateDir: stateRootB,
  });

  try {
    await Promise.all([runtimeA.start(), runtimeB.start()]);
    await Promise.all([runtimeA.stop(), runtimeB.stop()]);

    const identityPath = path.join(
      openClawHome,
      ".openclaw",
      "extensions",
      "surf-ace",
      "surf-ace-provider-identity.json",
    );
    const identity = JSON.parse(await fs.readFile(identityPath, "utf8")) as { providerId: string };
    const stateA = JSON.parse(
      await fs.readFile(path.join(stateRootA, "extensions", "surf-ace", "surf-ace-runtime-state.json"), "utf8"),
    ) as { providerId: string };
    const stateB = JSON.parse(
      await fs.readFile(path.join(stateRootB, "extensions", "surf-ace", "surf-ace-runtime-state.json"), "utf8"),
    ) as { providerId: string };

    assert.equal(stateA.providerId, identity.providerId);
    assert.equal(stateB.providerId, identity.providerId);
  } finally {
    await runtimeA.stop().catch(() => {});
    await runtimeB.stop().catch(() => {});
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    await fs.rm(openClawHome, { force: true, recursive: true });
    await fs.rm(stateRootA, { force: true, recursive: true });
    await fs.rm(stateRootB, { force: true, recursive: true });
  }
});

test("surf ace runtime seeds durable provider identity from existing OpenClaw-home runtime state", async () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const openClawHome = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-openclaw-home-"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-state-root-"));
  const existingProviderId = "pv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  process.env.OPENCLAW_HOME = openClawHome;
  delete process.env.OPENCLAW_STATE_DIR;

  try {
    const existingStateDir = path.join(openClawHome, ".openclaw", "extensions", "surf-ace");
    await fs.mkdir(existingStateDir, { recursive: true });
    await fs.writeFile(
      path.join(existingStateDir, "surf-ace-runtime-state.json"),
      JSON.stringify(
        {
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId: existingProviderId,
          version: 1,
          windowLabels: {},
        },
        null,
        2,
      ),
    );

    const runtime = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      openClawStateDir: stateRoot,
    });
    await runtime.start();
    await runtime.stop();

    const identity = JSON.parse(
      await fs.readFile(path.join(existingStateDir, "surf-ace-provider-identity.json"), "utf8"),
    ) as { providerId: string };
    const migratedState = JSON.parse(
      await fs.readFile(
        path.join(stateRoot, "extensions", "surf-ace", "surf-ace-runtime-state.json"),
        "utf8",
      ),
    ) as { providerId: string };
    assert.equal(identity.providerId, existingProviderId);
    assert.equal(migratedState.providerId, existingProviderId);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    await fs.rm(openClawHome, { force: true, recursive: true });
    await fs.rm(stateRoot, { force: true, recursive: true });
  }
});

test("surf ace runtime enforces spec-aligned provider behavior", async (t) => {
  await t.test("passive processes read the active owner's shared screen snapshot", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-lease-"));
    const discoveryA = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const discoveryB = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const infoMessagesA: string[] = [];
    const infoMessagesB: string[] = [];
    const runtimeA = createSurfAceRuntime({
      discovery: discoveryA,
      logger: {
        info: (message: string) => {
          infoMessagesA.push(message);
        },
      },
      stateDir,
    });
    const runtimeB = createSurfAceRuntime({
      discovery: discoveryB,
      logger: {
        info: (message: string) => {
          infoMessagesB.push(message);
        },
      },
      stateDir,
    });

    try {
      await runtimeA.start();
      await waitFor(() => server.pairedSocket !== null);
      await runtimeB.start();
      await waitFor(async () => (await runtimeB.listScreens()).length === 1);

      const screensA = await runtimeA.listScreens();
      const screensB = await runtimeB.listScreens();
      assert.equal(server.pairRequests.length, 1);
      assert.equal(screensA[0]?.connectionState, "connected");
      assert.equal(screensB[0]?.connectionState, "connected");
      assert.equal(screensB[0]?.fingerprint, screensA[0]?.fingerprint);
      assert.equal(screensB[0]?.windowLabel, screensA[0]?.windowLabel);
      assert.ok(
        infoMessagesB.some((message) => message.includes("passive process")),
      );
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive processes migrate persisted numeric pane ids to opaque pane ids", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-lease-"));
    const discoveryA = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const discoveryB = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtimeA = createSurfAceRuntime({ discovery: discoveryA, stateDir });
    const runtimeB = createSurfAceRuntime({ discovery: discoveryB, stateDir });

    try {
      await runtimeA.start();
      await waitFor(() => server.pairedSocket !== null);
      const activeScreens = await runtimeA.listScreens();
      const activeScreen = activeScreens[0];
      assert.ok(activeScreen);

      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
            {
              screens: [
              {
                ...activeScreen,
                panes: activeScreen.panes.map((pane) => ({
                  ...pane,
                  paneId: 1,
                })),
              },
            ],
            updatedAt: Date.now(),
            version: 1,
          },
          null,
          2,
        ),
      );

      await runtimeB.start();
      const passiveScreens = await runtimeB.listScreens();
      const passivePaneId = passiveScreens[0]?.panes[0]?.paneId;
      assertOpaquePaneId(passivePaneId);
      assert.equal(passiveScreens[0]?.panes[0]?.paneLabel, 1);
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive processes repair persisted visible coordinates before listing", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-lease-"));
    const discoveryA = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const discoveryB = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtimeA = createSurfAceRuntime({ discovery: discoveryA, stateDir });
    const runtimeB = createSurfAceRuntime({ discovery: discoveryB, stateDir });

    try {
      await runtimeA.start();
      await waitFor(() => server.pairedSocket !== null);
      const activeScreen = (await runtimeA.listScreens())[0];
      assert.ok(activeScreen);

        await fs.writeFile(
          path.join(stateDir, "surf-ace-runtime-screens.json"),
          JSON.stringify(
              {
              screens: [
                {
                ...activeScreen,
                _debug: {
                  ...activeScreen._debug,
                  localOwnership: activeScreen._debug?.localOwnership
                    ? {
                      ...activeScreen._debug.localOwnership,
                      surfaceId: "sf_snapshot-a",
                    }
                    : null,
                },
                fingerprint: "sf_snapshot-a",
                authority: {
                  actionable: true,
                  admitted: true,
                  blockers: [],
                  reason: null,
                },
                panes: activeScreen.panes.map((pane) => ({
                  ...pane,
                  paneLabel: 6242,
                })),
                windowLabel: "a",
              },
              {
                ...activeScreen,
                _debug: {
                  ...activeScreen._debug,
                  localOwnership: activeScreen._debug?.localOwnership
                    ? {
                      ...activeScreen._debug.localOwnership,
                      surfaceId: "sf_snapshot-b",
                    }
                    : null,
                },
                fingerprint: "sf_snapshot-b",
                authority: {
                  actionable: true,
                  admitted: true,
                  blockers: [],
                  reason: null,
                },
                panes: activeScreen.panes.map((pane) => ({
                  ...pane,
                  paneLabel: 6243,
                })),
                windowLabel: "a",
              },
            ],
            updatedAt: Date.now(),
            version: 1,
          },
          null,
          2,
        ),
      );

      await runtimeB.start();
      const passiveScreens = await runtimeB.listScreens();
      const visibleCoordinates = passiveScreens.flatMap((screen) =>
        screen.panes.map((pane) => `${screen.windowLabel}:${pane.paneLabel}`)
      );
      assert.deepEqual(
        passiveScreens.map((screen) => screen.windowLabel),
        ["a", "b"],
      );
      assert.deepEqual(visibleCoordinates, ["a:6242", "b:6243"]);
      assert.equal(new Set(visibleCoordinates).size, visibleCoordinates.length);
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive persisted screen repair projects global pane display tokens", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-passive-surface-local-labels-"));
    const discoveryA = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const discoveryB = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtimeA = createSurfAceRuntime({ discovery: discoveryA, stateDir });
    const runtimeB = createSurfAceRuntime({ discovery: discoveryB, stateDir });

    try {
      await runtimeA.start();
      await waitFor(() => server.pairedSocket !== null);
      const activeScreen = (await runtimeA.listScreens())[0];
      assert.ok(activeScreen);

      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              {
                ...activeScreen,
                _debug: {
                  ...activeScreen._debug,
                  localOwnership: activeScreen._debug?.localOwnership
                    ? {
                      ...activeScreen._debug.localOwnership,
                      surfaceId: "sf_snapshot-a",
                    }
                    : null,
                },
                fingerprint: "sf_snapshot-a",
                panes: activeScreen.panes.map((pane) => ({
                  ...pane,
                  paneLabel: 1,
                })),
                windowLabel: "a",
              },
              {
                ...activeScreen,
                _debug: {
                  ...activeScreen._debug,
                  localOwnership: activeScreen._debug?.localOwnership
                    ? {
                      ...activeScreen._debug.localOwnership,
                      surfaceId: "sf_snapshot-b",
                    }
                    : null,
                },
                fingerprint: "sf_snapshot-b",
                panes: activeScreen.panes.map((pane) => ({
                  ...pane,
                  paneLabel: 1,
                })),
                windowLabel: "b",
              },
            ],
            updatedAt: Date.now(),
            version: 1,
          },
          null,
          2,
        ),
      );

      await runtimeB.start();
      const passiveScreens = await runtimeB.listScreens();
      assert.deepEqual(
        passiveScreens.flatMap((screen) =>
          screen.panes.map((pane) => `${screen.windowLabel}:${pane.paneLabel}`)
        ),
        ["a:1", "b:2"],
      );
      assert.deepEqual(
        passiveScreens.flatMap((screen) => screen.panes.map((pane) => pane.displayId)),
        ["1", "2"],
      );
      assert.deepEqual(
        passiveScreens.flatMap((screen) => screen.panes.map((pane) => pane.paneAddress)),
        ["1", "2"],
      );
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive processes omit stale unowned unreachable snapshot rows", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-stale-passive-snapshot-"));
    const discoveryA = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const discoveryB = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtimeA = createSurfAceRuntime({ discovery: discoveryA, stateDir });
    const runtimeB = createSurfAceRuntime({ discovery: discoveryB, stateDir });

    try {
      await runtimeA.start();
      await waitFor(() => server.pairedSocket !== null);
      const activeScreen = (await runtimeA.listScreens())[0];
      assert.ok(activeScreen);

      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              activeScreen,
              {
                ...activeScreen,
                connectionState: "unreachable",
                fingerprint: "sf_stale_unowned_snapshot",
                _debug: {
                  ...activeScreen._debug,
                  hasPairedInGatewaySession: false,
                  reconnectAttempt: 1000,
                  remoteListedAt: Date.now(),
                  remotePaired: true,
                  sessionId: null,
                  unreachableFailures: 1000,
                  wsOpen: false,
                },
              },
              {
                ...activeScreen,
                connectionDiagnostics: {
                  circuitOpen: true,
                  circuitState: "open",
                  failureCount: 5,
                  givenUp: false,
                  openedAt: Date.now(),
                  reason: "foreign remote-paired stale publisher",
                  reconnectAttempt: 5,
                },
                connectionState: "unreachable",
                fingerprint: "sf_foreign_remote_paired_circuit_snapshot",
                _debug: {
                  ...activeScreen._debug,
                  hasPairedInGatewaySession: false,
                  reconnectAttempt: 5,
                  remoteListedAt: Date.now(),
                  remotePaired: true,
                  sessionId: null,
                  unreachableFailures: 5,
                  wsOpen: false,
                },
              },
              {
                ...activeScreen,
                connectionState: "connected",
                fingerprint: "sf_remote_paired_connected_without_local_session",
                _debug: {
                  ...activeScreen._debug,
                  hasPairedInGatewaySession: false,
                  reconnectAttempt: 5,
                  remoteListedAt: Date.now(),
                  remotePaired: true,
                  sessionId: null,
                  unreachableFailures: 0,
                  wsOpen: false,
                },
              },
            ],
            contentContinuity: {
              [activeScreen.fingerprint]: [],
              sf_remote_paired_connected_without_local_session: [
                {
                  contentId: "ct_hidden_restart",
                  contentType: "markdown",
                  contentValue: "# hidden restart content",
                  historyOwnerToken: "hot_hidden_restart",
                  paneLabel: 1,
                  revision: 1,
                  sessionKey: "agent:test:hidden-restart-content",
                },
              ],
              sf_foreign_remote_paired_circuit_snapshot: [
                {
                  contentId: "ct_foreign_circuit_restart",
                  contentType: "markdown",
                  contentValue: "# foreign circuit restart content",
                  historyOwnerToken: "hot_foreign_circuit_restart",
                  paneLabel: 1,
                  revision: 1,
                  sessionKey: "agent:test:foreign-circuit-restart-content",
                },
              ],
              sf_stale_unowned_snapshot: [
                {
                  contentId: "ct_stale_restart",
                  contentType: "markdown",
                  contentValue: "# stale restart content",
                  historyOwnerToken: "hot_stale_restart",
                  paneLabel: 1,
                  revision: 1,
                  sessionKey: "agent:test:stale-restart-content",
                },
              ],
            },
            updatedAt: Date.now(),
            version: 1,
          },
          null,
          2,
        ),
      );

      await runtimeB.start();
      const passiveScreens = await runtimeB.listScreens();
      const internalRuntimeB = runtimeB as any;
      assert.deepEqual(
        passiveScreens.map((screen) => screen.fingerprint),
        [activeScreen.fingerprint],
      );
      assert.equal(internalRuntimeB.restartContentBySurface.has("sf_remote_paired_connected_without_local_session"), false);
      assert.equal(internalRuntimeB.restartContentBySurface.has("sf_foreign_remote_paired_circuit_snapshot"), false);
      assert.equal(internalRuntimeB.restartContentBySurface.has("sf_stale_unowned_snapshot"), false);
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive processes forward pane mutations and target restore to the active runtime owner", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-lease-"));
    const discoveryA = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const discoveryB = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtimeA = createSurfAceRuntime({ discovery: discoveryA, stateDir });
    const runtimeB = createSurfAceRuntime({ discovery: discoveryB, stateDir });

    try {
      await runtimeA.start();
      await waitFor(() => server.pairedSocket !== null);
      await runtimeB.start();
      await waitFor(async () => (await runtimeB.listScreens()).length === 1);

      const screen = (await runtimeB.listScreens())[0];
      const pane = screen?.panes[0];
      assert.ok(screen);
      assert.ok(pane);

      const registered = await runtimeA.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: screen.fingerprint,
        idempotencyKey: "terminal:passive-owner-bridge",
        launchedAt: new Date().toISOString(),
        ...targetRegistrationOwnership(runtimeA, screen.fingerprint, pane.paneId),
        paneId: pane.paneId,
        registrationState: "attached",
        restorePolicy: "manual",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command", "args"],
          safetyClass: "process",
          summary: "passive owner bridge",
        },
        targetKind: "terminal_app",
        targetPayload: {
          args: [],
          command: "printf",
          envPolicy: "surface_default",
          pty: true,
          restartPolicy: "manual_only",
        },
      });
      assert.equal(registered.status, "registered");
      const restored = await runtimeB.restoreTarget({
        confirmed: true,
        fingerprint: screen.fingerprint,
        paneId: pane.paneId,
        targetId: registered.targetId,
      });
      const pushed = await runtimeB.push({
        content: "# passive owner bridge",
        contentType: "markdown",
        fingerprint: screen.fingerprint,
        paneId: pane.paneId,
      });
      const read = await runtimeB.read({
        fingerprint: screen.fingerprint,
        paneId: pane.paneId,
      });

      assert.equal(restored.blockedReason, null);
      assert.equal(restored.targetId, registered.targetId);
      assert.equal(restored.evidence?.status, "applied");
      assert.equal(pushed.fingerprint, server.surfaceId);
      assert.equal(pushed.paneId, pane.paneId);
      assert.equal(read.fingerprint, server.surfaceId);
      assert.equal(read.paneId, pane.paneId);
      assert.equal(server.contentSetRequests.length, 1);
      assert.equal(server.contentSetRequests[0]?.paneId, server.initialRemotePaneId);
      assert.equal(server.targetApplyRequests.length, 1);
      assert.equal(server.targetApplyRequests[0]?.targetId, registered.targetId);
      assert.equal(server.pairRequests.length, 1);
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive list keeps connected snapshots actionable while duplicate provider processes are diagnostic", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-duplicate-provider-passive-snapshot-"));
    const discoveryA = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const discoveryB = new StaticDiscoveryService([]);
    const runtimeA = createSurfAceRuntime({ discovery: discoveryA, stateDir });
    let observedExpectedProviderPid: number | null | undefined;
    const runtimeB = createSurfAceRuntime({
      discovery: discoveryB,
      providerProcessHealth: (expectedProviderPid) => {
        observedExpectedProviderPid = expectedProviderPid;
        return {
          duplicateProviderProcesses: true,
          liveProviderProcessCount: 2,
          pids: [expectedProviderPid ?? -1, 404],
          source: "injected",
        };
      },
      stateDir,
    });

    try {
      await runtimeA.start();
      await waitFor(() => server.authorityStateRequests.some((request) => request.actionable), 12_000);
      await waitFor(async () => {
        const screens = await runtimeA.listScreens();
        return screens.some((screen) => screen.fingerprint === server.surfaceId && screen.connectionState === "connected");
      }, 12_000);

      await runtimeB.start();
      const screens = await runtimeB.listScreens();
      const passiveScreen = screens.find((screen) => screen.fingerprint === server.surfaceId);

      assert.equal(observedExpectedProviderPid, process.pid);
      assert.ok(passiveScreen);
      assert.equal(passiveScreen.connectionState, "connected");
      assert.equal(passiveScreen.authority.actionable, true);
      assert.equal(passiveScreen.authority.reason, null);
      assert.equal(passiveScreen.panes.length, 1);
      assert.equal(passiveScreen._debug?.providerAuthorityProjection.providerProcessBlockReason, "duplicate_provider_processes");
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("pre-start provider authority diagnostics use active owner PID", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-prestart-provider-pid-"));
    const now = Date.now();
    const activeOwnerPid = process.ppid || process.pid;
    let observedExpectedProviderPid: number | null | undefined;
    const runtime = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      providerProcessHealth: (expectedProviderPid) => {
        observedExpectedProviderPid = expectedProviderPid;
        return {
          duplicateProviderProcesses: false,
          liveProviderProcessCount: 1,
          pids: [expectedProviderPid ?? -1],
          source: "injected",
        };
      },
      stateDir,
    });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-owner.lock"),
        JSON.stringify(
          {
            controlPort: 0,
            lastActiveAt: now,
            pid: activeOwnerPid,
            startedAt: now - 60_000,
          },
          null,
          2,
        ),
      );

      const diagnostics = await runtime.providerAuthorityDiagnostics();

      assert.equal(diagnostics.ownerStatus, "stopped");
      assert.equal(observedExpectedProviderPid, activeOwnerPid);
      assert.equal(diagnostics.providerProcessBlockReason, null);
      assert.deepEqual(diagnostics.providerProcessHealth.pids, [activeOwnerPid]);
    } finally {
      await runtime.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("listScreens exposes only the CLU surface fields and local pane identities", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const screens = await runtime.listScreens();
      assert.equal(screens.length, 1);

      const screen = screens[0];
      assert.ok(screen);
      assert.deepEqual(
        Object.keys(screen).sort(),
          [
            "_debug",
            "authority",
            "connectionDiagnostics",
            "connectionState",
            "fingerprint",
          "lastSeenAt",
          "name",
          "panes",
          "pendingEvents",
          "topology",
          "topologyRevision",
          "viewport",
          "windowLabel",
        ].sort(),
      );
      assert.equal(screen.fingerprint, server.surfaceId);
      assert.equal(screen.windowLabel, "a");
      assert.deepEqual(screen.topology, { paneId: screen.panes[0]?.paneId, type: "pane" });
      assert.equal(screen.topologyRevision, 0);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1]);
      assert.equal(server.initialRemotePaneId, 41);
      assert.equal(screen._debug?.localOwnership?.providerId, server.pairAttemptDetails[0]?.providerId);
      assert.equal(screen._debug?.localOwnership?.sessionId, "sa_test_session");
      assert.equal(screen._debug?.localOwnership?.source, "pair.response");
        assert.equal(screen._debug?.remoteOwnership?.paired, false);
        assert.equal(screen._debug?.remoteOwnership?.source, "surfaces.list");
        assert.equal(screen.connectionDiagnostics.circuitState, "closed");
        assert.equal(screen.connectionDiagnostics.givenUp, false);
        assert.deepEqual(
          Object.keys(screen.panes[0] ?? {}).sort(),
        ["activeContent", "displayId", "historySummary", "name", "paneAddress", "paneId", "paneLabel", "target", "viewport"].sort(),
      );
      assert.equal(screen.panes[0]?.displayId, "1");
      assert.equal(screen.panes[0]?.paneAddress, "1");
      assert.deepEqual(screen.panes[0]?.viewport, { height: 768, scale: 2, width: 1024 });
    });
  });

	  await t.test("startup tombstones stale self-owned persisted churn fixture before discovery workers run", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-stale-self-owned-"));
    let runtime: ReturnType<typeof createSurfAceRuntime> | null = null;
    try {
	      const selfOwnedSurfaceIds: Record<string, unknown> = {};
	      const targetStateBySurfaceId: Record<string, unknown> = {};
	      const windowLabels: Record<string, string> = {};
	      const selfOwnedSources = [
	        "current_target_state",
	        "legacy_target_state",
	        "legacy_local_ownership",
	        "current_snapshot_local_ownership",
	      ];
	      for (let index = 1; index <= 24; index += 1) {
	        const surfaceId = `sf_churn_${String(index).padStart(2, "0")}`;
	        const paneLineageId = `pl_${surfaceId}_incident`;
	        const targetId = `tg_${surfaceId}_incident`;
	        selfOwnedSurfaceIds[surfaceId] = {
	          observedAt: Date.now() - 60_000,
	          providerId: "pv_churn",
	          source: selfOwnedSources[(index - 1) % selfOwnedSources.length],
	        };
	        if (index <= 2) {
	          targetStateBySurfaceId[surfaceId] = {
	            ownershipEpoch: index,
	            paneTargets: {
	              [paneLineageId]: {
	                currentTargetId: targetId,
	                diagnosticContent: null,
	                lastRestoreBlockedReason: null,
	                nonDurableTargetDiagnostic: null,
	                paneLineageId,
	                targetEpoch: index,
	              },
	            },
	            registeredTargetIdsByIdempotencyKey: {},
	            targetRecords: [
	              {
	                appliedAt: new Date(Date.now() - 60_000).toISOString(),
	                currentState: "current",
	                ownerProviderId: "pv_churn",
	                ownershipEpoch: index,
	                ownershipSessionId: `sa_deleted_log_${index}`,
	                paneIdAtApply: `pn_${surfaceId}_incident`,
	                paneLabelAtApply: index,
	                paneLineageId,
	                restorePolicy: "auto",
	                surfaceId,
	                surfaceInstanceId: null,
	                targetEpoch: index,
	                targetHeader: {
	                  payloadSchemaVersion: 1,
	                  replaySemantics: "bytes",
	                  requiredCapabilities: ["target.markdown.v1"],
	                  safeToLogFields: [],
	                  safetyClass: "passive",
	                  summary: "incident stale target hint",
	                },
	                targetId,
	                targetKind: "markdown",
	                targetPayload: { markdown: "# stale incident hint" },
	              },
	            ],
	          };
	          windowLabels[surfaceId] = index === 1 ? "a" : "b";
	        }
      }
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 25,
          nextRemotePaneId: 96363,
          nextWindowLabelIndex: 24,
          paneLabelsByPaneId: {},
          providerId: "pv_churn",
          selfOwnedSurfaceIds,
          targetStateBySurfaceId,
          tombstonedEndpointIds: [],
          version: 1,
          windowLabels,
        }, null, 2),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify({
          contentContinuity: {},
          screens: [],
          updatedAt: Date.now(),
          version: 1,
        }, null, 2),
      );

	      const discovery = new StaticDiscoveryService([]);
	      runtime = createSurfAceRuntime({ discovery, legacyStateDir: stateDir, stateDir });
	      const preStartDiagnostics = await runtime.providerAuthorityDiagnostics();
	      assert.equal(preStartDiagnostics.ownerStatus, "stopped");
	      assert.equal(preStartDiagnostics.activeTargetRecordCount, 2);
	      assert.equal(preStartDiagnostics.targetStateSurfaceIds.length, 2);
	      assert.equal(preStartDiagnostics.windowLabelSurfaceIds.length, 2);
	      assert.equal(Object.keys(preStartDiagnostics.surfaceTombstones).length, 0);
	      const preStartState = JSON.parse(await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"));
	      assert.equal(Object.keys(preStartState.targetStateBySurfaceId ?? {}).length, 2);
	      assert.equal(Object.keys(preStartState.windowLabels ?? {}).length, 2);
	      assert.equal(Object.keys(preStartState.surfaceTombstones ?? {}).length, 0);
	      const screens = await runtime.listScreens();
      assert.deepEqual(screens, []);
      const emptyListDiagnostics = await runtime.providerAuthorityDiagnostics();
      assert.deepEqual(emptyListDiagnostics.runtimeScreenIds, []);
      assert.equal(emptyListDiagnostics.nextRemotePaneId, 96363);
      assert.equal(emptyListDiagnostics.persistedSelfOwnedSurfaceIds.length, 24);
      assert.equal(emptyListDiagnostics.targetStateSurfaceIds.length, 0);
      assert.equal(emptyListDiagnostics.windowLabelSurfaceIds.length, 0);
      assert.equal(emptyListDiagnostics.liveSurfaceIds.length, 0);
      assert.equal(emptyListDiagnostics.ownsRuntimeLease, true);
      let repairedState: any = null;
      await waitFor(async () => {
        try {
          repairedState = JSON.parse(await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"));
          return true;
        } catch {
          return false;
        }
      });
	      assert.equal(repairedState.nextRemotePaneId, 96363);
	      assert.equal(Object.keys(repairedState.surfaceTombstones ?? {}).length, 24);
	      assert.equal(repairedState.surfaceTombstones.sf_churn_01.hadTargetState, true);
	      assert.equal(repairedState.surfaceTombstones.sf_churn_01.hadWindowLabel, true);
	      assert.equal(repairedState.surfaceTombstones.sf_churn_02.hadTargetState, true);
	      assert.equal(repairedState.surfaceTombstones.sf_churn_02.hadWindowLabel, true);
	      assert.equal(repairedState.surfaceTombstones.sf_churn_03.hadTargetState, false);
	      assert.ok(repairedState.selfOwnedSurfaceIds.sf_churn_01.relinquishedAt);
      const repairedDiagnostics = await runtime.providerAuthorityDiagnostics();
      assert.equal(repairedDiagnostics.activeTargetRecordCount, 0);
      assert.equal(Object.keys(repairedDiagnostics.surfaceTombstones).length, 24);
      assert.equal(repairedDiagnostics.surfaceTombstones.sf_churn_01.reason, "stale_self_owned_persisted_surface");

      await runtime.stop();
      runtime = null;
      const port = nextPort++;
      const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_churn_01" });
      try {
        const discovery = new StaticDiscoveryService([discoveryEndpoint(port, "churn01")]);
        runtime = createSurfAceRuntime({ discovery, legacyStateDir: stateDir, stateDir });
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
        assert.equal(server.surfacesListRequests, 0);
        assert.equal(server.pairRequests.length, 0);
        assert.deepEqual(await runtime.listScreens(), []);
        const diagnostics = await runtime.providerAuthorityDiagnostics();
        assert.deepEqual(diagnostics.runtimeScreenIds, []);
        assert.equal(diagnostics.surfaceTombstones.sf_churn_01.reason, "stale_self_owned_persisted_surface");
      } finally {
        await server.close();
      }
    } finally {
      await runtime?.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
	  });

  await t.test("live surfaces.list rediscovery clears stale self-owned tombstone before worker starts", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-stale-discovered-"));
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_churn_discovered" });
    server.markSurfacePairedForList("sf_churn_discovered");
    server.lockedProviderId = "pv_churn_discovered";
    server.lockedSessionId = "sa_stale_churn_discovered";
	    let runtime: ReturnType<typeof createSurfAceRuntime> | null = null;
	    try {
	      await fs.writeFile(
	        path.join(stateDir, "surf-ace-runtime-state.json"),
	        JSON.stringify({
	          nextPaneLabel: 2,
	          nextRemotePaneId: 96363,
	          nextWindowLabelIndex: 1,
	          paneLabelsByPaneId: {},
	          providerId: "pv_churn_discovered",
	          selfOwnedSurfaceIds: {
	            sf_churn_discovered: {
	              observedAt: Date.now() - 60_000,
	              providerId: "pv_churn_discovered",
	              source: "legacy_local_ownership",
	            },
	          },
	          targetStateBySurfaceId: {},
	          tombstonedEndpointIds: [],
	          version: 1,
	          windowLabels: {
	            sf_churn_discovered: "a",
	          },
	        }, null, 2),
	      );
	      await fs.writeFile(
	        path.join(stateDir, "surf-ace-runtime-screens.json"),
	        JSON.stringify({
	          contentContinuity: {},
	          screens: [],
	          updatedAt: Date.now(),
	          version: 1,
	        }, null, 2),
	      );
	      const discovery = new StaticDiscoveryService([discoveryEndpoint(port, "churn-discovered")]);
	      runtime = createSurfAceRuntime({ discovery, legacyStateDir: stateDir, stateDir });
	      assert.deepEqual(await runtime.listScreens(), []);
	      await waitFor(() => server.pairedSocket !== null, 12_000);
	      const diagnostics = await runtime.providerAuthorityDiagnostics();
	      assert.equal(diagnostics.surfaceTombstones.sf_churn_discovered, undefined);
	      assert.equal(diagnostics.nextRemotePaneId, 96364);
	      assert.equal(server.pairRequests.length, 2);
	      assert.deepEqual(
	        server.pairAttemptDetails.map((attempt) => attempt.takeover),
	        [false, true],
	      );
	      const screens = await runtime.listScreens();
	      assert.equal(screens.length, 1);
	      assert.equal(screens[0]?.fingerprint, "sf_churn_discovered");
	      const state = (runtime as any).persistentState as {
	        selfOwnedSurfaceIds?: Record<string, { relinquishedAt?: number; source?: string }>;
	      };
	      assert.equal(state.selfOwnedSurfaceIds?.sf_churn_discovered?.relinquishedAt, undefined);
	      assert.equal(state.selfOwnedSurfaceIds?.sf_churn_discovered?.source, "current_local_ownership");
	    } finally {
	      await runtime?.stop();
	      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("startup tombstones stale target-owned surfaces despite unrelated discovery endpoints", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-stale-target-discovered-"));
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_unrelated_discovered" });
    let runtime: ReturnType<typeof createSurfAceRuntime> | null = null;
    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 2,
          nextRemotePaneId: 96363,
          nextWindowLabelIndex: 1,
          paneLabelsByPaneId: {},
          providerId: "pv_stale_target_discovered",
          selfOwnedSurfaceIds: {
            sf_stale_target_discovered: {
              observedAt: Date.now() - 60_000,
              providerId: "pv_stale_target_discovered",
              source: "current_local_ownership",
            },
          },
          targetStateBySurfaceId: {
            sf_stale_target_discovered: {
              ownershipEpoch: 7,
              paneTargets: {},
              registeredTargetIdsByIdempotencyKey: {},
              targetRecords: [
                {
                  appliedAt: new Date(Date.now() - 60_000).toISOString(),
                  currentState: "current",
                  ownerProviderId: "pv_stale_target_discovered",
                  ownershipEpoch: 7,
                  ownershipSessionId: "sa_stale_target_discovered",
                  paneIdAtApply: "pn_stale_target_discovered",
                  paneLabelAtApply: 1,
                  paneLineageId: "pl_stale_target_discovered",
                  targetId: "tg_stale_target_discovered",
                  targetPayload: { contentType: "markdown", markdown: "# stale" },
                  targetType: "content",
                },
              ],
            },
          },
          tombstonedEndpointIds: [],
          version: 1,
          windowLabels: {
            sf_stale_target_discovered: "a",
          },
        }, null, 2),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify({
          contentContinuity: {},
          screens: [],
          updatedAt: Date.now(),
          version: 1,
        }, null, 2),
      );

      const discovery = new StaticDiscoveryService([discoveryEndpoint(port, "unrelated-discovered")]);
      runtime = createSurfAceRuntime({ discovery, legacyStateDir: stateDir, stateDir });
      assert.deepEqual(await runtime.listScreens(), []);
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });

      const diagnostics = await runtime.providerAuthorityDiagnostics();
      assert.equal(
        diagnostics.surfaceTombstones.sf_stale_target_discovered.reason,
        "stale_self_owned_persisted_surface",
      );
      assert.equal(diagnostics.targetStateSurfaceIds.includes("sf_stale_target_discovered"), false);
      assert.equal(diagnostics.windowLabelSurfaceIds.includes("sf_stale_target_discovered"), false);
      assert.equal(
        server.pairRequestSurfaceIds.includes("sf_stale_target_discovered"),
        false,
      );
    } finally {
      await runtime?.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("startup preserves aged current browser targets as recovery hints without making them live", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-aged-browser-target-"));
    let runtime: ReturnType<typeof createSurfAceRuntime> | null = null;
    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 2,
          nextRemotePaneId: 96363,
          nextWindowLabelIndex: 1,
          paneLabelsByPaneId: {},
          providerId: "pv_aged_browser_target",
          selfOwnedSurfaceIds: {
            sf_aged_browser_target: {
              observedAt: Date.now() - 120_000,
              providerId: "pv_aged_browser_target",
              source: "current_local_ownership",
            },
          },
          targetStateBySurfaceId: {
            sf_aged_browser_target: {
              ownershipEpoch: 7,
              paneTargets: {
                pl_aged_browser_target: {
                  currentTargetId: "tg_aged_browser_target",
                  diagnosticContent: null,
                  lastRestoreBlockedReason: null,
                  nonDurableTargetDiagnostic: null,
                  paneLineageId: "pl_aged_browser_target",
                  targetEpoch: 1,
                },
              },
              registeredTargetIdsByIdempotencyKey: {},
              targetRecords: [
                {
                  appliedAt: new Date(Date.now() - 120_000).toISOString(),
                  currentState: "current",
                  ownerProviderId: "pv_aged_browser_target",
                  ownershipEpoch: 7,
                  ownershipSessionId: "sa_aged_browser_target",
                  paneIdAtApply: "pn_aged_browser_target",
                  paneLabelAtApply: 1,
                  paneLineageId: "pl_aged_browser_target",
                  restorePolicy: "auto",
                  surfaceId: "sf_aged_browser_target",
                  surfaceInstanceId: null,
                  targetEpoch: 1,
                  targetHeader: {
                    payloadSchemaVersion: 1,
                    replaySemantics: "navigate",
                    requiredCapabilities: ["target.browser_url.v1"],
                    safeToLogFields: ["url"],
                    safetyClass: "network",
                    summary: "https://example.com",
                  },
                  targetId: "tg_aged_browser_target",
                  targetKind: "browser_url",
                  targetPayload: { url: "https://example.com" },
                },
              ],
            },
          },
          tombstonedEndpointIds: [],
          version: 1,
          windowLabels: {
            sf_aged_browser_target: "a",
          },
        }, null, 2),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify({
          contentContinuity: {},
          screens: [],
          updatedAt: Date.now(),
          version: 1,
        }, null, 2),
      );

      const discovery = new StaticDiscoveryService([]);
      runtime = createSurfAceRuntime({ discovery, legacyStateDir: stateDir, stateDir });
      assert.deepEqual(await runtime.listScreens(), []);
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });

      const diagnostics = await runtime.providerAuthorityDiagnostics();
      assert.equal(diagnostics.surfaceTombstones.sf_aged_browser_target, undefined);
      assert.equal(diagnostics.targetStateSurfaceIds.includes("sf_aged_browser_target"), true);
      assert.equal(diagnostics.windowLabelSurfaceIds.includes("sf_aged_browser_target"), true);
      assert.deepEqual(await runtime.listScreens(), []);
    } finally {
      await runtime?.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("startup defers stale self-owned tombstone when contentContinuity hints exist", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-continuity-deferral-"));
    let runtime: ReturnType<typeof createSurfAceRuntime> | null = null;
    try {
      const surfaceId = "sf_continuity_hint";
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 2,
          nextRemotePaneId: 96363,
          nextWindowLabelIndex: 1,
          paneLabelsByPaneId: {},
          providerId: "pv_continuity_deferral",
          selfOwnedSurfaceIds: {
            [surfaceId]: {
              observedAt: Date.now() - 60_000,
              providerId: "pv_continuity_deferral",
              source: "current_local_ownership",
            },
          },
          targetStateBySurfaceId: {},
          tombstonedEndpointIds: [],
          version: 1,
          windowLabels: {},
        }, null, 2),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify({
          contentContinuity: {
            [surfaceId]: [
              {
                contentId: "ct_deferral",
                contentType: "html",
                contentValue: "<main>restore me</main>",
                display: null,
                historyOwnerToken: null,
                paneLabel: 1,
                remotePaneId: 1,
                revision: 1,
                sessionKey: "agent:test:deferral",
              },
            ],
          },
          screens: [],
          updatedAt: Date.now(),
          version: 1,
        }, null, 2),
      );

      const discovery = new StaticDiscoveryService([]);
      runtime = createSurfAceRuntime({ discovery, legacyStateDir: stateDir, stateDir });
      assert.deepEqual(await runtime.listScreens(), []);
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });

      const diagnostics = await runtime.providerAuthorityDiagnostics();
      assert.equal(diagnostics.surfaceTombstones[surfaceId], undefined);
    } finally {
      await runtime?.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("startup preserves current local target authority beyond short startup grace", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-current-target-authority-"));
    let runtime: ReturnType<typeof createSurfAceRuntime> | null = null;
    try {
      const surfaceId = "sf_current_target_authority";
      const paneLineageId = "pl_current_target_authority";
      const targetId = "tg_current_target_authority";
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 2,
          nextRemotePaneId: 96363,
          nextWindowLabelIndex: 1,
          paneLabelsByPaneId: {},
          providerId: "pv_current_target_authority",
          selfOwnedSurfaceIds: {
            [surfaceId]: {
              observedAt: Date.now() - 120_000,
              providerId: "pv_current_target_authority",
              source: "current_local_ownership",
            },
          },
          targetStateBySurfaceId: {
            [surfaceId]: {
              ownershipEpoch: 7,
              paneTargets: {
                [paneLineageId]: {
                  currentTargetId: targetId,
                  diagnosticContent: null,
                  lastRestoreBlockedReason: null,
                  nonDurableTargetDiagnostic: null,
                  paneLineageId,
                  staleTargetId: null,
                  targetEpoch: 1,
                },
              },
              registeredTargetIdsByIdempotencyKey: {},
              targetRecords: [
                {
                  appliedAt: new Date(Date.now() - 120_000).toISOString(),
                  currentState: "current",
                  ownerProviderId: "pv_current_target_authority",
                  ownershipEpoch: 7,
                  ownershipSessionId: "sa_current_target_authority",
                  paneIdAtApply: "pn_current_target_authority",
                  paneLabelAtApply: 1,
                  paneLineageId,
                  restorePolicy: "auto",
                  surfaceId,
                  surfaceInstanceId: null,
                  targetEpoch: 1,
                  targetHeader: {
                    payloadSchemaVersion: 1,
                    replaySemantics: "bytes",
                    requiredCapabilities: ["target.html.v1"],
                    safeToLogFields: [],
                    safetyClass: "passive",
                    summary: "T338 persisted current local target authority",
                  },
                  targetId,
                  targetKind: "html",
                  targetPayload: { html: "<main>T338 persisted current local target authority</main>" },
                },
              ],
            },
          },
          tombstonedEndpointIds: [],
          version: 1,
          windowLabels: {
            [surfaceId]: "a",
          },
        }, null, 2),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify({ contentContinuity: {}, screens: [], updatedAt: Date.now(), version: 1 }, null, 2),
      );

      const discovery = new StaticDiscoveryService([]);
      runtime = createSurfAceRuntime({ discovery, legacyStateDir: stateDir, stateDir });
      assert.deepEqual(await runtime.listScreens(), []);
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });

      const diagnostics = await runtime.providerAuthorityDiagnostics();
      assert.equal(diagnostics.surfaceTombstones[surfaceId], undefined);
      assert.equal(diagnostics.targetStateSurfaceIds.includes(surfaceId), true);
      assert.equal(diagnostics.windowLabelSurfaceIds.includes(surfaceId), true);
    } finally {
      await runtime?.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("startup preserves current target imports beyond short startup grace", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-current-target-import-authority-"));
    let runtime: ReturnType<typeof createSurfAceRuntime> | null = null;
    try {
      const surfaceId = "sf_current_target_import_authority";
      const paneLineageId = "pl_current_target_import_authority";
      const targetId = "tg_current_target_import_authority";
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 2,
          nextRemotePaneId: 96363,
          nextWindowLabelIndex: 1,
          paneLabelsByPaneId: {},
          providerId: "pv_current_target_import_authority",
          selfOwnedSurfaceIds: {},
          targetStateBySurfaceId: {
            [surfaceId]: {
              ownershipEpoch: 7,
              paneTargets: {
                [paneLineageId]: {
                  currentTargetId: targetId,
                  diagnosticContent: null,
                  lastRestoreBlockedReason: null,
                  nonDurableTargetDiagnostic: null,
                  paneLineageId,
                  staleTargetId: null,
                  targetEpoch: 1,
                },
              },
              registeredTargetIdsByIdempotencyKey: {},
              targetRecords: [
                {
                  appliedAt: new Date(Date.now() - 120_000).toISOString(),
                  currentState: "current",
                  ownerProviderId: "pv_current_target_import_authority",
                  ownershipEpoch: 7,
                  ownershipSessionId: "sa_current_target_import_authority",
                  paneIdAtApply: "pn_current_target_import_authority",
                  paneLabelAtApply: 1,
                  paneLineageId,
                  restorePolicy: "auto",
                  surfaceId,
                  surfaceInstanceId: null,
                  targetEpoch: 1,
                  targetHeader: {
                    payloadSchemaVersion: 1,
                    replaySemantics: "bytes",
                    requiredCapabilities: ["target.html.v1"],
                    safeToLogFields: [],
                    safetyClass: "passive",
                    summary: "T338 persisted current target import authority",
                  },
                  targetId,
                  targetKind: "html",
                  targetPayload: { html: "<main>T338 persisted current target import authority</main>" },
                },
              ],
            },
          },
          tombstonedEndpointIds: [],
          version: 1,
          windowLabels: {
            [surfaceId]: "a",
          },
        }, null, 2),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify({ contentContinuity: {}, screens: [], updatedAt: Date.now(), version: 1 }, null, 2),
      );

      const discovery = new StaticDiscoveryService([]);
      runtime = createSurfAceRuntime({ discovery, legacyStateDir: stateDir, stateDir });
      assert.deepEqual(await runtime.listScreens(), []);
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });

      const diagnostics = await runtime.providerAuthorityDiagnostics();
      assert.equal(diagnostics.surfaceTombstones[surfaceId], undefined);
      assert.equal(diagnostics.persistedSelfOwnedSurfaceIds.includes(surfaceId), true);
      assert.equal(diagnostics.targetStateSurfaceIds.includes(surfaceId), true);
      assert.equal(diagnostics.windowLabelSurfaceIds.includes(surfaceId), true);
    } finally {
      await runtime?.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("startup tombstones stale legacy-root target imports without refreshing ownership age", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-stale-legacy-current-"));
    const legacyStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-stale-legacy-root-"));
    let runtime: ReturnType<typeof createSurfAceRuntime> | null = null;
    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId: "pv_current_stale_legacy_import",
          selfOwnedSurfaceIds: {},
          tombstonedEndpointIds: [],
          version: 1,
          windowLabels: {},
        }, null, 2),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify({ contentContinuity: {}, screens: [], updatedAt: Date.now(), version: 1 }, null, 2),
      );

      const legacyStatePath = path.join(legacyStateDir, "surf-ace-runtime-state.json");
      await fs.writeFile(
        legacyStatePath,
        JSON.stringify({
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId: "pv_current_stale_legacy_import",
          targetStateBySurfaceId: {
            sf_stale_legacy_target_import: {
              ownershipEpoch: 1,
              paneTargets: {},
              registeredTargetIdsByIdempotencyKey: {},
              targetRecords: [],
            },
          },
          version: 1,
          windowLabels: {},
        }, null, 2),
      );
      const staleTime = new Date(Date.now() - 60_000);
      await fs.utimes(legacyStatePath, staleTime, staleTime);

      runtime = createSurfAceRuntime({
        discovery: new StaticDiscoveryService([]),
        legacyStateDir,
        stateDir,
      });
      assert.deepEqual(await runtime.listScreens(), []);

      const diagnostics = await runtime.providerAuthorityDiagnostics();
      assert.equal(
        diagnostics.surfaceTombstones.sf_stale_legacy_target_import.reason,
        "stale_self_owned_persisted_surface",
      );
      assert.equal(diagnostics.persistedSelfOwnedSurfaceIds.includes("sf_stale_legacy_target_import"), true);
      assert.equal(diagnostics.targetStateSurfaceIds.includes("sf_stale_legacy_target_import"), false);
    } finally {
      await runtime?.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
      await fs.rm(legacyStateDir, { force: true, recursive: true });
    }
  });

	  await t.test("provider actionability requires accepted client authority state", async () => {
		    await withRuntimeHarness({
		      configureServer: (server) => {
		        server.rejectAuthorityState = true;
      },
      waitForAuthority: false,
      run: async ({ runtime, server }) => {
        await waitFor(() => server.authorityStateRequests.length > 0, 12_000);
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        assert.equal(screen.authority.actionable, false);
        assert.equal(screen.authority.reason, "test_authority_rejected");
        assert.ok(screen._debug?.providerAuthorityProjection.authorityBlockedSurfaceIds.includes(server.surfaceId));
        await assert.rejects(
          runtime.push({
            content: "# blocked",
            contentType: "markdown",
            fingerprint: server.surfaceId,
            paneId: screen.panes[0]!.paneId,
          }),
          /test_authority_rejected/,
        );
        assert.equal(server.contentSetRequests.length, 0);
      },
		    });
		  });

  await t.test("runtime app binding degraded diagnostics block native app launch readiness without changing provider ownership", async () => {
    const runtimeAppBinding: RuntimeAppBindingDiagnostics = {
      acknowledgement: "failed",
      bindingAuthority: "degraded",
      bindingDegradedReasons: ["launch_token_missing", "process_lineage_missing"],
      checkedAt: 123 as never,
      diagnosticDrift: ["wayland_app_id_mismatch"],
      expectedBundleId: "ai.surf-ace.electron",
      expectedPackageName: "@surf-ace/electron",
      expectedRuntimeId: "surf-ace.runtime.electron",
      failureMessage: "missing launch token",
      launchTokenStatus: "missing",
      observedUiLabel: "Test Surface",
      observedWaylandAppId: "surf-ace-electron",
      observedWindowTitle: "Test Surface",
      processLineageStatus: "missing",
      ready: false,
      reportedBundleId: "ai.surf-ace.electron",
      reportedPackageName: "@surf-ace/electron",
      reportedRuntimeId: "surf-ace.runtime.electron",
    };
    await withRuntimeHarness({
      configureServer: (server) => {
        server.runtimeAppBinding = runtimeAppBinding;
      },
      waitForAuthority: false,
      run: async ({ runtime, server }) => {
        await waitFor(async () => {
          const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
          return screen?._debug?.runtimeAppBinding?.bindingAuthority === "degraded";
        }, 12_000);

        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        assert.equal(screen.connectionState, "connected");
        assert.equal(screen.authority.actionable, true);
        assert.equal(screen.authority.reason, null);
        assert.deepEqual(screen._debug?.runtimeAppBinding, runtimeAppBinding);
        assert.deepEqual(
          screen._debug?.providerAuthorityProjection.runtimeAppBindingBySurfaceId[server.surfaceId],
          runtimeAppBinding,
        );
        assert.deepEqual(
          screen._debug?.providerAuthorityProjection.authorityBlockersBySurfaceId[server.surfaceId],
          [],
        );
        await assert.rejects(
          runtime.launchNativeApp({
            appId: "com.example.NativeApp",
            confirmed: true,
            fingerprint: server.surfaceId,
            paneId: screen.panes[0]!.paneId,
          }),
          /runtime_binding_degraded/,
        );
      },
    });
  });

  await t.test("provider process inventory recognizes in-process owner and stale plugin siblings", () => {
    const inProcessHealth = providerProcessHealthFromProcessList(
      [
        "48791 /opt/homebrew/opt/node@24/bin/node /Users/mike/openclaw/dist/index.js gateway --port 18789",
        "49466 node -e const text='openclaw-plugins'",
      ].join("\n"),
      48791,
    );
    assert.equal(inProcessHealth.duplicateProviderProcesses, false);
    assert.equal(inProcessHealth.liveProviderProcessCount, 1);
    assert.deepEqual(inProcessHealth.pids, [48791]);

    const pluginOwnerHealth = providerProcessHealthFromProcessList(
      "27021 OSLogRateLimit=64 OPENCLAW_GATEWAY_PORT=18789 openclaw-plugins",
      27021,
    );
    assert.equal(pluginOwnerHealth.duplicateProviderProcesses, false);
    assert.equal(pluginOwnerHealth.liveProviderProcessCount, 1);
    assert.deepEqual(pluginOwnerHealth.pids, [27021]);

    const staleSiblingHealth = providerProcessHealthFromProcessList(
      [
        "48791 /opt/homebrew/opt/node@24/bin/node /Users/mike/openclaw/dist/index.js gateway --port 18789",
        "27021 OSLogRateLimit=64 OPENCLAW_GATEWAY_PORT=18789 openclaw-plugins",
      ].join("\n"),
      48791,
    );
    assert.equal(staleSiblingHealth.duplicateProviderProcesses, true);
    assert.equal(staleSiblingHealth.liveProviderProcessCount, 2);
    assert.deepEqual(staleSiblingHealth.pids, [27021, 48791]);

    const expectedOwnerWithStaleSiblingHealth = providerProcessHealthFromProcessList(
      [
        "48791 /opt/homebrew/bin/node --import tsx packages/extension/src/index.ts gateway --port 18789",
        "27021 OSLogRateLimit=64 OPENCLAW_GATEWAY_PORT=18789 openclaw-plugins",
      ].join("\n"),
      48791,
    );
    assert.equal(expectedOwnerWithStaleSiblingHealth.duplicateProviderProcesses, true);
    assert.equal(expectedOwnerWithStaleSiblingHealth.liveProviderProcessCount, 2);
    assert.deepEqual(expectedOwnerWithStaleSiblingHealth.pids, [27021, 48791]);

    const duplicateGatewayHealth = providerProcessHealthFromProcessList(
      [
        "48791 /opt/homebrew/opt/node@24/bin/node /Users/mike/openclaw/dist/index.js gateway --port 18789",
        "48802 /opt/homebrew/opt/node@24/bin/node /Users/mike/openclaw/dist/index.js gateway --port 18789",
      ].join("\n"),
      48791,
    );
    assert.equal(duplicateGatewayHealth.duplicateProviderProcesses, true);
    assert.equal(duplicateGatewayHealth.liveProviderProcessCount, 2);
    assert.deepEqual(duplicateGatewayHealth.pids, [48791, 48802]);

    const duplicateRelativeGatewayHealth = providerProcessHealthFromProcessList(
      [
        "48791 node dist/index.js gateway --port 18789",
        "48802 node dist/index.js gateway --port 18789",
      ].join("\n"),
      48791,
    );
    assert.equal(duplicateRelativeGatewayHealth.duplicateProviderProcesses, true);
    assert.equal(duplicateRelativeGatewayHealth.liveProviderProcessCount, 2);
    assert.deepEqual(duplicateRelativeGatewayHealth.pids, [48791, 48802]);

    const missingExpectedOwnerHealth = providerProcessHealthFromProcessList(
      "27021 OSLogRateLimit=64 OPENCLAW_GATEWAY_PORT=18789 openclaw-plugins",
      48791,
    );
    assert.equal(missingExpectedOwnerHealth.duplicateProviderProcesses, false);
    assert.equal(missingExpectedOwnerHealth.liveProviderProcessCount, 1);
    assert.deepEqual(missingExpectedOwnerHealth.pids, [27021]);

    const reusedPidHealth = providerProcessHealthFromProcessList(
      "48791 /bin/sleep 1000",
      48791,
    );
    assert.equal(reusedPidHealth.duplicateProviderProcesses, false);
    assert.equal(reusedPidHealth.liveProviderProcessCount, 0);
    assert.deepEqual(reusedPidHealth.pids, []);
  });

  await t.test("provider process diagnostics do not block same-provider actionability or pane operations", async () => {
    let health: SurfAceProviderProcessHealth = {
      duplicateProviderProcesses: true,
      liveProviderProcessCount: 2,
      pids: [process.pid, 202],
      source: "injected",
    };
    await withRuntimeHarness({
      providerProcessHealth: () => ({ ...health, pids: [...health.pids] }),
      run: async ({ runtime, server }) => {
        const duplicateProcessScreen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(duplicateProcessScreen);
        assert.equal(duplicateProcessScreen.connectionState, "connected");
        assert.equal(duplicateProcessScreen.authority.actionable, true);
        assert.equal(duplicateProcessScreen.authority.reason, null);
        assert.equal(duplicateProcessScreen._debug?.providerAuthorityProjection.providerProcessBlockReason, "duplicate_provider_processes");
        assert.deepEqual(duplicateProcessScreen._debug?.providerAuthorityProjection.providerProcessHealth.pids, [process.pid, 202]);

        const paneId = duplicateProcessScreen.panes[0]?.paneId;
        assert.ok(paneId);
        await runtime.push({
          content: "# accepted while duplicate provider processes are diagnostic",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId,
        });
        assert.equal(server.contentSetRequests.at(-1)?.paneId, server.initialRemotePaneId);

        health = {
          duplicateProviderProcesses: false,
          liveProviderProcessCount: 1,
          pids: [202],
          source: "injected",
        };

        const mismatchedOwnerScreen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(mismatchedOwnerScreen);
        assert.equal(mismatchedOwnerScreen.authority.actionable, true);
        assert.equal(mismatchedOwnerScreen.authority.reason, null);
        assert.equal(
          mismatchedOwnerScreen._debug?.providerAuthorityProjection.providerProcessBlockReason,
          "provider_process_lease_mismatch",
        );
        await runtime.push({
          content: "# accepted while runtime lease mismatch is diagnostic",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId,
        });
        assert.equal(server.contentSetRequests.at(-1)?.paneId, server.initialRemotePaneId);

        health = {
          duplicateProviderProcesses: false,
          liveProviderProcessCount: 1,
          pids: [process.pid],
          source: "injected",
        };

        await runtime.push({
          content: "# accepted after singular provider ownership",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId,
        });
        assert.equal(server.contentSetRequests.at(-1)?.paneId, server.initialRemotePaneId);
        const actionableScreen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.equal(actionableScreen?.authority.actionable, true);
        assert.equal(actionableScreen?._debug?.providerAuthorityProjection.providerProcessBlockReason, null);
      },
    });
  });

  await t.test("missing or unavailable provider process inventory remains diagnostic", async () => {
    let health: SurfAceProviderProcessHealth = {
      duplicateProviderProcesses: false,
      liveProviderProcessCount: 0,
      pids: [],
      source: "process_inventory",
    };
    await withRuntimeHarness({
      providerProcessHealth: () => ({ ...health, pids: [...health.pids] }),
      run: async ({ runtime, server }) => {
        const missingScreen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(missingScreen);
        assert.equal(missingScreen.authority.actionable, true);
        assert.equal(missingScreen.authority.reason, null);
        assert.equal(missingScreen.connectionState, "connected");
        assert.equal(missingScreen._debug?.providerAuthorityProjection.providerProcessBlockReason, "provider_process_missing");

        health = {
          duplicateProviderProcesses: false,
          liveProviderProcessCount: 0,
          pids: [],
          reason: "process inventory unavailable",
          source: "unavailable",
        };

        const unavailableScreen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(unavailableScreen);
        assert.equal(unavailableScreen.authority.actionable, true);
        assert.equal(unavailableScreen.authority.reason, null);
        assert.equal(unavailableScreen.connectionState, "connected");
        assert.equal(
          unavailableScreen._debug?.providerAuthorityProjection.providerProcessBlockReason,
          "provider_process_inventory_unavailable",
        );
      },
    });
  });

		  await t.test("legacy v1 clients without authority state capability fail closed", async () => {
	    await withRuntimeHarness({
	      configureServer: (server) => {
	        server.protocolFeatures = [];
	      },
	      waitForAuthority: false,
	      run: async ({ runtime, server }) => {
	        await waitFor(() => server.pairedSocket !== null, 12_000);
	        await new Promise((resolve) => {
	          setTimeout(resolve, 100);
	        });
		        assert.equal(server.authorityStateRequests.length, 0);
		        assert.equal(server.heartbeatRequests, 0);

		        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
		        assert.ok(screen);
		        assert.equal(screen.connectionState, "connecting");
		        assert.equal(screen.authority.actionable, false);
		        assert.equal(screen.authority.reason, "authority_state_unsupported");
		        assert.deepEqual(screen.panes, []);
		        assert.deepEqual(
		          screen._debug?.providerAuthorityProjection.authorityBlockersBySurfaceId[server.surfaceId],
		          ["authority_state_unsupported"],
		        );
		        await assert.rejects(
		          runtime.push({
		            content: "# legacy blocked",
		            contentType: "markdown",
		            fingerprint: server.surfaceId,
		            paneId: "pn_legacy_unsupported",
		          }),
		          /authority_state_unsupported/,
	        );
	        assert.equal(server.contentSetRequests.length, 0);
	      },
	    });
	  });

	  await t.test("topology mutation invalidates and republishes exact client authority", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await waitFor(() => server.authorityStateRequests.some((request) => request.actionable), 12_000);
      const initialAuthorityCount = server.authorityStateRequests.length;
      await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      await waitFor(() => server.authorityStateRequests.length >= initialAuthorityCount + 2, 12_000);
      const after = server.authorityStateRequests.slice(initialAuthorityCount);
      assert.ok(after.some((request) => request.actionable === false && request.reason === "topology_update_in_flight"));
      assert.ok(after.some((request) => request.actionable === true && request.paneLabels.length === 2));
      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.equal(screen?.authority.actionable, true);
      assertPaneLabelsWithOpaqueIds(screen?.panes ?? [], [1, 2]);
    });
  });

  await t.test("failed topology mutation republishes current client authority", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await waitFor(() => server.authorityStateRequests.some((request) => request.actionable), 12_000);
      const initialAuthorityCount = server.authorityStateRequests.length;
      server.nextTopologyApplyError = { code: "invalid_request", message: "test topology rejection" };
      await assert.rejects(
        runtime.split({
          count: 2,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        }),
        /test topology rejection/,
      );
      await waitFor(() => server.authorityStateRequests.length >= initialAuthorityCount + 2, 12_000);
      const after = server.authorityStateRequests.slice(initialAuthorityCount);
      assert.ok(after.some((request) => request.actionable === false && request.reason === "topology_update_in_flight"));
      assert.ok(after.some((request) => request.actionable === true && request.paneLabels.length === 1));
      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.equal(screen?.authority.actionable, true);
      assertPaneLabelsWithOpaqueIds(screen?.panes ?? [], [1]);
    });
  });

  await t.test("listScreens adopts provider pane labels from pair.response", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        const pane = server.panes.get(server.initialRemotePaneId);
        assert.ok(pane);
        pane.paneLabel = 7;
      },
      run: async ({ runtime, server }) => {
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        assert.deepEqual(screen.panes.map((pane) => pane.paneLabel), [7]);
        assert.equal(server.pairRequests[0]?.initialPaneLabel, 1);
      },
    });
  });

  await t.test("listScreens does not advertise connected for a stale closed transport", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await surface.client?.close(1000, "test_stale_closed_transport");
      surface.connectionState = "connected";
      surface.client = {
        close: async () => {},
        isOpen: () => false,
        request: async () => {
          throw new Error("stale transport should not receive requests");
        },
      };

      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      assert.equal(screen.connectionState, "connecting");
      assert.equal(screen._debug?.wsOpen, false);
    });
  });

  await t.test("listScreens and authority diagnostics report one authority snapshot", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      assert.deepEqual(
        screen._debug?.providerAuthorityProjection.authorityBlockersBySurfaceId[server.surfaceId],
        screen.authority.blockers,
      );

      const diagnostics = await runtime.providerAuthorityDiagnostics();
      assert.deepEqual(
        diagnostics.authorityBlockersBySurfaceId[server.surfaceId],
        screen.authority.blockers,
      );

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      surface.connectionState = "unreachable";

      const staleScreen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(staleScreen);
      assert.equal(staleScreen.authority.actionable, false);
      assert.deepEqual(
        staleScreen._debug?.providerAuthorityProjection.authorityBlockersBySurfaceId[server.surfaceId],
        staleScreen.authority.blockers,
      );

      const staleDiagnostics = await runtime.providerAuthorityDiagnostics();
      assert.deepEqual(
        staleDiagnostics.authorityBlockersBySurfaceId[server.surfaceId],
        staleScreen.authority.blockers,
      );
    });
  });

  await t.test("endpoint identity changes discard stale transport lineage before reconnect", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-endpoint-churn-"));
    const initialEndpoint = discoveryEndpoint(port);
    const discovery = new StaticDiscoveryService([initialEndpoint]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => server.pairedSocket !== null);
      assert.equal(server.pairAttemptDetails.length, 1);

      discovery.setEndpoints([
        {
          ...initialEndpoint,
          endpointId: `${initialEndpoint.endpointId}-after-churn`,
          lastSeenAt: Date.now(),
        },
      ]);
      await discovery.refreshNow();

      await waitFor(() => server.pairAttemptDetails.length >= 2);
      const reconnectAttempt = server.pairAttemptDetails.at(-1);
      assert.ok(reconnectAttempt);
      assert.equal(reconnectAttempt.resumeSessionId, "sa_test_session");
      assert.equal(reconnectAttempt.takeover, false);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("same endpoint rediscovery reopens retained surface retry circuit", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      surface.connectionCircuitOpenedAt = Date.now();
      surface.connectionCircuitReason = "test client down";
      surface.connectionState = "unreachable";
      surface.autoRetryEnabled = false;
      surface.unreachableFailures = 3;
      surface.reconnectAttempt = 4;

      await discovery.refreshNow();

      assert.equal(surface.autoRetryEnabled, true);
      assert.equal(surface.connectionCircuitOpenedAt, null);
      assert.equal(surface.connectionCircuitReason, null);
      assert.equal(surface.connectionState, "connecting");
      assert.equal(surface.unreachableFailures, 0);
      assert.equal(surface.reconnectAttempt, 0);
    });
  });

  await t.test("previously unseen remote panes adopt provider-visible pane labels", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      server.panes.set(77, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: 5,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });

      await internalRuntime.syncSurfaceSnapshots(surface, true);
      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 5]);
    });
  });

  await t.test("provider-visible pane labels cannot default to remote pane ids", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      const paneId = paneByLabel(screen, 1).paneId;
      server.panes.set(77, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: 77,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });

      await assert.rejects(
        async () =>
          await runtime.push(
            {
              content: "# invalid pane label",
              contentType: "markdown",
              fingerprint: server.surfaceId,
              paneId,
            },
            { sessionKey: "agent:test:invalid-pane-label" },
          ),
        /invalid pane label/,
      );
      assert.equal(server.contentSetRequests.length, 0);
    });
  });

  await t.test("provider rejects missing pair pane labels before adopting state", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.throws(
        () =>
          internalRuntime.applyPairPaneState(
            surface,
            [
              {
                contentType: null,
                currentContentId: null,
                currentRevision: 0,
                paneId: server.initialRemotePaneId,
              },
            ],
            false,
          ),
        /invalid pane label/,
      );
    });
  });

  await t.test("provider rejects missing panes.list labels before mutation", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      const paneId = paneByLabel(screen, 1).paneId;
      server.omitPanesListPaneLabel = true;

      await assert.rejects(
        async () =>
          await runtime.push(
            {
              content: "# missing panes.list pane label",
              contentType: "markdown",
              fingerprint: server.surfaceId,
              paneId,
            },
            { sessionKey: "agent:test:missing-pane-list-label" },
          ),
        /invalid pane label/,
      );
      assert.equal(server.contentSetRequests.length, 0);
    });
  });

  await t.test("provider rejects missing topology response labels before accepting split", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const paneId = paneByLabel(before, 1).paneId;
      server.omitTopologyApplyResponsePaneLabel = true;

      await assert.rejects(
        async () =>
          await runtime.split({
            count: 2,
            direction: "vertical",
            fingerprint: server.surfaceId,
            paneId,
          }),
        /invalid pane label/,
      );

      const after = (await runtime.listScreens())[0]!;
      assert.deepEqual(after.panes.map((pane) => pane.paneId), [paneId]);
    });
  });

  await t.test("panes.list provider label repairs refresh the shared screen snapshot", async () => {
    await withRuntimeHarness(async ({ runtime, server, stateDir }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const pane = internalRuntime.findPaneByRemoteId(surface, server.initialRemotePaneId);
      assert.ok(pane);

      const remotePane = server.panes.get(server.initialRemotePaneId);
      assert.ok(remotePane);
      const storageKey = `${server.surfaceId}::${server.initialRemotePaneId}`;
      internalRuntime.persistentState.paneLabelsByPaneId[storageKey] = 9;
      pane.paneLabel = 1;
      remotePane.paneLabel = 9;
      await internalRuntime.syncRemotePaneList(surface);

      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      assert.deepEqual(screen.panes.map((pane) => pane.paneLabel), [9]);

      const snapshotPath = path.join(stateDir, "surf-ace-runtime-screens.json");
      await waitFor(async () => {
        const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
        const persistedScreen = snapshot.screens.find(
          (candidate: { fingerprint?: string }) => candidate.fingerprint === server.surfaceId,
        );
        return persistedScreen?.panes?.[0]?.paneLabel === 9;
      });
    });
  });

  await t.test("panes.list provenance updates visible pane chrome state", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const remotePane = server.panes.get(server.initialRemotePaneId);
      assert.ok(remotePane);
      remotePane.contentId = "ct_11aabbcc";
      remotePane.contentType = "markdown";
      remotePane.revision = 3;
      remotePane.display = {
        provenance: {
          displayName: "List Session",
          pushedAt: "2026-05-18T00:00:00Z",
          sessionKey: "agent:test:list-session",
          source: "openclaw",
        },
        title: "Document Title",
      };

      await internalRuntime.syncRemotePaneList(surface);

      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      const pane = screen?.panes.find((candidate) => candidate.paneLabel === remotePane.paneLabel);
      assert.equal(pane?.activeContent?.display?.title, "Document Title");
      assert.deepEqual(pane?.historySummary.visibleProvenance, {
        displayName: "List Session",
        pushedAt: "2026-05-18T00:00:00Z",
        sessionKey: "agent:test:list-session",
        source: "openclaw",
      });
    });
  });

  await t.test("content push reconciles visible pane identity before reporting applied", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const initialScreen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(initialScreen);
      const paneId = paneByLabel(initialScreen, 1).paneId;
      const remotePane = server.panes.get(server.initialRemotePaneId);
      assert.ok(remotePane);
      remotePane.paneLabel = 6;

      const pushed = await runtime.push(
        {
          content: "# visible pane identity",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId,
        },
        { sessionKey: "agent:test:visible-pane-identity" },
      );

      assert.equal(pushed.paneId, paneId);
      assert.equal(pushed.paneLabel, 6);
      assert.equal(pushed.displayId, "6");
      assert.equal(pushed.paneAddress, "6");
      assert.equal(server.contentSetRequests.at(-1)?.paneId, server.initialRemotePaneId);

      const screenAfterPush = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screenAfterPush);
      const listedPane = screenAfterPush.panes.find((candidate) => candidate.paneId === paneId);
      assert.ok(listedPane);
      assert.equal(listedPane.paneLabel, 6);
      assert.equal(listedPane.displayId, "6");
      assert.equal(listedPane.paneAddress, "6");
      assert.equal(listedPane.activeContent?.contentId, pushed.contentId);

      const read = await runtime.read({ fingerprint: server.surfaceId, paneId });
      assert.equal(read.paneId, paneId);
      assert.equal(read.paneLabel, 6);
      assert.equal(read.displayId, "6");
      assert.equal(read.paneAddress, "6");
      assert.equal(read.windowLabel, "a");
      assert.equal(read.contentSnapshot?.contentId, pushed.contentId);
      assert.deepEqual(read.contentSnapshot?.content, { markdown: "# visible pane identity" });
    });
  });

  await t.test("capture projects provider content when stale snapshot reports blank content", async () => {
    await withRuntimeHarness({
      now: () => 1_777_050,
      run: async ({ runtime, server }) => {
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        const paneId = paneByLabel(screen, 1).paneId;
        const pushed = await runtime.push(
          {
            content: "<main>provider-owned capture content</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId,
          },
          { sessionKey: "agent:test:blank-snapshot-capture" },
        );
        const remotePane = server.panes.get(server.initialRemotePaneId);
        assert.ok(remotePane);
        remotePane.contentId = null;
        remotePane.contentType = null;
        remotePane.revision += 1;
        server.snapshotImage = "Ymxhbmstc25hcHNob3QtZnJhbWU=";

        const captured = await runtime.capturePane({ fingerprint: server.surfaceId, paneId });
        assert.equal(captured.capture.visibleContentId, pushed.contentId);
        assert.equal(captured.capture.contentType, "html");
        assert.equal(captured.capture.failureReason, null);

        const listed = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        const listedPane = listed?.panes.find((candidate) => candidate.paneId === paneId);
        assert.equal(listedPane?.activeContent?.contentId, pushed.contentId);
        assert.equal(listedPane?.historySummary.visibleContentId, pushed.contentId);

        const read = await runtime.read({ fingerprint: server.surfaceId, paneId });
        assert.equal(read.contentSnapshot?.contentId, pushed.contentId);
        assert.deepEqual(read.contentSnapshot?.content, { html: "<main>provider-owned capture content</main>" });
      },
    });
  });

  await t.test("provider pane authority adopts unambiguous current target by pane lineage for list read capture and restore", async () => {
    await withRuntimeHarness({
      now: () => 1_777_100,
      run: async ({ runtime, server, stateDir }) => {
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        const paneId = paneByLabel(screen, 1).paneId;
        const pushed = await runtime.push(
          {
            content: "<main>lineage authority content</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId,
          },
          { sessionKey: "agent:test:lineage-authority" },
        );
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(paneId);
        assert.ok(pane);
        const target = surface.targetRecords.get(pane.currentTargetId);
        assert.ok(target);

        pane.currentTargetId = null;
        pane.staleTargetId = null;
        pane.lastRestoreBlockedReason = null;
        await internalRuntime.persistSurfaceTargetState(surface, "test dropped pane current target pointer");

        const listed = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        const listedPane = listed?.panes.find((candidate) => candidate.paneId === paneId);
        assert.equal(listedPane?.target?.targetId, target.targetId);
        assert.equal(listedPane?.target?.blockedReason, null);
        assert.equal(pane.currentTargetId, target.targetId);

        const read = await runtime.read({ fingerprint: server.surfaceId, paneId });
        assert.equal(read.contentSnapshot?.contentId, pushed.contentId);
        assert.deepEqual(read.contentSnapshot?.content, { html: "<main>lineage authority content</main>" });

        server.snapshotImage = "bGluZWFnZS1mcmFtZQ==";
        const captured = await runtime.capturePane({ fingerprint: server.surfaceId, paneId });
        assert.equal(captured.capture.visibleContentId, pushed.contentId);
        assert.equal(captured.capture.failureReason, null);

        const restored = await runtime.restoreTarget({ fingerprint: server.surfaceId, paneId });
        assert.equal(restored.targetId, target.targetId);
        assert.equal(restored.blockedReason, null);
        assert.equal(restored.evidence?.status, "applied");

        await waitFor(async () => {
          const persisted = JSON.parse(
            await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
          );
          return persisted.targetStateBySurfaceId?.[server.surfaceId]?.paneTargets?.[pane.paneLineageId]
            ?.currentTargetId === target.targetId;
        });
      },
    });
  });

  await t.test("destructive clear tombstones lineage-only current provider target authority", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      now: () => 1_777_150,
      run: async ({ runtime, server, stateDir }) => {
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        const paneId = paneByLabel(screen, 1).paneId;
        await runtime.push({
          content: "https://example.com/clear-lineage-only-target",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId,
        });
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(paneId);
        assert.ok(pane);
        const target = surface.targetRecords.get(pane.currentTargetId);
        assert.ok(target);

        pane.currentTargetId = null;
        pane.staleTargetId = null;
        pane.lastRestoreBlockedReason = null;
        await internalRuntime.persistSurfaceTargetState(surface, "test clear lineage-only current target");

        await runtime.clear({ fingerprint: server.surfaceId, paneId });

        assert.equal(surface.targetRecords.get(target.targetId)?.currentState, "tombstoned");
        assert.equal(pane.currentTargetId, null);
        await waitFor(async () => {
          const persisted = JSON.parse(
            await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
          );
          return persisted.targetStateBySurfaceId?.[server.surfaceId]?.lifecycleEvents?.some(
            (event: any) =>
              event.event === "tombstone" &&
              event.targetId === target.targetId,
          );
        });
      },
    });
  });

  await t.test("destructive close tombstones lineage-only current provider target authority", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      now: () => 1_777_175,
      run: async ({ runtime, server, stateDir }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        await runtime.split({
          count: 2,
          direction: "horizontal",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const splitScreen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(splitScreen);
        const paneId = paneByLabel(splitScreen, 2).paneId;
        await runtime.push({
          content: "https://example.com/close-lineage-only-target",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId,
        });
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(paneId);
        assert.ok(pane);
        const target = surface.targetRecords.get(pane.currentTargetId);
        assert.ok(target);

        pane.currentTargetId = null;
        pane.staleTargetId = null;
        pane.lastRestoreBlockedReason = null;
        await internalRuntime.persistSurfaceTargetState(surface, "test close lineage-only current target");

        await runtime.closePane({ fingerprint: server.surfaceId, paneId });

        assert.equal(surface.targetRecords.get(target.targetId)?.currentState, "tombstoned");
        assert.equal(surface.panes.has(paneId), false);
        await waitFor(async () => {
          const persisted = JSON.parse(
            await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
          );
          return persisted.targetStateBySurfaceId?.[server.surfaceId]?.lifecycleEvents?.some(
            (event: any) =>
              event.event === "tombstone" &&
              event.targetId === target.targetId,
          );
        });
      },
    });
  });

  await t.test("provider pane authority makes ambiguous lineage targets stale instead of projecting null", async () => {
    await withRuntimeHarness({
      now: () => 1_777_200,
      run: async ({ runtime, server, stateDir }) => {
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        const paneId = paneByLabel(screen, 1).paneId;
        await runtime.push(
          {
            content: "<main>ambiguous lineage authority</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId,
          },
          { sessionKey: "agent:test:ambiguous-lineage-authority" },
        );
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(paneId);
        assert.ok(pane);
        const firstTarget = surface.targetRecords.get(pane.currentTargetId);
        assert.ok(firstTarget);
        const secondTargetId = "tg_ambiguous_lineage_second_current";
        surface.targetRecords.set(secondTargetId, {
          ...structuredClone(firstTarget),
          appliedAt: new Date(1_777_201).toISOString(),
          targetId: secondTargetId,
          targetEpoch: firstTarget.targetEpoch + 1,
        });
        pane.currentTargetId = null;
        pane.staleTargetId = null;
        pane.lastRestoreBlockedReason = null;
        await internalRuntime.persistSurfaceTargetState(surface, "test ambiguous current target records");

        const listed = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        const listedPane = listed?.panes.find((candidate) => candidate.paneId === paneId);
        assert.equal(listedPane?.target?.blockedReason, "pane_lineage_ambiguous");
        assert.notEqual(listedPane?.target?.targetId, undefined);
        assert.equal(firstTarget.currentState, "stale");
        assert.equal(surface.targetRecords.get(secondTargetId)?.currentState, "stale");
        assert.equal(pane.currentTargetId, null);
        assert.equal(pane.lastRestoreBlockedReason, "pane_lineage_ambiguous");

        await waitFor(async () => {
          const persisted = JSON.parse(
            await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
          );
          const targetState = persisted.targetStateBySurfaceId?.[server.surfaceId];
          return targetState?.targetRecords?.filter(
            (record: any) =>
              (record.targetId === firstTarget.targetId || record.targetId === secondTargetId) &&
              record.currentState === "stale",
          ).length === 2 &&
            targetState?.lifecycleEvents?.some(
              (event: any) =>
                event.event === "stale" &&
                event.reason === "pane_lineage_ambiguous",
            );
        });
      },
    });
  });

  await t.test("provider pane authority rejects duplicate current lineage targets even when a pane pointer exists", async () => {
    await withRuntimeHarness({
      now: () => 1_777_300,
      run: async ({ runtime, server, stateDir }) => {
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        const paneId = paneByLabel(screen, 1).paneId;
        await runtime.push(
          {
            content: "<main>duplicate pointer lineage authority</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId,
          },
          { sessionKey: "agent:test:duplicate-pointer-lineage" },
        );
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(paneId);
        assert.ok(pane);
        const firstTarget = surface.targetRecords.get(pane.currentTargetId);
        assert.ok(firstTarget);
        const secondTargetId = "tg_duplicate_pointer_lineage_current";
        surface.targetRecords.set(secondTargetId, {
          ...structuredClone(firstTarget),
          appliedAt: new Date(1_777_301).toISOString(),
          targetId: secondTargetId,
          targetEpoch: firstTarget.targetEpoch + 1,
        });
        await internalRuntime.persistSurfaceTargetState(surface, "test duplicate current target records with pointer");

        const listed = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        const listedPane = listed?.panes.find((candidate) => candidate.paneId === paneId);
        assert.equal(listedPane?.target?.blockedReason, "pane_lineage_ambiguous");
        assert.equal(firstTarget.currentState, "stale");
        assert.equal(surface.targetRecords.get(secondTargetId)?.currentState, "stale");
        assert.equal(pane.currentTargetId, null);
        assert.equal(pane.lastRestoreBlockedReason, "pane_lineage_ambiguous");

        await waitFor(async () => {
          const persisted = JSON.parse(
            await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
          );
          const targetState = persisted.targetStateBySurfaceId?.[server.surfaceId];
          return targetState?.targetRecords?.filter(
            (record: any) =>
              (record.targetId === firstTarget.targetId || record.targetId === secondTargetId) &&
              record.currentState === "stale",
          ).length === 2 &&
            targetState?.paneTargets?.[pane.paneLineageId]?.currentTargetId === null;
        });
      },
    });
  });

  await t.test("empty pair observation with mismatched lineage does not stale lineage-only provider target authority", async () => {
    await withRuntimeHarness({
      now: () => 1_777_400,
      run: async ({ runtime, server, stateDir }) => {
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        const paneId = paneByLabel(screen, 1).paneId;
        await runtime.push(
          {
            content: "<main>lineage-only provider target</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId,
          },
          { sessionKey: "agent:test:mismatched-empty-pair-lineage" },
        );
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(paneId);
        assert.ok(pane);
        const target = surface.targetRecords.get(pane.currentTargetId);
        assert.ok(target);
        const originalLineageId = pane.paneLineageId;
        const originalPaneLabel = pane.paneLabel;
        pane.currentTargetId = null;
        pane.staleTargetId = null;
        pane.lastRestoreBlockedReason = null;
        await internalRuntime.persistSurfaceTargetState(surface, "test lineage-only target before empty pair");

        internalRuntime.applyPairState(surface, {
          id: "rq_empty_pair_label_authority",
          op: "pair.response",
          payload: {
            capabilities: {
              contentTypes: ["html", "markdown"],
              eventTypes: [],
              protocolFeatures: ["authority.state.v1"],
              targetCapabilities: server.targetCapabilities,
            },
            ownershipEpoch: surface.ownershipEpoch,
            resumed: false,
            sessionId: surface.sessionId ?? "sa_test_session",
            state: {
              layout: { paneId: Number(pane.remotePaneId), type: "pane" },
              panes: [{
                contentType: null,
                currentContentId: null,
                currentRevision: pane.currentRevision,
                paneId: pane.remotePaneId,
                paneLabel: 99,
                paneLineageId: "pl_client_empty_pair_observation",
              }],
              topologyRevision: surface.topologyRevision,
            },
            surfaceName: surface.name,
            viewport: surface.viewport,
          },
          type: "response",
          v: 1,
        }, {
          ignoreEmptyPairContentAuthority: false,
          prunePairClearedPaneTargets: false,
          pruneStalePanes: false,
        });
        assert.equal(pane.paneLineageId, originalLineageId);
        assert.equal(pane.paneLabel, originalPaneLabel);
        assert.equal(surface.targetRecords.get(target.targetId)?.currentState, "current");

        server.pairPaneStateMutator = (paneState) => ({
          ...paneState,
          contentType: null,
          currentContentId: null,
          paneLabel: 99,
          paneLineageId: "pl_client_empty_pair_observation",
        });
        await surface.client.close(1000, "test_mismatched_empty_pair_lineage");

        await waitFor(() => server.pairRequests.length >= 2, 12_000);
        await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

        const listed = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        const listedPane = listed?.panes.find((candidate) => candidate.paneId === paneId);
        assert.equal(pane.paneLineageId, originalLineageId);
        assert.equal(pane.paneLabel, originalPaneLabel);
        assert.equal(listedPane?.paneLabel, originalPaneLabel);
        assert.equal(listedPane?.target?.targetId, target.targetId);
        assert.equal(listedPane?.target?.blockedReason, null);
        assert.equal(surface.targetRecords.get(target.targetId)?.currentState, "current");
        assert.equal(pane.currentTargetId, target.targetId);

        await waitFor(async () => {
          const persisted = JSON.parse(
            await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
          );
          return persisted.targetStateBySurfaceId?.[server.surfaceId]?.targetRecords?.some(
            (record: any) => record.targetId === target.targetId && record.currentState === "current",
          ) &&
            persisted.targetStateBySurfaceId?.[server.surfaceId]?.paneTargets?.[originalLineageId]?.currentTargetId === target.targetId;
        });
      },
    });
  });

  await t.test("empty pair observation does not rewrite provider-owned empty topology pane identity", async () => {
    await withRuntimeHarness({
      now: () => 1_777_450,
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const split = await runtime.split({
          count: 2,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const paneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(paneIds[1]!);
        assert.ok(pane);
        assert.equal(pane.activeContentId, null);
        assert.equal(pane.currentTargetId, null);
        assert.equal(pane.snapshot, null);
        const originalLineageId = pane.paneLineageId;
        const originalPaneLabel = pane.paneLabel;

        internalRuntime.applyPairState(surface, {
          id: "rq_empty_pair_topology_identity",
          op: "pair.response",
          payload: {
            capabilities: {
              contentTypes: ["html", "markdown"],
              eventTypes: [],
              protocolFeatures: ["authority.state.v1"],
              targetCapabilities: server.targetCapabilities,
            },
            ownershipEpoch: surface.ownershipEpoch,
            resumed: false,
            sessionId: surface.sessionId ?? "sa_test_session",
            state: {
              layout: { paneId: Number(pane.remotePaneId), type: "pane" },
              panes: [{
                contentType: null,
                currentContentId: null,
                currentRevision: pane.currentRevision,
                paneId: pane.remotePaneId,
                paneLabel: 99,
                paneLineageId: "pl_client_empty_pair_topology_observation",
              }],
              topologyRevision: surface.topologyRevision,
            },
            surfaceName: surface.name,
            viewport: surface.viewport,
          },
          type: "response",
          v: 1,
        }, {
          ignoreEmptyPairContentAuthority: false,
          prunePairClearedPaneTargets: false,
          pruneStalePanes: false,
        });

        assert.equal(pane.paneLineageId, originalLineageId);
        assert.equal(pane.paneLabel, originalPaneLabel);
        assert.equal(pane.activeContentId, null);
        assert.equal(pane.currentTargetId, null);
      },
    });
  });

  await t.test("hydrate makes ambiguous lineage-only current targets stale before ownership rebind chooses a winner", async () => {
    await withRuntimeHarness({
      now: () => 1_777_500,
      run: async ({ discovery, runtime, server, stateDir }) => {
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        const paneId = paneByLabel(screen, 1).paneId;
        await runtime.push(
          {
            content: "<main>ambiguous persisted lineage authority</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId,
          },
          { sessionKey: "agent:test:hydrate-ambiguous-lineage" },
        );
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(paneId);
        assert.ok(pane);
        const firstTarget = surface.targetRecords.get(pane.currentTargetId);
        assert.ok(firstTarget);
        const secondTargetId = "tg_hydrate_ambiguous_lineage_current";
        surface.targetRecords.set(secondTargetId, {
          ...structuredClone(firstTarget),
          appliedAt: new Date(1_777_501).toISOString(),
          targetId: secondTargetId,
          targetEpoch: firstTarget.targetEpoch + 1,
        });
        pane.currentTargetId = null;
        pane.staleTargetId = null;
        pane.lastRestoreBlockedReason = null;
        await internalRuntime.persistSurfaceTargetState(surface, "test ambiguous lineage-only hydrate records");

        surface.targetRecords.clear();
        pane.currentTargetId = null;
        pane.staleTargetId = null;
        pane.lastRestoreBlockedReason = null;
        internalRuntime.hydrateSurfaceTargetState(surface, true, {
          ownershipEpoch: surface.ownershipEpoch - 1,
          sessionId: "sa_previous_hydrate_session",
        });

        const listed = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(listed);
        assert.equal(listed.panes.find((candidate) => candidate.paneId === paneId)?.target?.blockedReason, "pane_lineage_ambiguous");
        assert.equal(surface.targetRecords.get(firstTarget.targetId)?.currentState, "stale");
        assert.equal(surface.targetRecords.get(secondTargetId)?.currentState, "stale");
        assert.equal(pane.currentTargetId, null);

        await waitFor(async () => {
          let persisted: any;
          try {
            persisted = JSON.parse(
              await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
            );
          } catch {
            return false;
          }
          const targetState = persisted.targetStateBySurfaceId?.[server.surfaceId];
          return targetState?.targetRecords?.filter(
            (record: any) =>
              (record.targetId === firstTarget.targetId || record.targetId === secondTargetId) &&
              record.currentState === "stale",
          ).length === 2 &&
            targetState?.lifecycleEvents?.some(
              (event: any) =>
                event.event === "stale" &&
                event.reason === "pane_lineage_ambiguous",
            );
        }, 12_000);
      },
    });
  });

  await t.test("ambiguous provider pane labels reject content push before applied-looking success", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      const paneId = paneByLabel(screen, 1).paneId;
      server.panes.set(77, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: 1,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });

      await assert.rejects(
        async () =>
          await runtime.push(
            {
              content: "# ambiguous pane identity",
              contentType: "markdown",
              fingerprint: server.surfaceId,
              paneId,
            },
            { sessionKey: "agent:test:ambiguous-pane-identity" },
          ),
        /duplicate pane labels/,
      );
      assert.equal(server.contentSetRequests.length, 0);
    });
  });

  await t.test("provider-visible pane labels cannot duplicate within one surface", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      server.panes.set(77, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: 1,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });

      await assert.rejects(
        async () => internalRuntime.syncSurfaceSnapshots(surface, true),
        /duplicate pane labels/,
      );
    });
  });

  await t.test("provider-visible pane labels displace stale local label collisions", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      server.panes.set(77, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: 2,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });
      await internalRuntime.syncSurfaceSnapshots(surface, true);

      const firstPane = internalRuntime.findPaneByRemoteId(surface, server.initialRemotePaneId);
      const secondPane = internalRuntime.findPaneByRemoteId(surface, 77);
      assert.ok(firstPane);
      assert.ok(secondPane);
      assert.equal(firstPane.paneLabel, 1);
      assert.equal(secondPane.paneLabel, 2);

      internalRuntime.adoptProviderPaneLabels(surface, [
        { pane: firstPane, paneLabel: 2, remotePaneId: firstPane.remotePaneId },
      ]);

      assert.equal(firstPane.paneLabel, 2);
      assert.equal(secondPane.paneLabel, 1);
      const screen = (await runtime.listScreens())[0];
      assert.ok(screen);
      assert.equal(new Set(screen.panes.map((pane) => pane.paneLabel)).size, screen.panes.length);
    });
  });

  await t.test("provider-visible pane labels can swap within one surface", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      server.panes.set(77, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: 2,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });
      await internalRuntime.syncSurfaceSnapshots(surface, true);

      const firstRemotePane = server.panes.get(server.initialRemotePaneId);
      const secondRemotePane = server.panes.get(77);
      assert.ok(firstRemotePane);
      assert.ok(secondRemotePane);
      firstRemotePane.paneLabel = 2;
      secondRemotePane.paneLabel = 1;

      await internalRuntime.syncSurfaceSnapshots(surface, true);
      const firstPane = internalRuntime.findPaneByRemoteId(surface, server.initialRemotePaneId);
      const secondPane = internalRuntime.findPaneByRemoteId(surface, 77);
      assert.equal(firstPane?.paneLabel, 2);
      assert.equal(secondPane?.paneLabel, 1);
      const screen = (await runtime.listScreens())[0];
      assert.ok(screen);
      assert.equal(new Set(screen.panes.map((pane) => pane.paneLabel)).size, screen.panes.length);
    });
  });

  await t.test("provider pane labels do not advance new local pane label allocation before later splits", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      server.panes.set(77, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: 3,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });

      await internalRuntime.syncSurfaceSnapshots(surface, true);
      await waitFor(async () => (await runtime.listScreens())[0]?.panes.length === 2, 12_000);
      const sourcePaneId = await livePaneId(runtime, server.surfaceId, 1);

      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: sourcePaneId,
      });

      const topologyApply = server.topologyApplyRequests.at(-1);
      assert.deepEqual(
        topologyApply?.paneIds
          .map((paneId, index) => ({ paneId, paneLabel: topologyApply.paneLabels[index] }))
          .sort((left, right) => left.paneLabel - right.paneLabel),
        [
          { paneId: server.initialRemotePaneId, paneLabel: 1 },
          { paneId: 78, paneLabel: 2 },
          { paneId: 77, paneLabel: 3 },
        ],
      );
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);
    });
  });

  await t.test("same-session preserved topology records empty pair.response without clearing provider authority", async () => {
    await withRuntimeHarness(async ({ runtime, server, stateDir }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.split({
        count: 2,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const pane = internalRuntime.findPaneByRemoteId(surface, server.initialRemotePaneId);
      assert.ok(pane);
      pane.activeContentId = "ct_preserve_topology_stale";
      pane.contentType = "markdown";
      pane.contentValue = null;
      pane.diagnosticContent = {
        diagnosticContentId: "dg_preserve_topology_stale",
        kind: "status",
        summary: "stale visible diagnostic",
        shownAt: new Date().toISOString(),
      };
      assert.ok(pane.diagnosticContent);

      internalRuntime.applyPairPaneState(
        surface,
        [
          {
            contentType: null,
            currentContentId: null,
            currentRevision: pane.currentRevision,
            paneId: server.initialRemotePaneId,
            paneLabel: pane.paneLabel,
            paneLineageId: pane.paneLineageId,
          },
        ],
        true,
        { pruneStalePanes: false },
      );

      assert.equal(pane.activeContentId, "ct_preserve_topology_stale");
      assert.equal(pane.contentType, "markdown");
      assert.equal(pane.contentValue, null);
      assert.ok(pane.diagnosticContent);
      const snapshotPath = path.join(stateDir, "surf-ace-runtime-screens.json");
      await waitFor(async () => {
        const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
        const persistedScreen = snapshot.screens.find(
          (candidate: { fingerprint?: string }) => candidate.fingerprint === server.surfaceId,
        );
        const persistedPane = persistedScreen?.panes?.find(
          (candidate: { paneId?: string }) => candidate.paneId === pane.paneId,
        );
        return persistedPane?.activeContent?.contentId === "ct_preserve_topology_stale";
      });
    });
  });

  await t.test("multiple surfaces expose unique window labels and surface-local pane labels", async () => {
    const portA = nextPort++;
    const portB = nextPort++;
    const serverA = new FakeSurfAceWsServer(portA, { surfaceId: "sf_surface-a" });
    const serverB = new FakeSurfAceWsServer(portB, { surfaceId: "sf_surface-b" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-multi-"));
    const discovery = new StaticDiscoveryService([
      discoveryEndpoint(portA, "aaaabbbb"),
      discoveryEndpoint(portB, "ccccdddd"),
    ]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => serverA.pairedSocket !== null && serverB.pairedSocket !== null);

      const screens = await runtime.listScreens();
      const firstPaneIds = screens.map((screen) => {
        const paneId = screen.panes[0]?.paneId;
        assertOpaquePaneId(paneId);
        return paneId;
      });
      assert.deepEqual(
        screens.map((screen) => ({
          windowLabel: screen.windowLabel,
        })),
        [
          { windowLabel: "a" },
          { windowLabel: "b" },
        ],
      );
      const visibleCoordinates = screens.flatMap((screen) =>
        screen.panes.map((pane) => `${screen.windowLabel}:${pane.paneLabel}`)
      );
      const visibleAddresses = screens.flatMap((screen) => screen.panes.map((pane) => pane.paneAddress));
      const displayIds = screens.flatMap((screen) => screen.panes.map((pane) => pane.displayId));
      const paneLabels = screens.flatMap((screen) => screen.panes.map((pane) => pane.paneLabel));
      assert.equal(paneLabels.every((paneLabel) => Number.isInteger(paneLabel) && paneLabel > 0), true);
      assert.equal(new Set(visibleCoordinates).size, visibleCoordinates.length);
      assert.equal(new Set(visibleAddresses).size, visibleAddresses.length);
      assert.equal(new Set(displayIds).size, displayIds.length);
      assert.deepEqual(displayIds.sort(), ["1", "2"]);
      assert.deepEqual(visibleAddresses.sort(), ["1", "2"]);
      assert.equal(new Set(firstPaneIds).size, firstPaneIds.length);
        assert.deepEqual(
          [serverA.pairRequests[0]?.windowLabel, serverB.pairRequests[0]?.windowLabel].sort(),
          ["a", "b"],
        );
        assert.equal(
          serverA.pairRequests[0]?.windowLabel,
          screens.find((screen) => screen.fingerprint === serverA.surfaceId)?.windowLabel,
        );
        assert.equal(
          serverB.pairRequests[0]?.windowLabel,
          screens.find((screen) => screen.fingerprint === serverB.surfaceId)?.windowLabel,
        );
      const initialRemotePaneIds = [
        serverA.pairRequests[0]?.initialPaneId,
        serverB.pairRequests[0]?.initialPaneId,
      ].filter((paneId): paneId is number => typeof paneId === "number");
      assert.equal(new Set(initialRemotePaneIds).size, 2);
      assert.ok(initialRemotePaneIds.every((paneId) => paneId > 0));
      assert.deepEqual(
        [serverA.pairRequests[0]?.initialPaneLabel, serverB.pairRequests[0]?.initialPaneLabel].sort(),
        [1, 2],
      );
    } finally {
      await runtime.stop();
      await serverB.close();
      await serverA.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("pane label repair rewrites matching labels across windows before visible exposure", async () => {
    const portA = nextPort++;
    const portB = nextPort++;
    const serverA = new FakeSurfAceWsServer(portA, { surfaceId: "sf_surface-a" });
    const serverB = new FakeSurfAceWsServer(portB, { surfaceId: "sf_surface-b" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-pane-label-repair-publish-"));
    const discovery = new StaticDiscoveryService([
      discoveryEndpoint(portA, "aaaabbbb"),
      discoveryEndpoint(portB, "ccccdddd"),
    ]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => serverA.pairedSocket !== null && serverB.pairedSocket !== null);

      const internalRuntime = runtime as any;
      const surfaceA = internalRuntime.surfaces.get(serverA.surfaceId);
      const surfaceB = internalRuntime.surfaces.get(serverB.surfaceId);
      assert.ok(surfaceA);
      assert.ok(surfaceB);
      const paneA = [...surfaceA.panes.values()][0];
      const paneB = [...surfaceB.panes.values()][0];
      assert.ok(paneA);
      assert.ok(paneB);
      paneA.paneLabel = 1;
      paneB.paneLabel = 1;
      internalRuntime.persistentState.paneLabelsByPaneId[`${serverA.surfaceId}::${Number(paneA.remotePaneId)}`] = 1;
      internalRuntime.persistentState.paneLabelsByPaneId[`${serverB.surfaceId}::${Number(paneB.remotePaneId)}`] = 1;
      serverA.topologyApplyRequests.length = 0;
      serverB.topologyApplyRequests.length = 0;

      const screens = await runtime.listScreens();
      assert.deepEqual(
        screens.map((screen) => ({ paneLabel: screen.panes[0]?.paneLabel, windowLabel: screen.windowLabel })),
        [
          { paneLabel: 1, windowLabel: "a" },
          { paneLabel: 2, windowLabel: "b" },
        ],
      );
      assert.deepEqual(screens.flatMap((screen) => screen.panes.map((pane) => pane.displayId)).sort(), ["1", "2"]);
      assert.deepEqual(screens.flatMap((screen) => screen.panes.map((pane) => pane.paneAddress)).sort(), ["1", "2"]);
      assert.equal(new Set(screens.flatMap((screen) => screen.panes.map((pane) => pane.paneLabel))).size, 2);
      assert.equal(serverA.topologyApplyRequests.length, 0);
      assert.equal(serverB.topologyApplyRequests.length, 0);
    } finally {
      await runtime.stop();
      await serverB.close();
      await serverA.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surfaces.list binds and pairs every surface exposed by one endpoint", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    server.addSurface({ initialRemotePaneId: 43, name: "Surface C", surfaceId: "sf_surface-c" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-multi-surface-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() =>
        server.pairedSocketFor("sf_surface-a") !== null &&
        server.pairedSocketFor("sf_surface-b") !== null &&
        server.pairedSocketFor("sf_surface-c") !== null,
      );

      const screens = await runtime.listScreens();
      const paneIds = screens.flatMap((screen) => screen.panes.map((pane) => pane.paneId));
      for (const paneId of paneIds) {
        assertOpaquePaneId(paneId);
      }
      assert.equal(new Set(paneIds).size, paneIds.length);
      assert.deepEqual(
        screens.map((screen) => ({
          fingerprint: screen.fingerprint,
          windowLabel: screen.windowLabel,
        })),
        [
          { fingerprint: "sf_surface-a", windowLabel: "a" },
          { fingerprint: "sf_surface-b", windowLabel: "b" },
          { fingerprint: "sf_surface-c", windowLabel: "c" },
        ],
      );
      const visibleCoordinates = screens.flatMap((screen) =>
        screen.panes.map((pane) => `${screen.windowLabel}:${pane.paneLabel}`)
      );
      const paneLabels = screens.flatMap((screen) => screen.panes.map((pane) => pane.paneLabel));
      assert.equal(paneLabels.every((paneLabel) => Number.isInteger(paneLabel) && paneLabel > 0), true);
      assert.equal(new Set(visibleCoordinates).size, visibleCoordinates.length);

      const requestsBySurface = new Map(
        server.pairRequestSurfaceIds.map((surfaceId, index) => [surfaceId, server.pairRequests[index]]),
      );
      assert.deepEqual([...requestsBySurface.keys()].sort(), [
        "sf_surface-a",
        "sf_surface-b",
        "sf_surface-c",
      ]);
      assert.equal(requestsBySurface.get("sf_surface-a")?.windowLabel, "a");
      assert.equal(requestsBySurface.get("sf_surface-b")?.windowLabel, "b");
      assert.equal(requestsBySurface.get("sf_surface-c")?.windowLabel, "c");
      const initialRemotePaneIds = [...requestsBySurface.values()]
        .map((request) => request?.initialPaneId)
        .filter((paneId): paneId is number => typeof paneId === "number");
      assert.equal(new Set(initialRemotePaneIds).size, 3);
      assert.ok(initialRemotePaneIds.every((paneId) => paneId > 0));
      assert.deepEqual(
        [...requestsBySurface.values()].map((request) => request?.initialPaneLabel).sort(),
        [1, 2, 3],
      );
      const internalRuntime = runtime as any;
      assert.deepEqual(
        [...internalRuntime.surfaces.keys()].sort(),
        ["sf_surface-a", "sf_surface-b", "sf_surface-c"],
      );
      assert.equal(internalRuntime.endpointProbes.size, 1);
      const endpointProbe = internalRuntime.endpointProbes.get(`endpoint-${port}`);
      assert.ok(endpointProbe);
      assert.equal("surfaceId" in endpointProbe, false);
      assert.equal("panes" in endpointProbe, false);
      assert.equal(server.pairedSocketFor("sf_surface-a") === server.pairedSocketFor("sf_surface-b"), false);
      assert.equal(server.pairedSocketFor("sf_surface-b") === server.pairedSocketFor("sf_surface-c"), false);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("endpoint probe retries without visible leakage when surfaces.list is unavailable", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.surfacesListErrorCode = "unsupported";
      },
      waitForPair: false,
      run: async ({ runtime, server, stateDir }) => {
        const internalRuntime = runtime as any;
        await waitFor(() => server.surfacesListRequests >= 2, 12_000);
        assert.deepEqual(await runtime.listScreens(), []);
        assert.deepEqual([...internalRuntime.surfaces.keys()], []);
        assert.equal(internalRuntime.endpointProbes.size, 1);
        assert.equal([...internalRuntime.surfaces.keys()].some((surfaceId) => surfaceId.startsWith("sf_disc_")), false);
        assert.deepEqual(server.pairRequestSurfaceIds, []);
      },
    });
  });

  await t.test("endpoint probe dedupes volatile discovery aliases by fingerprint", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-endpoint-alias-dedupe-"));
    const endpointA = discoveryEndpoint(port, "aliasfp");
    const endpointB = {
      ...endpointA,
      endpointId: "endpoint-alias-hostname",
      host: "localhost",
      lastSeenAt: endpointA.lastSeenAt + 1,
    };
    const discovery = new StaticDiscoveryService([endpointA, endpointB]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => server.pairedSocket !== null, 12_000);

      const internalRuntime = runtime as any;
      assert.equal(internalRuntime.endpointProbes.size, 1);
      const probe = [...internalRuntime.endpointProbes.values()][0];
      assert.ok(probe);
      assert.equal(probe.endpointId, endpointB.endpointId);
      assert.equal(probe.canonicalKey, "fp:aliasfp");
      assert.equal("surfaceId" in probe, false);
      assert.equal("panes" in probe, false);

      const endpointC = {
        ...endpointA,
        endpointId: "endpoint-alias-ipv4",
        host: "127.0.0.1",
        lastSeenAt: endpointA.lastSeenAt,
      };
      probe.unreachableFailures = 1;
      discovery.setEndpoints([endpointB, endpointC]);
      await discovery.refreshNow();

      assert.equal(internalRuntime.endpointProbes.size, 1);
      assert.equal([...internalRuntime.endpointProbes.values()][0], probe);
      assert.equal(probe.endpointId, endpointC.endpointId);
      assert.equal(internalRuntime.surfaces.get(server.surfaceId)?.endpointId, endpointB.endpointId);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surfaces.list alias reconciliation removes closed sibling windows by endpoint fingerprint", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-endpoint-alias-remove-"));
    const endpointA = discoveryEndpoint(port, "aliasremove");
    const endpointB = {
      ...endpointA,
      endpointId: "endpoint-alias-remove-hostname",
      host: "localhost",
      lastSeenAt: endpointA.lastSeenAt + 1,
    };
    const endpointC = {
      ...endpointA,
      endpointId: "endpoint-alias-remove-ipv4",
      host: "127.0.0.1",
      lastSeenAt: endpointA.lastSeenAt + 2,
    };
    const discovery = new StaticDiscoveryService([endpointA, endpointB]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => server.pairedSocketFor("sf_surface-a") !== null && server.pairedSocketFor("sf_surface-b") !== null, 12_000);

      const internalRuntime = runtime as any;
      assert.equal(internalRuntime.surfaces.get("sf_surface-b")?.endpointId, endpointB.endpointId);
      internalRuntime.reconcileCanonicalSurfacesFromRemoteList({
        endpoint: endpointC,
        remoteSurfaces: [
          {
            name: "Surface A",
            paired: true,
            surfaceId: "sf_surface-a",
            viewport: endpointC.viewport,
          },
        ],
        source: "surfaces.list",
        startDiscoveredSiblings: true,
      });

      assert.equal(internalRuntime.surfaces.has("sf_surface-b"), false);
      assert.equal((await runtime.listScreens()).some((screen) => screen.fingerprint === "sf_surface-b"), false);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("provider pane labels are repaired into global display tokens before exposure", async () => {
    const portA = nextPort++;
    const portB = nextPort++;
    const serverA = new FakeSurfAceWsServer(portA, {
      initialRemotePaneId: 6242,
      surfaceId: "sf_surface-a",
    });
    const serverB = new FakeSurfAceWsServer(portB, {
      initialRemotePaneId: 6243,
      surfaceId: "sf_surface-b",
    });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-duplicate-pane-labels-"));
    const discovery = new StaticDiscoveryService([
      discoveryEndpoint(portA, "aaaabbbb"),
      discoveryEndpoint(portB, "ccccdddd"),
    ]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 6244,
            nextRemotePaneId: 6244,
            nextWindowLabelIndex: 2,
            paneLabelsByPaneId: {
              [`${serverA.surfaceId}::6242`]: 1,
              [`${serverB.surfaceId}::6243`]: 2,
            },
            providerId: "pv_test_provider",
            version: 1,
            windowLabels: {
              [serverA.surfaceId]: "fx",
              [serverB.surfaceId]: "fw",
            },
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(() => serverA.pairedSocket !== null && serverB.pairedSocket !== null);

      const screens = await runtime.listScreens();
      assert.deepEqual(
        screens.map((screen) => ({
          windowLabel: screen.windowLabel,
        })),
          [
            { windowLabel: "fw" },
            { windowLabel: "fx" },
          ],
        );
      const visibleCoordinates = screens.flatMap((screen) =>
        screen.panes.map((pane) => `${screen.windowLabel}:${pane.paneLabel}`)
      );
      const visibleAddresses = screens.flatMap((screen) => screen.panes.map((pane) => pane.paneAddress));
      const displayIds = screens.flatMap((screen) => screen.panes.map((pane) => pane.displayId));
      const paneLabels = screens.flatMap((screen) => screen.panes.map((pane) => pane.paneLabel));
      assert.equal(paneLabels.every((paneLabel) => Number.isInteger(paneLabel) && paneLabel > 0), true);
      assert.deepEqual([...paneLabels].sort((a, b) => a - b), [1, 2]);
      assert.equal(new Set(visibleCoordinates).size, visibleCoordinates.length);
      assert.deepEqual(displayIds.sort(), ["1", "2"]);
      assert.deepEqual(visibleAddresses.sort(), ["1", "2"]);
      assert.equal(displayIds.includes("e1"), false);
      assert.equal(displayIds.includes("e16"), false);
      assert.equal(displayIds.includes("b13"), false);
      assert.equal(displayIds.every((displayId) => !/^[a-z]+-?\d+$/i.test(displayId)), true);
      assert.deepEqual(
        [serverA.pairRequests[0]?.initialPaneLabel, serverB.pairRequests[0]?.initialPaneLabel].sort(),
        [1, 2],
      );
      const repairedState = JSON.parse(await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"));
      assert.deepEqual(
        [
          repairedState.paneLabelsByPaneId[`${serverA.surfaceId}::6242`],
          repairedState.paneLabelsByPaneId[`${serverB.surfaceId}::6243`],
        ].sort(),
        [1, 2],
      );
      assert.equal(repairedState.nextPaneLabel >= 3, true);
    } finally {
      await runtime.stop();
      await serverB.close();
      await serverA.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("duplicate persisted window labels are repaired before visible coordinate exposure", async () => {
    const portA = nextPort++;
    const portB = nextPort++;
    const serverA = new FakeSurfAceWsServer(portA, {
      initialRemotePaneId: 6242,
      surfaceId: "sf_surface-a",
    });
    const serverB = new FakeSurfAceWsServer(portB, {
      initialRemotePaneId: 6243,
      surfaceId: "sf_surface-b",
    });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-duplicate-window-labels-"));
    const discovery = new StaticDiscoveryService([
      discoveryEndpoint(portA, "aaaabbbb"),
      discoveryEndpoint(portB, "ccccdddd"),
    ]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 6244,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {
              [`${serverA.surfaceId}::6242`]: 1,
              [`${serverB.surfaceId}::6243`]: 1,
            },
            providerId: "pv_test_provider",
            version: 1,
            windowLabels: {
              [serverA.surfaceId]: "a",
              [serverB.surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(() => serverA.pairedSocket !== null && serverB.pairedSocket !== null);

      const screens = await runtime.listScreens();
      assert.deepEqual(
        screens.map((screen) => ({
          windowLabel: screen.windowLabel,
        })),
        [
          { windowLabel: "a" },
          { windowLabel: "b" },
        ],
      );
      const visibleCoordinates = screens.flatMap((screen) =>
        screen.panes.map((pane) => `${screen.windowLabel}:${pane.paneLabel}`)
      );
      const paneLabels = screens.flatMap((screen) => screen.panes.map((pane) => pane.paneLabel));
      assert.deepEqual(paneLabels.sort((left, right) => left - right), [1, 2]);
      assert.equal(new Set(visibleCoordinates).size, visibleCoordinates.length);
      assert.deepEqual(
        [serverA.pairRequests[0]?.windowLabel, serverB.pairRequests[0]?.windowLabel].sort(),
        ["a", "b"],
      );
      assert.deepEqual(
        [serverA.pairRequests[0]?.initialPaneLabel, serverB.pairRequests[0]?.initialPaneLabel].sort(),
        [1, 2],
      );
      const screenA = screens.find((screen) => screen.fingerprint === serverA.surfaceId);
      const screenB = screens.find((screen) => screen.fingerprint === serverB.surfaceId);
      assert.ok(screenA?.panes[0]);
      assert.ok(screenB?.panes[0]);
      await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: screenA.fingerprint,
        paneId: screenA.panes[0].paneId,
      });
      await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: screenB.fingerprint,
        paneId: screenB.panes[0].paneId,
      });
      assert.equal(serverA.topologyApplyRequests.at(-1)?.windowLabel, "a");
      assert.equal(serverB.topologyApplyRequests.at(-1)?.windowLabel, "b");
      const repairedState = JSON.parse(await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"));
      assert.deepEqual(
        [repairedState.windowLabels[serverA.surfaceId], repairedState.windowLabels[serverB.surfaceId]].sort(),
        ["a", "b"],
      );
    } finally {
      await runtime.stop();
      await serverB.close();
      await serverA.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("invalid persisted window labels are repaired before pair and authority state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-invalid-window-label-"));
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, {
      initialRemotePaneId: 6242,
      surfaceId: "sf_invalid-window-label",
    });
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port, "aaaabbbb")]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 6243,
            nextWindowLabelIndex: 0,
            paneLabelsByPaneId: {
              [`${server.surfaceId}::6242`]: 1,
            },
            providerId: "pv_test_provider",
            version: 1,
            windowLabels: {
              [server.surfaceId]: "Aleph",
            },
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(() => server.authorityStateRequests.some((request) => request.actionable), 12_000);

      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      assert.equal(screen.windowLabel, "a");
      assert.equal(server.pairRequests[0]?.windowLabel, "a");
      assert.equal(server.authorityStateRequests.at(-1)?.windowLabel, "a");
      const repairedState = JSON.parse(await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"));
      assert.equal(repairedState.windowLabels[server.surfaceId], "a");
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("client topology responses cannot overwrite provider pane labels with duplicates", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      server.nextTopologyApplyResponsePaneLabels = [77, 77, 77];
      const paneId = await livePaneId(runtime, server.surfaceId, 1);

      await assert.rejects(
        runtime.split({
          count: 3,
          direction: "horizontal",
          fingerprint: server.surfaceId,
          paneId,
        }),
        /duplicate pane labels/,
      );

      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assertPaneLabelsWithOpaqueIds(screen?.panes ?? [], [1]);
      assert.deepEqual(server.topologyApplyRequests.at(-1)?.paneLabels, [1, 2, 3]);
    });
  });

  await t.test("client topology rejection is logged with pane label context", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      server.nextTopologyApplyError = {
        code: "invalid_payload",
        message: "duplicate or invalid paneLabel in surface payload",
      };

      await assert.rejects(
        runtime.split({
          count: 2,
          direction: "horizontal",
          fingerprint: server.surfaceId,
          paneId: await livePaneId(runtime, server.surfaceId, 1),
        }),
        /duplicate or invalid paneLabel in surface payload/,
      );

      assert.ok(
        warnings.some((warning) =>
          warning.includes("event=topology_apply_error") &&
          warning.includes(`surface_id=${server.surfaceId}`) &&
          warning.includes("window_label=a") &&
          warning.includes("session_id=sa_test_session") &&
          warning.includes("pane_count=2") &&
          warning.includes("remote_pane_ids=41,42") &&
          warning.includes("pane_labels=1,2") &&
          warning.includes("error_code=invalid_payload") &&
          warning.includes("duplicate or invalid paneLabel in surface payload")
        ),
      );
    });
  });

  await t.test("surfaces.list removes an established surface missing from the authoritative list", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });

      const internalRuntime = runtime as any;
      const preservedSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(preservedSurface);
      const staleSurface = {
        ...preservedSurface,
        client: {
          isOpen: () => true,
          request: async () => ({
            id: "rq_surfaces_list",
            ok: true,
            op: "surfaces.list",
            payload: {
              surfaces: [
                {
                  name: "Surface A",
                  paired: true,
                  surfaceId: server.surfaceId,
                  viewport: preservedSurface.viewport,
                },
                {
                  name: "Surface B",
                  paired: false,
                  surfaceId: "sf_surface-b",
                  viewport: preservedSurface.viewport,
                },
              ],
            },
            sentAt: Date.now(),
            type: "response",
            v: 1,
          }),
        },
        connectedAt: null,
        hasPairedInGatewaySession: false,
        panes: new Map(),
        recentEventIds: [],
        recentEventIdsSet: new Set(),
        retryDelayResolver: null,
        sessionId: null,
        snapshotBufferedEvents: [],
        stopRequested: false,
        surfaceId: "sf_stale-window" as any,
        workPromise: null,
      };
      internalRuntime.surfaces.set(staleSurface.surfaceId, staleSurface);

      await internalRuntime.discoverSurfaceId(staleSurface);

      assert.equal(staleSurface.surfaceId, "sf_stale-window");
      assert.equal(staleSurface.stopRequested, true);
      assert.equal(internalRuntime.surfaces.has("sf_stale-window"), false);
      assert.equal(internalRuntime.surfaces.get(server.surfaceId), preservedSurface);
      assert.ok(internalRuntime.surfaces.get("sf_surface-b"));
    });
  });

  await t.test("endpoint reconciliation preserves every live surface on a multi-window endpoint", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    server.addSurface({ initialRemotePaneId: 43, name: "Surface C", surfaceId: "sf_surface-c" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-multi-reconcile-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port, "aaaabbbb")]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() =>
        server.pairedSocketFor("sf_surface-a") !== null &&
        server.pairedSocketFor("sf_surface-b") !== null &&
        server.pairedSocketFor("sf_surface-c") !== null,
      );

      const internalRuntime = runtime as any;
      const replacementEndpoint = {
        ...discoveryEndpoint(nextPort++, "aaaabbbb"),
        endpointId: "endpoint-replacement",
      };
      internalRuntime.refreshEndpointTopology(replacementEndpoint);

      for (const surfaceId of ["sf_surface-a", "sf_surface-b", "sf_surface-c"]) {
        const surface = internalRuntime.surfaces.get(surfaceId);
        assert.ok(surface);
        assert.equal(surface.endpointId, `endpoint-${port}`);
      }
      assert.deepEqual(
        [...internalRuntime.surfaces.keys()].filter((surfaceId) => surfaceId.startsWith("sf_surface-")).sort(),
        ["sf_surface-a", "sf_surface-b", "sf_surface-c"],
      );
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surface appeared and removed events add and drop live surfaces on one endpoint", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-surface-events-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => server.pairedSocket !== null);

      server.sendSurfaceAppeared({
        initialRemotePaneId: 42,
        name: "Surface B",
        surfaceId: "sf_surface-b",
      });

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          server.pairedSocketFor("sf_surface-b") !== null &&
          screens.some((screen) => screen.fingerprint === "sf_surface-b")
        );
      });

      assert.deepEqual(
        (await runtime.listScreens()).map((screen) => screen.fingerprint),
        ["sf_surface-a", "sf_surface-b"],
      );

      server.sendSurfaceRemoved({ surfaceId: "sf_surface-b" });

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          server.pairedSocketFor("sf_surface-b") === null &&
          !screens.some((screen) => screen.fingerprint === "sf_surface-b")
        );
      });

      assert.deepEqual(
        (await runtime.listScreens()).map((screen) => screen.fingerprint),
        ["sf_surface-a"],
      );
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surface appeared for an already listed canonical sibling does not duplicate the visible registry", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-surface-appeared-duplicate-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() =>
        server.pairedSocketFor("sf_surface-a") !== null &&
        server.pairedSocketFor("sf_surface-b") !== null,
      );

      server.sendSurfaceAppeared({
        initialRemotePaneId: 42,
        name: "Surface B",
        surfaceId: "sf_surface-b",
      });

      await waitFor(async () => (await runtime.listScreens()).length === 2);

      const internalRuntime = runtime as any;
      assert.deepEqual(
        (await runtime.listScreens()).map((screen) => screen.fingerprint),
        ["sf_surface-a", "sf_surface-b"],
      );
      assert.deepEqual(
        [...internalRuntime.surfaces.keys()].sort(),
        ["sf_surface-a", "sf_surface-b"],
      );
      assert.equal(internalRuntime.endpointProbes.size, 1);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surfaces.list absence removes a closed sibling window even if the lifecycle event was missed", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-missed-surface-remove-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      let surfaceBScreen = (await runtime.listScreens()).find((screen) => screen.fingerprint === "sf_surface-b");
      await waitFor(async () => {
        surfaceBScreen = (await runtime.listScreens()).find((screen) => screen.fingerprint === "sf_surface-b");
        return Boolean(surfaceBScreen);
      });

      const paneId = surfaceBScreen!.panes[0]!.paneId;
      await runtime.push(
        {
          content: "<p>closed window content</p>",
          contentType: "html",
          fingerprint: "sf_surface-b",
          paneId,
        },
        { sessionDisplayName: "Session B", sessionKey: "agent:test:surface-b" },
      );
      const internalRuntime = runtime as any;
      assert.ok(internalRuntime.persistentState.targetStateBySurfaceId["sf_surface-b"]);

      server.removeSurfaceWithoutEvent("sf_surface-b");
      const primarySurface = internalRuntime.surfaces.get("sf_surface-a");
      assert.ok(primarySurface);
      await internalRuntime.discoverSurfaceId(primarySurface);

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          !screens.some((screen) => screen.fingerprint === "sf_surface-b") &&
          server.pairedSocketFor("sf_surface-b") === null &&
          !internalRuntime.persistentState.targetStateBySurfaceId["sf_surface-b"]
        );
      });

      assert.deepEqual(
        (await runtime.listScreens()).map((screen) => screen.fingerprint),
        ["sf_surface-a"],
      );
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surfaces.list absence removes the queried source surface", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-source-surface-absent-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return screens.some((screen) => screen.fingerprint === "sf_surface-b");
      });

      const internalRuntime = runtime as any;
      const sourceSurface = internalRuntime.surfaces.get("sf_surface-b");
      assert.ok(sourceSurface);
      server.omitSurfaceFromList("sf_surface-b");
      await internalRuntime.discoverSurfaceId(sourceSurface);

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          !screens.some((screen) => screen.fingerprint === "sf_surface-b") &&
          server.pairedSocketFor("sf_surface-b") === null
        );
      });
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("source removal still starts newly discovered sibling windows", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-source-removed-start-sibling-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => server.pairedSocketFor("sf_surface-a") !== null);

      server.addSurface({ initialRemotePaneId: 42, name: "Surface B", surfaceId: "sf_surface-b" });
      server.omitSurfaceFromList("sf_surface-a");

      const internalRuntime = runtime as any;
      const sourceSurface = internalRuntime.surfaces.get("sf_surface-a");
      assert.ok(sourceSurface?.client);
      await sourceSurface.client.close(1000, "test_source_removed_start_sibling");

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          server.pairedSocketFor("sf_surface-b") !== null &&
          screens.some((screen) => screen.fingerprint === "sf_surface-b") &&
          !screens.some((screen) => screen.fingerprint === "sf_surface-a")
        );
      }, 12_000);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("empty surfaces.list removes all cached surfaces for the endpoint", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-empty-surfaces-list-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return screens.some((screen) => screen.fingerprint === "sf_surface-a");
      });

      const internalRuntime = runtime as any;
      const sourceSurface = internalRuntime.surfaces.get("sf_surface-a");
      assert.ok(sourceSurface);
      server.omitSurfaceFromList("sf_surface-a");
      await internalRuntime.discoverSurfaceId(sourceSurface);

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return screens.length === 0 && server.pairedSocketFor("sf_surface-a") === null;
      });
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("empty surfaces.list prevents provisional endpoint resurrection", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-empty-list-no-provisional-"));
    const endpoint = discoveryEndpoint(port);
    const discovery = new StaticDiscoveryService([endpoint]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return screens.some((screen) => screen.fingerprint === "sf_surface-a");
      });

      const internalRuntime = runtime as any;
      const sourceSurface = internalRuntime.surfaces.get("sf_surface-a");
      assert.ok(sourceSurface);
      server.omitSurfaceFromList("sf_surface-a");
      await internalRuntime.discoverSurfaceId(sourceSurface);

      await waitFor(async () => (await runtime.listScreens()).length === 0);
      assert.deepEqual([...internalRuntime.surfaces.keys()], []);
      assert.equal(internalRuntime.endpointProbes.size, 1);
      const probe = internalRuntime.endpointProbes.get(endpoint.endpointId);
      assert.ok(probe);
      assert.equal("surfaceId" in probe, false);
      assert.equal("panes" in probe, false);
      await assert.rejects(
        runtime.read({
          fingerprint: endpoint.endpointId,
          paneId: "pn_probe" as any,
        }),
        /Unknown Surf Ace surface/,
      );

      internalRuntime.handleDiscoveryUpdate([endpoint]);
      assert.deepEqual(await runtime.listScreens(), []);

      await runtime.stop();
      const runtimeAfterRestart = createSurfAceRuntime({
        discovery: new StaticDiscoveryService([endpoint]),
        stateDir,
      });
      try {
        await runtimeAfterRestart.start();
        await waitFor(async () => (await runtimeAfterRestart.listScreens()).length === 0);

        server.addSurface({
          initialRemotePaneId: 42,
          name: "Reopened Surface",
          surfaceId: "sf_surface-reopened",
        });
        (runtimeAfterRestart as any).handleDiscoveryUpdate([endpoint]);

        await waitFor(async () => {
          const screens = await runtimeAfterRestart.listScreens();
          return (
            server.pairedSocketFor("sf_surface-reopened") !== null &&
            screens.some((screen) => screen.fingerprint === "sf_surface-reopened") &&
            !screens.some((screen) => screen.connectionState === "connecting")
          );
        }, 12_000);
      } finally {
        await runtimeAfterRestart.stop();
      }
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("last surface_removed event leaves only a hidden endpoint probe", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_surface-a" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-last-surface-removed-probe-"));
    const endpoint = discoveryEndpoint(port);
    const discovery = new StaticDiscoveryService([endpoint]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return screens.some((screen) => screen.fingerprint === "sf_surface-a");
      });
      const paneId = await livePaneId(runtime, "sf_surface-a", 1);
      await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: "sf_surface-a",
        paneId,
      });
      const topologyApplyCountAfterSplit = server.topologyApplyRequests.length;

      server.sendSurfaceRemoved({ surfaceId: "sf_surface-a" });
      await waitFor(async () => (await runtime.listScreens()).length === 0);

      const internalRuntime = runtime as any;
      internalRuntime.handleDiscoveryUpdate([endpoint]);
      assert.deepEqual(await runtime.listScreens(), []);

      server.addSurface({
        initialRemotePaneId: 42,
        name: "Reopened Surface",
        surfaceId: "sf_surface-reopened",
      });
      internalRuntime.handleDiscoveryUpdate([endpoint]);

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return (
          server.pairedSocketFor("sf_surface-reopened") !== null &&
          screens.some((screen) => screen.fingerprint === "sf_surface-reopened") &&
          !screens.some((screen) => screen.fingerprint === "sf_surface-a") &&
          !screens.some((screen) => screen.connectionState === "connecting") &&
          server.topologyApplyRequests.length === topologyApplyCountAfterSplit
        );
      }, 12_000);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("provider keeps pane identity local and reuses content ownership per injected session", async () => {
    await withRuntimeHarness(async ({ alertBodies, runtime, server }) => {
      const localEvents: Array<{
        paneId: string;
        previousSessionKey: string;
        surfaceId: string;
        type: string;
        visibleContentId: string | null;
      }> = [];
      const unsubscribe = runtime.subscribe((event) => {
        if (event.type === "event.content_superseded") {
          localEvents.push(event);
        }
      });

      try {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const first = await runtime.push(
          {
            content: "<p>first</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          { sessionDisplayName: "Session One", sessionKey: "agent:test:1" },
        );
        const second = await runtime.push(
          {
            content: "<p>second</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          { sessionDisplayName: "Session One", sessionKey: "agent:test:1" },
        );
        const third = await runtime.push(
          {
            content: "<p>third</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          { sessionDisplayName: "Session Two", sessionKey: "agent:test:2" },
        );

        assert.equal(server.contentSetRequests.length, 3);
        assert.deepEqual(server.pairRequests, [
          {
            initialPaneId: 1,
            initialPaneLabel: 1,
            windowLabel: "a",
          },
        ]);
        assert.deepEqual(
          server.contentSetRequests.map((request) => request.paneId),
          [server.initialRemotePaneId, server.initialRemotePaneId, server.initialRemotePaneId],
        );
        assert.ok(server.contentSetRequests.every((request) => request.historyOwnerToken.startsWith("hot_")));
        assert.equal(
          server.contentSetRequests[0]?.historyOwnerToken,
          server.contentSetRequests[1]?.historyOwnerToken,
        );
        assert.notEqual(
          server.contentSetRequests[0]?.historyOwnerToken,
          server.contentSetRequests[2]?.historyOwnerToken,
        );
        assert.deepEqual(
          server.contentSetRequests.map((request) => request.displayTitle),
          [null, null, null],
        );
        assert.deepEqual(
          server.contentSetRequests.map((request) => request.displaySenderName),
          ["Session One", "Session One", "Session Two"],
        );
        assert.deepEqual(server.contentSetRequests[0]?.displayProvenance, {
          displayName: "Session One",
          sessionKey: "agent:test:1",
        });
        assert.equal(first.paneId, firstPaneId);
        assert.equal(second.paneId, firstPaneId);
        assert.equal(third.paneId, firstPaneId);
        assert.equal(first.contentId, second.contentId);
        assert.notEqual(first.contentId, third.contentId);
        assert.deepEqual(localEvents, [
          {
            paneId: firstPaneId,
            previousSessionKey: "agent:test:1",
            surfaceId: server.surfaceId,
            type: "event.content_superseded",
            visibleContentId: first.contentId,
          },
        ]);

        const screens = await runtime.listScreens();
        assert.equal(screens[0]?.panes[0]?.historySummary.visibleContentId, third.contentId);
        assert.equal(screens[0]?.panes[0]?.historySummary.backCount, 1);

        server.sendDrawingFlush(server.initialRemotePaneId, third.contentId);
        await waitFor(() => alertBodies.length === 1);
        assertAnnotationAlertBody(alertBodies[0], {
          image: "aGVsbG8=",
          message: "Surf Ace updates pending on Surface A (1 live dirty stroke)",
          paneId: firstPaneId,
          sessionKey: "agent:test:2",
          surfaceId: server.surfaceId,
        });

        server.sendDrawingFlush(server.initialRemotePaneId, third.contentId);
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        assert.equal(alertBodies.length, 1);

        const read = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.ok(read.liveDirtyStrokeIds.includes("stroke_abc123"));
        assert.equal(read.liveFrame?.contentId, third.contentId);
        assert.equal(read.liveFrame?.contextKey, third.contentId);
        assert.deepEqual(read.liveFrame?.strokes[0]?.points[0], {
          pressure: 0.2,
          x: 10,
          y: 20,
        });

        server.sendDrawingFlush(server.initialRemotePaneId, third.contentId);
        await waitFor(() => alertBodies.length === 2);

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        pane.paneLabel = Number(pane.remotePaneId);

        const removed = await runtime.annotateRemove({
          contentId: third.contentId,
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
          strokeIds: ["stroke_abc123"],
        });
        assert.deepEqual(removed, {
          displayId: "1",
          fingerprint: server.surfaceId,
          notFoundStrokeIds: [],
          paneAddress: "1",
          paneId: firstPaneId,
          paneLabel: 1,
          remainingStrokeCount: 0,
          removedStrokeIds: ["stroke_abc123"],
        });
        assert.equal(pane.paneLabel, 1);
        assert.deepEqual(server.annotationsRemoveRequests, [
          {
            contentId: third.contentId,
            paneId: server.initialRemotePaneId,
            strokeIds: ["stroke_abc123"],
          },
        ]);
      } finally {
        unsubscribe();
      }
    });
  });

  await t.test("provider uses explicit pusher provenance for display without raw id fallback", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.push(
        {
          content: "# stream",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        {
          agentId: "agent_raw_123",
          provenance: {
            agentId: "agent_nested",
            displayName: "Nested Display",
            sessionKey: "agent:test:nested",
            source: "openclaw",
            streamLabel: "Nested Stream",
          },
          sessionKey: "agent:test:raw-only",
          streamLabel: "Surf Ace Stream",
        },
      );
      await runtime.push(
        {
          content: "# raw",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        {
          agentId: "agent_raw_456",
          sessionKey: "agent:test:raw-only-2",
        },
      );

      assert.equal(server.contentSetRequests[0]?.displayTitle, null);
      assert.equal(server.contentSetRequests[0]?.displaySenderName, "Nested Display");
      assert.deepEqual(server.contentSetRequests[0]?.displayProvenance, {
        agentId: "agent_raw_123",
        displayName: "Nested Display",
        sessionKey: "agent:test:raw-only",
        source: "openclaw",
        streamLabel: "Surf Ace Stream",
      });
      assert.equal(server.contentSetRequests[1]?.displayTitle, null);
      assert.equal(server.contentSetRequests[1]?.displaySenderName, null);
      assert.deepEqual(server.contentSetRequests[1]?.displayProvenance, {
        agentId: "agent_raw_456",
        sessionKey: "agent:test:raw-only-2",
      });
    });
  });

  await t.test("provider prefers session display name over tool display name for sender provenance", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.push(
        {
          content: "# wrapped review",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        {
          displayName: "Wrapped XHigh reviews",
          sessionDisplayName: "Flynn / T263",
          sessionKey: "agent:test:session-display",
        },
      );

      assert.equal(server.contentSetRequests[0]?.displayTitle, null);
      assert.equal(server.contentSetRequests[0]?.displaySenderName, "Flynn / T263");
      assert.deepEqual(server.contentSetRequests[0]?.displayProvenance, {
        displayName: "Flynn / T263",
        sessionKey: "agent:test:session-display",
      });
    });
  });

  await t.test("provider keeps explicit pusher provenance when session display name supplies sender chrome", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.push(
        {
          content: "# t231 separation",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        {
          displayName: "Generic Tool Wrapper",
          pushedBy: {
            displayName: "T231 Pusher",
            sessionKey: "agent:test:t231-pusher",
            source: "openclaw",
          },
          sessionDisplayName: "Flynn / T263",
          sessionKey: "agent:test:t263-session",
        },
      );

      assert.equal(server.contentSetRequests[0]?.displaySenderName, "Flynn / T263");
      assert.equal(server.contentSetRequests[0]?.displayTitle, null);
      assert.deepEqual(server.contentSetRequests[0]?.displayProvenance, {
        displayName: "Flynn / T263",
        sessionKey: "agent:test:t263-session",
      });
    });
  });

  await t.test("provider uses nested pusher session keys for content ownership", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const first = await runtime.push(
        {
          content: "# alpha",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        {
          pushedBy: {
            displayName: "Alpha Stream",
            sessionKey: "agent:test:nested-alpha",
          },
        },
      );
      const second = await runtime.push(
        {
          content: "# beta",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        {
          sourceProvenance: {
            displayName: "Beta Stream",
            sessionKey: "agent:test:nested-beta",
          },
        },
      );

      assert.notEqual(first.contentId, second.contentId);
      assert.notEqual(
        server.contentSetRequests[0]?.historyOwnerToken,
        server.contentSetRequests[1]?.historyOwnerToken,
      );
      assert.deepEqual(
        server.contentSetRequests.map((request) => request.displayTitle),
        [null, null],
      );
      assert.deepEqual(
        server.contentSetRequests.map((request) => request.displaySenderName),
        ["Alpha Stream", "Beta Stream"],
      );

      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.historySummary.backCount, 1);
      assert.equal(screens[0]?.panes[0]?.historySummary.visibleContentId, second.contentId);
      assert.deepEqual(screens[0]?.panes[0]?.historySummary.visibleProvenance, {
        displayName: "Beta Stream",
        sessionKey: "agent:test:nested-beta",
      });
    });
  });

  await t.test("provider skips immediate html snapshot sync while renderer is pending", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const snapshotCountBefore = server.snapshotRequests.length;
      server.nextContentApplyRenderStatus = "pending_renderer";

      const result = await runtime.push(
        {
          content: "<p>pending</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionDisplayName: "Pending Renderer", sessionKey: "agent:test:pending-renderer" },
      );

      assert.equal(result.paneId, firstPaneId);
      assert.equal(server.contentSetRequests.length, 1);
      assert.equal(server.snapshotRequests.length, snapshotCountBefore);
    });
  });

  await t.test("sourcePath html push materializes source bytes instead of placeholder content", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-sourcepath-"));
    try {
      const sourcePath = path.join(tempDir, "report.html");
      await fs.writeFile(sourcePath, "<main>actual source bytes</main>", "utf8");
      await withRuntimeHarness(async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push(
          {
            content: "<main>placeholder bytes</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
            sourcePath,
          },
          { sessionKey: "agent:test:sourcepath" },
        );

        assert.equal(pushed.paneId, firstPaneId);
        assert.deepEqual(server.contentSetRequests.at(-1)?.content, { html: "<main>actual source bytes</main>" });
        assert.equal(server.contentSetRequests.at(-1)?.reloadSource, undefined);
        const read = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.deepEqual(read.contentSnapshot?.content, { html: "<main>actual source bytes</main>" });
      });
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  await t.test("sourcePath html push rejects unreadable source before pane mutation", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await assert.rejects(
        runtime.push({
          content: "<main>placeholder bytes</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
          sourcePath: path.join(os.tmpdir(), `surf-ace-missing-source-${Date.now()}.html`),
        }),
        /Unable to read sourcePath/,
      );
      assert.equal(server.contentSetRequests.length, 0);
    });
  });

  await t.test("provider discards non-html navigation events and keeps clear scoped to remote pane ids", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const markdownPush = await runtime.push(
        {
          content: "# notes",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:1" },
      );

      server.sendNavigation(server.initialRemotePaneId, markdownPush.contentId, "https://example.com/ignored");
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const markdownRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(markdownRead.lastNavigation, null);
      assert.equal(markdownRead.contentSnapshot?.contentId, markdownPush.contentId);
      assert.equal(markdownRead.contentSnapshot?.contentType, "markdown");
      assert.deepEqual(markdownRead.contentSnapshot?.content, { markdown: "# notes" });
      assert.equal(markdownRead.contentSnapshot?.visibleText, "# notes");
      assert.equal(markdownRead.contentSnapshot?.image, undefined);
      assert.deepEqual(markdownRead.contentSnapshot?.drawings, []);
      const markdownSnapshot = await runtime.snapshot({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(markdownSnapshot.snapshot?.contentId, markdownPush.contentId);
      assert.equal(markdownSnapshot.snapshot?.contentType, "markdown");
      assert.equal(markdownSnapshot.snapshot?.visibleText, "# notes");
      const internalRuntime = runtime as any;
      const internalSurface = internalRuntime.surfaces.get(server.surfaceId);
      const internalPane = internalSurface?.panes.get(firstPaneId);
      assert.ok(internalPane?.snapshot);
      internalPane.contentValue = null;
      const snapshotOnlyRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(snapshotOnlyRead.contentSnapshot?.contentId, markdownPush.contentId);
      assert.equal(snapshotOnlyRead.contentSnapshot?.contentType, "markdown");
      assert.equal(snapshotOnlyRead.contentSnapshot?.content, undefined);
      assert.equal(snapshotOnlyRead.contentSnapshot?.visibleText, "# notes");
      internalPane.snapshot.drawings = [{
        points: [],
        strokeId: "stale_stroke",
        tool: "pen",
      }];
      internalPane.snapshot.image = "stale-image";
      internalPane.snapshot.selection = {
        anchorEnd: 7,
        anchorStart: 1,
        selectedText: "stale",
      };
      const secondMarkdownPush = await runtime.push(
        {
          content: "# newer",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:1" },
      );
      const secondMarkdownSnapshot = await runtime.snapshot({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(secondMarkdownSnapshot.snapshot?.contentId, secondMarkdownPush.contentId);
      assert.equal(secondMarkdownSnapshot.snapshot?.visibleText, "# newer");
      assert.deepEqual(secondMarkdownSnapshot.snapshot?.drawings, []);
      assert.equal(secondMarkdownSnapshot.snapshot?.image, undefined);
      assert.equal(secondMarkdownSnapshot.snapshot?.selection, null);
      const largeMarkdownPush = await runtime.push(
        {
          content: "#".repeat(5_000),
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:1" },
      );
      const largeMarkdownSnapshot = await runtime.snapshot({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(largeMarkdownSnapshot.snapshot?.contentId, largeMarkdownPush.contentId);
      assert.equal(largeMarkdownSnapshot.snapshot?.visibleText?.length, 4096);

      const htmlPush = await runtime.push(
        {
          content: "<p>html</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:1" },
      );

      const navigatedAt = server.sendNavigation(
        server.initialRemotePaneId,
        htmlPush.contentId,
        "https://example.com/live",
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const htmlRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.deepEqual(htmlRead.lastNavigation, {
        navigatedAt,
        url: "https://example.com/live",
      });
      assert.equal(htmlRead.contentSnapshot?.contentId, htmlPush.contentId);
      assert.equal(htmlRead.contentSnapshot?.contentType, "html");
      assert.deepEqual(htmlRead.contentSnapshot?.content, { html: "<p>html</p>" });
      assert.equal(htmlRead.contentSnapshot?.visibleText, "Visible text");

      const imagePush = await runtime.push(
        {
          content: { data: "aW1hZ2UtZGF0YQ==", mediaType: "image/png" },
          contentType: "image",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:1" },
      );
      const imageRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(imageRead.contentSnapshot?.contentId, imagePush.contentId);
      assert.equal(imageRead.contentSnapshot?.contentType, "image");
      assert.deepEqual(imageRead.contentSnapshot?.content, { data: "aW1hZ2UtZGF0YQ==", mediaType: "image/png" });
      assert.equal(imageRead.contentSnapshot?.image, "aW1hZ2UtZGF0YQ==");

      const canvasPush = await runtime.push(
        {
          content: { color: "#ffffff", grid: true },
          contentType: "canvas",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:1" },
      );
      const canvasRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(canvasRead.contentSnapshot?.contentId, canvasPush.contentId);
      assert.equal(canvasRead.contentSnapshot?.contentType, "canvas");
      assert.deepEqual(canvasRead.contentSnapshot?.content, { color: "#ffffff", grid: true });

      const clear = await runtime.clear({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.deepEqual(clear, {
        displayId: "1",
        fingerprint: server.surfaceId,
        paneAddress: "1",
        paneId: firstPaneId,
        paneLabel: 1,
        revision: clear.revision,
      });
      assert.deepEqual(server.clearRequests.map((request) => request.paneId), [server.initialRemotePaneId]);
    });
  });

  await t.test("provider records generic pane targets and keeps diagnostic placeholders separate", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "terminal:btop:1",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command", "args"],
          safetyClass: "process",
          summary: "btop",
        },
        targetKind: "terminal_app",
        targetPayload: {
          args: [],
          command: "btop",
          cwd: "/tmp",
          env: { TERM: "xterm-256color" },
          envPolicy: "explicit_allowlist",
          pty: true,
          restartPolicy: "restore_new_process",
        },
      });
      assert.equal(registered.status, "registered");
      const originalLineage = targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId).paneLineageId;

      const screensAfterRegister = await runtime.listScreens();
      const target = screensAfterRegister[0]?.panes[0]?.target;
      assert.equal(target?.targetKind, "terminal_app");
      assert.equal(target?.targetPolicy, "confirm");
      assert.equal(target?.blockedReason, null);
      assert.deepEqual(target?.targetPayload, { args: [], command: "btop" });

      const blocked = await runtime.restoreTarget({
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assert.equal(blocked.blockedReason, "restore_requires_confirmation");
      assert.equal(server.targetApplyRequests.length, 0);

      await runtime.push({
        content: "<p>btop should be here</p>",
        contentType: "html",
        diagnostic: {
          derivedFromTargetId: target?.targetId,
          kind: "placeholder",
          summary: "btop placeholder",
        },
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      const screensAfterPlaceholder = await runtime.listScreens();
      const targetAfterPlaceholder = screensAfterPlaceholder[0]?.panes[0]?.target;
      assert.equal(targetAfterPlaceholder?.targetKind, "terminal_app");
      assert.equal(targetAfterPlaceholder?.diagnosticContent?.kind, "placeholder");
      assert.equal(targetAfterPlaceholder?.diagnosticContent?.summary, "btop placeholder");

      const confirmed = await runtime.restoreTarget({
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assert.equal(confirmed.blockedReason, null);
      assert.equal(confirmed.evidence?.status, "applied");
      assert.deepEqual(server.targetApplyRequests, [
        {
          ownershipEpoch: targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId).ownershipEpoch,
          ownershipSessionId: targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId).ownershipSessionId,
          paneLineageId: targetAfterPlaceholder?.paneLineageId,
          restoreReason: "confirmed_restore",
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "launch_equivalent",
            requiredCapabilities: ["target.terminal_app.v1"],
            safeToLogFields: ["command", "args"],
            safetyClass: "process",
            summary: "btop",
          },
          targetId: target?.targetId,
          targetKind: "terminal_app",
          targetPayload: {
            args: [],
            command: "btop",
            cwd: "/tmp",
            env: { TERM: "xterm-256color" },
            envPolicy: "explicit_allowlist",
            pty: true,
            restartPolicy: "restore_new_process",
          },
        },
      ]);
      const screensAfterRestore = await runtime.listScreens();
      assert.equal(screensAfterRestore[0]?.panes[0]?.target?.diagnosticContent, null);
    });
  });

  await t.test("provider adopts same-provider non-legacy lineage discovered during process target restore", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "terminal:btop:stale-lineage",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        restorePolicy: "manual",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command", "args"],
          safetyClass: "process",
          summary: "btop",
        },
        targetKind: "terminal_app",
        targetPayload: {
          args: [],
          command: "btop",
          cwd: "/tmp",
          env: { TERM: "xterm-256color" },
          envPolicy: "explicit_allowlist",
          pty: true,
          restartPolicy: "restore_new_process",
        },
      });
      assert.equal(registered.status, "registered");
      const serverPane = server.panes.get(server.initialRemotePaneId);
      assert.ok(serverPane);
      const providerLineage = `pl_${server.surfaceId}_recreated`;
      serverPane.paneLineageId = providerLineage;

      const restored = await runtime.restoreTarget({
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      assert.equal(restored.blockedReason, null);
      assert.equal(restored.evidence?.status, "applied");
      assert.equal(server.targetApplyRequests.length, 1);
      assert.equal(server.targetApplyRequests[0]?.paneLineageId, providerLineage);
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const adoptedTarget = [...surface.targetRecords.values()].find((record: any) => record.targetId === registered.targetId);
      assert.equal(adoptedTarget?.currentState, "current");
      assert.equal(adoptedTarget?.paneLineageId, providerLineage);
      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.target?.blockedReason, null);
      assert.equal(screens[0]?.panes[0]?.target?.paneLineageId, providerLineage);
    });
  });

  await t.test("surf_ace_push browser_url creates a live URL target instead of static HTML", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server, stateDir }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push(
          {
            content: "https://google.com",
            contentType: "browser_url",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          {
            pushedBy: {
              displayName: "Browser Pusher",
              sessionKey: "agent:test:browser",
              source: "openclaw",
            },
          },
        );

        assert.equal(pushed.contentId, null);
        assert.equal(pushed.targetKind, "browser_url");
        assert.equal(pushed.targetApplyEvidence?.status, "applied");
        assert.equal(pushed.revision, 1);
        assert.equal(server.contentSetRequests.length, 0);
        assert.equal(server.targetApplyRequests.length, 1);
        const [applyRequest] = server.targetApplyRequests;
        assert.ok(applyRequest);
        assert.equal("materialization" in applyRequest, false);
        assert.equal(applyRequest.displayTitle, null);
        assert.equal(applyRequest.displaySenderName, "Browser Pusher");
        assert.deepEqual(applyRequest.displayProvenance, {
          displayName: "Browser Pusher",
          sessionKey: "agent:test:browser",
          source: "openclaw",
        });
        assert.equal(applyRequest.restoreReason, "initial_apply");
        assert.equal(applyRequest.targetKind, "browser_url");
        assert.deepEqual(applyRequest.targetHeader, {
          payloadSchemaVersion: 1,
          replaySemantics: "navigate",
          requiredCapabilities: ["target.browser_url.v1"],
          safeToLogFields: ["url"],
          safetyClass: "network",
          summary: "https://google.com",
        });
        assert.deepEqual(applyRequest.targetPayload, { url: "https://google.com" });

        const screens = await runtime.listScreens();
        const target = screens[0]?.panes[0]?.target;
        assert.equal(target?.targetKind, "browser_url");
        assert.equal(target?.targetPolicy, "auto");
        assert.equal(target?.display?.title, undefined);
        assert.deepEqual(target?.targetPayload, { url: "https://google.com" });

        const expectedBrowserUrlEvidence = {
          appliedAt: pushed.targetApplyEvidence?.appliedAt,
          navigationStatus: "loaded",
          paneLineageId: target?.paneLineageId,
          replaySemantics: "navigate",
          requestId: pushed.targetApplyEvidence?.requestId,
          targetEpoch: 1,
          targetId: pushed.targetId,
          url: "https://google.com",
        };
        assert.equal(target?.lastApplyEvidence?.status, "applied");
        assert.deepEqual(target?.lastApplyEvidence?.materializedState, {
          navigationStatus: "loaded",
          replaySemantics: "navigate",
          url: "https://google.com",
        });
        const read = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(read.contentSnapshot, null);
        assert.deepEqual(read.browserUrl, expectedBrowserUrlEvidence);
        const captured = await runtime.capturePane({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(captured.capture.visibleContentId, null);
        assert.deepEqual(captured.capture.browserUrl, expectedBrowserUrlEvidence);

        await runtime.push({
          content: "<p>replacement</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(server.contentSetRequests.at(-1)?.revision, pushed.revision + 1);
      },
    });
  });

  await t.test("provider adopts client current browser_url target from pair state", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
        const pane = server.panes.get(server.initialRemotePaneId);
        assert.ok(pane);
        pane.revision = 1;
        pane.currentTarget = clientBrowserUrlTarget({
          paneLineageId: pane.paneLineageId,
          targetId: "tg_pair_browser_url",
          url: "https://pair.example/",
        });
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const pane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(pane?.target?.targetKind, "browser_url");
        assert.equal(pane?.target?.targetPayload.url, "https://pair.example/");
        const read = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(read.browserUrl?.url, "https://pair.example/");
        assert.equal(server.contentSetRequests.length, 0);
        assert.equal(server.targetApplyRequests.length, 0);
      },
    });
  });

  await t.test("provider adopts client current browser_url target from panes.list when provider record is missing", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const serverPane = server.panes.get(server.initialRemotePaneId);
        assert.ok(serverPane);
        serverPane.revision = 2;
        serverPane.currentTarget = clientBrowserUrlTarget({
          paneLineageId: serverPane.paneLineageId,
          targetEpoch: 2,
          targetId: "tg_panes_list_browser_url",
          url: "https://panes-list.example/",
        });

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const providerPane = surface.panes.get(firstPaneId);
        assert.ok(providerPane);
        surface.targetRecords.clear();
        providerPane.currentTargetId = null;

        await internalRuntime.syncRemotePaneList(surface);

        const pane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(pane?.target?.targetKind, "browser_url");
        assert.equal(pane?.target?.targetPayload.url, "https://panes-list.example/");
        const read = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(read.browserUrl?.url, "https://panes-list.example/");
        assert.equal(server.contentSetRequests.length, 0);
        assert.equal(server.targetApplyRequests.length, 0);
      },
    });
  });

  await t.test("browser_url read and capture require complete loaded semantic materializedState", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const loaded = await runtime.push({
          content: "https://loaded.example/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(loaded.targetApplyEvidence?.status, "applied");
        const loadedRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(loadedRead.browserUrl?.navigationStatus, "loaded");
        assert.equal(loadedRead.browserUrl?.replaySemantics, "navigate");
        assert.equal(loadedRead.browserUrl?.url, "https://loaded.example/");
        const loadedCapture = await runtime.capturePane({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(loadedCapture.capture.browserUrl?.navigationStatus, "loaded");
        assert.equal(loadedCapture.capture.browserUrl?.replaySemantics, "navigate");
        assert.equal(loadedCapture.capture.browserUrl?.url, "https://loaded.example/");

        server.targetApplyErrorCode = "materialization_failed";
        const restored = await runtime.restoreTarget({
          confirmed: true,
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
          targetId: loaded.targetId,
        });
        assert.equal(restored.evidence?.status, "failed");
        assert.equal(restored.evidence?.errorCode, "materialization_failed");
        const staleRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(staleRead.browserUrl, null);
        const staleCapture = await runtime.capturePane({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(staleCapture.capture.browserUrl, null);
        server.targetApplyErrorCode = null;

        server.browserUrlMaterializedStateOverride = {
          navigationStatus: "started_unverified",
          replaySemantics: "navigate",
          url: "https://unverified.example/",
        };
        const unverified = await runtime.push({
          content: "https://unverified.example/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(unverified.targetApplyEvidence?.status, "applied");
        assert.equal(unverified.targetApplyEvidence?.materializedState?.navigationStatus, "started_unverified");
        const unverifiedRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(unverifiedRead.browserUrl, null);
        const unverifiedCapture = await runtime.capturePane({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(unverifiedCapture.capture.browserUrl, null);

        server.browserUrlMaterializedStateOverride = { url: "https://incomplete.example/" };
        const incomplete = await runtime.push({
          content: "https://incomplete.example/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(incomplete.targetApplyEvidence?.status, "applied");
        const incompleteRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(incompleteRead.browserUrl, null);
        const incompleteCapture = await runtime.capturePane({ fingerprint: server.surfaceId, paneId: firstPaneId });
        assert.equal(incompleteCapture.capture.browserUrl, null);
        server.browserUrlMaterializedStateOverride = undefined;
      },
    });
  });

  await t.test("malformed pair pane target payload is quarantined before browser_url recovery push", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
        server.pairPaneStateMutator = (paneState) => ({
          ...paneState,
          targetPayload: {
            html: "file-backed scrollable T338 current-docket wall card",
          },
        });
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const screens = await runtime.listScreens();
        assert.equal(screens[0]?.authority.actionable, true);

        await runtime.push({
          content: "https://tars.tail4105e8.ts.net:19443/tracker.html?id=T338",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(server.contentSetRequests.length, 0);
        assert.equal(server.targetApplyRequests.length, 1);
        assert.equal(server.targetApplyRequests[0]?.targetKind, "browser_url");
        assert.deepEqual(server.targetApplyRequests[0]?.targetPayload, {
          url: "https://tars.tail4105e8.ts.net:19443/tracker.html?id=T338",
        });
      },
    });
  });

  await t.test("resume replay reapplies browser_url targets through provider authority", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        await runtime.push({
          content: "https://arstechnica.com/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(server.targetApplyRequests.length, 1);

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        await internalRuntime.repushSurfaceContent(surface);

        assert.equal(server.targetApplyRequests.length, 2);
        const replay = server.targetApplyRequests.at(-1);
        assert.ok(replay);
        assert.equal(replay.restoreReason, "resume_restore");
        assert.equal(replay.targetKind, "browser_url");
        assert.deepEqual(replay.targetPayload, { url: "https://arstechnica.com/" });

        const pane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(pane?.target?.blockedReason, null);
        assert.equal(pane?.target?.targetKind, "browser_url");
        assert.equal(pane?.target?.targetPolicy, "auto");
      },
    });
  });

  await t.test("surf_ace_list clears browser_url target metadata when native hosting supersedes it", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server, stateDir }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        await runtime.push({
          content: "https://google.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        const target = surface.targetRecords.get(pane.currentTargetId);
        assert.ok(target);
        pane.currentTargetId = null;
        pane.staleTargetId = null;
        pane.lastRestoreBlockedReason = null;
        await internalRuntime.persistSurfaceTargetState(surface, "test native takeover lineage-only browser target");

        const remotePane = server.panes.get(server.initialRemotePaneId);
        assert.ok(remotePane);
        remotePane.contentId = null;
        remotePane.contentType = null;
        remotePane.externalNative = true;
        await internalRuntime.syncRemotePaneList(surface);

        assert.equal(surface.targetRecords.get(target.targetId)?.currentState, "tombstoned");
        const screensAfterNative = await runtime.listScreens();
        assert.equal(screensAfterNative[0]?.panes[0]?.activeContent, null);
        assert.equal(screensAfterNative[0]?.panes[0]?.target, null);
        await waitFor(async () => {
          const persisted = JSON.parse(
            await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
          );
          return persisted.targetStateBySurfaceId?.[server.surfaceId]?.lifecycleEvents?.some(
            (event: any) =>
              event.event === "tombstone" &&
              event.reason === "native pane superseded browser_url target" &&
              event.targetId === target.targetId,
          );
        });
      },
    });
  });

  await t.test("browser_url target apply keeps content revisions monotonic after prior pushes", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        await runtime.push({
          content: "",
          contentType: "canvas",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const secondPush = await runtime.push({
          content: "",
          contentType: "canvas",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const browserPush = await runtime.push({
          content: "https://google.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(browserPush.revision, secondPush.revision);

        await runtime.push({
          content: "<p>replacement</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(server.contentSetRequests.at(-1)?.revision, secondPush.revision + 1);
      },
    });
  });

  await t.test("content.apply resyncs provider revision from client stale_revision and retries once", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.nextContentApplyError = {
          code: "stale_revision",
          details: { expectedRevision: 4 },
          message: "Expected revision >= 4",
        };
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push({
          content: "<p>resynced</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(pushed.revision, 5);
        assert.deepEqual(
          server.contentSetRequests.map((request) => request.revision),
          [5],
        );
        const screens = await runtime.listScreens();
        assert.equal(screens[0]?.panes[0]?.activeContent?.revision, 5);
      },
    });
  });

  await t.test("content.clear resyncs provider revision from client stale_revision and retries once", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.nextContentApplyError = {
          code: "stale_revision",
          details: { expectedRevision: 4 },
          message: "Expected revision >= 4",
        };
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const cleared = await runtime.clear({
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(cleared.revision, 5);
        assert.deepEqual(
          server.clearRequests.map((request) => request.revision),
          [5],
        );
        const screens = await runtime.listScreens();
        assert.equal(screens[0]?.panes[0]?.activeContent, null);
      },
    });
  });

  await t.test("surf_ace_list repairs legacy provider pane lineage before browser_url target.apply", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.includePairPaneLineageIds = false;
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push({
          content: "https://arstechnica.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(pushed.targetApplyEvidence?.status, "applied");
        const [applyRequest] = server.targetApplyRequests;
        assert.ok(applyRequest);
        assert.equal(applyRequest.paneLineageId, `pl_${server.surfaceId}_${server.initialRemotePaneId}`);
        assert.doesNotMatch(applyRequest.paneLineageId, /^legacy_remote_pane_/);
        const screens = await runtime.listScreens();
        assert.equal(
          screens[0]?.panes[0]?.target?.paneLineageId,
          `pl_${server.surfaceId}_${server.initialRemotePaneId}`,
        );
      },
    });
  });

  await t.test("provider does not migrate legacy target lineage by pane label or pane id alone", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        const currentLineage = pane.paneLineageId;
        const legacyLineage = `legacy_remote_pane_${server.initialRemotePaneId}`;
        const targetId = "tgt_legacy_label_only";
        surface.targetRecords.set(targetId, {
          appliedAt: new Date().toISOString(),
          currentState: "current",
          ownerProviderId: internalRuntime.persistentState.providerId,
          ownershipEpoch: surface.ownershipEpoch,
          ownershipSessionId: surface.sessionId,
          paneIdAtApply: pane.paneId,
          paneLabelAtApply: pane.paneLabel,
          paneLineageId: legacyLineage,
          restorePolicy: "auto",
          surfaceId: surface.surfaceId,
          surfaceInstanceId: null,
          targetEpoch: pane.targetEpoch + 1,
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "navigate",
            requiredCapabilities: ["target.browser_url.v1"],
            safeToLogFields: ["url"],
            safetyClass: "network",
            summary: "legacy label-only target",
          },
          targetId,
          targetKind: "browser_url",
          targetPayload: { url: "https://example.com/legacy" },
        });
        pane.paneLineageId = legacyLineage;
        pane.currentTargetId = null;
        pane.staleTargetId = null;

        internalRuntime.adoptPaneLineage(surface, pane, currentLineage);

        const target = surface.targetRecords.get(targetId);
        assert.equal(target?.paneLineageId, legacyLineage);
        assert.equal(target?.currentState, "stale");
        assert.equal(pane.currentTargetId, null);
        assert.equal(server.targetApplyRequests.length, 0);
      },
    });
  });

  await t.test("provider adopts current target when non-legacy pane lineage changes", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        await runtime.push({
          content: "https://example.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(server.targetApplyRequests.length, 1);

        const remotePane = server.panes.get(server.initialRemotePaneId);
        assert.ok(remotePane);
        remotePane.paneLineageId = `pl_${server.surfaceId}_${server.initialRemotePaneId}_reset`;

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        await internalRuntime.syncRemotePaneList(surface);

        const screen = (await runtime.listScreens())[0];
        const pane = screen?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(pane?.target?.blockedReason, null);
        assert.equal(pane?.target?.targetKind, "browser_url");
        assert.equal(server.targetApplyRequests.length, 1);

        const currentTarget = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
        assert.equal(currentTarget?.currentState, "current");
        assert.equal(currentTarget?.paneLineageId, remotePane.paneLineageId);
        assert.equal(surface.panes.get(firstPaneId)?.currentTargetId, currentTarget?.targetId);
        assert.equal(surface.panes.get(firstPaneId)?.targetEpoch, 0);

        internalRuntime.captureSurfaceTargetState(surface);
        surface.targetRecords = new Map();
        surface.panes.get(firstPaneId).staleTargetId = null;
        surface.panes.get(firstPaneId).lastRestoreBlockedReason = null;
        internalRuntime.hydrateSurfaceTargetState(surface, true);

        const rehydratedPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(rehydratedPane?.target?.blockedReason, null);
        assert.equal(rehydratedPane?.target?.targetKind, "browser_url");

        const registered = await runtime.registerTarget({
          expectedPreviousTargetEpoch: null,
          fingerprint: server.surfaceId,
          idempotencyKey: "terminal:new-lineage",
          ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
          paneId: firstPaneId,
          registrationState: "attached",
          restorePolicy: "manual",
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "launch_equivalent",
            requiredCapabilities: ["target.terminal_app.v1"],
            safeToLogFields: ["command"],
            safetyClass: "process",
            summary: "new lineage target",
          },
          targetKind: "terminal_app",
          targetPayload: {
            args: [],
            command: "top",
            envPolicy: "surface_default",
            pty: true,
            restartPolicy: "restore_new_process",
          },
        });
        assert.equal(registered.status, "registered");
      },
    });
  });

  await t.test("provider rebinds current self-owned targets when ownership refreshes by stable pane lineage", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        await runtime.push({
          content: "https://example.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(server.targetApplyRequests.length, 1);

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        internalRuntime.markPairConnected(surface, "sa_reowned_session", surface.ownershipEpoch + 1, false);

        const pane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(pane?.target?.blockedReason, null);
        assert.equal(pane?.target?.targetKind, "browser_url");
        assert.equal(server.targetApplyRequests.length, 1);

        const reboundTarget = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
        assert.equal(reboundTarget?.currentState, "current");
        assert.equal(reboundTarget?.ownershipSessionId, "sa_reowned_session");
        assert.equal(reboundTarget?.ownershipEpoch, surface.ownershipEpoch);
        assert.equal(surface.panes.get(firstPaneId)?.currentTargetId, reboundTarget?.targetId);

        internalRuntime.captureSurfaceTargetState(surface);
        surface.targetRecords = new Map();
        surface.panes.get(firstPaneId).staleTargetId = null;
        surface.panes.get(firstPaneId).lastRestoreBlockedReason = null;
        internalRuntime.hydrateSurfaceTargetState(surface, true);

        const rehydratedPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(rehydratedPane?.target?.blockedReason, null);
        assert.equal(rehydratedPane?.target?.targetKind, "browser_url");
      },
    });
  });

  await t.test("provider adopts same-provider persisted target ownership session drift during hydration", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        await runtime.push({
          content: "https://example.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        const target = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
        assert.ok(target);

        target.ownershipSessionId = "sa_unknown_prior_session";
        target.ownershipEpoch = surface.ownershipEpoch - 1;
        internalRuntime.captureSurfaceTargetState(surface);
        surface.targetRecords = new Map();
        pane.currentTargetId = null;
        pane.staleTargetId = null;
        pane.lastRestoreBlockedReason = null;

        internalRuntime.hydrateSurfaceTargetState(surface, true);

        const hydratedTarget = surface.targetRecords.get(target.targetId);
        assert.equal(hydratedTarget?.currentState, "current");
        assert.equal(hydratedTarget?.ownershipSessionId, surface.sessionId);
        assert.equal(hydratedTarget?.ownershipEpoch, surface.ownershipEpoch);
        assert.equal(pane.currentTargetId, target.targetId);
        assert.equal(pane.staleTargetId, null);
        assert.equal(pane.lastRestoreBlockedReason, null);

        const rehydratedPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(rehydratedPane?.target?.blockedReason, null);
        assert.equal(rehydratedPane?.target?.targetKind, "browser_url");
      },
    });
  });

  await t.test("provider does not attach stale persisted targets by pane label or pane id", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        await runtime.push({
          content: "https://example.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const target = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
        assert.ok(target);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        const staleLineage = `${pane.paneLineageId}_old`;
        target.paneLineageId = staleLineage;
        target.paneIdAtApply = pane.paneId;
        target.paneLabelAtApply = pane.paneLabel;
        surface.targetRecords.set(target.targetId, target);
        internalRuntime.persistentState.targetStateBySurfaceId = {
          [server.surfaceId]: {
            ownershipEpoch: surface.ownershipEpoch,
            paneTargets: {
              [staleLineage]: {
                currentTargetId: target.targetId,
                diagnosticContent: null,
                lastRestoreBlockedReason: null,
                nonDurableTargetDiagnostic: null,
                paneLineageId: staleLineage,
                targetEpoch: target.targetEpoch,
              },
            },
            registeredTargetIdsByIdempotencyKey: {},
            targetRecords: [structuredClone(target)],
          },
        };

        internalRuntime.hydrateSurfaceTargetState(surface, true);

        const refreshedPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(refreshedPane?.target, null);
        const hydratedTarget = surface.targetRecords.get(target.targetId);
        assert.equal(hydratedTarget?.currentState, "stale");
        assert.equal(surface.panes.get(firstPaneId)?.staleTargetId, null);
        internalRuntime.captureSurfaceTargetState(surface);
        assert.equal(
          internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId].targetRecords.some(
            (record: any) => record.targetId === target.targetId && record.currentState === "stale",
          ),
          true,
        );
        assert.equal(server.targetApplyRequests.length, 1);
      },
    });
  });

  await t.test("surf_ace_push browser_url blocks when the surface lacks live browser capability", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const panesListRequestsBeforePush = server.panesListRequests;
      const topologyApplyRequestsBeforePush = server.topologyApplyRequests.length;

      await assert.rejects(
        async () => await runtime.push({
          content: "https://google.com",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        }),
        /target\.browser_url\.v1/,
      );
      assert.equal(server.contentSetRequests.length, 0);
      assert.equal(server.targetApplyRequests.length, 0);
      assert.equal(server.panesListRequests, panesListRequestsBeforePush);
      assert.equal(server.topologyApplyRequests.length, topologyApplyRequestsBeforePush);
    });
  });

  await t.test("internal terminal_app target applies a provider-owned process target with opaque geometry", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const [, secondPane] = split;
      assert.ok(secondPane);

      const launched = await launchInternalTerminal(runtime,
        {
          args: ["--utf-force"],
          command: "btop",
          confirmed: true,
          fingerprint: server.surfaceId,
          paneId: secondPane.paneId,
          restartPolicy: "restore_new_process",
          summary: "btop split",
        },
        {
          pushedBy: {
            displayName: "Terminal Launcher",
            sessionKey: "agent:test:terminal",
            source: "openclaw",
          },
        },
      );

      assert.equal(launched.blockedReason, null);
      assert.equal(launched.contentId, null);
      assert.equal(launched.targetKind, "terminal_app");
      assert.equal(launched.targetApplyEvidence?.status, "applied");
      assert.equal(server.contentSetRequests.length, 0);
      assert.equal(server.targetApplyRequests.length, 1);
      const [applyRequest] = server.targetApplyRequests;
      assert.ok(applyRequest);
      assert.equal("materialization" in applyRequest, false);
      assert.equal(applyRequest.paneLineageId, targetRegistrationOwnership(runtime, server.surfaceId, secondPane.paneId).paneLineageId);
      assert.equal(applyRequest.restoreReason, "confirmed_restore");
      assert.equal(applyRequest.targetKind, "terminal_app");
      assert.deepEqual(applyRequest.targetHeader, {
        payloadSchemaVersion: 1,
        replaySemantics: "launch_equivalent",
        requiredCapabilities: ["target.terminal_app.v1"],
        safeToLogFields: ["command", "args"],
        safetyClass: "process",
        summary: "btop split",
      });
      assert.deepEqual(applyRequest.targetPayload, {
        args: ["--utf-force"],
        command: "btop",
        envPolicy: "surface_default",
        pty: true,
        restartPolicy: "restore_new_process",
      });

      const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === secondPane.paneId);
      assert.equal(screenPane?.target?.targetKind, "terminal_app");
      assert.equal(screenPane?.target?.blockedReason, null);
      assert.equal(screenPane?.target?.lastApplyEvidence?.status, "applied");
      assert.deepEqual(screenPane?.target?.targetPayload, {
        args: ["--utf-force"],
        command: "btop",
      });
    });
  });

  await t.test("provider resume replay restores previously confirmed restartable terminal targets", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const [, secondPane] = split;
      assert.ok(secondPane);

      await launchInternalTerminal(runtime, {
        command: "btop",
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: secondPane.paneId,
        restartPolicy: "restore_new_process",
        summary: "btop persisted",
      });
      assert.equal(server.targetApplyRequests.length, 1);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await internalRuntime.repushSurfaceContent(surface);

      assert.equal(server.targetApplyRequests.length, 2);
      const replay = server.targetApplyRequests.at(-1);
      assert.equal(replay?.restoreReason, "resume_restore");
      assert.equal(replay?.targetKind, "terminal_app");
      assert.deepEqual(replay?.targetPayload, {
        args: [],
        command: "btop",
        envPolicy: "surface_default",
        pty: true,
        restartPolicy: "restore_new_process",
      });

      const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === secondPane.paneId);
      assert.equal(screenPane?.target?.targetKind, "terminal_app");
      assert.equal(screenPane?.target?.blockedReason, null);
      assert.equal(screenPane?.target?.lastApplyEvidence?.status, "applied");
    });
  });

  await t.test("provider resume replay keeps restartable terminal eligibility after transient materialization failure", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const [, secondPane] = split;
      assert.ok(secondPane);

      await launchInternalTerminal(runtime, {
        command: "btop",
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: secondPane.paneId,
        restartPolicy: "restore_new_process",
        summary: "btop persisted",
      });
      assert.equal(server.targetApplyRequests.length, 1);

      const internalRuntime = runtime as any;
      internalRuntime.resumeTargetMaterializationRetryDelaysMs = [1];
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      server.targetApplyErrorCode = "materialization_failed";
      await internalRuntime.repushSurfaceContent(surface);

      assert.equal(server.targetApplyRequests.length, 3);
      assert.deepEqual(
        server.targetApplyRequests.slice(1).map((request) => request.restoreReason),
        ["resume_restore", "resume_restore"],
      );
      let screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === secondPane.paneId);
      assert.equal(screenPane?.target?.targetKind, "terminal_app");
      assert.equal(screenPane?.target?.blockedReason, "materialization_failed");
      assert.equal(screenPane?.target?.lastApplyEvidence?.status, "failed");

      server.targetApplyErrorCode = null;
      await internalRuntime.repushSurfaceContent(surface);

      assert.equal(server.targetApplyRequests.length, 4);
      const replay = server.targetApplyRequests.at(-1);
      assert.equal(replay?.restoreReason, "resume_restore");
      assert.equal(replay?.targetKind, "terminal_app");
      screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === secondPane.paneId);
      assert.equal(screenPane?.target?.blockedReason, null);
      assert.equal(screenPane?.target?.lastApplyEvidence?.status, "applied");
    });
  });

  await t.test("provider resume replay retries restartable terminal materialization after transient failure", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const [, secondPane] = split;
      assert.ok(secondPane);

      await launchInternalTerminal(runtime, {
        command: "btop",
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: secondPane.paneId,
        restartPolicy: "restore_new_process",
        summary: "btop retry persisted",
      });
      assert.equal(server.targetApplyRequests.length, 1);

      const internalRuntime = runtime as any;
      internalRuntime.resumeTargetMaterializationRetryDelaysMs = [1];
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      server.targetApplyErrorCode = "materialization_failed";
      server.targetApplyErrorResponsesRemaining = 1;
      await internalRuntime.repushSurfaceContent(surface);

      assert.equal(server.targetApplyRequests.length, 3);
      assert.deepEqual(
        server.targetApplyRequests.slice(1).map((request) => request.restoreReason),
        ["resume_restore", "resume_restore"],
      );
      const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === secondPane.paneId);
      assert.equal(screenPane?.target?.targetKind, "terminal_app");
      assert.equal(screenPane?.target?.blockedReason, null);
      assert.equal(screenPane?.target?.lastApplyEvidence?.status, "applied");
    });
  });

  await t.test("provider resume replay retries restartable terminal materialization while authority is settling", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const [, secondPane] = split;
      assert.ok(secondPane);

      await launchInternalTerminal(runtime, {
        command: "btop",
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: secondPane.paneId,
        restartPolicy: "restore_new_process",
        summary: "btop settling retry persisted",
      });
      assert.equal(server.targetApplyRequests.length, 1);

      const internalRuntime = runtime as any;
      internalRuntime.resumeTargetMaterializationRetryDelaysMs = [1];
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      surface.connectionState = "connecting";
      server.targetApplyErrorCode = "materialization_failed";
      server.targetApplyErrorResponsesRemaining = 1;
      await internalRuntime.repushSurfaceContent(surface);

      assert.equal(server.targetApplyRequests.length, 3);
      assert.deepEqual(
        server.targetApplyRequests.slice(1).map((request) => request.restoreReason),
        ["resume_restore", "resume_restore"],
      );
      const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === secondPane.paneId);
      assert.equal(screenPane?.target?.targetKind, "terminal_app");
      assert.equal(screenPane?.target?.blockedReason, null);
      assert.equal(screenPane?.target?.lastApplyEvidence?.status, "applied");
    });
  });

  await t.test("provider resume replay keeps retrying restartable terminal materialization within bounded delays", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const [, secondPane] = split;
      assert.ok(secondPane);

      await launchInternalTerminal(runtime, {
        command: "btop",
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: secondPane.paneId,
        restartPolicy: "restore_new_process",
        summary: "btop delayed retry persisted",
      });
      assert.equal(server.targetApplyRequests.length, 1);

      const internalRuntime = runtime as any;
      internalRuntime.resumeTargetMaterializationRetryDelaysMs = [1, 1, 1];
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      server.targetApplyErrorCode = "materialization_failed";
      server.targetApplyErrorResponsesRemaining = 2;
      await internalRuntime.repushSurfaceContent(surface);

      assert.equal(server.targetApplyRequests.length, 4);
      assert.deepEqual(
        server.targetApplyRequests.slice(1).map((request) => request.restoreReason),
        ["resume_restore", "resume_restore", "resume_restore"],
      );
      const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === secondPane.paneId);
      assert.equal(screenPane?.target?.targetKind, "terminal_app");
      assert.equal(screenPane?.target?.blockedReason, null);
      assert.equal(screenPane?.target?.lastApplyEvidence?.status, "applied");
    });
  });

  await t.test("provider resume replay coalesces concurrent restartable terminal materialization", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const [, secondPane] = split;
      assert.ok(secondPane);

      await launchInternalTerminal(runtime, {
        command: "btop",
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: secondPane.paneId,
        restartPolicy: "restore_new_process",
        summary: "btop concurrent replay persisted",
      });
      assert.equal(server.targetApplyRequests.length, 1);

      const internalRuntime = runtime as any;
      internalRuntime.resumeTargetMaterializationRetryDelaysMs = [1, 1, 1];
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      server.targetApplyDelayMs = 10;
      server.targetApplyErrorCode = "materialization_failed";
      server.targetApplyErrorResponsesRemaining = 1;
      await Promise.all([
        internalRuntime.repushSurfaceContent(surface),
        internalRuntime.repushSurfaceContent(surface),
      ]);

      assert.equal(server.targetApplyRequests.length, 3);
      assert.deepEqual(
        server.targetApplyRequests.slice(1).map((request) => request.restoreReason),
        ["resume_restore", "resume_restore"],
      );
      const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === secondPane.paneId);
      assert.equal(screenPane?.target?.targetKind, "terminal_app");
      assert.equal(screenPane?.target?.blockedReason, null);
      assert.equal(screenPane?.target?.lastApplyEvidence?.status, "applied");
    });
  });

  await t.test("provider resume replay still blocks manual-only terminal targets", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await launchInternalTerminal(runtime, {
        command: "btop",
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
        restartPolicy: "manual_only",
        summary: "btop manual only",
      });
      assert.equal(server.targetApplyRequests.length, 1);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await internalRuntime.repushSurfaceContent(surface);

      assert.equal(server.targetApplyRequests.length, 1);
      const screenPane = (await runtime.listScreens())[0]?.panes[0];
      assert.equal(screenPane?.target?.targetKind, "terminal_app");
      assert.equal(screenPane?.target?.blockedReason, "restore_requires_confirmation");
    });
  });

  await t.test("surf_ace_launch_native_app applies the primitive native app process target with opaque geometry", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.runtimeAppBinding = trustedRuntimeAppBinding();
      },
      run: async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const launched = await runtime.launchNativeApp({
        appId: "com.example.NativeApp",
        args: ["--pane", "main"],
        confirmed: true,
        cwd: "/tmp",
        env: { SURF_ACE_TEST: "1" },
        fingerprint: server.surfaceId,
        launchMode: "attach_or_launch",
        paneId: firstPaneId,
        summary: "Native App",
      });

      assert.equal(launched.blockedReason, null);
      assert.equal(launched.contentId, null);
      assert.equal(launched.targetKind, "native_app");
      assert.equal(launched.targetApplyEvidence?.status, "applied");
      assert.equal(server.contentSetRequests.length, 0);
      assert.equal(server.targetApplyRequests.length, 1);
      const [applyRequest] = server.targetApplyRequests;
      assert.ok(applyRequest);
      assert.equal("materialization" in applyRequest, false);
      assert.equal(applyRequest.targetKind, "native_app");
      assert.deepEqual(applyRequest.targetHeader, {
        payloadSchemaVersion: 1,
        replaySemantics: "launch_equivalent",
        requiredCapabilities: ["target.native_app.v1"],
        safeToLogFields: ["appId", "args", "cwd", "launchMode"],
        safetyClass: "process",
        summary: "Native App",
      });
      assert.deepEqual(applyRequest.targetPayload, {
        appId: "com.example.NativeApp",
        args: ["--pane", "main"],
        cwd: "/tmp",
        env: { SURF_ACE_TEST: "1" },
        launchMode: "attach_or_launch",
      });

      const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
      assert.equal(screenPane?.target?.targetKind, "native_app");
      assert.equal(screenPane?.target?.blockedReason, null);
      assert.equal(screenPane?.target?.lastApplyEvidence?.status, "applied");
      },
    });
  });

  await t.test("surf_ace_launch_native_app default idempotency includes cwd and env digest", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.runtimeAppBinding = trustedRuntimeAppBinding();
      },
      run: async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

      await runtime.launchNativeApp({
        appId: "com.example.NativeApp",
        args: ["--pane"],
        confirmed: true,
        cwd: "/tmp/one",
        env: { SURF_ACE_TEST: "1" },
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      await runtime.launchNativeApp({
        appId: "com.example.NativeApp",
        args: ["--pane"],
        confirmed: true,
        cwd: "/tmp/two",
        env: { SURF_ACE_TEST: "2" },
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      assert.equal(server.targetApplyRequests.length, 2);
      assert.equal(server.targetApplyRequests[0]?.targetPayload.cwd, "/tmp/one");
      assert.deepEqual(server.targetApplyRequests[0]?.targetPayload.env, { SURF_ACE_TEST: "1" });
      assert.equal(server.targetApplyRequests[1]?.targetPayload.cwd, "/tmp/two");
      assert.deepEqual(server.targetApplyRequests[1]?.targetPayload.env, { SURF_ACE_TEST: "2" });
      },
    });
  });

  await t.test("surf_ace_launch_native_app accepts empty-env compositor proof", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.runtimeAppBinding = trustedRuntimeAppBinding();
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const launched = await runtime.launchNativeApp({
          appId: "com.example.NativeApp",
          confirmed: true,
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(launched.blockedReason, null);
        assert.equal(launched.targetApplyEvidence?.status, "applied");
        assert.equal(launched.targetApplyEvidence?.materializedState?.proof?.envDigest, stableStringRecordDigest({}));
        const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(screenPane?.target?.blockedReason, null);
      },
    });
  });

  await t.test("surf_ace_launch_native_app does not claim readiness without matching pane and target proof", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.runtimeAppBinding = trustedRuntimeAppBinding();
        server.nativeTargetProofContentIdOverride = "target_other";
        server.nativeTargetProofPaneIdOverride = String(server.initialRemotePaneId);
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const launched = await runtime.launchNativeApp({
          appId: "com.example.NativeApp",
          confirmed: true,
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(launched.blockedReason, "materialization_failed");
        assert.equal(launched.targetApplyEvidence?.status, "applied");
        const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(screenPane?.target?.targetKind, "native_app");
        assert.equal(screenPane?.target?.blockedReason, "materialization_failed");
      },
    });
  });

  await t.test("surf_ace_list adopts native window group projection and clears stale native materialization block", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.runtimeAppBinding = trustedRuntimeAppBinding();
        server.nativeTargetProofContentIdOverride = "target_other";
        server.nativeTargetProofPaneIdOverride = String(server.initialRemotePaneId);
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const launched = await runtime.launchNativeApp({
          appId: "com.example.NativeApp",
          confirmed: true,
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(launched.blockedReason, "materialization_failed");
        const remotePane = server.panes.get(server.initialRemotePaneId);
        assert.ok(remotePane);
        remotePane.nativeWindowGroup = {
          acceptedSecondaryCount: 0,
          clippingStatus: "clipped",
          deniedReasons: [],
          deniedToplevelCount: 0,
          focusedWindowId: "native-primary",
          launchToken: "provider-launch-token",
          members: [{
            bounds: { height: 480, width: 640, x: 0, y: 0 },
            clippedToPane: true,
            focused: true,
            id: "native-primary",
            lifecycle: "live",
            role: "primary",
          }],
          paneId: String(server.initialRemotePaneId),
          paneInstanceId: remotePane.paneLineageId,
          paneLocalBounds: { height: 480, width: 640, x: 0, y: 0 },
          primaryWindowId: "native-primary",
        };

        const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(screenPane?.target?.targetKind, "native_app");
        assert.equal(screenPane?.target?.blockedReason, null);
        assert.equal(screenPane?.nativeWindowGroup?.primaryWindowId, "native-primary");
      },
    });
  });

  await t.test("surf_ace_launch_native_app fails closed when runtime app binding is missing", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await assert.rejects(
        runtime.launchNativeApp({
          appId: "com.example.NativeApp",
          confirmed: true,
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        }),
        /runtime_binding_missing/,
      );
      assert.equal(server.targetApplyRequests.length, 0);
    });
  });

  await t.test("surf_ace_launch_native_app refreshes runtime app binding before claiming readiness", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.runtimeAppBinding = trustedRuntimeAppBinding();
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        server.runtimeAppBinding = {
          ...trustedRuntimeAppBinding(),
          acknowledgement: "failed",
          bindingAuthority: "degraded",
          bindingDegradedReasons: ["process_lineage_missing"],
          failureMessage: "process lineage missing at launch",
          processLineageStatus: "missing",
          ready: false,
        };

        await assert.rejects(
          runtime.launchNativeApp({
            appId: "com.example.NativeApp",
            confirmed: true,
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          }),
          /runtime_binding_degraded/,
        );

        assert.equal(server.runtimeAppBindingRequests, 1);
        assert.equal(server.targetApplyRequests.length, 0);
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.equal(screen?._debug?.runtimeAppBinding?.processLineageStatus, "missing");
      },
    });
  });

  await t.test("internal terminal_app target fails closed without explicit confirmation", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

      await assert.rejects(
        async () => await launchInternalTerminal(runtime, {
          command: "btop",
          confirmed: false,
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        }),
        /confirmed:true/,
      );
      assert.equal(server.contentSetRequests.length, 0);
      assert.equal(server.targetApplyRequests.length, 0);
    });
  });

  await t.test("surf_ace_push browser_url uses pair.response ownership epoch for actionable panes", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.pairResponseOwnershipEpoch = 7;
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const screenPane = (await runtime.listScreens())[0]?.panes.find((candidate) => candidate.paneId === firstPaneId);
        assert.equal(screenPane?.paneId, firstPaneId);

        const pushed = await runtime.push({
          content: "http://100.85.66.60:4173/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(pushed.blockedReason, null);
        assert.equal(server.targetApplyRequests.length, 1);
        assert.equal(server.targetApplyRequests[0]?.ownershipEpoch, 7);
      },
    });
  });

  await t.test("surf_ace_push browser_url keeps failed materialization as target evidence", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
        server.targetApplyErrorCode = "materialization_failed";
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push({
          content: "https://blocked.invalid/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(pushed.contentId, null);
        assert.equal(pushed.blockedReason, "materialization_failed");
        assert.equal(pushed.targetApplyEvidence?.status, "failed");
        assert.equal(pushed.targetApplyEvidence?.errorCode, "materialization_failed");
        const screens = await runtime.listScreens();
        const target = screens[0]?.panes[0]?.target;
        assert.equal(target?.targetKind, "browser_url");
        assert.equal(target?.blockedReason, "materialization_failed");
        assert.equal(target?.lastApplyEvidence?.status, "failed");
      },
    });
  });

  await t.test("surf_ace_push html replaces failed browser_url target after provider revision reset", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
        server.targetApplyErrorCode = "materialization_failed";
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        await runtime.push({
          content: "<main>before browser target</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const browserPush = await runtime.push({
          content: "https://blocked.invalid/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(browserPush.blockedReason, "materialization_failed");

        server.targetApplyErrorCode = null;
        server.nextContentApplyError = {
          code: "stale_revision",
          details: { expectedRevision: 1 },
          message: "revision mismatch",
        };
        const htmlPush = await runtime.push({
          content: "<main>replacement</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(htmlPush.revision, 1);
        assert.equal(server.contentSetRequests.at(-1)?.revision, 1);
        const screen = (await runtime.listScreens())[0];
        const pane = screen?.panes[0];
        assert.equal(screen?.authority.actionable, true);
        assert.equal(pane?.activeContent?.contentId, htmlPush.contentId);
        assert.equal(pane?.target?.targetKind, "html");
        assert.equal(pane?.target?.blockedReason, null);
      },
    });
  });

  await t.test("surf_ace_push markdown recovers failed html materialization in pane 15", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        const initialPane = server.panes.get(server.initialRemotePaneId);
        assert.ok(initialPane);
        initialPane.paneLabel = 15;
      },
      run: async ({ runtime, server }) => {
        const paneId = await livePaneId(runtime, server.surfaceId, 15);
        const htmlPush = await runtime.push({
          content: "<main>pane 15 failed materialization</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId,
        });
        assert.equal(htmlPush.paneLabel, 15);
        assert.equal(htmlPush.paneAddress, "15");

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(paneId);
        assert.ok(pane);
        const target = surface.targetRecords.get(pane.currentTargetId);
        assert.ok(target);
        target.lastApplyEvidence = {
          appliedAt: new Date(1_777_500).toISOString(),
          errorCode: "materialization_failed",
          message: "ATS blocked HTTP materialization",
          requestId: "rq_t1385_failed_materialization",
          status: "failed",
        };
        pane.lastRestoreBlockedReason = "materialization_failed";
        await internalRuntime.persistSurfaceTargetState(surface, "test failed html materialization");
        server.contentSetRequests.length = 0;

        server.nextContentApplyError = {
          code: "stale_revision",
          details: { expectedRevision: 1 },
          message: "revision mismatch",
        };
        const markdownPush = await runtime.push({
          content: "# pane 15 recovered",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId,
        });

        assert.equal(markdownPush.revision, 1);
        assert.equal(markdownPush.paneId, paneId);
        assert.equal(markdownPush.paneLabel, 15);
        assert.equal(markdownPush.paneAddress, "15");
        assert.deepEqual(server.contentSetRequests.map((request) => request.revision), [1]);

        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        const listedPane = screen?.panes.find((candidate) => candidate.paneId === paneId);
        assert.equal(screen?.authority.actionable, true);
        assert.equal(listedPane?.paneLabel, 15);
        assert.equal(listedPane?.paneAddress, "15");
        assert.equal(listedPane?.activeContent?.contentId, markdownPush.contentId);
        assert.equal(listedPane?.activeContent?.contentType, "markdown");
        assert.equal(listedPane?.target?.targetKind, "markdown");
        assert.equal(listedPane?.target?.blockedReason, null);
      },
    });
  });

  await t.test("surf_ace_clear clears failed browser_url target without dropping actionability", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
        server.targetApplyErrorCode = "materialization_failed";
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        await runtime.push({
          content: "<main>before browser target</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const browserPush = await runtime.push({
          content: "https://blocked.invalid/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(browserPush.blockedReason, "materialization_failed");

        server.targetApplyErrorCode = null;
        server.nextContentApplyError = {
          code: "stale_revision",
          details: { expectedRevision: 1 },
          message: "revision mismatch",
        };
        const cleared = await runtime.clear({
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(cleared.revision, 1);
        assert.deepEqual(server.clearRequests.map((request) => request.revision), [1]);
        const screen = (await runtime.listScreens())[0];
        assert.equal(screen?.authority.actionable, true);
        assert.equal(screen?.panes[0]?.activeContent, null);
        assert.equal(screen?.panes[0]?.target, null);
      },
    });
  });

  await t.test("surf_ace_push html retries failed browser_url revision recovery once", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
        server.targetApplyErrorCode = "materialization_failed";
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const initial = await runtime.push({
          content: "<main>before browser target</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const browserPush = await runtime.push({
          content: "https://blocked.invalid/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(browserPush.blockedReason, "materialization_failed");

        server.targetApplyErrorCode = null;
        const staleRevisionError = {
          code: "stale_revision",
          details: { expectedRevision: 1 },
          message: "revision mismatch",
        };
        server.nextContentApplyErrors = [staleRevisionError, staleRevisionError, staleRevisionError];

        await assert.rejects(
          runtime.push({
            content: "<main>replacement</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          }),
          /revision mismatch/,
        );

        const screen = (await runtime.listScreens())[0];
        const pane = screen?.panes[0];
        assert.equal(screen?.authority.actionable, true);
        assert.equal(pane?.activeContent?.contentId, initial.contentId);
        assert.equal(pane?.target?.targetKind, "browser_url");
        assert.equal(pane?.target?.blockedReason, "materialization_failed");
      },
    });
  });

  await t.test("surf_ace_push html stays actionable after browser_url recovery navigation", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
        server.targetApplyErrorCode = "materialization_failed";
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        await runtime.push({
          content: "<main>before browser target</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const failedBrowserPush = await runtime.push({
          content: "https://blocked.invalid/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(failedBrowserPush.blockedReason, "materialization_failed");

        server.targetApplyErrorCode = null;
        const recoveryNavigation = await runtime.push({
          content: "https://example.com/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(recoveryNavigation.blockedReason, null);

        const htmlPush = await runtime.push({
          content: "<main>after browser recovery</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const screen = (await runtime.listScreens())[0];
        const pane = screen?.panes[0];
        assert.equal(screen?.authority.actionable, true);
        assert.equal(pane?.activeContent?.contentId, htmlPush.contentId);
        assert.equal(pane?.target?.targetKind, "html");
        assert.equal(pane?.target?.blockedReason, null);
      },
    });
  });

  await t.test("surf_ace_push browser_url treats ownership mismatch as reconciliation diagnostic", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
        server.targetApplyResultErrorCode = "ownership_epoch_mismatch";
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);

        const pushed = await runtime.push({
          content: "http://100.85.66.60:18803/",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        assert.equal(pushed.blockedReason, "ownership_epoch_mismatch");
        assert.equal(pushed.targetApplyEvidence?.errorCode, "ownership_epoch_mismatch");
        assert.equal(server.targetApplyRequests.length, 1);

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        assert.ok(pane.currentTargetId);
        assert.equal(pane.lastRestoreBlockedReason, null);
        assert.equal(pane.staleTargetId, null);
        const currentTarget = surface.targetRecords.get(pane.currentTargetId);
        assert.equal(currentTarget?.currentState, "current");
        assert.equal(currentTarget?.lastApplyEvidence?.errorCode, "ownership_epoch_mismatch");
        assert.equal(surface.sessionId, null);
        assert.equal(surface.hasPairedInGatewaySession, false);
        assert.equal(surface.localOwnership, null);
        assert.equal(surface.connectionState, "connecting");
        assert.equal(surface.authorityRejectedReason, "ownership_epoch_mismatch");
      },
    });
  });

  await t.test("provider sends split pane target.apply without native pane geometry", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const [, secondPane] = split;
      assert.ok(secondPane);
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "terminal:btop:split-pane",
        ...targetRegistrationOwnership(runtime, server.surfaceId, secondPane.paneId),
        paneId: secondPane.paneId,
        registrationState: "attached",
        restorePolicy: "manual",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command", "args"],
          safetyClass: "process",
          summary: "btop split",
        },
        targetKind: "terminal_app",
        targetPayload: {
          args: ["--utf-force"],
          command: "btop",
          envPolicy: "surface_default",
          pty: true,
          restartPolicy: "restore_new_process",
        },
      });
      assert.equal(registered.status, "registered");

      const restored = await runtime.restoreTarget({
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: secondPane.paneId,
      });
      assert.equal(restored.blockedReason, null);
      assert.equal(server.targetApplyRequests.length, 1);

      const [applyRequest] = server.targetApplyRequests;
      assert.ok(applyRequest);
      assert.equal("materialization" in applyRequest, false);
      assert.equal(applyRequest.paneLineageId, targetRegistrationOwnership(runtime, server.surfaceId, secondPane.paneId).paneLineageId);
      assert.deepEqual(applyRequest.targetPayload, {
        args: ["--utf-force"],
        command: "btop",
        envPolicy: "surface_default",
        pty: true,
        restartPolicy: "restore_new_process",
      });
    });
  });

  await t.test("provider keeps rotated logical surface target.apply geometry-opaque", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.addSurface({
          surfaceId: server.surfaceId,
          viewport: { height: 3840, scale: 1, width: 2160 },
        });
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const registered = await runtime.registerTarget({
          expectedPreviousTargetEpoch: null,
          fingerprint: server.surfaceId,
          idempotencyKey: "terminal:top:racter-deg90-logical",
          ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
          paneId: firstPaneId,
          registrationState: "attached",
          restorePolicy: "manual",
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "launch_equivalent",
            requiredCapabilities: ["target.terminal_app.v1"],
            safeToLogFields: ["command", "args"],
            safetyClass: "process",
            summary: "top deg90",
          },
          targetKind: "terminal_app",
          targetPayload: {
            args: [],
            command: "top",
            envPolicy: "surface_default",
            pty: true,
            restartPolicy: "restore_new_process",
          },
        });
        assert.equal(registered.status, "registered");

        const restored = await runtime.restoreTarget({
          confirmed: true,
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assert.equal(restored.blockedReason, null);
        assert.equal(server.targetApplyRequests.length, 1);

        const [applyRequest] = server.targetApplyRequests;
        assert.ok(applyRequest);
        assert.equal("materialization" in applyRequest, false);
        assert.equal(applyRequest.paneLineageId, targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId).paneLineageId);
        assert.deepEqual(applyRequest.targetPayload, {
          args: [],
          command: "top",
          envPolicy: "surface_default",
          pty: true,
          restartPolicy: "restore_new_process",
        });
      },
    });
  });

  await t.test("provider sends native app target.apply without native pane geometry", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "native:app:geometry",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        restorePolicy: "manual",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.native_app.v1"],
          safeToLogFields: ["appId"],
          safetyClass: "process",
          summary: "Native App",
        },
        targetKind: "native_app",
        targetPayload: {
          appId: "com.example.NativeApp",
          launchMode: "new_instance",
        },
      });
      assert.equal(registered.status, "registered");

      const restored = await runtime.restoreTarget({
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assert.equal(restored.blockedReason, null);
      assert.equal(server.targetApplyRequests.length, 1);

      const [applyRequest] = server.targetApplyRequests;
      assert.ok(applyRequest);
      assert.equal("materialization" in applyRequest, false);
      assert.equal(applyRequest.targetKind, "native_app");
      assert.deepEqual(applyRequest.targetPayload, {
        appId: "com.example.NativeApp",
        launchMode: "new_instance",
      });
    });
  });

  await t.test("provider rejects duplicate and stale local target registrations without incrementing epoch", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const input = {
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "native:app:1",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached" as const,
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent" as const,
          requiredCapabilities: ["target.native_app.v1"],
          safeToLogFields: ["appId"],
          safetyClass: "process" as const,
          summary: "Native App",
        },
        targetKind: "native_app" as const,
        targetPayload: {
          appId: "com.example.Native",
          launchMode: "new_instance",
        },
      };
      const first = await runtime.registerTarget(input);
      const duplicate = await runtime.registerTarget(input);
      assert.equal(first.status, "registered");
      assert.deepEqual(duplicate, first);

      const stale = await runtime.registerTarget({
        ...input,
        idempotencyKey: "native:app:stale",
        targetPayload: {
          appId: "com.example.Other",
          launchMode: "new_instance",
        },
      });
      assert.equal(stale.status, "rejected");
      assert.equal(stale.status === "rejected" ? stale.errorCode : "", "target_epoch_stale");

      const oldEpoch = await runtime.registerTarget({
        ...input,
        idempotencyKey: "native:app:old-epoch",
        ownershipEpoch: input.ownershipEpoch - 1,
      });
      assert.equal(oldEpoch.status, "rejected");
      assert.equal(oldEpoch.status === "rejected" ? oldEpoch.errorCode : "", "registration_late_old_epoch");

      await runtime.clear({
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const staleAfterTombstone = await runtime.registerTarget({
        ...input,
        idempotencyKey: "native:app:stale-after-tombstone",
      });
      assert.equal(staleAfterTombstone.status, "rejected");
      assert.equal(staleAfterTombstone.status === "rejected" ? staleAfterTombstone.errorCode : "", "target_epoch_stale");

      const malformed = await runtime.registerTarget({
        ...input,
        expectedPreviousTargetEpoch: first.status === "registered" ? first.targetEpoch : null,
        idempotencyKey: "native:app:malformed",
        targetPayload: {
          appId: "com.example.Malformed",
        },
      });
      assert.equal(malformed.status, "rejected");
      assert.equal(malformed.status === "rejected" ? malformed.errorCode : "", "unsafe_payload");

      const malformedImage = await runtime.registerTarget({
        expectedPreviousTargetEpoch: first.status === "registered" ? first.targetEpoch : null,
        fingerprint: server.surfaceId,
        idempotencyKey: "image:malformed",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "bytes",
          requiredCapabilities: ["target.image.v1"],
          safeToLogFields: ["mediaType", "alt"],
          safetyClass: "passive",
          summary: "Malformed Image",
        },
        targetKind: "image",
        targetPayload: {
          data: "aGVsbG8=",
        },
      });
      assert.equal(malformedImage.status, "rejected");
      assert.equal(malformedImage.status === "rejected" ? malformedImage.errorCode : "", "unsafe_payload");
    });
  });

  await t.test("provider reuses same-install target records by idempotency key after ownership change", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const input = {
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "native:app:ownership-rerun",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached" as const,
        restorePolicy: "manual" as const,
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent" as const,
          requiredCapabilities: ["target.native_app.v1"],
          safeToLogFields: ["appId"],
          safetyClass: "process" as const,
          summary: "Native App",
        },
        targetKind: "native_app" as const,
        targetPayload: {
          appId: "com.example.Native",
          launchMode: "new_instance" as const,
        },
      };
      const first = await runtime.registerTarget(input);
      assert.equal(first.status, "registered");

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      internalRuntime.markPairConnected(surface, "sa_target_reowned_session", surface.ownershipEpoch + 1, false);

      const rerunAfterOwnershipChange = await runtime.registerTarget({
        ...input,
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        expectedPreviousTargetEpoch: first.status === "registered" ? first.targetEpoch : null,
      });
      assert.equal(rerunAfterOwnershipChange.status, "registered");
      if (rerunAfterOwnershipChange.status === "registered") {
        assert.equal(rerunAfterOwnershipChange.targetId, first.targetId);
      }

      const retainedTarget = surface.targetRecords.get(first.status === "registered" ? first.targetId : "");
      assert.equal(retainedTarget?.currentState, "current");
      assert.equal(
        surface.registeredTargetIdsByIdempotencyKey.get(input.idempotencyKey),
        rerunAfterOwnershipChange.status === "registered" ? rerunAfterOwnershipChange.targetId : null,
      );
    });
  });

  await t.test("provider normalizes generic target.apply failures for diagnostics", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      server.targetApplyErrorCode = "busy";
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "terminal:busy:1",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command"],
          safetyClass: "process",
          summary: "busy terminal",
        },
        targetKind: "terminal_app",
        targetPayload: {
          args: [],
          command: "top",
          envPolicy: "surface_default",
          pty: true,
          restartPolicy: "restore_new_process",
        },
      });
      assert.equal(registered.status, "registered");

      const restored = await runtime.restoreTarget({
        confirmed: true,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assert.equal(restored.evidence?.status, "failed");
      assert.equal(restored.evidence?.errorCode, "materialization_failed");
      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.target?.blockedReason, "materialization_failed");
    });
  });

  await t.test("provider blocks process auto-restore without a validated approval token model", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const registered = await runtime.registerTarget({
        expectedPreviousTargetEpoch: null,
        fingerprint: server.surfaceId,
        idempotencyKey: "terminal:auto:approval-token-string",
        ...targetRegistrationOwnership(runtime, server.surfaceId, firstPaneId),
        paneId: firstPaneId,
        registrationState: "attached",
        restorePolicy: "auto",
        targetHeader: {
          payloadSchemaVersion: 1,
          replaySemantics: "launch_equivalent",
          requiredCapabilities: ["target.terminal_app.v1"],
          safeToLogFields: ["command"],
          safetyClass: "process",
          summary: "top",
        },
        targetKind: "terminal_app",
        targetPayload: {
          approvalTokenId: "not-provider-validated",
          args: [],
          command: "top",
          envPolicy: "surface_default",
          pty: true,
          restartPolicy: "restore_new_process",
        },
      });
      assert.equal(registered.status, "registered");

      const restored = await runtime.restoreTarget({
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assert.equal(restored.blockedReason, "approval_required");
      assert.equal(server.targetApplyRequests.length, 0);
    });
  });

  await t.test("provider splits panes with provider-assigned pane ids and closes them by pane scope", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      const splitPaneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);
      assert.deepEqual(server.splitRequests, []);
      assert.ok(
        server.topologyApplyRequests.some((request) => (
          JSON.stringify(request.layout) === JSON.stringify({
            children: [
              { paneId: server.initialRemotePaneId, type: "pane" },
              { paneId: 42, type: "pane" },
              { paneId: 43, type: "pane" },
            ],
            direction: "horizontal",
            type: "split",
          }) &&
          JSON.stringify(request.paneIds) === JSON.stringify([server.initialRemotePaneId, 42, 43]) &&
          JSON.stringify(request.paneLabels) === JSON.stringify([1, 2, 3]) &&
          request.windowLabel === "a"
        )),
      );

      const splitScreens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(splitScreens[0]?.panes ?? [], [1, 2, 3]);
      assert.deepEqual(
        splitScreens[0]?.panes.map((pane) => pane.viewport),
        [
          { height: 256, scale: 2, width: 1024 },
          { height: 256, scale: 2, width: 1024 },
          { height: 256, scale: 2, width: 1024 },
        ],
      );

      const close = await runtime.closePane({
        fingerprint: server.surfaceId,
        paneId: splitPaneIds[1]!,
      });
      assert.deepEqual(close, { displayId: "2", ok: true, paneAddress: "2", paneId: splitPaneIds[1], paneLabel: 2 });
      assert.deepEqual(server.closePaneRequests, []);
      assert.deepEqual(server.topologyApplyRequests.at(-1), {
        layout: {
          children: [
            { paneId: server.initialRemotePaneId, type: "pane" },
            { paneId: 43, type: "pane" },
          ],
          direction: "horizontal",
          type: "split",
        },
        paneIds: [server.initialRemotePaneId, 43],
        paneLabels: [1, 3],
        topologyRevision: server.topologyApplyRequests.at(-1)?.topologyRevision,
        windowLabel: "a",
      });

      const afterCloseScreens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(afterCloseScreens[0]?.panes ?? [], [1, 3]);
    });
  });

    await t.test("provider realizes a desired root topology in one topology.apply", async () => {
      await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const firstPaneId = paneByLabel(before, 1).paneId;
      assert.deepEqual(before.topology, { paneId: firstPaneId, type: "pane" });
      assert.equal(before.topologyRevision, 0);

      const realized = await runtime.realizeTopology({
        allowDestroyPaneIds: [],
        desired: {
          children: [
            { paneId: firstPaneId, type: "pane" },
            { type: "pane" },
            { name: "scratch", type: "pane" },
          ],
          direction: "vertical",
          type: "split",
        },
        expectedTopologyRevision: before.topologyRevision,
        fingerprint: server.surfaceId,
        target: { root: true },
      });

      assert.deepEqual(server.splitRequests, []);
      assert.equal(server.topologyApplyRequests.length, 1);
      assert.deepEqual(server.topologyApplyRequests[0], {
        layout: {
          children: [
            { paneId: server.initialRemotePaneId, type: "pane" },
            { paneId: 42, type: "pane" },
            { paneId: 43, type: "pane" },
          ],
          direction: "vertical",
          type: "split",
        },
        paneIds: [server.initialRemotePaneId, 42, 43],
        paneLabels: [1, 2, 3],
        topologyRevision: 1,
        windowLabel: "a",
      });
      assert.deepEqual(realized.createdPaneIds.length, 2);
      assert.deepEqual(realized.destroyedPaneIds, []);
      assert.deepEqual(realized.preservedPaneIds, [firstPaneId]);
      assert.deepEqual(realized.panes.map((pane) => pane.paneLabel), [1, 2, 3]);
      assert.deepEqual(realized.topology, {
        children: [
          { paneId: firstPaneId, type: "pane" },
          { paneId: realized.createdPaneIds[0], type: "pane" },
          { paneId: realized.createdPaneIds[1], type: "pane" },
        ],
        direction: "vertical",
        type: "split",
      });

      const after = (await runtime.listScreens())[0]!;
      assert.deepEqual(after.topology, realized.topology);
      assert.equal(after.topologyRevision, 1);
      assertPaneLabelsWithOpaqueIds(after.panes, [1, 2, 3]);
      });
    });

    await t.test("provider realizes weighted topology so list reflects resized panes", async () => {
      await withRuntimeHarness(async ({ runtime, server }) => {
        const before = (await runtime.listScreens())[0]!;
        const firstPaneId = paneByLabel(before, 1).paneId;

        const realized = await runtime.realizeTopology({
          allowDestroyPaneIds: [],
          desired: {
            children: [
              { paneId: firstPaneId, type: "pane", weight: 1 },
              { type: "pane", weight: 3 },
            ],
            direction: "vertical",
            type: "split",
          },
          expectedTopologyRevision: before.topologyRevision,
          fingerprint: server.surfaceId,
          target: { root: true },
        });

        assert.deepEqual(server.topologyApplyRequests.at(-1)?.layout, {
          children: [
            { paneId: server.initialRemotePaneId, type: "pane", weight: 1 },
            { paneId: 42, type: "pane", weight: 3 },
          ],
          direction: "vertical",
          type: "split",
        });
        assert.deepEqual(realized.topology, {
          children: [
            { paneId: firstPaneId, type: "pane", weight: 1 },
            { paneId: realized.createdPaneIds[0], type: "pane", weight: 3 },
          ],
          direction: "vertical",
          type: "split",
        });

        const after = (await runtime.listScreens())[0]!;
        assert.deepEqual(
          after.panes.map((pane) => pane.viewport),
          [
            { height: 768, scale: 2, width: 256 },
            { height: 768, scale: 2, width: 768 },
          ],
        );
      });
    });

    await t.test("provider preserves compact pane labels when topology reorders surviving panes", async () => {
      await withRuntimeHarness(async ({ runtime, server }) => {
        const before = (await runtime.listScreens())[0]!;
        const firstPaneId = paneByLabel(before, 1).paneId;
        const split = await runtime.realizeTopology({
          allowDestroyPaneIds: [],
          desired: {
            children: [
              { paneId: firstPaneId, type: "pane" },
              { type: "pane" },
            ],
            direction: "horizontal",
            type: "split",
          },
          expectedTopologyRevision: before.topologyRevision,
          fingerprint: server.surfaceId,
          target: { root: true },
        });
        const labelOnePaneId = paneByLabel({ ...before, panes: split.panes }, 1).paneId;
        const labelTwoPaneId = paneByLabel({ ...before, panes: split.panes }, 2).paneId;

        const reordered = await runtime.realizeTopology({
          allowDestroyPaneIds: [],
          desired: {
            children: [
              { paneId: labelTwoPaneId, type: "pane" },
              { paneId: labelOnePaneId, type: "pane" },
            ],
            direction: "horizontal",
            type: "split",
          },
          expectedTopologyRevision: split.topologyRevision,
          fingerprint: server.surfaceId,
          target: { root: true },
        });

        assert.equal(paneByLabel({ ...before, panes: reordered.panes }, 1).paneId, labelOnePaneId);
        assert.equal(paneByLabel({ ...before, panes: reordered.panes }, 2).paneId, labelTwoPaneId);
        assert.deepEqual(server.topologyApplyRequests.at(-1)?.paneLabels, [2, 1]);
      });
    });

    await t.test("provider realizes topology across multiple surfaces in one CLU operation", async () => {
      await withRuntimeHarness({
        configureServer: (server) => {
          server.addSurface({
            initialRemotePaneId: 51,
            name: "Surface B",
            surfaceId: "sf_surface-b",
          });
        },
        run: async ({ runtime, server }) => {
          const before = await runtime.listScreens();
          const surfaceA = before.find((screen) => screen.fingerprint === server.surfaceId);
          const surfaceB = before.find((screen) => screen.fingerprint === "sf_surface-b");
          assert.ok(surfaceA);
          assert.ok(surfaceB);
          const paneA = surfaceA.panes[0]!;
          const paneB = surfaceB.panes[0]!;
          const topologyApplyCount = server.topologyApplyRequests.length;
          const surfaceATopologyRevision = surfaceA.topologyRevision;
          const surfaceBTopologyRevision = surfaceB.topologyRevision;

          const realized = await runtime.realizeTopologies({
            operations: [
              {
                allowDestroyPaneIds: [],
                desired: {
                  children: [{ paneId: paneA.paneId, type: "pane" }, { name: "A scratch", type: "pane" }],
                  direction: "vertical",
                  type: "split",
                },
                expectedTopologyRevision: surfaceA.topologyRevision,
                fingerprint: surfaceA.fingerprint,
                operationId: "surface-a",
                target: { root: true },
                windowLabel: surfaceA.windowLabel,
              },
              {
                allowDestroyPaneIds: [],
                desired: {
                  children: [{ paneId: paneB.paneId, type: "pane" }, { name: "B scratch", type: "pane" }],
                  direction: "vertical",
                  type: "split",
                },
                expectedTopologyRevision: surfaceB.topologyRevision,
                fingerprint: surfaceB.fingerprint,
                operationId: "surface-b",
                target: { root: true },
                windowLabel: surfaceB.windowLabel,
              },
            ],
          });

          assert.equal(realized.ok, true);
          assert.deepEqual(realized.applied.map((result) => result.operationId), ["surface-a", "surface-b"]);
          assert.deepEqual(realized.applied.map((result) => result.fingerprint), [surfaceA.fingerprint, surfaceB.fingerprint]);
          assert.deepEqual(realized.applied.map((result) => result.createdPaneIds.length), [1, 1]);
          assert.equal(server.topologyApplyRequests.length - topologyApplyCount, 2);
          const returnedDisplayIds = realized.applied.flatMap((result) => result.panes.map((pane) => pane.displayId));
          const returnedPaneAddresses = realized.applied.flatMap((result) => result.panes.map((pane) => pane.paneAddress));
          assert.equal(new Set(returnedDisplayIds).size, returnedDisplayIds.length);
          assert.equal(new Set(returnedPaneAddresses).size, returnedPaneAddresses.length);
          assert.equal(returnedDisplayIds.every((displayId) => !/^[a-z]+-?\d+$/i.test(displayId)), true);
          assert.equal(returnedDisplayIds.includes("e1"), false);
          assert.equal(returnedDisplayIds.includes("e16"), false);
          assert.equal(returnedDisplayIds.includes("b13"), false);

          const after = await runtime.listScreens();
          const afterA = after.find((screen) => screen.fingerprint === surfaceA.fingerprint);
          const afterB = after.find((screen) => screen.fingerprint === surfaceB.fingerprint);
          assert.equal(afterA?.panes.length, 2);
          assert.equal(afterB?.panes.length, 2);
          assert.equal(afterA?.topologyRevision, surfaceATopologyRevision + 1);
          assert.equal(afterB?.topologyRevision, surfaceBTopologyRevision + 1);
        },
      });
    });

    await t.test("provider realizes Spatial surface window lifecycle through topology mutation surface", async () => {
      await withRuntimeHarness(async ({ runtime, server }) => {
        const before = (await runtime.listScreens())[0];
        assert.ok(before);
        server.nextSurfaceWindowOpenResponse = {
          accepted: true,
          surfaceId: "sf_spatial_surface-b",
        };

        const opened = await runtime.realizeTopologies({
          operations: [
            {
              action: "openWindow",
              fingerprint: before.fingerprint,
              operationId: "spatial-window-open",
              requestedBy: "authorized-agent",
              windowLabel: before.windowLabel,
            },
          ],
        });

        assert.equal(opened.ok, true);
        assert.deepEqual(opened.applied, [
          {
            accepted: true,
            action: "openWindow",
            fingerprint: before.fingerprint,
            openedSurfaceId: "sf_spatial_surface-b",
            operationId: "spatial-window-open",
            windowLabel: before.windowLabel,
          },
        ]);
        assert.deepEqual(server.surfaceWindowOpenRequests, [
          {
            requestedBy: "authorized-agent",
            surfaceId: before.fingerprint,
          },
        ]);

        server.sendSurfaceAppeared({
          fromSurfaceId: before.fingerprint,
          initialRemotePaneId: 51,
          name: "Spatial Surface B",
          surfaceId: "sf_spatial_surface-b",
        });
        await waitFor(async () =>
          (await runtime.listScreens()).some((screen) => screen.fingerprint === "sf_spatial_surface-b"),
        );

        const discovered = (await runtime.listScreens()).find((screen) => screen.fingerprint === "sf_spatial_surface-b");
        assert.ok(discovered);
        assert.equal(discovered.name, "Spatial Surface B");

        const closed = await runtime.realizeTopologies({
          operations: [
            {
              action: "closeWindow",
              fingerprint: discovered.fingerprint,
              operationId: "spatial-window-close",
              requestedBy: "authorized-agent",
              windowLabel: discovered.windowLabel,
            },
          ],
        });

        assert.equal(closed.ok, true);
        assert.deepEqual(closed.applied, [
          {
            action: "closeWindow",
            closed: true,
            fingerprint: discovered.fingerprint,
            operationId: "spatial-window-close",
            windowLabel: discovered.windowLabel,
          },
        ]);
        assert.deepEqual(server.surfaceWindowCloseRequests, [
          {
            requestedBy: "authorized-agent",
            surfaceId: discovered.fingerprint,
          },
        ]);

        server.sendSurfaceRemoved({
          fromSurfaceId: before.fingerprint,
          surfaceId: discovered.fingerprint,
        });
        await waitFor(async () =>
          !(await runtime.listScreens()).some((screen) => screen.fingerprint === discovered.fingerprint),
        );
      });
    });

    await t.test("provider multi-surface topology reports clear partial failure", async () => {
      await withRuntimeHarness({
        configureServer: (server) => {
          server.addSurface({
            initialRemotePaneId: 51,
            name: "Surface B",
            surfaceId: "sf_surface-b",
          });
        },
        run: async ({ runtime, server }) => {
          const before = await runtime.listScreens();
          const surfaceA = before.find((screen) => screen.fingerprint === server.surfaceId);
          const surfaceB = before.find((screen) => screen.fingerprint === "sf_surface-b");
          assert.ok(surfaceA);
          assert.ok(surfaceB);
          const surfaceATopologyRevision = surfaceA.topologyRevision;
          const surfaceBTopologyRevision = surfaceB.topologyRevision;
          const result = await runtime.realizeTopologies({
            operations: [
              {
                allowDestroyPaneIds: [surfaceA.panes[0]!.paneId],
                desired: { children: [{ type: "pane" }, { type: "pane" }], direction: "vertical", type: "split" },
                expectedTopologyRevision: surfaceA.topologyRevision,
                fingerprint: surfaceA.fingerprint,
                operationId: "applies-first",
                target: { root: true },
              },
              {
                allowDestroyPaneIds: [],
                desired: { children: [{ type: "pane" }, { type: "pane" }], direction: "vertical", type: "split" },
                expectedTopologyRevision: surfaceB.topologyRevision + 1,
                fingerprint: surfaceB.fingerprint,
                operationId: "fails-second",
                target: { root: true },
              },
              {
                allowDestroyPaneIds: [],
                desired: { type: "pane" },
                expectedTopologyRevision: surfaceA.topologyRevision,
                fingerprint: surfaceA.fingerprint,
                operationId: "skipped-third",
                target: { root: true },
              },
            ],
          });

          assert.equal(result.ok, false);
          assert.deepEqual(result.applied.map((applied) => applied.operationId), ["applies-first"]);
          assert.equal(result.failed.operationId, "fails-second");
          assert.equal(result.failed.index, 1);
          assert.equal(result.failed.code, "invalid_operation");
          assert.deepEqual(result.skipped.map((skipped) => skipped.operationId), ["skipped-third"]);

          const after = await runtime.listScreens();
          assert.equal(
            after.find((screen) => screen.fingerprint === surfaceA.fingerprint)?.topologyRevision,
            surfaceATopologyRevision + 1,
          );
          assert.equal(
            after.find((screen) => screen.fingerprint === surfaceB.fingerprint)?.topologyRevision,
            surfaceBTopologyRevision,
          );
        },
      });
    });

    await t.test("provider root realization prunes stale local panes outside provider authority", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const firstPaneId = paneByLabel(before, 1).paneId;
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const firstPane = surface.panes.get(firstPaneId);
      assert.ok(firstPane);
      const stalePaneId = "pn_stale_outside_layout";
      surface.panes.set(stalePaneId, {
        ...structuredClone(firstPane),
        paneId: stalePaneId,
        paneLabel: 99,
        remotePaneId: 999,
      });

      const realized = await runtime.realizeTopology({
        allowDestroyPaneIds: [firstPaneId],
        desired: {
          children: [{ type: "pane" }, { type: "pane" }],
          direction: "vertical",
          type: "split",
        },
        expectedTopologyRevision: before.topologyRevision,
        fingerprint: server.surfaceId,
        target: { root: true },
      });

      assert.deepEqual(realized.destroyedPaneIds, [firstPaneId]);
      assert.equal(realized.panes.length, 2);
      assert.ok(!realized.panes.some((pane) => pane.paneId === stalePaneId));
      assert.equal(surface.panes.has(stalePaneId), false);
      const after = (await runtime.listScreens())[0]!;
      assert.deepEqual(after.panes.map((pane) => pane.paneId).sort(), realized.createdPaneIds.sort());
    });
  });

  await t.test("provider pane-list sync ignores client stale panes outside provider-owned topology", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const firstPaneId = paneByLabel(before, 1).paneId;
      const realized = await runtime.realizeTopology({
        allowDestroyPaneIds: [firstPaneId],
        desired: {
          children: [{ type: "pane" }, { type: "pane" }],
          direction: "vertical",
          type: "split",
        },
        expectedTopologyRevision: before.topologyRevision,
        fingerprint: server.surfaceId,
        target: { root: true },
      });
      const firstServerPane = server.panes.values().next().value as TestPane;
      server.panes.set(999, {
        ...structuredClone(firstServerPane),
        paneLabel: 999,
      });

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await internalRuntime.syncRemotePaneList(surface);

      const after = (await runtime.listScreens())[0]!;
      assert.deepEqual(after.panes.map((pane) => pane.paneId).sort(), realized.createdPaneIds.sort());
      assert.deepEqual(after.panes.map((pane) => pane.paneLabel), realized.panes.map((pane) => pane.paneLabel));
    });
  });

  await t.test("provider reconciles client-listed orphan panes into topology authority before close", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const firstPane = before.panes[0]!;
      const firstServerPane = server.panes.get(server.initialRemotePaneId);
      assert.ok(firstServerPane);
      server.panes.set(77, {
        ...structuredClone(firstServerPane),
        contentId: null,
        contentType: null,
        frame: { height: 384, width: 1024, x: 0, y: 384 },
        paneLabel: 5,
        paneLineageId: `${firstServerPane.paneLineageId}-orphan`,
        revision: 0,
        viewport: { height: 384, scale: 2, width: 1024 },
      });
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await internalRuntime.syncRemotePaneList(surface);

      const withOrphan = (await runtime.listScreens())[0]!;
      assert.deepEqual(withOrphan.topology, { paneId: firstPane.paneId, type: "pane" });
      const orphanPane = paneByLabel(withOrphan, 5);

      const close = await runtime.closePane({
        fingerprint: server.surfaceId,
        paneId: orphanPane.paneId,
      });

      assert.deepEqual(close, { displayId: "5", ok: true, paneAddress: "5", paneId: orphanPane.paneId, paneLabel: 5 });
      assert.deepEqual(server.topologyApplyRequests.at(-1), {
        layout: { paneId: server.initialRemotePaneId, type: "pane" },
        paneIds: [server.initialRemotePaneId],
        paneLabels: [1],
        topologyRevision: 1,
        windowLabel: "a",
      });
      const after = (await runtime.listScreens())[0]!;
      assert.deepEqual(after.panes.map((pane) => pane.paneId), [firstPane.paneId]);
      assert.deepEqual(after.topology, { paneId: firstPane.paneId, type: "pane" });
    });
  });

  await t.test("provider rejects duplicate client pane labels before close mutates topology", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const firstServerPane = server.panes.get(server.initialRemotePaneId);
      assert.ok(firstServerPane);
      server.panes.set(77, {
        ...structuredClone(firstServerPane),
        contentId: null,
        contentType: null,
        frame: { height: 384, width: 1024, x: 0, y: 384 },
        paneLabel: 1,
        paneLineageId: `${firstServerPane.paneLineageId}-duplicate`,
        revision: 0,
        viewport: { height: 384, scale: 2, width: 1024 },
      });

      await assert.rejects(
        runtime.closePane({
          fingerprint: server.surfaceId,
          paneId: before.panes[0]!.paneId,
        }),
        /duplicate pane labels/,
      );
      assert.equal(server.topologyApplyRequests.length, 0);
    });
  });

  await t.test("authority reconciliation prunes zero-revision local panes absent from provider list", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const firstPane = before.panes[0]!;
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const sourcePane = surface.panes.get(firstPane.paneId);
      assert.ok(sourcePane);
      const stalePane = structuredClone(sourcePane);
      stalePane.paneId = internalRuntime.allocatePaneId();
      stalePane.remotePaneId = 9999;
      stalePane.paneLabel = 5;
      stalePane.paneLineageId = "pl_zero_revision_stale_local";
      surface.panes.set(stalePane.paneId, stalePane);

      await assert.rejects(
        runtime.closePane({
          fingerprint: server.surfaceId,
          paneId: stalePane.paneId,
        }),
        /Unknown Surf Ace pane/,
      );
      assert.equal(surface.panes.has(stalePane.paneId), false);
      assert.equal(server.topologyApplyRequests.length, 0);
    });
  });

  await t.test("target push reconciles provider-listed panes before applying browser URL", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstServerPane = server.panes.get(server.initialRemotePaneId);
        assert.ok(firstServerPane);
        server.panes.set(77, {
          ...structuredClone(firstServerPane),
          contentId: null,
          contentType: null,
          frame: { height: 384, width: 1024, x: 0, y: 384 },
          paneLabel: 5,
          paneLineageId: `${firstServerPane.paneLineageId}-target`,
          revision: 0,
          viewport: { height: 384, scale: 2, width: 1024 },
        });
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        await internalRuntime.syncRemotePaneList(surface);
        const targetPane = [...surface.panes.values()].find((pane: any) => pane.paneLabel === 5);
        assert.ok(targetPane);

        const pushed = await runtime.push({
          content: "https://example.com/authority",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: targetPane.paneId,
        });

        assert.equal(pushed.targetKind, "browser_url");
        assert.equal(server.targetApplyRequests.at(-1)?.paneLineageId, `${firstServerPane.paneLineageId}-target`);
        const after = (await runtime.listScreens())[0]!;
        assert.deepEqual(after.panes.map((pane) => pane.paneLabel), [1, 5]);
      },
    });
  });

  await t.test("capture reconciles provider-listed panes before snapshot request", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstServerPane = server.panes.get(server.initialRemotePaneId);
      assert.ok(firstServerPane);
      server.panes.set(77, {
        ...structuredClone(firstServerPane),
        contentId: null,
        contentType: null,
        frame: { height: 384, width: 1024, x: 0, y: 384 },
        paneLabel: 5,
        paneLineageId: `${firstServerPane.paneLineageId}-capture`,
        revision: 0,
        viewport: { height: 384, scale: 2, width: 1024 },
      });
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await internalRuntime.syncRemotePaneList(surface);
      const capturePane = [...surface.panes.values()].find((pane: any) => pane.paneLabel === 5);
      assert.ok(capturePane);

      const captured = await runtime.capturePane({
        fingerprint: server.surfaceId,
        paneId: capturePane.paneId,
      });

      assert.equal(captured.capture.paneLabel, 5);
      assert.equal(server.snapshotRequests.at(-1)?.paneId, 77);
    });
  });

  await t.test("read and snapshot repair global pane display tokens without provider reconciliation", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const before = (await runtime.listScreens())[0]!;
      const firstPane = before.panes[0]!;
      const panesListRequests = server.panesListRequests;
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const sourcePane = surface.panes.get(firstPane.paneId);
      assert.ok(sourcePane);
      const stalePane = structuredClone(sourcePane);
      stalePane.paneId = internalRuntime.allocatePaneId();
      stalePane.remotePaneId = 9999;
      stalePane.paneLabel = 9999;
      stalePane.paneLineageId = "pl_zero_revision_stale_local_read";
      surface.panes.set(stalePane.paneId, stalePane);

      const read = await runtime.read({
        fingerprint: server.surfaceId,
        paneId: stalePane.paneId,
      });
      assert.equal(read.paneId, stalePane.paneId);
      assert.equal(read.paneLabel, 2);
      assert.equal(stalePane.paneLabel, 2);
      assert.equal(surface.panes.has(stalePane.paneId), true);

      const secondStalePane = structuredClone(sourcePane);
      secondStalePane.paneId = internalRuntime.allocatePaneId();
      secondStalePane.remotePaneId = 9998;
      secondStalePane.paneLabel = 9998;
      secondStalePane.paneLineageId = "pl_zero_revision_stale_local_snapshot";
      surface.panes.set(secondStalePane.paneId, secondStalePane);
      const snapshot = await runtime.snapshot({
        fingerprint: server.surfaceId,
        paneId: secondStalePane.paneId,
      });
      assert.equal(snapshot.paneId, secondStalePane.paneId);
      const after = (await runtime.listScreens())[0]!;
      const projectedSnapshotPane = after.panes.find((pane) => pane.paneId === secondStalePane.paneId);
      assert.equal(snapshot.paneLabel, projectedSnapshotPane?.paneLabel);
      assert.notEqual(snapshot.paneLabel, 9998);
      assert.equal(secondStalePane.paneLabel, projectedSnapshotPane?.paneLabel);
      assert.equal(surface.panes.has(secondStalePane.paneId), true);
      assert.equal(server.panesListRequests, panesListRequests);
    });
  });

  await t.test("authority mutations fail closed when provider pane list is unavailable", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      server.panesListErrorCode = "internal_error";

      await assert.rejects(
        runtime.push({
          content: "# blocked",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        }),
        /pane authority unavailable/,
      );
      assert.equal(server.contentSetRequests.length, 0);

      await assert.rejects(
        runtime.realizeTopology({
          allowDestroyPaneIds: [],
          desired: {
            children: [{ paneId: firstPaneId, type: "pane" }, { type: "pane" }],
            direction: "vertical",
            type: "split",
          },
          expectedTopologyRevision: 0,
          fingerprint: server.surfaceId,
          target: { root: true },
        }),
        /pane authority unavailable/,
      );
      assert.equal(server.topologyApplyRequests.length, 0);
    });
  });

  await t.test("surf_ace_list repairs global pane display tokens and publishes accepted topology", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const topologyApplyCount = server.topologyApplyRequests.length;
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const panes = internalRuntime.visiblePanes(surface);
      assert.equal(panes.length, 2);
      panes[1].paneLabel = Number(panes[1].remotePaneId);

      const after = (await runtime.listScreens())[0]!;
      assert.deepEqual(after.panes.map((pane) => pane.paneLabel), [1, 2]);
      assert.equal(panes[1].paneLabel, 2);
      await waitFor(() => server.topologyApplyRequests.length > topologyApplyCount);
    });
  });

  await t.test("screen summaries use client-resolved pane geometry after topology reconciliation", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const panes = [...server.panes.values()];
      assert.equal(panes.length, 2);
      panes[0]!.frame = { height: 700, width: 333, x: 0, y: 0 };
      panes[0]!.viewport = { height: 700, scale: 2, width: 333 };
      panes[1]!.frame = { height: 700, width: 691, x: 333, y: 0 };
      panes[1]!.viewport = { height: 700, scale: 2, width: 691 };
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await internalRuntime.syncRemotePaneList(surface);

      const after = (await runtime.listScreens())[0]!;
      assert.deepEqual(
        after.panes.map((pane) => pane.viewport),
        [
          { height: 700, scale: 2, width: 333 },
          { height: 700, scale: 2, width: 691 },
        ],
      );
    });
  });

  await t.test("provider rejects stale or undeclared destructive topology realization before publish", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await assert.rejects(
        runtime.realizeTopology({
          allowDestroyPaneIds: [],
          desired: { paneId: firstPaneId, type: "pane" },
          expectedTopologyRevision: 99,
          fingerprint: server.surfaceId,
          target: { root: true },
        }),
        /expected revision 99, current revision is 0/,
      );

      await assert.rejects(
        runtime.realizeTopology({
          allowDestroyPaneIds: [],
          desired: { type: "pane" },
          expectedTopologyRevision: 0,
          fingerprint: server.surfaceId,
          target: { root: true },
        }),
        /would destroy pane/,
      );
      assert.equal(server.topologyApplyRequests.length, 0);
    });
  });

  await t.test("provider defaults omitted split direction from target pane geometry", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2]);
      assert.deepEqual(server.topologyApplyRequests.at(-1), {
        layout: {
          children: [
            { paneId: server.initialRemotePaneId, type: "pane" },
            { paneId: 42, type: "pane" },
          ],
          direction: "vertical",
          type: "split",
        },
        paneIds: [server.initialRemotePaneId, 42],
        paneLabels: [1, 2],
        topologyRevision: server.topologyApplyRequests.at(-1)?.topologyRevision,
        windowLabel: "a",
      });

      const splitScreens = await runtime.listScreens();
      assert.deepEqual(
        splitScreens[0]?.panes.map((pane) => pane.viewport),
        [
          { height: 768, scale: 2, width: 512 },
          { height: 768, scale: 2, width: 512 },
        ],
      );
    });
  });

  await t.test("pair reconnect restores provider-owned topology and content after blank pair observation", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const splitPaneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);

      const firstPush = await runtime.push(
        {
          content: "<p>one</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: splitPaneIds[0]!,
        },
        { sessionKey: "agent:test:topology-a" },
      );
      const secondPush = await runtime.push(
        {
          content: "<p>two</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: splitPaneIds[1]!,
        },
        { sessionKey: "agent:test:topology-b" },
      );

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      server.panes.clear();
      server.panes.set(server.initialRemotePaneId, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: 1,
        revision: 0,
        viewport: { height: 768, scale: 2, width: 1024 },
      });
      server.setTopologyLayout({ paneId: server.initialRemotePaneId, type: "pane" }, 9);

      const initialTopologyApplyCount = server.topologyApplyRequests.length;
      const initialContentApplyCount = server.contentSetRequests.length;
      await surface.client.close(1000, "test_authoritative_topology_reconnect");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(
        server.topologyApplyRequests
          .slice(initialTopologyApplyCount)
          .some((request) => request.paneIds.length > 1),
        true,
      );
      assert.equal(
        server.contentSetRequests.length > initialContentApplyCount,
        true,
        JSON.stringify(server.contentSetRequests.map((request) => ({
          contentId: request.contentId,
          contentType: request.contentType,
          revision: request.revision,
        }))),
      );

      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 2, 3]);
      assert.equal(screens[0]?.panes.find((pane) => pane.paneLabel === 1)?.activeContent?.contentId, firstPush.contentId);
      assert.equal(screens[0]?.panes.find((pane) => pane.paneLabel === 2)?.activeContent?.contentId, secondPush.contentId);
    });
  });

  await t.test("pair reconnect restores durable target and drops stale restart content after blank pair observation", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        await runtime.push({
          content: "https://example.com/stale-before-pair",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        assert.ok(surface.client);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        const target = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
        assert.ok(target);
        internalRuntime.captureSurfaceTargetState(surface);
        internalRuntime.restartContentBySurface.set(server.surfaceId, [
          {
            contentId: "ct_stale_restart_pair_import",
            contentType: "html",
            contentValue: { html: "<p>stale restart</p>" },
            display: null,
            historyOwnerToken: "hot_stale_restart_pair_import",
            paneLabel: pane.paneLabel,
            remotePaneId: Number(pane.remotePaneId),
            revision: 1,
            sessionKey: "agent:test:stale-restart-pair-import",
          },
        ]);

        server.panes.clear();
        server.panes.set(server.initialRemotePaneId, {
          contentId: null,
          contentType: null,
          drawings: [],
          frame: { height: 768, width: 1024, x: 0, y: 0 },
          name: null,
          paneLabel: 1,
          paneLineageId: pane.paneLineageId,
          revision: 0,
          viewport: { height: 768, scale: 2, width: 1024 },
        });
        server.setTopologyLayout({ paneId: server.initialRemotePaneId, type: "pane" }, 10);

        const initialTargetApplyCount = server.targetApplyRequests.length;
        const initialContentApplyCount = server.contentSetRequests.length;
        await surface.client.close(1000, "test_no_stale_target_restart_replay_after_pair_import");

        await waitFor(() => server.pairRequests.length >= 2, 12_000);
        await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

        assert.equal(server.targetApplyRequests.length > initialTargetApplyCount, true);
        assert.equal(server.contentSetRequests.length, initialContentApplyCount);
        assert.equal(internalRuntime.restartContentBySurface.has(server.surfaceId), false);
        const importedPane = [...surface.panes.values()].find((candidate: any) => Number(candidate.remotePaneId) === server.initialRemotePaneId);
        assert.ok(importedPane);
        assert.equal(importedPane.currentTargetId, target.targetId);
        assert.equal(surface.targetRecords.get(target.targetId)?.currentState, "current");
      },
    });
  });

  await t.test("pair reconnect preserves provider-owned topology while dropping stale restart content", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const splitPaneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      const firstPane = surface.panes.get(splitPaneIds[0]!);
      const prunedPane = surface.panes.get(splitPaneIds[1]!);
      assert.ok(firstPane);
      assert.ok(prunedPane);
      internalRuntime.restartContentBySurface.set(server.surfaceId, [
        {
          contentId: "ct_stale_restart_pruned_pair_import",
          contentType: "html",
          contentValue: { html: "<p>stale pruned restart</p>" },
          display: null,
          historyOwnerToken: "hot_stale_restart_pruned_pair_import",
          paneLabel: prunedPane.paneLabel,
          remotePaneId: Number(prunedPane.remotePaneId),
          revision: 1,
          sessionKey: "agent:test:stale-pruned-restart-pair-import",
        },
      ]);

      server.panes.clear();
      server.panes.set(server.initialRemotePaneId, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: 1,
        paneLineageId: firstPane.paneLineageId,
        revision: 0,
        viewport: { height: 768, scale: 2, width: 1024 },
      });
      server.setTopologyLayout({ paneId: server.initialRemotePaneId, type: "pane" }, 12);

      const initialContentApplyCount = server.contentSetRequests.length;
      const initialTopologyApplyCount = server.topologyApplyRequests.length;
      await surface.client.close(1000, "test_no_pruned_restart_replay_after_pair_import");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(
        server.contentSetRequests.length,
        initialContentApplyCount,
        JSON.stringify(server.contentSetRequests.map((request) => ({
          contentId: request.contentId,
          contentType: request.contentType,
          revision: request.revision,
        }))),
      );
      assert.equal(internalRuntime.restartContentBySurface.has(server.surfaceId), false);
      assert.equal(
        server.topologyApplyRequests
          .slice(initialTopologyApplyCount)
          .some((request) => request.paneIds.length === 2),
        true,
      );
      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 2]);
      assert.equal(screens[0]?.panes[0]?.activeContent, null);
      assert.equal(screens[0]?.panes[1]?.activeContent, null);
    });
  });

  await t.test("fresh empty pair import preserves persisted provider target authority before replay", async () => {
    const port = nextPort++;
    const surfaceId = "sf_fresh_pair_stale_target";
    const providerId = "pv_fresh_pair_stale_target";
    const remotePaneId = 41;
    const paneLineageId = `pl_${surfaceId}_${remotePaneId}`;
    const targetId = "tg_fresh_pair_stale_target";
    const server = new FakeSurfAceWsServer(port, { surfaceId });
    server.targetCapabilities = [
      ...server.targetCapabilities,
      "target.browser_url.v1",
    ];
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-fresh-pair-stale-target-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            selfOwnedSurfaceIds: {
              [surfaceId]: {
                observedAt: Date.now(),
                providerId,
                source: "current_local_ownership",
              },
            },
            targetStateBySurfaceId: {
              [surfaceId]: {
                ownershipEpoch: 1,
                paneTargets: {
                  [paneLineageId]: {
                    currentTargetId: targetId,
                    diagnosticContent: null,
                    lastRestoreBlockedReason: null,
                    nonDurableTargetDiagnostic: null,
                    paneLineageId,
                    targetEpoch: 1,
                  },
                },
                registeredTargetIdsByIdempotencyKey: {},
                targetRecords: [
                  {
                    appliedAt: new Date(Date.now() - 120_000).toISOString(),
                    currentState: "current",
                    ownerProviderId: providerId,
                    ownershipEpoch: 1,
                    ownershipSessionId: "sa_stale_fresh_pair",
                    paneIdAtApply: "pn_stale_fresh_pair",
                    paneLabelAtApply: 1,
                    paneLineageId,
                    restorePolicy: "auto",
                    surfaceId,
                    surfaceInstanceId: null,
                    targetEpoch: 1,
                    targetHeader: {
                      payloadSchemaVersion: 1,
                      replaySemantics: "navigate",
                      requiredCapabilities: ["target.browser_url.v1"],
                      safeToLogFields: ["url"],
                      safetyClass: "network",
                      summary: "https://example.com/stale-fresh-pair",
                    },
                    targetId,
                    targetKind: "browser_url",
                    targetPayload: { url: "https://example.com/stale-fresh-pair" },
                  },
                ],
              },
            },
            version: 1,
            windowLabels: {
              [surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );

      await runtime.start();
      const internalRuntime = runtime as any;
      await waitFor(() => {
        const surface = internalRuntime.surfaces.get(surfaceId);
        return surface?.connectionState === "connected";
      }, 12_000);

      assert.equal(server.targetApplyRequests.length > 0, true);
      assert.equal(server.contentSetRequests.length, 0);
      const surface = internalRuntime.surfaces.get(surfaceId);
      assert.ok(surface);
      const pane = internalRuntime.findPaneByRemoteId(surface, remotePaneId);
      assert.ok(pane);
      assert.equal(pane.currentTargetId, targetId);
      assert.equal(surface.targetRecords.get(targetId)?.currentState, "current");
      const screen = (await runtime.listScreens())[0];
      assert.equal(screen?.panes[0]?.target?.targetId, targetId);
      assert.equal(screen?.panes[0]?.target?.blockedReason, null);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("provider restart restores durable multi-pane topology targets and content after collapsed content pair", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ discovery, infos, runtime, server, stateDir }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const split = await runtime.split({
          count: 2,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const paneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);
        const htmlPush = await runtime.push(
          {
            content: "<main>restored html</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: paneIds[0]!,
          },
          { sessionKey: "agent:test:restart-html" },
        );
        const browserPush = await runtime.push({
          content: "https://example.com/restart-target",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: paneIds[1]!,
        });
        assert.equal(browserPush.blockedReason, null);

        const initialContentApplyCount = server.contentSetRequests.length;
        const initialTargetApplyCount = server.targetApplyRequests.length;
        const initialTopologyApplyCount = server.topologyApplyRequests.length;
        const internalRuntime = runtime as any;
        const liveSurface = internalRuntime.surfaces.get(server.surfaceId);
        const htmlTargetId = liveSurface?.panes.get(paneIds[0]!)?.currentTargetId;
        assert.equal(typeof htmlTargetId, "string");
        await internalRuntime.persistScreenSnapshot();
        const persistedAfterOfficialSetup = JSON.parse(
          await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8"),
        ) as {
          contentContinuity?: Record<string, Array<{
            contentId?: string;
            contentValue?: unknown;
            paneLabel?: number;
            targetId?: string | null;
          }>>;
          screens?: Array<{ fingerprint?: string; panes?: Array<{ paneLabel?: number }> }>;
        };
        assert.equal(
          persistedAfterOfficialSetup.screens?.some((screen) =>
            screen.fingerprint === server.surfaceId &&
            screen.panes?.map((pane) => pane.paneLabel).join(",") === "1,2"
          ),
          true,
        );
        assert.equal(
          persistedAfterOfficialSetup.contentContinuity?.[server.surfaceId]?.some((entry) =>
            entry.contentId === htmlPush.contentId &&
            entry.paneLabel === 1 &&
            entry.contentValue === "<main>restored html</main>" &&
            entry.targetId === htmlTargetId
          ),
          true,
        );
        const preBounceSurface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(preBounceSurface);
        const preBounceHtmlPane = preBounceSurface.panes.get(paneIds[0]!);
        assert.ok(preBounceHtmlPane);
        preBounceHtmlPane.buffer.liveFrame = {
          contentId: htmlPush.contentId,
          contextKey: htmlPush.contentId,
          frameId: "fr_restart_paint",
          image: "cmVzdGFydC1wYWludA==",
          openedAt: 1_700_000_000_000,
          scrollOffset: { x: 0, y: 0 },
          strokes: [
            {
              bbox: { height: 20, width: 20, x: 10, y: 10 },
              endedAt: 1_700_000_000_010,
              points: [
                { pressure: 0.5, x: 10, y: 10 },
                { pressure: 0.6, x: 30, y: 30 },
              ],
              startedAt: 1_700_000_000_000,
              strokeId: "stroke_restart_paint",
            },
          ],
          updatedAt: 1_700_000_000_010,
          viewport: { height: 768, scale: 2, width: 512 },
        };
        preBounceHtmlPane.buffer.liveDirtyStrokeIds = ["stroke_restart_paint"];
        await internalRuntime.persistScreenSnapshot();
        const preBounceSnapshot = await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8");
        const trustedRestartSnapshot = internalRuntime.buildScreenSummary(preBounceSurface);
        const bootstrapPane = structuredClone(preBounceHtmlPane);
        preBounceSurface.panes = new Map([[bootstrapPane.paneId, bootstrapPane]]);
        preBounceSurface.layout = { paneId: bootstrapPane.paneId, type: "pane" };
        internalRuntime.restoreRestartTopology(preBounceSurface, trustedRestartSnapshot);
        assert.deepEqual(
          [...preBounceSurface.panes.values()].map((pane: any) => pane.paneLabel).sort((left: number, right: number) => left - right),
          [1, 2],
        );
        assert.ok(
          infos.some((info) =>
            info.includes("event=restart_topology_restore_applied") &&
            info.includes("bootstrap_pane_count=1") &&
            info.includes("restored_pane_count=2") &&
            info.includes("target_lineage_match_count=")),
        );
        await runtime.stop();
        await fs.writeFile(path.join(stateDir, "surf-ace-runtime-screens.json"), preBounceSnapshot);

        server.resetToSinglePane(server.initialRemotePaneId);
        const collapsedPane = server.panes.get(server.initialRemotePaneId);
        assert.ok(collapsedPane);
        collapsedPane.paneLabel = 2;
        collapsedPane.contentId = htmlPush.contentId;
        collapsedPane.contentType = "html";
        collapsedPane.revision = 1;
        server.setTopologyLayout({ paneId: server.initialRemotePaneId, type: "pane" }, 161);
        const restartInfos: string[] = [];
        const restartedRuntime = createSurfAceRuntime({
          discovery,
          logger: {
            info: (message: string) => restartInfos.push(message),
            warn: () => {},
          },
          stateDir,
        });
        try {
          await restartedRuntime.start();
          const restartedInternal = restartedRuntime as any;
          await waitFor(() => {
            const surface = restartedInternal.surfaces.get(server.surfaceId);
            return surface?.connectionState === "connected";
          }, 12_000);

          await waitFor(() =>
            server.topologyApplyRequests
              .slice(initialTopologyApplyCount)
              .some((request) => request.paneIds.length === 2),
          );
          await waitFor(() => server.contentSetRequests.length > initialContentApplyCount);
          await waitFor(() => server.targetApplyRequests.length > initialTargetApplyCount);

          const screens = await restartedRuntime.listScreens();
          const screen = screens.find((candidate) => candidate.fingerprint === server.surfaceId);
          assert.ok(screen);
          assertPaneLabelsWithOpaqueIds(screen.panes, [1, 2]);
          const htmlPane = screen.panes.find((pane) => pane.paneLabel === 1);
          const browserPane = screen.panes.find((pane) => pane.paneLabel === 2);
          assert.equal(htmlPane?.activeContent?.contentId, htmlPush.contentId);
          assert.equal(htmlPane?.target?.targetId, htmlTargetId);
          assert.equal(htmlPane?.target?.targetKind, "html");
          assert.equal(browserPane?.target?.targetKind, "browser_url");
          assert.equal(browserPane?.target?.targetId, browserPush.targetId);
          assert.equal(browserPane?.target?.blockedReason, null);
          const restoredHtmlApply = server.contentSetRequests
            .slice(initialContentApplyCount)
            .find((request) => request.contentId === htmlPush.contentId);
          assert.deepEqual(
            (restoredHtmlApply?.restoredDrawings as Array<{ strokeId: string }> | undefined)?.map((stroke) => stroke.strokeId),
            ["stroke_restart_paint"],
          );
          assert.equal(
            server.targetApplyRequests
              .slice(initialTargetApplyCount)
              .some((request) =>
                request.targetId === browserPush.targetId &&
                request.targetKind === "browser_url" &&
                request.restoreReason === "resume_restore"
              ),
            true,
          );
          const restoredRead = await restartedRuntime.read({ fingerprint: server.surfaceId, paneId: htmlPane!.paneId });
          assert.deepEqual(restoredRead.liveFrame?.strokes.map((stroke) => stroke.strokeId), ["stroke_restart_paint"]);
          assert.deepEqual(restoredRead.liveDirtyStrokeIds, ["stroke_restart_paint"]);

          const targetState = restartedInternal.persistentState.targetStateBySurfaceId[server.surfaceId];
          assert.ok(targetState);
          assert.equal(
            targetState.targetRecords.some(
              (record: any) => record.targetId === browserPush.targetId && record.currentState === "current",
            ),
            true,
          );
          assert.ok(
            restartInfos.some((info) =>
              info.includes("event=restart_restore_begin") &&
              info.includes("snapshot_pane_count=2") &&
              info.includes("content_continuity_count=1")),
          );
          assert.ok(
            restartInfos.some((info) =>
              info.includes("event=restart_topology_restore_applied") &&
              info.includes("restored_pane_count=2") &&
              info.includes("target_lineage_match_count=")),
          );
          assert.ok(
            restartInfos.some((info) =>
              info.includes("event=target_lifecycle_hydrate_result") &&
              info.includes("target_record_count=") &&
              info.includes("current_target_count=") &&
              info.includes("stale_target_count=")),
          );
          assert.ok(
            restartInfos.some((info) =>
              info.includes("event=pair_response_ok") &&
              info.includes("pane_content_count=1") &&
              info.includes("pane_ids=") &&
              info.includes("pane_labels=") &&
              info.includes("topology_revision=161") &&
              info.includes("pair_state=")),
          );
          assert.ok(
            restartInfos.some((info) =>
              info.includes("event=panes_list_summary") &&
              info.includes("raw_pane_count=") &&
              info.includes("adopted_pane_count=") &&
              info.includes("raw_panes=") &&
              info.includes("adopted_panes=") &&
              info.includes("topology_revision=") &&
              info.includes("layout=")),
          );
          assert.ok(
            restartInfos.some((info) =>
              info.includes("event=restart_content_restore_result") &&
              info.includes("applied_count=1")),
          );
        } finally {
          await restartedRuntime.stop();
        }
      },
    });
  });

  await t.test("provider restart preserves topology-only restored panes after non-empty collapsed pair", async () => {
    await withRuntimeHarness({
      run: async ({ discovery, runtime, server, stateDir }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const split = await runtime.split({
          count: 2,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const paneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);
        const htmlPush = await runtime.push(
          {
            content: "<main>provider collapse remains authoritative without omitted continuity</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: paneIds[0]!,
          },
          { sessionKey: "agent:test:restart-collapse-negative" },
        );
        await (runtime as any).persistScreenSnapshot();
        const persistedSnapshot = JSON.parse(
          await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8"),
        ) as {
          screens: Array<{
            fingerprint: string;
            panes: Array<unknown>;
            _debug?: {
              hasPairedInGatewaySession?: boolean;
              localOwnership?: { providerId?: string; sessionId?: string; source?: string; surfaceId?: string } | null;
              sessionId?: string | null;
            };
          }>;
        };
        const persistedScreen = persistedSnapshot.screens.find((screen) => screen.fingerprint === server.surfaceId);
        assert.ok(persistedScreen, "expected provider-owned screen snapshot before restart");
        assert.equal(persistedScreen.panes.length, 2);
        assert.equal(persistedScreen._debug?.hasPairedInGatewaySession, true);
        assert.equal(persistedScreen._debug?.localOwnership?.source, "pair.response");
        assert.equal(persistedScreen._debug?.localOwnership?.surfaceId, server.surfaceId);
        assert.equal(persistedScreen._debug?.localOwnership?.sessionId, persistedScreen._debug?.sessionId);

        await runtime.stop();
        const persistedSnapshotAfterStop = JSON.parse(
          await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8"),
        ) as typeof persistedSnapshot;
        const persistedScreenAfterStop = persistedSnapshotAfterStop.screens.find((screen) =>
          screen.fingerprint === server.surfaceId
        );
        assert.ok(persistedScreenAfterStop, "expected provider-owned screen snapshot after stop");
        assert.equal(persistedScreenAfterStop.panes.length, 2);
        assert.equal(persistedScreenAfterStop._debug?.hasPairedInGatewaySession, true);
        assert.equal(persistedScreenAfterStop._debug?.localOwnership?.source, "pair.response");
        assert.equal(persistedScreenAfterStop._debug?.localOwnership?.surfaceId, server.surfaceId);
        assert.equal(
          persistedScreenAfterStop._debug?.localOwnership?.sessionId,
          persistedScreenAfterStop._debug?.sessionId,
        );
        const persistedIdentityAfterStop = JSON.parse(
          await fs.readFile(path.join(stateDir, "surf-ace-provider-identity.json"), "utf8"),
        ) as { providerId: string };
        const persistedStateAfterStop = JSON.parse(
          await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
        ) as { providerId: string };
        assert.equal(persistedScreenAfterStop._debug?.localOwnership?.providerId, persistedIdentityAfterStop.providerId);
        assert.equal(persistedStateAfterStop.providerId, persistedIdentityAfterStop.providerId);

        server.resetToSinglePane(server.initialRemotePaneId);
        const collapsedPane = server.panes.get(server.initialRemotePaneId);
        assert.ok(collapsedPane);
        collapsedPane.paneLabel = 1;
        collapsedPane.contentId = htmlPush.contentId;
        collapsedPane.contentType = "html";
        collapsedPane.revision = 1;
        server.setTopologyLayout({ paneId: server.initialRemotePaneId, type: "pane" }, 162);

        const restartInfos: string[] = [];
        const restartedRuntime = createSurfAceRuntime({
          discovery,
          logger: {
            info: (message: string) => restartInfos.push(message),
            warn: () => {},
          },
          stateDir,
        });
        try {
          await restartedRuntime.start();
          try {
            await waitFor(async () => {
              const screens = await restartedRuntime.listScreens();
              const screen = screens.find((candidate) => candidate.fingerprint === server.surfaceId);
              return screen?.panes.length === 2 &&
                screen.panes.map((pane) => pane.paneLabel).sort((left, right) => left - right).join(",") === "1,2";
            });
          } catch (error) {
            assert.fail(`${String(error)}\n${restartInfos.join("\n")}`);
          }
          assert.ok(
            restartInfos.some((info) =>
              info.includes("event=persisted_snapshot_read") &&
              info.includes("screen_count=1") &&
              info.includes("trusted_count=1")),
            restartInfos.join("\n"),
          );
          assert.ok(
            restartInfos.some((info) =>
              info.includes("event=restart_topology_restore_applied") &&
              info.includes("restored_pane_count=2")),
            restartInfos.join("\n"),
          );
          assert.ok(
            restartInfos.some((info) =>
              info.includes("event=pair_observation_preserved_provider_topology_authority") &&
              info.includes("observed_pane_count=1") &&
              info.includes("visible_pane_count=2")),
            restartInfos.join("\n"),
          );
          const screens = await restartedRuntime.listScreens();
          const screen = screens.find((candidate) => candidate.fingerprint === server.surfaceId);
          assert.ok(screen);
          assert.equal(screen.panes.length, 2);
          assert.equal(
            screen.panes.some((pane) => pane.activeContent?.contentId === htmlPush.contentId),
            true,
          );
        } finally {
          await restartedRuntime.stop();
          await server.close();
          await fs.rm(stateDir, { force: true, recursive: true });
        }
      },
    });
  });

  await t.test("discovery endpoint absence preserves provider-owned topology targets and content for blank reconnect", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ discovery, infos, runtime, server, stateDir }) => {
        const initialEndpoints = discovery.getSnapshot();
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const split = await runtime.split({
          count: 2,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const paneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);
        const htmlPush = await runtime.push(
          {
            content: "<main>Cyberbrain Kanban</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: paneIds[0]!,
          },
          { sessionKey: "agent:test:cyberbrain-html" },
        );
        const browserPush = await runtime.push({
          content: "https://example.com/cyberbrain-kanban",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: paneIds[1]!,
        });
        assert.equal(browserPush.blockedReason, null);

        const initialContentApplyCount = server.contentSetRequests.length;
        const initialTargetApplyCount = server.targetApplyRequests.length;
        const initialTopologyApplyCount = server.topologyApplyRequests.length;
        const internalRuntime = runtime as any;
        await internalRuntime.persistScreenSnapshot();

        const pairedSocket = server.pairedSocket;
        assert.ok(pairedSocket);
        pairedSocket.terminate();
        await waitFor(() => server.activeSocketCount === 0);
        discovery.setEndpoints([]);
        await discovery.refreshNow();
        internalRuntime.removeClosedSurface(server.surfaceId, "discovery_endpoint_absent");
        assert.equal(internalRuntime.surfaces.has(server.surfaceId), false);
        assert.ok(internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId]);
        assert.equal(internalRuntime.persistentState.surfaceTombstones?.[server.surfaceId], undefined);

        let persistedScreens: {
          contentContinuity?: Record<string, Array<{ contentId?: string; contentValue?: unknown; paneLabel?: number }>>;
          screens?: Array<{ fingerprint?: string; panes?: Array<{ paneLabel?: number }> }>;
        } = {};
        await waitFor(async () => {
          persistedScreens = JSON.parse(
            await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8"),
          );
          return Boolean(
            persistedScreens.screens?.some((screen) =>
              screen.fingerprint === server.surfaceId &&
              screen.panes?.map((pane) => pane.paneLabel).join(",") === "1,2"
            ) &&
            persistedScreens.contentContinuity?.[server.surfaceId]?.some((entry) =>
              entry.contentId === htmlPush.contentId &&
              entry.paneLabel === 1 &&
              entry.contentValue === "<main>Cyberbrain Kanban</main>"
            ),
          );
        });
        assert.equal(
          infos.some((info) =>
            info.includes("event=surface_removed_target_state") &&
            info.includes("reason=discovery_endpoint_absent")
          ),
          false,
        );

        server.resetToSinglePane(server.initialRemotePaneId);
        discovery.setEndpoints(initialEndpoints);
        await discovery.refreshNow();
        await waitFor(() => {
          const surface = internalRuntime.surfaces.get(server.surfaceId);
          return surface?.connectionState === "connected";
        }, 12_000);
        await waitFor(() =>
          server.topologyApplyRequests
            .slice(initialTopologyApplyCount)
            .some((request) => request.paneIds.length === 2),
        );
        await waitFor(() => server.contentSetRequests.length > initialContentApplyCount);
        await waitFor(() => server.targetApplyRequests.length > initialTargetApplyCount);

        const screens = await runtime.listScreens();
        const screen = screens.find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        assertPaneLabelsWithOpaqueIds(screen.panes, [1, 2]);
        const htmlPane = screen.panes.find((pane) => pane.paneLabel === 1);
        const browserPane = screen.panes.find((pane) => pane.paneLabel === 2);
        assert.equal(htmlPane?.activeContent?.contentId, htmlPush.contentId);
        assert.equal(browserPane?.target?.targetId, browserPush.targetId);
        assert.equal(browserPane?.target?.targetKind, "browser_url");
        assert.equal(browserPane?.target?.blockedReason, null);
      },
    });
  });

  await t.test("empty surfaces.list preserves provider-owned topology targets and content", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ discovery, infos, runtime, server, stateDir }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const split = await runtime.split({
          count: 2,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const paneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);
        const htmlPush = await runtime.push(
          {
            content: "<main>Empty surfaces.list must not clear Surf Ace panes</main>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: paneIds[0]!,
          },
          { sessionKey: "agent:test:empty-surfaces-list-html" },
        );
        const browserPush = await runtime.push({
          content: "https://example.com/empty-surfaces-list",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: paneIds[1]!,
        });
        assert.equal(browserPush.blockedReason, null);

        const internalRuntime = runtime as any;
        await internalRuntime.persistScreenSnapshot();
        server.removeSurfaceWithoutEvent(server.surfaceId);
        await discovery.refreshNow();
        await waitFor(() => !internalRuntime.surfaces.has(server.surfaceId));
        assert.ok(internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId]);
        assert.equal(internalRuntime.persistentState.surfaceTombstones?.[server.surfaceId], undefined);

        let persistedScreens: {
          contentContinuity?: Record<string, Array<{ contentId?: string; contentValue?: unknown; paneLabel?: number }>>;
          screens?: Array<{ fingerprint?: string; panes?: Array<{ paneLabel?: number }> }>;
        } = {};
        await waitFor(async () => {
          persistedScreens = JSON.parse(
            await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8"),
          );
          return Boolean(
            persistedScreens.screens?.some((screen) =>
              screen.fingerprint === server.surfaceId &&
              screen.panes?.map((pane) => pane.paneLabel).join(",") === "1,2"
            ) &&
            persistedScreens.contentContinuity?.[server.surfaceId]?.some((entry) =>
              entry.contentId === htmlPush.contentId &&
              entry.paneLabel === 1 &&
              entry.contentValue === "<main>Empty surfaces.list must not clear Surf Ace panes</main>"
            ),
          );
        });
        assert.equal(
          infos.some((info) =>
            info.includes("event=surface_removed_target_state") &&
            info.includes("reason=surfaces_list_absent")
          ),
          false,
        );
      },
    });
  });

  await t.test("fresh pair import adopts lineage-only persisted target records", async () => {
    const port = nextPort++;
    const surfaceId = "sf_fresh_pair_lineage_only_target";
    const providerId = "pv_fresh_pair_lineage_only_target";
    const remotePaneId = 41;
    const paneLineageId = `pl_${surfaceId}_${remotePaneId}`;
    const targetId = "tg_fresh_pair_lineage_only_target";
    const server = new FakeSurfAceWsServer(port, { surfaceId });
    server.targetCapabilities = [
      ...server.targetCapabilities,
      "target.browser_url.v1",
    ];
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-fresh-pair-lineage-target-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            selfOwnedSurfaceIds: {
              [surfaceId]: {
                observedAt: Date.now(),
                providerId,
                source: "current_local_ownership",
              },
            },
            targetStateBySurfaceId: {
              [surfaceId]: {
                ownershipEpoch: 1,
                paneTargets: {},
                registeredTargetIdsByIdempotencyKey: {},
                targetRecords: [
                  {
                    appliedAt: new Date(Date.now() - 120_000).toISOString(),
                    currentState: "current",
                    ownerProviderId: providerId,
                    ownershipEpoch: 1,
                    ownershipSessionId: "sa_lineage_only_stale_pair",
                    paneIdAtApply: "pn_lineage_only_stale_pair",
                    paneLabelAtApply: 1,
                    paneLineageId,
                    restorePolicy: "auto",
                    surfaceId,
                    surfaceInstanceId: null,
                    targetEpoch: 1,
                    targetHeader: {
                      payloadSchemaVersion: 1,
                      replaySemantics: "navigate",
                      requiredCapabilities: ["target.browser_url.v1"],
                      safeToLogFields: ["url"],
                      safetyClass: "network",
                      summary: "https://example.com/lineage-only-stale-pair",
                    },
                    targetId,
                    targetKind: "browser_url",
                    targetPayload: { url: "https://example.com/lineage-only-stale-pair" },
                  },
                ],
              },
            },
            version: 1,
            windowLabels: {
              [surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );

      await runtime.start();
      const internalRuntime = runtime as any;
      await waitFor(() => {
        const surface = internalRuntime.surfaces.get(surfaceId);
        return surface?.connectionState === "connected";
      }, 12_000);

      assert.equal(server.targetApplyRequests.length, 0);
      assert.equal(server.contentSetRequests.length, 0);
      const surface = internalRuntime.surfaces.get(surfaceId);
      assert.ok(surface);
      const pane = internalRuntime.findPaneByRemoteId(surface, remotePaneId);
      assert.ok(pane);
      assert.equal(pane.currentTargetId, targetId);
      assert.equal(surface.targetRecords.get(targetId)?.currentState, "current");
      await waitFor(async () => {
        const persisted = JSON.parse(
          await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
        );
        return persisted.targetStateBySurfaceId?.[surfaceId]?.targetRecords?.some(
          (record: any) => record.targetId === targetId && record.currentState === "current",
        );
      }, 12_000);
      const persisted = JSON.parse(
        await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
      );
      const persistedTargetState = persisted.targetStateBySurfaceId?.[surfaceId];
      assert.ok(
        persistedTargetState?.targetRecords?.some(
          (record: any) => record.targetId === targetId && record.currentState === "current",
        ),
      );
      assert.ok(
        persistedTargetState?.paneTargets?.[paneLineageId]?.currentTargetId === targetId,
      );
      assert.ok(
        persistedTargetState?.lifecycleEvents?.some(
          (event: any) =>
            event.event === "persist" &&
            event.reason === "stale target hydrate",
        ),
      );
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("post-pair lineage repair does not resurrect explicitly stale target records", async () => {
    const port = nextPort++;
    const surfaceId = "sf_pair_lineage_repair_stale_target";
    const providerId = "pv_pair_lineage_repair_stale_target";
    const remotePaneId = 41;
    const originalLineageId = `pl_${surfaceId}_${remotePaneId}`;
    const repairedLineageId = `${originalLineageId}_provider_repair`;
    const targetId = "tg_pair_lineage_repair_stale_target";
    const server = new FakeSurfAceWsServer(port, { surfaceId });
    server.targetCapabilities = [
      ...server.targetCapabilities,
      "target.browser_url.v1",
    ];
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-pair-lineage-repair-stale-target-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            selfOwnedSurfaceIds: {
              [surfaceId]: {
                observedAt: Date.now(),
                providerId,
                source: "current_local_ownership",
              },
            },
            targetStateBySurfaceId: {
              [surfaceId]: {
                ownershipEpoch: 1,
                paneTargets: {},
                registeredTargetIdsByIdempotencyKey: {},
                targetRecords: [
                  {
                    appliedAt: new Date(Date.now() - 120_000).toISOString(),
                    currentState: "current",
                    ownerProviderId: providerId,
                    ownershipEpoch: 1,
                    ownershipSessionId: "sa_pair_lineage_repair",
                    paneIdAtApply: "pn_pair_lineage_repair",
                    paneLabelAtApply: 1,
                    paneLineageId: originalLineageId,
                    restorePolicy: "auto",
                    surfaceId,
                    surfaceInstanceId: null,
                    targetEpoch: 1,
                    targetHeader: {
                      payloadSchemaVersion: 1,
                      replaySemantics: "navigate",
                      requiredCapabilities: ["target.browser_url.v1"],
                      safeToLogFields: ["url"],
                      safetyClass: "network",
                      summary: "https://example.com/pair-lineage-repair-stale-target",
                    },
                    targetId,
                    targetKind: "browser_url",
                    targetPayload: { url: "https://example.com/pair-lineage-repair-stale-target" },
                  },
                ],
              },
            },
            version: 1,
            windowLabels: {
              [surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );

      await runtime.start();
      const internalRuntime = runtime as any;
      await waitFor(() => {
        const surface = internalRuntime.surfaces.get(surfaceId);
        return surface?.connectionState === "connected";
      }, 12_000);

      const surface = internalRuntime.surfaces.get(surfaceId);
      assert.ok(surface);
      const pane = internalRuntime.findPaneByRemoteId(surface, remotePaneId);
      assert.ok(pane);
      const targetBeforeRepair = surface.targetRecords.get(targetId);
      assert.ok(targetBeforeRepair);
      targetBeforeRepair.currentState = "stale";
      pane.currentTargetId = null;
      const previousLineageId = pane.paneLineageId;
      targetBeforeRepair.paneLineageId = previousLineageId;
      pane.staleTargetId = targetId;
      pane.lastRestoreBlockedReason = "restore_blocked_stale_target";

      internalRuntime.adoptPaneLineage(surface, pane, repairedLineageId);

      const target = surface.targetRecords.get(targetId);
      assert.equal(target?.paneLineageId, repairedLineageId);
      assert.equal(target?.currentState, "stale");
      assert.equal(pane.currentTargetId, null);
      assert.equal(pane.staleTargetId, targetId);
      assert.equal(pane.lastRestoreBlockedReason, "restore_blocked_stale_target");
      assert.equal(server.targetApplyRequests.length, 0);
      assert.equal(server.contentSetRequests.length, 0);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("matching provider pair content preserves current target through lineage repair", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        const targetId = "tg_matching_pair_content_current_target";
        const contentId = "ct_matching_pair_content_current_target";
        pane.activeContentId = contentId;
        pane.contentType = "html";
        pane.currentRevision = 7;
        pane.currentTargetId = targetId;
        surface.targetRecords.set(targetId, {
          appliedAt: new Date().toISOString(),
          currentState: "current",
          ownerProviderId: internalRuntime.persistentState.providerId,
          ownershipEpoch: surface.ownershipEpoch,
          ownershipSessionId: surface.sessionId,
          paneIdAtApply: pane.paneId,
          paneLabelAtApply: pane.paneLabel,
          paneLineageId: pane.paneLineageId,
          restorePolicy: "auto",
          surfaceId: surface.surfaceId,
          surfaceInstanceId: null,
          targetEpoch: pane.targetEpoch + 1,
          targetHeader: {
            payloadSchemaVersion: 1,
            replaySemantics: "navigate",
            requiredCapabilities: ["target.browser_url.v1"],
            safeToLogFields: ["url"],
            safetyClass: "network",
            summary: "https://example.com/current-target-pair-content",
          },
          targetId,
          targetKind: "browser_url",
          targetPayload: { url: "https://example.com/current-target-pair-content" },
        });

        internalRuntime.applyPairPaneContentState(surface, pane, {
          contentType: "html",
          currentContentId: contentId,
          currentRevision: 7,
          display: {
            provenance: {
              displayName: "Pair Import Session",
              sessionKey: "agent:test:pair-import",
            },
            title: "Imported Document Title",
          },
          paneId: server.initialRemotePaneId,
          paneLabel: pane.paneLabel,
          paneLineageId: pane.paneLineageId,
        });

        assert.equal(pane.display?.title, "Imported Document Title");
        assert.equal(pane.ownerSessionKey, "agent:test:pair-import");
        assert.equal(pane.currentTargetId, targetId);
        assert.equal(surface.targetRecords.get(targetId)?.currentState, "current");
        const repairedLineageId = `${pane.paneLineageId}_provider_repair`;
        internalRuntime.adoptPaneLineage(surface, pane, repairedLineageId);

        assert.equal(pane.currentTargetId, targetId);
        assert.equal(surface.targetRecords.get(targetId)?.currentState, "current");
        assert.equal(surface.targetRecords.get(targetId)?.paneLineageId, repairedLineageId);
      },
    });
  });

  await t.test("pair reconnect does not replay stale target or content over provider-owned content", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.targetCapabilities = [
          ...server.targetCapabilities,
          "target.browser_url.v1",
        ];
      },
      run: async ({ runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        await runtime.push({
          content: "https://example.com/stale-provider-content",
          contentType: "browser_url",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        assert.ok(surface.client);
        const pane = surface.panes.get(firstPaneId);
        assert.ok(pane);
        const target = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
        assert.ok(target);
        internalRuntime.captureSurfaceTargetState(surface);
        internalRuntime.restartContentBySurface.set(server.surfaceId, [
          {
            contentId: "ct_stale_restart_nonempty_pair_import",
            contentType: "html",
            contentValue: { html: "<p>stale restart</p>" },
            display: null,
            historyOwnerToken: "hot_stale_restart_nonempty_pair_import",
            paneLabel: pane.paneLabel,
            remotePaneId: Number(pane.remotePaneId),
            revision: 1,
            sessionKey: "agent:test:stale-nonempty-pair-import",
          },
        ]);

        server.panes.clear();
        server.panes.set(server.initialRemotePaneId, {
          contentId: "ct_a1b2c3d4",
          contentType: "html",
          drawings: [],
          frame: { height: 768, width: 1024, x: 0, y: 0 },
          name: null,
          paneLabel: 1,
          paneLineageId: pane.paneLineageId,
          revision: 17,
          viewport: { height: 768, scale: 2, width: 1024 },
        });
        server.setTopologyLayout({ paneId: server.initialRemotePaneId, type: "pane" }, 11);

        const initialTargetApplyCount = server.targetApplyRequests.length;
        const initialContentApplyCount = server.contentSetRequests.length;
        await surface.client.close(1000, "test_no_stale_replay_over_provider_content");

        await waitFor(() => server.pairRequests.length >= 2, 12_000);
        await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

        assert.equal(server.targetApplyRequests.length, initialTargetApplyCount);
        assert.equal(server.contentSetRequests.length, initialContentApplyCount);
        assert.equal(internalRuntime.restartContentBySurface.has(server.surfaceId), false);
        const importedPane = [...surface.panes.values()].find((candidate: any) => Number(candidate.remotePaneId) === server.initialRemotePaneId);
        assert.ok(importedPane);
        assert.equal(importedPane.currentTargetId, null);
        assert.equal(importedPane.activeContentId, "ct_a1b2c3d4");
        assert.equal(importedPane.contentValue, null);
        assert.equal(importedPane.currentRevision, 17);
        assert.equal(surface.targetRecords.get(target.targetId)?.currentState, "stale");
      },
    });
  });

  await t.test("provider-owned panes.list content reattaches stale durable target after client bounce", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "<main>T338 client bounce provider-owned html</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:t338-client-bounce-reattach" },
      );

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const pane = surface.panes.get(firstPaneId);
      assert.ok(pane);
      const target = surface.targetRecords.get(pane.currentTargetId);
      assert.ok(target);

      target.currentState = "stale";
      pane.currentTargetId = null;
      pane.staleTargetId = target.targetId;
      pane.lastRestoreBlockedReason = "restore_blocked_stale_target";
      pane.activeContentId = null;
      pane.contentType = null;
      pane.contentValue = null;
      pane.historySummary.visibleContentId = null;
      pane.pairImportedContentAuthority = false;
      server.panes.set(Number(pane.remotePaneId), {
        contentId: pushed.contentId,
        contentType: "html",
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: pane.paneLabel,
        paneLineageId: pane.paneLineageId,
        revision: Number(pane.currentRevision),
        viewport: { height: 768, scale: 2, width: 1024 },
      });

      const initialContentApplyCount = server.contentSetRequests.length;
      await internalRuntime.syncRemotePaneList(surface);

      assert.equal(server.contentSetRequests.length, initialContentApplyCount);
      assert.equal(pane.activeContentId, pushed.contentId);
      assert.equal(pane.contentType, "html");
      assert.equal(target.currentState, "current");
      assert.equal(target.ownerProviderId, internalRuntime.persistentState.providerId);
      assert.equal(target.ownershipSessionId, surface.sessionId);
      assert.equal(target.ownershipEpoch, surface.ownershipEpoch);
      assert.equal(pane.currentTargetId, target.targetId);
      assert.equal(pane.staleTargetId, null);
      assert.equal(pane.lastRestoreBlockedReason, null);
      const screen = (await runtime.listScreens())[0];
      assert.equal(screen?.panes[0]?.target?.targetId, target.targetId);
      assert.equal(screen?.panes[0]?.target?.blockedReason, null);
    });
  });

  await t.test("history navigation provider-owned visible content is not replayed after reconnect", async () => {
    await withRuntimeHarness(async ({ infos, runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const first = await runtime.push(
        {
          content: "<p>first</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:history-a" },
      );
      const second = await runtime.push(
        {
          content: "<p>second</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:history-b" },
      );

      server.sendHistoryNavigated(server.initialRemotePaneId, {
        contentId: first.contentId,
        direction: "back",
        revision: 1,
      });

      await waitFor(async () => (await runtime.listScreens())[0]?.panes[0]?.historySummary.visibleContentId === first.contentId);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      const initialContentApplyCount = server.contentSetRequests.length;
      await surface.client.close(1000, "test_history_repush_reconnect");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(
        server.contentSetRequests.length,
        initialContentApplyCount,
        JSON.stringify(server.contentSetRequests.map((request) => ({
          contentId: request.contentId,
          contentType: request.contentType,
          revision: request.revision,
        }))),
      );
      assert.ok(
        infos.some((info) =>
          info.includes("event=resume_replay_outcome") &&
          info.includes("content_id=" + first.contentId) &&
          info.includes("outcome=skipped_provider_owned")),
      );

      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.activeContent?.contentId, first.contentId);
      assert.equal(screens[0]?.panes[0]?.historySummary.visibleContentId, first.contentId);
    });
  });

  await t.test("provider rejects invalid split counts and cleans reserved panes after split transport failure", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await assert.rejects(
        runtime.split({
          count: 1,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        }),
        /at least 2/,
      );

      server.dropNextSplitRequest = true;
      await assert.rejects(
        runtime.split({
          count: 3,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        }),
      );

      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1]);
    });
  });

  await t.test("provider captures frame-open state freshly, delivers settled annotation turns, and ignores after_reconnect snapshot hints", async () => {
    await withRuntimeHarness(async ({ alertBodies, annotationTurns, runtime, server, warnings }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "<p>fresh snapshot</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:fresh" },
      );

      const initialSnapshotCount = server.snapshotRequests.length;
      server.snapshotImage = "ZnJhbWUtb3Blbg==";
      server.snapshotScrollOffset = { x: 24, y: 48 };
      server.sendDrawingFlush(server.initialRemotePaneId, pushed.contentId);

      await waitFor(() => server.snapshotRequests.length > initialSnapshotCount);
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const liveRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(liveRead.liveFrame?.image, "ZnJhbWUtb3Blbg==");
      assert.deepEqual(liveRead.liveFrame?.scrollOffset, { x: 24, y: 48 });
      assertAnnotationAlertBody(alertBodies[0], {
        image: "ZnJhbWUtb3Blbg==",
        message: "Surf Ace updates pending on Surface A (1 live dirty stroke)",
        paneId: firstPaneId,
        sessionKey: "agent:test:fresh",
        surfaceId: server.surfaceId,
      });

      const clear = await runtime.clear({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(clear.paneId, firstPaneId);
      await waitFor(() => annotationTurns.length === 1);
      assert.equal(alertBodies.length, 1);
      const turn = annotationTurns[0];
      assert.ok(turn);
      assert.equal(turn.fingerprint, server.surfaceId);
      assert.equal(turn.paneId, firstPaneId);
      assert.equal(turn.sessionKey, "agent:test:fresh");
      assert.equal(turn.surfaceName, "Surface A");
      assert.equal(turn.attachment.content, "ZnJhbWUtb3Blbg==");
      assert.equal(turn.attachment.mimeType, "image/png");
      assert.equal(turn.attachment.type, "file");
      assert.equal(
        turn.attachment.fileName,
        `surf-ace-${server.surfaceId}-pane-${firstPaneId}-${turn.frame.frameId}.png`,
      );
      assert.equal(turn.frame.contentId, pushed.contentId);
      assert.equal(turn.frame.contextKey, pushed.contentId);
      assert.equal(turn.frame.image, "ZnJhbWUtb3Blbg==");
      assert.deepEqual(turn.frame.scrollOffset, { x: 24, y: 48 });
      assert.deepEqual(turn.frame.viewport, {
        height: 768,
        scale: 2,
        width: 1024,
      });
      assert.equal(turn.frame.url, undefined);
      assert.deepEqual(turn.frame.strokes, [
        {
          bbox: { height: 20, width: 20, x: 10, y: 20 },
          endedAt: 120,
          points: [
            { pressure: 0.2, x: 10, y: 20 },
            { pressure: 0.4, x: 30, y: 40 },
          ],
          startedAt: 100,
          strokeId: "stroke_abc123",
        },
      ]);
      assert.equal(
        turn.idempotencyKey,
        `surf-ace-annotation-intent:${server.surfaceId}:${firstPaneId}:${turn.frame.frameId}`,
      );
      assert.match(turn.message, /Surf Ace settled annotation on surface "Surface A", pane 1\./);
      assert.match(turn.message, /Treat the attached image as the primary annotation input\./);
      assert.match(turn.message, /Use the stroke metadata below as secondary context only\./);
      assert.match(turn.message, /"displayId": "1"/);
      assert.match(turn.message, /"paneAddress": "1"/);

      const closedRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(closedRead.frames.length, 1);

      const beforeReconnectHint = server.snapshotRequests.length;
      server.sendSnapshotHint("after_reconnect");
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      assert.equal(server.snapshotRequests.length, beforeReconnectHint);

      server.sendSnapshotHint("after_render");
      await waitFor(() => server.snapshotRequests.length > beforeReconnectHint);

      server.snapshotDelayMs = 250;
      server.sendSnapshotHint("after_render");
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
      for (let index = 0; index <= 128; index += 1) {
        server.sendDrawingFlush(server.initialRemotePaneId, pushed.contentId);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      server.snapshotDelayMs = 0;

      assert.ok(
        warnings.some((warning) => warning.includes("snapshot event buffer overflow")),
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
    });
  });

  await t.test("annotation committed finalizes live annotation frames without a pane mutation", async () => {
    await withRuntimeHarness(async ({ annotationTurns, runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "<p>annotation committed</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:annotation-committed" },
      );

      server.snapshotImage = "Y29tbWl0dGVkLWZyYW1l";
      server.sendDrawingFlush(server.initialRemotePaneId, pushed.contentId);
      server.sendAnnotationCommitted(server.initialRemotePaneId, pushed.contentId);

      await waitFor(() => annotationTurns.length === 1);
      const turn = annotationTurns[0];
      assert.ok(turn);
      assert.equal(turn.sessionKey, "agent:test:annotation-committed");
      assert.equal(turn.attachment.content, "Y29tbWl0dGVkLWZyYW1l");
      assert.equal(turn.frame.contentId, pushed.contentId);

      const read = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(read.liveFrame, null);
      assert.equal(read.frames.length, 1);
      assert.equal(read.frames[0]?.image, "Y29tbWl0dGVkLWZyYW1l");
    });
  });

  await t.test("provider leaves settled annotation frames queued when the snapshot image is missing", async () => {
    await withRuntimeHarness(async ({ alertBodies, annotationTurns, runtime, server, warnings }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "<p>missing image</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:missing-image" },
      );

      const initialSnapshotCount = server.snapshotRequests.length;
      server.snapshotImage = "";
      server.sendDrawingFlush(server.initialRemotePaneId, pushed.contentId);

      await waitFor(() => server.snapshotRequests.length > initialSnapshotCount);
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const clear = await runtime.clear({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(clear.paneId, firstPaneId);
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      assert.equal(alertBodies[0]?.attachments, undefined);
      assert.equal(
        alertBodies[0]?.message,
        "Surf Ace updates pending on Surface A (1 live dirty stroke)",
      );
      assert.equal(alertBodies[0]?.noOverlay, true);
      assert.equal(alertBodies[0]?.sessionKey, "agent:test:missing-image");
      assert.equal(annotationTurns.length, 0);
      const closedRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(closedRead.frames.length, 1);
      assert.equal(closedRead.frames[0]?.image, "");
      assert.ok(
        warnings.some((warning) => warning.includes("settled annotation frame missing image")),
      );
    });
  });

  await t.test("reconnect snapshot materializes visible pane drawings back into surf_ace_read", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "<p>reconnect state</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:reconnect" },
      );

      const pane = server.panes.get(server.initialRemotePaneId);
      assert.ok(pane);
      pane.drawings = ["stroke_recovered"];
      server.snapshotImage = "cmVjb25uZWN0LWZyYW1l";
      server.snapshotScrollOffset = { x: 12, y: 34 };

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      await surface.client.close(1000, "test_reconnect_snapshot_materialization");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      const recovered = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(recovered.liveFrame?.contentId, pushed.contentId);
      assert.equal(recovered.liveFrame?.image, "cmVjb25uZWN0LWZyYW1l");
      assert.deepEqual(recovered.liveFrame?.scrollOffset, { x: 12, y: 34 });
      assert.deepEqual(recovered.liveFrame?.strokes.map((stroke) => stroke.strokeId), [
        "stroke_recovered",
      ]);
      assert.deepEqual(recovered.liveDirtyStrokeIds, ["stroke_recovered"]);

      const afterRead = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.deepEqual(afterRead.liveFrame?.strokes.map((stroke) => stroke.strokeId), [
        "stroke_recovered",
      ]);
      assert.deepEqual(afterRead.liveDirtyStrokeIds, []);
    });
  });

  await t.test("annotation alert gate is surface-scoped and resets on read or timeout", async () => {
    let currentTime = Date.now();
    await withRuntimeHarness({
      now: () => currentTime,
      run: async ({ alertBodies, runtime, server }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const firstPush = await runtime.push(
          {
            content: "<p>pane one</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: firstPaneId,
          },
          { sessionKey: "agent:test:alert-1" },
        );

        server.sendDrawingFlush(server.initialRemotePaneId, firstPush.contentId);
        await waitFor(() => alertBodies.length === 1);
        assertAnnotationAlertBody(alertBodies[0], {
          image: "aGVsbG8=",
          message: "Surf Ace updates pending on Surface A (1 live dirty stroke)",
          paneId: firstPaneId,
          sessionKey: "agent:test:alert-1",
          surfaceId: server.surfaceId,
        });

        const split = await runtime.split({
          count: 2,
          direction: "horizontal",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        const splitPaneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);

        const secondTopologyApply = server.topologyApplyRequests.at(-1);
        const secondRemotePaneId =
          secondTopologyApply?.paneIds[
            secondTopologyApply.paneLabels.findIndex((paneLabel) => paneLabel === 2)
          ];
        assert.equal(typeof secondRemotePaneId, "number");

        const secondPush = await runtime.push(
          {
            content: "<p>pane two</p>",
            contentType: "html",
            fingerprint: server.surfaceId,
            paneId: splitPaneIds[1]!,
          },
          { sessionKey: "agent:test:alert-2" },
        );

        server.sendDrawingFlush(secondRemotePaneId as number, secondPush.contentId);
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        assert.equal(alertBodies.length, 1);

        currentTime += 10 * 60_000 + 1;
        server.sendDrawingFlush(secondRemotePaneId as number, secondPush.contentId);
        await waitFor(() => alertBodies.length === 2);
        assertAnnotationAlertBody(alertBodies[1], {
          image: "aGVsbG8=",
          message: "Surf Ace updates pending on Surface A (3 live dirty strokes)",
          paneId: splitPaneIds[1]!,
          sessionKey: "agent:test:alert-2",
          surfaceId: server.surfaceId,
        });

        await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });

        server.sendDrawingFlush(secondRemotePaneId as number, secondPush.contentId);
        await waitFor(() => alertBodies.length === 3);
        assertAnnotationAlertBody(alertBodies[2], {
          image: "aGVsbG8=",
          message: "Surf Ace updates pending on Surface A (3 live dirty strokes)",
          paneId: splitPaneIds[1]!,
          sessionKey: "agent:test:alert-2",
          surfaceId: server.surfaceId,
        });
      },
    });
  });

  await t.test("background resume sync bails on closed sockets without unhandled rejections", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      const unhandled: unknown[] = [];
      const handleUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", handleUnhandled);

      try {
        await surface.client.close(1000, "test_close");
        internalRuntime.handleSurfaceResumedEvent(surface, {
          eventId: "ev_test_resume",
          op: "event.surface_resumed",
          payload: {
            surfaceId: server.surfaceId,
          },
          sentAt: Date.now(),
          type: "event",
          v: 1,
        });

        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });

        assert.deepEqual(unhandled, []);
        assert.equal(
          warnings.some((warning) => warning.includes("Surf Ace socket is not open")),
          false,
        );
      } finally {
        process.off("unhandledRejection", handleUnhandled);
      }
    });
  });

  await t.test("surface resume sync skips restored panes without bound remote ids", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.push(
        {
          content: "# unbound restore",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:resume-unbound" },
      );

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const pane = surface.panes.get(firstPaneId);
      assert.ok(pane);
      pane.remotePaneId = undefined;

      const initialContentApplyCount = server.contentSetRequests.length;
      const initialSnapshotCount = server.snapshotRequests.length;
      internalRuntime.handleSurfaceResumedEvent(surface, {
        eventId: "ev_test_resume_unbound",
        op: "event.surface_resumed",
        payload: {
          surfaceId: server.surfaceId,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      assert.equal(server.contentSetRequests.length, initialContentApplyCount);
      assert.equal(server.snapshotRequests.length, initialSnapshotCount);
      assert.equal(
        warnings.some((warning) => warning.includes("paneId is required")),
        false,
      );
    });
  });

  await t.test("surface resume replays provider-owned content before snapshot sync", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "# restart continuity",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionDisplayName: "Resume Pusher", sessionKey: "agent:test:resume-continuity" },
      );

      const remotePane = server.panes.get(server.initialRemotePaneId);
      assert.ok(remotePane);
      remotePane.contentId = null;
      remotePane.contentType = null;
      remotePane.revision = 0;

      const initialContentApplyCount = server.contentSetRequests.length;
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      internalRuntime.handleSurfaceResumedEvent(surface, {
        eventId: "ev_test_resume_content",
        op: "event.surface_resumed",
        payload: {
          surfaceId: server.surfaceId,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      });

      await waitFor(() => server.contentSetRequests.length > initialContentApplyCount, 12_000);

      const replayed = server.contentSetRequests.at(-1);
      assert.equal(replayed?.contentId, pushed.contentId);
      assert.equal(replayed?.contentType, "markdown");
      assert.equal(replayed?.displayTitle, null);
      assert.deepEqual(replayed?.displayProvenance, {
        displayName: "Resume Pusher",
        sessionKey: "agent:test:resume-continuity",
      });

      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.activeContent?.contentId, pushed.contentId);
      assert.equal(screens[0]?.panes[0]?.activeContent?.revision, pushed.revision);
      const read = await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId });
      assert.equal(read.contentSnapshot?.contentId, pushed.contentId);
      assert.equal(read.contentSnapshot?.contentType, "markdown");
      assert.deepEqual(read.contentSnapshot?.content, { markdown: "# restart continuity" });
    });
  });

  await t.test("persisted restart snapshot carries provider-owned content for replay", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "# persisted restart continuity",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:restart-persist" },
      );

      const internalRuntime = runtime as any;
      await internalRuntime.persistScreenSnapshot();
      const snapshotPath = path.join(internalRuntime.stateDir, "surf-ace-runtime-screens.json");
      const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
        contentContinuity?: Record<string, Array<{
          contentId: string;
          contentType: string;
          contentValue: string;
          paneLabel: number;
          remotePaneId: number;
          revision: number;
          sessionKey: string | null;
          targetId?: string | null;
        }>>;
      };
      const continuityEntry = snapshot.contentContinuity?.[server.surfaceId]?.[0];
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      const firstPane = surface?.panes.get(firstPaneId);
      assert.ok(firstPane);
      const target = firstPane.currentTargetId ? surface?.targetRecords.get(firstPane.currentTargetId) : null;
      assert.ok(target);
      firstPane.paneLabel = Number(firstPane.remotePaneId);
      await internalRuntime.persistScreenSnapshot();
      let projectedSnapshot: {
        contentContinuity?: Record<string, Array<{
          paneLabel: number;
        }>>;
      } | null = null;
      await waitFor(async () => {
        const rawSnapshot = await fs.readFile(snapshotPath, "utf8");
        if (rawSnapshot.length === 0) {
          return false;
        }
        projectedSnapshot = JSON.parse(rawSnapshot) as {
          contentContinuity?: Record<string, Array<{
            paneLabel: number;
          }>>;
        };
        return projectedSnapshot.contentContinuity?.[server.surfaceId]?.[0]?.paneLabel === 1;
      });
      assert.ok(projectedSnapshot);
      const projectedContinuityEntry = projectedSnapshot.contentContinuity?.[server.surfaceId]?.[0];
      assert.equal(continuityEntry?.contentId, pushed.contentId);
      assert.equal(continuityEntry?.contentType, "markdown");
      assert.equal(continuityEntry?.contentValue, "# persisted restart continuity");
      assert.equal(continuityEntry?.paneLabel, 1);
      assert.equal(continuityEntry?.remotePaneId, Number(firstPane.remotePaneId));
      assert.equal(continuityEntry?.revision, pushed.revision);
      assert.equal(continuityEntry?.sessionKey, "agent:test:restart-persist");
      assert.equal(continuityEntry?.targetId, target.targetId);
      assert.equal(projectedContinuityEntry?.paneLabel, 1);
      assert.equal(firstPane.paneLabel, 1);
    });
  });

  await t.test("blank provider observation does not erase persisted restart continuity", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const paneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);
      const pushed = await runtime.push(
        {
          content: "<main>T338 continuity survives blank pair</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: paneIds[0]!,
        },
        { sessionKey: "agent:test:blank-continuity" },
      );

      const internalRuntime = runtime as any;
      await internalRuntime.persistScreenSnapshot();
      const snapshotPath = path.join(internalRuntime.stateDir, "surf-ace-runtime-screens.json");
      const persistedBefore = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
        contentContinuity?: Record<string, Array<{ contentId?: string; contentValue?: unknown }>>;
        screens?: Array<{ fingerprint?: string; panes?: Array<{ paneLabel?: number }> }>;
      };
      assert.equal(
        persistedBefore.contentContinuity?.[server.surfaceId]?.some((entry) =>
          entry.contentId === pushed.contentId &&
          entry.contentValue === "<main>T338 continuity survives blank pair</main>"
        ),
        true,
      );
      assert.deepEqual(
        persistedBefore.screens
          ?.find((screen) => screen.fingerprint === server.surfaceId)
          ?.panes
          ?.map((pane) => pane.paneLabel),
        [1, 2],
      );
      const persistedScreenBefore = persistedBefore.screens?.find((screen) => screen.fingerprint === server.surfaceId) as
        | { _debug?: { localOwnership?: unknown }; fingerprint?: string }
        | undefined;
      assert.ok(persistedScreenBefore);
      if (persistedScreenBefore._debug) {
        persistedScreenBefore._debug.localOwnership = null;
      }
      await fs.writeFile(snapshotPath, JSON.stringify(persistedBefore, null, 2));
      await internalRuntime.loadRestartSnapshots();
      assert.ok(internalRuntime.restartSnapshots.has(server.surfaceId));

      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const pane = surface.panes.get(paneIds[0]!);
      assert.ok(pane);
      pane.activeContentId = null;
      await internalRuntime.persistScreenSnapshot();
      const persistedProjected = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
        contentContinuity?: Record<string, Array<{ contentId?: string; contentValue?: unknown }>>;
        screens?: Array<{
          fingerprint?: string;
          panes?: Array<{
            activeContent?: unknown;
            historySummary?: { visibleContentId?: string | null };
            target?: unknown;
          }>;
        }>;
      };
      assert.equal(
        persistedProjected.contentContinuity?.[server.surfaceId]?.some((entry) =>
          entry.contentId === pushed.contentId &&
          entry.contentValue === "<main>T338 continuity survives blank pair</main>"
        ),
        true,
      );
      const projectedScreen = persistedProjected.screens?.find((screen) => screen.fingerprint === server.surfaceId);
      assert.ok(projectedScreen);
      for (const projectedPane of projectedScreen.panes ?? []) {
        projectedPane.activeContent = null;
        projectedPane.historySummary = {
          ...(projectedPane.historySummary ?? {}),
          visibleContentId: null,
        };
        projectedPane.target = null;
      }
      await fs.writeFile(snapshotPath, JSON.stringify(persistedProjected, null, 2));

      surface.panes = new Map([[pane.paneId, pane]]);
      surface.layout = { paneId: pane.paneId, type: "pane" };
      surface.topologyRevision += 1;
      pane.contentType = null;
      pane.contentValue = null;
      pane.currentRevision = 2;
      pane.historySummary.visibleContentId = null;
      await internalRuntime.persistScreenSnapshot();

      const persistedAfter = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
        contentContinuity?: Record<string, Array<{ contentId?: string; contentValue?: unknown }>>;
        screens?: Array<{ fingerprint?: string; panes?: Array<{ paneLabel?: number }> }>;
      };
      assert.equal(
        persistedAfter.contentContinuity?.[server.surfaceId]?.some((entry) =>
          entry.contentId === pushed.contentId &&
          entry.contentValue === "<main>T338 continuity survives blank pair</main>"
        ),
        true,
      );
      assert.deepEqual(
        persistedAfter.screens
          ?.find((screen) => screen.fingerprint === server.surfaceId)
          ?.panes
          ?.map((pane) => pane.paneLabel),
        [1, 2],
      );
    });
  });

  await t.test("blank provider observation retains prior topology when only continuity hints exist", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const paneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);
      const pushed = await runtime.push(
        {
          content: "<main>T338 continuity-only topology retention</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: paneIds[0]!,
        },
        { sessionKey: "agent:test:continuity-only-retention" },
      );

      const internalRuntime = runtime as any;
      await internalRuntime.persistScreenSnapshot();
      const snapshotPath = path.join(internalRuntime.stateDir, "surf-ace-runtime-screens.json");
      const persistedBefore = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
        contentContinuity?: Record<string, Array<{ contentId?: string; contentValue?: unknown }>>;
        screens?: Array<{ _debug?: unknown; fingerprint?: string; panes?: Array<{ paneLabel?: number }> }>;
      };
      const previousScreen = persistedBefore.screens?.find((screen) => screen.fingerprint === server.surfaceId);
      assert.ok(previousScreen);
      delete previousScreen._debug;
      await fs.writeFile(snapshotPath, JSON.stringify(persistedBefore, null, 2));

      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const pane = surface.panes.get(paneIds[0]!);
      assert.ok(pane);
      surface.panes = new Map([[pane.paneId, pane]]);
      surface.layout = { paneId: pane.paneId, type: "pane" };
      surface.topologyRevision += 1;
      pane.activeContentId = null;
      pane.contentType = null;
      pane.contentValue = null;
      pane.historySummary.visibleContentId = null;

      await internalRuntime.persistScreenSnapshot();
      const persistedAfter = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
        contentContinuity?: Record<string, Array<{ contentId?: string; contentValue?: unknown }>>;
        screens?: Array<{ fingerprint?: string; panes?: Array<{ paneLabel?: number }> }>;
      };
      assert.equal(
        persistedAfter.contentContinuity?.[server.surfaceId]?.some((entry) =>
          entry.contentId === pushed.contentId &&
          entry.contentValue === "<main>T338 continuity-only topology retention</main>"
        ),
        true,
      );
      assert.deepEqual(
        persistedAfter.screens
          ?.find((screen) => screen.fingerprint === server.surfaceId)
          ?.panes
          ?.map((pane) => pane.paneLabel),
        [1, 2],
      );
    });
  });

  await t.test("provider shutdown snapshot keeps prior topology and continuity when no live screens remain", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const paneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);
      const pushed = await runtime.push(
        {
          content: "<main>T338 shutdown retention</main>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: paneIds[0]!,
        },
        { sessionKey: "agent:test:shutdown-retention" },
      );

      const internalRuntime = runtime as any;
      await internalRuntime.persistScreenSnapshot();
      const snapshotPath = path.join(internalRuntime.stateDir, "surf-ace-runtime-screens.json");
      internalRuntime.surfaces.clear();
      internalRuntime.preserveEmptyScreenSnapshotOnce = true;

      await internalRuntime.persistScreenSnapshot();
      const persistedAfter = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
        contentContinuity?: Record<string, Array<{ contentId?: string; contentValue?: unknown }>>;
        screens?: Array<{ fingerprint?: string; panes?: Array<{ paneLabel?: number }> }>;
      };
      assert.equal(
        persistedAfter.contentContinuity?.[server.surfaceId]?.some((entry) =>
          entry.contentId === pushed.contentId &&
          entry.contentValue === "<main>T338 shutdown retention</main>"
        ),
        true,
      );
      assert.deepEqual(
        persistedAfter.screens
          ?.find((screen) => screen.fingerprint === server.surfaceId)
          ?.panes
          ?.map((pane) => pane.paneLabel),
        [1, 2],
      );
    });
  });

  await t.test("legacy restart content snapshot without target pointer restores content with null target", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const pushed = await runtime.push(
        {
          content: "# restored restart continuity",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:restart-restore" },
      );

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const pane = internalRuntime.firstPane(surface);
      assert.ok(pane);

      internalRuntime.clearVisiblePaneContent(pane, 0);
      internalRuntime.restartContentBySurface = new Map([
        [
          server.surfaceId,
          [
            {
              contentId: pushed.contentId,
              contentType: "markdown",
              contentValue: "# restored restart continuity",
              historyOwnerToken: "hot_test",
              paneLabel: pane.paneLabel,
              revision: pushed.revision,
              sessionKey: "agent:test:restart-restore",
            },
          ],
        ],
      ]);

      internalRuntime.restoreRestartContent(surface);

      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.panes[0]?.activeContent?.contentId, pushed.contentId);
      assert.equal(screens[0]?.panes[0]?.activeContent?.revision, pushed.revision);
      assert.equal(screens[0]?.panes[0]?.target, null);
      const read = await runtime.read({ fingerprint: server.surfaceId, paneId: pane.paneId });
      assert.equal(read.contentSnapshot?.contentId, pushed.contentId);
      assert.equal(read.contentSnapshot?.contentType, "markdown");
      assert.deepEqual(read.contentSnapshot?.content, { markdown: "# restored restart continuity" });
      assert.equal(read.contentSnapshot?.visibleText, "# restored restart continuity");
    });
  });

  await t.test("restart content restore follows stable provider pane ids when provider labels change", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const secondPaneId = paneByLabel({ panes: split }, 2).paneId;
      const pushed = await runtime.push(
        {
          content: "# restored after provider label repair",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: secondPaneId,
        },
        { sessionKey: "agent:test:restart-label-repair" },
      );

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const secondPane = surface.panes.get(secondPaneId);
      assert.ok(secondPane);

      internalRuntime.clearVisiblePaneContent(secondPane, 0);
      secondPane.paneLabel = 7;
      internalRuntime.restartContentBySurface = new Map([
        [
          server.surfaceId,
          [
            {
              contentId: pushed.contentId,
              contentType: "markdown",
              contentValue: "# restored after provider label repair",
              display: null,
              historyOwnerToken: "hot_test",
              paneLabel: 2,
              remotePaneId: Number(secondPane.remotePaneId),
              revision: pushed.revision,
              sessionKey: "agent:test:restart-label-repair",
            },
          ],
        ],
      ]);

      internalRuntime.restoreRestartContent(surface);

      const read = await runtime.read({ fingerprint: server.surfaceId, paneId: secondPaneId });
      assert.equal(read.contentSnapshot?.contentId, pushed.contentId);
      assert.equal(read.contentSnapshot?.contentType, "markdown");
      assert.deepEqual(read.contentSnapshot?.content, { markdown: "# restored after provider label repair" });
    });
  });

  await t.test("worker closes stale sockets and suppresses invalid_resume retries when the circuit opens", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port);
    server.forcedPairErrors = Array.from({ length: 10 }, () => ({
      code: "invalid_resume" as const,
      message: "Resume session did not match active ownership lock",
    }));

    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-retry-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({
      discovery,
      logger: {
        warn: () => {},
      },
      stateDir,
    });

    try {
      await runtime.start();
      await waitFor(() => server.pairRequests.length >= 3, 12_000);
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await waitFor(
        () => surface.autoRetryEnabled === false && surface.connectionCircuitOpenedAt !== null,
        12_000,
      );
      await waitFor(() => surface.workPromise === null, 12_000);
      const pairRequestsAfterCircuitOpen = server.pairRequests.length;
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      assert.equal(server.pairRequests.length, pairRequestsAfterCircuitOpen);
      assert.equal(surface.autoRetryEnabled, false);
      assert.equal(surface.connectionState, "unreachable");
      assert.equal(surface.connectionCircuitOpenedAt !== null, true);
      assert.equal(internalRuntime.surfaceConnectionDiagnostics(surface).circuitState, "given_up");
      const screen = (await runtime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
      assert.equal(screen?.authority.actionable, false);
      assert.equal(screen?.authority.blockers.includes("not_connected"), true);
      assert.ok(server.activeSocketCount <= 1);
      assert.ok(server.maxConcurrentSocketCount <= 1);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }

    assert.equal(server.activeSocketCount, 0);
  });

  await t.test("provider rejects pair responses without topology panes before marking connected", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.forceEmptyPairResponsePanes = true;
      },
      waitForPair: false,
      run: async ({ runtime, server, warnings }) => {
        await waitFor(
          () => warnings.some((warning) => warning.includes("contained no topology panes")),
          12_000,
        );

        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        assert.equal(surface.hasPairedInGatewaySession, false);
        assert.equal(surface.sessionId, null);
        assert.notEqual(surface.connectionState, "connected");

        const screens = await runtime.listScreens();
        const screen = screens.find((entry) => entry.fingerprint === server.surfaceId);
        assert.equal(screen, undefined);
      },
    });
  });

  await t.test("rediscovery on an already paired surface does not re-arm takeover from paired advertisement", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.equal(surface.sessionId, "sa_test_session");
      assert.equal(surface.hasPairedInGatewaySession, true);

      surface.forceTakeoverOnNextPair = false;
      await internalRuntime.discoverSurfaceId(surface);

      assert.equal(surface.forceTakeoverOnNextPair, false);
    });
  });

  await t.test("rediscovery after resume fallback does not re-arm takeover from paired advertisement", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.equal(surface.sessionId, "sa_test_session");
      assert.equal(surface.hasPairedInGatewaySession, true);

      surface.sessionId = null;
      surface.forceTakeoverOnNextPair = false;
      await internalRuntime.discoverSurfaceId(surface);

      assert.equal(surface.forceTakeoverOnNextPair, false);
    });
  });

  await t.test("discovery churn does not close an already connected surface", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server }) => {
      const initialPairAttempts = server.pairAttemptDetails.length;
      assert.equal(initialPairAttempts, 1);

      discovery.setEndpoints([]);
      await discovery.refreshNow();
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const screens = await runtime.listScreens();
      assert.equal(screens[0]?.connectionState, "connected");
      assert.equal(server.pairAttemptDetails.length, initialPairAttempts);
      assert.notEqual(server.pairedSocket, null);
    });
  });

  await t.test("discovery refresh does not open endpoint probe when owned surface worker is active", async () => {
    await withRuntimeHarness(async ({ discovery, infos, runtime, server }) => {
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);
      const probeAttemptsBeforeRefresh = infos.filter((message) => message.includes("endpoint_probe_attempt")).length;
      server.maxConcurrentSocketCount = server.activeSocketCount;

      await discovery.refreshNow();
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      const probeAttemptsAfterRefresh = infos.filter((message) => message.includes("endpoint_probe_attempt")).length;
      assert.equal(probeAttemptsAfterRefresh, probeAttemptsBeforeRefresh);
      assert.equal(server.maxConcurrentSocketCount, 1);
      assert.equal((await runtime.listScreens())[0]?.connectionState, "connected");
    });
  });

  await t.test("accepted topology missing from discovery is removed and not targetable after transport becomes unreachable", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.equal((await runtime.listScreens()).some((entry) => entry.fingerprint === server.surfaceId), true);
      const staleSurfaceId = "surface-stale-accepted";
      const staleEndpointId = "endpoint-stale-accepted";
      const stalePaneId = [...surface.panes.values()][0]?.paneId;
      assert.ok(stalePaneId);
      const staleSurface = {
        ...surface,
        surfaceId: staleSurfaceId,
        endpointId: staleEndpointId,
        endpoint: {
          ...surface.endpoint,
          endpointId: staleEndpointId,
          name: "stale accepted",
          port: surface.endpoint.port + 1,
        },
        client: null,
        connectionCircuitOpenedAt: Date.now(),
        connectionCircuitReason: "test missing discovery unreachable",
        connectionState: "unreachable",
        localOwnership: {
          ...surface.localOwnership,
          surfaceId: staleSurfaceId,
        },
        panes: new Map(surface.panes),
        stopRequested: false,
        unreachableFailures: 5,
        workPromise: null,
      };

      discovery.setEndpoints([]);
      await discovery.refreshNow();
      internalRuntime.surfaces.set(staleSurfaceId, staleSurface);

      await assert.rejects(
        async () => await runtime.read({ fingerprint: staleSurfaceId, paneId: stalePaneId }),
        /Unknown Surf Ace surface/,
      );
      await assert.rejects(
        async () => await runtime.snapshot({ fingerprint: staleSurfaceId, paneId: stalePaneId }),
        /Unknown Surf Ace surface/,
      );
      const screens = await runtime.listScreens();

      assert.equal(screens.some((entry) => entry.fingerprint === staleSurfaceId), false);
      assert.equal(internalRuntime.surfaces.has(staleSurfaceId), false);
    });
  });

  await t.test("discovery loss removes unowned disconnected pane-only ghost rows", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.panes.size > 0);
      const firstPane = internalRuntime.firstPane(surface);
      assert.ok(firstPane);
      const remotePaneId = firstPane.remotePaneId;
      assert.ok(remotePaneId);

      surface.autoRetryEnabled = false;
      surface.client = null;
      surface.connectedAt = null;
      surface.connectionState = "unreachable";
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      internalRuntime.persistentState.targetStateBySurfaceId[surface.surfaceId] = {
        ownershipEpoch: 1,
        paneTargets: {},
        registeredTargetIdsByIdempotencyKey: {},
        targetRecords: [],
      };
      internalRuntime.persistentState.windowLabels[surface.surfaceId] = "z";
      internalRuntime.persistentState.paneLabelsByPaneId[`${surface.surfaceId}::${Number(remotePaneId)}`] = 7;
      internalRuntime.restartContentBySurface = new Map([
        [
          surface.surfaceId,
          [
            {
              contentId: "ct_ghost_restart",
              contentType: "markdown",
              contentValue: "# ghost",
              historyOwnerToken: "hot_ghost",
              paneLabel: firstPane.paneLabel,
              revision: 1,
              sessionKey: "agent:test:ghost-cleanup",
            },
          ],
        ],
      ]);
      internalRuntime.restartSnapshots = new Map([
        [surface.surfaceId, { fingerprint: surface.surfaceId }],
      ]);

      discovery.setEndpoints([]);
      await discovery.refreshNow();

      await waitFor(async () => {
        const screens = await runtime.listScreens();
        return !screens.some((entry) => entry.fingerprint === server.surfaceId);
      });

      assert.equal(internalRuntime.surfaces.has(server.surfaceId), false);
      assert.equal(internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId], undefined);
      assert.equal(internalRuntime.persistentState.windowLabels[server.surfaceId], undefined);
      assert.equal(
        internalRuntime.persistentState.paneLabelsByPaneId[`${server.surfaceId}::${Number(remotePaneId)}`],
        undefined,
      );
      assert.equal(internalRuntime.restartContentBySurface.has(server.surfaceId), false);
      assert.equal(internalRuntime.restartSnapshots.has(server.surfaceId), false);
    });
  });

  await t.test("still-discovered unowned unreachable pane ghosts are pruned before listing", async () => {
    await withRuntimeHarness(async ({ runtime, server, stateDir }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.panes.size > 0);
      const screen = (await runtime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
      const paneId = screen?.panes[0]?.paneId;
      assert.ok(paneId);
      await runtime.push(
        {
          content: "# stale ghost",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId,
        },
        { sessionDisplayName: "Ghost Test", sessionKey: "agent:test:ghost-content" },
      );

      surface.stopRequested = true;
      await surface.client?.close(1000, "test_stale_unreachable_ghost").catch(() => {});
      await surface.workPromise;
      surface.workPromise = null;
      surface.stopRequested = false;
      surface.autoRetryEnabled = true;
      surface.client = null;
      surface.connectedAt = null;
      surface.connectionState = "unreachable";
      surface.hasPairedInGatewaySession = false;
      surface.reconnectAttempt = 1000;
      surface.remoteListedAt = null;
      surface.remotePaired = false;
      surface.sessionId = null;
      surface.unreachableFailures = 1000;
      internalRuntime.persistentState.targetStateBySurfaceId[surface.surfaceId] = {
        ownershipEpoch: 1,
        paneTargets: {},
        registeredTargetIdsByIdempotencyKey: {},
        targetRecords: [],
      };

      const screens = await runtime.listScreens();

      assert.equal(screens.some((entry) => entry.fingerprint === server.surfaceId), false);
      assert.equal(internalRuntime.surfaces.has(server.surfaceId), false);
      assert.equal(internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId], undefined);
      await internalRuntime.persistScreenSnapshot();
      const persistedSnapshot = JSON.parse(
        await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8"),
      );
      assert.equal(persistedSnapshot.contentContinuity?.[server.surfaceId], undefined);
    });
  });

  await t.test("still-discovered unowned connecting ghosts with high retry counts are pruned before listing", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.panes.size > 0);

      surface.stopRequested = true;
      await surface.client?.close(1000, "test_stale_connecting_ghost").catch(() => {});
      await surface.workPromise;
      surface.workPromise = null;
      surface.stopRequested = false;
      surface.autoRetryEnabled = true;
      surface.client = null;
      surface.connectedAt = null;
      surface.connectionState = "connecting";
      surface.hasPairedInGatewaySession = false;
      surface.reconnectAttempt = 1000;
      surface.remoteListedAt = null;
      surface.remotePaired = false;
      surface.sessionId = null;
      surface.unreachableFailures = 0;

      const screens = await runtime.listScreens();

      assert.equal(screens.some((entry) => entry.fingerprint === server.surfaceId), false);
      assert.equal(internalRuntime.surfaces.has(server.surfaceId), false);
    });
  });

  await t.test("remote paired disconnected surfaces are preserved internally but hidden until owned", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server }) => {
      const internalRuntime = runtime as any;
      const endpoint = discovery.getSnapshot()[0]!;
      internalRuntime.reconcileCanonicalSurfacesFromRemoteList({
        endpoint,
        remoteSurfaces: [
          {
            name: "Surface A",
            paired: true,
            surfaceId: server.surfaceId,
            viewport: endpoint.viewport,
          },
        ],
        source: "surfaces.list",
        startDiscoveredSiblings: false,
      });
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.equal(surface.remotePaired, true);
      surface.remoteListedAt = null;

      surface.stopRequested = true;
      await surface.client?.close(1000, "test_remote_paired_preserved").catch(() => {});
      await surface.workPromise;
      surface.workPromise = null;
      surface.stopRequested = false;
      surface.autoRetryEnabled = true;
      surface.client = null;
      surface.connectedAt = null;
      surface.connectionState = "connecting";
      surface.hasPairedInGatewaySession = false;
      surface.reconnectAttempt = 1000;
      surface.sessionId = null;
      surface.unreachableFailures = 1000;

      const screens = await runtime.listScreens();

      assert.equal(screens.some((entry) => entry.fingerprint === server.surfaceId), false);
      assert.equal(internalRuntime.surfaces.has(server.surfaceId), true);
    });
  });

  await t.test("remote-paired foreign rows with cached panes stay hidden without local ownership", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server, stateDir }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      await runtime.push(
        {
          content: "# foreign ghost content",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:foreign-ghost-content" },
      );

      const internalRuntime = runtime as any;
      const endpoint = discovery.getSnapshot()[0]!;
      const ownedSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(ownedSurface);
      const ownedPanes = new Map(ownedSurface.panes);
      const ownedLayout = structuredClone(ownedSurface.layout);
      const ownedTopologyRevision = ownedSurface.topologyRevision;
      internalRuntime.reconcileCanonicalSurfacesFromRemoteList({
        endpoint,
        remoteSurfaces: [
          {
            name: "Foreign Surface",
            paired: true,
            surfaceId: "sf_foreign_remote_paired",
            viewport: endpoint.viewport,
          },
        ],
        source: "surfaces.list",
        startDiscoveredSiblings: false,
      });

      const surface = internalRuntime.surfaces.get("sf_foreign_remote_paired");
      assert.ok(surface);
      assert.equal(typeof surface.remoteListedAt, "number");
      assert.equal(surface.remotePaired, true);
      assert.equal(surface.remotePairObservation?.paired, true);
      assert.equal(surface.remotePairObservation?.endpointId, endpoint.endpointId);
      assert.equal(surface.remotePairObservation?.endpointHost, endpoint.host);
      assert.equal(surface.localOwnership, null);
      surface.connectionState = "unreachable";
      surface.hasPairedInGatewaySession = false;
      surface.layout = ownedLayout;
      surface.panes = ownedPanes;
      surface.reconnectAttempt = 5;
      surface.sessionId = null;
      surface.topologyRevision = ownedTopologyRevision;
      surface.unreachableFailures = 5;

      const screens = await runtime.listScreens();
      assert.equal(screens.some((entry) => entry.fingerprint === surface.surfaceId), false);
      assert.equal(internalRuntime.surfaces.has(surface.surfaceId), true);

      const hiddenPane = [...surface.panes.values()][0];
      assert.ok(hiddenPane);
      await assert.rejects(
        async () => await runtime.read({ fingerprint: surface.surfaceId, paneId: hiddenPane.paneId }),
        /Unknown Surf Ace surface/,
      );
      await assert.rejects(
        async () => await runtime.snapshot({ fingerprint: surface.surfaceId, paneId: hiddenPane.paneId }),
        /Unknown Surf Ace surface/,
      );

      await internalRuntime.persistScreenSnapshot();
      let persistedSnapshot: any = null;
      await waitFor(async () => {
        const rawSnapshot = await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8");
        if (rawSnapshot.length === 0) {
          return false;
        }
        try {
          persistedSnapshot = JSON.parse(rawSnapshot);
          return true;
        } catch {
          return false;
        }
      });
      assert.equal(persistedSnapshot.contentContinuity?.[surface.surfaceId], undefined);

      const staleRemotePaneIds = [...surface.panes.values()].map((pane: any) => Number(pane.remotePaneId));
      assert.ok(staleRemotePaneIds.length > 0);
      const contentRequestsBeforeFreshPair = server.contentSetRequests.length;
      const clearRequestsBeforeFreshPair = server.clearRequests.length;
      const topologyRequestsBeforeFreshPair = server.topologyApplyRequests.length;
      server.addSurface({
        initialRemotePaneId: 77,
        name: "Foreign Surface",
        surfaceId: surface.surfaceId,
      });
      surface.connectionState = "connecting";
      surface.remotePaired = false;
      surface.unreachableFailures = 0;
      internalRuntime.ensureSurfaceWorker(surface);

      await waitFor(async () => {
        const freshScreens = await runtime.listScreens();
        return freshScreens.some((entry) => entry.fingerprint === surface.surfaceId && entry.connectionState === "connected");
      }, 12_000);

      const freshSurfaceScreen = (await runtime.listScreens()).find((entry) => entry.fingerprint === surface.surfaceId);
      assert.ok(freshSurfaceScreen);
      const freshPairRequestIndex = server.pairRequestSurfaceIds.lastIndexOf(surface.surfaceId);
      assert.notEqual(freshPairRequestIndex, -1);
      const freshPairRequest = server.pairRequests[freshPairRequestIndex];
      assert.ok(freshPairRequest);
      assert.equal(staleRemotePaneIds.includes(freshPairRequest.initialPaneId), false);
      assert.equal(freshPairRequest.initialPaneLabel, 1);
      assertPaneLabelsWithOpaqueIds(freshSurfaceScreen.panes, [1]);
      assert.equal(freshSurfaceScreen.panes[0]?.activeContent, null);
      assert.equal(surface.panes.size, 1);
      assert.equal(surface.topologyRevision, 0);
      assert.equal(server.topologyApplyRequests.length >= topologyRequestsBeforeFreshPair, true);
      assert.equal(server.contentSetRequests.length, contentRequestsBeforeFreshPair);
      assert.equal(server.clearRequests.length, clearRequestsBeforeFreshPair);
    });
  });

  await t.test("single idle remote-paired cached pane does not seed fresh pair bootstrap", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      const stalePane = [...surface.panes.values()][0];
      assert.ok(stalePane);
      const staleRemotePaneId = Number(stalePane.remotePaneId);
      surface.stopRequested = true;
      await surface.client.close(1000, "test_idle_remote_paired_cached_pane_bootstrap").catch(() => {});
      await surface.workPromise;
      surface.workPromise = null;
      surface.stopRequested = false;
      surface.autoRetryEnabled = true;
      surface.client = null;
      surface.connectedAt = null;
      surface.connectionState = "connecting";
      surface.hasPairedInGatewaySession = false;
      surface.reconnectAttempt = 5;
      surface.remotePaired = true;
      surface.sessionId = null;
      surface.unreachableFailures = 5;

      assert.equal((await runtime.listScreens()).some((entry) => entry.fingerprint === server.surfaceId), false);

      const pairRequestsBeforeFreshPair = server.pairRequests.length;
      server.resetToSinglePane(77);
      surface.remotePaired = false;
      surface.unreachableFailures = 0;
      internalRuntime.ensureSurfaceWorker(surface);

      await waitFor(() => server.pairRequests.length > pairRequestsBeforeFreshPair, 12_000);
      const freshPairRequest = server.pairRequests.at(-1);
      assert.ok(freshPairRequest);
      assert.notEqual(freshPairRequest.initialPaneId, staleRemotePaneId);
      assert.equal(freshPairRequest.initialPaneLabel, 1);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);
    });
  });

    await t.test("session id without paired ownership does not expose stale cached panes", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.panes.size > 0);
      surface.stopRequested = true;
      await surface.client?.close(1000, "test_stale_session_without_paired_flag_hidden").catch(() => {});
      await surface.workPromise;
      surface.workPromise = null;
      surface.stopRequested = false;
      surface.autoRetryEnabled = true;
      surface.client = null;
      surface.connectedAt = null;
      surface.connectionState = "connecting";
      surface.hasPairedInGatewaySession = false;
      surface.reconnectAttempt = 5;
      surface.remotePaired = true;
      surface.sessionId = "sa_stale_resume_only";
      surface.unreachableFailures = 5;

      const screens = await runtime.listScreens();

      assert.equal(screens.some((entry) => entry.fingerprint === server.surfaceId), false);
      assert.equal(internalRuntime.surfaces.has(server.surfaceId), true);
    });
  });

  await t.test("paired flag without local session does not expose stale cached panes", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.panes.size > 0);
      surface.stopRequested = true;
      await surface.client?.close(1000, "test_no_session_paired_flag_hidden").catch(() => {});
      await surface.workPromise;
      surface.workPromise = null;
      surface.stopRequested = false;
      surface.autoRetryEnabled = true;
      surface.client = null;
      surface.connectedAt = null;
      surface.connectionState = "connecting";
      surface.hasPairedInGatewaySession = true;
      surface.reconnectAttempt = 5;
      surface.remotePaired = true;
      surface.sessionId = null;
      surface.unreachableFailures = 5;

      const screens = await runtime.listScreens();

      assert.equal(screens.some((entry) => entry.fingerprint === server.surfaceId), false);
      assert.equal(internalRuntime.surfaces.has(server.surfaceId), true);
    });
  });

  await t.test("circuit-open pre-admission surfaces expose diagnostics without panes", async () => {
    await withRuntimeHarness(async ({ runtime, server, stateDir }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.panes.size > 0);

      surface.stopRequested = true;
      await surface.client?.close(1000, "test_preadmission_diagnostic_visibility").catch(() => {});
      await surface.workPromise;
      surface.workPromise = null;
      surface.stopRequested = false;
      surface.autoRetryEnabled = true;
      surface.client = null;
      surface.connectedAt = null;
      surface.connectionState = "connecting";
      surface.hasPairedInGatewaySession = false;
      surface.localOwnership = null;
      surface.remotePaired = true;
      surface.sessionId = null;
      surface.unreachableFailures = 3;
      surface.windowLabel = "";
      delete internalRuntime.persistentState.windowLabels[server.surfaceId];
      internalRuntime.noteSurfaceConnectionFailure(surface, "test pre-admission circuit open");

      const screens = await runtime.listScreens();
      const screen = screens.find((entry) => entry.fingerprint === server.surfaceId);

      assert.ok(screen);
      assert.equal(screen.windowLabel, "");
      assert.deepEqual(screen.panes, []);
      assert.equal(screen.topology, null);
      assert.equal(screen.topologyRevision, 0);
      assert.equal(screen.connectionDiagnostics.circuitState, "given_up");
      assert.equal(screen.connectionDiagnostics.circuitOpen, true);
      assert.equal(screen.connectionDiagnostics.givenUp, true);
      assert.equal(screen._debug?.hasPairedInGatewaySession, false);
      assert.equal(internalRuntime.persistentState.windowLabels[server.surfaceId], undefined);

      await waitFor(async () => {
        try {
          const raw = await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8");
          const snapshot = JSON.parse(raw) as { screens: Array<{ fingerprint?: string; connectionDiagnostics?: { circuitState?: string } }> };
          return snapshot.screens.some((entry) =>
            entry.fingerprint === server.surfaceId &&
            entry.connectionDiagnostics?.circuitState === "given_up");
        } catch {
          return false;
        }
      }, 12_000);
      const passiveRuntime = createSurfAceRuntime({
        discovery: new StaticDiscoveryService([]),
        stateDir,
      });
      try {
        await passiveRuntime.start();
        const passiveScreen = (await passiveRuntime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
        assert.equal(passiveScreen?.windowLabel, "");
        assert.deepEqual(passiveScreen?.panes, []);
        assert.equal(passiveScreen?.connectionDiagnostics.circuitState, "given_up");
        assert.equal(passiveScreen?.connectionDiagnostics.givenUp, true);
      } finally {
        await passiveRuntime.stop();
      }
    });
  });

  await t.test("remote-paired foreign circuit-open rows stay hidden from list exposure", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.panes.size > 0);

      surface.stopRequested = true;
      await surface.client?.close(1000, "test_foreign_preadmission_diagnostic_hidden").catch(() => {});
      await surface.workPromise;
      surface.workPromise = null;
      surface.stopRequested = false;
      surface.autoRetryEnabled = true;
      surface.client = null;
      surface.connectedAt = null;
      surface.connectionState = "connecting";
      surface.hasPairedInGatewaySession = false;
      surface.localOwnership = null;
      surface.remotePaired = true;
      surface.sessionId = null;
      surface.unreachableFailures = 3;
      surface.windowLabel = "";
      delete internalRuntime.persistentState.selfOwnedSurfaceIds[server.surfaceId];
      delete internalRuntime.persistentState.windowLabels[server.surfaceId];
      internalRuntime.noteSurfaceConnectionFailure(surface, "test foreign pre-admission circuit open");

      const screens = await runtime.listScreens();

      assert.equal(screens.some((entry) => entry.fingerprint === server.surfaceId), false);
      assert.equal(internalRuntime.surfaces.has(server.surfaceId), true);
    });
  });

  await t.test("surfaces.list-active unlocked surfaces are preserved internally but hidden until paired", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server }) => {
      const internalRuntime = runtime as any;
      const endpoint = discovery.getSnapshot()[0]!;
      internalRuntime.reconcileCanonicalSurfacesFromRemoteList({
        endpoint,
        remoteSurfaces: [
          {
            name: "Surface A",
            paired: false,
            surfaceId: server.surfaceId,
            viewport: endpoint.viewport,
          },
        ],
        source: "surfaces.list",
        startDiscoveredSiblings: false,
      });
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.equal(typeof surface.remoteListedAt, "number");
      assert.equal(surface.remotePaired, false);

      surface.stopRequested = true;
      await surface.client?.close(1000, "test_unpaired_listed_preserved").catch(() => {});
      await surface.workPromise;
      surface.workPromise = null;
      surface.stopRequested = false;
      surface.autoRetryEnabled = true;
      surface.client = null;
      surface.connectedAt = null;
      surface.connectionState = "unreachable";
      surface.hasPairedInGatewaySession = false;
      surface.reconnectAttempt = 1000;
      surface.sessionId = null;
      surface.unreachableFailures = 1000;

      const screens = await runtime.listScreens();

      assert.equal(screens.some((entry) => entry.fingerprint === server.surfaceId), false);
      assert.equal(internalRuntime.surfaces.has(server.surfaceId), true);
    });
  });

  await t.test("failed pre-pair bootstrap panes are not exposed in surf_ace_list", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.busyWithoutTakeoverResponsesRemaining = 100;
      },
      waitForPair: false,
      run: async ({ runtime, server, stateDir }) => {
        await waitFor(() => server.pairRequests.length > 0, 12_000);
        const internalRuntime = runtime as any;
          const surface = internalRuntime.surfaces.get(server.surfaceId);
          assert.ok(surface);
          assert.ok(surface.panes.size > 0);
          assert.equal(surface.hasPairedInGatewaySession, false);
          assert.equal(surface.sessionId, null);
          await waitFor(() => surface.windowLabel === "");
          assert.equal(internalRuntime.persistentState.windowLabels[server.surfaceId], undefined);
          await waitFor(async () => {
            try {
              const persisted = JSON.parse(
                await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
              );
              return persisted.windowLabels?.[server.surfaceId] === undefined;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return true;
            }
            throw error;
          }
        });

          const screens = await runtime.listScreens();

          assert.equal(screens.some((entry) => entry.fingerprint === server.surfaceId), false);
        },
      });
    });

  await t.test("failed pre-pair rows do not reserve visible window labels for later active surfaces", async () => {
      const stalePort = nextPort++;
      const activePort = nextPort++;
      const staleServer = new FakeSurfAceWsServer(stalePort, {
        surfaceId: "sf_stale_prepair",
      });
      const activeServer = new FakeSurfAceWsServer(activePort, {
        surfaceId: "sf_active_after_stale",
      });
      staleServer.busyWithoutTakeoverResponsesRemaining = 100;
      const staleEndpoint = discoveryEndpoint(stalePort, "aaaabbbb");
      const activeEndpoint = discoveryEndpoint(activePort, "ccccdddd");
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-prepair-window-label-"));
      const discovery = new StaticDiscoveryService([staleEndpoint]);
      const runtime = createSurfAceRuntime({ discovery, stateDir });

      try {
        await runtime.start();
        await waitFor(() => staleServer.pairRequests.length > 0, 12_000);
        const internalRuntime = runtime as any;
          const staleSurface = internalRuntime.surfaces.get(staleServer.surfaceId);
          assert.ok(staleSurface);
          assert.ok(staleSurface.panes.size > 0);

          discovery.setEndpoints([staleEndpoint, activeEndpoint]);
          await discovery.refreshNow();
          await waitFor(() => activeServer.pairedSocket !== null, 12_000);
          await waitFor(() => staleSurface.windowLabel === "");
          assert.equal(internalRuntime.persistentState.windowLabels[staleServer.surfaceId], undefined);

          const screens = await runtime.listScreens();
        assert.equal(screens.some((entry) => entry.fingerprint === staleServer.surfaceId), false);
        const activeScreen = screens.find((entry) => entry.fingerprint === activeServer.surfaceId);
        assert.ok(activeScreen);
        assert.equal(activeScreen.windowLabel, "a");
        assert.equal(activeServer.pairRequests[0]?.windowLabel, "a");
      } finally {
        await runtime.stop();
        await activeServer.close();
        await staleServer.close();
        await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("surfaces.list-only rows do not inherit stale persisted window labels before pair", async () => {
    const activePort = nextPort++;
    const stalePort = nextPort++;
    const activeServer = new FakeSurfAceWsServer(activePort, { surfaceId: "sf_active_before_stale_label" });
    const staleServer = new FakeSurfAceWsServer(stalePort, { surfaceId: "sf_surfaces_list_stale_label" });
    const activeEndpoint = discoveryEndpoint(activePort, "abcddcba");
    const staleEndpoint = discoveryEndpoint(stalePort, "dcbaabcd");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-surfaces-list-label-"));
    const discovery = new StaticDiscoveryService([activeEndpoint]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => activeServer.pairedSocket !== null, 12_000);
      const activeScreen = (await runtime.listScreens()).find((screen) => screen.fingerprint === activeServer.surfaceId);
      assert.ok(activeScreen);
      assert.equal(activeScreen.windowLabel, "a");

      const internalRuntime = runtime as any;
      internalRuntime.persistentState.windowLabels[staleServer.surfaceId] = "a";

      discovery.setEndpoints([activeEndpoint, staleEndpoint]);
      await discovery.refreshNow();
      await waitFor(() => staleServer.pairRequests.length > 0, 12_000);

      assert.equal(activeServer.pairRequests[0]?.windowLabel, "a");
      assert.equal(staleServer.pairRequests[0]?.windowLabel, "b");
      assert.notEqual(staleServer.pairRequests[0]?.windowLabel, activeScreen.windowLabel);
    } finally {
      await runtime.stop();
      await staleServer.close();
      await activeServer.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("discovery churn does not cull a previously paired disconnected surface", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      await surface.client.close(1000, "test_discovery_gap_after_drop");
      await waitFor(async () => {
        const screen = (await runtime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
        return screen ? screen.connectionState !== "connected" : false;
      }, 12_000);

      discovery.setEndpoints([]);
      await discovery.refreshNow();
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const screen = (await runtime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1]);
      assert.equal(surface.stopRequested, false);
    });
  });

  await t.test("passive list ignores persisted screen snapshots older than the active owner lease", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-stale-passive-snapshot-"));
    const now = Date.now();
    const runtime = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      now: () => now,
      stateDir,
    });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-owner.lock"),
        JSON.stringify(
          {
            controlPort: 0,
            lastActiveAt: now,
            pid: process.pid,
            startedAt: now,
          },
          null,
          2,
        ),
      );
        await fs.writeFile(
          path.join(stateDir, "surf-ace-runtime-screens.json"),
          JSON.stringify(
              {
                screens: [
                {
                _debug: {
                  autoRetryEnabled: true,
                  endpointId: "stale-endpoint",
                  hasPairedInGatewaySession: true,
                  ownershipRecovery: "active",
                  reconnectAttempt: 1100,
                  sessionId: "sa_stale_snapshot",
                  unreachableFailures: 1100,
                  wsOpen: false,
                },
                connectionState: "unreachable",
                fingerprint: "sf_stale_snapshot",
                lastSeenAt: now - 60_000,
                name: "Stale Snapshot",
                panes: [
                  {
                    activeContent: null,
                    historySummary: [],
                    name: null,
                    paneId: 1,
                    paneLabel: 1,
                    target: null,
                    viewport: {
                      height: 768,
                      scale: 2,
                      width: 1024,
                    },
                  },
                ],
                pendingEvents: 0,
                topology: null,
                topologyRevision: 0,
                viewport: {
                  height: 768,
                  scale: 2,
                  width: 1024,
                },
                windowLabel: "z",
              },
            ],
            updatedAt: now - 1,
            version: 1,
          },
          null,
          2,
        ),
      );

      const screens = await runtime.listScreens();

      assert.deepEqual(screens, []);
    } finally {
      await runtime.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive list keeps current snapshots after owner lease heartbeat refresh", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-current-passive-snapshot-"));
    const now = Date.now();
    const providerId = "pv_current_passive_snapshot";
    const sessionId = "sa_current_snapshot";
    const activeOwnerPid = process.ppid || process.pid;
    let observedExpectedProviderPid: number | null | undefined;
    const runtime = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      now: () => now,
      providerProcessHealth: (expectedProviderPid) => {
        observedExpectedProviderPid = expectedProviderPid;
        return {
          duplicateProviderProcesses: false,
          liveProviderProcessCount: 1,
          pids: [expectedProviderPid ?? -1],
          source: "injected",
        };
      },
      stateDir,
    });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            version: 1,
            windowLabels: {},
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-owner.lock"),
        JSON.stringify(
          {
            controlPort: 0,
            lastActiveAt: now,
            pid: activeOwnerPid,
            startedAt: now - 60_000,
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              {
	                _debug: {
	                  autoRetryEnabled: true,
	                  endpointId: "active-endpoint",
                  hasPairedInGatewaySession: true,
                  localOwnership: persistedLocalOwnership({
                    endpointId: "active-endpoint",
                    providerId,
                    sessionId,
                    surfaceId: "sf_current_snapshot",
                  }),
                  ownershipRecovery: "active",
                  reconnectAttempt: 0,
                  sessionId,
	                  unreachableFailures: 0,
	                  wsOpen: true,
	                },
	                authority: {
	                  actionable: false,
	                  admitted: false,
	                  blockers: ["provider_process_lease_mismatch"],
	                  reason: "provider_process_lease_mismatch",
	                },
	                connectionDiagnostics: {
	                  circuitOpen: false,
	                  circuitState: "closed",
	                  failureCount: 0,
	                  givenUp: false,
	                  openedAt: null,
	                  reason: "provider_process_lease_mismatch",
	                  reconnectAttempt: 0,
	                },
	                connectionState: "connected",
	                fingerprint: "sf_current_snapshot",
                lastSeenAt: now,
                name: "Current Snapshot",
                panes: [
                  {
                    activeContent: null,
                    historySummary: [],
                    name: null,
                    paneId: 1,
                    paneLabel: 1,
                    target: null,
                    viewport: {
                      height: 768,
                      scale: 2,
                      width: 1024,
                    },
                  },
                ],
                pendingEvents: 0,
                topology: null,
                topologyRevision: 0,
                viewport: {
                  height: 768,
                  scale: 2,
                  width: 1024,
                },
                windowLabel: "a",
              },
            ],
            updatedAt: now - 1,
            version: 1,
          },
          null,
          2,
        ),
      );

      const screens = await runtime.listScreens();

      assert.equal(screens.length, 1);
	      assert.equal(screens[0]?.fingerprint, "sf_current_snapshot");
	      assert.equal(screens[0]?.connectionState, "connecting");
	      assert.equal(screens[0]?.authority.actionable, false);
	      assert.equal(screens[0]?.authority.reason, "provider_process_lease_mismatch");
	      assert.deepEqual(screens[0]?.authority.blockers, ["provider_process_lease_mismatch"]);
	      assert.equal(screens[0]?.connectionDiagnostics.reason, null);
	      assert.equal(observedExpectedProviderPid, activeOwnerPid);
      assert.equal(screens[0]?._debug?.providerAuthorityProjection.providerProcessBlockReason, null);
    } finally {
      await runtime.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive list does not show persisted Cyberbrain-style records as connected without authority", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-cyberbrain-false-green-"));
    const now = Date.now();
    const providerId = "pv_cyberbrain_false_green";
    const sessionId = "sa_cyberbrain_false_green";
    const runtime = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      now: () => now,
      stateDir,
    });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            version: 1,
            windowLabels: {},
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-owner.lock"),
        JSON.stringify(
          {
            controlPort: 0,
            lastActiveAt: now,
            pid: process.pid,
            startedAt: now - 60_000,
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              {
                _debug: {
                  autoRetryEnabled: true,
                  endpointId: "cyberbrain-endpoint",
                  hasPairedInGatewaySession: true,
                  localOwnership: persistedLocalOwnership({
                    endpointId: "cyberbrain-endpoint",
                    providerId,
                    sessionId,
                    surfaceId: "sf_cyberbrain_persisted_only",
                  }),
                  ownershipRecovery: "active",
                  reconnectAttempt: 0,
                  sessionId,
                  unreachableFailures: 0,
                  wsOpen: false,
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
                fingerprint: "sf_cyberbrain_persisted_only",
                lastSeenAt: now,
                name: "Cyberbrain",
                panes: [],
                pendingEvents: 0,
                topology: null,
                topologyRevision: 0,
                viewport: { height: 768, scale: 2, width: 1024 },
                windowLabel: "c",
              },
            ],
            updatedAt: now - 1,
            version: 1,
          },
          null,
          2,
        ),
      );

      const screens = await runtime.listScreens();

      assert.equal(screens.length, 1);
      assert.equal(screens[0]?.fingerprint, "sf_cyberbrain_persisted_only");
      assert.equal(screens[0]?.connectionState, "connecting");
      assert.equal(screens[0]?.authority.actionable, false);
      assert.equal(screens[0]?.authority.reason, "persisted_authority_missing");
      assert.deepEqual(screens[0]?.authority.blockers, ["persisted_authority_missing"]);
    } finally {
      await runtime.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive list does not show authority-blocked persisted records as connected", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-authority-blocked-false-green-"));
    const now = Date.now();
    const providerId = "pv_authority_blocked_false_green";
    const sessionId = "sa_authority_blocked_false_green";
    const runtime = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      now: () => now,
      stateDir,
    });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            version: 1,
            windowLabels: {},
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-owner.lock"),
        JSON.stringify(
          {
            controlPort: 0,
            lastActiveAt: now,
            pid: process.pid,
            startedAt: now - 60_000,
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              {
                _debug: {
                  autoRetryEnabled: true,
                  endpointId: "blocked-endpoint",
                  hasPairedInGatewaySession: true,
                  localOwnership: persistedLocalOwnership({
                    endpointId: "blocked-endpoint",
                    providerId,
                    sessionId,
                    surfaceId: "sf_authority_blocked",
                  }),
                  ownershipRecovery: "active",
                  reconnectAttempt: 0,
                  sessionId,
                  unreachableFailures: 0,
                  wsOpen: false,
                },
                authority: {
                  actionable: false,
                  admitted: false,
                  blockers: ["not_provider_admitted", "not_connected", "socket_not_open", "no_visible_panes"],
                  reason: "not_provider_admitted",
                },
                connectionDiagnostics: {
                  circuitOpen: false,
                  circuitState: "closed",
                  failureCount: 0,
                  givenUp: false,
                  openedAt: null,
                  reason: "not_provider_admitted",
                  reconnectAttempt: 0,
                },
                connectionState: "connected",
                fingerprint: "sf_authority_blocked",
                lastSeenAt: now,
                name: "Aleph iPad",
                panes: [
                  {
                    activeContent: null,
                    historySummary: [],
                    name: null,
                    paneId: 1,
                    paneLabel: 1,
                    target: null,
                    viewport: { height: 768, scale: 2, width: 1024 },
                  },
                ],
                pendingEvents: 0,
                topology: { paneId: 1, type: "pane" },
                topologyRevision: 0,
                viewport: { height: 768, scale: 2, width: 1024 },
                windowLabel: "a",
              },
            ],
            updatedAt: now - 1,
            version: 1,
          },
          null,
          2,
        ),
      );

      const screens = await runtime.listScreens();

      assert.equal(screens.length, 1);
      assert.equal(screens[0]?.fingerprint, "sf_authority_blocked");
      assert.equal(screens[0]?.connectionState, "connecting");
      assert.equal(screens[0]?.authority.actionable, false);
      assert.equal(screens[0]?.authority.reason, "not_provider_admitted");
      assert.deepEqual(screens[0]?.authority.blockers, [
        "not_provider_admitted",
        "not_connected",
        "socket_not_open",
        "no_visible_panes",
      ]);
    } finally {
      await runtime.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("passive list rejects current snapshots without trusted local ownership provenance", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-untrusted-passive-snapshot-"));
    const now = Date.now();
    const providerId = "pv_untrusted_passive_snapshot";
    const sessionId = "sa_untrusted_snapshot";
    const runtime = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      now: () => now,
      stateDir,
    });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            version: 1,
            windowLabels: {},
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-owner.lock"),
        JSON.stringify(
          {
            controlPort: 0,
            lastActiveAt: now,
            pid: process.pid,
            startedAt: now - 60_000,
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              {
                _debug: {
                  endpointId: "legacy-endpoint",
                  hasPairedInGatewaySession: true,
                  sessionId,
                  wsOpen: true,
                },
                connectionState: "connected",
                fingerprint: "sf_legacy_untrusted",
                lastSeenAt: now,
                name: "Legacy Boolean Snapshot",
                panes: [],
                pendingEvents: 0,
                topology: null,
                topologyRevision: 0,
                viewport: { height: 768, scale: 2, width: 1024 },
                windowLabel: "a",
              },
              {
                _debug: {
                  endpointId: "foreign-endpoint",
                  hasPairedInGatewaySession: true,
                  localOwnership: persistedLocalOwnership({
                    endpointId: "foreign-endpoint",
                    providerId: "pv_foreign_provider",
                    sessionId,
                    surfaceId: "sf_foreign_untrusted",
                  }),
                  sessionId,
                  wsOpen: true,
                },
                connectionState: "connected",
                fingerprint: "sf_foreign_untrusted",
                lastSeenAt: now,
                name: "Foreign Boolean Snapshot",
                panes: [],
                pendingEvents: 0,
                topology: null,
                topologyRevision: 0,
                viewport: { height: 768, scale: 2, width: 1024 },
                windowLabel: "b",
              },
            ],
            updatedAt: now - 1,
            version: 1,
          },
          null,
          2,
        ),
      );

      assert.deepEqual(await runtime.listScreens(), []);
    } finally {
      await runtime.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("runtime lease refresh preserves owner startedAt and advances lastActiveAt", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-lease-started-at-"));
    let now = Date.now();
    const runtime = createSurfAceRuntime({
      discovery: new StaticDiscoveryService([]),
      now: () => now,
      stateDir,
    });

    try {
      await runtime.start();
      const leasePath = path.join(stateDir, "surf-ace-runtime-owner.lock");
      const firstLease = JSON.parse(await fs.readFile(leasePath, "utf8"));
      now += 60_000;
      await (runtime as any).refreshRuntimeLease();
      const refreshedLease = JSON.parse(await fs.readFile(leasePath, "utf8"));

      assert.equal(refreshedLease.startedAt, firstLease.startedAt);
      assert.equal(refreshedLease.lastActiveAt, now);
      assert.ok(refreshedLease.lastActiveAt > firstLease.lastActiveAt);
    } finally {
      await runtime.stop();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

    await t.test("brief reconnects preserve backoff until a connection has been stable for 30s", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      surface.reconnectAttempt = 4;
      surface.unreachableFailures = 2;
      surface.connectedAt = Date.now() - 5_000;
      internalRuntime.noteConnectionEnded(surface);
      assert.equal(surface.reconnectAttempt, 4);
      assert.equal(surface.unreachableFailures, 2);

      surface.reconnectAttempt = 4;
      surface.unreachableFailures = 2;
      surface.connectedAt = Date.now() - 31_000;
      internalRuntime.noteConnectionEnded(surface);
      assert.equal(surface.reconnectAttempt, 0);
      assert.equal(surface.unreachableFailures, 0);
    });
    });

  await t.test("surf_ace_list exposes open connection circuit diagnostics under duration pressure", async () => {
    await withRuntimeHarness(async ({ runtime, server, stateDir }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      surface.unreachableFailures = 3;
      internalRuntime.noteSurfaceConnectionFailure(surface, "test open circuit");
      await waitFor(async () => {
        try {
          const raw = await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8");
          const snapshot = JSON.parse(raw) as { screens: Array<{ connectionDiagnostics?: { circuitState?: string } }> };
          return snapshot.screens.some((entry) => entry.connectionDiagnostics?.circuitState === "given_up");
        } catch {
          return false;
        }
      }, 12_000);
      let screen = (await runtime.listScreens())[0];
      assert.equal(screen?.connectionDiagnostics.circuitState, "given_up");
      assert.equal(screen?.connectionDiagnostics.circuitOpen, true);
      assert.equal(screen?.connectionDiagnostics.givenUp, true);
      assert.equal(screen?._debug?.connectionCircuit.circuitState, "given_up");
      assert.equal(screen?._debug?.autoRetryEnabled, false);

      const passiveRuntime = createSurfAceRuntime({
        discovery: new StaticDiscoveryService([]),
        stateDir,
      });
      try {
        await passiveRuntime.start();
        const passiveScreen = (await passiveRuntime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
        assert.equal(passiveScreen?.connectionDiagnostics.circuitState, "given_up");
        assert.equal(passiveScreen?.connectionDiagnostics.circuitOpen, true);
        assert.equal(passiveScreen?.connectionDiagnostics.givenUp, true);
      } finally {
        await passiveRuntime.stop();
      }

      surface.unreachableFailures = 6;
      internalRuntime.noteSurfaceConnectionFailure(surface, "test duration pressure");
      screen = (await runtime.listScreens())[0];
      assert.equal(screen?.connectionDiagnostics.circuitState, "given_up");
      assert.equal(screen?.connectionDiagnostics.givenUp, true);
      assert.equal(screen?._debug?.autoRetryEnabled, false);
    });
  });

  await t.test("operator reattempt-connections resets open circuit state and wakes retry", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      surface.unreachableFailures = 6;
      internalRuntime.noteSurfaceConnectionFailure(surface, "test duration pressure");
      const result = await runtime.reattemptConnections({ fingerprint: server.surfaceId });
      assert.equal(result.surfaces[0]?.fingerprint, server.surfaceId);
      assert.equal(result.surfaces[0]?.circuitState, "given_up");
      assert.equal(surface.autoRetryEnabled, true);
      assert.equal(surface.reconnectAttempt, 0);
      assert.equal(surface.unreachableFailures, 0);
      assert.equal(surface.connectionCircuitOpenedAt, null);
    });
  });

  await t.test("operator reattempt-connections clears stale invalid_resume session before retry", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.equal(surface.sessionId, "sa_test_session");

      surface.unreachableFailures = 6;
      internalRuntime.noteSurfaceConnectionFailure(surface, "SurfAceToolError: Resume session did not match active ownership lock");
      const result = await runtime.reattemptConnections({ fingerprint: server.surfaceId });

      assert.equal(result.surfaces[0]?.fingerprint, server.surfaceId);
      assert.equal(result.surfaces[0]?.circuitState, "given_up");
      assert.equal(surface.sessionId, null);
      assert.equal(surface.hasPairedInGatewaySession, false);
      assert.equal(surface.localOwnership, null);
      assert.equal(surface.connectionCircuitOpenedAt, null);
      assert.equal(surface.autoRetryEnabled, true);
    });
  });

  await t.test("operator reattempt-connections republishes same-provider authority after window label mismatch", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.rejectAuthorityState = true;
        server.rejectAuthorityStateReason = "window_label_mismatch";
      },
      waitForAuthority: false,
      run: async ({ runtime, server }) => {
        await waitFor(() => server.authorityStateRequests.some((request) => request.actionable), 12_000);

        let screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        assert.equal(screen.connectionState, "connecting");
        assert.equal(screen.authority.actionable, false);
        assert.equal(screen.authority.reason, "window_label_mismatch");

        const authorityCountBeforeReattempt = server.authorityStateRequests.length;
        server.rejectAuthorityState = false;

        const result = await runtime.reattemptConnections({ fingerprint: server.surfaceId });
        assert.equal(result.surfaces[0]?.fingerprint, server.surfaceId);
        await waitFor(() => server.authorityStateRequests.length > authorityCountBeforeReattempt, 12_000);

        screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
        assert.ok(screen);
        assert.equal(screen.connectionState, "connected");
        assert.equal(screen.authority.actionable, true);
        assert.equal(screen.authority.reason, null);
        assert.equal(screen.authority.blockers.length, 0);
      },
    });
  });

  await t.test("operator reattempt-all suppresses endpoint probes covered by owned workers", async () => {
    await withRuntimeHarness(async ({ infos, runtime, server }) => {
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);
      const internalRuntime = runtime as any;
      const probe = [...internalRuntime.endpointProbes.values()][0];
      assert.ok(probe);
      const probeAttemptsBeforeReattempt = infos.filter((message) => message.includes("endpoint_probe_attempt")).length;
      server.maxConcurrentSocketCount = server.activeSocketCount;

      const result = await runtime.reattemptConnections();
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      const probeAttemptsAfterReattempt = infos.filter((message) => message.includes("endpoint_probe_attempt")).length;
      assert.equal(result.surfaces.some((entry) => entry.fingerprint === server.surfaceId), true);
      assert.deepEqual(result.endpointProbes, []);
      assert.equal(probeAttemptsAfterReattempt, probeAttemptsBeforeReattempt);
      assert.equal(server.maxConcurrentSocketCount, 1);
      assert.equal(probe.stopRequested, true);
    });
  });

  await t.test("operator reattempt-all removes stale accepted surfaces before waking workers", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const staleSurfaceId = "surface-stale-reattempt";
      const staleEndpointId = "endpoint-stale-reattempt";
      const staleSurface = {
        ...surface,
        surfaceId: staleSurfaceId,
        endpointId: staleEndpointId,
        endpoint: {
          ...surface.endpoint,
          endpointId: staleEndpointId,
          name: "stale reattempt",
          port: surface.endpoint.port + 1,
        },
        client: null,
        connectionCircuitOpenedAt: Date.now(),
        connectionCircuitReason: "test missing discovery reattempt",
        connectionState: "unreachable",
        localOwnership: {
          ...surface.localOwnership,
          surfaceId: staleSurfaceId,
        },
        panes: new Map(surface.panes),
        stopRequested: false,
        unreachableFailures: 5,
        workPromise: null,
      };

      discovery.setEndpoints([]);
      await discovery.refreshNow();
      internalRuntime.surfaces.set(staleSurfaceId, staleSurface);

      const result = await runtime.reattemptConnections();

      assert.equal(result.surfaces.some((entry) => entry.fingerprint === staleSurfaceId), false);
      assert.equal(internalRuntime.surfaces.has(staleSurfaceId), false);
    });
  });

    await t.test("resume failures keep the owner session state intact", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      surface.reconnectAttempt = 3;
      internalRuntime.noteResumeFailure(surface);
      internalRuntime.noteResumeFailure(surface);
      internalRuntime.noteResumeFailure(surface);
      assert.equal(surface.reconnectAttempt, 3);
      assert.equal(surface.sessionId, "sa_test_session");
      assert.ok(
        warnings.some((warning) =>
          warning.includes("owner resume still failing") && warning.includes(server.surfaceId),
        ),
      );
    });
  });

  await t.test("ownership.relinquish disables auto-retry and clears local ownership state", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const result = await runtime.relinquish({ fingerprint: server.surfaceId });
      assert.deepEqual(result, { relinquished: true });

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      await waitFor(() => surface.workPromise === null, 3_000);
      assert.equal(surface.autoRetryEnabled, false);
      assert.equal(surface.connectionState, "unreachable");
      assert.equal(surface.hasPairedInGatewaySession, false);
      assert.equal(surface.sessionId, null);
      assert.equal(server.pairedSocket, null);
      assert.equal(
        typeof internalRuntime.persistentState.selfOwnedSurfaceIds?.[server.surfaceId]?.relinquishedAt,
        "number",
      );

      internalRuntime.resetSurfaceConnectionCircuit(surface, "endpoint changed");
      internalRuntime.ensureSurfaceWorker(surface);
      assert.equal(surface.autoRetryEnabled, false);
      assert.equal(surface.stopRequested, true);
      assert.equal(surface.workPromise, null);

      await runtime.reattemptConnections({ fingerprint: server.surfaceId });
      assert.equal(surface.autoRetryEnabled, false);
      assert.equal(surface.stopRequested, true);
      assert.equal(surface.workPromise, null);
    });
  });

  await t.test("ownership.relinquish records tombstone without prior self-owned entry", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      delete internalRuntime.persistentState.selfOwnedSurfaceIds?.[server.surfaceId];

      const result = await runtime.relinquish({ fingerprint: server.surfaceId });
      assert.deepEqual(result, { relinquished: true });

      const tombstone = internalRuntime.persistentState.selfOwnedSurfaceIds?.[server.surfaceId];
      assert.equal(tombstone?.providerId, internalRuntime.persistentState.providerId);
      assert.equal(tombstone?.source, "current_local_ownership");
      assert.equal(typeof tombstone?.relinquishedAt, "number");
    });
  });

  await t.test("operator reattempt-connections returns empty result for unknown fingerprint", async () => {
    await withRuntimeHarness(async ({ runtime }) => {
      const result = await runtime.reattemptConnections({ fingerprint: "sf_missing_reattempt" });
      assert.deepEqual(result, {
        endpointProbes: [],
        surfaces: [],
      });
    });
  });

  await t.test("known self-owned busy reconnect self-reclaims with stable provider identity", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      const initialProviderId = server.pairAttemptDetails[0]?.providerId;
      assert.equal(typeof initialProviderId, "string");
      server.busyWithoutTakeoverResponsesRemaining = 1;

      await surface.client.close(1000, "test_busy_self_reclaim_identity");

      await waitFor(
        () =>
          server.pairAttemptDetails.length >= 2 &&
          surface.sessionId === "sa_test_session" &&
          surface.hasPairedInGatewaySession,
        12_000,
      );
      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);

      const reconnectAttempts = server.pairAttemptDetails.slice(1);
      assert.deepEqual(
        reconnectAttempts.slice(0, 2).map((attempt) => attempt.providerId),
        [initialProviderId, initialProviderId],
      );
      assert.deepEqual(
        reconnectAttempts.slice(0, 2).map((attempt) => attempt.takeover),
        [false, true],
      );
      assert.ok(
        warnings.some((warning) => warning.includes("ownership_self_reclaim")),
      );
    });
  });

  await t.test("known self-owned reclaim latch blocks repeated takeover", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      surface.selfOwnershipReclaimAttempted = true;
      const response = {
        error: {
          code: "busy",
          message: "Surface remained paired after self reclaim",
        },
        id: "rq_repeat_self_reclaim",
        ok: false,
        op: "pair.request",
        sentAt: Date.now(),
        type: "response",
        v: 1,
      };
      let takeoverRequests = 0;

      const recovered = await internalRuntime.maybeRecoverKnownSelfOwnershipLock(
        surface,
        response,
        null,
        async (takeover: boolean) => {
          if (takeover) {
            takeoverRequests += 1;
          }
          return response;
        },
      );

      assert.equal(recovered, response);
      assert.equal(takeoverRequests, 0);
      assert.ok(
        warnings.some((warning) => warning.includes("ownership_self_reclaim_blocked")),
      );
    });
  });

  await t.test("operator reattempt resets known self-owned reclaim latch", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      surface.selfOwnershipReclaimAttempted = true;
      await runtime.reattemptConnections({ fingerprint: server.surfaceId });
      assert.equal(surface.selfOwnershipReclaimAttempted, false);

      const response = {
        error: {
          code: "busy",
          message: "Surface remained paired after self reclaim",
        },
        id: "rq_operator_retry_self_reclaim",
        ok: false,
        op: "pair.request",
        sentAt: Date.now(),
        type: "response",
        v: 1,
      };
      let takeoverRequests = 0;

      await internalRuntime.maybeRecoverKnownSelfOwnershipLock(
        surface,
        response,
        null,
        async (takeover: boolean) => {
          if (takeover) {
            takeoverRequests += 1;
          }
          return response;
        },
      );

      assert.equal(takeoverRequests, 1);
      assert.equal(surface.selfOwnershipReclaimAttempted, true);
    });
  });

  await t.test("known self-owned reclaim latch resets after transport failure", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      const response = {
        error: {
          code: "busy",
          message: "Surface is already paired",
        },
        id: "rq_transport_failed_self_reclaim",
        ok: false,
        op: "pair.request",
        sentAt: Date.now(),
        type: "response",
        v: 1,
      };
      let takeoverRequests = 0;

      await assert.rejects(
        async () =>
          await internalRuntime.maybeRecoverKnownSelfOwnershipLock(
            surface,
            response,
            null,
            async (takeover: boolean) => {
              if (takeover) {
                takeoverRequests += 1;
              }
              throw new Error("socket closed before reclaim response");
            },
          ),
        /socket closed before reclaim response/,
      );

      assert.equal(takeoverRequests, 1);
      assert.equal(surface.selfOwnershipReclaimAttempted, false);
    });
  });

  await t.test("stored self ownership must match trusted provider lineage before self-reclaim", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      surface.sessionId = null;
      surface.hasPairedInGatewaySession = false;
      internalRuntime.persistentState.selfOwnedSurfaceIds[server.surfaceId] = {
        observedAt: Date.now(),
        providerId: "pv_untrusted_previous_owner",
        source: "current_local_ownership",
      };
      assert.equal(internalRuntime.isKnownSelfOwnedSurface(surface), false);

      internalRuntime.persistentState.providerLineage.push({
        observedAt: Date.now(),
        providerId: "pv_untrusted_previous_owner",
        source: "legacy_state_root",
      });
      assert.equal(internalRuntime.isKnownSelfOwnedSurface(surface), true);

      internalRuntime.persistentState.selfOwnedSurfaceIds[server.surfaceId] = {
        observedAt: Date.now(),
        providerId: "pv_untrusted_previous_owner",
        relinquishedAt: Date.now(),
        source: "current_local_ownership",
      };
      surface.remotePaired = true;
      assert.equal(internalRuntime.isKnownSelfOwnedSurface(surface), true);
    });
  });

  await t.test("known self-owned invalid_resume with an active resume token does not force a takeover", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      const initialProviderId = server.pairAttemptDetails[0]?.providerId;
      assert.equal(typeof initialProviderId, "string");
      server.lockUntilNewProviderIdCode = "invalid_resume";
      server.lockUntilNewProviderIdProviderId = initialProviderId ?? null;

      await surface.client.close(1000, "test_invalid_resume_self_reclaim_identity");

      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(
        () => warnings.some((warning) => warning.includes("ownership_self_reclaim_blocked")),
        12_000,
      );

      const reconnectAttempts = server.pairAttemptDetails.slice(1);
      assert.deepEqual(
        reconnectAttempts.slice(0, 1).map((attempt) => attempt.providerId),
        [initialProviderId],
      );
      assert.deepEqual(
        reconnectAttempts.slice(0, 1).map((attempt) => attempt.takeover),
        [false],
      );
      assert.ok(reconnectAttempts.every((attempt) => attempt.takeover !== true));
    });
  });

  await t.test("connect refusal refresh does not rebind by single fingerprint prefix", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server, warnings }) => {
      const replacementPort = nextPort++;
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const originalEndpointId = surface.endpointId;
      const sharedFingerprint = surface.fingerprintPrefix;
      assert.ok(sharedFingerprint);

      discovery.setEndpoints([discoveryEndpoint(replacementPort, sharedFingerprint)]);
      await internalRuntime.refreshEndpointAfterConnectFailure(surface, new Error("ECONNREFUSED"));

      assert.equal(surface.endpointId, originalEndpointId);
      assert.ok(
        warnings.some((warning) =>
          warning.includes("not refreshing stale endpoint") &&
          warning.includes("discovery-only") &&
          warning.includes("matched 1 endpoint")),
      );
    });
  });

  await t.test("endpoint url changes reset backoff and wake a sleeping worker immediately", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const replacementPort = nextPort++;
      const replacementServer = new FakeSurfAceWsServer(replacementPort);

      try {
        const internalRuntime = runtime as any;
        const originalSurface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(originalSurface);
        assert.ok(originalSurface.client);
        const originalEndpointId = originalSurface.endpointId;

        await originalSurface.client.close(1000, "test_endpoint_url_change_wake");
        await server.close();

        await waitFor(() => originalSurface.reconnectAttempt >= 1, 12_000);
        originalSurface.reconnectAttempt = 4;
        originalSurface.unreachableFailures = 3;

        internalRuntime.refreshEndpointTopology({
          ...discoveryEndpoint(replacementPort),
          endpointId: originalSurface.endpointId,
        });

        assert.equal(originalSurface.endpointId, originalEndpointId);
        assert.equal(originalSurface.reconnectAttempt, 0);
        assert.equal(originalSurface.unreachableFailures, 0);

        await waitFor(() => replacementServer.pairedSocket !== null, 3_000);
        await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 3_000);
      } finally {
        await replacementServer.close();
      }
    });
  });

  await t.test("fingerprint identity does not rebind live paired surface on endpoint alias churn", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const replacementPort = nextPort++;
      const replacementServer = new FakeSurfAceWsServer(replacementPort);

      try {
        const internalRuntime = runtime as any;
        const originalSurface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(originalSurface);
        assert.ok(originalSurface.client?.isOpen());
        const originalEndpointId = originalSurface.endpointId;

        internalRuntime.refreshEndpointTopology({
          ...discoveryEndpoint(replacementPort, originalSurface.fingerprintPrefix),
          endpointId: `endpoint-${replacementPort}`,
        });

        assert.equal(internalRuntime.surfaces.get(server.surfaceId), originalSurface);
        assert.equal(originalSurface.endpointId, originalEndpointId);
        assert.equal(originalSurface.client?.isOpen(), true);
      } finally {
        await replacementServer.close();
      }
    });
  });

  await t.test("same websocket url with different fingerprint is not treated as the same provider", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const originalSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(originalSurface);
      assert.ok(originalSurface.client?.isOpen());
      const originalEndpointId = originalSurface.endpointId;

      const simulatorEndpoint = {
        ...discoveryEndpoint(server.port, "sim12345"),
        endpointId: `endpoint-${server.port}-sim12345`,
        name: "Surf Ace - simulator proof",
      };
      internalRuntime.refreshEndpointTopology(simulatorEndpoint);

      assert.equal(internalRuntime.surfaces.get(server.surfaceId), originalSurface);
      assert.equal(originalSurface.endpointId, originalEndpointId);
      assert.equal(originalSurface.fingerprintPrefix, "abcd1234");
      assert.ok(internalRuntime.endpointProbes.get(simulatorEndpoint.endpointId));
    });
  });

  await t.test("connect-failure refresh does not rebind by ambiguous fingerprint prefix", async () => {
    await withRuntimeHarness(async ({ discovery, runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const originalEndpointId = surface.endpointId;
      const sharedFingerprint = surface.fingerprintPrefix;
      assert.ok(sharedFingerprint);

      discovery.setEndpoints([
        discoveryEndpoint(nextPort++, sharedFingerprint),
        discoveryEndpoint(nextPort++, sharedFingerprint),
      ]);

      await internalRuntime.refreshEndpointAfterConnectFailure(surface, new Error("ECONNREFUSED"));

      assert.equal(surface.endpointId, originalEndpointId);
        assert.ok(
          warnings.some((warning) =>
            warning.includes("not refreshing stale endpoint") &&
            warning.includes("matched 2 endpoints")),
        );
    });
  });

  await t.test("discovery does not reuse a stopped surface id when the endpoint reappears", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const originalSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(originalSurface);

      originalSurface.stopRequested = true;
      internalRuntime.refreshEndpointTopology(structuredClone(originalSurface.endpoint));

      assert.equal(internalRuntime.surfaces.has(server.surfaceId), false);
      const replacementProbe = internalRuntime.endpointProbes.get(originalSurface.endpointId);
      assert.ok(replacementProbe);
      assert.notEqual(replacementProbe, originalSurface);
      assert.equal(replacementProbe.stopRequested, false);
      assert.equal("surfaceId" in replacementProbe, false);
      assert.equal("panes" in replacementProbe, false);
    });
  });

  await t.test("pair response replaces stale local panes from prior sessions", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      internalRuntime.applyPairState(surface, {
        id: "rq_repair",
        ok: true,
        op: "pair.request",
        payload: {
          capabilities: {
            contentTypes: ["html", "image", "pdf", "terminal", "markdown"],
            eventTypes: [],
            protocolFeatures: ["authority.state.v1"],
          },
          eventConfig: {
            activeEvents: [],
            drawingFlushConfig: {
              idleWindowMs: 8000,
              maxIntervalMs: 30000,
            },
            profile: "minimum_deep",
          },
          limits: {
            maxDrawingFlushBytes: 2 * 1024 * 1024,
            maxFrameBytes: 10 * 1024 * 1024,
            maxMessageBytes: 12 * 1024 * 1024,
            maxStrokePointsPerFlush: 8192,
            maxVisibleTextBytes: 4096,
            resumeGraceMs: 20_000,
          },
          resumed: false,
          sessionId: "sa_repaired",
          state: {
            layout: { paneId: server.initialRemotePaneId, type: "pane" },
	                panes: [
	                  {
	                    contentType: null,
	                    currentContentId: null,
	                    currentRevision: 0,
                paneId: server.initialRemotePaneId,
                paneLabel: 1,
              },
            ],
            topologyRevision: 0,
          },
          surfaceId: server.surfaceId,
          surfaceName: "Surface A",
          viewport: { height: 768, scale: 2, width: 1024 },
        },
        sentAt: Date.now(),
        type: "response",
        v: 1,
      });

      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1]);
    });
  });

  await t.test("pair response publishes topology when global pane label differs from client label", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.addSurface({
          initialPaneLabel: 1,
          initialRemotePaneId: 42,
          name: "Surface B",
          surfaceId: "sf_surface-b",
        });
      },
      run: async ({ runtime, server }) => {
        await waitFor(() =>
          server.topologyApplyRequests.some((request) =>
            request.paneIds.includes(42) &&
            request.paneLabels.includes(2),
          ),
        );

        await waitFor(async () => {
          const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === "sf_surface-b");
          return screen?.authority.actionable === true;
        });
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === "sf_surface-b");
        assert.ok(screen);
        assertPaneLabelsWithOpaqueIds(screen.panes, [2]);
      },
    });
  });

  await t.test("blank single-pane pair does not collapse trusted multi-pane local topology", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const paneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);
      await runtime.push({
        content: "<main>restore continuity marker</main>",
        contentType: "html",
        fingerprint: server.surfaceId,
        paneId: paneIds[1]!,
      });
      surface.topologyRevision = 5;

      internalRuntime.applyPairPaneState(
        surface,
        [
          {
            contentType: null,
            currentContentId: null,
            currentRevision: 0,
            paneId: server.initialRemotePaneId,
            paneLabel: 1,
          },
        ],
        false,
        {
          ignoreEmptyPairContentAuthority: true,
          pairStateLayout: { paneId: server.initialRemotePaneId, type: "pane" },
          pairStateTopologyRevision: 100,
          pruneStalePanes: true,
        },
      );

      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1, 2]);
      assert.equal(surface.topologyRevision, 5);
      assert.equal(surface.layout?.type, "split");
    });
  });

  await t.test("full pair response rebinds restored provider panes before topology publish", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const paneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);
      const pushed = [];
      for (const paneId of paneIds) {
        pushed.push(await runtime.push({
          content: `<main>T338 restored pane ${paneId}</main>`,
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: paneId!,
        }));
      }

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const panes = paneIds.map((paneId) => surface.panes.get(paneId!));
      assert.equal(panes.every(Boolean), true);
      const originalRemoteIds = panes.map((pane) => Number(pane.remotePaneId));
      const originalPaneIds = panes.map((pane) => pane.paneId);
      for (const [index, pane] of panes.entries()) {
        pane.remotePaneId = 9001 + index;
      }
      surface.topologyRevision = 42;
      internalRuntime.restartTopologyRestoredSurfaceIds.add(server.surfaceId);

      internalRuntime.applyPairState(surface, {
        id: "rq_full_pair_rebind_restored_provider_panes",
        ok: true,
        op: "pair.request",
        payload: {
          capabilities: {
            contentTypes: ["html", "image", "pdf", "terminal", "markdown"],
            eventTypes: [],
            protocolFeatures: ["authority.state.v1"],
            targetCapabilities: server.targetCapabilities,
          },
          eventConfig: {
            activeEvents: [],
            drawingFlushConfig: {
              idleWindowMs: 8000,
              maxIntervalMs: 30000,
            },
            profile: "minimum_deep",
          },
          limits: {
            maxDrawingFlushBytes: 2 * 1024 * 1024,
            maxFrameBytes: 10 * 1024 * 1024,
            maxMessageBytes: 12 * 1024 * 1024,
            maxStrokePointsPerFlush: 8192,
            maxVisibleTextBytes: 4096,
            resumeGraceMs: 20_000,
          },
          ownershipEpoch: surface.ownershipEpoch,
          resumed: true,
          sessionId: surface.sessionId ?? "sa_test_session",
          state: {
            layout: {
              children: originalRemoteIds.map((paneId) => ({ paneId, type: "pane" as const })),
              direction: "vertical",
              type: "split",
            },
            panes: originalRemoteIds.map((remotePaneId, index) => ({
              contentType: "html" as const,
              currentContentId: pushed[index]!.contentId,
              currentRevision: pushed[index]!.revision,
              paneId: remotePaneId,
              paneLabel: index + 1,
              paneLineageId: panes[index]!.paneLineageId,
            })),
            topologyRevision: 42,
          },
          surfaceId: server.surfaceId,
          surfaceName: surface.name,
          viewport: surface.viewport,
        },
        sentAt: Date.now(),
        type: "response",
        v: 1,
      });

      const reboundPanes = originalPaneIds.map((paneId) => surface.panes.get(paneId));
      assert.equal(reboundPanes.every(Boolean), true);
      assert.deepEqual(reboundPanes.map((pane) => Number(pane.remotePaneId)), originalRemoteIds);
      assert.deepEqual(reboundPanes.map((pane) => pane.activeContentId), pushed.map((result) => result.contentId));
      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 2, 3]);
      assert.deepEqual(
        screens[0]?.panes.map((pane) => pane.activeContent?.contentId),
        pushed.map((result) => result.contentId),
      );
      assert.deepEqual(
        screens[0]?.panes.map((pane) => pane.target?.blockedReason ?? null),
        [null, null, null],
      );
      for (const pane of reboundPanes) {
        assert.equal(pane?.lastRestoreBlockedReason, null);
        assert.ok(pane?.currentTargetId);
        const target = surface.targetRecords.get(pane.currentTargetId);
        assert.equal(target?.currentState, "current");
      }

      server.nextContentApplyError = {
        code: "stale_revision",
        details: { expectedRevision: Number(reboundPanes[0]?.currentRevision ?? 0) },
        message: "provider already has restored content",
      };
      await (runtime as any).repushSurfaceContent(surface);
      const retainedPane = reboundPanes[0];
      assert.ok(retainedPane?.currentTargetId);
      assert.equal(retainedPane.lastRestoreBlockedReason, null);
      assert.equal(surface.targetRecords.get(retainedPane.currentTargetId)?.currentState, "current");
    });
  });

  await t.test("pair response publishes topology for multi-pane label repair before authority", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.addSurface({
          initialPaneLabel: 1,
          initialRemotePaneId: 42,
          name: "Surface B",
          surfaceId: "sf_surface-b",
        });
        const surface = (server as unknown as { surfaces: Map<string, TestSurfaceState> }).surfaces.get("sf_surface-b");
        assert.ok(surface);
        surface.panes.set(43, {
          contentId: null,
          contentType: null,
          drawings: [],
          frame: { height: 768, width: 512, x: 512, y: 0 },
          name: null,
          paneLabel: 2,
          paneLineageId: "pl_sf_surface-b_43",
          revision: 0,
          viewport: {
            height: 768,
            scale: 2,
            width: 512,
          },
        });
        server.setTopologyLayout(
          {
            children: [
              { paneId: 42, type: "pane" },
              { paneId: 43, type: "pane" },
            ],
            direction: "vertical",
            type: "split",
          },
          0,
          "sf_surface-b",
        );
      },
      run: async ({ runtime, server }) => {
        await waitFor(() => server.pairedSocketFor("sf_surface-b") !== null);
        await waitFor(() =>
          server.topologyApplyRequests.some((request) =>
            request.paneIds.includes(42) &&
            request.paneIds.includes(43) &&
            request.paneLabels.includes(2) &&
            request.paneLabels.includes(3)
          ),
        );
        const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === "sf_surface-b");
        assert.ok(screen);
        assert.deepEqual(screen.panes.map((pane) => pane.paneLabel).sort((left, right) => left - right), [2, 3]);
        const authorityState = server.authorityStateRequests.findLast((request) =>
          request.surfaceId === "sf_surface-b" && request.actionable
        );
        assert.ok(authorityState);
        assert.deepEqual(authorityState.paneLabels.sort((left, right) => left - right), [2, 3]);
      },
    });
  });

  await t.test("pair response rechecks single-pane label repair after pane-list reconciliation", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.addSurface({
          initialPaneLabel: 1,
          initialRemotePaneId: 42,
          name: "Surface B",
          surfaceId: "sf_surface-b",
        });
        server.addPaneAfterPairResponse = {
          paneId: 43,
          paneLabel: 2,
          surfaceId: "sf_surface-b",
        };
      },
      run: async ({ server }) => {
        await waitFor(() => server.pairedSocketFor("sf_surface-b") !== null);
        await waitFor(() => server.panesListRequests > 0);
        await waitFor(() =>
          server.topologyApplyRequests.some((request) =>
            request.windowLabel === "b" &&
            (request.paneIds.includes(42) || request.paneIds.includes(43)),
          ),
        );
      },
    });
  });

  await t.test("orphaned non-layout panes are not exposed or targetable after split", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const visiblePaneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const sourcePane = surface.panes.get(visiblePaneIds[0]);
      assert.ok(sourcePane);
      const orphanPane = structuredClone(sourcePane);
      orphanPane.paneId = internalRuntime.allocatePaneId();
      orphanPane.remotePaneId = 9999;
      orphanPane.paneLabel = 99;
      orphanPane.paneLineageId = "pl_orphan_non_layout";
      surface.panes.set(orphanPane.paneId, orphanPane);

      const screens = await runtime.listScreens();
      assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 2]);
      assert.equal(screens[0]?.panes.some((pane) => pane.paneId === orphanPane.paneId), false);

      const contentSetCount = server.contentSetRequests.length;
      await assert.rejects(
        runtime.push({
          content: "# stale pane",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: orphanPane.paneId,
        }),
        /Unknown Surf Ace pane/,
      );
      assert.equal(server.contentSetRequests.length, contentSetCount);

      await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: visiblePaneIds[0],
      });
      assert.equal(server.topologyApplyRequests.at(-1)?.paneIds.includes(9999), false);
    });
  });

  await t.test("close counts accepted visible topology panes instead of stale local panes", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 2,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      const visiblePaneIds = assertPaneLabelsWithOpaqueIds(split, [1, 2]);

      await runtime.closePane({
        fingerprint: server.surfaceId,
        paneId: visiblePaneIds[1]!,
      });
      const topologyApplyCount = server.topologyApplyRequests.length;

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const sourcePane = surface.panes.get(visiblePaneIds[0]!);
      assert.ok(sourcePane);
      const orphanPane = structuredClone(sourcePane);
      orphanPane.paneId = internalRuntime.allocatePaneId();
      orphanPane.remotePaneId = 9999;
      orphanPane.paneLabel = 99;
      orphanPane.paneLineageId = "pl_close_orphan_non_layout";
      surface.panes.set(orphanPane.paneId, orphanPane);

      await assert.rejects(
        runtime.closePane({
          fingerprint: server.surfaceId,
          paneId: visiblePaneIds[0]!,
        }),
        /Cannot close the last remaining pane/,
      );
      assert.equal(server.topologyApplyRequests.length, topologyApplyCount);
    });
  });

  await t.test("pre-revision panes.list panes are reconciled into layout before close", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.equal(surface.topologyRevision, 0);
      assert.deepEqual(surface.layout, { paneId: firstPaneId, type: "pane" });

      const firstRemotePane = server.panes.get(server.initialRemotePaneId);
      assert.ok(firstRemotePane);
      firstRemotePane.frame = { height: 384, width: 1024, x: 0, y: 0 };
      firstRemotePane.viewport = { height: 384, scale: 2, width: 1024 };
      server.panes.set(9999, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 384, width: 1024, x: 0, y: 384 },
        name: null,
        paneLabel: 99,
        paneLineageId: "pl_orphan_pre_revision",
        revision: 0,
        viewport: {
          height: 384,
          scale: 2,
          width: 1024,
        },
      });
      await internalRuntime.syncRemotePaneList(surface);

      const screens = await runtime.listScreens();
      const paneIds = assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 99]);
      assert.deepEqual(surface.layout, {
        children: [
          { paneId: paneIds[0], type: "pane" },
          { paneId: paneIds[1], type: "pane" },
        ],
        direction: "horizontal",
        type: "split",
      });

      const closed = await runtime.closePane({
        fingerprint: server.surfaceId,
        paneId: paneIds[1]!,
      });
      assert.equal(closed.ok, true);
      assert.equal(closed.paneLabel, 99);
      assert.equal(server.topologyApplyRequests.at(-1)?.paneIds.includes(9999), false);

      const after = (await runtime.listScreens())[0]!;
      assert.equal(after.topologyRevision, 1);
      assertPaneLabelsWithOpaqueIds(after.panes, [1]);
    });
  });

  await t.test("pre-revision pair response panes adopt provider geometry from panes.list", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        const firstRemotePane = server.panes.get(server.initialRemotePaneId);
        assert.ok(firstRemotePane);
        firstRemotePane.frame = { height: 768, width: 512, x: 0, y: 0 };
        firstRemotePane.viewport = { height: 768, scale: 2, width: 512 };
        server.panes.set(9999, {
          contentId: null,
          contentType: null,
          drawings: [],
          frame: { height: 768, width: 512, x: 512, y: 0 },
          name: null,
          paneLabel: 99,
          paneLineageId: "pl_pair_response_pre_revision",
          revision: 0,
          viewport: {
            height: 768,
            scale: 2,
            width: 512,
          },
        });
        server.setTopologyLayout(
          {
            children: [
              { paneId: server.initialRemotePaneId, type: "pane" },
              { paneId: 9999, type: "pane" },
            ],
            direction: "vertical",
            type: "split",
          },
          0,
        );
      },
      run: async ({ runtime, server }) => {
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);

        await waitFor(async () => {
          await internalRuntime.syncRemotePaneList(surface);
          return surface.layout?.type === "split" && surface.layout.direction === "vertical";
        });

        const screens = await runtime.listScreens();
        const paneIds = assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 99]);
        assert.deepEqual(surface.layout, {
          children: [
            { paneId: paneIds[0], type: "pane" },
            { paneId: paneIds[1], type: "pane" },
          ],
          direction: "vertical",
          type: "split",
        });
      },
    });
  });

  await t.test("pair response preserves arbitrary restored split-tree topology", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      internalRuntime.applyPairState(surface, {
        id: "rq_pair_tree_restore",
        ok: true,
        op: "pair.request",
        payload: {
          capabilities: {
            contentTypes: ["html", "image", "pdf", "terminal", "markdown"],
            eventTypes: [],
            protocolFeatures: ["authority.state.v1"],
          },
          eventConfig: {
            activeEvents: [],
            drawingFlushConfig: {
              idleWindowMs: 8000,
              maxIntervalMs: 30000,
            },
            profile: "minimum_deep",
          },
          limits: {
            maxDrawingFlushBytes: 2 * 1024 * 1024,
            maxFrameBytes: 10 * 1024 * 1024,
            maxMessageBytes: 12 * 1024 * 1024,
            maxStrokePointsPerFlush: 8192,
            maxVisibleTextBytes: 4096,
            resumeGraceMs: 20_000,
          },
          resumed: false,
          sessionId: "sa_pair_tree_restore",
          state: {
            layout: {
              children: [
                {
                  children: [
                    { paneId: server.initialRemotePaneId, type: "pane" },
                    { paneId: 9998, type: "pane", weight: 2 },
                  ],
                  direction: "horizontal",
                  type: "split",
                  weight: 3,
                },
                {
                  children: [
                    { paneId: 9999, type: "pane" },
                    { paneId: 10000, type: "pane" },
                  ],
                  direction: "vertical",
                  type: "split",
                },
              ],
              direction: "vertical",
              type: "split",
            },
            panes: [
              {
                contentType: null,
                currentContentId: null,
                currentRevision: 0,
                paneId: server.initialRemotePaneId,
                paneLabel: 1,
              },
              {
                contentType: null,
                currentContentId: null,
                currentRevision: 0,
                paneId: 9998,
                paneLabel: 2,
              },
              {
                contentType: null,
                currentContentId: null,
                currentRevision: 0,
                paneId: 9999,
                paneLabel: 3,
              },
              {
                contentType: null,
                currentContentId: null,
                currentRevision: 0,
                paneId: 10000,
                paneLabel: 4,
              },
            ],
            topologyRevision: 7,
          },
          surfaceId: server.surfaceId,
          surfaceName: "Surface A",
          viewport: { height: 768, scale: 2, width: 1024 },
        },
        sentAt: Date.now(),
        type: "response",
        v: 1,
      });
      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      const paneIdByLabel = new Map(screen.panes.map((pane) => [pane.paneLabel, pane.paneId]));

      assert.equal(surface.topologyRevision, 7);
      assert.deepEqual(surface.layout, {
        children: [
          {
            children: [
              { paneId: paneIdByLabel.get(1), type: "pane" },
              { paneId: paneIdByLabel.get(2), type: "pane", weight: 2 },
            ],
            direction: "horizontal",
            type: "split",
            weight: 3,
          },
          {
            children: [
              { paneId: paneIdByLabel.get(3), type: "pane" },
              { paneId: paneIdByLabel.get(4), type: "pane" },
            ],
            direction: "vertical",
            type: "split",
          },
        ],
        direction: "vertical",
        type: "split",
      });
    });
  });

  await t.test("pair response rejects topology that does not exactly cover restored panes", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const beforeLayout = structuredClone(surface.layout);
      const beforeTopologyRevision = surface.topologyRevision;
      const beforePanes = structuredClone([...surface.panes.values()]);
      assert.throws(
        () =>
          internalRuntime.applyPairPaneState(
            surface,
            [
              {
                contentType: null,
                currentContentId: null,
                currentRevision: 0,
                paneId: server.initialRemotePaneId,
                paneLabel: 1,
              },
              {
                contentType: null,
                currentContentId: null,
                currentRevision: 0,
                paneId: 9998,
                paneLabel: 2,
              },
            ],
            false,
            {
              pairStateLayout: {
                children: [
                  { paneId: server.initialRemotePaneId, type: "pane" },
                  { paneId: server.initialRemotePaneId, type: "pane" },
                ],
                direction: "vertical",
                type: "split",
              },
              pairStateTopologyRevision: 7,
            },
          ),
        /did not exactly match its pane list/,
      );
      assert.deepEqual(surface.layout, beforeLayout);
      assert.equal(surface.topologyRevision, beforeTopologyRevision);
      assert.deepEqual([...surface.panes.values()], beforePanes);
      const beforeSessionId = surface.sessionId;
      const beforeOwnershipEpoch = surface.ownershipEpoch;
      assert.throws(
        () =>
          internalRuntime.assertPairResponseTopologyMatchesPanes(surface, {
            payload: {
              state: {
                layout: {
                  children: [
                    { paneId: server.initialRemotePaneId, type: "pane" },
                    { paneId: server.initialRemotePaneId, type: "pane" },
                  ],
                  direction: "vertical",
                  type: "split",
                },
                panes: [
                  {
                    contentType: null,
                    currentContentId: null,
                    currentRevision: 0,
                    paneId: server.initialRemotePaneId,
                    paneLabel: 1,
                  },
                  {
                    contentType: null,
                    currentContentId: null,
                    currentRevision: 0,
                    paneId: 9998,
	                    paneLabel: 2,
	                  },
	                ],
	                topologyRevision: 7,
	              },
	            },
	          }),
        /did not exactly match its pane list/,
      );
      assert.equal(surface.sessionId, beforeSessionId);
      assert.equal(surface.ownershipEpoch, beforeOwnershipEpoch);
    });
  });

  await t.test("pre-revision pane-list reconciliation uses provider surface bounds", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        server.setSurfaceViewport({ height: 800, scale: 2, width: 1200 });
        const firstRemotePane = server.panes.get(server.initialRemotePaneId);
        assert.ok(firstRemotePane);
        firstRemotePane.frame = { height: 800, width: 600, x: 0, y: 0 };
        firstRemotePane.viewport = { height: 800, scale: 2, width: 600 };
        server.panes.set(9999, {
          contentId: null,
          contentType: null,
          drawings: [],
          frame: { height: 800, width: 600, x: 600, y: 0 },
          name: null,
          paneLabel: 99,
          paneLineageId: "pl_provider_bounds_pre_revision",
          revision: 0,
          viewport: {
            height: 800,
            scale: 2,
            width: 600,
          },
        });
        server.setTopologyLayout(
          {
            children: [
              { paneId: server.initialRemotePaneId, type: "pane" },
              { paneId: 9999, type: "pane" },
            ],
            direction: "vertical",
            type: "split",
          },
          0,
        );
      },
      run: async ({ runtime, server }) => {
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        surface.viewport = { height: 768, scale: 2, width: 1024 };

        await internalRuntime.syncRemotePaneList(surface);

        const paneIds = assertPaneLabelsWithOpaqueIds((await runtime.listScreens())[0]?.panes ?? [], [1, 99]);
        assert.deepEqual(surface.layout, {
          children: [
            { paneId: paneIds[0], type: "pane" },
            { paneId: paneIds[1], type: "pane" },
          ],
          direction: "vertical",
          type: "split",
        });
      },
    });
  });

  await t.test("pre-revision split preserves reconciled provider geometry", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        const firstRemotePane = server.panes.get(server.initialRemotePaneId);
        assert.ok(firstRemotePane);
        firstRemotePane.frame = { height: 768, width: 512, x: 0, y: 0 };
        firstRemotePane.viewport = { height: 768, scale: 2, width: 512 };
        server.panes.set(9999, {
          contentId: null,
          contentType: null,
          drawings: [],
          frame: { height: 768, width: 512, x: 512, y: 0 },
          name: null,
          paneLabel: 99,
          paneLineageId: "pl_split_provider_geometry",
          revision: 0,
          viewport: {
            height: 768,
            scale: 2,
            width: 512,
          },
        });
        server.setTopologyLayout(
          {
            children: [
              { paneId: server.initialRemotePaneId, type: "pane" },
              { paneId: 9999, type: "pane" },
            ],
            direction: "vertical",
            type: "split",
          },
          0,
        );
      },
      run: async ({ runtime, server }) => {
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        await internalRuntime.syncRemotePaneList(surface);

        const screens = await runtime.listScreens();
        const paneIds = assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 99]);
        assert.equal(surface.layout?.type, "split");
        assert.equal(surface.layout?.direction, "vertical");

        await runtime.split({
          count: 2,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: paneIds[0]!,
        });

        const topologyApply = server.topologyApplyRequests.at(-1);
        assert.ok(topologyApply);
        const newRemotePaneId = topologyApply.paneIds.find((paneId) =>
          paneId !== server.initialRemotePaneId && paneId !== 9999
        );
        assert.ok(newRemotePaneId);
        assert.deepEqual(topologyApply.layout, {
          children: [
            {
              children: [
                { paneId: server.initialRemotePaneId, type: "pane" },
                { paneId: newRemotePaneId, type: "pane" },
              ],
              direction: "vertical",
              type: "split",
            },
            { paneId: 9999, type: "pane" },
          ],
          direction: "vertical",
          type: "split",
        });
      },
    });
  });

  await t.test("pre-revision pane-list reconciliation skips in-flight topology apply", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        const firstRemotePane = server.panes.get(server.initialRemotePaneId);
        assert.ok(firstRemotePane);
        firstRemotePane.frame = { height: 768, width: 512, x: 0, y: 0 };
        firstRemotePane.viewport = { height: 768, scale: 2, width: 512 };
        server.panes.set(9999, {
          contentId: null,
          contentType: null,
          drawings: [],
          frame: { height: 768, width: 512, x: 512, y: 0 },
          name: null,
          paneLabel: 99,
          paneLineageId: "pl_inflight_provider_geometry",
          revision: 0,
          viewport: {
            height: 768,
            scale: 2,
            width: 512,
          },
        });
        server.setTopologyLayout(
          {
            children: [
              { paneId: server.initialRemotePaneId, type: "pane" },
              { paneId: 9999, type: "pane" },
            ],
            direction: "vertical",
            type: "split",
          },
          0,
        );
        server.topologyApplyDelayMs = 100;
      },
      run: async ({ runtime, server }) => {
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        await internalRuntime.syncRemotePaneList(surface);

        const screens = await runtime.listScreens();
        const paneIds = assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1, 99]);
        const splitPromise = runtime.split({
          count: 2,
          direction: "vertical",
          fingerprint: server.surfaceId,
          paneId: paneIds[0]!,
        });
        await waitFor(() => server.topologyApplyRequests.length > 0);

        const stagedLayout = structuredClone(surface.layout);
        await internalRuntime.syncRemotePaneList(surface);

        assert.deepEqual(surface.layout, stagedLayout);
        await splitPromise;
      },
    });
  });

  await t.test("pre-revision multi-pane provider geometry reconciles before close", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      await livePaneId(runtime, server.surfaceId, 1);
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      server.setSurfaceViewport({ height: 768, scale: 2, width: 1023 });

      const firstRemotePane = server.panes.get(server.initialRemotePaneId);
      assert.ok(firstRemotePane);
      firstRemotePane.frame = { height: 768, width: 341, x: 0, y: 0 };
      firstRemotePane.viewport = { height: 768, scale: 2, width: 341 };
      for (const [remotePaneId, x] of [[9998, 341], [9999, 682]] as const) {
        server.panes.set(remotePaneId, {
          contentId: null,
          contentType: null,
          drawings: [],
          frame: { height: 768, width: 341, x, y: 0 },
          name: null,
          paneLabel: remotePaneId === 9998 ? 2 : 3,
          paneLineageId: `pl_multi_pane_${remotePaneId}`,
          revision: 0,
          viewport: {
            height: 768,
            scale: 2,
            width: 341,
          },
        });
      }

      await internalRuntime.syncRemotePaneList(surface);

      const panes = assertPaneLabelsWithOpaqueIds((await runtime.listScreens())[0]?.panes ?? [], [1, 2, 3]);
      const closed = await runtime.closePane({
        fingerprint: server.surfaceId,
        paneId: panes[2]!,
      });
      assert.equal(closed.ok, true);
      assert.equal(closed.paneLabel, 3);
      assertPaneLabelsWithOpaqueIds((await runtime.listScreens())[0]?.panes ?? [], [1, 2]);
    });
  });

  await t.test("pair.request includes configured providerName", async () => {
    await withRuntimeHarness({
      providerName: "CLU / Surf Ace",
      run: async ({ server }) => {
        assert.equal(server.pairAttemptDetails[0]?.providerName, "CLU / Surf Ace");
      },
    });
  });

  await t.test("providerNameForSurface never falls back to pane session keys", async () => {
    await withRuntimeHarness({
      providerName: "CLU / Surf Ace",
      run: async ({ runtime, server }) => {
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        surface.panes.get(firstPaneId).pendingOwnerSessionKey = "agent:main:clawline:flynn:main";
        surface.panes.get(firstPaneId).ownerSessionKey = "agent:main:clawline:flynn:main";
        assert.equal(internalRuntime.providerNameForSurface(surface), "CLU / Surf Ace");
      },
    });
  });

  await t.test("pair bootstrap preserves the stable first-pane remote id across reconnects", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);

      const bootstrapPaneId = internalRuntime.ensureInitialPairPane(surface);
      assert.equal(bootstrapPaneId, server.initialRemotePaneId);
      assert.equal(surface.panes.size, 3);
      assert.equal(surface.panes.get(firstPaneId)?.remotePaneId, server.initialRemotePaneId);
    });
  });

  await t.test("reconnect pair requests reuse the stable first-pane remote id", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const beforeReconnect = (await runtime.listScreens())[0]?.panes.map((pane) => pane.paneId);
      assert.equal(beforeReconnect?.length, 1);
      beforeReconnect?.forEach((paneId) => assertOpaquePaneId(paneId));

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      await surface.client.close(1000, "test_reconnect_stable_pane_id");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(server.pairRequests.map((request) => request.initialPaneId), [
        1,
        server.initialRemotePaneId,
      ]);

      const afterReconnect = (await runtime.listScreens())[0]?.panes.map((pane) => pane.paneId);
      assert.deepEqual(afterReconnect, beforeReconnect);
    });
  });

  await t.test("reconnect remap adopts the provider-visible pane label for a non-pristine sole pane", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);

      await runtime.push(
        {
          content: "<p>persist me</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:reconnect-remap" },
      );

      const originalPane = surface.panes.get(firstPaneId);
      assert.ok(originalPane);
      assert.equal(originalPane.paneLabel, 1);
      assert.notEqual(originalPane.activeContentId, null);

      server.panes.clear();
      server.panes.set(900, {
        contentId: null,
        contentType: null,
        drawings: [],
        frame: { height: 768, width: 1024, x: 0, y: 0 },
        name: null,
        paneLabel: 7,
        revision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
      });

      await surface.client.close(1000, "test_reconnect_preserve_local_pane_label");

      await waitFor(() => server.pairRequests.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      const afterReconnect = (await runtime.listScreens())[0];
      assertPaneLabelsWithOpaqueIds(afterReconnect?.panes ?? [], [7]);

      const remappedPane = surface.panes.get(firstPaneId);
      assert.ok(remappedPane);
      assert.equal(remappedPane.remotePaneId, 900);
      assert.equal(remappedPane.paneLabel, 7);

      await runtime.push(
        {
          content: "<p>after reconnect</p>",
          contentType: "html",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:reconnect-remap" },
      );
      assert.equal(server.contentSetRequests.at(-1)?.paneId, 900);
    });
  });

  await t.test("surface-id remap preserves existing pane topology until pair response arrives", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);

      const internalRuntime = runtime as any;
      const preservedSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(preservedSurface);

      const bootstrapPane = structuredClone(preservedSurface.panes.get(firstPaneId));
      assert.ok(bootstrapPane);
      const restartEntry = {
        contentId: "ct_restart_remap",
        contentType: "markdown",
        contentValue: "# restart remap",
        historyOwnerToken: "hot_restart_remap",
        paneLabel: bootstrapPane.paneLabel,
        revision: 17,
        sessionKey: "agent:test:restart-remap",
      };

      const remappingSurface = {
        ...preservedSurface,
        client: {
          close: async () => {},
          isOpen: () => true,
          request: async () => ({
            id: "rq_surfaces_list",
            ok: true,
            op: "surfaces.list",
            payload: {
              surfaces: [
                {
                  name: preservedSurface.name,
                  paired: false,
                  surfaceId: server.surfaceId,
                  viewport: preservedSurface.viewport,
                },
              ],
            },
            sentAt: Date.now(),
            type: "response",
            v: 1,
          }),
        },
        connectedAt: null,
        endpoint: {
          ...preservedSurface.endpoint,
          endpointId: "endpoint-reconnect",
          fingerprintPrefix: "",
        },
        endpointId: "endpoint-reconnect",
        fingerprintPrefix: "",
        hasPairedInGatewaySession: false,
        panes: new Map([[bootstrapPane.paneId, bootstrapPane]]),
        recentEventIds: [...preservedSurface.recentEventIds],
        recentEventIdsSet: new Set(preservedSurface.recentEventIdsSet),
        retryDelayResolver: null,
        sessionId: null,
        snapshotBufferedEvents: [...preservedSurface.snapshotBufferedEvents],
        stopRequested: false,
        surfaceId: "sf_reconnect_previous" as any,
        workPromise: null,
      };

      internalRuntime.surfaces.set(remappingSurface.surfaceId, remappingSurface);
      internalRuntime.restartContentBySurface = new Map([
        [remappingSurface.surfaceId, [restartEntry]],
      ]);
      internalRuntime.restartSnapshots = new Map([
        [remappingSurface.surfaceId, { snapshot: "restart-snapshot" }],
      ]);
      const discoveredSurfaces = await internalRuntime.discoverSurfaceId(remappingSurface);
      assert.deepEqual(discoveredSurfaces.map((surface: any) => surface.surfaceId), [server.surfaceId]);

      const screen = (await runtime.listScreens()).find((entry) => entry.fingerprint === server.surfaceId);
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1, 2, 3]);
      assert.equal(internalRuntime.surfaces.get(server.surfaceId), preservedSurface);
      assert.equal(internalRuntime.surfaces.has("sf_reconnect_previous"), false);
      assert.equal(remappingSurface.stopRequested, true);
      await waitFor(() => remappingSurface.client === null);
      assert.equal(remappingSurface.client, null);
      assert.equal(preservedSurface.hasPairedInGatewaySession, true);
      assert.equal(preservedSurface.sessionId, "sa_test_session");
      assert.equal(internalRuntime.restartContentBySurface.has("sf_reconnect_previous"), false);
      assert.equal(internalRuntime.restartContentBySurface.has(server.surfaceId), false);
      assert.equal(internalRuntime.restartSnapshots.has("sf_reconnect_previous"), false);
      assert.equal(internalRuntime.restartSnapshots.has(server.surfaceId), false);
    });
  });

  await t.test("surfaces.list remap does not expose local topology when ownership provenance names the old surface", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const preservedSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(preservedSurface);
      const firstPane = [...preservedSurface.panes.values()][0];
      assert.ok(firstPane);

      internalRuntime.surfaces.delete(server.surfaceId);
      const oldSurfaceId = "sf_previous_owned_surface" as any;
      const remappingSurface = {
        ...preservedSurface,
        client: {
          close: async () => {},
          isOpen: () => true,
          request: async () => ({
            id: "rq_surfaces_list",
            ok: true,
            op: "surfaces.list",
            payload: {
              surfaces: [
                {
                  name: preservedSurface.name,
                  paired: true,
                  surfaceId: server.surfaceId,
                  viewport: preservedSurface.viewport,
                },
              ],
            },
            sentAt: Date.now(),
            type: "response",
            v: 1,
          }),
        },
        endpoint: {
          ...preservedSurface.endpoint,
          endpointId: "endpoint-remap-old-owned",
          fingerprintPrefix: "",
        },
        endpointId: "endpoint-remap-old-owned",
        fingerprintPrefix: "",
        localOwnership: {
          ...preservedSurface.localOwnership,
          surfaceId: oldSurfaceId,
        },
        panes: new Map([[firstPane.paneId, firstPane]]),
        recentEventIds: [...preservedSurface.recentEventIds],
        recentEventIdsSet: new Set(preservedSurface.recentEventIdsSet),
        retryDelayResolver: null,
        snapshotBufferedEvents: [...preservedSurface.snapshotBufferedEvents],
        stopRequested: false,
        surfaceId: oldSurfaceId,
        workPromise: null,
      };

      internalRuntime.surfaces.set(oldSurfaceId, remappingSurface);
      internalRuntime.restartContentBySurface = new Map([
        [
          oldSurfaceId,
          [
            {
              contentId: "ct_old_surface_restart",
              contentType: "markdown",
              contentValue: "# old surface restart",
              historyOwnerToken: "hot_old_surface_restart",
              paneLabel: firstPane.paneLabel,
              revision: 4,
              sessionKey: "agent:test:old-surface-restart",
            },
          ],
        ],
      ]);
      await internalRuntime.discoverSurfaceId(remappingSurface);

      const remappedSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(remappedSurface);
      assert.equal(remappedSurface.surfaceId, server.surfaceId);
      assert.equal(remappedSurface.localOwnership?.surfaceId, oldSurfaceId);
      assert.equal(internalRuntime.shouldAttemptResume(remappedSurface), false);
      assert.equal(internalRuntime.restartContentBySurface.has(oldSurfaceId), false);
      assert.equal(internalRuntime.restartContentBySurface.has(server.surfaceId), false);
      assert.equal((await runtime.listScreens()).some((screen) => screen.fingerprint === server.surfaceId), false);
    });
  });

  await t.test("pair.response canonicalization preserves an existing canonical surface on remap", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      const split = await runtime.split({
        count: 3,
        direction: "horizontal",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);

      const internalRuntime = runtime as any;
      const canonicalSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(canonicalSurface);
      const canonicalClient = canonicalSurface.client;

      const bootstrapPane = structuredClone(canonicalSurface.panes.get(firstPaneId));
      assert.ok(bootstrapPane);

      const remappingSurface = {
        ...canonicalSurface,
        client: {
          close: async () => {},
          isOpen: () => true,
          request: async () => {
            throw new Error("not used in canonicalization test");
          },
        },
        connectedAt: null,
        endpoint: {
          ...canonicalSurface.endpoint,
          endpointId: "endpoint-duplicate-hostname",
          fingerprintPrefix: "",
        },
        endpointId: "endpoint-duplicate-hostname",
        fingerprintPrefix: "",
        hasPairedInGatewaySession: false,
        panes: new Map([[bootstrapPane.paneId, bootstrapPane]]),
        recentEventIds: [...canonicalSurface.recentEventIds],
        recentEventIdsSet: new Set(canonicalSurface.recentEventIdsSet),
        retryDelayResolver: null,
        sessionId: null,
        snapshotBufferedEvents: [...canonicalSurface.snapshotBufferedEvents],
        stopRequested: false,
        surfaceId: "sf_duplicate_hostname_previous" as any,
        workPromise: null,
      };

      internalRuntime.surfaces.set(remappingSurface.surfaceId, remappingSurface);
      const provisionalClient = remappingSurface.client;
      const adoptedSurface = internalRuntime.adoptCanonicalSurfaceId(remappingSurface, server.surfaceId, "pair.response");

      assert.equal(internalRuntime.surfaces.has("sf_duplicate_hostname_previous"), false);
      assert.equal(internalRuntime.surfaces.get(server.surfaceId), canonicalSurface);
      assert.equal(adoptedSurface, canonicalSurface);
      const screens = await runtime.listScreens();
      assert.equal(screens.filter((entry) => entry.fingerprint === server.surfaceId).length, 1);
      const screen = screens.find((entry) => entry.fingerprint === server.surfaceId);
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [1, 2, 3]);
      assert.equal(canonicalSurface.hasPairedInGatewaySession, true);
      assert.equal(canonicalSurface.sessionId, "sa_test_session");
      assert.equal(canonicalSurface.client, canonicalClient);
      assert.notEqual(canonicalSurface.client, provisionalClient);
      assert.notEqual(canonicalSurface.client, null);
      assert.equal(remappingSurface.stopRequested, true);
      assert.equal(remappingSurface.client, null);
    });
  });

  await t.test("canonical restart continuity migration preserves restored topology marker", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const previousSurfaceId = "sf_restart_previous_canonical";
      internalRuntime.restartSnapshots.set(previousSurfaceId, internalRuntime.buildScreenSummary(surface));
      internalRuntime.restartContentBySurface.set(previousSurfaceId, [
        {
          contentId: "ct_restart_previous_canonical",
          contentType: "html",
          contentValue: "<main>restart previous canonical</main>",
          historyOwnerToken: "hot_restart_previous_canonical",
          paneLabel: 1,
          revision: 1,
          sessionKey: "agent:test:restart-previous-canonical",
        },
      ]);
      internalRuntime.restartTopologyRestoredSurfaceIds.add(previousSurfaceId);

      internalRuntime.migrateRestartContinuity(previousSurfaceId, server.surfaceId, true);

      assert.equal(internalRuntime.restartSnapshots.has(previousSurfaceId), false);
      assert.equal(internalRuntime.restartSnapshots.has(server.surfaceId), true);
      assert.equal(internalRuntime.restartContentBySurface.has(previousSurfaceId), false);
      assert.equal(internalRuntime.restartContentBySurface.has(server.surfaceId), true);
      assert.equal(internalRuntime.restartTopologyRestoredSurfaceIds.has(previousSurfaceId), false);
      assert.equal(internalRuntime.restartTopologyRestoredSurfaceIds.has(server.surfaceId), true);
    });
  });

  await t.test("pair.response remap transfers a live paired client when existing canonical has no client", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const canonicalSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(canonicalSurface);
      const previousCanonicalClient = canonicalSurface.client;
      canonicalSurface.client = null;

      let incomingCloseCalls = 0;
      const incomingClient = {
        close: async () => {
          incomingCloseCalls += 1;
        },
        isOpen: () => true,
        request: async () => {
          throw new Error("not used in client transfer test");
        },
      };
      const remappingSurface = {
        ...canonicalSurface,
        client: incomingClient,
        connectedAt: null,
        endpoint: {
          ...canonicalSurface.endpoint,
          endpointId: "endpoint-stale-wrapper",
          fingerprintPrefix: "",
        },
        endpointId: "endpoint-stale-wrapper",
        fingerprintPrefix: "",
        hasPairedInGatewaySession: false,
        panes: new Map(canonicalSurface.panes),
        recentEventIds: [...canonicalSurface.recentEventIds],
        recentEventIdsSet: new Set(canonicalSurface.recentEventIdsSet),
        retryDelayResolver: null,
        sessionId: null,
        snapshotBufferedEvents: [...canonicalSurface.snapshotBufferedEvents],
        stopRequested: false,
        surfaceId: "sf_stale_wrapper_previous" as any,
        workPromise: null,
      };

      internalRuntime.surfaces.set(remappingSurface.surfaceId, remappingSurface);
      const adoptedSurface = internalRuntime.adoptCanonicalSurfaceId(remappingSurface, server.surfaceId, "pair.response");

      assert.equal(adoptedSurface, canonicalSurface);
      assert.equal(internalRuntime.surfaces.has("sf_stale_wrapper_previous"), false);
      assert.equal(canonicalSurface.client, incomingClient);
      assert.equal(remappingSurface.client, null);
      assert.equal(remappingSurface.stopRequested, true);
      assert.equal(incomingCloseCalls, 0);

      canonicalSurface.client = previousCanonicalClient;
    });
  });

  await t.test("provisional entries accidentally placed in the canonical registry trip the pre-exposure invariant", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const canonicalSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(canonicalSurface);

      const leakedProbe = {
        ...canonicalSurface,
        client: null,
        connectedAt: null,
        connectionState: "connecting",
        endpoint: {
          ...canonicalSurface.endpoint,
          endpointId: "endpoint-leaked-probe",
          fingerprintPrefix: "",
        },
        endpointId: "endpoint-leaked-probe",
        fingerprintPrefix: "",
        hasPairedInGatewaySession: false,
        panes: new Map(),
        recentEventIds: [],
        recentEventIdsSet: new Set(),
        retryDelayResolver: null,
        sessionId: null,
        stopRequested: false,
        surfaceId: "sf_disc_leaked_probe" as any,
        workPromise: null,
        windowLabel: "",
      };
      internalRuntime.surfaces.set(leakedProbe.surfaceId, leakedProbe);

      await assert.rejects(runtime.listScreens(), /canonical surface registry invariant failed/);
      assert.equal(internalRuntime.surfaces.get(leakedProbe.surfaceId), leakedProbe);
      assert.ok(
        warnings.some((warning) =>
          warning.includes("canonical_surface_invariant_failed") &&
          warning.includes("sf_disc_leaked_probe")),
      );
    });
  });

  await t.test("discovery reconciles canonical endpoint surfaces through the remote registry", async () => {
    await withRuntimeHarness(async ({ discovery, infos, runtime, server }) => {
      const internalRuntime = runtime as any;
      const retainedSurface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(retainedSurface);
      assert.ok(retainedSurface.client?.isOpen());
      server.addSurface({ initialRemotePaneId: 42, name: "Legitimate Sibling", surfaceId: "sf_legitimate_sibling" });

      const siblingSurface = {
        ...retainedSurface,
        autoRetryEnabled: true,
        client: null,
        connectedAt: null,
        connectionState: "connecting",
        hasPairedInGatewaySession: false,
        lastSeenAt: retainedSurface.lastSeenAt - 500,
        panes: new Map(),
        recentEventIds: [],
        recentEventIdsSet: new Set(),
        retryDelayResolver: null,
        sessionId: null,
        stopRequested: false,
        surfaceId: "sf_legitimate_sibling" as any,
        workPromise: null,
        windowLabel: "y",
      };
      const staleSurface = {
        ...retainedSurface,
        autoRetryEnabled: true,
        client: null,
        connectedAt: null,
        connectionState: "connecting",
        hasPairedInGatewaySession: false,
        lastSeenAt: retainedSurface.lastSeenAt - 1_000,
        panes: new Map(),
        recentEventIds: [],
        recentEventIdsSet: new Set(),
        retryDelayResolver: null,
        sessionId: null,
        stopRequested: false,
        surfaceId: "sf_disc_stale_same_endpoint" as any,
        workPromise: null,
        windowLabel: "z",
      };
      internalRuntime.surfaces.set(siblingSurface.surfaceId, siblingSurface);
      internalRuntime.surfaces.set(staleSurface.surfaceId, staleSurface);

      await discovery.refreshNow();
      await waitFor(() => !internalRuntime.surfaces.has(staleSurface.surfaceId));

      assert.equal(internalRuntime.surfaces.get(server.surfaceId), retainedSurface);
      assert.equal(internalRuntime.surfaces.get(siblingSurface.surfaceId), siblingSurface);
      assert.equal(siblingSurface.stopRequested, false);
      assert.equal(internalRuntime.surfaces.has(staleSurface.surfaceId), false);
      assert.equal(staleSurface.stopRequested, true);
      assert.equal(server.pairRequestSurfaceIds.includes(staleSurface.surfaceId), false);
      assert.ok(
        infos.some((info) =>
          info.includes("surface_removed") &&
          info.includes("surfaces_list_absent") &&
          info.includes(staleSurface.surfaceId)),
      );
    });
  });

  await t.test("stable surfaceId plus remotePaneId preserves paneLabel across reconnect bootstrap", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, {
      initialRemotePaneId: 41,
      surfaceId: "sf_surface-a",
    });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-pane-label-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtimeA = createSurfAceRuntime({ discovery, stateDir });
    const runtimeB = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtimeA.start();
      await waitFor(() => server.pairedSocket !== null);

      const beforeRestart = (await runtimeA.listScreens())[0];
      const beforePaneIds = assertPaneLabelsWithOpaqueIds(beforeRestart?.panes ?? [], [1]);

      await runtimeA.stop();
      await waitFor(() => server.activeSocketCount === 0);

      await runtimeB.start();
      await waitFor(() => server.pairRequests.length >= 2);
      await waitFor(() => server.pairedSocket !== null);

      const afterRestart = (await runtimeB.listScreens())[0];
      assert.ok(afterRestart);
      assert.equal(afterRestart.panes.length, 1);
      assertOpaquePaneId(afterRestart.panes[0]?.paneId);
      assert.equal(afterRestart.panes[0]?.paneId, beforePaneIds[0]);
      assert.equal(afterRestart.panes[0]?.paneLabel, 1);
    } finally {
      await runtimeB.stop();
      await runtimeA.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("provider-visible pane labels override polluted persisted local labels", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, {
      initialPaneLabel: 4,
      initialRemotePaneId: 6243,
      surfaceId: "sf_surface-a",
    });
    server.panes.set(6245, {
      contentId: null,
      contentType: null,
      drawings: [],
      frame: { height: 768, width: 1024, x: 0, y: 0 },
      name: null,
      paneLabel: 5,
      revision: 0,
      viewport: {
        height: 768,
        scale: 2,
        width: 1024,
      },
    });
    server.setTopologyLayout(
      {
        children: [
          { paneId: 6245, type: "pane" },
          { paneId: 6243, type: "pane" },
        ],
        direction: "vertical",
        type: "split",
      },
      0,
    );
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-pane-label-polluted-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 6244,
            nextRemotePaneId: 6246,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {
              [`${server.surfaceId}::6243`]: 4,
              [`${server.surfaceId}::6245`]: 5,
            },
            providerId: "pv_test_provider",
            version: 1,
            windowLabels: {
              [server.surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(() => server.pairedSocket !== null);

      const screen = (await runtime.listScreens())[0];
      assert.ok(screen);
      assertPaneLabelsWithOpaqueIds(screen.panes, [5, 4]);
      assert.equal(server.pairRequests[0]?.initialPaneLabel, 1);

      const split = await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: screen.panes[0]!.paneId,
      });
      assertPaneLabelsWithOpaqueIds(split, [1, 4, 5]);
      assert.deepEqual(server.topologyApplyRequests.at(-1)?.paneLabels, [5, 1, 4]);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("provider restart resumes ownership identity without replaying stale restart content", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_restart_owner" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-restart-owner-"));
    const providerId = "pv_restart_owner";
    const sessionId = "sa_restart_session";
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const infos: string[] = [];
    const runtime = createSurfAceRuntime({
      discovery,
      logger: {
        info: (message: string) => {
          infos.push(message);
        },
      },
      stateDir,
    });
    server.lockedProviderId = providerId;
    server.lockedSessionId = sessionId;

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            version: 1,
            windowLabels: {
              [server.surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              {
                _debug: {
                  autoRetryEnabled: true,
                  endpointId: "endpoint-before-provider-restart",
                  hasPairedInGatewaySession: true,
                  localOwnership: persistedLocalOwnership({
                    endpointId: "endpoint-before-provider-restart",
                    endpointPort: port,
                    providerId,
                    sessionId,
                    surfaceId: server.surfaceId,
                  }),
                  reconnectAttempt: 0,
                  sessionId,
                  unreachableFailures: 0,
                  wsOpen: true,
                },
                connectionState: "connected",
                fingerprint: server.surfaceId,
                lastSeenAt: Date.now(),
                name: "Restart Owner",
                panes: [],
                  pendingEvents: 0,
                  viewport: {
                    height: 768,
                    scale: 2,
                    width: 1024,
                  },
                  windowLabel: "a",
                },
              ],
              contentContinuity: {
                [server.surfaceId]: [
                  {
                    contentId: "ct_aabbccdd",
                    contentType: "markdown",
                    contentValue: "# restart persisted content",
                    historyOwnerToken: "hot_restart_persisted",
                    paneLabel: 1,
                    revision: 7,
                    sessionKey: "agent:test:restart-owner-content",
                  },
                ],
              },
              updatedAt: Date.now() - 10 * 60_000,
              version: 1,
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(server.pairAttemptDetails.length, 1);
      assert.equal(server.pairAttemptDetails[0]?.providerId, providerId);
      assert.equal(server.pairAttemptDetails[0]?.resumeSessionId, sessionId);
      assert.equal(server.pairAttemptDetails[0]?.takeover, false);
      assert.equal(server.pairedSocket !== null, true);
      await waitFor(
        () =>
          infos.some((info) =>
            info.includes("event=resume_replay_outcome") &&
            info.includes("outcome=skipped_provider_owned")),
        12_000,
      );
      assert.equal(server.topologyApplyRequests.some((request) => request.windowLabel === "a"), false);
      assert.equal(server.contentSetRequests.length, 0);
      const screen = (await runtime.listScreens())[0];
      assert.equal(screen?.panes[0]?.activeContent?.contentId ?? null, null);
      assert.equal(screen?.panes[0]?.activeContent?.revision ?? null, null);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("provider restart does not resume or replay content from legacy boolean-only ownership", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_restart_legacy_owner" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-restart-legacy-owner-"));
    const providerId = "pv_restart_legacy_owner";
    const sessionId = "sa_restart_legacy_session";
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            version: 1,
            windowLabels: {
              [server.surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            contentContinuity: {
              [server.surfaceId]: [
                {
                  contentId: "ct_legacy_boolean_content",
                  contentType: "markdown",
                  contentValue: "# should not replay",
                  historyOwnerToken: "hot_legacy_boolean_content",
                  paneLabel: 1,
                  revision: 3,
                  sessionKey: "agent:test:legacy-boolean-content",
                },
              ],
            },
            screens: [
              {
                _debug: {
                  endpointId: "endpoint-before-provider-restart",
                  hasPairedInGatewaySession: true,
                  reconnectAttempt: 0,
                  sessionId,
                  wsOpen: true,
                },
                connectionState: "connected",
                fingerprint: server.surfaceId,
                lastSeenAt: Date.now(),
                name: "Restart Legacy Owner",
                panes: [],
                pendingEvents: 0,
                topology: null,
                topologyRevision: 0,
                viewport: { height: 768, scale: 2, width: 1024 },
                windowLabel: "a",
              },
            ],
            updatedAt: Date.now(),
            version: 1,
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(server.pairAttemptDetails[0]?.resumeSessionId, null);
      assert.equal(server.pairAttemptDetails[0]?.takeover, false);
      assert.equal(server.contentSetRequests.length, 0);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

    await t.test("provider restart keeps persisted ownership through transient busy", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_restart_busy" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-restart-busy-"));
    const providerId = "pv_restart_busy";
    const sessionId = "sa_restart_busy_session";
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });
    server.lockedProviderId = providerId;
    server.lockedSessionId = sessionId;
    server.busyWithoutTakeoverResponsesRemaining = 1;

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify(
          {
            nextPaneLabel: 2,
            nextRemotePaneId: 2,
            nextWindowLabelIndex: 1,
            paneLabelsByPaneId: {},
            providerId,
            version: 1,
            windowLabels: {
              [server.surfaceId]: "a",
            },
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-screens.json"),
        JSON.stringify(
          {
            screens: [
              {
                _debug: {
                  autoRetryEnabled: true,
                  endpointId: "endpoint-before-provider-restart",
                  hasPairedInGatewaySession: true,
                  localOwnership: persistedLocalOwnership({
                    endpointId: "endpoint-before-provider-restart",
                    endpointPort: port,
                    providerId,
                    sessionId,
                    surfaceId: server.surfaceId,
                  }),
                  reconnectAttempt: 0,
                  sessionId,
                  unreachableFailures: 0,
                  wsOpen: true,
                },
                connectionState: "connected",
                fingerprint: server.surfaceId,
                lastSeenAt: Date.now(),
                name: "Restart Busy",
                panes: [],
                pendingEvents: 0,
                viewport: {
                  height: 768,
                  scale: 2,
                  width: 1024,
                },
                windowLabel: "a",
              },
            ],
            updatedAt: Date.now(),
            version: 1,
          },
          null,
          2,
        ),
      );

      await runtime.start();
      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(server.pairAttemptDetails[0]?.providerId, providerId);
      assert.equal(server.pairAttemptDetails[0]?.resumeSessionId, sessionId);
      assert.equal(server.pairAttemptDetails[0]?.takeover, false);
      assert.equal(server.pairAttemptDetails[1]?.providerId, providerId);
      assert.equal(server.pairAttemptDetails[1]?.resumeSessionId, null);
      assert.equal(server.pairAttemptDetails[1]?.takeover, true);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
    });

  await t.test("foreign busy pair without durable self authority does not expose pre-pair bootstrap panes", async () => {
      const port = nextPort++;
      const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_restart_foreign_busy" });
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-restart-foreign-busy-"));
      const providerId = "pv_restart_foreign_busy";
      const sessionId = "sa_restart_foreign_busy_session";
      const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
      const runtime = createSurfAceRuntime({ discovery, stateDir });
      server.lockedProviderId = "pv_foreign_owner";
      server.lockedSessionId = "sa_foreign_session";
      server.busyWithoutTakeoverResponsesRemaining = 100;

      try {
        await fs.writeFile(
          path.join(stateDir, "surf-ace-runtime-state.json"),
          JSON.stringify(
            {
              nextPaneLabel: 2,
              nextRemotePaneId: 2,
              nextWindowLabelIndex: 1,
              paneLabelsByPaneId: {},
              providerId,
              version: 1,
              windowLabels: {
                [server.surfaceId]: "a",
              },
            },
            null,
            2,
          ),
        );
        await fs.writeFile(
          path.join(stateDir, "surf-ace-runtime-screens.json"),
          JSON.stringify(
              {
                screens: [
                {
                  _debug: {
                    autoRetryEnabled: true,
                    endpointId: "endpoint-before-provider-restart",
                    hasPairedInGatewaySession: true,
                    localOwnership: persistedLocalOwnership({
                      endpointId: "endpoint-before-provider-restart",
                      endpointPort: port,
                      providerId: "pv_foreign_owner",
                      sessionId,
                      surfaceId: server.surfaceId,
                    }),
                    reconnectAttempt: 0,
                    sessionId,
                    unreachableFailures: 0,
                    wsOpen: true,
                  },
                  connectionState: "connected",
                  fingerprint: server.surfaceId,
                  lastSeenAt: Date.now(),
                  name: "Restart Foreign Busy",
                  panes: [],
                  pendingEvents: 0,
                  viewport: {
                    height: 768,
                    scale: 2,
                    width: 1024,
                  },
                  windowLabel: "a",
                },
              ],
              updatedAt: Date.now(),
              version: 1,
            },
            null,
            2,
          ),
        );

        await runtime.start();
        await waitFor(() => server.pairAttemptDetails.length > 0, 12_000);
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        assert.ok(surface.panes.size > 0);

        const screens = await runtime.listScreens();
        assert.equal(screens.some((screen) => screen.fingerprint === server.surfaceId), false);
      } finally {
        await runtime.stop();
        await server.close();
        await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("restart-pending pair requests do not reuse stale window labels held by active surfaces", async () => {
    const activePort = nextPort++;
    const restartPort = nextPort++;
    const activeServer = new FakeSurfAceWsServer(activePort, { surfaceId: "sf_active_label_owner" });
    const restartServer = new FakeSurfAceWsServer(restartPort, { surfaceId: "sf_restart_stale_label" });
    restartServer.lockedProviderId = "pv_foreign_label_owner";
    restartServer.lockedSessionId = "sa_foreign_label_session";
    restartServer.busyWithoutTakeoverResponsesRemaining = 100;
    const activeEndpoint = discoveryEndpoint(activePort, "ddddeeee");
    const restartEndpoint = discoveryEndpoint(restartPort, "eeeeffff");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-restart-label-conflict-"));
    const discovery = new StaticDiscoveryService([activeEndpoint]);
    const runtime = createSurfAceRuntime({ discovery, stateDir });

    try {
      await runtime.start();
      await waitFor(() => activeServer.pairedSocket !== null, 12_000);
      const activeScreen = (await runtime.listScreens()).find((screen) => screen.fingerprint === activeServer.surfaceId);
      assert.ok(activeScreen);
      assert.equal(activeScreen.windowLabel, "a");

      const internalRuntime = runtime as any;
      internalRuntime.persistentState.windowLabels[restartServer.surfaceId] = "a";
      internalRuntime.restartSnapshots.set(restartServer.surfaceId, {
        _debug: {
          autoRetryEnabled: true,
          endpointId: "stale-restart-endpoint",
          hasPairedInGatewaySession: true,
          localOwnership: persistedLocalOwnership({
            endpointId: "stale-restart-endpoint",
            endpointPort: restartPort,
            providerId: internalRuntime.persistentState.providerId,
            sessionId: "sa_restart_stale_label_session",
            surfaceId: restartServer.surfaceId,
          }),
          ownershipRecovery: "active",
          reconnectAttempt: 0,
          sessionId: "sa_restart_stale_label_session",
          unreachableFailures: 0,
          wsOpen: true,
        },
        connectionState: "connected",
        fingerprint: restartServer.surfaceId,
        lastSeenAt: Date.now(),
        name: "Restart Label Conflict",
        panes: [],
        pendingEvents: 0,
        topology: null,
        topologyRevision: 0,
        viewport: {
          height: 768,
          scale: 2,
          width: 1024,
        },
        windowLabel: "a",
      });

      discovery.setEndpoints([activeEndpoint, restartEndpoint]);
      await discovery.refreshNow();
      await waitFor(() => restartServer.pairRequests.length > 0, 12_000);

      assert.equal(activeServer.pairRequests[0]?.windowLabel, "a");
      assert.equal(restartServer.pairRequests[0]?.windowLabel, "b");
      assert.notEqual(restartServer.pairRequests[0]?.windowLabel, activeScreen.windowLabel);
    } finally {
      await runtime.stop();
      await restartServer.close();
      await activeServer.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("single invalid_resume clears the stale session and retries as a fresh owner pair", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      assert.equal(surface.sessionId, "sa_test_session");

      server.resumePairMismatchMessage = "Resume session did not match active ownership lock";
      server.rejectNextResumePairWithSessionMismatch = true;
      await surface.client.close(1000, "test_resume_restart");

      await waitFor(
        () =>
          server.pairAttemptDetails.length >= 2 &&
          surface.sessionId === "sa_test_session" &&
          surface.hasPairedInGatewaySession,
        12_000,
      );

      assert.equal(server.pairAttemptDetails[1]?.resumeSessionId, "sa_test_session");
      assert.equal(server.pairAttemptDetails[1]?.takeover, false);
      assert.equal(surface.sessionId, "sa_test_session");
      assert.equal(surface.hasPairedInGatewaySession, true);
    });
  });

  await t.test("busy on nil-session cold-start surface with persisted capability state does not self-reclaim", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      internalRuntime.markSelfOwnedSurfaceRelinquished(server.surfaceId);
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      surface.localOwnership = null;

      const providerId = server.pairAttemptDetails[0]?.providerId;

      server.busyWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_cold_start_busy_no_self_reclaim");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(server.pairAttemptDetails[1]?.takeover, false);
      assert.equal(server.pairAttemptDetails[2]?.takeover, false);
      assert.equal(server.pairAttemptDetails[2]?.providerId, providerId);
      assert.ok(
        warnings.some((warning) => warning.includes("ownership_self_reclaim_blocked") && warning.includes(server.surfaceId)),
      );
    });
  });

  await t.test("busy after a live-session drop self-reclaims with stable provider identity", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      assert.equal(surface.hasPairedInGatewaySession, true);
      const providerId = server.pairAttemptDetails[0]?.providerId;

      // Return busy once, then self-reclaim with the same provider identity.
      server.busyWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_live_session_busy_self_reclaim");

      // Wait for reconnect: first attempt gets busy, second succeeds as self-reclaim.
      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.equal(server.pairAttemptDetails[1]?.takeover, false);
      assert.equal(server.pairAttemptDetails[2]?.takeover, true);
      assert.equal(server.pairAttemptDetails[2]?.providerId, providerId);
      assert.ok(
        warnings.some((warning) => warning.includes("ownership_self_reclaim") && warning.includes(server.surfaceId)),
      );
    });
  });

  await t.test("pre-admission foreign-provider busy reclaims with takeover and preserves pair response", async () => {
    await withRuntimeHarness({
      configureServer: (server) => {
        const firstPane = server.panes.get(server.initialRemotePaneId);
        assert.ok(firstPane);
        firstPane.contentId = "ct_pre_admission_foreign_reclaim";
        firstPane.contentType = "markdown";
        firstPane.revision = 7;
        server.panes.set(42, {
          contentId: "ct_pre_admission_foreign_reclaim_second",
          contentType: "markdown",
          drawings: [],
          frame: {
            height: 768,
            width: 512,
            x: 512,
            y: 0,
          },
          name: null,
          paneLabel: 2,
          paneLineageId: `${server.surfaceId}_pane_42`,
          revision: 3,
          viewport: {
            height: 768,
            scale: 2,
            width: 512,
          },
        });
        server.setTopologyLayout({
          children: [
            { paneId: server.initialRemotePaneId, type: "pane" },
            { paneId: 42, type: "pane" },
          ],
          direction: "horizontal",
          type: "split",
        }, 4);
        server.busyWithoutTakeoverResponsesRemaining = 1;
        server.busyWithoutTakeoverMessage = "surface ownership lock is held by another provider";
      },
      run: async ({ runtime, server, warnings }) => {
        await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

        assert.deepEqual(
          server.pairAttemptDetails.slice(0, 2).map((attempt) => attempt.takeover),
          [false, true],
        );
        assert.deepEqual(
          server.pairAttemptDetails.slice(0, 2).map((attempt) => attempt.resumeSessionId),
          [null, null],
        );
        const screen = (await runtime.listScreens())[0];
        assert.ok(screen);
        assert.deepEqual(screen.panes.map((pane) => pane.paneLabel).sort(), [1, 2]);
        assert.equal(
          screen.panes.find((pane) => pane.paneLabel === 1)?.activeContent?.contentId,
          "ct_pre_admission_foreign_reclaim",
        );
        assert.equal(
          screen.panes.find((pane) => pane.paneLabel === 2)?.activeContent?.contentId,
          "ct_pre_admission_foreign_reclaim_second",
        );
        assert.ok(warnings.some((warning) => warning.includes("ownership_foreign_reclaim")));
      },
    });
  });

  await t.test("foreign-provider busy without durable self authority does not self-reclaim with takeover", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      assert.equal(surface.hasPairedInGatewaySession, true);
      internalRuntime.markSelfOwnedSurfaceRelinquished(server.surfaceId);
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      surface.localOwnership = null;

      server.busyWithoutTakeoverResponsesRemaining = 1;
      server.busyWithoutTakeoverMessage = "Surface ownership lock is held by another provider";
      await surface.client.close(1000, "test_foreign_busy_no_self_reclaim");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) => warning.includes("backing off") && warning.includes("takeover requires explicit user action")),
      );
    });
  });

  await t.test("foreign-provider busy does not self-reclaim stale valid local ownership", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      assert.equal(surface.hasPairedInGatewaySession, true);

      server.busyWithoutTakeoverResponsesRemaining = 1;
      server.busyWithoutTakeoverMessage = "Surface ownership lock is held by another provider";
      await surface.client.close(1000, "test_foreign_busy_stale_valid_local_ownership");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) => warning.includes("foreign_ownership_lock_cleared") && warning.includes(server.surfaceId)),
      );
    });
  });

  await t.test("legacy different-provider target state does not authorize self-reclaim", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_legacy_self_reclaim" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-lineage-current-"));
    const legacyStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-lineage-legacy-"));
    const currentProviderId = "pv_current_lineage";
    const legacyProviderId = "pv_legacy_lineage";
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, legacyStateDir, stateDir });
    server.lockedProviderId = legacyProviderId;
    server.lockedSessionId = "sa_legacy_lineage_session";
    server.busyWithoutTakeoverMessage = "Surface ownership lock is held by another provider";

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId: currentProviderId,
          version: 1,
          windowLabels: {},
        }),
      );
      await fs.writeFile(
        path.join(legacyStateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId: legacyProviderId,
          targetStateBySurfaceId: {
            [server.surfaceId]: { ownershipEpoch: 1, paneTargets: {} },
          },
          version: 1,
          windowLabels: {},
        }),
      );

      await runtime.start();
      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);

      assert.equal(server.pairAttemptDetails[0]?.providerId, currentProviderId);
      assert.equal(server.pairAttemptDetails[0]?.takeover, false);
      assert.equal(server.pairAttemptDetails[1]?.providerId, currentProviderId);
      assert.equal(server.pairAttemptDetails[1]?.takeover, false);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
      await fs.rm(legacyStateDir, { force: true, recursive: true });
    }
  });

  await t.test("legacy weak hints do not authorize same-gateway self-reclaim", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_legacy_weak_hint" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-weak-current-"));
    const legacyStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-weak-legacy-"));
    const currentProviderId = "pv_current_weak_hint";
    const legacyProviderId = "pv_legacy_weak_hint";
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({ discovery, legacyStateDir, stateDir });
    server.lockedProviderId = legacyProviderId;
    server.lockedSessionId = "sa_legacy_weak_session";

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId: currentProviderId,
          version: 1,
          windowLabels: {},
        }),
      );
      await fs.writeFile(
        path.join(legacyStateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 1,
          paneLabelsByPaneId: {},
          providerId: legacyProviderId,
          version: 1,
          windowLabels: {
            [server.surfaceId]: "a",
          },
        }),
      );

      await runtime.start();
      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      assert.equal(server.pairAttemptDetails[0]?.takeover, false);
      assert.equal(server.pairAttemptDetails[1]?.takeover, false);
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
      await fs.rm(legacyStateDir, { force: true, recursive: true });
    }
  });

  await t.test("known-self invalid_resume self-reclaim sends durable local ownership session", async () => {
    const port = nextPort++;
    const surfaceId = "sf_known_self_invalid_resume";
    const providerId = "pv_known_self_invalid_resume";
    const ownershipSessionId = "sa_known_self_invalid_resume";
    const paneLineageId = `pl_${surfaceId}_durable`;
    const server = new FakeSurfAceWsServer(port, { surfaceId });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-known-self-invalid-resume-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const warnings: string[] = [];
    const runtime = createSurfAceRuntime({
      discovery,
      logger: {
        error: () => {},
        info: () => {},
        warn: (message: string) => warnings.push(message),
      },
      stateDir,
    });
    server.lockedProviderId = providerId;
    server.lockedSessionId = ownershipSessionId;
    server.takeoverRequiresResumeSessionId = ownershipSessionId;

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId,
          selfOwnedSurfaceIds: {
            [surfaceId]: {
              observedAt: Date.now(),
              providerId,
              source: "legacy_target_state",
            },
          },
          targetStateBySurfaceId: {
            [surfaceId]: {
              ownershipEpoch: 1,
              paneTargets: {
                [paneLineageId]: {
                  currentTargetId: "tg_known_self_invalid_resume",
                  diagnosticContent: null,
                  lastRestoreBlockedReason: null,
                  nonDurableTargetDiagnostic: null,
                  paneLineageId,
                  targetEpoch: 1,
                },
              },
              registeredTargetIdsByIdempotencyKey: {},
              targetRecords: [
                {
                  appliedAt: new Date().toISOString(),
                  currentState: "current",
                  ownerProviderId: providerId,
                  ownershipEpoch: 1,
                  ownershipSessionId,
                  paneIdAtApply: "pn_previous_known_self",
                  paneLabelAtApply: 1,
                  paneLineageId,
                  restorePolicy: "auto",
                  surfaceId,
                  surfaceInstanceId: null,
                  targetEpoch: 1,
                  targetHeader: {
                    payloadSchemaVersion: 1,
                    replaySemantics: "bytes",
                    requiredCapabilities: ["target.markdown.v1"],
                    safeToLogFields: [],
                    safetyClass: "passive",
                    summary: "known-self durable reclaim target",
                  },
                  targetId: "tg_known_self_invalid_resume",
                  targetKind: "markdown",
                  targetPayload: { markdown: "# durable reclaim" },
                },
              ],
            },
          },
          version: 1,
          windowLabels: {},
        }),
      );

      await runtime.start();
      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(0, 2).map((attempt) => attempt.takeover),
        [false, true],
      );
      assert.deepEqual(
        server.pairAttemptDetails.slice(0, 2).map((attempt) => attempt.resumeSessionId),
        [null, ownershipSessionId],
      );
      assert.ok(warnings.some((warning) => warning.includes("ownership_self_reclaim")));
      assert.ok(
        !warnings.some((warning) =>
          warning.includes("invalid_resume on cold-start reconnect") &&
          warning.includes(surfaceId)),
      );
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("known-self self-reclaim retries takeover without stale durable resume session", async () => {
    const port = nextPort++;
    const surfaceId = "sf_known_self_stale_reclaim_session";
    const providerId = "pv_known_self_stale_reclaim_session";
    const ownershipSessionId = "sa_known_self_stale_reclaim_session";
    const paneLineageId = `pl_${surfaceId}_durable`;
    const server = new FakeSurfAceWsServer(port, { surfaceId });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-known-self-stale-reclaim-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const warnings: string[] = [];
    const runtime = createSurfAceRuntime({
      discovery,
      logger: {
        error: () => {},
        info: () => {},
        warn: (message: string) => warnings.push(message),
      },
      stateDir,
    });
    server.lockedProviderId = providerId;
    server.lockedSessionId = "sa_actual_active_lock";
    server.takeoverRequiresResumeSessionId = "sa_actual_active_lock";
    server.clearTakeoverResumeRequirementAfterMismatch = true;

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId,
          selfOwnedSurfaceIds: {
            [surfaceId]: {
              observedAt: Date.now(),
              providerId,
              source: "legacy_target_state",
            },
          },
          targetStateBySurfaceId: {
            [surfaceId]: {
              ownershipEpoch: 1,
              paneTargets: {
                [paneLineageId]: {
                  currentTargetId: "tg_known_self_stale_reclaim_session",
                  diagnosticContent: null,
                  lastRestoreBlockedReason: null,
                  nonDurableTargetDiagnostic: null,
                  paneLineageId,
                  targetEpoch: 1,
                },
              },
              registeredTargetIdsByIdempotencyKey: {},
              targetRecords: [
                {
                  appliedAt: new Date().toISOString(),
                  currentState: "current",
                  ownerProviderId: providerId,
                  ownershipEpoch: 1,
                  ownershipSessionId,
                  paneIdAtApply: "pn_previous_known_self",
                  paneLabelAtApply: 1,
                  paneLineageId,
                  restorePolicy: "auto",
                  surfaceId,
                  surfaceInstanceId: null,
                  targetEpoch: 1,
                  targetHeader: {
                    payloadSchemaVersion: 1,
                    replaySemantics: "bytes",
                    requiredCapabilities: ["target.markdown.v1"],
                    safeToLogFields: [],
                    safetyClass: "passive",
                    summary: "known-self stale durable reclaim target",
                  },
                  targetId: "tg_known_self_stale_reclaim_session",
                  targetKind: "markdown",
                  targetPayload: { markdown: "# stale durable reclaim" },
                },
              ],
            },
          },
          version: 1,
          windowLabels: {},
        }),
      );

      await runtime.start();
      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(0, 3).map((attempt) => attempt.takeover),
        [false, true, true],
      );
      assert.deepEqual(
        server.pairAttemptDetails.slice(0, 3).map((attempt) => attempt.resumeSessionId),
        [null, ownershipSessionId, null],
      );
      assert.ok(warnings.some((warning) => warning.includes("ownership_self_reclaim_resume_stale")));
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("current target ownership record authorizes post-restart invalid_resume self-reclaim", async () => {
    const port = nextPort++;
    const surfaceId = "sf_current_target_invalid_resume";
    const providerId = "pv_current_target_invalid_resume";
    const ownershipSessionId = "sa_current_target_invalid_resume";
    const paneLineageId = `pl_${surfaceId}_durable`;
    const server = new FakeSurfAceWsServer(port, { surfaceId });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-current-target-invalid-resume-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const warnings: string[] = [];
    const runtime = createSurfAceRuntime({
      discovery,
      logger: {
        error: () => {},
        info: () => {},
        warn: (message: string) => warnings.push(message),
      },
      stateDir,
    });
    server.lockedProviderId = providerId;
    server.lockedSessionId = ownershipSessionId;
    server.takeoverRequiresResumeSessionId = ownershipSessionId;

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId,
          targetStateBySurfaceId: {
            [surfaceId]: {
              ownershipEpoch: 1,
              paneTargets: {
                [paneLineageId]: {
                  currentTargetId: "tg_current_target_invalid_resume",
                  diagnosticContent: null,
                  lastRestoreBlockedReason: null,
                  nonDurableTargetDiagnostic: null,
                  paneLineageId,
                  targetEpoch: 1,
                },
              },
              registeredTargetIdsByIdempotencyKey: {},
              targetRecords: [
                {
                  appliedAt: new Date().toISOString(),
                  currentState: "current",
                  ownerProviderId: providerId,
                  ownershipEpoch: 1,
                  ownershipSessionId,
                  paneIdAtApply: "pn_previous_current_target",
                  paneLabelAtApply: 1,
                  paneLineageId,
                  restorePolicy: "auto",
                  surfaceId,
                  surfaceInstanceId: null,
                  targetEpoch: 1,
                  targetHeader: {
                    payloadSchemaVersion: 1,
                    replaySemantics: "bytes",
                    requiredCapabilities: ["target.markdown.v1"],
                    safeToLogFields: [],
                    safetyClass: "passive",
                    summary: "current target durable reclaim",
                  },
                  targetId: "tg_current_target_invalid_resume",
                  targetKind: "markdown",
                  targetPayload: { markdown: "# current target durable reclaim" },
                },
              ],
            },
          },
          version: 1,
          windowLabels: {},
        }),
      );

      await runtime.start();
      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(0, 2).map((attempt) => attempt.takeover),
        [false, true],
      );
      assert.deepEqual(
        server.pairAttemptDetails.slice(0, 2).map((attempt) => attempt.resumeSessionId),
        [null, ownershipSessionId],
      );
      assert.ok(warnings.some((warning) => warning.includes("ownership_self_reclaim")));
      assert.ok(!warnings.some((warning) => warning.includes("ownership_self_reclaim_blocked")));
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("stale target ownership record is tombstoned before post-restart invalid_resume self-reclaim", async () => {
    const port = nextPort++;
    const surfaceId = "sf_stale_target_invalid_resume";
    const providerId = "pv_stale_target_invalid_resume";
    const ownershipSessionId = "sa_stale_target_invalid_resume";
    const paneLineageId = `pl_${surfaceId}_durable`;
    const server = new FakeSurfAceWsServer(port, { surfaceId });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-stale-target-invalid-resume-"));
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const warnings: string[] = [];
    const runtime = createSurfAceRuntime({
      discovery,
      logger: {
        error: () => {},
        info: () => {},
        warn: (message: string) => warnings.push(message),
      },
      stateDir,
    });

    try {
      await fs.writeFile(
        path.join(stateDir, "surf-ace-runtime-state.json"),
        JSON.stringify({
          nextPaneLabel: 1,
          nextRemotePaneId: 1,
          nextWindowLabelIndex: 0,
          paneLabelsByPaneId: {},
          providerId,
          targetStateBySurfaceId: {
            [surfaceId]: {
              ownershipEpoch: 1,
              paneTargets: {
                [paneLineageId]: {
                  currentTargetId: null,
                  diagnosticContent: null,
                  lastRestoreBlockedReason: "ownership_epoch_mismatch",
                  nonDurableTargetDiagnostic: null,
                  paneLineageId,
                  staleTargetId: "tg_stale_target_invalid_resume",
                  targetEpoch: 1,
                },
              },
              registeredTargetIdsByIdempotencyKey: {},
              targetRecords: [
                {
                  appliedAt: new Date().toISOString(),
                  currentState: "stale",
                  ownerProviderId: providerId,
                  ownershipEpoch: 1,
                  ownershipSessionId,
                  paneIdAtApply: "pn_previous_stale_target",
                  paneLabelAtApply: 1,
                  paneLineageId,
                  restorePolicy: "auto",
                  surfaceId,
                  surfaceInstanceId: null,
                  targetEpoch: 1,
                  targetHeader: {
                    payloadSchemaVersion: 1,
                    replaySemantics: "bytes",
                    requiredCapabilities: ["target.markdown.v1"],
                    safeToLogFields: [],
                    safetyClass: "passive",
                    summary: "stale target durable reclaim",
                  },
                  targetId: "tg_stale_target_invalid_resume",
                  targetKind: "markdown",
                  targetPayload: { markdown: "# stale target durable reclaim" },
                },
              ],
            },
          },
          version: 1,
          windowLabels: {},
        }),
      );

      await runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.deepEqual(server.pairAttemptDetails, []);
      assert.equal((await runtime.listScreens())[0]?.connectionState, undefined);
      const state = JSON.parse(
        await fs.readFile(path.join(stateDir, "surf-ace-runtime-state.json"), "utf8"),
      ) as {
        selfOwnedSurfaceIds?: Record<string, { relinquishedAt?: number }>;
        surfaceTombstones?: Record<string, { reason?: string }>;
      };
      assert.equal(state.surfaceTombstones?.[surfaceId]?.reason, "stale_self_owned_persisted_surface");
      assert.equal(state.selfOwnedSurfaceIds?.[surfaceId]?.relinquishedAt !== undefined, true);
      assert.ok(warnings.some((warning) => warning.includes("persisted_self_owned_surface_reconciled")));
      assert.ok(!warnings.some((warning) => warning.includes("ownership_self_reclaim ")));
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("foreign-provider busy clears stale content before later fresh pair", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.push(
        {
          content: "# stale before foreign busy",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:foreign-busy-clear-content" },
        );
        const contentRequestsBeforeReconnect = server.contentSetRequests.length;
        const clearRequestsBeforeReconnect = server.clearRequests.length;
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      const firstPane = surface.panes.get(firstPaneId);
      assert.ok(firstPane);
      removeDurableSelfAuthority(runtime, surface, server.surfaceId);
      internalRuntime.restartContentBySurface = new Map([
        [
          server.surfaceId,
          [
            {
              contentId: "ct_stale_foreign_busy_restart",
              contentType: "markdown",
              contentValue: "# stale restart before foreign busy",
              historyOwnerToken: "hot_stale_foreign_busy_restart",
              paneLabel: firstPane.paneLabel,
              revision: 999,
              sessionKey: "agent:test:foreign-busy-stale-restart",
            },
          ],
          ],
        ]);

        server.resetToSinglePane();
        server.busyWithoutTakeoverResponsesRemaining = 1;
        server.busyWithoutTakeoverMessage = "Surface ownership lock is held by another provider";
        await surface.client.close(1000, "test_foreign_busy_clears_content_before_fresh_pair");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      const screens = await runtime.listScreens();
      const pane = screens[0]?.panes[0];
      assert.ok(pane);
        assert.equal(pane.activeContent, null);
        assert.equal(internalRuntime.restartContentBySurface.has(server.surfaceId), false);
        assert.equal(server.contentSetRequests.length, contentRequestsBeforeReconnect);
        assert.equal(server.clearRequests.length, clearRequestsBeforeReconnect);
        assert.ok(warnings.some((warning) => warning.includes("foreign_ownership_lock_cleared")));
      });
    });

    await t.test("fresh pair clears legacy partial target state instead of preserving it", async () => {
      await withRuntimeHarness(async ({ runtime, server }) => {
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        assert.ok(surface.client);
        surface.hasPairedInGatewaySession = false;
        surface.sessionId = null;
        surface.localOwnership = null;
        internalRuntime.persistentState.targetStateBySurfaceId = {
          [server.surfaceId]: {
            ownershipEpoch: 1,
            paneTargets: {},
          },
        };

        server.resetToSinglePane();
        await surface.client.close(1000, "test_legacy_partial_target_state_fresh_pair");

        await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
        await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

        const persisted = internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId];
        assert.ok(persisted);
        assert.deepEqual(persisted.targetRecords, []);
        assert.deepEqual(persisted.registeredTargetIdsByIdempotencyKey, {});
        assert.equal(Object.values(persisted.paneTargets).some((paneTarget: any) => paneTarget.currentTargetId !== null), false);
      });
    });

    await t.test("fresh pair with persisted target evidence uses pair-response ownership epoch for new targets", async () => {
      await withRuntimeHarness({
        configureServer: (server) => {
          server.targetCapabilities = [
            ...server.targetCapabilities,
            "target.browser_url.v1",
          ];
        },
        run: async ({ runtime, server }) => {
          const internalRuntime = runtime as any;
          const surface = internalRuntime.surfaces.get(server.surfaceId);
          assert.ok(surface);
          assert.ok(surface.client);
          surface.hasPairedInGatewaySession = false;
          surface.sessionId = null;
          surface.localOwnership = null;
          internalRuntime.persistentState.targetStateBySurfaceId = {
            [server.surfaceId]: {
              ownershipEpoch: 41,
              paneTargets: {},
              registeredTargetIdsByIdempotencyKey: {},
              targetRecords: [],
            },
          };

          server.resetToSinglePane();
          await surface.client.close(1000, "test_fresh_pair_target_epoch_authority");
          await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
          await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

          const paneId = await livePaneId(runtime, server.surfaceId, 1);
          const result = await runtime.push(
            {
              content: "https://example.com",
              contentType: "browser_url",
              fingerprint: server.surfaceId,
              paneId,
            },
            { sessionKey: "agent:test:fresh-pair-target-epoch" },
          );

          assert.equal(result.blockedReason, null);
          assert.equal(server.targetApplyRequests.at(-1)?.ownershipEpoch, server.pairResponseOwnershipEpoch);
        },
      });
    });

    await t.test("ambiguous busy marks same-provider target evidence stale before fresh pair replay", async () => {
      await withRuntimeHarness({
        configureServer: (server) => {
          server.targetCapabilities = [
            ...server.targetCapabilities,
            "target.browser_url.v1",
          ];
        },
        run: async ({ runtime, server, warnings }) => {
          const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
          await runtime.push(
            {
              content: "https://example.com",
              contentType: "browser_url",
              fingerprint: server.surfaceId,
              paneId: firstPaneId,
            },
            { sessionKey: "agent:test:foreign-busy-preserve-target-state" },
          );

          const targetApplyRequestsBeforeReconnect = server.targetApplyRequests.length;
          const internalRuntime = runtime as any;
          const surface = internalRuntime.surfaces.get(server.surfaceId);
          assert.ok(surface);
          const target = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
          assert.ok(target);
          target.ownershipSessionId = "sa_previous_foreign_session";
          surface.targetRecords.set(target.targetId, target);
          internalRuntime.captureSurfaceTargetState(surface);
          removeDurableSelfAuthority(runtime, surface, server.surfaceId);

          server.resetToSinglePane();
          server.busyWithoutTakeoverResponsesRemaining = 1;
          server.busyWithoutTakeoverMessage = "Surface ownership lock is held by another provider";
          await surface.client.close(1000, "test_foreign_busy_preserves_target_state_evidence");

          await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
          await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

          const targetState = internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId];
          assert.ok(targetState);
          assert.equal(
            targetState.targetRecords.some(
              (record: any) => record.targetId === target.targetId && record.currentState === "stale",
            ),
            true,
          );
          const reconnectedPane = (await runtime.listScreens())[0]?.panes[0];
          assert.equal(reconnectedPane?.target?.targetId, target.targetId);
          assert.equal(reconnectedPane?.target?.targetKind, "browser_url");
          assert.equal(reconnectedPane?.target?.blockedReason, "restore_blocked_stale_target");
          assert.equal(server.targetApplyRequests.length, targetApplyRequestsBeforeReconnect);
          assert.ok(warnings.some((warning) => warning.includes("foreign_ownership_lock_cleared")));
        },
      });
    });

    await t.test("foreign-provider busy drops passive targets from mixed preserved evidence", async () => {
      await withRuntimeHarness({
        configureServer: (server) => {
          server.targetCapabilities = [
            ...server.targetCapabilities,
            "target.browser_url.v1",
          ];
        },
        run: async ({ runtime, server, warnings }) => {
          const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
          await runtime.push(
            {
              content: "https://example.com",
              contentType: "browser_url",
              fingerprint: server.surfaceId,
              paneId: firstPaneId,
            },
            { sessionKey: "agent:test:foreign-busy-mixed-target-state" },
          );

          const internalRuntime = runtime as any;
          const surface = internalRuntime.surfaces.get(server.surfaceId);
          assert.ok(surface);
          const processTarget = [...surface.targetRecords.values()].find((record: any) => record.targetKind === "browser_url");
          assert.ok(processTarget);
          const passiveTarget = {
            ...structuredClone(processTarget),
            targetHeader: {
              payloadSchemaVersion: 1,
              replaySemantics: "bytes",
              requiredCapabilities: ["target.markdown.v1"],
              safeToLogFields: [],
              safetyClass: "passive",
              summary: "stale passive foreign content",
            },
            targetId: "tg_stale_passive_foreign_content",
            targetKind: "markdown",
            targetPayload: { markdown: "# stale passive foreign content" },
          };
          surface.targetRecords.set(passiveTarget.targetId, passiveTarget);
          internalRuntime.captureSurfaceTargetState(surface);
          const paneTarget = Object.values(
            internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId].paneTargets,
          )[0] as any;
          paneTarget.lastRestoreBlockedReason = "ownership_session_mismatch";
          paneTarget.diagnosticContent = {
            derivedFromTargetId: passiveTarget.targetId,
            diagnosticContentId: "dg_stale_passive_foreign_content",
            kind: "status",
            paneLineageId: passiveTarget.paneLineageId,
            shownAt: new Date().toISOString(),
            summary: "stale passive foreign content",
            surfaceId: server.surfaceId,
          };
          paneTarget.nonDurableTargetDiagnostic = {
            blockedReason: "ownership_session_mismatch",
            diagnosticContent: paneTarget.diagnosticContent,
            lastApplyEvidence: null,
            paneLineageId: passiveTarget.paneLineageId,
            targetHeader: structuredClone(passiveTarget.targetHeader),
            targetId: passiveTarget.targetId,
            targetKind: passiveTarget.targetKind,
            targetPayload: structuredClone(passiveTarget.targetPayload),
            targetPolicy: passiveTarget.restorePolicy,
          };
          assert.equal(
            internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId].targetRecords.some(
              (record: any) => record.targetId === passiveTarget.targetId,
            ),
            true,
          );
          removeDurableSelfAuthority(runtime, surface, server.surfaceId);

          server.resetToSinglePane();
          server.busyWithoutTakeoverResponsesRemaining = 1;
          server.busyWithoutTakeoverMessage = "Surface ownership lock is held by another provider";
          await surface.client.close(1000, "test_foreign_busy_drops_passive_mixed_target_state");

          await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
          await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

          const targetState = internalRuntime.persistentState.targetStateBySurfaceId[server.surfaceId];
          assert.ok(targetState);
          assert.equal(
            targetState.targetRecords.some((record: any) => record.targetId === processTarget.targetId),
            true,
          );
          assert.equal(
            targetState.targetRecords.some((record: any) => record.targetId === passiveTarget.targetId),
            false,
          );
          for (const retainedPaneTarget of Object.values(targetState.paneTargets) as any[]) {
            assert.notEqual(retainedPaneTarget.lastRestoreBlockedReason, "ownership_session_mismatch");
            assert.notEqual(retainedPaneTarget.diagnosticContent?.derivedFromTargetId, passiveTarget.targetId);
            assert.notEqual(retainedPaneTarget.nonDurableTargetDiagnostic?.targetId, passiveTarget.targetId);
          }
          assert.ok(warnings.some((warning) => warning.includes("foreign_ownership_lock_cleared")));
        },
      });
    });

    await t.test("foreign-provider busy drops stale provider topology before later fresh pair", async () => {
      await withRuntimeHarness(async ({ runtime, server, warnings }) => {
        const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
        const split = await runtime.split({
          count: 3,
          direction: "horizontal",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        });
        assertPaneLabelsWithOpaqueIds(split, [1, 2, 3]);
        const topologyRequestsBeforeReconnect = server.topologyApplyRequests.length;
        const internalRuntime = runtime as any;
        const surface = internalRuntime.surfaces.get(server.surfaceId);
        assert.ok(surface);
        assert.equal(surface.panes.size, 3);
        assert.ok(surface.topologyRevision > 0);
        removeDurableSelfAuthority(runtime, surface, server.surfaceId);

        server.resetToSinglePane();
        server.busyWithoutTakeoverResponsesRemaining = 1;
        server.busyWithoutTakeoverMessage = "Surface ownership lock is held by another provider";
        await surface.client.close(1000, "test_foreign_busy_drops_stale_provider_topology");

        await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
        await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

        const screens = await runtime.listScreens();
        assert.equal(screens[0]?.panes.length, 1);
        assertPaneLabelsWithOpaqueIds(screens[0]?.panes ?? [], [1]);
        assert.equal(server.topologyApplyRequests.length, topologyRequestsBeforeReconnect);
        assert.equal(surface.panes.size, 1);
        assert.equal(surface.topologyRevision, 0);
        assert.ok(warnings.some((warning) => warning.includes("foreign_ownership_lock_cleared")));
      });
    });

    await t.test("foreign-provider busy clears stale local ownership before exposure", async () => {
    await withRuntimeHarness(async ({ runtime, server, stateDir, warnings }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.push(
        {
          content: "# stale foreign busy",
          contentType: "markdown",
          fingerprint: server.surfaceId,
          paneId: firstPaneId,
        },
        { sessionKey: "agent:test:foreign-busy-stale" },
      );
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      assert.equal(surface.hasPairedInGatewaySession, true);
      assert.notEqual(surface.sessionId, null);
      removeDurableSelfAuthority(runtime, surface, server.surfaceId);

      server.busyWithoutTakeoverResponsesRemaining = 100;
      server.busyWithoutTakeoverMessage = "Surface ownership lock is held by another provider";
      await surface.client.close(1000, "test_foreign_busy_clears_local_ownership");

      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(() => surface.sessionId === null && surface.hasPairedInGatewaySession === false, 12_000);

      const screens = await runtime.listScreens();
      assert.equal(screens.some((entry) => entry.fingerprint === server.surfaceId), false);
      assert.equal(internalRuntime.surfaces.has(server.surfaceId), true);
      await assert.rejects(
        async () => await runtime.read({ fingerprint: server.surfaceId, paneId: firstPaneId }),
        /Unknown Surf Ace surface/,
      );
      await assert.rejects(
        async () => await runtime.snapshot({ fingerprint: server.surfaceId, paneId: firstPaneId }),
        /Unknown Surf Ace surface/,
      );

      await internalRuntime.persistScreenSnapshot();
      let persistedSnapshot: any = null;
      await waitFor(async () => {
        const rawSnapshot = await fs.readFile(path.join(stateDir, "surf-ace-runtime-screens.json"), "utf8");
        if (rawSnapshot.length === 0) {
          return false;
        }
        try {
          persistedSnapshot = JSON.parse(rawSnapshot);
          return true;
        } catch {
          return false;
        }
      });
      assert.equal(persistedSnapshot.screens.some((entry: any) => entry.fingerprint === server.surfaceId), false);
      assert.equal(persistedSnapshot.contentContinuity?.[server.surfaceId], undefined);
      assert.ok(warnings.some((warning) => warning.includes("foreign_ownership_lock_cleared")));
    });
  });

  await t.test("busy on an unknown surface remains explicit operator reclaim", async () => {
    const port = nextPort++;
    const server = new FakeSurfAceWsServer(port, { surfaceId: "sf_foreign_busy" });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-ext-foreign-busy-"));
    const warnings: string[] = [];
    const discovery = new StaticDiscoveryService([discoveryEndpoint(port)]);
    const runtime = createSurfAceRuntime({
      discovery,
      logger: {
        error: () => {},
        info: () => {},
        warn: (message: string) => warnings.push(message),
      },
      stateDir,
    });
    server.busyWithoutTakeoverResponsesRemaining = 1;

    try {
      await runtime.start();
      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(0, 2).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) => warning.includes("backing off") && warning.includes("takeover requires explicit user action")),
      );
    } finally {
      await runtime.stop();
      await server.close();
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  await t.test("invalid_resume after a cold-start reconnect retries fresh without takeover", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      delete internalRuntime.persistentState.selfOwnedSurfaceIds?.[server.surfaceId];

      server.invalidResumeWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_cold_start_invalid_resume_fresh");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.resumeSessionId),
        [null, null],
      );
      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) =>
          warning.includes("retrying fresh (no takeover)")),
      );
      assert.equal(surface.sessionId, "sa_test_session");
    });
  });

  await t.test("rediscovered nil-session active ownership lock self-reclaims without opening circuit", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      const providerId = server.pairAttemptDetails[0]?.providerId;
      assert.equal(typeof providerId, "string");

      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      surface.localOwnership = null;
      delete internalRuntime.persistentState.selfOwnedSurfaceIds?.[server.surfaceId];
      delete internalRuntime.persistentState.targetStateBySurfaceId?.[server.surfaceId];
      server.lockedProviderId = providerId ?? null;
      server.lockedSessionId = "sa_restart_active_lock";

      await surface.client.close(1000, "test_nil_session_active_lock_self_reclaim");

      await waitFor(() => server.pairAttemptDetails.length >= 4, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 4).map((attempt) => attempt.resumeSessionId),
        [null, null, null],
      );
      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 4).map((attempt) => attempt.takeover),
        [false, false, true],
      );
      assert.equal(surface.autoRetryEnabled, true);
      assert.equal(surface.connectionCircuitOpenedAt, null);
      assert.equal(surface.unreachableFailures, 0);
      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      assert.equal(screen.connectionState, "connected");
      assert.equal(screen.authority.actionable, true);
      assert.equal(screen._debug.ownershipRecovery, "active");
      assert.ok(
        warnings.some((warning) => warning.includes("ownership_self_reclaim") && warning.includes(server.surfaceId)),
      );
    });
  });

  await t.test("durable different-provider target proof blocks active-lock self-reclaim", async () => {
    await withRuntimeHarness(async ({ runtime, server }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      const providerId = server.pairAttemptDetails[0]?.providerId;
      assert.equal(typeof providerId, "string");

      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      surface.localOwnership = null;
      delete internalRuntime.persistentState.selfOwnedSurfaceIds?.[server.surfaceId];
      internalRuntime.persistentState.targetStateBySurfaceId = {
        [server.surfaceId]: {
          paneTargets: {
            pl_different_install: {
              currentTargetId: "tg_different_install",
            },
          },
          registeredTargetIdsByIdempotencyKey: {},
          targetRecords: [
            {
              currentState: "current",
              ownerProviderId: "pv_different_install",
              ownershipSessionId: "sa_different_install",
              targetId: "tg_different_install",
            },
          ],
        },
      };
      server.lockUntilNewProviderIdCode = "invalid_resume";
      server.lockUntilNewProviderIdProviderId = providerId ?? null;

      await surface.client.close(1000, "test_durable_different_provider_blocks_active_lock_reclaim");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.resumeSessionId),
        [null, null],
      );
      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.takeover),
        [false, false],
      );
    });
  });

  await t.test("stale different-provider target record does not block active-lock self-reclaim", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      const providerId = server.pairAttemptDetails[0]?.providerId;
      assert.equal(typeof providerId, "string");

      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      surface.localOwnership = null;
      delete internalRuntime.persistentState.selfOwnedSurfaceIds?.[server.surfaceId];
      internalRuntime.persistentState.targetStateBySurfaceId = {
        [server.surfaceId]: {
          paneTargets: {
            pl_stale_different_install: {
              currentTargetId: null,
            },
          },
          registeredTargetIdsByIdempotencyKey: {},
          targetRecords: [
            {
              currentState: "stale",
              ownerProviderId: "pv_different_install",
              ownershipSessionId: "sa_different_install",
              targetId: "tg_stale_different_install",
            },
          ],
        },
      };
      server.lockedProviderId = providerId ?? null;
      server.lockedSessionId = "sa_restart_active_lock";

      await surface.client.close(1000, "test_stale_different_provider_does_not_block_active_lock_reclaim");

      await waitFor(() => server.pairAttemptDetails.length >= 4, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 4).map((attempt) => attempt.takeover),
        [false, false, true],
      );
      assert.equal(surface.autoRetryEnabled, true);
      assert.equal(surface.connectionCircuitOpenedAt, null);
      const screen = (await runtime.listScreens()).find((candidate) => candidate.fingerprint === server.surfaceId);
      assert.ok(screen);
      assert.equal(screen.authority.actionable, true);
      assert.ok(
        warnings.some((warning) => warning.includes("ownership_self_reclaim") && warning.includes(server.surfaceId)),
      );
    });
  });

  await t.test("cold-start invalid_resume ignores legacy endpoint mapping state without takeover", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      delete internalRuntime.persistentState.selfOwnedSurfaceIds?.[server.surfaceId];
      internalRuntime.persistentState.endpointSurfaces = {
        [surface.endpointId]: "sf_stale_surface",
      };

      server.invalidResumeWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_stale_endpoint_surface_mapping");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 20_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) =>
          warning.includes("retrying fresh (no takeover)")),
      );
      assert.equal(surface.sessionId, "sa_test_session");
    });
  });

  await t.test("cold-start invalid_resume with target state but no different-provider proof self-reclaims", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      const providerId = server.pairAttemptDetails[0]?.providerId;
      assert.equal(typeof providerId, "string");

      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      delete internalRuntime.persistentState.selfOwnedSurfaceIds?.[server.surfaceId];
      internalRuntime.persistentState.targetStateBySurfaceId = {
        [server.surfaceId]: {
          paneTargets: {},
          registeredTargetIdsByIdempotencyKey: {},
          targetRecords: [],
        },
      };
      server.lockUntilNewProviderIdCode = "invalid_resume";
      server.lockUntilNewProviderIdProviderId = providerId ?? null;

      await surface.client.close(1000, "test_cold_start_invalid_resume_self_reclaim");

      await waitFor(() => server.pairAttemptDetails.length >= 4, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 4).map((attempt) => attempt.resumeSessionId),
        [null, null, null],
      );
      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 4).map((attempt) => attempt.takeover),
        [false, false, true],
      );
      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 4).map((attempt) => attempt.providerId),
        [providerId, providerId, providerId],
      );
      assert.ok(
        warnings.some((warning) =>
          warning.includes("ownership_self_reclaim") &&
          warning.includes("reason=invalid_resume") &&
          warning.includes(server.surfaceId),
        ),
      );
    });
  });

  await t.test("busy with persisted target state but no resume session does not self-reclaim", async () => {
    await withRuntimeHarness(async ({ runtime, server, warnings }) => {
      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      surface.hasPairedInGatewaySession = false;
      surface.sessionId = null;
      delete internalRuntime.persistentState.selfOwnedSurfaceIds?.[server.surfaceId];
      internalRuntime.persistentState.targetStateBySurfaceId = {
        [server.surfaceId]: {
          paneTargets: {},
          registeredTargetIdsByIdempotencyKey: {},
          targetRecords: [],
        },
      };

      server.busyWithoutTakeoverResponsesRemaining = 1;
      await surface.client.close(1000, "test_persisted_target_state_no_takeover");

      await waitFor(() => server.pairAttemptDetails.length >= 3, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.deepEqual(
        server.pairAttemptDetails.slice(1, 3).map((attempt) => attempt.takeover),
        [false, false],
      );
      assert.ok(
        warnings.some((warning) =>
          warning.includes("ownership_self_reclaim_blocked") &&
          warning.includes("had_persisted_target_state=true")),
      );
    });
  });

  await t.test("provider-owned content during resumed replay is skipped without provider shutdown loop", async () => {
    await withRuntimeHarness(async ({ infos, runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.push({
        content: "<p>before reconnect</p>",
        contentType: "html",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      const internalRuntime = runtime as any;
      const surface = internalRuntime.surfaces.get(server.surfaceId);
      assert.ok(surface);
      assert.ok(surface.client);
      surface.topologyRevision = 1;

      await surface.client.close(1000, "test_stale_replay_skip");

      await waitFor(() => server.pairAttemptDetails.length >= 2, 12_000);
      await waitFor(async () => (await runtime.listScreens())[0]?.connectionState === "connected", 12_000);

      assert.ok(
        infos.some((info) =>
          info.includes("event=resume_replay_outcome") &&
          info.includes("outcome=skipped_provider_owned")),
      );
    });
  });

  await t.test("topology apply diagnostics include payload and before/after pane sets", async () => {
    await withRuntimeHarness(async ({ infos, runtime, server }) => {
      const firstPaneId = await livePaneId(runtime, server.surfaceId, 1);
      await runtime.split({
        count: 2,
        direction: "vertical",
        fingerprint: server.surfaceId,
        paneId: firstPaneId,
      });

      assert.ok(
        infos.some((info) =>
          info.includes("event=topology_apply_begin") &&
          info.includes("payload=") &&
          info.includes("before_pane_ids=") &&
          info.includes("expected_topology_revision=")),
      );
      assert.ok(
        infos.some((info) =>
          info.includes("event=topology_apply_ok") &&
          info.includes("after_pane_ids=") &&
          info.includes("created_pane_ids=") &&
          info.includes("response_panes=")),
      );
      assert.equal(server.topologyApplyRequests.length, 1);
    });
  });

});
