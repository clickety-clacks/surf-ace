import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
  SurfacesListResponse,
  SurfaceViewport,
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
  windowLabel: string;
  _debug?: {
    autoRetryEnabled: boolean;
    endpointId: string;
    hasPairedInGatewaySession: boolean;
    reconnectAttempt: number;
    sessionId: string | null;
    unreachableFailures: number;
    wsOpen: boolean;
  };
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

export type SurfAceRelinquishResult = {
  relinquished: true;
};

export type SurfAceSplitInput = {
  count: number;
  direction: "horizontal" | "vertical";
  fingerprint: string;
  paneId: number;
};

export type SurfAceSplitResult = Array<{
  paneId: number;
}>;

export type SurfAceClosePaneResult = {
  ok: true;
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
  closePane(input: { fingerprint: string; paneId: number }): Promise<SurfAceClosePaneResult>;
  listScreens(): Promise<SurfAceScreenSummary[]>;
  push(input: SurfAcePushInput, context?: { sessionKey?: string }): Promise<SurfAcePushResult>;
  read(input: { fingerprint: string; paneId: number }): Promise<SurfAceReadResult>;
  relinquish(input: { fingerprint: string }): Promise<SurfAceRelinquishResult>;
  split(input: SurfAceSplitInput): Promise<SurfAceSplitResult>;
  snapshot(input: { fingerprint: string; paneId: number }): Promise<SurfAceSnapshotResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (event: SurfAceLocalEvent) => void): () => void;
}

type MutablePaneBuffer = {
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
  alertFired: boolean;
  alertFiredAt: number | null;
  autoRetryEnabled: boolean;
  client: SurfAceWireClient | null;
  connectionState: SurfAceConnectionState;
  consecutiveResumeFailures: number;
  connectedAt: number | null;
  endpoint: SurfAceDiscoveryEndpoint;
  endpointId: string;
  fingerprintPrefix: string;
  hasPairedInGatewaySession: boolean;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  heartbeatMisses: number;
  heartbeatNonce: string | null;
  lastSeenAt: number;
  name: string;
  paneIdsNeedingSnapshot: Set<number>;
  panes: Map<number, ManagedPane>;
  recentEventIds: string[];
  recentEventIdsSet: Set<string>;
  reclaimTakeoverOnBusy: boolean;
  reconnectAttempt: number;
  retryDelayResolver: (() => void) | null;
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
const LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
const LEASE_STALE_THRESHOLD_MS = 90_000;
const RECONNECT_BACKOFF_BASE_MS = 2_000;
const RECONNECT_BACKOFF_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_RESET_MS = 30_000;
const MIN_STABLE_FOR_RECLAIM_MS = 5_000;
const UNREACHABLE_AFTER_FAILURES = 3;
const ALERT_RESET_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ALERT_SESSION_KEY = "agent:main:main";
const ALERT_ENDPOINT_URL = "http://localhost:18800/alert";
const INITIAL_PAIR_PANE_ID = 1 as PaneId;
const MAX_CONSECUTIVE_RESUME_FAILURES = 3;
const STATE_FILE_NAME = "surf-ace-runtime-state.json";
const RUNTIME_LEASE_FILE_NAME = "surf-ace-runtime-owner.lock";

export class SurfAceToolError extends Error {
  constructor(
    readonly code:
      | "content_too_large"
      | "internal_error"
      | "not_connected"
      | "not_lock_owner"
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

function makeProvisionalSurfaceId(endpointId: string): SurfaceId {
  const digest = createHash("sha256").update(endpointId).digest("hex").slice(0, 16);
  return `sf_disc_${digest}` as SurfaceId;
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
    case "not_lock_owner":
    case "stale_content":
    case "stale_revision":
    case "unsupported_content_type":
    case "unsupported_operation_for_content_type":
      return code;
    default:
      return "internal_error";
  }
}

function isResumeSessionMismatch(response: Response): response is ErrorResponse {
  return (
    isErrorResponse(response) &&
    response.error.code === "invalid_resume"
  );
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

function nextReconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BACKOFF_CAP_MS, RECONNECT_BACKOFF_BASE_MS * 2 ** attempt);
}

function isSocketClosedError(error: unknown): boolean {
  return error instanceof Error &&
    (error.message.includes("Surf Ace socket is not open") ||
      error.message.includes("Surf Ace socket closed"));
}

function isEndpointRefreshableConnectionError(error: unknown): boolean {
  return error instanceof Error &&
    (
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("Timed out connecting to") ||
      error.message.includes("Opening handshake timed out")
    );
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
  private unsubscribeDiscovery: (() => void) | null = null;
  private runtimeLease: FileHandle | null = null;
  private leaseHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private ownsRuntimeLease = false;

  constructor(options: SurfAceRuntimeOptions = {}) {
    this.discovery = options.discovery ?? createBonjourSurfAceDiscoveryService({ logger: options.logger });
    this.drawingFlushConfig = options.drawingFlushConfig ?? DEFAULT_DRAWING_FLUSH_CONFIG;
    this.eventProfile = options.eventProfile ?? "minimum_deep";
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => Date.now());
    this.providerName = options.providerName;
    this.stateDir =
      options.stateDir ?? path.join(os.homedir(), ".surf-ace-openclaw-extension");
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
      this.logger.info?.("[surf-ace:runtime] start() — loading state");
      await ensureDirectory(this.stateDir);
      await this.loadState();
      this.ownsRuntimeLease = await this.acquireRuntimeLease();
      this.logger.info?.(`[surf-ace:runtime] start() — lease acquired: ${this.ownsRuntimeLease}`);
      if (!this.ownsRuntimeLease) {
        this.logger.info?.(
          "[surf-ace:runtime] passive process; another OpenClaw process owns the Surf Ace runtime lease",
        );
        this.started = true;
        return;
      }
      this.unsubscribeDiscovery = this.discovery.subscribe((endpoints) => {
        this.handleDiscoveryUpdate(endpoints);
      });
      this.logger.info?.("[surf-ace:runtime] start() — starting discovery");
      await this.discovery.start();
      const snapshot = this.discovery.getSnapshot();
      this.logger.info?.(`[surf-ace:runtime] start() — discovery started, snapshot has ${snapshot.length} endpoint(s), calling handleDiscoveryUpdate`);
      this.handleDiscoveryUpdate(snapshot);
      this.logger.info?.(`[surf-ace:runtime] start() — complete, ${this.surfaces.size} surface(s) in map`);
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
    if (!this.ownsRuntimeLease) {
      this.unsubscribeDiscovery?.();
      this.unsubscribeDiscovery = null;
      await this.releaseRuntimeLease();
      return;
    }

    await this.discovery.stop();
    this.unsubscribeDiscovery?.();
    this.unsubscribeDiscovery = null;

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
    await this.releaseRuntimeLease();
  }

  subscribe(listener: (event: SurfAceLocalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async listScreens(): Promise<SurfAceScreenSummary[]> {
    await this.start();
    const discoverySnapshot = this.discovery.getSnapshot();
    this.logger.info?.(
      `[surf-ace:runtime] listScreens: ${this.surfaces.size} surface(s) in map, ${discoverySnapshot.length} discovery endpoint(s): ${discoverySnapshot.map((ep) => `${ep.name}@${ep.endpointId}`).join(", ") || "(none)"}`,
    );
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
        windowLabel: surface.windowLabel,
        _debug: {
          autoRetryEnabled: surface.autoRetryEnabled,
          endpointId: surface.endpointId,
          hasPairedInGatewaySession: surface.hasPairedInGatewaySession,
          reconnectAttempt: surface.reconnectAttempt,
          sessionId: surface.sessionId,
          unreachableFailures: surface.unreachableFailures,
          wsOpen: surface.client?.isOpen() ?? false,
        },
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

  async split(input: SurfAceSplitInput): Promise<SurfAceSplitResult> {
    await this.start();
    const surface = this.requireConnectedSurface(input.fingerprint);
    return await this.paneSplit(surface, input);
  }

  async closePane(input: { fingerprint: string; paneId: number }): Promise<SurfAceClosePaneResult> {
    await this.start();
    const surface = this.requireConnectedSurface(input.fingerprint);
    return await this.paneClose(surface, input);
  }

  async relinquish(input: { fingerprint: string }): Promise<SurfAceRelinquishResult> {
    await this.start();
    const surface = this.requireConnectedSurface(input.fingerprint);
    const response = await this.sendRequest(
      surface,
      this.requestEnvelope("ownership.relinquish"),
    );
    if (isErrorResponse(response)) {
      throw new SurfAceToolError(
        mutationErrorCode(response.error.code),
        response.error.message,
      );
    }

    surface.autoRetryEnabled = false;
    surface.connectionState = "unreachable";
    surface.hasPairedInGatewaySession = false;
    surface.sessionId = null;
    surface.stopRequested = true;
    this.stopHeartbeat(surface);
    await surface.client?.close(1000, clampCloseReason("provider_shutdown")).catch(() => {});
    return { relinquished: true };
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

    const surface = this.surfaces.get(input.fingerprint);
    if (surface) {
      surface.alertFired = false;
      surface.alertFiredAt = null;
    }
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
    this.finalizeLiveFrame(surface, pane);

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

  private async paneSplit(
    surface: ManagedSurface,
    input: SurfAceSplitInput,
  ): Promise<SurfAceSplitResult> {
    if (input.count < 2) {
      throw new SurfAceToolError(
        "invalid_operation",
        "Surf Ace split count must be at least 2.",
      );
    }

    const pane = this.requirePane(surface.surfaceId, input.paneId);
    const reservedPanes: ManagedPane[] = [];
    const additionalPaneCount = input.count - 1;
    const newPaneIds = Array.from({ length: additionalPaneCount }, () => {
      const paneId = this.allocatePaneId();
      const created = createPane(paneId, paneId, surface.viewport);
      surface.panes.set(created.paneId, created);
      reservedPanes.push(created);
      return paneId;
    });

    const request: PaneSplitRequest = {
      id: makeBrandedRequestId(),
      op: "pane.split",
      payload: {
        count: input.count,
        direction: input.direction,
        newPaneIds: newPaneIds.map((paneId) => asPaneId(paneId)),
        paneId: pane.remotePaneId,
      },
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    };

    let response: Response;
    try {
      response = await this.sendRequest(surface, request);
    } catch (error) {
      for (const reservedPane of reservedPanes) {
        surface.panes.delete(reservedPane.paneId);
      }
      throw error;
    }

    if (isErrorResponse(response)) {
      for (const reservedPane of reservedPanes) {
        surface.panes.delete(reservedPane.paneId);
      }
      throw new SurfAceToolError(
        mutationErrorCode(response.error.code),
        response.error.message,
      );
    }

    const payload = (response as PaneSplitResponse).payload;
    const seenRemotePaneIds = new Set<number>();
    const panes = payload.panes.map(({ paneId: remotePaneId }) => {
      seenRemotePaneIds.add(remotePaneId);
      const managedPane = this.ensurePane(surface, remotePaneId);
      managedPane.viewport = cloneViewport(surface.viewport);
      return { paneId: managedPane.paneId };
    });

    for (const managedPane of [...surface.panes.values()]) {
      if (!seenRemotePaneIds.has(managedPane.remotePaneId)) {
        surface.panes.delete(managedPane.paneId);
      }
    }

    return panes;
  }

  private async paneClose(
    surface: ManagedSurface,
    input: { fingerprint: string; paneId: number },
  ): Promise<SurfAceClosePaneResult> {
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    const request: PaneCloseRequest = {
      id: makeBrandedRequestId(),
      op: "pane.close",
      payload: {
        paneId: pane.remotePaneId,
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

    const payload = (response as PaneCloseResponse).payload;
    const removedPane = this.findPaneByRemoteId(surface, payload.paneId);
    if (removedPane) {
      surface.panes.delete(removedPane.paneId);
    }

    return { ok: true };
  }

  private async contentSet(
    surface: ManagedSurface,
    input: SurfAcePushInput,
    sessionKey?: string,
  ): Promise<SurfAcePushResult> {
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    this.finalizeLiveFrame(surface, pane);
    const normalizedContent = normalizeContent(input.contentType, input.content);
    const contentPreview = typeof normalizedContent === "string"
      ? normalizedContent.slice(0, 200)
      : JSON.stringify(normalizedContent).slice(0, 200);
    this.logger.info?.(
      `[surf-ace:runtime] contentSet pane=${pane.paneId}(remote=${pane.remotePaneId}) type=${input.contentType} contentPreview=${contentPreview}`,
    );

    const nextContentId =
      sessionKey && pane.ownerSessionKey === sessionKey && pane.activeContentId
        ? pane.activeContentId
        : makeContentId();
    pane.pendingOwnerSessionKey = sessionKey ?? null;

    const request: ContentSetRequest = {
      id: makeBrandedRequestId(),
      op: "content.set",
      payload: {
        content: normalizedContent,
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
    return this.applyMutationResponse(surface, pane, response, request, sessionKey) as SurfAcePushResult;
  }

  private emit(event: SurfAceLocalEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private finalizeLiveFrame(surface: ManagedSurface, pane: ManagedPane): void {
    if (!pane.buffer.liveFrame) {
      return;
    }
    pane.buffer.closedFrames.push(structuredClone(pane.buffer.liveFrame));
    pane.buffer.liveFrame = null;
    pane.buffer.liveDirtyStrokeIds = [];
    this.maybeFireAnnotationAlert(surface, pane);
  }

  private maybeFireAnnotationAlert(surface: ManagedSurface, pane: ManagedPane): void {
    const now = this.now();
    const { liveDirtyStrokeCount, queuedFrameCount } = this.countUnreadAnnotationActivity(surface);
    if (liveDirtyStrokeCount === 0 && queuedFrameCount === 0) {
      return;
    }
    if (
      surface.alertFired &&
      surface.alertFiredAt !== null &&
      now - surface.alertFiredAt >= ALERT_RESET_TIMEOUT_MS
    ) {
      surface.alertFired = false;
      surface.alertFiredAt = null;
    }
    if (
      surface.alertFired &&
      surface.alertFiredAt !== null &&
      now - surface.alertFiredAt < ALERT_RESET_TIMEOUT_MS
    ) {
      return;
    }

    surface.alertFired = true;
    surface.alertFiredAt = now;
    this.runBackgroundTask(
      `annotation alert for ${surface.surfaceId}`,
      async () => {
        await this.postAnnotationAlert(
          this.buildAnnotationAlertMessage(surface.name, liveDirtyStrokeCount, queuedFrameCount),
          pane.ownerSessionKey ?? DEFAULT_ALERT_SESSION_KEY,
        );
      },
    );
  }

  private countUnreadAnnotationActivity(surface: ManagedSurface): {
    liveDirtyStrokeCount: number;
    queuedFrameCount: number;
  } {
    let liveDirtyStrokeCount = 0;
    let queuedFrameCount = 0;
    for (const pane of surface.panes.values()) {
      liveDirtyStrokeCount += pane.buffer.liveDirtyStrokeIds.length;
      queuedFrameCount += pane.buffer.closedFrames.length;
    }
    return { liveDirtyStrokeCount, queuedFrameCount };
  }

  private buildAnnotationAlertMessage(
    surfaceName: string,
    liveDirtyStrokeCount: number,
    queuedFrameCount: number,
  ): string {
    const details: string[] = [];
    if (liveDirtyStrokeCount > 0) {
      details.push(
        `${liveDirtyStrokeCount} live ${liveDirtyStrokeCount === 1 ? "dirty stroke" : "dirty strokes"}`,
      );
    }
    if (queuedFrameCount > 0) {
      details.push(
        `${queuedFrameCount} queued ${queuedFrameCount === 1 ? "frame" : "frames"}`,
      );
    }
    if (details.length === 0) {
      return `Surf Ace updates pending on ${surfaceName}`;
    }
    return `Surf Ace updates pending on ${surfaceName} (${details.join(", ")})`;
  }

  private async postAnnotationAlert(message: string, sessionKey: string): Promise<void> {
    try {
      await fetch(ALERT_ENDPOINT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message,
          noOverlay: true,
          sessionKey,
        }),
      });
    } catch {
      // Alert delivery is best-effort; unread state remains in the local buffer.
    }
  }

  private handleDiscoveryUpdate(endpoints: SurfAceDiscoveryEndpoint[]): void {
    this.logger.info?.(
      `[surf-ace:runtime] discoveryUpdate: ${endpoints.length} endpoint(s): ${endpoints.map((ep) => `${ep.name}@${ep.endpointId}`).join(", ") || "(none)"}; surfaces in map: ${this.surfaces.size}`,
    );
    for (const endpoint of endpoints) {
      this.refreshEndpointTopology(endpoint);
    }

    const currentEndpointIds = new Set(endpoints.map((endpoint) => endpoint.endpointId));
    for (const surface of this.surfaces.values()) {
      if (!currentEndpointIds.has(surface.endpointId)) {
        const wsOpen = surface.client?.isOpen() ?? false;
        const preserveOwnedSurface =
          wsOpen ||
          surface.connectionState === "connected" ||
          surface.hasPairedInGatewaySession ||
          surface.panes.size > 0;
        this.logger.info?.(
          `[surf-ace:runtime] surface ${surface.surfaceId} (${surface.name}) missing from discovery; preserve=${preserveOwnedSurface} wsOpen=${wsOpen} state=${surface.connectionState} paired=${surface.hasPairedInGatewaySession} panes=${surface.panes.size}`,
        );
        if (preserveOwnedSurface) {
          continue;
        }
        surface.stopRequested = true;
        if (surface.client) {
          this.runBackgroundTask(
            `close removed surface ${surface.surfaceId}`,
            async () => {
              await surface.client?.close(1000, clampCloseReason("provider_shutdown"));
            },
          );
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
    this.finalizeLiveFrame(surface, pane);
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

  private handleSnapshotHintEvent(surface: ManagedSurface, event: SnapshotHintEvent): void {
    if (event.payload.reason === "after_reconnect") {
      return;
    }
    this.runBackgroundTask(
      `snapshot hint sync for ${surface.surfaceId}`,
      async () => {
        await this.syncSurfaceSnapshots(surface);
      },
    );
  }

  private handleSurfaceAppearedEvent(
    sourceSurface: ManagedSurface,
    event: SurfaceAppearedEvent,
  ): void {
    const existing = this.surfaces.get(event.payload.surfaceId);
    const windowLabel = this.ensureWindowLabel(event.payload.surfaceId);
    const surface = existing ?? {
      alertFired: false,
      alertFiredAt: null,
      autoRetryEnabled: true,
      client: null,
      connectionState: "connecting" as SurfAceConnectionState,
      consecutiveResumeFailures: 0,
      connectedAt: null,
      endpoint: sourceSurface.endpoint,
      endpointId: sourceSurface.endpointId,
      fingerprintPrefix: sourceSurface.fingerprintPrefix,
      hasPairedInGatewaySession: false,
      heartbeatInterval: null,
      heartbeatMisses: 0,
      heartbeatNonce: null,
      lastSeenAt: this.now(),
      name: event.payload.name,
      paneIdsNeedingSnapshot: new Set<number>(),
      panes: new Map<number, ManagedPane>(),
      recentEventIds: [],
      recentEventIdsSet: new Set<string>(),
      reclaimTakeoverOnBusy: false,
      reconnectAttempt: 0,
      retryDelayResolver: null,
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
    surface.fingerprintPrefix = sourceSurface.fingerprintPrefix;
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
      this.runBackgroundTask(
        `close removed announced surface ${surface.surfaceId}`,
        async () => {
          await surface.client?.close(1000, clampCloseReason("provider_shutdown"));
        },
      );
    }
    this.surfaces.delete(event.payload.surfaceId);
  }

  private handleSurfaceResumedEvent(surface: ManagedSurface, event: SurfaceResumedEvent): void {
    this.emit({
      paneId: 0,
      surfaceId: event.payload.surfaceId,
      type: "event.surface_resumed",
    });
    this.refreshEndpointTopology(surface.endpoint);
    this.runBackgroundTask(
      `surface resumed sync for ${surface.surfaceId}`,
      async () => {
        await this.syncSurfaceSnapshots(surface);
      },
    );
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
        this.logger.warn?.(
          `[surf-ace:runtime] snapshot event buffer overflow for ${surface.surfaceId}; dropping oldest event`,
        );
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
    const contextKey = pane.buffer.currentUrl ?? pane.activeContentId ?? event.payload.contentId;
    const now = this.now();
    if (!pane.buffer.liveFrame || pane.buffer.liveFrame.contextKey !== contextKey) {
      const frameId = makeFrameId();
      pane.buffer.liveFrame = {
        contentId: event.payload.contentId,
        contextKey,
        frameId,
        image: "",
        openedAt: event.payload.firstStrokeAt,
        scrollOffset: pane.buffer.scrollPosition
          ? { x: pane.buffer.scrollPosition.x, y: pane.buffer.scrollPosition.y }
          : { x: 0, y: 0 },
        strokes: [],
        updatedAt: event.payload.lastStrokeAt,
        url: pane.buffer.currentUrl ?? undefined,
        viewport: pane.viewport,
      };
      this.runBackgroundTask(
        `frame-open snapshot for ${surface.surfaceId}/${pane.paneId}`,
        async () => {
          await this.captureFrameOpenState(surface, pane, frameId);
        },
      );
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

  private async captureFrameOpenState(
    surface: ManagedSurface,
    pane: ManagedPane,
    frameId: string,
  ): Promise<void> {
    if (!this.canSendRequests(surface)) {
      return;
    }

    try {
      const response = await this.sendRequest(
        surface,
        this.requestEnvelope("snapshot.get", {
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

      const payload = (response as SnapshotResponse).payload;
      if (pane.buffer.liveFrame?.frameId !== frameId) {
        return;
      }

      pane.buffer.liveFrame.image = payload.image ?? "";
      pane.buffer.liveFrame.scrollOffset = { ...payload.viewport.scrollOffset };
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
    } catch (error) {
      this.logger.warn?.(
        `[surf-ace:runtime] frame-open snapshot failed for ${surface.surfaceId}/${pane.paneId}: ${String(error)}`,
      );
    }
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
    const existingFirstPane = this.firstPane(surface);
    if (existingFirstPane && existingFirstPane.remotePaneId > 0) {
      return existingFirstPane.remotePaneId;
    }

    if (this.persistentState.nextPaneId <= INITIAL_PAIR_PANE_ID) {
      this.persistentState.nextPaneId = INITIAL_PAIR_PANE_ID + 1;
      this.runBackgroundTask(
        "persist next pane id",
        async () => {
          await this.persistState();
        },
      );
    }

    if (surface.panes.size === 0) {
      surface.panes = new Map<number, ManagedPane>([
        [INITIAL_PAIR_PANE_ID, createPane(INITIAL_PAIR_PANE_ID, INITIAL_PAIR_PANE_ID, surface.viewport)],
      ]);
      surface.snapshotBufferedEvents = [];
    }
    return INITIAL_PAIR_PANE_ID;
  }

  private firstPane(surface: ManagedSurface): ManagedPane | null {
    let first: ManagedPane | null = null;
    for (const pane of surface.panes.values()) {
      if (!first || pane.paneId < first.paneId) {
        first = pane;
      }
    }
    return first;
  }

  private findPaneByRemoteId(surface: ManagedSurface, remotePaneId: PaneId): ManagedPane | null {
    for (const pane of surface.panes.values()) {
      if (pane.remotePaneId === remotePaneId) {
        return pane;
      }
    }
    return null;
  }

  private consumeBootstrapPaneForPairState(
    surface: ManagedSurface,
    remotePaneId: PaneId,
  ): ManagedPane | null {
    if (surface.panes.size !== 1) {
      return null;
    }
    if (this.findPaneByRemoteId(surface, remotePaneId)) {
      return null;
    }

    const bootstrapPane = surface.panes.values().next().value ?? null;
    if (!bootstrapPane) {
      return null;
    }
    if (bootstrapPane.remotePaneId !== bootstrapPane.paneId) {
      return null;
    }
    if (
      bootstrapPane.activeContentId !== null ||
      bootstrapPane.contentType !== null ||
      bootstrapPane.currentRevision !== asRevision(0) ||
      bootstrapPane.historySummary.visibleContentId !== null ||
      bootstrapPane.snapshot !== null
    ) {
      return null;
    }

    bootstrapPane.remotePaneId = remotePaneId;
    return bootstrapPane;
  }

  private ensureSurfaceWorker(surface: ManagedSurface): void {
    if (!surface.autoRetryEnabled || surface.workPromise) {
      this.logger.info?.(
        `[surf-ace:runtime] ensureSurfaceWorker SKIPPED for ${surface.surfaceId}: autoRetry=${surface.autoRetryEnabled} hasWork=${!!surface.workPromise}`,
      );
      return;
    }
    this.logger.info?.(`[surf-ace:runtime] ensureSurfaceWorker STARTING worker for ${surface.surfaceId}`);
    surface.stopRequested = false;
    surface.workPromise = this.runSurfaceWorker(surface).finally(() => {
      surface.workPromise = null;
      this.logger.info?.(`[surf-ace:runtime] worker exited for ${surface.surfaceId}`);
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
    this.runBackgroundTask(
      `persist window label for ${surfaceId}`,
      async () => {
        await this.persistState();
      },
    );
    return label;
  }

  private reconcileWindowLabel(
    previousSurfaceId: string,
    nextSurfaceId: string,
    currentWindowLabel: string,
  ): string {
    const existingNextLabel = this.persistentState.windowLabels[nextSurfaceId];
    if (existingNextLabel) {
      if (previousSurfaceId !== nextSurfaceId) {
        delete this.persistentState.windowLabels[previousSurfaceId];
      }
      return existingNextLabel;
    }

    const migratedLabel = currentWindowLabel || this.persistentState.windowLabels[previousSurfaceId];
    if (migratedLabel) {
      this.persistentState.windowLabels[nextSurfaceId] = migratedLabel;
      if (previousSurfaceId !== nextSurfaceId) {
        delete this.persistentState.windowLabels[previousSurfaceId];
      }
      return migratedLabel;
    }

    if (previousSurfaceId !== nextSurfaceId) {
      delete this.persistentState.windowLabels[previousSurfaceId];
    }
    return this.ensureWindowLabel(nextSurfaceId);
  }

  private allocatePaneId(): PaneId {
    const paneId = asPaneId(this.persistentState.nextPaneId);
    this.persistentState.nextPaneId += 1;
    this.runBackgroundTask(
      "persist next pane id",
      async () => {
        await this.persistState();
      },
    );
    return paneId;
  }

  private async loadState(): Promise<void> {
    const statePath = path.join(this.stateDir, STATE_FILE_NAME);
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as RuntimeStateFile & { endpointSurfaces?: Record<string, string> };
      if (parsed.version === 1) {
        this.persistentState = {
          nextPaneId: parsed.nextPaneId,
          nextWindowLabelIndex: parsed.nextWindowLabelIndex,
          providerId: parsed.providerId,
          version: 1,
          windowLabels: parsed.windowLabels ?? {},
        };
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

  private async acquireRuntimeLease(): Promise<boolean> {
    const leasePath = path.join(this.stateDir, RUNTIME_LEASE_FILE_NAME);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(leasePath, "wx");
        await this.writeLeaseContent(handle);
        this.runtimeLease = handle;
        this.startLeaseHeartbeat();
        return true;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "EEXIST") {
          throw error;
        }
        if (!(await this.clearStaleRuntimeLease(leasePath))) {
          return false;
        }
      }
    }

    return false;
  }

  private async writeLeaseContent(handle: FileHandle): Promise<void> {
    const content = JSON.stringify(
      {
        pid: process.pid,
        startedAt: this.now(),
        lastActiveAt: this.now(),
      },
      null,
      2,
    );
    await handle.truncate(0);
    await handle.write(content, 0, "utf8");
  }

  private startLeaseHeartbeat(): void {
    this.stopLeaseHeartbeat();
    this.leaseHeartbeatInterval = setInterval(() => {
      const handle = this.runtimeLease;
      if (!handle) {
        this.stopLeaseHeartbeat();
        return;
      }
      this.writeLeaseContent(handle).catch((error) => {
        this.logger.warn?.(
          `[surf-ace:runtime] lease heartbeat write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, LEASE_HEARTBEAT_INTERVAL_MS);
  }

  private stopLeaseHeartbeat(): void {
    if (this.leaseHeartbeatInterval) {
      clearInterval(this.leaseHeartbeatInterval);
      this.leaseHeartbeatInterval = null;
    }
  }

  private async clearStaleRuntimeLease(leasePath: string): Promise<boolean> {
    let contents = "";
    try {
      contents = await fs.readFile(leasePath, "utf8");
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return true;
      }
      return false;
    }

    let ownerPid: number | null = null;
    let lastActiveAt: number | null = null;
    try {
      const parsed = JSON.parse(contents) as { pid?: number; lastActiveAt?: number };
      ownerPid = typeof parsed.pid === "number" ? parsed.pid : null;
      lastActiveAt = typeof parsed.lastActiveAt === "number" ? parsed.lastActiveAt : null;
    } catch {
      ownerPid = null;
    }

    // Check if the owner PID is dead — always stale.
    let ownerAlive = false;
    if (ownerPid !== null) {
      try {
        process.kill(ownerPid, 0);
        ownerAlive = true;
      } catch {
        // PID is dead — stale.
      }
    }

    // If the owner process is alive, check the heartbeat timestamp.
    // A lease without a recent lastActiveAt is stale — the holder's
    // runtime is no longer actively managing surfaces.
    if (ownerAlive) {
      const age = lastActiveAt !== null ? this.now() - lastActiveAt : Infinity;
      if (age < LEASE_STALE_THRESHOLD_MS) {
        this.logger.info?.(
          `[surf-ace:runtime] lease held by live PID ${ownerPid}, lastActive ${Math.round(age / 1000)}s ago — deferring`,
        );
        return false;
      }
      this.logger.info?.(
        `[surf-ace:runtime] lease held by PID ${ownerPid} but lastActive ${lastActiveAt !== null ? `${Math.round(age / 1000)}s ago` : "never"} (stale threshold ${LEASE_STALE_THRESHOLD_MS / 1000}s) — evicting`,
      );
    }

    try {
      await fs.unlink(leasePath);
      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      return nodeError.code === "ENOENT";
    }
  }

  private async releaseRuntimeLease(): Promise<void> {
    this.stopLeaseHeartbeat();
    const lease = this.runtimeLease;
    this.runtimeLease = null;
    this.ownsRuntimeLease = false;
    if (!lease) {
      return;
    }

    const leasePath = path.join(this.stateDir, RUNTIME_LEASE_FILE_NAME);
    await lease.close().catch(() => {});
    await fs.unlink(leasePath).catch(() => {});
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

  private refreshEndpointTopology(endpoint: SurfAceDiscoveryEndpoint): void {
    // Spec §6.1: connect → pair.request directly (surfaces.list is optional and not required
    // for single-window endpoints; Electron returns errors on the pre-flight WS connection).
    this.logger.info?.(
      `[surf-ace:runtime] refreshEndpointTopology for ${endpoint.name}@${endpoint.endpointId} (fp=${endpoint.fingerprintPrefix || "none"})`,
    );
    const existing = this.reusableSurface(
      [...this.surfaces.values()].find((s) => s.endpointId === endpoint.endpointId),
    );

    if (existing) {
      this.logger.info?.(`[surf-ace:runtime] refreshEndpointTopology → reuse existing by endpointId: ${existing.surfaceId}`);
      this.assignEndpoint(existing, endpoint);
      this.ensureSurfaceWorker(existing);
      return;
    }

    const existingByFingerprint = this.reusableSurface(
      endpoint.fingerprintPrefix
        ? [...this.surfaces.values()].find((s) => s.fingerprintPrefix === endpoint.fingerprintPrefix)
        : undefined,
    );

    if (existingByFingerprint) {
      this.logger.info?.(`[surf-ace:runtime] refreshEndpointTopology → reuse existing by fingerprint: ${existingByFingerprint.surfaceId}`);
      this.assignEndpoint(existingByFingerprint, endpoint);
      this.ensureSurfaceWorker(existingByFingerprint);
      return;
    }

    const surfaceId = makeProvisionalSurfaceId(endpoint.endpointId);
    this.logger.info?.(`[surf-ace:runtime] refreshEndpointTopology → NEW surface ${surfaceId} for ${endpoint.name}`);
    const surface: ManagedSurface = {
      alertFired: false,
      alertFiredAt: null,
      autoRetryEnabled: true,
      client: null,
      connectionState: "connecting",
      consecutiveResumeFailures: 0,
      connectedAt: null,
      endpoint,
      endpointId: endpoint.endpointId,
      fingerprintPrefix: endpoint.fingerprintPrefix,
      hasPairedInGatewaySession: false,
      heartbeatInterval: null,
      heartbeatMisses: 0,
      heartbeatNonce: null,
      lastSeenAt: this.now(),
      name: endpoint.name,
      paneIdsNeedingSnapshot: new Set<number>(),
      panes: new Map<number, ManagedPane>(),
      recentEventIds: [],
      recentEventIdsSet: new Set<string>(),
      reclaimTakeoverOnBusy: false,
      reconnectAttempt: 0,
      retryDelayResolver: null,
      sessionId: null,
      snapshotBufferedEvents: [],
      snapshotSyncInFlight: false,
      stopRequested: false,
      surfaceId,
      unreachableFailures: 0,
      viewport: cloneViewport(endpoint.viewport),
      windowLabel: "",
      workPromise: null,
    };

    this.surfaces.set(surfaceId, surface);
    this.ensureSurfaceWorker(surface);
  }

  private reusableSurface(surface: ManagedSurface | undefined): ManagedSurface | undefined {
    if (!surface) {
      return undefined;
    }
    if (!surface.stopRequested) {
      return surface;
    }
    this.surfaces.delete(surface.surfaceId);
    return undefined;
  }

  private assignEndpoint(surface: ManagedSurface, endpoint: SurfAceDiscoveryEndpoint): void {
    const previousEndpointId = surface.endpointId;
    const endpointChanged = previousEndpointId !== endpoint.endpointId;
    surface.endpoint = endpoint;
    surface.endpointId = endpoint.endpointId;
    surface.fingerprintPrefix = endpoint.fingerprintPrefix;
    surface.lastSeenAt = this.now();
    surface.name = endpoint.name;
    surface.viewport = cloneViewport(endpoint.viewport);

    if (!endpointChanged) {
      return;
    }

    surface.reconnectAttempt = 0;
    surface.unreachableFailures = 0;
    if (surface.connectionState !== "connected") {
      surface.connectionState = "connecting";
    }
    if (surface.connectionState !== "connected") {
      this.runBackgroundTask(
        `refresh surface client after endpoint change ${surface.surfaceId}`,
        async () => {
          if (surface.client) {
            await this.closeSurfaceClient(surface, surface.client, clampCloseReason("provider_shutdown"));
          }
        },
      );
    }
    this.wakeSurfaceRetry(surface);

  }

  private async discoverSurfaceId(surface: ManagedSurface): Promise<void> {
    const client = surface.client;
    if (!client) {
      return;
    }

    let response: Response;
    try {
      if (!client.isOpen()) {
        return;
      }
      response = await client.request(
        this.requestEnvelope("surfaces.list"),
        REQUEST_TIMEOUT_MS,
      );
    } catch {
      this.logger.warn?.(
        `[surf-ace:runtime] surfaces.list failed for ${surface.endpointId}, using cached surfaceId`,
      );
      return;
    }

    if (isErrorResponse(response)) {
      return;
    }

    const remoteSurfaces = (response as SurfacesListResponse).payload.surfaces;
    if (remoteSurfaces.length === 0) {
      return;
    }

    const remoteSurfaceId = asSurfaceId(remoteSurfaces[0].surfaceId);
    if (remoteSurfaceId === surface.surfaceId) {
      if (!surface.windowLabel) {
        surface.windowLabel = this.ensureWindowLabel(remoteSurfaceId);
      }
      return;
    }

    const oldSurfaceId = surface.surfaceId;
    if (this.surfaces.get(oldSurfaceId) === surface) {
      this.surfaces.delete(oldSurfaceId);
    }
    surface.surfaceId = remoteSurfaceId;
    surface.windowLabel = this.reconcileWindowLabel(oldSurfaceId, remoteSurfaceId, surface.windowLabel);
    this.surfaces.set(remoteSurfaceId, surface);
    this.runBackgroundTask(
      `persist remapped surface id ${surface.endpointId}`,
      async () => {
        await this.persistState();
      },
    );
  }

  private async requestPair(surface: ManagedSurface): Promise<PairResponse> {
    const client = surface.client;
    if (!client || !client.isOpen()) {
      throw new SurfAceToolError(
        "not_connected",
        `Surf Ace surface is not connected: ${surface.surfaceId}`,
      );
    }
    const initialPaneId = this.ensureInitialPairPane(surface);
    const windowLabel = surface.windowLabel || this.ensureWindowLabel(surface.surfaceId);
    surface.windowLabel = windowLabel;
    const resumeSessionId = this.shouldAttemptResume(surface) ? surface.sessionId : null;

    const buildPairRequest = (takeover: boolean, requestedResumeSessionId: SessionId | null): PairRequest => ({
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
        resume: requestedResumeSessionId ? { sessionId: requestedResumeSessionId } : undefined,
        surfaceId: surface.surfaceId,
        takeover,
        windowLabel,
      },
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    });

    const sendPairRequest = async (
      takeover: boolean,
      requestedResumeSessionId: SessionId | null,
    ): Promise<Response> => {
      try {
        return await client.request(
          buildPairRequest(takeover, requestedResumeSessionId),
          REQUEST_TIMEOUT_MS,
        );
      } catch (error) {
        if (requestedResumeSessionId && isSocketClosedError(error)) {
          this.noteResumeFailure(surface);
        }
        if (isSocketClosedError(error)) {
          throw new SurfAceToolError(
            "not_connected",
            `Surf Ace surface is not connected: ${surface.surfaceId}`,
          );
        }
        throw error;
      }
    };

    let response = await sendPairRequest(false, resumeSessionId);

    if (isResumeSessionMismatch(response) && resumeSessionId) {
      this.noteResumeFailure(surface);
      response = await this.maybeRecoverFromColdStartInvalidResume(
        surface,
        response,
        sendPairRequest,
      );
      if (isResumeSessionMismatch(response)) {
        this.logger.warn?.(
          `[surf-ace:runtime] resume session mismatch for ${surface.surfaceId}; retrying fresh owner pair`,
        );
        surface.sessionId = null;
        response = await sendPairRequest(false, null);
      }
    }

    if (
      isResumeSessionMismatch(response) &&
      !surface.hasPairedInGatewaySession
    ) {
      response = await this.maybeRecoverFromColdStartInvalidResume(
        surface,
        response,
        sendPairRequest,
      );
    }

    if (
      isErrorResponse(response) &&
      response.error.code === "busy" &&
      !surface.hasPairedInGatewaySession
    ) {
      this.logger.warn?.(
        `[surf-ace:runtime] busy on cold-start reconnect for ${surface.surfaceId}; retrying with takeover`,
      );
      response = await sendPairRequest(true, null);
    }

    if (
      isErrorResponse(response) &&
      response.error.code === "busy" &&
      surface.reclaimTakeoverOnBusy
    ) {
      this.logger.warn?.(
        `[surf-ace:runtime] busy after a live-session drop for ${surface.surfaceId}; reclaiming with takeover`,
      );
      surface.reclaimTakeoverOnBusy = false;
      response = await sendPairRequest(true, null);
    }

    if (isErrorResponse(response)) {
      // If we get "busy" despite having paired before, the ownership was
      // taken by another provider.  Reset so next worker iteration falls
      // into the cold-start takeover path.
      if (response.error.code === "busy" && surface.hasPairedInGatewaySession) {
        surface.hasPairedInGatewaySession = false;
        surface.sessionId = null;
      }
      throw new SurfAceToolError(mutationErrorCode(response.error.code), response.error.message);
    }

    return response as PairResponse;
  }

  private async maybeRecoverFromColdStartInvalidResume(
    surface: ManagedSurface,
    response: Response,
    sendPairRequest: (
      takeover: boolean,
      requestedResumeSessionId: SessionId | null,
    ) => Promise<Response>,
  ): Promise<Response> {
    if (
      !isErrorResponse(response) ||
      response.error.code !== "invalid_resume" ||
      surface.hasPairedInGatewaySession
    ) {
      return response;
    }

    this.logger.warn?.(
      `[surf-ace:runtime] invalid_resume on cold-start reconnect for ${surface.surfaceId}; retrying with takeover`,
    );
    surface.sessionId = null;
    return sendPairRequest(true, null);
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
    this.logger.info?.(`[surf-ace:runtime] runSurfaceWorker ENTERED for ${surface.surfaceId} endpoint=${surface.endpointId}`);
    while (!surface.stopRequested) {
      try {
        surface.connectionState = surface.unreachableFailures >= UNREACHABLE_AFTER_FAILURES
          ? "unreachable"
          : "connecting";

        let client: SurfAceWireClient | null = null;
        try {
          client = new SurfAceWireClient(buildWsUrl(surface.endpoint), {
            onClose: (code, reason) => {
              if (surface.client !== client) {
                return;
              }
              this.stopHeartbeat(surface);
              if (!surface.stopRequested && (code !== 1000 || reason !== "provider_shutdown")) {
                this.logger.warn?.(
                  `[surf-ace:runtime] socket closed for ${surface.surfaceId}: code=${code} reason=${reason || "<none>"}`,
                );
              }
              if (!surface.autoRetryEnabled) {
                surface.connectionState = "unreachable";
                return;
              }
              surface.connectionState =
                surface.unreachableFailures >= UNREACHABLE_AFTER_FAILURES
                  ? "unreachable"
                  : "connecting";
            },
            onEvent: (event) => {
              if (surface.client !== client) {
                return;
              }
              try {
                this.handleWireEvent(surface, event);
              } catch (error) {
                this.logger.warn?.(
                  `[surf-ace:runtime] event handler error for ${surface.surfaceId}: ${String(error)}`,
                );
              }
            },
          });

          await this.assignSurfaceClient(surface, client);
          this.logger.info?.(`[surf-ace:runtime] worker connecting to ${buildWsUrl(surface.endpoint)} for ${surface.surfaceId}`);
          await client.connect(REQUEST_TIMEOUT_MS);
          this.logger.info?.(`[surf-ace:runtime] worker WS open for ${surface.surfaceId}, discovering surfaceId`);
          await this.discoverSurfaceId(surface);
          this.logger.info?.(`[surf-ace:runtime] worker pairing ${surface.surfaceId}`);
          const pairResponse = await this.requestPair(surface);
          this.markPairConnected(surface, asSessionId(pairResponse.payload.sessionId));
          surface.connectionState = "connected";
          this.logger.info?.(`[surf-ace:runtime] worker CONNECTED ${surface.surfaceId} session=${pairResponse.payload.sessionId} panes=${pairResponse.payload.state.panes.length}`);
          surface.unreachableFailures = 0;
          this.applyPairState(surface, pairResponse);
          this.startHeartbeat(surface);
          await this.syncSurfaceSnapshots(surface, true);
          await client.waitForClose();
          this.noteConnectionEnded(surface);
        } catch (error) {
          this.noteConnectionEnded(surface);
          surface.unreachableFailures += 1;
          // If the pair failed due to a stale resume/ownership lock, clear the
          // stale sessionId so the next attempt goes in fresh with no resume.
          // Without this, the worker loops forever re-sending the same rejected
          // sessionId every retry interval.
          if (
            error instanceof SurfAceToolError &&
            (error.code === "busy" || error.message.toLowerCase().includes("ownership lock") || error.message.toLowerCase().includes("resume"))
          ) {
            if (surface.sessionId !== null) {
              this.logger.warn?.(
                `[surf-ace:runtime] clearing stale sessionId for ${surface.surfaceId} after ownership lock / resume mismatch`,
              );
              surface.sessionId = null;
              surface.hasPairedInGatewaySession = false;
            }
          }
          await this.refreshEndpointAfterConnectFailure(surface, error);
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
          if (client) {
            await this.closeSurfaceClient(surface, client, clampCloseReason("provider_shutdown"));
          }
        }
      } catch (error) {
        this.logger.warn?.(
          `[surf-ace:runtime] worker iteration error for ${surface.surfaceId}: ${String(error)}`,
        );
      }

      if (surface.stopRequested) {
        break;
      }

      const attempt = surface.reconnectAttempt;
      surface.reconnectAttempt += 1;
      const delay = nextReconnectDelayMs(attempt);
      const jitter = Math.floor(Math.random() * 250);
      await this.waitForSurfaceRetry(surface, delay + jitter);
    }
  }

  private async waitForSurfaceRetry(surface: ManagedSurface, delayMs: number): Promise<void> {
    await Promise.race([
      sleep(delayMs),
      new Promise<void>((resolve) => {
        const wake = () => {
          if (surface.retryDelayResolver === wake) {
            surface.retryDelayResolver = null;
          }
          resolve();
        };
        surface.retryDelayResolver = wake;
      }),
    ]);
    surface.retryDelayResolver = null;
  }

  private wakeSurfaceRetry(surface: ManagedSurface): void {
    const resolve = surface.retryDelayResolver;
    surface.retryDelayResolver = null;
    resolve?.();
  }

  private async assignSurfaceClient(surface: ManagedSurface, nextClient: SurfAceWireClient): Promise<void> {
    const previousClient = surface.client;
    if (previousClient === nextClient) {
      return;
    }
    if (previousClient) {
      await this.closeSurfaceClient(surface, previousClient, clampCloseReason("provider_shutdown"));
    }
    surface.client = nextClient;
  }

  private async closeSurfaceClient(
    surface: ManagedSurface,
    client: SurfAceWireClient,
    reason: string,
  ): Promise<void> {
    if (surface.client === client) {
      surface.client = null;
    }
    await client.close(1000, reason).catch(() => {});
  }

  private async refreshEndpointAfterConnectFailure(
    surface: ManagedSurface,
    error: unknown,
  ): Promise<void> {
    if (!isEndpointRefreshableConnectionError(error) || !surface.fingerprintPrefix) {
      return;
    }

    try {
      await this.discovery.refreshNow();
    } catch (refreshError) {
      this.logger.warn?.(
        `[surf-ace:runtime] discovery refresh failed for ${surface.surfaceId}: ${String(refreshError)}`,
      );
      return;
    }

    const replacement = this.discovery.getSnapshot().find(
      (endpoint) => endpoint.fingerprintPrefix === surface.fingerprintPrefix,
    );
    if (!replacement || replacement.endpointId === surface.endpointId) {
      return;
    }

    this.logger.warn?.(
      `[surf-ace:runtime] refreshed stale endpoint for ${surface.surfaceId}: ${surface.endpointId} -> ${replacement.endpointId}`,
    );
    this.assignEndpoint(surface, replacement);
  }

  private async sendRequest(surface: ManagedSurface, request: Request): Promise<Response> {
    const client = surface.client;
    if (!client || !client.isOpen()) {
      throw new SurfAceToolError("not_connected", `Surf Ace surface is not connected: ${surface.surfaceId}`);
    }
    const payloadBytes = JSON.stringify(request).length;
    this.logger.info?.(
      `[surf-ace:runtime] sendRequest ${request.op} id=${request.id} to ${surface.endpointId} (${payloadBytes} bytes, wsOpen=${client.isOpen()})`,
    );
    try {
      const response = await client.request(request, REQUEST_TIMEOUT_MS);
      const responseOk = !isErrorResponse(response);
      this.logger.info?.(
        `[surf-ace:runtime] sendRequest ${request.op} id=${request.id} response ok=${responseOk}${!responseOk ? ` error=${(response as ErrorResponse).error.code}` : ""}`,
      );
      return response;
    } catch (error) {
      this.logger.warn?.(
        `[surf-ace:runtime] sendRequest ${request.op} id=${request.id} threw: ${String(error)}`,
      );
      if (isSocketClosedError(error)) {
        throw new SurfAceToolError(
          "not_connected",
          `Surf Ace surface is not connected: ${surface.surfaceId}`,
        );
      }
      throw error;
    }
  }

  private startHeartbeat(surface: ManagedSurface): void {
    this.stopHeartbeat(surface);
    if (!surface.client) {
      return;
    }

    surface.heartbeatInterval = setInterval(() => {
      const client = surface.client;
      if (!client || !client.isOpen()) {
        return;
      }
      if (surface.heartbeatNonce) {
        surface.heartbeatMisses += 1;
        if (surface.heartbeatMisses >= 2) {
          this.runBackgroundTask(
            `close stale heartbeat surface ${surface.surfaceId}`,
            async () => {
              await client.close(1000, clampCloseReason("provider_shutdown"));
            },
          );
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

      this.runBackgroundTask(
        `heartbeat ping for ${surface.surfaceId}`,
        async () => {
          if (!client.isOpen()) {
            return;
          }
          try {
            const response = await client.request(request, REQUEST_TIMEOUT_MS);
            if (isErrorResponse(response)) {
              return;
            }
            const pong = response as HeartbeatPongResponse;
            if (pong.payload.nonce === nonce) {
              surface.heartbeatMisses = 0;
              surface.heartbeatNonce = null;
            }
          } catch {
            surface.heartbeatMisses += 1;
          }
        },
      );
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
    if (!this.canSendRequests(surface)) {
      return;
    }
    let response: Response;
    try {
      response = await this.sendRequest(
        surface,
        this.requestEnvelope("panes.list"),
      );
    } catch (error) {
      if (error instanceof SurfAceToolError && error.code === "not_connected") {
        return;
      }
      throw error;
    }

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
    if (!this.canSendRequests(surface) || (surface.snapshotSyncInFlight && !force)) {
      return;
    }

    surface.snapshotSyncInFlight = true;
    try {
      try {
        await this.syncPaneTopology(surface);
      } catch (error) {
        if (error instanceof SurfAceToolError && error.code === "not_connected") {
          return;
        }
        throw error;
      }
      const panes = [...surface.panes.values()];
      for (const pane of panes) {
        let response: Response;
        try {
          response = await this.sendRequest(
            surface,
            this.requestEnvelope("snapshot.get", {
              includeDrawings: true,
              includeImage: true,
              includeVisibleText: true,
              paneId: pane.remotePaneId,
            }),
          );
        } catch (error) {
          if (error instanceof SurfAceToolError && error.code === "not_connected") {
            return;
          }
          throw error;
        }

        if (isErrorResponse(response)) {
          throw new SurfAceToolError(
            mutationErrorCode(response.error.code),
            response.error.message,
          );
        }

        this.applySnapshot(surface, pane, response as SnapshotResponse);
      }
    } catch (error) {
      if (surface.client?.isOpen()) {
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

  private canSendRequests(surface: ManagedSurface): boolean {
    return Boolean(surface.client?.isOpen());
  }

  private markPairConnected(surface: ManagedSurface, sessionId: SessionId): void {
    surface.consecutiveResumeFailures = 0;
    surface.connectedAt = this.now();
    surface.autoRetryEnabled = true;
    surface.hasPairedInGatewaySession = true;
    surface.reclaimTakeoverOnBusy = false;
    surface.sessionId = sessionId;
  }

  private noteConnectionEnded(surface: ManagedSurface): void {
    const hadLiveSession = surface.connectedAt !== null;
    const connectionDurationMs = surface.connectedAt ? this.now() - surface.connectedAt : 0;
    if (connectionDurationMs >= STABLE_CONNECTION_RESET_MS) {
      surface.reconnectAttempt = 0;
      surface.unreachableFailures = 0;
    }
    surface.connectedAt = null;
    // Only set reclaimTakeoverOnBusy if the connection was stable long
    // enough to rule out a pathological takeover-then-immediate-close
    // loop. If the socket dropped within seconds of pairing, the
    // takeover itself is the problem — retrying won't help.
    if (hadLiveSession && surface.hasPairedInGatewaySession && surface.autoRetryEnabled
        && connectionDurationMs >= MIN_STABLE_FOR_RECLAIM_MS) {
      surface.reclaimTakeoverOnBusy = true;
    } else if (hadLiveSession && connectionDurationMs < MIN_STABLE_FOR_RECLAIM_MS) {
      this.logger.warn?.(
        `[surf-ace:runtime] connection for ${surface.surfaceId} lasted ${connectionDurationMs}ms (< ${MIN_STABLE_FOR_RECLAIM_MS}ms); suppressing takeover reclaim`,
      );
    }
  }

  private noteResumeFailure(surface: ManagedSurface): void {
    surface.consecutiveResumeFailures += 1;
    if (surface.consecutiveResumeFailures < MAX_CONSECUTIVE_RESUME_FAILURES) {
      return;
    }
    this.logger.warn?.(
      `[surf-ace:runtime] owner resume still failing for ${surface.surfaceId} after ${surface.consecutiveResumeFailures} attempts`,
    );
  }

  private shouldAttemptResume(surface: ManagedSurface): boolean {
    return Boolean(
      surface.hasPairedInGatewaySession &&
      surface.sessionId,
    );
  }

  private runBackgroundTask(label: string, work: () => Promise<void>): void {
    void Promise.resolve()
      .then(work)
      .catch((error) => {
        this.logger.warn?.(
          `[surf-ace:runtime] background task failed (${label}): ${String(error)}`,
        );
      });
  }

  private applyPairState(surface: ManagedSurface, response: PairResponse): void {
    surface.name = response.payload.surfaceName;
    surface.viewport = cloneViewport(response.payload.viewport);
    const seenRemotePaneIds = new Set<number>();
    for (const paneState of response.payload.state.panes) {
      seenRemotePaneIds.add(paneState.paneId);
      const pane =
        this.consumeBootstrapPaneForPairState(surface, paneState.paneId) ??
        this.ensurePane(surface, paneState.paneId);
      pane.activeContentId = paneState.currentContentId;
      pane.contentType = paneState.contentType;
      pane.currentRevision = paneState.currentRevision;
      pane.historySummary.visibleContentId = paneState.currentContentId;
    }
    for (const pane of [...surface.panes.values()]) {
      if (!seenRemotePaneIds.has(pane.remotePaneId)) {
        surface.panes.delete(pane.paneId);
      }
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
      pane.buffer.currentUrl = null;
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
      }
      pane.buffer.currentUrl = null;
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
