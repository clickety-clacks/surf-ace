import http from "node:http";
import { randomUUID } from "node:crypto";

import { WebSocketServer, type WebSocket } from "ws";

import type {
  AnnotationsRemoveRequest,
  ContentAppendRequest,
  ContentClearRequest,
  ContentPatchRequest,
  ContentSetRequest,
  DrawingFlushConfig,
  Event,
  EventProfile,
  HeartbeatPingRequest,
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
  providerId: string;
  requestCache: Map<string, SocketCacheEntry>;
  resumeGraceTimer: NodeJS.Timeout | null;
  sessionId: string;
  socket: WebSocket;
};

type GraceSession = {
  drawingFlushConfig: DrawingFlushConfig;
  eventProfile: EventProfile;
  providerId: string;
  resumeDeadline: number;
  resumeGraceTimer: NodeJS.Timeout;
  sessionId: string;
};

type PaneFlushTimers = {
  idleTimer: NodeJS.Timeout | null;
  maxTimer: NodeJS.Timeout | null;
};

type SurfaceTransportState = {
  active: ActiveSession | null;
  grace: GraceSession | null;
};

type SocketMeta = {
  cache: Map<string, SocketCacheEntry>;
  pairedSurfaceId: string | null;
};

export type SurfaceWsServerOptions = {
  capturePaneImage: (surfaceId: string, paneId: number) => Promise<string | null>;
  core: SurfaceCore;
  endpointName: string;
  hostName: string;
  onBusyChanged?: () => void;
  port: number;
  protocolVersion?: number;
  resumeGraceMs?: number;
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

export class SurfaceWsServer {
  private readonly core: SurfaceCore;
  private readonly endpointName: string;
  private readonly hostName: string;
  private readonly onBusyChanged?: () => void;
  private readonly port: number;
  private readonly protocolVersion: number;
  private readonly resumeGraceMs: number;
  private readonly capturePaneImage: SurfaceWsServerOptions["capturePaneImage"];
  private readonly viewportProvider: SurfaceWsServerOptions["viewport"];
  readonly wsPath: string;

  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly socketMeta = new WeakMap<WebSocket, SocketMeta>();
  private readonly transports = new Map<string, SurfaceTransportState>();
  private ignoreInitialSurfaceEvents = true;

  constructor(options: SurfaceWsServerOptions) {
    this.capturePaneImage = options.capturePaneImage;
    this.core = options.core;
    this.endpointName = options.endpointName;
    this.hostName = options.hostName;
    this.onBusyChanged = options.onBusyChanged;
    this.port = options.port;
    this.protocolVersion = options.protocolVersion ?? 1;
    this.resumeGraceMs = options.resumeGraceMs ?? 20_000;
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
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (websocket) => {
        this.wss.emit("connection", websocket, request);
      });
    });

    this.wss.on("connection", (socket) => {
      this.socketMeta.set(socket, { cache: new Map(), pairedSurfaceId: null });
      socket.on("message", (data) => {
        void this.handleMessage(socket, data.toString("utf8"));
      });
      socket.on("close", () => {
        this.handleSocketClosed(socket);
      });
    });

    this.core.subscribe((event) => {
      void this.handleCoreEvent(event);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.listen(this.port, "0.0.0.0", () => resolve());
      this.httpServer.once("error", reject);
    });
    this.ignoreInitialSurfaceEvents = false;
  }

  async stop(): Promise<void> {
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
    const state = this.core.captureSnapshot(surfaceId, paneId);
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
    const state = this.core.captureSnapshot(surfaceId, paneId);
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
    const state = this.core.captureSnapshot(surfaceId, paneId);
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
    const state = this.core.captureSnapshot(surfaceId, paneId);
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
    const state = this.core.captureSnapshot(surfaceId, paneId);
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
      const socket = transport.active.socket;
      clearPaneTimers(transport.active.paneFlushTimers);
      transport.active = null;
      const meta = this.socketMeta.get(socket);
      if (meta) {
        meta.pairedSurfaceId = null;
      }
      socket.close(1000, reason);
    }
    if (transport.grace) {
      clearTimeout(transport.grace.resumeGraceTimer);
      transport.grace = null;
    }
    this.core.setConnectionBar(surfaceId, "disconnected");
    this.onBusyChanged?.();
  }

  private async handleCoreEvent(event: CoreEvent): Promise<void> {
    switch (event.type) {
      case "drawing-dirty":
        this.schedulePaneFlush(event.surfaceId, event.paneId);
        return;
      case "pane-created":
        await this.broadcastLifecycleEvent({
          eventId: makeEventId(),
          op: "event.pane_created",
          payload: {
            fromSplit: event.fromSplit,
            paneId: event.paneId,
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
        response = errorResponse(
          request.op,
          request.id,
          error.code,
          error.message,
          error.details,
        );
      } else {
        response = errorResponse(request.op, request.id, "internal_error", "Unhandled surface error");
      }
    }

    cache.set(request.id, { payloadHash, response });
    trimCache(cache);
    await this.reply(socket, response);
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
        return this.handleHeartbeat(request);
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
    if (!request.payload.windowLabel || request.payload.initialPaneId < 1) {
      throw new SurfaceCoreError(
        "invalid_payload",
        "pair.request requires windowLabel and initialPaneId",
      );
    }

    const surfaceId = request.payload.surfaceId;
    this.core.getSurface(surfaceId);
    const transport = this.transport(surfaceId);
    const existing = transport.active;
    const grace = transport.grace;
    const providerId = request.payload.providerId;
    const requestedProfile = request.payload.eventProfile ?? "minimum_deep";
    const drawingFlushConfig = request.payload.drawingFlushConfig ?? DEFAULT_DRAWING_FLUSH_CONFIG;

    let resumed = false;
    if (existing) {
      if (existing.providerId === providerId && request.payload.takeover) {
        existing.socket.close(1000, "superseded");
        clearPaneTimers(existing.paneFlushTimers);
        transport.active = null;
      } else {
        throw new SurfaceCoreError("busy", "Surface is already paired");
      }
    } else if (grace) {
      if (grace.providerId !== providerId) {
        throw new SurfaceCoreError("busy", "Surface is in resume grace");
      }
      if (request.payload.resume?.sessionId && request.payload.resume.sessionId !== grace.sessionId) {
        throw new SurfaceCoreError("busy", "Resume session did not match active grace session");
      }
      clearTimeout(grace.resumeGraceTimer);
      transport.grace = null;
      resumed = true;
    }

    const sessionId = resumed ? grace!.sessionId : `sa_${randomUUID().replaceAll("-", "")}`;
    const session: ActiveSession = {
      connectionId: request.payload.connectionId,
      drawingFlushConfig,
      eventProfile: requestedProfile,
      paneFlushTimers: new Map(),
      providerId,
      requestCache: new Map(),
      resumeGraceTimer: null,
      sessionId,
      socket,
    };
    transport.active = session;
    const meta = this.socketMeta.get(socket);
    if (meta) {
      meta.pairedSurfaceId = surfaceId;
    }

    this.core.applyProviderBootstrapTopology(surfaceId, {
      initialPaneId: Number(request.payload.initialPaneId),
      windowLabel: request.payload.windowLabel,
    });
    this.core.setConnectionBar(surfaceId, "connected");
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
          resumeGraceMs: this.resumeGraceMs,
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

    this.armAllPendingFlushes(surfaceId);

    return response;
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

  private async handlePaneSplit(socket: WebSocket, request: PaneSplitRequest): Promise<Response> {
    const surfaceId = this.requirePairedSurfaceId(socket);
    const payload = this.core.paneSplit(surfaceId, {
      count: request.payload.count,
      direction: request.payload.direction,
      newPaneIds: request.payload.newPaneIds.map(Number),
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

  private handleHeartbeat(request: HeartbeatPingRequest): Response {
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
    const created: SurfaceTransportState = { active: null, grace: null };
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
    transport.grace = {
      drawingFlushConfig: session.drawingFlushConfig,
      eventProfile: session.eventProfile,
      providerId: session.providerId,
      resumeDeadline: Date.now() + this.resumeGraceMs,
      resumeGraceTimer: setTimeout(() => {
        const current = this.transport(surfaceId);
        if (current.grace?.sessionId === session.sessionId) {
          current.grace = null;
          this.core.setConnectionBar(surfaceId, "disconnected");
          this.onBusyChanged?.();
        }
      }, this.resumeGraceMs),
      sessionId: session.sessionId,
    };
    this.core.setConnectionBar(surfaceId, "connecting");
    this.onBusyChanged?.();
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
    await new Promise<void>((resolve, reject) => {
      socket.send(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private isSurfaceBusy(surfaceId: string): boolean {
    const transport = this.transport(surfaceId);
    return Boolean(transport.active || transport.grace);
  }

  private isEndpointBusy(): boolean {
    return this.core.listSurfaces().some((surface) => this.isSurfaceBusy(surface.surfaceId));
  }
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
      "event.drawing_flush",
      "event.tap",
      "event.scroll",
      "event.selection",
      "event.page",
      "event.navigation",
      "event.snapshot_hint",
    ] as const;
  }
  return [
    "event.drawing_flush",
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
  const created = { idleTimer: null, maxTimer: null };
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
  if (transport.grace) {
    clearTimeout(transport.grace.resumeGraceTimer);
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
