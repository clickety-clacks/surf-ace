import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import type {
  AnnotationsRemoveRequest,
  AnnotationsRemoveResponse,
  AnnotationCommittedEvent,
  ConnectionId,
  ContentApplyRequest,
  ContentApplyResponse,
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
  HistoryNavigatedEvent,
  NavigationEvent,
  PaneCreatedEvent,
  PaneId as RemotePaneId,
  PaneRemovedEvent,
  PaneRenamedEvent,
  PairRequest,
  PairResponse,
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
  TopologyApplyResponse,
  Viewport,
  MutationAckResponse,
  PageEvent,
  TopologyApplyRequest,
} from "../../protocol/src/index.js";
import {
  type SurfAceDiscoveryEndpoint,
  type SurfAceDiscoveryService,
  type SurfAceLogger,
  createBonjourSurfAceDiscoveryService,
} from "./surf-ace-discovery.js";
import { SurfAceWireClient } from "./surf-ace-server.js";

export type SurfAceConnectionState = "connected" | "connecting" | "unreachable";
type Brand<T, TName extends string> = T & { readonly __brand: TName };
export type PaneId = Brand<string, "PaneId">;

export type SurfAceHistorySummary = {
  backCount: number;
  forwardCount: number;
  visibleContentId: string | null;
};

export type SurfAcePaneSummary = {
  paneId: PaneId;
  paneLabel: number;
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
  paneId: PaneId;
  paneLabel: number;
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
  paneId: PaneId;
  paneLabel: number;
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
  paneId: PaneId;
  strokeIds: string[];
};

export type SurfAceAnnotateRemoveResult = {
  fingerprint: string;
  notFoundStrokeIds: string[];
  paneId: PaneId;
  paneLabel: number;
  remainingStrokeCount: number;
  removedStrokeIds: string[];
};

export type SurfAcePushInput =
  {
    content: string;
    contentType: ContentType;
    fingerprint: string;
    paneId: PaneId;
  };

export type SurfAcePushResult = {
  contentId: string;
  fingerprint: string;
  paneId: PaneId;
  paneLabel: number;
  revision: number;
};

export type SurfAceClearResult = {
  fingerprint: string;
  paneId: PaneId;
  paneLabel: number;
  revision: number;
};

export type SurfAceRelinquishResult = {
  relinquished: true;
};

export type SurfAceSplitInput = {
  count: number;
  direction: "horizontal" | "vertical";
  fingerprint: string;
  paneId: PaneId;
};

export type SurfAceSplitResult = Array<{
  paneId: PaneId;
  paneLabel: number;
}>;

export type SurfAceClosePaneResult = {
  ok: true;
  paneId: PaneId;
  paneLabel: number;
};

export type SurfAceLocalEvent =
  | {
      paneId: PaneId;
      previousSessionKey: string;
      surfaceId: string;
      type: "event.content_superseded";
      visibleContentId: string | null;
    }
  | {
      paneId: PaneId;
      surfaceId: string;
      type: "event.surface_resumed";
    };

export type SurfAceAnnotationIntentTurn = {
  attachment: {
    content: string;
    fileName: string;
    mimeType: "image/png";
    type: "file";
  };
  fingerprint: string;
  frame: SurfAceFrame;
  idempotencyKey: string;
  message: string;
  paneId: PaneId;
  sessionKey: string;
  surfaceName: string;
};

export type SurfAceRuntimeOptions = {
  deliverSettledAnnotationTurn?: (turn: SurfAceAnnotationIntentTurn) => Promise<void>;
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
  clear(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceClearResult>;
  closePane(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceClosePaneResult>;
  listScreens(): Promise<SurfAceScreenSummary[]>;
  push(input: SurfAcePushInput, context?: { sessionKey?: string }): Promise<SurfAcePushResult>;
  read(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceReadResult>;
  relinquish(input: { fingerprint: string }): Promise<SurfAceRelinquishResult>;
  split(input: SurfAceSplitInput): Promise<SurfAceSplitResult>;
  snapshot(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceSnapshotResult>;
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

type ManagedLayoutNode =
  | {
      paneId: PaneId;
      type: "pane";
    }
  | {
      children: ManagedLayoutNode[];
      direction: "horizontal" | "vertical";
      type: "split";
    };

type ManagedHistoryEntry = {
  contentId: ContentId;
  contentType: ContentType;
  contentValue: ContentSetRequest["payload"]["content"];
  historyOwnerToken: string | null;
  revision: Revision;
  sessionKey: string | null;
};

type ManagedPane = {
  activeContentId: ContentId | null;
  contentType: ContentType | null;
  contentValue: ContentSetRequest["payload"]["content"] | null;
  currentRevision: Revision;
  historyEntries: ManagedHistoryEntry[];
  historySummary: SurfAceHistorySummary;
  historyOwnerToken: string | null;
  name: string | null;
  ownerSessionKey: string | null;
  paneId: PaneId;
  paneLabel: number;
  pendingOwnerSessionKey: string | null;
  remotePaneId: RemotePaneId;
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
  consecutiveOwnershipLockFailures: number;
  connectedAt: number | null;
  endpoint: SurfAceDiscoveryEndpoint;
  endpointId: string;
  fingerprintPrefix: string;
  hasPairedInGatewaySession: boolean;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  heartbeatMisses: number;
  heartbeatNonce: string | null;
  lastSeenAt: number;
  layout: ManagedLayoutNode | null;
  name: string;
  paneIdsNeedingSnapshot: Set<PaneId>;
  panes: Map<PaneId, ManagedPane>;
  recentEventIds: string[];
  recentEventIdsSet: Set<string>;
  reconnectAttempt: number;
  retryDelayResolver: (() => void) | null;
  sessionId: SessionId | null;
  snapshotBufferedEvents: Event[];
  snapshotSyncInFlight: boolean;
  stopRequested: boolean;
  surfaceId: SurfaceId;
  topologyRevision: number;
  unreachableFailures: number;
  viewport: SurfaceViewport;
  windowLabel: string;
  workPromise: Promise<void> | null;
};

type RuntimeStateFile = {
  nextRemotePaneId: number;
  nextPaneLabel: number;
  nextWindowLabelIndex: number;
  paneLabelsByPaneId: Record<string, number>;
  providerId: string;
  version: 1;
  windowLabels: Record<string, string>;
};

type PersistedRestartContentEntry = {
  contentId: string;
  contentType: ContentType;
  contentValue: ContentSetRequest["payload"]["content"];
  historyOwnerToken: string | null;
  paneLabel: number;
  revision: number;
  sessionKey: string | null;
};

type PersistedScreenSnapshotFile = {
  contentContinuity?: Record<string, PersistedRestartContentEntry[]>;
  screens: SurfAceScreenSummary[];
  updatedAt: number;
  version: 1;
};

type RuntimeDiagnosticFields = Record<string, boolean | number | string | null | undefined>;

function formatRuntimeDiagnosticValue(value: string | number | boolean): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:@%-]+$/.test(text) ? text : JSON.stringify(text);
}

function runtimeDiagnostic(event: string, fields: RuntimeDiagnosticFields = {}): string {
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatRuntimeDiagnosticValue(value as string | number | boolean)}`)
    .join(" ");
  return suffix.length > 0
    ? `[surf-ace:runtime] event=${event} ${suffix}`
    : `[surf-ace:runtime] event=${event}`;
}

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
const RESTART_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;
const RECONNECT_BACKOFF_BASE_MS = 2_000;
const RECONNECT_BACKOFF_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_RESET_MS = 30_000;
const UNREACHABLE_AFTER_FAILURES = 3;
const ALERT_RESET_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ALERT_SESSION_KEY = "agent:main:main";
const ALERT_ENDPOINT_URL = "http://localhost:18800/alert";
const MAX_CONSECUTIVE_RESUME_FAILURES = 3;
const MAX_CONSECUTIVE_OWNERSHIP_LOCK_FAILURES = 3;
const STATE_FILE_NAME = "surf-ace-runtime-state.json";
const SCREEN_SNAPSHOT_FILE_NAME = "surf-ace-runtime-screens.json";
const RUNTIME_LEASE_FILE_NAME = "surf-ace-runtime-owner.lock";
const OWNER_CONTROL_PATH = "/surf-ace-runtime-owner";
const OWNER_CONTROL_MAX_BODY_BYTES = 1024 * 1024;

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

type OwnerControlCommand =
  | {
      context?: { sessionKey?: string };
      input: SurfAcePushInput;
      op: "push";
    }
  | {
      input: { fingerprint: string; paneId: PaneId };
      op: "clear" | "closePane" | "read" | "snapshot";
    }
  | {
      input: SurfAceSplitInput;
      op: "split";
    }
  | {
      input: { fingerprint: string };
      op: "relinquish";
    }
  | {
      input: SurfAceAnnotateRemoveInput;
      op: "annotateRemove";
    };

type RuntimeLeaseFile = {
  controlPort?: number;
  lastActiveAt?: number;
  pid?: number;
  startedAt?: number;
};

function asEpochMs(value: number): EpochMs {
  return value as EpochMs;
}

function asPaneId(value: string): PaneId {
  return value as PaneId;
}

function asRemotePaneId(value: number): RemotePaneId {
  return value as RemotePaneId;
}

function isBoundRemotePaneId(value: RemotePaneId | null | undefined): value is RemotePaneId {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0;
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

/**
 * Build the WebSocket URL for a discovery endpoint, applying host overrides
 * from SURF_ACE_HOST_MAP when present.
 *
 * SURF_ACE_HOST_MAP is a comma-separated list of `host:port=host:port` pairs.
 * Example: `Aleph.local:19001=127.0.0.1:19002`
 */
const hostMap: Map<string, { host: string; port: number }> = (() => {
  const map = new Map<string, { host: string; port: number }>();
  const raw = process.env["SURF_ACE_HOST_MAP"] ?? "";
  for (const entry of raw.split(",").filter(Boolean)) {
    const [from, to] = entry.split("=");
    if (from && to) {
      const [toHost, toPortStr] = to.split(":");
      const toPort = Number(toPortStr);
      if (toHost && !Number.isNaN(toPort)) {
        map.set(from.trim(), { host: toHost.trim(), port: toPort });
      }
    }
  }
  return map;
})();

function buildWsUrl(endpoint: SurfAceDiscoveryEndpoint): string {
  const key = `${endpoint.host}:${endpoint.port}`;
  const override = hostMap.get(key);
  if (override) {
    return `ws://${override.host}:${override.port}${endpoint.wsPath}`;
  }
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
  paneLabel: number,
  remotePaneId: RemotePaneId = asRemotePaneId(0),
  viewport: SurfaceViewport = DEFAULT_VIEWPORT,
): ManagedPane {
  return {
    activeContentId: null,
    buffer: createPaneBuffer(),
    contentType: null,
    contentValue: null,
    currentRevision: asRevision(0),
    historyEntries: [],
    historySummary: {
      backCount: 0,
      forwardCount: 0,
      visibleContentId: null,
    },
    historyOwnerToken: null,
    name: null,
    ownerSessionKey: null,
    paneId,
    paneLabel,
    pendingOwnerSessionKey: null,
    remotePaneId,
    snapshot: null,
    viewport: cloneViewport(viewport),
  };
}

function createManagedSurface(
  surfaceId: SurfaceId,
  endpoint: SurfAceDiscoveryEndpoint,
  name: string,
  viewport: SurfaceViewport,
  windowLabel: string,
  now: number,
): ManagedSurface {
  return {
    alertFired: false,
    alertFiredAt: null,
    autoRetryEnabled: true,
    client: null,
    connectionState: "connecting",
    consecutiveResumeFailures: 0,
    consecutiveOwnershipLockFailures: 0,
    connectedAt: null,
    endpoint,
    endpointId: endpoint.endpointId,
    fingerprintPrefix: endpoint.fingerprintPrefix,
    hasPairedInGatewaySession: false,
    heartbeatInterval: null,
    heartbeatMisses: 0,
    heartbeatNonce: null,
    lastSeenAt: now,
    layout: null,
    name,
    paneIdsNeedingSnapshot: new Set<PaneId>(),
    panes: new Map<PaneId, ManagedPane>(),
    recentEventIds: [],
    recentEventIdsSet: new Set<string>(),
    reconnectAttempt: 0,
    retryDelayResolver: null,
    sessionId: null,
    snapshotBufferedEvents: [],
    snapshotSyncInFlight: false,
    stopRequested: false,
    surfaceId,
    topologyRevision: 0,
    unreachableFailures: 0,
    viewport: cloneViewport(viewport),
    windowLabel,
    workPromise: null,
  };
}

function flattenManagedLayout(node: ManagedLayoutNode | null): PaneId[] {
  if (!node) {
    return [];
  }
  if (node.type === "pane") {
    return [node.paneId];
  }
  return node.children.flatMap((child) => flattenManagedLayout(child));
}

function splitManagedLayoutNode(
  node: ManagedLayoutNode,
  targetPaneId: PaneId,
  direction: "horizontal" | "vertical",
  paneIds: PaneId[],
): ManagedLayoutNode {
  if (node.type === "pane") {
    if (node.paneId !== targetPaneId) {
      return node;
    }
    return {
      children: paneIds.map((paneId) => ({ paneId, type: "pane" })),
      direction,
      type: "split",
    };
  }
  return {
    ...node,
    children: node.children.map((child) => splitManagedLayoutNode(child, targetPaneId, direction, paneIds)),
  };
}

function removePaneFromManagedLayout(node: ManagedLayoutNode, paneId: PaneId): ManagedLayoutNode | null {
  if (node.type === "pane") {
    return node.paneId === paneId ? null : node;
  }
  const nextChildren = node.children
    .map((child) => removePaneFromManagedLayout(child, paneId))
    .filter((child): child is ManagedLayoutNode => child !== null);
  if (nextChildren.length === 0) {
    return null;
  }
  if (nextChildren.length === 1) {
    return nextChildren[0]!;
  }
  return {
    ...node,
    children: nextChildren,
  };
}

function collapseManagedLayout(node: ManagedLayoutNode | null): ManagedLayoutNode {
  if (!node) {
    throw new SurfAceToolError("internal_error", "Surface layout collapsed unexpectedly");
  }
  if (node.type === "pane") {
    return node;
  }
  if (node.children.length === 1) {
    return collapseManagedLayout(node.children[0]!);
  }
  return {
    ...node,
    children: node.children.map((child) => collapseManagedLayout(child)),
  };
}

function remoteLayoutToTopologyLayout(
  surface: ManagedSurface,
  node: ManagedLayoutNode,
): TopologyApplyRequest["payload"]["layout"] {
  if (node.type === "pane") {
    const pane = surface.panes.get(node.paneId);
    if (!pane) {
      throw new SurfAceToolError(
        "internal_error",
        `Surface ${surface.surfaceId} layout referenced missing pane ${node.paneId}`,
      );
    }
    return {
      paneId: pane.remotePaneId,
      type: "pane",
    };
  }
  return {
    children: node.children.map((child) => remoteLayoutToTopologyLayout(surface, child)),
    direction: node.direction,
    type: "split",
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
  if (points.length === 0) {
    return {
      height: 0,
      width: 0,
      x: 0,
      y: 0,
    };
  }

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

function convertStrokeToFrameStroke(
  stroke: Stroke,
  fallbackTimestamp: number,
): SurfAceFrameStroke {
  const firstPoint = stroke.points[0];
  const lastPoint = stroke.points[stroke.points.length - 1];
  return {
    bbox: computeStrokeBBox(stroke.points),
    endedAt: lastPoint?.timestamp ?? fallbackTimestamp,
    points: stroke.points.map((point) => ({
      pressure: point.pressure,
      x: point.x,
      y: point.y,
    })),
    startedAt: firstPoint?.timestamp ?? fallbackTimestamp,
    strokeId: stroke.strokeId,
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

function sameHistorySessionKey(left: string | null, right: string | null): boolean {
  return left === right;
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

function isOwnershipLockResponse(response: Response): response is ErrorResponse {
  return (
    isErrorResponse(response) &&
    (response.error.code === "busy" || response.error.code === "invalid_resume")
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

function paneLabelStorageKey(surfaceId: string, remotePaneId: RemotePaneId): string {
  return `${surfaceId}::${Number(remotePaneId)}`;
}

function migratePersistedPaneId(fingerprint: string, legacyPaneId: unknown, paneLabel: number): PaneId {
  if (typeof legacyPaneId === "string") {
    return asPaneId(legacyPaneId);
  }
  const digest = createHash("sha256")
    .update(`${fingerprint}:${Number(legacyPaneId ?? 0)}:${paneLabel}`)
    .digest("hex")
    .slice(0, 32);
  return asPaneId(`pn_${digest}`);
}

export class DefaultSurfAceRuntime implements SurfAceRuntime {
  private readonly deliverSettledAnnotationTurn?: (
    turn: SurfAceAnnotationIntentTurn,
  ) => Promise<void>;
  private readonly discovery: SurfAceDiscoveryService;
  private readonly drawingFlushConfig: DrawingFlushConfig;
  private readonly eventProfile: EventProfile;
  private readonly listeners = new Set<(event: SurfAceLocalEvent) => void>();
  private readonly logger: SurfAceLogger;
  private readonly now: () => number;
  private readonly providerName: string;
  private readonly stateDir: string;
  private readonly surfaces = new Map<string, ManagedSurface>();
  private persistentState: RuntimeStateFile = {
    nextRemotePaneId: 1,
    nextPaneLabel: 1,
    nextWindowLabelIndex: 0,
    paneLabelsByPaneId: {},
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
  private ownerControlPort: number | null = null;
  private ownerControlServer: Server | null = null;
  private screenSnapshotWrite: Promise<void> = Promise.resolve();
  private restartContentBySurface = new Map<string, PersistedRestartContentEntry[]>();
  private restartSnapshots = new Map<string, SurfAceScreenSummary>();

  constructor(options: SurfAceRuntimeOptions = {}) {
    this.deliverSettledAnnotationTurn = options.deliverSettledAnnotationTurn;
    this.discovery = options.discovery ?? createBonjourSurfAceDiscoveryService({ logger: options.logger });
    this.drawingFlushConfig = options.drawingFlushConfig ?? DEFAULT_DRAWING_FLUSH_CONFIG;
    this.eventProfile = options.eventProfile ?? "minimum_deep";
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => Date.now());
    this.providerName = options.providerName ?? "CLU / Surf Ace";
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
      if (this.ownsRuntimeLease) {
        await this.startOwnerControlServer();
        await this.refreshRuntimeLease();
      }
      this.logger.info?.(`[surf-ace:runtime] start() — lease acquired: ${this.ownsRuntimeLease}`);
      if (!this.ownsRuntimeLease) {
        this.logger.info?.(
          "[surf-ace:runtime] passive process; another OpenClaw process owns the Surf Ace runtime lease",
        );
        this.started = true;
        return;
      }
      await this.loadRestartSnapshots();
      // Clear stale workPromises left over from a previous lifecycle (e.g.
      // stop() was called but start() fires before its await-all resolves).
      // Surfaces with a stale workPromise would cause ensureSurfaceWorker to
      // skip, so new workers would never start.
      for (const surface of this.surfaces.values()) {
        if (surface.workPromise) {
          this.logger.info?.(
            `[surf-ace:runtime] start() — clearing stale workPromise for ${surface.surfaceId}`,
          );
          surface.workPromise = null;
          surface.stopRequested = false;
        }
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
      this.wakeSurfaceRetry(surface);
      if (surface.client) {
        await surface.client.close(1000, clampCloseReason("provider_shutdown"));
      }
      await surface.workPromise;
    });

    await Promise.all(stopPromises);
    this.surfaces.clear();
    await this.persistScreenSnapshot();
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
    if (this.ownsRuntimeLease) {
      return this.buildScreenSummaries();
    }
    return await this.loadPersistedScreenSnapshot();
  }

  async push(
    input: SurfAcePushInput,
    context?: { sessionKey?: string },
  ): Promise<SurfAcePushResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAcePushResult>({
        context,
        input,
        op: "push",
      });
    }
    const surface = this.requireConnectedSurface(input.fingerprint);
    return await this.contentSet(surface, input, context?.sessionKey);
  }

  async clear(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceClearResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceClearResult>({ input, op: "clear" });
    }
    const surface = this.requireConnectedSurface(input.fingerprint);
    return await this.contentClear(surface, input);
  }

  async split(input: SurfAceSplitInput): Promise<SurfAceSplitResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceSplitResult>({ input, op: "split" });
    }
    const surface = this.requireConnectedSurface(input.fingerprint);
    return await this.paneSplit(surface, input);
  }

  async closePane(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceClosePaneResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceClosePaneResult>({ input, op: "closePane" });
    }
    const surface = this.requireConnectedSurface(input.fingerprint);
    return await this.paneClose(surface, input);
  }

  async relinquish(input: { fingerprint: string }): Promise<SurfAceRelinquishResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceRelinquishResult>({ input, op: "relinquish" });
    }
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
    this.queuePersistScreenSnapshot("ownership relinquish");
    return { relinquished: true };
  }

  async read(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceReadResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceReadResult>({ input, op: "read" });
    }
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
      paneLabel: pane.paneLabel,
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

  async snapshot(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceSnapshotResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceSnapshotResult>({ input, op: "snapshot" });
    }
    const pane = this.requirePane(input.fingerprint, input.paneId);
    return {
      fingerprint: input.fingerprint,
      paneId: pane.paneId,
      paneLabel: pane.paneLabel,
      snapshot: pane.snapshot ? structuredClone(pane.snapshot) : null,
    };
  }

  async annotateRemove(
    input: SurfAceAnnotateRemoveInput,
  ): Promise<SurfAceAnnotateRemoveResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceAnnotateRemoveResult>({
        input,
        op: "annotateRemove",
      });
    }
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
      paneLabel: pane.paneLabel,
      remainingStrokeCount: payload.remainingStrokeCount,
      removedStrokeIds: [...payload.removedStrokeIds],
    };
  }

  private async contentClear(
    surface: ManagedSurface,
    input: { fingerprint: string; paneId: PaneId },
  ): Promise<SurfAceClearResult> {
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    this.finalizeLiveFrame(surface, pane);

    const request: ContentApplyRequest = {
      id: makeBrandedRequestId(),
      op: "content.apply",
      payload: {
        clear: true,
        paneId: pane.remotePaneId,
        revision: asRevision((pane.currentRevision as number) + 1),
        topologyRevision: surface.topologyRevision as TopologyApplyRequest["payload"]["topologyRevision"],
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
    const currentLayout = collapseManagedLayout(surface.layout);
    const reservedPanes: ManagedPane[] = [];
    const additionalPaneCount = input.count - 1;
    for (let index = 0; index < additionalPaneCount; index += 1) {
      const paneId = this.allocatePaneId();
      const remotePaneId = this.allocateRemotePaneId();
      const paneLabel = this.ensurePaneLabel(surface, null);
      const created = createPane(paneId, paneLabel, remotePaneId, surface.viewport);
      surface.panes.set(created.paneId, created);
      reservedPanes.push(created);
    }

    surface.layout = splitManagedLayoutNode(
      currentLayout,
      pane.paneId,
      input.direction,
      [pane.paneId, ...reservedPanes.map((reservedPane) => reservedPane.paneId)],
    );

    try {
      await this.pushTopology(surface, { increment: true });
    } catch (error) {
      surface.layout = currentLayout;
      for (const reservedPane of reservedPanes) {
        surface.panes.delete(reservedPane.paneId);
      }
      throw error;
    }
    this.queuePersistScreenSnapshot("pane split");
    return this.orderedPanes(surface).map((managedPane) => ({
      paneId: managedPane.paneId,
      paneLabel: managedPane.paneLabel,
    }));
  }

  private async paneClose(
    surface: ManagedSurface,
    input: { fingerprint: string; paneId: PaneId },
  ): Promise<SurfAceClosePaneResult> {
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    if (surface.panes.size <= 1) {
      throw new SurfAceToolError(
        "invalid_operation",
        "Cannot close the last remaining pane.",
      );
    }

    const currentLayout = collapseManagedLayout(surface.layout);
    const nextLayout = collapseManagedLayout(removePaneFromManagedLayout(currentLayout, pane.paneId));
    surface.layout = nextLayout;
    surface.panes.delete(pane.paneId);

    try {
      await this.pushTopology(surface, { increment: true });
    } catch (error) {
      surface.panes.set(pane.paneId, pane);
      surface.layout = currentLayout;
      throw error;
    }

    this.queuePersistScreenSnapshot("pane close");
    return {
      ok: true,
      paneId: pane.paneId,
      paneLabel: pane.paneLabel,
    };
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

    const request: ContentApplyRequest = {
      id: makeBrandedRequestId(),
      op: "content.apply",
      payload: {
        content: normalizedContent,
        contentId: nextContentId,
        contentType: input.contentType,
        historyOwnerToken: historyOwnerTokenForSession(sessionKey),
        paneId: pane.remotePaneId,
        revision: asRevision((pane.currentRevision as number) + 1),
        topologyRevision: surface.topologyRevision as TopologyApplyRequest["payload"]["topologyRevision"],
      } as ContentApplyRequest["payload"],
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    };

    const previousVisibleText = pane.snapshot?.visibleText?.trim() ?? "";
    const response = await this.sendRequest(surface, request);
    const result = this.applyMutationResponse(surface, pane, response, request, sessionKey) as SurfAcePushResult;
    if (input.contentType === "html") {
      await this.syncPaneSnapshot(surface, pane, {
        waitForVisibleText: true,
        waitForVisibleTextChangeFrom: previousVisibleText,
      });
    }
    return result;
  }

  private emit(event: SurfAceLocalEvent): void {
    this.queuePersistScreenSnapshot("emit");
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private finalizeLiveFrame(surface: ManagedSurface, pane: ManagedPane): void {
    if (!pane.buffer.liveFrame) {
      return;
    }
    const finalizedFrame = structuredClone(pane.buffer.liveFrame);
    pane.buffer.closedFrames.push(finalizedFrame);
    pane.buffer.liveFrame = null;
    pane.buffer.liveDirtyStrokeIds = [];
    this.maybeDeliverSettledAnnotationTurn(surface, pane, finalizedFrame);
  }

  private maybeDeliverSettledAnnotationTurn(
    surface: ManagedSurface,
    pane: ManagedPane,
    frame: SurfAceFrame,
  ): void {
    const turn = this.buildSettledAnnotationIntentTurn(surface, pane, frame);
    if (!turn) {
      return;
    }
    if (!this.deliverSettledAnnotationTurn) {
      this.logger.warn?.(
        `[surf-ace:runtime] settled annotation delivery unavailable for ${surface.surfaceId}/${pane.paneId}; leaving frame queued`,
      );
      return;
    }

    this.runBackgroundTask(
      `settled annotation turn for ${surface.surfaceId}/${pane.paneId}/${frame.frameId}`,
      async () => {
        await this.deliverSettledAnnotationTurn?.(turn);
      },
    );
  }

  private buildSettledAnnotationIntentTurn(
    surface: ManagedSurface,
    pane: ManagedPane,
    frame: SurfAceFrame,
  ): SurfAceAnnotationIntentTurn | null {
    const image = frame.image.trim();
    if (!image) {
      this.logger.warn?.(
        `[surf-ace:runtime] settled annotation frame missing image for ${surface.surfaceId}/${pane.paneId}/${frame.frameId}; leaving frame queued`,
      );
      return null;
    }

    const sessionKey = pane.ownerSessionKey ?? DEFAULT_ALERT_SESSION_KEY;
    const strokeSummary = frame.strokes.map((stroke) => ({
      bbox: stroke.bbox,
      endedAt: stroke.endedAt,
      pointCount: stroke.points.length,
      startedAt: stroke.startedAt,
      strokeId: stroke.strokeId,
    }));

    return {
      attachment: {
        content: image,
        fileName: `surf-ace-${surface.surfaceId}-pane-${pane.paneId}-${frame.frameId}.png`,
        mimeType: "image/png",
        type: "file",
      },
      fingerprint: surface.surfaceId,
      frame: structuredClone(frame),
      idempotencyKey: `surf-ace-annotation-intent:${surface.surfaceId}:${pane.paneId}:${frame.frameId}`,
      message: [
        `Surf Ace settled annotation on surface "${surface.name}", pane ${pane.paneLabel}.`,
        "Treat the attached image as the primary annotation input.",
        "Use the stroke metadata below as secondary context only.",
        "",
        JSON.stringify(
          {
            contentId: frame.contentId,
            contextKey: frame.contextKey,
            fingerprint: surface.surfaceId,
            frameId: frame.frameId,
            openedAt: frame.openedAt,
            paneId: pane.paneId,
            paneLabel: pane.paneLabel,
            scrollOffset: frame.scrollOffset,
            strokeCount: frame.strokes.length,
            strokes: strokeSummary,
            surfaceName: surface.name,
            updatedAt: frame.updatedAt,
            url: frame.url,
            viewport: frame.viewport,
          },
          null,
          2,
        ),
      ].join("\n"),
      paneId: pane.paneId,
      sessionKey,
      surfaceName: surface.name,
    };
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
          surface,
          pane,
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

  private buildAnnotationAlertAttachment(
    surface: ManagedSurface,
    pane: ManagedPane,
    frameId: string,
    image: string,
  ): SurfAceAnnotationIntentTurn["attachment"] {
    return {
      content: image,
      fileName: `surf-ace-${surface.surfaceId}-pane-${pane.paneId}-${frameId}.png`,
      mimeType: "image/png",
      type: "file",
    };
  }

  private async resolveAnnotationAlertAttachment(
    surface: ManagedSurface,
    pane: ManagedPane,
  ): Promise<SurfAceAnnotationIntentTurn["attachment"] | null> {
    const liveFrame = pane.buffer.liveFrame;
    const liveImage = liveFrame?.image.trim();
    if (liveFrame && liveImage) {
      return this.buildAnnotationAlertAttachment(surface, pane, liveFrame.frameId, liveImage);
    }

    if (liveFrame && this.canSendRequests(surface)) {
      await this.captureLiveFrameSnapshot(surface, pane, liveFrame.frameId, "annotation alert snapshot");
      const refreshedFrame = pane.buffer.liveFrame;
      const refreshedImage =
        refreshedFrame?.frameId === liveFrame.frameId ? refreshedFrame.image.trim() : "";
      if (refreshedFrame && refreshedImage) {
        return this.buildAnnotationAlertAttachment(
          surface,
          pane,
          refreshedFrame.frameId,
          refreshedImage,
        );
      }
    }

    const snapshotImage = pane.snapshot?.image?.trim();
    if (snapshotImage) {
      return this.buildAnnotationAlertAttachment(
        surface,
        pane,
        liveFrame?.frameId ?? "snapshot",
        snapshotImage,
      );
    }

    return null;
  }

  private async postAnnotationAlert(
    surface: ManagedSurface,
    pane: ManagedPane,
    message: string,
    sessionKey: string,
  ): Promise<void> {
    try {
      const attachment = await this.resolveAnnotationAlertAttachment(surface, pane);
      if (!attachment) {
        this.logger.warn?.(
          `[surf-ace:runtime] annotation alert missing image for ${surface.surfaceId}/${pane.paneId}; falling back to text-only alert`,
        );
      }
      await fetch(ALERT_ENDPOINT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attachments: attachment ? [attachment] : undefined,
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
    this.logger.warn?.(
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
    this.queuePersistScreenSnapshot("discovery update");
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

  private handleHistoryNavigatedEvent(surface: ManagedSurface, event: HistoryNavigatedEvent): void {
    const pane = this.ensurePane(surface, event.payload.paneId);
    const previousVisibleEntry = this.visibleHistoryEntry(pane);
    if (event.payload.contentId === null) {
      this.storeHiddenHistoryEntry(pane, previousVisibleEntry);
      this.clearVisiblePaneContent(pane, event.payload.revision);
    } else if (pane.activeContentId !== event.payload.contentId) {
      const targetEntry = this.takeHiddenHistoryEntryByContentId(pane, event.payload.contentId);
      if (targetEntry) {
        this.storeHiddenHistoryEntry(pane, previousVisibleEntry);
        this.applyVisibleEntry(pane, {
          ...targetEntry,
          revision: event.payload.revision,
        });
      }
    } else {
      pane.currentRevision = event.payload.revision;
    }
    const previousVisibleContentId = pane.historySummary.visibleContentId;
    pane.historySummary.visibleContentId = event.payload.contentId;
    if (event.payload.direction === "back") {
      pane.historySummary.backCount = Math.max(0, pane.historySummary.backCount - 1);
      pane.historySummary.forwardCount += previousVisibleContentId ? 1 : 0;
      return;
    }
    pane.historySummary.backCount += event.payload.contentId ? 1 : 0;
    pane.historySummary.forwardCount = Math.max(0, pane.historySummary.forwardCount - 1);
  }

  private handlePaneCreatedEvent(surface: ManagedSurface, event: PaneCreatedEvent): void {
    this.logger.info?.(
      runtimeDiagnostic("ignored_surface_topology_event", {
        event: "event.pane_created",
        pane_id: event.payload.paneId,
        surface_id: surface.surfaceId,
      }),
    );
  }

  private handlePaneRemovedEvent(surface: ManagedSurface, event: PaneRemovedEvent): void {
    this.logger.info?.(
      runtimeDiagnostic("ignored_surface_topology_event", {
        event: "event.pane_removed",
        pane_id: event.payload.paneId,
        surface_id: surface.surfaceId,
      }),
    );
  }

  private handlePaneRenamedEvent(surface: ManagedSurface, event: PaneRenamedEvent): void {
    this.logger.info?.(
      runtimeDiagnostic("ignored_surface_topology_event", {
        event: "event.pane_renamed",
        pane_id: event.payload.paneId,
        surface_id: surface.surfaceId,
      }),
    );
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
    const windowLabel = existing?.windowLabel || this.ensureWindowLabel(event.payload.surfaceId);
    const surface = existing ?? createManagedSurface(
      event.payload.surfaceId,
      sourceSurface.endpoint,
      event.payload.name,
      event.payload.viewport,
      windowLabel,
      this.now(),
    );

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
    const resumedPaneId = this.firstPane(surface)?.paneId ?? this.allocatePaneId();
    this.emit({
      paneId: resumedPaneId,
      surfaceId: event.payload.surfaceId,
      type: "event.surface_resumed",
    });
    this.refreshEndpointTopology(surface.endpoint);
    this.runBackgroundTask(
      `surface resumed sync for ${surface.surfaceId}`,
      async () => {
        await this.repushSurfaceContent(surface);
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
      case "event.annotation_committed":
        this.handleAnnotationCommittedEvent(surface, event);
        break;
      case "event.drawing_flush":
        this.ingestDrawingFlush(surface, event);
        break;
      case "event.history_navigated":
        this.handleHistoryNavigatedEvent(surface, event);
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
    this.queuePersistScreenSnapshot(`wire event ${event.op}`);
  }

  private ingestDrawingFlush(surface: ManagedSurface, event: DrawingFlushEvent): void {
    this.logger.info?.(
      `[surf-ace:runtime] ingestDrawingFlush for ${surface.surfaceId} pane=${event.payload.paneId} strokes=${event.payload.strokes?.length ?? "MISSING"}`,
    );
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
          await this.captureLiveFrameSnapshot(surface, pane, frameId, "frame-open snapshot");
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

  private handleAnnotationCommittedEvent(
    surface: ManagedSurface,
    event: AnnotationCommittedEvent,
  ): void {
    const pane = this.ensurePane(surface, event.payload.paneId);
    const liveFrame = pane.buffer.liveFrame;
    if (!liveFrame || liveFrame.contentId !== event.payload.contentId) {
      return;
    }
    const frameId = liveFrame.frameId;
    this.runBackgroundTask(
      `annotation commit snapshot for ${surface.surfaceId}/${pane.paneId}/${frameId}`,
      async () => {
        await this.captureLiveFrameSnapshot(surface, pane, frameId, "annotation commit");
        if (surface.stopRequested) {
          return;
        }
        if (pane.buffer.liveFrame?.frameId !== frameId) {
          return;
        }
        this.finalizeLiveFrame(surface, pane);
        this.queuePersistScreenSnapshot(
          `annotation committed ${surface.surfaceId}/${pane.paneId}/${frameId}`,
        );
      },
    );
  }

  private async captureLiveFrameSnapshot(
    surface: ManagedSurface,
    pane: ManagedPane,
    frameId: string,
    reason: string,
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
      pane.buffer.liveFrame.updatedAt = this.now();
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
        `[surf-ace:runtime] ${reason} failed for ${surface.surfaceId}/${pane.paneId}: ${String(error)}`,
      );
    }
  }

  private ensurePane(surface: ManagedSurface, remotePaneId: RemotePaneId): ManagedPane {
    this.noteObservedRemotePaneId(remotePaneId);
    const existing = this.findPaneByRemoteId(surface, remotePaneId);
    if (existing) {
      existing.paneLabel = this.ensurePaneLabel(surface, existing, remotePaneId);
      return existing;
    }
    const paneId = this.allocatePaneId();
    const paneLabel = this.ensurePaneLabel(surface, null, remotePaneId);
    const created = createPane(paneId, paneLabel, remotePaneId, surface.viewport);
    surface.panes.set(created.paneId, created);
    surface.layout ??= { paneId: created.paneId, type: "pane" };
    return created;
  }

  private ensureInitialPairPane(surface: ManagedSurface): RemotePaneId {
    const existingFirstPane = this.firstPane(surface);
    if (existingFirstPane && existingFirstPane.remotePaneId > asRemotePaneId(0)) {
      this.noteObservedRemotePaneId(existingFirstPane.remotePaneId);
      existingFirstPane.paneLabel = this.ensurePaneLabel(
        surface,
        existingFirstPane,
        existingFirstPane.remotePaneId,
      );
      surface.layout ??= { paneId: existingFirstPane.paneId, type: "pane" };
      return existingFirstPane.remotePaneId;
    }

    if (existingFirstPane) {
      existingFirstPane.remotePaneId = this.allocateRemotePaneId();
      existingFirstPane.paneLabel = this.ensurePaneLabel(surface, existingFirstPane);
      surface.layout ??= { paneId: existingFirstPane.paneId, type: "pane" };
      return existingFirstPane.remotePaneId;
    }

    if (surface.panes.size === 0) {
      const initialPaneId = this.allocatePaneId();
      const initialRemotePaneId = this.allocateRemotePaneId();
      const initialPaneLabel = this.ensurePaneLabel(surface, null);
      surface.panes = new Map<PaneId, ManagedPane>([
        [initialPaneId, createPane(initialPaneId, initialPaneLabel, initialRemotePaneId, surface.viewport)],
      ]);
      surface.layout = { paneId: initialPaneId, type: "pane" };
      surface.snapshotBufferedEvents = [];
      return initialRemotePaneId;
    }

    throw new SurfAceToolError("internal_error", `Surface ${surface.surfaceId} has no initial pane`);
  }

  private firstPane(surface: ManagedSurface): ManagedPane | null {
    for (const paneId of flattenManagedLayout(surface.layout)) {
      const pane = surface.panes.get(paneId);
      if (pane) {
        return pane;
      }
    }
    let first: ManagedPane | null = null;
    for (const pane of surface.panes.values()) {
      if (
        !first ||
        pane.paneLabel < first.paneLabel ||
        (pane.paneLabel === first.paneLabel && pane.paneId < first.paneId)
      ) {
        first = pane;
      }
    }
    return first;
  }

  private findPaneByRemoteId(surface: ManagedSurface, remotePaneId: RemotePaneId): ManagedPane | null {
    for (const pane of surface.panes.values()) {
      if (pane.remotePaneId === remotePaneId) {
        return pane;
      }
    }
    return null;
  }

  private consumeBootstrapPaneForPairState(
    surface: ManagedSurface,
    remotePaneId: RemotePaneId,
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
    this.noteObservedRemotePaneId(remotePaneId);
    bootstrapPane.paneLabel = this.ensurePaneLabel(surface, bootstrapPane, remotePaneId);
    return bootstrapPane;
  }

  private recoverSolePaneForTopologySync(
    surface: ManagedSurface,
    remotePaneId: RemotePaneId,
    remotePaneCount: number,
  ): ManagedPane | null {
    if (remotePaneCount !== 1 || surface.panes.size !== 1) {
      return null;
    }
    if (this.findPaneByRemoteId(surface, remotePaneId)) {
      return null;
    }

    const existingPane = surface.panes.values().next().value ?? null;
    if (!existingPane) {
      return null;
    }

    existingPane.remotePaneId = remotePaneId;
    this.noteObservedRemotePaneId(remotePaneId);
    existingPane.paneLabel = this.ensurePaneLabel(surface, existingPane, remotePaneId);
    return existingPane;
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

  private preserveSurfaceStateUntilPairResponse(
    remappedSurface: ManagedSurface,
    preservedSurface: ManagedSurface,
  ): void {
    if (preservedSurface === remappedSurface) {
      return;
    }
    remappedSurface.panes = new Map(preservedSurface.panes);
    remappedSurface.layout = preservedSurface.layout
      ? structuredClone(preservedSurface.layout)
      : null;
    remappedSurface.topologyRevision = preservedSurface.topologyRevision;
    remappedSurface.hasPairedInGatewaySession = preservedSurface.hasPairedInGatewaySession;
    remappedSurface.sessionId = preservedSurface.sessionId;
    remappedSurface.consecutiveResumeFailures = preservedSurface.consecutiveResumeFailures;
    remappedSurface.consecutiveOwnershipLockFailures = preservedSurface.consecutiveOwnershipLockFailures;
  }

  private quiesceSupersededSurface(
    supersededSurface: ManagedSurface,
    replacementSurfaceId: SurfaceId,
  ): void {
    supersededSurface.stopRequested = true;
    supersededSurface.autoRetryEnabled = false;
    supersededSurface.connectionState = "connecting";
    this.stopHeartbeat(supersededSurface);
    this.wakeSurfaceRetry(supersededSurface);
    if (!supersededSurface.client) {
      return;
    }
    this.runBackgroundTask(
      `close superseded surface ${supersededSurface.surfaceId} -> ${replacementSurfaceId}`,
      async () => {
        const client = supersededSurface.client;
        if (!client) {
          return;
        }
        await this.closeSurfaceClient(
          supersededSurface,
          client,
          clampCloseReason("provider_shutdown"),
        );
      },
      );
  }

  private adoptCanonicalSurfaceId(
    surface: ManagedSurface,
    nextSurfaceId: SurfaceId,
    source: "pair.response" | "surfaces.list",
  ): void {
    if (nextSurfaceId === surface.surfaceId) {
      if (!surface.windowLabel) {
        surface.windowLabel = this.ensureWindowLabel(nextSurfaceId);
      }
      this.restoreRestartOwnership(surface);
      return;
    }

    const oldSurfaceId = surface.surfaceId;
    const preservedSurface = this.surfaces.get(nextSurfaceId);
    if (this.surfaces.get(oldSurfaceId) === surface) {
      this.surfaces.delete(oldSurfaceId);
    }
    if (preservedSurface && preservedSurface !== surface) {
      this.preserveSurfaceStateUntilPairResponse(surface, preservedSurface);
      this.quiesceSupersededSurface(preservedSurface, nextSurfaceId);
    }
    this.logger.info?.(
      runtimeDiagnostic("surface_adopt_remote_id", {
        endpoint_id: surface.endpointId,
        from_surface_id: oldSurfaceId,
        panes: preservedSurface?.panes.size ?? surface.panes.size,
        source,
        to_surface_id: nextSurfaceId,
      }),
    );
    surface.surfaceId = nextSurfaceId;
    surface.windowLabel = this.reconcileWindowLabel(
      oldSurfaceId,
      nextSurfaceId,
      surface.windowLabel,
    );
    this.reconcilePaneLabelsBySurfaceId(oldSurfaceId, nextSurfaceId);
    this.surfaces.set(nextSurfaceId, surface);
    this.restoreRestartOwnership(surface);
    this.runBackgroundTask(
      `persist remapped surface id ${surface.endpointId}`,
      async () => {
        await this.persistState();
      },
    );
  }

  private orderedPanes(surface: ManagedSurface): ManagedPane[] {
    const ordered: ManagedPane[] = [];
    const seen = new Set<PaneId>();
    for (const paneId of flattenManagedLayout(surface.layout)) {
      const pane = surface.panes.get(paneId);
      if (!pane) {
        continue;
      }
      ordered.push(pane);
      seen.add(paneId);
    }
    if (ordered.length === surface.panes.size) {
      return ordered;
    }
    return [
      ...ordered,
      ...[...surface.panes.values()].filter((pane) => !seen.has(pane.paneId)).sort((left, right) => (
        left.paneLabel - right.paneLabel || left.paneId.localeCompare(right.paneId)
      )),
    ];
  }

  private visibleHistoryEntry(pane: ManagedPane): ManagedHistoryEntry | null {
    if (!pane.activeContentId || !pane.contentType || pane.contentValue === null) {
      return null;
    }
    return {
      contentId: pane.activeContentId,
      contentType: pane.contentType,
      contentValue: structuredClone(pane.contentValue),
      historyOwnerToken: pane.historyOwnerToken,
      revision: pane.currentRevision,
      sessionKey: pane.ownerSessionKey,
    };
  }

  private storeHiddenHistoryEntry(
    pane: ManagedPane,
    entry: ManagedHistoryEntry | null,
  ): void {
    if (!entry) {
      return;
    }
    pane.historyEntries = [
      entry,
      ...pane.historyEntries.filter((candidate) => !sameHistorySessionKey(candidate.sessionKey, entry.sessionKey)),
    ].slice(0, 20);
  }

  private removeHiddenHistoryEntryForSession(pane: ManagedPane, sessionKey: string | null): void {
    pane.historyEntries = pane.historyEntries.filter((entry) => !sameHistorySessionKey(entry.sessionKey, sessionKey));
  }

  private takeHiddenHistoryEntryByContentId(
    pane: ManagedPane,
    contentId: ContentId,
  ): ManagedHistoryEntry | null {
    const index = pane.historyEntries.findIndex((entry) => entry.contentId === contentId);
    if (index < 0) {
      return null;
    }
    const [entry] = pane.historyEntries.splice(index, 1);
    return entry ?? null;
  }

  private applyVisibleEntry(pane: ManagedPane, entry: ManagedHistoryEntry): void {
    pane.activeContentId = entry.contentId;
    pane.contentType = entry.contentType;
    pane.contentValue = structuredClone(entry.contentValue);
    pane.currentRevision = entry.revision;
    pane.historyOwnerToken = entry.historyOwnerToken;
    pane.ownerSessionKey = entry.sessionKey;
    pane.historySummary.visibleContentId = entry.contentId;
  }

  private clearVisiblePaneContent(pane: ManagedPane, revision: Revision): void {
    pane.activeContentId = null;
    pane.contentType = null;
    pane.contentValue = null;
    pane.currentRevision = revision;
    pane.historyOwnerToken = null;
    pane.ownerSessionKey = null;
    pane.historySummary.visibleContentId = null;
    pane.buffer.currentUrl = null;
    pane.snapshot = pane.snapshot
      ? {
          ...pane.snapshot,
          contentId: null,
          contentType: null,
          drawings: [],
          revision,
          visibleText: "",
        }
      : null;
    pane.buffer.liveFrame = null;
    pane.buffer.liveDirtyStrokeIds = [];
  }

  private nextTopologyRevision(
    surface: ManagedSurface,
    increment: boolean,
  ): number {
    if (increment) {
      return Math.max(1, surface.topologyRevision + 1);
    }
    return Math.max(1, surface.topologyRevision);
  }

  private async pushTopology(
    surface: ManagedSurface,
    options: { increment?: boolean } = {},
  ): Promise<void> {
    const layout = collapseManagedLayout(surface.layout);
    surface.layout = layout;
    const topologyRevision = this.nextTopologyRevision(surface, options.increment ?? false);
    const request: TopologyApplyRequest = {
      id: makeBrandedRequestId(),
      op: "topology.apply",
      payload: {
        layout: remoteLayoutToTopologyLayout(surface, layout),
        panes: this.orderedPanes(surface).map((pane) => ({
          name: pane.name,
          paneId: pane.remotePaneId,
          paneLabel: pane.paneLabel,
        })),
        topologyRevision: topologyRevision as TopologyApplyRequest["payload"]["topologyRevision"],
        windowLabel: surface.windowLabel,
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
    const payload = (response as TopologyApplyResponse).payload;
    surface.topologyRevision = Number(payload.topologyRevision);
    for (const paneState of payload.panes) {
      const pane = this.findPaneByRemoteId(surface, paneState.paneId);
      if (!pane) {
        continue;
      }
      pane.name = paneState.name;
      pane.paneLabel = paneState.paneLabel;
    }
    this.queuePersistScreenSnapshot("topology apply");
  }

  private async repushSurfaceContent(surface: ManagedSurface): Promise<void> {
    for (const pane of this.orderedPanes(surface)) {
      if (!isBoundRemotePaneId(pane.remotePaneId)) {
        continue;
      }
      if (!pane.activeContentId || !pane.contentType || pane.contentValue === null) {
        if (pane.currentRevision <= asRevision(0)) {
          continue;
        }
        const clearRequest: ContentApplyRequest = {
          id: makeBrandedRequestId(),
          op: "content.apply",
          payload: {
            clear: true,
            paneId: pane.remotePaneId,
            revision: pane.currentRevision,
            topologyRevision: surface.topologyRevision as TopologyApplyRequest["payload"]["topologyRevision"],
          },
          sentAt: asEpochMs(this.now()),
          type: "request",
          v: 1,
        };
        const clearResponse = await this.sendRequest(surface, clearRequest);
        this.applyMutationResponse(surface, pane, clearResponse, clearRequest);
        continue;
      }

      const contentRequest: ContentApplyRequest = {
        id: makeBrandedRequestId(),
        op: "content.apply",
        payload: {
          content: structuredClone(pane.contentValue),
          contentId: pane.activeContentId,
          contentType: pane.contentType,
          historyOwnerToken:
            pane.historyOwnerToken ??
            historyOwnerTokenForSession(pane.ownerSessionKey ?? undefined),
          paneId: pane.remotePaneId,
          revision: pane.currentRevision,
          topologyRevision: surface.topologyRevision as TopologyApplyRequest["payload"]["topologyRevision"],
        } as ContentApplyRequest["payload"],
        sentAt: asEpochMs(this.now()),
        type: "request",
        v: 1,
      };
      const contentResponse = await this.sendRequest(surface, contentRequest);
      this.applyMutationResponse(surface, pane, contentResponse, contentRequest, pane.ownerSessionKey ?? undefined);
    }
  }

  private allocatePaneId(): PaneId {
    return asPaneId(`pn_${randomUUID().replaceAll("-", "")}`);
  }

  private allocateRemotePaneId(): RemotePaneId {
    const remotePaneId = asRemotePaneId(this.persistentState.nextRemotePaneId);
    this.persistentState.nextRemotePaneId += 1;
    this.runBackgroundTask(
      "persist next remote pane id",
      async () => {
        await this.persistState();
      },
    );
    return remotePaneId;
  }

  private noteObservedRemotePaneId(remotePaneId: RemotePaneId): void {
    const numericRemotePaneId = Number(remotePaneId);
    if (numericRemotePaneId < this.persistentState.nextRemotePaneId) {
      return;
    }
    this.persistentState.nextRemotePaneId = numericRemotePaneId + 1;
    this.runBackgroundTask(
      "persist observed remote pane id",
      async () => {
        await this.persistState();
      },
    );
  }

  private allocatePaneLabel(): number {
    const paneLabel = this.persistentState.nextPaneLabel;
    this.persistentState.nextPaneLabel += 1;
    this.runBackgroundTask(
      "persist next pane label",
      async () => {
        await this.persistState();
      },
    );
    return paneLabel;
  }

  private ensurePaneLabel(
    surface: ManagedSurface,
    pane: ManagedPane | null,
    remotePaneId?: RemotePaneId,
  ): number {
    if (remotePaneId && remotePaneId > asRemotePaneId(0)) {
      const key = paneLabelStorageKey(surface.surfaceId, remotePaneId);
      const existing = this.persistentState.paneLabelsByPaneId[key];
      if (typeof existing === "number" && existing > 0) {
        return existing;
      }

      const paneLabel =
        pane?.paneLabel && pane.paneLabel > 0
          ? pane.paneLabel
          : Number(remotePaneId);
      if (paneLabel >= this.persistentState.nextPaneLabel) {
        this.persistentState.nextPaneLabel = paneLabel + 1;
      }
      this.persistentState.paneLabelsByPaneId[key] = paneLabel;
      this.runBackgroundTask(
        `persist pane label for ${surface.surfaceId}/${remotePaneId}`,
        async () => {
          await this.persistState();
        },
      );
      return paneLabel;
    }

    if (pane?.paneLabel && pane.paneLabel > 0) {
      return pane.paneLabel;
    }

    return this.allocatePaneLabel();
  }

  private reconcilePaneLabelsBySurfaceId(previousSurfaceId: string, nextSurfaceId: string): void {
    if (previousSurfaceId === nextSurfaceId) {
      return;
    }

    let changed = false;
    const remapped = { ...this.persistentState.paneLabelsByPaneId };
    const previousPrefix = `${previousSurfaceId}::`;
    for (const [key, paneLabel] of Object.entries(this.persistentState.paneLabelsByPaneId)) {
      if (!key.startsWith(previousPrefix)) {
        continue;
      }
      remapped[`${nextSurfaceId}::${key.slice(previousPrefix.length)}`] = paneLabel;
      delete remapped[key];
      changed = true;
    }

    if (!changed) {
      return;
    }

    this.persistentState.paneLabelsByPaneId = remapped;
    this.runBackgroundTask(
      `persist pane label remap ${previousSurfaceId} -> ${nextSurfaceId}`,
      async () => {
        await this.persistState();
      },
    );
  }

  private async loadState(): Promise<void> {
    const statePath = path.join(this.stateDir, STATE_FILE_NAME);
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as RuntimeStateFile & { endpointSurfaces?: Record<string, string> };
      if (parsed.version === 1) {
        this.persistentState = {
          nextRemotePaneId: parsed.nextRemotePaneId ?? (parsed as { nextPaneId?: number }).nextPaneId ?? 1,
          nextPaneLabel: parsed.nextPaneLabel ?? 1,
          nextWindowLabelIndex: parsed.nextWindowLabelIndex,
          paneLabelsByPaneId: parsed.paneLabelsByPaneId ?? {},
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

  private buildScreenSummaries(): SurfAceScreenSummary[] {
    return [...this.surfaces.values()]
      .sort((left, right) => left.windowLabel.localeCompare(right.windowLabel, "en"))
      .map((surface) => this.buildScreenSummary(surface));
  }

  private buildScreenSummary(surface: ManagedSurface): SurfAceScreenSummary {
    return {
      connectionState: surface.connectionState,
      fingerprint: surface.surfaceId,
      lastSeenAt: surface.lastSeenAt,
      name: surface.name,
      panes: this.orderedPanes(surface)
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
          paneLabel: pane.paneLabel,
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
    };
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

  private async loadPersistedScreenSnapshot(): Promise<SurfAceScreenSummary[]> {
    return (await this.loadPersistedScreenSnapshotFile())?.screens ?? [];
  }

  private async loadPersistedScreenSnapshotFile(): Promise<PersistedScreenSnapshotFile | null> {
    const snapshotPath = path.join(this.stateDir, SCREEN_SNAPSHOT_FILE_NAME);
    try {
      const raw = await fs.readFile(snapshotPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedScreenSnapshotFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.screens)) {
        return null;
      }
      const ageMs = this.now() - (parsed.updatedAt ?? 0);
      if (ageMs > RESTART_SNAPSHOT_MAX_AGE_MS) {
        return null;
      }
      return {
        ...parsed,
        screens: parsed.screens.map((screen) => ({
          ...screen,
          panes: screen.panes.map((pane) => ({
            ...pane,
            paneId: migratePersistedPaneId(screen.fingerprint, pane.paneId, pane.paneLabel),
          })),
        })),
      };
    } catch {
      return null;
    }
  }

  private async loadRestartSnapshots(): Promise<void> {
    const snapshotFile = await this.loadPersistedScreenSnapshotFile();
    const screens = snapshotFile?.screens ?? [];
    this.restartSnapshots = new Map(
      screens
        .filter((screen) =>
          screen._debug?.hasPairedInGatewaySession === true &&
          typeof screen._debug.sessionId === "string" &&
          screen._debug.sessionId.length > 0
        )
        .map((screen) => [screen.fingerprint, screen]),
    );
    this.restartContentBySurface = new Map(Object.entries(snapshotFile?.contentContinuity ?? {}));
  }

  private restoreRestartOwnership(surface: ManagedSurface): void {
    if (surface.hasPairedInGatewaySession || surface.sessionId) {
      return;
    }
    const snapshot = this.restartSnapshots.get(surface.surfaceId);
    const sessionId = snapshot?._debug?.sessionId;
    if (
      !snapshot ||
      snapshot._debug?.hasPairedInGatewaySession !== true ||
      typeof sessionId !== "string" ||
      sessionId.length === 0
    ) {
      return;
    }
    surface.hasPairedInGatewaySession = true;
    surface.sessionId = asSessionId(sessionId);
    if (!surface.windowLabel && snapshot.windowLabel) {
      surface.windowLabel = snapshot.windowLabel;
    }
    this.restartSnapshots.delete(surface.surfaceId);
    this.logger.info?.(
      runtimeDiagnostic("restart_ownership_restored", {
        session_id: sessionId,
        surface_id: surface.surfaceId,
      }),
    );
  }

  private restoreRestartContent(surface: ManagedSurface): void {
    const entries = this.restartContentBySurface.get(surface.surfaceId);
    if (!entries || entries.length === 0) {
      return;
    }

    const panes = this.orderedPanes(surface);
    for (const entry of entries) {
      const pane =
        panes.find((candidate) => candidate.paneLabel === entry.paneLabel) ??
        (panes.length === 1 && entries.length === 1 ? panes[0] : null);
      if (!pane) {
        continue;
      }
      this.applyVisibleEntry(pane, {
        contentId: entry.contentId as ContentId,
        contentType: entry.contentType,
        contentValue: structuredClone(entry.contentValue),
        historyOwnerToken: entry.historyOwnerToken,
        revision: entry.revision as Revision,
        sessionKey: entry.sessionKey,
      });
    }
    this.restartContentBySurface.delete(surface.surfaceId);
  }

  private queuePersistScreenSnapshot(reason: string): void {
    if (!this.ownsRuntimeLease) {
      return;
    }
    this.runBackgroundTask(
      `persist screen snapshot (${reason})`,
      async () => {
        await this.persistScreenSnapshot();
      },
    );
  }

  private async persistScreenSnapshot(): Promise<void> {
    if (!this.ownsRuntimeLease) {
      return;
    }
    const snapshotPath = path.join(this.stateDir, SCREEN_SNAPSHOT_FILE_NAME);
    const payload: PersistedScreenSnapshotFile = {
      contentContinuity: this.buildContentContinuitySnapshot(),
      screens: this.buildScreenSummaries(),
      updatedAt: this.now(),
      version: 1,
    };
    this.screenSnapshotWrite = this.screenSnapshotWrite
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(snapshotPath, JSON.stringify(payload, null, 2));
      });
    await this.screenSnapshotWrite;
  }

  private buildContentContinuitySnapshot(): Record<string, PersistedRestartContentEntry[]> {
    const contentContinuity: Record<string, PersistedRestartContentEntry[]> = {};
    for (const surface of this.surfaces.values()) {
      const entries = this.orderedPanes(surface)
        .map((pane): PersistedRestartContentEntry | null => {
          const entry = this.visibleHistoryEntry(pane);
          if (!entry) {
            return null;
          }
          return {
            contentId: entry.contentId,
            contentType: entry.contentType,
            contentValue: structuredClone(entry.contentValue),
            historyOwnerToken: entry.historyOwnerToken,
            paneLabel: pane.paneLabel,
            revision: entry.revision,
            sessionKey: entry.sessionKey,
          };
        })
        .filter((entry): entry is PersistedRestartContentEntry => entry !== null);
      if (entries.length > 0) {
        contentContinuity[surface.surfaceId] = entries;
      }
    }
    return contentContinuity;
  }

  private providerId(): ProviderId {
    return makeProviderId(this.persistentState.providerId);
  }

  private async forwardToRuntimeOwner<TResult>(command: OwnerControlCommand): Promise<TResult> {
    const lease = await this.readRuntimeLease();
    const controlPort = lease.controlPort;
    if (typeof controlPort !== "number" || controlPort <= 0) {
      throw new SurfAceToolError(
        "internal_error",
        "Surf Ace runtime owner is active but does not expose a tool control endpoint.",
      );
    }

    let response: globalThis.Response;
    try {
      response = await fetch(`http://127.0.0.1:${controlPort}${OWNER_CONTROL_PATH}`, {
        body: JSON.stringify(command),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    } catch (error) {
      throw new SurfAceToolError(
        "internal_error",
        `Surf Ace runtime owner control request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const payload = await response.json().catch(() => null) as
      | { error?: { code?: SurfAceToolError["code"]; message?: string }; ok?: boolean; result?: TResult }
      | null;
    if (!response.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? "internal_error";
      const message = payload?.error?.message ?? "Surf Ace runtime owner control request failed.";
      throw new SurfAceToolError(code, message);
    }
    return payload.result as TResult;
  }

  private async startOwnerControlServer(): Promise<void> {
    if (this.ownerControlServer) {
      return;
    }

    const server = createServer((request, response) => {
      void this.handleOwnerControlRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new SurfAceToolError("internal_error", "Surf Ace runtime owner control endpoint failed to bind.");
    }
    server.unref();
    this.ownerControlServer = server;
    this.ownerControlPort = address.port;
  }

  private async stopOwnerControlServer(): Promise<void> {
    const server = this.ownerControlServer;
    this.ownerControlServer = null;
    this.ownerControlPort = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleOwnerControlRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST" || request.url !== OWNER_CONTROL_PATH) {
      this.writeOwnerControlResponse(response, 404, {
        error: { code: "invalid_operation", message: "Unknown Surf Ace runtime owner control route." },
        ok: false,
      });
      return;
    }

    try {
      const command = await this.readOwnerControlCommand(request);
      const result = await this.executeOwnerControlCommand(command);
      this.writeOwnerControlResponse(response, 200, { ok: true, result });
    } catch (error) {
      const code = error instanceof SurfAceToolError ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : String(error);
      this.writeOwnerControlResponse(response, 500, {
        error: { code, message },
        ok: false,
      });
    }
  }

  private async readOwnerControlCommand(request: IncomingMessage): Promise<OwnerControlCommand> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > OWNER_CONTROL_MAX_BODY_BYTES) {
        throw new SurfAceToolError("content_too_large", "Surf Ace runtime owner control request is too large.");
      }
      chunks.push(buffer);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OwnerControlCommand;
    return parsed;
  }

  private async executeOwnerControlCommand(command: OwnerControlCommand): Promise<unknown> {
    switch (command.op) {
      case "annotateRemove":
        return await this.annotateRemove(command.input);
      case "clear":
        return await this.clear(command.input);
      case "closePane":
        return await this.closePane(command.input);
      case "push":
        return await this.push(command.input, command.context);
      case "read":
        return await this.read(command.input);
      case "relinquish":
        return await this.relinquish(command.input);
      case "snapshot":
        return await this.snapshot(command.input);
      case "split":
        return await this.split(command.input);
    }
  }

  private writeOwnerControlResponse(
    response: ServerResponse,
    statusCode: number,
    payload: Record<string, unknown>,
  ): void {
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  }

  private async readRuntimeLease(): Promise<RuntimeLeaseFile> {
    const leasePath = path.join(this.stateDir, RUNTIME_LEASE_FILE_NAME);
    try {
      return JSON.parse(await fs.readFile(leasePath, "utf8")) as RuntimeLeaseFile;
    } catch {
      return {};
    }
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
        controlPort: this.ownerControlPort,
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

  private async refreshRuntimeLease(): Promise<void> {
    const handle = this.runtimeLease;
    if (!handle) {
      return;
    }
    await this.writeLeaseContent(handle);
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
      const parsed = JSON.parse(contents) as RuntimeLeaseFile;
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
    await this.stopOwnerControlServer();
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

  private requirePane(fingerprint: string, paneId: PaneId): ManagedPane {
    const surface = this.surfaces.get(fingerprint);
    if (!surface) {
      throw new SurfAceToolError("screen_not_found", `Unknown Surf Ace surface: ${fingerprint}`);
    }
    const pane = surface.panes.get(paneId);
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
      runtimeDiagnostic("endpoint_reconcile_begin", {
        busy: endpoint.busy,
        endpoint_id: endpoint.endpointId,
        fingerprint: endpoint.fingerprintPrefix || "none",
        host: endpoint.host,
        port: endpoint.port,
        surface_name: endpoint.name,
      }),
    );
    const existing = this.reusableSurface(
      [...this.surfaces.values()].find((s) => s.endpointId === endpoint.endpointId),
    );

    if (existing) {
      this.logger.info?.(
        runtimeDiagnostic("endpoint_adopt", {
          action: "reuse_by_endpoint",
          endpoint_id: endpoint.endpointId,
          surface_id: existing.surfaceId,
        }),
      );
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
      this.logger.info?.(
        runtimeDiagnostic("endpoint_adopt", {
          action: "reuse_by_fingerprint",
          endpoint_id: endpoint.endpointId,
          fingerprint: endpoint.fingerprintPrefix || "none",
          surface_id: existingByFingerprint.surfaceId,
        }),
      );
      this.assignEndpoint(existingByFingerprint, endpoint);
      this.ensureSurfaceWorker(existingByFingerprint);
      return;
    }

    const surfaceId = makeProvisionalSurfaceId(endpoint.endpointId);
    this.logger.info?.(
      runtimeDiagnostic("endpoint_adopt", {
        action: "create_surface",
        endpoint_id: endpoint.endpointId,
        surface_id: surfaceId,
        surface_name: endpoint.name,
      }),
    );
    const surface = createManagedSurface(
      surfaceId,
      endpoint,
      endpoint.name,
      endpoint.viewport,
      "",
      this.now(),
    );

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
    const sameFingerprint =
      Boolean(endpoint.fingerprintPrefix) &&
      endpoint.fingerprintPrefix === surface.fingerprintPrefix;
    if (
      endpointChanged &&
      sameFingerprint &&
      surface.hasPairedInGatewaySession &&
      surface.client?.isOpen()
    ) {
      surface.lastSeenAt = this.now();
      surface.name = endpoint.name;
      surface.viewport = cloneViewport(endpoint.viewport);
      this.logger.info?.(
        runtimeDiagnostic("endpoint_alias_observed", {
          fingerprint: endpoint.fingerprintPrefix || "none",
          observed_endpoint_id: endpoint.endpointId,
          retained_endpoint_id: previousEndpointId,
          surface_id: surface.surfaceId,
        }),
      );
      return;
    }
    surface.endpoint = endpoint;
    surface.endpointId = endpoint.endpointId;
    surface.fingerprintPrefix = endpoint.fingerprintPrefix;
    surface.lastSeenAt = this.now();
    surface.name = endpoint.name;
    surface.viewport = cloneViewport(endpoint.viewport);

    if (!endpointChanged) {
      return;
    }
    this.logger.info?.(
      runtimeDiagnostic("endpoint_rebind", {
        fingerprint: endpoint.fingerprintPrefix || "none",
        from_endpoint_id: previousEndpointId,
        surface_id: surface.surfaceId,
        to_endpoint_id: endpoint.endpointId,
      }),
    );

    surface.reconnectAttempt = 0;
    surface.unreachableFailures = 0;
    surface.connectionState = "connecting";
    this.runBackgroundTask(
      `refresh surface client after endpoint change ${surface.surfaceId}`,
      async () => {
        if (surface.client) {
          await this.closeSurfaceClient(surface, surface.client, clampCloseReason("provider_shutdown"));
        }
      },
    );
    this.wakeSurfaceRetry(surface);

  }

  private async discoverSurfaceId(surface: ManagedSurface): Promise<ManagedSurface[]> {
    const client = surface.client;
    if (!client) {
      return [];
    }

    let response: Response;
    try {
      if (!client.isOpen()) {
        return [];
      }
      response = await client.request(
        this.requestEnvelope("surfaces.list"),
        REQUEST_TIMEOUT_MS,
      );
    } catch {
      this.logger.warn?.(
        `[surf-ace:runtime] surfaces.list failed for ${surface.endpointId}, using cached surfaceId`,
      );
      return [];
    }

    if (isErrorResponse(response)) {
      return [];
    }

    const remoteSurfaces = (response as SurfacesListResponse).payload.surfaces;
    if (remoteSurfaces.length === 0) {
      return [];
    }

    const matchedRemoteSurface =
      remoteSurfaces.find((remoteSurface) => remoteSurface.surfaceId === surface.surfaceId) ??
      remoteSurfaces[0];
    const matchedRemoteSurfaceId = asSurfaceId(matchedRemoteSurface.surfaceId);

    this.adoptCanonicalSurfaceId(surface, matchedRemoteSurfaceId, "surfaces.list");

    surface.lastSeenAt = this.now();
    surface.name = matchedRemoteSurface.name;
    surface.viewport = cloneViewport(matchedRemoteSurface.viewport);

    const siblingsToStart: ManagedSurface[] = [];
    for (const remoteSurface of remoteSurfaces) {
      const remoteSurfaceId = asSurfaceId(remoteSurface.surfaceId);
      if (remoteSurfaceId === surface.surfaceId) {
        continue;
      }

      const existing = this.surfaces.get(remoteSurfaceId);
      const discoveredSurface = existing ?? createManagedSurface(
        remoteSurfaceId,
        surface.endpoint,
        remoteSurface.name,
        remoteSurface.viewport,
        this.ensureWindowLabel(remoteSurfaceId),
        this.now(),
      );

      discoveredSurface.endpoint = surface.endpoint;
      discoveredSurface.endpointId = surface.endpointId;
      discoveredSurface.fingerprintPrefix = surface.fingerprintPrefix;
      discoveredSurface.lastSeenAt = this.now();
      discoveredSurface.name = remoteSurface.name;
      discoveredSurface.viewport = cloneViewport(remoteSurface.viewport);
      discoveredSurface.stopRequested = false;
      this.surfaces.set(remoteSurfaceId, discoveredSurface);
      siblingsToStart.push(discoveredSurface);
    }
    return siblingsToStart;
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
    const initialPane = this.firstPane(surface);
    if (!initialPane) {
      throw new SurfAceToolError("internal_error", `Surface ${surface.surfaceId} has no initial pane`);
    }
    const windowLabel = surface.windowLabel || this.ensureWindowLabel(surface.surfaceId);
    surface.windowLabel = windowLabel;
    const resumeSessionId = this.shouldAttemptResume(surface) ? surface.sessionId : null;
    const providerName = this.providerNameForSurface(surface);

    const buildPairRequest = (takeover: boolean, requestedResumeSessionId: SessionId | null): PairRequest => ({
      id: makeBrandedRequestId(),
      op: "pair.request",
      payload: {
        connectionId: makeConnectionId(),
        drawingFlushConfig: this.drawingFlushConfig,
        eventProfile: this.eventProfile,
        initialPaneId,
        initialPaneLabel: initialPane.paneLabel,
        protocolVersion: 1,
        providerId: this.providerId(),
        providerName,
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
      this.noteOwnershipLockFailure(surface, "invalid_resume");
      response = await this.maybeRecoverFromColdStartInvalidResume(
        surface,
        response,
        sendPairRequest,
      );
      if (isResumeSessionMismatch(response)) {
        if (!surface.hasPairedInGatewaySession) {
          this.logger.warn?.(
            `[surf-ace:runtime] resume session mismatch for ${surface.surfaceId}; retrying fresh owner pair`,
          );
          surface.sessionId = null;
          response = await sendPairRequest(false, null);
        }
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

    response = await this.maybeRecoverFromColdStartBusy(
      surface,
      response,
      resumeSessionId,
      sendPairRequest,
    );

    if (isErrorResponse(response)) {
      if (isOwnershipLockResponse(response)) {
        const ownershipLockCode = response.error.code === "busy" ? "busy" : "invalid_resume";
        this.noteOwnershipLockFailure(surface, ownershipLockCode);
      } else {
        surface.consecutiveOwnershipLockFailures = 0;
      }
    }
    if (isErrorResponse(response)) {
      if (response.error.code === "busy") {
        this.logger.warn?.(
          `[surf-ace:runtime] busy for ${surface.surfaceId}; backing off (takeover requires explicit user action)`,
        );
      }
      throw new SurfAceToolError(mutationErrorCode(response.error.code), response.error.message);
    }

    return response as PairResponse;
  }

  private providerNameForSurface(surface: ManagedSurface): string {
    void surface;
    return this.providerName;
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
      `[surf-ace:runtime] invalid_resume on cold-start reconnect for ${surface.surfaceId}; retrying fresh (no takeover)`,
    );
    this.clearSurfaceResumeState(surface);
    return sendPairRequest(false, null);
  }

  private async maybeRecoverFromColdStartBusy(
    surface: ManagedSurface,
    response: Response,
    resumeSessionId: SessionId | null,
    sendPairRequest: (
      takeover: boolean,
      requestedResumeSessionId: SessionId | null,
    ) => Promise<Response>,
  ): Promise<Response> {
    if (
      !isErrorResponse(response) ||
      response.error.code !== "busy" ||
      surface.hasPairedInGatewaySession ||
      resumeSessionId !== null
    ) {
      return response;
    }
    void sendPairRequest;
    return response;
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
                  runtimeDiagnostic("socket_closed", {
                    code,
                    reason: reason || "<none>",
                    surface_id: surface.surfaceId,
                  }),
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
                  runtimeDiagnostic("event_handler_error", {
                    error: String(error),
                    surface_id: surface.surfaceId,
                  }),
                );
              }
            },
          });

          await this.assignSurfaceClient(surface, client);
          this.logger.info?.(
            runtimeDiagnostic("reconnect_attempt", {
              attempt: surface.reconnectAttempt + 1,
              endpoint_id: surface.endpointId,
              surface_id: surface.surfaceId,
              url: buildWsUrl(surface.endpoint),
            }),
          );
          await client.connect(REQUEST_TIMEOUT_MS);
          this.logger.info?.(
            runtimeDiagnostic("socket_open", {
              endpoint_id: surface.endpointId,
              surface_id: surface.surfaceId,
            }),
          );
          const siblingSurfaces = await this.discoverSurfaceId(surface);
          this.logger.info?.(
            runtimeDiagnostic("pair_request_begin", {
              resume: Boolean(this.shouldAttemptResume(surface)),
              surface_id: surface.surfaceId,
            }),
          );
          const pairResponse = await this.requestPair(surface);
          this.adoptCanonicalSurfaceId(
            surface,
            asSurfaceId(pairResponse.payload.surfaceId),
            "pair.response",
          );
          this.markPairConnected(surface, asSessionId(pairResponse.payload.sessionId));
          this.logger.info?.(
            runtimeDiagnostic("pair_response_ok", {
              panes: pairResponse.payload.state.panes.length,
              resumed: pairResponse.payload.resumed,
              session_id: pairResponse.payload.sessionId,
              surface_id: surface.surfaceId,
            }),
          );
          surface.unreachableFailures = 0;
          this.applyPairState(surface, pairResponse);
          this.restoreRestartContent(surface);
          await this.pushTopology(surface);
          await this.repushSurfaceContent(surface);
          this.startHeartbeat(surface);
          await this.syncSurfaceSnapshots(surface, true);
          surface.connectionState = "connected";
          this.queuePersistScreenSnapshot("connection ready");
          for (const siblingSurface of siblingSurfaces) {
            this.ensureSurfaceWorker(siblingSurface);
          }
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
            if (surface.sessionId !== null && !surface.hasPairedInGatewaySession) {
              this.logger.warn?.(
                runtimeDiagnostic("resume_state_cleared", {
                  reason: "ownership_lock_or_resume_mismatch",
                  surface_id: surface.surfaceId,
                }),
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
            runtimeDiagnostic("reconnect_error", {
              error: String(error),
              failures: surface.unreachableFailures,
              surface_id: surface.surfaceId,
            }),
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

    const sendHeartbeat = () => {
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
    };

    // Send first heartbeat immediately — the device's heartbeat watchdog
    // may expire sessions before the first interval-based ping fires.
    sendHeartbeat();
    surface.heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(surface: ManagedSurface): void {
    if (surface.heartbeatInterval) {
      clearInterval(surface.heartbeatInterval);
      surface.heartbeatInterval = null;
    }
    surface.heartbeatMisses = 0;
    surface.heartbeatNonce = null;
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
      const panes = this.layoutPanes(surface);
      for (const pane of panes) {
        if (!isBoundRemotePaneId(pane.remotePaneId)) {
          continue;
        }
        await this.syncPaneSnapshot(surface, pane);
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

  private layoutPanes(surface: ManagedSurface): ManagedPane[] {
    const panes: ManagedPane[] = [];
    for (const paneId of flattenManagedLayout(surface.layout)) {
      const pane = surface.panes.get(paneId);
      if (pane) {
        panes.push(pane);
      }
    }
    return panes;
  }

  private async syncPaneSnapshot(
    surface: ManagedSurface,
    pane: ManagedPane,
    options: { waitForVisibleText?: boolean; waitForVisibleTextChangeFrom?: string } = {},
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
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
      const visibleText = pane.snapshot?.visibleText?.trim() ?? "";
      const changedFromPrevious =
        options.waitForVisibleTextChangeFrom === undefined ||
        visibleText !== options.waitForVisibleTextChangeFrom;
      if (
        !options.waitForVisibleText ||
        pane.contentType !== "html" ||
        (visibleText.length > 0 && changedFromPrevious)
      ) {
        return;
      }
      await sleep(75);
    }
  }

  private markPairConnected(surface: ManagedSurface, sessionId: SessionId): void {
    surface.consecutiveResumeFailures = 0;
    surface.consecutiveOwnershipLockFailures = 0;
    surface.connectedAt = this.now();
    surface.autoRetryEnabled = true;
    surface.hasPairedInGatewaySession = true;
    surface.sessionId = sessionId;
    this.queuePersistScreenSnapshot("pair connected");
  }

  private noteConnectionEnded(surface: ManagedSurface): void {
    const hadLiveSession = surface.connectedAt !== null;
    const connectionDurationMs = surface.connectedAt ? this.now() - surface.connectedAt : 0;
    if (connectionDurationMs >= STABLE_CONNECTION_RESET_MS) {
      surface.reconnectAttempt = 0;
      surface.unreachableFailures = 0;
    }
    surface.connectedAt = null;
    this.queuePersistScreenSnapshot("connection ended");
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

  private noteOwnershipLockFailure(
    surface: ManagedSurface,
    code: "busy" | "invalid_resume",
  ): void {
    surface.consecutiveOwnershipLockFailures += 1;
    if (
      surface.consecutiveOwnershipLockFailures <
      MAX_CONSECUTIVE_OWNERSHIP_LOCK_FAILURES
    ) {
      return;
    }
    this.logger.warn?.(
      `[surf-ace:runtime] ${code} persisted for ${surface.surfaceId} with provider ${this.persistentState.providerId}; preserving ownership identity`,
    );
  }

  private clearSurfaceResumeState(surface: ManagedSurface): void {
    surface.sessionId = null;
    surface.hasPairedInGatewaySession = false;
    surface.consecutiveResumeFailures = 0;
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
    if (response.payload.state.panes.length === 1 && surface.panes.size === 1) {
      const paneState = response.payload.state.panes[0]!;
      const pane =
        this.consumeBootstrapPaneForPairState(surface, paneState.paneId) ??
        this.recoverSolePaneForTopologySync(surface, paneState.paneId, response.payload.state.panes.length);
      if (pane) {
        pane.viewport = cloneViewport(surface.viewport);
      }
    }
    this.queuePersistScreenSnapshot("apply pair state");
  }

  private applySnapshot(
    surface: ManagedSurface,
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
    this.materializeSnapshotDrawings(surface, pane, payload);
  }

  private materializeSnapshotDrawings(
    surface: ManagedSurface,
    pane: ManagedPane,
    payload: SnapshotResponse["payload"],
  ): void {
    if (!payload.contentId || !payload.drawings || payload.drawings.length === 0) {
      return;
    }

    const now = this.now();
    const contextKey = pane.buffer.currentUrl ?? payload.contentId;
    const snapshotStrokes = payload.drawings.map((stroke) => convertStrokeToFrameStroke(stroke, now));
    const snapshotStrokeIds = new Set(snapshotStrokes.map((stroke) => stroke.strokeId));
    const existingLiveFrame = pane.buffer.liveFrame;
    const sameContext = existingLiveFrame?.contextKey === contextKey;
    const previousStrokeIds = new Set(
      sameContext ? existingLiveFrame.strokes.map((stroke) => stroke.strokeId) : [],
    );

    const openedAt = snapshotStrokes.reduce(
      (minimum, stroke) => Math.min(minimum, stroke.startedAt),
      snapshotStrokes[0]?.startedAt ?? now,
    );
    const updatedAt = snapshotStrokes.reduce(
      (maximum, stroke) => Math.max(maximum, stroke.endedAt),
      snapshotStrokes[0]?.endedAt ?? now,
    );

    if (!sameContext) {
      pane.buffer.liveFrame = {
        contentId: payload.contentId,
        contextKey,
        frameId: makeFrameId(),
        image: payload.image ?? "",
        openedAt,
        scrollOffset: { ...payload.viewport.scrollOffset },
        strokes: snapshotStrokes,
        updatedAt,
        url: pane.buffer.currentUrl ?? undefined,
        viewport: pane.viewport,
      };
      pane.buffer.liveDirtyStrokeIds = snapshotStrokes.map((stroke) => stroke.strokeId);
      pane.buffer.liveSeq += 1;
      this.maybeFireAnnotationAlert(surface, pane);
      return;
    }

    existingLiveFrame.contentId = payload.contentId;
    existingLiveFrame.image = payload.image ?? existingLiveFrame.image;
    existingLiveFrame.openedAt = Math.min(existingLiveFrame.openedAt, openedAt);
    existingLiveFrame.scrollOffset = { ...payload.viewport.scrollOffset };
    existingLiveFrame.strokes = snapshotStrokes;
    existingLiveFrame.updatedAt = Math.max(existingLiveFrame.updatedAt, updatedAt);
    existingLiveFrame.viewport = pane.viewport;

    const existingDirty = pane.buffer.liveDirtyStrokeIds.filter((strokeId) =>
      snapshotStrokeIds.has(strokeId)
    );
    const newDirtyStrokeIds = snapshotStrokes
      .map((stroke) => stroke.strokeId)
      .filter((strokeId) => !previousStrokeIds.has(strokeId));

    pane.buffer.liveDirtyStrokeIds = [...existingDirty, ...newDirtyStrokeIds];
    if (newDirtyStrokeIds.length > 0) {
      pane.buffer.liveSeq += 1;
      this.maybeFireAnnotationAlert(surface, pane);
    }
  }

  private applyMutationResponse(
    surface: ManagedSurface,
    pane: ManagedPane,
    response: Response,
    request: ContentApplyRequest | ContentClearRequest | ContentSetRequest,
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
    const isClearRequest =
      request.op === "content.clear" ||
      (request.op === "content.apply" && "clear" in request.payload);
    const isSetRequest =
      request.op === "content.set" ||
      (request.op === "content.apply" && !("clear" in request.payload));
    const setPayload = isSetRequest
      ? (request.payload as ContentSetRequest["payload"] | Exclude<ContentApplyRequest["payload"], { clear: true }>)
      : null;
    const previousVisibleEntry = this.visibleHistoryEntry(pane);
    const contentChanged =
      previousVisibleEntry?.contentId !== payload.currentContentId ||
      previousVisibleEntry?.revision !== payload.currentRevision ||
      previousOwner !== nextOwner;

    if (isSetRequest && previousOwner && nextOwner && previousOwner !== nextOwner) {
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

    if (isClearRequest) {
      this.clearVisiblePaneContent(pane, payload.currentRevision);
    } else {
      if (contentChanged) {
        this.storeHiddenHistoryEntry(pane, previousVisibleEntry);
      }
      this.removeHiddenHistoryEntryForSession(pane, nextOwner);
      pane.activeContentId = payload.currentContentId;
      pane.contentType = setPayload?.contentType ?? pane.contentType;
      pane.contentValue = setPayload ? structuredClone(setPayload.content) : pane.contentValue;
      pane.historyOwnerToken = setPayload?.historyOwnerToken ?? pane.historyOwnerToken;
      pane.ownerSessionKey = nextOwner;
      pane.historySummary.visibleContentId = payload.currentContentId;
      if (pane.snapshot && setPayload) {
        pane.snapshot.contentId = payload.currentContentId;
        pane.snapshot.contentType = setPayload.contentType;
        pane.snapshot.drawings = [];
        pane.snapshot.revision = payload.currentRevision;
      }
      pane.buffer.currentUrl = null;
    }

    pane.pendingOwnerSessionKey = null;
    pane.currentRevision = payload.currentRevision;
    this.queuePersistScreenSnapshot(`mutation ${request.op}`);

    if (isClearRequest) {
      return {
        fingerprint: surface.surfaceId,
        paneId: pane.paneId,
        paneLabel: pane.paneLabel,
        revision: payload.currentRevision,
      };
    }

    return {
      contentId: payload.currentContentId as string,
      fingerprint: surface.surfaceId,
      paneId: pane.paneId,
      paneLabel: pane.paneLabel,
      revision: payload.currentRevision,
    };
  }
}

export function createSurfAceRuntime(options: SurfAceRuntimeOptions = {}): SurfAceRuntime {
  return new DefaultSurfAceRuntime(options);
}
