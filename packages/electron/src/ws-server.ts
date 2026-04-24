import http from "node:http";
import { randomUUID } from "node:crypto";

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
  TopologyApplyRequest,
  Viewport,
} from "../../protocol/src/index.js";
import { SurfaceCore, SurfaceCoreError, type CoreEvent } from "./surface-core.js";

type SocketCacheEntry = {
  payloadHash: string;
  response: Response;
};

type ActiveSession = {
  connectionId: string;
  drawingFlushConfig: DrawingFlushConfig;
  eventProfile: EventProfile;
  paneFlushTimers: Map<number, PaneFlushTimers>;
  pairConfirmed: boolean;
  providerId: string;
  requestCache: Map<string, SocketCacheEntry>;
  sessionId: string;
  socket: WebSocket;
};

type OwnershipLock = {
  drawingFlushConfig: DrawingFlushConfig;
  eventProfile: EventProfile;
  providerId: string;
  sessionId: string;
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

type SocketMeta = {
  cache: Map<string, SocketCacheEntry>;
  pairedSurfaceId: string | null;
};

export type SurfaceWsServerOptions = {
  bindAddress?: string;
  capturePaneImage: (surfaceId: string, paneId: number) => Promise<string | null>;
  core: SurfaceCore;
  endpointName: string;
  hostName: string;
  onBusyChanged?: () => void;
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

export class SurfaceWsServer {
  private readonly bindAddress: string;
  private readonly core: SurfaceCore;
  private readonly endpointName: string;
  private readonly hostName: string;
  private readonly onBusyChanged?: () => void;
  private readonly port: number;
  private readonly protocolVersion: number;
  private readonly capturePaneImage: SurfaceWsServerOptions["capturePaneImage"];
  private readonly viewportProvider: SurfaceWsServerOptions["viewport"];
  readonly wsPath: string;

  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly socketMeta = new WeakMap<WebSocket, SocketMeta>();
  private readonly transports = new Map<string, SurfaceTransportState>();
  private ignoreInitialSurfaceEvents = true;

  constructor(options: SurfaceWsServerOptions) {
    this.bindAddress = options.bindAddress ?? "0.0.0.0";
    this.capturePaneImage = options.capturePaneImage;
    this.core = options.core;
    this.endpointName = options.endpointName;
    this.hostName = options.hostName;
    this.onBusyChanged = options.onBusyChanged;
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
      this.socketMeta.set(socket, { cache: new Map(), pairedSurfaceId: null });
      console.info(
        serverDiagnostic("socket_open", {
          path: request.url ?? this.wsPath,
        }),
      );
      socket.on("message", (data) => {
        void this.handleMessage(socket, data.toString("utf8")).catch(() => {});
      });
      socket.on("close", (code, reasonBuffer) => {
        const reason = reasonBuffer.toString() || "<none>";
        console.info(
          serverDiagnostic("socket_close", {
            code,
            reason,
          }),
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

  async emitNavigation(surfaceId: string, paneId: number, url: string): Promise<void> {
    const session = this.activeSession(surfaceId);
    if (!session || !isEventEnabled(session.eventProfile, "event.navigation")) {
      return;
    }
    const state = this.tryCaptureSnapshot(surfaceId, paneId);
    if (!state) {
      return;
    }
    if (!state.contentId || state.contentType !== "html") {
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
      case "surface-created":
      case "surface-removed":
      case "surface-changed":
        return;
    }
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let request: Request;
    try {
      request = JSON.parse(raw) as Request;
    } catch {
      console.warn(serverDiagnostic("socket_protocol_violation", { reason: "invalid_json" }));
      socket.close(4410, "protocol_violation");
      return;
    }

    const meta = this.socketMeta.get(socket);
    if (!meta) {
      return;
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
      response = await this.dispatchRequest(socket, request);
    } catch (error) {
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
    await this.reply(socket, response);
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
    switch (request.op) {
      case "surfaces.list":
        return this.handleSurfacesList(request);
      case "pair.request":
        return await this.handlePairRequest(socket, request);
      case "ownership.relinquish":
        return this.handleRelinquish(socket, request);
      case "topology.apply":
        return this.handleTopologyApply(socket, request);
      case "content.apply":
        return await this.handleContentApply(socket, request);
      case "panes.list":
        return this.handlePanesList(socket, request);
      case "pane.split":
        return await this.handlePaneSplit(socket, request);
      case "pane.rename":
        return this.handlePaneRename(socket, request);
      case "pane.close":
        return this.handlePaneClose(socket, request);
      case "content.set":
        return await this.handleContentSet(socket, request);
      case "content.clear":
        return this.handleContentClear(socket, request);
      case "content.append":
        return this.handleContentAppend(socket, request);
      case "content.patch":
        return this.handleContentPatch(socket, request);
      case "annotations.remove":
        return this.handleAnnotationsRemove(socket, request);
      case "snapshot.get":
        return await this.handleSnapshotGet(socket, request);
      case "heartbeat.ping":
        return this.handleHeartbeat(socket, request);
    }
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
    if (request.payload.protocolVersion !== 1) {
      throw new SurfaceCoreError("unsupported_protocol_version", "Unsupported protocol version");
    }
    if (
      typeof request.payload.providerName !== "string" ||
      !request.payload.providerName.trim()
    ) {
      throw new SurfaceCoreError("missing_provider_name", "providerName is required");
    }
    if (
      !request.payload.windowLabel ||
      request.payload.initialPaneId < 1 ||
      request.payload.initialPaneLabel < 1
    ) {
      throw new SurfaceCoreError(
        "invalid_payload",
        "pair.request requires windowLabel, initialPaneId, and initialPaneLabel",
      );
    }

    const surfaceId = request.payload.surfaceId;
    this.core.getSurface(surfaceId);
    const transport = this.transport(surfaceId);
    const existing = transport.active;
    const lock = transport.lock;
    const providerId = request.payload.providerId;
    const requestedProfile = request.payload.eventProfile ?? "minimum_deep";
    const drawingFlushConfig = request.payload.drawingFlushConfig ?? DEFAULT_DRAWING_FLUSH_CONFIG;
    const resumeSessionId = request.payload.resume?.sessionId ?? null;
    console.info(
      serverDiagnostic("pair_request_begin", {
        provider_id: providerId,
        resume_session_id: resumeSessionId ?? "nil",
        surface_id: surfaceId,
        takeover: request.payload.takeover ?? false,
      }),
    );

    let resumed = false;
    let sessionId: string;
    const existingOpenElsewhere =
      existing !== null &&
      existing.socket !== socket &&
      existing.socket.readyState === WebSocket.OPEN;

    if (!lock) {
      sessionId = `sa_${randomUUID().replaceAll("-", "")}`;
      console.info(
        serverDiagnostic("pair_request_new_session", {
          provider_id: providerId,
          surface_id: surfaceId,
        }),
      );
    } else if (lock.providerId === providerId) {
      if (existingOpenElsewhere) {
        console.warn(
          serverDiagnostic("pair_request_duplicate_active", {
            provider_id: providerId,
            session_id: lock.sessionId,
            surface_id: surfaceId,
          }),
        );
        throw new SurfaceCoreError("busy", "Provider already holds an active socket for this surface");
      }
      if (resumeSessionId !== lock.sessionId) {
        console.warn(
          serverDiagnostic("pair_request_invalid_resume", {
            expected_session_id: lock.sessionId,
            provider_id: providerId,
            received_session_id: resumeSessionId ?? "nil",
            surface_id: surfaceId,
          }),
        );
        throw new SurfaceCoreError("invalid_resume", "Resume session did not match active ownership lock");
      } else {
        resumed = true;
        sessionId = lock.sessionId;
        console.info(
          serverDiagnostic("pair_request_resumed", {
            provider_id: providerId,
            session_id: sessionId,
            surface_id: surfaceId,
          }),
        );
        if (existing && existing.socket !== socket) {
          this.detachActiveSession(surfaceId, "superseded");
        }
      }
    } else {
      if (!request.payload.takeover) {
        console.warn(
          serverDiagnostic("pair_request_busy", {
            lock_provider_id: lock.providerId,
            requested_provider_id: providerId,
            surface_id: surfaceId,
          }),
        );
        throw new SurfaceCoreError("busy", "Surface ownership lock is held by another provider");
      }
      if (existing && existing.socket !== socket) {
        this.detachActiveSession(surfaceId, "superseded");
      }
      sessionId = `sa_${randomUUID().replaceAll("-", "")}`;
      console.info(
        serverDiagnostic("pair_request_takeover", {
          provider_id: providerId,
          surface_id: surfaceId,
        }),
      );
    }

    const session: ActiveSession = {
      connectionId: request.payload.connectionId,
      drawingFlushConfig,
      eventProfile: requestedProfile,
      paneFlushTimers: new Map(),
      pairConfirmed: false,
      providerId,
      requestCache: new Map(),
      sessionId,
      socket,
    };
    transport.active = session;
    transport.lock = {
      drawingFlushConfig,
      eventProfile: requestedProfile,
      providerId,
      sessionId,
    };
    const meta = this.socketMeta.get(socket);
    if (meta) {
      meta.pairedSurfaceId = surfaceId;
    }

    if (!resumed) {
      this.core.applyProviderBootstrapTopology(surfaceId, {
        initialPaneId: Number(request.payload.initialPaneId),
        initialPaneLabel: Number(request.payload.initialPaneLabel),
        windowLabel: request.payload.windowLabel,
      });
    }
    this.core.setConnectionBar(surfaceId, "connecting");
    this.core.setProviderName(surfaceId, request.payload.providerName);
    this.onBusyChanged?.();

    const response: Response = {
      id: request.id,
      ok: true,
      op: "pair.request",
      payload: {
        capabilities: this.core.capabilities(),
        eventConfig: {
          activeEvents: activeEventsForProfile(requestedProfile),
          drawingFlushConfig,
          profile: requestedProfile,
        },
        limits: {
          ...DEFAULT_LIMITS,
          resumeGraceMs: 20_000,
        },
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

    console.info(
      serverDiagnostic("pair_response_ok", {
        pane_count: response.payload.state.panes.length,
        resumed,
        session_id: sessionId,
        surface_id: surfaceId,
      }),
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

  private handleTopologyApply(socket: WebSocket, request: TopologyApplyRequest): Response {
    const surfaceId = this.requirePairedSurfaceId(socket);
    return {
      id: request.id,
      ok: true,
      op: "topology.apply",
      payload: this.core.topologyApply(surfaceId, request.payload),
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handleContentApply(socket: WebSocket, request: ContentApplyRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    if ("clear" in request.payload) {
      return {
        id: request.id,
        ok: true,
        op: "content.apply",
        payload: this.core.contentApply(surfaceId, request.payload),
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
    return {
      id: request.id,
      ok: true,
      op: "content.apply",
      payload: this.core.contentApply(surfaceId, request.payload),
      sentAt: Date.now(),
      type: "response",
      v: 1,
    };
  }

  private async handlePaneSplit(socket: WebSocket, request: PaneSplitRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = this.core.paneSplit(surfaceId, {
      count: request.payload.count,
      direction: request.payload.direction,
      newPaneIds: request.payload.newPaneIds.map(Number),
      newPaneLabels: request.payload.newPaneLabels.map(Number),
      paneId: Number(request.payload.paneId),
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

  private handlePaneClose(socket: WebSocket, request: PaneCloseRequest): Response {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = this.core.paneClose(surfaceId, Number(request.payload.paneId));
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
    const payload = this.core.contentSet(surfaceId, request.payload);
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

  private handleContentClear(socket: WebSocket, request: ContentClearRequest): Response {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = this.core.contentClear(surfaceId, request.payload);
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

  private handleContentAppend(socket: WebSocket, request: ContentAppendRequest): Response {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = this.core.contentAppend(surfaceId, request.payload);
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

  private handleContentPatch(socket: WebSocket, request: ContentPatchRequest): Response {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = this.core.contentPatch(surfaceId, request.payload);
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

  private handleAnnotationsRemove(socket: WebSocket, request: AnnotationsRemoveRequest): Response {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = this.core.annotationsRemove(surfaceId, {
      contentId: request.payload.contentId,
      paneId: Number(request.payload.paneId),
      strokeIds: request.payload.strokeIds.map(String),
    });
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
      this.core.setConnectionBar(surfaceId, "connected");
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
    clearPaneTimers(active.paneFlushTimers);
    transport.active = null;
    const meta = this.socketMeta.get(active.socket);
    if (meta) {
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

  private async reply(socket: WebSocket, response: Response): Promise<void> {
    await this.send(socket, JSON.stringify(response));
  }

  private async sendEvent(socket: WebSocket, event: Event): Promise<void> {
    await this.send(socket, JSON.stringify(event));
  }

  private async send(socket: WebSocket, payload: string): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(payload, (error) => {
        if (error) {
          if (socket.readyState !== WebSocket.OPEN || isSocketClosedError(error)) {
            resolve();
            return;
          }
          reject(error);
          return;
        }
        resolve();
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
