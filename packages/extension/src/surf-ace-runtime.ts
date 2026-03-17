import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AnnotationsRemoveRequest,
  AnnotationsRemoveResponse,
  ConnectionId,
  ContentAppendRequest,
  ContentClearRequest,
  ContentId,
  ContentPatchRequest,
  ContentSetRequest,
  ContentType,
  DrawingFlushConfig,
  DrawingFlushEvent,
  EpochMs,
  ErrorResponse,
  Event,
  EventProfile,
  HeartbeatPingRequest,
  HeartbeatPongResponse,
  NavigationEvent,
  PaneCloseRequest,
  PaneCloseResponse,
  PaneCreatedEvent,
  PaneId,
  PaneRemovedEvent,
  PaneRenameRequest,
  PaneRenamedEvent,
  PaneRenameResponse,
  PaneSplitRequest,
  PaneSplitResponse,
  PairRequest,
  PairResponse,
  PanesListRequest,
  PanesListResponse,
  Position,
  ProviderId,
  Request,
  RequestId,
  Rect,
  Response,
  Revision,
  ScrollEvent,
  Selection,
  SelectionEvent,
  SessionId,
  SnapshotGetRequest,
  SnapshotHintEvent,
  SnapshotResponse,
  Stroke,
  StrokeId,
  SurfaceAppearedEvent,
  SurfaceId,
  SurfaceRemovedEvent,
  SurfaceResumedEvent,
  SurfaceViewport,
  SurfacesListRequest,
  SurfacesListResponse,
  TapEvent,
  Viewport,
  MutationAckResponse,
  PageEvent,
} from "../../protocol/src/index.js";
import {
  type SurfAceDiscoveryEndpoint,
  type SurfAceDiscoveryService,
  type SurfAceLogger,
  createBonjourSurfAceDiscoveryService,
} from "./surf-ace-discovery.js";
import { SurfAceWireClient } from "./surf-ace-server.js";

export type SurfAceConnectionState = "connected" | "connecting" | "unreachable";

export type SurfAceHistorySummary = {
  backCount: number;
  forwardCount: number;
  visibleContentId: string | null;
};

export type SurfAcePaneSummary = {
  paneId: number;
  name: string | null;
  activeContent:
    | {
        contentId: string;
        contentType: ContentType;
        revision: number;
      }
    | null;
  historySummary: SurfAceHistorySummary;
};

export type SurfAceScreenSummary = {
  connectionState: SurfAceConnectionState;
  fingerprint: string;
  lastSeenAt: number;
  name: string;
  panes: SurfAcePaneSummary[];
  pendingEvents: number;
  viewport: SurfaceViewport;
};

export type SurfAceFrameStroke = {
  bbox: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  endedAt: number;
  points: Array<{
    pressure?: number;
    timestamp: number;
    x: number;
    y: number;
  }>;
  startedAt: number;
  strokeId: string;
};

export type SurfAceFrame = {
  contentId: string;
  contextKey: string;
  frameId: string;
  image: string;
  openedAt: number;
  scrollOffset: {
    x: number;
    y: number;
  };
  strokes: SurfAceFrameStroke[];
  updatedAt: number;
  url?: string;
  viewport: SurfaceViewport;
};

export type SurfAceReadResult = {
  fingerprint: string;
  frames: SurfAceFrame[];
  lastNavigation: {
    navigatedAt: number;
    url: string;
  } | null;
  liveDirtyStrokeIds: string[];
  liveFrame: SurfAceFrame | null;
  liveSeq: number | null;
  overflowed: boolean;
  page: {
    pageCount: number;
    pageLabel?: string;
    pageNumber: number;
  } | null;
  paneId: number;
  pendingFrames?: number;
  playbackPosition: number | null;
  playbackState: "ended" | "paused" | "playing" | null;
  readAt: number;
  scrollPosition:
    | {
        visibleRect: Viewport["visibleRect"];
        x: number;
        y: number;
      }
    | null;
  selection:
    | {
        anchorEnd: number | null;
        anchorStart: number | null;
        bounds?: Rect;
        selectedText: string;
      }
    | null;
  taps: Array<{
    elementRole?: string;
    eventId: string;
    kind: "long_press" | "tap";
    nearestText?: string;
    timestamp: number;
    x: number;
    y: number;
  }>;
};

export type SurfAceSnapshotResult = {
  fingerprint: string;
  paneId: number;
  snapshot: {
    contentId: string | null;
    contentType: ContentType | null;
    drawings?: Stroke[];
    image?: string;
    revision: number;
    selection: Selection;
    viewport: Viewport;
    visibleText?: string;
  } | null;
};

export type SurfAceAnnotateRemoveInput = {
  contentId: string;
  fingerprint: string;
  paneId: number;
  strokeIds: string[];
};

export type SurfAceAnnotateRemoveResult = {
  fingerprint: string;
  notFoundStrokeIds: string[];
  paneId: number;
  remainingStrokeCount: number;
  removedStrokeIds: string[];
};

export type SurfAcePushInput =
  {
    content: string;
    contentType: ContentType;
    fingerprint: string;
    paneId: number;
  };

export type SurfAcePushResult = {
  contentId: string;
  fingerprint: string;
  paneId: number;
  revision: number;
};

export type SurfAceClearResult = {
  fingerprint: string;
  paneId: number;
  revision: number;
};

export type SurfAceLocalEvent =
  | {
      paneId: number;
      previousSessionKey: string;
      surfaceId: string;
      type: "event.content_superseded";
      visibleContentId: string | null;
    }
  | {
      paneId: number;
      surfaceId: string;
      type: "event.surface_resumed";
    };

export type SurfAceRuntimeOptions = {
  discovery?: SurfAceDiscoveryService;
  drawingFlushConfig?: DrawingFlushConfig;
  eventProfile?: EventProfile;
  logger?: SurfAceLogger;
  now?: () => number;
  providerName?: string;
  stateDir?: string;
};

export interface SurfAceRuntime {
  annotateRemove(input: SurfAceAnnotateRemoveInput): Promise<SurfAceAnnotateRemoveResult>;
  clear(input: { fingerprint: string; paneId: number }): Promise<SurfAceClearResult>;
  listScreens(): Promise<SurfAceScreenSummary[]>;
  push(input: SurfAcePushInput, context?: { sessionKey?: string }): Promise<SurfAcePushResult>;
  read(input: { fingerprint: string; paneId: number }): Promise<SurfAceReadResult>;
  snapshot(input: { fingerprint: string; paneId: number }): Promise<SurfAceSnapshotResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (event: SurfAceLocalEvent) => void): () => void;
}

type MutablePaneBuffer = {
  alertFired: boolean;
  alertFiredAt: number | null;
  closedFrames: SurfAceFrame[];
  currentUrl: string | null;
  liveDirtyStrokeIds: string[];
  liveFrame: SurfAceFrame | null;
  liveSeq: number;
  overflowed: boolean;
  page: SurfAceReadResult["page"];
  playbackPosition: number | null;
  playbackState: SurfAceReadResult["playbackState"];
  scrollPosition: SurfAceReadResult["scrollPosition"];
  selection: SurfAceReadResult["selection"];
  taps: SurfAceReadResult["taps"];
  lastNavigation: SurfAceReadResult["lastNavigation"];
};

type CachedSnapshot = NonNullable<SurfAceSnapshotResult["snapshot"]> & {
  cachedAt: number;
};

type ManagedPane = {
  activeContentId: ContentId | null;
  contentType: ContentType | null;
  currentRevision: Revision;
  historySummary: SurfAceHistorySummary;
  name: string | null;
  ownerSessionKey: string | null;
  paneId: PaneId;
  pendingOwnerSessionKey: string | null;
  remotePaneId: PaneId;
  snapshot: CachedSnapshot | null;
  viewport: SurfaceViewport;
  buffer: MutablePaneBuffer;
};

type ManagedSurface = {
  client: SurfAceWireClient | null;
  connectionState: SurfAceConnectionState;
  endpoint: SurfAceDiscoveryEndpoint;
  endpointId: string;
  forceTakeoverOnNextPair: boolean;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  heartbeatMisses: number;
  heartbeatNonce: string | null;
  lastSeenAt: number;
  name: string;
  paneIdsNeedingSnapshot: Set<number>;
  panes: Map<number, ManagedPane>;
  recentEventIds: string[];
  recentEventIdsSet: Set<string>;
  reconnectAttempt: number;
  sessionId: SessionId | null;
  snapshotBufferedEvents: Event[];
  snapshotSyncInFlight: boolean;
  stopRequested: boolean;
  surfaceId: SurfaceId;
  unreachableFailures: number;
  viewport: SurfaceViewport;
  windowLabel: string;
  workPromise: Promise<void> | null;
};

type RuntimeStateFile = {
  nextPaneId: number;
  nextWindowLabelIndex: number;
  providerId: string;
  version: 1;
  windowLabels: Record<string, string>;
};

const DEFAULT_DRAWING_FLUSH_CONFIG: DrawingFlushConfig = {
  idleWindowMs: 8_000,
  maxIntervalMs: 30_000,
};
const DEFAULT_VIEWPORT: SurfaceViewport = { width: 0, height: 0, scale: 1 };
const MAX_BUFFERED_TAPS = 512;
const MAX_EVENT_DEDUP = 1024;
const MAX_PENDING_EVENTS_DURING_SNAPSHOT = 128;
const MAX_READ_FRAME_BATCH = 5;
const MAX_READ_FRAME_IMAGE_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const UNREACHABLE_AFTER_FAILURES = 3;
const ALERT_RESET_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ALERT_SESSION_KEY = "agent:main:main";
const ALERT_ENDPOINT_URL = "http://localhost:18800/alert";
const STATE_FILE_NAME = "surf-ace-runtime-state.json";

export class SurfAceToolError extends Error {
  constructor(
    readonly code:
      | "content_too_large"
      | "internal_error"
      | "not_connected"
      | "screen_not_found"
      | "stale_content"
      | "unsupported_content_type"
      | "render_failed"
      | "busy"
      | "invalid_operation"
      | "rate_limited"
      | "stale_revision"
      | "unsupported_operation_for_content_type",
    message: string,
  ) {
    super(message);
    this.name = "SurfAceToolError";
  }
}

function asEpochMs(value: number): EpochMs {
  return value as EpochMs;
}

function asPaneId(value: number): PaneId {
  return value as PaneId;
}

function asRevision(value: number): Revision {
  return value as Revision;
}

function asSurfaceId(value: string): SurfaceId {
  return value as SurfaceId;
}

function asSessionId(value: string): SessionId {
  return value as SessionId;
}

function makeBrandedRequestId(): RequestId {
  return `rq_${randomUUID().replaceAll("-", "")}`.slice(0, 48) as RequestId;
}

function makeConnectionId(): ConnectionId {
  return `cn_${randomUUID().replaceAll("-", "")}`.slice(0, 32) as ConnectionId;
}

function makeProviderId(value: string): ProviderId {
  return value as ProviderId;
}

function makeContentId(): ContentId {
  return `ct_${randomBytes(4).toString("hex")}` as ContentId;
}

function makeFrameId(): string {
  return `fr_${randomBytes(4).toString("hex")}`;
}

function makeNonce(): string {
  return randomUUID().replaceAll("-", "");
}

function buildWsUrl(endpoint: SurfAceDiscoveryEndpoint): string {
  return `ws://${endpoint.host}:${endpoint.port}${endpoint.wsPath}`;
}

function cloneViewport(viewport: SurfaceViewport): SurfaceViewport {
  return { ...viewport };
}

function createPaneBuffer(): MutablePaneBuffer {
  return {
    alertFired: false,
    alertFiredAt: null,
    closedFrames: [],
    currentUrl: null,
    lastNavigation: null,
    liveDirtyStrokeIds: [],
    liveFrame: null,
    liveSeq: 0,
    overflowed: false,
    page: null,
    playbackPosition: null,
    playbackState: null,
    scrollPosition: null,
    selection: null,
    taps: [],
  };
}

function createPane(
  paneId: PaneId,
  remotePaneId: PaneId = paneId,
  viewport: SurfaceViewport = DEFAULT_VIEWPORT,
): ManagedPane {
  return {
    activeContentId: null,
    buffer: createPaneBuffer(),
    contentType: null,
    currentRevision: asRevision(0),
    historySummary: {
      backCount: 0,
      forwardCount: 0,
      visibleContentId: null,
    },
    name: null,
    ownerSessionKey: null,
    paneId,
    pendingOwnerSessionKey: null,
    remotePaneId,
    snapshot: null,
    viewport: cloneViewport(viewport),
  };
}

function clampCloseReason(reason: string): string {
  return reason.slice(0, 123);
}

function convertSelection(selection: Selection): SurfAceReadResult["selection"] {
  if (!selection || selection.kind !== "text") {
    return null;
  }
  return {
    anchorEnd: null,
    anchorStart: null,
    bounds: selection.boundingRect,
    selectedText: selection.text,
  };
}

function cloneFrame(frame: SurfAceFrame | null): SurfAceFrame | null {
  if (!frame) {
    return null;
  }
  return structuredClone(frame);
}

function computeStrokeBBox(points: Stroke["points"]): SurfAceFrameStroke["bbox"] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return {
    height: maxY - minY,
    width: maxX - minX,
    x: minX,
    y: minY,
  };
}

function contentKey(contentType: ContentType, content: unknown): string {
  const hash = createHash("sha1");
  hash.update(contentType);
  hash.update(JSON.stringify(content));
  return hash.digest("hex");
}

function ensureDirectory(dirPath: string): Promise<void> {
  return fs.mkdir(dirPath, { recursive: true }).then(() => undefined);
}

function historyOwnerTokenForSession(sessionKey?: string): string {
  const hash = createHash("sha256");
  hash.update(sessionKey ?? "anonymous");
  return `hot_${hash.digest("hex").slice(0, 16)}`;
}

function isErrorResponse(response: Response): response is ErrorResponse {
  return (response as ErrorResponse).ok === false;
}

function mutationErrorCode(
  code: ErrorResponse["error"]["code"],
): SurfAceToolError["code"] {
  switch (code) {
    case "busy":
    case "content_too_large":
    case "invalid_operation":
    case "rate_limited":
    case "render_failed":
    case "stale_content":
    case "stale_revision":
    case "unsupported_content_type":
    case "unsupported_operation_for_content_type":
      return code;
    default:
      return "internal_error";
  }
}

function normalizeContent(
  contentType: ContentType,
  content: unknown,
): ContentSetRequest["payload"]["content"] {
  if (contentType === "html") {
    if (typeof content === "string") {
      return { html: content };
    }
    return content as ContentSetRequest["payload"]["content"];
  }
  if (contentType === "markdown") {
    if (typeof content === "string") {
      return { markdown: content };
    }
    return content as ContentSetRequest["payload"]["content"];
  }
  if (contentType === "pdf") {
    if (typeof content === "string") {
      return { data: content };
    }
    return content as ContentSetRequest["payload"]["content"];
  }
  if (contentType === "image") {
    if (typeof content === "string") {
      return { data: content, mediaType: "image/png" };
    }
    return content as ContentSetRequest["payload"]["content"];
  }
  if (contentType === "terminal") {
    if (typeof content === "string") {
      return {
        lines: content.split("\n"),
        scrollback: 0,
      };
    }
    return content as ContentSetRequest["payload"]["content"];
  }
  if (contentType === "canvas") {
    if (typeof content === "string") {
      if (!content.trim()) {
        return "";
      }
      try {
        return JSON.parse(content) as ContentSetRequest["payload"]["content"];
      } catch {
        return "";
      }
    }
    return content as ContentSetRequest["payload"]["content"];
  }
  return content as ContentSetRequest["payload"]["content"];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function windowLabelForIndex(index: number): string {
  let cursor = index + 1;
  let label = "";
  while (cursor > 0) {
    cursor -= 1;
    label = String.fromCharCode(97 + (cursor % 26)) + label;
    cursor = Math.floor(cursor / 26);
  }
  return label;
}

export class DefaultSurfAceRuntime implements SurfAceRuntime {
  private readonly discovery: SurfAceDiscoveryService;
  private readonly drawingFlushConfig: DrawingFlushConfig;
  private readonly eventProfile: EventProfile;
  private readonly listeners = new Set<(event: SurfAceLocalEvent) => void>();
  private readonly logger: SurfAceLogger;
  private readonly now: () => number;
  private readonly providerName?: string;
  private readonly stateDir: string;
  private readonly surfaces = new Map<string, ManagedSurface>();
  private persistentState: RuntimeStateFile = {
    nextPaneId: 1,
    nextWindowLabelIndex: 0,
    providerId: "",
    version: 1,
    windowLabels: {},
  };
  private started = false;
  private startPromise: Promise<void> | null = null;
  private stateWrite: Promise<void> = Promise.resolve();
  private readonly unsubscribeDiscovery: (() => void) | null;

  constructor(options: SurfAceRuntimeOptions = {}) {
    this.discovery = options.discovery ?? createBonjourSurfAceDiscoveryService({ logger: options.logger });
    this.drawingFlushConfig = options.drawingFlushConfig ?? DEFAULT_DRAWING_FLUSH_CONFIG;
    this.eventProfile = options.eventProfile ?? "minimum_deep";
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => Date.now());
    this.providerName = options.providerName;
    this.stateDir =
      options.stateDir ?? path.join(os.homedir(), ".surf-ace-openclaw-extension");
    this.unsubscribeDiscovery = this.discovery.subscribe((endpoints) => {
      void this.handleDiscoveryUpdate(endpoints);
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = (async () => {
      await ensureDirectory(this.stateDir);
      await this.loadState();
      await this.discovery.start();
      await this.handleDiscoveryUpdate(this.discovery.getSnapshot());
      this.started = true;
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.discovery.stop();
    this.unsubscribeDiscovery?.();

    const stopPromises = [...this.surfaces.values()].map(async (surface) => {
      surface.stopRequested = true;
      this.stopHeartbeat(surface);
      if (surface.client) {
        await surface.client.close(1000, clampCloseReason("provider_shutdown"));
      }
      await surface.workPromise;
    });

    await Promise.all(stopPromises);
    this.surfaces.clear();
  }

  subscribe(listener: (event: SurfAceLocalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async listScreens(): Promise<SurfAceScreenSummary[]> {
    await this.start();
    return [...this.surfaces.values()]
      .sort((left, right) => left.windowLabel.localeCompare(right.windowLabel, "en"))
      .map((surface) => ({
        connectionState: surface.connectionState,
        fingerprint: surface.surfaceId,
        lastSeenAt: surface.lastSeenAt,
        name: surface.name,
        panes: [...surface.panes.values()]
          .sort((left, right) => left.paneId - right.paneId)
          .map((pane) => ({
            activeContent: pane.activeContentId && pane.contentType
              ? {
                  contentId: pane.activeContentId,
                  contentType: pane.contentType,
                  revision: pane.currentRevision,
                }
              : null,
            historySummary: structuredClone(pane.historySummary),
            name: pane.name,
            paneId: pane.paneId,
          })),
        pendingEvents: this.pendingEventCount(surface),
        viewport: cloneViewport(surface.viewport),
      }));
  }

  async push(
    input: SurfAcePushInput,
    context?: { sessionKey?: string },
  ): Promise<SurfAcePushResult> {
    await this.start();
    const surface = this.requireConnectedSurface(input.fingerprint);
    return await this.contentSet(surface, input, context?.sessionKey);
  }

  async clear(input: { fingerprint: string; paneId: number }): Promise<SurfAceClearResult> {
    await this.start();
    const surface = this.requireConnectedSurface(input.fingerprint);
    return await this.contentClear(surface, input);
  }

  async read(input: { fingerprint: string; paneId: number }): Promise<SurfAceReadResult> {
    await this.start();
    const pane = this.requirePane(input.fingerprint, input.paneId);
    const returnedFrames: SurfAceFrame[] = [];
    let returnedImageBytes = 0;

    while (
      returnedFrames.length < MAX_READ_FRAME_BATCH &&
      pane.buffer.closedFrames.length > 0
    ) {
      const candidate = pane.buffer.closedFrames[0];
      const candidateBytes = Buffer.byteLength(candidate.image, "utf8");
      if (
        returnedFrames.length > 0 &&
        returnedImageBytes + candidateBytes > MAX_READ_FRAME_IMAGE_BYTES
      ) {
        break;
      }
      pane.buffer.closedFrames.shift();
      returnedFrames.push(structuredClone(candidate));
      returnedImageBytes += candidateBytes;
    }

    const result: SurfAceReadResult = {
      fingerprint: input.fingerprint,
      frames: returnedFrames,
      lastNavigation: pane.buffer.lastNavigation ? { ...pane.buffer.lastNavigation } : null,
      liveDirtyStrokeIds: [...pane.buffer.liveDirtyStrokeIds],
      liveFrame: cloneFrame(pane.buffer.liveFrame),
      liveSeq: pane.buffer.liveFrame ? pane.buffer.liveSeq : null,
      overflowed: pane.buffer.overflowed,
      page: pane.buffer.page ? { ...pane.buffer.page } : null,
      paneId: pane.paneId,
      pendingFrames: pane.buffer.closedFrames.length || undefined,
      playbackPosition: pane.buffer.playbackPosition,
      playbackState: pane.buffer.playbackState,
      readAt: this.now(),
      scrollPosition: pane.buffer.scrollPosition
        ? {
            visibleRect: { ...pane.buffer.scrollPosition.visibleRect },
            x: pane.buffer.scrollPosition.x,
            y: pane.buffer.scrollPosition.y,
          }
        : null,
      selection: pane.buffer.selection ? { ...pane.buffer.selection } : null,
      taps: structuredClone(pane.buffer.taps),
    };

    pane.buffer.alertFired = false;
    pane.buffer.alertFiredAt = null;
    pane.buffer.liveDirtyStrokeIds = [];
    pane.buffer.overflowed = false;
    pane.buffer.lastNavigation = null;
    pane.buffer.page = null;
    pane.buffer.scrollPosition = null;
    pane.buffer.selection = null;
    pane.buffer.taps = [];

    return result;
  }

  async snapshot(input: { fingerprint: string; paneId: number }): Promise<SurfAceSnapshotResult> {
    await this.start();
    const pane = this.requirePane(input.fingerprint, input.paneId);
    return {
      fingerprint: input.fingerprint,
      paneId: pane.paneId,
      snapshot: pane.snapshot ? structuredClone(pane.snapshot) : null,
    };
  }

  async annotateRemove(
    input: SurfAceAnnotateRemoveInput,
  ): Promise<SurfAceAnnotateRemoveResult> {
    await this.start();
    const surface = this.requireConnectedSurface(input.fingerprint);
    const pane = this.requirePane(input.fingerprint, input.paneId);

    const request: AnnotationsRemoveRequest = {
      id: makeBrandedRequestId(),
      op: "annotations.remove",
      payload: {
        contentId: input.contentId as ContentId,
        paneId: pane.remotePaneId,
        strokeIds: input.strokeIds.map((strokeId) => strokeId as StrokeId),
      },
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    };

    const response = await this.sendRequest(surface, request);
    if (isErrorResponse(response)) {
      throw new SurfAceToolError(
        mutationErrorCode(response.error.code),
        response.error.message,
      );
    }

    const payload = (response as AnnotationsRemoveResponse).payload;
    this.removeStrokesFromLiveState(pane, new Set(payload.removedStrokeIds));

    return {
      fingerprint: input.fingerprint,
      notFoundStrokeIds: [...payload.notFoundStrokeIds],
      paneId: pane.paneId,
      remainingStrokeCount: payload.remainingStrokeCount,
      removedStrokeIds: [...payload.removedStrokeIds],
    };
  }

  private async contentClear(
    surface: ManagedSurface,
    input: { fingerprint: string; paneId: number },
  ): Promise<SurfAceClearResult> {
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    this.finalizeLiveFrame(pane);

    const request: ContentClearRequest = {
      id: makeBrandedRequestId(),
      op: "content.clear",
      payload: {
        paneId: pane.remotePaneId,
        revision: asRevision((pane.currentRevision as number) + 1),
      },
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    };

    const response = await this.sendRequest(surface, request);
    return this.applyMutationResponse(surface, pane, response, request) as SurfAceClearResult;
  }

  private async contentSet(
    surface: ManagedSurface,
    input: SurfAcePushInput,
    sessionKey?: string,
  ): Promise<SurfAcePushResult> {
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    this.finalizeLiveFrame(pane);

    const nextContentId =
      sessionKey && pane.ownerSessionKey === sessionKey && pane.activeContentId
        ? pane.activeContentId
        : makeContentId();
    pane.pendingOwnerSessionKey = sessionKey ?? null;

    const request: ContentSetRequest = {
      id: makeBrandedRequestId(),
      op: "content.set",
      payload: {
        content: normalizeContent(input.contentType, input.content),
        contentId: nextContentId,
        contentType: input.contentType,
        historyOwnerToken: historyOwnerTokenForSession(sessionKey),
        paneId: pane.remotePaneId,
        revision: asRevision((pane.currentRevision as number) + 1),
      } as ContentSetRequest["payload"],
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    };

    const response = await this.sendRequest(surface, request);
    return this.applyMutationResponse(surface, pane, response, request, sessionKey, {
      contentHash: contentKey(input.contentType, request.payload.content),
    }) as SurfAcePushResult;
  }

  private emit(event: SurfAceLocalEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private finalizeLiveFrame(pane: ManagedPane): void {
    if (!pane.buffer.liveFrame) {
      return;
    }
    pane.buffer.closedFrames.push(structuredClone(pane.buffer.liveFrame));
    pane.buffer.liveFrame = null;
    pane.buffer.liveDirtyStrokeIds = [];
  }

  private maybeFireAnnotationAlert(surface: ManagedSurface, pane: ManagedPane): void {
    const now = this.now();
    if (
      pane.buffer.alertFired &&
      pane.buffer.alertFiredAt !== null &&
      now - pane.buffer.alertFiredAt < ALERT_RESET_TIMEOUT_MS
    ) {
      return;
    }

    pane.buffer.alertFired = true;
    pane.buffer.alertFiredAt = now;
    void this.postAnnotationAlert(`Surf Ace updates pending on ${surface.name}`);
  }

  private async postAnnotationAlert(message: string): Promise<void> {
    try {
      await fetch(ALERT_ENDPOINT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message,
          noOverlay: true,
          sessionKey: DEFAULT_ALERT_SESSION_KEY,
        }),
      });
    } catch {
      // Alert delivery is best-effort; unread state remains in the local buffer.
    }
  }

  private async handleDiscoveryUpdate(endpoints: SurfAceDiscoveryEndpoint[]): Promise<void> {
    for (const endpoint of endpoints) {
      await this.refreshEndpointTopology(endpoint);
    }

    const currentEndpointIds = new Set(endpoints.map((endpoint) => endpoint.endpointId));
    for (const surface of this.surfaces.values()) {
      if (!currentEndpointIds.has(surface.endpointId)) {
        surface.stopRequested = true;
        if (surface.client) {
          void surface.client.close(1000, clampCloseReason("provider_shutdown"));
        }
      }
    }
  }

  private handleNavigationEvent(surface: ManagedSurface, event: NavigationEvent): void {
    const pane = this.ensurePane(surface, event.payload.paneId);
    if (pane.contentType !== "html") {
      return;
    }
    pane.buffer.lastNavigation = {
      navigatedAt: event.sentAt,
      url: event.payload.url,
    };
    pane.buffer.currentUrl = event.payload.url;
    this.finalizeLiveFrame(pane);
  }

  private handlePaneCreatedEvent(surface: ManagedSurface, event: PaneCreatedEvent): void {
    const pane = this.ensurePane(surface, event.payload.paneId);
    pane.viewport = cloneViewport(surface.viewport);
  }

  private handlePaneRemovedEvent(surface: ManagedSurface, event: PaneRemovedEvent): void {
    const pane = this.findPaneByRemoteId(surface, event.payload.paneId);
    if (pane) {
      surface.panes.delete(pane.paneId);
    }
  }

  private handlePaneRenamedEvent(surface: ManagedSurface, event: PaneRenamedEvent): void {
    const pane = this.ensurePane(surface, event.payload.paneId);
    pane.name = event.payload.name ?? null;
  }

  private handlePageEvent(surface: ManagedSurface, event: PageEvent): void {
    const pane = this.ensurePane(surface, event.payload.paneId);
    pane.buffer.page = {
      pageCount: event.payload.totalPages,
      pageLabel: event.payload.pageText,
      pageNumber: event.payload.page,
    };
  }

  private handleScrollEvent(surface: ManagedSurface, event: ScrollEvent): void {
    const pane = this.ensurePane(surface, event.payload.paneId);
    pane.buffer.scrollPosition = {
      visibleRect: { ...event.payload.viewport.visibleRect },
      x: event.payload.viewport.scrollOffset.x,
      y: event.payload.viewport.scrollOffset.y,
    };
  }

  private handleSelectionEvent(surface: ManagedSurface, event: SelectionEvent): void {
    if (event.payload.selection && event.payload.selection.kind !== "text") {
      return;
    }
    const pane = this.ensurePane(surface, event.payload.paneId);
    pane.buffer.selection = convertSelection(event.payload.selection);
  }

  private handleSnapshotHintEvent(surface: ManagedSurface, _event: SnapshotHintEvent): void {
    void this.syncSurfaceSnapshots(surface);
  }

  private handleSurfaceAppearedEvent(
    sourceSurface: ManagedSurface,
    event: SurfaceAppearedEvent,
  ): void {
    const existing = this.surfaces.get(event.payload.surfaceId);
    const windowLabel = this.ensureWindowLabel(event.payload.surfaceId);
    const surface = existing ?? {
      client: null,
      connectionState: "connecting" as SurfAceConnectionState,
      endpoint: sourceSurface.endpoint,
      endpointId: sourceSurface.endpointId,
      forceTakeoverOnNextPair: false,
      heartbeatInterval: null,
      heartbeatMisses: 0,
      heartbeatNonce: null,
      lastSeenAt: this.now(),
      name: event.payload.name,
      paneIdsNeedingSnapshot: new Set<number>(),
      panes: new Map<number, ManagedPane>(),
      recentEventIds: [],
      recentEventIdsSet: new Set<string>(),
      reconnectAttempt: 0,
      sessionId: null,
      snapshotBufferedEvents: [],
      snapshotSyncInFlight: false,
      stopRequested: false,
      surfaceId: event.payload.surfaceId,
      unreachableFailures: 0,
      viewport: cloneViewport(event.payload.viewport),
      windowLabel,
      workPromise: null,
    };

    surface.endpoint = sourceSurface.endpoint;
    surface.endpointId = sourceSurface.endpointId;
    surface.lastSeenAt = this.now();
    surface.name = event.payload.name;
    surface.viewport = cloneViewport(event.payload.viewport);
    surface.windowLabel = windowLabel;
    this.surfaces.set(surface.surfaceId, surface);
    this.ensureSurfaceWorker(surface);
  }

  private handleSurfaceRemovedEvent(event: SurfaceRemovedEvent): void {
    const surface = this.surfaces.get(event.payload.surfaceId);
    if (!surface) {
      return;
    }
    surface.stopRequested = true;
    if (surface.client) {
      void surface.client.close(1000, clampCloseReason("provider_shutdown"));
    }
    this.surfaces.delete(event.payload.surfaceId);
  }

  private handleSurfaceResumedEvent(surface: ManagedSurface, event: SurfaceResumedEvent): void {
    this.emit({
      paneId: 0,
      surfaceId: event.payload.surfaceId,
      type: "event.surface_resumed",
    });
    void this.refreshEndpointTopology(surface.endpoint);
    void this.syncSurfaceSnapshots(surface);
  }

  private handleTapEvent(surface: ManagedSurface, event: TapEvent): void {
    const pane = this.ensurePane(surface, event.payload.paneId);
    pane.buffer.taps.push({
      eventId: event.eventId,
      kind: event.payload.kind,
      nearestText: event.payload.nearestContent,
      timestamp: event.sentAt,
      x: event.payload.position.x,
      y: event.payload.position.y,
    });

    if (pane.buffer.taps.length > MAX_BUFFERED_TAPS) {
      pane.buffer.taps.splice(0, pane.buffer.taps.length - MAX_BUFFERED_TAPS);
      pane.buffer.overflowed = true;
    }
  }

  private handleWireEvent(surface: ManagedSurface, event: Event): void {
    if (surface.snapshotSyncInFlight) {
      surface.snapshotBufferedEvents.push(event);
      if (surface.snapshotBufferedEvents.length > MAX_PENDING_EVENTS_DURING_SNAPSHOT) {
        surface.snapshotBufferedEvents.shift();
      }
      return;
    }

    if (surface.recentEventIdsSet.has(event.eventId)) {
      return;
    }
    surface.recentEventIdsSet.add(event.eventId);
    surface.recentEventIds.push(event.eventId);
    if (surface.recentEventIds.length > MAX_EVENT_DEDUP) {
      const removed = surface.recentEventIds.shift();
      if (removed) {
        surface.recentEventIdsSet.delete(removed);
      }
    }

    switch (event.op) {
      case "event.drawing_flush":
        this.ingestDrawingFlush(surface, event);
        break;
      case "event.navigation":
        this.handleNavigationEvent(surface, event);
        break;
      case "event.page":
        this.handlePageEvent(surface, event);
        break;
      case "event.pane_created":
        this.handlePaneCreatedEvent(surface, event);
        break;
      case "event.pane_removed":
        this.handlePaneRemovedEvent(surface, event);
        break;
      case "event.pane_renamed":
        this.handlePaneRenamedEvent(surface, event);
        break;
      case "event.scroll":
        this.handleScrollEvent(surface, event);
        break;
      case "event.selection":
        this.handleSelectionEvent(surface, event);
        break;
      case "event.snapshot_hint":
        this.handleSnapshotHintEvent(surface, event);
        break;
      case "event.surface_appeared":
        this.handleSurfaceAppearedEvent(surface, event);
        break;
      case "event.surface_removed":
        this.handleSurfaceRemovedEvent(event);
        break;
      case "event.surface_resumed":
        this.handleSurfaceResumedEvent(surface, event);
        break;
      case "event.tap":
        this.handleTapEvent(surface, event);
        break;
    }
  }

  private ingestDrawingFlush(surface: ManagedSurface, event: DrawingFlushEvent): void {
    const pane = this.ensurePane(surface, event.payload.paneId);
    const contextKey = pane.buffer.currentUrl ?? event.payload.contentId;
    const now = this.now();
    if (!pane.buffer.liveFrame || pane.buffer.liveFrame.contextKey !== contextKey) {
      const snapshot = pane.snapshot;
      pane.buffer.liveFrame = {
        contentId: event.payload.contentId,
        contextKey,
        frameId: makeFrameId(),
        image: snapshot?.image ?? "",
        openedAt: event.payload.firstStrokeAt,
        scrollOffset: snapshot?.viewport.scrollOffset ?? { x: 0, y: 0 },
        strokes: [],
        updatedAt: event.payload.lastStrokeAt,
        url: pane.buffer.currentUrl ?? undefined,
        viewport: pane.viewport,
      };
    }

    const liveFrame = pane.buffer.liveFrame;
    for (const stroke of event.payload.strokes) {
      liveFrame.strokes.push({
        bbox: computeStrokeBBox(stroke.points),
        endedAt:
          stroke.points[stroke.points.length - 1]?.timestamp ??
          event.payload.lastStrokeAt,
        points: stroke.points.map((point) => ({
          pressure: point.pressure,
          timestamp: point.timestamp,
          x: point.x,
          y: point.y,
        })),
        startedAt: stroke.points[0]?.timestamp ?? event.payload.firstStrokeAt,
        strokeId: stroke.strokeId,
      });
      pane.buffer.liveDirtyStrokeIds.push(stroke.strokeId);
    }

    liveFrame.updatedAt = event.payload.lastStrokeAt || now;
    pane.buffer.liveSeq += 1;
    this.maybeFireAnnotationAlert(surface, pane);
  }

  private ensurePane(surface: ManagedSurface, remotePaneId: PaneId): ManagedPane {
    const existing = this.findPaneByRemoteId(surface, remotePaneId);
    if (existing) {
      return existing;
    }
    const paneId = this.allocatePaneId();
    const created = createPane(paneId, remotePaneId, surface.viewport);
    surface.panes.set(created.paneId, created);
    return created;
  }

  private ensureInitialPairPane(surface: ManagedSurface): PaneId {
    const existingPaneIds = [...surface.panes.keys()].sort((left, right) => left - right);
    const paneId = existingPaneIds[0] ? asPaneId(existingPaneIds[0]) : this.allocatePaneId();
    if (!surface.panes.has(paneId)) {
      surface.panes.set(paneId, createPane(paneId, paneId, surface.viewport));
    }
    return paneId;
  }

  private findPaneByRemoteId(surface: ManagedSurface, remotePaneId: PaneId): ManagedPane | null {
    for (const pane of surface.panes.values()) {
      if (pane.remotePaneId === remotePaneId) {
        return pane;
      }
    }
    return null;
  }

  private ensureSurfaceWorker(surface: ManagedSurface): void {
    if (surface.workPromise) {
      return;
    }
    surface.stopRequested = false;
    surface.workPromise = this.runSurfaceWorker(surface).finally(() => {
      surface.workPromise = null;
    });
  }

  private ensureWindowLabel(surfaceId: string): string {
    const existing = this.persistentState.windowLabels[surfaceId];
    if (existing) {
      return existing;
    }
    const label = windowLabelForIndex(this.persistentState.nextWindowLabelIndex);
    this.persistentState.nextWindowLabelIndex += 1;
    this.persistentState.windowLabels[surfaceId] = label;
    void this.persistState();
    return label;
  }

  private allocatePaneId(): PaneId {
    const paneId = asPaneId(this.persistentState.nextPaneId);
    this.persistentState.nextPaneId += 1;
    void this.persistState();
    return paneId;
  }

  private async loadState(): Promise<void> {
    const statePath = path.join(this.stateDir, STATE_FILE_NAME);
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as RuntimeStateFile;
      if (parsed.version === 1) {
        this.persistentState = parsed;
      }
    } catch {
      this.persistentState.providerId = `pv_${randomUUID().replaceAll("-", "")}`;
      await this.persistState();
      return;
    }

    if (!this.persistentState.providerId) {
      this.persistentState.providerId = `pv_${randomUUID().replaceAll("-", "")}`;
      await this.persistState();
    }
  }

  private pendingEventCount(surface: ManagedSurface): number {
    let total = surface.snapshotBufferedEvents.length;
    for (const pane of surface.panes.values()) {
      total += pane.buffer.closedFrames.length;
      total += pane.buffer.liveDirtyStrokeIds.length;
      total += pane.buffer.taps.length;
      total += pane.buffer.lastNavigation ? 1 : 0;
      total += pane.buffer.page ? 1 : 0;
      total += pane.buffer.scrollPosition ? 1 : 0;
      total += pane.buffer.selection ? 1 : 0;
    }
    return total;
  }

  private async persistState(): Promise<void> {
    const statePath = path.join(this.stateDir, STATE_FILE_NAME);
    this.stateWrite = this.stateWrite
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(statePath, JSON.stringify(this.persistentState, null, 2));
      });
    await this.stateWrite;
  }

  private providerId(): ProviderId {
    return makeProviderId(this.persistentState.providerId);
  }

  private removeStrokesFromLiveState(pane: ManagedPane, removedStrokeIds: Set<string>): void {
    if (pane.buffer.liveFrame) {
      pane.buffer.liveFrame.strokes = pane.buffer.liveFrame.strokes.filter(
        (stroke) => !removedStrokeIds.has(stroke.strokeId),
      );
    }
    pane.buffer.liveDirtyStrokeIds = pane.buffer.liveDirtyStrokeIds.filter(
      (strokeId) => !removedStrokeIds.has(strokeId),
    );
    if (pane.snapshot?.drawings) {
      pane.snapshot.drawings = pane.snapshot.drawings.filter(
        (stroke) => !removedStrokeIds.has(stroke.strokeId),
      );
    }
  }

  private requireConnectedSurface(fingerprint: string): ManagedSurface {
    const surface = this.surfaces.get(fingerprint);
    if (!surface) {
      throw new SurfAceToolError("screen_not_found", `Unknown Surf Ace surface: ${fingerprint}`);
    }
    if (surface.connectionState !== "connected" || !surface.client) {
      throw new SurfAceToolError(
        "not_connected",
        `Surf Ace surface is not connected: ${fingerprint}`,
      );
    }
    return surface;
  }

  private requirePane(fingerprint: string, paneId: number): ManagedPane {
    const surface = this.surfaces.get(fingerprint);
    if (!surface) {
      throw new SurfAceToolError("screen_not_found", `Unknown Surf Ace surface: ${fingerprint}`);
    }
    const pane = surface.panes.get(paneId as PaneId);
    if (!pane) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Unknown Surf Ace pane ${paneId} on ${fingerprint}`,
      );
    }
    return pane;
  }

  private async refreshEndpointTopology(endpoint: SurfAceDiscoveryEndpoint): Promise<void> {
    let response: SurfacesListResponse | null = null;
    const client = new SurfAceWireClient(buildWsUrl(endpoint));
    try {
      await client.connect(REQUEST_TIMEOUT_MS);
      response = (await client.request(
        this.requestEnvelope("surfaces.list"),
        REQUEST_TIMEOUT_MS,
      )) as SurfacesListResponse;
    } catch (error) {
      this.logger.warn?.(
        `[surf-ace:runtime] surfaces.list failed for ${endpoint.host}:${endpoint.port}: ${String(error)}`,
      );
    } finally {
      await client.close(1000, clampCloseReason("provider_shutdown")).catch(() => {});
    }

    if (!response || isErrorResponse(response)) {
      return;
    }

    const seenSurfaceIds = new Set<string>();
    for (const summary of response.payload.surfaces) {
      seenSurfaceIds.add(summary.surfaceId);
      const existing = this.surfaces.get(summary.surfaceId);
      const windowLabel = this.ensureWindowLabel(summary.surfaceId);
      const surface: ManagedSurface = existing ?? {
        client: null,
        connectionState: "connecting",
        endpoint,
        endpointId: endpoint.endpointId,
        forceTakeoverOnNextPair: false,
        heartbeatInterval: null,
        heartbeatMisses: 0,
        heartbeatNonce: null,
        lastSeenAt: this.now(),
        name: summary.name,
        paneIdsNeedingSnapshot: new Set<number>(),
        panes: new Map<number, ManagedPane>(),
        recentEventIds: [],
        recentEventIdsSet: new Set<string>(),
        reconnectAttempt: 0,
        sessionId: null,
        snapshotBufferedEvents: [],
        snapshotSyncInFlight: false,
        stopRequested: false,
        surfaceId: summary.surfaceId,
        unreachableFailures: 0,
        viewport: cloneViewport(summary.viewport),
        windowLabel,
        workPromise: null,
      };

      surface.endpoint = endpoint;
      surface.endpointId = endpoint.endpointId;
      surface.lastSeenAt = this.now();
      surface.name = summary.name;
      surface.viewport = cloneViewport(summary.viewport);
      surface.windowLabel = windowLabel;
      this.surfaces.set(summary.surfaceId, surface);
      this.ensureSurfaceWorker(surface);
    }

    for (const surface of this.surfaces.values()) {
      if (surface.endpointId === endpoint.endpointId && !seenSurfaceIds.has(surface.surfaceId)) {
        surface.stopRequested = true;
      }
    }
  }

  private async requestPair(surface: ManagedSurface): Promise<PairResponse> {
    const client = surface.client;
    if (!client) {
      throw new Error("pair_without_client");
    }
    const initialPaneId = this.ensureInitialPairPane(surface);

    const buildPairRequest = (takeover: boolean): PairRequest => ({
      id: makeBrandedRequestId(),
      op: "pair.request",
      payload: {
        connectionId: makeConnectionId(),
        drawingFlushConfig: this.drawingFlushConfig,
        eventProfile: this.eventProfile,
        initialPaneId,
        protocolVersion: 1,
        providerId: this.providerId(),
        providerName: this.providerName,
        resume: surface.sessionId ? { sessionId: surface.sessionId } : undefined,
        surfaceId: surface.surfaceId,
        takeover,
        windowLabel: surface.windowLabel,
      },
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    });

    let response = await client.request(
      buildPairRequest(surface.forceTakeoverOnNextPair),
      REQUEST_TIMEOUT_MS,
    );

    if (isErrorResponse(response) && response.error.code === "busy" && surface.sessionId) {
      response = await client.request(buildPairRequest(true), REQUEST_TIMEOUT_MS);
    }

    if (isErrorResponse(response)) {
      throw new SurfAceToolError(mutationErrorCode(response.error.code), response.error.message);
    }

    return response as PairResponse;
  }

  private requestEnvelope<TOp extends Request["op"]>(
    op: TOp,
    payload?: Extract<Request, { op: TOp }> extends { payload: infer TPayload } ? TPayload : never,
  ): Extract<Request, { op: TOp }> {
    return {
      id: makeBrandedRequestId(),
      op,
      payload: (payload ?? {}) as never,
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    } as unknown as Extract<Request, { op: TOp }>;
  }

  private async runSurfaceWorker(surface: ManagedSurface): Promise<void> {
    while (!surface.stopRequested) {
      surface.connectionState = surface.unreachableFailures >= UNREACHABLE_AFTER_FAILURES
        ? "unreachable"
        : "connecting";

      try {
        surface.client = new SurfAceWireClient(buildWsUrl(surface.endpoint), {
          onClose: (_code) => {
            this.stopHeartbeat(surface);
            surface.connectionState =
              surface.unreachableFailures >= UNREACHABLE_AFTER_FAILURES
                ? "unreachable"
                : "connecting";
            surface.forceTakeoverOnNextPair = true;
          },
          onEvent: (event) => {
            this.handleWireEvent(surface, event);
          },
        });

        await surface.client.connect(REQUEST_TIMEOUT_MS);
        const pairResponse = await this.requestPair(surface);
        surface.sessionId = asSessionId(pairResponse.payload.sessionId);
        surface.connectionState = "connected";
        surface.reconnectAttempt = 0;
        surface.unreachableFailures = 0;
        surface.forceTakeoverOnNextPair = false;
        this.applyPairState(surface, pairResponse);
        this.startHeartbeat(surface);
        await this.syncSurfaceSnapshots(surface, true);
        await surface.client.waitForClose();
      } catch (error) {
        surface.unreachableFailures += 1;
        if (surface.connectionState !== "connected") {
          surface.connectionState =
            surface.unreachableFailures >= UNREACHABLE_AFTER_FAILURES
              ? "unreachable"
              : "connecting";
        }
        this.logger.warn?.(
          `[surf-ace:runtime] worker error for ${surface.surfaceId}: ${String(error)}`,
        );
      } finally {
        this.stopHeartbeat(surface);
        surface.client = null;
      }

      if (surface.stopRequested) {
        break;
      }

      const attempt = surface.reconnectAttempt;
      surface.reconnectAttempt += 1;
      const delay = Math.min(30_000, 500 * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(delay + jitter);
    }
  }

  private sendRequest(surface: ManagedSurface, request: Request): Promise<Response> {
    if (!surface.client) {
      throw new SurfAceToolError("not_connected", `Surf Ace surface is not connected: ${surface.surfaceId}`);
    }
    return surface.client.request(request, REQUEST_TIMEOUT_MS);
  }

  private startHeartbeat(surface: ManagedSurface): void {
    this.stopHeartbeat(surface);
    if (!surface.client) {
      return;
    }

    surface.heartbeatInterval = setInterval(() => {
      if (!surface.client) {
        return;
      }
      if (surface.heartbeatNonce) {
        surface.heartbeatMisses += 1;
        if (surface.heartbeatMisses >= 2) {
          surface.forceTakeoverOnNextPair = true;
          void surface.client.close(1000, clampCloseReason("provider_shutdown"));
          return;
        }
      }

      const nonce = makeNonce();
      surface.heartbeatNonce = nonce;
      const request: HeartbeatPingRequest = {
        id: makeBrandedRequestId(),
        op: "heartbeat.ping",
        payload: { nonce },
        sentAt: asEpochMs(this.now()),
        type: "request",
        v: 1,
      };

      void surface.client.request(request, REQUEST_TIMEOUT_MS).then((response) => {
        if (isErrorResponse(response)) {
          return;
        }
        const pong = response as HeartbeatPongResponse;
        if (pong.payload.nonce === nonce) {
          surface.heartbeatMisses = 0;
          surface.heartbeatNonce = null;
        }
      }).catch(() => {
        surface.heartbeatMisses += 1;
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(surface: ManagedSurface): void {
    if (surface.heartbeatInterval) {
      clearInterval(surface.heartbeatInterval);
      surface.heartbeatInterval = null;
    }
    surface.heartbeatMisses = 0;
    surface.heartbeatNonce = null;
  }

  private async syncPaneTopology(surface: ManagedSurface): Promise<void> {
    const response = await this.sendRequest(
      surface,
      this.requestEnvelope("panes.list"),
    );

    if (isErrorResponse(response)) {
      throw new SurfAceToolError(mutationErrorCode(response.error.code), response.error.message);
    }

    const payload = (response as PanesListResponse).payload;
    const seenRemotePaneIds = new Set<number>();
    for (const paneSummary of payload.panes) {
      seenRemotePaneIds.add(paneSummary.paneId);
      const pane = this.ensurePane(surface, paneSummary.paneId);
      pane.name = paneSummary.name;
      pane.viewport = cloneViewport(paneSummary.viewport);
      if (paneSummary.activeContentId) {
        pane.activeContentId = paneSummary.activeContentId;
        pane.historySummary.visibleContentId = paneSummary.activeContentId;
      }
      pane.contentType = paneSummary.contentType;
    }

    for (const pane of [...surface.panes.values()]) {
      if (!seenRemotePaneIds.has(pane.remotePaneId)) {
        surface.panes.delete(pane.paneId);
      }
    }
  }

  private async syncSurfaceSnapshots(
    surface: ManagedSurface,
    force = false,
  ): Promise<void> {
    if (!surface.client || (surface.snapshotSyncInFlight && !force)) {
      return;
    }

    surface.snapshotSyncInFlight = true;
    try {
      await this.syncPaneTopology(surface);
      const panes = [...surface.panes.values()];
      for (const pane of panes) {
        const response = await this.sendRequest(
          surface,
          this.requestEnvelope("snapshot.get", {
            includeDrawings: true,
            includeImage: true,
            includeVisibleText: true,
            paneId: pane.remotePaneId,
          }),
        );

        if (isErrorResponse(response)) {
          throw new SurfAceToolError(
            mutationErrorCode(response.error.code),
            response.error.message,
          );
        }

        this.applySnapshot(surface, pane, response as SnapshotResponse);
      }
    } catch (error) {
      if (surface.client) {
        await surface.client.close(1000, clampCloseReason("provider_shutdown")).catch(() => {});
      }
      throw error;
    } finally {
      surface.snapshotSyncInFlight = false;
      const buffered = [...surface.snapshotBufferedEvents];
      surface.snapshotBufferedEvents = [];
      for (const event of buffered) {
        this.handleWireEvent(surface, event);
      }
    }
  }

  private applyPairState(surface: ManagedSurface, response: PairResponse): void {
    surface.name = response.payload.surfaceName;
    surface.viewport = cloneViewport(response.payload.viewport);
    for (const paneState of response.payload.state.panes) {
      const pane = this.ensurePane(surface, paneState.paneId);
      pane.activeContentId = paneState.currentContentId;
      pane.contentType = paneState.contentType;
      pane.currentRevision = paneState.currentRevision;
      pane.historySummary.visibleContentId = paneState.currentContentId;
    }
  }

  private applySnapshot(
    _surface: ManagedSurface,
    pane: ManagedPane,
    response: SnapshotResponse,
  ): void {
    const payload = response.payload;
    pane.activeContentId = payload.contentId;
    pane.contentType = payload.contentType;
    pane.currentRevision = payload.revision;
    pane.historySummary.visibleContentId = payload.contentId;
    pane.snapshot = {
      cachedAt: this.now(),
      contentId: payload.contentId,
      contentType: payload.contentType,
      drawings: payload.drawings ? structuredClone(payload.drawings) : undefined,
      image: payload.image,
      revision: payload.revision,
      selection: payload.selection,
      viewport: structuredClone(payload.viewport),
      visibleText: payload.visibleText,
    };
    pane.buffer.selection = convertSelection(payload.selection);
    pane.buffer.scrollPosition = {
      visibleRect: { ...payload.viewport.visibleRect },
      x: payload.viewport.scrollOffset.x,
      y: payload.viewport.scrollOffset.y,
    };
  }

  private applyMutationResponse(
    surface: ManagedSurface,
    pane: ManagedPane,
    response: Response,
    request: ContentClearRequest | ContentSetRequest,
    sessionKey?: string,
    extras?: { contentHash?: string },
  ): SurfAcePushResult | SurfAceClearResult {
    if (isErrorResponse(response)) {
      pane.pendingOwnerSessionKey = null;
      throw new SurfAceToolError(
        mutationErrorCode(response.error.code),
        response.error.message,
      );
    }

    const payload = (response as MutationAckResponse).payload;
    const previousOwner = pane.ownerSessionKey;
    const nextOwner = pane.pendingOwnerSessionKey ?? sessionKey ?? null;
    const contentChangeOp = request.op === "content.set";

    if (contentChangeOp && previousOwner && nextOwner && previousOwner !== nextOwner) {
      pane.historySummary.backCount += pane.historySummary.visibleContentId ? 1 : 0;
      pane.historySummary.forwardCount = 0;
      this.emit({
        paneId: pane.paneId,
        previousSessionKey: previousOwner,
        surfaceId: surface.surfaceId,
        type: "event.content_superseded",
        visibleContentId: pane.historySummary.visibleContentId,
      });
    }

    if (request.op === "content.clear") {
      pane.activeContentId = null;
      pane.contentType = null;
      pane.ownerSessionKey = null;
      pane.snapshot = pane.snapshot
        ? {
            ...pane.snapshot,
            contentId: null,
            contentType: null,
            drawings: [],
            revision: payload.currentRevision,
            visibleText: "",
          }
        : null;
      pane.buffer.liveFrame = null;
      pane.buffer.liveDirtyStrokeIds = [];
      pane.historySummary.visibleContentId = null;
    } else {
      pane.activeContentId = payload.currentContentId;
      pane.contentType =
        request.op === "content.set"
          ? request.payload.contentType
          : pane.contentType;
      pane.ownerSessionKey = nextOwner;
      pane.historySummary.visibleContentId = payload.currentContentId;
      if (pane.snapshot && request.op === "content.set") {
        pane.snapshot.contentId = payload.currentContentId;
        pane.snapshot.contentType = request.payload.contentType;
        pane.snapshot.drawings = [];
        pane.snapshot.revision = payload.currentRevision;
        if (extras?.contentHash) {
          pane.buffer.currentUrl =
            request.payload.contentType === "html"
              ? `content://${extras.contentHash}`
              : null;
        }
      }
    }

    pane.pendingOwnerSessionKey = null;
    pane.currentRevision = payload.currentRevision;

    if (request.op === "content.clear") {
      return {
        fingerprint: surface.surfaceId,
        paneId: pane.paneId,
        revision: payload.currentRevision,
      };
    }

    return {
      contentId: payload.currentContentId as string,
      fingerprint: surface.surfaceId,
      paneId: pane.paneId,
      revision: payload.currentRevision,
    };
  }
}

export function createSurfAceRuntime(options: SurfAceRuntimeOptions = {}): SurfAceRuntime {
  return new DefaultSurfAceRuntime(options);
}
