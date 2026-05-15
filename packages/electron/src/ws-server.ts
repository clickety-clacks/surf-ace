import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WebSocket, WebSocketServer } from "ws";

import type {
  AnnotationsRemoveRequest,
  AuthorityStateRequest,
  ContentApplyRequest,
  ContentAppendRequest,
  ContentClearRequest,
  ContentPatchRequest,
  ContentSetRequest,
  DrawingFlushConfig,
  Event,
  EventProfile,
  HeartbeatPingRequest,
  HistoryNavigatedEvent,
  RelinquishRequest,
  PaneCloseRequest,
  PaneRenameRequest,
  PaneSplitRequest,
  PairRequest,
  PanesListRequest,
  Request,
  Response,
  Selection,
  SnapshotGetRequest,
  SnapshotHintEvent,
  SurfaceViewport,
  SurfacesListRequest,
  TargetApplyRequest,
  TargetApplyResponse,
  TargetMaterializedState,
  TopologyApplyRequest,
  Viewport,
} from "../../protocol/src/index.js";
import {
  compositorFailureMessage,
  isOverlayNativePaneLivenessFailure,
  type NativePaneMaterialization,
  nativePaneReleaseRequestForCompositor,
  overlayRequestForCompositor,
  overlayTopologyEpochFromCompositorResponse,
  requestForCompositor,
  resolveCompositorControlSocketPath,
  sendCompositorControl,
  validateMaterializationAgainstCompositorStatus,
  type CompositorControlRequest,
  type CompositorControlResponse,
} from "./native-pane-bridge.js";
import { isValidWindowLabel, SurfaceCore, SurfaceCoreError, type CoreEvent } from "./surface-core.js";

type SocketCacheEntry = {
  payloadHash: string;
  response: Response;
};

type ActiveSession = {
  connectionId: string;
  drawingFlushConfig: DrawingFlushConfig;
  eventProfile: EventProfile;
  ownershipEpoch: number;
  paneFlushTimers: Map<number, PaneFlushTimers>;
  pairConfirmed: boolean;
  providerId: string;
  providerName: string;
  requestCache: Map<string, SocketCacheEntry>;
  sessionId: string;
  socket: WebSocket;
};

type OwnershipLock = {
  drawingFlushConfig: DrawingFlushConfig;
  eventProfile: EventProfile;
  ownershipEpoch: number;
  providerId: string;
  sessionId: string;
};

type PairPostResponseCommit = {
  providerName: string;
  session: ActiveSession;
  supersededSession: ActiveSession | null;
  surfaceId: string;
};

type PaneFlushTimers = {
  commitAfterFlush: boolean;
  idleTimer: NodeJS.Timeout | null;
  maxTimer: NodeJS.Timeout | null;
};

type SurfaceTransportState = {
  active: ActiveSession | null;
  lock: OwnershipLock | null;
};

type PendingBrowserUrlApply = {
  appliedAt: string;
  request: TargetApplyRequest;
  resolve: (payload: TargetApplyResponse["payload"]) => void;
  socket: WebSocket;
  timeout: NodeJS.Timeout;
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
  onBusyChanged?: () => void;
  onNativeMaterialized?: (surfaceId: string, materialization: NativePaneMaterialization) => void;
  onNativeReleased?: (surfaceId: string, paneIds: string[]) => Promise<void> | void;
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
const NATIVE_OVERLAY_LIVENESS_RETRY_COUNT = 10;
const NATIVE_OVERLAY_LIVENESS_RETRY_DELAY_MS = 100;
const WS_DIAGNOSTIC_LOG_PATH = process.env.SURF_ACE_WS_DIAGNOSTIC_LOG ?? path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "@surf-ace",
  "electron",
  "ws-diagnostics.log",
);

type ServerDiagnosticFields = Record<string, boolean | number | string | null | undefined>;

function formatServerDiagnosticValue(value: string | number | boolean): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:@%-]+$/.test(text) ? text : JSON.stringify(text);
}

function serverDiagnostic(event: string, fields: ServerDiagnosticFields = {}): string {
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatServerDiagnosticValue(value)}`)
    .join(" ");
  return suffix.length > 0
    ? `[surf-ace:server] event=${event} ${suffix}`
    : `[surf-ace:server] event=${event}`;
}

function diagnosticJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function errorDiagnosticFields(error: unknown): ServerDiagnosticFields {
  if (error instanceof Error) {
    return {
      error_message: error.message,
      error_name: error.name,
    };
  }
  return { error_message: String(error) };
}

function appendServerDiagnostic(line: string): void {
  try {
    fs.mkdirSync(path.dirname(WS_DIAGNOSTIC_LOG_PATH), { recursive: true });
    fs.appendFileSync(WS_DIAGNOSTIC_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Diagnostics must never change WebSocket behavior.
  }
}

function persistentServerDiagnostic(
  level: "info" | "warn" | "error",
  event: string,
  fields: ServerDiagnosticFields = {},
): void {
  const line = serverDiagnostic(event, fields);
  appendServerDiagnostic(line);
  console[level](line);
}

export class SurfaceWsServer {
  private readonly bindAddress: string;
  private readonly compositorSocketPath: string | null;
  private readonly core: SurfaceCore;
  private readonly endpointName: string;
  private readonly hostName: string;
  private readonly getOverlayDiagnostics?: (surfaceId: string) => Record<string, unknown> | null;
  private readonly onBusyChanged?: () => void;
  private readonly onNativeMaterialized?: (surfaceId: string, materialization: NativePaneMaterialization) => void;
  private readonly onNativeReleased?: (surfaceId: string, paneIds: string[]) => Promise<void> | void;
  private readonly port: number;
  private readonly protocolVersion: number;
  private readonly capturePaneImage: SurfaceWsServerOptions["capturePaneImage"];
  private readonly viewportProvider: SurfaceWsServerOptions["viewport"];
  private readonly pendingBrowserUrlApplies = new Map<string, PendingBrowserUrlApply>();
  readonly wsPath: string;

  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly socketMeta = new WeakMap<WebSocket, SocketMeta>();
  private readonly pendingPairCommits = new WeakMap<Response, PairPostResponseCommit>();
  private readonly transports = new Map<string, SurfaceTransportState>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private providerWindowLabelQueue: Promise<void> = Promise.resolve();
  private ignoreInitialSurfaceEvents = true;

  constructor(options: SurfaceWsServerOptions) {
    this.bindAddress = options.bindAddress ?? "0.0.0.0";
    this.capturePaneImage = options.capturePaneImage;
    this.compositorSocketPath = options.compositorSocketPath === undefined
      ? resolveCompositorControlSocketPath()
      : options.compositorSocketPath;
    this.core = options.core;
    this.endpointName = options.endpointName;
    this.getOverlayDiagnostics = options.getOverlayDiagnostics;
    this.hostName = options.hostName;
    this.onBusyChanged = options.onBusyChanged;
    this.onNativeMaterialized = options.onNativeMaterialized;
    this.onNativeReleased = options.onNativeReleased;
    this.port = options.port;
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
      if (request.url !== this.wsPath) {
        console.warn(
          serverDiagnostic("socket_reject", {
            path: request.url ?? "<none>",
            reason: "bad_path",
          }),
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
      this.socketMeta.set(socket, { cache: new Map(), pairedSurfaceId: null, remoteAddress, socketId });
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
  }

  async start(): Promise<void> {
    console.info(
      serverDiagnostic("bind_start", {
        host: this.bindAddress,
        port: this.port,
        ws_path: this.wsPath,
      }),
    );
    await new Promise<void>((resolve, reject) => {
      this.httpServer.listen(this.port, this.bindAddress, () => resolve());
      this.httpServer.once("error", reject);
    });
    this.ignoreInitialSurfaceEvents = false;
    console.info(
      serverDiagnostic("bind_ok", {
        endpoint_name: this.endpointName,
        host: this.bindAddress,
        host_name: this.hostName,
        port: this.port,
        ws_path: this.wsPath,
      }),
    );
  }

  async stop(): Promise<void> {
    console.info(
      serverDiagnostic("stop_begin", {
        active_sessions: [...this.transports.values()].filter((transport) => Boolean(transport.active)).length,
      }),
    );
    for (const transport of this.transports.values()) {
      clearTransport(transport);
      if (transport.active) {
        transport.active.socket.close(1000, "provider_shutdown");
      }
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
    console.info(serverDiagnostic("stop_ok"));
  }

  advertisedTxt(fingerprintPrefix: string): Record<string, string> {
    const viewport = this.viewportProvider();
    return {
      busy: this.isEndpointBusy() ? "1" : "0",
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
    const session = this.activeSession(surfaceId);
    if (!session || !isEventEnabled(session.eventProfile, "event.tap")) {
      return;
    }
    const state = this.tryCaptureSnapshot(surfaceId, paneId);
    if (!state) {
      return;
    }
    if (!state.contentId) {
      return;
    }
    await this.sendEvent(session.socket, {
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
    });
  }

  async emitSelection(
    surfaceId: string,
    paneId: number,
    selection: Selection,
  ): Promise<void> {
    const session = this.activeSession(surfaceId);
    if (!session || !isEventEnabled(session.eventProfile, "event.selection")) {
      return;
    }
    const state = this.tryCaptureSnapshot(surfaceId, paneId);
    if (!state) {
      return;
    }
    if (!state.contentId) {
      return;
    }
    await this.sendEvent(session.socket, {
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
    });
  }

  async emitScroll(
    surfaceId: string,
    paneId: number,
    viewport: Viewport,
    visibleText: string,
  ): Promise<void> {
    const session = this.activeSession(surfaceId);
    if (!session || !isEventEnabled(session.eventProfile, "event.scroll")) {
      return;
    }
    const state = this.tryCaptureSnapshot(surfaceId, paneId);
    if (!state) {
      return;
    }
    if (!state.contentId) {
      return;
    }
    await this.sendEvent(session.socket, {
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
    });
  }

  async emitNavigation(
    surfaceId: string,
    paneId: number,
    url: string,
    navigationState?: { contentId: string; revision: number },
  ): Promise<void> {
    const session = this.activeSession(surfaceId);
    if (!session || !isEventEnabled(session.eventProfile, "event.navigation")) {
      return;
    }
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
    await this.sendEvent(session.socket, {
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
    });
  }

  async emitPage(
    surfaceId: string,
    paneId: number,
    payload: { page: number; pageText?: string; totalPages: number },
  ): Promise<void> {
    const session = this.activeSession(surfaceId);
    if (!session || !isEventEnabled(session.eventProfile, "event.page")) {
      return;
    }
    const state = this.tryCaptureSnapshot(surfaceId, paneId);
    if (!state) {
      return;
    }
    if (!state.contentId) {
      return;
    }
    await this.sendEvent(session.socket, {
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
    });
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

  disconnectSurface(surfaceId: string, reason = "provider_shutdown"): void {
    const transport = this.transport(surfaceId);
    if (transport.active) {
      this.detachActiveSession(surfaceId, reason);
    }
    transport.lock = null;
    this.core.setConnectionBar(surfaceId, "disconnected");
    this.onBusyChanged?.();
  }

  private async handleCoreEvent(event: CoreEvent): Promise<void> {
    switch (event.type) {
      case "annotation-committed":
        await this.maybeSendAnnotationCommitted(event.surfaceId, event.paneId);
        return;
      case "drawing-dirty":
        this.schedulePaneFlush(event.surfaceId, event.paneId);
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
      case "surface-removed":
      case "surface-changed":
      case "pane-geometry-changed":
        return;
    }
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    const initialMeta = this.socketMeta.get(socket);
    let request: Request;
    try {
      request = JSON.parse(raw) as Request;
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

    const meta = this.socketMeta.get(socket);
    if (!meta) {
      return;
    }

    if (request.op === "pair.request") {
      persistentServerDiagnostic(
        "info",
        "pair_request_receive",
        {
          connection_id: request.payload.connectionId,
          provider_id: request.payload.providerId,
          raw_bytes: Buffer.byteLength(raw),
          request_id: request.id,
          resume_session_id: request.payload.resume?.sessionId ?? "nil",
          socket_id: meta.socketId,
          surface_id: request.payload.surfaceId,
          takeover: request.payload.takeover ?? false,
        },
      );
    }

    const cache = meta.pairedSurfaceId
      ? this.transport(meta.pairedSurfaceId).active?.requestCache ?? meta.cache
      : meta.cache;
    const payloadHash = JSON.stringify(request);
    const cached = cache.get(request.id);
    if (cached) {
      if (cached.payloadHash !== payloadHash) {
        console.warn(
          serverDiagnostic("request_reject", {
            op: request.op,
            reason: "request_id_reuse_mismatch",
            request_id: request.id,
          }),
        );
        await this.reply(socket, errorResponse(request.op, request.id, "invalid_request_id_reuse", "Request id was reused with different payload"));
        return;
      }
      await this.reply(socket, cached.response);
      return;
    }

    let response: Response;
    try {
      if (request.op === "pair.request") {
        persistentServerDiagnostic(
          "info",
          "pair_request_dispatch_enter",
          {
            request_id: request.id,
            socket_id: meta.socketId,
            surface_id: request.payload.surfaceId,
          },
        );
      }
      response = await this.dispatchRequest(socket, request);
      if (request.op === "pair.request") {
        persistentServerDiagnostic(
          "info",
          "pair_request_dispatch_exit",
          {
            request_id: request.id,
            socket_id: meta.socketId,
            surface_id: response.ok && response.op === "pair.request" ? response.payload.surfaceId : request.payload.surfaceId,
          },
        );
      }
    } catch (error) {
      if (request.op === "pair.request") {
        persistentServerDiagnostic(
          "warn",
          "pair_request_dispatch_throw",
          {
            provider_id: request.payload.providerId,
            request_id: request.id,
            resume_session_id: request.payload.resume?.sessionId ?? "nil",
            socket_id: meta.socketId,
            surface_id: request.payload.surfaceId,
            takeover: request.payload.takeover ?? false,
            ...errorDiagnosticFields(error),
          },
        );
      }
      if (error instanceof SurfaceCoreError) {
        console.warn(
          serverDiagnostic("request_error", {
            code: error.code,
            op: request.op,
          }),
        );
        response = errorResponse(
          request.op,
          request.id,
          error.code,
          error.message,
          error.details,
        );
      } else {
        console.warn(
          serverDiagnostic("request_error", {
            code: "internal_error",
            op: request.op,
          }),
        );
        response = errorResponse(request.op, request.id, "internal_error", "Unhandled surface error");
      }
    }

    cache.set(request.id, { payloadHash, response });
    trimCache(cache);
    const responseDelivered = await this.reply(socket, response);
    if (
      response.type === "response" &&
      response.ok &&
      response.op === "pair.request"
    ) {
      if (responseDelivered) {
        this.commitPairResponse(response);
      } else {
        this.pendingPairCommits.delete(response);
      }
    }
    if (request.op === "pair.request") {
      persistentServerDiagnostic(
        response.ok && responseDelivered ? "info" : "warn",
        "pair_response_sent",
        {
          delivered: responseDelivered,
          error_code: !response.ok ? response.error.code : undefined,
          ok: response.ok,
          request_id: request.id,
          resume_session_id: request.payload.resume?.sessionId ?? "nil",
          session_id: response.ok && response.op === "pair.request" ? response.payload.sessionId : undefined,
          socket_id: meta.socketId,
          surface_id: response.ok && response.op === "pair.request" ? response.payload.surfaceId : request.payload.surfaceId,
          takeover: request.payload.takeover ?? false,
        },
      );
    }
    if (
      response.type === "response" &&
      !response.ok &&
      response.op === "pair.request" &&
      response.error.code === "missing_provider_name"
    ) {
      socket.close(1008, "missing_provider_name");
      return;
    }
    if (
      response.type === "response" &&
      response.ok &&
      response.op === "pair.request"
    ) {
      this.armAllPendingFlushes(response.payload.surfaceId);
      this.armAllPendingAnnotationCommits(response.payload.surfaceId);
    }
    if (
      response.type === "response" &&
      response.ok &&
      response.op === "ownership.relinquish"
    ) {
      const surfaceId = meta.pairedSurfaceId;
      if (surfaceId) {
        this.detachActiveSession(surfaceId, "relinquished");
      }
      return;
    }
    if (
      response.type === "response" &&
      response.ok &&
      response.op === "pair.request" &&
      response.payload.resumed
    ) {
      const surfaceId = response.payload.surfaceId;
      await this.sendSnapshotHint(surfaceId, "after_reconnect");
      await this.sendEvent(socket, {
        eventId: makeEventId(),
        op: "event.surface_resumed",
        payload: { surfaceId },
        sentAt: Date.now() as never,
        type: "event",
        v: 1,
      });
    }
  }

  private async dispatchRequest(socket: WebSocket, request: Request): Promise<Response> {
    if ((request as { op: string }).op === "diagnostics.overlay_regions") {
      return this.handleOverlayDiagnostics(socket, request);
    }
    switch (request.op) {
      case "surfaces.list":
        return this.handleSurfacesList(request);
      case "pair.request":
        return await this.handlePairRequest(socket, request);
      case "ownership.relinquish":
        return this.handleRelinquish(socket, request);
      case "topology.apply":
        return await this.handleTopologyApply(socket, request);
      case "content.apply":
        return await this.handleContentApply(socket, request);
      case "target.apply":
        return await this.handleTargetApply(socket, request);
      case "panes.list":
        return this.handlePanesList(socket, request);
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
      case "authority.state":
        return await this.handleAuthorityState(socket, request);
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
        surfaces: this.core.listSurfaces().map((surface) => ({
          name: surface.name,
          paired: this.isSurfaceBusy(surface.surfaceId),
          surfaceId: surface.surfaceId,
          viewport: this.core.viewport(surface.surfaceId),
        })),
      },
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handlePairRequest(socket: WebSocket, request: PairRequest): Promise<Response> {
    const meta = this.socketMeta.get(socket);
    if (request.payload.protocolVersion !== 1) {
      persistentServerDiagnostic(
        "warn",
        "pair_request_validation_failed",
        {
          code: "unsupported_protocol_version",
          protocol_version: request.payload.protocolVersion,
          request_id: request.id,
          socket_id: meta?.socketId,
          surface_id: request.payload.surfaceId,
        },
      );
      throw new SurfaceCoreError("unsupported_protocol_version", "Unsupported protocol version");
    }
    if (
      typeof request.payload.providerName !== "string" ||
      !request.payload.providerName.trim()
    ) {
      persistentServerDiagnostic(
        "warn",
        "pair_request_validation_failed",
        {
          code: "missing_provider_name",
          request_id: request.id,
          socket_id: meta?.socketId,
          surface_id: request.payload.surfaceId,
        },
      );
      throw new SurfaceCoreError("missing_provider_name", "providerName is required");
    }
    if (
      !request.payload.windowLabel ||
      request.payload.initialPaneId < 1 ||
      request.payload.initialPaneLabel < 1
    ) {
      persistentServerDiagnostic(
        "warn",
        "pair_request_validation_failed",
        {
          code: "invalid_payload",
          initial_pane_id: request.payload.initialPaneId,
          initial_pane_label: request.payload.initialPaneLabel,
          request_id: request.id,
          socket_id: meta?.socketId,
          surface_id: request.payload.surfaceId,
          window_label: request.payload.windowLabel,
        },
      );
      throw new SurfaceCoreError(
        "invalid_payload",
        "pair.request requires windowLabel, initialPaneId, and initialPaneLabel",
      );
    }
    if (!isValidWindowLabel(request.payload.windowLabel)) {
      persistentServerDiagnostic(
        "warn",
        "pair_request_validation_failed",
        {
          code: "invalid_window_label",
          request_id: request.id,
          socket_id: meta?.socketId,
          surface_id: request.payload.surfaceId,
          window_label: request.payload.windowLabel,
        },
      );
      throw new SurfaceCoreError(
        "invalid_payload",
        "pair.request windowLabel must be a lowercase alphabetic provider identity label",
      );
    }

    return await this.runProviderWindowLabelMutation(() => this.acceptPairRequest(socket, request, meta));
  }

  private async acceptPairRequest(socket: WebSocket, request: PairRequest, meta: SocketMeta | undefined): Promise<Response> {
    const surfaceId = request.payload.surfaceId;
    this.core.getSurface(surfaceId);
    const transport = this.transport(surfaceId);
    const existing = transport.active;
    const lock = transport.lock;
    const providerId = request.payload.providerId;
    const requestedProfile = request.payload.eventProfile ?? "minimum_deep";
    const drawingFlushConfig = request.payload.drawingFlushConfig ?? DEFAULT_DRAWING_FLUSH_CONFIG;
    const resumeSessionId = request.payload.resume?.sessionId ?? null;
    const existingOpenElsewhere =
      existing !== null &&
      existing.socket !== socket &&
      existing.socket.readyState === WebSocket.OPEN;
    persistentServerDiagnostic(
      "info",
      "pair_request_begin",
      {
        existing_open_elsewhere: existingOpenElsewhere,
        has_lock: Boolean(lock),
        lock_provider_id: lock?.providerId,
        lock_session_id: lock?.sessionId,
        provider_id: providerId,
        request_id: request.id,
        resume_session_id: resumeSessionId ?? "nil",
        socket_id: meta?.socketId,
        surface_id: surfaceId,
        takeover: request.payload.takeover ?? false,
      },
    );
    this.core.assertProviderWindowLabelAvailable(surfaceId, request.payload.windowLabel);

    let resumed = false;
    let sessionId: string;
    let ownershipEpoch: number;
    let supersededSession: ActiveSession | null = null;

    if (!lock) {
      sessionId = `sa_${randomUUID().replaceAll("-", "")}`;
      ownershipEpoch = 1;
      persistentServerDiagnostic(
        "info",
        "pair_request_new_session",
        {
          provider_id: providerId,
          request_id: request.id,
          session_id: sessionId,
          socket_id: meta?.socketId,
          surface_id: surfaceId,
        },
      );
    } else if (lock.providerId === providerId) {
      if (request.payload.takeover === true && resumeSessionId === lock.sessionId) {
        resumed = true;
        sessionId = lock.sessionId;
        ownershipEpoch = lock.ownershipEpoch;
        if (existing && existing.socket !== socket) {
          supersededSession = existing;
        }
        persistentServerDiagnostic(
          "info",
          "pair_request_takeover_resumed",
          {
            provider_id: providerId,
            request_id: request.id,
            session_id: sessionId,
            socket_id: meta?.socketId,
            surface_id: surfaceId,
          },
        );
      } else if (request.payload.takeover === true) {
        if (existing && existing.socket !== socket) {
          supersededSession = existing;
        }
        sessionId = `sa_${randomUUID().replaceAll("-", "")}`;
        ownershipEpoch = lock.ownershipEpoch + 1;
        persistentServerDiagnostic(
          "info",
          "pair_request_explicit_takeover",
          {
            existing_open_elsewhere: existingOpenElsewhere,
            previous_provider_id: lock.providerId,
            previous_session_id: lock.sessionId,
            provider_id: providerId,
            request_id: request.id,
            same_provider: true,
            session_id: sessionId,
            socket_id: meta?.socketId,
            surface_id: surfaceId,
          },
        );
      } else if (resumeSessionId !== lock.sessionId) {
        persistentServerDiagnostic(
          "warn",
          "pair_request_invalid_resume",
          {
            expected_session_id: lock.sessionId,
            provider_id: providerId,
            received_session_id: resumeSessionId ?? "nil",
            request_id: request.id,
            socket_id: meta?.socketId,
            surface_id: surfaceId,
          },
        );
        throw new SurfaceCoreError("invalid_resume", "Resume session did not match active ownership lock");
      } else {
        resumed = true;
        sessionId = lock.sessionId;
        ownershipEpoch = lock.ownershipEpoch;
        if (existing && existing.socket !== socket) {
          supersededSession = existing;
        }
        persistentServerDiagnostic(
          "info",
          "pair_request_resumed",
          {
            provider_id: providerId,
            request_id: request.id,
            session_id: sessionId,
            socket_id: meta?.socketId,
            surface_id: surfaceId,
          },
        );
      }
    } else {
      if (!request.payload.takeover) {
        persistentServerDiagnostic(
          "warn",
          "pair_request_busy",
          {
            lock_provider_id: lock.providerId,
            requested_provider_id: providerId,
            request_id: request.id,
            socket_id: meta?.socketId,
            surface_id: surfaceId,
          },
        );
        throw new SurfaceCoreError("busy", "Surface ownership lock is held by another provider");
      }
      if (existing && existing.socket !== socket) {
        supersededSession = existing;
      }
      sessionId = `sa_${randomUUID().replaceAll("-", "")}`;
      ownershipEpoch = lock.ownershipEpoch + 1;
      persistentServerDiagnostic(
        "info",
        "pair_request_explicit_takeover",
        {
          existing_open_elsewhere: existingOpenElsewhere,
          previous_provider_id: lock.providerId,
          previous_session_id: lock.sessionId,
          provider_id: providerId,
          request_id: request.id,
          same_provider: false,
          session_id: sessionId,
          socket_id: meta?.socketId,
          surface_id: surfaceId,
        },
      );
    }

    if (resumed) {
      await this.runSurfaceMutation(surfaceId, async () => {
        await this.adoptProviderWindowLabel(surfaceId, request.payload.windowLabel, "pair.resume", request.id);
      });
    } else {
      this.core.applyProviderBootstrapTopology(surfaceId, {
        initialPaneId: Number(request.payload.initialPaneId),
        initialPaneLabel: Number(request.payload.initialPaneLabel),
        windowLabel: request.payload.windowLabel,
      });
    }

    const session: ActiveSession = {
      connectionId: request.payload.connectionId,
      drawingFlushConfig,
      eventProfile: requestedProfile,
      ownershipEpoch,
      paneFlushTimers: new Map(),
      pairConfirmed: false,
      providerId,
      providerName: request.payload.providerName,
      requestCache: new Map(),
      sessionId,
      socket,
    };
    const response: Response = {
      id: request.id,
      ok: true,
      op: "pair.request",
      payload: {
        capabilities: this.capabilities(),
        eventConfig: {
          activeEvents: activeEventsForProfile(requestedProfile),
          drawingFlushConfig,
          profile: requestedProfile,
        },
        limits: {
          ...DEFAULT_LIMITS,
          resumeGraceMs: 20_000,
        },
        ownershipEpoch,
        resumed,
        sessionId: sessionId as PairRequest["payload"]["resume"]["sessionId"],
        state: this.core.pairState(surfaceId),
        surfaceId: surfaceId as PairRequest["payload"]["surfaceId"],
        surfaceName: this.core.surfaceName(surfaceId),
        viewport: this.core.viewport(surfaceId),
      },
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
    this.pendingPairCommits.set(response, {
      providerName: request.payload.providerName,
      session,
      supersededSession,
      surfaceId,
    });

    persistentServerDiagnostic(
      "info",
      "pair_response_ok",
      {
        pane_count: response.payload.state.panes.length,
        request_id: request.id,
        resumed,
        session_id: sessionId,
        socket_id: meta?.socketId,
        surface_id: surfaceId,
      },
    );

    return response;
  }

  private handleRelinquish(socket: WebSocket, request: RelinquishRequest): Response {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const transport = this.transport(surfaceId);
    const active = transport.active;
    if (!active || active.socket !== socket) {
      throw new SurfaceCoreError("not_lock_owner", "Only the active lock owner may relinquish");
    }
    if (!transport.lock || transport.lock.providerId !== active.providerId) {
      throw new SurfaceCoreError("not_lock_owner", "Only the current lock owner may relinquish");
    }

    transport.lock = null;
    this.core.setConnectionBar(surfaceId, "disconnected");
    this.onBusyChanged?.();

    return {
      id: request.id,
      ok: true,
      op: "ownership.relinquish",
      payload: { relinquished: true },
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private handlePanesList(socket: WebSocket, request: PanesListRequest): Response {
    const surfaceId = this.requirePairedSurfaceId(socket);
    return {
      id: request.id,
      ok: true,
      op: "panes.list",
      payload: this.core.panesList(surfaceId),
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
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
    let missing = this.core.missingResolvedPaneGeometry(surfaceId, uniquePaneIds);
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
          missing = this.core.missingResolvedPaneGeometry(surfaceId, uniquePaneIds);
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
      const rollbackMaterialization = this.core.projectCurrentNativePaneGeometry(surfaceId, nativePaneIds);
      const materialization = this.core.projectNativePaneGeometryUpdateForViewport(surfaceId, nativePaneIds, viewport);
      const updateResult = await this.applyNativePaneGeometryToCompositor(materialization);
      if (updateResult.failure) {
        if (updateResult.updated) {
          await this.rollbackNativePaneGeometry(surfaceId, rollbackMaterialization, "viewport", updateResult.failure);
        }
        return false;
      }
      this.core.setViewport(surfaceId, viewport);
      this.markUpdatedNativePaneGeometry(surfaceId, materialization);
      return true;
    });
  }

  async resizeSplit(surfaceId: string, path: number[], weights: number[]): Promise<boolean> {
    return await this.runSurfaceMutation(surfaceId, async () => {
      const nativeGeometryUpdate = this.core.projectNativePaneGeometryUpdateForResizeSplit(surfaceId, path, weights);
      const rollbackNativeGeometry = nativeGeometryUpdate
        ? this.core.projectNativePaneGeometryUpdate(surfaceId, nativeGeometryUpdate.panes.map((pane) => Number(pane.id)))
        : null;
      try {
        await this.updateNativePaneGeometryBeforeLayout(surfaceId, nativeGeometryUpdate, "pane.resize", rollbackNativeGeometry);
        this.core.resizeSplit(surfaceId, path, weights);
        this.markUpdatedNativePaneGeometry(surfaceId, nativeGeometryUpdate);
        return true;
      } catch (error) {
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
      const nativeHostedPaneIds = this.core.nativeHostedPaneIdsForTopologyApply(surfaceId, request.payload);
      const nativeGeometryUpdate = this.core.projectNativePaneGeometryUpdateForTopologyApply(surfaceId, request.payload);
      const rollbackNativeGeometry = nativeGeometryUpdate
        ? this.core.projectCurrentNativePaneGeometry(surfaceId, nativeGeometryUpdate.panes.map((pane) => Number(pane.id)))
        : null;
      this.core.nativeHostedPaneIdsForTopologyApply(surfaceId, request.payload);
      await this.updateNativePaneGeometryBeforeLayout(surfaceId, nativeGeometryUpdate, "topology.apply", rollbackNativeGeometry);
      const releaseFailure = await this.releaseNativePanesBeforeRendererContent(
        surfaceId,
        nativeHostedPaneIds,
        "topology.apply",
      );
      if (releaseFailure) {
        await this.rollbackNativePaneGeometry(surfaceId, rollbackNativeGeometry, "topology.apply", releaseFailure);
        throw new SurfaceCoreError("render_failed", releaseFailure);
      }
      const result = this.core.topologyApply(surfaceId, request.payload);
      this.recordProviderWindowRelabel(surfaceId, previousWindowLabel, request.payload.windowLabel, "topology.apply", request.id);
      this.markUpdatedNativePaneGeometry(surfaceId, nativeGeometryUpdate);
      if (previousWindowLabel === request.payload.windowLabel) {
        await this.waitForResolvedPaneGeometry(
          surfaceId,
          result.panes.map((pane) => Number(pane.paneId)),
          "topology.apply",
        );
      }
      return result;
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
    const appliedAt = new Date().toISOString();
    if (request.payload.surfaceId !== surfaceId) {
      return this.targetApplyFailureResponse(request, appliedAt, "ownership_session_mismatch", "target.apply surfaceId does not match paired surface");
    }
    const sessionFailure = this.targetApplySessionFailure(surfaceId, socket, request, appliedAt);
    if (sessionFailure) {
      return sessionFailure;
    }

    if (request.payload.targetKind === "browser_url") {
      const preflightFailure = this.core.browserUrlTargetPreflight(surfaceId, request.payload);
      if (preflightFailure) {
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
        const currentSessionFailure = this.targetApplySessionFailure(surfaceId, socket, request, appliedAt);
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
        const postReleaseSessionFailure = this.targetApplySessionFailure(surfaceId, socket, request, appliedAt);
        if (postReleaseSessionFailure) {
          return { response: postReleaseSessionFailure };
        }
        return { payload: this.core.targetApply(surfaceId, request.payload) };
      });
      if ("response" in releaseResult) {
        return releaseResult.response;
      }
      if ("failure" in releaseResult) {
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
        ? await this.waitForBrowserUrlNavigation(surfaceId, Number(paneId), request, socket, appliedAt)
        : result;
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
      const currentSessionFailure = this.targetApplySessionFailure(surfaceId, socket, request, appliedAt);
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

      let hostRequest: CompositorControlRequest | null = null;
      let preflightStatus: CompositorControlResponse | null = null;
      let hostApplied = false;
      let overlayRequest: CompositorControlRequest | null = null;
      let overlayApplied = false;
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
        const postHostSessionFailure = this.targetApplySessionFailure(surfaceId, socket, request, appliedAt);
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
        const postOverlayLayoutFailure = this.core.validateNativePaneMaterializationLayout(surfaceId, materialization);
        if (postOverlayLayoutFailure) {
          throw new Error(postOverlayLayoutFailure);
        }
        const postOverlaySessionFailure = this.targetApplySessionFailure(surfaceId, socket, request, appliedAt);
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
            nativeHost: "applied",
            overlayRegions: overlayRequest ? "applied" : "not_requested",
          },
          paneLineageId: request.payload.paneLineageId,
          requestId: request.payload.requestId,
          status: "applied",
          targetEpoch: request.payload.targetEpoch,
          targetId: request.payload.targetId,
        };
        this.core.markNativePaneMaterialized(surfaceId, materialization);
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
        const releasedAfterFailure = hostApplied
          ? await this.releaseNativePaneAfterFailedHost(surfaceId, materialization)
          : false;
        if (hostApplied && !releasedAfterFailure) {
          this.core.markNativePaneMaterialized(surfaceId, materialization);
          this.onNativeMaterialized?.(surfaceId, materialization);
        }
        const payload: TargetApplyResponse["payload"] = {
          appliedAt,
          errorCode: "materialization_failed",
          materializedState: {
            nativeHost: releasedAfterFailure ? "released_after_failure" : hostApplied ? "applied" : "not_applied",
            overlayRegions: overlayRequest
              ? overlayApplied
                ? "applied"
                : "not_applied"
              : "not_requested",
          },
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
    evidence: { errorMessage?: string; status: "applied" | "failed"; targetId: string; url: string },
  ): void {
    const key = browserUrlApplyKey(surfaceId, paneId);
    const pending = this.pendingBrowserUrlApplies.get(key);
    if (!pending || pending.request.payload.targetId !== evidence.targetId) {
      return;
    }
    this.pendingBrowserUrlApplies.delete(key);
    clearTimeout(pending.timeout);
    const sessionFailure = this.targetApplySessionFailurePayload(
      surfaceId,
      pending.socket,
      pending.request,
      pending.appliedAt,
    );
    if (sessionFailure) {
      pending.resolve(sessionFailure);
      return;
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
    pending.resolve(payload);
  }

  private async sendNativeOverlayRequestWithLivenessRetry(
    request: CompositorControlRequest,
  ): Promise<CompositorControlResponse> {
    if (!this.compositorSocketPath || request.type !== "overlay_regions.set") {
      return await sendCompositorControl(this.compositorSocketPath ?? "", request);
    }
    let currentRequest = request;
    let response = await sendCompositorControl(this.compositorSocketPath, currentRequest);
    for (let attempt = 0; attempt < NATIVE_OVERLAY_LIVENESS_RETRY_COUNT && isOverlayNativePaneLivenessFailure(response); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, NATIVE_OVERLAY_LIVENESS_RETRY_DELAY_MS));
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

  private async waitForBrowserUrlNavigation(
    surfaceId: string,
    paneId: number,
    request: TargetApplyRequest,
    socket: WebSocket,
    appliedAt: string,
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
      const timeout = setTimeout(() => {
        this.pendingBrowserUrlApplies.delete(key);
        const sessionFailure = this.targetApplySessionFailurePayload(surfaceId, socket, request, appliedAt);
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
        request,
        resolve,
        socket,
        timeout,
      });
    });
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

  private async updateNativePaneGeometryBeforeLayout(
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
    const updateResult = await this.applyNativePaneGeometryToCompositor(materialization);
    if (updateResult.failure) {
      if (updateResult.updated) {
        await this.rollbackNativePaneGeometry(surfaceId, rollbackMaterialization, operation, updateResult.failure);
      }
      throw new SurfaceCoreError("render_failed", updateResult.failure);
    }
    const staleSourceFailure = rollbackMaterialization
      ? this.core.validateNativePaneMaterializationLayout(surfaceId, rollbackMaterialization)
      : null;
    if (staleSourceFailure) {
      const currentMaterialization = rollbackMaterialization
        ? this.core.projectCurrentNativePaneGeometry(surfaceId, rollbackMaterialization.panes.map((pane) => Number(pane.id)))
        : null;
      await this.rollbackNativePaneGeometry(surfaceId, currentMaterialization, operation, staleSourceFailure);
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

  private async adoptProviderWindowLabel(
    surfaceId: string,
    windowLabel: string,
    source: "authority.state" | "pair.resume",
    requestId: string,
  ): Promise<void> {
    const currentWindowLabel = this.core.surfaceWindowLabel(surfaceId);
    if (windowLabel === currentWindowLabel) {
      return;
    }
    const nativeOverlayUpdate = this.core.projectNativePaneOverlayWindowLabelUpdate(surfaceId, windowLabel);
    const rollbackNativeGeometry = nativeOverlayUpdate
      ? this.core.projectNativePaneGeometryUpdate(surfaceId, nativeOverlayUpdate.panes.map((pane) => Number(pane.id)))
      : null;
    await this.updateNativePaneGeometryBeforeLayout(surfaceId, nativeOverlayUpdate, source, rollbackNativeGeometry);
    this.recordProviderWindowRelabel(surfaceId, currentWindowLabel, windowLabel, source, requestId);
    this.core.applyWindowLabelOnly(surfaceId, windowLabel);
    this.markUpdatedNativePaneGeometry(surfaceId, nativeOverlayUpdate);
  }

  private recordProviderWindowRelabel(
    surfaceId: string,
    currentWindowLabel: string,
    windowLabel: string,
    source: "authority.state" | "pair.resume" | "topology.apply",
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
        source,
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
    const active = this.transport(surfaceId).active;
    if (!active || active.socket !== socket || request.payload.ownershipSessionId !== active.sessionId) {
      return (this.targetApplyFailureResponse(
        request,
        appliedAt,
        "ownership_session_mismatch",
        "target.apply ownership session does not match active session",
      ) as TargetApplyResponse).payload;
    }
    if (request.payload.ownershipEpoch !== active.ownershipEpoch) {
      return (this.targetApplyFailureResponse(
        request,
        appliedAt,
        "ownership_epoch_mismatch",
        "target.apply ownershipEpoch does not match the active session",
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
      const nativeHostedPaneIds = this.core.nativeHostedPaneIdsForPaneSplit(surfaceId, splitPayload);
      const nativeGeometryUpdate = this.core.projectNativePaneGeometryUpdateForPaneSplit(surfaceId, splitPayload);
      const rollbackNativeGeometry = nativeGeometryUpdate
        ? this.core.projectCurrentNativePaneGeometry(surfaceId, nativeGeometryUpdate.panes.map((pane) => Number(pane.id)))
        : null;
      const releaseFailure = await this.releaseNativePanesBeforeRendererContent(
        surfaceId,
        nativeHostedPaneIds,
        "pane.split",
      );
      if (releaseFailure) {
        throw new SurfaceCoreError("render_failed", releaseFailure);
      }
      this.core.nativeHostedPaneIdsForPaneSplit(surfaceId, splitPayload);
      await this.updateNativePaneGeometryBeforeLayout(surfaceId, nativeGeometryUpdate, "pane.split", rollbackNativeGeometry);
      const result = this.core.paneSplit(surfaceId, splitPayload);
      this.markUpdatedNativePaneGeometry(surfaceId, nativeGeometryUpdate);
      await this.waitForResolvedPaneGeometry(
        surfaceId,
        result.panes.map((pane) => Number(pane.paneId)),
        "pane.split",
      );
      return result;
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
      const nativeGeometryUpdate = this.core.projectNativePaneGeometryUpdateForPaneClose(surfaceId, paneId);
      const rollbackNativeGeometry = nativeGeometryUpdate
        ? this.core.projectCurrentNativePaneGeometry(surfaceId, nativeGeometryUpdate.panes.map((pane) => Number(pane.id)))
        : null;
      await this.updateNativePaneGeometryBeforeLayout(surfaceId, nativeGeometryUpdate, "pane.close", rollbackNativeGeometry);
      const releaseFailure = await this.releaseNativePanesBeforeRendererContent(
        surfaceId,
        [nativeHostedPaneId],
        "pane.close",
      );
      if (releaseFailure) {
        await this.rollbackNativePaneGeometry(surfaceId, rollbackNativeGeometry, "pane.close", releaseFailure);
        throw new SurfaceCoreError("render_failed", releaseFailure);
      }
      const result = this.core.paneClose(surfaceId, paneId);
      this.markUpdatedNativePaneGeometry(surfaceId, nativeGeometryUpdate);
      await this.waitForResolvedPaneGeometry(
        surfaceId,
        this.core.getRendererWindowState(surfaceId).panes.map((pane) => pane.paneId),
        "pane.close",
      );
      return result;
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
    const surfaceId = this.requirePairedSurfaceId(socket);
    const transport = this.transport(surfaceId);
    if (transport.active?.socket !== socket) {
      throw new SurfaceCoreError("not_paired", "Operation requires active pair.request first");
    }
    if (!transport.active.pairConfirmed) {
      transport.active.pairConfirmed = true;
    }
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

  private async handleAuthorityState(socket: WebSocket, request: AuthorityStateRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const transport = this.transport(surfaceId);
    const active = transport.active;
    const payload = request.payload;
    let accepted = false;
    let reason: string | null = null;

    if (!active || active.socket !== socket) {
      reason = "not_active_session";
    } else if (payload.surfaceId !== surfaceId) {
      reason = "surface_id_mismatch";
    } else if (
      payload.providerId !== active.providerId ||
      payload.sessionId !== active.sessionId ||
      payload.ownershipEpoch !== active.ownershipEpoch
    ) {
      reason = "session_identity_mismatch";
    } else {
      const surface = this.core.getSurface(surfaceId);
      const panes = this.core.pairState(surfaceId).panes;
      const panesById = new Map(panes.map((pane) => [pane.paneId, pane]));
      const payloadPaneIds = new Set(payload.panes.map((pane) => pane.paneId));
      const panesMatch = panesById.size === payload.panes.length &&
        payloadPaneIds.size === payload.panes.length &&
        payload.panes.every((candidate) => {
          const pane = panesById.get(candidate.paneId);
          return Boolean(pane) &&
            candidate.paneLabel === pane.paneLabel &&
            (candidate.paneLineageId ?? null) === (pane.paneLineageId ?? null);
        });
      if (!isValidWindowLabel(payload.windowLabel)) {
        reason = "window_label_mismatch";
      } else if (payload.windowLabel !== surface.windowLabel) {
        await this.runProviderWindowLabelMutation(() => this.runSurfaceMutation(surfaceId, async () => {
          await this.adoptProviderWindowLabel(surfaceId, payload.windowLabel, "authority.state", request.id);
        }));
      }
      if (!reason && !panesMatch) {
        reason = "pane_identity_mismatch";
      } else if (!reason && !payload.actionable) {
        reason = payload.reason ?? "provider_not_actionable";
      } else if (!reason) {
        accepted = true;
        this.core.setProviderName(surfaceId, active.providerName);
        this.core.setConnectionBar(surfaceId, "connected");
      }
    }

    if (!accepted) {
      this.core.setConnectionBar(surfaceId, "connecting");
    }

    return {
      id: request.id,
      ok: true,
      op: "authority.state",
      payload: { accepted, reason },
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

  private transport(surfaceId: string): SurfaceTransportState {
    const existing = this.transports.get(surfaceId);
    if (existing) {
      return existing;
    }
    const created: SurfaceTransportState = { active: null, lock: null };
    this.transports.set(surfaceId, created);
    return created;
  }

  private capabilities() {
    const capabilities = this.core.capabilities();
    return {
      ...capabilities,
      protocolFeatures: ["authority.state.v1"],
      targetCapabilities: this.compositorSocketPath
        ? [...capabilities.targetCapabilities, "target.terminal_app.v1"]
        : capabilities.targetCapabilities,
    };
  }

  private activeSession(surfaceId: string): ActiveSession | null {
    return this.transport(surfaceId).active;
  }

  private handleSocketClosed(socket: WebSocket): void {
    const meta = this.socketMeta.get(socket);
    if (!meta?.pairedSurfaceId) {
      return;
    }
    const surfaceId = meta.pairedSurfaceId;
    const transport = this.transport(surfaceId);
    if (!transport.active || transport.active.socket !== socket) {
      return;
    }

    const session = transport.active;
    clearPaneTimers(session.paneFlushTimers);
    transport.active = null;
    console.info(
      serverDiagnostic("session_detached", {
        provider_id: session.providerId,
        session_id: session.sessionId,
        surface_id: surfaceId,
      }),
    );
    this.core.setConnectionBar(surfaceId, "connecting");
    this.onBusyChanged?.();
  }

  private detachActiveSession(surfaceId: string, reason: string): void {
    const transport = this.transport(surfaceId);
    const active = transport.active;
    if (!active) {
      return;
    }
    transport.active = null;
    this.closeSession(surfaceId, active, reason);
  }

  private commitPairResponse(response: Response): void {
    const plan = this.pendingPairCommits.get(response);
    if (!plan) {
      return;
    }
    this.pendingPairCommits.delete(response);
    const transport = this.transport(plan.surfaceId);
    transport.active = plan.session;
    transport.lock = {
      drawingFlushConfig: plan.session.drawingFlushConfig,
      eventProfile: plan.session.eventProfile,
      ownershipEpoch: plan.session.ownershipEpoch,
      providerId: plan.session.providerId,
      sessionId: plan.session.sessionId,
    };
    const meta = this.socketMeta.get(plan.session.socket);
    if (meta) {
      meta.pairedSurfaceId = plan.surfaceId;
    }
    this.core.setConnectionBar(plan.surfaceId, "connecting");
    this.core.setProviderName(plan.surfaceId, plan.providerName);
    this.onBusyChanged?.();
    if (plan.supersededSession && plan.supersededSession.socket !== plan.session.socket) {
      this.closeSession(plan.surfaceId, plan.supersededSession, "superseded");
    }
  }

  private closeSession(surfaceId: string, active: ActiveSession, reason: string): void {
    clearPaneTimers(active.paneFlushTimers);
    const meta = this.socketMeta.get(active.socket);
    if (meta?.pairedSurfaceId === surfaceId) {
      meta.pairedSurfaceId = null;
    }
    console.info(
      serverDiagnostic("session_detach_request", {
        provider_id: active.providerId,
        reason,
        session_id: active.sessionId,
        surface_id: surfaceId,
      }),
    );
    active.socket.close(1000, reason);
  }

  private schedulePaneFlush(surfaceId: string, paneId: number): void {
    const session = this.activeSession(surfaceId);
    if (!session) {
      return;
    }
    const meta = this.core.flushMeta(surfaceId, paneId);
    const timers = ensurePaneTimers(session.paneFlushTimers, paneId);
    if (timers.idleTimer) {
      clearTimeout(timers.idleTimer);
    }
    timers.idleTimer = setTimeout(() => {
      void this.flushPane(surfaceId, paneId, "idle_window");
    }, session.drawingFlushConfig.idleWindowMs);

    if (!timers.maxTimer && meta.lastSuccessfulFlushAt !== null) {
      const elapsed = Date.now() - meta.lastSuccessfulFlushAt;
      const delay = Math.max(0, session.drawingFlushConfig.maxIntervalMs - elapsed);
      timers.maxTimer = setTimeout(() => {
        void this.flushPane(surfaceId, paneId, "max_interval");
      }, delay);
    }
  }

  private armAllPendingFlushes(surfaceId: string): void {
    for (const paneId of this.core.activePaneIds(surfaceId)) {
      if (this.core.hasPendingDrawingFlush(surfaceId, paneId)) {
        this.schedulePaneFlush(surfaceId, paneId);
      }
    }
  }

  private armAllPendingAnnotationCommits(surfaceId: string): void {
    for (const paneId of this.core.activePaneIds(surfaceId)) {
      if (this.core.hasPendingAnnotationCommit(surfaceId, paneId)) {
        void this.maybeSendAnnotationCommitted(surfaceId, paneId);
      }
    }
  }

  private async maybeSendAnnotationCommitted(surfaceId: string, paneId: number): Promise<void> {
    const session = this.activeSession(surfaceId);
    if (!session) {
      return;
    }
    const timers = ensurePaneTimers(session.paneFlushTimers, paneId);
    const meta = this.core.flushMeta(surfaceId, paneId);
    if (meta.flushInFlight) {
      timers.commitAfterFlush = true;
      return;
    }
    if (this.core.hasPendingDrawingFlush(surfaceId, paneId)) {
      timers.commitAfterFlush = true;
      if (timers.idleTimer) {
        clearTimeout(timers.idleTimer);
        timers.idleTimer = null;
      }
      if (timers.maxTimer) {
        clearTimeout(timers.maxTimer);
        timers.maxTimer = null;
      }
      await this.flushPane(surfaceId, paneId, "idle_window");
      return;
    }

    const payload = this.core.buildAnnotationCommitted(surfaceId, paneId);
    if (!payload) {
      return;
    }

    await this.sendEvent(session.socket, {
      eventId: makeEventId(),
      op: "event.annotation_committed",
      payload,
      sentAt: Date.now(),
      type: "event",
      v: 1,
    });
    timers.commitAfterFlush = false;
    this.core.markAnnotationCommittedSent(surfaceId, paneId);
  }

  private async flushPane(
    surfaceId: string,
    paneId: number,
    reason: "idle_window" | "max_interval",
  ): Promise<void> {
    const session = this.activeSession(surfaceId);
    if (!session) {
      return;
    }
    const timers = ensurePaneTimers(session.paneFlushTimers, paneId);
    if (reason === "idle_window" && timers.idleTimer) {
      clearTimeout(timers.idleTimer);
      timers.idleTimer = null;
    }
    if (reason === "max_interval" && timers.maxTimer) {
      clearTimeout(timers.maxTimer);
      timers.maxTimer = null;
    }

    const payload = this.core.buildDrawingFlush(
      surfaceId,
      paneId,
      session.drawingFlushConfig,
      reason,
    );
    if (!payload) {
      return;
    }

    this.core.setFlushInFlight(surfaceId, paneId, true);
    try {
      await this.sendEvent(session.socket, {
        eventId: makeEventId(),
        op: "event.drawing_flush",
        payload,
        sentAt: Date.now(),
        type: "event",
        v: 1,
      });
      this.core.markDrawingFlushSent(surfaceId, paneId);
      if (timers.maxTimer) {
        clearTimeout(timers.maxTimer);
        timers.maxTimer = null;
      }
      if (timers.commitAfterFlush) {
        await this.maybeSendAnnotationCommitted(surfaceId, paneId);
      }
    } catch {
      this.core.setFlushInFlight(surfaceId, paneId, false);
    }
  }

  private async sendSnapshotHint(
    surfaceId: string,
    reason: SnapshotHintEvent["payload"]["reason"],
  ): Promise<void> {
    const session = this.activeSession(surfaceId);
    if (!session || !isEventEnabled(session.eventProfile, "event.snapshot_hint")) {
      return;
    }
    await this.sendEvent(session.socket, {
      eventId: makeEventId(),
      op: "event.snapshot_hint",
      payload: { reason },
      sentAt: Date.now(),
      type: "event",
      v: 1,
    });
  }

  private async broadcastLifecycleEvent(event: Event): Promise<void> {
    const activeSockets = [...this.transports.values()]
      .map((transport) => transport.active?.socket)
      .filter((socket): socket is WebSocket => Boolean(socket));
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

  private isSurfaceBusy(surfaceId: string): boolean {
    const transport = this.transport(surfaceId);
    return Boolean(transport.lock);
  }

  private isEndpointBusy(): boolean {
    return this.core.listSurfaces().some((surface) => this.isSurfaceBusy(surface.surfaceId));
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
    const session = this.activeSession(event.surfaceId);
    if (!session || !isEventEnabled(session.eventProfile, "event.history_navigated")) {
      return;
    }
    const payload: HistoryNavigatedEvent["payload"] = {
      contentId: event.contentId as HistoryNavigatedEvent["payload"]["contentId"],
      direction: event.direction,
      paneId: event.paneId as HistoryNavigatedEvent["payload"]["paneId"],
      revision: event.revision as HistoryNavigatedEvent["payload"]["revision"],
    };
    await this.sendEvent(session.socket, {
      eventId: makeEventId(),
      op: "event.history_navigated",
      payload,
      sentAt: Date.now(),
      type: "event",
      v: 1,
    });
  }
}

export const __test = {
  serverDiagnostic,
};

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

function activeEventsForProfile(profile: EventProfile) {
  if (profile === "deep_plus_scroll") {
    return [
      "event.annotation_committed",
      "event.drawing_flush",
      "event.history_navigated",
      "event.tap",
      "event.scroll",
      "event.selection",
      "event.page",
      "event.navigation",
      "event.snapshot_hint",
    ] as const;
  }
  return [
    "event.annotation_committed",
    "event.drawing_flush",
    "event.history_navigated",
    "event.tap",
    "event.selection",
    "event.page",
    "event.navigation",
    "event.snapshot_hint",
  ] as const;
}

function isEventEnabled(profile: EventProfile, eventName: Event["op"]): boolean {
  if (
    eventName === "event.surface_appeared" ||
    eventName === "event.surface_removed" ||
    eventName === "event.surface_resumed" ||
    eventName === "event.history_navigated" ||
    eventName === "event.pane_created" ||
    eventName === "event.pane_removed" ||
    eventName === "event.pane_renamed"
  ) {
    return true;
  }
  return activeEventsForProfile(profile).includes(eventName as never);
}

function browserUrlApplyKey(surfaceId: string, paneId: number): string {
  return `${surfaceId}::${paneId}`;
}

function isNativeHostTargetKind(targetKind: TargetApplyRequest["payload"]["targetKind"]): boolean {
  return targetKind === "terminal_app" || targetKind === "native_app" || targetKind === "compositor_app";
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

function ensurePaneTimers(map: Map<number, PaneFlushTimers>, paneId: number): PaneFlushTimers {
  const existing = map.get(paneId);
  if (existing) {
    return existing;
  }
  const created = { commitAfterFlush: false, idleTimer: null, maxTimer: null };
  map.set(paneId, created);
  return created;
}

function clearPaneTimers(map: Map<number, PaneFlushTimers>): void {
  for (const timers of map.values()) {
    if (timers.idleTimer) {
      clearTimeout(timers.idleTimer);
    }
    if (timers.maxTimer) {
      clearTimeout(timers.maxTimer);
    }
  }
  map.clear();
}

function clearTransport(transport: SurfaceTransportState): void {
  if (transport.active) {
    clearPaneTimers(transport.active.paneFlushTimers);
  }
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
