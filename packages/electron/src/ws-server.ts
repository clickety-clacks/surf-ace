import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WebSocket, WebSocketServer } from "ws";

import type {
  AnnotationsRemoveRequest,
  ContentApplyRequest,
  ContentAppendRequest,
  ContentClearRequest,
  ContentPatchRequest,
  ContentSetRequest,
  DrawingFlushConfig,
  Event,
  HeartbeatPingRequest,
  HistoryNavigatedEvent,
  RuntimeAppBindingDiagnostics,
  PaneCloseRequest,
  PaneRenameRequest,
  PaneSplitRequest,
  PanesListRequest,
  Request,
  Response,
  Selection,
  SnapshotGetRequest,
  SurfaceViewport,
  SurfacesListRequest,
  TargetApplyRequest,
  TargetApplyResponse,
  NativeHostMaterializedState,
  TargetMaterializedState,
  TopologyApplyRequest,
  Viewport,
} from "../../protocol/src/index.js";
import {
  SURF_ACE_LOCKLESS_V1_CAPABILITY,
  locklessPaneScopeId,
  validateLocklessEnvelope,
  type LocklessEvent,
  type LocklessErrorCode,
  type LocklessPairPayload,
  type LocklessRequest,
  type LocklessResponse,
  type LocklessTargetApplyResult,
  type LocklessTopologyRealizeResult,
} from "../../protocol/src/lockless.js";
import {
  compositorFailureMessage,
  isOverlayNativePaneLivenessFailure,
  type NativePaneMaterialization,
  nativePaneWindowGroupsFromCompositorStatus,
  nativePaneReleaseRequestForCompositor,
  overlayRequestForCompositor,
  overlayRegionsWithLivePaneInstanceAuthority,
  overlayTopologyEpochFromCompositorResponse,
  requestForCompositor,
  resolveCompositorControlSocketPath,
  sendCompositorControl,
  validateMaterializationAgainstCompositorStatus,
  type CompositorControlRequest,
  type CompositorControlResponse,
  type NativePaneWindowGroupStatus,
} from "./native-pane-bridge.js";
import {
  type ClientDiagnosticFields,
  clientDiagnosticLine,
  errorDiagnosticFields,
  recordClientDiagnostic,
} from "./client-flight-recorder.js";
import {
  isValidWindowLabel,
  SurfaceCore,
  SurfaceCoreError,
  type CoreEvent,
} from "./surface-core.js";
import {
  LocklessAuthorityError,
  type AuthorityEvent,
  type LocklessClientAuthority,
  type PersistentTargetApplyWorkItem,
  type PersistentTombstone,
} from "./lockless-client-authority.js";
import { PersistentStateOutcomeUnknownError } from "./persistent-state-file.js";

type SocketCacheEntry = {
  payloadHash: string;
  response: Response;
};

type LocklessTransportSession = {
  connectionSlot: string;
  connectionToken: string;
  controllerInstanceId: string;
  controllerProductName: string | null;
  surfaceId: string | null;
  socket: WebSocket;
};

type PendingBrowserUrlApply = {
  appliedAt: string;
  committedLocklessIntent: boolean;
  request: TargetApplyRequest;
  resolve: (payload: TargetApplyResponse["payload"]) => void;
  socket: WebSocket | null;
  timeout: NodeJS.Timeout;
};

type BrowserUrlNavigationEvidence = {
  currentUrl?: string;
  errorMessage?: string;
  pageTitle?: string;
  readbackResult?: string;
  status: "applied" | "failed";
  targetId: string;
  url: string;
};

type SocketMeta = {
  cache: Map<string, SocketCacheEntry>;
  pairedSurfaceId: string | null;
  remoteAddress: string;
  socketId: string;
};

export type SurfaceWsServerOptions = {
  bindAddress?: string;
  capturePaneImage: (surfaceId: string, paneId: number) => Promise<string | null>;
  core: SurfaceCore;
  endpointName: string;
  hostName: string;
  compositorSocketPath?: string | null;
  getOverlayDiagnostics?: (surfaceId: string) => Record<string, unknown> | null;
  nativeOverlayLivenessRetryCount?: number;
  nativeOverlayLivenessRetryDelayMs?: number;
  getRuntimeAppBinding?: () => Promise<RuntimeAppBindingDiagnostics | null> | RuntimeAppBindingDiagnostics | null;
  onNativeMaterialized?: (surfaceId: string, materialization: NativePaneMaterialization) => void;
  onNativeReleased?: (surfaceId: string, paneIds: string[]) => Promise<void> | void;
  persistLocklessState?: () => Promise<void>;
  port: number;
  protocolVersion?: number;
  viewport: () => SurfaceViewport;
  wsPath?: string;
};

const DEFAULT_DRAWING_FLUSH_CONFIG: DrawingFlushConfig = {
  idleWindowMs: 8_000,
  maxIntervalMs: 30_000,
};
const DEFAULT_LIMITS = {
  maxDrawingFlushBytes: 2 * 1024 * 1024,
  maxFrameBytes: 10 * 1024 * 1024,
  maxMessageBytes: 12 * 1024 * 1024,
  maxStrokePointsPerFlush: 8192,
  maxVisibleTextBytes: 4096,
};
const BROWSER_URL_NAVIGATION_TIMEOUT_MS = 8_000;
const PANE_GEOMETRY_READY_TIMEOUT_MS = 8_000;
const NATIVE_OVERLAY_LIVENESS_RETRY_COUNT = 80;
const NATIVE_OVERLAY_LIVENESS_RETRY_DELAY_MS = 100;
type ServerDiagnosticFields = ClientDiagnosticFields;

function serverDiagnostic(event: string, fields: ServerDiagnosticFields = {}): string {
  return clientDiagnosticLine("server", event, fields);
}

function diagnosticJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function metaConnectionToken(meta: SocketMeta | undefined): string {
  if (!meta) {
    throw new Error("Socket metadata is unavailable");
  }
  return meta.socketId;
}

function locklessSuccess(
  request: LocklessRequest,
  payload: unknown,
): unknown {
  return {
    id: request.id,
    ok: true,
    op: request.op,
    payload,
    sentAt: Date.now(),
    type: "response",
    v: 1,
  };
}

function browserUrlDiagnosticFields(url: string): ServerDiagnosticFields {
  try {
    const parsed = new URL(url);
    return {
      url,
      url_host: parsed.hostname,
      url_port: parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : ""),
      url_scheme: parsed.protocol.replace(/:$/, ""),
    };
  } catch {
    return {
      url,
      url_host: "invalid",
      url_port: "",
      url_scheme: "invalid",
    };
  }
}

function persistentServerDiagnostic(
  level: "info" | "warn" | "error",
  event: string,
  fields: ServerDiagnosticFields = {},
): void {
  recordClientDiagnostic(level, "server", event, fields);
}

function pairStateDiagnosticSummary(state: ReturnType<SurfaceCore["pairState"]>): string {
  const panes = state.panes.map((pane) =>
    `${Number(pane.paneId)}:${pane.paneLabel}:${pane.currentContentId ?? "nil"}`
  ).join(",");
  return `rev=${Number(state.topologyRevision)} panes=${panes || "none"} layout=${JSON.stringify(state.layout)}`;
}

export class SurfaceWsServer {
  private readonly bindAddress: string;
  private readonly compositorSocketPath: string | null;
  private readonly core: SurfaceCore;
  private readonly endpointName: string;
  private readonly hostName: string;
  private readonly getOverlayDiagnostics?: (surfaceId: string) => Record<string, unknown> | null;
  private readonly nativeOverlayLivenessRetryCount: number;
  private readonly nativeOverlayLivenessRetryDelayMs: number;
  private readonly getRuntimeAppBinding?: () => Promise<RuntimeAppBindingDiagnostics | null> | RuntimeAppBindingDiagnostics | null;
  private readonly onNativeMaterialized?: (surfaceId: string, materialization: NativePaneMaterialization) => void;
  private readonly onNativeReleased?: (surfaceId: string, paneIds: string[]) => Promise<void> | void;
  private readonly port: number;
  private readonly protocolVersion: number;
  private readonly persistLocklessState: () => Promise<void>;
  private readonly capturePaneImage: SurfaceWsServerOptions["capturePaneImage"];
  private readonly viewportProvider: SurfaceWsServerOptions["viewport"];
  private readonly pendingBrowserUrlApplies = new Map<string, PendingBrowserUrlApply>();
  private readonly earlyBrowserUrlNavigationEvidence = new Map<string, BrowserUrlNavigationEvidence>();
  readonly wsPath: string;

  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly socketMeta = new WeakMap<WebSocket, SocketMeta>();
  private readonly locklessSessions = new Map<WebSocket, LocklessTransportSession>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private lifecycleMutationQueue: Promise<void> = Promise.resolve();
  private providerWindowLabelQueue: Promise<void> = Promise.resolve();
  private ignoreInitialSurfaceEvents = true;
  private persistenceOutcomeUnknown: PersistentStateOutcomeUnknownError | null = null;

  constructor(options: SurfaceWsServerOptions) {
    this.bindAddress = options.bindAddress ?? "0.0.0.0";
    this.capturePaneImage = options.capturePaneImage;
    this.compositorSocketPath = options.compositorSocketPath === undefined
      ? resolveCompositorControlSocketPath()
      : options.compositorSocketPath;
    this.core = options.core;
    this.endpointName = options.endpointName;
    this.getOverlayDiagnostics = options.getOverlayDiagnostics;
    this.getRuntimeAppBinding = options.getRuntimeAppBinding;
    this.hostName = options.hostName;
    this.nativeOverlayLivenessRetryCount = options.nativeOverlayLivenessRetryCount ?? NATIVE_OVERLAY_LIVENESS_RETRY_COUNT;
    this.nativeOverlayLivenessRetryDelayMs = options.nativeOverlayLivenessRetryDelayMs ?? NATIVE_OVERLAY_LIVENESS_RETRY_DELAY_MS;
    this.onNativeMaterialized = options.onNativeMaterialized;
    this.onNativeReleased = options.onNativeReleased;
    this.port = options.port;
    const persistLocklessState = options.persistLocklessState ?? (async () => {});
    this.persistLocklessState = async () => {
      if (this.persistenceOutcomeUnknown) throw this.persistenceOutcomeUnknown;
      try {
        await persistLocklessState();
      } catch (error) {
        if (error instanceof PersistentStateOutcomeUnknownError) {
          this.failStopPersistence(error);
        }
        throw error;
      }
    };
    this.protocolVersion = options.protocolVersion ?? 1;
    this.viewportProvider = options.viewport;
    this.wsPath = options.wsPath ?? "/ws";

    this.httpServer = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
        return;
      }
      response.writeHead(404);
      response.end();
    });
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (request, socket, head) => {
      if (this.persistenceOutcomeUnknown) {
        socket.destroy();
        return;
      }
      if (request.url !== this.wsPath) {
        persistentServerDiagnostic(
          "warn",
          "socket_reject",
          {
            path: request.url ?? "<none>",
            reason: "bad_path",
          },
        );
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (websocket) => {
        this.wss.emit("connection", websocket, request);
      });
    });

    this.wss.on("connection", (socket, request) => {
      const remoteAddress = request.socket.remoteAddress ?? "<unknown>";
      const socketId = `sock_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      this.socketMeta.set(socket, {
        cache: new Map(),
        pairedSurfaceId: null,
        remoteAddress,
        socketId,
      });
      persistentServerDiagnostic(
        "info",
        "socket_open",
        {
          path: request.url ?? this.wsPath,
          remote_address: remoteAddress,
          socket_id: socketId,
        },
      );
      socket.on("message", (data) => {
        void this.handleMessage(socket, data.toString("utf8")).catch((error) => {
          persistentServerDiagnostic(
            "error",
            "socket_message_handler_failed",
            {
              paired_surface_id: this.socketMeta.get(socket)?.pairedSurfaceId,
              socket_id: this.socketMeta.get(socket)?.socketId,
              ...errorDiagnosticFields(error),
            },
          );
        });
      });
      socket.on("error", (error) => {
        const meta = this.socketMeta.get(socket);
        persistentServerDiagnostic(
          "warn",
          "socket_error",
          {
            paired_surface_id: meta?.pairedSurfaceId,
            socket_id: meta?.socketId,
            ...errorDiagnosticFields(error),
          },
        );
      });
      socket.on("close", (code, reasonBuffer) => {
        const meta = this.socketMeta.get(socket);
        const reason = reasonBuffer.toString() || "<none>";
        persistentServerDiagnostic(
          "info",
          "socket_close",
          {
            code,
            paired_surface_id: meta?.pairedSurfaceId,
            reason,
            socket_id: meta?.socketId,
          },
        );
        this.handleSocketClosed(socket);
      });
    });

    this.core.subscribe((event) => {
      void this.handleCoreEvent(event).catch(() => {});
    });
    this.core.locklessAuthority.subscribe((event) => {
      void this.sendLocklessAuthorityEvent(event).catch(() => {});
    });
  }

  async start(): Promise<void> {
    persistentServerDiagnostic(
      "info",
      "server_bind_start",
      {
        host: this.bindAddress,
        port: this.port,
        ws_path: this.wsPath,
      },
    );
    await this.resumeTargetApplyWorkItems();
    await new Promise<void>((resolve, reject) => {
      this.httpServer.listen(this.port, this.bindAddress, () => resolve());
      this.httpServer.once("error", reject);
    });
    this.ignoreInitialSurfaceEvents = false;
    persistentServerDiagnostic(
      "info",
      "server_bind_ok",
      {
        endpoint_name: this.endpointName,
        host: this.bindAddress,
        host_name: this.hostName,
        port: this.port,
        ws_path: this.wsPath,
      },
    );
  }

  async stop(): Promise<void> {
    persistentServerDiagnostic(
      "info",
      "server_stop_begin",
      {
        controller_connections: this.locklessSessions.size,
      },
    );
    for (const session of this.locklessSessions.values()) {
      session.socket.close(1000, "provider_shutdown");
    }
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        this.httpServer.close((serverError) => {
          if (serverError) {
            reject(serverError);
            return;
          }
          resolve();
        });
      });
    });
    persistentServerDiagnostic("info", "server_stop_ok");
  }

  failStopPersistence(error: PersistentStateOutcomeUnknownError): void {
    if (this.persistenceOutcomeUnknown) return;
    // Set synchronously: this is what actually blocks every future admission
    // and mutation attempt (checked at the top of the wrapped
    // persistLocklessState, and independently by SurfaceCore's own
    // admissionFailStop), so no candidate can proceed and no sequence can be
    // reused regardless of when the sockets below actually close.
    this.persistenceOutcomeUnknown = error;
    persistentServerDiagnostic("error", "persistence_outcome_unknown_fail_stop", {
      ...errorDiagnosticFields(error.cause),
    });
    // Deferred to a macrotask so the request that TRIGGERED this fail-stop
    // gets its bounded error response sent first. Closing synchronously here
    // (the previous behavior) marks every socket, including the caller's own,
    // as no longer OPEN before dispatch ever reaches the point of sending a
    // reply, so `this.send` silently drops it and the caller times out
    // instead of receiving an answer.
    setImmediate(() => {
      for (const socket of this.wss.clients) {
        socket.close(1011, "persistence_outcome_unknown");
      }
    });
  }

  advertisedTxt(fingerprintPrefix: string): Record<string, string> {
    const viewport = this.viewportProvider();
    return {
      busy: "0",
      cap: String(contentBitmask(this.core.capabilities().contentTypes)),
      h: String(viewport.height),
      name: this.endpointName,
      pk: fingerprintPrefix,
      s: String(viewport.scale),
      tls: "0",
      v: String(this.protocolVersion),
      w: String(viewport.width),
      ws: this.wsPath,
    };
  }

  async emitTap(surfaceId: string, paneId: number, payload: {
    kind: "tap" | "long_press";
    nearestContent?: string;
    position: { x: number; y: number };
  }): Promise<void> {
    const state = this.tryCaptureSnapshot(surfaceId, paneId);
    if (!state) {
      return;
    }
    if (!state.contentId) {
      return;
    }
    const event = {
      eventId: makeEventId(),
      op: "event.tap",
      payload: {
        contentId: state.contentId,
        kind: payload.kind,
        nearestContent: payload.nearestContent,
        paneId,
        position: payload.position,
        revision: state.revision,
      },
      sentAt: Date.now(),
      type: "event",
      v: 1,
    } as const;
    await this.ingestLocklessPaneConsumable(
      surfaceId,
      paneId,
      "tap",
      event.payload,
      "renderer.tap",
    );
  }

  async emitSelection(
    surfaceId: string,
    paneId: number,
    selection: Selection,
  ): Promise<void> {
    const state = this.tryCaptureSnapshot(surfaceId, paneId);
    if (!state) {
      return;
    }
    if (!state.contentId) {
      return;
    }
    const event = {
      eventId: makeEventId(),
      op: "event.selection",
      payload: {
        contentId: state.contentId,
        paneId,
        revision: state.revision,
        selection,
      },
      sentAt: Date.now(),
      type: "event",
      v: 1,
    } as const;
    await this.ingestLocklessPaneConsumable(
      surfaceId,
      paneId,
      "selection",
      event.payload,
      "renderer.selection",
    );
  }

  async emitScroll(
    surfaceId: string,
    paneId: number,
    viewport: Viewport,
    visibleText: string,
  ): Promise<void> {
    const state = this.tryCaptureSnapshot(surfaceId, paneId);
    if (!state) {
      return;
    }
    if (!state.contentId) {
      return;
    }
    const event = {
      eventId: makeEventId(),
      op: "event.scroll",
      payload: {
        contentId: state.contentId,
        paneId,
        phase: "settled",
        revision: state.revision,
        viewport,
        visibleText,
      },
      sentAt: Date.now(),
      type: "event",
      v: 1,
    } as const;
    await this.ingestLocklessPaneConsumable(
      surfaceId,
      paneId,
      "scroll",
      event.payload,
      "renderer.scroll",
    );
  }

  async emitNavigation(
    surfaceId: string,
    paneId: number,
    url: string,
    navigationState?: { contentId: string; revision: number },
  ): Promise<void> {
    const state = navigationState ?? (() => {
      const snapshot = this.tryCaptureSnapshot(surfaceId, paneId);
      if (!snapshot || !snapshot.contentId || snapshot.contentType !== "html") {
        return null;
      }
      return {
        contentId: snapshot.contentId,
        revision: snapshot.revision,
      };
    })();
    if (!state) {
      return;
    }
    const event = {
      eventId: makeEventId(),
      op: "event.navigation",
      payload: {
        contentId: state.contentId,
        paneId,
        revision: state.revision,
        url,
      },
      sentAt: Date.now(),
      type: "event",
      v: 1,
    } as const;
    await this.ingestLocklessPaneConsumable(
      surfaceId,
      paneId,
      "navigation",
      event.payload,
      "renderer.navigation",
    );
  }

  async emitPage(
    surfaceId: string,
    paneId: number,
    payload: { page: number; pageText?: string; totalPages: number },
  ): Promise<void> {
    const state = this.tryCaptureSnapshot(surfaceId, paneId);
    if (!state) {
      return;
    }
    if (!state.contentId) {
      return;
    }
    const event = {
      eventId: makeEventId(),
      op: "event.page",
      payload: {
        contentId: state.contentId,
        page: payload.page,
        pageText: payload.pageText,
        paneId,
        revision: state.revision,
        totalPages: payload.totalPages,
      },
      sentAt: Date.now(),
      type: "event",
      v: 1,
    } as const;
    await this.ingestLocklessPaneConsumable(
      surfaceId,
      paneId,
      "page",
      event.payload,
      "renderer.page",
    );
  }

  private async ingestLocklessPaneConsumable(
    surfaceId: string,
    paneId: number,
    recordClass: import("../../protocol/src/lockless.js").ConsumableRecordClass,
    payload: unknown,
    triggerOperation: string,
  ): Promise<void> {
    const scopeId = locklessPaneScopeId(surfaceId, paneId);
    const record = await this.core.locklessAuthority.transactionAsync(async () => {
      const appended = this.core.locklessAuthority.appendConsumable({
        payload,
        recordClass,
        scopeId,
        scopeKind: "pane",
        triggerOperation,
      });
      this.core.markLocklessAuthorityChanged(surfaceId);
      await this.persistLocklessState();
      return appended;
    });
    if (record) {
      await this.broadcastLocklessDelta(scopeId, [record]);
    }
  }

  private async ingestLocklessSurfaceConsumable(
    surfaceId: string,
    recordClass: import("../../protocol/src/lockless.js").ConsumableRecordClass,
    payload: unknown,
    triggerOperation: string,
  ): Promise<void> {
    const scopeId = `surface:${encodeURIComponent(surfaceId)}`;
    const record = await this.core.locklessAuthority.transactionAsync(async () => {
      const appended = this.core.locklessAuthority.appendConsumable({
        payload,
        recordClass,
        scopeId,
        scopeKind: "surface",
        triggerOperation,
      });
      this.core.markLocklessAuthorityChanged(surfaceId);
      await this.persistLocklessState();
      return appended;
    });
    if (record) {
      await this.broadcastLocklessDelta(scopeId, [record]);
    }
  }

  private async updateLocklessAnnotationFrame(
    surfaceId: string,
    paneId: number,
  ): Promise<void> {
    const payload = this.core.buildDrawingFlush(
      surfaceId,
      paneId,
      DEFAULT_DRAWING_FLUSH_CONFIG,
      "idle_window",
    );
    if (!payload) return;
    const scopeId = locklessPaneScopeId(surfaceId, paneId);
    const frameId = `annotation:${payload.contentId}`;
    const record = await this.core.locklessAuthority.transactionAsync(async () => {
      const updated = this.core.locklessAuthority.updateLiveFrame({
        frameId,
        payload: { ...payload, flushId: frameId },
        scopeId,
        triggerOperation: "renderer.annotation_live",
      });
      this.core.markLocklessAuthorityChanged(surfaceId);
      await this.persistLocklessState();
      return updated;
    });
    if (record) {
      await this.broadcastLocklessDelta(scopeId, [record]);
    }
  }

  async broadcastSurfaceAppeared(surfaceId: string): Promise<void> {
    if (this.ignoreInitialSurfaceEvents) {
      return;
    }
    const surface = this.core.getSurface(surfaceId);
    await this.broadcastLifecycleEvent({
      eventId: makeEventId(),
      op: "event.surface_appeared",
      payload: {
        name: surface.name,
        surfaceId,
        viewport: this.core.viewport(surfaceId),
      },
      sentAt: Date.now(),
      type: "event",
      v: 1,
    });
  }

  async broadcastSurfaceRemoved(surfaceId: string): Promise<void> {
    await this.broadcastLifecycleEvent({
      eventId: makeEventId(),
      op: "event.surface_removed",
      payload: { surfaceId },
      sentAt: Date.now(),
      type: "event",
      v: 1,
    });
  }

  async closeSurfaceFromLocalUser(surfaceId: string): Promise<{
    surfaceId: string;
    surfaceSetRevision: number;
    tombstoneId: string;
  }> {
    const result = await this.core.locklessAuthority.transactionAsync(async () => {
      const committed = await this.runLifecycleTransaction(() => {
        const record = this.core.captureSurfaceTombstonePayload(surfaceId);
        const paneTombstones =
          this.core.locklessAuthority.takePaneTombstonesForSurface(
            surfaceId,
          );
        const tombstone = this.core.locklessAuthority.createTombstone({
          kind: "surface",
          payload: { paneTombstones, surface: record },
          surfaceId,
        });
        this.core.removeSurface(surfaceId);
        return {
          surfaceId,
          surfaceSetRevision:
            this.core.locklessAuthority.advanceSurfaceSetRevision(),
          tombstoneId: tombstone.tombstoneId,
        };
      }, surfaceId);
      await this.persistLocklessState();
      return committed;
    });
    this.core.markLocklessAuthorityChanged();
    return result;
  }

  async openSurfaceFromLocalUser(): Promise<{
    surfaceId: string;
    surfaceSetRevision: number;
  }> {
    const result = await this.core.locklessAuthority.transactionAsync(
      async () => {
        const committed = await this.runLifecycleTransaction(() => {
          this.core.locklessAuthority.assertPaneCreationCapacity(0, 1);
          const surface = this.core.createLocklessSurface(
            "Surf Ace",
            this.viewportProvider(),
          );
          this.core.locklessAuthority.ensureScope(
            `surface:${encodeURIComponent(surface.surfaceId)}`,
            "surface",
          );
          for (const paneId of this.core.activePaneIds(surface.surfaceId)) {
            this.core.locklessAuthority.ensureScope(
              locklessPaneScopeId(surface.surfaceId, paneId),
              "pane",
            );
          }
          return {
            surfaceId: surface.surfaceId,
            surfaceSetRevision:
              this.core.locklessAuthority.advanceSurfaceSetRevision(),
          };
        });
        await this.persistLocklessState();
        return committed;
      },
    );
    this.core.markLocklessAuthorityChanged(result.surfaceId);
    return result;
  }

  disconnectLocklessSurfaceSessions(
    surfaceId: string,
    reason = "surface_closed",
  ): void {
    for (const session of [...this.locklessSessions.values()]) {
      if (session.surfaceId === surfaceId) {
        session.socket.close(1000, reason);
      }
    }
  }

  private async handleCoreEvent(event: CoreEvent): Promise<void> {
    switch (event.type) {
      case "lockless-authority-changed":
        return;
      case "annotation-committed":
        await this.maybeSendAnnotationCommitted(event.surfaceId, event.paneId);
        return;
      case "drawing-dirty":
        await this.updateLocklessAnnotationFrame(
          event.surfaceId,
          event.paneId,
        );
        return;
      case "history-navigated":
        await this.maybeSendHistoryNavigated(event);
        return;
      case "pane-created":
        await this.broadcastLifecycleEvent({
          eventId: makeEventId(),
          op: "event.pane_created",
          payload: {
            fromSplit: event.fromSplit,
            paneId: event.paneId,
            paneLabel: event.paneLabel,
            parentPaneId: event.parentPaneId,
            surfaceId: event.surfaceId,
          },
          sentAt: Date.now(),
          type: "event",
          v: 1,
        });
        return;
      case "pane-removed":
        await this.broadcastLifecycleEvent({
          eventId: makeEventId(),
          op: "event.pane_removed",
          payload: {
            paneId: event.paneId,
            surfaceId: event.surfaceId,
          },
          sentAt: Date.now(),
          type: "event",
          v: 1,
        });
        return;
      case "pane-renamed":
        await this.broadcastLifecycleEvent({
          eventId: makeEventId(),
          op: "event.pane_renamed",
          payload: {
            name: event.name,
            paneId: event.paneId,
            surfaceId: event.surfaceId,
          },
          sentAt: Date.now(),
          type: "event",
          v: 1,
        });
        return;
      case "topology-changed": {
        const topology = this.core.topologyState(event.surfaceId);
        await this.ingestLocklessSurfaceConsumable(
          event.surfaceId,
          "topology",
          topology,
          "client.topology",
        );
        await this.broadcastLifecycleEvent({
          eventId: makeEventId(),
          op: "event.topology_changed",
          payload: {
            layout: topology.layout,
            panes: topology.panes,
            surfaceId: event.surfaceId as never,
            topologyRevision: topology.topologyRevision,
          },
          sentAt: Date.now(),
          type: "event",
          v: 1,
        });
        return;
      }
      case "surface-created":
        await this.broadcastSurfaceAppeared(event.surfaceId);
        return;
      case "surface-removed":
        await this.broadcastSurfaceRemoved(event.surfaceId);
        return;
      case "surface-changed":
      case "pane-geometry-changed":
        return;
    }
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    const initialMeta = this.socketMeta.get(socket);
    let parsedRequest: Request | LocklessRequest;
    try {
      parsedRequest = JSON.parse(raw) as Request | LocklessRequest;
    } catch {
      persistentServerDiagnostic(
        "warn",
        "socket_protocol_violation",
        {
          reason: "invalid_json",
          socket_id: initialMeta?.socketId,
        },
      );
      socket.close(4410, "protocol_violation");
      return;
    }
    if (
      parsedRequest.op === "surfaces.list" &&
      !this.locklessSessions.has(socket)
    ) {
      await this.reply(
        socket,
        this.handleSurfacesList(parsedRequest as SurfacesListRequest),
      );
      return;
    }
    if (this.isLocklessWireRequest(socket, parsedRequest)) {
      await this.handleLocklessMessage(socket, parsedRequest);
      return;
    }
    const request = parsedRequest as Request;
    const code = request.op === "pair.request"
      ? "capability_mismatch"
      : "not_paired";
    const message = request.op === "pair.request"
      ? `pair.request requires ${SURF_ACE_LOCKLESS_V1_CAPABILITY}`
      : "Operation requires lockless pair.request first";
    await this.reply(
      socket,
      errorResponse(request.op, request.id, code, message),
    );
  }

  private isLocklessWireRequest(
    socket: WebSocket,
    request: Request | LocklessRequest,
  ): request is LocklessRequest {
    if (this.locklessSessions.has(socket)) {
      return true;
    }
    if (request.op !== "pair.request") return false;
    const features = (request.payload as Partial<LocklessPairPayload>)
      .protocolFeatures;
    return (
      Array.isArray(features) &&
      features.includes(SURF_ACE_LOCKLESS_V1_CAPABILITY)
    );
  }

  private async handleLocklessMessage(
    socket: WebSocket,
    request: LocklessRequest,
  ): Promise<void> {
    const meta = this.socketMeta.get(socket);
    if (!meta) return;
    const validation = validateLocklessEnvelope(request);
    if (!validation.ok) {
      const session = this.locklessSessions.get(socket);
      if (session && locklessOperationMutates(request.op)) {
        await this.core.locklessAuthority.transactionAsync(async () => {
          this.core.locklessAuthority.auditRejected(
            request.id,
            request.op,
            session.controllerInstanceId,
            "invalid_payload",
            session.surfaceId,
          );
          this.core.markLocklessAuthorityChanged(session.surfaceId ?? undefined);
          await this.persistLocklessState();
        });
      }
      await this.send(
        socket,
        JSON.stringify(
          errorResponse(
            request.op,
            request.id as never,
            "invalid_payload",
            validation.reason,
          ),
        ),
      );
      return;
    }
    const payloadHash = JSON.stringify({
      op: request.op,
      payload: request.payload,
    });
    const cached = meta.cache.get(request.id);
    if (cached) {
      if (cached.payloadHash !== payloadHash) {
        const session = this.locklessSessions.get(socket);
        if (session && locklessOperationMutates(request.op)) {
          await this.core.locklessAuthority.transactionAsync(async () => {
            this.core.locklessAuthority.auditRejected(
              request.id,
              request.op,
              session.controllerInstanceId,
              "invalid_payload",
              session.surfaceId,
            );
            this.core.markLocklessAuthorityChanged(
              session.surfaceId ?? undefined,
            );
            await this.persistLocklessState();
          });
        }
        await this.send(
          socket,
          JSON.stringify(
            errorResponse(
              request.op,
              request.id as never,
              "invalid_request_id_reuse",
              "Request id was reused with different payload",
            ),
          ),
        );
        return;
      }
      await this.send(socket, JSON.stringify(cached.response));
      return;
    }

    if (request.op === "target.apply") {
      const session = this.locklessSessions.get(socket);
      if (session) {
        await this.handleLocklessTargetApply(
          socket,
          meta,
          session,
          request,
          payloadHash,
        );
        return;
      }
    }

    const dispatch = async (): Promise<{
      rejectionCode: LocklessErrorCode | null;
      response: Response;
    }> => {
      try {
        const response = request.op === "pair.request"
          ? await this.runLocklessPairReservation(
              request.payload.surfaceId ?? null,
              async () => await this.dispatchLocklessRequest(socket, request),
            )
          : await this.dispatchLocklessRequest(socket, request);
        return {
          rejectionCode: null,
          response: response as Response,
        };
      } catch (error) {
        if (error instanceof LocklessAuthorityError) {
          return {
            rejectionCode: error.code,
            response: errorResponse(
              request.op,
              request.id as never,
              error.code,
              error.message,
              error.details,
            ),
          };
        } else if (error instanceof SurfaceCoreError) {
          return {
            rejectionCode: locklessAuditErrorCode(error.code),
            response: errorResponse(
              request.op,
              request.id as never,
              error.code,
              error.message,
              error.details,
            ),
          };
        }
        persistentServerDiagnostic(
          "warn",
          "lockless_request_error",
          {
            op: request.op,
            request_id: request.id,
            ...errorDiagnosticFields(error),
          },
        );
        if (error instanceof PersistentStateOutcomeUnknownError) {
          // Stable, specific detail rather than the generic fallback: the
          // caller that TRIGGERED the fail-stop is owed an answer that says
          // what happened, not an opaque "unhandled" error indistinguishable
          // from any other internal fault.
          return {
            rejectionCode: "internal_error",
            response: errorResponse(
              request.op,
              request.id as never,
              "internal_error",
              "Persistent state commit outcome is unknown; registry requires restart",
            ),
          };
        }
        return {
          rejectionCode: "internal_error",
          response: errorResponse(
            request.op,
            request.id as never,
            "internal_error",
            "Unhandled lockless surface error",
          ),
        };
      }
    };
    let response: Response;
    const session = this.locklessSessions.get(socket);
    if (
      request.op !== "pair.request" &&
      session &&
      locklessOperationMutates(request.op)
    ) {
      try {
        response = await this.core.locklessAuthority.transactionAsync(() =>
          this.core.transactionAsync(async () => {
            this.core.locklessAuthority.beginOperationReceipt(
              session.controllerInstanceId,
              request.id,
              request.op,
            );
            const result = await dispatch();
            response = result.response;
            let operationReceipt: { commitSequence: number; requestId: string };
            if (response.ok) {
              const correlation = locklessResultCorrelation(response.payload);
              const audit = this.core.locklessAuthority.auditAccepted(
                request.id,
                request.op,
                session.controllerInstanceId,
                session.surfaceId,
                correlation,
              );
              if (
                response.payload &&
                typeof response.payload === "object" &&
                !Array.isArray(response.payload)
              ) {
                (response as Response & {
                  payload: Record<string, unknown>;
                }).payload = {
                  ...(response.payload as Record<string, unknown>),
                  operationReceipt: {
                    commitSequence: audit.commitSequence,
                    requestId: request.id,
                  },
                };
              }
              operationReceipt = {
                commitSequence: audit.commitSequence,
                requestId: request.id,
              };
            } else {
              const audit = this.core.locklessAuthority.auditRejected(
                request.id,
                request.op,
                session.controllerInstanceId,
                result.rejectionCode ?? "internal_error",
                session.surfaceId,
              );
              operationReceipt = {
                commitSequence: audit.commitSequence,
                requestId: request.id,
              };
            }
            this.core.locklessAuthority.completeOperationReceipt(
              session.controllerInstanceId,
              request.id,
              request.op,
              response.ok ? "resolved_success" : "resolved_failure",
              response,
              operationReceipt,
            );
            this.core.markLocklessAuthorityChanged(
              session.surfaceId ?? undefined,
            );
            await this.persistLocklessState();
            return response;
          }),
        );
      } catch (error) {
        if (!(error instanceof LocklessAuthorityError)) throw error;
        response = await this.core.locklessAuthority.transactionAsync(async () => {
          this.core.locklessAuthority.auditRejected(
            request.id,
            request.op,
            session.controllerInstanceId,
            error.code,
            session.surfaceId,
          );
          this.core.markLocklessAuthorityChanged(session.surfaceId ?? undefined);
          await this.persistLocklessState();
          return errorResponse(
            request.op,
            request.id as never,
            error.code,
            error.message,
            error.details,
          );
        });
      }
    } else if (request.op === "pair.request") {
      response = (await dispatch()).response;
    } else if (request.op === "surfaces.list") {
      response = await this.core.locklessAuthority.transactionAsync(() =>
        this.core.transactionAsync(async () => {
          const attemptCount =
            this.core.listSurfaceAdmissionAttempts().length;
          const result = await dispatch();
          if (
            this.core.listSurfaceAdmissionAttempts().length > attemptCount
          ) {
            await this.persistLocklessState();
          }
          return result.response;
        }),
      );
    } else {
      response = await this.core.locklessAuthority.transactionAsync(async () => {
        const result = await dispatch();
        if (
          request.op === "consumable.ack" ||
          request.op === "operation.receipt.ack"
        ) {
          await this.persistLocklessState();
        }
        return result.response;
      });
    }
    meta.cache.set(request.id, { payloadHash, response });
    trimCache(meta.cache);
    await this.send(socket, JSON.stringify(response));
  }

  private async handleLocklessTargetApply(
    socket: WebSocket,
    meta: SocketMeta,
    session: LocklessTransportSession,
    request: Extract<LocklessRequest, { op: "target.apply" }>,
    payloadHash: string,
  ): Promise<void> {
    let converted: TargetApplyRequest | null = null;
    let response: Response;
    try {
      response = await this.core.locklessAuthority.transactionPersisted(
        () => {
          converted = this.preflightLocklessTargetApply(socket, session, request);
          this.core.locklessAuthority.beginOperationReceipt(
            session.controllerInstanceId,
            request.id,
            request.op,
          );
          const audit = this.core.locklessAuthority.auditAccepted(
            request.id,
            request.op,
            session.controllerInstanceId,
            request.payload.surfaceId,
            {
              operationRequestId: request.id,
              targetEpoch: request.payload.targetEpoch,
              targetId: request.payload.targetId,
              targetRequestId: request.payload.requestId,
            },
          );
          const operationReceipt = {
            commitSequence: audit.commitSequence,
            requestId: request.id,
          };
          const committed = locklessSuccess(request, {
            operationReceipt,
            operationRequestId: request.id,
            status: "intent_committed",
            surfaceId: request.payload.surfaceId,
            targetEpoch: request.payload.targetEpoch,
            targetId: request.payload.targetId,
            targetRequestId: request.payload.requestId,
          }) as Response;
          this.core.locklessAuthority.completeOperationReceipt(
            session.controllerInstanceId,
            request.id,
            request.op,
            "resolved_success",
            committed,
            operationReceipt,
          );
          this.core.locklessAuthority.admitTargetApplyWorkItem({
            controllerInstanceId: session.controllerInstanceId,
            currentSurfaceBase:
              this.core.captureSurfaceTombstonePayload(
                request.payload.surfaceId,
              ),
            intentCommitSequence: audit.commitSequence,
            operationRequestId: request.id,
            request: {
              ...request.payload,
              paneLineageId: converted.payload.paneLineageId,
            },
          });
          return committed;
        },
        this.persistLocklessState,
      );
    } catch (error) {
      if (
        !(error instanceof LocklessAuthorityError) &&
        !(error instanceof SurfaceCoreError)
      ) {
        throw error;
      }
      const rejectionCode = error instanceof LocklessAuthorityError
        ? error.code
        : locklessAuditErrorCode(error.code);
      response = await this.core.locklessAuthority.transactionAsync(async () => {
        this.core.locklessAuthority.auditRejected(
          request.id,
          request.op,
          session.controllerInstanceId,
          rejectionCode,
          request.payload.surfaceId,
        );
        this.core.markLocklessAuthorityChanged(request.payload.surfaceId);
        await this.persistLocklessState();
        return errorResponse(
          request.op,
          request.id as never,
          error.code,
          error.message,
          error.details,
        );
      });
    }
    this.core.markLocklessAuthorityChanged(request.payload.surfaceId);
    meta.cache.set(request.id, { payloadHash, response });
    trimCache(meta.cache);
    if (!response.ok) {
      await this.send(socket, JSON.stringify(response));
      return;
    }
    if (!converted) {
      throw new Error("target.apply committed without a validated request");
    }
    try {
      await this.send(socket, JSON.stringify(response));
    } finally {
      await this.continueTargetApplyWorkItem(
        session.controllerInstanceId,
        request.id,
        converted,
        socket,
      );
    }
  }

  private preflightLocklessTargetApply(
    socket: WebSocket,
    session: LocklessTransportSession,
    request: Extract<LocklessRequest, { op: "target.apply" }>,
  ): TargetApplyRequest {
    if (
      session.surfaceId !== request.payload.surfaceId ||
      this.locklessSessions.get(socket) !== session
    ) {
      throw new LocklessAuthorityError(
        "not_paired",
        "target.apply requires the target surface connection",
      );
    }
    if (!this.core.listSurfaces().some(
      (surface) => surface.surfaceId === request.payload.surfaceId,
    )) {
      throw new LocklessAuthorityError(
        "invalid_payload",
        "target.apply surface is not live",
        { targetErrorCode: "pane_lineage_missing" },
      );
    }
    this.requireLocklessSurface(request.payload.surfaceId);
    const pane = this.resolveLocklessTargetPane(
      request.payload.surfaceId,
      request.payload.paneId,
      request.payload.paneLineageId,
    );
    const converted: TargetApplyRequest = {
      id: request.id,
      op: "target.apply",
      payload: {
        display:
          request.payload.display as TargetApplyRequest["payload"]["display"],
        paneLineageId: pane.paneLineageId,
        requestId: request.payload.requestId,
        restoreReason:
          request.payload.restoreReason as TargetApplyRequest["payload"]["restoreReason"],
        surfaceId:
          request.payload.surfaceId as TargetApplyRequest["payload"]["surfaceId"],
        targetEpoch: request.payload.targetEpoch,
        targetHeader:
          request.payload.targetHeader as TargetApplyRequest["payload"]["targetHeader"],
        targetId: request.payload.targetId,
        targetKind:
          request.payload.targetKind as TargetApplyRequest["payload"]["targetKind"],
        targetPayload: request.payload.targetPayload,
      },
      sentAt: request.sentAt,
      type: "request",
      v: 1,
    };
    if (converted.payload.targetKind === "browser_url") {
      const failure = this.core.browserUrlTargetIntentPreflight(
        request.payload.surfaceId,
        converted.payload,
      );
      if (failure) {
        throw new LocklessAuthorityError(
          "invalid_payload",
          failure.message ?? "target.apply intent was rejected",
          { targetErrorCode: failure.errorCode },
        );
      }
    } else if (isNativeHostTargetKind(converted.payload.targetKind)) {
      this.core.projectNativePaneMaterialization(
        request.payload.surfaceId,
        converted.payload,
      );
    } else {
      throw new LocklessAuthorityError(
        "unsupported_operation",
        `Unsupported target kind: ${converted.payload.targetKind}`,
      );
    }
    return converted;
  }

  private async resumeTargetApplyWorkItems(): Promise<void> {
    for (const item of this.core.locklessAuthority.targetApplyWorkItems()) {
      if (item.state === "materializing") {
        await this.terminalizeTargetApplyWorkItem(item, {
          errorCode: "materialization_outcome_unknown",
          status: "failed",
        });
        continue;
      }
      await this.continueTargetApplyWorkItem(
        item.controllerInstanceId,
        item.operationRequestId,
        this.targetApplyRequestFromWorkItem(item),
        null,
      );
    }
  }

  private targetApplyRequestFromWorkItem(
    item: PersistentTargetApplyWorkItem,
  ): TargetApplyRequest {
    const payload = item.request;
    if (!payload.paneLineageId) {
      throw new LocklessAuthorityError(
        "capability_mismatch",
        "Persisted target apply work item lacks pane lineage",
        { operationRequestId: item.operationRequestId },
      );
    }
    return {
      id: item.operationRequestId as never,
      op: "target.apply",
      payload: {
        display: payload.display as TargetApplyRequest["payload"]["display"],
        paneLineageId: payload.paneLineageId as never,
        requestId: payload.requestId,
        restoreReason:
          payload.restoreReason as TargetApplyRequest["payload"]["restoreReason"],
        surfaceId: payload.surfaceId as never,
        targetEpoch: payload.targetEpoch as never,
        targetHeader:
          payload.targetHeader as TargetApplyRequest["payload"]["targetHeader"],
        targetId: payload.targetId,
        targetKind:
          payload.targetKind as TargetApplyRequest["payload"]["targetKind"],
        targetPayload: payload.targetPayload,
      },
      sentAt: Date.now() as never,
      type: "request",
      v: 1,
    };
  }

  private async continueTargetApplyWorkItem(
    controllerInstanceId: string,
    operationRequestId: string,
    request: TargetApplyRequest,
    socket: WebSocket | null,
  ): Promise<void> {
    const item = await this.core.locklessAuthority.transactionPersisted(
      () =>
        this.core.locklessAuthority.markTargetApplyMaterializing(
          controllerInstanceId,
          operationRequestId,
        ),
      this.persistLocklessState,
    );
    if (!item) return;
    this.core.markLocklessAuthorityChanged(item.surfaceId);
    let result: Omit<
      LocklessTargetApplyResult,
      "intentCommitSequence" | "operationRequestId" | "surfaceId" |
        "targetEpoch" | "targetId" | "targetRequestId"
    >;
    try {
      const response = await this.handleTargetApplyForSurface(
        item.surfaceId,
        socket,
        request,
        true,
      );
      if (!response.ok) {
        result = {
          errorCode: response.error.code,
          status: "failed",
        };
      } else {
        const payload = (response as TargetApplyResponse).payload;
        result = {
          ...(payload.errorCode ? { errorCode: payload.errorCode } : {}),
          ...(payload.materializedState
            ? { materializedState: payload.materializedState }
            : {}),
          status: payload.status === "applied" ? "applied" : "failed",
        };
      }
    } catch (error) {
      result = {
        errorCode:
          error instanceof LocklessAuthorityError
            ? error.code
            : "materialization_failed",
        status: "failed",
      };
    }
    await this.terminalizeTargetApplyWorkItem(item, result);
  }

  private async terminalizeTargetApplyWorkItem(
    item: PersistentTargetApplyWorkItem,
    result: Omit<
      LocklessTargetApplyResult,
      "intentCommitSequence" | "operationRequestId" | "surfaceId" |
        "targetEpoch" | "targetId" | "targetRequestId"
    >,
  ): Promise<void> {
    const completed = await this.core.locklessAuthority.transactionPersisted(
      () =>
        this.core.locklessAuthority.completeTargetApplyWorkItem(
          item.controllerInstanceId,
          item.operationRequestId,
          result,
        ),
      this.persistLocklessState,
    );
    if (completed) {
      this.core.markLocklessAuthorityChanged(completed.result.surfaceId);
    }
  }

  private async dispatchLocklessRequest(
    socket: WebSocket,
    request: LocklessRequest,
  ): Promise<unknown> {
    if (request.op === "pair.request") {
      if (this.locklessSessions.has(socket)) {
        throw new LocklessAuthorityError(
          "duplicate_controller_instance",
          "Socket is already admitted",
        );
      }
      const surfaceId = request.payload.surfaceId ?? null;
      // The ledger is global, so the candidate row and its durable write must
      // be one serialized transition. Calling begin here and persisting after
      // leaves a window in which a second pair.request for another surface
      // reads the same high-water value and believes it owns it.
      const admissionAttempt = surfaceId
        ? await this.core.prepareSurfaceAdmissionAttempt(
            {
              controllerInstanceId: request.payload.controllerInstanceId,
              requestId: request.id,
              surfaceId,
            },
            async () => {
              await this.persistLocklessState();
            },
          )
        : null;
      const connectionToken = metaConnectionToken(
        this.socketMeta.get(socket),
      );
      const connectionSlot = surfaceId
        ? `surface:${surfaceId}`
        : "lifecycle";
      const controllerWasKnown =
        this.core.locklessAuthority.hasController(
          request.payload.controllerInstanceId,
        );
      let admission: ReturnType<
        LocklessClientAuthority["admit"]
      >;
      try {
        if (surfaceId && admissionAttempt) {
          // Durable witness (B2): stamped "started" through the same
          // serialized boundary, immediately before the paired operation
          // itself executes. Until this commits, a crash proves the
          // operation never began.
          await this.core.markSurfaceAdmissionAttemptStarted(
            admissionAttempt.attemptSequence,
            async () => {
              await this.persistLocklessState();
            },
          );
          this.core.advanceSurfaceAdmissionAttempt(
            admissionAttempt.attemptSequence,
            "surface_lookup",
          );
          this.core.getSurface(surfaceId);
          this.core.advanceSurfaceAdmissionAttempt(
            admissionAttempt.attemptSequence,
            "controller_admission",
          );
        }
        admission = await this.core.transactionAsync(async () =>
          await this.core.locklessAuthority.transactionPersisted(
            () => {
              const admitted = this.core.locklessAuthority.admit(
                request.payload,
                connectionToken,
                request.id,
                connectionSlot,
              );
              for (const ack of request.payload.resume?.pendingAcks ?? []) {
                this.core.locklessAuthority.acknowledge(
                  request.payload.controllerInstanceId,
                  ack,
                );
              }
              if (surfaceId) {
                this.core.admitSurfaceToLockless(
                  surfaceId,
                  admissionAttempt?.attemptSequence,
                );
                this.core.locklessAuthority.ensureScope(
                  `surface:${encodeURIComponent(surfaceId)}`,
                  "surface",
                );
                for (const paneId of this.core.activePaneIds(surfaceId)) {
                  this.core.locklessAuthority.ensureScope(
                    locklessPaneScopeId(surfaceId, paneId),
                    "pane",
                  );
                }
              }
              this.core.markLocklessAuthorityChanged(surfaceId ?? undefined);
              if (admissionAttempt) {
                this.core.succeedSurfaceAdmissionAttempt(
                  admissionAttempt.attemptSequence,
                );
              }
              return admitted;
            },
            this.persistLocklessState,
          ),
        );
      } catch (error) {
        if (admissionAttempt) {
          if (error instanceof PersistentStateOutcomeUnknownError) {
            throw error;
          }
          if (
            this.core.surfaceAdmissionAttempt(
              admissionAttempt.attemptSequence,
            ).outcome === "succeeded"
          ) {
            this.core.rollbackUnpersistedSurfaceAdmissionSuccess(
              admissionAttempt.attemptSequence,
            );
          }
          const reasonCode = error instanceof LocklessAuthorityError ||
              error instanceof SurfaceCoreError
            ? error.code
            : "internal_error";
          const reason = error instanceof Error
            ? error.message
            : "Unknown surface admission failure";
          this.core.failSurfaceAdmissionAttempt(
            admissionAttempt.attemptSequence,
            reasonCode,
            reason,
          );
          await this.persistLocklessState();
        }
        throw error;
      }
      const completedAdmissionAttempt = admissionAttempt
        ? this.core.surfaceAdmissionAttempt(admissionAttempt.attemptSequence)
        : null;
      const session: LocklessTransportSession = {
        connectionSlot,
        connectionToken,
        controllerInstanceId: request.payload.controllerInstanceId,
        controllerProductName:
          request.payload.controllerProductName?.trim() || null,
        socket,
        surfaceId,
      };
      this.locklessSessions.set(socket, session);
      if (surfaceId) {
        const socketMeta = this.socketMeta.get(socket);
        if (socketMeta) socketMeta.pairedSurfaceId = surfaceId;
        this.core.setConnectionBar(surfaceId, "connected");
      }
      const admittedScopeIds = surfaceId
        ? [
            `surface:${encodeURIComponent(surfaceId)}`,
            ...this.core
              .activePaneIds(surfaceId)
              .map((paneId) => locklessPaneScopeId(surfaceId, paneId)),
          ]
        : [];
      const scopes = admittedScopeIds.map((scopeId) =>
        this.core.locklessAuthority.scopeSnapshot(
          request.payload.controllerInstanceId,
          scopeId,
        ),
      );
      const receiptResolutions =
        this.core.locklessAuthority.resolveOperationReceipts(
          request.payload.controllerInstanceId,
          request.payload.resume?.unresolvedRequestIds ?? [],
          !controllerWasKnown &&
            (request.payload.resume?.unresolvedRequestIds?.length ?? 0) > 0,
        );
      return {
        id: request.id,
        ok: true,
        op: request.op,
        payload: {
          ...(completedAdmissionAttempt
            ? { admissionAttempt: completedAdmissionAttempt }
            : {}),
          capabilities: await this.locklessCapabilities(),
          controllerInstanceId: request.payload.controllerInstanceId,
          limits: this.core.locklessAuthority.limits,
          mode: "lockless",
          receiptResolutions,
          resumed: admission.resumed,
          scopes,
          sessionId: `lockless_${request.payload.controllerInstanceId}`,
          state: surfaceId ? this.core.pairState(surfaceId) : null,
          surfaceId,
          surfaceSetRevision:
            this.core.locklessAuthority.surfaceSetRevision,
        },
        sentAt: Date.now(),
        type: "response",
        v: 1,
      };
    }

    const session = this.locklessSessions.get(socket);
    if (!session) {
      throw new SurfaceCoreError(
        "not_paired",
        "Operation requires lockless pair.request first",
      );
    }
    if (request.op === "heartbeat.ping") {
      return locklessSuccess(request, {
        nonce: request.payload.nonce,
        receivedAt: Date.now(),
      });
    }
    if (request.op === "operation.receipt.sync") {
      return locklessSuccess(request, {
        resolutions:
          this.core.locklessAuthority.resolveOperationReceipts(
            session.controllerInstanceId,
            request.payload.requestIds,
          ),
      });
    }
    if (request.op === "operation.receipt.ack") {
      const accepted =
        this.core.locklessAuthority.acknowledgeOperationReceipt(
          session.controllerInstanceId,
          request.payload.requestId,
          request.payload.release ?? false,
        );
      this.core.locklessAuthority.auditAccepted(
        request.id,
        request.op,
        session.controllerInstanceId,
        session.surfaceId,
        {
          accepted,
          acknowledgedRequestId: request.payload.requestId,
          release: request.payload.release ?? false,
        },
      );
      this.core.markLocklessAuthorityChanged(session.surfaceId ?? undefined);
      return locklessSuccess(request, {
        accepted,
        release: request.payload.release ?? false,
        requestId: request.payload.requestId,
      });
    }
    if (request.op === "surfaces.list") {
      for (const surface of this.core.listSurfaces()) {
        if (
          this.core
            .activePaneIds(surface.surfaceId)
            .some((paneId) => paneId < 1)
        ) {
          await this.admitSurfaceForDiscovery(
            session.controllerInstanceId,
            request.id,
            surface.surfaceId,
          );
        }
      }
      return locklessSuccess(request, {
        admissionAvailable:
          this.core.locklessAuthority.liveControllerIds().length <
          this.core.locklessAuthority.limits.maxAdmittedControllerEntries,
        ...(session.surfaceId === null
          ? { admissionAttempts: this.core.listSurfaceAdmissionAttempts() }
          : {}),
        limits: this.core.locklessAuthority.limits,
        surfaceSetRevision:
          this.core.locklessAuthority.surfaceSetRevision,
        surfaceTombstones:
          this.core.locklessAuthority.listTombstones("surface"),
        surfaces: this.core.listSurfaces().map((surface) => ({
          name: surface.name,
          surfaceId: surface.surfaceId,
          topology: this.core.topologyState(surface.surfaceId),
          viewport: this.core.viewport(surface.surfaceId),
        })),
      });
    }
    if (request.op === "surface.window.label.apply") {
      const { surfaceId, windowLabel } = request.payload;
      if (session.surfaceId !== surfaceId) {
        throw new SurfaceCoreError("not_paired", "Label application requires the target surface connection");
      }
      this.requireLocklessSurface(surfaceId);
      this.core.applyWindowLabelOnly(surfaceId, windowLabel);
      return locklessSuccess(request, { surfaceId, windowLabel });
    }
    if (request.op === "panes.list") {
      const targetSurfaceId =
        request.payload.surfaceId ?? session.surfaceId;
      if (!targetSurfaceId) {
        throw new SurfaceCoreError(
          "invalid_payload",
          "panes.list requires surfaceId on an endpoint-scoped session",
        );
      }
      if (session.surfaceId !== targetSurfaceId) {
        throw new SurfaceCoreError(
          "not_paired",
          "panes.list requires the target surface connection",
        );
      }
      this.requireLocklessSurface(targetSurfaceId);
      return locklessSuccess(request, {
        ...this.core.panesList(targetSurfaceId),
        topology: this.core.topologyState(targetSurfaceId),
      });
    }
    if (
      request.op === "annotations.remove" ||
      request.op === "snapshot.get" ||
      request.op === "target.apply" ||
      request.op === "target.register" ||
      request.op === "topology.apply"
    ) {
      if (session.surfaceId !== request.payload.surfaceId) {
        throw new SurfaceCoreError(
          "not_paired",
          `${request.op} requires the target surface connection`,
        );
      }
      this.requireLocklessSurface(request.payload.surfaceId);
    }
    if (request.op === "annotations.remove") {
      const payload = await this.runSurfaceMutation(
        request.payload.surfaceId,
        () =>
          this.core.annotationsRemove(request.payload.surfaceId, {
            contentId: request.payload.contentId,
            paneId: request.payload.paneId,
            strokeIds: request.payload.strokeIds,
          }),
      );
      this.core.markLocklessAuthorityChanged(request.payload.surfaceId);
      return locklessSuccess(request, payload);
    }
    if (request.op === "snapshot.get") {
      const snapshot = this.core.captureSnapshot(
        request.payload.surfaceId,
        request.payload.paneId,
      );
      const image = request.payload.includeImage
        ? await this.capturePaneImage(
            request.payload.surfaceId,
            request.payload.paneId,
          )
        : undefined;
      return locklessSuccess(request, {
        ...snapshot,
        drawings: request.payload.includeDrawings
          ? this.core
              .getRendererWindowState(request.payload.surfaceId)
              .panes.find(
                (pane) => pane.paneId === request.payload.paneId,
              )?.drawings
          : undefined,
        image: image ?? undefined,
        visibleText:
          request.payload.includeVisibleText === false
            ? undefined
            : snapshot.visibleText,
      });
    }
    if (request.op === "target.apply") {
      const pane = this.resolveLocklessTargetPane(
        request.payload.surfaceId,
        request.payload.paneId,
        request.payload.paneLineageId,
      );
      const converted: TargetApplyRequest = {
        id: request.id,
        op: "target.apply",
        payload: {
          display: request.payload.display as TargetApplyRequest["payload"]["display"],
          paneLineageId: pane.paneLineageId,
          requestId: request.payload.requestId,
          restoreReason:
            request.payload.restoreReason as TargetApplyRequest["payload"]["restoreReason"],
          surfaceId:
            request.payload.surfaceId as TargetApplyRequest["payload"]["surfaceId"],
          targetEpoch: request.payload.targetEpoch,
          targetHeader:
            request.payload.targetHeader as TargetApplyRequest["payload"]["targetHeader"],
          targetId: request.payload.targetId,
          targetKind:
            request.payload.targetKind as TargetApplyRequest["payload"]["targetKind"],
          targetPayload: request.payload.targetPayload,
        },
        sentAt: request.sentAt,
        type: "request",
        v: 1,
      };
      const response = await this.handleTargetApply(socket, converted);
      if (!response.ok) return response as LocklessResponse;
      return locklessSuccess(request, response.payload);
    }
    if (request.op === "target.register") {
      const registered = await this.runSurfaceMutation(
        request.payload.surfaceId,
        () => {
          const pane = this.resolveLocklessTargetPane(
            request.payload.surfaceId,
            request.payload.paneId,
            request.payload.paneLineageId,
          );
          const current = pane.currentTarget ?? null;
          const duplicate = this.core.locklessTargetRegistration(
            request.payload.surfaceId,
            Number(pane.paneId),
            request.payload.idempotencyKey,
          );
          if (duplicate) {
            return { pane, target: duplicate };
          }
          const currentEpoch = current?.targetEpoch ?? null;
          if (
            request.payload.expectedPreviousTargetEpoch !== currentEpoch
          ) {
            throw new LocklessAuthorityError(
              "stale_content",
              "target.register expectedPreviousTargetEpoch is stale",
              { currentTarget: current },
            );
          }
          const rollback = this.core.captureSurfaceMutationRollback(
            request.payload.surfaceId,
          );
          const before = this.core.capturePaneTombstonePayload(
            request.payload.surfaceId,
            Number(pane.paneId),
          ).pane;
          try {
            return this.core.transaction(() => {
              const registered = this.core.registerLocklessTarget(
                request.payload.surfaceId,
                Number(pane.paneId),
                request.payload,
              );
              const after = this.core.capturePaneTombstonePayload(
                request.payload.surfaceId,
                Number(pane.paneId),
              ).pane;
              this.core.locklessAuthority.assertPaneRecoverableCapacity(
                before,
                after,
                after.history.map((entry) => entry.annotations),
              );
              return { pane, target: registered };
            });
          } catch (error) {
            rollback();
            throw error;
          }
        },
      );
      return locklessSuccess(request, {
        idempotencyKey: request.payload.idempotencyKey,
        paneId: registered.pane.paneId,
        paneLineageId: registered.pane.paneLineageId,
        registered: true,
        target: registered.target,
      });
    }
    if (request.op === "topology.apply") {
      const result = await this.realizeLocklessTopology(request);
      this.core.markLocklessAuthorityChanged(request.payload.surfaceId);
      return locklessSuccess(request, result);
    }
    if (request.op === "consumable.ack") {
      this.core.locklessAuthority.acknowledge(
        session.controllerInstanceId,
        request.payload,
      );
      this.core.markLocklessAuthorityChanged(session.surfaceId ?? undefined);
      const snapshot = this.core.locklessAuthority.scopeSnapshot(
        session.controllerInstanceId,
        request.payload.scopeId,
      );
      return locklessSuccess(request, {
        acceptedCursor: snapshot.cursor.cursor,
        acceptedGapGeneration: snapshot.cursor.gapGeneration,
      });
    }
    if (request.op === "consumable.sync") {
      if (
        request.payload.scopeIds.some(
          (scopeId) =>
            !this.locklessSessionMatchesScope(session, scopeId),
        )
      ) {
        throw new SurfaceCoreError(
          "not_paired",
          "Sync requires each scope's surface connection",
        );
      }
      const snapshots = request.payload.scopeIds.map((scopeId) =>
        this.core.locklessAuthority.scopeSnapshot(
          session.controllerInstanceId,
          scopeId,
        ),
      );
      return locklessSuccess(request, { snapshots });
    }
    if (request.op === "surface.window.open") {
      if (session.surfaceId !== null) {
        throw new SurfaceCoreError(
          "invalid_operation",
          "surface.window.open requires the lifecycle connection",
        );
      }
      const result = await this.runLifecycleTransaction(() => {
          this.core.locklessAuthority.assertSurfaceSetRevision(
            request.payload.expectedSurfaceSetRevision,
            this.core.listSurfaces().map((surface) => ({
              name: surface.name,
              surfaceId: surface.surfaceId,
            })),
          );
          this.core.locklessAuthority.assertPaneCreationCapacity(0, 1);
          const surface = this.core.createLocklessSurface(
            "Surf Ace",
            this.viewportProvider(),
          );
          this.core.locklessAuthority.ensureScope(
            `surface:${encodeURIComponent(surface.surfaceId)}`,
            "surface",
          );
          for (const paneId of this.core.activePaneIds(surface.surfaceId)) {
            this.core.locklessAuthority.ensureScope(
              locklessPaneScopeId(surface.surfaceId, paneId),
              "pane",
            );
          }
          const surfaceSetRevision =
            this.core.locklessAuthority.advanceSurfaceSetRevision();
          return {
            state: this.core.pairState(surface.surfaceId),
            surfaceId: surface.surfaceId,
            surfaceSetRevision,
            topology: this.core.topologyState(surface.surfaceId),
            viewport: this.core.viewport(surface.surfaceId),
          };
      });
      this.core.markLocklessAuthorityChanged(result.surfaceId);
      return locklessSuccess(request, result);
    }
    if (request.op === "surface.window.close") {
      const targetSurfaceId = request.payload.surfaceId;
      if (session.surfaceId !== targetSurfaceId) {
        throw new SurfaceCoreError(
          "not_paired",
          "surface.window.close requires the target surface connection",
        );
      }
      this.requireLocklessSurface(targetSurfaceId);
      const result = await this.runLifecycleTransaction(
        () => {
          const record =
            this.core.captureSurfaceTombstonePayload(targetSurfaceId);
            this.core.locklessAuthority.assertSurfaceSetRevision(
              request.payload.expectedSurfaceSetRevision,
              this.core.listSurfaces().map((surface) => ({
                surfaceId: surface.surfaceId,
              })),
            );
            this.core.locklessAuthority.assertTopologyRevision(
              request.payload.expectedTopologyRevision,
              Number(record.topologyRevision),
              this.core.topologyState(targetSurfaceId),
            );
            const paneTombstones =
              this.core.locklessAuthority.takePaneTombstonesForSurface(
                targetSurfaceId,
              );
            const tombstone =
              this.core.locklessAuthority.createTombstone({
                kind: "surface",
                payload: { paneTombstones, surface: record },
                surfaceId: targetSurfaceId,
              });
            this.core.removeSurface(targetSurfaceId);
            const surfaceSetRevision =
              this.core.locklessAuthority.advanceSurfaceSetRevision();
            return {
              closedSequence: tombstone.closedSequence,
              recoverable: true,
              surfaceId: targetSurfaceId,
              surfaceSetRevision,
              tombstoneId: tombstone.tombstoneId,
            };
        },
        targetSurfaceId,
      );
      this.core.markLocklessAuthorityChanged();
      return locklessSuccess(request, result);
    }
    if (request.op === "surface.window.restore") {
      if (session.surfaceId !== null) {
        throw new SurfaceCoreError(
          "invalid_operation",
          "surface.window.restore requires the lifecycle connection",
        );
      }
      let restoredSurfaceId: string | null = null;
      try {
        const result = await this.runLifecycleTransaction(() => {
            this.core.locklessAuthority.assertSurfaceSetRevision(
              request.payload.expectedSurfaceSetRevision,
              this.core.listSurfaces().map((surface) => ({
                surfaceId: surface.surfaceId,
              })),
            );
            const tombstone =
              this.core.locklessAuthority.restoreTombstone(
                request.payload.tombstoneId,
                "surface",
              );
            const payload = tombstone.payload as {
              paneTombstones: PersistentTombstone[];
              surface: ReturnType<
                SurfaceCore["captureSurfaceTombstonePayload"]
              >;
            };
            const surface = this.core.restoreSurfaceTombstone(
              payload.surface,
            );
            restoredSurfaceId = surface.surfaceId;
            this.core.locklessAuthority.restoreExactTombstones(
              payload.paneTombstones,
            );
            const surfaceSetRevision =
              this.core.locklessAuthority.advanceSurfaceSetRevision();
            return {
              state: this.core.pairState(surface.surfaceId),
              surfaceId: surface.surfaceId,
              surfaceSetRevision,
              topology: this.core.topologyState(surface.surfaceId),
            };
        });
        this.core.markLocklessAuthorityChanged(result.surfaceId);
        return locklessSuccess(request, result);
      } catch (error) {
        if (restoredSurfaceId) this.core.removeSurface(restoredSurfaceId);
        throw error;
      }
    }

    const surfaceId =
      "surfaceId" in request.payload
        ? request.payload.surfaceId
        : session.surfaceId;
    if (!surfaceId) {
      throw new SurfaceCoreError(
        "invalid_payload",
        "Operation requires a surfaceId",
      );
    }
    if (session.surfaceId !== surfaceId) {
      throw new SurfaceCoreError(
        "not_paired",
        "Operation requires the target surface connection",
      );
    }
    this.requireLocklessSurface(surfaceId);

    if (request.op === "content.set") {
      const commit = await this.runSurfaceMutation(surfaceId, () => {
        const rollbackSurface =
          this.core.captureSurfaceMutationRollback(surfaceId);
        const before = this.core.capturePaneTombstonePayload(
          surfaceId,
          request.payload.paneId,
        ).pane;
        try {
          return this.core.transaction(() => {
            const result = this.core.locklessContentPush(
              surfaceId,
              request.payload,
              session.controllerProductName,
            );
            const after = this.core.capturePaneTombstonePayload(
              surfaceId,
              request.payload.paneId,
            ).pane;
            this.core.locklessAuthority.assertPaneRecoverableCapacity(
              before,
              after,
              after.history.map((entry) => entry.annotations),
            );
            return result;
          });
        } catch (error) {
          rollbackSurface();
          throw error;
        }
      });
      const scopeId = locklessPaneScopeId(surfaceId, commit.paneId);
      const record = this.core.locklessAuthority.appendConsumable({
        payload: { ...commit, surfaceId },
        recordClass: "content",
        scopeId,
        scopeKind: "pane",
        triggerOperation: request.op,
      });
      await this.broadcastLockless({
        eventId: makeEventId(),
        op: "event.lockless_content_committed",
        payload: { ...commit, surfaceId },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      });
      if (record) {
        await this.broadcastLocklessDelta(scopeId, [record]);
      }
      this.core.markLocklessAuthorityChanged(surfaceId);
      return locklessSuccess(request, commit);
    }

    if (
      request.op === "content.append" ||
      request.op === "content.patch" ||
      request.op === "content.clear"
    ) {
      const result = await this.runSurfaceMutation(surfaceId, () => {
        const rollbackSurface =
          this.core.captureSurfaceMutationRollback(surfaceId);
        const before = this.core.capturePaneTombstonePayload(
          surfaceId,
          request.payload.paneId,
        ).pane;
        const paneSummary = this.core
          .pairState(surfaceId)
          .panes.find(
            (pane) => Number(pane.paneId) === request.payload.paneId,
          );
        if (
          !paneSummary ||
          Number(paneSummary.currentRevision) !==
            request.payload.expectedRevision
        ) {
          throw new LocklessAuthorityError(
            "stale_content",
            "Content mutation expected revision is stale",
            {
              currentRevision: paneSummary
                ? Number(paneSummary.currentRevision)
                : null,
            },
          );
        }
        try {
          return this.core.transaction(() => {
            const revision = request.payload.expectedRevision + 1;
            const committed =
              request.op === "content.append"
                ? this.core.contentAppend(surfaceId, {
                    contentId: request.payload.contentId as never,
                    lines: request.payload.lines,
                    paneId: request.payload.paneId as never,
                    revision: revision as never,
                  })
                : request.op === "content.patch"
                  ? this.core.contentPatch(surfaceId, {
                      contentId: request.payload.contentId as never,
                      paneId: request.payload.paneId as never,
                      patch: request.payload.patch,
                      revision: revision as never,
                    })
                  : this.core.contentClear(surfaceId, {
                      paneId: request.payload.paneId as never,
                      revision: revision as never,
                    });
            const after = this.core.capturePaneTombstonePayload(
              surfaceId,
              request.payload.paneId,
            ).pane;
            this.core.locklessAuthority.assertPaneRecoverableCapacity(
              before,
              after,
              after.history.map((entry) => entry.annotations),
            );
            return committed;
          });
        } catch (error) {
          rollbackSurface();
          throw error;
        }
      });
      const scopeId = locklessPaneScopeId(
        surfaceId,
        request.payload.paneId,
      );
      const record = this.core.locklessAuthority.appendConsumable({
        payload: { ...result, operation: request.op, surfaceId },
        recordClass: "content",
        scopeId,
        scopeKind: "pane",
        triggerOperation: request.op,
      });
      if (record) await this.broadcastLocklessDelta(scopeId, [record]);
      this.core.markLocklessAuthorityChanged(surfaceId);
      return locklessSuccess(request, result);
    }

    if (request.op === "pane.split") {
      const result = await this.runSurfaceMutation(surfaceId, () =>
        this.core.transaction(() => {
        const rollbackSurface =
          this.core.captureSurfaceMutationRollback(surfaceId);
        const rollbackRecord =
          this.core.captureSurfaceTombstonePayload(surfaceId);
        const topology = this.core.topologyState(surfaceId);
        try {
          this.core.locklessAuthority.assertTopologyRevision(
            request.payload.expectedTopologyRevision,
            Number(topology.topologyRevision),
            topology,
          );
          const currentCount = topology.panes.length;
          const prospectiveCount = currentCount - 1 + request.payload.count;
          this.core.locklessAuthority.assertPaneCreationCapacity(
            currentCount,
            prospectiveCount,
          );
          const newPaneIds: number[] = [];
          const newPaneLabels: number[] = [];
          const usedIds = new Set(
            [
              ...topology.panes.map((pane) => Number(pane.paneId)),
              ...this.core.locklessAuthority.retainedPaneIds(surfaceId),
            ],
          );
          const usedLabels = new Set(
            topology.panes.map((pane) => pane.paneLabel),
          );
          for (let index = 1; index < request.payload.count; index += 1) {
            const identity = this.core.locklessAuthority.allocatePaneIdentity(
              usedIds,
              usedLabels,
            );
            usedIds.add(identity.paneId);
            usedLabels.add(identity.paneLabel);
            newPaneIds.push(identity.paneId);
            newPaneLabels.push(identity.paneLabel);
          }
          const panes = this.core.paneSplit(surfaceId, {
            count: request.payload.count,
            direction: request.payload.direction,
            newPaneIds,
            newPaneLabels,
            paneId: request.payload.paneId,
          });
          this.assertLocklessRecoverableCapacity(surfaceId, rollbackRecord);
          return {
            ...panes,
            topologyRevision: Number(
              this.core.topologyState(surfaceId).topologyRevision,
            ),
          };
        } catch (error) {
          rollbackSurface();
          throw error;
        }
        }),
      );
      for (const pane of result.panes) {
        this.core.locklessAuthority.ensureScope(
          locklessPaneScopeId(surfaceId, Number(pane.paneId)),
          "pane",
        );
      }
      this.core.markLocklessAuthorityChanged(surfaceId);
      return locklessSuccess(request, result);
    }

    if (request.op === "pane.close") {
      const result = await this.runLifecycleTransaction(
        () => {
        const rollbackSurface =
          this.core.captureSurfaceMutationRollback(surfaceId);
        const topology = this.core.topologyState(surfaceId);
        try {
            this.core.locklessAuthority.assertTopologyRevision(
              request.payload.expectedTopologyRevision,
              Number(topology.topologyRevision),
              topology,
            );
            const tombstonePayload = this.core.capturePaneTombstonePayload(
              surfaceId,
              request.payload.paneId,
            );
            const tombstone = this.core.locklessAuthority.createTombstone({
              kind: "pane",
              payload: tombstonePayload,
              surfaceId,
            });
          this.core.paneClose(surfaceId, request.payload.paneId);
            return {
              closedSequence: tombstone.closedSequence,
              paneId: request.payload.paneId,
              recoverable: true,
              tombstoneId: tombstone.tombstoneId,
              topologyRevision: Number(
                this.core.topologyState(surfaceId).topologyRevision,
              ),
            };
        } catch (error) {
          rollbackSurface();
          throw error;
        }
        },
        surfaceId,
      );
      this.core.markLocklessAuthorityChanged(surfaceId);
      return locklessSuccess(request, result);
    }

    if (request.op === "pane.rename") {
      const result = await this.runSurfaceMutation(surfaceId, () => {
        const rollbackSurface =
          this.core.captureSurfaceMutationRollback(surfaceId);
        const before = this.core.capturePaneTombstonePayload(
          surfaceId,
          request.payload.paneId,
        ).pane;
        try {
          return this.core.transaction(() => {
            const topology = this.core.topologyState(surfaceId);
            this.core.locklessAuthority.assertTopologyRevision(
              request.payload.expectedTopologyRevision,
              Number(topology.topologyRevision),
              topology,
            );
            const committed = this.core.locklessPaneRename(
              surfaceId,
              request.payload.paneId,
              request.payload.name,
            );
            const after = this.core.capturePaneTombstonePayload(
              surfaceId,
              request.payload.paneId,
            ).pane;
            this.core.locklessAuthority.assertPaneRecoverableCapacity(
              before,
              after,
              after.history.map((entry) => entry.annotations),
            );
            return committed;
          });
        } catch (error) {
          rollbackSurface();
          throw error;
        }
      });
      this.core.markLocklessAuthorityChanged(surfaceId);
      return locklessSuccess(request, result);
    }

    if (request.op === "pane.restore") {
      const result = await this.runSurfaceMutation(surfaceId, () =>
        this.core.transaction(() => {
        const rollbackSurface =
          this.core.captureSurfaceMutationRollback(surfaceId);
        const topology = this.core.topologyState(surfaceId);
        try {
          return this.core.locklessAuthority.transaction(() => {
            this.core.locklessAuthority.assertTopologyRevision(
              request.payload.expectedTopologyRevision,
              Number(topology.topologyRevision),
              topology,
            );
            const tombstone = this.core.locklessAuthority.restoreTombstone(
              request.payload.tombstoneId,
              "pane",
            );
            return this.core.restorePaneTombstone(
              surfaceId,
              tombstone.payload as ReturnType<
                SurfaceCore["capturePaneTombstonePayload"]
              >,
              request.payload.anchorPaneId,
              request.payload.direction,
            );
          });
        } catch (error) {
          rollbackSurface();
          throw error;
        }
        }),
      );
      this.core.markLocklessAuthorityChanged(surfaceId);
      return locklessSuccess(request, {
        ...result,
        recoverable: false,
        tombstoneId: request.payload.tombstoneId,
      });
    }

    throw new LocklessAuthorityError(
      "unsupported_operation",
      `Lockless operation is not implemented: ${request.op}`,
    );
  }

  private resolveLocklessTargetPane(
    surfaceId: string,
    paneId?: number,
    paneLineageId?: string,
  ): ReturnType<SurfaceCore["panesList"]>["panes"][number] {
    const panes = this.core.panesList(surfaceId).panes;
    const pane = panes.find((candidate) =>
      paneLineageId
        ? candidate.paneLineageId === paneLineageId
        : Number(candidate.paneId) === paneId,
    );
    if (!pane?.paneLineageId) {
      throw new SurfaceCoreError(
        "invalid_payload",
        "Target intent requires a current paneId or paneLineageId",
        { targetErrorCode: "pane_lineage_missing" },
      );
    }
    return pane;
  }

  private async realizeLocklessTopology(
    request: Extract<LocklessRequest, { op: "topology.apply" }>,
  ): Promise<LocklessTopologyRealizeResult> {
    const surfaceId = request.payload.surfaceId;
    return await this.runLifecycleTransaction(() => {
      const current = this.core.topologyState(surfaceId);
      this.core.locklessAuthority.assertTopologyRevision(
        request.payload.expectedTopologyRevision,
        Number(current.topologyRevision),
        current,
      );
      const existing = new Map(
        current.panes.map((pane) => [Number(pane.paneId), pane]),
      );
      const retained = this.core.locklessAuthority.retainedPaneIds(surfaceId);
      const usedIds = new Set([...existing.keys(), ...retained]);
      const usedLabels = new Set(current.panes.map((pane) => pane.paneLabel));
      const created = new Map<number, { name: string | null; paneLabel: number }>();
      const materialize = (value: unknown): TopologyApplyRequest["payload"]["layout"] => {
        if (!value || typeof value !== "object") {
          throw new SurfaceCoreError(
            "invalid_payload",
            "topology.apply desired node must be an object",
          );
        }
        const node = value as {
          children?: unknown[];
          direction?: unknown;
          name?: unknown;
          paneId?: unknown;
          type?: unknown;
          weight?: unknown;
        };
        if (node.type === "pane") {
          if (node.paneId !== undefined) {
            const explicitId = Number(node.paneId);
            if (!existing.has(explicitId)) {
              throw new SurfaceCoreError(
                "invalid_payload",
                "topology.apply cannot allocate a caller-selected paneId",
              );
            }
            return {
              paneId:
                explicitId as TopologyApplyRequest["payload"]["layout"] extends {
                  paneId: infer T;
                }
                  ? T
                  : never,
              type: "pane",
              ...(typeof node.weight === "number"
                ? { weight: node.weight }
                : {}),
            };
          }
          const identity = this.core.locklessAuthority.allocatePaneIdentity(
            usedIds,
            usedLabels,
          );
          usedIds.add(identity.paneId);
          usedLabels.add(identity.paneLabel);
          created.set(identity.paneId, {
            name: typeof node.name === "string" ? node.name : null,
            paneLabel: identity.paneLabel,
          });
          return {
            paneId:
              identity.paneId as TopologyApplyRequest["payload"]["layout"] extends {
                paneId: infer T;
              }
                ? T
                : never,
            type: "pane",
            ...(typeof node.weight === "number"
              ? { weight: node.weight }
              : {}),
          };
        }
        if (
          node.type !== "split" ||
          (node.direction !== "horizontal" &&
            node.direction !== "vertical") ||
          !Array.isArray(node.children) ||
          node.children.length < 2
        ) {
          throw new SurfaceCoreError(
            "invalid_payload",
            "topology.apply desired split is malformed",
          );
        }
        return {
          children: node.children.map(materialize),
          direction: node.direction,
          type: "split",
          ...(typeof node.weight === "number"
            ? { weight: node.weight }
            : {}),
        };
      };
      const desired = materialize(request.payload.desired);
      const replaceTarget = (
        node: TopologyApplyRequest["payload"]["layout"],
      ): TopologyApplyRequest["payload"]["layout"] => {
        if ("paneId" in request.payload.target) {
          if (
            node.type === "pane" &&
            Number(node.paneId) === request.payload.target.paneId
          ) {
            return desired;
          }
          if (node.type === "split") {
            return {
              ...node,
              children: node.children.map(replaceTarget),
            };
          }
        }
        return node;
      };
      const layout =
        "root" in request.payload.target
          ? desired
          : replaceTarget(current.layout);
      const resultingIds = new Set(locklessTopologyPaneIds(layout));
      if (
        !("root" in request.payload.target) &&
        !resultingIds.has(request.payload.target.paneId)
      ) {
        const targetWasPresent = locklessTopologyPaneIds(current.layout).includes(
          request.payload.target.paneId,
        );
        if (!targetWasPresent) {
          throw new SurfaceCoreError(
            "invalid_payload",
            "topology.apply target pane is not live",
          );
        }
      }
      const removed = [...existing.keys()].filter((paneId) => !resultingIds.has(paneId));
      const allowed = new Set(request.payload.allowDestroyPaneIds);
      if (removed.some((paneId) => !allowed.has(paneId))) {
        throw new SurfaceCoreError(
          "invalid_payload",
          "topology.apply removal requires allowDestroyPaneIds",
          { removedPaneIds: removed },
        );
      }
      this.core.locklessAuthority.assertPaneCreationCapacity(
        existing.size,
        resultingIds.size,
      );
      const panes = [...resultingIds].map((paneId) => {
        const prior = existing.get(paneId);
        const added = created.get(paneId);
        return {
          name: added?.name ?? prior?.name ?? null,
          paneId: paneId as never,
          paneLabel: added?.paneLabel ?? prior!.paneLabel,
        };
      });
      const rollback = this.core.captureSurfaceMutationRollback(surfaceId);
      const beforeRecord =
        this.core.captureSurfaceTombstonePayload(surfaceId);
      const removedPanePayloads = removed.map((paneId) =>
        this.core.capturePaneTombstonePayload(surfaceId, paneId),
      );
      try {
            const result = this.core.topologyApply(surfaceId, {
              layout,
              panes,
              topologyRevision:
                (request.payload.expectedTopologyRevision + 1) as never,
              windowLabel: current.windowLabel,
            });
            this.assertLocklessRecoverableCapacity(surfaceId, beforeRecord);
            const destroyedPaneTombstones = [];
            for (const payload of removedPanePayloads) {
              const tombstone =
                this.core.locklessAuthority.createTombstone({
                kind: "pane",
                payload,
                surfaceId,
              });
              destroyedPaneTombstones.push({
                closedSequence: tombstone.closedSequence,
                paneId: payload.pane.paneId,
                tombstoneId: tombstone.tombstoneId,
              });
            }
            for (const paneId of created.keys()) {
              this.core.locklessAuthority.ensureScope(
                locklessPaneScopeId(surfaceId, paneId),
                "pane",
              );
            }
            const topology = this.core.topologyState(surfaceId);
            return {
              createdPaneIds: [...created.keys()],
              destroyedPaneIds: removed,
              destroyedPaneTombstones,
              panes: this.core.panesList(surfaceId).panes,
              preservedPaneIds: [...resultingIds].filter((paneId) =>
                existing.has(paneId),
              ),
              topology: topology.layout,
              topologyRevision: Number(result.topologyRevision),
            };
      } catch (error) {
        rollback();
        throw error;
      }
    }, surfaceId);
  }

  private async dispatchRequest(socket: WebSocket, request: Request): Promise<Response> {
    if ((request as { op: string }).op === "diagnostics.overlay_regions") {
      return this.handleOverlayDiagnostics(socket, request);
    }
    switch (request.op) {
      case "surfaces.list":
        return this.handleSurfacesList(request);
      case "runtime.app_binding":
        return await this.handleRuntimeAppBinding(request);
      case "topology.apply":
        return await this.handleTopologyApply(socket, request);
      case "content.apply":
        return await this.handleContentApply(socket, request);
      case "target.apply":
        return await this.handleTargetApply(socket, request);
      case "panes.list":
        return await this.handlePanesList(socket, request);
      case "pane.split":
        return await this.handlePaneSplit(socket, request);
      case "pane.rename":
        return this.handlePaneRename(socket, request);
      case "pane.close":
        return await this.handlePaneClose(socket, request);
      case "content.set":
        return await this.handleContentSet(socket, request);
      case "content.clear":
        return await this.handleContentClear(socket, request);
      case "content.append":
        return await this.handleContentAppend(socket, request);
      case "content.patch":
        return await this.handleContentPatch(socket, request);
      case "annotations.remove":
        return await this.handleAnnotationsRemove(socket, request);
      case "snapshot.get":
        return await this.handleSnapshotGet(socket, request);
      case "heartbeat.ping":
        return this.handleHeartbeat(socket, request);
    }
  }

  private handleOverlayDiagnostics(socket: WebSocket, request: Request): Response {
    const surfaceId = this.requirePairedSurfaceId(socket);
    return {
      id: request.id,
      ok: true,
      op: "diagnostics.overlay_regions",
      payload: {
        diagnostics: this.getOverlayDiagnostics?.(surfaceId) ?? null,
        surfaceId,
      },
      sentAt: Date.now(),
      type: "response",
      v: 1,
    } as unknown as Response;
  }

  private handleSurfacesList(request: SurfacesListRequest): Response {
    return {
      id: request.id,
      ok: true,
      op: "surfaces.list",
      payload: {
        capabilities: {
          limits: this.core.locklessAuthority.limits,
          protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
          surfaceLifecycle: true,
        },
        surfaceSetRevision:
          this.core.locklessAuthority.surfaceSetRevision,
        surfaceTombstones:
          this.core.locklessAuthority.listTombstones("surface"),
        surfaces: this.core.listSurfaces().map((surface) => ({
          name: surface.name,
          paired: this.hasLocklessSession(surface.surfaceId),
          surfaceId: surface.surfaceId,
          viewport: this.core.viewport(surface.surfaceId),
        })),
      },
      sentAt: Date.now(),
      type: "response",
      v: 1,
    } as unknown as Response;
  }

  private async handleRuntimeAppBinding(request: Request): Promise<Response> {
    return {
      id: request.id,
      ok: true,
      op: "runtime.app_binding",
      payload: {
        runtimeAppBinding: await this.currentRuntimeAppBinding(),
      },
      sentAt: Date.now() as never,
      type: "response",
      v: 1,
    };
  }

  private async handlePanesList(socket: WebSocket, request: PanesListRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    await this.refreshNativePaneWindowGroups(surfaceId);
    const payload = this.core.panesList(surfaceId);
    persistentServerDiagnostic(
      "info",
      "panes_list_summary",
      {
        pane_count: payload.panes.length,
        pane_ids: payload.panes.map((pane) => Number(pane.paneId)).join(","),
        pane_labels: payload.panes.map((pane) => pane.paneLabel).join(","),
        pane_content_ids: payload.panes.map((pane) => pane.activeContentId ?? "nil").join(","),
        request_id: request.id,
        surface_id: surfaceId,
      },
    );
    return {
      id: request.id,
      ok: true,
      op: "panes.list",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async refreshNativePaneWindowGroups(surfaceId: string): Promise<void> {
    if (!this.compositorSocketPath) {
      return;
    }
    try {
      const status = await sendCompositorControl(this.compositorSocketPath, { type: "get_status" });
      const failure = compositorFailureMessage(status);
      if (failure) {
        persistentServerDiagnostic("warn", "native_window_group_refresh_failed", {
          error_message: failure,
          surface_id: surfaceId,
        });
        return;
      }
      const observedWindowGroups = nativePaneWindowGroupsFromCompositorStatus(status);
      this.core.markNativePaneWindowGroups(surfaceId, observedWindowGroups);
    } catch (error) {
      persistentServerDiagnostic("warn", "native_window_group_refresh_failed", {
        error_message: error instanceof Error ? error.message : String(error),
        surface_id: surfaceId,
      });
    }
  }

  private async runSurfaceMutation<T>(surfaceId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.mutationQueues.get(surfaceId) ?? Promise.resolve();
    let releaseQueue = (): void => {};
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.mutationQueues.set(surfaceId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseQueue();
      if (this.mutationQueues.get(surfaceId) === queued) {
        this.mutationQueues.delete(surfaceId);
      }
    }
  }

  private async runLocklessPairReservation<T>(
    _surfaceId: string | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await operation();
  }
  private async runLifecycleTransaction<T>(
    operation: () => T,
    surfaceId?: string,
  ): Promise<T> {
    const previous = this.lifecycleMutationQueue;
    let releaseQueue = (): void => {};
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.lifecycleMutationQueue = queued;
    await previous.catch(() => undefined);
    try {
      const transact = () =>
        this.core.transaction(() =>
          this.core.locklessAuthority.transaction(operation),
        );
      return surfaceId
        ? await this.runSurfaceMutation(surfaceId, transact)
        : transact();
    } finally {
      releaseQueue();
      if (this.lifecycleMutationQueue === queued) {
        this.lifecycleMutationQueue = Promise.resolve();
      }
    }
  }

  private assertLocklessRecoverableCapacity(
    surfaceId: string,
    before: ReturnType<SurfaceCore["captureSurfaceTombstonePayload"]>,
  ): void {
    const after = this.core.captureSurfaceTombstonePayload(surfaceId);
    const { panes: _beforePanes, ...beforeBase } = before;
    this.core.locklessAuthority.assertSurfaceRecoverableBaseCapacity(
      beforeBase,
      this.core.captureSurfaceRecoverableBase(surfaceId),
    );
    for (const pane of after.panes) {
      this.core.locklessAuthority.assertPaneRecoverableCapacity(
        before.panes.find((candidate) => candidate.paneId === pane.paneId) ??
          {},
        pane,
        pane.history.map((entry) => entry.annotations),
      );
    }
  }

  private async runProviderWindowLabelMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.providerWindowLabelQueue;
    let releaseQueue = (): void => {};
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.providerWindowLabelQueue = queued;
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseQueue();
      if (this.providerWindowLabelQueue === queued) {
        this.providerWindowLabelQueue = Promise.resolve();
      }
    }
  }

  private async waitForResolvedPaneGeometry(
    surfaceId: string,
    paneIds: number[],
    operation: string,
  ): Promise<void> {
    const uniquePaneIds = [...new Set(paneIds)];
    if (uniquePaneIds.length === 0) {
      return;
    }
    const expectedIdentity = this.core.resolvedPaneGeometryIdentity(surfaceId);
    let missing = this.core.missingResolvedPaneGeometry(surfaceId, uniquePaneIds, expectedIdentity);
    if (missing.length === 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let unsubscribe = (): void => {};
      const cleanup = (): void => {
        clearTimeout(timeout);
        unsubscribe();
      };
      const check = (): void => {
        try {
          missing = this.core.missingResolvedPaneGeometry(surfaceId, uniquePaneIds, expectedIdentity);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (missing.length === 0) {
          cleanup();
          resolve();
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        persistentServerDiagnostic("warn", "pane_geometry_ready_timeout", {
          missing_pane_ids: missing.join(","),
          operation,
          expected_geometry_revision: expectedIdentity.geometryRevision,
          expected_surface_epoch: expectedIdentity.surfaceEpoch,
          expected_topology_revision: expectedIdentity.topologyRevision,
          surface_id: surfaceId,
        });
        reject(new SurfaceCoreError(
          "render_failed",
          `${operation} did not produce resolved pane geometry for pane(s): ${missing.join(",")}`,
        ));
      }, PANE_GEOMETRY_READY_TIMEOUT_MS);
      unsubscribe = this.core.subscribe((event) => {
        if (event.surfaceId !== surfaceId) {
          return;
        }
        if (event.type === "pane-geometry-changed" || event.type === "surface-changed") {
          check();
        }
      });
      check();
    });
  }

  async setViewport(surfaceId: string, viewport: SurfaceViewport): Promise<boolean> {
    return await this.runSurfaceMutation(surfaceId, async () => {
      const nativePaneIds = this.core.panesList(surfaceId).panes
        .filter((pane) => pane.externalNative)
        .map((pane) => Number(pane.paneId));
      if (nativePaneIds.length === 0) {
        this.core.setViewport(surfaceId, viewport);
        return true;
      }
      const rollbackSurface = this.core.captureSurfaceMutationRollback(surfaceId);
      const rollbackMaterialization = this.core.projectCurrentNativePaneGeometry(surfaceId, nativePaneIds);
      try {
        this.core.setViewport(surfaceId, viewport);
        await this.waitForResolvedPaneGeometry(surfaceId, this.core.activePaneIds(surfaceId), "viewport");
        const materialization = this.core.projectCurrentNativePaneGeometry(surfaceId, nativePaneIds);
        await this.applyResolvedNativePaneGeometry(surfaceId, materialization, "viewport", rollbackMaterialization);
        this.markUpdatedNativePaneGeometry(surfaceId, materialization);
        return true;
      } catch (error) {
        rollbackSurface();
        persistentServerDiagnostic("warn", "viewport_resize_failed", {
          surface_id: surfaceId,
          ...errorDiagnosticFields(error),
        });
        return false;
      }
    });
  }

  async resizeSplit(surfaceId: string, path: number[], weights: number[]): Promise<boolean> {
    return await this.runSurfaceMutation(surfaceId, async () => {
      const nativePaneIds = this.core.panesList(surfaceId).panes
        .filter((pane) => pane.externalNative)
        .map((pane) => Number(pane.paneId));
      const rollbackSurface = this.core.captureSurfaceMutationRollback(surfaceId);
      const rollbackNativeGeometry = nativePaneIds.length > 0
        ? this.core.projectCurrentNativePaneGeometry(surfaceId, nativePaneIds)
        : null;
      try {
        this.core.resizeSplit(surfaceId, path, weights);
        await this.waitForResolvedPaneGeometry(surfaceId, this.core.activePaneIds(surfaceId), "pane.resize");
        const nativeGeometryUpdate = nativePaneIds.length > 0
          ? this.core.projectCurrentNativePaneGeometry(surfaceId, nativePaneIds)
          : null;
        await this.applyResolvedNativePaneGeometry(surfaceId, nativeGeometryUpdate, "pane.resize", rollbackNativeGeometry);
        this.markUpdatedNativePaneGeometry(surfaceId, nativeGeometryUpdate);
        return true;
      } catch (error) {
        rollbackSurface();
        persistentServerDiagnostic("warn", "pane_resize_failed", {
          surface_id: surfaceId,
          ...errorDiagnosticFields(error),
        });
        return false;
      }
    });
  }

  async navigateHistoryAfterNativeRelease(
    surfaceId: string,
    paneId: number,
    direction: "back" | "forward",
  ): Promise<boolean> {
    return await this.runSurfaceMutation(surfaceId, async () => {
      if (!this.core.canNavigateHistory(surfaceId, paneId, direction)) {
        this.core.navigateHistory(surfaceId, paneId, direction);
        return true;
      }
      const nativeHostedPaneId = this.core.nativeHostedPaneIdForPaneId(surfaceId, paneId);
      const releaseFailure = await this.releaseNativePanesBeforeRendererContent(surfaceId, [nativeHostedPaneId], "history");
      if (releaseFailure) {
        return false;
      }
      if (!this.core.canNavigateHistory(surfaceId, paneId, direction)) {
        return false;
      }
      this.core.navigateHistory(surfaceId, paneId, direction);
      return true;
    });
  }

  private async handleTopologyApply(socket: WebSocket, request: TopologyApplyRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    persistentServerDiagnostic(
      "info",
      "topology_apply_receive",
      {
        pane_ids: request.payload.panes.map((pane) => Number(pane.paneId)).join(","),
        pane_labels: request.payload.panes.map((pane) => pane.paneLabel).join(","),
        payload: diagnosticJson(request.payload),
        request_id: request.id,
        surface_id: surfaceId,
        topology_revision: Number(request.payload.topologyRevision),
        window_label: request.payload.windowLabel,
      },
    );
    if (!isValidWindowLabel(request.payload.windowLabel)) {
      persistentServerDiagnostic(
        "warn",
        "topology_apply_validation_failed",
        {
          code: "invalid_window_label",
          request_id: request.id,
          surface_id: surfaceId,
          window_label: request.payload.windowLabel,
        },
      );
      throw new SurfaceCoreError(
        "invalid_payload",
        "topology.apply windowLabel must be a lowercase alphabetic provider identity label",
      );
    }
    const currentWindowLabel = this.core.surfaceWindowLabel(surfaceId);
    if (request.payload.windowLabel.length > 3 && request.payload.windowLabel !== currentWindowLabel) {
      persistentServerDiagnostic(
        "warn",
        "topology_apply_validation_failed",
        {
          code: "invalid_window_label",
          request_id: request.id,
          surface_id: surfaceId,
          window_label: request.payload.windowLabel,
        },
      );
      throw new SurfaceCoreError(
        "invalid_payload",
        "topology.apply windowLabel must match the paired surface identity",
      );
    }
    const payload = await this.runProviderWindowLabelMutation(() => this.runSurfaceMutation(surfaceId, async () => {
      const previousWindowLabel = this.core.surfaceWindowLabel(surfaceId);
      const removedNativePaneIds = this.core.nativeHostedPaneIdsForTopologyApply(surfaceId, request.payload);
      const retainedPaneIds = new Set(request.payload.panes.map((pane) => Number(pane.paneId)));
      const retainedNativePaneIds = this.core.panesList(surfaceId).panes
        .filter((pane) => pane.externalNative && retainedPaneIds.has(Number(pane.paneId)))
        .map((pane) => Number(pane.paneId));
      const rollbackSurface = this.core.captureSurfaceMutationRollback(surfaceId);
      const rollbackNativeGeometry = retainedNativePaneIds.length > 0
        ? this.core.projectCurrentNativePaneGeometry(surfaceId, retainedNativePaneIds)
        : null;
      try {
        const result = this.core.topologyApply(surfaceId, request.payload);
        await this.waitForResolvedPaneGeometry(
          surfaceId,
          result.panes.map((pane) => Number(pane.paneId)),
          "topology.apply",
        );
        const nativeGeometryUpdate = retainedNativePaneIds.length > 0
          ? this.core.projectCurrentNativePaneGeometry(surfaceId, retainedNativePaneIds)
          : null;
        await this.applyResolvedNativePaneGeometry(
          surfaceId,
          nativeGeometryUpdate,
          "topology.apply",
          rollbackNativeGeometry,
        );
        const releaseFailure = await this.releaseNativePanesBeforeRendererContent(
          surfaceId,
          removedNativePaneIds,
          "topology.apply",
        );
        if (releaseFailure) {
          await this.rollbackNativePaneGeometry(surfaceId, rollbackNativeGeometry, "topology.apply", releaseFailure);
          throw new SurfaceCoreError("render_failed", releaseFailure);
        }
        this.recordWindowRelabel(surfaceId, previousWindowLabel, request.payload.windowLabel, request.id);
        this.markUpdatedNativePaneGeometry(surfaceId, nativeGeometryUpdate);
        return result;
      } catch (error) {
        rollbackSurface();
        throw error;
      }
    }));
    persistentServerDiagnostic(
      "info",
      "topology_apply_applied",
      {
        pane_lineage_ids: payload.panes.map((pane) => pane.paneLineageId).join(","),
        pane_ids: payload.panes.map((pane) => Number(pane.paneId)).join(","),
        request_id: request.id,
        response_panes: diagnosticJson(payload.panes),
        surface_id: surfaceId,
        topology_revision: Number(payload.topologyRevision),
        window_label: request.payload.windowLabel,
      },
    );
    return {
      id: request.id,
      ok: true,
      op: "topology.apply",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handleContentApply(socket: WebSocket, request: ContentApplyRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    if ("clear" in request.payload) {
      const payload = await this.runSurfaceMutation(surfaceId, async () => {
        const nativeHostedPaneId = this.core.nativeHostedPaneIdForContentApply(surfaceId, request.payload);
        const releaseFailure = await this.releaseNativePanesBeforeRendererContent(surfaceId, [nativeHostedPaneId], "content.apply");
        if (releaseFailure) {
          throw new SurfaceCoreError("render_failed", releaseFailure);
        }
        this.core.nativeHostedPaneIdForContentApply(surfaceId, request.payload);
        return this.core.contentApply(surfaceId, request.payload);
      });
      persistentServerDiagnostic(
        "info",
        "content_apply_result",
        {
          content_id: payload.currentContentId ?? "nil",
          pane_id: request.payload.paneId,
          request_id: request.id,
          result: "applied",
          revision: payload.currentRevision,
          surface_id: surfaceId,
          topology_revision: Number(payload.topologyRevision ?? 0),
        },
      );
      return {
        id: request.id,
        ok: true,
        op: "content.apply",
        payload,
        sentAt: Date.now(),
        type: "response",
        v: 1,
      };
    }
    const contentBytes = Buffer.byteLength(JSON.stringify(request.payload.content), "utf8");
    if (contentBytes > DEFAULT_LIMITS.maxFrameBytes) {
      throw new SurfaceCoreError("content_too_large", "Content exceeded max frame size");
    }
    if (!request.payload.historyOwnerToken) {
      throw new SurfaceCoreError("invalid_payload", "content.apply requires historyOwnerToken");
    }
    const payload = await this.runSurfaceMutation(surfaceId, async () => {
      const nativeHostedPaneId = this.core.nativeHostedPaneIdForContentApply(surfaceId, request.payload);
      const releaseFailure = await this.releaseNativePanesBeforeRendererContent(surfaceId, [nativeHostedPaneId], "content.apply");
      if (releaseFailure) {
        throw new SurfaceCoreError("render_failed", releaseFailure);
      }
      this.core.nativeHostedPaneIdForContentApply(surfaceId, request.payload);
      return this.core.contentApply(surfaceId, request.payload);
    });
    persistentServerDiagnostic(
      "info",
      "content_apply_result",
      {
        content_id: payload.currentContentId ?? "nil",
        content_type: request.payload.contentType,
        pane_id: request.payload.paneId,
        request_id: request.id,
        result: "applied",
        revision: payload.currentRevision,
        surface_id: surfaceId,
        topology_revision: Number(payload.topologyRevision ?? 0),
      },
    );
    return {
      id: request.id,
      ok: true,
      op: "content.apply",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handleTargetApply(socket: WebSocket, request: TargetApplyRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    return await this.handleTargetApplyForSurface(
      surfaceId,
      socket,
      request,
      false,
    );
  }

  private async handleTargetApplyForSurface(
    surfaceId: string,
    socket: WebSocket | null,
    request: TargetApplyRequest,
    committedLocklessIntent: boolean,
  ): Promise<Response> {
    const appliedAt = new Date().toISOString();
    if (request.payload.surfaceId !== surfaceId) {
      return this.targetApplyFailureResponse(request, appliedAt, "invalid_payload", "target.apply surfaceId does not match the admitted surface");
    }
    const sessionFailure = committedLocklessIntent
      ? null
      : this.targetApplySessionFailure(surfaceId, socket!, request, appliedAt);
    if (sessionFailure) {
      return sessionFailure;
    }

    if (request.payload.targetKind === "browser_url") {
      const targetUrl = String((request.payload.targetPayload as { url?: unknown }).url ?? "");
      persistentServerDiagnostic(
        "info",
        "target_apply_browser_url_begin",
        {
          pane_lineage_id: request.payload.paneLineageId,
          request_id: request.payload.requestId,
          surface_id: surfaceId,
          target_id: request.payload.targetId,
          ...browserUrlDiagnosticFields(targetUrl),
        },
      );
      const preflightFailure = this.core.browserUrlTargetPreflight(surfaceId, request.payload);
      if (preflightFailure) {
        persistentServerDiagnostic(
          "info",
          "target_apply_browser_url_result",
          {
            error_code: preflightFailure.errorCode,
            materialized_navigation_status: preflightFailure.materializedState?.navigationStatus,
            message: preflightFailure.message,
            pane_lineage_id: request.payload.paneLineageId,
            request_id: request.payload.requestId,
            status: preflightFailure.status,
            surface_id: surfaceId,
            target_id: request.payload.targetId,
            ...browserUrlDiagnosticFields(targetUrl),
          },
        );
        return {
          id: request.id,
          ok: true,
          op: "target.apply.result",
          payload: preflightFailure,
          sentAt: Date.now(),
          type: "response",
          v: 1,
        };
      }
      const releaseResult = await this.runSurfaceMutation(surfaceId, async () => {
        const currentSessionFailure = committedLocklessIntent
          ? null
          : this.targetApplySessionFailure(surfaceId, socket!, request, appliedAt);
        if (currentSessionFailure) {
          return {
            response: currentSessionFailure,
          };
        }
        const nativeHostedPaneId = this.core.nativeHostedPaneIdForLineage(surfaceId, request.payload.paneLineageId);
        const releaseFailure = await this.releaseNativePanesBeforeRendererContent(
          surfaceId,
          [nativeHostedPaneId],
          "browser_url",
        );
        if (releaseFailure) {
          return { failure: releaseFailure as string };
        }
        const postReleasePreflightFailure = this.core.browserUrlTargetPreflight(surfaceId, request.payload);
        if (postReleasePreflightFailure) {
          return { payload: postReleasePreflightFailure };
        }
        const postReleaseSessionFailure = committedLocklessIntent
          ? null
          : this.targetApplySessionFailure(surfaceId, socket!, request, appliedAt);
        if (postReleaseSessionFailure) {
          return { response: postReleaseSessionFailure };
        }
        const rollback = this.core.captureSurfaceMutationRollback(surfaceId);
        const before =
          this.core.captureSurfaceTombstonePayload(surfaceId);
        try {
          return {
            payload: this.core.transaction(() => {
              const payload = this.core.targetApply(
                surfaceId,
                request.payload,
              );
              this.assertLocklessRecoverableCapacity(surfaceId, before);
              return payload;
            }),
          };
        } catch (error) {
          rollback();
          throw error;
        }
      });
      if ("response" in releaseResult) {
        return releaseResult.response;
      }
      if ("failure" in releaseResult) {
        persistentServerDiagnostic(
          "info",
          "target_apply_browser_url_result",
          {
            error_code: "materialization_failed",
            message: releaseResult.failure,
            pane_lineage_id: request.payload.paneLineageId,
            request_id: request.payload.requestId,
            status: "failed",
            surface_id: surfaceId,
            target_id: request.payload.targetId,
            ...browserUrlDiagnosticFields(targetUrl),
          },
        );
        return this.targetApplyFailureResponse(request, appliedAt, "materialization_failed", releaseResult.failure);
      }
      const result = releaseResult.payload;
      const paneId = this.core.pairState(surfaceId).panes.find((pane) =>
        pane.paneLineageId === request.payload.paneLineageId
      )?.paneId;
      const shouldWaitForBrowserUrl =
        paneId !== undefined &&
        result.status === "failed" &&
        result.errorCode === "materialization_failed" &&
        result.materializedState?.navigationStatus === "started_unverified";
      const payload = shouldWaitForBrowserUrl
        ? await this.waitForBrowserUrlNavigation(
            surfaceId,
            Number(paneId),
            request,
            socket,
            appliedAt,
            committedLocklessIntent,
          )
        : result;
      persistentServerDiagnostic(
        "info",
        "target_apply_browser_url_result",
        {
          current_url: payload.materializedState?.url,
          error_code: payload.errorCode,
          materialized_navigation_status: payload.materializedState?.navigationStatus,
          message: payload.message,
          pane_id: paneId,
          pane_lineage_id: request.payload.paneLineageId,
          request_id: request.payload.requestId,
          status: payload.status,
          surface_id: surfaceId,
          target_id: request.payload.targetId,
          ...browserUrlDiagnosticFields(targetUrl),
        },
      );
      return {
        id: request.id,
        ok: true,
        op: "target.apply.result",
        payload,
        sentAt: Date.now(),
        type: "response",
        v: 1,
      };
    }

    if (!isNativeHostTargetKind(request.payload.targetKind)) {
      const payload: TargetApplyResponse["payload"] = {
        appliedAt,
        errorCode: "unsupported_target_kind",
        message: `Unsupported target kind: ${request.payload.targetKind}`,
        paneLineageId: request.payload.paneLineageId,
        requestId: request.payload.requestId,
        status: "rejected",
        targetEpoch: request.payload.targetEpoch,
        targetId: request.payload.targetId,
      };
      return {
        id: request.id,
        ok: true,
        op: "target.apply.result",
        payload,
        sentAt: Date.now(),
        type: "response",
        v: 1,
      };
    }
    return await this.runSurfaceMutation(surfaceId, async () => {
      const currentSessionFailure = committedLocklessIntent
        ? null
        : this.targetApplySessionFailure(surfaceId, socket!, request, appliedAt);
      if (currentSessionFailure) {
        return currentSessionFailure;
      }

      let materialization: NativePaneMaterialization;
      try {
        materialization = this.core.projectNativePaneMaterialization(
          surfaceId,
          request.payload,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "native pane host plan projection failed";
        return this.targetApplyFailureResponse(request, appliedAt, "materialization_failed", message);
      }
      if (!this.compositorSocketPath) {
        const payload: TargetApplyResponse["payload"] = {
          appliedAt,
          errorCode: "materialization_failed",
          message: publicTargetApplyMessage("materialization_failed"),
          paneLineageId: request.payload.paneLineageId,
          requestId: request.payload.requestId,
          status: "failed",
          targetEpoch: request.payload.targetEpoch,
          targetId: request.payload.targetId,
        };
        return {
          id: request.id,
          ok: true,
          op: "target.apply.result",
          payload,
          sentAt: Date.now(),
          type: "response",
          v: 1,
        };
      }

      if (request.payload.targetKind === "native_app") {
        const runtimeAppBinding = await this.currentRuntimeAppBinding();
        if (!runtimeAppBinding?.ready) {
          const diagnostic = runtimeAppBinding
            ? runtimeAppBinding.bindingAuthority === "blocked"
              ? runtimeAppBinding.bindingBlockReason ?? "runtime_binding_blocked"
              : runtimeAppBinding.bindingDegradedReasons[0] ?? "runtime_binding_degraded"
            : "runtime_binding_missing";
          const payload: TargetApplyResponse["payload"] = {
            appliedAt,
            errorCode: "materialization_failed",
            materializedState: nativeHostMaterializedState(request.payload, materialization, {
              diagnostics: [diagnostic],
              nativeHost: "not_applied",
              overlayRegions: "not_requested",
            }),
            message: publicTargetApplyMessage("materialization_failed"),
            paneLineageId: request.payload.paneLineageId,
            requestId: request.payload.requestId,
            status: "failed",
            targetEpoch: request.payload.targetEpoch,
            targetId: request.payload.targetId,
          };
          return {
            id: request.id,
            ok: true,
            op: "target.apply.result",
            payload,
            sentAt: Date.now(),
            type: "response",
            v: 1,
          };
        }
      }

      let hostRequest: CompositorControlRequest | null = null;
      let preflightStatus: CompositorControlResponse | null = null;
      let hostApplied = false;
      let overlayRequest: CompositorControlRequest | null = null;
      let overlayApplied = false;
      const recoverableBefore =
        this.core.captureSurfaceTombstonePayload(surfaceId);
      const rollbackRecoverable =
        this.core.captureSurfaceMutationRollback(surfaceId);
      try {
        hostRequest = requestForCompositor(materialization);
        preflightStatus = await sendCompositorControl(this.compositorSocketPath, { type: "get_status" });
        const statusFailure = compositorFailureMessage(preflightStatus);
        if (statusFailure) {
          throw new Error(statusFailure);
        }
        const geometryFailure = validateMaterializationAgainstCompositorStatus(hostRequest, preflightStatus);
        if (geometryFailure) {
          throw new Error(geometryFailure);
        }
        const layoutFailure = this.core.validateNativePaneMaterializationLayout(surfaceId, materialization);
        if (layoutFailure) {
          throw new Error(layoutFailure);
        }
        const hostResponse = await sendCompositorControl(this.compositorSocketPath, hostRequest);
        const hostFailure = compositorFailureMessage(hostResponse);
        if (hostFailure) {
          throw new Error(hostFailure);
        }
        hostApplied = true;
        const postHostLayoutFailure = this.core.validateNativePaneMaterializationLayout(surfaceId, materialization);
        if (postHostLayoutFailure) {
          throw new Error(postHostLayoutFailure);
        }
        const postHostSessionFailure = committedLocklessIntent
          ? null
          : this.targetApplySessionFailure(surfaceId, socket!, request, appliedAt);
        if (postHostSessionFailure) {
          const releasedAfterFailure = await this.releaseNativePaneAfterFailedHost(surfaceId, materialization);
          if (!releasedAfterFailure) {
            this.core.markNativePaneMaterialized(surfaceId, materialization);
            this.onNativeMaterialized?.(surfaceId, materialization);
          }
          return postHostSessionFailure;
        }
        overlayRequest = overlayRequestForCompositor(materialization, {
          topologyEpoch: overlayTopologyEpochFromCompositorResponse(hostResponse) ?? undefined,
        });
        const overlayResponse = overlayRequest
          ? await this.sendNativeOverlayRequestWithLivenessRetry(overlayRequest)
          : null;
        if (overlayResponse) {
          const overlayFailure = compositorFailureMessage(overlayResponse);
          if (overlayFailure) {
            throw new Error(overlayFailure);
          }
          overlayApplied = true;
        }
        const readinessResponse = request.payload.targetKind === "native_app"
          ? await this.waitForNativePaneWindowGroupReadiness(materialization, overlayResponse ?? hostResponse)
          : overlayResponse ?? hostResponse;
        const postOverlayLayoutFailure = this.core.validateNativePaneMaterializationLayout(surfaceId, materialization);
        if (postOverlayLayoutFailure) {
          throw new Error(postOverlayLayoutFailure);
        }
        const postOverlaySessionFailure = committedLocklessIntent
          ? null
          : this.targetApplySessionFailure(surfaceId, socket!, request, appliedAt);
        if (postOverlaySessionFailure) {
          const releasedAfterFailure = await this.releaseNativePaneAfterFailedHost(surfaceId, materialization);
          if (!releasedAfterFailure) {
            this.core.markNativePaneMaterialized(surfaceId, materialization);
            this.onNativeMaterialized?.(surfaceId, materialization);
          }
          return postOverlaySessionFailure;
        }
        const payload: TargetApplyResponse["payload"] = {
          appliedAt,
          materializedState: {
            ...nativeHostMaterializedState(request.payload, materialization, {
              ...nativePaneReadinessFromCompositor(readinessResponse, materialization),
              nativeHost: nativePaneWindowGroupsFromCompositorStatus(readinessResponse).some((group) =>
                nativePaneWindowGroupMatchesMaterialization(group, materialization)
              ) ? "applied" : "not_applied",
              overlayRegions: overlayRequest ? "applied" : "not_requested",
            }),
          },
          paneLineageId: request.payload.paneLineageId,
          requestId: request.payload.requestId,
          status: "applied",
          targetEpoch: request.payload.targetEpoch,
          targetId: request.payload.targetId,
        };
        const observedWindowGroups = nativePaneWindowGroupsFromCompositorStatus(readinessResponse);
        this.core.transaction(() => {
          this.core.markNativePaneMaterialized(surfaceId, materialization);
          if (observedWindowGroups.length > 0) {
            this.core.markNativePaneWindowGroups(
              surfaceId,
              observedWindowGroups,
            );
          }
          this.assertLocklessRecoverableCapacity(
            surfaceId,
            recoverableBefore,
          );
        });
        this.onNativeMaterialized?.(surfaceId, materialization);
        return {
          id: request.id,
          ok: true,
          op: "target.apply.result",
          payload,
          sentAt: Date.now(),
          type: "response",
          v: 1,
        };
      } catch (error) {
        const capacityError =
          error instanceof LocklessAuthorityError &&
          (error.code === "surface_state_capacity" ||
            error.code === "pane_state_capacity");
        if (capacityError) {
          rollbackRecoverable();
        }
        const releasedAfterFailure = hostApplied
          ? await this.releaseNativePaneAfterFailedHost(surfaceId, materialization)
          : false;
        if (hostApplied && !releasedAfterFailure) {
          this.core.markNativePaneMaterialized(surfaceId, materialization);
          this.onNativeMaterialized?.(surfaceId, materialization);
        }
        persistentServerDiagnostic(
          "warn",
          "target_apply_native_materialization_failed",
          {
            error_message: error instanceof Error ? error.message : String(error),
            host_applied: hostApplied,
            native_host: releasedAfterFailure ? "released_after_failure" : hostApplied ? "applied" : "not_applied",
            overlay_applied: overlayApplied,
            overlay_regions: overlayRequest ? overlayApplied ? "applied" : "not_applied" : "not_requested",
            pane_lineage_id: request.payload.paneLineageId,
            request_id: request.payload.requestId,
            surface_id: surfaceId,
            target_id: request.payload.targetId,
          },
        );
        if (capacityError) throw error;
        const payload: TargetApplyResponse["payload"] = {
          appliedAt,
          errorCode: "materialization_failed",
          materializedState: nativeHostMaterializedState(request.payload, materialization, {
            diagnostics: [error instanceof Error ? error.message : "native host materialization failed"],
            nativeHost: releasedAfterFailure ? "released_after_failure" : hostApplied ? "applied" : "not_applied",
            overlayRegions: overlayRequest
              ? overlayApplied
                ? "applied"
                : "not_applied"
              : "not_requested",
          }),
          message: publicTargetApplyMessage("materialization_failed"),
          paneLineageId: request.payload.paneLineageId,
          requestId: request.payload.requestId,
          status: "failed",
          targetEpoch: request.payload.targetEpoch,
          targetId: request.payload.targetId,
        };
        return {
          id: request.id,
          ok: true,
          op: "target.apply.result",
          payload,
          sentAt: Date.now(),
          type: "response",
          v: 1,
        };
      }
    });
  }

  resolveBrowserUrlNavigation(
    surfaceId: string,
    paneId: number,
    evidence: BrowserUrlNavigationEvidence,
  ): void {
    const key = browserUrlApplyKey(surfaceId, paneId);
    const pending = this.pendingBrowserUrlApplies.get(key);
    if (!pending || pending.request.payload.targetId !== evidence.targetId) {
      persistentServerDiagnostic(
        "info",
        "target_apply_browser_url_renderer_evidence_early",
        {
          current_url: evidence.currentUrl,
          error_message: evidence.errorMessage,
          page_title: evidence.pageTitle,
          pane_id: paneId,
          readback_result: evidence.readbackResult,
          status: evidence.status,
          surface_id: surfaceId,
          target_id: evidence.targetId,
          ...browserUrlDiagnosticFields(evidence.url),
        },
      );
      this.earlyBrowserUrlNavigationEvidence.set(`${key}:${evidence.targetId}`, evidence);
      return;
    }
    this.pendingBrowserUrlApplies.delete(key);
    clearTimeout(pending.timeout);
    persistentServerDiagnostic(
      "info",
      "target_apply_browser_url_renderer_evidence",
      {
        current_url: evidence.currentUrl,
        error_message: evidence.errorMessage,
        page_title: evidence.pageTitle,
        pane_id: paneId,
        readback_result: evidence.readbackResult,
        request_id: pending.request.payload.requestId,
        status: evidence.status,
        surface_id: surfaceId,
        target_id: evidence.targetId,
        ...browserUrlDiagnosticFields(evidence.url),
      },
    );
    pending.resolve(this.browserUrlNavigationPayload(surfaceId, paneId, pending, evidence));
  }

  private async sendNativeOverlayRequestWithLivenessRetry(
    request: CompositorControlRequest,
  ): Promise<CompositorControlResponse> {
    if (!this.compositorSocketPath || request.type !== "overlay_regions.set") {
      return await sendCompositorControl(this.compositorSocketPath ?? "", request);
    }
    let currentRequest = request;
    let response = await sendCompositorControl(this.compositorSocketPath, currentRequest);
    for (let attempt = 0; attempt < this.nativeOverlayLivenessRetryCount; attempt += 1) {
      const liveRegions = overlayRegionsWithLivePaneInstanceAuthority(currentRequest.regions, response);
      if (liveRegions) {
        currentRequest = {
          ...currentRequest,
          regions: liveRegions,
        };
        response = await sendCompositorControl(this.compositorSocketPath, currentRequest);
        continue;
      }
      if (!isOverlayNativePaneLivenessFailure(response)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, this.nativeOverlayLivenessRetryDelayMs));
      const status = await sendCompositorControl(this.compositorSocketPath, { type: "get_status" });
      const topologyEpoch = overlayTopologyEpochFromCompositorResponse(status);
      currentRequest = topologyEpoch === null
        ? currentRequest
        : {
            ...currentRequest,
            topologyEpoch,
          };
      response = await sendCompositorControl(this.compositorSocketPath, currentRequest);
    }
    return response;
  }

  private async waitForNativePaneWindowGroupReadiness(
    materialization: NativePaneMaterialization,
    initialResponse: CompositorControlResponse,
  ): Promise<CompositorControlResponse> {
    if (!this.compositorSocketPath) {
      return initialResponse;
    }
    let response = initialResponse;
    for (let attempt = 0; attempt < this.nativeOverlayLivenessRetryCount; attempt += 1) {
      if (nativePaneWindowGroupsFromCompositorStatus(response).some((group) =>
        nativePaneWindowGroupMatchesMaterialization(group, materialization)
      )) {
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, this.nativeOverlayLivenessRetryDelayMs));
      response = await sendCompositorControl(this.compositorSocketPath, { type: "get_status" });
      const failure = compositorFailureMessage(response);
      if (failure) {
        return response;
      }
    }
    return response;
  }

  private async waitForBrowserUrlNavigation(
    surfaceId: string,
    paneId: number,
    request: TargetApplyRequest,
    socket: WebSocket | null,
    appliedAt: string,
    committedLocklessIntent: boolean,
  ): Promise<TargetApplyResponse["payload"]> {
    return await new Promise((resolve) => {
      const key = browserUrlApplyKey(surfaceId, paneId);
      const previous = this.pendingBrowserUrlApplies.get(key);
      if (previous) {
        this.pendingBrowserUrlApplies.delete(key);
        clearTimeout(previous.timeout);
        const superseded = browserUrlApplyResult(
          previous.request.payload,
          "failed",
          "materialization_failed",
          "browser_url navigation superseded before verification",
          {
            navigationStatus: "failed",
            replaySemantics: "navigate",
            url: String((previous.request.payload.targetPayload as { url?: unknown }).url ?? ""),
          },
        );
        this.core.completeBrowserUrlNavigation(surfaceId, paneId, {
          errorMessage: "browser_url navigation superseded before verification",
          status: "failed",
          targetId: previous.request.payload.targetId,
          url: String((previous.request.payload.targetPayload as { url?: unknown }).url ?? ""),
        }, superseded);
        previous.resolve(superseded);
      }
      const payload = request.payload;
      const targetUrl = String((payload.targetPayload as { url?: unknown }).url ?? "");
      const evidenceKey = `${key}:${payload.targetId}`;
      const earlyEvidence = this.earlyBrowserUrlNavigationEvidence.get(evidenceKey);
      if (earlyEvidence) {
        this.earlyBrowserUrlNavigationEvidence.delete(evidenceKey);
        resolve(this.browserUrlNavigationPayload(surfaceId, paneId, {
          appliedAt,
          committedLocklessIntent,
          request,
          resolve,
          socket,
        }, earlyEvidence));
        return;
      }
      const timeout = setTimeout(() => {
        this.pendingBrowserUrlApplies.delete(key);
        this.earlyBrowserUrlNavigationEvidence.delete(evidenceKey);
        const sessionFailure = committedLocklessIntent || !socket
          ? null
          : this.targetApplySessionFailurePayload(
              surfaceId,
              socket,
              request,
              appliedAt,
            );
        if (sessionFailure) {
          resolve(sessionFailure);
          return;
        }
        const timedOut = browserUrlApplyResult(
          payload,
          "failed",
          "materialization_failed",
          "browser_url navigation was not verified before timeout",
          { navigationStatus: "started_unverified", replaySemantics: "navigate", url: targetUrl },
        );
        this.core.completeBrowserUrlNavigation(surfaceId, paneId, {
          errorMessage: "browser_url navigation was not verified before timeout",
          status: "failed",
          targetId: payload.targetId,
          url: targetUrl,
        }, timedOut);
        resolve(timedOut);
      }, BROWSER_URL_NAVIGATION_TIMEOUT_MS);
      this.pendingBrowserUrlApplies.set(key, {
        appliedAt,
        committedLocklessIntent,
        request,
        resolve,
        socket,
        timeout,
      });
    });
  }

  private browserUrlNavigationPayload(
    surfaceId: string,
    paneId: number,
    pending: Omit<PendingBrowserUrlApply, "timeout">,
    evidence: BrowserUrlNavigationEvidence,
  ): TargetApplyResponse["payload"] {
    const sessionFailure =
      pending.committedLocklessIntent || !pending.socket
        ? null
        : this.targetApplySessionFailurePayload(
            surfaceId,
            pending.socket,
            pending.request,
            pending.appliedAt,
          );
    if (sessionFailure) {
      return sessionFailure;
    }
    let payload = browserUrlApplyResult(
      pending.request.payload,
      evidence.status,
      evidence.status === "failed" ? "materialization_failed" : undefined,
      evidence.status === "applied" ? "browser_url navigation loaded" : evidence.errorMessage ?? "browser_url navigation failed",
      {
        navigationStatus: evidence.status === "applied" ? "loaded" : "failed",
        replaySemantics: "navigate",
        url: evidence.url,
      },
    );
    const completed = this.core.completeBrowserUrlNavigation(surfaceId, paneId, evidence, payload);
    if (!completed) {
      payload = browserUrlApplyResult(
        pending.request.payload,
        "failed",
        "materialization_failed",
        "browser_url navigation was superseded before verification",
        { navigationStatus: "failed", replaySemantics: "navigate", url: evidence.url },
      );
    }
    return payload;
  }

  private async releaseNativePanesBeforeRendererContent(
    surfaceId: string,
    paneIds: Array<number | null>,
    operation: string,
  ): Promise<string | null> {
    const releasePaneIds = paneIds.filter((paneId): paneId is number => paneId !== null);
    if (releasePaneIds.length === 0) {
      return null;
    }
    if (!this.compositorSocketPath) {
      return `${operation} cannot replace a live native-hosted pane without native pane release support`;
    }
    const releaseRequest = nativePaneReleaseRequestForCompositor(releasePaneIds);
    let releaseResponse: CompositorControlResponse;
    try {
      releaseResponse = await sendCompositorControl(this.compositorSocketPath, releaseRequest);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const releaseFailure = compositorFailureMessage(releaseResponse);
    if (releaseFailure) {
      return releaseFailure;
    }
    this.core.markNativePaneReleased(surfaceId, releasePaneIds);
    try {
      await this.onNativeReleased?.(surfaceId, releasePaneIds.map((paneId) => String(paneId)));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  }

  private async applyResolvedNativePaneGeometry(
    surfaceId: string,
    materialization: NativePaneMaterialization | null,
    operation: string,
    rollbackMaterialization: NativePaneMaterialization | null = null,
  ): Promise<void> {
    if (!materialization) {
      return;
    }
    if (!this.compositorSocketPath) {
      throw new SurfaceCoreError("render_failed", `${operation} cannot update live native-hosted pane geometry without native pane update support`);
    }
    const layoutFailure = this.core.validateNativePaneMaterializationLayout(surfaceId, materialization);
    if (layoutFailure) {
      throw new SurfaceCoreError("render_failed", layoutFailure);
    }
    const updateResult = await this.applyNativePaneGeometryToCompositor(materialization);
    if (updateResult.failure) {
      if (updateResult.updated) {
        await this.rollbackNativePaneGeometry(surfaceId, rollbackMaterialization, operation, updateResult.failure);
      }
      throw new SurfaceCoreError("render_failed", updateResult.failure);
    }
    const staleSourceFailure = this.core.validateNativePaneMaterializationLayout(surfaceId, materialization);
    if (staleSourceFailure) {
      await this.rollbackNativePaneGeometry(surfaceId, rollbackMaterialization, operation, staleSourceFailure);
      throw new SurfaceCoreError("render_failed", staleSourceFailure);
    }
  }

  private async applyNativePaneGeometryToCompositor(
    materialization: NativePaneMaterialization,
  ): Promise<{ failure: string | null; updated: boolean }> {
    if (!this.compositorSocketPath) {
      return { failure: "native pane update support is unavailable", updated: false };
    }
    const updateRequest = requestForCompositor(materialization);
    let preflightStatus: CompositorControlResponse;
    try {
      preflightStatus = await sendCompositorControl(this.compositorSocketPath, { type: "get_status" });
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error), updated: false };
    }
    const statusFailure = compositorFailureMessage(preflightStatus);
    if (statusFailure) {
      return { failure: statusFailure, updated: false };
    }
    const geometryFailure = validateMaterializationAgainstCompositorStatus(updateRequest, preflightStatus);
    if (geometryFailure) {
      return { failure: geometryFailure, updated: false };
    }
    let updateResponse: CompositorControlResponse;
    try {
      updateResponse = await sendCompositorControl(this.compositorSocketPath, updateRequest);
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error), updated: false };
    }
    const updateFailure = compositorFailureMessage(updateResponse);
    if (updateFailure) {
      return { failure: updateFailure, updated: false };
    }
    const overlayRequest = overlayRequestForCompositor(materialization);
    if (!overlayRequest) {
      return { failure: null, updated: true };
    }
    let overlayResponse: CompositorControlResponse;
    try {
      overlayResponse = await sendCompositorControl(this.compositorSocketPath, overlayRequest);
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error), updated: true };
    }
    const overlayFailure = compositorFailureMessage(overlayResponse);
    if (overlayFailure) {
      return { failure: overlayFailure, updated: true };
    }
    return { failure: null, updated: true };
  }

  private async rollbackNativePaneGeometry(
    surfaceId: string,
    rollbackMaterialization: NativePaneMaterialization | null,
    operation: string,
    reason: string,
  ): Promise<void> {
    if (!rollbackMaterialization || !this.compositorSocketPath) {
      return;
    }
    try {
      const rollbackResult = await this.applyNativePaneGeometryToCompositor(rollbackMaterialization);
      if (rollbackResult.failure) {
        persistentServerDiagnostic("warn", "native_pane_geometry_rollback_failed", {
          failure: rollbackResult.failure,
          operation,
          reason,
          surface_id: surfaceId,
        });
      }
    } catch (error) {
      persistentServerDiagnostic("warn", "native_pane_geometry_rollback_failed", {
        operation,
        reason,
        surface_id: surfaceId,
        ...errorDiagnosticFields(error),
      });
    }
  }

  private markUpdatedNativePaneGeometry(
    surfaceId: string,
    materialization: NativePaneMaterialization | null,
  ): void {
    if (!materialization) {
      return;
    }
    const layoutFailure = this.core.validateNativePaneMaterializationLayout(surfaceId, materialization);
    if (layoutFailure) {
      throw new SurfaceCoreError("render_failed", layoutFailure);
    }
    this.core.markNativePaneMaterialized(surfaceId, materialization);
    this.onNativeMaterialized?.(surfaceId, materialization);
  }

  private async releaseNativePaneAfterFailedHost(
    surfaceId: string,
    materialization: NativePaneMaterialization,
  ): Promise<boolean> {
    if (!this.compositorSocketPath) {
      return false;
    }
    const paneIds = materialization.panes.map((pane) => pane.id);
    let releaseResponse: CompositorControlResponse;
    try {
      releaseResponse = await sendCompositorControl(
        this.compositorSocketPath,
        nativePaneReleaseRequestForCompositor(paneIds),
      );
    } catch {
      return false;
    }
    if (compositorFailureMessage(releaseResponse)) {
      return false;
    }
    this.core.markNativePaneReleased(surfaceId, paneIds);
    try {
      await this.onNativeReleased?.(surfaceId, paneIds.map((paneId) => String(paneId)));
    } catch (error) {
      persistentServerDiagnostic("warn", "native_pane_post_failure_release_cleanup_failed", {
        surface_id: surfaceId,
        ...errorDiagnosticFields(error),
      });
    }
    return true;
  }

  private recordWindowRelabel(
    surfaceId: string,
    currentWindowLabel: string,
    windowLabel: string,
    requestId: string,
  ): void {
    if (windowLabel === currentWindowLabel) {
      return;
    }
    persistentServerDiagnostic(
      "info",
      "topology_apply_window_relabel",
      {
        current_window_label: currentWindowLabel || "nil",
        request_id: requestId,
        source: "topology.apply",
        surface_id: surfaceId,
        window_label: windowLabel,
      },
    );
  }

  private targetApplyFailureResponse(
    request: TargetApplyRequest,
    appliedAt: string,
    errorCode: TargetApplyResponse["payload"]["errorCode"],
    message: string,
  ): Response {
    const payload: TargetApplyResponse["payload"] = {
      appliedAt,
      errorCode,
      message: publicTargetApplyMessage(errorCode, message),
      paneLineageId: request.payload.paneLineageId,
      requestId: request.payload.requestId,
      status: "rejected",
      targetEpoch: request.payload.targetEpoch,
      targetId: request.payload.targetId,
    };
    return {
      id: request.id,
      ok: true,
      op: "target.apply.result",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private targetApplySessionFailure(
    surfaceId: string,
    socket: WebSocket,
    request: TargetApplyRequest,
    appliedAt: string,
  ): Response | null {
    const payload = this.targetApplySessionFailurePayload(surfaceId, socket, request, appliedAt);
    if (!payload) {
      return null;
    }
    return {
      id: request.id,
      ok: true,
      op: "target.apply.result",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private targetApplySessionFailurePayload(
    surfaceId: string,
    socket: WebSocket,
    request: TargetApplyRequest,
    appliedAt: string,
  ): TargetApplyResponse["payload"] | null {
    const locklessSession = this.locklessSessions.get(socket);
    if (
      locklessSession &&
      locklessSession.surfaceId === surfaceId
    ) {
      const paneLineages = new Set(
        this.core
          .pairState(surfaceId)
          .panes.map((pane) => pane.paneLineageId),
      );
      if (paneLineages.has(request.payload.paneLineageId)) {
        return null;
      }
      return (this.targetApplyFailureResponse(
        request,
        appliedAt,
        "pane_lineage_missing",
        "target.apply pane lineage is not present on this surface",
      ) as TargetApplyResponse).payload;
    }
    if (!locklessSession || locklessSession.surfaceId !== surfaceId) {
      return (this.targetApplyFailureResponse(
        request,
        appliedAt,
        "not_paired",
        "target.apply requires the target surface connection",
      ) as TargetApplyResponse).payload;
    }
    const paneLineages = new Set(this.core.pairState(surfaceId).panes.map((pane) => pane.paneLineageId));
    if (!paneLineages.has(request.payload.paneLineageId)) {
      return (this.targetApplyFailureResponse(
        request,
        appliedAt,
        "pane_lineage_missing",
        "target.apply pane lineage is not present on this surface",
      ) as TargetApplyResponse).payload;
    }
    return null;
  }

  private async handlePaneSplit(socket: WebSocket, request: PaneSplitRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const splitPayload = {
      count: request.payload.count,
      direction: request.payload.direction,
      newPaneIds: request.payload.newPaneIds.map(Number),
      newPaneLabels: request.payload.newPaneLabels.map(Number),
      paneId: Number(request.payload.paneId),
    };
    const payload = await this.runSurfaceMutation(surfaceId, async () => {
      const nativeHostedPaneIds = this.core.nativeHostedPaneIdsForPaneSplitGeometryUpdate(surfaceId, splitPayload);
      const rollbackSurface = this.core.captureSurfaceMutationRollback(surfaceId);
      const rollbackNativeGeometry = nativeHostedPaneIds.length > 0
        ? this.core.projectCurrentNativePaneGeometry(surfaceId, nativeHostedPaneIds)
        : null;
      try {
        const result = this.core.paneSplit(surfaceId, splitPayload);
        await this.waitForResolvedPaneGeometry(
          surfaceId,
          result.panes.map((pane) => Number(pane.paneId)),
          "pane.split",
        );
        const nativeGeometryUpdate = nativeHostedPaneIds.length > 0
          ? this.core.projectCurrentNativePaneGeometry(surfaceId, nativeHostedPaneIds)
          : null;
        await this.applyResolvedNativePaneGeometry(surfaceId, nativeGeometryUpdate, "pane.split", rollbackNativeGeometry);
        this.markUpdatedNativePaneGeometry(surfaceId, nativeGeometryUpdate);
        return result;
      } catch (error) {
        rollbackSurface();
        throw error;
      }
    });
    return {
      id: request.id,
      ok: true,
      op: "pane.split",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private handlePaneRename(socket: WebSocket, request: PaneRenameRequest): Response {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = this.core.paneRename(surfaceId, Number(request.payload.paneId), request.payload.name);
    return {
      id: request.id,
      ok: true,
      op: "pane.rename",
      payload: {
        name: payload.name,
        paneId: payload.paneId as PaneRenameRequest["payload"]["paneId"],
      },
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handlePaneClose(socket: WebSocket, request: PaneCloseRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = await this.runSurfaceMutation(surfaceId, async () => {
      const paneId = Number(request.payload.paneId);
      const nativeHostedPaneId = this.core.nativeHostedPaneIdForPaneClose(surfaceId, paneId);
      const retainedNativePaneIds = this.core.panesList(surfaceId).panes
        .filter((pane) => pane.externalNative && Number(pane.paneId) !== paneId)
        .map((pane) => Number(pane.paneId));
      const rollbackSurface = this.core.captureSurfaceMutationRollback(surfaceId);
      const rollbackNativeGeometry = retainedNativePaneIds.length > 0
        ? this.core.projectCurrentNativePaneGeometry(surfaceId, retainedNativePaneIds)
        : null;
      try {
        const result = this.core.paneClose(surfaceId, paneId);
        await this.waitForResolvedPaneGeometry(
          surfaceId,
          this.core.activePaneIds(surfaceId),
          "pane.close",
        );
        const nativeGeometryUpdate = retainedNativePaneIds.length > 0
          ? this.core.projectCurrentNativePaneGeometry(surfaceId, retainedNativePaneIds)
          : null;
        await this.applyResolvedNativePaneGeometry(surfaceId, nativeGeometryUpdate, "pane.close", rollbackNativeGeometry);
        const releaseFailure = await this.releaseNativePanesBeforeRendererContent(
          surfaceId,
          [nativeHostedPaneId],
          "pane.close",
        );
        if (releaseFailure) {
          await this.rollbackNativePaneGeometry(surfaceId, rollbackNativeGeometry, "pane.close", releaseFailure);
          throw new SurfaceCoreError("render_failed", releaseFailure);
        }
        this.markUpdatedNativePaneGeometry(surfaceId, nativeGeometryUpdate);
        return result;
      } catch (error) {
        rollbackSurface();
        throw error;
      }
    });
    return {
      id: request.id,
      ok: true,
      op: "pane.close",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handleContentSet(socket: WebSocket, request: ContentSetRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const contentBytes = Buffer.byteLength(JSON.stringify(request.payload.content), "utf8");
    if (contentBytes > DEFAULT_LIMITS.maxFrameBytes) {
      throw new SurfaceCoreError("content_too_large", "Content exceeded max frame size");
    }
    if (!request.payload.historyOwnerToken) {
      throw new SurfaceCoreError(
        "invalid_payload",
        "content.set requires historyOwnerToken",
      );
    }
    const payload = await this.runSurfaceMutation(surfaceId, async () => {
      const nativeHostedPaneId = this.core.nativeHostedPaneIdForContentSet(surfaceId, request.payload);
      const releaseFailure = await this.releaseNativePanesBeforeRendererContent(surfaceId, [nativeHostedPaneId], "content.set");
      if (releaseFailure) {
        throw new SurfaceCoreError("render_failed", releaseFailure);
      }
      this.core.nativeHostedPaneIdForContentSet(surfaceId, request.payload);
      return this.core.contentSet(surfaceId, request.payload);
    });
    return {
      id: request.id,
      ok: true,
      op: "content.set",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handleContentClear(socket: WebSocket, request: ContentClearRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = await this.runSurfaceMutation(surfaceId, async () => {
      const nativeHostedPaneId = this.core.nativeHostedPaneIdForContentClear(surfaceId, request.payload);
      const releaseFailure = await this.releaseNativePanesBeforeRendererContent(surfaceId, [nativeHostedPaneId], "content.clear");
      if (releaseFailure) {
        throw new SurfaceCoreError("render_failed", releaseFailure);
      }
      this.core.nativeHostedPaneIdForContentClear(surfaceId, request.payload);
      return this.core.contentClear(surfaceId, request.payload);
    });
    return {
      id: request.id,
      ok: true,
      op: "content.clear",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handleContentAppend(socket: WebSocket, request: ContentAppendRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = await this.runSurfaceMutation(surfaceId, () => this.core.contentAppend(surfaceId, request.payload));
    return {
      id: request.id,
      ok: true,
      op: "content.append",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handleContentPatch(socket: WebSocket, request: ContentPatchRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = await this.runSurfaceMutation(surfaceId, () => this.core.contentPatch(surfaceId, request.payload));
    return {
      id: request.id,
      ok: true,
      op: "content.patch",
      payload,
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handleAnnotationsRemove(socket: WebSocket, request: AnnotationsRemoveRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = await this.runSurfaceMutation(surfaceId, () => this.core.annotationsRemove(surfaceId, {
      contentId: request.payload.contentId,
      paneId: Number(request.payload.paneId),
      strokeIds: request.payload.strokeIds.map(String),
    }));
    return {
      id: request.id,
      ok: true,
      op: "annotations.remove",
      payload: {
        contentId: payload.contentId,
        notFoundStrokeIds: payload.notFoundStrokeIds,
        paneId: payload.paneId as AnnotationsRemoveRequest["payload"]["paneId"],
        remainingStrokeCount: payload.remainingStrokeCount,
        removedStrokeIds: payload.removedStrokeIds,
      },
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handleSnapshotGet(socket: WebSocket, request: SnapshotGetRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const snapshot = this.core.captureSnapshot(surfaceId, Number(request.payload.paneId));
    const image = request.payload.includeImage
      ? await this.capturePaneImage(surfaceId, Number(request.payload.paneId))
      : undefined;

    return {
      id: request.id,
      ok: true,
      op: "snapshot.get",
      payload: {
        ...snapshot,
        drawings: request.payload.includeDrawings
          ? this.core.getRendererWindowState(surfaceId).panes.find((pane) => pane.paneId === Number(request.payload.paneId))?.drawings
          : undefined,
        image: image ?? undefined,
        visibleText: request.payload.includeVisibleText === false ? undefined : snapshot.visibleText,
      },
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private handleHeartbeat(socket: WebSocket, request: HeartbeatPingRequest): Response {
    this.requirePairedSurfaceId(socket);
    return {
      id: request.id,
      ok: true,
      op: "heartbeat.ping",
      payload: { nonce: request.payload.nonce },
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private requirePairedSurfaceId(socket: WebSocket): string {
    const meta = this.socketMeta.get(socket);
    if (!meta?.pairedSurfaceId) {
      throw new SurfaceCoreError("not_paired", "Operation requires pair.request first");
    }
    return meta.pairedSurfaceId;
  }

  private requireLocklessSurface(surfaceId: string): void {
    this.core.getSurface(surfaceId);
    this.core.admitSurfaceToLockless(surfaceId);
  }

  private async admitSurfaceForDiscovery(
    controllerInstanceId: string,
    requestId: string,
    surfaceId: string,
  ): Promise<void> {
    // Discovery admission writes to the same global ledger as pair.request,
    // so it takes the same serialized durable prepare. Left outside the queue
    // it would race pairing and consume a sequence nobody committed.
    const attempt = await this.core.prepareSurfaceAdmissionAttempt(
      {
        controllerInstanceId,
        requestId,
        surfaceId,
      },
      async () => {
        await this.persistLocklessState();
      },
    );
    try {
      // Durable witness (B2): stamped "started" through the same serialized
      // boundary, immediately before the paired operation executes.
      await this.core.markSurfaceAdmissionAttemptStarted(
        attempt.attemptSequence,
        async () => {
          await this.persistLocklessState();
        },
      );
      this.core.advanceSurfaceAdmissionAttempt(
        attempt.attemptSequence,
        "surface_lookup",
      );
      this.core.getSurface(surfaceId);
      this.core.admitSurfaceToLockless(
        surfaceId,
        attempt.attemptSequence,
      );
      this.core.markLocklessAuthorityChanged(surfaceId);
      // Durable, not just in-memory: a success left pending on disk reloads
      // as an unresolved stale row and blocks the next incarnation.
      await this.core.finalizeSurfaceAdmissionAttempt(
        attempt.attemptSequence,
        { kind: "succeeded" },
        async () => {
          await this.persistLocklessState();
        },
      );
    } catch (error) {
      if ((error as { name?: string } | null)?.name ===
        "PersistentStateOutcomeUnknownError") {
        // Neither the witness nor a terminal outcome is proven durable.
        // Fail-stop is already set by whichever call threw; do not attempt a
        // second durable write on top of an unproven one.
        throw error;
      }
      const reasonCode = error instanceof LocklessAuthorityError ||
          error instanceof SurfaceCoreError
        ? error.code
        : "internal_error";
      const reason = error instanceof Error
        ? error.message
        : "Unknown surface admission failure";
      await this.core.finalizeSurfaceAdmissionAttempt(
        attempt.attemptSequence,
        { kind: "failed", reason, reasonCode },
        async () => {
          await this.persistLocklessState();
        },
      );
      throw error;
    }
  }

  private hasLocklessSession(surfaceId: string): boolean {
    return [...this.locklessSessions.values()].some(
      (session) => session.surfaceId === surfaceId,
    );
  }

  private async broadcastLockless(event: LocklessEvent): Promise<void> {
    const payload = event.payload as {
      scopeId?: string;
      surfaceId?: string;
    };
    for (const session of this.locklessSessions.values()) {
      if (
        payload.surfaceId &&
        session.surfaceId !== payload.surfaceId
      ) {
        continue;
      }
      if (
        payload.scopeId &&
        !this.locklessSessionMatchesScope(session, payload.scopeId)
      ) {
        continue;
      }
      await this.send(session.socket, JSON.stringify(event));
    }
  }

  private locklessSessionMatchesScope(
    session: LocklessTransportSession,
    scopeId: string,
  ): boolean {
    if (!session.surfaceId) return false;
    return (
      scopeId === `surface:${encodeURIComponent(session.surfaceId)}` ||
      scopeId.startsWith(
        `pane:${encodeURIComponent(session.surfaceId)}:`,
      )
    );
  }

  private async broadcastLocklessDelta(
    scopeId: string,
    records: Array<{
      bytes: number;
      payload: unknown;
      recordClass: import("../../protocol/src/lockless.js").ConsumableRecordClass;
      recordId: string;
      sequence: number;
    }>,
  ): Promise<void> {
    const state = this.core.locklessAuthority.exportState().scopes[scopeId];
    if (!state) return;
    const retainedSequences = [
      ...state.records.map((record) => record.sequence),
      ...Object.values(state.liveFrames).map(
        (record) => record.sequence,
      ),
    ];
    await this.broadcastLockless({
      eventId: makeEventId(),
      op: "event.lockless_consumable_delta",
      payload: {
        firstRetainedSequence:
          retainedSequences.length > 0
            ? Math.min(...retainedSequences)
            : state.nextSequence,
        lastRetainedSequence: state.nextSequence - 1,
        records,
        scopeId,
      },
      sentAt: Date.now(),
      type: "event",
      v: 1,
    });
  }

  private async sendLocklessAuthorityEvent(
    event: AuthorityEvent,
  ): Promise<void> {
    if (event.type === "diagnostic.lockless_audit") {
      persistentServerDiagnostic("info", "lockless_authority_audit", {
        commit_sequence: event.record.commitSequence,
        controller_instance_id:
          event.record.controllerInstanceId ?? undefined,
        error_code: event.record.errorCode ?? undefined,
        operation: event.record.operation,
        request_id: event.record.requestId,
        result_correlation: event.record.resultCorrelation
          ? JSON.stringify(event.record.resultCorrelation)
          : undefined,
        result: event.record.result,
        surface_id: event.record.surfaceId ?? undefined,
      });
      return;
    }
    if (
      event.type === "event.consumable_available" ||
      event.type === "event.consumable_overflow"
    ) {
      const session = [...this.locklessSessions.values()].find(
        (candidate) =>
          candidate.controllerInstanceId === event.controllerInstanceId &&
          this.locklessSessionMatchesScope(candidate, event.scopeId),
      );
      if (!session) return;
      const snapshot = this.core.locklessAuthority.scopeSnapshot(
        event.controllerInstanceId,
        event.scopeId,
      );
      const payload =
        event.type === "event.consumable_overflow"
          ? {
              firstRetainedSequence: snapshot.firstRetainedSequence,
              gap: event.gap,
              lastRetainedSequence: snapshot.lastRetainedSequence,
              scopeId: event.scopeId,
            }
          : { scopeId: event.scopeId };
      await this.send(
        session.socket,
        JSON.stringify({
          eventId: makeEventId(),
          op: event.type,
          payload,
          sentAt: Date.now(),
          type: "event",
          v: 1,
        }),
      );
      return;
    }
    if (event.type === "event.target_apply_result") {
      const projected: LocklessEvent = {
        eventId: makeEventId(),
        op: "event.target_apply_result",
        payload: {
          ...event.result,
          consumableSequence: event.record.sequence,
          recordId: event.record.recordId,
        },
        sentAt: Date.now(),
        type: "event",
        v: 1,
      };
      await this.broadcastLockless(projected);
      if (event.retained) {
        await this.broadcastLocklessDelta(event.scopeId, [event.record]);
      }
      return;
    }
    if (event.type === "event.controller_retention_reclaimed") {
      persistentServerDiagnostic(
        "info",
        "lockless_controller_retention_reclaimed",
        {
          controller_instance_id: event.controllerInstanceId,
          cursor_bytes: event.cursorBytes,
          cursor_count: event.cursorCount,
          disconnected_at: event.disconnectedAt ?? undefined,
          dormant_sequence: event.dormantSequence,
          max_dormant_controller_bytes:
            event.maxDormantControllerBytes,
          max_dormant_controller_entries:
            event.maxDormantControllerEntries,
          scope_count: event.scopeCount,
          trigger: event.trigger,
          unread_bytes: event.unreadBytes,
          unread_record_count: event.unreadRecordCount,
        },
      );
    } else if (event.type === "event.tombstone_reclaimed") {
      persistentServerDiagnostic(
        "info",
        "lockless_tombstone_reclaimed",
        {
          bytes: event.bytes,
          closed_sequence: event.closedSequence,
          kind: event.kind,
          max_retained_tombstone_bytes:
            event.maxRetainedTombstoneBytes,
          max_retained_tombstones: event.maxRetainedTombstones,
          reason: event.reason,
          surface_id: event.surfaceId,
          tombstone_id: event.tombstoneId,
        },
      );
    }
    await this.sendLocklessControlEvent(event);
  }

  private async sendLocklessControlEvent(
    event: AuthorityEvent,
  ): Promise<void> {
    for (const session of this.locklessSessions.values()) {
      await this.send(
        session.socket,
        JSON.stringify({
          eventId: makeEventId(),
          op: event.type,
          payload: event,
          sentAt: Date.now(),
          type: "event",
          v: 1,
        }),
      );
    }
  }

  private async locklessCapabilities() {
    const capabilities = this.core.capabilities();
    const runtimeAppBinding = await this.currentRuntimeAppBinding();
    return {
      ...capabilities,
      limits: this.core.locklessAuthority.limits,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
      ...(runtimeAppBinding ? { runtimeAppBinding } : {}),
      surfaceLifecycle: true,
      targetCapabilities: this.compositorSocketPath
        ? [...capabilities.targetCapabilities, "target.native_app.v1"]
        : capabilities.targetCapabilities,
    };
  }

  private async currentRuntimeAppBinding(): Promise<RuntimeAppBindingDiagnostics | null> {
    return await this.getRuntimeAppBinding?.() ?? null;
  }

  private handleSocketClosed(socket: WebSocket): void {
    const locklessSession = this.locklessSessions.get(socket);
    if (locklessSession) {
      this.locklessSessions.delete(socket);
      void this.core.locklessAuthority.transactionAsync(async () => {
        this.core.locklessAuthority.disconnect(
          locklessSession.controllerInstanceId,
          locklessSession.connectionToken,
          locklessSession.connectionSlot,
        );
        this.core.markLocklessAuthorityChanged(
          locklessSession.surfaceId ?? undefined,
        );
        await this.persistLocklessState();
      }).catch(() => {});
      if (
        locklessSession.surfaceId &&
        this.core.listSurfaces().some(
          (surface) => surface.surfaceId === locklessSession.surfaceId,
        )
      ) {
        this.core.setConnectionBar(
          locklessSession.surfaceId,
          [...this.locklessSessions.values()].some(
            (session) => session.surfaceId === locklessSession.surfaceId,
          )
            ? "connected"
            : "disconnected",
        );
      }
      return;
    }
  }

  private async maybeSendAnnotationCommitted(surfaceId: string, paneId: number): Promise<void> {
    await this.updateLocklessAnnotationFrame(surfaceId, paneId);
    const snapshot = this.tryCaptureSnapshot(surfaceId, paneId);
    if (!snapshot?.contentId) return;
    const scopeId = locklessPaneScopeId(surfaceId, paneId);
    const record = await this.core.locklessAuthority.transactionAsync(async () => {
      const finalized = this.core.locklessAuthority.finalizeLiveFrame(
        scopeId,
        `annotation:${snapshot.contentId}`,
        "renderer.annotation_finalized",
      );
      if (this.core.hasPendingDrawingFlush(surfaceId, paneId)) {
        this.core.markDrawingFlushSent(surfaceId, paneId);
      }
      this.core.markAnnotationCommittedSent(surfaceId, paneId);
      this.core.markLocklessAuthorityChanged(surfaceId);
      await this.persistLocklessState();
      return finalized;
    });
    if (record) {
      await this.broadcastLocklessDelta(scopeId, [record]);
    }
  }

  private async broadcastLifecycleEvent(event: Event): Promise<void> {
    const activeSockets = new Set<WebSocket>();
    const affectedSurfaceId = (
      event.payload as { surfaceId?: string }
    ).surfaceId;
    for (const session of this.locklessSessions.values()) {
      if (
        !affectedSurfaceId ||
        session.surfaceId === null ||
        session.surfaceId === affectedSurfaceId
      ) {
        activeSockets.add(session.socket);
      }
    }
    for (const socket of activeSockets) {
      await this.sendEvent(socket, event);
    }
  }

  private async reply(socket: WebSocket, response: Response): Promise<boolean> {
    return await this.send(socket, JSON.stringify(response));
  }

  private async sendEvent(socket: WebSocket, event: Event): Promise<boolean> {
    return await this.send(socket, JSON.stringify(event));
  }

  private async send(socket: WebSocket, payload: string): Promise<boolean> {
    if (socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    return await new Promise<boolean>((resolve, reject) => {
      socket.send(payload, (error) => {
        if (error) {
          if (socket.readyState !== WebSocket.OPEN || isSocketClosedError(error)) {
            resolve(false);
            return;
          }
          reject(error);
          return;
        }
        resolve(true);
      });
    });
  }

  private tryCaptureSnapshot(surfaceId: string, paneId: number): SnapshotResponse["payload"] | null {
    try {
      return this.core.captureSnapshot(surfaceId, paneId);
    } catch (error) {
      if (error instanceof SurfaceCoreError && error.code === "invalid_payload") {
        return null;
      }
      throw error;
    }
  }

  private async maybeSendHistoryNavigated(event: Extract<CoreEvent, { type: "history-navigated" }>): Promise<void> {
    const payload: HistoryNavigatedEvent["payload"] = {
      contentId: event.contentId as HistoryNavigatedEvent["payload"]["contentId"],
      direction: event.direction,
      paneId: event.paneId as HistoryNavigatedEvent["payload"]["paneId"],
      revision: event.revision as HistoryNavigatedEvent["payload"]["revision"],
    };
    await this.ingestLocklessPaneConsumable(
      event.surfaceId,
      event.paneId,
      "history",
      payload,
      "client.history",
    );
  }
}

export const __test = {
  browserUrlDiagnosticFields,
  serverDiagnostic,
};

function locklessTopologyPaneIds(
  node: TopologyApplyRequest["payload"]["layout"],
): number[] {
  if (node.type === "pane") return [Number(node.paneId)];
  return node.children.flatMap(locklessTopologyPaneIds);
}

function locklessOperationMutates(op: LocklessRequest["op"]): boolean {
  return !new Set<LocklessRequest["op"]>([
    "heartbeat.ping",
    "pair.request",
    "panes.list",
    "snapshot.get",
    "surfaces.list",
    "consumable.ack",
    "consumable.sync",
    "operation.receipt.ack",
    "operation.receipt.sync",
  ]).has(op);
}

function locklessAuditErrorCode(
  code: SurfaceCoreError["code"],
): LocklessErrorCode {
  switch (code) {
    case "stale_content":
    case "not_paired":
    case "invalid_payload":
    case "invalid_operation":
      return code;
    default:
      return code === "internal_error"
        ? "internal_error"
        : "unsupported_operation";
  }
}

function locklessResultCorrelation(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const source = payload as Record<string, unknown>;
  const keys = [
    "contentId",
    "historyEntryId",
    "paneId",
    "revision",
    "surfaceId",
    "surfaceSetRevision",
    "targetEpoch",
    "targetId",
    "tombstoneId",
    "topologyRevision",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

function errorResponse(
  op: Request["op"],
  id: string,
  code: SurfaceCoreError["code"] | "invalid_request_id_reuse",
  message: string,
  details?: Record<string, unknown>,
): Response {
  return {
    error: details ? { code, details, message } : { code, message },
    id: id as Request["id"],
    ok: false,
    op,
    sentAt: Date.now(),
    type: "response",
    v: 1,
  };
}

function isSocketClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("WebSocket is not open");
}

function trimCache(cache: Map<string, SocketCacheEntry>): void {
  while (cache.size > 1024) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) {
      return;
    }
    cache.delete(firstKey);
  }
}

function browserUrlApplyKey(surfaceId: string, paneId: number): string {
  return `${surfaceId}::${paneId}`;
}

function isNativeHostTargetKind(targetKind: TargetApplyRequest["payload"]["targetKind"]): boolean {
  return targetKind === "terminal_app" || targetKind === "native_app" || targetKind === "compositor_app";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeHostMaterializedState(
  payload: TargetApplyRequest["payload"],
  materialization: NativePaneMaterialization,
  state: {
    diagnostics?: string[];
    inputFocus?: "ready" | "not_ready" | "unknown";
    lifecycle?: "launch_requested" | "running" | "exited" | "unknown";
    nativeHost: "applied" | "not_applied" | "released_after_failure";
    overlayRegions: "applied" | "not_applied" | "not_requested";
    proof?: NativeHostMaterializedState["proof"];
  },
): TargetMaterializedState {
  const pane = materialization.panes[0];
  const targetPayload = isPlainRecord(payload.targetPayload) ? payload.targetPayload : {};
  const args = Array.isArray(targetPayload.args) && targetPayload.args.every((arg) => typeof arg === "string")
    ? [...targetPayload.args]
    : undefined;
  const env = isPlainRecord(targetPayload.env)
    ? Object.keys(targetPayload.env).filter((key) => typeof targetPayload.env[key] === "string").sort()
    : undefined;
  const envDigest = isPlainRecord(targetPayload.env) ? stableStringRecordDigest(targetPayload.env) : undefined;
  const appId = typeof targetPayload.appId === "string" ? targetPayload.appId : undefined;
  const command = typeof targetPayload.command === "string" ? targetPayload.command : undefined;
  const cwd = typeof targetPayload.cwd === "string" ? targetPayload.cwd : undefined;
  const launchMode = typeof targetPayload.launchMode === "string" ? targetPayload.launchMode : undefined;
  return {
    authority: {
      paneLineageId: payload.paneLineageId,
      surfaceId: payload.surfaceId,
      targetEpoch: payload.targetEpoch,
    },
    ...(state.diagnostics && state.diagnostics.length > 0 ? { diagnostics: state.diagnostics } : {}),
    inputFocus: state.inputFocus ?? "unknown",
    lifecycle: state.lifecycle ?? (state.nativeHost === "applied" ? "launch_requested" : "unknown"),
    nativeHost: state.nativeHost,
    nativeTarget: {
      ...(appId ? { appId } : {}),
      ...(args ? { args } : {}),
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(envDigest ? { envDigest } : {}),
      ...(env && env.length > 0 ? { envKeys: env } : {}),
      ...(launchMode ? { launchMode } : {}),
      targetKind: payload.targetKind,
    },
    overlayRegions: state.overlayRegions,
    ...(pane
      ? {
        paneGeometry: { ...pane.geometry },
      }
      : {}),
    ...(state.proof ? { proof: state.proof } : {}),
  };
}

function nativePaneReadinessFromCompositor(
  response: CompositorControlResponse,
  materialization: NativePaneMaterialization,
): {
  diagnostics?: string[];
  inputFocus?: "ready" | "not_ready" | "unknown";
  lifecycle?: "launch_requested" | "running" | "exited" | "unknown";
  proof?: NativeHostMaterializedState["proof"];
} {
  const status = response.status;
  if (!isPlainRecord(status)) {
    return {};
  }
  const pane = materialization.panes[0];
  const panes = Array.isArray(status.panes) ? status.panes : [];
  const paneStatus = panes.find((candidate) => {
    if (!isPlainRecord(candidate) || !pane) {
      return false;
    }
    return String(candidate.id ?? "") === String(pane.id) ||
      (pane.binding_id ? String(candidate.binding_id ?? "") === String(pane.binding_id) : false);
  });
  const source = isPlainRecord(paneStatus) ? paneStatus : status;
  const nativeHostStatus = isPlainRecord(paneStatus) && isPlainRecord(paneStatus.nativeHost)
    ? paneStatus.nativeHost
    : null;
  const paneStatusId = isPlainRecord(paneStatus) && (typeof paneStatus.id === "string" || typeof paneStatus.id === "number")
    ? String(paneStatus.id)
    : null;
  const paneStatusBindingId = isPlainRecord(paneStatus)
    ? stringProperty(paneStatus, "binding_id") ?? stringProperty(paneStatus, "bindingId") ??
      stringProperty(nativeHostStatus, "binding_id") ?? stringProperty(nativeHostStatus, "bindingId")
    : null;
  const paneStatusContentId = isPlainRecord(paneStatus)
    ? stringProperty(paneStatus, "content_id") ?? stringProperty(paneStatus, "contentId") ??
      stringProperty(nativeHostStatus, "content_id") ?? stringProperty(nativeHostStatus, "contentId")
    : null;
  const nativeAppStatus = isPlainRecord(paneStatus) && isPlainRecord(paneStatus.nativeApp)
    ? paneStatus.nativeApp
    : isPlainRecord(nativeHostStatus) && isPlainRecord(nativeHostStatus.nativeApp)
    ? nativeHostStatus.nativeApp
    : null;
  const processStatus = isPlainRecord(paneStatus) && isPlainRecord(paneStatus.process)
    ? paneStatus.process
    : isPlainRecord(nativeHostStatus) && isPlainRecord(nativeHostStatus.process)
    ? nativeHostStatus.process
    : null;
  const proof = paneProofFromCompositorStatus({
    nativeAppStatus,
    pane,
    paneStatus: isPlainRecord(paneStatus) ? paneStatus : null,
    paneStatusBindingId,
    paneStatusContentId,
    paneStatusId,
    processStatus,
  });
  const diagnostics = nativePaneDiagnosticsFromCompositorStatus(status, isPlainRecord(paneStatus) ? paneStatus : null);
  return {
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(!nativePaneWindowGroupsFromCompositorStatus(response).some((group) =>
      nativePaneWindowGroupMatchesMaterialization(group, materialization)
    ) ? { diagnostics: [...diagnostics, "matching native pane window group was not observed"] } : {}),
    inputFocus: normalizeNativeInputFocus(source.inputFocus ?? source.input_focus),
    lifecycle: normalizeNativeLifecycle(source.lifecycle) ??
      normalizeNativeLifecycle(
        isPlainRecord(nativeHostStatus?.lifecycle)
          ? nativeHostStatus.lifecycle.state
          : undefined,
      ),
    ...(proof ? { proof } : {}),
  };
}

function nativePaneWindowGroupMatchesMaterialization(
  group: NativePaneWindowGroupStatus,
  materialization: NativePaneMaterialization,
): boolean {
  const pane = materialization.panes[0];
  if (!pane) {
    return false;
  }
  if (pane.windowGroup?.launchIdentity.launchToken) {
    return group.launchToken === pane.windowGroup.launchIdentity.launchToken;
  }
  if (group.paneInstanceId && group.paneInstanceId === pane.geometry.paneInstanceId) {
    return true;
  }
  return group.paneId === String(pane.id) && (
    group.primaryWindowId === pane.binding_id ||
    group.primaryWindowId === pane.content_id
  );
}

function nativePaneDiagnosticsFromCompositorStatus(
  status: Record<string, unknown>,
  paneStatus: Record<string, unknown> | null,
): string[] {
  const diagnostics = new Set<string>();
  appendDiagnosticValues(diagnostics, status.diagnostics);
  appendDiagnosticValues(diagnostics, status.diagnostic);
  appendDiagnosticValues(diagnostics, status.reason);
  appendDiagnosticValues(diagnostics, status.message);
  if (paneStatus) {
    appendDiagnosticValues(diagnostics, paneStatus.diagnostics);
    appendDiagnosticValues(diagnostics, paneStatus.diagnostic);
    appendDiagnosticValues(diagnostics, paneStatus.reason);
    appendDiagnosticValues(diagnostics, paneStatus.message);
    if (isPlainRecord(paneStatus.nativeApp)) {
      appendDiagnosticValues(diagnostics, paneStatus.nativeApp.diagnostics);
      appendDiagnosticValues(diagnostics, paneStatus.nativeApp.diagnostic);
      appendDiagnosticValues(diagnostics, paneStatus.nativeApp.reason);
      appendDiagnosticValues(diagnostics, paneStatus.nativeApp.message);
    }
    if (isPlainRecord(paneStatus.process)) {
      appendDiagnosticValues(diagnostics, paneStatus.process.diagnostics);
      appendDiagnosticValues(diagnostics, paneStatus.process.diagnostic);
      appendDiagnosticValues(diagnostics, paneStatus.process.reason);
      appendDiagnosticValues(diagnostics, paneStatus.process.message);
    }
  }
  return [...diagnostics];
}

function appendDiagnosticValues(target: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    target.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      appendDiagnosticValues(target, entry);
    }
  }
}

function paneProofFromCompositorStatus(input: {
  nativeAppStatus: Record<string, unknown> | null;
  pane: NativePaneMaterialization["panes"][number] | undefined;
  paneStatus: Record<string, unknown> | null;
  paneStatusBindingId: string | null;
  paneStatusContentId: string | null;
  paneStatusId: string | null;
  processStatus: Record<string, unknown> | null;
}): NativeHostMaterializedState["proof"] | undefined {
  const {
    nativeAppStatus,
    pane,
    paneStatus,
    paneStatusBindingId,
    paneStatusContentId,
    paneStatusId,
    processStatus,
  } = input;
  if (
    !pane ||
    !paneStatus ||
    paneStatusId !== String(pane.id) ||
    !((pane.binding_id && paneStatusBindingId === pane.binding_id) ||
      (pane.content_id && paneStatusContentId === pane.content_id))
  ) {
    return undefined;
  }

  if (pane.nativeApp) {
    const appId = stringProperty(nativeAppStatus, "appId") ?? stringProperty(nativeAppStatus, "app_id") ??
      stringProperty(paneStatus, "appId") ?? stringProperty(paneStatus, "app_id") ??
      pane.nativeApp.appId;
    const args = stringArrayProperty(nativeAppStatus, "args") ?? stringArrayProperty(processStatus, "args") ??
      stringArrayProperty(paneStatus, "args") ??
      pane.nativeApp.args;
    const launchMode = stringProperty(nativeAppStatus, "launchMode") ?? stringProperty(nativeAppStatus, "launch_mode") ??
      stringProperty(paneStatus, "launchMode") ?? stringProperty(paneStatus, "launch_mode") ??
      pane.nativeApp.launchMode;
    const cwd = stringProperty(processStatus, "cwd") ?? stringProperty(paneStatus, "cwd");
    const expectedCwd = pane.process?.cwd;
    const envDigest = stringProperty(processStatus, "envDigest") ?? stringProperty(processStatus, "env_digest") ??
      stringProperty(paneStatus, "envDigest") ?? stringProperty(paneStatus, "env_digest") ??
      stableStringRecordDigest(pane.process?.env ?? {});
    const expectedEnvDigest = stableStringRecordDigest(pane.process?.env ?? {});

    if (
      appId !== pane.nativeApp.appId ||
      !stringArraysEqual(args, pane.nativeApp.args) ||
      launchMode !== pane.nativeApp.launchMode ||
      (cwd ?? "") !== (expectedCwd ?? "") ||
      envDigest !== expectedEnvDigest
    ) {
      return undefined;
    }

    return {
      appId,
      args,
      ...(paneStatusBindingId ? { bindingId: paneStatusBindingId } : {}),
      ...(paneStatusContentId ? { contentId: paneStatusContentId } : {}),
      ...(cwd ? { cwd } : {}),
      envDigest,
      launchMode,
      paneId: paneStatusId,
    };
  }

  return {
    ...(paneStatusBindingId ? { bindingId: paneStatusBindingId } : {}),
    ...(paneStatusContentId ? { contentId: paneStatusContentId } : {}),
    paneId: paneStatusId,
  };
}

function normalizeNativeInputFocus(value: unknown): "ready" | "not_ready" | "unknown" | undefined {
  if (value === "ready" || value === "not_ready" || value === "unknown") {
    return value;
  }
  return undefined;
}

function normalizeNativeLifecycle(value: unknown): "launch_requested" | "running" | "exited" | "unknown" | undefined {
  if (value === "launch_requested" || value === "running" || value === "exited" || value === "unknown") {
    return value;
  }
  return undefined;
}

function stringProperty(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayProperty(record: Record<string, unknown> | null, key: string): string[] | undefined {
  const value = record?.[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : undefined;
}

function stringArraysEqual(left: string[] | undefined, right: string[]): boolean {
  return Boolean(left) && left!.length === right.length && left!.every((entry, index) => entry === right[index]);
}

function stableStringRecordDigest(value: Record<string, unknown>): string {
  const stableValue = Object.fromEntries(Object.keys(value)
    .filter((key) => typeof value[key] === "string")
    .sort()
    .map((key) => [key, value[key]]));
  return createHash("sha256").update(JSON.stringify(stableValue)).digest("hex");
}

function publicTargetApplyMessage(
  errorCode: TargetApplyResponse["payload"]["errorCode"],
  fallback = "Target apply failed",
): string {
  if (errorCode === "materialization_failed") {
    return "Target materialization failed";
  }
  return fallback;
}

function browserUrlApplyResult(
  payload: TargetApplyRequest["payload"],
  status: TargetApplyResponse["payload"]["status"],
  errorCode: TargetApplyResponse["payload"]["errorCode"] | undefined,
  message: string,
  materializedState: TargetMaterializedState,
): TargetApplyResponse["payload"] {
  return {
    appliedAt: new Date().toISOString(),
    errorCode,
    materializedState,
    message,
    paneLineageId: payload.paneLineageId,
    requestId: payload.requestId,
    status,
    targetEpoch: payload.targetEpoch,
    targetId: payload.targetId,
  };
}

function makeEventId(): Event["eventId"] {
  return `ev_${randomUUID().replaceAll("-", "")}` as Event["eventId"];
}

function contentBitmask(contentTypes: string[]): number {
  const bits: Record<string, number> = {
    canvas: 1 << 6,
    html: 1 << 0,
    image: 1 << 1,
    markdown: 1 << 4,
    pdf: 1 << 2,
    terminal: 1 << 3,
    video: 1 << 5,
  };
  return contentTypes.reduce((mask, type) => mask | (bits[type] ?? 0), 0);
}
