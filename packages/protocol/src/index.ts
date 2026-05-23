type Brand<T, TName extends string> = T & {
  readonly __brand: TName;
};

export type RequestId = Brand<string, "RequestId">;
export type ProviderId = Brand<string, "ProviderId">;
export type ConnectionId = Brand<string, "ConnectionId">;
export type SessionId = Brand<string, "SessionId">;
export type SurfaceId = Brand<string, "SurfaceId">;
export type ContentId = Brand<string, "ContentId">;
export type StrokeId = Brand<string, "StrokeId">;
export type EventId = Brand<string, "EventId">;
export type FlushId = Brand<string, "FlushId">;
export type PaneId = Brand<number, "PaneId">;
export type Revision = Brand<number, "Revision">;
export type EpochMs = Brand<number, "EpochMs">;

export type ContentType =
  | "html"
  | "image"
  | "pdf"
  | "terminal"
  | "markdown"
  | "video"
  | "canvas";

export type TargetKind =
  | "html"
  | "markdown"
  | "image"
  | "browser_url"
  | "web_snapshot"
  | "terminal_app"
  | "native_app"
  | "compositor_app"
  | "video";

export type TargetHeader = {
  summary: string;
  requiredCapabilities: string[];
  safetyClass: "passive" | "network" | "process" | "privileged";
  replaySemantics: "bytes" | "navigate" | "launch_equivalent" | "attach";
  payloadSchemaVersion: number;
  safeToLogFields: string[];
};

export type BrowserUrlTargetPayloadV1 = {
  url: string;
};

export type BrowserUrlMaterializedState = {
  navigationStatus: "started_unverified" | "loaded" | "failed";
  replaySemantics: "navigate";
  url: string;
};

export type NativeHostMaterializedState = {
  authority?: {
    ownershipEpoch: number;
    ownershipSessionId: string;
    paneLineageId: string;
    surfaceId: SurfaceId;
    targetEpoch: number;
  };
  diagnostics?: string[];
  inputFocus?: "ready" | "not_ready" | "unknown";
  lifecycle?: "launch_requested" | "running" | "exited" | "unknown";
  nativeTarget?: {
    appId?: string;
    args?: string[];
    command?: string;
    cwd?: string;
    envDigest?: string;
    envKeys?: string[];
    launchMode?: string;
    targetKind: TargetKind;
  };
  nativeHost: "applied" | "not_applied" | "released_after_failure";
  overlayRegions: "applied" | "not_applied" | "not_requested";
  paneGeometry?: {
    coordinateSpace: "compositor_logical";
    geometryRevision: Revision;
    height: number;
    paneInstanceId: string;
    surfaceEpoch: string;
    topologyEpoch: TopologyRevision;
    width: number;
    x: number;
    y: number;
  };
  proof?: {
    appId?: string;
    args?: string[];
    bindingId?: string;
    contentId?: string;
    cwd?: string;
    envDigest?: string;
    launchMode?: string;
    paneId: string;
  };
};

export type RuntimeAppBindingDiagnostics = {
  acknowledgement: "accepted" | "failed" | "not_configured" | "pending";
  bindingAuthority: "trusted" | "degraded" | "blocked";
  bindingBlockReason?: string;
  bindingDegradedReasons: string[];
  checkedAt?: EpochMs;
  diagnosticDrift: string[];
  expectedBundleId: string | null;
  expectedPackageName: string | null;
  expectedRuntimeId: string;
  failureMessage?: string;
  launchTokenStatus: "matched" | "missing" | "mismatched";
  observedUiLabel: string | null;
  observedWaylandAppId: string | null;
  observedWindowTitle: string | null;
  processLineageStatus: "matched" | "missing" | "mismatched";
  ready: boolean;
  reportedBundleId: string | null;
  reportedPackageName: string | null;
  reportedRuntimeId: string;
};

export type ContentMaterializedState = {
  contentType: ContentType;
  paneId: PaneId;
};

export type TargetMaterializedState =
  | BrowserUrlMaterializedState
  | NativeHostMaterializedState
  | ContentMaterializedState;

export type RestorePolicy = "auto" | "confirm" | "manual" | "never";

export type ApplyEvidence = {
  requestId: string;
  targetId: string;
  paneLineageId: string;
  targetEpoch: number;
  status: "applied" | "rejected" | "failed";
  errorCode?: TargetErrorCode;
  message?: string;
  materializedState?: TargetMaterializedState;
  appliedAt: string;
};

export type TargetErrorCode =
  | "capability_missing"
  | "policy_denied"
  | "approval_required"
  | "unsafe_payload"
  | "ownership_epoch_mismatch"
  | "ownership_session_mismatch"
  | "pane_lineage_missing"
  | "pane_lineage_ambiguous"
  | "target_epoch_stale"
  | "target_superseded"
  | "registration_late_old_epoch"
  | "registration_duplicate"
  | "registration_failed"
  | "materialization_failed"
  | "unsupported_target_kind"
  | "restore_blocked_stale_target"
  | "restore_unregistered_local_target"
  | "restore_requires_confirmation";

export type TargetApplyReason =
  | "initial_apply"
  | "resume_restore"
  | "manual_restore"
  | "confirmed_restore";

// `surf_ace_list` exposes provider-side connectivity with this enum in DESIGN.md.
//
// KNOWN BUG (iOS client): The connection status indicator (green bar) on
// device surfaces should only show "connected" (green) AFTER a successful
// pair handshake (pair.request → PairResponse with ok:true). It must show
// "disconnected" (red/grey) any time the socket is closed OR a pair is
// pending/in-flight. The current iOS client turns green on raw socket open,
// which is incorrect — it stays green during crash loops because the
// provider retries faster than the UI updates.
export type ConnectionState = "connected" | "connecting" | "unreachable";

export type EventProfile = "minimum_deep" | "deep_plus_scroll";

export type Position = {
  x: number;
  y: number;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Viewport = {
  scrollOffset: Position;
  visibleRect: Rect;
  contentSize: {
    width: number;
    height: number;
  };
  zoomLevel: number;
};

export type SurfaceViewport = {
  width: number;
  height: number;
  scale: number;
};

export type PaneGeometryProjection = {
  paneId: PaneId;
  paneInstanceId: string;
  topologyEpoch: TopologyRevision;
  surfaceEpoch: string;
  geometryRevision: Revision;
  coordinateSpace: "surface_logical";
  surfaceBounds: Rect;
  paneFrame: Rect;
  contentViewport: Rect;
  protocolViewport: {
    coordinateSpace: "protocol_viewport";
    rect: Rect;
    viewport: SurfaceViewport;
  };
  splitSpacingInsets: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  safeAreaInsets: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  scale: number;
};

export type Selection =
  | null
  | {
      kind: "text";
      text: string;
      boundingRect?: Rect;
    }
  | {
      kind: "point";
      position: Position;
    }
  | {
      kind: "region";
      rect: Rect;
      text?: string;
    };

export type HtmlContent = {
  html: string;
  baseUrl?: string;
};

export type ImageContent = {
  data: string;
  mediaType: string;
  alt?: string;
};

export type PdfContent = {
  data: string;
};

export type TerminalContent = {
  lines: string[];
  scrollback: number;
};

export type MarkdownContent = {
  markdown: string;
};

export type VideoContent = string;

export type CanvasContent =
  | ""
  | {
      color?: string;
      grid?: boolean;
    };

export type ContentValue =
  | HtmlContent
  | ImageContent
  | PdfContent
  | TerminalContent
  | MarkdownContent
  | VideoContent
  | CanvasContent;

export type ContentDisplay = {
  title?: string;
  senderDisplayName?: string;
  scrollable?: boolean;
  interactive?: boolean;
  provenance?: PusherProvenance;
};

export type PusherProvenance = {
  agentId?: string;
  displayName?: string;
  pushedAt?: string;
  sessionKey?: string;
  source?: string;
  streamLabel?: string;
};

export type ContentReloadSource = {
  kind: "file";
  path: string;
};

export type PairResume = {
  sessionId: SessionId;
};

export type TopologyRevision = Brand<number, "TopologyRevision">;

export type DrawingFlushConfig = {
  idleWindowMs: number;
  maxIntervalMs: number;
};

export type RequestBase<TOp extends string> = {
  v: 1;
  type: "request";
  op: TOp;
  id: RequestId;
  sentAt: EpochMs;
};

export type ResponseBase<TOp extends string> = {
  v: 1;
  type: "response";
  op: TOp;
  id: RequestId;
  ok: true;
  sentAt: EpochMs;
};

export type EventBase<TOp extends string> = {
  v: 1;
  type: "event";
  op: TOp;
  eventId: EventId;
  sentAt: EpochMs;
};

export type SurfacesListRequest = RequestBase<"surfaces.list">;

export type PairRequest = RequestBase<"pair.request"> & {
  payload: {
    providerId: ProviderId;
    connectionId: ConnectionId;
    surfaceId: SurfaceId;
    windowLabel: string;
    initialPaneId: PaneId;
    initialPaneLabel: number;
    providerName: string;
    protocolVersion: 1;
    takeover?: boolean;
    eventProfile?: EventProfile;
    drawingFlushConfig?: DrawingFlushConfig;
    resume?: PairResume;
  };
};

export type RelinquishRequest = RequestBase<"ownership.relinquish">;

export type ContentSetPayload =
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "html";
      content: HtmlContent;
      display?: ContentDisplay;
      reloadSource?: ContentReloadSource;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "image";
      content: ImageContent;
      display?: ContentDisplay;
      reloadSource?: ContentReloadSource;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "pdf";
      content: PdfContent;
      display?: ContentDisplay;
      reloadSource?: ContentReloadSource;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "terminal";
      content: TerminalContent;
      display?: ContentDisplay;
      reloadSource?: ContentReloadSource;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "markdown";
      content: MarkdownContent;
      display?: ContentDisplay;
      reloadSource?: ContentReloadSource;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "video";
      content: VideoContent;
      display?: ContentDisplay;
      reloadSource?: ContentReloadSource;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "canvas";
      content: CanvasContent;
      display?: ContentDisplay;
      reloadSource?: ContentReloadSource;
    };

export type ContentSetRequest = RequestBase<"content.set"> & {
  payload: ContentSetPayload;
};

export type ContentAppendRequest = RequestBase<"content.append"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    revision: Revision;
    lines: string[];
  };
};

export type ContentPatchRequest = RequestBase<"content.patch"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    revision: Revision;
    patch: {
      selector: string;
      action: "replace_inner" | "replace_outer" | "insert_before" | "insert_after" | "remove";
      html?: string;
    };
  };
};

export type ContentClearRequest = RequestBase<"content.clear"> & {
  payload: {
    paneId: PaneId;
    revision: Revision;
  };
};

export type AnnotationsRemoveRequest = RequestBase<"annotations.remove"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    strokeIds: StrokeId[];
  };
};

export type SnapshotGetRequest = RequestBase<"snapshot.get"> & {
  payload: {
    paneId: PaneId;
    includeImage?: boolean;
    includeVisibleText?: boolean;
    includeDrawings?: boolean;
  };
};

export type HeartbeatPingRequest = RequestBase<"heartbeat.ping"> & {
  payload: {
    nonce: string;
  };
};

export type PanesListRequest = RequestBase<"panes.list">;

export type AuthorityPaneIdentity = {
  paneId: PaneId;
  paneLabel: number;
  paneLineageId: string;
};

export type AuthorityStatePayload = {
  actionable: boolean;
  reason: string | null;
  ownershipEpoch: number;
  providerId: ProviderId;
  sessionId: SessionId;
  surfaceId: SurfaceId;
  windowLabel: string;
  panes: AuthorityPaneIdentity[];
};

export type AuthorityStateRequest = RequestBase<"authority.state"> & {
  payload: AuthorityStatePayload;
};

export type TopologyLayoutNode =
  | {
      type: "pane";
      paneId: PaneId;
      weight?: number;
    }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      weight?: number;
      children: TopologyLayoutNode[];
    };

export type TopologyPaneState = {
  paneId: PaneId;
  paneLabel: number;
  name: string | null;
};

export type TopologyApplyRequest = RequestBase<"topology.apply"> & {
  payload: {
    topologyRevision: TopologyRevision;
    windowLabel: string;
    layout: TopologyLayoutNode;
    panes: TopologyPaneState[];
  };
};

export type ContentApplyRequest = RequestBase<"content.apply"> & {
  payload:
    | (ContentSetPayload & {
        topologyRevision?: TopologyRevision;
      })
    | {
        clear: true;
        paneId: PaneId;
        revision: Revision;
        topologyRevision?: TopologyRevision;
      };
};

export type TargetApplyRequest = RequestBase<"target.apply"> & {
  payload: {
    requestId: string;
    targetId: string;
    surfaceId: SurfaceId;
    ownershipSessionId: string;
    ownershipEpoch: number;
    paneLineageId: string;
    targetEpoch: number;
    targetKind: TargetKind;
    targetHeader: TargetHeader;
    targetPayload: unknown;
    display?: ContentDisplay;
    restoreReason: TargetApplyReason;
  };
};

export type TargetRegisterRequest = RequestBase<"target.register"> & {
  payload: {
    idempotencyKey: string;
    surfaceId: SurfaceId;
    surfaceInstanceId: string | null;
    ownershipSessionId: string;
    ownershipEpoch: number;
    paneLineageId: string;
    expectedPreviousTargetEpoch: number | null;
    targetKind: TargetKind;
    targetHeader: TargetHeader;
    targetPayload: unknown;
    launchedAt: string;
    registrationState: "before_attach" | "attached";
  };
};

export type PaneSplitRequest = RequestBase<"pane.split"> & {
  payload: {
    paneId: PaneId;
    count: number;
    direction: "horizontal" | "vertical";
    newPaneIds: PaneId[];
    newPaneLabels: number[];
  };
};

export type PaneRenameRequest = RequestBase<"pane.rename"> & {
  payload: {
    paneId: PaneId;
    name: string | null;
  };
};

export type PaneCloseRequest = RequestBase<"pane.close"> & {
  payload: {
    paneId: PaneId;
  };
};

export type SurfaceSummary = {
  surfaceId: SurfaceId;
  name: string;
  viewport: SurfaceViewport;
  paired: boolean;
};

export type SurfacesListResponse = ResponseBase<"surfaces.list"> & {
  payload: {
    surfaces: SurfaceSummary[];
  };
};

export type PairResponse = ResponseBase<"pair.request"> & {
  payload: {
    sessionId: SessionId;
    ownershipEpoch: number;
    resumed: boolean;
    surfaceId: SurfaceId;
    surfaceName: string;
    viewport: SurfaceViewport;
    capabilities: {
      contentTypes: ContentType[];
      eventTypes: Event["op"][];
      protocolFeatures?: string[];
      runtimeAppBinding?: RuntimeAppBindingDiagnostics;
      targetCapabilities?: string[];
    };
    eventConfig: {
      profile: EventProfile;
      activeEvents: Array<
        | "event.drawing_flush"
        | "event.history_navigated"
        | "event.tap"
        | "event.scroll"
        | "event.selection"
        | "event.page"
        | "event.navigation"
        | "event.snapshot_hint"
      >;
      drawingFlushConfig: DrawingFlushConfig;
    };
    limits: {
      maxMessageBytes: number;
      maxFrameBytes: number;
      maxVisibleTextBytes: number;
      maxStrokePointsPerFlush: number;
      maxDrawingFlushBytes: number;
      resumeGraceMs: number;
    };
    state: {
      panes: Array<{
        paneId: PaneId;
        paneLabel: number;
        paneLineageId?: string;
        currentContentId: ContentId | null;
        currentRevision: Revision;
        contentType: ContentType | null;
        display?: ContentDisplay;
      }>;
      layout: TopologyLayoutNode;
      topologyRevision: TopologyRevision;
    };
  };
};

export type RuntimeAppBindingRequest = RequestBase<"runtime.app_binding">;

export type RuntimeAppBindingResponse = ResponseBase<"runtime.app_binding"> & {
  payload: {
    runtimeAppBinding: RuntimeAppBindingDiagnostics | null;
  };
};

export type RelinquishResponse = ResponseBase<"ownership.relinquish"> & {
  payload: {
    relinquished: true;
  };
};

export type MutationAckResponse = ResponseBase<
  "content.set" | "content.append" | "content.patch" | "content.clear"
> & {
  payload: {
    paneId: PaneId;
    currentContentId: ContentId | null;
    currentRevision: Revision;
    contentType?: ContentType | null;
    contentId: ContentId | null;
  };
};

export type AuthorityStateResponse = ResponseBase<"authority.state"> & {
  payload: {
    accepted: boolean;
    reason: string | null;
  };
};

export type RenderDiagnostics = {
  bridgeAttached: boolean;
  revision: Revision;
  status: "standby_rendered" | "render_requested" | "pending_renderer" | "failed";
  contentId?: ContentId;
  contentType?: ContentType;
  message?: string;
};

export type AnnotationsRemoveResponse = ResponseBase<"annotations.remove"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    removedStrokeIds: StrokeId[];
    notFoundStrokeIds: StrokeId[];
    remainingStrokeCount: number;
  };
};

export type StrokePoint = Position & {
  timestamp: EpochMs;
  pressure?: number;
};

export type StrokeTool = "pencil" | "finger" | "mouse";

export type Stroke = {
  strokeId: StrokeId;
  tool: StrokeTool;
  videoTimestamp?: number;
  points: StrokePoint[];
};

export type SnapshotResponse = ResponseBase<"snapshot.get"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId | null;
    revision: Revision;
    contentType: ContentType | null;
    viewport: Viewport;
    visibleText?: string;
    selection: Selection;
    drawings?: Stroke[];
    image?: string;
  };
};

export type HeartbeatPongResponse = ResponseBase<"heartbeat.ping"> & {
  payload: {
    nonce: string;
  };
};

export type PanesListResponse = ResponseBase<"panes.list"> & {
  payload: {
    panes: Array<{
      paneId: PaneId;
      paneLabel: number;
      paneLineageId?: string;
      name: string | null;
      activeContentId: ContentId | null;
      contentType: ContentType | null;
      display?: ContentDisplay;
      externalNative?: boolean;
      viewport: SurfaceViewport;
      geometry: PaneGeometryProjection;
    }>;
  };
};

export type TopologyApplyResponse = ResponseBase<"topology.apply"> & {
  payload: {
    topologyRevision: TopologyRevision;
    panes: Array<{
      paneId: PaneId;
      paneLabel: number;
      name: string | null;
      paneLineageId?: string;
    }>;
  };
};

export type ContentApplyResponse = ResponseBase<"content.apply"> & {
  payload: MutationAckResponse["payload"] & {
    render?: RenderDiagnostics;
    topologyRevision?: TopologyRevision;
  };
};

export type TargetApplyResponse = ResponseBase<"target.apply.result"> & {
  payload: ApplyEvidence;
};

export type TargetRegisteredResponse = ResponseBase<"target.registered"> & {
  payload: {
    idempotencyKey: string;
    targetId: string;
    targetEpoch: number;
    status: "registered";
  };
};

export type TargetRegisterRejectedResponse = ResponseBase<"target.register.rejected"> & {
  payload: {
    idempotencyKey: string;
    status: "rejected";
    errorCode: TargetErrorCode;
    message: string;
  };
};

export type PaneSplitResponse = ResponseBase<"pane.split"> & {
  payload: {
    panes: Array<{
      paneId: PaneId;
      paneLabel: number;
    }>;
  };
};

export type PaneRenameResponse = ResponseBase<"pane.rename"> & {
  payload: {
    paneId: PaneId;
    name: string | null;
  };
};

export type PaneCloseResponse = ResponseBase<"pane.close"> & {
  payload: {
    paneId: PaneId;
    closedFramesDiscarded: number;
  };
};

export type ErrorResponse = {
  v: 1;
  type: "response";
  op:
    | "surfaces.list"
    | "pair.request"
    | "ownership.relinquish"
    | "topology.apply"
    | "content.apply"
    | "target.apply"
    | "content.set"
    | "content.append"
    | "content.patch"
    | "content.clear"
    | "annotations.remove"
    | "snapshot.get"
    | "authority.state"
    | "heartbeat.ping"
    | "panes.list"
    | "pane.split"
    | "pane.rename"
    | "pane.close";
  id: RequestId;
  ok: false;
  sentAt: EpochMs;
  error: {
    code:
      | "busy"
      | "invalid_resume"
      | "not_lock_owner"
      | "not_paired"
      | "invalid_payload"
      | "invalid_request_id_reuse"
      | "invalid_operation"
      | "unsupported_protocol_version"
      | "unsupported_content_type"
      | "unsupported_operation_for_content_type"
      | TargetErrorCode
      | "stale_revision"
      | "stale_content"
      | "content_too_large"
      | "render_failed"
      | "rate_limited"
      | "internal_error";
    message: string;
    details?: Record<string, unknown>;
  };
};

export type DrawingFlushEvent = EventBase<"event.drawing_flush"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    revision: Revision;
    flushId: FlushId;
    flushReason: "idle_window" | "max_interval";
    idleWindowMs: number;
    maxIntervalMs: number;
    strokes: Stroke[];
    strokeCount: number;
    pointsCount: number;
    firstStrokeAt: EpochMs;
    lastStrokeAt: EpochMs;
  };
};

export type AnnotationCommittedEvent = EventBase<"event.annotation_committed"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    revision: Revision;
    committedAt: EpochMs;
  };
};

export type TapEvent = EventBase<"event.tap"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    revision: Revision;
    kind: "tap" | "long_press";
    position: Position;
    nearestContent?: string;
  };
};

export type ScrollEvent = EventBase<"event.scroll"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    revision: Revision;
    phase: "settled";
    viewport: Viewport;
    visibleText: string;
  };
};

export type SelectionEvent = EventBase<"event.selection"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    revision: Revision;
    selection: Selection;
  };
};

export type PageEvent = EventBase<"event.page"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    revision: Revision;
    page: number;
    totalPages: number;
    pageText?: string;
  };
};

export type NavigationEvent = EventBase<"event.navigation"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId;
    revision: Revision;
    url: string;
  };
};

export type HistoryNavigatedEvent = EventBase<"event.history_navigated"> & {
  payload: {
    paneId: PaneId;
    contentId: ContentId | null;
    revision: Revision;
    direction: "back" | "forward";
  };
};

export type SurfaceAppearedEvent = EventBase<"event.surface_appeared"> & {
  payload: {
    surfaceId: SurfaceId;
    name: string;
    viewport: SurfaceViewport;
  };
};

export type SurfaceRemovedEvent = EventBase<"event.surface_removed"> & {
  payload: {
    surfaceId: SurfaceId;
  };
};

export type SurfaceResumedEvent = EventBase<"event.surface_resumed"> & {
  payload: {
    surfaceId: SurfaceId;
  };
};

export type TopologyChangedEvent = EventBase<"event.topology_changed"> & {
  payload: {
    surfaceId: SurfaceId;
    topologyRevision: TopologyRevision;
    layout: TopologyLayoutNode;
    panes: TopologyPaneState[];
  };
};

export type SnapshotHintEvent = EventBase<"event.snapshot_hint"> & {
  payload: {
    reason: "after_render" | "after_reconnect" | "backpressure_drop";
  };
};

export type PaneCreatedEvent = EventBase<"event.pane_created"> & {
  payload: {
    surfaceId: SurfaceId;
    paneId: PaneId;
    paneLabel: number;
    parentPaneId?: PaneId | null;
    fromSplit: boolean;
  };
};

export type PaneRemovedEvent = EventBase<"event.pane_removed"> & {
  payload: {
    surfaceId: SurfaceId;
    paneId: PaneId;
  };
};

export type PaneRenamedEvent = EventBase<"event.pane_renamed"> & {
  payload: {
    surfaceId: SurfaceId;
    paneId: PaneId;
    name: string | null;
  };
};

export type Request =
  | SurfacesListRequest
  | PairRequest
  | RuntimeAppBindingRequest
  | RelinquishRequest
  | TopologyApplyRequest
  | ContentApplyRequest
  | TargetApplyRequest
  | TargetRegisterRequest
  | ContentSetRequest
  | ContentAppendRequest
  | ContentPatchRequest
  | ContentClearRequest
  | AnnotationsRemoveRequest
  | SnapshotGetRequest
  | AuthorityStateRequest
  | HeartbeatPingRequest
  | PanesListRequest
  | PaneSplitRequest
  | PaneRenameRequest
  | PaneCloseRequest;

export type Response =
  | SurfacesListResponse
  | PairResponse
  | RuntimeAppBindingResponse
  | RelinquishResponse
  | TopologyApplyResponse
  | ContentApplyResponse
  | TargetApplyResponse
  | TargetRegisteredResponse
  | TargetRegisterRejectedResponse
  | MutationAckResponse
  | AnnotationsRemoveResponse
  | SnapshotResponse
  | AuthorityStateResponse
  | HeartbeatPongResponse
  | PanesListResponse
  | PaneSplitResponse
  | PaneRenameResponse
  | PaneCloseResponse
  | ErrorResponse;

export type Event =
  | DrawingFlushEvent
  | AnnotationCommittedEvent
  | TapEvent
  | ScrollEvent
  | SelectionEvent
  | PageEvent
  | NavigationEvent
  | HistoryNavigatedEvent
  | SurfaceAppearedEvent
  | SurfaceRemovedEvent
  | SurfaceResumedEvent
  | TopologyChangedEvent
  | SnapshotHintEvent
  | PaneCreatedEvent
  | PaneRemovedEvent
  | PaneRenamedEvent;

export * from "./message-names.js";
export * from "./messages.js";
export * from "./schemas.js";
export * from "./schemas-manifest.js";
export * from "./pair-example.js";
