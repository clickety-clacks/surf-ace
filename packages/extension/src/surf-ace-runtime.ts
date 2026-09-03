import os from "node:os";
import path from "node:path";

import type {
  ConsumableGap,
  ConsumableRecord,
  ContentId,
  ContentType,
  PusherProvenance,
  Selection,
  Stroke,
  SurfaceViewport,
  TargetErrorCode,
  TargetHeader,
  TargetKind,
  TargetMaterializedState,
  Viewport,
} from "../../protocol/src/index.js";
import type {
  SurfAceDiscoveryService,
  SurfAceLogger,
} from "./surf-ace-discovery.js";

type Brand<T, TName extends string> = T & { readonly __brand: TName };

export type PaneId = Brand<string, "PaneId">;
export type SurfAceConnectionState = "connected" | "connecting" | "unreachable";
export type SurfAceConnectionCircuitState = "closed" | "open" | "given_up";

export type SurfAceOperationReceipt = {
  clientResultIds: Record<string, number | string>;
  operation: string;
  requestId: string | null;
};

export type SurfAceConnectionDiagnostics = {
  circuitOpen: boolean;
  circuitState: SurfAceConnectionCircuitState;
  failureCount: number;
  givenUp: boolean;
  openedAt: number | null;
  reason: string | null;
  reconnectAttempt: number;
};

export type SurfAceAdmissionDecision = {
  actionable: boolean;
  admitted: boolean;
  blockers: string[];
  reason: string | null;
};

export type SurfAceHistorySummary = {
  backCount: number;
  forwardCount: number;
  visibleContentId: string | null;
  visibleProvenance?: SurfAceVisibleContentProvenance | null;
};

export type SurfAceVisibleContentProvenance = {
  agentId?: string;
  displayName?: string;
  pushedAt?: string;
  sessionKey: string | null;
  source?: string;
  streamLabel?: string;
};

export type SurfAcePaneTargetDiagnostic = {
  blockedReason: TargetErrorCode | null;
  displayId: string;
  paneAddress: string;
  paneLineageId: string;
  targetHeader: TargetHeader;
  targetId: string;
  targetKind: TargetKind;
  targetPayload: unknown;
};

export type SurfAcePaneSummary = {
  activeContent: {
    contentId: string;
    contentType: ContentType;
    revision: number;
  } | null;
  displayId: string;
  historySummary: SurfAceHistorySummary;
  name: string | null;
  paneAddress: string;
  paneId: PaneId;
  paneLabel: number;
  target: SurfAcePaneTargetDiagnostic | null;
  viewport: SurfaceViewport;
};

export type SurfAceTopologySummaryNode =
  | { paneId: PaneId; type: "pane"; weight?: number }
  | {
      children: SurfAceTopologySummaryNode[];
      direction: "horizontal" | "vertical";
      type: "split";
      weight?: number;
    };

export type SurfAceScreenSummary = {
  authority: SurfAceAdmissionDecision;
  connectionDiagnostics: SurfAceConnectionDiagnostics;
  connectionState: SurfAceConnectionState;
  endpointId?: string;
  fingerprint: string;
  lastSeenAt: number;
  name: string;
  panes: SurfAcePaneSummary[];
  pendingEvents: number;
  topology: SurfAceTopologySummaryNode | null;
  topologyRevision: number;
  viewport: SurfaceViewport;
  windowLabel: string;
};

export type SurfAceFrameStroke = {
  bbox: { height: number; width: number; x: number; y: number };
  endedAt: number;
  points: Array<{ pressure?: number; x: number; y: number }>;
  startedAt: number;
  strokeId: string;
};

export type SurfAceFrame = {
  contentId: string;
  contextKey: string;
  frameId: string;
  image: string;
  openedAt: number;
  scrollOffset: { x: number; y: number };
  strokes: SurfAceFrameStroke[];
  updatedAt: number;
  url?: string;
  viewport: SurfaceViewport;
};

export type SurfAceBrowserUrlSemanticEvidence = {
  appliedAt: string;
  navigationStatus: "loaded";
  paneLineageId: string;
  replaySemantics: "navigate";
  requestId: string;
  targetEpoch: number;
  targetId: string;
  url: string;
};

export type SurfAceReadResult = {
  acknowledgementPending?: boolean;
  browserUrl: SurfAceBrowserUrlSemanticEvidence | null;
  cacheStatus?: "current" | "unsynchronized";
  consumableGap?: ConsumableGap | null;
  consumableLoss?: ConsumableGap | null;
  consumableRecords?: ConsumableRecord[];
  contentSnapshot: {
    cachedAt: number;
    content?: unknown;
    contentId: string | null;
    contentType: ContentType | null;
    drawings?: Stroke[];
    image?: string;
    revision: number;
    selection: Selection;
    viewport: Viewport;
    visibleText?: string;
  } | null;
  displayId: string;
  fingerprint: string;
  frames: SurfAceFrame[];
  lastNavigation: { navigatedAt: number; url: string } | null;
  liveDirtyStrokeIds: string[];
  liveFrame: SurfAceFrame | null;
  liveSeq: number | null;
  overflowed?: boolean;
  page: { pageCount: number; pageLabel?: string; pageNumber: number } | null;
  paneAddress: string;
  paneId: PaneId;
  paneLabel: number;
  pendingFrames?: number;
  playbackPosition: number | null;
  playbackState: "ended" | "paused" | "playing" | null;
  readAt: number;
  repairScheduled?: boolean;
  scrollPosition: { visibleRect: Viewport["visibleRect"]; x: number; y: number } | null;
  selection: {
    anchorEnd: number | null;
    anchorStart: number | null;
    bounds?: unknown;
    selectedText: string;
  } | null;
  taps: Array<{
    elementRole?: string;
    eventId: string;
    kind: "long_press" | "tap";
    nearestText?: string;
    timestamp: number;
    x: number;
    y: number;
  }>;
  windowLabel: string;
};

export type SurfAceSnapshotResult = {
  displayId: string;
  fingerprint: string;
  operationReceipt?: SurfAceOperationReceipt;
  paneAddress: string;
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
  windowLabel: string;
};

export type SurfAceAnnotateRemoveInput = {
  contentId: string;
  fingerprint: string;
  paneId: PaneId;
  strokeIds: string[];
};

export type SurfAcePaneCaptureResult = {
  capture: {
    browserUrl: SurfAceBrowserUrlSemanticEvidence | null;
    bytesBase64: string | null;
    capturedAt: number;
    contentType: ContentType | null;
    dimensions: { height: number; width: number };
    displayId: string;
    failureReason: string | null;
    fingerprint: string;
    paneAddress: string;
    paneId: PaneId;
    paneLabel: number;
    scale: number;
    topologyRevision: number;
    visibleContentId: ContentId | null;
    windowLabel: string;
  };
  operationReceipt?: SurfAceOperationReceipt;
};

export type SurfAceAnnotateRemoveResult = {
  displayId: string;
  fingerprint: string;
  notFoundStrokeIds: string[];
  operationReceipt?: SurfAceOperationReceipt;
  paneAddress: string;
  paneId: PaneId;
  paneLabel: number;
  remainingStrokeCount: number;
  removedStrokeIds: string[];
};

export type SurfAcePushContentType = ContentType | "browser_url";

export type SurfAcePushInput = {
  content: string;
  contentType: SurfAcePushContentType;
  diagnostic?: {
    derivedFromTargetId?: string;
    kind: "placeholder" | "status" | "error";
    summary: string;
  };
  fingerprint: string;
  paneId: PaneId;
  sourcePath?: string;
};

export type SurfAceLaunchNativeAppInput = {
  appId: string;
  args?: string[];
  confirmed: boolean;
  cwd?: string;
  env?: Record<string, string>;
  fingerprint: string;
  idempotencyKey?: string;
  launchMode?: "new_instance" | "attach_or_launch";
  paneId: PaneId;
  summary?: string;
};

export type SurfAcePushResult = {
  blockedReason?: TargetErrorCode | null;
  contentId: string | null;
  displayId: string;
  fingerprint: string;
  operationReceipt?: SurfAceOperationReceipt;
  paneAddress: string;
  paneId: PaneId;
  paneLabel: number;
  revision: number;
  targetApplyEvidence?: ApplyEvidence;
  targetId?: string;
  targetKind?: TargetKind;
};

export type SurfAceClearResult = {
  displayId: string;
  fingerprint: string;
  operationReceipt?: SurfAceOperationReceipt;
  paneAddress: string;
  paneId: PaneId;
  paneLabel: number;
  revision: number;
};

export type SurfAceSessionContext = {
  agentId?: string;
  displayName?: string;
  provenance?: PusherProvenance;
  pushedAt?: string;
  pushedBy?: PusherProvenance;
  source?: string | PusherProvenance;
  sourceProvenance?: PusherProvenance;
  sessionDisplayName?: string;
  sessionKey?: string;
  streamLabel?: string;
};

export type ApplyEvidence = {
  appliedAt: string;
  errorCode?: TargetErrorCode;
  materializedState?: TargetMaterializedState;
  message?: string;
  requestId: string;
  status: "applied" | "rejected" | "failed";
};

export type SurfAceTargetRegisterInput = {
  expectedPreviousTargetEpoch: number | null;
  fingerprint: string;
  idempotencyKey: string;
  launchedAt?: string;
  paneId: PaneId;
  paneLineageId: string;
  registrationState: "before_attach" | "attached";
  restorePolicy?: string;
  targetHeader: TargetHeader;
  targetKind: TargetKind;
  targetPayload: unknown;
};

export type SurfAceTargetRegisterResult =
  | { idempotencyKey: string; status: "registered"; targetEpoch: number; targetId: string }
  | { errorCode: TargetErrorCode; idempotencyKey: string; message: string; status: "rejected" };

export type SurfAceTargetRestoreResult = {
  blockedReason: TargetErrorCode | null;
  evidence: ApplyEvidence | null;
  targetId: string;
};

export type SurfAceReattemptConnectionsInput = { fingerprint?: string };

export type SurfAceReattemptConnectionsResult = {
  endpointProbes: Array<{
    circuitState: SurfAceConnectionCircuitState;
    endpointId: string;
    name: string;
  }>;
  surfaces: Array<{
    circuitState: SurfAceConnectionCircuitState;
    fingerprint: string;
    name: string;
    windowLabel: string;
  }>;
};

export type SurfAceSplitInput = {
  count: number;
  direction?: "horizontal" | "vertical";
  expectedTopologyRevision?: number;
  fingerprint: string;
  paneId: PaneId;
};

export type SurfAceSplitResult = Array<{
  displayId: string;
  operationReceipt?: SurfAceOperationReceipt;
  paneAddress: string;
  paneId: PaneId;
  paneLabel: number;
}>;

export type SurfAceRealizeTopologyNode =
  | {
      children: SurfAceRealizeTopologyNode[];
      direction: "horizontal" | "vertical";
      type?: "split";
      weight?: number;
    }
  | { name?: string | null; paneId?: PaneId; type?: "pane"; weight?: number };

export type SurfAceRealizeTopologyInput = {
  allowDestroyPaneIds: PaneId[];
  desired: SurfAceRealizeTopologyNode;
  expectedTopologyRevision: number;
  fingerprint: string;
  target: { root: true; paneId?: never } | { paneId: PaneId; root?: never };
};

export type SurfAceRealizeTopologiesInput = {
  operations: Array<
    | (SurfAceRealizeTopologyInput & { operationId?: string; windowLabel?: string })
    | {
        action: "openWindow" | "closeWindow";
        fingerprint: string;
        operationId?: string;
        requestedBy?: string;
        windowLabel?: string;
      }
  >;
};

export type SurfAceRealizeTopologyResult = {
  createdPaneIds: PaneId[];
  destroyedPaneIds: PaneId[];
  destroyedPaneTombstones: Array<{
    closedSequence: number;
    paneId: PaneId;
    tombstoneId: string;
  }>;
  ok: true;
  operationReceipt?: SurfAceOperationReceipt;
  panes: Array<{
    activeContentId: string | null;
    contentType: ContentType | null;
    displayId: string;
    name: string | null;
    paneAddress: string;
    paneId: PaneId;
    paneLabel: number;
  }>;
  preservedPaneIds: PaneId[];
  target: SurfAceRealizeTopologyInput["target"];
  topology: SurfAceTopologySummaryNode;
  topologyRevision: number;
};

export type SurfAceRealizeTopologyOperationResult = SurfAceRealizeTopologyResult & {
  action?: "realizeTopology";
  fingerprint: string;
  operationId?: string;
  windowLabel: string;
};

export type SurfAceWindowLifecycleOperationResult = {
  accepted?: boolean;
  action: "openWindow" | "closeWindow";
  closed?: boolean;
  fingerprint: string;
  openedSurfaceId?: string;
  operationId?: string;
  windowLabel: string;
};

export type SurfAceRealizeTopologiesResult =
  | {
      applied: Array<SurfAceRealizeTopologyOperationResult | SurfAceWindowLifecycleOperationResult>;
      ok: true;
    }
  | {
      applied: Array<SurfAceRealizeTopologyOperationResult | SurfAceWindowLifecycleOperationResult>;
      failed: {
        code: string;
        fingerprint: string;
        index: number;
        message: string;
        operationId?: string;
        windowLabel?: string;
      };
      ok: false;
      skipped: Array<{
        fingerprint: string;
        index: number;
        operationId?: string;
        windowLabel?: string;
      }>;
    };

export type SurfAceClosePaneResult = {
  displayId: string;
  ok: true;
  operationReceipt?: SurfAceOperationReceipt;
  paneAddress: string;
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
  | { paneId: PaneId; surfaceId: string; type: "event.surface_resumed" };

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
  alertDelivery?: (message: string) => Promise<void>;
  discovery?: SurfAceDiscoveryService;
  logger?: SurfAceLogger;
  openClawStateDir?: string;
  projectionCapacityBytes?: number;
  stateDir?: string;
};

export interface SurfAceRuntime {
  annotateRemove(input: SurfAceAnnotateRemoveInput): Promise<SurfAceAnnotateRemoveResult>;
  capturePane(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAcePaneCaptureResult>;
  clear(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceClearResult>;
  closePane(input: { expectedTopologyRevision?: number; fingerprint: string; paneId: PaneId }): Promise<SurfAceClosePaneResult>;
  launchNativeApp(input: SurfAceLaunchNativeAppInput, context?: SurfAceSessionContext): Promise<SurfAcePushResult>;
  listScreens(): Promise<SurfAceScreenSummary[]>;
  push(input: SurfAcePushInput, context?: SurfAceSessionContext): Promise<SurfAcePushResult>;
  read(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceReadResult>;
  realizeTopologies(input: SurfAceRealizeTopologiesInput): Promise<SurfAceRealizeTopologiesResult>;
  realizeTopology(input: SurfAceRealizeTopologyInput): Promise<SurfAceRealizeTopologyResult>;
  reattemptConnections(input?: SurfAceReattemptConnectionsInput): Promise<SurfAceReattemptConnectionsResult>;
  registerTarget(input: SurfAceTargetRegisterInput): Promise<SurfAceTargetRegisterResult>;
  renamePane(input: { expectedTopologyRevision: number; fingerprint: string; name: string | null; paneId: PaneId }): Promise<unknown>;
  restorePane(input: { anchorPaneId: PaneId; direction: "horizontal" | "vertical"; expectedTopologyRevision: number; fingerprint: string; tombstoneId: string }): Promise<unknown>;
  restoreTarget(input: { confirmed?: boolean; fingerprint: string; paneId: PaneId; targetId?: string }): Promise<SurfAceTargetRestoreResult>;
  snapshot(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceSnapshotResult>;
  split(input: SurfAceSplitInput): Promise<SurfAceSplitResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  surfaceIntent(input: Record<string, unknown> & { action: "open" | "close" | "restore" }): Promise<unknown>;
}

function resolveHomePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveOpenClawHomeDir(): string {
  const configured = process.env.OPENCLAW_HOME?.trim();
  return configured ? path.resolve(resolveHomePath(configured)) : os.homedir();
}

export function resolveDefaultSurfAceStateDir(
  openClawStateDir = process.env.OPENCLAW_STATE_DIR,
): string {
  const stateRoot = openClawStateDir?.trim()
    ? path.resolve(resolveHomePath(openClawStateDir.trim()))
    : path.join(resolveOpenClawHomeDir(), ".openclaw");
  return path.join(stateRoot, "extensions", "surf-ace");
}
