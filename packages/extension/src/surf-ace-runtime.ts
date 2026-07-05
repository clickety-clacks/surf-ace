import { execFileSync } from "node:child_process";
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
  AuthorityStateRequest,
  ConnectionId,
  ContentApplyRequest,
  ContentApplyResponse,
  ContentAppendRequest,
  ContentClearRequest,
  ContentDisplay,
  ContentId,
  ContentPatchRequest,
  ContentSetPayload,
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
  PanesListResponse,
  PaneRemovedEvent,
  PaneRenamedEvent,
  PairRequest,
  PairResponse,
  Position,
  ProviderId,
  PusherProvenance,
  Request,
  RequestId,
  Rect,
  Response,
  Revision,
  RuntimeAppBindingDiagnostics,
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
  TargetApplyReason,
  TargetApplyRequest,
  TargetApplyResponse,
  TargetErrorCode,
  TargetHeader,
  TargetKind,
  TargetMaterializedState,
  TopologyChangedEvent,
  TopologyApplyResponse,
  Viewport,
  MutationAckResponse,
  NativePaneWindowGroupDiagnostic,
  PaneGeometryProjection,
  RestorePolicy,
  PageEvent,
  TopologyApplyRequest,
} from "../../protocol/src/index.js";
import { validateEnvelopeType } from "../../protocol/src/validate.js";
import {
  type SurfAceDiscoveryEndpoint,
  type SurfAceDiscoveryService,
  type SurfAceLogger,
  createBonjourSurfAceDiscoveryService,
} from "./surf-ace-discovery.js";
import { SurfAceOwnershipRecoveryPolicy } from "./surf-ace-ownership-recovery-policy.js";
import { SurfAceWireClient } from "./surf-ace-server.js";
import { SurfAceStateRepository } from "./surf-ace-state-repository.js";

export type SurfAceConnectionState = "connected" | "connecting" | "unreachable";
export type SurfAceConnectionCircuitState = "closed" | "open" | "given_up";
type Brand<T, TName extends string> = T & { readonly __brand: TName };
export type PaneId = Brand<string, "PaneId">;

export type SurfAceConnectionDiagnostics = {
  circuitOpen: boolean;
  circuitState: SurfAceConnectionCircuitState;
  failureCount: number;
  givenUp: boolean;
  openedAt: number | null;
  reason: string | null;
  reconnectAttempt: number;
};

export type SurfAceProviderAuthorityDecision = {
  actionable: boolean;
  admitted: boolean;
  blockers: string[];
  reason: string | null;
};

export type SurfAceProviderProcessHealth = {
  duplicateProviderProcesses: boolean;
  liveProviderProcessCount: number;
  pids: number[];
  reason?: string;
  source: "injected" | "process_inventory" | "unavailable";
};

type SurfAceProviderProcessBlockReason =
  | "duplicate_provider_processes"
  | "provider_process_inventory_unavailable"
  | "provider_process_lease_mismatch"
  | "provider_process_missing";

type SurfAceProviderAuthoritySnapshot = {
  decisionsBySurfaceId: Map<string, SurfAceProviderAuthorityDecision>;
  expectedProviderPid: number | null;
  providerProcessBlockReason: SurfAceProviderProcessBlockReason | null;
  providerProcessHealth: SurfAceProviderProcessHealth;
};

const SURF_ACE_CONTENT_TYPES = new Set<string>([
  "canvas",
  "html",
  "image",
  "markdown",
  "pdf",
  "terminal",
  "video",
]);
const SURF_ACE_CONTENT_ID_PATTERN = /^ct_[0-9a-f]{8}$/;

const PROVIDER_PROCESS_BLOCK_REASONS = new Set<string>([
  "duplicate_provider_processes",
  "provider_process_inventory_unavailable",
  "provider_process_lease_mismatch",
  "provider_process_missing",
]);

export type SurfAceProviderAuthorityProjection = {
  activeTargetRecordCount: number;
  authorityBlockedSurfaceIds: string[];
  authorityBlockersBySurfaceId: Record<string, string[]>;
  disabled: boolean;
  liveSurfaceIds: string[];
  nextRemotePaneId: number;
  ownerStatus: "active" | "passive" | "stopped";
  ownsRuntimeLease: boolean;
  persistedSelfOwnedSurfaceIds: string[];
  persistedSurfaceIds: string[];
  processId: number;
  providerProcessBlockReason: SurfAceProviderProcessBlockReason | null;
  providerProcessHealth: SurfAceProviderProcessHealth;
  providerId: string;
  runtimeAppBindingBySurfaceId: Record<string, RuntimeAppBindingDiagnostics | null>;
  runtimeScreenIds: string[];
  started: boolean;
  surfaceTombstones: Record<string, {
    hadTargetState: boolean;
    hadWindowLabel: boolean;
    providerId: string;
    reason: string;
    tombstonedAt: number;
  }>;
  targetStateSurfaceIds: string[];
  windowLabelSurfaceIds: string[];
};

export type SurfAceHistorySummary = {
  backCount: number;
  forwardCount: number;
  visibleProvenance?: SurfAceVisibleContentProvenance | null;
  visibleContentId: string | null;
};

export type SurfAceVisibleContentProvenance = {
  agentId?: string;
  displayName?: string;
  pushedAt?: string;
  sessionKey: string | null;
  source?: string;
  streamLabel?: string;
};

export type SurfAcePaneSummary = {
  displayId: string;
  paneAddress: string;
  paneId: PaneId;
  paneLabel: number;
  name: string | null;
  nativeWindowGroup?: NativePaneWindowGroupDiagnostic;
  activeContent:
    | {
        contentId: string;
        contentType: ContentType;
        display?: ContentDisplay;
        revision: number;
    }
    | null;
  historySummary: SurfAceHistorySummary;
  target: SurfAcePaneTargetDiagnostic | null;
  viewport: SurfaceViewport;
};

export type SurfAceTopologySummaryNode =
  | {
      paneId: PaneId;
      type: "pane";
      weight?: number;
    }
  | {
      children: SurfAceTopologySummaryNode[];
      direction: "horizontal" | "vertical";
      type: "split";
      weight?: number;
    };

export type SurfAceScreenSummary = {
  authority: SurfAceProviderAuthorityDecision;
  connectionDiagnostics: SurfAceConnectionDiagnostics;
  connectionState: SurfAceConnectionState;
  fingerprint: string;
  lastSeenAt: number;
  name: string;
  panes: SurfAcePaneSummary[];
  pendingEvents: number;
  topology: SurfAceTopologySummaryNode | null;
  topologyRevision: number;
  viewport: SurfaceViewport;
  windowLabel: string;
  _debug?: {
    providerAuthority: SurfAceProviderAuthorityDecision;
    providerAuthorityProjection: SurfAceProviderAuthorityProjection;
    runtimeAppBinding: RuntimeAppBindingDiagnostics | null;
    autoRetryEnabled: boolean;
    connectionCircuit?: SurfAceConnectionDiagnostics;
    endpointId: string;
    hasPairedInGatewaySession: boolean;
    localOwnership?: LocalOwnershipProvenance | null;
    ownershipRecovery: "active" | "foreign_or_unknown" | "known_self";
    reconnectAttempt: number;
    remoteOwnership?: RemotePairObservation | null;
    remoteListedAt?: number | null;
    remotePaired?: boolean;
    sessionId: string | null;
    unreachableFailures: number;
    wsOpen: boolean;
  };
};

type EndpointProvenance = {
  endpointHost: string;
  endpointId: string;
  endpointName: string;
  endpointPort: number;
};

type LocalOwnershipProvenance = EndpointProvenance & {
  acceptedAt: number;
  providerId: string;
  sessionId: string;
  source: "pair.response";
  surfaceId: SurfaceId;
};

type RemotePairObservation = EndpointProvenance & {
  observedAt: number;
  paired: boolean;
  source: "surfaces.list";
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
  browserUrl: SurfAceBrowserUrlSemanticEvidence | null;
  contentSnapshot: {
    cachedAt: number;
    content?: ContentSetRequest["payload"]["content"];
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
  paneAddress: string;
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
  windowLabel: string;
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

export type SurfAceSnapshotResult = {
  displayId: string;
  fingerprint: string;
  paneAddress: string;
  paneId: PaneId;
  paneLabel: number;
  windowLabel: string;
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

export type SurfAcePaneCaptureResult = {
  capture: {
    browserUrl: SurfAceBrowserUrlSemanticEvidence | null;
    bytesBase64: string | null;
    capturedAt: number;
    contentType: ContentType | null;
    dimensions: {
      height: number;
      width: number;
    };
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
};

export type SurfAceAnnotateRemoveResult = {
  displayId: string;
  fingerprint: string;
  notFoundStrokeIds: string[];
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

export type SurfAcePushBatchInput = {
  pushes: SurfAcePushInput[];
};

type SurfAceContentPushInput = SurfAcePushInput & { contentType: ContentType };
type SurfAceBrowserUrlPushInput = SurfAcePushInput & { contentType: "browser_url" };

type SurfAceLaunchTerminalInput = {
  args?: string[];
  command: string;
  confirmed: boolean;
  cwd?: string | null;
  fingerprint: string;
  idempotencyKey?: string;
  paneId: PaneId;
  restartPolicy?: "restore_new_process" | "manual_only";
  summary?: string;
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
  paneAddress: string;
  paneId: PaneId;
  paneLabel: number;
  revision: number;
  targetApplyEvidence?: ApplyEvidence;
  targetId?: string;
  targetKind?: TargetKind;
};

export type SurfAcePushBatchResult = {
  failed: number;
  ok: boolean;
  results: SurfAcePushBatchPaneResult[];
  succeeded: number;
};

export type SurfAcePushBatchPaneResult = {
  errorCode?: SurfAceToolError["code"];
  message?: string;
  ok: boolean;
  push: SurfAcePushInput;
  result?: SurfAcePushResult;
};

export type SurfAceClearResult = {
  displayId: string;
  fingerprint: string;
  paneAddress: string;
  paneId: PaneId;
  paneLabel: number;
  revision: number;
};

type SurfAceSessionContext = {
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
  requestId: string;
  status: "applied" | "rejected" | "failed";
  errorCode?: TargetErrorCode;
  message?: string;
  materializedState?: TargetMaterializedState;
  appliedAt: string;
};

export type PaneTargetRecord = {
  targetId: string;
  surfaceId: string;
  surfaceInstanceId: string | null;
  paneLineageId: string;
  paneIdAtApply: string;
  paneLabelAtApply: number | string | null;
  targetEpoch: number;
  targetKind: TargetKind;
  targetHeader: TargetHeader;
  targetPayload: unknown;
  contentIdAtApply?: string | null;
  display?: ContentDisplay | null;
  restorePolicy: RestorePolicy;
  ownerProviderId: string;
  ownershipSessionId: string;
  ownershipEpoch: number;
  appliedAt: string;
  currentState: "current" | "superseded" | "stale" | "tombstoned";
  supersededByTargetId?: string;
  lastApplyEvidence?: ApplyEvidence;
  lastSuccessfulApplyEvidence?: ApplyEvidence;
};

export type DiagnosticPaneContent = {
  diagnosticContentId: string;
  surfaceId: string;
  paneLineageId: string;
  kind: "placeholder" | "status" | "error";
  summary: string;
  derivedFromTargetId?: string;
  shownAt: string;
};

export type SurfAcePaneTargetDiagnostic = {
  blockedReason: TargetErrorCode | null;
  diagnosticContent: DiagnosticPaneContent | null;
  lastApplyEvidence: ApplyEvidence | null;
  display?: ContentDisplay | null;
  displayId: string;
  paneAddress: string;
  paneLineageId: string;
  targetHeader: TargetHeader;
  targetId: string;
  targetKind: TargetKind;
  targetPayload: unknown;
  targetPolicy: RestorePolicy;
};

export type SurfAceTargetRegisterInput = {
  fingerprint: string;
  idempotencyKey: string;
  paneId: PaneId;
  ownershipEpoch: number;
  ownershipSessionId: string;
  paneLineageId: string;
  expectedPreviousTargetEpoch: number | null;
  targetKind: TargetKind;
  targetHeader: TargetHeader;
  targetPayload: unknown;
  launchedAt?: string;
  registrationState: "before_attach" | "attached";
  restorePolicy?: RestorePolicy;
};

export type SurfAceTargetRegisterResult =
  | {
      idempotencyKey: string;
      status: "registered";
      targetEpoch: number;
      targetId: string;
    }
  | {
      errorCode: TargetErrorCode;
      idempotencyKey: string;
      message: string;
      status: "rejected";
    };

export type SurfAceTargetRestoreResult = {
  blockedReason: TargetErrorCode | null;
  evidence: ApplyEvidence | null;
  targetId: string;
};

export type SurfAceRelinquishResult = {
  relinquished: true;
};

export type SurfAceReattemptConnectionsInput = {
  fingerprint?: string;
};

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

export type SurfAceOpenSurfaceWindowInput = {
  fingerprint: string;
  requestedBy?: string;
};

export type SurfAceOpenSurfaceWindowResult = {
  accepted: boolean;
  fingerprint: string;
  message: string;
  openedSurfaceId?: string;
  windowLabel: string;
};

export type SurfAceSplitInput = {
  count: number;
  direction?: "horizontal" | "vertical";
  fingerprint: string;
  paneId: PaneId;
};

export type SurfAceSplitResult = Array<{
  displayId: string;
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
  | {
      name?: string | null;
      paneId?: PaneId;
      type?: "pane";
      weight?: number;
    };

export type SurfAceRealizeTopologyInput = {
  allowDestroyPaneIds: PaneId[];
  desired: SurfAceRealizeTopologyNode;
  expectedTopologyRevision: number;
  fingerprint: string;
  target:
    | { root: true; paneId?: never }
    | { paneId: PaneId; root?: never };
};

export type SurfAceRealizeTopologiesInput = {
  operations: Array<
    | (SurfAceRealizeTopologyInput & {
        operationId?: string;
        windowLabel?: string;
      })
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
  ok: true;
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
  operationId?: string;
  openedSurfaceId?: string;
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
  legacyStateDir?: string;
  logger?: SurfAceLogger;
  now?: () => number;
  openClawStateDir?: string;
  providerProcessHealth?: (expectedProviderPid?: number | null) => SurfAceProviderProcessHealth;
  providerName?: string;
  stateDir?: string;
};

export interface SurfAceRuntime {
  annotateRemove(input: SurfAceAnnotateRemoveInput): Promise<SurfAceAnnotateRemoveResult>;
  capturePane(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAcePaneCaptureResult>;
  clear(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceClearResult>;
  closePane(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceClosePaneResult>;
  listScreens(): Promise<SurfAceScreenSummary[]>;
  launchNativeApp(input: SurfAceLaunchNativeAppInput, context?: SurfAceSessionContext): Promise<SurfAcePushResult>;
  providerAuthorityDiagnostics(): Promise<SurfAceProviderAuthorityProjection>;
  push(input: SurfAcePushInput, context?: SurfAceSessionContext): Promise<SurfAcePushResult>;
  pushBatch(input: SurfAcePushBatchInput, context?: SurfAceSessionContext): Promise<SurfAcePushBatchResult>;
  read(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceReadResult>;
  realizeTopology(input: SurfAceRealizeTopologyInput): Promise<SurfAceRealizeTopologyResult>;
  realizeTopologies(input: SurfAceRealizeTopologiesInput): Promise<SurfAceRealizeTopologiesResult>;
  registerTarget(input: SurfAceTargetRegisterInput): Promise<SurfAceTargetRegisterResult>;
  reattemptConnections(input?: SurfAceReattemptConnectionsInput): Promise<SurfAceReattemptConnectionsResult>;
  relinquish(input: { fingerprint: string }): Promise<SurfAceRelinquishResult>;
  restoreTarget(input: { confirmed?: boolean; fingerprint: string; paneId: PaneId; targetId?: string }): Promise<SurfAceTargetRestoreResult>;
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
      weight?: number;
    }
  | {
      children: ManagedLayoutNode[];
      direction: "horizontal" | "vertical";
      type: "split";
      weight?: number;
    };

type ManagedHistoryEntry = {
  contentId: ContentId;
  contentType: ContentType;
  contentValue: ContentSetRequest["payload"]["content"];
  display: ContentDisplay | null;
  historyOwnerToken: string | null;
  revision: Revision;
  sessionKey: string | null;
  targetId: string | null;
};

type ManagedPane = {
  activeContentId: ContentId | null;
  contentType: ContentType | null;
  contentValue: ContentSetRequest["payload"]["content"] | null;
  currentTargetId: string | null;
  currentRevision: Revision;
  diagnosticContent: DiagnosticPaneContent | null;
  display: ContentDisplay | null;
  externalNative: boolean;
  historyEntries: ManagedHistoryEntry[];
  historySummary: SurfAceHistorySummary;
  historyOwnerToken: string | null;
  lastRestoreBlockedReason: TargetErrorCode | null;
  name: string | null;
  nativeWindowGroup: NativePaneWindowGroupDiagnostic | null;
  nonDurableTargetDiagnostic: SurfAcePaneTargetDiagnostic | null;
  ownerSessionKey: string | null;
  paneId: PaneId;
  paneLabel: number;
  paneLineageId: string;
  pendingOwnerSessionKey: string | null;
  pairImportedContentAuthority: boolean;
  remotePaneId: RemotePaneId;
  geometry: PaneGeometryProjection | null;
  snapshot: CachedSnapshot | null;
  staleTargetId: string | null;
  targetEpoch: number;
  viewport: SurfaceViewport;
  buffer: MutablePaneBuffer;
};

type ProviderPaneAuthorityRecord = {
  pane: ManagedPane;
  target: PaneTargetRecord | null;
  targetState: "current" | "stale" | "none";
  blockedReason: TargetErrorCode | null;
};

type ManagedSurface = {
  alertFired: boolean;
  alertFiredAt: number | null;
  authorityAcceptedAt: number | null;
  authorityAcceptedIdentityKey: string | null;
  authorityRejectedReason: string | null;
  autoRetryEnabled: boolean;
  client: SurfAceWireClient | null;
  connectionState: SurfAceConnectionState;
  connectionCircuitOpenedAt: number | null;
  connectionCircuitReason: string | null;
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
  localOwnership: LocalOwnershipProvenance | null;
  name: string;
  paneIdsNeedingSnapshot: Set<PaneId>;
  panes: Map<PaneId, ManagedPane>;
  recentEventIds: string[];
  recentEventIdsSet: Set<string>;
  registeredTargetIdsByIdempotencyKey: Map<string, string>;
  reconnectAttempt: number;
  remotePairObservation: RemotePairObservation | null;
  remoteListedAt: number | null;
  remotePaired: boolean;
  restartOwnershipPendingPair: boolean;
  runtimeAppBinding: RuntimeAppBindingDiagnostics | null;
  retryDelayResolver: (() => void) | null;
  selfOwnershipReclaimAttempted: boolean;
  sessionId: SessionId | null;
  ownershipEpoch: number;
  snapshotBufferedEvents: Event[];
  snapshotSyncInFlight: boolean;
  stopRequested: boolean;
  surfaceId: SurfaceId;
  protocolFeatures: Set<string>;
  targetCapabilities: Set<string>;
  targetRecords: Map<string, PaneTargetRecord>;
  topologyApplyInFlight: boolean;
  topologyRevision: number;
  unreachableFailures: number;
  viewport: SurfaceViewport;
  windowLabel: string;
  workPromise: Promise<void> | null;
};

type EndpointProbe = {
  autoRetryEnabled: boolean;
  canonicalKey: string;
  client: SurfAceWireClient | null;
  connectionState: SurfAceConnectionState;
  connectionCircuitOpenedAt: number | null;
  connectionCircuitReason: string | null;
  endpoint: SurfAceDiscoveryEndpoint;
  endpointId: string;
  fingerprintPrefix: string;
  lastSeenAt: number;
  name: string;
  reconnectAttempt: number;
  reconcileWorkPromise: Promise<void> | null;
  retryDelayResolver: (() => void) | null;
  stopRequested: boolean;
  unreachableFailures: number;
  viewport: SurfaceViewport;
  workPromise: Promise<void> | null;
};

type RuntimeStateFile = {
  nextRemotePaneId: number;
  nextPaneLabel: number;
  nextWindowLabelIndex: number;
  paneLabelsByPaneId: Record<string, number>;
  providerId: string;
  providerLineage?: Array<{
    observedAt: number;
    providerId: string;
    source: "current_state" | "legacy_state_root";
  }>;
  selfOwnedSurfaceIds?: Record<string, {
    observedAt: number;
    providerId: string;
    relinquishedAt?: number;
    source:
      | "current_local_ownership"
      | "current_snapshot_local_ownership"
      | "current_target_state"
      | "current_target_ownership"
      | "legacy_local_ownership"
      | "legacy_target_state";
  }>;
  surfaceTombstones?: Record<string, {
    hadTargetState: boolean;
    hadWindowLabel: boolean;
    providerId: string;
    reason: string;
    tombstonedAt: number;
  }>;
  targetLifecycleEventsBySurfaceId?: Record<string, PersistedTargetLifecycleEvent[]>;
  targetStateBySurfaceId?: Record<string, PersistedSurfaceTargetState>;
  tombstonedEndpointIds?: string[];
  version: 1;
  windowLabels: Record<string, string>;
};

type ProviderIdentityFile = {
  providerId: string;
  version: 1;
};

type PersistedRestartContentEntry = {
  contentId: string;
  contentType: ContentType;
  contentValue: unknown;
  display: ContentDisplay | null;
  historyOwnerToken: string | null;
  liveDirtyStrokeIds?: string[];
  liveFrame?: SurfAceFrame | null;
  paneLabel: number;
  remotePaneId?: number;
  revision: number;
  sessionKey: string | null;
};

type PersistedPaneTargetState = {
  currentTargetId: string | null;
  diagnosticContent: DiagnosticPaneContent | null;
  lastRestoreBlockedReason: TargetErrorCode | null;
  nonDurableTargetDiagnostic?: SurfAcePaneTargetDiagnostic | null;
  paneLineageId: string;
  staleTargetId?: string | null;
  targetEpoch: number;
};

type PersistedTargetLifecycleEvent = {
  event: "create" | "persist" | "hydrate" | "stale" | "remove" | "tombstone";
  paneLineageId?: string;
  reason: string;
  recordedAt: number;
  targetId?: string;
};

type PersistedSurfaceTargetState = {
  lifecycleEvents?: PersistedTargetLifecycleEvent[];
  ownershipEpoch?: number;
  paneTargets: Record<string, PersistedPaneTargetState>;
  registeredTargetIdsByIdempotencyKey: Record<string, string>;
  targetRecords: PaneTargetRecord[];
};

type PersistedScreenSnapshotFile = {
  contentContinuity?: Record<string, PersistedRestartContentEntry[]>;
  screens: SurfAceScreenSummary[];
  updatedAt: number;
  version: 1;
};

type RuntimeDiagnosticFields = Record<string, boolean | number | string | null | undefined>;

function resolveHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith(`~${path.sep}`) || input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveOpenClawHomeDir(): string {
  const openClawHome = process.env.OPENCLAW_HOME?.trim();
  return openClawHome ? path.resolve(resolveHomePath(openClawHome)) : os.homedir();
}

export function resolveDefaultSurfAceStateDir(openClawStateDir = process.env.OPENCLAW_STATE_DIR): string {
  const stateRoot = openClawStateDir?.trim()
    ? path.resolve(resolveHomePath(openClawStateDir.trim()))
    : path.join(resolveOpenClawHomeDir(), ".openclaw");
  return path.join(stateRoot, "extensions", "surf-ace");
}

function resolveDefaultProviderIdentityPath(): string {
  return path.join(resolveOpenClawHomeDir(), ".openclaw", "extensions", "surf-ace", PROVIDER_IDENTITY_FILE_NAME);
}

function legacySurfAceStateDir(): string {
  return path.join(os.homedir(), ".surf-ace-openclaw-extension");
}

function generateProviderId(): string {
  return `pv_${randomUUID().replaceAll("-", "")}`;
}

function isValidProviderId(value: string): boolean {
  return /^pv_[A-Za-z0-9_:-]{1,128}$/.test(value);
}

function formatRuntimeDiagnosticValue(value: string | number | boolean): string {
  const text = String(value);
  return /^[A-Za-z0-9_.,/:@%-]+$/.test(text) ? text : JSON.stringify(text);
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

function commandExecutableToken(command: string): string {
  return command
    .trim()
    .split(/\s+/)
    .find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ?? "";
}

function isOpenClawGatewayProcess(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const executable = path.basename(commandExecutableToken(command));
  if (!/^node(?:$|@)/.test(executable)) {
    return false;
  }
  return tokens.includes("gateway") &&
    tokens.some((token) => {
      const pathParts = token.split(/[\\/]/);
      return path.basename(token) === "index.js" && pathParts.includes("dist");
    });
}

function isExpectedProviderOwnerProcess(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const executable = path.basename(commandExecutableToken(command));
  if (path.basename(executable) === "openclaw-plugins" || isOpenClawGatewayProcess(command)) {
    return true;
  }
  if (!/^(node(?:$|@)|tsx|ts-node|bun|deno)$/.test(executable) || !tokens.includes("gateway")) {
    return false;
  }
  return tokens.some((token) => {
    if (/(?:openclaw|surf-ace|clawdbot)/i.test(token)) {
      return true;
    }
    const pathParts = token.split(/[\\/]/);
    return ["index.js", "index.ts"].includes(path.basename(token)) &&
      pathParts.some((part) => ["dist", "src", "packages"].includes(part));
  });
}

export function providerProcessHealthFromProcessList(
  processListOutput: string,
  expectedProviderPid: number | null = process.pid,
): SurfAceProviderProcessHealth {
  const processCommands = new Map<number, string>();
  for (const line of processListOutput.split("\n")) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    if (Number.isFinite(pid)) {
      processCommands.set(pid, match[2] ?? "");
    }
  }

  const pids = new Set<number>();
  for (const [pid, command] of processCommands) {
    const executable = commandExecutableToken(command);
    if (path.basename(executable) === "openclaw-plugins" || isOpenClawGatewayProcess(command)) {
      pids.add(pid);
    }
  }
  if (typeof expectedProviderPid === "number") {
    const expectedCommand = processCommands.get(expectedProviderPid);
    if (expectedCommand && isExpectedProviderOwnerProcess(expectedCommand)) {
      pids.add(expectedProviderPid);
    }
  }

  const livePids = [...pids].sort((left, right) => left - right);
  return {
    duplicateProviderProcesses: livePids.length > 1,
    liveProviderProcessCount: livePids.length,
    pids: livePids,
    source: "process_inventory",
  };
}

function defaultProviderProcessHealth(expectedProviderPid: number | null = process.pid): SurfAceProviderProcessHealth {
  if (process.platform !== "darwin") {
    return {
      duplicateProviderProcesses: false,
      liveProviderProcessCount: 0,
      pids: [],
      reason: "process inventory unavailable on this platform",
      source: "unavailable",
    };
  }

  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return providerProcessHealthFromProcessList(output, expectedProviderPid);
  } catch (error) {
    return {
      duplicateProviderProcesses: false,
      liveProviderProcessCount: 0,
      pids: [],
      reason: error instanceof Error ? error.message : String(error),
      source: "unavailable",
    };
  }
}

function diagnosticJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
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
const AUTHORITY_STATE_PROTOCOL_FEATURE = "authority.state.v1";
const LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
const LEASE_STALE_THRESHOLD_MS = 90_000;
const RESTART_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;
const STARTUP_SELF_OWNERSHIP_RECLAIM_GRACE_MS = 30_000;
const RECONNECT_BACKOFF_BASE_MS = 2_000;
const RECONNECT_BACKOFF_CAP_MS = 30_000;
const RESUME_TARGET_MATERIALIZATION_RETRY_DELAYS_MS = [250, 2_000, 10_000] as const;
const REQUEST_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_RESET_MS = 30_000;
const UNREACHABLE_AFTER_FAILURES = 3;
const GIVE_UP_AFTER_FAILURES = 6;
const ALERT_RESET_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ALERT_SESSION_KEY = "agent:main:main";
const ALERT_ENDPOINT_URL = "http://localhost:18800/alert";
const MAX_CONSECUTIVE_RESUME_FAILURES = 3;
const MAX_CONSECUTIVE_OWNERSHIP_LOCK_FAILURES = 3;
const DISCOVERY_UPDATE_LOG_MIN_INTERVAL_MS = 5_000;
const PROVIDER_IDENTITY_FILE_NAME = "surf-ace-provider-identity.json";
const STATE_FILE_NAME = "surf-ace-runtime-state.json";
const SCREEN_SNAPSHOT_FILE_NAME = "surf-ace-runtime-screens.json";
const RUNTIME_LEASE_FILE_NAME = "surf-ace-runtime-owner.lock";
const OWNER_CONTROL_PATH = "/surf-ace-runtime-owner";
const RESTORE_FLIGHT_RECORDER_ARTIFACT_DIR = path.join("/tmp", "surf-ace", "restore-flight-recorder");
const OWNER_CONTROL_MAX_BODY_BYTES = 1024 * 1024;
const LEGACY_STATE_FILE_NAMES = [
  STATE_FILE_NAME,
  SCREEN_SNAPSHOT_FILE_NAME,
  RUNTIME_LEASE_FILE_NAME,
] as const;

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
      context?: SurfAceSessionContext;
      input: SurfAcePushInput;
      op: "push";
    }
  | {
      context?: SurfAceSessionContext;
      input: SurfAcePushBatchInput;
      op: "pushBatch";
    }
  | {
      context?: SurfAceSessionContext;
      input: SurfAceLaunchNativeAppInput;
      op: "launchNativeApp";
    }
  | {
      context?: SurfAceSessionContext;
      input: SurfAceLaunchTerminalInput;
      op: "launchTerminal";
    }
  | {
      input: { fingerprint: string; paneId: PaneId };
      op: "capturePane" | "clear" | "closePane" | "read" | "snapshot";
    }
  | {
      input: { confirmed?: boolean; fingerprint: string; paneId: PaneId; targetId?: string };
      op: "restoreTarget";
    }
  | {
      input: SurfAceSplitInput;
      op: "split";
    }
  | {
      input: SurfAceRealizeTopologyInput;
      op: "realizeTopology";
    }
  | {
      input: SurfAceRealizeTopologiesInput;
      op: "realizeTopologies";
    }
  | {
      input: { fingerprint: string };
      op: "relinquish";
    }
  | {
      input?: SurfAceReattemptConnectionsInput;
      op: "reattemptConnections";
    }
  | {
      op: "listScreens";
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

function legacyPaneLineageId(remotePaneId: RemotePaneId): string {
  return `legacy_remote_pane_${remotePaneId}`;
}

function isLegacyPaneLineageId(lineageId: string): boolean {
  return lineageId.startsWith("legacy_remote_pane_");
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

function isProvisionalSurfaceId(surfaceId: SurfaceId): boolean {
  return surfaceId.startsWith("sf_disc_");
}

function makeContentId(): ContentId {
  return `ct_${randomBytes(4).toString("hex")}` as ContentId;
}

function makeTargetId(): string {
  return `tg_${randomBytes(8).toString("hex")}`;
}

function makeDiagnosticContentId(): string {
  return `dc_${randomBytes(8).toString("hex")}`;
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

function visiblePaneAddress(windowLabel: string, paneLabel: number): string {
  void windowLabel;
  return paneLabel > 0 ? String(paneLabel) : "";
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
    currentTargetId: null,
    currentRevision: asRevision(0),
    diagnosticContent: null,
    display: null,
    externalNative: false,
    historyEntries: [],
    historySummary: {
      backCount: 0,
      forwardCount: 0,
      visibleContentId: null,
    },
    historyOwnerToken: null,
    lastRestoreBlockedReason: null,
    name: null,
    nativeWindowGroup: null,
    nonDurableTargetDiagnostic: null,
    ownerSessionKey: null,
    paneId,
    paneLabel,
    paneLineageId: legacyPaneLineageId(remotePaneId),
    pendingOwnerSessionKey: null,
    pairImportedContentAuthority: false,
    remotePaneId,
    geometry: null,
    snapshot: null,
    staleTargetId: null,
    targetEpoch: 0,
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
    authorityAcceptedAt: null,
    authorityAcceptedIdentityKey: null,
    authorityRejectedReason: null,
    autoRetryEnabled: true,
    client: null,
    connectionState: "connecting",
    connectionCircuitOpenedAt: null,
    connectionCircuitReason: null,
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
    localOwnership: null,
    name,
    paneIdsNeedingSnapshot: new Set<PaneId>(),
    panes: new Map<PaneId, ManagedPane>(),
    recentEventIds: [],
    recentEventIdsSet: new Set<string>(),
    registeredTargetIdsByIdempotencyKey: new Map<string, string>(),
    reconnectAttempt: 0,
    remotePairObservation: null,
    remoteListedAt: null,
    remotePaired: false,
    restartOwnershipPendingPair: false,
    runtimeAppBinding: null,
    retryDelayResolver: null,
    selfOwnershipReclaimAttempted: false,
    sessionId: null,
    ownershipEpoch: 0,
    snapshotBufferedEvents: [],
    snapshotSyncInFlight: false,
    stopRequested: false,
    surfaceId,
    protocolFeatures: new Set<string>(),
    targetCapabilities: new Set<string>(),
    targetRecords: new Map<string, PaneTargetRecord>(),
    topologyApplyInFlight: false,
    topologyRevision: 0,
    unreachableFailures: 0,
    viewport: cloneViewport(viewport),
    windowLabel,
    workPromise: null,
  };
}

function endpointProvenance(endpoint: SurfAceDiscoveryEndpoint): EndpointProvenance {
  return {
    endpointHost: endpoint.host,
    endpointId: endpoint.endpointId,
    endpointName: endpoint.name,
    endpointPort: endpoint.port,
  };
}

function createEndpointProbe(endpoint: SurfAceDiscoveryEndpoint, now: number): EndpointProbe {
  return {
    autoRetryEnabled: true,
    canonicalKey: endpointProbeKey(endpoint),
    client: null,
    connectionState: "connecting",
    connectionCircuitOpenedAt: null,
    connectionCircuitReason: null,
    endpoint,
    endpointId: endpoint.endpointId,
    fingerprintPrefix: endpoint.fingerprintPrefix,
    lastSeenAt: now,
    name: endpoint.name,
    reconnectAttempt: 0,
    reconcileWorkPromise: null,
    retryDelayResolver: null,
    stopRequested: false,
    unreachableFailures: 0,
    viewport: cloneViewport(endpoint.viewport),
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

function flattenTopologyLayoutRemotePaneIds(node: TopologyApplyRequest["payload"]["layout"]): RemotePaneId[] {
  if (node.type === "pane") {
    return [node.paneId];
  }
  return node.children.flatMap((child) => flattenTopologyLayoutRemotePaneIds(child));
}

function isValidTopologyLayoutNode(node: unknown): node is TopologyApplyRequest["payload"]["layout"] {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return false;
  }
  const record = node as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.weight !== undefined && (typeof record.weight !== "number" || !Number.isFinite(record.weight) || record.weight <= 0)) {
    return false;
  }
  if (record.type === "pane") {
    return keys.every((key) => key === "type" || key === "paneId" || key === "weight") &&
      Number.isInteger(record.paneId) &&
      Number(record.paneId) >= 1;
  }
  if (record.type !== "split") {
    return false;
  }
  if (!keys.every((key) => key === "type" || key === "direction" || key === "children" || key === "weight")) {
    return false;
  }
  if (record.direction !== "horizontal" && record.direction !== "vertical") {
    return false;
  }
  if (!Array.isArray(record.children) || record.children.length === 0) {
    return false;
  }
  return record.children.every((child) => isValidTopologyLayoutNode(child));
}

function topologyLayoutExactlyCoversRemotePaneIds(
  layout: TopologyApplyRequest["payload"]["layout"],
  remotePaneIds: readonly RemotePaneId[],
): boolean {
  const layoutRemotePaneIds = flattenTopologyLayoutRemotePaneIds(layout);
  const layoutRemotePaneIdSet = new Set(layoutRemotePaneIds);
  return layoutRemotePaneIds.length === remotePaneIds.length &&
    layoutRemotePaneIdSet.size === layoutRemotePaneIds.length &&
    remotePaneIds.every((paneId) => layoutRemotePaneIdSet.has(paneId));
}

function isValidPairResponsePaneState(node: unknown): node is PairResponse["payload"]["state"]["panes"][number] {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return false;
  }
  const record = node as Record<string, unknown>;
  const allowedKeys = new Set([
    "contentType",
    "currentContentId",
    "currentRevision",
    "display",
    "paneId",
    "paneLabel",
    "paneLineageId",
  ]);
  if (!Object.keys(record).every((key) => allowedKeys.has(key))) {
    return false;
  }
  if (!Number.isInteger(record.paneId) || Number(record.paneId) < 1) {
    return false;
  }
  if (!Number.isInteger(record.paneLabel) || Number(record.paneLabel) < 1) {
    return false;
  }
  if (!Number.isInteger(record.currentRevision) || Number(record.currentRevision) < 0) {
    return false;
  }
  if (
    record.currentContentId !== null &&
    (
      typeof record.currentContentId !== "string" ||
      !SURF_ACE_CONTENT_ID_PATTERN.test(record.currentContentId)
    )
  ) {
    return false;
  }
  if (record.contentType !== null && !SURF_ACE_CONTENT_TYPES.has(record.contentType as ContentType)) {
    return false;
  }
  return record.paneLineageId === undefined ||
    (typeof record.paneLineageId === "string" && record.paneLineageId.length > 0);
}

function recoverPairResponsePaneTopologyState(node: unknown): PairResponse["payload"]["state"]["panes"][number] | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }
  const record = node as Record<string, unknown>;
  if (!Number.isInteger(record.paneId) || Number(record.paneId) < 1) {
    return null;
  }
  if (!Number.isInteger(record.paneLabel) || Number(record.paneLabel) < 1) {
    return null;
  }
  return {
    contentType: null,
    currentContentId: null,
    currentRevision: 0 as Revision,
    paneId: record.paneId as RemotePaneId,
    paneLabel: record.paneLabel as number,
    ...(typeof record.paneLineageId === "string" && record.paneLineageId.length > 0
      ? { paneLineageId: record.paneLineageId }
      : {}),
  };
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

function managedLayoutFromPanes(
  panes: ManagedPane[],
  direction: "horizontal" | "vertical" = "horizontal",
): ManagedLayoutNode {
  if (panes.length === 0) {
    throw new SurfAceToolError("internal_error", "Surface layout cannot be built without panes");
  }
  if (panes.length === 1) {
    return {
      paneId: panes[0]!.paneId,
      type: "pane",
    };
  }
  return {
    children: panes.map((pane) => ({
      paneId: pane.paneId,
      type: "pane",
    })),
    direction,
    type: "split",
  };
}

function approxEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1;
}

function managedLayoutFromEqualProviderGeometry(panes: ManagedPane[]): ManagedLayoutNode | null {
  if (panes.length === 0) {
    return null;
  }
  if (panes.length === 1) {
    return { paneId: panes[0]!.paneId, type: "pane" };
  }
  if (panes.length !== 2) {
    return null;
  }
  if (panes.some((pane) => !pane.geometry)) {
    return null;
  }
  const frames = panes.map((pane) => ({
    bounds: pane.geometry!.surfaceBounds,
    frame: pane.geometry!.paneFrame,
    pane,
  }));
  const surfaceBounds = frames[0]!.bounds;
  if (
    frames.some(
      ({ bounds }) =>
        !approxEqual(bounds.x, surfaceBounds.x) ||
        !approxEqual(bounds.y, surfaceBounds.y) ||
        !approxEqual(bounds.width, surfaceBounds.width) ||
        !approxEqual(bounds.height, surfaceBounds.height),
    )
  ) {
    return null;
  }
  const vertical = [...frames].sort((left, right) => left.frame.x - right.frame.x || left.pane.paneId.localeCompare(right.pane.paneId));
  const verticalTile =
    vertical.every(({ frame }) => approxEqual(frame.y, surfaceBounds.y) && approxEqual(frame.height, surfaceBounds.height)) &&
    vertical.every(({ frame }) => approxEqual(frame.width, vertical[0]!.frame.width)) &&
    vertical.every(({ frame }, index) => approxEqual(frame.x, surfaceBounds.x + index * vertical[0]!.frame.width)) &&
    approxEqual(vertical[0]!.frame.width * vertical.length, surfaceBounds.width);
  if (verticalTile) {
    return managedLayoutFromPanes(vertical.map(({ pane }) => pane), "vertical");
  }

  const horizontal = [...frames].sort((left, right) => left.frame.y - right.frame.y || left.pane.paneId.localeCompare(right.pane.paneId));
  const horizontalTile =
    horizontal.every(({ frame }) => approxEqual(frame.x, surfaceBounds.x) && approxEqual(frame.width, surfaceBounds.width)) &&
    horizontal.every(({ frame }) => approxEqual(frame.height, horizontal[0]!.frame.height)) &&
    horizontal.every(({ frame }, index) => approxEqual(frame.y, surfaceBounds.y + index * horizontal[0]!.frame.height)) &&
    approxEqual(horizontal[0]!.frame.height * horizontal.length, surfaceBounds.height);
  if (horizontalTile) {
    return managedLayoutFromPanes(horizontal.map(({ pane }) => pane), "horizontal");
  }
  return null;
}

function managedLayoutEquals(left: ManagedLayoutNode | null, right: ManagedLayoutNode | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function integerPaneRect(rect: Rect): Rect {
  return {
    height: Math.max(0, Math.round(rect.height)),
    width: Math.max(0, Math.round(rect.width)),
    x: Math.round(rect.x),
    y: Math.round(rect.y),
  };
}

function layoutNodeWeight(node: { weight?: number }): number {
  return typeof node.weight === "number" && Number.isFinite(node.weight) && node.weight > 0
    ? node.weight
    : 1;
}

function collectManagedPaneRects(node: ManagedLayoutNode, rect: Rect, result: Map<PaneId, Rect>): void {
  if (node.type === "pane") {
    result.set(node.paneId, integerPaneRect(rect));
    return;
  }

  if (node.children.length === 0) {
    return;
  }

  const totalWeight = Math.max(1, node.children.reduce((sum, child) => sum + layoutNodeWeight(child), 0));
  let offset = 0;

  if (node.direction === "vertical") {
    node.children.forEach((child, index) => {
      const childWeight = layoutNodeWeight(child);
      const childStart = Math.round(rect.x + offset);
      offset += rect.width * (childWeight / totalWeight);
      const childEnd = index === node.children.length - 1 ? Math.round(rect.x + rect.width) : Math.round(rect.x + offset);
      collectManagedPaneRects(
        child,
        {
          height: rect.height,
          width: Math.max(0, childEnd - childStart),
          x: childStart,
          y: rect.y,
        },
        result,
      );
    });
    return;
  }

  node.children.forEach((child, index) => {
    const childWeight = layoutNodeWeight(child);
    const childStart = Math.round(rect.y + offset);
    offset += rect.height * (childWeight / totalWeight);
    const childEnd = index === node.children.length - 1 ? Math.round(rect.y + rect.height) : Math.round(rect.y + offset);
    collectManagedPaneRects(
      child,
      {
        height: Math.max(0, childEnd - childStart),
        width: rect.width,
        x: rect.x,
        y: childStart,
      },
      result,
    );
  });
}

function managedPaneRects(surface: ManagedSurface): Map<PaneId, Rect> {
  const result = new Map<PaneId, Rect>();
  collectManagedPaneRects(
    collapseManagedLayout(surface.layout),
    {
      height: surface.viewport.height,
      width: surface.viewport.width,
      x: 0,
      y: 0,
    },
    result,
  );
  return result;
}

function paneFrameRect(pane: ManagedPane): Rect | null {
  return pane.geometry?.paneFrame ?? pane.geometry?.protocolViewport.rect ?? null;
}

function viewportFromResolvedPaneGeometry(pane: ManagedPane): SurfaceViewport {
  return pane.geometry?.protocolViewport.viewport ?? cloneViewport(pane.viewport);
}

function remoteLayoutToTopologyLayout(
  surface: ManagedSurface,
  node: ManagedLayoutNode,
  panes: Map<PaneId, ManagedPane> = surface.panes,
): TopologyApplyRequest["payload"]["layout"] {
  if (node.type === "pane") {
    const pane = panes.get(node.paneId);
    if (!pane) {
      throw new SurfAceToolError(
        "internal_error",
        `Surface ${surface.surfaceId} layout referenced missing pane ${node.paneId}`,
      );
    }
    return {
      paneId: pane.remotePaneId,
      type: "pane",
      ...(node.weight !== undefined ? { weight: node.weight } : {}),
    };
  }
  return {
    children: node.children.map((child) => remoteLayoutToTopologyLayout(surface, child, panes)),
    direction: node.direction,
    type: "split",
    ...(node.weight !== undefined ? { weight: node.weight } : {}),
  };
}

function topologyLayoutToManagedLayout(
  surface: ManagedSurface,
  node: TopologyApplyRequest["payload"]["layout"],
): ManagedLayoutNode {
  return topologyLayoutToManagedLayoutFromPanes([...surface.panes.values()], node);
}

function topologyLayoutToManagedLayoutFromPanes(
  panes: readonly ManagedPane[],
  node: TopologyApplyRequest["payload"]["layout"],
): ManagedLayoutNode {
  if (node.type === "pane") {
    const pane = panes.find((candidate) => candidate.remotePaneId === node.paneId);
    if (!pane) {
      throw new SurfAceToolError("invalid_operation", `Topology update referenced unknown pane ${node.paneId}.`);
    }
    return {
      paneId: pane.paneId,
      type: "pane",
      ...(node.weight !== undefined ? { weight: node.weight } : {}),
    };
  }
  return {
    children: node.children.map((child) => topologyLayoutToManagedLayoutFromPanes(panes, child)),
    direction: node.direction,
    type: "split",
    ...(node.weight !== undefined ? { weight: node.weight } : {}),
  };
}

function managedLayoutToSummary(node: ManagedLayoutNode | null): SurfAceTopologySummaryNode | null {
  if (!node) {
    return null;
  }
  if (node.type === "pane") {
    return {
      paneId: node.paneId,
      type: "pane",
      ...(node.weight !== undefined ? { weight: node.weight } : {}),
    };
  }
  return {
    children: node.children.map((child) => managedLayoutToSummary(child)!),
    direction: node.direction,
    type: "split",
    ...(node.weight !== undefined ? { weight: node.weight } : {}),
  };
}

function managedLayoutFromSummary(node: SurfAceTopologySummaryNode | null): ManagedLayoutNode | null {
  if (!node) {
    return null;
  }
  if (node.type === "pane") {
    return {
      paneId: node.paneId,
      type: "pane",
      ...(node.weight !== undefined ? { weight: node.weight } : {}),
    };
  }
  return {
    children: node.children.map((child) => managedLayoutFromSummary(child)).filter((child): child is ManagedLayoutNode => child !== null),
    direction: node.direction,
    type: "split",
    ...(node.weight !== undefined ? { weight: node.weight } : {}),
  };
}

function replacePaneInManagedLayout(
  node: ManagedLayoutNode,
  paneId: PaneId,
  replacement: ManagedLayoutNode,
): { found: boolean; layout: ManagedLayoutNode } {
  if (node.type === "pane") {
    if (node.paneId !== paneId) {
      return { found: false, layout: node };
    }
    return { found: true, layout: replacement };
  }
  let found = false;
  const children = node.children.map((child) => {
    const result = replacePaneInManagedLayout(child, paneId, replacement);
    found ||= result.found;
    return result.layout;
  });
  return {
    found,
    layout: {
      ...node,
      children,
    },
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

function cloneCurrentContentSnapshot(
  snapshot: CachedSnapshot | null,
  activeContentId: ContentId | null,
  contentValue: ContentSetRequest["payload"]["content"] | null,
): SurfAceReadResult["contentSnapshot"] {
  if (!snapshot || !activeContentId || snapshot.contentId !== activeContentId) {
    return null;
  }
  const content = contentValue === null ? undefined : structuredClone(contentValue);
  const cloned = content === undefined
    ? structuredClone(snapshot)
    : {
        ...structuredClone(snapshot),
        content,
      };
  if (
    cloned.contentType === "image" &&
    !cloned.image &&
    content !== undefined &&
    typeof content === "object" &&
    content !== null &&
    "data" in content &&
    typeof (content as { data?: unknown }).data === "string"
  ) {
    cloned.image = (content as { data: string }).data;
  }
  return cloned;
}

function currentBrowserUrlSemanticEvidence(surface: ManagedSurface, pane: ManagedPane): SurfAceBrowserUrlSemanticEvidence | null {
  if (!pane.currentTargetId) {
    return null;
  }
  const target = surface.targetRecords.get(pane.currentTargetId);
  if (!target || target.currentState !== "current" || target.targetKind !== "browser_url") {
    return null;
  }
  if (!isPlainRecord(target.targetPayload) || typeof target.targetPayload.url !== "string") {
    return null;
  }
  const evidence = target.lastApplyEvidence;
  if (!evidence || evidence.status !== "applied") {
    return null;
  }
  if (!isPlainRecord(evidence.materializedState)) {
    return null;
  }
  const materializedState = evidence.materializedState as Record<string, unknown>;
  if (
    materializedState.navigationStatus !== "loaded" ||
    materializedState.replaySemantics !== "navigate" ||
    typeof materializedState.url !== "string" ||
    materializedState.url !== target.targetPayload.url
  ) {
    return null;
  }
  return {
    appliedAt: evidence.appliedAt,
    navigationStatus: "loaded",
    paneLineageId: target.paneLineageId,
    replaySemantics: "navigate",
    requestId: evidence.requestId,
    targetEpoch: target.targetEpoch,
    targetId: target.targetId,
    url: materializedState.url,
  };
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

function restoredDrawingsFromFrame(frame: SurfAceFrame | null): Stroke[] | undefined {
  if (!frame || frame.strokes.length === 0) {
    return undefined;
  }
  return frame.strokes.map((stroke) => ({
    points: stroke.points.map((point, index) => ({
      pressure: point.pressure,
      timestamp: (index === 0 ? stroke.startedAt : index === stroke.points.length - 1 ? stroke.endedAt : frame.updatedAt) as EpochMs,
      x: point.x,
      y: point.y,
    })),
    strokeId: stroke.strokeId as StrokeId,
    tool: "pencil",
  }));
}

function ensureDirectory(dirPath: string): Promise<void> {
  return fs.mkdir(dirPath, { recursive: true }).then(() => undefined);
}

function historyOwnerTokenForSession(sessionKey?: string): string {
  const hash = createHash("sha256");
  hash.update(sessionKey ?? "anonymous");
  return `hot_${hash.digest("hex").slice(0, 16)}`;
}

function cleanProvenanceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function mergeProvenance(
  base: Partial<PusherProvenance>,
  next: unknown,
): Partial<PusherProvenance> {
  if (!next || typeof next !== "object") {
    return base;
  }
  const record = next as Record<string, unknown>;
  return {
    agentId: cleanProvenanceString(record.agentId) ?? base.agentId,
    displayName: cleanProvenanceString(record.displayName) ?? base.displayName,
    pushedAt: cleanProvenanceString(record.pushedAt) ?? base.pushedAt,
    sessionKey: cleanProvenanceString(record.sessionKey) ?? base.sessionKey,
    source: cleanProvenanceString(record.source) ?? base.source,
    streamLabel: cleanProvenanceString(record.streamLabel) ?? base.streamLabel,
  };
}

function pusherProvenanceFromContext(context?: SurfAceSessionContext): PusherProvenance | null {
  if (!context) {
    return null;
  }
  const contextSessionKey = cleanProvenanceString(context.sessionKey);
  let provenance: Partial<PusherProvenance> = contextSessionKey ? {} : mergeProvenance({}, context.pushedBy);
  provenance = mergeProvenance(provenance, context.sourceProvenance);
  provenance = mergeProvenance(provenance, context.provenance);
  if (typeof context.source === "object") {
    provenance = mergeProvenance(provenance, context.source);
  } else {
    provenance.source = cleanProvenanceString(context.source) ?? provenance.source;
  }
  provenance.agentId = cleanProvenanceString(context.agentId) ?? provenance.agentId;
  provenance.pushedAt = cleanProvenanceString(context.pushedAt) ?? provenance.pushedAt;
  provenance.sessionKey = contextSessionKey ?? provenance.sessionKey;
  provenance.streamLabel = cleanProvenanceString(context.streamLabel) ?? provenance.streamLabel;
  provenance.displayName = cleanProvenanceString(context.sessionDisplayName) ?? provenance.displayName;

  const cleaned = Object.fromEntries(
    Object.entries(provenance).filter((entry): entry is [keyof PusherProvenance, string] =>
      typeof entry[1] === "string" && entry[1].length > 0
    ),
  ) as PusherProvenance;
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

function displayTitleFromProvenance(provenance: PusherProvenance | null): string | null {
  return provenance?.displayName ?? provenance?.streamLabel ?? null;
}

function displayForPusherProvenance(context?: SurfAceSessionContext): ContentDisplay | undefined {
  const provenance = pusherProvenanceFromContext(context);
  const senderDisplayName = cleanProvenanceString(context?.sessionDisplayName) ?? displayTitleFromProvenance(provenance);
  if (!provenance && !senderDisplayName) {
    return undefined;
  }
  return {
    ...(senderDisplayName ? { senderDisplayName } : {}),
    ...(provenance ? { provenance } : {}),
  };
}

function pusherSessionKeyFromDisplay(display: ContentDisplay | null | undefined): string | null {
  return cleanProvenanceString(display?.provenance?.sessionKey) ?? null;
}

function visibleContentProvenance(pane: ManagedPane): SurfAceVisibleContentProvenance | null {
  if (!pane.activeContentId) {
    return null;
  }
  const provenance = pane.display?.provenance;
  const sessionKey = pusherSessionKeyFromDisplay(pane.display) ?? pane.ownerSessionKey ?? null;
  const displayName = cleanProvenanceString(provenance?.displayName) ??
    cleanProvenanceString(provenance?.streamLabel) ??
    (pusherSessionKeyFromDisplay(pane.display) ? undefined : cleanProvenanceString(pane.display?.senderDisplayName));
  const visible: SurfAceVisibleContentProvenance = {
    ...(cleanProvenanceString(provenance?.agentId) ? { agentId: cleanProvenanceString(provenance?.agentId) } : {}),
    ...(displayName ? { displayName } : {}),
    ...(cleanProvenanceString(provenance?.pushedAt) ? { pushedAt: cleanProvenanceString(provenance?.pushedAt) } : {}),
    sessionKey,
    ...(cleanProvenanceString(provenance?.source) ? { source: cleanProvenanceString(provenance?.source) } : {}),
    ...(cleanProvenanceString(provenance?.streamLabel) ? { streamLabel: cleanProvenanceString(provenance?.streamLabel) } : {}),
  };
  return sessionKey || Object.keys(visible).some((key) => key !== "sessionKey") ? visible : null;
}

function pusherSessionKeyFromContext(context?: SurfAceSessionContext): string | undefined {
  return pusherProvenanceFromContext(context)?.sessionKey;
}

function sameHistorySessionKey(left: string | null, right: string | null): boolean {
  return left === right;
}

function isErrorResponse(response: Response): response is ErrorResponse {
  return (response as ErrorResponse).ok === false;
}

function staleRevisionExpectedRevision(response: Response): Revision | null {
  if (!isErrorResponse(response) || response.error.code !== "stale_revision") {
    return null;
  }
  const expectedRevision = response.error.details?.expectedRevision;
  if (Number.isInteger(expectedRevision) && Number(expectedRevision) >= 0) {
    return asRevision(Number(expectedRevision));
  }
  const match = /Expected revision >=\s*(\d+)/.exec(response.error.message);
  if (!match) {
    return null;
  }
  return asRevision(Number(match[1]));
}

function mutationRenderStatus(response: Response): string | null {
  if (isErrorResponse(response)) {
    return null;
  }
  const render = ((response as { payload?: { render?: unknown } }).payload)?.render;
  if (!render || typeof render !== "object") {
    return null;
  }
  const status = (render as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
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

function isForeignOwnershipLockResponse(response: Response): boolean {
  return (
    isErrorResponse(response) &&
    response.error.code === "busy" &&
    response.error.message.toLowerCase().includes("another provider")
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

function denormalizeContent(
  contentType: ContentType,
  content: ContentSetRequest["payload"]["content"],
): unknown {
  if (
    contentType === "markdown" &&
    typeof content === "object" &&
    content !== null &&
    "markdown" in content &&
    typeof (content as { markdown?: unknown }).markdown === "string"
  ) {
    return (content as { markdown: string }).markdown;
  }
  if (
    contentType === "html" &&
    typeof content === "object" &&
    content !== null &&
    "html" in content &&
    typeof (content as { html?: unknown }).html === "string"
  ) {
    return (content as { html: string }).html;
  }
  return structuredClone(content);
}

const MAX_SYNTHETIC_VISIBLE_TEXT_BYTES = 4096;

function clampSyntheticVisibleText(text: string): string {
  return text.slice(0, MAX_SYNTHETIC_VISIBLE_TEXT_BYTES);
}

function viewportSnapshotFromSurfaceViewport(viewport: SurfaceViewport): Viewport {
  const width = Math.max(0, Math.floor(viewport.width));
  const height = Math.max(0, Math.floor(viewport.height));
  return {
    contentSize: { height, width },
    scrollOffset: { x: 0, y: 0 },
    visibleRect: { height, width, x: 0, y: 0 },
    zoomLevel: 1,
  };
}

function visibleTextFromContent(
  contentType: ContentType,
  content: ContentSetRequest["payload"]["content"],
  fallback: string | undefined,
): string {
  if (
    contentType === "markdown" &&
    typeof content === "object" &&
    content !== null &&
    "markdown" in content &&
    typeof (content as { markdown?: unknown }).markdown === "string"
  ) {
    return clampSyntheticVisibleText((content as { markdown: string }).markdown);
  }
  if (
    contentType === "terminal" &&
    typeof content === "object" &&
    content !== null &&
    "lines" in content &&
    Array.isArray((content as { lines?: unknown }).lines)
  ) {
    return clampSyntheticVisibleText(((content as { lines: unknown[] }).lines).map((line) => String(line)).join("\n"));
  }
  if (
    contentType === "html" &&
    typeof content === "object" &&
    content !== null &&
    "html" in content &&
    typeof (content as { html?: unknown }).html === "string"
  ) {
    return fallback ?? "";
  }
  return fallback ?? "";
}

function isBrowserUrlPushInput(input: SurfAcePushInput): input is SurfAceBrowserUrlPushInput {
  return input.contentType === "browser_url";
}

function isContentPushInput(input: SurfAcePushInput): input is SurfAceContentPushInput {
  return input.contentType !== "browser_url";
}

function defaultRestorePolicyForTarget(
  targetKind: TargetKind,
  targetHeader: TargetHeader,
): RestorePolicy {
  if (targetHeader.safetyClass === "privileged") {
    return "manual";
  }
  switch (targetKind) {
    case "html":
    case "markdown":
    case "image":
    case "web_snapshot":
      return "auto";
    case "browser_url":
      return "auto";
    case "terminal_app":
    case "native_app":
    case "compositor_app":
      return "confirm";
    case "video":
      return "never";
  }
}

function requiredCapabilityForTargetKind(targetKind: TargetKind): string {
  return `target.${targetKind}.v1`;
}

function isProcessBackedTargetKind(targetKind: TargetKind): boolean {
  return targetKind === "terminal_app" || targetKind === "native_app" || targetKind === "compositor_app";
}

function processTargetAllowsResumeRestart(target: PaneTargetRecord): boolean {
  if (!isProcessBackedTargetKind(target.targetKind)) {
    return false;
  }
  if (!isPlainRecord(target.targetPayload) || target.targetPayload.restartPolicy !== "restore_new_process") {
    return false;
  }
  return target.lastSuccessfulApplyEvidence?.status === "applied" || target.lastApplyEvidence?.status === "applied";
}

function contentTargetKind(contentType: ContentType): TargetKind | null {
  switch (contentType) {
    case "html":
    case "markdown":
    case "image":
      return contentType;
    default:
      return null;
  }
}

function passiveContentTargetHeader(
  contentType: ContentType,
  content: ContentSetRequest["payload"]["content"],
): TargetHeader | null {
  const targetKind = contentTargetKind(contentType);
  if (!targetKind) {
    return null;
  }
  const summary = (() => {
    if (targetKind === "html" && typeof content === "object" && content && "html" in content) {
      return String(content.html).slice(0, 80);
    }
    if (targetKind === "markdown" && typeof content === "object" && content && "markdown" in content) {
      return String(content.markdown).slice(0, 80);
    }
    if (targetKind === "image") {
      return "image";
    }
    return targetKind;
  })();
  return {
    payloadSchemaVersion: 1,
    replaySemantics: "bytes",
    requiredCapabilities: [requiredCapabilityForTargetKind(targetKind)],
    safeToLogFields: [],
    safetyClass: "passive",
    summary,
  };
}

function contentPayloadForTarget(
  targetKind: TargetKind,
  targetPayload: unknown,
): { content: ContentSetRequest["payload"]["content"]; contentType: ContentType } | null {
  if (targetKind === "html" && typeof targetPayload === "object" && targetPayload && "html" in targetPayload) {
    return {
      content: structuredClone(targetPayload) as ContentSetRequest["payload"]["content"],
      contentType: "html",
    };
  }
  if (targetKind === "markdown" && typeof targetPayload === "object" && targetPayload && "markdown" in targetPayload) {
    return {
      content: structuredClone(targetPayload) as ContentSetRequest["payload"]["content"],
      contentType: "markdown",
    };
  }
  if (targetKind === "image" && typeof targetPayload === "object" && targetPayload && "data" in targetPayload) {
    return {
      content: structuredClone(targetPayload) as ContentSetRequest["payload"]["content"],
      contentType: "image",
    };
  }
  if (targetKind === "web_snapshot" && typeof targetPayload === "object" && targetPayload && "html" in targetPayload) {
    const payload = targetPayload as { baseUrl?: string; html: string };
    return {
      content: {
        baseUrl: payload.baseUrl,
        html: payload.html,
      },
      contentType: "html",
    };
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function stringArraysEqual(left: string[] | undefined, right: string[]): boolean {
  return Boolean(left) && left!.length === right.length && left!.every((entry, index) => entry === right[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSupportedTargetKind(value: unknown): value is TargetKind {
  return value === "html" ||
    value === "markdown" ||
    value === "image" ||
    value === "web_snapshot" ||
    value === "browser_url" ||
    value === "terminal_app" ||
    value === "native_app" ||
    value === "compositor_app" ||
    value === "video";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function validateTargetHeader(targetKind: TargetKind, targetHeader: TargetHeader): TargetErrorCode | null {
  if (!isSupportedTargetKind(targetKind)) {
    return "unsupported_target_kind";
  }
  if (
    !isPlainRecord(targetHeader) ||
    typeof targetHeader.summary !== "string" ||
    !isStringArray(targetHeader.requiredCapabilities) ||
    !isStringArray(targetHeader.safeToLogFields) ||
    typeof targetHeader.payloadSchemaVersion !== "number" ||
    !["passive", "network", "process", "privileged"].includes(String(targetHeader.safetyClass)) ||
    !["bytes", "navigate", "launch_equivalent", "attach"].includes(String(targetHeader.replaySemantics))
  ) {
    return "unsafe_payload";
  }
  if (targetKind === "video") {
    return "unsupported_target_kind";
  }
  if (!targetHeader.requiredCapabilities.includes(requiredCapabilityForTargetKind(targetKind))) {
    return "capability_missing";
  }
  if (targetHeader.payloadSchemaVersion !== 1) {
    return "unsupported_target_kind";
  }
  return null;
}

function validateTargetPayload(targetKind: TargetKind, targetPayload: unknown): TargetErrorCode | null {
  if (!isPlainRecord(targetPayload)) {
    return "unsafe_payload";
  }
  switch (targetKind) {
    case "html":
      return hasOnlyKeys(targetPayload, ["html", "baseUrl"]) &&
        typeof targetPayload.html === "string" &&
        (targetPayload.baseUrl === undefined || typeof targetPayload.baseUrl === "string")
        ? null
        : "unsafe_payload";
    case "markdown":
      return hasOnlyKeys(targetPayload, ["markdown"]) && typeof targetPayload.markdown === "string" ? null : "unsafe_payload";
    case "image":
      return hasOnlyKeys(targetPayload, ["data", "mediaType", "alt"]) &&
        typeof targetPayload.data === "string" &&
        typeof targetPayload.mediaType === "string" &&
        (targetPayload.alt === undefined || typeof targetPayload.alt === "string")
        ? null
        : "unsafe_payload";
    case "web_snapshot":
      return hasOnlyKeys(targetPayload, ["html", "sourceUrl", "fetchedAt", "baseUrl"]) &&
        typeof targetPayload.html === "string" &&
        typeof targetPayload.sourceUrl === "string" &&
        typeof targetPayload.fetchedAt === "string" &&
        (targetPayload.baseUrl === undefined || typeof targetPayload.baseUrl === "string")
        ? null
        : "unsafe_payload";
    case "browser_url":
      return hasOnlyKeys(targetPayload, ["url", "allowedSnapshotFallback", "fallbackSnapshotTargetId"]) &&
        typeof targetPayload.url === "string" &&
        (targetPayload.allowedSnapshotFallback === undefined || typeof targetPayload.allowedSnapshotFallback === "boolean") &&
        (targetPayload.fallbackSnapshotTargetId === undefined || typeof targetPayload.fallbackSnapshotTargetId === "string")
        ? null
        : "unsafe_payload";
    case "terminal_app":
      return hasOnlyKeys(targetPayload, ["command", "args", "cwd", "envPolicy", "env", "pty", "restartPolicy", "approvalTokenId"]) &&
        typeof targetPayload.command === "string" &&
        isStringArray(targetPayload.args) &&
        (targetPayload.cwd === undefined || targetPayload.cwd === null || typeof targetPayload.cwd === "string") &&
        (targetPayload.envPolicy === "surface_default" || targetPayload.envPolicy === "explicit_allowlist") &&
        (targetPayload.env === undefined || isStringRecord(targetPayload.env)) &&
        targetPayload.pty === true &&
        (targetPayload.restartPolicy === "restore_new_process" || targetPayload.restartPolicy === "manual_only") &&
        (targetPayload.approvalTokenId === undefined || typeof targetPayload.approvalTokenId === "string")
        ? null
        : "unsafe_payload";
    case "native_app":
      return hasOnlyKeys(targetPayload, ["appId", "args", "cwd", "env", "launchMode", "approvalTokenId", "clientOptions"]) &&
        typeof targetPayload.appId === "string" &&
        (targetPayload.args === undefined || isStringArray(targetPayload.args)) &&
        (targetPayload.cwd === undefined || targetPayload.cwd === null || typeof targetPayload.cwd === "string") &&
        (targetPayload.env === undefined || isStringRecord(targetPayload.env)) &&
        (targetPayload.launchMode === "new_instance" || targetPayload.launchMode === "attach_or_launch") &&
        (targetPayload.approvalTokenId === undefined || typeof targetPayload.approvalTokenId === "string") &&
        (targetPayload.clientOptions === undefined || (
          isPlainRecord(targetPayload.clientOptions) &&
          !containsNativeGeometrySeamField(targetPayload.clientOptions)
        ))
        ? null
        : "unsafe_payload";
    case "compositor_app":
      return hasOnlyKeys(targetPayload, ["compositorAppId", "hostRuntime", "launchSpec", "approvalTokenId"]) &&
        typeof targetPayload.compositorAppId === "string" &&
        typeof targetPayload.hostRuntime === "string" &&
        isPlainRecord(targetPayload.launchSpec) &&
        !containsNativeGeometrySeamField(targetPayload.launchSpec) &&
        (targetPayload.approvalTokenId === undefined || typeof targetPayload.approvalTokenId === "string")
        ? null
        : "unsafe_payload";
    case "video":
      return "unsupported_target_kind";
  }
  return "unsupported_target_kind";
}

const nativeGeometrySeamFieldNames = new Set([
  "coordinateSpace",
  "geometryRevision",
  "h",
  "hostRequest",
  "hostResponse",
  "materialization",
  "overlayRequest",
  "overlayResponse",
  "paneInstanceId",
  "preflightStatus",
  "preflightStatusSummary",
  "surfaceEpoch",
  "topologyEpoch",
  "w",
  "width",
  "height",
  "x",
  "y",
]);

function containsNativeGeometrySeamField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsNativeGeometrySeamField(item));
  }
  if (!isPlainRecord(value)) {
    return false;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (nativeGeometrySeamFieldNames.has(key) || containsNativeGeometrySeamField(nested)) {
      return true;
    }
  }
  return false;
}

function validatePaneTargetInput(targetKind: TargetKind, targetHeader: TargetHeader, targetPayload: unknown): TargetErrorCode | null {
  return validateTargetHeader(targetKind, targetHeader) ?? validateTargetPayload(targetKind, targetPayload);
}

const targetErrorCodes = new Set<TargetErrorCode>([
  "capability_missing",
  "policy_denied",
  "approval_required",
  "unsafe_payload",
  "ownership_epoch_mismatch",
  "ownership_session_mismatch",
  "pane_lineage_missing",
  "pane_lineage_ambiguous",
  "target_epoch_stale",
  "target_superseded",
  "registration_late_old_epoch",
  "registration_duplicate",
  "registration_failed",
  "materialization_failed",
  "unsupported_target_kind",
  "restore_blocked_stale_target",
  "restore_unregistered_local_target",
  "restore_requires_confirmation",
]);

function targetErrorCodeFromResponse(errorCode: string): TargetErrorCode {
  return targetErrorCodes.has(errorCode as TargetErrorCode)
    ? errorCode as TargetErrorCode
    : "materialization_failed";
}

function isNativeHostTargetKind(targetKind: string | undefined): boolean {
  return targetKind === "native_app" || targetKind === "terminal_app";
}

function isTransientTargetAuthorityErrorCode(errorCode: TargetErrorCode | undefined): boolean {
  return errorCode === "ownership_epoch_mismatch" ||
    errorCode === "ownership_session_mismatch" ||
    errorCode === "pane_lineage_missing" ||
    errorCode === "pane_lineage_ambiguous" ||
    errorCode === "restore_blocked_stale_target";
}

function isTargetSessionAuthorityMismatch(errorCode: TargetErrorCode | undefined): boolean {
  return errorCode === "ownership_epoch_mismatch" ||
    errorCode === "ownership_session_mismatch";
}

function safeDiagnosticTargetPayload(
  targetPayload: unknown,
  safeToLogFields: string[],
): Record<string, unknown> | null {
  if (
    safeToLogFields.length === 0 ||
    typeof targetPayload !== "object" ||
    targetPayload === null ||
    Array.isArray(targetPayload)
  ) {
    return null;
  }
  const payload = targetPayload as Record<string, unknown>;
  const safePayload: Record<string, unknown> = {};
  for (const field of safeToLogFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      safePayload[field] = structuredClone(payload[field]);
    }
  }
  return Object.keys(safePayload).length > 0 ? safePayload : null;
}

function stableStringMapDigest(value: Record<string, string> | undefined): string {
  const stableValue = JSON.stringify(
    Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right))),
  );
  return createHash("sha256").update(stableValue).digest("hex");
}

function optionalStringFingerprint(value: string | null | undefined): string {
  return value === undefined ? "<undefined>" : JSON.stringify(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nextReconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BACKOFF_CAP_MS, RECONNECT_BACKOFF_BASE_MS * 2 ** attempt);
}

function endpointProbeKey(endpoint: SurfAceDiscoveryEndpoint): string {
  const fingerprintPrefix = endpoint.fingerprintPrefix.trim();
  if (fingerprintPrefix.length > 0) {
    return `fp:${fingerprintPrefix}`;
  }
  return `ws:${buildWsUrl(endpoint)}`;
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

function isProviderWindowLabel(windowLabel: unknown): windowLabel is string {
  return typeof windowLabel === "string" && /^[a-z]+$/.test(windowLabel);
}

function firstAvailablePaneLabel(usedPaneLabels: ReadonlySet<number>, start = 1): number {
  const firstCandidate = Math.max(1, Math.trunc(start));
  const upperBound = firstCandidate + usedPaneLabels.size;
  for (let paneLabel = firstCandidate; paneLabel <= upperBound; paneLabel += 1) {
    if (!usedPaneLabels.has(paneLabel)) {
      return paneLabel;
    }
  }
  return upperBound + 1;
}

function paneLabelStorageKey(surfaceId: string, remotePaneId: RemotePaneId): string {
  return `${surfaceId}::${Number(remotePaneId)}`;
}

function surfaceIdFromPaneLabelStorageKey(key: string): string | null {
  const delimiter = key.indexOf("::");
  return delimiter > 0 ? key.slice(0, delimiter) : null;
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
  private readonly legacyStateDir: string;
  private readonly logger: SurfAceLogger;
  private readonly now: () => number;
  private readonly providerIdentityPath: string;
  private readonly providerProcessHealth: (expectedProviderPid?: number | null) => SurfAceProviderProcessHealth;
  private readonly providerName: string;
  private readonly ownershipRecoveryPolicy = new SurfAceOwnershipRecoveryPolicy();
  private readonly stateRepository: SurfAceStateRepository<RuntimeStateFile>;
  private readonly stateDir: string;
  private readonly warnLegacyStateRoot: boolean;
  private readonly surfaces = new Map<string, ManagedSurface>();
  private readonly endpointProbes = new Map<string, EndpointProbe>();
  private readonly tombstonedEndpointIds = new Set<string>();
  private readonly tombstonedSurfaceIds = new Set<SurfaceId>();
  private readonly livePairedSelfRediscoveredSurfaceIds = new Set<string>();
  private readonly startupImportedOwnershipSurfaceIds = new Set<string>();
  private readonly pendingGuardTopologyPublishSurfaceIds = new Set<string>();
  private lastDiscoveryUpdateLogAt = 0;
  private lastDiscoveryUpdateLogKey = "";
  private persistentState: RuntimeStateFile = {
    nextRemotePaneId: 1,
    nextPaneLabel: 1,
    nextWindowLabelIndex: 0,
    paneLabelsByPaneId: {},
    providerId: "",
    providerLineage: [],
    selfOwnedSurfaceIds: {},
    surfaceTombstones: {},
    targetLifecycleEventsBySurfaceId: {},
    targetStateBySurfaceId: {},
    tombstonedEndpointIds: [],
    version: 1,
    windowLabels: {},
  };
  private started = false;
  private startPromise: Promise<void> | null = null;
  private stateWrite: Promise<void> = Promise.resolve();
  private unsubscribeDiscovery: (() => void) | null = null;
  private runtimeLease: FileHandle | null = null;
  private runtimeLeaseStartedAt: number | null = null;
  private leaseHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private ownsRuntimeLease = false;
  private ownerControlPort: number | null = null;
  private ownerControlServer: Server | null = null;
  private screenSnapshotPersist: Promise<void> = Promise.resolve();
  private screenSnapshotWrite: Promise<void> = Promise.resolve();
  private lastPersistedContentContinuity = new Map<string, PersistedRestartContentEntry[]>();
  private preserveEmptyScreenSnapshotOnce = false;
  private restartContentBySurface = new Map<string, PersistedRestartContentEntry[]>();
  private restartTopologyRestoredSurfaceIds = new Set<string>();
  private restartSnapshots = new Map<string, SurfAceScreenSummary>();
  private persistedRuntimeScreenIds = new Set<string>();
  private resumeTargetMaterializationInFlight = new Map<string, Promise<ApplyEvidence>>();
  private resumeTargetMaterializationRetryDelaysMs: readonly number[] =
    RESUME_TARGET_MATERIALIZATION_RETRY_DELAYS_MS;

  constructor(options: SurfAceRuntimeOptions = {}) {
    this.deliverSettledAnnotationTurn = options.deliverSettledAnnotationTurn;
    this.discovery = options.discovery ?? createBonjourSurfAceDiscoveryService({ logger: options.logger });
    this.drawingFlushConfig = options.drawingFlushConfig ?? DEFAULT_DRAWING_FLUSH_CONFIG;
    this.eventProfile = options.eventProfile ?? "minimum_deep";
    this.legacyStateDir = options.legacyStateDir ?? legacySurfAceStateDir();
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => Date.now());
    this.providerProcessHealth = options.providerProcessHealth ?? defaultProviderProcessHealth;
    this.providerIdentityPath = path.join(
      options.stateDir ?? path.dirname(resolveDefaultProviderIdentityPath()),
      PROVIDER_IDENTITY_FILE_NAME,
    );
    this.providerName = options.providerName ?? "CLU / Surf Ace";
    this.stateDir = options.stateDir ?? resolveDefaultSurfAceStateDir(options.openClawStateDir);
    this.stateRepository = new SurfAceStateRepository<RuntimeStateFile>(this.stateDir, STATE_FILE_NAME);
    this.warnLegacyStateRoot = !options.stateDir && !options.legacyStateDir;
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
      await this.warnIfLegacyStateRootExists();
      await this.loadState();
      this.logger.info?.(
        runtimeDiagnostic("startup_state_dir", {
          provider_id: this.persistentState.providerId,
          state_dir: this.stateDir,
        }),
      );
      this.ownsRuntimeLease = await this.acquireRuntimeLease();
      if (this.ownsRuntimeLease) {
        await this.loadDurableProviderLineage();
        await this.reconcilePersistedSelfOwnedSurfacesBeforeDiscovery();
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
      for (const probe of this.endpointProbes.values()) {
        if (probe.reconcileWorkPromise) {
          this.logger.info?.(
            `[surf-ace:runtime] start() — clearing stale probe reconcileWorkPromise for ${probe.endpointId}`,
          );
          probe.reconcileWorkPromise = null;
        }
        if (probe.workPromise) {
          this.logger.info?.(
            `[surf-ace:runtime] start() — clearing stale probe workPromise for ${probe.endpointId}`,
          );
          probe.workPromise = null;
          probe.stopRequested = false;
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
      this.logger.info?.(`[surf-ace:runtime] start() — complete, ${this.surfaces.size} canonical surface(s), ${this.endpointProbes.size} endpoint probe(s)`);
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
    this.captureProviderShutdownSnapshots();

    const stopPromises = [...this.surfaces.values()].map(async (surface) => {
      surface.stopRequested = true;
      this.stopHeartbeat(surface);
      this.wakeSurfaceRetry(surface);
      if (typeof surface.client?.close === "function") {
        await surface.client.close(1000, clampCloseReason("provider_shutdown"));
      }
      await surface.workPromise;
    });
    stopPromises.push(...[...this.endpointProbes.values()].map(async (probe) => {
      probe.stopRequested = true;
      this.wakeEndpointProbeRetry(probe);
      if (typeof probe.client?.close === "function") {
        await probe.client.close(1000, clampCloseReason("provider_shutdown"));
      }
      await probe.reconcileWorkPromise;
      await probe.workPromise;
    }));

    await Promise.all(stopPromises);
    this.surfaces.clear();
    this.endpointProbes.clear();
    this.preserveEmptyScreenSnapshotOnce = true;
    await this.persistScreenSnapshot();
    await this.stateWrite;
    await this.screenSnapshotWrite;
    await this.releaseRuntimeLease();
  }

  private captureProviderShutdownSnapshots(): void {
    for (const surface of this.canonicalVisibleSurfaces()) {
      if (!this.hasAcceptedSurfaceTopology(surface)) {
        continue;
      }
      const screen = this.buildScreenSummary(surface);
      if (!this.hasTrustedPersistedSelfOwnership(screen)) {
        continue;
      }
      this.restartSnapshots.set(surface.surfaceId, structuredClone(screen));
      const restartContent = this.captureRestartContentEntries(surface);
      if (restartContent.length > 0) {
        this.restartContentBySurface.set(surface.surfaceId, structuredClone(restartContent));
      }
    }
  }

  subscribe(listener: (event: SurfAceLocalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async listScreens(): Promise<SurfAceScreenSummary[]> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.loadPersistedScreenSnapshot();
    }
    const discoverySnapshot = this.discovery.getSnapshot();
    this.logger.info?.(
      `[surf-ace:runtime] listScreens: ${this.surfaces.size} canonical surface(s), ${this.endpointProbes.size} endpoint probe(s), ${discoverySnapshot.length} discovery endpoint(s): ${discoverySnapshot.map((ep) => `${ep.name}@${ep.endpointId}`).join(", ") || "(none)"}`,
    );
    for (const surface of this.surfaces.values()) {
      if (this.needsNativeWindowProjectionRefresh(surface)) {
        await this.syncRemotePaneList(surface);
      }
      await this.reconcileProviderPaneAuthorityForSurface(surface, "list screens");
    }
    return this.buildScreenSummaries();
  }

  async providerAuthorityDiagnostics(): Promise<SurfAceProviderAuthorityProjection> {
    if (!this.started && !this.startPromise) {
      const parsed = await this.readRuntimeStateFile(path.join(this.stateDir, STATE_FILE_NAME));
      const runtimeScreenIds = await this.readPersistedRuntimeScreenIds();
      const ownerLease = await this.readRuntimeLease();
      return this.buildProviderAuthorityProjection(
        this.runtimeStateForDiagnostics(parsed),
        runtimeScreenIds,
        "stopped",
        typeof ownerLease.pid === "number" ? ownerLease.pid : process.pid,
      );
    }
    await this.start();
    await this.refreshPersistedRuntimeScreenIds();
    const ownerLease = this.ownsRuntimeLease ? {} : await this.readRuntimeLease();
    return this.buildProviderAuthorityProjection(
      this.persistentState,
      this.persistedRuntimeScreenIds,
      undefined,
      typeof ownerLease.pid === "number" ? ownerLease.pid : process.pid,
    );
  }

  async push(
    input: SurfAcePushInput,
    context?: SurfAceSessionContext,
  ): Promise<SurfAcePushResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAcePushResult>({
        context,
        input,
        op: "push",
      });
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
    if (isBrowserUrlPushInput(input)) {
      return await this.browserUrlTargetSet(surface, input, context);
    }
    if (isContentPushInput(input)) {
      return await this.contentSet(surface, input, context);
    }
    throw new SurfAceToolError("unsupported_content_type", `Unsupported content type: ${String(input.contentType)}`);
  }

  async pushBatch(
    input: SurfAcePushBatchInput,
    context?: SurfAceSessionContext,
  ): Promise<SurfAcePushBatchResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAcePushBatchResult>({
        context,
        input,
        op: "pushBatch",
      });
    }
    if (!Array.isArray(input.pushes) || input.pushes.length === 0) {
      throw new SurfAceToolError("invalid_operation", "Batch push requires at least one pane push.");
    }

    const results = await Promise.all(input.pushes.map(async (push): Promise<SurfAcePushBatchPaneResult> => {
      try {
        return {
          ok: true,
          push,
          result: await this.push(push, context),
        };
      } catch (error) {
        return {
          errorCode: error instanceof SurfAceToolError ? error.code : "internal_error",
          message: error instanceof Error ? error.message : String(error),
          ok: false,
          push,
        };
      }
    }));
    const succeeded = results.filter((result) => result.ok).length;
    return {
      failed: results.length - succeeded,
      ok: succeeded === results.length,
      results,
      succeeded,
    };
  }

  private async launchTerminal(
    input: SurfAceLaunchTerminalInput,
    context?: SurfAceSessionContext,
  ): Promise<SurfAcePushResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAcePushResult>({
        context,
        input,
        op: "launchTerminal",
      });
    }
    if (input.confirmed !== true) {
      throw new SurfAceToolError(
        "invalid_operation",
        "Process-backed terminal targets require confirmed:true.",
      );
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
    return await this.terminalAppTargetSet(surface, input, context);
  }

  async launchNativeApp(
    input: SurfAceLaunchNativeAppInput,
    context?: SurfAceSessionContext,
  ): Promise<SurfAcePushResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAcePushResult>({
        context,
        input,
        op: "launchNativeApp",
      });
    }
    if (input.confirmed !== true) {
      throw new SurfAceToolError(
        "invalid_operation",
        "Process-backed native app targets require confirmed:true.",
      );
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
    return await this.nativeAppTargetSet(surface, input, context);
  }

  async clear(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceClearResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceClearResult>({ input, op: "clear" });
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
    return await this.contentClear(surface, input);
  }

  private async openSurfaceWindow(input: SurfAceOpenSurfaceWindowInput): Promise<SurfAceOpenSurfaceWindowResult> {
    const surface = await this.requireActionableSurface(input.fingerprint);
    const response = await this.sendRequest(
      surface,
      this.requestEnvelope("surface.window.open", {
        requestedBy: input.requestedBy,
      }),
    );
    if (isErrorResponse(response)) {
      throw new SurfAceToolError(mutationErrorCode(response.error.code), response.error.message);
    }
    if (response.op !== "surface.window.open") {
      throw new SurfAceToolError("invalid_operation", `Unexpected response for surface.window.open: ${response.op}`);
    }
    return {
      accepted: response.payload.accepted,
      fingerprint: surface.surfaceId,
      openedSurfaceId: response.payload.surfaceId,
      message: response.payload.accepted
        ? "Surf Ace surface window open request accepted."
        : "Surf Ace surface window open request was not accepted.",
      windowLabel: surface.windowLabel,
    };
  }

  private async closeSurfaceWindow(input: SurfAceOpenSurfaceWindowInput): Promise<SurfAceWindowLifecycleOperationResult> {
    const surface = await this.requireActionableSurface(input.fingerprint);
    const response = await this.sendRequest(
      surface,
      this.requestEnvelope("surface.window.close", {
        requestedBy: input.requestedBy,
      }),
    );
    if (isErrorResponse(response)) {
      throw new SurfAceToolError(mutationErrorCode(response.error.code), response.error.message);
    }
    if (response.op !== "surface.window.close") {
      throw new SurfAceToolError("invalid_operation", `Unexpected response for surface.window.close: ${response.op}`);
    }
    return {
      action: "closeWindow",
      closed: response.payload.closed,
      fingerprint: response.payload.surfaceId,
      windowLabel: surface.windowLabel,
    };
  }

  async split(input: SurfAceSplitInput): Promise<SurfAceSplitResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceSplitResult>({ input, op: "split" });
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
    return await this.paneSplit(surface, input);
  }

  async realizeTopology(input: SurfAceRealizeTopologyInput): Promise<SurfAceRealizeTopologyResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceRealizeTopologyResult>({
        input,
        op: "realizeTopology",
      });
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
    await this.reconcilePaneTopologyAuthority(surface, "topology realization");
    return await this.realizeSurfaceTopology(surface, input);
  }

  async realizeTopologies(input: SurfAceRealizeTopologiesInput): Promise<SurfAceRealizeTopologiesResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceRealizeTopologiesResult>({
        input,
        op: "realizeTopologies",
      });
    }

    const operations = input.operations;
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new SurfAceToolError("invalid_operation", "Topology realization requires at least one operation.");
    }

    const applied: Array<SurfAceRealizeTopologyOperationResult | SurfAceWindowLifecycleOperationResult> = [];
    for (const [index, operation] of operations.entries()) {
      try {
        const surface = await this.requireActionableSurface(operation.fingerprint);
        if (operation.windowLabel && surface.windowLabel !== operation.windowLabel) {
          throw new SurfAceToolError(
            "screen_not_found",
            `Surf Ace surface ${operation.fingerprint} has window label ${surface.windowLabel}, expected ${operation.windowLabel}.`,
          );
        }
        if ("action" in operation) {
          if (operation.action === "openWindow") {
            const result = await this.openSurfaceWindow(operation);
            applied.push({
              accepted: result.accepted,
              action: "openWindow",
              fingerprint: result.fingerprint,
              openedSurfaceId: result.openedSurfaceId,
              operationId: operation.operationId,
              windowLabel: result.windowLabel,
            });
            continue;
          }
          const result = await this.closeSurfaceWindow(operation);
          applied.push({
            ...result,
            operationId: operation.operationId,
          });
          continue;
        }
        await this.reconcilePaneTopologyAuthority(surface, "topology realization");
        const result = await this.realizeSurfaceTopology(surface, operation);
        applied.push({
          ...result,
          action: "realizeTopology",
          fingerprint: surface.surfaceId,
          operationId: operation.operationId,
          windowLabel: surface.windowLabel,
        });
      } catch (error) {
        const failure = error instanceof SurfAceToolError
          ? { code: error.code, message: error.message }
          : { code: "invalid_operation", message: String(error) };
        return {
          applied,
          failed: {
            ...failure,
            fingerprint: operation.fingerprint,
            index,
            operationId: operation.operationId,
            windowLabel: operation.windowLabel,
          },
          ok: false,
          skipped: operations.slice(index + 1).map((skipped, skippedOffset) => ({
            fingerprint: skipped.fingerprint,
            index: index + 1 + skippedOffset,
            operationId: skipped.operationId,
            windowLabel: skipped.windowLabel,
          })),
        };
      }
    }

    return {
      applied,
      ok: true,
    };
  }

  async closePane(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceClosePaneResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceClosePaneResult>({ input, op: "closePane" });
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
    return await this.paneClose(surface, input);
  }

  async relinquish(input: { fingerprint: string }): Promise<SurfAceRelinquishResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceRelinquishResult>({ input, op: "relinquish" });
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
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
    surface.localOwnership = null;
    surface.remotePairObservation = null;
    surface.remotePaired = false;
    surface.restartOwnershipPendingPair = false;
    surface.sessionId = null;
    surface.stopRequested = true;
    this.markSelfOwnedSurfaceRelinquished(surface.surfaceId);
    this.stopHeartbeat(surface);
    await surface.client?.close(1000, clampCloseReason("provider_shutdown")).catch(() => {});
    await this.persistState();
    this.queuePersistScreenSnapshot("ownership relinquish");
    return { relinquished: true };
  }

  async reattemptConnections(
    input: SurfAceReattemptConnectionsInput = {},
  ): Promise<SurfAceReattemptConnectionsResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceReattemptConnectionsResult>({
        input,
        op: "reattemptConnections",
      });
    }
    this.pruneStaleAcceptedSurfaces("operator reattempt connections");

    const surface = input.fingerprint ? this.surfaces.get(input.fingerprint as SurfaceId) : null;
    const surfaces = input.fingerprint
      ? surface ? [surface] : []
      : [...this.surfaces.values()];
    const reattemptedSurfaces: SurfAceReattemptConnectionsResult["surfaces"] = [];
    for (const surface of surfaces) {
      const diagnostics = this.surfaceConnectionDiagnostics(surface);
      surface.selfOwnershipReclaimAttempted = false;
      if (diagnostics.reason?.includes("invalid_resume") || diagnostics.reason?.includes("Resume session did not match")) {
        this.clearSurfaceResumeState(surface);
      }
      this.resetSurfaceConnectionCircuit(surface, "operator reattempt", { enableRetry: !surface.stopRequested });
      if (this.canRepublishAuthorityOnReattempt(surface)) {
        surface.connectionState = "connected";
        if (await this.publishAuthorityState(surface)) {
          this.startHeartbeat(surface);
        }
      }
      this.ensureSurfaceWorker(surface);
      this.wakeSurfaceRetry(surface);
      reattemptedSurfaces.push({
        circuitState: diagnostics.circuitState,
        fingerprint: surface.surfaceId,
        name: surface.name,
        windowLabel: surface.windowLabel,
      });
    }

    const reattemptedEndpointProbes: SurfAceReattemptConnectionsResult["endpointProbes"] = [];
    if (!input.fingerprint) {
      for (const probe of this.endpointProbes.values()) {
        const ownedSurfaces = this.ownedSurfacesForEndpoint(probe.endpoint);
        const openOwnedSurface = this.openAcceptedOwnedSurface(ownedSurfaces);
        if (ownedSurfaces.length > 0) {
          this.suppressEndpointProbeWorker(probe, "owned surface worker active");
          if (openOwnedSurface) {
            this.ensureOwnedEndpointSurfacesListReconcile(probe, openOwnedSurface);
          }
          continue;
        }
        const diagnostics = this.endpointProbeConnectionDiagnostics(probe);
        this.resetEndpointProbeConnectionCircuit(probe, "operator reattempt", { enableRetry: true });
        this.ensureEndpointProbeWorker(probe);
        this.wakeEndpointProbeRetry(probe);
        reattemptedEndpointProbes.push({
          circuitState: diagnostics.circuitState,
          endpointId: probe.endpointId,
          name: probe.name,
        });
      }
    }

    this.queuePersistScreenSnapshot("operator reattempt connections");
    return {
      endpointProbes: reattemptedEndpointProbes,
      surfaces: reattemptedSurfaces,
    };
  }

  async read(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceReadResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceReadResult>({ input, op: "read" });
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
    const pane = this.requirePane(input.fingerprint, input.paneId);
    await this.reconcileProviderPaneAuthority(surface, pane, "read");
    this.repairLivePaneLabelInvariant("read", surface);
    const paneLabel = this.projectedPaneLabel(surface, pane);
    const displayId = visiblePaneAddress(surface.windowLabel, paneLabel);
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
      browserUrl: currentBrowserUrlSemanticEvidence(surface, pane),
      contentSnapshot: cloneCurrentContentSnapshot(pane.snapshot, pane.activeContentId, pane.contentValue),
      displayId,
      fingerprint: input.fingerprint,
      frames: returnedFrames,
      lastNavigation: pane.buffer.lastNavigation ? { ...pane.buffer.lastNavigation } : null,
      liveDirtyStrokeIds: [...pane.buffer.liveDirtyStrokeIds],
      liveFrame: cloneFrame(pane.buffer.liveFrame),
      liveSeq: pane.buffer.liveFrame ? pane.buffer.liveSeq : null,
      overflowed: pane.buffer.overflowed,
      page: pane.buffer.page ? { ...pane.buffer.page } : null,
      paneAddress: displayId,
      paneId: pane.paneId,
      paneLabel,
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
      windowLabel: surface.windowLabel,
    };

    surface.alertFired = false;
    surface.alertFiredAt = null;
    pane.buffer.liveDirtyStrokeIds = [];
    pane.buffer.overflowed = false;
    pane.buffer.lastNavigation = null;
    pane.buffer.page = null;
    pane.buffer.scrollPosition = null;
    pane.buffer.selection = null;
    pane.buffer.taps = [];

    return result;
  }

  async capturePane(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAcePaneCaptureResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAcePaneCaptureResult>({ input, op: "capturePane" });
    }

    const surface = await this.requireActionableSurface(input.fingerprint);
    const surfaceAuthorityProof = this.authorityProofToken(surface);
    await this.reconcilePaneTopologyAuthority(surface, "capture");
    this.assertAuthorityProofUnchanged(surface, undefined, surfaceAuthorityProof, "capture");
    this.repairLivePaneLabelInvariant("capture", surface);
    const pane = this.requirePane(input.fingerprint, input.paneId);
    await this.reconcileProviderPaneAuthority(surface, pane, "capture");
    const paneAuthorityProof = this.authorityProofToken(surface, pane);
    const capturedAt = this.now();
    let payload: SnapshotResponse["payload"] | null = null;
    let failureReason: string | null = null;

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
        if (mutationErrorCode(response.error.code) === "not_connected") {
          throw new SurfAceToolError("not_connected", response.error.message);
        }
        failureReason = response.error.message;
      } else {
        payload = (response as SnapshotResponse).payload;
        this.applySnapshot(surface, pane, response as SnapshotResponse);
        if (!payload.image) {
          failureReason = "client returned no rendered image for pane capture";
        }
      }
    } catch (error) {
      if (error instanceof SurfAceToolError && error.code === "not_connected") {
        throw error;
      }
      failureReason = error instanceof Error ? error.message : String(error);
    }

    this.assertAuthorityProofUnchanged(surface, pane, paneAuthorityProof, "capture");
    const viewport = payload?.viewport ?? pane.snapshot?.viewport;
    const visibleRect = viewport?.visibleRect;
    const imageBytes = payload?.image && payload.image.length > 0 ? payload.image : null;
    const paneLabel = this.projectedPaneLabel(surface, pane);
    const displayId = visiblePaneAddress(surface.windowLabel, paneLabel);
    const preserveProviderSnapshotProjection =
      payload?.contentId === null && this.hasProviderOwnedPaneAuthority(surface, pane);
    const providerProjectedContentId: ContentId | null = pane.activeContentId ??
      (pane.snapshot?.contentId as ContentId | undefined) ??
      (pane.historySummary.visibleContentId as ContentId | null);
    const visibleContentId: ContentId | null = preserveProviderSnapshotProjection
      ? providerProjectedContentId
      : (payload?.contentId as ContentId | null | undefined) ?? pane.activeContentId;
    const contentType = preserveProviderSnapshotProjection
      ? pane.contentType ?? pane.snapshot?.contentType ?? payload?.contentType ?? null
      : payload?.contentType ?? pane.contentType;
    return {
      capture: {
        browserUrl: currentBrowserUrlSemanticEvidence(surface, pane),
        bytesBase64: imageBytes,
        capturedAt,
        contentType,
        dimensions: {
          height: visibleRect?.height ?? pane.viewport.height,
          width: visibleRect?.width ?? pane.viewport.width,
        },
        displayId,
        failureReason,
        fingerprint: input.fingerprint,
        paneAddress: displayId,
        paneId: pane.paneId,
        paneLabel,
        scale: pane.viewport.scale,
        topologyRevision: surface.topologyRevision,
        visibleContentId,
        windowLabel: surface.windowLabel,
      },
    };
  }

  async registerTarget(input: SurfAceTargetRegisterInput): Promise<SurfAceTargetRegisterResult> {
    await this.start();
    const surface = await this.requireActionableSurface(input.fingerprint);
    const pane = this.requirePane(input.fingerprint, input.paneId);
    if (
      input.ownershipSessionId !== (surface.sessionId ?? "") ||
      input.ownershipEpoch !== surface.ownershipEpoch
    ) {
      return await this.rejectTargetRegistration(
        surface,
        pane,
        input,
        "registration_late_old_epoch",
        "Target registration ownership epoch does not match current surface ownership",
      );
    }
    const duplicateTargetId = surface.registeredTargetIdsByIdempotencyKey.get(input.idempotencyKey);
    if (duplicateTargetId) {
      const duplicate = surface.targetRecords.get(duplicateTargetId);
      if (
        duplicate &&
        duplicate.currentState === "current" &&
        duplicate.ownershipEpoch === surface.ownershipEpoch &&
        duplicate.ownershipSessionId === (surface.sessionId ?? "") &&
        duplicate.paneLineageId === pane.paneLineageId &&
        pane.currentTargetId === duplicate.targetId
      ) {
        return {
          idempotencyKey: input.idempotencyKey,
          status: "registered",
          targetEpoch: duplicate.targetEpoch,
          targetId: duplicate.targetId,
        };
      }
      surface.registeredTargetIdsByIdempotencyKey.delete(input.idempotencyKey);
    }
    if (input.paneLineageId !== pane.paneLineageId) {
      return await this.rejectTargetRegistration(
        surface,
        pane,
        input,
        "pane_lineage_missing",
        "Target registration pane lineage does not match the current pane",
      );
    }
    if ([...surface.panes.values()].filter((candidate) => candidate.paneLineageId === input.paneLineageId).length !== 1) {
      return await this.rejectTargetRegistration(
        surface,
        pane,
        input,
        "pane_lineage_ambiguous",
        "Target registration pane lineage is ambiguous",
      );
    }
    const currentEpoch = pane.targetEpoch === 0 ? null : pane.targetEpoch;
    if (currentEpoch !== input.expectedPreviousTargetEpoch) {
      return await this.rejectTargetRegistration(
        surface,
        pane,
        input,
        "target_epoch_stale",
        `Expected previous target epoch ${input.expectedPreviousTargetEpoch ?? "null"}, found ${currentEpoch ?? "null"}`,
      );
    }
    const targetValidationError = validatePaneTargetInput(input.targetKind, input.targetHeader, input.targetPayload);
    if (targetValidationError) {
      return await this.rejectTargetRegistration(
        surface,
        pane,
        input,
        targetValidationError,
        `Invalid target registration for ${input.targetKind}`,
      );
    }
    if (typeof input.launchedAt !== "string" || input.launchedAt.length === 0) {
      return await this.rejectTargetRegistration(
        surface,
        pane,
        input,
        "registration_failed",
        "Target registration missing launchedAt evidence",
      );
    }

    const target = await this.createPaneTargetRecord(surface, pane, {
      appliedAt: input.launchedAt,
      deferPersist: true,
      restorePolicy: input.restorePolicy,
      targetHeader: input.targetHeader,
      targetKind: input.targetKind,
      targetPayload: input.targetPayload,
    });
    surface.registeredTargetIdsByIdempotencyKey.set(input.idempotencyKey, target.targetId);
    await this.persistSurfaceTargetStateImmediately(surface, "target registration");
    return {
      idempotencyKey: input.idempotencyKey,
      status: "registered",
      targetEpoch: target.targetEpoch,
      targetId: target.targetId,
    };
  }

  async restoreTarget(input: { confirmed?: boolean; fingerprint: string; paneId: PaneId; targetId?: string }): Promise<SurfAceTargetRestoreResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceTargetRestoreResult>({ input, op: "restoreTarget" });
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
    const pane = this.requirePane(input.fingerprint, input.paneId);
    const authority = await this.reconcileProviderPaneAuthority(surface, pane, "restore");
    const target = input.targetId
      ? surface.targetRecords.get(input.targetId) ?? null
      : authority.target;
    if (!target) {
      throw new SurfAceToolError("invalid_operation", `No target record for pane ${input.paneId}`);
    }
    const targetAuthorityRepaired = this.repairCurrentSelfTargetAuthority(surface, pane, target);
    await this.ensureCurrentPaneLineage(surface, pane);
    const targetLineageRepaired = this.repairCurrentSelfTargetAuthority(surface, pane, target);
    if (targetAuthorityRepaired || targetLineageRepaired) {
      await this.persistSurfaceTargetState(surface, "target authority repair before restore");
    }
    const blockedReason = this.restoreBlockedReason(surface, pane, target, input.confirmed === true);
    if (blockedReason) {
      pane.lastRestoreBlockedReason = blockedReason;
      await this.persistSurfaceTargetState(surface, "manual restore blocked");
      return {
        blockedReason,
        evidence: null,
        targetId: target.targetId,
      };
    }
    const evidence = await this.materializeTargetRecord(surface, pane, target, input.confirmed ? "confirmed_restore" : "manual_restore");
    return {
      blockedReason: null,
      evidence,
      targetId: target.targetId,
    };
  }

  async snapshot(input: { fingerprint: string; paneId: PaneId }): Promise<SurfAceSnapshotResult> {
    await this.start();
    if (!this.ownsRuntimeLease) {
      return await this.forwardToRuntimeOwner<SurfAceSnapshotResult>({ input, op: "snapshot" });
    }
    const surface = await this.requireActionableSurface(input.fingerprint);
    const pane = this.requirePane(input.fingerprint, input.paneId);
    this.repairLivePaneLabelInvariant("snapshot", surface);
    const paneLabel = this.projectedPaneLabel(surface, pane);
    const displayId = visiblePaneAddress(surface.windowLabel, paneLabel);
    return {
      displayId,
      fingerprint: input.fingerprint,
      paneAddress: displayId,
      paneId: pane.paneId,
      paneLabel,
      windowLabel: surface.windowLabel,
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
    const surface = await this.requireActionableSurface(input.fingerprint);
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
    this.repairLivePaneLabelInvariant("annotations remove", surface);
    const paneLabel = this.projectedPaneLabel(surface, pane);
    const displayId = visiblePaneAddress(surface.windowLabel, paneLabel);

    return {
      displayId,
      fingerprint: input.fingerprint,
      notFoundStrokeIds: [...payload.notFoundStrokeIds],
      paneAddress: displayId,
      paneId: pane.paneId,
      paneLabel,
      remainingStrokeCount: payload.remainingStrokeCount,
      removedStrokeIds: [...payload.removedStrokeIds],
    };
  }

  private async contentClear(
    surface: ManagedSurface,
    input: { fingerprint: string; paneId: PaneId },
  ): Promise<SurfAceClearResult> {
    await this.reconcilePaneTopologyAuthority(surface, "content clear");
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    await this.ensureCurrentPaneLineage(surface, pane);
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
    return await this.applyMutationResponse(surface, pane, response, request) as SurfAceClearResult;
  }

  private async paneSplit(
    surface: ManagedSurface,
    input: SurfAceSplitInput,
  ): Promise<SurfAceSplitResult> {
    await this.reconcilePaneTopologyAuthority(surface, "pane split");
    if (input.count < 2) {
      throw new SurfAceToolError(
        "invalid_operation",
        "Surf Ace split count must be at least 2.",
      );
    }

    await this.syncRemotePaneList(surface);
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    const currentLayout = this.topologySeedLayout(surface);
    const beforePaneIds = this.visiblePanes(surface).map((managedPane) => managedPane.paneId);
    const beforeRemotePaneIds = this.visiblePanes(surface).map((managedPane) => Number(managedPane.remotePaneId));
    const direction = input.direction ?? this.defaultSplitDirection(surface, pane);
    const nextPanes = new Map(surface.panes);
    const reservedPanes: ManagedPane[] = [];
    const additionalPaneCount = input.count - 1;
    for (let index = 0; index < additionalPaneCount; index += 1) {
      const paneId = this.allocatePaneId();
      const remotePaneId = this.allocateRemotePaneId();
      const paneLabel = this.ensurePaneLabel({ ...surface, panes: nextPanes }, null, remotePaneId);
      const created = createPane(paneId, paneLabel, remotePaneId, surface.viewport);
      nextPanes.set(created.paneId, created);
      reservedPanes.push(created);
    }

    const nextLayout = splitManagedLayoutNode(
      currentLayout,
      pane.paneId,
      direction,
      [pane.paneId, ...reservedPanes.map((reservedPane) => reservedPane.paneId)],
    );

    await this.pushTopology(surface, {
      beforePaneIds,
      beforeRemotePaneIds,
      increment: true,
      nextLayout,
      nextPanes,
    });
    this.queuePersistScreenSnapshot("pane split");
    return this.visiblePanes(surface)
      .sort((left, right) => left.paneLabel - right.paneLabel || left.paneId.localeCompare(right.paneId))
      .map((managedPane) => ({
        displayId: visiblePaneAddress(surface.windowLabel, managedPane.paneLabel),
        paneAddress: visiblePaneAddress(surface.windowLabel, managedPane.paneLabel),
        paneId: managedPane.paneId,
        paneLabel: managedPane.paneLabel,
      }));
  }

  private defaultSplitDirection(
    surface: ManagedSurface,
    pane: ManagedPane,
  ): "horizontal" | "vertical" {
    const rect = paneFrameRect(pane);
    const viewport = rect ?? pane.viewport;
    return viewport.width >= viewport.height ? "vertical" : "horizontal";
  }

  private realizeDesiredTopologyNode(
    surface: ManagedSurface,
    panes: Map<PaneId, ManagedPane>,
    node: SurfAceRealizeTopologyNode,
    options: {
      createdPaneIds: PaneId[];
      desiredRoot: boolean;
      preservePaneIds: Set<PaneId>;
      targetPaneId: PaneId | null;
      targetPaneIds: Set<PaneId>;
    },
  ): ManagedLayoutNode {
    if (!node || typeof node !== "object") {
      throw new SurfAceToolError("invalid_operation", "Topology realization nodes must be objects.");
    }
    const maybeSplit = node as Extract<SurfAceRealizeTopologyNode, { children: SurfAceRealizeTopologyNode[] }>;
    if (Array.isArray(maybeSplit.children)) {
      if (maybeSplit.direction !== "horizontal" && maybeSplit.direction !== "vertical") {
        throw new SurfAceToolError("invalid_operation", "Split topology nodes require horizontal or vertical direction.");
      }
      if (maybeSplit.children.length < 2) {
        throw new SurfAceToolError("invalid_operation", "Split topology nodes require at least two children.");
      }
      return {
        children: maybeSplit.children.map((child) =>
          this.realizeDesiredTopologyNode(surface, panes, child, {
            ...options,
            desiredRoot: false,
          })
        ),
        direction: maybeSplit.direction,
        type: "split",
        ...(maybeSplit.weight !== undefined ? { weight: maybeSplit.weight } : {}),
      };
    }

    const leaf = node as Extract<SurfAceRealizeTopologyNode, { paneId?: PaneId }>;
    const requestedPaneId = leaf.paneId ?? (
      options.desiredRoot && options.targetPaneId ? options.targetPaneId : undefined
    );
    if (requestedPaneId) {
      const pane = panes.get(requestedPaneId);
      if (!pane) {
        throw new SurfAceToolError("invalid_operation", `Unknown Surf Ace pane ${requestedPaneId} on ${surface.surfaceId}`);
      }
      if (!options.targetPaneIds.has(requestedPaneId)) {
        throw new SurfAceToolError(
          "invalid_operation",
          `Topology realization cannot preserve pane ${requestedPaneId} outside the targeted subtree.`,
        );
      }
      if (options.preservePaneIds.has(requestedPaneId)) {
        throw new SurfAceToolError("invalid_operation", `Topology realization repeats pane ${requestedPaneId}.`);
      }
      if ("name" in leaf) {
        pane.name = leaf.name ?? null;
      }
      options.preservePaneIds.add(requestedPaneId);
      return {
        paneId: requestedPaneId,
        type: "pane",
        ...(leaf.weight !== undefined ? { weight: leaf.weight } : {}),
      };
    }

    const paneId = this.allocatePaneId();
    const remotePaneId = this.allocateRemotePaneId();
    const paneLabel = this.ensurePaneLabel({ ...surface, panes }, null, remotePaneId);
    const created = createPane(paneId, paneLabel, remotePaneId, surface.viewport);
    if ("name" in leaf) {
      created.name = leaf.name ?? null;
    }
    panes.set(created.paneId, created);
    options.createdPaneIds.push(created.paneId);
    return {
      paneId: created.paneId,
      type: "pane",
      ...(leaf.weight !== undefined ? { weight: leaf.weight } : {}),
    };
  }

  private async realizeSurfaceTopology(
    surface: ManagedSurface,
    input: SurfAceRealizeTopologyInput,
  ): Promise<SurfAceRealizeTopologyResult> {
    if (!Number.isInteger(input.expectedTopologyRevision) || input.expectedTopologyRevision !== surface.topologyRevision) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Topology realization expected revision ${input.expectedTopologyRevision}, current revision is ${surface.topologyRevision}.`,
      );
    }

    const currentLayout = collapseManagedLayout(surface.layout);
    const targetsRoot = "root" in input.target && input.target.root === true;
    const targetsPane = "paneId" in input.target && input.target.paneId !== undefined && input.target.paneId !== null;
    if (targetsRoot === targetsPane) {
      throw new SurfAceToolError("invalid_operation", "Topology realization target must be exactly `{ root: true }` or `{ paneId }`.");
    }
    const targetPaneId = targetsPane ? input.target.paneId! : null;
    if (targetPaneId && !surface.panes.has(targetPaneId)) {
      throw new SurfAceToolError("invalid_operation", `Unknown Surf Ace pane ${targetPaneId} on ${surface.surfaceId}`);
    }

    const currentLayoutPaneIds = flattenManagedLayout(currentLayout);
    const targetPaneIds = new Set(
      targetPaneId
        ? currentLayoutPaneIds.filter((paneId) => paneId === targetPaneId)
        : currentLayoutPaneIds.length > 0
          ? currentLayoutPaneIds
          : [...surface.panes.keys()],
    );
    if (targetPaneId && targetPaneIds.size === 0) {
      throw new SurfAceToolError("invalid_operation", `Pane ${targetPaneId} is not present in the current topology.`);
    }

    const nextPanes = new Map<PaneId, ManagedPane>(
      [...surface.panes.entries()].map(([paneId, pane]) => [paneId, structuredClone(pane)]),
    );
    const createdPaneIds: PaneId[] = [];
    const preservedPaneIds = new Set<PaneId>();
    const replacement = this.realizeDesiredTopologyNode(surface, nextPanes, input.desired, {
      createdPaneIds,
      desiredRoot: true,
      preservePaneIds: preservedPaneIds,
      targetPaneId,
      targetPaneIds,
    });
    const nextLayout = targetPaneId
      ? replacePaneInManagedLayout(currentLayout, targetPaneId, replacement)
      : { found: true, layout: replacement };
    if (!nextLayout.found) {
      throw new SurfAceToolError("invalid_operation", `Pane ${targetPaneId} is not present in the current topology.`);
    }

    const destroyedPaneIds = [...targetPaneIds].filter((paneId) => !preservedPaneIds.has(paneId));
    const allowedDestroyPaneIds = new Set(input.allowDestroyPaneIds ?? []);
    const undeclaredDestroyedPaneIds = destroyedPaneIds.filter((paneId) => !allowedDestroyPaneIds.has(paneId));
    if (undeclaredDestroyedPaneIds.length > 0) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Topology realization would destroy pane(s) ${undeclaredDestroyedPaneIds.join(", ")} without allowDestroyPaneIds.`,
      );
    }

    for (const paneId of destroyedPaneIds) {
      nextPanes.delete(paneId);
    }
    const nextLayoutPaneIds = new Set(flattenManagedLayout(collapseManagedLayout(nextLayout.layout)));
    for (const paneId of nextPanes.keys()) {
      if (!nextLayoutPaneIds.has(paneId)) {
        nextPanes.delete(paneId);
      }
    }

    const beforePaneIds = this.visiblePanes(surface).map((pane) => pane.paneId);
    const beforeRemotePaneIds = this.visiblePanes(surface).map((pane) => Number(pane.remotePaneId));
    await this.pushTopology(surface, {
      beforePaneIds,
      beforeRemotePaneIds,
      increment: true,
      nextLayout: collapseManagedLayout(nextLayout.layout),
      nextPanes,
    });

    await this.persistScreenSnapshot();
    const topology = managedLayoutToSummary(collapseManagedLayout(surface.layout))!;
    return {
      createdPaneIds,
      destroyedPaneIds,
      ok: true,
      panes: this.visiblePanes(surface).map((pane) => ({
        activeContentId: pane.activeContentId,
        contentType: pane.contentType,
        displayId: visiblePaneAddress(surface.windowLabel, pane.paneLabel),
        name: pane.name,
        paneAddress: visiblePaneAddress(surface.windowLabel, pane.paneLabel),
        paneId: pane.paneId,
        paneLabel: pane.paneLabel,
      })),
      preservedPaneIds: [...preservedPaneIds],
      target: input.target,
      topology,
      topologyRevision: surface.topologyRevision,
    };
  }

  private async paneClose(
    surface: ManagedSurface,
    input: { fingerprint: string; paneId: PaneId },
  ): Promise<SurfAceClosePaneResult> {
    await this.reconcilePaneTopologyAuthority(surface, "pane close");
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    if (this.visiblePanes(surface).length <= 1) {
      throw new SurfAceToolError(
        "invalid_operation",
        "Cannot close the last remaining pane.",
      );
    }

    const currentLayout = collapseManagedLayout(surface.layout);
    const layoutPaneIds = flattenManagedLayout(currentLayout);
    if (
      layoutPaneIds.length !== surface.panes.size ||
      layoutPaneIds.some((layoutPaneId) => !surface.panes.has(layoutPaneId)) ||
      !layoutPaneIds.includes(pane.paneId)
    ) {
      throw new SurfAceToolError(
        "invalid_operation",
        "Cannot close pane because the provider topology is ambiguous.",
      );
    }
    const nextLayoutCandidate = removePaneFromManagedLayout(currentLayout, pane.paneId);
    if (!nextLayoutCandidate && surface.panes.size > 1) {
      throw new SurfAceToolError(
        "invalid_operation",
        "Cannot close pane because the provider topology is ambiguous.",
      );
    }
    const nextLayout = collapseManagedLayout(nextLayoutCandidate);
    const nextPanes = new Map(surface.panes);
    nextPanes.delete(pane.paneId);

    await this.pushTopology(surface, { increment: true, nextLayout, nextPanes });
    await this.tombstonePaneTarget(surface, pane);
    this.repairLivePaneLabelInvariant("pane close", surface);

    await this.persistScreenSnapshot();
    const displayId = visiblePaneAddress(surface.windowLabel, pane.paneLabel);
    return {
      displayId,
      ok: true,
      paneAddress: displayId,
      paneId: pane.paneId,
      paneLabel: pane.paneLabel,
    };
  }

  private async contentSet(
    surface: ManagedSurface,
    input: SurfAceContentPushInput,
    context?: SurfAceSessionContext,
  ): Promise<SurfAcePushResult> {
    await this.reconcilePaneTopologyAuthority(surface, "content push");
    this.repairLivePaneLabelInvariant("content push", surface);
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    await this.ensureCurrentPaneLineage(surface, pane);
    this.finalizeLiveFrame(surface, pane);
    const normalizedContent = normalizeContent(input.contentType, input.content);
    const contentPreview = typeof normalizedContent === "string"
      ? normalizedContent.slice(0, 200)
      : JSON.stringify(normalizedContent).slice(0, 200);
    this.logger.info?.(
      `[surf-ace:runtime] contentSet pane=${pane.paneId}(remote=${pane.remotePaneId}) type=${input.contentType} contentPreview=${contentPreview}`,
    );

    const sessionKey = pusherSessionKeyFromContext(context);
    const display = displayForPusherProvenance(context);
    const nextContentId =
      sessionKey && pane.ownerSessionKey === sessionKey && pane.activeContentId
        ? pane.activeContentId
        : makeContentId();
    pane.pendingOwnerSessionKey = sessionKey ?? null;

    const payload = {
      content: normalizedContent,
      contentId: nextContentId,
      contentType: input.contentType,
      historyOwnerToken: historyOwnerTokenForSession(sessionKey),
      paneId: pane.remotePaneId,
      revision: asRevision((pane.currentRevision as number) + 1),
      topologyRevision: surface.topologyRevision as TopologyApplyRequest["payload"]["topologyRevision"],
    } as ContentSetPayload & { topologyRevision?: TopologyApplyRequest["payload"]["topologyRevision"] };
    if (input.sourcePath) {
      payload.reloadSource = { kind: "file", path: input.sourcePath };
    }
    if (display) {
      payload.display = display;
    }

    const request: ContentApplyRequest = {
      id: makeBrandedRequestId(),
      op: "content.apply",
      payload,
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    };

    const previousVisibleText = pane.snapshot?.visibleText?.trim() ?? "";
    const response = await this.sendRequest(surface, request);
    const renderStatus = mutationRenderStatus(response);
    const result = await this.applyMutationResponse(surface, pane, response, request, sessionKey, {
      diagnostic: input.diagnostic,
    }) as SurfAcePushResult;
    this.ensureContentSnapshot(surface, pane);
    if (input.contentType === "html" && renderStatus !== "pending_renderer") {
      await this.syncPaneSnapshot(surface, pane, {
        waitForVisibleText: true,
        waitForVisibleTextChangeFrom: previousVisibleText,
      });
    }
    await this.persistScreenSnapshot();
    return result;
  }

  private async browserUrlTargetSet(
    surface: ManagedSurface,
    input: SurfAceBrowserUrlPushInput,
    context?: SurfAceSessionContext,
  ): Promise<SurfAcePushResult> {
    const requiredCapability = requiredCapabilityForTargetKind("browser_url");
    if (!surface.targetCapabilities.has(requiredCapability)) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Surface ${surface.surfaceId} does not advertise ${requiredCapability}`,
      );
    }
    await this.reconcilePaneTopologyAuthority(surface, "target push");
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    await this.ensureCurrentPaneLineage(surface, pane);
    this.finalizeLiveFrame(surface, pane);

    const targetHeader: TargetHeader = {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: [requiredCapability],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: input.content,
    };
    const display = displayForPusherProvenance(context);
    const target = await this.createPaneTargetRecord(surface, pane, {
      display,
      restorePolicy: "auto",
      targetHeader,
      targetKind: "browser_url",
      targetPayload: { url: input.content },
    });
    pane.diagnosticContent = null;

    const evidence = await this.materializeTargetRecord(surface, pane, target, "initial_apply");
    this.repairLivePaneLabelInvariant("browser_url target push", surface);
    const paneLabel = this.projectedPaneLabel(surface, pane);
    const displayId = visiblePaneAddress(surface.windowLabel, paneLabel);
    return {
      blockedReason: evidence.status === "applied" ? null : evidence.errorCode ?? "materialization_failed",
      contentId: null,
      displayId,
      fingerprint: surface.surfaceId,
      paneAddress: displayId,
      paneId: pane.paneId,
      paneLabel,
      revision: pane.currentRevision,
      targetApplyEvidence: evidence,
      targetId: target.targetId,
      targetKind: target.targetKind,
    };
  }

  private async terminalAppTargetSet(
    surface: ManagedSurface,
    input: SurfAceLaunchTerminalInput,
    context?: SurfAceSessionContext,
  ): Promise<SurfAcePushResult> {
    const command = input.command.trim();
    if (!command) {
      throw new SurfAceToolError("invalid_operation", "Terminal command must be non-empty.");
    }
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new SurfAceToolError("invalid_operation", "Terminal args must be strings.");
    }
    const requiredCapability = requiredCapabilityForTargetKind("terminal_app");
    if (!surface.targetCapabilities.has(requiredCapability)) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Surface ${surface.surfaceId} does not advertise ${requiredCapability}`,
      );
    }
    await this.reconcilePaneTopologyAuthority(surface, "terminal target launch");
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    await this.ensureCurrentPaneLineage(surface, pane);
    this.finalizeLiveFrame(surface, pane);

    const targetHeader: TargetHeader = {
      payloadSchemaVersion: 1,
      replaySemantics: "launch_equivalent",
      requiredCapabilities: [requiredCapability],
      safeToLogFields: ["command", "args"],
      safetyClass: "process",
      summary: input.summary?.trim() || [command, ...args].join(" "),
    };
    const targetPayload = {
      args,
      command,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      envPolicy: "surface_default" as const,
      pty: true as const,
      restartPolicy: input.restartPolicy ?? "manual_only",
    };
    const previousTargetEpoch = pane.targetEpoch === 0 ? null : pane.targetEpoch;
    const registered = await this.registerTarget({
      expectedPreviousTargetEpoch: previousTargetEpoch,
      fingerprint: surface.surfaceId,
      idempotencyKey: input.idempotencyKey ??
        `terminal_app:${pane.paneId}:${command}:${JSON.stringify(args)}:${optionalStringFingerprint(input.cwd)}`,
      launchedAt: new Date(this.now()).toISOString(),
      ownershipEpoch: surface.ownershipEpoch,
      ownershipSessionId: surface.sessionId ?? "",
      paneId: pane.paneId,
      paneLineageId: pane.paneLineageId,
      registrationState: "attached",
      restorePolicy: "manual",
      targetHeader,
      targetKind: "terminal_app",
      targetPayload,
    });
    if (registered.status === "rejected") {
      throw new SurfAceToolError(
        "invalid_operation",
        `Terminal target registration rejected: ${registered.message}`,
      );
    }

    const restored = await this.restoreTarget({
      confirmed: true,
      fingerprint: surface.surfaceId,
      paneId: pane.paneId,
      targetId: registered.targetId,
    });
    this.repairLivePaneLabelInvariant("terminal target launch", surface);
    const paneLabel = this.projectedPaneLabel(surface, pane);
    const displayId = visiblePaneAddress(surface.windowLabel, paneLabel);
    return {
      blockedReason: restored.blockedReason ?? (restored.evidence?.status === "applied" ? null : restored.evidence?.errorCode ?? "materialization_failed"),
      contentId: null,
      displayId,
      fingerprint: surface.surfaceId,
      paneAddress: displayId,
      paneId: pane.paneId,
      paneLabel,
      revision: pane.currentRevision,
      targetApplyEvidence: restored.evidence ?? undefined,
      targetId: registered.targetId,
      targetKind: "terminal_app",
    };
  }

  private async nativeAppTargetSet(
    surface: ManagedSurface,
    input: SurfAceLaunchNativeAppInput,
    _context?: SurfAceSessionContext,
  ): Promise<SurfAcePushResult> {
    const appId = input.appId.trim();
    if (!appId) {
      throw new SurfAceToolError("invalid_operation", "Native app id must be non-empty.");
    }
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new SurfAceToolError("invalid_operation", "Native app args must be strings.");
    }
    if (input.env && !isStringRecord(input.env)) {
      throw new SurfAceToolError("invalid_operation", "Native app env must be a string map.");
    }
    if (input.cwd !== undefined && typeof input.cwd !== "string") {
      throw new SurfAceToolError("invalid_operation", "Native app cwd must be a string.");
    }
    const requiredCapability = requiredCapabilityForTargetKind("native_app");
    if (!surface.targetCapabilities.has(requiredCapability)) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Surface ${surface.surfaceId} does not advertise ${requiredCapability}`,
      );
    }
    await this.refreshRuntimeAppBinding(surface);
    this.requireTrustedRuntimeAppBinding(surface);
    await this.reconcilePaneTopologyAuthority(surface, "native app target launch");
    const pane = this.requirePane(surface.surfaceId, input.paneId);
    await this.ensureCurrentPaneLineage(surface, pane);
    this.finalizeLiveFrame(surface, pane);

    const targetHeader: TargetHeader = {
      payloadSchemaVersion: 1,
      replaySemantics: "launch_equivalent",
      requiredCapabilities: [requiredCapability],
      safeToLogFields: ["appId", "args", "cwd", "launchMode"],
      safetyClass: "process",
      summary: input.summary?.trim() || [appId, ...args].join(" "),
    };
    const launchMode = input.launchMode ?? "new_instance";
    const targetPayload = {
      appId,
      ...(args.length > 0 ? { args } : {}),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env ? { env: input.env } : {}),
      launchMode,
    };
    const previousTargetEpoch = pane.targetEpoch === 0 ? null : pane.targetEpoch;
    const registered = await this.registerTarget({
      expectedPreviousTargetEpoch: previousTargetEpoch,
      fingerprint: surface.surfaceId,
      idempotencyKey: input.idempotencyKey ??
        `native_app:${pane.paneId}:${appId}:${JSON.stringify(args)}:${optionalStringFingerprint(input.cwd)}:${stableStringMapDigest(input.env)}:${launchMode}`,
      launchedAt: new Date(this.now()).toISOString(),
      ownershipEpoch: surface.ownershipEpoch,
      ownershipSessionId: surface.sessionId ?? "",
      paneId: pane.paneId,
      paneLineageId: pane.paneLineageId,
      registrationState: "attached",
      restorePolicy: "manual",
      targetHeader,
      targetKind: "native_app",
      targetPayload,
    });
    if (registered.status === "rejected") {
      throw new SurfAceToolError(
        "invalid_operation",
        `Native app target registration rejected: ${registered.message}`,
      );
    }

    const restored = await this.restoreTarget({
      confirmed: true,
      fingerprint: surface.surfaceId,
      paneId: pane.paneId,
      targetId: registered.targetId,
    });
    const readinessBlockedReason = this.nativeAppReadinessBlockedReason(
      restored.evidence ?? undefined,
      pane,
      registered.targetId,
      surface.targetRecords.get(registered.targetId) ?? null,
    );
    if (readinessBlockedReason) {
      pane.lastRestoreBlockedReason = readinessBlockedReason;
      await this.persistSurfaceTargetState(surface, "native app readiness not proven");
    }
    this.repairLivePaneLabelInvariant("native app target launch", surface);
    const paneLabel = this.projectedPaneLabel(surface, pane);
    const displayId = visiblePaneAddress(surface.windowLabel, paneLabel);
    return {
      blockedReason: restored.blockedReason ?? readinessBlockedReason,
      contentId: null,
      displayId,
      fingerprint: surface.surfaceId,
      paneAddress: displayId,
      paneId: pane.paneId,
      paneLabel,
      revision: pane.currentRevision,
      targetApplyEvidence: restored.evidence ?? undefined,
      targetId: registered.targetId,
      targetKind: "native_app",
    };
  }

  private nativeAppReadinessBlockedReason(
    evidence: ApplyEvidence | undefined,
    pane: ManagedPane,
    targetId: string,
    target: PaneTargetRecord | null,
  ): TargetErrorCode | null {
    if (!evidence || evidence.status !== "applied") {
      return evidence?.errorCode ?? "materialization_failed";
    }
    const materializedState = evidence.materializedState;
    if (!materializedState || !("nativeHost" in materializedState)) {
      return "materialization_failed";
    }
    if (
      materializedState.nativeHost !== "applied" ||
      materializedState.proof?.paneId !== String(pane.remotePaneId) ||
      materializedState.proof?.contentId !== targetId ||
      !this.nativeAppProofMatchesTarget(materializedState.proof, target)
    ) {
      return "materialization_failed";
    }
    return null;
  }

  private nativeAppProofMatchesTarget(
    proof: NonNullable<Extract<TargetMaterializedState, { nativeHost: unknown }>["proof"]> | undefined,
    target: PaneTargetRecord | null,
  ): boolean {
    if (!proof) {
      return false;
    }
    const targetPayload = target && isPlainRecord(target.targetPayload) ? target.targetPayload : null;
    if (!targetPayload || typeof targetPayload.appId !== "string") {
      return false;
    }
    const args = isStringArray(targetPayload.args) ? targetPayload.args : [];
    const cwd = typeof targetPayload.cwd === "string" ? targetPayload.cwd : "";
    const env = isStringRecord(targetPayload.env) ? targetPayload.env : undefined;
    const launchMode = targetPayload.launchMode === "attach_or_launch" ? "attach_or_launch" : "new_instance";
    return proof.appId === targetPayload.appId &&
      stringArraysEqual(proof.args, args) &&
      (proof.cwd ?? "") === cwd &&
      proof.envDigest === stableStringMapDigest(env) &&
      proof.launchMode === launchMode;
  }

  private requireTrustedRuntimeAppBinding(surface: ManagedSurface): void {
    const binding = surface.runtimeAppBinding;
    if (!binding) {
      throw new SurfAceToolError(
        "not_connected",
        `Surf Ace native app launch is not ready on ${surface.surfaceId} (runtime_binding_missing)`,
      );
    }
    if (!binding.ready) {
      throw new SurfAceToolError(
        "not_connected",
        `Surf Ace native app launch is not ready on ${surface.surfaceId} (${
          binding.bindingAuthority === "blocked" ? "runtime_binding_blocked" : "runtime_binding_degraded"
        })`,
      );
    }
  }

  private async refreshRuntimeAppBinding(surface: ManagedSurface): Promise<void> {
    const response = await this.sendRequest(surface, this.requestEnvelope("runtime.app_binding"));
    if (isErrorResponse(response)) {
      surface.runtimeAppBinding = null;
      this.logger.warn?.(
        runtimeDiagnostic("runtime_app_binding_refresh_failed", {
          error_code: response.error.code,
          surface_id: surface.surfaceId,
        }),
      );
      return;
    }
    if (response.op !== "runtime.app_binding") {
      surface.runtimeAppBinding = null;
      this.logger.warn?.(
        runtimeDiagnostic("runtime_app_binding_refresh_unexpected_response", {
          response_op: response.op,
          surface_id: surface.surfaceId,
        }),
      );
      return;
    }
    surface.runtimeAppBinding = response.payload.runtimeAppBinding
      ? structuredClone(response.payload.runtimeAppBinding)
      : null;
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

    this.repairLivePaneLabelInvariant("settled annotation turn", surface);
    const paneLabel = this.projectedPaneLabel(surface, pane);
    const displayId = visiblePaneAddress(surface.windowLabel, paneLabel);
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
        `Surf Ace settled annotation on surface "${surface.name}", pane ${displayId}.`,
        "Treat the attached image as the primary annotation input.",
        "Use the stroke metadata below as secondary context only.",
        "",
        JSON.stringify(
          {
            contentId: frame.contentId,
            contextKey: frame.contextKey,
            displayId,
            fingerprint: surface.surfaceId,
            frameId: frame.frameId,
            openedAt: frame.openedAt,
            paneId: pane.paneId,
            paneLabel,
            paneAddress: displayId,
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
    const canonicalEndpoints = this.dedupeDiscoveryEndpoints(endpoints);
    this.logDiscoveryUpdate(endpoints, canonicalEndpoints);
    for (const endpoint of canonicalEndpoints) {
      this.refreshEndpointTopology(endpoint);
    }

    const currentEndpointIds = new Set(canonicalEndpoints.map((endpoint) => endpoint.endpointId));
    const currentEndpointKeys = new Set(canonicalEndpoints.map((endpoint) => endpointProbeKey(endpoint)));
    for (const surface of this.allManagedSurfaces()) {
      if (!currentEndpointIds.has(surface.endpointId) && !currentEndpointKeys.has(endpointProbeKey(surface.endpoint))) {
        const wsOpen = surface.client?.isOpen() ?? false;
        const preserveOwnedSurface =
          wsOpen ||
          surface.connectionState === "connected" ||
          surface.hasPairedInGatewaySession ||
          surface.sessionId !== null;
        this.logger.info?.(
          `[surf-ace:runtime] surface ${surface.surfaceId} (${surface.name}) missing from discovery; preserve=${preserveOwnedSurface} wsOpen=${wsOpen} state=${surface.connectionState} paired=${surface.hasPairedInGatewaySession} panes=${surface.panes.size}`,
        );
        if (preserveOwnedSurface) {
          continue;
        }
        this.removeClosedSurface(surface.surfaceId, "discovery_endpoint_absent");
      }
    }
    for (const probe of this.endpointProbes.values()) {
      if (currentEndpointIds.has(probe.endpointId) || currentEndpointKeys.has(probe.canonicalKey)) {
        continue;
      }
      probe.stopRequested = true;
      this.wakeEndpointProbeRetry(probe);
      this.endpointProbes.delete(probe.endpointId);
      if (probe.client) {
        this.runBackgroundTask(
          `close removed endpoint probe ${probe.endpointId}`,
          async () => {
            await probe.client?.close(1000, clampCloseReason("provider_shutdown"));
          },
        );
      }
    }
    this.queuePersistScreenSnapshot("discovery update");
  }

  private dedupeDiscoveryEndpoints(endpoints: SurfAceDiscoveryEndpoint[]): SurfAceDiscoveryEndpoint[] {
    const byKey = new Map<string, SurfAceDiscoveryEndpoint>();
    for (const endpoint of endpoints) {
      const key = endpointProbeKey(endpoint);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, endpoint);
        continue;
      }
      byKey.set(key, this.chooseDiscoveryEndpointAlias(existing, endpoint));
    }
    return [...byKey.values()];
  }

  private chooseDiscoveryEndpointAlias(
    current: SurfAceDiscoveryEndpoint,
    candidate: SurfAceDiscoveryEndpoint,
  ): SurfAceDiscoveryEndpoint {
    const canonicalKey = endpointProbeKey(current);
    const currentProbe = this.findEndpointProbeByCanonicalKey(canonicalKey);
    if (this.hasEndpointAliasFailures(canonicalKey)) {
      const currentFailed = this.hasEndpointAliasFailure(current);
      const candidateFailed = this.hasEndpointAliasFailure(candidate);
      if (currentFailed !== candidateFailed) {
        return currentFailed ? candidate : current;
      }
      return candidate.lastSeenAt >= current.lastSeenAt ? candidate : current;
    }
    if (currentProbe?.endpointId === candidate.endpointId) {
      return candidate;
    }
    if (currentProbe?.endpointId === current.endpointId) {
      return current;
    }
    return candidate.lastSeenAt >= current.lastSeenAt ? candidate : current;
  }

  private hasEndpointAliasFailures(canonicalKey: string): boolean {
    const probe = this.findEndpointProbeByCanonicalKey(canonicalKey);
    if (probe && probe.unreachableFailures > 0) {
      return true;
    }
    return this.allManagedSurfaces().some((surface) =>
      endpointProbeKey(surface.endpoint) === canonicalKey &&
      surface.unreachableFailures > 0 &&
      surface.connectionState !== "connected"
    );
  }

  private hasEndpointAliasFailure(endpoint: SurfAceDiscoveryEndpoint): boolean {
    const endpointUrl = buildWsUrl(endpoint);
    const probe = this.endpointProbes.get(endpoint.endpointId);
    if (probe && probe.unreachableFailures > 0) {
      return true;
    }
    return this.allManagedSurfaces().some((surface) =>
      surface.endpointId === endpoint.endpointId &&
      buildWsUrl(surface.endpoint) === endpointUrl &&
      surface.unreachableFailures > 0 &&
      surface.connectionState !== "connected"
    );
  }

  private logDiscoveryUpdate(
    rawEndpoints: SurfAceDiscoveryEndpoint[],
    canonicalEndpoints: SurfAceDiscoveryEndpoint[],
  ): void {
    const logKey = canonicalEndpoints
      .map((endpoint) => `${endpointProbeKey(endpoint)}@${endpoint.endpointId}`)
      .sort()
      .join(",");
    const now = this.now();
    const shouldLog = logKey !== this.lastDiscoveryUpdateLogKey ||
      now - this.lastDiscoveryUpdateLogAt >= DISCOVERY_UPDATE_LOG_MIN_INTERVAL_MS;
    if (!shouldLog) {
      return;
    }
    this.lastDiscoveryUpdateLogAt = now;
    this.lastDiscoveryUpdateLogKey = logKey;
    this.logger.warn?.(
      `[surf-ace:runtime] discoveryUpdate: ${canonicalEndpoints.length}/${rawEndpoints.length} endpoint(s): ${canonicalEndpoints.map((ep) => `${ep.name}@${ep.endpointId}`).join(", ") || "(none)"}; canonical surfaces: ${this.surfaces.size}; endpoint probes: ${this.endpointProbes.size}`,
    );
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
        this.applyVisibleEntry(surface, pane, {
          ...targetEntry,
          revision: event.payload.revision,
        });
        pane.pairImportedContentAuthority = true;
      }
    } else {
      pane.currentRevision = event.payload.revision;
      pane.pairImportedContentAuthority = true;
    }
    if (event.payload.contentId === null) {
      this.selectVisiblePaneTarget(surface, pane, null);
      pane.pairImportedContentAuthority = true;
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

  private handleTopologyChangedEvent(surface: ManagedSurface, event: TopologyChangedEvent): void {
    const panesByRemoteId = new Map(event.payload.panes.map((pane) => [pane.paneId, pane]));
    for (const paneState of panesByRemoteId.values()) {
      const pane = this.findPaneByRemoteId(surface, paneState.paneId);
      if (!pane) {
        throw new SurfAceToolError("invalid_operation", `Topology update referenced unknown pane ${paneState.paneId}.`);
      }
      pane.paneLabel = paneState.paneLabel;
      pane.name = paneState.name;
    }
    const layout = topologyLayoutToManagedLayout(surface, event.payload.layout);
    const visiblePaneIds = new Set(flattenManagedLayout(layout));
    surface.layout = collapseManagedLayout(layout);
    surface.topologyRevision = Math.max(surface.topologyRevision, Number(event.payload.topologyRevision));
    for (const pane of surface.panes.values()) {
      if (!visiblePaneIds.has(pane.paneId)) {
        continue;
      }
      const rect = managedPaneRects(surface).get(pane.paneId);
      if (rect) {
        pane.viewport = { height: rect.height, scale: surface.viewport.scale, width: rect.width };
      }
    }
    this.logger.info?.(
      runtimeDiagnostic("topology_changed_event_applied", {
        pane_ids: [...visiblePaneIds].join(","),
        surface_id: surface.surfaceId,
        topology_revision: surface.topologyRevision,
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
    const surface = this.upsertCanonicalVisibleSurface({
      endpoint: sourceSurface.endpoint,
      name: event.payload.name,
      source: "surface_appeared",
      surfaceId: event.payload.surfaceId,
      viewport: event.payload.viewport,
    });
    this.ensureSurfaceWorker(surface);
  }

  private handleSurfaceRemovedEvent(event: SurfaceRemovedEvent): void {
    this.removeClosedSurface(event.payload.surfaceId, "surface_removed_event");
  }

  private removeClosedSurface(
    surfaceId: SurfaceId,
    reason:
      | "surface_removed_event"
      | "surfaces_list_absent"
      | "surfaces_list_empty"
      | "discovery_endpoint_absent"
      | "unowned_unreachable",
  ): void {
    const surface = this.surfaces.get(surfaceId);
    const preserveDurableSurfaceState = Boolean(
      surface &&
        this.hasAcceptedSurfaceTopology(surface) &&
        reason !== "surface_removed_event" &&
        reason !== "surfaces_list_absent",
    );
    if (!preserveDurableSurfaceState) {
      this.recordSurfaceTombstone(surfaceId, reason);
      this.clearClosedSurfacePersistentState(surfaceId, reason);
    }
    if (!surface) {
      return;
    }
    if (preserveDurableSurfaceState) {
      this.restartSnapshots.set(surfaceId, structuredClone(this.buildScreenSummary(surface)));
      const restartContent = this.captureRestartContentEntries(surface);
      if (restartContent.length > 0) {
        this.restartContentBySurface.set(surfaceId, structuredClone(restartContent));
      }
    }
    const surfaceEndpointKey = endpointProbeKey(surface.endpoint);
    const lastSurfaceForEndpoint = ![...this.surfaces.values()].some(
      (candidate) => candidate !== surface && endpointProbeKey(candidate.endpoint) === surfaceEndpointKey,
    );
    if (reason === "surface_removed_event" && lastSurfaceForEndpoint) {
      this.tombstoneEndpointId(surface.endpointId, "last surface removed");
      const probe = this.upsertEndpointProbe(surface.endpoint);
      this.ensureEndpointProbeWorker(probe);
      this.wakeEndpointProbeRetry(probe);
      surface.stopRequested = true;
      surface.autoRetryEnabled = false;
      surface.connectionState = "unreachable";
      this.stopHeartbeat(surface);
      this.wakeSurfaceRetry(surface);
      const client = surface.client;
      surface.client = null;
      if (client) {
        this.runBackgroundTask(
          `close removed surface ${surface.surfaceId}`,
          async () => {
            await client.close(1000, clampCloseReason("surface_removed")).catch(() => {});
          },
        );
      }
      this.removeManagedSurfaceFromRegistries(surface);
      this.logger.info?.(
        runtimeDiagnostic("surface_removed", {
          reason,
          surface_id: surfaceId,
        }),
      );
      this.queuePersistScreenSnapshot(`surface removed ${reason}`);
      return;
    }
    surface.stopRequested = true;
    surface.autoRetryEnabled = false;
    surface.connectionState = "unreachable";
    this.stopHeartbeat(surface);
    this.wakeSurfaceRetry(surface);
    const client = surface.client;
    surface.client = null;
    if (client) {
      this.runBackgroundTask(
        `close removed surface ${surface.surfaceId}`,
        async () => {
          await client.close(1000, clampCloseReason("provider_shutdown")).catch(() => {});
        },
      );
    }
    this.removeManagedSurfaceFromRegistries(surface);
    this.logger.info?.(
      runtimeDiagnostic("surface_removed", {
        reason,
        surface_id: surfaceId,
      }),
    );
    this.queuePersistScreenSnapshot(`surface removed ${reason}`);
  }

  private clearClosedSurfacePersistentState(
    surfaceId: SurfaceId,
    reason: string,
  ): void {
    this.restartSnapshots.delete(surfaceId);
    this.restartContentBySurface.delete(surfaceId);
    let changed = false;
    const hadTargetState = Boolean(this.persistentState.targetStateBySurfaceId?.[surfaceId]);
    if (this.persistentState.targetStateBySurfaceId) {
      if (this.persistentState.targetStateBySurfaceId[surfaceId]) {
        this.recordTargetLifecycleEventForSurfaceId(surfaceId, {
          event: "remove",
          reason,
        });
        this.logger.info?.(
          runtimeDiagnostic("target_lifecycle_remove", {
            reason,
            surface_id: surfaceId,
          }),
        );
        delete this.persistentState.targetStateBySurfaceId[surfaceId];
        changed = true;
      }
    }
    const paneLabelPrefix = `${surfaceId}::`;
    for (const key of Object.keys(this.persistentState.paneLabelsByPaneId)) {
      if (key.startsWith(paneLabelPrefix)) {
        delete this.persistentState.paneLabelsByPaneId[key];
        changed = true;
      }
    }
    if (this.persistentState.windowLabels[surfaceId]) {
      delete this.persistentState.windowLabels[surfaceId];
      changed = true;
    }
    if (!changed) {
      return;
    }
    this.runBackgroundTask(
      `persist removed surface state ${surfaceId}`,
      async () => {
        await this.persistState();
        if (hadTargetState) {
          this.logger.info?.(
            runtimeDiagnostic("surface_removed_target_state", {
              reason,
              surface_id: surfaceId,
            }),
          );
        }
      },
    );
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
      case "event.topology_changed":
        this.handleTopologyChangedEvent(surface, event);
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

    const previousRemotePaneId = bootstrapPane.remotePaneId;
    if (isBoundRemotePaneId(previousRemotePaneId) && previousRemotePaneId !== remotePaneId) {
      delete this.persistentState.paneLabelsByPaneId[paneLabelStorageKey(surface.surfaceId, previousRemotePaneId)];
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

    const previousRemotePaneId = existingPane.remotePaneId;
    if (isBoundRemotePaneId(previousRemotePaneId) && previousRemotePaneId !== remotePaneId) {
      delete this.persistentState.paneLabelsByPaneId[paneLabelStorageKey(surface.surfaceId, previousRemotePaneId)];
    }
    existingPane.remotePaneId = remotePaneId;
    this.noteObservedRemotePaneId(remotePaneId);
    existingPane.paneLabel = this.ensurePaneLabel(surface, existingPane, remotePaneId);
    return existingPane;
  }

  private recoverSoleProviderPaneForEmptyPairObservation(
    surface: ManagedSurface,
    paneState: PairResponse["payload"]["state"]["panes"][number],
    remotePaneCount: number,
  ): ManagedPane | null {
    if (remotePaneCount !== 1 || paneState.currentContentId !== null) {
      return null;
    }
    if (this.findPaneByRemoteId(surface, paneState.paneId)) {
      return null;
    }

    const visiblePanes = this.visiblePanes(surface);
    if (visiblePanes.length !== 1) {
      return null;
    }
    const existingPane = visiblePanes[0]!;
    if (!this.hasProviderOwnedPaneAuthority(surface, existingPane)) {
      return null;
    }

    const previousRemotePaneId = existingPane.remotePaneId;
    if (isBoundRemotePaneId(previousRemotePaneId) && previousRemotePaneId !== paneState.paneId) {
      delete this.persistentState.paneLabelsByPaneId[paneLabelStorageKey(surface.surfaceId, previousRemotePaneId)];
    }
    existingPane.remotePaneId = paneState.paneId;
    this.noteObservedRemotePaneId(paneState.paneId);
    if (paneState.paneId > asRemotePaneId(0)) {
      this.persistentState.paneLabelsByPaneId[paneLabelStorageKey(surface.surfaceId, paneState.paneId)] =
        existingPane.paneLabel;
    }
    return existingPane;
  }

  private recoverProviderPaneForPairObservation(
    surface: ManagedSurface,
    paneState: PairResponse["payload"]["state"]["panes"][number],
    usedPaneIds: Set<PaneId>,
  ): ManagedPane | null {
    if (this.findPaneByRemoteId(surface, paneState.paneId)) {
      return null;
    }
    if (!this.hasAcceptedSurfaceTopology(surface) && !this.restartTopologyRestoredSurfaceIds.has(surface.surfaceId)) {
      return null;
    }
    const visibleMatches = this.visiblePanes(surface).filter((pane) =>
      !usedPaneIds.has(pane.paneId) &&
      pane.paneLabel === paneState.paneLabel &&
      (
        this.hasProviderOwnedPaneAuthority(surface, pane) ||
        this.restartTopologyRestoredSurfaceIds.has(surface.surfaceId)
      )
    );
    if (visibleMatches.length !== 1) {
      return null;
    }
    const existingPane = visibleMatches[0]!;
    const previousRemotePaneId = existingPane.remotePaneId;
    if (isBoundRemotePaneId(previousRemotePaneId) && previousRemotePaneId !== paneState.paneId) {
      delete this.persistentState.paneLabelsByPaneId[paneLabelStorageKey(surface.surfaceId, previousRemotePaneId)];
    }
    existingPane.remotePaneId = paneState.paneId;
    this.noteObservedRemotePaneId(paneState.paneId);
    this.persistentState.paneLabelsByPaneId[paneLabelStorageKey(surface.surfaceId, paneState.paneId)] =
      existingPane.paneLabel;
    this.logger.info?.(
      runtimeDiagnostic("pair_observation_rebound_provider_pane", {
        pane_id: existingPane.paneId,
        pane_label: existingPane.paneLabel,
        previous_remote_pane_id: Number(previousRemotePaneId ?? 0),
        remote_pane_id: Number(paneState.paneId),
        surface_id: surface.surfaceId,
        window_label: surface.windowLabel || "nil",
      }),
    );
    return existingPane;
  }

  private ensureSurfaceWorker(surface: ManagedSurface): void {
    if (this.isStalePersistedSurfaceTombstone(surface.surfaceId)) {
      surface.autoRetryEnabled = false;
      surface.stopRequested = true;
      this.logger.warn?.(
        runtimeDiagnostic("surface_worker_blocked_by_tombstone", {
          surface_id: surface.surfaceId,
        }),
      );
      return;
    }
    if (!surface.autoRetryEnabled || surface.stopRequested || surface.workPromise) {
      this.logger.info?.(
        `[surf-ace:runtime] ensureSurfaceWorker SKIPPED for ${surface.surfaceId}: autoRetry=${surface.autoRetryEnabled} stopRequested=${surface.stopRequested} hasWork=${!!surface.workPromise}`,
      );
      return;
    }
    this.logger.info?.(`[surf-ace:runtime] ensureSurfaceWorker STARTING worker for ${surface.surfaceId}`);
    surface.stopRequested = false;
    let workPromise!: Promise<void>;
    workPromise = this.runSurfaceWorker(surface).finally(() => {
      for (const managedSurface of this.allManagedSurfaces()) {
        if (managedSurface.workPromise === workPromise) {
          managedSurface.workPromise = null;
        }
      }
      this.logger.info?.(`[surf-ace:runtime] worker exited for ${surface.surfaceId}`);
    });
    surface.workPromise = workPromise;
  }

  private ensureWindowLabel(surfaceId: string): string {
    const existing = this.persistentState.windowLabels[surfaceId];
    if (isProviderWindowLabel(existing)) {
      return existing;
    }
    if (existing) {
      delete this.persistentState.windowLabels[surfaceId];
    }
    const usedWindowLabels = new Set<string>();
    for (const surface of this.surfaces.values()) {
      if (
        surface.surfaceId === surfaceId ||
        !isProviderWindowLabel(surface.windowLabel) ||
        !this.shouldReserveWindowLabel(surface)
      ) {
        continue;
      }
      usedWindowLabels.add(surface.windowLabel);
    }
    let nextWindowLabelIndex = 0;
    let label = windowLabelForIndex(nextWindowLabelIndex);
    while (usedWindowLabels.has(label)) {
      nextWindowLabelIndex += 1;
      label = windowLabelForIndex(nextWindowLabelIndex);
    }
    this.persistentState.nextWindowLabelIndex = Math.max(
      this.persistentState.nextWindowLabelIndex,
      nextWindowLabelIndex + 1,
    );
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
    if (isProviderWindowLabel(existingNextLabel)) {
      if (previousSurfaceId !== nextSurfaceId) {
        delete this.persistentState.windowLabels[previousSurfaceId];
      }
      return existingNextLabel;
    } else if (existingNextLabel) {
      delete this.persistentState.windowLabels[nextSurfaceId];
    }

    const migratedLabel = currentWindowLabel || this.persistentState.windowLabels[previousSurfaceId];
    if (isProviderWindowLabel(migratedLabel)) {
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

  private repairLiveWindowLabelInvariant(
    reason: string,
    options: { includePairingSurface?: ManagedSurface; includePairingSurfaces?: boolean } = {},
  ): void {
    const orderedSurfaces = [...this.surfaces.values()]
      .filter((surface) =>
        this.hasVisibleAcceptedSurfaceTopology(surface) ||
        surface === options.includePairingSurface ||
        (options.includePairingSurfaces === true && this.shouldReserveWindowLabel(surface))
      )
      .map((surface, index) => ({ index, surface }))
      .sort((left, right) => (
        this.windowLabelStabilityRank(right.surface) - this.windowLabelStabilityRank(left.surface) ||
        ((left.surface.connectedAt ?? Number.MAX_SAFE_INTEGER) - (right.surface.connectedAt ?? Number.MAX_SAFE_INTEGER)) ||
        left.index - right.index
      ))
      .map((entry) => entry.surface);
    const usedWindowLabels = new Set<string>();
    let nextWindowLabelIndex = 0;
    let changed = false;
    const nextAvailable = (): string => {
      let windowLabel = windowLabelForIndex(nextWindowLabelIndex);
      while (usedWindowLabels.has(windowLabel)) {
        nextWindowLabelIndex += 1;
        windowLabel = windowLabelForIndex(nextWindowLabelIndex);
      }
      return windowLabel;
    };

    for (const surface of orderedSurfaces) {
      let windowLabel = surface.windowLabel || this.persistentState.windowLabels[surface.surfaceId] || "";
      if (!isProviderWindowLabel(windowLabel) || usedWindowLabels.has(windowLabel)) {
        windowLabel = nextAvailable();
      }
      usedWindowLabels.add(windowLabel);
      while (usedWindowLabels.has(windowLabelForIndex(nextWindowLabelIndex))) {
        nextWindowLabelIndex += 1;
      }
      if (surface.windowLabel !== windowLabel) {
        surface.windowLabel = windowLabel;
        changed = true;
      }
      if (this.persistentState.windowLabels[surface.surfaceId] !== windowLabel) {
        this.persistentState.windowLabels[surface.surfaceId] = windowLabel;
        changed = true;
      }
    }

    const liveSurfaceIds = new Set<string>(orderedSurfaces.map((surface) => surface.surfaceId));
    for (const surfaceId of Object.keys(this.persistentState.windowLabels)) {
      if (!liveSurfaceIds.has(surfaceId) && this.tombstonedSurfaceIds.has(asSurfaceId(surfaceId))) {
        delete this.persistentState.windowLabels[surfaceId];
        changed = true;
      }
    }

    if (this.persistentState.nextWindowLabelIndex < nextWindowLabelIndex) {
      this.persistentState.nextWindowLabelIndex = nextWindowLabelIndex;
      changed = true;
    }
    if (changed) {
      this.runBackgroundTask(
        `persist window labels ${reason}`,
        async () => {
          await this.persistState();
        },
      );
    }
  }

  private windowLabelStabilityRank(surface: ManagedSurface): number {
    if (surface.hasPairedInGatewaySession || surface.sessionId) {
      return 3;
    }
    if (surface.connectionState === "connected" || surface.client?.isOpen()) {
      return 2;
    }
    if (surface.connectionState === "connecting") {
      return 1;
    }
    return 0;
  }

  private shouldReserveWindowLabel(surface: ManagedSurface): boolean {
    return this.hasVisibleAcceptedSurfaceTopology(surface) ||
      (
        (surface.client?.isOpen() ?? false) &&
        surface.unreachableFailures === 0 &&
        !surface.restartOwnershipPendingPair
      );
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
    remappedSurface.registeredTargetIdsByIdempotencyKey = new Map(preservedSurface.registeredTargetIdsByIdempotencyKey);
    remappedSurface.targetRecords = new Map(preservedSurface.targetRecords);
    remappedSurface.ownershipEpoch = preservedSurface.ownershipEpoch;
    remappedSurface.topologyRevision = preservedSurface.topologyRevision;
    remappedSurface.hasPairedInGatewaySession = preservedSurface.hasPairedInGatewaySession;
    remappedSurface.localOwnership = preservedSurface.localOwnership
      ? structuredClone(preservedSurface.localOwnership)
      : null;
    remappedSurface.remotePairObservation = preservedSurface.remotePairObservation
      ? structuredClone(preservedSurface.remotePairObservation)
      : null;
    remappedSurface.remotePaired = preservedSurface.remotePaired;
    remappedSurface.restartOwnershipPendingPair = preservedSurface.restartOwnershipPendingPair;
    remappedSurface.selfOwnershipReclaimAttempted = preservedSurface.selfOwnershipReclaimAttempted;
    remappedSurface.sessionId = preservedSurface.sessionId;
    remappedSurface.consecutiveResumeFailures = preservedSurface.consecutiveResumeFailures;
    remappedSurface.consecutiveOwnershipLockFailures = preservedSurface.consecutiveOwnershipLockFailures;
  }

  private quiesceSupersededSurface(
    supersededSurface: ManagedSurface,
    replacementSurfaceId: SurfaceId,
    options: { closeClient?: boolean } = {},
  ): void {
    supersededSurface.stopRequested = true;
    supersededSurface.autoRetryEnabled = false;
    supersededSurface.connectionState = "connecting";
    this.stopHeartbeat(supersededSurface);
    this.wakeSurfaceRetry(supersededSurface);
    const client = supersededSurface.client;
    supersededSurface.client = null;
    if (!client || options.closeClient === false) {
      return;
    }
    this.runBackgroundTask(
      `close superseded surface ${supersededSurface.surfaceId} -> ${replacementSurfaceId}`,
      async () => {
        await client.close(1000, clampCloseReason("provider_shutdown")).catch(() => {});
      },
      );
  }

  private upsertCanonicalVisibleSurface(input: {
    endpoint: SurfAceDiscoveryEndpoint;
    name: string;
    remotePaired?: boolean;
    remapFrom?: ManagedSurface;
    source: "pair.response" | "surface_appeared" | "surfaces.list";
    surfaceId: SurfaceId;
    viewport: SurfaceViewport;
  }): ManagedSurface {
    if (isProvisionalSurfaceId(input.surfaceId)) {
      this.logger.warn?.(
        runtimeDiagnostic("canonical_surface_quarantined", {
          endpoint_id: input.endpoint.endpointId,
          reason: "provisional_remote_surface_id",
          source: input.source,
          surface_id: input.surfaceId,
        }),
      );
      throw new SurfAceToolError("internal_error", `Cannot admit provisional Surf Ace surface id: ${input.surfaceId}`);
    }
    const remapFrom = input.remapFrom;
    const oldSurfaceId = remapFrom?.surfaceId;
    if (this.persistentState.surfaceTombstones?.[input.surfaceId]) {
      const stalePersistedTombstone = this.isStalePersistedSurfaceTombstone(input.surfaceId);
      if (stalePersistedTombstone) {
        if (input.source === "surfaces.list" && input.remotePaired === true) {
          this.clearSurfaceTombstone(input.surfaceId, "live paired surfaces.list rediscovery");
          this.livePairedSelfRediscoveredSurfaceIds.add(input.surfaceId);
        }
      } else {
        delete this.persistentState.surfaceTombstones[input.surfaceId];
        this.tombstonedSurfaceIds.delete(input.surfaceId);
      }
    }
    const existing = this.surfaces.get(input.surfaceId);
    const previousEndpoint = existing?.endpoint;
    if (
      existing &&
      existing !== remapFrom &&
      previousEndpoint &&
      previousEndpoint.endpointId !== input.endpoint.endpointId &&
      buildWsUrl(previousEndpoint) !== buildWsUrl(input.endpoint) &&
      endpointProbeKey(previousEndpoint) !== endpointProbeKey(input.endpoint) &&
      !existing.stopRequested
    ) {
      this.logger.warn?.(
        runtimeDiagnostic("canonical_surface_rebind_skipped", {
          existing_endpoint_id: previousEndpoint.endpointId,
          incoming_endpoint_id: input.endpoint.endpointId,
          reason: "endpoint_id_and_url_changed",
          source: input.source,
          surface_id: input.surfaceId,
        }),
      );
      return existing;
    }
    const windowLabel = existing?.windowLabel ||
      (input.source === "surfaces.list" ? "" : this.persistentState.windowLabels[input.surfaceId]) ||
      (input.source === "surfaces.list" ? "" : this.ensureWindowLabel(input.surfaceId));
    let surface = existing ?? remapFrom ?? createManagedSurface(
      input.surfaceId,
      input.endpoint,
      input.name,
      input.viewport,
      windowLabel,
      this.now(),
    );

    if (remapFrom && oldSurfaceId && oldSurfaceId !== input.surfaceId) {
      this.removeManagedSurfaceFromRegistries(remapFrom);
      if (existing && existing !== remapFrom) {
        this.preserveSurfaceStateUntilPairResponse(remapFrom, existing);
        if (!existing.client?.isOpen() && remapFrom.client?.isOpen()) {
          existing.client = remapFrom.client;
          this.quiesceSupersededSurface(remapFrom, input.surfaceId, { closeClient: false });
        } else {
          this.quiesceSupersededSurface(remapFrom, input.surfaceId);
        }
        surface = existing;
      } else {
        remapFrom.surfaceId = input.surfaceId;
        surface = remapFrom;
      }
      surface.windowLabel = this.reconcileWindowLabel(
        oldSurfaceId,
        input.surfaceId,
        surface.windowLabel,
      );
      this.renamePersistedSurfaceTargetState(oldSurfaceId, input.surfaceId);
      this.reconcilePaneLabelsBySurfaceId(oldSurfaceId, input.surfaceId);
      this.migrateRestartContinuity(oldSurfaceId, input.surfaceId, input.source === "pair.response");
      this.runBackgroundTask(
        `persist remapped surface id ${surface.endpointId}`,
        async () => {
          await this.persistState();
        },
      );
      if (existing && existing !== remapFrom) {
        if (typeof input.remotePaired === "boolean") {
          if (input.source === "surfaces.list") {
            this.applyRemotePairObservation(surface, input.endpoint, input.remotePaired, this.now());
          } else {
            surface.remotePaired = input.remotePaired;
          }
        }
        this.clearTombstonedEndpointId(surface.endpointId, input.source);
        this.surfaces.set(surface.surfaceId, surface);
        this.restoreRestartOwnership(surface);
        this.logger.info?.(
          runtimeDiagnostic("canonical_surface_upsert", {
            endpoint_id: surface.endpointId,
            source: input.source,
            surface_id: surface.surfaceId,
            visible_surface_count: this.surfaces.size,
          }),
        );
        this.repairLiveWindowLabelInvariant(`canonical surface upsert ${input.source}`);
        return surface;
      }
    }

    surface.endpoint = input.endpoint;
    surface.endpointId = input.endpoint.endpointId;
    surface.fingerprintPrefix = input.endpoint.fingerprintPrefix;
    surface.lastSeenAt = this.now();
    surface.name = input.name;
    if (typeof input.remotePaired === "boolean") {
      if (input.source === "surfaces.list") {
        this.applyRemotePairObservation(surface, input.endpoint, input.remotePaired, surface.lastSeenAt);
      } else {
        surface.remotePaired = input.remotePaired;
      }
    }
    surface.viewport = cloneViewport(input.viewport);
    surface.windowLabel = windowLabel;
    if (!existing && !remapFrom) {
      surface.stopRequested = false;
      this.restoreRestartOwnership(surface);
    } else if (
      previousEndpoint &&
      (
        previousEndpoint.endpointId !== input.endpoint.endpointId ||
        buildWsUrl(previousEndpoint) !== buildWsUrl(input.endpoint)
      )
    ) {
      this.resetSurfaceConnectionCircuit(surface, "endpoint changed");
      this.stopHeartbeat(surface);
      this.wakeSurfaceRetry(surface);
      if (surface.client) {
        const client = surface.client;
        this.runBackgroundTask(
          `refresh canonical surface client ${surface.surfaceId}`,
          async () => {
            await this.closeSurfaceClient(surface, client, clampCloseReason("provider_shutdown"));
          },
        );
      }
    }
    this.clearTombstonedEndpointId(surface.endpointId, input.source);
    this.surfaces.set(surface.surfaceId, surface);
    this.restoreRestartOwnership(surface);
    this.logger.info?.(
      runtimeDiagnostic("canonical_surface_upsert", {
        endpoint_id: surface.endpointId,
        source: input.source,
        surface_id: surface.surfaceId,
        visible_surface_count: this.surfaces.size,
      }),
    );
    this.repairLiveWindowLabelInvariant(`canonical surface upsert ${input.source}`);
    return surface;
  }

  private adoptCanonicalSurfaceId(
    surface: ManagedSurface,
    nextSurfaceId: SurfaceId,
    source: "pair.response",
  ): ManagedSurface {
    const oldSurfaceId = surface.surfaceId;
    const canonicalSurface = this.upsertCanonicalVisibleSurface({
      endpoint: surface.endpoint,
      name: surface.name,
      remapFrom: surface,
      source,
      surfaceId: nextSurfaceId,
      viewport: surface.viewport,
    });
    if (oldSurfaceId !== canonicalSurface.surfaceId) {
      this.logger.info?.(
        runtimeDiagnostic("surface_adopt_remote_id", {
          endpoint_id: canonicalSurface.endpointId,
          from_surface_id: oldSurfaceId,
          panes: canonicalSurface.panes.size,
          source,
          to_surface_id: canonicalSurface.surfaceId,
        }),
      );
    }
    return canonicalSurface;
  }

  private orderedPanes(surface: ManagedSurface): ManagedPane[] {
    return this.orderedPanesFrom(surface, surface.panes, surface.layout);
  }

  private orderedPanesFrom(
    surface: ManagedSurface,
    panes: Map<PaneId, ManagedPane>,
    layout: ManagedLayoutNode | null,
  ): ManagedPane[] {
    const ordered: ManagedPane[] = [];
    const seen = new Set<PaneId>();
    for (const paneId of flattenManagedLayout(layout)) {
      const pane = panes.get(paneId);
      if (!pane) {
        continue;
      }
      ordered.push(pane);
      seen.add(paneId);
    }
    if (ordered.length === panes.size) {
      return ordered;
    }
    return [
      ...ordered,
      ...[...panes.values()].filter((pane) => !seen.has(pane.paneId)).sort((left, right) => (
        left.paneLabel - right.paneLabel || left.paneId.localeCompare(right.paneId)
      )),
    ];
  }

  private visiblePanes(surface: ManagedSurface): ManagedPane[] {
    return surface.topologyRevision > 0 ? this.layoutPanes(surface) : this.orderedPanes(surface);
  }

  private visiblePanesFrom(
    surface: ManagedSurface,
    panes: Map<PaneId, ManagedPane>,
    layout: ManagedLayoutNode | null,
  ): ManagedPane[] {
    return surface.topologyRevision > 0
      ? flattenManagedLayout(layout).map((paneId) => panes.get(paneId)).filter((pane): pane is ManagedPane => Boolean(pane))
      : this.orderedPanesFrom(surface, panes, layout);
  }

  private visiblePaneSummaryProjections(surface: ManagedSurface): Array<{ pane: ManagedPane; paneLabel: number }> {
    const usedPaneLabels = new Set<number>();
    const nextAvailable = (): number => {
      return firstAvailablePaneLabel(usedPaneLabels);
    };
    return this.visiblePanes(surface).map((pane) => {
      const paneLabel = this.isUsablePaneLabelValue(pane.remotePaneId, pane.paneLabel, surface) &&
          !usedPaneLabels.has(pane.paneLabel)
        ? pane.paneLabel
        : nextAvailable();
      usedPaneLabels.add(paneLabel);
      return { pane, paneLabel };
    });
  }

  private projectedPaneLabel(surface: ManagedSurface, pane: ManagedPane): number {
    return this.visiblePaneSummaryProjections(surface)
      .find((projection) => projection.pane.paneId === pane.paneId)?.paneLabel ?? pane.paneLabel;
  }

  private async reconcilePaneTopologyAuthority(
    surface: ManagedSurface,
    reason: string,
  ): Promise<void> {
    await this.reconcilePaneTopologyAuthorityFromProvider(surface, reason, { requireProviderList: true });
  }

  private async reconcilePaneTopologyAuthorityFromProvider(
    surface: ManagedSurface,
    reason: string,
    options: { publishLabelRepairTopology?: boolean; requireProviderList: boolean },
  ): Promise<void> {
    const providerPaneIds = await this.syncRemotePaneList(surface, {
      publishLabelRepairTopology: options.publishLabelRepairTopology,
    });
    if (!providerPaneIds && options.requireProviderList) {
      throw new SurfAceToolError(
        "not_connected",
        `Surf Ace pane authority unavailable for ${reason}: provider panes.list did not return pane identity.`,
      );
    }
    this.pruneZeroRevisionLocalPanesAbsentFromProvider(surface, providerPaneIds, reason);
    this.assertActionablePaneLabels(surface, reason);
    this.reconcileVisiblePaneLayout(surface, reason, providerPaneIds);
    await this.publishAuthorityState(surface);
  }

  private assertActionablePaneLabels(surface: ManagedSurface, reason: string): void {
    const labels = new Map<number, PaneId[]>();
    for (const pane of this.visiblePanes(surface)) {
      if (!this.isUsablePaneLabelValue(pane.remotePaneId, pane.paneLabel, surface)) {
        throw new SurfAceToolError(
          "invalid_operation",
          `Surf Ace pane ${pane.paneId} on ${surface.surfaceId} has untrusted pane label for ${reason}.`,
        );
      }
      const paneIds = labels.get(pane.paneLabel) ?? [];
      paneIds.push(pane.paneId);
      labels.set(pane.paneLabel, paneIds);
    }
    const duplicate = [...labels.entries()].find(([, paneIds]) => paneIds.length > 1);
    if (duplicate) {
      const [paneLabel, paneIds] = duplicate;
      throw new SurfAceToolError(
        "invalid_operation",
        `Surf Ace surface ${surface.surfaceId} has duplicate pane label ${paneLabel} for panes ${paneIds.join(", ")}.`,
      );
    }
  }

  private pruneZeroRevisionLocalPanesAbsentFromProvider(
    surface: ManagedSurface,
    providerPaneIds: PaneId[] | null,
    reason: string,
  ): void {
    if (surface.topologyRevision > 0 || !providerPaneIds) {
      return;
    }
    const providerPaneIdSet = new Set(providerPaneIds);
    const removedPaneIds: PaneId[] = [];
    for (const paneId of surface.panes.keys()) {
      if (providerPaneIdSet.has(paneId)) {
        continue;
      }
      surface.panes.delete(paneId);
      removedPaneIds.push(paneId);
    }
    if (removedPaneIds.length === 0) {
      return;
    }
    this.logger.info?.(
      runtimeDiagnostic("pane_topology_authority_pruned", {
        reason,
        removed_pane_ids: removedPaneIds.join(","),
        surface_id: surface.surfaceId,
        topology_revision: surface.topologyRevision,
        window_label: surface.windowLabel || "nil",
      }),
    );
    this.queuePersistScreenSnapshot("pane topology authority pruning");
  }

  private reconcileVisiblePaneLayout(
    surface: ManagedSurface,
    reason: string,
    providerPaneIds: PaneId[] | null = null,
  ): void {
    if (surface.topologyRevision > 0) {
      return;
    }
    const orderedPanes = this.orderedPanes(surface);
    let panes = orderedPanes;
    if (providerPaneIds) {
      const providerPaneIdSet = new Set(providerPaneIds);
      panes = [
        ...orderedPanes.filter((pane) => providerPaneIdSet.has(pane.paneId)),
        ...providerPaneIds
          .filter((paneId) => !orderedPanes.some((pane) => pane.paneId === paneId))
          .map((paneId) => surface.panes.get(paneId))
          .filter((pane): pane is ManagedPane => Boolean(pane)),
      ];
    }
    if (panes.length === 0) {
      return;
    }
    const layoutPaneIds = new Set(flattenManagedLayout(surface.layout));
    const layoutCoversPanes =
      panes.length > 0 &&
      panes.length === layoutPaneIds.size &&
      panes.every((pane) => layoutPaneIds.has(pane.paneId));
    if (layoutCoversPanes) {
      return;
    }

    surface.layout = managedLayoutFromPanes(panes);
    this.logger.info?.(
      runtimeDiagnostic("pane_topology_authority_reconciled", {
        pane_count: panes.length,
        pane_ids: panes.map((pane) => pane.paneId).join(","),
        reason,
        surface_id: surface.surfaceId,
        topology_revision: surface.topologyRevision,
        window_label: surface.windowLabel || "nil",
      }),
    );
    this.queuePersistScreenSnapshot("pane topology authority reconciliation");
  }

  private topologySeedLayout(surface: ManagedSurface): ManagedLayoutNode {
    if (surface.topologyRevision > 0) {
      return collapseManagedLayout(surface.layout);
    }
    const layoutPaneIds = flattenManagedLayout(surface.layout);
    if (
      layoutPaneIds.length === surface.panes.size &&
      layoutPaneIds.every((paneId) => surface.panes.has(paneId))
    ) {
      return collapseManagedLayout(surface.layout);
    }
    return managedLayoutFromPanes(this.orderedPanes(surface));
  }

  private currentTargetRecord(surface: ManagedSurface, pane: ManagedPane): PaneTargetRecord | null {
    if (!pane.currentTargetId) {
      return null;
    }
    const target = surface.targetRecords.get(pane.currentTargetId);
    if (!target || target.currentState !== "current") {
      return null;
    }
    return target;
  }

  private needsNativeWindowProjectionRefresh(surface: ManagedSurface): boolean {
    if (!this.canSendRequests(surface)) {
      return false;
    }
    for (const pane of surface.panes.values()) {
      const target = this.currentTargetRecord(surface, pane);
      if (
        target &&
        isNativeHostTargetKind(target.targetKind) &&
        pane.lastRestoreBlockedReason === "materialization_failed" &&
        pane.nativeWindowGroup === null
      ) {
        return true;
      }
    }
    return false;
  }

  private providerPaneAuthorityRecord(
    surface: ManagedSurface,
    pane: ManagedPane,
  ): ProviderPaneAuthorityRecord {
    const currentTargets = this.currentProviderTargetsForPaneLineage(surface, pane);
    if (currentTargets.length > 1) {
      return {
        blockedReason: "pane_lineage_ambiguous",
        pane,
        target: currentTargets
          .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))[0]!,
        targetState: "stale",
      };
    }

    const currentPointerTarget = this.currentTargetRecord(surface, pane);
    if (currentPointerTarget && currentPointerTarget.paneLineageId === pane.paneLineageId) {
      return {
        blockedReason: pane.lastRestoreBlockedReason,
        pane,
        target: currentPointerTarget,
        targetState: "current",
      };
    }

    if (currentTargets.length === 1) {
      return {
        blockedReason: null,
        pane,
        target: currentTargets[0]!,
        targetState: "current",
      };
    }

    const staleTarget = pane.staleTargetId ? surface.targetRecords.get(pane.staleTargetId) ?? null : null;
    if (staleTarget && staleTarget.paneLineageId === pane.paneLineageId && (
      staleTarget.currentState === "current" ||
      staleTarget.currentState === "stale"
    )) {
      return {
        blockedReason: pane.lastRestoreBlockedReason ?? "restore_blocked_stale_target",
        pane,
        target: staleTarget,
        targetState: staleTarget.currentState === "current" ? "current" : "stale",
      };
    }

    const staleTargets = [...surface.targetRecords.values()]
      .filter((target) =>
        target.currentState === "stale" &&
        target.surfaceId === surface.surfaceId &&
        target.paneLineageId === pane.paneLineageId
      )
      .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt));
    if (staleTargets.length > 0) {
      return {
        blockedReason: pane.lastRestoreBlockedReason ?? "restore_blocked_stale_target",
        pane,
        target: staleTargets[0]!,
        targetState: "stale",
      };
    }

    return {
      blockedReason: null,
      pane,
      target: null,
      targetState: "none",
    };
  }

  private async reconcileProviderPaneAuthority(
    surface: ManagedSurface,
    pane: ManagedPane,
    reason: string,
  ): Promise<ProviderPaneAuthorityRecord> {
    const currentTargets = this.currentProviderTargetsForPaneLineage(surface, pane);
    if (this.markAmbiguousProviderPaneAuthorityStale(surface, pane)) {
      await this.persistSurfaceTargetState(surface, `ambiguous provider pane authority: ${reason}`);
      return this.providerPaneAuthorityRecord(surface, pane);
    }

    const currentPointerTarget = this.currentTargetRecord(surface, pane);
    if (currentPointerTarget && currentPointerTarget.paneLineageId === pane.paneLineageId) {
      return this.providerPaneAuthorityRecord(surface, pane);
    }

    if (currentTargets.length === 1) {
      const target = currentTargets[0]!;
      const repaired = this.repairCurrentSelfTargetAuthority(surface, pane, target);
      if (repaired || pane.currentTargetId !== target.targetId) {
        pane.currentTargetId = target.targetId;
        if (pane.staleTargetId === target.targetId) {
          pane.staleTargetId = null;
        }
        if (
          pane.lastRestoreBlockedReason === "restore_blocked_stale_target" ||
          pane.lastRestoreBlockedReason === "target_superseded" ||
          pane.lastRestoreBlockedReason === "ownership_epoch_mismatch" ||
          pane.lastRestoreBlockedReason === "ownership_session_mismatch"
        ) {
          pane.lastRestoreBlockedReason = null;
        }
        await this.persistSurfaceTargetState(surface, `provider pane authority adoption: ${reason}`);
      }
      return this.providerPaneAuthorityRecord(surface, pane);
    }

    return this.providerPaneAuthorityRecord(surface, pane);
  }

  private async reconcileProviderPaneAuthorityForSurface(
    surface: ManagedSurface,
    reason: string,
  ): Promise<void> {
    for (const pane of this.visiblePanes(surface)) {
      await this.reconcileProviderPaneAuthority(surface, pane, reason);
    }
  }

  private currentProviderTargetsForPaneLineage(surface: ManagedSurface, pane: ManagedPane): PaneTargetRecord[] {
    return [...surface.targetRecords.values()].filter((target) =>
      target.currentState === "current" &&
      target.surfaceId === surface.surfaceId &&
      target.paneLineageId === pane.paneLineageId
    );
  }

  private markAmbiguousProviderPaneAuthorityStale(surface: ManagedSurface, pane: ManagedPane): boolean {
    const currentTargets = this.currentProviderTargetsForPaneLineage(surface, pane);
    if (currentTargets.length <= 1) {
      return false;
    }
    let changed = false;
    for (const target of currentTargets) {
      changed = this.markTargetStale(
        surface,
        target,
        "pane_lineage_ambiguous",
        "Multiple current provider targets exist for the same pane lineage",
        pane,
      ) || changed;
    }
    return changed;
  }

  private hasProviderOwnedPaneAuthority(surface: ManagedSurface, pane: ManagedPane): boolean {
    const authority = this.providerPaneAuthorityRecord(surface, pane);
    return authority.target !== null ||
      (
        this.hasAcceptedSurfaceTopology(surface) &&
        this.visiblePanes(surface).some((candidate) => candidate.paneId === pane.paneId)
      ) ||
      [...surface.targetRecords.values()].some((target) =>
        target.surfaceId === surface.surfaceId &&
        target.paneLineageId === pane.paneLineageId &&
        (target.currentState === "current" || target.currentState === "stale")
      ) ||
      pane.activeContentId !== null ||
      pane.historySummary.visibleContentId !== null ||
      pane.snapshot !== null;
  }

  private async createPaneTargetRecord(
    surface: ManagedSurface,
    pane: ManagedPane,
    input: {
      appliedAt?: string;
      contentIdAtApply?: string | null;
      deferPersist?: boolean;
      restorePolicy?: RestorePolicy;
      targetHeader: TargetHeader;
      targetKind: TargetKind;
      targetPayload: unknown;
      display?: ContentDisplay | null;
    },
  ): Promise<PaneTargetRecord> {
    const previous = this.currentTargetRecord(surface, pane);
    pane.targetEpoch += 1;
    const targetId = makeTargetId();
    if (previous) {
      previous.currentState = "superseded";
      previous.supersededByTargetId = targetId;
    }
    const record: PaneTargetRecord = {
      appliedAt: input.appliedAt ?? new Date(this.now()).toISOString(),
      currentState: "current",
      ownerProviderId: this.persistentState.providerId,
      ownershipEpoch: surface.ownershipEpoch,
      ownershipSessionId: surface.sessionId ?? "",
      paneIdAtApply: pane.paneId,
      paneLabelAtApply: pane.paneLabel,
      paneLineageId: pane.paneLineageId,
      restorePolicy: input.restorePolicy ?? defaultRestorePolicyForTarget(input.targetKind, input.targetHeader),
      surfaceId: surface.surfaceId,
      surfaceInstanceId: null,
      targetEpoch: pane.targetEpoch,
      targetHeader: structuredClone(input.targetHeader),
      targetId,
      targetKind: input.targetKind,
      targetPayload: structuredClone(input.targetPayload),
      contentIdAtApply: input.contentIdAtApply ?? null,
      display: input.display ? structuredClone(input.display) : null,
    };
    surface.targetRecords.set(targetId, record);
    this.recordTargetLifecycleEvent(surface, {
      event: "create",
      paneLineageId: pane.paneLineageId,
      reason: "target record",
      targetId,
    });
    this.logger.info?.(
      runtimeDiagnostic("target_lifecycle_create", {
        pane_lineage_id: pane.paneLineageId,
        surface_id: surface.surfaceId,
        target_id: targetId,
      }),
    );
    pane.currentTargetId = targetId;
    pane.staleTargetId = null;
    pane.nonDurableTargetDiagnostic = null;
    pane.lastRestoreBlockedReason = null;
    pane.pairImportedContentAuthority = false;
    if (input.deferPersist !== true) {
      await this.persistSurfaceTargetState(surface, "target record");
    }
    return record;
  }

  private async rejectTargetRegistration(
    surface: ManagedSurface,
    pane: ManagedPane,
    input: SurfAceTargetRegisterInput,
    errorCode: TargetErrorCode,
    message: string,
  ): Promise<SurfAceTargetRegisterResult> {
    if (input.registrationState === "attached") {
      this.repairLivePaneLabelInvariant("target registration rejection", surface);
      const paneLabel = this.projectedPaneLabel(surface, pane);
      const displayId = visiblePaneAddress(surface.windowLabel, paneLabel);
      const now = new Date(this.now()).toISOString();
      pane.nonDurableTargetDiagnostic = {
        blockedReason: "registration_failed",
        diagnosticContent: {
          derivedFromTargetId: input.idempotencyKey,
          diagnosticContentId: makeDiagnosticContentId(),
          kind: "error",
          paneLineageId: pane.paneLineageId,
          shownAt: now,
          summary: "visible target registration failed",
          surfaceId: surface.surfaceId,
        },
        lastApplyEvidence: {
          appliedAt: now,
          errorCode,
          message,
          requestId: input.idempotencyKey,
          status: "failed",
        },
        displayId,
        paneAddress: displayId,
        paneLineageId: pane.paneLineageId,
        targetHeader: structuredClone(input.targetHeader),
        targetId: input.idempotencyKey,
        targetKind: input.targetKind,
        targetPayload: safeDiagnosticTargetPayload(
          input.targetPayload,
          isStringArray(input.targetHeader.safeToLogFields) ? input.targetHeader.safeToLogFields : [],
        ),
        targetPolicy: "never",
      };
      pane.lastRestoreBlockedReason = "registration_failed";
      await this.persistSurfaceTargetState(surface, "attached target registration failed");
    }
    return {
      errorCode,
      idempotencyKey: input.idempotencyKey,
      message,
      status: "rejected",
    };
  }

  private async recordDiagnosticPaneContent(
    surface: ManagedSurface,
    pane: ManagedPane,
    diagnostic: NonNullable<SurfAcePushInput["diagnostic"]>,
  ): Promise<void> {
    pane.diagnosticContent = {
      derivedFromTargetId: diagnostic.derivedFromTargetId,
      diagnosticContentId: makeDiagnosticContentId(),
      kind: diagnostic.kind,
      paneLineageId: pane.paneLineageId,
      shownAt: new Date(this.now()).toISOString(),
      summary: diagnostic.summary,
      surfaceId: surface.surfaceId,
    };
    await this.persistSurfaceTargetState(surface, "diagnostic content");
  }

  private async tombstonePaneTarget(surface: ManagedSurface, pane: ManagedPane): Promise<void> {
    const targetIds = new Set<string>();
    const pointerTarget = this.currentTargetRecord(surface, pane);
    if (pointerTarget) {
      targetIds.add(pointerTarget.targetId);
    }
    if (pane.staleTargetId) {
      targetIds.add(pane.staleTargetId);
    }
    for (const target of this.currentProviderTargetsForPaneLineage(surface, pane)) {
      targetIds.add(target.targetId);
    }
    if (targetIds.size === 0) {
      return;
    }
    for (const targetId of targetIds) {
      const target = surface.targetRecords.get(targetId);
      if (!target) {
        continue;
      }
      target.currentState = "tombstoned";
      this.recordTargetLifecycleEvent(surface, {
        event: "tombstone",
        paneLineageId: target.paneLineageId,
        reason: "target tombstone",
        targetId: target.targetId,
      });
      this.logger.info?.(
        runtimeDiagnostic("target_lifecycle_tombstone", {
          pane_lineage_id: target.paneLineageId,
          reason: "target tombstone",
          surface_id: surface.surfaceId,
          target_id: target.targetId,
        }),
      );
    }
    pane.currentTargetId = null;
    pane.staleTargetId = null;
    await this.persistSurfaceTargetState(surface, "target tombstone");
  }

  private markTargetStale(
    surface: ManagedSurface,
    target: PaneTargetRecord,
    reason: TargetErrorCode,
    _message: string,
    pane?: ManagedPane,
  ): boolean {
    let changed = false;
    if (target.currentState !== "stale") {
      target.currentState = "stale";
      delete target.supersededByTargetId;
      changed = true;
    }
    this.recordTargetLifecycleEvent(surface, {
      event: "stale",
      paneLineageId: target.paneLineageId,
      reason,
      targetId: target.targetId,
    });
    this.logger.info?.(
      runtimeDiagnostic("target_lifecycle_stale", {
        pane_lineage_id: target.paneLineageId,
        reason,
        surface_id: surface.surfaceId,
        target_id: target.targetId,
      }),
    );
    const panes = pane ? [pane] : [...surface.panes.values()];
    for (const candidate of panes) {
      if (candidate.currentTargetId === target.targetId) {
        candidate.currentTargetId = null;
        changed = true;
      }
      if (pane || candidate.paneLineageId === target.paneLineageId || candidate.staleTargetId === target.targetId) {
        if (candidate.staleTargetId !== target.targetId) {
          candidate.staleTargetId = target.targetId;
          changed = true;
        }
        if (candidate.lastRestoreBlockedReason !== reason) {
          candidate.lastRestoreBlockedReason = reason;
          changed = true;
        }
      }
    }
    return changed;
  }

  private failedBrowserUrlMaterializationTarget(surface: ManagedSurface, pane: ManagedPane): PaneTargetRecord | null {
    const targetId = pane.currentTargetId ?? pane.staleTargetId;
    const target = targetId ? surface.targetRecords.get(targetId) ?? null : null;
    if (
      !target ||
      target.targetKind !== "browser_url" ||
      target.paneLineageId !== pane.paneLineageId ||
      target.lastApplyEvidence?.status !== "failed" ||
      target.lastApplyEvidence.errorCode !== "materialization_failed"
    ) {
      return null;
    }
    return target;
  }

  private async staleFailedBrowserUrlMaterializationTarget(
    surface: ManagedSurface,
    pane: ManagedPane,
    reason: string,
  ): Promise<boolean> {
    const target = this.failedBrowserUrlMaterializationTarget(surface, pane);
    if (!target) {
      return false;
    }
    const changed = this.markTargetStale(surface, target, "materialization_failed", reason, pane);
    if (changed) {
      await this.persistSurfaceTargetState(surface, reason);
    }
    return changed;
  }

  private paneTargetDiagnostic(surface: ManagedSurface, pane: ManagedPane, paneLabel: number): SurfAcePaneTargetDiagnostic | null {
    const displayId = visiblePaneAddress(surface.windowLabel, paneLabel);
    const authority = this.providerPaneAuthorityRecord(surface, pane);
    const target = authority.targetState === "current" ? authority.target : null;
    if (!target) {
      const staleTarget = authority.targetState === "stale" ? authority.target : null;
      if (staleTarget) {
        return {
          blockedReason: authority.blockedReason ?? "restore_blocked_stale_target",
          diagnosticContent: pane.diagnosticContent ? structuredClone(pane.diagnosticContent) : null,
          lastApplyEvidence: staleTarget.lastApplyEvidence ? structuredClone(staleTarget.lastApplyEvidence) : null,
          displayId,
          paneAddress: displayId,
          paneLineageId: staleTarget.paneLineageId,
          targetHeader: structuredClone(staleTarget.targetHeader),
          targetId: staleTarget.targetId,
          targetKind: staleTarget.targetKind,
          targetPayload: safeDiagnosticTargetPayload(staleTarget.targetPayload, staleTarget.targetHeader.safeToLogFields),
          targetPolicy: staleTarget.restorePolicy,
        };
      }
      if (pane.nonDurableTargetDiagnostic) {
        return {
          ...structuredClone(pane.nonDurableTargetDiagnostic),
          displayId,
          paneAddress: displayId,
        };
      }
      return null;
    }
    return {
      blockedReason: authority.blockedReason,
      diagnosticContent: pane.diagnosticContent ? structuredClone(pane.diagnosticContent) : null,
      display: target.display ? structuredClone(target.display) : null,
      displayId,
      lastApplyEvidence: target.lastApplyEvidence ? structuredClone(target.lastApplyEvidence) : null,
      paneAddress: displayId,
      paneLineageId: pane.paneLineageId,
      targetHeader: structuredClone(target.targetHeader),
      targetId: target.targetId,
      targetKind: target.targetKind,
      targetPayload: safeDiagnosticTargetPayload(target.targetPayload, target.targetHeader.safeToLogFields),
      targetPolicy: target.restorePolicy,
    };
  }

  private visibleHistoryEntry(pane: ManagedPane): ManagedHistoryEntry | null {
    if (!pane.activeContentId || !pane.contentType || pane.contentValue === null) {
      return null;
    }
    return {
      contentId: pane.activeContentId,
      contentType: pane.contentType,
      contentValue: structuredClone(pane.contentValue),
      display: pane.display ? structuredClone(pane.display) : null,
      historyOwnerToken: pane.historyOwnerToken,
      revision: pane.currentRevision,
      sessionKey: pane.ownerSessionKey,
      targetId: pane.currentTargetId,
    };
  }

  private restartContinuityEntry(pane: ManagedPane): ManagedHistoryEntry | null {
    const visibleEntry = this.visibleHistoryEntry(pane);
    if (visibleEntry) {
      return visibleEntry;
    }
    const contentId = pane.historySummary.visibleContentId ?? pane.snapshot?.contentId;
    const contentType = pane.contentType ?? pane.snapshot?.contentType;
    if (!contentId || !contentType || pane.contentValue === null) {
      return null;
    }
    return {
      contentId: contentId as ContentId,
      contentType,
      contentValue: structuredClone(pane.contentValue),
      display: pane.display ? structuredClone(pane.display) : null,
      historyOwnerToken: pane.historyOwnerToken,
      revision: pane.currentRevision,
      sessionKey: pane.ownerSessionKey,
      targetId: pane.currentTargetId,
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

  private applyVisibleEntry(surface: ManagedSurface, pane: ManagedPane, entry: ManagedHistoryEntry): void {
    pane.activeContentId = entry.contentId;
    pane.contentType = entry.contentType;
    pane.contentValue = structuredClone(entry.contentValue);
    pane.currentRevision = entry.revision;
    pane.display = entry.display ? structuredClone(entry.display) : null;
    pane.historyOwnerToken = entry.historyOwnerToken;
    pane.ownerSessionKey = entry.sessionKey;
    pane.pairImportedContentAuthority = false;
    this.selectVisiblePaneTarget(surface, pane, entry.targetId);
    pane.historySummary.visibleContentId = entry.contentId;
    this.ensureContentSnapshot(surface, pane);
  }

  private ensureContentSnapshot(surface: ManagedSurface, pane: ManagedPane): void {
    if (!pane.activeContentId || !pane.contentType || pane.contentValue === null) {
      return;
    }
    const matchingSnapshot = pane.snapshot?.contentId === pane.activeContentId ? pane.snapshot : null;
    const viewport = matchingSnapshot?.viewport ?? viewportSnapshotFromSurfaceViewport(pane.viewport);
    pane.snapshot = {
      cachedAt: this.now(),
      contentId: pane.activeContentId,
      contentType: pane.contentType,
      drawings: matchingSnapshot?.drawings ? structuredClone(matchingSnapshot.drawings) : [],
      image: matchingSnapshot?.image,
      revision: pane.currentRevision,
      selection: matchingSnapshot?.selection ?? null,
      viewport,
      visibleText: visibleTextFromContent(pane.contentType, pane.contentValue, matchingSnapshot?.visibleText),
    };
    pane.buffer.scrollPosition ??= {
      visibleRect: { ...viewport.visibleRect },
      x: viewport.scrollOffset.x,
      y: viewport.scrollOffset.y,
    };
    this.queuePersistScreenSnapshot(`content snapshot ${surface.surfaceId}/${pane.paneId}`);
  }

  private selectVisiblePaneTarget(surface: ManagedSurface, pane: ManagedPane, targetId: string | null): void {
    pane.currentTargetId = targetId;
    for (const target of surface.targetRecords.values()) {
      if (target.paneLineageId !== pane.paneLineageId) {
        continue;
      }
      if (target.targetId === targetId) {
        if (target.currentState === "stale") {
          pane.currentTargetId = null;
          pane.staleTargetId = target.targetId;
          pane.lastRestoreBlockedReason = "restore_blocked_stale_target";
          continue;
        }
        target.currentState = "current";
        delete target.supersededByTargetId;
      } else if (target.currentState === "current") {
        target.currentState = "superseded";
        if (targetId) {
          target.supersededByTargetId = targetId;
        }
      }
    }
    this.runBackgroundTask("persist target state after history navigation", async () => {
      await this.persistSurfaceTargetState(surface, "history navigation target selection");
    });
  }

  private clearVisiblePaneContent(pane: ManagedPane, revision: Revision): void {
    pane.activeContentId = null;
    pane.contentType = null;
    pane.contentValue = null;
    pane.currentRevision = revision;
    pane.display = null;
    pane.historyOwnerToken = null;
    pane.ownerSessionKey = null;
    pane.historySummary.visibleContentId = null;
    pane.diagnosticContent = null;
    pane.nonDurableTargetDiagnostic = null;
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
    options: {
      beforePaneIds?: PaneId[];
      beforeRemotePaneIds?: number[];
      increment?: boolean;
      nextLayout?: ManagedLayoutNode | null;
      nextPanes?: Map<PaneId, ManagedPane>;
    } = {},
  ): Promise<void> {
    while (surface.topologyApplyInFlight) {
      await sleep(10);
    }
    surface.topologyApplyInFlight = true;
    try {
      this.invalidateClientAuthority(surface, "topology_update_in_flight");
      await this.publishAuthorityState(surface, {
        actionableOverride: false,
        reasonOverride: "topology_update_in_flight",
      });
      const draftLayout = collapseManagedLayout(options.nextLayout ?? surface.layout);
      if (!draftLayout) {
        throw new SurfAceToolError("invalid_operation", "Cannot publish empty Surf Ace topology.");
      }
      const draftPanes = options.nextPanes ?? surface.panes;
      const draftVisiblePanes = this.visiblePanesFrom(surface, draftPanes, draftLayout);
      const orderedBeforePanes = this.visiblePanes(surface);
      const beforePaneIds = options.beforePaneIds ?? orderedBeforePanes.map((pane) => pane.paneId);
      const beforeRemotePaneIds = options.beforeRemotePaneIds ?? orderedBeforePanes.map((pane) => Number(pane.remotePaneId));
      this.repairLiveWindowLabelInvariant("topology publish");
      const topologyRevision = this.nextTopologyRevision(surface, options.increment ?? false);
      const request: TopologyApplyRequest = {
        id: makeBrandedRequestId(),
        op: "topology.apply",
        payload: {
          layout: remoteLayoutToTopologyLayout(surface, draftLayout, draftPanes),
          panes: draftVisiblePanes.map((pane) => ({
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
      this.logger.info?.(
        runtimeDiagnostic("topology_apply_begin", {
          before_pane_ids: beforePaneIds.join(","),
          before_remote_pane_ids: beforeRemotePaneIds.join(","),
          current_topology_revision: surface.topologyRevision,
          expected_topology_revision: topologyRevision,
          payload: diagnosticJson(request.payload),
          session_id: surface.sessionId ?? "nil",
          surface_id: surface.surfaceId,
          window_label: surface.windowLabel || "nil",
        }),
      );

      const response = await this.sendRequest(surface, request);
      if (isErrorResponse(response)) {
        this.logger.warn?.(
          runtimeDiagnostic("topology_apply_error", {
            current_topology_revision: surface.topologyRevision,
            error_code: response.error.code,
            error_message: response.error.message,
            expected_topology_revision: topologyRevision,
            pane_count: request.payload.panes.length,
            pane_labels: request.payload.panes.map((pane) => Number(pane.paneLabel)).join(","),
            payload: diagnosticJson(request.payload),
            remote_pane_ids: request.payload.panes.map((pane) => Number(pane.paneId)).join(","),
            session_id: surface.sessionId ?? "nil",
            surface_id: surface.surfaceId,
            window_label: surface.windowLabel || "nil",
          }),
        );
        throw new SurfAceToolError(
          mutationErrorCode(response.error.code),
          response.error.message,
        );
      }
      const payload = (response as TopologyApplyResponse).payload;
      this.assertProviderPaneLabelsUnique(surface, payload.panes);
      if (options.nextPanes || options.nextLayout !== undefined) {
        surface.layout = draftLayout;
        surface.panes = draftPanes;
      } else {
        surface.layout = draftLayout;
      }
      surface.topologyRevision = Number(payload.topologyRevision);
      let lineageChanged = false;
      for (const paneState of payload.panes) {
        const pane = this.findPaneByRemoteId(surface, paneState.paneId);
        if (!pane) {
          continue;
        }
        pane.name = paneState.name;
        if (typeof paneState.paneLineageId === "string" && paneState.paneLineageId.length > 0) {
          lineageChanged = this.adoptPaneLineage(surface, pane, paneState.paneLineageId) || lineageChanged;
        }
      }
      const afterPaneIds = this.visiblePanes(surface).map((pane) => pane.paneId);
      const afterRemotePaneIds = this.visiblePanes(surface).map((pane) => Number(pane.remotePaneId));
      const beforePaneSet = new Set(beforePaneIds);
      const afterPaneSet = new Set(afterPaneIds);
      this.logger.info?.(
        runtimeDiagnostic("topology_apply_ok", {
          after_pane_ids: afterPaneIds.join(","),
          after_remote_pane_ids: afterRemotePaneIds.join(","),
          created_pane_ids: afterPaneIds.filter((paneId) => !beforePaneSet.has(paneId)).join(","),
          removed_pane_ids: beforePaneIds.filter((paneId) => !afterPaneSet.has(paneId)).join(","),
          response_panes: diagnosticJson(payload.panes),
          session_id: surface.sessionId ?? "nil",
          surface_id: surface.surfaceId,
          topology_revision: surface.topologyRevision,
          window_label: surface.windowLabel || "nil",
        }),
      );
      this.repairLivePaneLabelInvariant("topology response", surface, surface);
      const providerPaneIds = await this.syncRemotePaneList(surface);
      this.assertActionablePaneLabels(surface, "topology response");
      this.reconcileVisiblePaneLayout(surface, "topology response", providerPaneIds);
      if (lineageChanged) {
        await this.persistSurfaceTargetState(surface, "topology lineage repair");
      }
      surface.topologyApplyInFlight = false;
      await this.publishAuthorityState(surface);
      await this.persistScreenSnapshot();
    } catch (error) {
      surface.topologyApplyInFlight = false;
      await this.republishAuthorityAfterFailedTopology(surface);
      throw error;
    } finally {
      surface.topologyApplyInFlight = false;
    }
  }

  private async republishAuthorityAfterFailedTopology(surface: ManagedSurface): Promise<void> {
    try {
      await this.publishAuthorityState(surface);
    } catch (error) {
      this.logger.warn?.(
        runtimeDiagnostic("topology_authority_republish_failed", {
          error: error instanceof Error ? error.message : String(error),
          session_id: surface.sessionId ?? "nil",
          surface_id: surface.surfaceId,
          window_label: surface.windowLabel || "nil",
        }),
      );
    }
  }

  private async repushSurfaceContent(surface: ManagedSurface, restoreAttemptId?: string): Promise<void> {
    for (const pane of this.visiblePanes(surface)) {
      if (!isBoundRemotePaneId(pane.remotePaneId)) {
        continue;
      }
      try {
        if (pane.pairImportedContentAuthority) {
          this.logReplayOutcome(surface, pane, "content", "skipped_provider_owned", undefined, undefined, restoreAttemptId);
          continue;
        }

        const authority = await this.reconcileProviderPaneAuthority(surface, pane, "resume replay");
        const target = authority.targetState === "current" ? authority.target : null;
        if (target) {
          const targetAuthorityRepaired = this.repairCurrentSelfTargetAuthority(surface, pane, target);
          await this.ensureCurrentPaneLineage(surface, pane);
          const targetLineageRepaired = this.repairCurrentSelfTargetAuthority(surface, pane, target);
          if (targetAuthorityRepaired || targetLineageRepaired) {
            await this.persistSurfaceTargetState(surface, "target authority repair before resume restore");
          }
          const blockedReason = this.restoreBlockedReason(surface, pane, target, false, {
            allowResumeProcessRestart: true,
          });
          if (blockedReason) {
            pane.lastRestoreBlockedReason = blockedReason;
            await this.persistSurfaceTargetState(surface, "restore blocked");
            this.logReplayOutcome(surface, pane, "target", blockedReason, undefined, undefined, restoreAttemptId);
            continue;
          }
          const evidence = await this.materializeTargetRecordWithResumeRetries(surface, pane, target);
          this.logReplayOutcome(surface, pane, "target", evidence.status, evidence.errorCode, undefined, restoreAttemptId);
          continue;
        }

        if (pane.activeContentId && pane.contentType && pane.contentValue === null) {
          this.logReplayOutcome(surface, pane, "content", "skipped_provider_owned", undefined, undefined, restoreAttemptId);
          continue;
        }

        if (!pane.activeContentId || !pane.contentType) {
          if (pane.currentRevision <= asRevision(0)) {
            this.logReplayOutcome(surface, pane, "clear", "skipped_empty_revision", undefined, undefined, restoreAttemptId);
            continue;
          }
          const clearRequest: ContentApplyRequest = {
            id: makeBrandedRequestId(),
            op: "content.apply",
            payload: {
              clear: true,
              paneId: pane.remotePaneId,
              revision: pane.currentRevision,
              ...(restoreAttemptId ? { restoreAttemptId } : {}),
              topologyRevision: surface.topologyRevision as TopologyApplyRequest["payload"]["topologyRevision"],
            } as ContentApplyRequest["payload"],
            sentAt: asEpochMs(this.now()),
            type: "request",
            v: 1,
          };
          const clearResponse = await this.sendRequest(surface, clearRequest);
          await this.applyMutationResponse(surface, pane, clearResponse, clearRequest);
          this.logReplayOutcome(surface, pane, "clear", "applied", undefined, undefined, restoreAttemptId);
          continue;
        }

        const contentRequest: ContentApplyRequest = {
          id: makeBrandedRequestId(),
          op: "content.apply",
          payload: {
            content: structuredClone(pane.contentValue),
            contentId: pane.activeContentId,
            contentType: pane.contentType,
            ...(pane.display ? { display: structuredClone(pane.display) } : {}),
            ...(restoredDrawingsFromFrame(pane.buffer.liveFrame)
              ? { restoredDrawings: restoredDrawingsFromFrame(pane.buffer.liveFrame) }
              : {}),
            historyOwnerToken:
              pane.historyOwnerToken ??
              historyOwnerTokenForSession(pane.ownerSessionKey ?? undefined),
            paneId: pane.remotePaneId,
            revision: pane.currentRevision,
            ...(restoreAttemptId ? { restoreAttemptId } : {}),
            topologyRevision: surface.topologyRevision as TopologyApplyRequest["payload"]["topologyRevision"],
          } as ContentApplyRequest["payload"],
          sentAt: asEpochMs(this.now()),
          type: "request",
          v: 1,
        };
        const contentResponse = await this.sendRequest(surface, contentRequest);
        await this.applyMutationResponse(surface, pane, contentResponse, contentRequest, pane.ownerSessionKey ?? undefined);
        this.logReplayOutcome(surface, pane, "content", "applied", undefined, undefined, restoreAttemptId);
      } catch (error) {
        if (
          error instanceof SurfAceToolError &&
          (error.code === "stale_revision" || error.code === "stale_content")
        ) {
          const authority = this.providerPaneAuthorityRecord(surface, pane);
          const target = authority.targetState === "current" ? authority.target : null;
          const contentTarget = target ? contentPayloadForTarget(target.targetKind, target.targetPayload) : null;
          if (
            target &&
            contentTarget &&
            pane.activeContentId &&
            pane.contentType === contentTarget.contentType
          ) {
            pane.lastRestoreBlockedReason = null;
            pane.diagnosticContent = null;
            pane.nonDurableTargetDiagnostic = null;
            await this.persistSurfaceTargetState(surface, "resume restore skipped provider-owned content");
            this.logReplayOutcome(surface, pane, "target", "skipped_provider_owned", error.code, error.message, restoreAttemptId);
            continue;
          }
          this.clearVisiblePaneContent(pane, pane.currentRevision);
          await this.tombstonePaneTarget(surface, pane);
          this.logReplayOutcome(surface, pane, "content", "skipped_stale", error.code, error.message, restoreAttemptId);
          continue;
        }
        throw error;
      }
    }
  }

  private async materializeTargetRecordWithResumeRetries(
    surface: ManagedSurface,
    pane: ManagedPane,
    target: PaneTargetRecord,
  ): Promise<ApplyEvidence> {
    const key = this.resumeTargetMaterializationKey(surface, pane, target);
    const inFlight = this.resumeTargetMaterializationInFlight.get(key);
    if (inFlight) {
      this.logger.info?.(
        runtimeDiagnostic("target_materialization_join_in_flight", {
          pane_id: pane.paneId,
          surface_id: surface.surfaceId,
          target_id: target.targetId,
          target_kind: target.targetKind,
          window_label: surface.windowLabel || "nil",
        }),
      );
      return inFlight;
    }
    const materialization = this.materializeTargetRecordWithResumeRetriesExclusive(surface, pane, target);
    this.resumeTargetMaterializationInFlight.set(key, materialization);
    try {
      return await materialization;
    } finally {
      if (this.resumeTargetMaterializationInFlight.get(key) === materialization) {
        this.resumeTargetMaterializationInFlight.delete(key);
      }
    }
  }

  private resumeTargetMaterializationKey(
    surface: ManagedSurface,
    pane: ManagedPane,
    target: PaneTargetRecord,
  ): string {
    return `${surface.surfaceId}:${pane.paneLineageId}:${target.targetId}`;
  }

  private async materializeTargetRecordWithResumeRetriesExclusive(
    surface: ManagedSurface,
    pane: ManagedPane,
    target: PaneTargetRecord,
  ): Promise<ApplyEvidence> {
    let evidence = await this.materializeTargetRecord(surface, pane, target, "resume_restore");
    if (!this.shouldRetryResumeTargetMaterialization(surface, pane, target, evidence)) {
      return evidence;
    }

    for (const delayMs of this.resumeTargetMaterializationRetryDelaysMs) {
      await sleep(delayMs);
      const currentTarget = this.currentTargetRecord(surface, pane);
      if (currentTarget?.targetId !== target.targetId) {
        this.logger.info?.(
          runtimeDiagnostic("target_materialization_retry_aborted", {
            pane_id: pane.paneId,
            previous_target_id: target.targetId,
            surface_id: surface.surfaceId,
            target_id: currentTarget?.targetId ?? "nil",
            window_label: surface.windowLabel || "nil",
          }),
        );
        return evidence;
      }
      this.logger.info?.(
        runtimeDiagnostic("target_materialization_retry", {
          delay_ms: delayMs,
          pane_id: pane.paneId,
          surface_id: surface.surfaceId,
          target_id: target.targetId,
          target_kind: target.targetKind,
          window_label: surface.windowLabel || "nil",
        }),
      );
      evidence = await this.materializeTargetRecord(surface, pane, target, "resume_restore");
      this.logReplayOutcome(surface, pane, "target", evidence.status, evidence.errorCode);
      if (!this.shouldRetryResumeTargetMaterialization(surface, pane, target, evidence)) {
        return evidence;
      }
    }

    return evidence;
  }

  private shouldRetryResumeTargetMaterialization(
    surface: ManagedSurface,
    pane: ManagedPane,
    target: PaneTargetRecord,
    evidence: ApplyEvidence,
  ): boolean {
    if (!(surface.client?.isOpen() ?? false)) {
      return false;
    }
    if (evidence.status === "applied" || evidence.errorCode !== "materialization_failed") {
      return false;
    }
    if (this.currentTargetRecord(surface, pane)?.targetId !== target.targetId) {
      return false;
    }
    return processTargetAllowsResumeRestart(target);
  }

  private async recoverSurfaceAuthoritySession(
    surface: ManagedSurface,
    reason: TargetErrorCode,
  ): Promise<void> {
    const client = surface.client;
    this.invalidateClientAuthority(surface, reason);
    this.clearSurfaceResumeState(surface);
    surface.connectionState = "connecting";
    surface.reconnectAttempt = 0;
    this.logger.warn?.(
      runtimeDiagnostic("target_authority_session_repair", {
        reason,
        surface_id: surface.surfaceId,
        window_label: surface.windowLabel || "nil",
      }),
    );
    if (client?.isOpen()) {
      if (surface.client === client) {
        surface.client = null;
      }
      void client.close(1000, clampCloseReason("authority_session_repair")).catch(() => {});
    }
    this.wakeSurfaceRetry(surface);
  }

  private logReplayOutcome(
    surface: ManagedSurface,
    pane: ManagedPane,
    replayKind: "clear" | "content" | "target",
    outcome: string,
    errorCode?: string,
    message?: string,
    restoreAttemptId?: string,
  ): void {
    this.logger.info?.(
      runtimeDiagnostic("resume_replay_outcome", {
        content_id: pane.activeContentId ?? "nil",
        error_code: errorCode,
        message,
        outcome,
        pane_id: pane.paneId,
        pane_label: pane.paneLabel,
        remote_pane_id: Number(pane.remotePaneId),
        replay_kind: replayKind,
        restore_attempt_id: restoreAttemptId,
        revision: Number(pane.currentRevision),
        session_id: surface.sessionId ?? "nil",
        surface_id: surface.surfaceId,
        topology_revision: surface.topologyRevision,
        window_label: surface.windowLabel || "nil",
      }),
    );
  }

  private restoreBlockedReason(
    surface: ManagedSurface,
    pane: ManagedPane,
    target: PaneTargetRecord,
    confirmed: boolean,
    options: { allowResumeProcessRestart?: boolean } = {},
  ): TargetErrorCode | null {
    if (target.surfaceId !== surface.surfaceId || target.paneLineageId !== pane.paneLineageId) {
      return "restore_blocked_stale_target";
    }
    if ([...surface.panes.values()].filter((candidate) => candidate.paneLineageId === target.paneLineageId).length > 1) {
      return "pane_lineage_ambiguous";
    }
    if (target.ownershipSessionId !== (surface.sessionId ?? "")) {
      return "ownership_session_mismatch";
    }
    if (target.ownershipEpoch !== surface.ownershipEpoch) {
      return "ownership_epoch_mismatch";
    }
    if (target.currentState !== "current" || pane.currentTargetId !== target.targetId) {
      return "target_superseded";
    }
    const requiredCapabilities = new Set([
      requiredCapabilityForTargetKind(target.targetKind),
      ...target.targetHeader.requiredCapabilities,
    ]);
    for (const requiredCapability of requiredCapabilities) {
      if (!surface.targetCapabilities.has(requiredCapability)) {
        return "capability_missing";
      }
    }
    if (target.restorePolicy === "never") {
      return "policy_denied";
    }
    const resumeRestartAllowed = options.allowResumeProcessRestart === true && processTargetAllowsResumeRestart(target);
    if (target.restorePolicy === "manual" && !confirmed && !resumeRestartAllowed) {
      return "restore_requires_confirmation";
    }
    if (target.restorePolicy === "confirm" && !confirmed && !resumeRestartAllowed) {
      return "restore_requires_confirmation";
    }
    if ((target.targetHeader.safetyClass === "process" || isProcessBackedTargetKind(target.targetKind)) && target.restorePolicy === "auto") {
      return "approval_required";
    }
    return null;
  }

  private repairCurrentSelfTargetAuthority(
    surface: ManagedSurface,
    pane: ManagedPane,
    target: PaneTargetRecord,
  ): boolean {
    if (
      target.surfaceId !== surface.surfaceId ||
      target.currentState !== "current" ||
      !this.isTrustedProviderLineageId(target.ownerProviderId)
    ) {
      return false;
    }
    const sameVisibleTarget = pane.currentTargetId === target.targetId;
    const samePaneLineage = target.paneLineageId === pane.paneLineageId;
    if (!sameVisibleTarget && !samePaneLineage) {
      return false;
    }

    let changed = false;
    if (sameVisibleTarget && target.paneLineageId !== pane.paneLineageId) {
      target.paneLineageId = pane.paneLineageId;
      changed = true;
    }
    if (target.ownerProviderId !== this.persistentState.providerId) {
      target.ownerProviderId = this.persistentState.providerId;
      changed = true;
    }
    if (target.ownershipSessionId !== (surface.sessionId ?? "")) {
      target.ownershipSessionId = surface.sessionId ?? "";
      changed = true;
    }
    if (target.ownershipEpoch !== surface.ownershipEpoch) {
      target.ownershipEpoch = surface.ownershipEpoch;
      changed = true;
    }
    if (pane.currentTargetId !== target.targetId) {
      pane.currentTargetId = target.targetId;
      changed = true;
    }
    if (pane.staleTargetId === target.targetId) {
      pane.staleTargetId = null;
      changed = true;
    }
    if (
      pane.lastRestoreBlockedReason === "ownership_epoch_mismatch" ||
      pane.lastRestoreBlockedReason === "ownership_session_mismatch" ||
      pane.lastRestoreBlockedReason === "restore_blocked_stale_target"
    ) {
      pane.lastRestoreBlockedReason = null;
      changed = true;
    }
    return changed;
  }

  private repairProviderOwnedContentTargetAuthority(surface: ManagedSurface, pane: ManagedPane): boolean {
    if (
      pane.currentTargetId !== null ||
      !pane.activeContentId ||
      !pane.contentType ||
      pane.contentValue !== null ||
      !pane.pairImportedContentAuthority
    ) {
      return false;
    }
    const staleTarget = pane.staleTargetId ? surface.targetRecords.get(pane.staleTargetId) ?? null : null;
    if (
      !staleTarget ||
      staleTarget.surfaceId !== surface.surfaceId ||
      staleTarget.paneLineageId !== pane.paneLineageId ||
      staleTarget.currentState !== "stale" ||
      !this.isTrustedProviderLineageId(staleTarget.ownerProviderId)
    ) {
      return false;
    }
    const contentTarget = contentPayloadForTarget(staleTarget.targetKind, staleTarget.targetPayload);
    if (
      !contentTarget ||
      contentTarget.contentType !== pane.contentType ||
      staleTarget.contentIdAtApply !== pane.activeContentId
    ) {
      return false;
    }

    staleTarget.currentState = "current";
    delete staleTarget.supersededByTargetId;
    staleTarget.ownerProviderId = this.persistentState.providerId;
    staleTarget.ownershipSessionId = surface.sessionId ?? "";
    staleTarget.ownershipEpoch = surface.ownershipEpoch;
    pane.currentTargetId = staleTarget.targetId;
    pane.staleTargetId = null;
    if (
      pane.lastRestoreBlockedReason === "restore_blocked_stale_target" ||
      pane.lastRestoreBlockedReason === "ownership_session_mismatch" ||
      pane.lastRestoreBlockedReason === "ownership_epoch_mismatch" ||
      pane.lastRestoreBlockedReason === "target_superseded"
    ) {
      pane.lastRestoreBlockedReason = null;
    }
    return true;
  }

  private async materializeTargetRecord(
    surface: ManagedSurface,
    pane: ManagedPane,
    target: PaneTargetRecord,
    restoreReason: TargetApplyReason,
    display?: ContentDisplay,
  ): Promise<ApplyEvidence> {
    const recordTargetApplyEvidence = (evidence: ApplyEvidence): void => {
      target.lastApplyEvidence = evidence;
      if (evidence.status === "applied") {
        target.lastSuccessfulApplyEvidence = evidence;
      }
    };
    const authority = await this.reconcileProviderPaneAuthority(surface, pane, `target materialization ${restoreReason}`);
    if (authority.target?.targetId !== target.targetId || authority.targetState !== "current") {
      const evidence: ApplyEvidence = {
        appliedAt: new Date(this.now()).toISOString(),
        errorCode: "target_superseded",
        message: "Target is not the current provider pane authority",
        requestId: target.targetId,
        status: "failed",
      };
      recordTargetApplyEvidence(evidence);
      pane.lastRestoreBlockedReason = "target_superseded";
      await this.persistSurfaceTargetState(surface, "target authority superseded before materialization");
      return evidence;
    }
    target = authority.target;
    const targetDisplay = display ?? target.display ?? undefined;
    const contentTarget = contentPayloadForTarget(target.targetKind, target.targetPayload);
    if (contentTarget) {
      const overwritingDiagnosticContent = pane.diagnosticContent !== null;
      const reuseExistingContentIdentity = restoreReason === "resume_restore" && Boolean(pane.activeContentId) && !overwritingDiagnosticContent;
      const request: ContentApplyRequest = {
        id: makeBrandedRequestId(),
        op: "content.apply",
        payload: {
          content: contentTarget.content,
          contentId: reuseExistingContentIdentity ? pane.activeContentId! : makeContentId(),
          contentType: contentTarget.contentType,
          ...(targetDisplay ? { display: targetDisplay } : {}),
          ...(restoredDrawingsFromFrame(pane.buffer.liveFrame)
            ? { restoredDrawings: restoredDrawingsFromFrame(pane.buffer.liveFrame) }
            : {}),
          historyOwnerToken: historyOwnerTokenForSession(pane.ownerSessionKey ?? undefined),
          paneId: pane.remotePaneId,
          revision: asRevision(
            reuseExistingContentIdentity
              ? Number(pane.currentRevision)
              : Math.max(Number(pane.currentRevision), 0) + 1,
          ),
          topologyRevision: surface.topologyRevision as TopologyApplyRequest["payload"]["topologyRevision"],
        } as ContentApplyRequest["payload"],
        sentAt: asEpochMs(this.now()),
        type: "request",
        v: 1,
      };
      const response = await this.sendRequest(surface, request);
      if (isErrorResponse(response)) {
        if (
          restoreReason === "resume_restore" &&
          (response.error.code === "stale_content" || response.error.code === "stale_revision")
        ) {
          throw new SurfAceToolError(mutationErrorCode(response.error.code), response.error.message);
        }
        const evidence: ApplyEvidence = {
          appliedAt: new Date(this.now()).toISOString(),
          errorCode: "materialization_failed",
          message: response.error.message,
          requestId: request.id,
          status: "failed",
        };
        recordTargetApplyEvidence(evidence);
        pane.lastRestoreBlockedReason = "materialization_failed";
        await this.persistSurfaceTargetState(surface, "content target materialization failed");
        return evidence;
      }
      if (pane.currentTargetId !== target.targetId || target.currentState !== "current") {
        const evidence: ApplyEvidence = {
          appliedAt: new Date(this.now()).toISOString(),
          errorCode: "target_superseded",
          message: "Ignored content target apply response after target supersession",
          requestId: request.id,
          status: "failed",
        };
        recordTargetApplyEvidence(evidence);
        await this.persistSurfaceTargetState(surface, "stale content target apply response");
        return evidence;
      }
      await this.applyMutationResponse(surface, pane, response, request, pane.ownerSessionKey ?? undefined, {
        skipTargetRecord: true,
      });
      target.contentIdAtApply = pane.activeContentId;
      const evidence: ApplyEvidence = {
        appliedAt: new Date(this.now()).toISOString(),
        materializedState: {
          contentType: contentTarget.contentType,
          paneId: Number(pane.paneId) as RemotePaneId,
        },
        requestId: request.id,
        status: "applied",
      };
      recordTargetApplyEvidence(evidence);
      pane.lastRestoreBlockedReason = null;
      pane.diagnosticContent = null;
      await this.persistSurfaceTargetState(surface, "target materialized");
      return evidence;
    }

    if (isLegacyPaneLineageId(target.paneLineageId) || target.paneLineageId !== pane.paneLineageId) {
      await this.ensureCurrentPaneLineage(surface, pane);
      if (
        isLegacyPaneLineageId(target.paneLineageId) &&
        target.currentState === "current" &&
        pane.currentTargetId === target.targetId &&
        target.paneLineageId !== pane.paneLineageId
      ) {
        target.paneLineageId = pane.paneLineageId;
        await this.persistSurfaceTargetState(surface, "target lineage repair before apply");
      }
      if (target.paneLineageId !== pane.paneLineageId) {
        this.markTargetStale(
          surface,
          target,
          "restore_blocked_stale_target",
          "Target pane lineage does not match the current pane",
          pane,
        );
        await this.persistSurfaceTargetState(surface, "target lineage stale before apply");
        throw new SurfAceToolError(
          "invalid_operation",
          "Target pane lineage does not match the current pane",
        );
      }
    }

    const requestId = makeBrandedRequestId();
    const request: TargetApplyRequest = {
      id: requestId,
      op: "target.apply",
      payload: {
        ownershipEpoch: surface.ownershipEpoch,
        ownershipSessionId: surface.sessionId ?? "",
        paneLineageId: target.paneLineageId,
        requestId,
        restoreReason,
        surfaceId: surface.surfaceId,
        targetEpoch: target.targetEpoch,
        targetHeader: structuredClone(target.targetHeader),
        targetId: target.targetId,
        targetKind: target.targetKind,
        targetPayload: structuredClone(target.targetPayload),
        ...(targetDisplay ? { display: targetDisplay } : {}),
      },
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    };
    const response = await this.sendRequest(surface, request);
    if (isErrorResponse(response)) {
      const evidence: ApplyEvidence = {
        appliedAt: new Date(this.now()).toISOString(),
        errorCode: targetErrorCodeFromResponse(response.error.code),
        message: response.error.message,
        requestId,
        status: "failed",
      };
      recordTargetApplyEvidence(evidence);
      const transientAuthorityError = isTransientTargetAuthorityErrorCode(evidence.errorCode);
      pane.lastRestoreBlockedReason = transientAuthorityError
        ? null
        : evidence.errorCode ?? "materialization_failed";
      if (!transientAuthorityError && (
        evidence.errorCode === "pane_lineage_missing" ||
        evidence.errorCode === "pane_lineage_ambiguous"
      )) {
        this.markTargetStale(
          surface,
          target,
          evidence.errorCode,
          response.error.message,
          pane,
        );
      }
      if (isTargetSessionAuthorityMismatch(evidence.errorCode)) {
        await this.recoverSurfaceAuthoritySession(surface, evidence.errorCode as TargetErrorCode);
      } else if (transientAuthorityError) {
        await this.publishAuthorityState(surface);
      }
      await this.persistSurfaceTargetState(surface, "target materialization failed");
      return evidence;
    }
    const payload = (response as TargetApplyResponse).payload;
    if (
      payload.requestId !== requestId ||
      payload.targetId !== target.targetId ||
      payload.paneLineageId !== target.paneLineageId ||
      payload.targetEpoch !== target.targetEpoch
    ) {
      const evidence: ApplyEvidence = {
        appliedAt: new Date(this.now()).toISOString(),
        errorCode: "materialization_failed",
        message: "target.apply response did not match the requested target",
        requestId,
        status: "failed",
      };
      recordTargetApplyEvidence(evidence);
      pane.lastRestoreBlockedReason = "materialization_failed";
      await this.persistSurfaceTargetState(surface, "target apply response mismatch");
      return evidence;
    }
    const evidence: ApplyEvidence = {
      appliedAt: payload.appliedAt,
      errorCode: payload.errorCode,
      materializedState: payload.materializedState,
      message: payload.message,
      requestId: payload.requestId,
      status: payload.status,
    };
    recordTargetApplyEvidence(evidence);
    if (
      evidence.status !== "applied" &&
      !isTransientTargetAuthorityErrorCode(evidence.errorCode) &&
      (evidence.errorCode === "pane_lineage_missing" ||
        evidence.errorCode === "pane_lineage_ambiguous")
    ) {
      this.markTargetStale(
        surface,
        target,
        evidence.errorCode,
        evidence.message ?? "target.apply rejected stale target authority",
        pane,
      );
    }
    if (pane.currentTargetId !== target.targetId) {
      await this.persistSurfaceTargetState(surface, "stale target apply response");
      return evidence;
    }
    if (evidence.status !== "applied" && isTargetSessionAuthorityMismatch(evidence.errorCode)) {
      pane.lastRestoreBlockedReason = null;
      await this.recoverSurfaceAuthoritySession(surface, evidence.errorCode as TargetErrorCode);
    } else if (evidence.status !== "applied" && isTransientTargetAuthorityErrorCode(evidence.errorCode)) {
      pane.lastRestoreBlockedReason = null;
      await this.publishAuthorityState(surface);
    } else {
      pane.lastRestoreBlockedReason = evidence.status === "applied" ? null : evidence.errorCode ?? "materialization_failed";
    }
    if (evidence.status === "applied") {
      this.clearVisiblePaneContent(pane, asRevision(Math.max(Number(pane.currentRevision), target.targetEpoch)));
    }
    await this.persistSurfaceTargetState(surface, "target apply response");
    return evidence;
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

  private livePaneLabelStorageKey(surface: ManagedSurface, pane: ManagedPane): string | null {
    return isBoundRemotePaneId(pane.remotePaneId)
      ? paneLabelStorageKey(surface.surfaceId, pane.remotePaneId)
      : null;
  }

  private isLiveSurfacePaneLabelStorageKey(key: string): boolean {
    const surfaceId = surfaceIdFromPaneLabelStorageKey(key);
    return Boolean(surfaceId && this.surfaces.has(surfaceId));
  }

  private maximumCompactPaneLabel(_surface?: ManagedSurface): number {
    const surfaces = [...this.surfaces.values()];
    const livePaneCount = surfaces
      .reduce((total, liveSurface) => total + liveSurface.panes.size, 0);
    const livePersistedCount = Object.keys(this.persistentState.paneLabelsByPaneId)
      .filter((key) => {
        return this.isLiveSurfacePaneLabelStorageKey(key);
      }).length;
    return Math.max(1, livePaneCount + livePersistedCount + 1);
  }

  private isUsablePaneLabelValue(
    remotePaneId: RemotePaneId | undefined,
    paneLabel: unknown,
    surface?: ManagedSurface,
  ): paneLabel is number {
    if (typeof paneLabel !== "number" || !Number.isInteger(paneLabel) || paneLabel <= 0) {
      return false;
    }
    if (remotePaneId !== undefined) {
      const numericRemotePaneId = Number(remotePaneId);
      if (paneLabel === numericRemotePaneId && numericRemotePaneId > this.maximumCompactPaneLabel(surface)) {
        return false;
      }
    }
    return true;
  }

  private usedLivePaneLabels(
    includeSurface: ManagedSurface,
    excluding?: { pane?: ManagedPane | null; storageKey?: string | null },
  ): Set<number> {
    const usedPaneLabels = new Set<number>();
    const liveStorageKeys = new Set<string>();
    const liveSurfaces = this.paneLabelRepairSurfaces(includeSurface);
    for (const surface of liveSurfaces) {
      for (const pane of surface.panes.values()) {
        const storageKey = this.livePaneLabelStorageKey(surface, pane);
        if (storageKey) {
          liveStorageKeys.add(storageKey);
        }
        if (excluding?.pane && pane.paneId === excluding.pane.paneId) {
          continue;
        }
        if (excluding?.storageKey && storageKey === excluding.storageKey) {
          continue;
        }
        if (this.isUsablePaneLabelValue(pane.remotePaneId, pane.paneLabel, surface)) {
          usedPaneLabels.add(pane.paneLabel);
        }
      }
    }
    for (const [storageKey, paneLabel] of Object.entries(this.persistentState.paneLabelsByPaneId)) {
      if (excluding?.storageKey && storageKey === excluding.storageKey) {
        continue;
      }
      if (!liveStorageKeys.has(storageKey)) {
        continue;
      }
      if (this.isUsablePaneLabelValue(undefined, paneLabel)) {
        usedPaneLabels.add(paneLabel);
      }
    }
    return usedPaneLabels;
  }

  private allocatePaneLabel(
    surface: ManagedSurface,
    excluding?: { pane?: ManagedPane | null; storageKey?: string | null },
  ): number {
    const usedPaneLabels = this.usedLivePaneLabels(surface, excluding);
    const paneLabel = firstAvailablePaneLabel(usedPaneLabels);
    if (paneLabel >= this.persistentState.nextPaneLabel) {
      this.persistentState.nextPaneLabel = paneLabel + 1;
    }
    this.persistPaneLabelState("next pane label");
    return paneLabel;
  }

  private persistPaneLabelState(reason: string): void {
    this.runBackgroundTask(
      `persist ${reason}`,
      async () => {
        await this.persistState();
      },
    );
  }

  private persistEndpointTombstoneState(reason: string): void {
    this.persistentState.tombstonedEndpointIds = [...this.tombstonedEndpointIds].sort();
    this.runBackgroundTask(
      `persist endpoint tombstones ${reason}`,
      async () => {
        await this.persistState();
      },
    );
  }

  private tombstoneEndpointId(endpointId: string, reason: string): void {
    if (this.tombstonedEndpointIds.has(endpointId)) {
      return;
    }
    this.tombstonedEndpointIds.add(endpointId);
    this.persistEndpointTombstoneState(reason);
  }

  private clearTombstonedEndpointId(endpointId: string, reason: string): void {
    if (!this.tombstonedEndpointIds.delete(endpointId)) {
      return;
    }
    this.persistEndpointTombstoneState(reason);
  }

  private paneLabelRepairSurfaces(includeSurface?: ManagedSurface): ManagedSurface[] {
    const surfaces = new Map<string, ManagedSurface>();
    for (const surface of this.canonicalVisibleSurfaces()) {
      surfaces.set(surface.surfaceId, surface);
    }
    for (const surface of this.surfaces.values()) {
      if (surface.client?.isOpen()) {
        surfaces.set(surface.surfaceId, surface);
      }
    }
    if (includeSurface) {
      surfaces.set(includeSurface.surfaceId, includeSurface);
    }
    return [...surfaces.values()];
  }

  private repairLivePaneLabelInvariant(
    reason: string,
    includeSurface?: ManagedSurface,
    skipPublishSurface?: ManagedSurface,
    options: { publishTopology?: boolean } = {},
  ): void {
    const changedSurfaces = new Set<ManagedSurface>();
    const liveStorageKeys = new Set<string>();
    let changed = false;
    let nextPaneLabel = Math.max(1, this.persistentState.nextPaneLabel);
    const orderedSurfaces = this.paneLabelRepairSurfaces(includeSurface)
      .sort((left, right) =>
        left.windowLabel.localeCompare(right.windowLabel, "en") ||
        left.surfaceId.localeCompare(right.surfaceId, "en")
      );

    const usedPaneLabels = new Set<number>();
    const nextAvailable = (): number => {
      return firstAvailablePaneLabel(usedPaneLabels);
    };
    for (const surface of orderedSurfaces) {
      const orderedPanes = this.visiblePanes(surface);
      for (const pane of orderedPanes) {
        const storageKey = this.livePaneLabelStorageKey(surface, pane);
        if (storageKey) {
          liveStorageKeys.add(storageKey);
        }
        const paneLabel = this.isUsablePaneLabelValue(pane.remotePaneId, pane.paneLabel, surface) &&
            !usedPaneLabels.has(pane.paneLabel)
          ? pane.paneLabel
          : nextAvailable();
        usedPaneLabels.add(paneLabel);
        nextPaneLabel = Math.max(nextPaneLabel, paneLabel + 1);
        if (pane.paneLabel !== paneLabel) {
          pane.paneLabel = paneLabel;
          changedSurfaces.add(surface);
          changed = true;
        }
        if (storageKey && this.persistentState.paneLabelsByPaneId[storageKey] !== paneLabel) {
          this.persistentState.paneLabelsByPaneId[storageKey] = paneLabel;
          changed = true;
        }
      }
    }

    for (const key of Object.keys(this.persistentState.paneLabelsByPaneId)) {
      if (this.isLiveSurfacePaneLabelStorageKey(key) && !liveStorageKeys.has(key)) {
        delete this.persistentState.paneLabelsByPaneId[key];
        changed = true;
      }
    }

    if (this.persistentState.nextPaneLabel !== nextPaneLabel) {
      this.persistentState.nextPaneLabel = nextPaneLabel;
      changed = true;
    }

    if (changed) {
      this.persistPaneLabelState(reason);
      if (options.publishTopology !== false) {
        for (const surface of changedSurfaces) {
          if (skipPublishSurface && surface.surfaceId === skipPublishSurface.surfaceId) {
            continue;
          }
          if (!this.hasAcceptedSurfaceTopology(surface) || !(surface.client?.isOpen() ?? false)) {
            continue;
          }
          this.runBackgroundTask(
            `publish pane label repair ${surface.surfaceId}`,
            async () => {
              await this.pushTopology(surface);
            },
          );
        }
      }
    }
  }

  private ensurePaneLabel(
    surface: ManagedSurface,
    pane: ManagedPane | null,
    remotePaneId?: RemotePaneId,
  ): number {
    const storageKey = remotePaneId && remotePaneId > asRemotePaneId(0)
      ? paneLabelStorageKey(surface.surfaceId, remotePaneId)
      : null;
    const excluding = { pane, storageKey };
    const usedPaneLabels = this.usedLivePaneLabels(surface, excluding);
    const currentPaneLabel = pane?.paneLabel;
    if (remotePaneId && remotePaneId > asRemotePaneId(0)) {
      const existing = this.persistentState.paneLabelsByPaneId[storageKey!];
      if (this.isUsablePaneLabelValue(remotePaneId, existing, surface) && !usedPaneLabels.has(existing)) {
        return existing;
      }
      delete this.persistentState.paneLabelsByPaneId[storageKey!];

      const paneLabel =
        this.isUsablePaneLabelValue(remotePaneId, currentPaneLabel, surface) && !usedPaneLabels.has(currentPaneLabel)
          ? currentPaneLabel
          : this.allocatePaneLabel(surface, excluding);
      this.persistentState.paneLabelsByPaneId[storageKey!] = paneLabel;
      this.runBackgroundTask(
        `persist pane label for ${surface.surfaceId}/${remotePaneId}`,
        async () => {
          await this.persistState();
        },
      );
      return paneLabel;
    }

    if (
      this.isUsablePaneLabelValue(undefined, currentPaneLabel, surface) && !usedPaneLabels.has(currentPaneLabel)
    ) {
      return currentPaneLabel;
    }

    return this.allocatePaneLabel(surface, excluding);
  }

  private adoptProviderPaneLabels(
    surface: ManagedSurface,
    entries: Array<{ pane: ManagedPane; paneLabel: number; remotePaneId: RemotePaneId }>,
  ): boolean {
    this.assertProviderPaneLabelsUnique(surface, entries);
    const labelCounts = new Map<number, number>();
    const entryPaneIds = new Set<PaneId>();
    const entryStorageKeys = new Set<string>();
    const usedPaneLabels = new Set<number>();
    const providerLabels = new Set<number>();
    for (const entry of entries) {
      entryPaneIds.add(entry.pane.paneId);
      const storageKey = paneLabelStorageKey(surface.surfaceId, entry.remotePaneId);
      entryStorageKeys.add(storageKey);
      if (this.isUsablePaneLabelValue(entry.remotePaneId, entry.paneLabel, surface)) {
        labelCounts.set(entry.paneLabel, (labelCounts.get(entry.paneLabel) ?? 0) + 1);
      }
    }
    for (const repairSurface of this.paneLabelRepairSurfaces(surface)) {
      if (repairSurface.surfaceId === surface.surfaceId) {
        continue;
      }
      for (const pane of repairSurface.panes.values()) {
        const storageKey = this.livePaneLabelStorageKey(repairSurface, pane);
        if (storageKey && entryStorageKeys.has(storageKey)) {
          continue;
        }
        if (this.isUsablePaneLabelValue(pane.remotePaneId, pane.paneLabel, repairSurface)) {
          usedPaneLabels.add(pane.paneLabel);
        }
      }
    }
    for (const [storageKey, paneLabel] of Object.entries(this.persistentState.paneLabelsByPaneId)) {
      if (storageKey.startsWith(`${surface.surfaceId}::`)) {
        continue;
      }
      if (entryStorageKeys.has(storageKey)) {
        continue;
      }
      if (this.isUsablePaneLabelValue(undefined, paneLabel)) {
        usedPaneLabels.add(paneLabel);
      }
    }
    for (const [paneLabel, count] of labelCounts) {
      if (count === 1 && !usedPaneLabels.has(paneLabel)) {
        providerLabels.add(paneLabel);
      }
    }
    for (const paneLabel of providerLabels) {
      usedPaneLabels.add(paneLabel);
    }
    for (const pane of surface.panes.values()) {
      if (
        !entryPaneIds.has(pane.paneId) &&
        this.isUsablePaneLabelValue(pane.remotePaneId, pane.paneLabel, surface) &&
        !usedPaneLabels.has(pane.paneLabel)
      ) {
        usedPaneLabels.add(pane.paneLabel);
      }
    }
    const nextAvailable = (): number => {
      const paneLabel = firstAvailablePaneLabel(usedPaneLabels);
      usedPaneLabels.add(paneLabel);
      return paneLabel;
    };

    let changed = false;
    for (const pane of surface.panes.values()) {
      if (entryPaneIds.has(pane.paneId) || !providerLabels.has(pane.paneLabel)) {
        continue;
      }
      const paneLabel = nextAvailable();
      if (pane.paneLabel !== paneLabel) {
        pane.paneLabel = paneLabel;
        changed = true;
      }
      const storageKey = this.livePaneLabelStorageKey(surface, pane);
      if (storageKey) {
        this.persistentState.paneLabelsByPaneId[storageKey] = paneLabel;
        changed = true;
      }
    }

    for (const entry of entries) {
      if (!this.isUsablePaneLabelValue(entry.remotePaneId, entry.paneLabel, surface)) {
        continue;
      }
      if (!providerLabels.has(entry.paneLabel)) {
        continue;
      }
      if (entry.pane.paneLabel !== entry.paneLabel) {
        entry.pane.paneLabel = entry.paneLabel;
        changed = true;
      }
      if (entry.remotePaneId <= asRemotePaneId(0)) {
        continue;
      }
      const storageKey = paneLabelStorageKey(surface.surfaceId, entry.remotePaneId);
      if (this.persistentState.paneLabelsByPaneId[storageKey] === entry.paneLabel) {
        continue;
      }
      this.persistentState.paneLabelsByPaneId[storageKey] = entry.paneLabel;
      changed = true;
    }
    if (changed) {
      this.persistPaneLabelState(`provider pane labels ${surface.surfaceId}`);
    }
    return changed;
  }

  private assertProviderPaneLabelsUnique(
    surface: ManagedSurface,
    paneStates: Array<{ paneId?: RemotePaneId; paneLabel: number; remotePaneId?: RemotePaneId }>,
  ): void {
    const paneLabels = new Set<number>();
    for (const paneState of paneStates) {
      const remotePaneId = paneState.paneId ?? paneState.remotePaneId;
      if (!this.isUsablePaneLabelValue(remotePaneId, paneState.paneLabel, surface)) {
        throw new SurfAceToolError(
          "internal_error",
          `Surf Ace provider returned invalid pane label for ${surface.surfaceId}`,
        );
      }
      if (paneLabels.has(paneState.paneLabel)) {
        throw new SurfAceToolError(
          "internal_error",
          `Surf Ace provider returned duplicate pane labels for ${surface.surfaceId}`,
        );
      }
      paneLabels.add(paneState.paneLabel);
    }
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
      const nextKey = `${nextSurfaceId}::${key.slice(previousPrefix.length)}`;
      if (remapped[nextKey] === undefined) {
        remapped[nextKey] = paneLabel;
      }
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
    let loadedStateProviderId = "";
    let shouldPersistState = false;
    const parsed = await this.stateRepository.load() as RuntimeStateFile & { endpointSurfaces?: Record<string, string> } | null;
    if (parsed?.version === 1) {
      loadedStateProviderId = parsed.providerId;
      this.persistentState = {
        nextRemotePaneId: parsed.nextRemotePaneId ?? (parsed as { nextPaneId?: number }).nextPaneId ?? 1,
        nextPaneLabel: parsed.nextPaneLabel ?? 1,
        nextWindowLabelIndex: parsed.nextWindowLabelIndex,
        paneLabelsByPaneId: parsed.paneLabelsByPaneId ?? {},
        providerId: parsed.providerId,
        providerLineage: parsed.providerLineage ?? [],
        selfOwnedSurfaceIds: parsed.selfOwnedSurfaceIds ?? {},
        surfaceTombstones: parsed.surfaceTombstones ?? {},
        targetLifecycleEventsBySurfaceId: parsed.targetLifecycleEventsBySurfaceId ?? {},
        targetStateBySurfaceId: parsed.targetStateBySurfaceId ?? {},
        tombstonedEndpointIds: parsed.tombstonedEndpointIds ?? [],
        version: 1,
        windowLabels: parsed.windowLabels ?? {},
      };
      this.tombstonedEndpointIds.clear();
      for (const endpointId of this.persistentState.tombstonedEndpointIds ?? []) {
        if (typeof endpointId === "string" && endpointId.length > 0) {
          this.tombstonedEndpointIds.add(endpointId);
        }
      }
      this.tombstonedSurfaceIds.clear();
      for (const surfaceId of Object.keys(this.persistentState.surfaceTombstones ?? {})) {
        if (surfaceId.length > 0) {
          this.tombstonedSurfaceIds.add(asSurfaceId(surfaceId));
        }
      }
    } else {
      shouldPersistState = true;
    }

    const durableProviderId = await this.loadOrCreateDurableProviderId(loadedStateProviderId);
    if (this.persistentState.providerId !== durableProviderId) {
      this.persistentState.providerLineage = [];
      this.persistentState.selfOwnedSurfaceIds = Object.fromEntries(
        Object.entries(this.persistentState.selfOwnedSurfaceIds ?? {}).filter(
          ([, ownership]) => ownership.providerId === durableProviderId,
        ),
      );
      this.persistentState.providerId = durableProviderId;
      shouldPersistState = true;
    }

    if (shouldPersistState) {
      await this.persistState();
    }
  }

  private async loadOrCreateDurableProviderId(seedProviderId: string): Promise<string> {
    const existingProviderId = await this.readDurableProviderId();
    if (existingProviderId) {
      return existingProviderId;
    }
    const providerId = isValidProviderId(seedProviderId)
      ? seedProviderId
      : await this.loadProviderIdSeedFromKnownLocalState() || generateProviderId();
    return await this.persistDurableProviderIdentity(providerId);
  }

  private async readDurableProviderId(): Promise<string> {
    try {
      const raw = await fs.readFile(this.providerIdentityPath, "utf8");
      const parsed = JSON.parse(raw) as ProviderIdentityFile;
      if (parsed.version === 1 && typeof parsed.providerId === "string" && isValidProviderId(parsed.providerId)) {
        return parsed.providerId;
      }
    } catch {
      return "";
    }
    return "";
  }

  private async loadProviderIdSeedFromKnownLocalState(): Promise<string> {
    const candidateStatePaths = new Set([
      path.join(path.dirname(this.providerIdentityPath), STATE_FILE_NAME),
      path.join(this.legacyStateDir, STATE_FILE_NAME),
    ]);
    for (const statePath of candidateStatePaths) {
      const providerId = await this.readProviderIdFromStateFile(statePath);
      if (providerId) {
        return providerId;
      }
    }
    return "";
  }

  private async readProviderIdFromStateFile(statePath: string): Promise<string> {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RuntimeStateFile>;
      return parsed.version === 1 && typeof parsed.providerId === "string" && isValidProviderId(parsed.providerId)
        ? parsed.providerId
        : "";
    } catch {
      return "";
    }
  }

  private async persistDurableProviderIdentity(providerId: string): Promise<string> {
    if (!isValidProviderId(providerId)) {
      throw new Error(`Invalid Surf Ace provider identity: ${providerId}`);
    }
    await ensureDirectory(path.dirname(this.providerIdentityPath));
    const identity: ProviderIdentityFile = { providerId, version: 1 };
    try {
      await fs.writeFile(this.providerIdentityPath, JSON.stringify(identity, null, 2), { flag: "wx" });
      return providerId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existingProviderId = await this.readDurableProviderId();
      if (!existingProviderId) {
        await fs.writeFile(this.providerIdentityPath, JSON.stringify(identity, null, 2));
        return providerId;
      }
      return existingProviderId;
    }
  }

  private async loadDurableProviderLineage(): Promise<void> {
    this.persistentState.providerLineage ??= [];
    this.persistentState.selfOwnedSurfaceIds ??= {};
    this.noteProviderLineage(this.persistentState.providerId, "current_state");
    this.startupImportedOwnershipSurfaceIds.clear();
    this.importCurrentTargetOwnership();
    for (const surfaceId of Object.keys(this.persistentState.targetStateBySurfaceId ?? {})) {
      const hadSelfOwnedSurface = Boolean(this.persistentState.selfOwnedSurfaceIds?.[surfaceId]);
      if (!hadSelfOwnedSurface) {
        this.noteSelfOwnedSurface(surfaceId, this.persistentState.providerId, "current_target_state");
        this.startupImportedOwnershipSurfaceIds.add(surfaceId);
      }
    }

    let importedCurrentSnapshotOwnership = false;
    const currentSnapshot = await this.readScreenSnapshotFile(path.join(this.stateDir, SCREEN_SNAPSHOT_FILE_NAME));
    for (const screen of currentSnapshot?.screens ?? []) {
      const providerId = screen._debug?.localOwnership?.providerId;
      if (
        typeof providerId === "string" &&
        this.isTrustedProviderLineageId(providerId) &&
        this.hasTrustedLocalOwnershipProvenanceForProvider(screen, providerId)
      ) {
        const existing = this.persistentState.selfOwnedSurfaceIds?.[screen.fingerprint];
        this.noteSelfOwnedSurface(screen.fingerprint, providerId, "current_snapshot_local_ownership");
        importedCurrentSnapshotOwnership ||= existing?.providerId !== providerId ||
          existing.source !== "current_snapshot_local_ownership";
      }
    }

    const legacyDir = this.legacyStateDir;
    if (path.resolve(legacyDir) === path.resolve(this.stateDir)) {
      if (importedCurrentSnapshotOwnership) {
        await this.persistState();
      }
      return;
    }

    const legacyStatePath = path.join(legacyDir, STATE_FILE_NAME);
    const legacyState = await this.readRuntimeStateFile(legacyStatePath);
    if (!legacyState?.providerId) {
      if (importedCurrentSnapshotOwnership) {
        await this.persistState();
      }
      return;
    }
    if (legacyState.providerId !== this.persistentState.providerId) {
      if (importedCurrentSnapshotOwnership) {
        await this.persistState();
      }
      return;
    }
    let legacyStateObservedAt = this.now();
    try {
      legacyStateObservedAt = (await fs.stat(legacyStatePath)).mtimeMs;
    } catch {
      // Keep the current time fallback for freshly imported legacy state when stat is unavailable.
    }
    this.noteProviderLineage(legacyState.providerId, "legacy_state_root");
    for (const surfaceId of Object.keys(legacyState.targetStateBySurfaceId ?? {})) {
      if (!this.persistentState.selfOwnedSurfaceIds?.[surfaceId]) {
        this.noteSelfOwnedSurface(surfaceId, legacyState.providerId, "legacy_target_state", legacyStateObservedAt);
      }
    }
    const legacySnapshot = await this.readScreenSnapshotFile(path.join(legacyDir, SCREEN_SNAPSHOT_FILE_NAME));
    for (const screen of legacySnapshot?.screens ?? []) {
      if (this.hasTrustedLocalOwnershipProvenanceForProvider(screen, legacyState.providerId)) {
        this.noteSelfOwnedSurface(screen.fingerprint, legacyState.providerId, "legacy_local_ownership");
      }
    }
    await this.persistState();
  }

  private async reconcilePersistedSelfOwnedSurfacesBeforeDiscovery(): Promise<void> {
    const currentSnapshot = await this.readScreenSnapshotFile(path.join(this.stateDir, SCREEN_SNAPSHOT_FILE_NAME));
    const persistedRuntimeSurfaceIds = new Set(
      (currentSnapshot?.screens ?? [])
        .map((screen) => screen.fingerprint)
        .filter((fingerprint): fingerprint is string => typeof fingerprint === "string" && fingerprint.length > 0),
	    );
	    const recoverableSurfaceIds = new Set(
	      (currentSnapshot?.screens ?? [])
	        .filter((screen) => this.hasTrustedLocalOwnershipProvenanceForProvider(screen, this.persistentState.providerId))
	        .map((screen) => screen.fingerprint),
    );
    const continuitySurfaceIds = new Set(
      Object.keys((currentSnapshot?.contentContinuity ?? {}) as Record<string, unknown>),
    );
    const persistedSurfaceIds = new Set([
      ...Object.keys(this.persistentState.selfOwnedSurfaceIds ?? {}),
      ...Object.keys(this.persistentState.targetStateBySurfaceId ?? {}),
      ...Object.keys(this.persistentState.windowLabels ?? {}),
    ]);
    let changed = false;
    for (const surfaceId of persistedSurfaceIds) {
      const ownership = this.persistentState.selfOwnedSurfaceIds?.[surfaceId];
      if (
		        !ownership ||
		        ownership.relinquishedAt ||
        !this.ownershipRecoveryPolicy.isTrustedProviderLineageId(this.persistentState, ownership.providerId) ||
        persistedRuntimeSurfaceIds.has(surfaceId) ||
        recoverableSurfaceIds.has(surfaceId) ||
        continuitySurfaceIds.has(surfaceId) ||
        this.hasBoundedStartupSelfOwnershipRecovery(surfaceId, ownership) ||
        this.hasRecoverableStartupOwnershipPath(surfaceId)
      ) {
        continue;
      }
      this.recordSurfaceTombstone(surfaceId, "stale_self_owned_persisted_surface");
      this.clearClosedSurfacePersistentState(asSurfaceId(surfaceId), "stale_self_owned_persisted_surface");
      changed = true;
    }
    if (changed) {
      await this.persistState();
      this.logger.warn?.(
        runtimeDiagnostic("persisted_self_owned_surface_reconciled", {
          reason: "stale_self_owned_persisted_surface",
          tombstoned_surface_count: Object.keys(this.persistentState.surfaceTombstones ?? {}).length,
        }),
      );
	    }
	  }

  private hasRecoverableStartupOwnershipPath(surfaceId: string): boolean {
    const hasDurableOwnershipHint = this.hasRecoverableDurableOwnershipHint(
      surfaceId,
      "current_target_state",
      { allowCurrentTargetState: true },
    );
    return this.startupImportedOwnershipSurfaceIds.has(surfaceId) && hasDurableOwnershipHint;
  }

  private hasBoundedStartupSelfOwnershipRecovery(
    surfaceId: string,
    ownership: NonNullable<RuntimeStateFile["selfOwnedSurfaceIds"]>[string],
  ): boolean {
    if (!this.ownershipRecoveryPolicy.isTrustedProviderLineageId(this.persistentState, ownership.providerId)) {
      return false;
    }
    if (this.hasRecoverableDurableOwnershipHint(surfaceId, ownership.source)) {
      return true;
    }
    const observedAt = Number.isFinite(ownership.observedAt) ? ownership.observedAt : 0;
    if (this.now() - observedAt > STARTUP_SELF_OWNERSHIP_RECLAIM_GRACE_MS) {
      return false;
    }
    return ownership.source === "current_local_ownership" || ownership.source === "legacy_target_state";
  }

  private hasRecoverableDurableOwnershipHint(
    surfaceId: string,
    ownershipSource?: string,
    options: { allowCurrentTargetState?: boolean } = {},
  ): boolean {
    const targetState = this.persistentState.targetStateBySurfaceId?.[surfaceId];
    const currentTargetIds = new Set(
      Object.values(targetState?.paneTargets ?? {})
        .map((paneTarget) => paneTarget.currentTargetId)
        .filter((targetId): targetId is string => typeof targetId === "string" && targetId.length > 0),
    );
    if (currentTargetIds.size === 0) {
      return false;
    }
    const targetRecords = Array.isArray(targetState?.targetRecords) ? targetState.targetRecords : [];
    return targetRecords.some((target) => {
      if (
        !currentTargetIds.has(target.targetId) ||
        typeof target.ownershipSessionId !== "string" ||
        target.ownershipSessionId.length === 0 ||
        target.currentState !== "current" ||
        !this.ownershipRecoveryPolicy.isTrustedProviderLineageId(
          this.persistentState,
          typeof target.ownerProviderId === "string" ? target.ownerProviderId : "",
        )
      ) {
        return false;
      }
      if (
        ownershipSource === "current_local_ownership" ||
        (ownershipSource === "current_target_state" && options.allowCurrentTargetState === true)
      ) {
        return target.targetHeader !== null && target.targetHeader !== undefined;
      }
      return this.isRecoverableDurableTargetHint(target);
    });
  }

  private isRecoverableDurableTargetHint(target: PaneTargetRecord): boolean {
    if (target.targetHeader?.safetyClass !== "passive") {
      return true;
    }
    const appliedAt = Date.parse(target.appliedAt);
    return Number.isFinite(appliedAt) && this.now() - appliedAt <= STARTUP_SELF_OWNERSHIP_RECLAIM_GRACE_MS;
  }

  private recordSurfaceTombstone(surfaceId: string, reason: string): void {
    this.persistentState.surfaceTombstones ??= {};
    this.tombstonedSurfaceIds.add(asSurfaceId(surfaceId));
    const hadTargetState = Boolean(this.persistentState.targetStateBySurfaceId?.[surfaceId]);
    const hadWindowLabel = Boolean(this.persistentState.windowLabels?.[surfaceId]);
    this.persistentState.surfaceTombstones[surfaceId] = {
      hadTargetState,
      hadWindowLabel,
      providerId: this.persistentState.providerId,
      reason,
      tombstonedAt: this.now(),
    };
    this.markSelfOwnedSurfaceRelinquished(surfaceId);
  }

  private surfaceTombstoneReason(surfaceId: string): string | null {
    return this.persistentState.surfaceTombstones?.[surfaceId]?.reason ?? null;
  }

  private isStalePersistedSurfaceTombstone(surfaceId: string): boolean {
    return this.surfaceTombstoneReason(surfaceId) === "stale_self_owned_persisted_surface";
  }

  private clearSurfaceTombstone(surfaceId: string, reason: string): void {
    if (!this.persistentState.surfaceTombstones?.[surfaceId]) {
      return;
    }
    delete this.persistentState.surfaceTombstones[surfaceId];
    this.tombstonedSurfaceIds.delete(asSurfaceId(surfaceId));
    this.logger.info?.(
      runtimeDiagnostic("surface_tombstone_cleared", {
        reason,
        surface_id: surfaceId,
      }),
    );
  }

  private noteProviderLineage(
    providerId: string,
    source: "current_state" | "legacy_state_root",
  ): void {
    if (!providerId) {
      return;
    }
    this.persistentState.providerLineage ??= [];
    if (this.persistentState.providerLineage.some((entry) => entry.providerId === providerId && entry.source === source)) {
      return;
    }
    this.persistentState.providerLineage.push({
      observedAt: this.now(),
      providerId,
      source,
    });
  }

  private noteSelfOwnedSurface(
    surfaceId: string,
    providerId: string,
    source:
      | "current_local_ownership"
      | "current_snapshot_local_ownership"
      | "current_target_state"
      | "current_target_ownership"
      | "legacy_local_ownership"
      | "legacy_target_state",
    observedAt = this.now(),
  ): void {
    if (!surfaceId || !providerId) {
      return;
    }
    this.persistentState.selfOwnedSurfaceIds ??= {};
    const existing = this.persistentState.selfOwnedSurfaceIds[surfaceId];
    if (existing && existing.source !== "current_target_state" && source === "current_target_state") {
      return;
    }
    const relinquishedAt = source === "current_local_ownership" ? undefined : existing?.relinquishedAt;
    this.persistentState.selfOwnedSurfaceIds[surfaceId] = {
      observedAt,
      providerId,
      source,
      ...(relinquishedAt ? { relinquishedAt } : {}),
    };
  }

  private importCurrentTargetOwnership(): void {
    for (const [surfaceId, targetState] of Object.entries(this.persistentState.targetStateBySurfaceId ?? {})) {
      const currentTargetIds = new Set(
        Object.values(targetState.paneTargets ?? {})
          .map((paneTarget) => paneTarget.currentTargetId)
          .filter((targetId): targetId is string => typeof targetId === "string" && targetId.length > 0),
      );
      if (currentTargetIds.size === 0) {
        continue;
      }
      const targetRecords = Array.isArray(targetState.targetRecords) ? targetState.targetRecords : [];
      for (const target of [...targetRecords].reverse()) {
        if (
          target.surfaceId === surfaceId &&
          target.currentState === "current" &&
          currentTargetIds.has(target.targetId) &&
          typeof target.ownerProviderId === "string" &&
          typeof target.ownershipSessionId === "string" &&
          target.ownershipSessionId.length > 0 &&
          this.isTrustedProviderLineageId(target.ownerProviderId)
        ) {
          const hadSelfOwnedSurface = Boolean(this.persistentState.selfOwnedSurfaceIds?.[surfaceId]);
          if (!hadSelfOwnedSurface) {
            this.noteSelfOwnedSurface(surfaceId, target.ownerProviderId, "current_target_ownership");
            this.startupImportedOwnershipSurfaceIds.add(surfaceId);
          }
          break;
        }
      }
    }
  }

  private markSelfOwnedSurfaceRelinquished(surfaceId: string): void {
    this.livePairedSelfRediscoveredSurfaceIds.delete(surfaceId);
    this.persistentState.selfOwnedSurfaceIds ??= {};
    const existing = this.persistentState.selfOwnedSurfaceIds[surfaceId];
    this.persistentState.selfOwnedSurfaceIds[surfaceId] = {
      observedAt: existing?.observedAt ?? this.now(),
      providerId: existing?.providerId ?? this.persistentState.providerId,
      source: existing?.source ?? "current_local_ownership",
      relinquishedAt: this.now(),
    };
  }

  private async readRuntimeStateFile(statePath: string): Promise<RuntimeStateFile | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as Partial<RuntimeStateFile>;
      if (parsed.version !== 1 || typeof parsed.providerId !== "string") {
        return null;
      }
      return {
        nextRemotePaneId: parsed.nextRemotePaneId ?? 1,
        nextPaneLabel: parsed.nextPaneLabel ?? 1,
        nextWindowLabelIndex: parsed.nextWindowLabelIndex ?? 0,
        paneLabelsByPaneId: parsed.paneLabelsByPaneId ?? {},
        providerId: parsed.providerId,
        providerLineage: parsed.providerLineage ?? [],
        selfOwnedSurfaceIds: parsed.selfOwnedSurfaceIds ?? {},
        surfaceTombstones: parsed.surfaceTombstones ?? {},
        targetStateBySurfaceId: parsed.targetStateBySurfaceId ?? {},
        tombstonedEndpointIds: parsed.tombstonedEndpointIds ?? [],
        version: 1,
        windowLabels: parsed.windowLabels ?? {},
      };
    } catch {
      return null;
    }
  }

  private async readScreenSnapshotFile(snapshotPath: string): Promise<PersistedScreenSnapshotFile | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as PersistedScreenSnapshotFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.screens)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private runtimeStateForDiagnostics(parsed: RuntimeStateFile | null): RuntimeStateFile {
    return parsed ?? {
      nextPaneLabel: 1,
      nextRemotePaneId: 1,
      nextWindowLabelIndex: 0,
      paneLabelsByPaneId: {},
      providerId: "",
      providerLineage: [],
      selfOwnedSurfaceIds: {},
      surfaceTombstones: {},
      targetStateBySurfaceId: {},
      tombstonedEndpointIds: [],
      version: 1,
      windowLabels: {},
    };
  }

  private async readPersistedRuntimeScreenIds(): Promise<Set<string>> {
    const snapshot = await this.readScreenSnapshotFile(path.join(this.stateDir, SCREEN_SNAPSHOT_FILE_NAME));
    return new Set(
      (snapshot?.screens ?? [])
        .map((screen) => screen.fingerprint)
        .filter((fingerprint): fingerprint is string => typeof fingerprint === "string" && fingerprint.length > 0),
    );
  }

  private async warnIfLegacyStateRootExists(): Promise<void> {
    const legacyDir = this.legacyStateDir;
    if (!this.warnLegacyStateRoot) {
      return;
    }
    if (path.resolve(this.stateDir) === path.resolve(legacyDir)) {
      return;
    }

    const legacyFiles: string[] = [];
    for (const fileName of LEGACY_STATE_FILE_NAMES) {
      try {
        await fs.access(path.join(legacyDir, fileName));
        legacyFiles.push(fileName);
      } catch {
        continue;
      }
    }
    if (legacyFiles.length === 0) {
      return;
    }

    this.logger.warn?.(
      `[surf-ace:runtime] found legacy Surf Ace state root ${legacyDir}; current OpenClaw extension state root is ${this.stateDir}. Trusted local legacy ownership is used only for same-gateway self-reclaim.`,
    );
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

  private allManagedSurfaces(): ManagedSurface[] {
    return [...this.surfaces.values()];
  }

  private canonicalVisibleSurfaces(): ManagedSurface[] {
    return [...this.surfaces.values()].filter((surface) => this.providerAuthorityForSurface(surface).admitted);
  }

  private listVisibleSurfaces(authoritySnapshot?: SurfAceProviderAuthoritySnapshot): ManagedSurface[] {
    return [...this.surfaces.values()].filter((surface) => {
      const authority = authoritySnapshot?.decisionsBySurfaceId.get(surface.surfaceId) ??
        this.providerAuthorityForSurface(surface);
      return authority.admitted || this.hasVisibleConnectionDiagnostic(surface);
    });
  }

  private baseProviderAuthorityForSurface(
    surface: ManagedSurface,
    _expectedProviderPid: number | null = process.pid,
    _providerProcessHealth?: SurfAceProviderProcessHealth,
  ): SurfAceProviderAuthorityDecision {
    const blockers: string[] = [];
    if (this.isStalePersistedSurfaceTombstone(surface.surfaceId)) {
      blockers.push("surface_tombstoned");
    }
    if (!this.hasAcceptedSurfaceTopology(surface)) {
      blockers.push("not_provider_admitted");
    }
    if (!this.hasVisibleAcceptedSurfaceTopology(surface)) {
      blockers.push("not_visible_accepted_topology");
    }
    if (surface.connectionState !== "connected") {
      blockers.push("not_connected");
    }
    if (!(surface.client?.isOpen() ?? false)) {
      blockers.push("socket_not_open");
    }
    if (!surface.protocolFeatures.has(AUTHORITY_STATE_PROTOCOL_FEATURE)) {
      blockers.push("authority_state_unsupported");
    }
    if (surface.panes.size === 0 || this.visiblePanes(surface).length === 0) {
      blockers.push("no_visible_panes");
    }
    const admitted = blockers.length === 0;
    return {
      actionable: admitted,
      admitted,
      blockers,
      reason: blockers[0] ?? null,
    };
  }

  private providerAuthorityForSurface(
    surface: ManagedSurface,
    expectedProviderPid: number | null = process.pid,
    providerProcessHealth?: SurfAceProviderProcessHealth,
  ): SurfAceProviderAuthorityDecision {
    const baseDecision = this.baseProviderAuthorityForSurface(
      surface,
      expectedProviderPid,
      providerProcessHealth,
    );
    const blockers = [...baseDecision.blockers];
    if (baseDecision.admitted && surface.authorityAcceptedIdentityKey !== this.authorityIdentityKey(surface)) {
      blockers.push(surface.authorityRejectedReason ?? "client_authority_unconfirmed");
    }
    const admitted = blockers.length === 0;
    return {
      actionable: admitted,
      admitted,
      blockers,
      reason: blockers[0] ?? null,
    };
  }

  private providerAuthorityForPane(surface: ManagedSurface, paneId: PaneId): SurfAceProviderAuthorityDecision {
    const surfaceDecision = this.providerAuthorityForSurface(surface);
    const blockers = [...surfaceDecision.blockers];
    if (!this.visiblePanes(surface).some((pane) => pane.paneId === paneId)) {
      blockers.push("pane_not_provider_visible");
    }
    const admitted = blockers.length === 0;
    return {
      actionable: admitted,
      admitted,
      blockers,
      reason: blockers[0] ?? null,
    };
  }

  private currentProviderProcessHealth(expectedProviderPid: number | null = process.pid): SurfAceProviderProcessHealth {
    try {
      return this.providerProcessHealth(expectedProviderPid);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn?.(
        runtimeDiagnostic("provider_process_health_unavailable", {
          reason,
        }),
      );
      return {
        duplicateProviderProcesses: false,
        liveProviderProcessCount: 0,
        pids: [],
        reason,
        source: "unavailable",
      };
    }
  }

  private providerProcessAuthorityBlockReason(
    expectedProviderPid: number | null,
    health = this.currentProviderProcessHealth(expectedProviderPid),
  ): SurfAceProviderProcessBlockReason | null {
    if (health.source === "unavailable") {
      return "provider_process_inventory_unavailable";
    }
    if (health.liveProviderProcessCount === 0) {
      return "provider_process_missing";
    }
    if (health.duplicateProviderProcesses || health.liveProviderProcessCount > 1) {
      return "duplicate_provider_processes";
    }
    if (typeof expectedProviderPid === "number" && !health.pids.includes(expectedProviderPid)) {
      return "provider_process_lease_mismatch";
    }
    return null;
  }

  private captureProviderAuthoritySnapshot(
    expectedProviderPid: number | null = process.pid,
  ): SurfAceProviderAuthoritySnapshot {
    const providerProcessHealth = this.currentProviderProcessHealth(expectedProviderPid);
    const providerProcessBlockReason = this.providerProcessAuthorityBlockReason(
      expectedProviderPid,
      providerProcessHealth,
    );
    const decisionsBySurfaceId = new Map<string, SurfAceProviderAuthorityDecision>();
    for (const surface of this.surfaces.values()) {
      decisionsBySurfaceId.set(
        surface.surfaceId,
        this.providerAuthorityForSurface(surface, expectedProviderPid, providerProcessHealth),
      );
    }
    return {
      decisionsBySurfaceId,
      expectedProviderPid,
      providerProcessBlockReason,
      providerProcessHealth,
    };
  }

  private authorityIdentityKey(surface: ManagedSurface): string {
    const panes = this.visiblePanes(surface).map((pane) =>
      `${Number(pane.remotePaneId)}:${pane.paneLabel}:${pane.paneLineageId}`
    );
    return [
      this.persistentState.providerId,
      surface.sessionId ?? "",
      surface.surfaceId,
      String(surface.ownershipEpoch),
      surface.windowLabel,
      ...panes,
    ].join("|");
  }

  private authorityProofToken(surface: ManagedSurface, pane?: ManagedPane): string {
    const authority = pane
      ? this.providerAuthorityForPane(surface, pane.paneId)
      : this.providerAuthorityForSurface(surface);
    return JSON.stringify({
      authority,
      authorityIdentityKey: this.authorityIdentityKey(surface),
      connectionState: surface.connectionState,
      pane: pane
        ? {
            paneId: pane.paneId,
            paneLabel: pane.paneLabel,
            paneLineageId: pane.paneLineageId,
            remotePaneId: Number(pane.remotePaneId),
          }
        : null,
      sessionId: surface.sessionId,
      surfaceId: surface.surfaceId,
      topologyRevision: surface.topologyRevision,
      visiblePaneIds: this.visiblePanes(surface).map((visiblePane) => visiblePane.paneId),
      wsOpen: surface.client?.isOpen() ?? false,
    });
  }

  private assertAuthorityProofUnchanged(
    surface: ManagedSurface,
    pane: ManagedPane | undefined,
    proofToken: string,
    reason: string,
  ): void {
    if (this.authorityProofToken(surface, pane) === proofToken) {
      return;
    }
    throw new SurfAceToolError(
      "not_connected",
      `Surf Ace authority changed during ${reason}; refresh surf_ace_list and retry.`,
    );
  }

  private invalidateClientAuthority(surface: ManagedSurface, reason: string): void {
    surface.authorityAcceptedAt = null;
    surface.authorityAcceptedIdentityKey = null;
    surface.authorityRejectedReason = reason;
  }

  private canRepublishAuthorityOnReattempt(surface: ManagedSurface): boolean {
    return (
      this.hasAcceptedSurfaceTopology(surface) &&
      this.hasVisibleAcceptedSurfaceTopology(surface) &&
      surface.authorityRejectedReason === "window_label_mismatch" &&
      (surface.client?.isOpen() ?? false) &&
      surface.protocolFeatures.has(AUTHORITY_STATE_PROTOCOL_FEATURE) &&
      surface.panes.size > 0 &&
      this.visiblePanes(surface).length > 0
    );
  }

  private hasVisibleConnectionDiagnostic(surface: ManagedSurface): boolean {
    if (surface.remotePaired && !this.isKnownSelfOwnedSurface(surface)) {
      return false;
    }
    if (
      this.hasAcceptedSurfaceTopology(surface) &&
      !this.isStalePersistedSurfaceTombstone(surface.surfaceId)
    ) {
      return true;
    }
    if (!this.hasCurrentDiscoveryEndpoint(surface) && !(surface.client?.isOpen() ?? false)) {
      return false;
    }
    const diagnostics = this.surfaceConnectionDiagnostics(surface);
    return diagnostics.circuitOpen || diagnostics.givenUp;
  }

  private hasVisibleAcceptedSurfaceTopology(surface: ManagedSurface): boolean {
    if (!this.hasAcceptedSurfaceTopology(surface)) {
      return false;
    }
    if (surface.client?.isOpen() ?? false) {
      return true;
    }
    if (this.hasCurrentDiscoveryEndpoint(surface)) {
      return true;
    }
    const diagnostics = this.surfaceConnectionDiagnostics(surface);
    return !diagnostics.circuitOpen &&
      !diagnostics.givenUp &&
      surface.connectionState !== "unreachable";
  }

  private hasCurrentDiscoveryEndpoint(surface: ManagedSurface): boolean {
    const endpointKey = endpointProbeKey(surface.endpoint);
    return this.dedupeDiscoveryEndpoints(this.discovery.getSnapshot()).some((endpoint) =>
      endpoint.endpointId === surface.endpointId ||
      buildWsUrl(endpoint) === buildWsUrl(surface.endpoint) ||
      endpointProbeKey(endpoint) === endpointKey
    );
  }

  private hasAcceptedSurfaceTopology(surface: ManagedSurface): boolean {
    return (
      surface.localOwnership !== null &&
      surface.localOwnership.providerId === this.persistentState.providerId &&
      surface.localOwnership.sessionId === surface.sessionId &&
      surface.localOwnership.surfaceId === surface.surfaceId &&
      surface.hasPairedInGatewaySession &&
      surface.sessionId !== null &&
      !surface.restartOwnershipPendingPair
    );
  }

  private hasProviderAuthorityContinuityOutsideRemotePanes(
    surface: ManagedSurface,
    pairRemotePaneIds: ReadonlySet<number>,
  ): boolean {
    const hasTopologyContinuity = this.visiblePanes(surface).some((pane) =>
      isBoundRemotePaneId(pane.remotePaneId) && !pairRemotePaneIds.has(Number(pane.remotePaneId))
    );
    if (hasTopologyContinuity) {
      return true;
    }
    const hasVisibleContinuity = this.visiblePanes(surface).some((pane) =>
      isBoundRemotePaneId(pane.remotePaneId) &&
      !pairRemotePaneIds.has(Number(pane.remotePaneId)) &&
      this.visibleHistoryEntry(pane) !== null
    );
    if (hasVisibleContinuity) {
      return true;
    }
    const paneLineageByRemotePaneId = new Map<number, string>();
    for (const pane of this.visiblePanes(surface)) {
      if (isBoundRemotePaneId(pane.remotePaneId)) {
        paneLineageByRemotePaneId.set(Number(pane.remotePaneId), pane.paneLineageId);
      }
    }
    const persistedTargets = this.persistentState.targetStateBySurfaceId?.[surface.surfaceId]?.targetRecords ?? [];
    const targetRecords = [
      ...surface.targetRecords.values(),
      ...persistedTargets,
    ];
    const hasTargetContinuity = targetRecords.some((target) =>
      target.surfaceId === surface.surfaceId &&
      (target.currentState === "current" || target.currentState === "stale") &&
      [...paneLineageByRemotePaneId].some(([remotePaneId, paneLineageId]) =>
        !pairRemotePaneIds.has(remotePaneId) && paneLineageId === target.paneLineageId
      )
    );
    if (hasTargetContinuity) {
      return true;
    }
    const restartContent = this.restartContentBySurface.get(surface.surfaceId) ?? [];
    return restartContent.some((entry) =>
      typeof entry.remotePaneId === "number" && !pairRemotePaneIds.has(entry.remotePaneId)
    );
  }

  private isUnownedDisconnectedGhostSurface(surface: ManagedSurface): boolean {
    return (
      surface.connectionState !== "connected" &&
      surface.autoRetryEnabled &&
      surface.connectionCircuitOpenedAt === null &&
      !(surface.client?.isOpen() ?? false) &&
      !surface.hasPairedInGatewaySession &&
      surface.remoteListedAt === null &&
      !surface.remotePaired &&
      surface.sessionId === null &&
      (
        surface.connectionState === "unreachable" ||
        surface.unreachableFailures >= UNREACHABLE_AFTER_FAILURES ||
        surface.reconnectAttempt >= UNREACHABLE_AFTER_FAILURES
      )
    );
  }

  private pruneUnownedDisconnectedGhostSurfaces(reason: string): void {
    for (const surface of [...this.surfaces.values()]) {
      if (!this.isUnownedDisconnectedGhostSurface(surface)) {
        continue;
      }
      this.logger.info?.(
        runtimeDiagnostic("unowned_disconnected_surface_pruned", {
          connection_state: surface.connectionState,
          reason,
          reconnect_attempt: surface.reconnectAttempt,
          surface_id: surface.surfaceId,
          unreachable_failures: surface.unreachableFailures,
        }),
      );
      this.removeClosedSurface(surface.surfaceId, "unowned_unreachable");
    }
  }

  private pruneStaleAcceptedSurfaces(reason: string): void {
    for (const surface of [...this.surfaces.values()]) {
      if (!this.hasAcceptedSurfaceTopology(surface) || this.hasVisibleAcceptedSurfaceTopology(surface)) {
        continue;
      }
      this.logger.info?.(
        runtimeDiagnostic("stale_accepted_surface_removed", {
          reason,
          surface_id: surface.surfaceId,
        }),
      );
      this.removeClosedSurface(surface.surfaceId, "discovery_endpoint_absent");
    }
  }

  private assertCanonicalSurfaceRegistry(reason: string): void {
    for (const [surfaceId, surface] of this.surfaces) {
      if (isProvisionalSurfaceId(surface.surfaceId) || surface.surfaceId !== surfaceId) {
        this.logger.warn?.(
          runtimeDiagnostic("canonical_surface_invariant_failed", {
            map_key: surfaceId,
            reason,
            surface_id: surface.surfaceId,
          }),
        );
        throw new SurfAceToolError("internal_error", `Surf Ace canonical surface registry invariant failed: ${reason}`);
      }
    }
  }

  private buildScreenSummaries(): SurfAceScreenSummary[] {
    this.assertCanonicalSurfaceRegistry("screen summary");
    this.pruneUnownedDisconnectedGhostSurfaces("screen summary");
    this.pruneStaleAcceptedSurfaces("screen summary");
    this.repairLiveWindowLabelInvariant("screen summary");
    this.repairLivePaneLabelInvariant("screen summary");
    const authoritySnapshot = this.captureProviderAuthoritySnapshot();
    const providerAuthorityProjection = this.buildProviderAuthorityProjection(
      this.persistentState,
      this.persistedRuntimeScreenIds,
      undefined,
      process.pid,
      authoritySnapshot,
    );
    return this.listVisibleSurfaces(authoritySnapshot)
      .sort((left, right) => this.screenSummarySortKey(left).localeCompare(this.screenSummarySortKey(right), "en"))
      .map((surface) => this.buildScreenSummary(surface, {
        authoritySnapshot,
        providerAuthorityProjection,
      }));
  }

  private screenSummarySortKey(surface: ManagedSurface): string {
    return surface.windowLabel || `~${surface.name}:${surface.surfaceId}`;
  }

  private buildScreenSummary(
    surface: ManagedSurface,
    options: {
      authoritySnapshot?: SurfAceProviderAuthoritySnapshot;
      exposeTopology?: boolean;
      providerAuthorityProjection?: SurfAceProviderAuthorityProjection;
    } = {},
  ): SurfAceScreenSummary {
    const authority = options.authoritySnapshot?.decisionsBySurfaceId.get(surface.surfaceId) ??
      this.providerAuthorityForSurface(surface);
    const providerAuthorityProjection = options.providerAuthorityProjection ??
      this.buildProviderAuthorityProjection(
        this.persistentState,
        this.persistedRuntimeScreenIds,
        undefined,
        process.pid,
        options.authoritySnapshot,
      );
    const exposeTopology = options.exposeTopology ?? (
      !authority.blockers.includes("authority_state_unsupported") &&
      !authority.blockers.includes("surface_tombstoned") &&
      (
        authority.admitted ||
        surface.connectionState === "connected" ||
        this.hasAcceptedSurfaceTopology(surface)
      )
    );
    const connectionState =
      surface.connectionState === "connected" && !authority.admitted
        ? "connecting"
        : surface.connectionState === "connected" && !(surface.client?.isOpen() ?? false)
          ? surface.autoRetryEnabled ? "connecting" : "unreachable"
          : surface.connectionState;
    return {
      connectionDiagnostics: this.surfaceConnectionDiagnostics(surface),
      authority,
      connectionState,
      fingerprint: surface.surfaceId,
      lastSeenAt: surface.lastSeenAt,
      name: surface.name,
      panes: exposeTopology ? this.visiblePaneSummaryProjections(surface)
        .map(({ pane, paneLabel }) => {
          return {
            activeContent: pane.activeContentId && pane.contentType
              ? {
                  contentId: pane.activeContentId,
                  contentType: pane.contentType,
                  ...(pane.display ? { display: structuredClone(pane.display) } : {}),
                  revision: pane.currentRevision,
                }
              : null,
            displayId: visiblePaneAddress(surface.windowLabel, paneLabel),
            historySummary: {
              ...structuredClone(pane.historySummary),
              visibleProvenance: visibleContentProvenance(pane),
            },
            name: pane.name,
            ...(pane.nativeWindowGroup ? { nativeWindowGroup: structuredClone(pane.nativeWindowGroup) } : {}),
            paneAddress: visiblePaneAddress(surface.windowLabel, paneLabel),
            paneId: pane.paneId,
            paneLabel,
            target: this.paneTargetDiagnostic(surface, pane, paneLabel),
            viewport: viewportFromResolvedPaneGeometry(pane),
          };
        }) : [],
      pendingEvents: this.pendingEventCount(surface),
      topology: exposeTopology ? managedLayoutToSummary(surface.layout) : null,
      topologyRevision: exposeTopology ? surface.topologyRevision : 0,
      viewport: cloneViewport(surface.viewport),
      windowLabel: exposeTopology ? surface.windowLabel : "",
      _debug: {
        autoRetryEnabled: surface.autoRetryEnabled,
        connectionCircuit: this.surfaceConnectionDiagnostics(surface),
        endpointId: surface.endpointId,
        hasPairedInGatewaySession: surface.hasPairedInGatewaySession,
        localOwnership: surface.localOwnership
          ? structuredClone(surface.localOwnership)
          : null,
        ownershipRecovery: surface.hasPairedInGatewaySession
          ? "active"
          : this.isKnownSelfOwnedSurface(surface) ? "known_self" : "foreign_or_unknown",
        reconnectAttempt: surface.reconnectAttempt,
        remoteOwnership: surface.remotePairObservation
          ? structuredClone(surface.remotePairObservation)
          : null,
        remoteListedAt: surface.remoteListedAt,
        remotePaired: surface.remotePaired,
        sessionId: surface.sessionId,
        unreachableFailures: surface.unreachableFailures,
        wsOpen: surface.client?.isOpen() ?? false,
        providerAuthority: authority,
        providerAuthorityProjection,
        runtimeAppBinding: surface.runtimeAppBinding ? structuredClone(surface.runtimeAppBinding) : null,
      },
    };
  }

  private buildProviderAuthorityProjection(
    state: RuntimeStateFile = this.persistentState,
    runtimeScreenIdsInput: Set<string> = this.persistedRuntimeScreenIds,
    ownerStatusOverride?: "active" | "passive" | "stopped",
    expectedProviderPid: number | null = process.pid,
    authoritySnapshot?: SurfAceProviderAuthoritySnapshot,
  ): SurfAceProviderAuthorityProjection {
    const snapshot = authoritySnapshot?.expectedProviderPid === expectedProviderPid
      ? authoritySnapshot
      : this.captureProviderAuthoritySnapshot(expectedProviderPid);
    const providerProcessHealth = snapshot.providerProcessHealth;
    const providerProcessBlockReason = snapshot.providerProcessBlockReason;
    const liveSurfaceIds = [...this.surfaces.keys()].sort();
    const persistedSelfOwnedSurfaceIds = Object.keys(state.selfOwnedSurfaceIds ?? {}).sort();
    const targetStateSurfaceIds = Object.keys(state.targetStateBySurfaceId ?? {}).sort();
    const windowLabelSurfaceIds = Object.keys(state.windowLabels ?? {}).sort();
    const persistedSurfaceIds = [...new Set([
      ...persistedSelfOwnedSurfaceIds,
      ...targetStateSurfaceIds,
      ...windowLabelSurfaceIds,
      ...Object.keys(state.surfaceTombstones ?? {}),
    ])].sort();
    const runtimeScreenIds = [...runtimeScreenIdsInput].sort();
    let activeTargetRecordCount = 0;
    for (const targetState of Object.values(state.targetStateBySurfaceId ?? {})) {
      activeTargetRecordCount += (targetState.targetRecords ?? []).filter((record) => record.currentState === "current").length;
    }
    const authorityBlockersBySurfaceId: Record<string, string[]> = {};
    const authorityBlockedSurfaceIds: string[] = [];
    const runtimeAppBindingBySurfaceId: Record<string, RuntimeAppBindingDiagnostics | null> = {};
    for (const surface of this.surfaces.values()) {
      const authority = snapshot.decisionsBySurfaceId.get(surface.surfaceId) ??
        this.providerAuthorityForSurface(surface, expectedProviderPid, providerProcessHealth);
      authorityBlockersBySurfaceId[surface.surfaceId] = authority.blockers;
      runtimeAppBindingBySurfaceId[surface.surfaceId] = surface.runtimeAppBinding
        ? structuredClone(surface.runtimeAppBinding)
        : null;
      if (!authority.admitted) {
        authorityBlockedSurfaceIds.push(surface.surfaceId);
      }
    }
    authorityBlockedSurfaceIds.sort();
    return {
      activeTargetRecordCount,
      authorityBlockedSurfaceIds,
      authorityBlockersBySurfaceId,
      disabled: !this.ownsRuntimeLease,
      liveSurfaceIds,
      nextRemotePaneId: state.nextRemotePaneId,
      ownerStatus: ownerStatusOverride ?? (this.started ? (this.ownsRuntimeLease ? "active" : "passive") : "stopped"),
      ownsRuntimeLease: this.ownsRuntimeLease,
      persistedSelfOwnedSurfaceIds,
      persistedSurfaceIds,
      processId: process.pid,
      providerProcessBlockReason,
      providerProcessHealth,
      providerId: state.providerId,
      runtimeAppBindingBySurfaceId,
      runtimeScreenIds,
      started: this.started,
      surfaceTombstones: structuredClone(state.surfaceTombstones ?? {}),
      targetStateSurfaceIds,
      windowLabelSurfaceIds,
    };
  }

  private surfaceConnectionDiagnostics(surface: ManagedSurface): SurfAceConnectionDiagnostics {
    return this.connectionDiagnostics({
      autoRetryEnabled: surface.autoRetryEnabled,
      connectionCircuitOpenedAt: surface.connectionCircuitOpenedAt,
      connectionCircuitReason: surface.connectionCircuitReason,
      reconnectAttempt: surface.reconnectAttempt,
      unreachableFailures: surface.unreachableFailures,
    });
  }

  private endpointProbeConnectionDiagnostics(probe: EndpointProbe): SurfAceConnectionDiagnostics {
    return this.connectionDiagnostics({
      autoRetryEnabled: probe.autoRetryEnabled,
      connectionCircuitOpenedAt: probe.connectionCircuitOpenedAt,
      connectionCircuitReason: probe.connectionCircuitReason,
      reconnectAttempt: probe.reconnectAttempt,
      unreachableFailures: probe.unreachableFailures,
    });
  }

  private connectionDiagnostics(input: {
    autoRetryEnabled: boolean;
    connectionCircuitOpenedAt: number | null;
    connectionCircuitReason: string | null;
    reconnectAttempt: number;
    unreachableFailures: number;
  }): SurfAceConnectionDiagnostics {
    const circuitOpen = input.connectionCircuitOpenedAt !== null;
    const givenUp = circuitOpen && !input.autoRetryEnabled;
    return {
      circuitOpen,
      circuitState: givenUp ? "given_up" : circuitOpen ? "open" : "closed",
      failureCount: input.unreachableFailures,
      givenUp,
      openedAt: input.connectionCircuitOpenedAt,
      reason: input.connectionCircuitReason,
      reconnectAttempt: input.reconnectAttempt,
    };
  }

  private async persistState(): Promise<void> {
    this.stateWrite = this.stateWrite
      .catch(() => {})
      .then(async () => {
        await this.stateRepository.save(this.persistentState);
      });
    await this.stateWrite;
  }

  private captureSurfaceTargetState(surface: ManagedSurface): void {
    this.persistentState.targetStateBySurfaceId ??= {};
    const lifecycleEvents =
      this.persistentState.targetStateBySurfaceId[surface.surfaceId]?.lifecycleEvents ?? [];
    const retainedTargetIds = new Set<string>();
    for (const target of surface.targetRecords.values()) {
      if (target.currentState === "current" || target.currentState === "stale") {
        retainedTargetIds.add(target.targetId);
      }
    }
    for (const pane of surface.panes.values()) {
      if (pane.currentTargetId) {
        retainedTargetIds.add(pane.currentTargetId);
      }
      if (pane.staleTargetId) {
        retainedTargetIds.add(pane.staleTargetId);
      }
      for (const entry of pane.historyEntries) {
        if (entry.targetId) {
          retainedTargetIds.add(entry.targetId);
        }
      }
    }
    for (const targetId of surface.registeredTargetIdsByIdempotencyKey.values()) {
      retainedTargetIds.add(targetId);
    }
    this.persistentState.targetStateBySurfaceId[surface.surfaceId] = {
      lifecycleEvents: lifecycleEvents.slice(-100),
      ownershipEpoch: surface.ownershipEpoch,
      paneTargets: Object.fromEntries(
        [...surface.panes.values()].map((pane) => [
          pane.paneLineageId,
          {
            currentTargetId: pane.currentTargetId,
            diagnosticContent: pane.diagnosticContent ? structuredClone(pane.diagnosticContent) : null,
            lastRestoreBlockedReason: pane.lastRestoreBlockedReason,
            nonDurableTargetDiagnostic: pane.nonDurableTargetDiagnostic
              ? structuredClone(pane.nonDurableTargetDiagnostic)
              : null,
            paneLineageId: pane.paneLineageId,
            staleTargetId: pane.staleTargetId,
            targetEpoch: pane.targetEpoch,
          },
        ]),
      ),
      registeredTargetIdsByIdempotencyKey: Object.fromEntries(surface.registeredTargetIdsByIdempotencyKey),
      targetRecords: [...surface.targetRecords.values()]
        .filter((record) => retainedTargetIds.has(record.targetId))
        .map((record) => structuredClone(record)),
    };
  }

  private async persistSurfaceTargetState(surface: ManagedSurface, reason: string): Promise<void> {
    this.captureSurfaceTargetState(surface);
    this.recordTargetLifecycleEvent(surface, { event: "persist", reason });
    this.logger.info?.(
      runtimeDiagnostic("target_lifecycle_persist", {
        reason,
        surface_id: surface.surfaceId,
        target_record_count: surface.targetRecords.size,
      }),
    );
    await this.persistState();
    await this.persistScreenSnapshot();
  }

  private async persistSurfaceTargetStateImmediately(surface: ManagedSurface, reason: string): Promise<void> {
    this.captureSurfaceTargetState(surface);
    this.recordTargetLifecycleEvent(surface, { event: "persist", reason });
    this.logger.info?.(
      runtimeDiagnostic("target_lifecycle_persist", {
        reason,
        surface_id: surface.surfaceId,
        target_record_count: surface.targetRecords.size,
      }),
    );
    await this.persistState();
    await this.persistScreenSnapshot();
  }

  private recordTargetLifecycleEvent(
    surface: ManagedSurface,
    event: Omit<PersistedTargetLifecycleEvent, "recordedAt">,
  ): void {
    this.persistentState.targetStateBySurfaceId ??= {};
    const recordedEvent = this.recordTargetLifecycleEventForSurfaceId(surface.surfaceId, event);
    const persisted = this.persistentState.targetStateBySurfaceId[surface.surfaceId] ?? {
      paneTargets: {},
      registeredTargetIdsByIdempotencyKey: {},
      targetRecords: [],
    };
    const lifecycleEvents = persisted.lifecycleEvents ?? [];
    lifecycleEvents.push(recordedEvent);
    persisted.lifecycleEvents = lifecycleEvents.slice(-100);
    this.persistentState.targetStateBySurfaceId[surface.surfaceId] = persisted;
  }

  private recordTargetLifecycleEventForSurfaceId(
    surfaceId: SurfaceId | string,
    event: Omit<PersistedTargetLifecycleEvent, "recordedAt">,
  ): PersistedTargetLifecycleEvent {
    this.persistentState.targetLifecycleEventsBySurfaceId ??= {};
    const recordedEvent = { ...event, recordedAt: this.now() };
    const lifecycleEvents = this.persistentState.targetLifecycleEventsBySurfaceId[surfaceId] ?? [];
    lifecycleEvents.push(recordedEvent);
    this.persistentState.targetLifecycleEventsBySurfaceId[surfaceId] = lifecycleEvents.slice(-100);
    return recordedEvent;
  }

  private hydrateSurfaceTargetState(
    surface: ManagedSurface,
    resumed: boolean,
    previousOwnership?: {
      ownershipEpoch: number;
      sessionId: SessionId | null;
    },
    pairImportedRemotePaneIds: Set<number> = new Set(),
  ): void {
    const persisted = this.persistentState.targetStateBySurfaceId?.[surface.surfaceId];
    if (!persisted) {
      return;
    }
    this.recordTargetLifecycleEvent(surface, {
      event: "hydrate",
      reason: pairImportedRemotePaneIds.size > 0 ? "pair response import" : "surface target hydrate",
    });
    this.logger.info?.(
      runtimeDiagnostic("target_lifecycle_hydrate", {
        pair_imported_pane_count: pairImportedRemotePaneIds.size,
        surface_id: surface.surfaceId,
        target_record_count: persisted.targetRecords.length,
      }),
    );
    surface.targetRecords = new Map(
      persisted.targetRecords.map((record) => {
        const hydrated = structuredClone(record);
        if (!hydrated.lastSuccessfulApplyEvidence && hydrated.lastApplyEvidence?.status === "applied") {
          hydrated.lastSuccessfulApplyEvidence = structuredClone(hydrated.lastApplyEvidence);
        }
        return [hydrated.targetId, hydrated];
      }),
    );
    surface.registeredTargetIdsByIdempotencyKey = new Map(
      Object.entries(persisted.registeredTargetIdsByIdempotencyKey ?? {}),
    );
    let staleTargetStateChanged = false;
    const staleReasonCounts = new Map<TargetErrorCode, number>();
    const recordStaleReason = (reason: TargetErrorCode): void => {
      staleReasonCounts.set(reason, (staleReasonCounts.get(reason) ?? 0) + 1);
    };
    const markImportedPaneTargetRecordsStale = (pane: ManagedPane): void => {
      for (const target of surface.targetRecords.values()) {
        if (
          target.currentState !== "current" ||
          target.surfaceId !== surface.surfaceId ||
          target.paneLineageId !== pane.paneLineageId
        ) {
          continue;
        }
        recordStaleReason("restore_blocked_stale_target");
        staleTargetStateChanged = this.markTargetStale(
          surface,
          target,
          "restore_blocked_stale_target",
          "Pair response imported authoritative provider pane state",
          pane,
        ) || staleTargetStateChanged;
      }
    };
    for (const pane of surface.panes.values()) {
      const paneTarget = persisted.paneTargets[pane.paneLineageId];
      if (!paneTarget) {
        if (pairImportedRemotePaneIds.has(Number(pane.remotePaneId))) {
          markImportedPaneTargetRecordsStale(pane);
        }
        pane.currentTargetId = null;
        pane.lastRestoreBlockedReason = null;
        pane.nonDurableTargetDiagnostic = null;
        pane.staleTargetId = null;
        pane.targetEpoch = 0;
        continue;
      }
      pane.currentTargetId = paneTarget.currentTargetId;
      pane.staleTargetId = paneTarget.staleTargetId ?? null;
      pane.diagnosticContent = paneTarget.diagnosticContent ? structuredClone(paneTarget.diagnosticContent) : null;
      pane.lastRestoreBlockedReason = paneTarget.lastRestoreBlockedReason;
      pane.nonDurableTargetDiagnostic = paneTarget.nonDurableTargetDiagnostic
        ? structuredClone(paneTarget.nonDurableTargetDiagnostic)
        : null;
      pane.targetEpoch = paneTarget.targetEpoch;
      if (pane.currentTargetId !== null) {
        pane.pairImportedContentAuthority = false;
      }
      if (pairImportedRemotePaneIds.has(Number(pane.remotePaneId))) {
        markImportedPaneTargetRecordsStale(pane);
        if (pane.currentTargetId) {
          const target = surface.targetRecords.get(pane.currentTargetId);
          if (target) {
            recordStaleReason("restore_blocked_stale_target");
            staleTargetStateChanged = this.markTargetStale(
              surface,
              target,
              "restore_blocked_stale_target",
              "Pair response imported authoritative provider pane state",
              pane,
            ) || staleTargetStateChanged;
          } else {
            pane.currentTargetId = null;
            pane.lastRestoreBlockedReason = null;
          }
        }
        pane.diagnosticContent = null;
        pane.nonDurableTargetDiagnostic = null;
        continue;
      }
      if (pane.currentTargetId) {
        const target = surface.targetRecords.get(pane.currentTargetId);
        if (
          target &&
          target.currentState === "current" &&
          (target.surfaceId !== surface.surfaceId ||
            target.paneLineageId !== pane.paneLineageId ||
            target.ownershipSessionId !== (surface.sessionId ?? "") ||
            target.ownershipEpoch !== surface.ownershipEpoch)
        ) {
          if (this.rebindCurrentSelfTargetOwnership(
            surface,
            target,
            pane,
            surface.sessionId ?? "",
            surface.ownershipEpoch,
            {
              previousOwnershipEpoch: previousOwnership?.ownershipEpoch ?? -1,
              previousSessionId: previousOwnership?.sessionId ?? null,
            },
          )) {
            staleTargetStateChanged = true;
            continue;
          }
          const reason = target.ownershipEpoch !== surface.ownershipEpoch
            ? "ownership_epoch_mismatch"
            : target.ownershipSessionId !== (surface.sessionId ?? "")
              ? "ownership_session_mismatch"
              : "restore_blocked_stale_target";
          recordStaleReason(reason);
          staleTargetStateChanged = this.markTargetStale(
            surface,
            target,
            reason,
            "Target authority is stale for the current surface ownership or pane lineage",
            pane,
          ) || staleTargetStateChanged;
        }
      }
    }
    for (const pane of surface.panes.values()) {
      staleTargetStateChanged = this.markAmbiguousProviderPaneAuthorityStale(surface, pane) || staleTargetStateChanged;
    }
    for (const target of surface.targetRecords.values()) {
      if (target.currentState !== "current") {
        continue;
      }
      const matchingPane = [...surface.panes.values()].find((pane) => pane.paneLineageId === target.paneLineageId);
      if (
        target.surfaceId !== surface.surfaceId ||
        target.ownershipSessionId !== (surface.sessionId ?? "") ||
        target.ownershipEpoch !== surface.ownershipEpoch ||
        !matchingPane
      ) {
        if (this.rebindCurrentSelfTargetOwnership(
          surface,
          target,
          matchingPane,
          surface.sessionId ?? "",
          surface.ownershipEpoch,
          {
            previousOwnershipEpoch: previousOwnership?.ownershipEpoch ?? -1,
            previousSessionId: previousOwnership?.sessionId ?? null,
          },
        )) {
          staleTargetStateChanged = true;
          continue;
        }
        const reason = target.ownershipEpoch !== surface.ownershipEpoch
          ? "ownership_epoch_mismatch"
          : target.ownershipSessionId !== (surface.sessionId ?? "")
            ? "ownership_session_mismatch"
            : "restore_blocked_stale_target";
        recordStaleReason(reason);
        staleTargetStateChanged = this.markTargetStale(
          surface,
          target,
          reason,
          "Target authority is stale for the current surface ownership or pane lineage",
          matchingPane,
        ) || staleTargetStateChanged;
      }
    }
    if (staleTargetStateChanged) {
      this.runBackgroundTask("persist stale target state after hydrate", async () => {
        await this.persistSurfaceTargetState(surface, "stale target hydrate");
      });
    }
    const targetStateCounts = [...surface.targetRecords.values()].reduce(
      (counts, target) => {
        counts[target.currentState] = (counts[target.currentState] ?? 0) + 1;
        return counts;
      },
      {} as Record<PaneTargetRecord["currentState"], number>,
    );
    this.logger.info?.(
      runtimeDiagnostic("target_lifecycle_hydrate_result", {
        current_target_count: targetStateCounts.current ?? 0,
        pair_imported_pane_count: pairImportedRemotePaneIds.size,
        pane_count: surface.panes.size,
        stale_reason_counts: [...staleReasonCounts.entries()]
          .map(([reason, count]) => `${reason}:${count}`)
          .join(","),
        stale_target_count: targetStateCounts.stale ?? 0,
        surface_id: surface.surfaceId,
        target_record_count: surface.targetRecords.size,
        tombstoned_target_count: targetStateCounts.tombstoned ?? 0,
      }),
    );
  }

  private renamePersistedSurfaceTargetState(previousSurfaceId: string, nextSurfaceId: string): void {
    if (previousSurfaceId === nextSurfaceId) {
      return;
    }
    const targetStateBySurfaceId = this.persistentState.targetStateBySurfaceId;
    const persisted = targetStateBySurfaceId?.[previousSurfaceId];
    if (!targetStateBySurfaceId || !persisted || targetStateBySurfaceId[nextSurfaceId]) {
      return;
    }
    targetStateBySurfaceId[nextSurfaceId] = persisted;
    delete targetStateBySurfaceId[previousSurfaceId];
  }

  private migrateRestartContinuity(
    previousSurfaceId: string,
    nextSurfaceId: string,
    preserveTrustedContinuity: boolean,
  ): void {
    if (previousSurfaceId === nextSurfaceId) {
      return;
    }
    if (preserveTrustedContinuity && !this.restartSnapshots.has(nextSurfaceId)) {
      const snapshot = this.restartSnapshots.get(previousSurfaceId);
      if (snapshot) {
        this.restartSnapshots.set(nextSurfaceId, {
          ...snapshot,
          fingerprint: nextSurfaceId,
        });
      }
    }
    this.restartSnapshots.delete(previousSurfaceId);
    if (this.restartTopologyRestoredSurfaceIds.delete(previousSurfaceId)) {
      this.restartTopologyRestoredSurfaceIds.add(nextSurfaceId);
    }

    if (preserveTrustedContinuity && !this.restartContentBySurface.has(nextSurfaceId)) {
      const content = this.restartContentBySurface.get(previousSurfaceId);
      if (content) {
        this.restartContentBySurface.set(nextSurfaceId, structuredClone(content));
      }
    }
    this.restartContentBySurface.delete(previousSurfaceId);
  }

  private async loadPersistedScreenSnapshot(): Promise<SurfAceScreenSummary[]> {
    const snapshotFile = await this.loadPersistedScreenSnapshotFile();
    const ownerLease = this.ownsRuntimeLease ? {} : await this.readRuntimeLease();
    if (
      snapshotFile &&
      typeof ownerLease.startedAt === "number" &&
      typeof snapshotFile.updatedAt === "number" &&
      snapshotFile.updatedAt < ownerLease.startedAt
    ) {
      return [];
    }
    return this.applyProviderProcessHealthToPersistedScreens(
      this.repairPersistedScreenSummaryLabels(
        this.filterPersistedVisibleScreens(snapshotFile?.screens ?? []),
      ),
      typeof ownerLease.pid === "number" ? ownerLease.pid : null,
    );
  }

  private applyProviderProcessHealthToPersistedScreens(
    screens: SurfAceScreenSummary[],
    expectedProviderPid: number | null,
  ): SurfAceScreenSummary[] {
    const providerAuthorityProjection = this.buildProviderAuthorityProjection(
      this.persistentState,
      this.persistedRuntimeScreenIds,
      "passive",
      expectedProviderPid,
    );
    return screens.map((screen) => {
      const authorityBlockers = screen.authority?.blockers ?? [];
      const durableBlockers = authorityBlockers.filter((blocker) => !PROVIDER_PROCESS_BLOCK_REASONS.has(blocker));
      const processOnlyAuthority =
        screen.authority?.actionable === false &&
        (
          (screen.authority.reason ? PROVIDER_PROCESS_BLOCK_REASONS.has(screen.authority.reason) : false) ||
          authorityBlockers.some((blocker) => PROVIDER_PROCESS_BLOCK_REASONS.has(blocker))
        ) &&
        durableBlockers.length === 0;
      const authority = processOnlyAuthority
        ? {
            actionable: true,
            admitted: true,
            blockers: [],
            reason: null,
          }
        : durableBlockers.length !== authorityBlockers.length
          ? {
              actionable: false,
              admitted: false,
              blockers: durableBlockers,
              reason: durableBlockers[0] ?? screen.authority.reason,
            }
          : screen.authority;
      const connectionDiagnostics =
        screen.connectionDiagnostics?.reason &&
        PROVIDER_PROCESS_BLOCK_REASONS.has(screen.connectionDiagnostics.reason)
          ? {
              ...screen.connectionDiagnostics,
              reason: null,
            }
          : screen.connectionDiagnostics;
      return {
        ...screen,
        authority,
        connectionDiagnostics,
        connectionState: processOnlyAuthority && screen.panes.length > 0 ? "connected" : screen.connectionState,
        _debug: screen._debug
          ? {
              ...screen._debug,
              providerAuthority: authority,
              providerAuthorityProjection,
            }
          : screen._debug,
      };
    });
  }

  private filterPersistedVisibleScreens(screens: SurfAceScreenSummary[]): SurfAceScreenSummary[] {
    return screens.filter((screen) => {
      const trustedSelfOwned = this.hasTrustedPersistedSelfOwnership(screen);
      const diagnosticVisible = screen.connectionDiagnostics?.circuitOpen === true ||
        screen.connectionDiagnostics?.givenUp === true;
      const foreignRemotePaired = screen._debug?.remotePaired === true && !trustedSelfOwned;
      return trustedSelfOwned || (diagnosticVisible && !foreignRemotePaired);
    });
  }

  private repairPersistedScreenSummaryLabels(screens: SurfAceScreenSummary[]): SurfAceScreenSummary[] {
    const usedWindowLabels = new Set<string>();
    let nextWindowLabelIndex = 0;
    const nextAvailableWindowLabel = (): string => {
      let windowLabel = windowLabelForIndex(nextWindowLabelIndex);
      while (usedWindowLabels.has(windowLabel)) {
        nextWindowLabelIndex += 1;
        windowLabel = windowLabelForIndex(nextWindowLabelIndex);
      }
      return windowLabel;
    };

    const usedPaneLabels = new Set<number>();
    let nextPaneLabel = 1;
    const nextAvailablePaneLabel = (): number => {
      const paneLabel = firstAvailablePaneLabel(usedPaneLabels, nextPaneLabel);
      nextPaneLabel = paneLabel + 1;
      return paneLabel;
    };

    return screens.map((screen) => {
      let windowLabel = screen.windowLabel;
      const isDiagnosticOnly = screen.panes.length === 0 &&
        screen.topology === null &&
        (screen.connectionDiagnostics?.circuitOpen === true || screen.connectionDiagnostics?.givenUp === true);
      if (isDiagnosticOnly && !windowLabel) {
        windowLabel = "";
      } else if (!isProviderWindowLabel(windowLabel) || usedWindowLabels.has(windowLabel)) {
        windowLabel = nextAvailableWindowLabel();
      }
      if (windowLabel) {
        usedWindowLabels.add(windowLabel);
        while (usedWindowLabels.has(windowLabelForIndex(nextWindowLabelIndex))) {
          nextWindowLabelIndex += 1;
        }
      }

      const panes = screen.panes.map((pane) => {
        const paneLabel = Number.isInteger(pane.paneLabel) &&
          pane.paneLabel > 0 &&
          !usedPaneLabels.has(pane.paneLabel)
          ? pane.paneLabel
          : nextAvailablePaneLabel();
        usedPaneLabels.add(paneLabel);
        nextPaneLabel = Math.max(nextPaneLabel, paneLabel + 1);
        const displayId = visiblePaneAddress(windowLabel, paneLabel);
        return {
          ...pane,
          displayId,
          paneAddress: displayId,
          paneLabel,
        };
      });

        return {
          ...screen,
          connectionDiagnostics: screen.connectionDiagnostics ?? {
            circuitOpen: false,
            circuitState: "closed",
            failureCount: screen._debug?.unreachableFailures ?? 0,
            givenUp: false,
            openedAt: null,
            reason: null,
            reconnectAttempt: screen._debug?.reconnectAttempt ?? 0,
          },
          panes,
          windowLabel,
        };
    });
  }

  private async loadPersistedScreenSnapshotFile(): Promise<PersistedScreenSnapshotFile | null> {
    const snapshotPath = path.join(this.stateDir, SCREEN_SNAPSHOT_FILE_NAME);
    try {
      const raw = await fs.readFile(snapshotPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedScreenSnapshotFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.screens)) {
        this.persistedRuntimeScreenIds = new Set();
        return null;
      }
      this.persistedRuntimeScreenIds = new Set(
        parsed.screens
          .map((screen) => screen.fingerprint)
          .filter((fingerprint): fingerprint is string => typeof fingerprint === "string" && fingerprint.length > 0),
      );
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
            target: pane.target ?? null,
          })),
        })),
      };
    } catch {
      this.persistedRuntimeScreenIds = new Set();
      return null;
    }
  }

  private async refreshPersistedRuntimeScreenIds(): Promise<void> {
    const snapshotPath = path.join(this.stateDir, SCREEN_SNAPSHOT_FILE_NAME);
    try {
      const raw = await fs.readFile(snapshotPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedScreenSnapshotFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.screens)) {
        this.persistedRuntimeScreenIds = new Set();
        return;
      }
      this.persistedRuntimeScreenIds = new Set(
        parsed.screens
          .map((screen) => screen.fingerprint)
          .filter((fingerprint): fingerprint is string => typeof fingerprint === "string" && fingerprint.length > 0),
      );
    } catch {
      this.persistedRuntimeScreenIds = new Set();
    }
  }

  private async loadRestartSnapshots(): Promise<void> {
    const snapshotFile = await this.loadPersistedScreenSnapshotFile();
    const screens = snapshotFile?.screens ?? [];
    const trustedRestartScreens = screens.filter((screen) =>
      this.hasTrustedPersistedSelfOwnership(screen)
    );
    const trustedSurfaceIds = new Set(trustedRestartScreens.map((screen) => screen.fingerprint));
    this.restartSnapshots = new Map(trustedRestartScreens.map((screen) => [screen.fingerprint, screen]));
    this.restartContentBySurface = new Map(
      Object.entries(snapshotFile?.contentContinuity ?? {})
        .filter(([surfaceId]) => trustedSurfaceIds.has(surfaceId)),
    );
    this.logger.info?.(
      runtimeDiagnostic("persisted_snapshot_read", {
        content_continuity_keys: Object.keys(snapshotFile?.contentContinuity ?? {}).sort().join(",") || "none",
        provider_id: this.persistentState.providerId,
        screen_count: screens.length,
        screens: screens
          .map((screen) =>
            `${screen.fingerprint}:${screen.panes.length}:${screen.topologyRevision}:${screen._debug?.localOwnership?.providerId ?? "nil"}:${screen._debug?.localOwnership?.sessionId ?? "nil"}`,
          )
          .join("|") || "none",
        state_dir: this.stateDir,
        trusted_count: trustedRestartScreens.length,
        trusted_surface_ids: [...trustedSurfaceIds].sort().join(",") || "none",
      }),
    );
  }

  private isTrustedRestartScreen(screen: SurfAceScreenSummary): boolean {
    return this.hasTrustedLocalOwnershipProvenanceForProvider(screen, this.persistentState.providerId);
  }

  private hasTrustedPersistedSelfOwnership(screen: SurfAceScreenSummary): boolean {
    if (this.hasTrustedLocalOwnershipProvenanceForProvider(screen, this.persistentState.providerId)) {
      return true;
    }
    const ownership = this.persistentState.selfOwnedSurfaceIds?.[screen.fingerprint];
    return Boolean(
      ownership &&
        !ownership.relinquishedAt &&
        ownership.source !== "current_target_state" &&
        this.isTrustedProviderLineageId(ownership.providerId),
    );
  }

  private hasTrustedLocalOwnershipProvenanceForProvider(screen: SurfAceScreenSummary, providerId: string): boolean {
    return (
      screen._debug?.hasPairedInGatewaySession === true &&
      screen._debug?.localOwnership !== undefined &&
      screen._debug.localOwnership !== null &&
      screen._debug.localOwnership.providerId === providerId &&
      screen._debug.localOwnership.sessionId === screen._debug.sessionId &&
      screen._debug.localOwnership.source === "pair.response" &&
      screen._debug.localOwnership.surfaceId === screen.fingerprint &&
      typeof screen._debug.sessionId === "string" &&
      screen._debug.sessionId.length > 0
    );
  }

  private restoreRestartOwnership(surface: ManagedSurface): void {
    if (this.hasAcceptedSurfaceTopology(surface)) {
      this.logger.info?.(
        runtimeDiagnostic("restart_restore_skipped", {
          reason: "accepted_topology_already_present",
          surface_id: surface.surfaceId,
        }),
      );
      return;
    }
    const snapshot = this.restartSnapshots.get(surface.surfaceId);
    if (!snapshot || !(this.isTrustedRestartScreen(snapshot) || this.hasTrustedPersistedSelfOwnership(snapshot))) {
      this.logger.info?.(
        runtimeDiagnostic("restart_restore_skipped", {
          reason: !snapshot ? "no_trusted_snapshot" : "untrusted_local_ownership",
          surface_id: surface.surfaceId,
        }),
      );
      return;
    }
    const sessionId = snapshot._debug?.sessionId as string;
    surface.hasPairedInGatewaySession = true;
    surface.restartOwnershipPendingPair = true;
    surface.sessionId = asSessionId(sessionId);
    const localOwnership = snapshot._debug?.localOwnership;
    surface.localOwnership = localOwnership
      ? structuredClone(localOwnership)
      : null;
    if (!surface.windowLabel && snapshot.windowLabel) {
      surface.windowLabel = snapshot.windowLabel;
    }
    this.logger.info?.(
      runtimeDiagnostic("restart_restore_begin", {
        bootstrap_pane_count: surface.panes.size,
        bootstrap_pane_ids: [...surface.panes.keys()].join(","),
        content_continuity_count: this.restartContentBySurface.get(surface.surfaceId)?.length ?? 0,
        session_id: sessionId,
        snapshot_pane_count: snapshot.panes.length,
        snapshot_pane_ids: snapshot.panes.map((pane) => pane.paneId).join(","),
        snapshot_topology_revision: snapshot.topologyRevision,
        surface_id: surface.surfaceId,
      }),
    );
    this.restoreRestartTopology(surface, snapshot);
    this.restartSnapshots.delete(surface.surfaceId);
    this.queuePersistScreenSnapshot("restart ownership pending pair");
    this.logger.info?.(
      runtimeDiagnostic("restart_ownership_restored", {
        pane_count: surface.panes.size,
        pane_ids: [...surface.panes.keys()].join(","),
        restart_topology_restored: this.restartTopologyRestoredSurfaceIds.has(surface.surfaceId),
        session_id: sessionId,
        surface_id: surface.surfaceId,
        topology_revision: surface.topologyRevision,
      }),
    );
  }

  private restoreRestartProviderAuthorityBeforePair(surface: ManagedSurface): void {
    if (this.restartTopologyRestoredSurfaceIds.has(surface.surfaceId)) {
      return;
    }
    this.restoreRestartOwnership(surface);
    if (this.restartTopologyRestoredSurfaceIds.has(surface.surfaceId)) {
      return;
    }
    const snapshot = this.restartSnapshots.get(surface.surfaceId);
    if (snapshot && this.hasTrustedPersistedSelfOwnership(snapshot)) {
      this.restoreRestartTopology(surface, snapshot);
      return;
    }
    const entries = this.restartContentBySurface.get(surface.surfaceId) ?? [];
    if (entries.length <= 1) {
      return;
    }
    const paneTargets = this.persistentState.targetStateBySurfaceId?.[surface.surfaceId]?.paneTargets ?? {};
    const targetRecords = this.persistentState.targetStateBySurfaceId?.[surface.surfaceId]?.targetRecords ?? [];
    surface.panes = new Map();
    for (const entry of entries) {
      const paneId = asPaneId(`pn_restart_${surface.surfaceId}_${entry.paneLabel}`);
      const remotePaneId = this.allocateRemotePaneId();
      const pane = createPane(paneId, entry.paneLabel, remotePaneId, DEFAULT_VIEWPORT);
      const persistedPaneTarget = Object.values(paneTargets).find((target) =>
        target.currentTargetId === entry.contentId ||
        target.staleTargetId === entry.contentId
      );
      const targetRecord = targetRecords.find((target) =>
        Number(target.paneLabelAtApply) === entry.paneLabel
      );
      if (persistedPaneTarget?.paneLineageId) {
        pane.paneLineageId = persistedPaneTarget.paneLineageId;
      } else if (targetRecord?.paneLineageId) {
        pane.paneLineageId = targetRecord.paneLineageId;
      }
      surface.panes.set(pane.paneId, pane);
    }
    const panes = [...surface.panes.values()].sort((left, right) => left.paneLabel - right.paneLabel);
    surface.layout = panes.length === 1
      ? { paneId: panes[0]!.paneId, type: "pane" }
      : { children: panes.map((pane) => ({ paneId: pane.paneId, type: "pane" as const })), direction: "vertical", type: "split" };
    surface.topologyRevision = Math.max(surface.topologyRevision, 1);
    this.restartTopologyRestoredSurfaceIds.add(surface.surfaceId);
    this.logger.info?.(
      runtimeDiagnostic("restart_topology_restore_applied", {
        bootstrap_pane_count: 0,
        bootstrap_pane_ids: "",
        restored_pane_count: surface.panes.size,
        restored_pane_ids: [...surface.panes.keys()].join(","),
        restored_topology_revision: surface.topologyRevision,
        surface_id: surface.surfaceId,
        target_record_count: this.persistentState.targetStateBySurfaceId?.[surface.surfaceId]?.targetRecords?.length ?? 0,
        target_lineage_match_count: 0,
        target_lineage_miss_count: surface.panes.size,
      }),
    );
  }

  private restoreRestartTopology(surface: ManagedSurface, snapshot: SurfAceScreenSummary): void {
    const canReplaceCurrentTopology =
      surface.panes.size === 0 ||
      surface.panes.size === 1;
    if (!canReplaceCurrentTopology) {
      return;
    }
    if (snapshot.panes.length === 0 || !snapshot.topology) {
      this.logger.info?.(
        runtimeDiagnostic("restart_topology_restore_skipped", {
          bootstrap_pane_count: surface.panes.size,
          reason: snapshot.panes.length === 0 ? "snapshot_empty" : "snapshot_missing_topology",
          snapshot_pane_count: snapshot.panes.length,
          surface_id: surface.surfaceId,
        }),
      );
      return;
    }
    const bootstrapPaneIds = [...surface.panes.keys()];
    const targetLineageByPaneId = new Map<string, string>();
    const persistedTargets = this.persistentState.targetStateBySurfaceId?.[surface.surfaceId]?.targetRecords ?? [];
    for (const target of persistedTargets) {
      if (target.currentState === "current" || target.currentState === "stale") {
        targetLineageByPaneId.set(target.paneIdAtApply, target.paneLineageId);
      }
    }
    let targetLineageMatchCount = 0;
    let targetLineageMissCount = 0;
    surface.panes = new Map();
    for (const paneSummary of snapshot.panes) {
      const remotePaneId = this.allocateRemotePaneId();
      if (targetLineageByPaneId.has(paneSummary.paneId) || paneSummary.target?.paneLineageId) {
        targetLineageMatchCount += 1;
      } else {
        targetLineageMissCount += 1;
      }
      const pane = createPane(paneSummary.paneId, paneSummary.paneLabel, remotePaneId, paneSummary.viewport);
      pane.paneLineageId =
        paneSummary.target?.paneLineageId ??
        targetLineageByPaneId.get(paneSummary.paneId) ??
        legacyPaneLineageId(remotePaneId);
      surface.panes.set(pane.paneId, pane);
    }
    surface.layout = managedLayoutFromSummary(snapshot.topology);
    surface.topologyRevision = snapshot.topologyRevision;
    surface.snapshotBufferedEvents = [];
    this.restartTopologyRestoredSurfaceIds.add(surface.surfaceId);
    this.logger.info?.(
      runtimeDiagnostic("restart_topology_restore_applied", {
        bootstrap_pane_count: bootstrapPaneIds.length,
        bootstrap_pane_ids: bootstrapPaneIds.join(","),
        restored_pane_count: surface.panes.size,
        restored_pane_ids: [...surface.panes.keys()].join(","),
        restored_topology_revision: surface.topologyRevision,
        surface_id: surface.surfaceId,
        target_record_count: persistedTargets.length,
        target_lineage_match_count: targetLineageMatchCount,
        target_lineage_miss_count: targetLineageMissCount,
      }),
    );
  }

  private restoreRestartContent(surface: ManagedSurface): void {
    const entries = this.restartContentBySurface.get(surface.surfaceId);
    if (!entries || entries.length === 0) {
      return;
    }
    if (!this.hasAcceptedSurfaceTopology(surface)) {
      this.restartContentBySurface.delete(surface.surfaceId);
      this.logger.info?.(
        runtimeDiagnostic("restart_content_restore_skipped", {
          entry_count: entries.length,
          reason: "topology_not_accepted",
          surface_id: surface.surfaceId,
          topology_revision: surface.topologyRevision,
        }),
      );
      return;
    }

    const panes = this.visiblePanes(surface);
    let appliedCount = 0;
    let skippedPaneMissCount = 0;
    for (const entry of entries) {
      const pane =
        (typeof entry.remotePaneId === "number" && Number.isInteger(entry.remotePaneId) && entry.remotePaneId > 0
          ? panes.find((candidate) => Number(candidate.remotePaneId) === entry.remotePaneId)
          : null) ??
        panes.find((candidate) => candidate.paneLabel === entry.paneLabel) ??
        (panes.length === 1 && entries.length === 1 ? panes[0] : null);
      if (!pane) {
        skippedPaneMissCount += 1;
        continue;
      }
      if (pane.pairImportedContentAuthority) {
        this.logReplayOutcome(surface, pane, "content", "skipped_provider_owned");
        continue;
      }
      this.applyVisibleEntry(surface, pane, {
        contentId: entry.contentId as ContentId,
        contentType: entry.contentType,
        contentValue: normalizeContent(entry.contentType, entry.contentValue),
        display: entry.display ? structuredClone(entry.display) : null,
        historyOwnerToken: entry.historyOwnerToken,
        revision: entry.revision as Revision,
        sessionKey: entry.sessionKey,
        targetId: null,
      });
      pane.buffer.liveFrame = entry.liveFrame ? structuredClone(entry.liveFrame) : null;
      pane.buffer.liveDirtyStrokeIds = entry.liveDirtyStrokeIds ? [...entry.liveDirtyStrokeIds] : [];
      appliedCount += 1;
    }
    this.restartContentBySurface.delete(surface.surfaceId);
    this.logger.info?.(
      runtimeDiagnostic("restart_content_restore_result", {
        applied_count: appliedCount,
        entry_count: entries.length,
        skipped_pane_miss_count: skippedPaneMissCount,
        surface_id: surface.surfaceId,
        visible_pane_count: panes.length,
      }),
    );
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
    this.screenSnapshotPersist = this.screenSnapshotPersist
      .catch(() => {})
      .then(() => this.persistScreenSnapshotNow());
    await this.screenSnapshotPersist;
  }

  private async persistScreenSnapshotNow(): Promise<void> {
    if (!this.ownsRuntimeLease) {
      return;
    }
    const snapshotPath = path.join(this.stateDir, SCREEN_SNAPSHOT_FILE_NAME);
    await this.screenSnapshotWrite.catch(() => {});
    const previousSnapshotFile = await this.loadPersistedScreenSnapshotFile();
    const liveScreens = this.buildScreenSummaries();
    const preserveEmptyScreenSnapshot = this.preserveEmptyScreenSnapshotOnce;
    this.preserveEmptyScreenSnapshotOnce = false;
    if (
      preserveEmptyScreenSnapshot &&
      liveScreens.length === 0 &&
      ((previousSnapshotFile?.screens.length ?? 0) > 0 ||
        Object.keys(previousSnapshotFile?.contentContinuity ?? {}).length > 0)
    ) {
      const payload: PersistedScreenSnapshotFile = {
        contentContinuity: structuredClone(previousSnapshotFile?.contentContinuity ?? {}),
        screens: structuredClone(previousSnapshotFile?.screens ?? []),
        updatedAt: this.now(),
        version: 1,
      };
      this.persistedRuntimeScreenIds = new Set(payload.screens.map((screen) => screen.fingerprint));
      this.screenSnapshotWrite = this.screenSnapshotWrite
        .catch(() => {})
        .then(() => fs.writeFile(snapshotPath, JSON.stringify(payload, null, 2)));
      await this.screenSnapshotWrite;
      return;
    }
    const retainedBlankSurfaceIds = new Set<string>();
    this.collectBlankContentContinuityRetentions(
      liveScreens,
      previousSnapshotFile?.contentContinuity ?? {},
      retainedBlankSurfaceIds,
    );
    const screens = [
      ...this.retainTrustedScreensAcrossBlankLiveObservation(
        liveScreens,
        previousSnapshotFile?.screens ?? [],
        retainedBlankSurfaceIds,
      ),
      ...this.retainedRestartScreens(liveScreens),
    ];
    this.persistedRuntimeScreenIds = new Set(screens.map((screen) => screen.fingerprint));
    const previousContentContinuity = previousSnapshotFile?.contentContinuity ?? {};
    const payload: PersistedScreenSnapshotFile = {
      contentContinuity: this.buildContentContinuitySnapshot(previousContentContinuity, retainedBlankSurfaceIds),
      screens,
      updatedAt: this.now(),
      version: 1,
    };
    this.screenSnapshotWrite = this.screenSnapshotWrite
      .catch(() => {})
      .then(() => fs.writeFile(snapshotPath, JSON.stringify(payload, null, 2)));
    await this.screenSnapshotWrite;
  }

  private buildContentContinuitySnapshot(
    previousContentContinuity: Record<string, PersistedRestartContentEntry[]> = {},
    retainedBlankSurfaceIds: Set<string> = new Set(),
  ): Record<string, PersistedRestartContentEntry[]> {
    const contentContinuity: Record<string, PersistedRestartContentEntry[]> = {};
    const retainedContent = new Map(this.restartContentBySurface);
    for (const surface of this.canonicalVisibleSurfaces()) {
      const entries = this.captureRestartContentEntries(surface);
      if (entries.length > 0) {
        contentContinuity[surface.surfaceId] = entries;
        this.lastPersistedContentContinuity.set(surface.surfaceId, structuredClone(entries));
      } else {
        const previousEntries = previousContentContinuity[surface.surfaceId] ??
          this.lastPersistedContentContinuity.get(surface.surfaceId);
        if (
          previousEntries &&
          previousEntries.length > 0 &&
          (this.shouldRetainContentContinuityForSurface(surface) || retainedBlankSurfaceIds.has(surface.surfaceId))
        ) {
          contentContinuity[surface.surfaceId] = structuredClone(previousEntries);
          this.lastPersistedContentContinuity.set(surface.surfaceId, structuredClone(previousEntries));
        }
      }
      retainedContent.delete(surface.surfaceId);
    }
    for (const [surfaceId, entries] of retainedContent) {
      if (entries.length > 0) {
        contentContinuity[surfaceId] = structuredClone(entries);
      }
    }
    for (const surfaceId of retainedBlankSurfaceIds) {
      if (contentContinuity[surfaceId]) {
        continue;
      }
      const previousEntries = previousContentContinuity[surfaceId] ??
        this.lastPersistedContentContinuity.get(surfaceId);
      if (previousEntries && previousEntries.length > 0) {
        contentContinuity[surfaceId] = structuredClone(previousEntries);
        this.lastPersistedContentContinuity.set(surfaceId, structuredClone(previousEntries));
      }
    }
    return contentContinuity;
  }

  private retainTrustedScreensAcrossBlankLiveObservation(
    liveScreens: SurfAceScreenSummary[],
    previousScreens: SurfAceScreenSummary[],
    retainedBlankSurfaceIds: Set<string>,
  ): SurfAceScreenSummary[] {
    const previousBySurfaceId = new Map(previousScreens.map((screen) => [screen.fingerprint, screen]));
    return liveScreens.map((screen) => {
      const previous = previousBySurfaceId.get(screen.fingerprint);
      if (previous && this.shouldRetainTrustedScreenForBlankLiveObservation(screen, previous)) {
        retainedBlankSurfaceIds.add(screen.fingerprint);
        return structuredClone(previous);
      }
      if (
        previous &&
        retainedBlankSurfaceIds.has(screen.fingerprint) &&
        previous.fingerprint === screen.fingerprint &&
        previous.panes.length > screen.panes.length &&
        this.isBlankSinglePaneScreen(screen)
      ) {
        return structuredClone(previous);
      }
      return screen;
    });
  }

  private collectBlankContentContinuityRetentions(
    liveScreens: SurfAceScreenSummary[],
    previousContentContinuity: Record<string, PersistedRestartContentEntry[]>,
    retainedBlankSurfaceIds: Set<string>,
  ): void {
    for (const screen of liveScreens) {
      const previousEntries = previousContentContinuity[screen.fingerprint] ??
        this.lastPersistedContentContinuity.get(screen.fingerprint);
      if (
        previousEntries &&
        previousEntries.length > 0 &&
        this.isBlankSinglePaneScreen(screen)
      ) {
        retainedBlankSurfaceIds.add(screen.fingerprint);
      }
    }
  }

  private shouldRetainTrustedScreenForBlankLiveObservation(
    liveScreen: SurfAceScreenSummary,
    previousScreen: SurfAceScreenSummary,
  ): boolean {
    if (!this.hasTrustedPersistedSelfOwnership(previousScreen)) {
      return false;
    }
    if (previousScreen.fingerprint !== liveScreen.fingerprint) {
      return false;
    }
    if (previousScreen.panes.length <= liveScreen.panes.length) {
      return false;
    }
    if (!this.isBlankSinglePaneScreen(liveScreen)) {
      return false;
    }
    return previousScreen.panes.some((pane) =>
      pane.activeContent !== null ||
      pane.historySummary.visibleContentId !== null ||
      pane.target !== null
    );
  }

  private isBlankSinglePaneScreen(screen: SurfAceScreenSummary): boolean {
    if (screen.panes.length !== 1) {
      return false;
    }
    const pane = screen.panes[0];
    if (!pane || pane.activeContent !== null || pane.historySummary.visibleContentId !== null) {
      return false;
    }
    return screen.topology?.type === "pane";
  }

  private shouldRetainContentContinuityForSurface(surface: ManagedSurface): boolean {
    if (!this.hasAcceptedSurfaceTopology(surface)) {
      return false;
    }
    return this.visiblePanes(surface).some((pane) => this.hasProviderOwnedPaneAuthority(surface, pane));
  }

  private captureRestartContentEntries(surface: ManagedSurface): PersistedRestartContentEntry[] {
    return this.visiblePanes(surface)
      .map((pane): PersistedRestartContentEntry | null => {
        const entry = this.restartContinuityEntry(pane);
        if (!entry) {
          return null;
        }
        return {
          contentId: entry.contentId,
          contentType: entry.contentType,
          contentValue: denormalizeContent(entry.contentType, entry.contentValue),
          display: entry.display ? structuredClone(entry.display) : null,
          historyOwnerToken: entry.historyOwnerToken,
          liveDirtyStrokeIds: [...pane.buffer.liveDirtyStrokeIds],
          liveFrame: cloneFrame(pane.buffer.liveFrame),
          paneLabel: this.projectedPaneLabel(surface, pane),
          remotePaneId: Number(pane.remotePaneId),
          revision: entry.revision,
          sessionKey: entry.sessionKey,
        };
      })
      .filter((entry): entry is PersistedRestartContentEntry => entry !== null);
  }

  private retainedRestartScreens(screens: SurfAceScreenSummary[]): SurfAceScreenSummary[] {
    const liveSurfaceIds = new Set(screens.map((screen) => screen.fingerprint));
    return [...this.restartSnapshots.entries()]
      .filter(([surfaceId]) => !liveSurfaceIds.has(surfaceId))
      .map(([, screen]) => structuredClone(screen));
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
      case "capturePane":
        return await this.capturePane(command.input);
      case "clear":
        return await this.clear(command.input);
      case "closePane":
        return await this.closePane(command.input);
      case "listScreens":
        return await this.listScreens();
      case "launchNativeApp":
        return await this.launchNativeApp(command.input, command.context);
      case "launchTerminal":
        return await this.launchTerminal(command.input, command.context);
      case "push":
        return await this.push(command.input, command.context);
      case "pushBatch":
        return await this.pushBatch(command.input, command.context);
      case "read":
        return await this.read(command.input);
      case "realizeTopology":
        return await this.realizeTopology(command.input);
      case "realizeTopologies":
        return await this.realizeTopologies(command.input);
      case "reattemptConnections":
        return await this.reattemptConnections(command.input);
      case "relinquish":
        return await this.relinquish(command.input);
      case "restoreTarget":
        return await this.restoreTarget(command.input);
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
    this.runtimeLeaseStartedAt = this.runtimeLeaseStartedAt ?? this.now();
    const lastActiveAt = this.now();
    const content = JSON.stringify(
      {
        controlPort: this.ownerControlPort,
        pid: process.pid,
        startedAt: this.runtimeLeaseStartedAt,
        lastActiveAt,
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
    this.runtimeLeaseStartedAt = null;
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
    this.assertCanonicalSurfaceRegistry("tool surface resolution");
    const surface = this.surfaces.get(fingerprint);
    if (!surface || isProvisionalSurfaceId(surface.surfaceId)) {
      throw new SurfAceToolError("screen_not_found", `Unknown Surf Ace surface: ${fingerprint}`);
    }
    const authority = this.providerAuthorityForSurface(surface);
    if (!authority.actionable) {
      const hidesSurface = this.authorityBlockerHidesSurface(authority);
      throw new SurfAceToolError(
        hidesSurface ? "screen_not_found" : "not_connected",
        hidesSurface
          ? `Unknown Surf Ace surface: ${fingerprint}`
          : `Surf Ace surface is not provider-actionable: ${fingerprint} (${authority.reason ?? "unknown"})`,
      );
    }
    if (surface.connectionState !== "connected" || !surface.client) {
      throw new SurfAceToolError(
        "not_connected",
        `Surf Ace surface is not connected: ${fingerprint}`,
      );
    }
    return surface;
  }

  private async requireActionableSurface(fingerprint: string): Promise<ManagedSurface> {
    const surface = this.requireKnownSurface(fingerprint);
    await this.ensureClientAuthorityAccepted(surface);
    return this.requireConnectedSurface(fingerprint);
  }

  private async ensureClientAuthorityAccepted(surface: ManagedSurface): Promise<void> {
    let authority = this.providerAuthorityForSurface(surface);
    if (
      authority.blockers.length === 1 &&
      authority.blockers[0] === "topology_update_in_flight"
    ) {
      const deadline = this.now() + 2_000;
      while (surface.topologyApplyInFlight && this.now() < deadline) {
        await sleep(10);
      }
      authority = this.providerAuthorityForSurface(surface);
    }
    if (authority.actionable) {
      return;
    }
    if (
      this.baseProviderAuthorityForSurface(surface).admitted &&
      authority.blockers.length === 1
    ) {
      await this.publishAuthorityState(surface);
    }
  }

  private authorityBlockerHidesSurface(authority: SurfAceProviderAuthorityDecision): boolean {
    return authority.blockers.some((blocker) =>
      blocker === "not_provider_admitted" ||
      blocker === "not_visible_accepted_topology" ||
      blocker === "surface_tombstoned"
    );
  }

  private requireKnownSurface(fingerprint: string): ManagedSurface {
    this.assertCanonicalSurfaceRegistry("tool surface resolution");
    const surface = this.surfaces.get(fingerprint);
    if (!surface || isProvisionalSurfaceId(surface.surfaceId)) {
      throw new SurfAceToolError("screen_not_found", `Unknown Surf Ace surface: ${fingerprint}`);
    }
    return surface;
  }

  private requirePane(fingerprint: string, paneId: PaneId): ManagedPane {
    this.assertCanonicalSurfaceRegistry("tool pane resolution");
    const surface = this.surfaces.get(fingerprint);
    if (!surface || isProvisionalSurfaceId(surface.surfaceId)) {
      throw new SurfAceToolError("screen_not_found", `Unknown Surf Ace surface: ${fingerprint}`);
    }
    if (this.hasAcceptedSurfaceTopology(surface) && !this.hasVisibleAcceptedSurfaceTopology(surface)) {
      this.pruneStaleAcceptedSurfaces("tool pane resolution");
      throw new SurfAceToolError("screen_not_found", `Unknown Surf Ace surface: ${fingerprint}`);
    }
    if (!this.hasVisibleAcceptedSurfaceTopology(surface)) {
      throw new SurfAceToolError("screen_not_found", `Unknown Surf Ace surface: ${fingerprint}`);
    }
    const pane = this.visiblePanes(surface).find((candidate) => candidate.paneId === paneId);
    if (!pane) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Unknown Surf Ace pane ${paneId} on ${fingerprint}`,
      );
    }
    const authority = this.providerAuthorityForPane(surface, paneId);
    if (!authority.actionable) {
      const hidesSurface = this.authorityBlockerHidesSurface(authority);
      throw new SurfAceToolError(
        hidesSurface ? "screen_not_found" : "not_connected",
        hidesSurface
          ? `Unknown Surf Ace surface: ${fingerprint}`
          : `Surf Ace pane is not provider-actionable: ${fingerprint}/${paneId} (${authority.reason ?? "unknown"})`,
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
    const endpointKey = endpointProbeKey(endpoint);
    for (const candidate of [...this.surfaces.values()]) {
      if (candidate.stopRequested && candidate.endpointId === endpoint.endpointId) {
        this.removeManagedSurfaceFromRegistries(candidate);
      }
    }
    const matchingSurfaces = [...this.surfaces.values()].filter((candidate) =>
      candidate.endpointId === endpoint.endpointId ||
      buildWsUrl(candidate.endpoint) === buildWsUrl(endpoint) ||
      endpointProbeKey(candidate.endpoint) === endpointKey
    );
    for (const candidate of [...this.surfaces.values()]) {
      if (
        candidate.endpointId === endpoint.endpointId ||
        buildWsUrl(candidate.endpoint) === buildWsUrl(endpoint) ||
        endpointProbeKey(candidate.endpoint) === endpointKey
      ) {
        this.assignEndpoint(candidate, endpoint);
        this.ensureSurfaceWorker(candidate);
      }
    }
    const ownedSurfaces = matchingSurfaces.filter((surface) => this.hasOwnedEndpointWorker(surface));
    const openOwnedSurface = this.openAcceptedOwnedSurface(ownedSurfaces);
    if (ownedSurfaces.length > 0) {
      const probe = this.upsertEndpointProbe(endpoint);
      this.suppressEndpointProbeWorker(probe, "owned surface worker active");
      if (openOwnedSurface) {
        this.ensureOwnedEndpointSurfacesListReconcile(probe, openOwnedSurface);
      }
      return;
    }
    const probe = this.upsertEndpointProbe(endpoint);
    this.logger.debug?.(
      runtimeDiagnostic("endpoint_adopt", {
        action: "upsert_endpoint_probe",
        endpoint_id: endpoint.endpointId,
        surface_name: endpoint.name,
      }),
    );
    this.ensureEndpointProbeWorker(probe);
  }

  private hasOwnedEndpointWorker(surface: ManagedSurface): boolean {
    return !surface.stopRequested &&
      surface.autoRetryEnabled &&
      (
        this.hasAcceptedSurfaceTopology(surface) ||
        (surface.client?.isOpen() ?? false) ||
        surface.workPromise !== null
      );
  }

  private ownedSurfacesForEndpoint(endpoint: SurfAceDiscoveryEndpoint): ManagedSurface[] {
    const endpointKey = endpointProbeKey(endpoint);
    return [...this.surfaces.values()].filter((surface) =>
      this.hasOwnedEndpointWorker(surface) &&
      (
        surface.endpointId === endpoint.endpointId ||
        buildWsUrl(surface.endpoint) === buildWsUrl(endpoint) ||
        endpointProbeKey(surface.endpoint) === endpointKey
      )
    );
  }

  private openAcceptedOwnedSurface(surfaces: ManagedSurface[]): ManagedSurface | undefined {
    return surfaces.find((surface) =>
      (surface.client?.isOpen() ?? false) &&
      this.hasAcceptedSurfaceTopology(surface)
    );
  }

  private suppressEndpointProbeWorker(probe: EndpointProbe, reason: string): void {
    probe.stopRequested = true;
    this.wakeEndpointProbeRetry(probe);
    this.logger.info?.(
      runtimeDiagnostic("endpoint_probe_suppressed", {
        endpoint_id: probe.endpointId,
        reason,
      }),
    );
    if (probe.client) {
      this.runBackgroundTask(
        `close suppressed endpoint probe ${probe.endpointId}`,
        async () => {
          await probe.client?.close(1000, clampCloseReason("provider_shutdown"));
        },
      );
    }
  }

  private ensureOwnedEndpointSurfacesListReconcile(probe: EndpointProbe, surface: ManagedSurface): void {
    if (probe.reconcileWorkPromise) {
      return;
    }
    const workPromise = this.discoverSurfaceId(surface)
      .then((surfacesToStart) => {
        for (const candidate of surfacesToStart) {
          this.ensureSurfaceWorker(candidate);
        }
      })
      .catch((error) => {
        this.logger.warn?.(
          runtimeDiagnostic("owned_endpoint_surfaces_list_unavailable", {
            endpoint_id: surface.endpointId,
            error: String(error),
            surface_id: surface.surfaceId,
          }),
        );
      })
      .finally(() => {
        if (probe.reconcileWorkPromise === workPromise) {
          probe.reconcileWorkPromise = null;
        }
      });
    probe.reconcileWorkPromise = workPromise;
  }

  private upsertEndpointProbe(endpoint: SurfAceDiscoveryEndpoint): EndpointProbe {
    const canonicalKey = endpointProbeKey(endpoint);
    const existing = this.endpointProbes.get(endpoint.endpointId) ??
      this.findEndpointProbeByCanonicalKey(canonicalKey);
    if (!existing) {
      const probe = createEndpointProbe(endpoint, this.now());
      this.endpointProbes.set(endpoint.endpointId, probe);
      return probe;
    }
    const endpointChanged = buildWsUrl(existing.endpoint) !== buildWsUrl(endpoint);
    if (existing.endpointId !== endpoint.endpointId) {
      this.endpointProbes.delete(existing.endpointId);
      this.endpointProbes.set(endpoint.endpointId, existing);
    }
    existing.canonicalKey = canonicalKey;
    existing.endpoint = endpoint;
    existing.endpointId = endpoint.endpointId;
    existing.fingerprintPrefix = endpoint.fingerprintPrefix;
    existing.lastSeenAt = this.now();
    existing.name = endpoint.name;
    existing.viewport = cloneViewport(endpoint.viewport);
    existing.stopRequested = false;
    if (!endpointChanged && (existing.connectionCircuitOpenedAt || !existing.autoRetryEnabled || existing.unreachableFailures > 0)) {
      this.logger.info?.(
        runtimeDiagnostic("endpoint_probe_rediscovery_retry_reset", {
          endpoint_id: existing.endpointId,
          failures: existing.unreachableFailures,
        }),
      );
      this.resetEndpointProbeConnectionCircuit(existing, "endpoint rediscovered", { enableRetry: true });
      this.wakeEndpointProbeRetry(existing);
    }
    if (endpointChanged) {
      this.resetEndpointProbeConnectionCircuit(existing, "endpoint changed");
      if (existing.client) {
        this.runBackgroundTask(
          `refresh endpoint probe client ${existing.endpointId}`,
          async () => {
            await existing.client?.close(1000, clampCloseReason("provider_shutdown"));
          },
        );
      }
      this.wakeEndpointProbeRetry(existing);
    }
    return existing;
  }

  private findEndpointProbeByCanonicalKey(canonicalKey: string): EndpointProbe | undefined {
    return [...this.endpointProbes.values()].find((probe) => probe.canonicalKey === canonicalKey);
  }

  private removeManagedSurfaceFromRegistries(surface: ManagedSurface): void {
    if (this.surfaces.get(surface.surfaceId) === surface) {
      this.surfaces.delete(surface.surfaceId);
    }
  }

  private isManagedSurfaceRegistered(surface: ManagedSurface): boolean {
    return this.surfaces.get(surface.surfaceId) === surface;
  }

  private assignEndpoint(
    surface: ManagedSurface,
    endpoint: SurfAceDiscoveryEndpoint,
    options: { preserveLiveAlias?: boolean } = {},
  ): void {
    const previousEndpointId = surface.endpointId;
    const endpointChanged = previousEndpointId !== endpoint.endpointId;
    const endpointUrlChanged = buildWsUrl(surface.endpoint) !== buildWsUrl(endpoint);
    const sameFingerprint =
      Boolean(endpoint.fingerprintPrefix) &&
      endpoint.fingerprintPrefix === surface.fingerprintPrefix;
    if (
      endpointChanged &&
      endpointUrlChanged &&
      sameFingerprint &&
      (options.preserveLiveAlias ?? true) &&
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
    if (endpointUrlChanged) {
      this.logger.warn?.(
        `[surf-ace:runtime] refreshed stale endpoint for ${surface.surfaceId}: ${previousEndpointId} -> ${endpoint.endpointId}`,
      );
    }
    surface.endpoint = endpoint;
    surface.endpointId = endpoint.endpointId;
    surface.fingerprintPrefix = endpoint.fingerprintPrefix;
    surface.lastSeenAt = this.now();
    surface.name = endpoint.name;
    surface.viewport = cloneViewport(endpoint.viewport);

    if (!endpointChanged && !endpointUrlChanged) {
      if (surface.connectionCircuitOpenedAt || !surface.autoRetryEnabled || surface.unreachableFailures > 0) {
        this.logger.info?.(
          runtimeDiagnostic("surface_rediscovery_retry_reset", {
            failures: surface.unreachableFailures,
            surface_id: surface.surfaceId,
          }),
        );
        this.resetSurfaceConnectionCircuit(surface, "endpoint rediscovered", { enableRetry: true });
        this.wakeSurfaceRetry(surface);
      }
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

    this.resetSurfaceConnectionCircuit(surface, "endpoint changed");
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

  private applyRemotePairObservation(
    surface: ManagedSurface,
    endpoint: SurfAceDiscoveryEndpoint,
    paired: boolean,
    observedAt: number,
  ): void {
    surface.remotePairObservation = {
      ...endpointProvenance(endpoint),
      observedAt,
      paired,
      source: "surfaces.list",
    };
    surface.remoteListedAt = observedAt;
    surface.remotePaired = paired;
  }

  private reconcileCanonicalSurfacesFromRemoteList(input: {
    endpoint: SurfAceDiscoveryEndpoint;
    remoteSurfaces: SurfacesListResponse["payload"]["surfaces"];
    source: "surfaces.list";
    sourceSurface?: ManagedSurface;
    startDiscoveredSiblings: boolean;
  }): ManagedSurface[] {
    const endpointId = input.endpoint.endpointId;
    const endpointKey = endpointProbeKey(input.endpoint);
    if (input.remoteSurfaces.length === 0) {
      this.tombstoneEndpointId(endpointId, "empty surfaces.list");
      for (const candidate of [...this.surfaces.values()]) {
        if (candidate.endpointId === endpointId || endpointProbeKey(candidate.endpoint) === endpointKey) {
          this.removeClosedSurface(candidate.surfaceId, "surfaces_list_empty");
        }
      }
      this.logEndpointCanonicalSurfaceCardinality(input.endpoint, "surfaces.list empty");
      this.queuePersistScreenSnapshot("empty surfaces.list");
      return [];
    }

    this.clearTombstonedEndpointId(endpointId, "surfaces.list nonempty");

    const remoteSurfaceIds = new Set(input.remoteSurfaces.map((remoteSurface) => remoteSurface.surfaceId));
    const surfacesToStart: ManagedSurface[] = [];
    let firstCanonicalSurface: ManagedSurface | null = null;

    const sourceRemapTarget = input.sourceSurface &&
      !remoteSurfaceIds.has(input.sourceSurface.surfaceId) &&
      input.remoteSurfaces.length === 1
        ? input.remoteSurfaces[0]
        : null;

    for (const remoteSurface of input.remoteSurfaces) {
      const shouldRemapSource =
        Boolean(sourceRemapTarget) &&
        input.sourceSurface &&
        remoteSurface.surfaceId === sourceRemapTarget?.surfaceId;
      const canonicalSurface = this.upsertCanonicalVisibleSurface({
        endpoint: input.endpoint,
        name: remoteSurface.name,
        remotePaired: remoteSurface.paired,
        remapFrom: shouldRemapSource ? input.sourceSurface : undefined,
        source: input.source,
        surfaceId: asSurfaceId(remoteSurface.surfaceId),
        viewport: remoteSurface.viewport,
      });
      firstCanonicalSurface ??= canonicalSurface;
      if (
        input.sourceSurface &&
        (
          shouldRemapSource ||
          canonicalSurface.surfaceId === input.sourceSurface.surfaceId
        )
      ) {
        surfacesToStart.push(canonicalSurface);
        continue;
      }
      if (!input.sourceSurface && canonicalSurface === firstCanonicalSurface) {
        surfacesToStart.push(canonicalSurface);
        continue;
      }
      if (input.startDiscoveredSiblings) {
        surfacesToStart.push(canonicalSurface);
      }
    }

    for (const candidate of [...this.surfaces.values()]) {
      if (candidate.endpointId !== endpointId && endpointProbeKey(candidate.endpoint) !== endpointKey) {
        continue;
      }
      if (remoteSurfaceIds.has(candidate.surfaceId)) {
        continue;
      }
      this.removeClosedSurface(candidate.surfaceId, "surfaces_list_absent");
    }

    this.logEndpointCanonicalSurfaceCardinality(input.endpoint, "surfaces.list");
    return [...new Set(surfacesToStart)];
  }

  private logEndpointCanonicalSurfaceCardinality(endpoint: SurfAceDiscoveryEndpoint, source: string): void {
    const endpointKey = endpointProbeKey(endpoint);
    const surfaceIds = [...this.surfaces.values()]
      .filter((surface) => endpointProbeKey(surface.endpoint) === endpointKey)
      .map((surface) => surface.surfaceId)
      .sort();
    this.logger.info?.(
      runtimeDiagnostic("endpoint_canonical_surface_cardinality", {
        endpoint_canonical_key: endpointKey,
        endpoint_id: endpoint.endpointId,
        source,
        surface_count: surfaceIds.length,
        surface_ids: surfaceIds.join(",") || "none",
      }),
    );
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
    return this.reconcileCanonicalSurfacesFromRemoteList({
      endpoint: surface.endpoint,
      remoteSurfaces,
      source: "surfaces.list",
      sourceSurface: surface,
      startDiscoveredSiblings: true,
    });
  }

  private async requestPair(surface: ManagedSurface): Promise<{
    response: PairResponse;
    requestedWindowLabel: string;
    restoreAttemptId: string;
  }> {
    const client = surface.client;
    if (!client || !client.isOpen()) {
      throw new SurfAceToolError(
        "not_connected",
        `Surf Ace surface is not connected: ${surface.surfaceId}`,
      );
    }
    const hasRestartOwnershipPendingPair =
      surface.restartOwnershipPendingPair &&
      this.hasValidResumeSession(surface);
    if (
      !this.hasAcceptedSurfaceTopology(surface) &&
      surface.panes.size > 0 &&
      !hasRestartOwnershipPendingPair
    ) {
      this.clearSurfaceLocalTopologyState(surface, {
        preserveRestartContent: hasRestartOwnershipPendingPair,
        preserveRestartSnapshot: hasRestartOwnershipPendingPair,
        preserveTargetState: true,
        targetLifecycleReason: "pair request topology reset",
      });
    }
    const initialPaneId = this.ensureInitialPairPane(surface);
    const initialPane = this.firstPane(surface);
    if (!initialPane) {
      throw new SurfAceToolError("internal_error", `Surface ${surface.surfaceId} has no initial pane`);
    }
    if (surface.restartOwnershipPendingPair) {
      delete this.persistentState.windowLabels[surface.surfaceId];
      surface.windowLabel = "";
    }
    surface.windowLabel = surface.windowLabel || this.ensureWindowLabel(surface.surfaceId);
    this.repairLiveWindowLabelInvariant("pair request", {
      includePairingSurface: surface,
      includePairingSurfaces: true,
    });
    const windowLabel = surface.windowLabel;
    this.repairLivePaneLabelInvariant("pair request", surface, surface);
    const resumeSessionId = this.shouldAttemptResume(surface) ? surface.sessionId : null;
    const providerName = this.providerNameForSurface(surface);
    const restoreAttemptId = `ra_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

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
        restoreAttemptId,
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

    response = await this.maybeRecoverKnownSelfOwnershipLock(
      surface,
      response,
      resumeSessionId,
      sendPairRequest,
    );

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
          surface.localOwnership = null;
          response = await sendPairRequest(false, null);
        }
      }
    }

    if (
      isResumeSessionMismatch(response) &&
      !surface.hasPairedInGatewaySession &&
      !this.isKnownSelfOwnedSurface(surface)
    ) {
      response = await this.maybeRecoverFromColdStartInvalidResume(
        surface,
        response,
        sendPairRequest,
      );
    }

    response = await this.maybeRecoverSameInstallOwnershipLock(
      surface,
      response,
      resumeSessionId,
      sendPairRequest,
    );

    if (isErrorResponse(response)) {
      if (isOwnershipLockResponse(response)) {
        const ownershipLockCode = response.error.code === "busy" ? "busy" : "invalid_resume";
        this.noteOwnershipLockFailure(surface, ownershipLockCode);
        if (isForeignOwnershipLockResponse(response) && !this.hasTrustedLineageSelfOwnership(surface)) {
          this.logger.warn?.(
            runtimeDiagnostic("foreign_ownership_lock_cleared", {
              reason: response.error.code,
              surface_id: surface.surfaceId,
            }),
          );
          this.clearForeignOwnershipLocalState(surface);
          this.queuePersistScreenSnapshot("foreign ownership lock");
        }
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

    const responseState = (response as { payload?: { state?: { panes?: unknown } } }).payload?.state;
    if (Array.isArray(responseState?.panes) && responseState.panes.length === 0) {
      throw new SurfAceToolError(
        "internal_error",
        `Surf Ace pair.response for ${surface.surfaceId} contained no topology panes; fresh surfaces must expose at least one targetable pane`,
      );
    }

    response = this.quarantineMalformedPairResponsePaneState(surface, response);
    const validation = validateEnvelopeType("pair.request", response);
    if (!validation.ok) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Surf Ace pair.response for ${surface.surfaceId} failed protocol validation: ${validation.reason}`,
      );
    }

    return { response: response as PairResponse, requestedWindowLabel: windowLabel, restoreAttemptId };
  }

  private quarantineMalformedPairResponsePaneState(surface: ManagedSurface, response: Response): Response {
    if (
      isErrorResponse(response) ||
      response.op !== "pair.request" ||
      !isPlainRecord(response.payload) ||
      !isPlainRecord(response.payload.state) ||
      !Array.isArray(response.payload.state.panes)
    ) {
      return response;
    }

    let quarantinedPaneCount = 0;
    const panes = response.payload.state.panes.map((paneState) => {
      if (isValidPairResponsePaneState(paneState)) {
        return paneState;
      }
      const recovered = recoverPairResponsePaneTopologyState(paneState);
      if (!recovered) {
        return paneState;
      }
      quarantinedPaneCount += 1;
      return recovered;
    });
    if (quarantinedPaneCount === 0) {
      return response;
    }

    this.logger.warn?.(
      runtimeDiagnostic("pair_response_pane_state_quarantined", {
        pane_count: quarantinedPaneCount,
        surface_id: surface.surfaceId,
      }),
    );
    return {
      ...response,
      payload: {
        ...response.payload,
        state: {
          ...response.payload.state,
          panes,
        },
      },
    } as Response;
  }

  private assertPairResponseHasTopologyPanes(surface: ManagedSurface, response: PairResponse): void {
    if (response.payload.state.panes.length > 0) {
      return;
    }
    throw new SurfAceToolError(
      "internal_error",
      `Surf Ace pair.response for ${surface.surfaceId} contained no topology panes; fresh surfaces must expose at least one targetable pane`,
    );
  }

  private assertPairResponseTopologyMatchesPanes(surface: ManagedSurface, response: PairResponse): void {
    if (
      !Number.isInteger(response.payload.state.topologyRevision) ||
      Number(response.payload.state.topologyRevision) < 0
    ) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Surf Ace pair.response topology for ${surface.surfaceId} contained an invalid topologyRevision.`,
      );
    }
    if (!response.payload.state.panes.every((paneState) => isValidPairResponsePaneState(paneState))) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Surf Ace pair.response state for ${surface.surfaceId} contained a schema-invalid pane entry.`,
      );
    }
    if (!isValidTopologyLayoutNode(response.payload.state.layout)) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Surf Ace pair.response topology for ${surface.surfaceId} was not a valid recursive layout.`,
      );
    }
    if (
      topologyLayoutExactlyCoversRemotePaneIds(
        response.payload.state.layout,
        response.payload.state.panes.map((pane) => pane.paneId),
      )
    ) {
      return;
    }
    throw new SurfAceToolError(
      "invalid_operation",
      `Surf Ace pair.response topology for ${surface.surfaceId} did not exactly match its pane list.`,
    );
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

  private async maybeRecoverKnownSelfOwnershipLock(
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
      (response.error.code !== "busy" && response.error.code !== "invalid_resume") ||
      (isForeignOwnershipLockResponse(response) && !this.hasTrustedLineageSelfOwnership(surface)) ||
      !this.isKnownSelfOwnedSurface(surface)
    ) {
      if (
        isErrorResponse(response) &&
        (response.error.code === "busy" || response.error.code === "invalid_resume") &&
        this.hasPersistedSelfSignals(surface) &&
        !this.hasValidResumeSession(surface)
      ) {
        this.logger.warn?.(
          runtimeDiagnostic("ownership_self_reclaim_blocked", {
            had_paired_session: surface.hasPairedInGatewaySession,
            had_persisted_target_state: Boolean(this.persistentState.targetStateBySurfaceId?.[surface.surfaceId]),
            had_resume_session: Boolean(resumeSessionId),
            has_target_capabilities: surface.targetCapabilities.size > 0,
            provider_id: this.persistentState.providerId,
            reason: response.error.code,
            surface_id: surface.surfaceId,
          }),
        );
      }
      return response;
    }
    return this.reclaimSelfOwnershipLock(surface, response, resumeSessionId, sendPairRequest);
  }

  private async maybeRecoverSameInstallOwnershipLock(
    surface: ManagedSurface,
    response: Response,
    resumeSessionId: SessionId | null,
    sendPairRequest: (
      takeover: boolean,
      requestedResumeSessionId: SessionId | null,
    ) => Promise<Response>,
  ): Promise<Response> {
    if (
      !isResumeSessionMismatch(response) ||
      resumeSessionId ||
      surface.hasPairedInGatewaySession ||
      this.hasDurableDifferentProviderOwnership(surface) ||
      !this.hasCurrentDiscoveryEndpoint(surface)
    ) {
      return response;
    }
    return this.reclaimSelfOwnershipLock(surface, response, null, sendPairRequest);
  }

  private isKnownSelfOwnedSurface(surface: ManagedSurface): boolean {
    if (
      this.livePairedSelfRediscoveredSurfaceIds.has(surface.surfaceId) &&
      this.hasCurrentDiscoveryEndpoint(surface)
    ) {
      return true;
    }
    if (this.hasTrustedLivePairedSelfRediscovery(surface)) {
      return true;
    }
    return this.ownershipRecoveryPolicy.isKnownSelfOwnedSurface(
      this.persistentState,
      surface.surfaceId,
      this.hasValidResumeSession(surface),
    );
  }

  private isTrustedProviderLineageId(providerId: string): boolean {
    return this.ownershipRecoveryPolicy.isTrustedProviderLineageId(this.persistentState, providerId);
  }

  private hasTrustedLineageSelfOwnership(surface: ManagedSurface): boolean {
    return this.ownershipRecoveryPolicy.hasTrustedForeignLineageSelfOwnership(
      this.persistentState,
      surface.surfaceId,
    );
  }

  private hasDurableDifferentProviderOwnership(surface: ManagedSurface): boolean {
    return this.ownershipRecoveryPolicy.hasDurableDifferentProviderOwnership(
      this.persistentState,
      surface.surfaceId,
    );
  }

  private async reclaimSelfOwnershipLock(
    surface: ManagedSurface,
    response: ErrorResponse,
    resumeSessionId: SessionId | null,
    sendPairRequest: (
      takeover: boolean,
      requestedResumeSessionId: SessionId | null,
    ) => Promise<Response>,
  ): Promise<Response> {
    if (surface.selfOwnershipReclaimAttempted) {
      this.logger.warn?.(
        runtimeDiagnostic("ownership_self_reclaim_blocked", {
          had_paired_session: surface.hasPairedInGatewaySession,
          had_reclaim_session: Boolean(resumeSessionId ? null : this.durableSelfReclaimResumeSessionId(surface)),
          had_resume_session: Boolean(resumeSessionId),
          provider_id: this.persistentState.providerId,
          reason: response.error.code,
          surface_id: surface.surfaceId,
        }),
      );
      return response;
    }
    if (response.error.code === "invalid_resume" && resumeSessionId) {
      this.logger.warn?.(
        runtimeDiagnostic("ownership_self_reclaim_blocked", {
          had_paired_session: surface.hasPairedInGatewaySession,
          had_resume_session: true,
          provider_id: this.persistentState.providerId,
          reason: "invalid_resume_stale_active_resume",
          surface_id: surface.surfaceId,
        }),
      );
      return response;
    }
    this.logger.warn?.(
      runtimeDiagnostic("ownership_self_reclaim", {
        had_paired_session: surface.hasPairedInGatewaySession,
        had_resume_session: Boolean(resumeSessionId),
        had_reclaim_session: Boolean(resumeSessionId ? null : this.durableSelfReclaimResumeSessionId(surface)),
        provider_id: this.persistentState.providerId,
        reason: response.error.code,
        surface_id: surface.surfaceId,
      }),
    );
    const reclaimResumeSessionId = resumeSessionId ? null : this.durableSelfReclaimResumeSessionId(surface);
    if (!reclaimResumeSessionId) {
      this.clearSurfaceResumeState(surface);
    }
    surface.selfOwnershipReclaimAttempted = true;
    try {
      const reclaimResponse = await sendPairRequest(true, reclaimResumeSessionId);
      if (reclaimResumeSessionId && isResumeSessionMismatch(reclaimResponse)) {
        this.logger.warn?.(
          runtimeDiagnostic("ownership_self_reclaim_resume_stale", {
            provider_id: this.persistentState.providerId,
            surface_id: surface.surfaceId,
          }),
        );
        this.clearSurfaceResumeState(surface);
        return await sendPairRequest(true, null);
      }
      return reclaimResponse;
    } catch (error) {
      surface.selfOwnershipReclaimAttempted = false;
      throw error;
    }
  }

  private durableSelfReclaimResumeSessionId(surface: ManagedSurface): SessionId | null {
    const sessionId = this.ownershipRecoveryPolicy.durableSelfReclaimResumeSessionId(
      this.persistentState,
      surface.surfaceId,
      surface.sessionId,
    );
    return sessionId ? asSessionId(sessionId) : null;
  }

  private hasValidResumeSession(surface: ManagedSurface): boolean {
    return Boolean(
      surface.hasPairedInGatewaySession &&
      surface.sessionId &&
      surface.localOwnership &&
      surface.localOwnership.providerId === this.persistentState.providerId &&
      surface.localOwnership.sessionId === surface.sessionId &&
      surface.localOwnership.surfaceId === surface.surfaceId,
    );
  }

  private hasTrustedLivePairedSelfRediscovery(surface: ManagedSurface): boolean {
    if (!surface.remotePaired || !this.hasCurrentDiscoveryEndpoint(surface)) {
      return false;
    }
    const ownership = this.persistentState.selfOwnedSurfaceIds?.[surface.surfaceId];
    return Boolean(
      ownership &&
        ownership.relinquishedAt &&
        ownership.source !== "current_target_state" &&
        this.ownershipRecoveryPolicy.isTrustedProviderLineageId(this.persistentState, ownership.providerId),
    );
  }

  private hasPersistedSelfSignals(surface: ManagedSurface): boolean {
    if (this.persistentState.targetStateBySurfaceId?.[surface.surfaceId]) {
      return true;
    }
    return surface.targetCapabilities.size > 0;
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

  private ensureEndpointProbeWorker(probe: EndpointProbe): void {
    if (!probe.autoRetryEnabled || probe.workPromise || probe.stopRequested) {
      return;
    }
    probe.workPromise = this.runEndpointProbeWorker(probe)
      .catch((error) => {
        this.logger.warn?.(
          runtimeDiagnostic("endpoint_probe_worker_error", {
            endpoint_id: probe.endpointId,
            error: String(error),
          }),
        );
      })
      .finally(() => {
        if (probe.workPromise) {
          probe.workPromise = null;
        }
      });
  }

  private async runEndpointProbeWorker(probe: EndpointProbe): Promise<void> {
    while (probe.autoRetryEnabled && !probe.stopRequested && this.endpointProbes.get(probe.endpointId) === probe) {
      let client: SurfAceWireClient | null = null;
      try {
        probe.connectionState = probe.unreachableFailures >= UNREACHABLE_AFTER_FAILURES
          ? "unreachable"
          : "connecting";
        client = new SurfAceWireClient(buildWsUrl(probe.endpoint), {
          onClose: (code, reason) => {
            if (probe.client !== client) {
              return;
            }
            if (!probe.stopRequested && (code !== 1000 || reason !== "provider_shutdown")) {
              this.logger.warn?.(
                runtimeDiagnostic("endpoint_probe_socket_closed", {
                  code,
                  endpoint_id: probe.endpointId,
                  reason: reason || "<none>",
                }),
              );
            }
            probe.connectionState =
              probe.unreachableFailures >= UNREACHABLE_AFTER_FAILURES
                ? "unreachable"
                : "connecting";
          },
        });
        await this.assignEndpointProbeClient(probe, client);
        this.logger.info?.(
          runtimeDiagnostic("endpoint_probe_attempt", {
            attempt: probe.reconnectAttempt + 1,
            endpoint_id: probe.endpointId,
            url: buildWsUrl(probe.endpoint),
          }),
        );
        await client.connect(REQUEST_TIMEOUT_MS);
        const surfacesToStart = await this.discoverEndpointProbeSurfaces(probe, client);
        if (surfacesToStart.length === 0) {
          throw new Error("endpoint probe discovered no canonical surfaces");
        }
        this.resetEndpointProbeConnectionCircuit(probe, "endpoint probe connected", { enableRetry: true });
        await this.closeEndpointProbeClient(probe, client, clampCloseReason("provider_shutdown"));
        for (const surface of surfacesToStart) {
          this.ensureSurfaceWorker(surface);
        }
        return;
      } catch (error) {
        probe.unreachableFailures += 1;
        this.noteEndpointProbeConnectionFailure(probe, String(error));
        await this.refreshEndpointProbeAfterConnectFailure(probe, error);
        probe.connectionState =
          probe.unreachableFailures >= UNREACHABLE_AFTER_FAILURES
            ? "unreachable"
            : "connecting";
        this.logger.warn?.(
          runtimeDiagnostic("endpoint_probe_error", {
            endpoint_id: probe.endpointId,
            error: String(error),
            failures: probe.unreachableFailures,
          }),
        );
      } finally {
        if (client) {
          await this.closeEndpointProbeClient(probe, client, clampCloseReason("provider_shutdown"));
        }
      }

      if (probe.stopRequested) {
        break;
      }
      if (!probe.autoRetryEnabled) {
        break;
      }

      const attempt = probe.reconnectAttempt;
      probe.reconnectAttempt += 1;
      const delay = nextReconnectDelayMs(attempt);
      const jitter = Math.floor(Math.random() * 250);
      await this.waitForEndpointProbeRetry(probe, delay + jitter);
    }
  }

  private async discoverEndpointProbeSurfaces(
    probe: EndpointProbe,
    client: SurfAceWireClient,
  ): Promise<ManagedSurface[]> {
    if (!client.isOpen()) {
      return [];
    }
    let response: Response;
    try {
      response = await client.request(
        this.requestEnvelope("surfaces.list"),
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger.warn?.(
        runtimeDiagnostic("endpoint_probe_surfaces_list_unavailable", {
          endpoint_id: probe.endpointId,
          error: String(error),
        }),
      );
      return [];
    }
    if (isErrorResponse(response)) {
      this.logger.warn?.(
        runtimeDiagnostic("endpoint_probe_surfaces_list_unavailable", {
          endpoint_id: probe.endpointId,
          error: response.error.message,
        }),
      );
      return [];
    }
    return this.reconcileCanonicalSurfacesFromRemoteList({
      endpoint: probe.endpoint,
      remoteSurfaces: (response as SurfacesListResponse).payload.surfaces,
      source: "surfaces.list",
      startDiscoveredSiblings: true,
    });
  }

  private async runSurfaceWorker(surface: ManagedSurface): Promise<void> {
    this.logger.info?.(`[surf-ace:runtime] runSurfaceWorker ENTERED for ${surface.surfaceId} endpoint=${surface.endpointId}`);
    while (surface.autoRetryEnabled && !surface.stopRequested) {
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
          if (surface.stopRequested || this.surfaces.get(surface.surfaceId) !== surface) {
            for (const siblingSurface of siblingSurfaces) {
              this.ensureSurfaceWorker(siblingSurface);
            }
            return;
          }
          this.logger.info?.(
            runtimeDiagnostic("pair_request_begin", {
              resume: Boolean(this.shouldAttemptResume(surface)),
              surface_id: surface.surfaceId,
            }),
          );
          const pair = await this.requestPair(surface);
          const pairResponse = pair.response;
          const restoreAttemptId = pair.restoreAttemptId;
          this.assertPairResponseHasTopologyPanes(surface, pairResponse);
          this.assertPairResponseTopologyMatchesPanes(surface, pairResponse);
          const canonicalSurface = this.adoptCanonicalSurfaceId(
            surface,
            asSurfaceId(pairResponse.payload.surfaceId),
            "pair.response",
          );
          if (canonicalSurface !== surface && canonicalSurface.client !== client) {
            await this.closeSurfaceClient(surface, client, clampCloseReason("provider_shutdown"));
            return;
          }
          if (canonicalSurface !== surface) {
            surface = canonicalSurface;
          }
          const pairBlankSinglePane =
            pairResponse.payload.state.panes.length === 1 &&
            pairResponse.payload.state.panes[0]?.currentContentId == null &&
            pairResponse.payload.state.panes[0]?.contentType == null;
          const pairFreshBlankSinglePane =
            pairBlankSinglePane &&
            pairResponse.payload.resumed === false &&
            (Number(pairResponse.payload.state.topologyRevision) || 0) === 0;
          const pairSinglePaneLabel = pairResponse.payload.state.panes[0]?.paneLabel ?? null;
          const pairTopologyRevision = Number(pairResponse.payload.state.topologyRevision);
          // Now that we have the canonical provider-assigned surface id,
          // attempt restart restoration again keyed by this id, and if no snapshot
          // exists, synthesize a minimal topology from persisted restart content so
          // the very first blank single-pane pair can be preserved in-flight.
          this.restoreRestartProviderAuthorityBeforePair(surface);
          const hadRestartRestoredTopology =
            this.restartTopologyRestoredSurfaceIds.has(surface.surfaceId) &&
            surface.panes.size > 0;
          const hadAcceptedLocalTopology =
            this.hasAcceptedSurfaceTopology(surface) &&
            surface.panes.size > 0;
          const hadRestartOwnershipPendingPair =
            surface.restartOwnershipPendingPair &&
            surface.hasPairedInGatewaySession &&
            surface.sessionId !== null;
          const previousOwnership = {
            ownershipEpoch: surface.ownershipEpoch,
            sessionId: surface.sessionId,
          };
          const preserveRestartPairState =
            this.restartTopologyRestoredSurfaceIds.has(surface.surfaceId) &&
            this.shouldPreserveProviderAuthorityForPairObservation(surface, pairResponse);
          const preserveProviderAuthorityPairState =
            preserveRestartPairState ||
            this.shouldPreserveProviderAuthorityForPairObservation(surface, pairResponse);
          const adoptEmptyPairProviderPaneState =
            preserveProviderAuthorityPairState &&
            !preserveRestartPairState &&
            this.shouldAdoptEmptyPairProviderPaneState(surface, pairResponse);
          this.logger.info?.(
            runtimeDiagnostic("pair_response_ok", {
              pair_state: this.pairResponseStateDiagnosticSummary(pairResponse),
              panes: pairResponse.payload.state.panes.length,
              pane_content_count: pairResponse.payload.state.panes.filter((pane) => pane.currentContentId !== null).length,
              pane_ids: pairResponse.payload.state.panes.map((pane) => Number(pane.paneId)).join(",") || "none",
              pane_labels: pairResponse.payload.state.panes.map((pane) => Number(pane.paneLabel)).join(",") || "none",
              resumed: pairResponse.payload.resumed,
              restore_attempt_id: restoreAttemptId,
              session_id: pairResponse.payload.sessionId,
              surface_id: surface.surfaceId,
              topology_revision: Number(pairResponse.payload.state.topologyRevision),
            }),
          );
          surface.unreachableFailures = 0;
          if (!hadAcceptedLocalTopology && !hadRestartRestoredTopology && !preserveProviderAuthorityPairState) {
            this.logger.warn?.(
              runtimeDiagnostic("restore_pair_decision_clear_local_topology", {
                had_accepted_local_topology: hadAcceptedLocalTopology,
                had_restart_restored_topology: hadRestartRestoredTopology,
                pair_blank_single_pane: pairBlankSinglePane,
                pair_fresh_blank_single_pane: pairFreshBlankSinglePane,
                restore_attempt_id: restoreAttemptId,
                surface_id: surface.surfaceId,
              }),
            );
            this.clearSurfaceLocalTopologyState(surface, {
              preservePaneLabels: hadRestartOwnershipPendingPair,
              preserveRestartContent: hadRestartOwnershipPendingPair,
              preserveRestartSnapshot: hadRestartOwnershipPendingPair,
              preserveTargetState: this.hasSurfaceTargetState(surface),
              targetLifecycleReason: "pair response topology reset",
            });
          }
          this.applyPairState(surface, pairResponse, {
            ignoreEmptyPairContentAuthority: preserveProviderAuthorityPairState,
            previousOwnership,
            prunePairClearedPaneTargets: !preserveProviderAuthorityPairState,
            pruneStalePanes: !preserveProviderAuthorityPairState,
            skipPairPaneState: preserveProviderAuthorityPairState && !adoptEmptyPairProviderPaneState,
          });
          if (this.pendingGuardTopologyPublishSurfaceIds.delete(surface.surfaceId)) {
            try {
              await this.pushTopology(surface, { increment: true });
              this.logger.info?.(
                runtimeDiagnostic("pair_import_guard_topology_published", {
                  pane_count: this.visiblePanes(surface).length,
                  surface_id: surface.surfaceId,
                }),
              );
            } catch (error) {
              this.logger.warn?.(
                runtimeDiagnostic("pair_import_guard_topology_publish_failed", {
                  error: String(error),
                  surface_id: surface.surfaceId,
                }),
              );
            }
          }
          const restoreProviderDecision = {
            adoptEmptyPairProviderPaneState,
            hadAcceptedLocalTopology,
            hadRestartRestoredTopology,
            pairBlankSinglePane,
            pairFreshBlankSinglePane,
            pairPaneContentCount: pairResponse.payload.state.panes.filter((pane) => pane.currentContentId !== null).length,
            pairPaneCount: pairResponse.payload.state.panes.length,
            pairSinglePaneLabel,
            pairTopologyRevision,
            preserveProviderAuthorityPairState,
            preserveRestartPairState,
          };
          this.markPairConnected(
            surface,
            asSessionId(pairResponse.payload.sessionId),
            pairResponse.payload.ownershipEpoch,
            pairResponse.payload.resumed,
          );
          if (preserveProviderAuthorityPairState && this.hasAcceptedSurfaceTopology(surface)) {
            await this.pushTopology(surface);
          }
          if (
            preserveProviderAuthorityPairState &&
            !preserveRestartPairState &&
            !this.restartTopologyRestoredSurfaceIds.has(surface.surfaceId)
          ) {
            this.restartContentBySurface.delete(surface.surfaceId);
          }
          this.restartTopologyRestoredSurfaceIds.delete(surface.surfaceId);
          const pairStateWindowLabelDiffers = pair.requestedWindowLabel !== surface.windowLabel;
          this.restoreRestartContent(surface);
          await this.reconcilePaneTopologyAuthorityFromProvider(surface, "pair response", {
            publishLabelRepairTopology: false,
            requireProviderList: true,
          });
          surface.connectionState = "connected";
          const pairStateLabelsDiffer = this.pairStatePaneLabelsDiffer(surface, pairResponse.payload.state.panes);
          const shouldPublishPaneLabelRepair =
            pairStateLabelsDiffer &&
            this.hasAcceptedSurfaceTopology(surface);
          const shouldPublishSinglePaneWindowLabelRepair =
            pairStateWindowLabelDiffers &&
            pairResponse.payload.state.panes.length === 1 &&
            surface.panes.size === 1 &&
            surface.layout?.type === "pane" &&
            this.hasAcceptedSurfaceTopology(surface);
          const shouldPublishProviderTopology =
            shouldPublishPaneLabelRepair ||
            shouldPublishSinglePaneWindowLabelRepair;
          if (shouldPublishProviderTopology) {
            await this.pushTopology(surface);
          }
          await this.repushSurfaceContent(surface, restoreAttemptId);
          surface.connectionState = "connected";
          await this.syncSurfaceSnapshots(surface, true, {
            publishLabelRepairTopology: shouldPublishProviderTopology,
          });
          this.runBackgroundTask(`collect spatial restore flight recorder ${surface.surfaceId}`, async () => {
            await this.collectSpatialRestoreFlightRecorder(surface, restoreAttemptId, restoreProviderDecision);
          });
          if (await this.publishAuthorityState(surface)) {
            this.startHeartbeat(surface);
          }
          this.queuePersistScreenSnapshot("connection ready");
          for (const siblingSurface of siblingSurfaces) {
            this.ensureSurfaceWorker(siblingSurface);
          }
          await client.waitForClose();
          this.noteConnectionEnded(surface);
        } catch (error) {
          this.noteConnectionEnded(surface);
          surface.unreachableFailures += 1;
          this.noteSurfaceConnectionFailure(surface, String(error));
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
              surface.localOwnership = null;
            }
          }
          if (!this.hasAcceptedSurfaceTopology(surface)) {
            const hadPersistedWindowLabel = this.persistentState.windowLabels[surface.surfaceId] !== undefined;
            delete this.persistentState.windowLabels[surface.surfaceId];
            surface.windowLabel = "";
            if (hadPersistedWindowLabel) {
              this.runBackgroundTask("persist cleared pre-pair window label", async () => {
                await this.persistState();
              });
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
          if (this.isUnownedDisconnectedGhostSurface(surface)) {
            this.removeClosedSurface(surface.surfaceId, "unowned_unreachable");
          }
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
      if (!surface.autoRetryEnabled) {
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
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (surface.retryDelayResolver === finish) {
          surface.retryDelayResolver = null;
        }
        resolve();
      };
      const timeout = setTimeout(finish, delayMs);
      surface.retryDelayResolver = finish;
    });
  }

  private wakeSurfaceRetry(surface: ManagedSurface): void {
    const resolve = surface.retryDelayResolver;
    surface.retryDelayResolver = null;
    resolve?.();
  }

  private async waitForEndpointProbeRetry(probe: EndpointProbe, delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (probe.retryDelayResolver === finish) {
          probe.retryDelayResolver = null;
        }
        resolve();
      };
      const timeout = setTimeout(finish, delayMs);
      probe.retryDelayResolver = finish;
    });
  }

  private wakeEndpointProbeRetry(probe: EndpointProbe): void {
    const resolve = probe.retryDelayResolver;
    probe.retryDelayResolver = null;
    resolve?.();
  }

  private async assignEndpointProbeClient(probe: EndpointProbe, nextClient: SurfAceWireClient): Promise<void> {
    const previousClient = probe.client;
    if (previousClient === nextClient) {
      return;
    }
    if (previousClient) {
      await this.closeEndpointProbeClient(probe, previousClient, clampCloseReason("provider_shutdown"));
    }
    probe.client = nextClient;
  }

  private async closeEndpointProbeClient(
    probe: EndpointProbe,
    client: SurfAceWireClient,
    reason: string,
  ): Promise<void> {
    if (probe.client === client) {
      probe.client = null;
    }
    await client.close(1000, reason).catch(() => {});
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

    const previousEndpointId = surface.endpointId;
    try {
      await this.discovery.refreshNow();
    } catch (refreshError) {
      this.logger.warn?.(
        `[surf-ace:runtime] discovery refresh failed for ${surface.surfaceId}: ${String(refreshError)}`,
      );
      return;
    }

    if (!this.isManagedSurfaceRegistered(surface)) {
      surface.stopRequested = true;
      return;
    }

    const replacementCandidates = this.discovery.getSnapshot().filter(
      (endpoint) => endpoint.fingerprintPrefix === surface.fingerprintPrefix,
    );
    if (replacementCandidates.length > 0) {
      this.logger.warn?.(
        `[surf-ace:runtime] not refreshing stale endpoint for ${surface.surfaceId}: fingerprint ${surface.fingerprintPrefix} is discovery-only and matched ${replacementCandidates.length} endpoint${replacementCandidates.length === 1 ? "" : "s"}`,
      );
      return;
    }
    if (surface.endpointId !== previousEndpointId && surface.client?.isOpen()) {
      void surface.client.close(1000, clampCloseReason("provider_shutdown")).catch(() => {});
    }
  }

  private async refreshEndpointProbeAfterConnectFailure(
    probe: EndpointProbe,
    error: unknown,
  ): Promise<void> {
    if (!isEndpointRefreshableConnectionError(error) || !probe.fingerprintPrefix) {
      return;
    }

    const previousEndpointId = probe.endpointId;
    try {
      await this.discovery.refreshNow();
    } catch (refreshError) {
      this.logger.warn?.(
        `[surf-ace:runtime] discovery refresh failed for endpoint probe ${probe.endpointId}: ${String(refreshError)}`,
      );
      return;
    }

    if (this.endpointProbes.get(probe.endpointId) !== probe) {
      probe.stopRequested = true;
      return;
    }

    const replacementCandidates = this.discovery.getSnapshot().filter(
      (endpoint) => endpoint.fingerprintPrefix === probe.fingerprintPrefix,
    );
    if (replacementCandidates.length > 0) {
      this.logger.warn?.(
        `[surf-ace:runtime] not refreshing stale endpoint probe ${probe.endpointId}: fingerprint ${probe.fingerprintPrefix} is discovery-only and matched ${replacementCandidates.length} endpoint${replacementCandidates.length === 1 ? "" : "s"}`,
      );
      return;
    }
    if (probe.endpointId !== previousEndpointId && probe.client?.isOpen()) {
      void probe.client.close(1000, clampCloseReason("provider_shutdown")).catch(() => {});
    }
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

  private async collectSpatialRestoreFlightRecorder(
    surface: ManagedSurface,
    restoreAttemptId: string,
    providerDecision: Record<string, unknown>,
  ): Promise<void> {
    const request = {
      id: makeBrandedRequestId(),
      op: "diagnostics.flight_recorder",
      payload: {
        maxLines: 240,
        restoreAttemptId,
      },
      sentAt: asEpochMs(this.now()),
      type: "request",
      v: 1,
    } as unknown as Request;
    try {
      const response = await this.sendRequest(surface, request);
      if (isErrorResponse(response)) {
        this.logger.warn?.(
          runtimeDiagnostic("restore_flight_recorder_pull_failed", {
            error: response.error.code,
            restore_attempt_id: restoreAttemptId,
            surface_id: surface.surfaceId,
          }),
        );
        return;
      }
      const payload = (response as unknown as {
        payload?: {
          lines?: unknown;
          logPath?: unknown;
          restoreAttemptId?: unknown;
          surfaceId?: unknown;
        };
      }).payload ?? {};
      const artifact = {
        capturedAt: new Date(this.now()).toISOString(),
        providerDecision,
        providerSurface: {
          endpointId: surface.endpointId,
          paneCount: surface.panes.size,
          surfaceId: surface.surfaceId,
          windowLabel: surface.windowLabel || null,
        },
        restoreAttemptId,
        spatialFlightRecorder: {
          lines: Array.isArray(payload.lines) ? payload.lines.filter((line) => typeof line === "string") : [],
          logPath: typeof payload.logPath === "string" ? payload.logPath : null,
          restoreAttemptId: typeof payload.restoreAttemptId === "string" ? payload.restoreAttemptId : null,
          surfaceId: typeof payload.surfaceId === "string" ? payload.surfaceId : null,
        },
      };
      await ensureDirectory(RESTORE_FLIGHT_RECORDER_ARTIFACT_DIR);
      const artifactPath = path.join(
        RESTORE_FLIGHT_RECORDER_ARTIFACT_DIR,
        `${restoreAttemptId}-${surface.surfaceId}.json`,
      );
      await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
      this.logger.info?.(
        runtimeDiagnostic("restore_flight_recorder_artifact_written", {
          artifact_path: artifactPath,
          line_count: artifact.spatialFlightRecorder.lines.length,
          restore_attempt_id: restoreAttemptId,
          surface_id: surface.surfaceId,
        }),
      );
    } catch (error) {
      this.logger.warn?.(
        runtimeDiagnostic("restore_flight_recorder_pull_failed", {
          error: String(error),
          restore_attempt_id: restoreAttemptId,
          surface_id: surface.surfaceId,
        }),
      );
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

  private async publishAuthorityState(
    surface: ManagedSurface,
    options: { actionableOverride?: boolean; reasonOverride?: string | null } = {},
  ): Promise<boolean> {
    const client = surface.client;
    if (!client?.isOpen()) {
      this.invalidateClientAuthority(surface, "socket_not_open");
      return false;
    }
    if (!surface.protocolFeatures.has(AUTHORITY_STATE_PROTOCOL_FEATURE)) {
      this.invalidateClientAuthority(surface, "authority_state_unsupported");
      return false;
    }
    const decision = this.baseProviderAuthorityForSurface(surface);
    const actionable = options.actionableOverride ?? decision.actionable;
    const reason = options.reasonOverride ?? decision.reason;
    const identityKey = this.authorityIdentityKey(surface);
    const request = this.requestEnvelope("authority.state", {
      actionable,
      reason,
      ownershipEpoch: surface.ownershipEpoch,
      panes: this.visiblePanes(surface).map((pane) => ({
        paneId: pane.remotePaneId,
        paneLabel: pane.paneLabel,
        paneLineageId: pane.paneLineageId,
      })),
      providerId: this.persistentState.providerId as ProviderId,
      sessionId: surface.sessionId ?? "" as SessionId,
      surfaceId: surface.surfaceId,
      windowLabel: surface.windowLabel,
    } satisfies AuthorityStateRequest["payload"]);
    try {
      const response = await client.request(request, REQUEST_TIMEOUT_MS);
      if (!response.ok || response.op !== "authority.state" || response.payload.accepted !== true) {
        this.invalidateClientAuthority(
          surface,
          response.ok && response.op === "authority.state" ? response.payload.reason ?? "authority_rejected" : "error_response",
        );
        this.logger.warn?.(
          runtimeDiagnostic("authority_state_rejected", {
            reason: response.ok && response.op === "authority.state" ? response.payload.reason ?? "unknown" : "error_response",
            surface_id: surface.surfaceId,
          }),
        );
        return false;
      }
      if (actionable) {
        surface.authorityAcceptedAt = this.now();
        surface.authorityAcceptedIdentityKey = identityKey;
        surface.authorityRejectedReason = null;
      } else {
        this.invalidateClientAuthority(surface, reason ?? "provider_not_actionable");
      }
      return actionable;
    } catch (error) {
      this.invalidateClientAuthority(surface, "authority_state_unavailable");
      this.logger.warn?.(
        runtimeDiagnostic("authority_state_unavailable", {
          error: String(error),
          surface_id: surface.surfaceId,
        }),
      );
      return false;
    }
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
    options: { publishLabelRepairTopology?: boolean } = {},
  ): Promise<void> {
    if (!this.canSendRequests(surface) || (surface.snapshotSyncInFlight && !force)) {
      return;
    }

    surface.snapshotSyncInFlight = true;
    try {
      await this.syncRemotePaneList(surface, {
        publishLabelRepairTopology: options.publishLabelRepairTopology,
      });
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

  private async syncRemotePaneList(
    surface: ManagedSurface,
    options: { publishLabelRepairTopology?: boolean } = {},
  ): Promise<PaneId[] | null> {
    if (!this.canSendRequests(surface)) {
      return null;
    }

    let response: Response;
    try {
      response = await this.sendRequest(surface, this.requestEnvelope("panes.list"));
    } catch (error) {
      if (error instanceof SurfAceToolError && error.code === "not_connected") {
        return null;
      }
      throw error;
    }
    if (isErrorResponse(response)) {
      return null;
    }

    const rawPaneStates = (response as PanesListResponse).payload.panes;
    const providerOwnedRemotePaneIds =
      surface.topologyRevision > 0 ? this.layoutRemotePaneIds(surface) : null;
    const paneStates = rawPaneStates.filter((paneState) =>
      !providerOwnedRemotePaneIds || providerOwnedRemotePaneIds.has(paneState.paneId),
    );
    this.logger.info?.(
      runtimeDiagnostic("panes_list_summary", {
        adopted_pane_count: paneStates.length,
        adopted_panes: this.paneListDiagnosticSummary(paneStates),
        layout: JSON.stringify(surface.layout),
        raw_pane_count: rawPaneStates.length,
        raw_panes: this.paneListDiagnosticSummary(rawPaneStates),
        surface_id: surface.surfaceId,
        topology_revision: surface.topologyRevision,
      }),
    );
    this.assertProviderPaneLabelsUnique(surface, paneStates);
    let lineageChanged = false;
    let contentStateChanged = false;
    let targetAuthorityChanged = false;
    const providerPaneLabels: Array<{ pane: ManagedPane; paneLabel: number; remotePaneId: RemotePaneId }> = [];
    const providerPaneIds: PaneId[] = [];
    for (const paneState of paneStates) {
      const pane = this.ensurePane(surface, paneState.paneId);
      pane.name = paneState.name;
      providerPaneIds.push(pane.paneId);
      providerPaneLabels.push({ pane, paneLabel: paneState.paneLabel, remotePaneId: paneState.paneId });
      pane.externalNative = paneState.externalNative === true;
      pane.nativeWindowGroup = paneState.nativeWindowGroup ? structuredClone(paneState.nativeWindowGroup) : null;
      if (
        pane.nativeWindowGroup &&
        pane.lastRestoreBlockedReason === "materialization_failed" &&
        isNativeHostTargetKind(this.currentTargetRecord(surface, pane)?.targetKind)
      ) {
        pane.lastRestoreBlockedReason = null;
        targetAuthorityChanged = true;
      }
      pane.viewport = cloneViewport(paneState.viewport);
      pane.geometry = structuredClone(paneState.geometry);
      if (pane.externalNative) {
        await this.clearBrowserUrlTargetForNativePane(surface, pane);
      }
      if (typeof paneState.paneLineageId === "string" && paneState.paneLineageId.length > 0) {
        lineageChanged = this.adoptPaneLineage(surface, pane, paneState.paneLineageId) || lineageChanged;
      }
      const nextContentId = paneState.activeContentId;
      const nextContentType = paneState.contentType;
      if (nextContentId && nextContentType) {
        const nextDisplay = paneState.display ? structuredClone(paneState.display) : null;
        const nextOwnerSessionKey = pusherSessionKeyFromDisplay(nextDisplay);
        const contentIdentityChanged =
          pane.activeContentId !== nextContentId ||
          pane.contentType !== nextContentType;
        const displayChanged = JSON.stringify(pane.display) !== JSON.stringify(nextDisplay);
        const ownerChanged = nextOwnerSessionKey !== null && pane.ownerSessionKey !== nextOwnerSessionKey;
        if (contentIdentityChanged || displayChanged || ownerChanged) {
          contentStateChanged = true;
        }
        pane.activeContentId = nextContentId;
        pane.contentType = nextContentType;
        if (contentIdentityChanged) {
          pane.contentValue = null;
          pane.snapshot = pane.snapshot?.contentId === nextContentId ? pane.snapshot : null;
        }
        pane.display = nextDisplay;
        if (nextOwnerSessionKey !== null) {
          pane.ownerSessionKey = nextOwnerSessionKey;
        }
        pane.historySummary.visibleContentId = nextContentId;
        pane.pairImportedContentAuthority = true;
        targetAuthorityChanged = this.repairProviderOwnedContentTargetAuthority(surface, pane) || targetAuthorityChanged;
      }
    }
    const topologyChanged = this.reconcilePreRevisionPaneListLayout(surface);
    const labelsChanged = this.adoptProviderPaneLabels(surface, providerPaneLabels);
    this.repairLivePaneLabelInvariant(
      "pane list sync",
      surface,
      surface.topologyApplyInFlight ? surface : undefined,
      { publishTopology: options.publishLabelRepairTopology },
    );
    if (lineageChanged) {
      await this.persistSurfaceTargetState(surface, "pane list lineage repair");
    }
    if (targetAuthorityChanged) {
      await this.persistSurfaceTargetState(surface, "pane list target authority repair");
    }
    if (labelsChanged || topologyChanged || contentStateChanged) {
      this.queuePersistScreenSnapshot(
        labelsChanged ? "pane list label repair" : contentStateChanged ? "pane list content repair" : "pane list topology repair",
      );
    }
    return providerPaneIds;
  }

  private pairResponseStateDiagnosticSummary(pairResponse: PairResponse): string {
    const state = pairResponse.payload.state;
    const panes = state.panes.map((pane) =>
      `${Number(pane.paneId)}:${Number(pane.paneLabel)}:${pane.currentContentId ?? "nil"}`
    ).join(",");
    return `rev=${Number(state.topologyRevision)} panes=${panes || "none"} layout=${JSON.stringify(state.layout)}`;
  }

  private paneListDiagnosticSummary(panes: PanesListResponse["payload"]["panes"]): string {
    return panes.map((pane) =>
      `${Number(pane.paneId)}:${Number(pane.paneLabel)}:${pane.activeContentId ?? "nil"}`
    ).join(",") || "none";
  }

  private reconcilePreRevisionPaneListLayout(surface: ManagedSurface): boolean {
    if (surface.topologyRevision > 0) {
      return false;
    }
    if (surface.topologyApplyInFlight) {
      return false;
    }
    const ordered = this.orderedPanes(surface);
    if (ordered.length <= 1) {
      return false;
    }
    const layoutPaneIds = flattenManagedLayout(surface.layout);
    if (layoutPaneIds.some((paneId) => !isBoundRemotePaneId(surface.panes.get(paneId)?.remotePaneId))) {
      return false;
    }
    const providerLayout = managedLayoutFromEqualProviderGeometry(ordered);
    if (!providerLayout || managedLayoutEquals(surface.layout, providerLayout)) {
      return false;
    }
    surface.layout = providerLayout;
    return true;
  }

  private async ensureCurrentPaneLineage(surface: ManagedSurface, pane: ManagedPane): Promise<void> {
    await this.syncRemotePaneList(surface);
    if (!isLegacyPaneLineageId(pane.paneLineageId)) {
      return;
    }
    await this.pushTopology(surface);
  }

  private adoptPaneLineage(
    surface: ManagedSurface,
    pane: ManagedPane,
    nextLineageId: string,
  ): boolean {
    const previousLineageId = pane.paneLineageId;
    if (previousLineageId === nextLineageId) {
      return false;
    }
    const previousCurrentTargetId = pane.currentTargetId;
    pane.paneLineageId = nextLineageId;
    if (!isLegacyPaneLineageId(previousLineageId)) {
      pane.targetEpoch = 0;
    }

    for (const target of surface.targetRecords.values()) {
      if (target.paneLineageId !== previousLineageId) {
        continue;
      }
      const matchesPreviousCurrentTarget = target.targetId === previousCurrentTargetId;
      const sameTargetIdentity =
        matchesPreviousCurrentTarget ||
        target.targetId === pane.staleTargetId;
      if (sameTargetIdentity) {
        target.paneLineageId = nextLineageId;
        if (matchesPreviousCurrentTarget && target.currentState === "stale") {
          target.currentState = "current";
          delete target.supersededByTargetId;
        }
        if (matchesPreviousCurrentTarget) {
          pane.currentTargetId = target.targetId;
          if (pane.staleTargetId === target.targetId) {
            pane.staleTargetId = null;
          }
          if (pane.lastRestoreBlockedReason === "restore_blocked_stale_target") {
            pane.lastRestoreBlockedReason = null;
          }
        }
      } else if (
        (!isLegacyPaneLineageId(previousLineageId) || !sameTargetIdentity) &&
        target.currentState === "current" &&
        (target.targetId === previousCurrentTargetId || target.paneLineageId === previousLineageId)
      ) {
        this.markTargetStale(
          surface,
          target,
          "restore_blocked_stale_target",
          "Pane lineage changed without explicit target remap",
          pane,
        );
      }
    }
    if (pane.diagnosticContent?.paneLineageId === previousLineageId) {
      pane.diagnosticContent.paneLineageId = nextLineageId;
    }
    if (pane.nonDurableTargetDiagnostic?.paneLineageId === previousLineageId) {
      pane.nonDurableTargetDiagnostic.paneLineageId = nextLineageId;
    }
    return true;
  }

  private async clearBrowserUrlTargetForNativePane(surface: ManagedSurface, pane: ManagedPane): Promise<void> {
    const targetIds = new Set<string>();
    const pointerTarget = this.currentTargetRecord(surface, pane);
    if (pointerTarget?.targetKind === "browser_url") {
      targetIds.add(pointerTarget.targetId);
    }
    for (const target of this.currentProviderTargetsForPaneLineage(surface, pane)) {
      if (target.targetKind === "browser_url") {
        targetIds.add(target.targetId);
      }
    }
    if (targetIds.size === 0) {
      return;
    }
    this.clearVisiblePaneContent(pane, pane.currentRevision);
    for (const targetId of targetIds) {
      const target = surface.targetRecords.get(targetId);
      if (!target) {
        continue;
      }
      target.currentState = "tombstoned";
      this.recordTargetLifecycleEvent(surface, {
        event: "tombstone",
        paneLineageId: target.paneLineageId,
        reason: "native pane superseded browser_url target",
        targetId: target.targetId,
      });
      this.logger.info?.(
        runtimeDiagnostic("target_lifecycle_tombstone", {
          pane_lineage_id: target.paneLineageId,
          reason: "native pane superseded browser_url target",
          surface_id: surface.surfaceId,
          target_id: target.targetId,
        }),
      );
    }
    pane.currentTargetId = null;
    pane.staleTargetId = null;
    pane.lastRestoreBlockedReason = null;
    pane.nonDurableTargetDiagnostic = null;
    await this.persistSurfaceTargetState(surface, "native pane superseded browser_url target");
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

  private layoutRemotePaneIds(surface: ManagedSurface): Set<RemotePaneId> {
    const remotePaneIds = new Set<RemotePaneId>();
    for (const pane of this.layoutPanes(surface)) {
      if (isBoundRemotePaneId(pane.remotePaneId)) {
        remotePaneIds.add(pane.remotePaneId);
      }
    }
    return remotePaneIds;
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

  private markPairConnected(
    surface: ManagedSurface,
    sessionId: SessionId,
    ownershipEpoch: number,
    resumed: boolean,
  ): void {
    const previousSessionId = surface.sessionId;
    const previousOwnershipEpoch = surface.ownershipEpoch;
    surface.consecutiveResumeFailures = 0;
    surface.consecutiveOwnershipLockFailures = 0;
    surface.connectedAt = this.now();
    this.resetSurfaceConnectionCircuit(surface, "pair connected", { enableRetry: true });
    surface.autoRetryEnabled = true;
    surface.hasPairedInGatewaySession = true;
    surface.localOwnership = {
      ...endpointProvenance(surface.endpoint),
      acceptedAt: surface.connectedAt,
      providerId: this.persistentState.providerId,
      sessionId,
      source: "pair.response",
      surfaceId: surface.surfaceId,
    };
    surface.selfOwnershipReclaimAttempted = false;
    surface.remotePaired = true;
    surface.restartOwnershipPendingPair = false;
    this.noteSelfOwnedSurface(surface.surfaceId, this.persistentState.providerId, "current_local_ownership");
    const ownershipChanged =
      !resumed ||
      previousSessionId !== sessionId ||
      previousOwnershipEpoch !== ownershipEpoch;
    surface.ownershipEpoch = ownershipEpoch;
    if (ownershipChanged) {
      let staleTargetStateChanged = false;
      for (const pane of surface.panes.values()) {
        staleTargetStateChanged = this.markAmbiguousProviderPaneAuthorityStale(surface, pane) || staleTargetStateChanged;
      }
      for (const target of surface.targetRecords.values()) {
        if (target.currentState !== "current") {
          continue;
        }
        const pane = [...surface.panes.values()].find((candidate) => candidate.currentTargetId === target.targetId) ??
          [...surface.panes.values()].find((candidate) => candidate.paneLineageId === target.paneLineageId);
        if (this.rebindCurrentSelfTargetOwnership(surface, target, pane, sessionId, ownershipEpoch, {
          previousOwnershipEpoch,
          previousSessionId,
        })) {
          staleTargetStateChanged = true;
          continue;
        }
        staleTargetStateChanged = this.markTargetStale(
          surface,
          target,
          "ownership_epoch_mismatch",
          "Target ownership epoch changed without a resume guarantee",
          pane,
        ) || staleTargetStateChanged;
      }
      if (staleTargetStateChanged) {
        this.runBackgroundTask("persist stale target state after ownership change", async () => {
          await this.persistSurfaceTargetState(surface, "stale target ownership change");
        });
      }
    }
    surface.sessionId = sessionId;
    this.repairLiveWindowLabelInvariant("pair connected");
    this.queuePersistScreenSnapshot("pair connected");
  }

  private rebindCurrentSelfTargetOwnership(
    surface: ManagedSurface,
    target: PaneTargetRecord,
    pane: ManagedPane | undefined,
    sessionId: SessionId | string,
    ownershipEpoch: number,
    previousOwnership: {
      previousOwnershipEpoch: number;
      previousSessionId: SessionId | string | null;
    },
  ): boolean {
    void previousOwnership;
    if (
      !pane ||
      target.currentState !== "current" ||
      target.surfaceId !== surface.surfaceId ||
      target.paneLineageId !== pane.paneLineageId ||
      !this.isTrustedProviderLineageId(target.ownerProviderId)
    ) {
      return false;
    }
    if (pane.currentTargetId !== null && pane.currentTargetId !== target.targetId) {
      return false;
    }
    let changed = false;
    if (target.ownerProviderId !== this.persistentState.providerId) {
      target.ownerProviderId = this.persistentState.providerId;
      changed = true;
    }
    if (target.ownershipSessionId !== sessionId) {
      target.ownershipSessionId = String(sessionId);
      changed = true;
    }
    if (target.ownershipEpoch !== ownershipEpoch) {
      target.ownershipEpoch = ownershipEpoch;
      changed = true;
    }
    if (pane.currentTargetId !== target.targetId) {
      pane.currentTargetId = target.targetId;
      changed = true;
    }
    if (pane.staleTargetId === target.targetId) {
      pane.staleTargetId = null;
      changed = true;
    }
    if (
      pane.lastRestoreBlockedReason === "ownership_epoch_mismatch" ||
      pane.lastRestoreBlockedReason === "ownership_session_mismatch"
    ) {
      pane.lastRestoreBlockedReason = null;
      changed = true;
    }
    return changed;
  }

  private noteConnectionEnded(surface: ManagedSurface): void {
    const connectionDurationMs = surface.connectedAt ? this.now() - surface.connectedAt : 0;
    if (surface.autoRetryEnabled && connectionDurationMs >= STABLE_CONNECTION_RESET_MS) {
      this.resetSurfaceConnectionCircuit(surface, "stable connection ended");
    }
    surface.connectedAt = null;
    this.queuePersistScreenSnapshot("connection ended");
  }

  private noteSurfaceConnectionFailure(surface: ManagedSurface, reason: string): void {
    if (surface.unreachableFailures >= UNREACHABLE_AFTER_FAILURES && surface.connectionCircuitOpenedAt === null) {
      surface.connectionCircuitOpenedAt = this.now();
      surface.connectionCircuitReason = reason;
      surface.autoRetryEnabled = false;
      surface.connectionState = "unreachable";
      this.logger.warn?.(
        runtimeDiagnostic("connection_circuit_open", {
          auto_retry_enabled: surface.autoRetryEnabled,
          failures: surface.unreachableFailures,
          surface_id: surface.surfaceId,
        }),
      );
      this.queuePersistScreenSnapshot("surface connection circuit open");
    }
    if (surface.unreachableFailures < GIVE_UP_AFTER_FAILURES) {
      return;
    }
    surface.connectionState = "unreachable";
    this.logger.warn?.(
      runtimeDiagnostic("connection_duration_pressure", {
        failures: surface.unreachableFailures,
        surface_id: surface.surfaceId,
      }),
    );
    this.queuePersistScreenSnapshot("surface connection duration pressure");
  }

  private noteEndpointProbeConnectionFailure(probe: EndpointProbe, reason: string): void {
    if (probe.unreachableFailures >= UNREACHABLE_AFTER_FAILURES && probe.connectionCircuitOpenedAt === null) {
      probe.connectionCircuitOpenedAt = this.now();
      probe.connectionCircuitReason = reason;
      probe.autoRetryEnabled = false;
      probe.connectionState = "unreachable";
      this.logger.warn?.(
        runtimeDiagnostic("endpoint_probe_circuit_open", {
          auto_retry_enabled: probe.autoRetryEnabled,
          endpoint_id: probe.endpointId,
          failures: probe.unreachableFailures,
        }),
      );
      this.queuePersistScreenSnapshot("endpoint probe circuit open");
    }
    if (probe.unreachableFailures < GIVE_UP_AFTER_FAILURES) {
      return;
    }
    probe.connectionState = "unreachable";
    this.logger.warn?.(
      runtimeDiagnostic("endpoint_probe_duration_pressure", {
        endpoint_id: probe.endpointId,
        failures: probe.unreachableFailures,
      }),
    );
  }

  private resetSurfaceConnectionCircuit(
    surface: ManagedSurface,
    _reason: string,
    options: { enableRetry?: boolean } = {},
  ): void {
    if (!surface.autoRetryEnabled && !options.enableRetry) {
      return;
    }
    if (options.enableRetry) {
      surface.autoRetryEnabled = true;
    }
    surface.connectionCircuitOpenedAt = null;
    surface.connectionCircuitReason = null;
    surface.reconnectAttempt = 0;
    surface.unreachableFailures = 0;
    if (surface.connectionState !== "connected") {
      surface.connectionState = "connecting";
    }
  }

  private resetEndpointProbeConnectionCircuit(
    probe: EndpointProbe,
    _reason: string,
    options: { enableRetry?: boolean } = {},
  ): void {
    if (!probe.autoRetryEnabled && !options.enableRetry) {
      return;
    }
    if (options.enableRetry) {
      probe.autoRetryEnabled = true;
    }
    probe.connectionCircuitOpenedAt = null;
    probe.connectionCircuitReason = null;
    probe.reconnectAttempt = 0;
    probe.unreachableFailures = 0;
    if (probe.connectionState !== "connected") {
      probe.connectionState = "connecting";
    }
    probe.stopRequested = false;
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
    surface.localOwnership = null;
    surface.restartOwnershipPendingPair = false;
    surface.consecutiveResumeFailures = 0;
  }

  private clearSurfaceLocalTopologyState(
    surface: ManagedSurface,
    options: {
      preservePaneLabels?: boolean;
      preserveRestartContent?: boolean;
      preserveRestartSnapshot?: boolean;
      preserveTargetState?: boolean;
      targetLifecycleReason?: string;
    } = {},
  ): void {
    if (options.preserveRestartSnapshot !== true) {
      this.restartSnapshots.delete(surface.surfaceId);
    }
    if (options.preserveRestartContent !== true) {
      this.restartContentBySurface.delete(surface.surfaceId);
    }
    for (const pane of surface.panes.values()) {
      this.clearVisiblePaneContent(pane, asRevision(0));
      pane.currentTargetId = null;
      pane.staleTargetId = null;
      pane.lastRestoreBlockedReason = null;
      pane.nonDurableTargetDiagnostic = null;
    }
    surface.panes = new Map<PaneId, ManagedPane>();
    surface.layout = null;
    surface.topologyRevision = 0;
    if (options.preservePaneLabels !== true) {
      for (const storageKey of Object.keys(this.persistentState.paneLabelsByPaneId)) {
        if (storageKey.startsWith(`${surface.surfaceId}::`)) {
          delete this.persistentState.paneLabelsByPaneId[storageKey];
        }
      }
    }
    surface.paneIdsNeedingSnapshot.clear();
    surface.snapshotBufferedEvents = [];
    if (options.preserveTargetState !== true) {
      surface.targetRecords.clear();
    }
    if (options.preserveTargetState !== true && this.persistentState.targetStateBySurfaceId) {
      if (this.persistentState.targetStateBySurfaceId[surface.surfaceId]) {
        const reason = options.targetLifecycleReason ?? "clear local topology state";
        this.recordTargetLifecycleEventForSurfaceId(surface.surfaceId, {
          event: "remove",
          reason,
        });
        this.logger.info?.(
          runtimeDiagnostic("target_lifecycle_remove", {
            reason,
            surface_id: surface.surfaceId,
          }),
        );
      }
      delete this.persistentState.targetStateBySurfaceId[surface.surfaceId];
    }
  }

  private clearForeignOwnershipLocalState(surface: ManagedSurface): void {
    const preserveTargetState = this.hasRecoverableForeignTargetState(surface);
    if (preserveTargetState) {
      this.prunePassiveForeignTargetState(surface);
      this.markForeignOwnershipTargetStateStale(surface);
    }
    this.clearSurfaceResumeState(surface);
    this.clearSurfaceLocalTopologyState(surface, {
      preserveTargetState,
      targetLifecycleReason: "foreign ownership state clear",
    });
    if (preserveTargetState) {
      this.captureSurfaceTargetState(surface);
    }
    this.runBackgroundTask("persist foreign ownership state clear", async () => {
      await this.persistState();
    });
  }

  private markForeignOwnershipTargetStateStale(surface: ManagedSurface): void {
    for (const target of surface.targetRecords.values()) {
      if (target.currentState !== "current") {
        continue;
      }
      this.markTargetStale(
        surface,
        target,
        "restore_blocked_stale_target",
        "Different-provider ownership lock invalidated current target authority",
      );
    }
  }

  private hasSurfaceTargetState(surface: ManagedSurface): boolean {
    if (surface.targetRecords.size > 0) {
      return true;
    }
    return this.isHydratablePersistedTargetState(
      this.persistentState.targetStateBySurfaceId?.[surface.surfaceId],
    );
  }

  private hasRecoverableForeignTargetState(surface: ManagedSurface): boolean {
    const hasRecoverableRecord = (record: PaneTargetRecord): boolean =>
      record.targetHeader.safetyClass !== "passive";
    if ([...surface.targetRecords.values()].some(hasRecoverableRecord)) {
      return true;
    }
    const persisted = this.persistentState.targetStateBySurfaceId?.[surface.surfaceId];
    return Boolean(
      this.isHydratablePersistedTargetState(persisted) &&
        persisted?.targetRecords.some(hasRecoverableRecord),
    );
  }

  private prunePassiveForeignTargetState(surface: ManagedSurface): void {
    const isRecoverableRecord = (record: PaneTargetRecord): boolean =>
      record.targetHeader.safetyClass !== "passive";
    const recoverableTargetIds = new Set<string>();
    surface.targetRecords = new Map(
      [...surface.targetRecords.values()]
        .filter(isRecoverableRecord)
        .map((record) => {
          recoverableTargetIds.add(record.targetId);
          return [record.targetId, record];
        }),
    );
    surface.registeredTargetIdsByIdempotencyKey = new Map(
      [...surface.registeredTargetIdsByIdempotencyKey.entries()].filter(([, targetId]) =>
        recoverableTargetIds.has(targetId),
      ),
    );
    for (const pane of surface.panes.values()) {
      if (pane.currentTargetId && !recoverableTargetIds.has(pane.currentTargetId)) {
        pane.currentTargetId = null;
        pane.lastRestoreBlockedReason = null;
      }
      if (pane.staleTargetId && !recoverableTargetIds.has(pane.staleTargetId)) {
        pane.staleTargetId = null;
        pane.lastRestoreBlockedReason = null;
      }
      if (
        pane.diagnosticContent?.derivedFromTargetId &&
        !recoverableTargetIds.has(pane.diagnosticContent.derivedFromTargetId)
      ) {
        pane.diagnosticContent = null;
      }
      if (pane.nonDurableTargetDiagnostic && !recoverableTargetIds.has(pane.nonDurableTargetDiagnostic.targetId)) {
        pane.nonDurableTargetDiagnostic = null;
      }
    }
    const persisted = this.persistentState.targetStateBySurfaceId?.[surface.surfaceId];
    if (!this.isHydratablePersistedTargetState(persisted) || !persisted) {
      return;
    }
    const persistedRecoverableTargetIds = new Set<string>();
    const targetRecords = persisted.targetRecords.filter((record) => {
      const keep = isRecoverableRecord(record);
      if (keep) {
        persistedRecoverableTargetIds.add(record.targetId);
      }
      return keep;
    });
    const paneTargets = Object.fromEntries(
      Object.entries(persisted.paneTargets).map(([paneLineageId, paneTarget]) => {
        const currentTargetId =
          paneTarget.currentTargetId && persistedRecoverableTargetIds.has(paneTarget.currentTargetId)
            ? paneTarget.currentTargetId
            : null;
        const staleTargetId =
          paneTarget.staleTargetId && persistedRecoverableTargetIds.has(paneTarget.staleTargetId)
            ? paneTarget.staleTargetId
            : null;
        let lastRestoreBlockedReason =
          currentTargetId !== null || staleTargetId !== null
            ? paneTarget.lastRestoreBlockedReason
            : null;
        const diagnosticContent =
          paneTarget.diagnosticContent?.derivedFromTargetId &&
          !persistedRecoverableTargetIds.has(paneTarget.diagnosticContent.derivedFromTargetId)
            ? null
            : paneTarget.diagnosticContent;
        const nonDurableTargetDiagnostic =
          paneTarget.nonDurableTargetDiagnostic &&
          !persistedRecoverableTargetIds.has(paneTarget.nonDurableTargetDiagnostic.targetId)
            ? null
            : paneTarget.nonDurableTargetDiagnostic ?? null;
        if (
          paneTarget.diagnosticContent !== diagnosticContent ||
          paneTarget.nonDurableTargetDiagnostic !== nonDurableTargetDiagnostic
        ) {
          lastRestoreBlockedReason = null;
        }
        return [
          paneLineageId,
          {
            ...paneTarget,
            currentTargetId,
            diagnosticContent,
            lastRestoreBlockedReason,
            nonDurableTargetDiagnostic,
            staleTargetId,
          },
        ];
      }),
    );
    const registeredTargetIdsByIdempotencyKey = Object.fromEntries(
      Object.entries(persisted.registeredTargetIdsByIdempotencyKey).filter(([, targetId]) =>
        persistedRecoverableTargetIds.has(targetId),
      ),
    );
    this.persistentState.targetStateBySurfaceId![surface.surfaceId] = {
      ...persisted,
      paneTargets,
      registeredTargetIdsByIdempotencyKey,
      targetRecords,
    };
  }

  private isHydratablePersistedTargetState(persisted: PersistedSurfaceTargetState | undefined): boolean {
    return Boolean(
      persisted &&
        isPlainRecord(persisted.paneTargets) &&
        Array.isArray(persisted.targetRecords),
    );
  }

  private shouldAttemptResume(surface: ManagedSurface): boolean {
    return this.hasValidResumeSession(surface);
  }

  private shouldPreserveProviderAuthorityForPairObservation(
    surface: ManagedSurface,
    pairResponse: PairResponse,
  ): boolean {
    if (
      !this.hasAcceptedSurfaceTopology(surface) &&
      !this.restartTopologyRestoredSurfaceIds.has(surface.surfaceId)
    ) {
      return false;
    }
    const pairPanes = pairResponse.payload.state.panes;
    if (pairPanes.length === 0) {
      return false;
    }
    const visiblePanes = this.visiblePanes(surface);
    if (visiblePanes.length === 0) {
      return false;
    }
    const pairRemotePaneIds = new Set(pairPanes.map((pane) => Number(pane.paneId)));
    const omitsVisiblePane = visiblePanes.some((pane) =>
      isBoundRemotePaneId(pane.remotePaneId) && !pairRemotePaneIds.has(Number(pane.remotePaneId))
    );
    const collapsesTopology = pairPanes.length < visiblePanes.length;
    const visiblePaneLabels = new Set(visiblePanes.map((pane) => pane.paneLabel));
    const pairPaneLabels = new Set(pairPanes.map((pane) => pane.paneLabel));
    const pairCoversVisibleLabels =
      pairPanes.length >= visiblePanes.length &&
      visiblePanes.every((pane) => pairPaneLabels.has(pane.paneLabel)) &&
      pairPanes.every((pane) => visiblePaneLabels.has(pane.paneLabel));
    if (pairCoversVisibleLabels && !collapsesTopology) {
      return false;
    }
    if (
      (!omitsVisiblePane && !collapsesTopology) ||
      !this.hasProviderAuthorityContinuityOutsideRemotePanes(surface, pairRemotePaneIds)
    ) {
      return false;
    }
    this.logger.info?.(
      runtimeDiagnostic("pair_observation_preserved_provider_topology_authority", {
        observed_content_count: pairPanes.filter((pane) => pane.currentContentId !== null).length,
        observed_pane_count: pairPanes.length,
        surface_id: surface.surfaceId,
        visible_pane_count: visiblePanes.length,
        window_label: surface.windowLabel || "nil",
      }),
    );
    return true;
  }

  private shouldAdoptEmptyPairProviderPaneState(
    surface: ManagedSurface,
    pairResponse: PairResponse,
  ): boolean {
    const pairPanes = pairResponse.payload.state.panes;
    if (pairPanes.length !== 1 || pairPanes[0]?.currentContentId !== null) {
      return false;
    }
    const visiblePanes = this.visiblePanes(surface);
    if (visiblePanes.length !== 1) {
      return false;
    }
    return this.hasProviderOwnedPaneAuthority(surface, visiblePanes[0]!);
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

  private applyPairState(
    surface: ManagedSurface,
    response: PairResponse,
    options: {
      ignoreEmptyPairContentAuthority?: boolean;
      previousOwnership?: {
        ownershipEpoch: number;
        sessionId: SessionId | null;
      };
      prunePairClearedPaneTargets?: boolean;
      pruneStalePanes?: boolean;
      skipPairPaneState?: boolean;
    } = {},
  ): void {
    const previousName = surface.name;
    const previousViewport = cloneViewport(surface.viewport);
    const previousProtocolFeatures = new Set(surface.protocolFeatures);
    const previousTargetCapabilities = new Set(surface.targetCapabilities);
    surface.name = response.payload.surfaceName;
    surface.viewport = cloneViewport(response.payload.viewport);
    surface.protocolFeatures = new Set(response.payload.capabilities.protocolFeatures ?? []);
    surface.runtimeAppBinding = response.payload.capabilities.runtimeAppBinding
      ? structuredClone(response.payload.capabilities.runtimeAppBinding)
      : null;
    surface.targetCapabilities = this.targetCapabilitiesForPair(response);
    try {
      const pairImportedRemotePaneIds = new Set<number>();
      const pairResponseRemotePaneIds = new Set<number>();
      if (options.prunePairClearedPaneTargets === true) {
        for (const paneState of response.payload.state.panes) {
          pairResponseRemotePaneIds.add(Number(paneState.paneId));
          const existingPane = this.findPaneByRemoteId(surface, paneState.paneId);
          if (
            paneState.currentContentId !== null && (
              !existingPane ||
              existingPane.activeContentId !== paneState.currentContentId ||
              existingPane.contentType !== paneState.contentType
            )
          ) {
            pairImportedRemotePaneIds.add(Number(paneState.paneId));
          }
        }
      }
      if (options.skipPairPaneState !== true) {
        this.applyPairPaneState(
          surface,
          response.payload.state.panes,
          response.payload.resumed === true,
          {
            ...options,
            ignoreEmptyPairContentAuthority: options.ignoreEmptyPairContentAuthority,
            pairStateLayout: response.payload.state.layout,
            pairStateTopologyRevision: response.payload.state.topologyRevision,
          },
        );
      }
      if (this.restartTopologyRestoredSurfaceIds.has(surface.surfaceId)) {
        for (const paneState of response.payload.state.panes) {
          const pane = this.findPaneByRemoteId(surface, paneState.paneId);
          if (
            pane &&
            paneState.currentContentId !== null &&
            pane.activeContentId === paneState.currentContentId &&
            pane.contentType === paneState.contentType
          ) {
            pairImportedRemotePaneIds.delete(Number(paneState.paneId));
          }
        }
      }
      if (options.prunePairClearedPaneTargets === true) {
        this.pruneRestartContentForPairImportedPanes(
          surface,
          pairResponseRemotePaneIds,
        );
      }
      this.hydrateSurfaceTargetState(
        surface,
        response.payload.resumed === true,
        options.previousOwnership,
        pairImportedRemotePaneIds,
      );
      if (options.prunePairClearedPaneTargets === true) {
        this.prunePairClearedPaneTargets(surface, response.payload.state.panes);
      }
    } catch (error) {
      surface.name = previousName;
      surface.viewport = previousViewport;
      surface.protocolFeatures = previousProtocolFeatures;
      surface.targetCapabilities = previousTargetCapabilities;
      throw error;
    }
    this.queuePersistScreenSnapshot("apply pair state");
  }

  private pairStatePaneLabelsDiffer(
    surface: ManagedSurface,
    paneStates: PairResponse["payload"]["state"]["panes"],
  ): boolean {
    for (const paneState of paneStates) {
      const pane = this.findPaneByRemoteId(surface, paneState.paneId);
      if (pane && pane.paneLabel !== paneState.paneLabel) {
        return true;
      }
    }
    return false;
  }

  private applyPairPaneState(
    surface: ManagedSurface,
    paneStates: PairResponse["payload"]["state"]["panes"],
    _sameSession: boolean,
    options: {
      ignoreEmptyPairContentAuthority?: boolean;
      pairStateLayout?: PairResponse["payload"]["state"]["layout"];
      pairStateTopologyRevision?: PairResponse["payload"]["state"]["topologyRevision"];
      pruneStalePanes?: boolean;
    } = {},
  ): void {
    this.assertProviderPaneLabelsUnique(surface, paneStates);
    if (paneStates.length === 0) {
      throw new SurfAceToolError(
        "invalid_operation",
        `Pair response for ${surface.surfaceId} did not include any topology panes.`,
      );
    }
    const nextPanes = new Map<PaneId, ManagedPane>();
    const previousPanes = new Map(surface.panes);
    const previousLayout = surface.layout;
    const previousTopologyRevision = surface.topologyRevision;
    const previousPaneSnapshots = new Map(
      [...surface.panes.entries()].map(([paneId, pane]) => [paneId, structuredClone(pane)]),
    );
    let lineageChanged = false;
    let consumedBootstrapPane = false;
    const reboundProviderPaneIds = new Set<PaneId>();
    const providerPaneLabels: Array<{ pane: ManagedPane; paneLabel: number; remotePaneId: RemotePaneId }> = [];
    try {
      for (const paneState of paneStates) {
        let pane = this.findPaneByRemoteId(surface, paneState.paneId);
        const pairStateMatchedExistingRemotePane = pane !== null;
        pane ??= this.recoverProviderPaneForPairObservation(surface, paneState, reboundProviderPaneIds);
        if (pane) {
          reboundProviderPaneIds.add(pane.paneId);
        }
        if (!pane && !consumedBootstrapPane && nextPanes.size === 0) {
          pane = this.consumeBootstrapPaneForPairState(surface, paneState.paneId);
          consumedBootstrapPane = pane !== null;
        }
        pane ??=
          this.recoverSoleProviderPaneForEmptyPairObservation(surface, paneState, paneStates.length) ??
          this.recoverSolePaneForTopologySync(surface, paneState.paneId, paneStates.length) ??
          this.ensurePane(surface, paneState.paneId);
        const preserveEmptyPairLabelAuthority = pairStateMatchedExistingRemotePane &&
          this.shouldPreserveEmptyPairPaneAuthority(
            surface,
            pane,
            paneState,
            { ignoreEmptyPairContentAuthority: options.ignoreEmptyPairContentAuthority },
            "pair pane label state",
          );
        providerPaneLabels.push({
          pane,
          paneLabel: preserveEmptyPairLabelAuthority ? pane.paneLabel : paneState.paneLabel,
          remotePaneId: paneState.paneId,
        });
        nextPanes.set(pane.paneId, pane);
      }

      if (!(options.pruneStalePanes ?? true)) {
        if (typeof options.pairStateTopologyRevision === "number") {
          surface.topologyRevision = Number(options.pairStateTopologyRevision);
        }
        for (const paneState of paneStates) {
          const pane = this.findPaneByRemoteId(surface, paneState.paneId);
          if (!pane) {
            continue;
          }
          const preserveEmptyPairAuthority = this.shouldPreserveEmptyPairPaneAuthority(
            surface,
            pane,
            paneState,
            { ignoreEmptyPairContentAuthority: options.ignoreEmptyPairContentAuthority },
            "pair pane lineage state",
          );
          if (
            !preserveEmptyPairAuthority &&
            typeof paneState.paneLineageId === "string" &&
            paneState.paneLineageId.length > 0
          ) {
            lineageChanged = this.adoptPaneLineage(surface, pane, paneState.paneLineageId) || lineageChanged;
          }
          this.applyPairPaneContentState(surface, pane, paneState, {
            ignoreEmptyPairContentAuthority: options.ignoreEmptyPairContentAuthority,
            preserveEmptyPairContentAuthority: preserveEmptyPairAuthority,
          });
          pane.viewport = cloneViewport(surface.viewport);
        }
        this.adoptProviderPaneLabels(surface, providerPaneLabels);
        this.queuePersistScreenSnapshot("apply pair state");
        return;
      }

      const pairIsBlankSinglePane =
        paneStates.length === 1 && paneStates[0]?.currentContentId === null;
      const pairRemotePaneIds = new Set(paneStates.map((paneState) => Number(paneState.paneId)));
      const localVisibleCount = this.visiblePanes(surface).length;
      const hasTrustedLocalMultiPane =
        this.hasAcceptedSurfaceTopology(surface) &&
        this.hasProviderAuthorityContinuityOutsideRemotePanes(surface, pairRemotePaneIds) &&
        surface.topologyRevision > 0 &&
        localVisibleCount > 1;
      if (
        (options.pruneStalePanes ?? true) &&
        options.ignoreEmptyPairContentAuthority === true &&
        pairIsBlankSinglePane &&
        hasTrustedLocalMultiPane
      ) {
        this.logger.info?.(
          runtimeDiagnostic("pair_import_guard_preserved_local_topology", {
            local_visible_panes: localVisibleCount,
            pair_panes: paneStates.length,
            surface_id: surface.surfaceId,
            topology_revision: surface.topologyRevision,
          }),
        );
        this.pendingGuardTopologyPublishSurfaceIds.add(surface.surfaceId);
        this.queuePersistScreenSnapshot("pair import guard");
        return;
      }

      const paneIds = [...nextPanes.keys()];
      const pairLayout = options.pairStateLayout
        ? topologyLayoutToManagedLayoutFromPanes([...nextPanes.values()], options.pairStateLayout)
        : null;
      const pairLayoutPaneIds = pairLayout ? flattenManagedLayout(pairLayout) : [];
      const pairLayoutPaneIdSet = new Set(pairLayoutPaneIds);
      const pairLayoutMatchesPanes = pairLayoutPaneIds.length === paneIds.length &&
        pairLayoutPaneIdSet.size === pairLayoutPaneIds.length &&
        paneIds.every((paneId) => pairLayoutPaneIdSet.has(paneId));
      if (!pairLayout || !pairLayoutMatchesPanes) {
        throw new SurfAceToolError(
          "invalid_operation",
          `Pair response topology for ${surface.surfaceId} did not exactly match its pane list.`,
        );
      }

      const paneByRemoteId = new Map(providerPaneLabels.map((entry) => [entry.remotePaneId, entry.pane]));
      for (const paneState of paneStates) {
        const pane = paneByRemoteId.get(paneState.paneId);
        if (!pane) {
          continue;
        }
        const preserveEmptyPairAuthority = this.shouldPreserveEmptyPairPaneAuthority(
          surface,
          pane,
          paneState,
          { ignoreEmptyPairContentAuthority: options.ignoreEmptyPairContentAuthority },
          "pair pane lineage state",
        );
        if (
          !preserveEmptyPairAuthority &&
          typeof paneState.paneLineageId === "string" &&
          paneState.paneLineageId.length > 0
        ) {
          lineageChanged = this.adoptPaneLineage(surface, pane, paneState.paneLineageId) || lineageChanged;
        }
        this.applyPairPaneContentState(surface, pane, paneState, {
          ignoreEmptyPairContentAuthority: options.ignoreEmptyPairContentAuthority,
          preserveEmptyPairContentAuthority: preserveEmptyPairAuthority,
        });
        pane.viewport = cloneViewport(surface.viewport);
      }
      this.adoptProviderPaneLabels(surface, providerPaneLabels);

      surface.panes = nextPanes;
      surface.layout = pairLayout;
      if (typeof options.pairStateTopologyRevision === "number") {
        surface.topologyRevision = Number(options.pairStateTopologyRevision);
      }
    } catch (error) {
      surface.panes = new Map(previousPanes);
      for (const [paneId, pane] of previousPaneSnapshots) {
        surface.panes.set(paneId, pane);
      }
      surface.layout = previousLayout;
      surface.topologyRevision = previousTopologyRevision;
      throw error;
    }

    if (lineageChanged) {
      this.runBackgroundTask("persist pair lineage repair", async () => {
        await this.persistSurfaceTargetState(surface, "pair lineage repair");
      });
    }
    this.queuePersistScreenSnapshot("apply pair state");
  }

  private prunePairClearedPaneTargets(
    surface: ManagedSurface,
    paneStates: PairResponse["payload"]["state"]["panes"],
  ): void {
    for (const paneState of paneStates) {
      if (paneState.currentContentId !== null) {
        continue;
      }
      const pane = this.findPaneByRemoteId(surface, paneState.paneId);
      if (!pane) {
        continue;
      }
      if (!this.hasProviderOwnedPaneAuthority(surface, pane)) {
        continue;
      }
      this.logger.info?.(
        runtimeDiagnostic("pair_empty_observation_preserved_provider_authority", {
          pane_id: pane.paneId,
          pane_lineage_id: pane.paneLineageId,
          remote_pane_id: Number(pane.remotePaneId),
          surface_id: surface.surfaceId,
          window_label: surface.windowLabel || "nil",
        }),
      );
    }
  }

  private preserveProviderAuthorityForEmptyPaneObservation(
    surface: ManagedSurface,
    pane: ManagedPane,
    reason: string,
  ): boolean {
    if (!this.hasProviderOwnedPaneAuthority(surface, pane)) {
      return false;
    }
    this.logger.info?.(
      runtimeDiagnostic("empty_observation_preserved_provider_authority", {
        pane_id: pane.paneId,
        pane_lineage_id: pane.paneLineageId,
        reason,
        remote_pane_id: Number(pane.remotePaneId),
        surface_id: surface.surfaceId,
        window_label: surface.windowLabel || "nil",
      }),
    );
    return true;
  }

  private shouldPreserveEmptyPairPaneAuthority(
    surface: ManagedSurface,
    pane: ManagedPane,
    paneState: PairResponse["payload"]["state"]["panes"][number],
    options: { ignoreEmptyPairContentAuthority?: boolean },
    reason: string,
  ): boolean {
    if (paneState.currentContentId !== null) {
      return false;
    }
    if (options.ignoreEmptyPairContentAuthority === true) {
      return true;
    }
    return this.preserveProviderAuthorityForEmptyPaneObservation(surface, pane, reason);
  }

  private pruneRestartContentForPairImportedPanes(
    surface: ManagedSurface,
    pairImportedRemotePaneIds: Set<number>,
  ): void {
    const restartEntries = this.restartContentBySurface.get(surface.surfaceId);
    if (!restartEntries || restartEntries.length === 0 || pairImportedRemotePaneIds.size === 0) {
      return;
    }
    this.restartContentBySurface.delete(surface.surfaceId);
  }

  private applyPairPaneContentState(
    surface: ManagedSurface,
    pane: ManagedPane,
    paneState: PairResponse["payload"]["state"]["panes"][number],
    options: {
      ignoreEmptyPairContentAuthority?: boolean;
      preserveEmptyPairContentAuthority?: boolean;
    } = {},
  ): boolean {
    if (paneState.currentContentId === null) {
      if (
        options.ignoreEmptyPairContentAuthority === true ||
        options.preserveEmptyPairContentAuthority === true ||
        this.preserveProviderAuthorityForEmptyPaneObservation(surface, pane, "pair pane content state")
      ) {
        return false;
      }
      const changed =
        pane.activeContentId !== null ||
        pane.contentType !== null ||
        pane.contentValue !== null ||
        pane.display !== null ||
        pane.historyOwnerToken !== null ||
        pane.ownerSessionKey !== null ||
        pane.historySummary.visibleContentId !== null ||
        pane.diagnosticContent !== null ||
        pane.nonDurableTargetDiagnostic !== null ||
        pane.buffer.currentUrl !== null ||
        pane.snapshot !== null ||
        pane.buffer.liveFrame !== null ||
        pane.buffer.liveDirtyStrokeIds.length > 0 ||
        pane.currentTargetId !== null ||
        pane.currentRevision !== paneState.currentRevision;
      this.clearVisiblePaneContent(pane, paneState.currentRevision);
      pane.currentTargetId = null;
      pane.pairImportedContentAuthority = true;
      return changed;
    }
    const preservesCurrentTarget =
      pane.activeContentId === paneState.currentContentId &&
      pane.contentType === paneState.contentType;
    const changed =
      pane.activeContentId !== paneState.currentContentId ||
      pane.contentType !== paneState.contentType ||
      pane.contentValue !== null ||
      pane.display !== null ||
      pane.historyOwnerToken !== null ||
      pane.ownerSessionKey !== null ||
      pane.historySummary.visibleContentId !== paneState.currentContentId ||
      pane.diagnosticContent !== null ||
      pane.nonDurableTargetDiagnostic !== null ||
      pane.buffer.currentUrl !== null ||
      (pane.snapshot !== null && pane.snapshot.contentId !== paneState.currentContentId) ||
      pane.buffer.liveFrame !== null ||
      pane.buffer.liveDirtyStrokeIds.length > 0 ||
      (!preservesCurrentTarget && pane.currentTargetId !== null) ||
      pane.currentRevision !== paneState.currentRevision;
    pane.activeContentId = paneState.currentContentId;
    pane.contentType = paneState.contentType;
    pane.contentValue = null;
    pane.currentRevision = paneState.currentRevision;
    pane.display = paneState.display ? structuredClone(paneState.display) : null;
    pane.historyOwnerToken = null;
    pane.ownerSessionKey = pusherSessionKeyFromDisplay(pane.display);
    pane.historySummary.visibleContentId = paneState.currentContentId;
    pane.diagnosticContent = null;
    pane.nonDurableTargetDiagnostic = null;
    pane.buffer.currentUrl = null;
    pane.buffer.liveFrame = null;
    pane.buffer.liveDirtyStrokeIds = [];
    if (!preservesCurrentTarget) {
      pane.currentTargetId = null;
    }
    pane.pairImportedContentAuthority = true;
    if (pane.snapshot?.contentId !== paneState.currentContentId) {
      pane.snapshot = null;
    } else if (pane.snapshot) {
      pane.snapshot.contentType = paneState.contentType;
      pane.snapshot.revision = paneState.currentRevision;
    }
    return changed;
  }

  private targetCapabilitiesForPair(response: PairResponse): Set<string> {
    const capabilities = new Set(response.payload.capabilities.targetCapabilities ?? []);
    for (const contentType of response.payload.capabilities.contentTypes) {
      const targetKind = contentTargetKind(contentType);
      if (targetKind) {
        capabilities.add(requiredCapabilityForTargetKind(targetKind));
      }
      if (contentType === "html") {
        capabilities.add("target.web_snapshot.v1");
      }
    }
    return capabilities;
  }

  private applySnapshot(
    surface: ManagedSurface,
    pane: ManagedPane,
    response: SnapshotResponse,
  ): void {
    const payload = response.payload;
    if (payload.contentId === null && this.preserveProviderAuthorityForEmptyPaneObservation(surface, pane, "snapshot")) {
      if (pane.snapshot) {
        pane.snapshot.cachedAt = this.now();
        pane.snapshot.image = payload.image ?? pane.snapshot.image;
        pane.snapshot.selection = payload.selection;
        pane.snapshot.viewport = structuredClone(payload.viewport);
        pane.snapshot.visibleText = payload.visibleText;
      }
      pane.buffer.selection = convertSelection(payload.selection);
      pane.buffer.scrollPosition = {
        visibleRect: { ...payload.viewport.visibleRect },
        x: payload.viewport.scrollOffset.x,
        y: payload.viewport.scrollOffset.y,
      };
      return;
    }
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

  private async applyMutationResponse(
    surface: ManagedSurface,
    pane: ManagedPane,
    response: Response,
    request: ContentApplyRequest | ContentClearRequest | ContentSetRequest,
    sessionKey?: string,
    options: { diagnostic?: SurfAcePushInput["diagnostic"]; failedBrowserUrlRevisionRecoveryAttempted?: boolean; skipTargetRecord?: boolean } = {},
  ): Promise<SurfAcePushResult | SurfAceClearResult> {
    if (isErrorResponse(response)) {
      const expectedRevision = staleRevisionExpectedRevision(response);
      if (expectedRevision !== null && Number(expectedRevision) > Number(pane.currentRevision)) {
        this.logger.warn?.(
          `[surf-ace:runtime] event=mutation_revision_resync surface_id=${surface.surfaceId} window_label=${surface.windowLabel || "<none>"} pane_id=${pane.paneId} pane_label=${pane.paneLabel} remote_pane_id=${pane.remotePaneId} provider_revision=${pane.currentRevision} client_revision=${expectedRevision} op=${request.op}`,
        );
        pane.currentRevision = expectedRevision;
        const retryRequest = {
          ...request,
          id: makeBrandedRequestId(),
          payload: {
            ...request.payload,
            revision: asRevision(Number(expectedRevision) + 1),
          },
          sentAt: asEpochMs(this.now()),
        } as ContentApplyRequest | ContentClearRequest | ContentSetRequest;
        const retryResponse = await this.sendRequest(surface, retryRequest);
        return await this.applyMutationResponse(surface, pane, retryResponse, retryRequest, sessionKey, options);
      }
      if (
        expectedRevision !== null &&
        options.failedBrowserUrlRevisionRecoveryAttempted !== true &&
        this.failedBrowserUrlMaterializationTarget(surface, pane)
      ) {
        this.logger.warn?.(
          `[surf-ace:runtime] event=failed_browser_url_revision_recovery surface_id=${surface.surfaceId} window_label=${surface.windowLabel || "<none>"} pane_id=${pane.paneId} pane_label=${pane.paneLabel} remote_pane_id=${pane.remotePaneId} provider_revision=${pane.currentRevision} client_revision=${expectedRevision} op=${request.op}`,
        );
        await this.staleFailedBrowserUrlMaterializationTarget(
          surface,
          pane,
          "failed browser_url target replaced by content mutation",
        );
        pane.currentRevision = asRevision(Math.max(0, Number(expectedRevision) - 1));
        const retryRequest = {
          ...request,
          id: makeBrandedRequestId(),
          payload: {
            ...request.payload,
            revision: expectedRevision,
          },
          sentAt: asEpochMs(this.now()),
        } as ContentApplyRequest | ContentClearRequest | ContentSetRequest;
        const retryResponse = await this.sendRequest(surface, retryRequest);
        return await this.applyMutationResponse(surface, pane, retryResponse, retryRequest, sessionKey, {
          ...options,
          failedBrowserUrlRevisionRecoveryAttempted: true,
        });
      }
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
      pane.pairImportedContentAuthority = false;
      await this.tombstonePaneTarget(surface, pane);
    } else {
      if (contentChanged) {
        this.storeHiddenHistoryEntry(pane, previousVisibleEntry);
      }
      this.removeHiddenHistoryEntryForSession(pane, nextOwner);
      pane.activeContentId = payload.currentContentId;
      pane.contentType = setPayload?.contentType ?? pane.contentType;
      pane.contentValue = setPayload ? structuredClone(setPayload.content) : pane.contentValue;
      pane.display = setPayload?.display ? structuredClone(setPayload.display) : null;
      pane.historyOwnerToken = setPayload?.historyOwnerToken ?? pane.historyOwnerToken;
      pane.ownerSessionKey = nextOwner;
      pane.pairImportedContentAuthority = false;
      pane.historySummary.visibleContentId = payload.currentContentId;
      if (pane.snapshot && setPayload) {
        pane.snapshot.contentId = payload.currentContentId;
        pane.snapshot.contentType = setPayload.contentType;
        pane.snapshot.drawings = [];
        pane.snapshot.image = undefined;
        pane.snapshot.revision = payload.currentRevision;
        pane.snapshot.selection = null;
        pane.snapshot.visibleText = undefined;
      }
      pane.buffer.currentUrl = null;
      if (options.diagnostic) {
        await this.recordDiagnosticPaneContent(surface, pane, options.diagnostic);
      } else if (!options.skipTargetRecord && setPayload) {
        const targetKind = contentTargetKind(setPayload.contentType);
        const targetHeader = passiveContentTargetHeader(setPayload.contentType, setPayload.content);
        if (targetKind && targetHeader) {
          await this.createPaneTargetRecord(surface, pane, {
            contentIdAtApply: payload.currentContentId,
            display: setPayload.display ? structuredClone(setPayload.display) : null,
            targetHeader,
            targetKind,
            targetPayload: setPayload.content,
          });
          pane.diagnosticContent = null;
          await this.persistSurfaceTargetState(surface, "diagnostic cleared by target record");
        } else {
          pane.diagnosticContent = null;
          await this.tombstonePaneTarget(surface, pane);
        }
      }
    }

    pane.pendingOwnerSessionKey = null;
    pane.currentRevision = payload.currentRevision;
    this.repairLivePaneLabelInvariant(`mutation ${request.op}`, surface);
    this.queuePersistScreenSnapshot(`mutation ${request.op}`);

    if (isClearRequest) {
      const displayId = visiblePaneAddress(surface.windowLabel, pane.paneLabel);
      return {
        displayId,
        fingerprint: surface.surfaceId,
        paneAddress: displayId,
        paneId: pane.paneId,
        paneLabel: pane.paneLabel,
        revision: payload.currentRevision,
      };
    }

    const displayId = visiblePaneAddress(surface.windowLabel, pane.paneLabel);
    return {
      contentId: payload.currentContentId as string,
      displayId,
      fingerprint: surface.surfaceId,
      paneAddress: displayId,
      paneId: pane.paneId,
      paneLabel: pane.paneLabel,
      revision: payload.currentRevision,
    };
  }
}

export function createSurfAceRuntime(options: SurfAceRuntimeOptions = {}): SurfAceRuntime {
  return new DefaultSurfAceRuntime(options);
}
