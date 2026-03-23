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
  scrollable?: boolean;
  interactive?: boolean;
};

export type PairResume = {
  sessionId: SessionId;
};

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
    providerName?: string;
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
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "image";
      content: ImageContent;
      display?: ContentDisplay;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "pdf";
      content: PdfContent;
      display?: ContentDisplay;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "terminal";
      content: TerminalContent;
      display?: ContentDisplay;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "markdown";
      content: MarkdownContent;
      display?: ContentDisplay;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "video";
      content: VideoContent;
      display?: ContentDisplay;
    }
  | {
      paneId: PaneId;
      contentId: ContentId;
      historyOwnerToken: string;
      revision: Revision;
      contentType: "canvas";
      content: CanvasContent;
      display?: ContentDisplay;
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

export type PaneSplitRequest = RequestBase<"pane.split"> & {
  payload: {
    paneId: PaneId;
    count: number;
    direction: "horizontal" | "vertical";
    newPaneIds: PaneId[];
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
    resumed: boolean;
    surfaceId: SurfaceId;
    surfaceName: string;
    viewport: SurfaceViewport;
    capabilities: {
      contentTypes: ContentType[];
      eventTypes: Event["op"][];
    };
    eventConfig: {
      profile: EventProfile;
      activeEvents: Array<
        | "event.drawing_flush"
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
        currentContentId: ContentId | null;
        currentRevision: Revision;
        contentType: ContentType | null;
      }>;
    };
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
      name: string | null;
      activeContentId: ContentId | null;
      contentType: ContentType | null;
      viewport: SurfaceViewport;
    }>;
  };
};

export type PaneSplitResponse = ResponseBase<"pane.split"> & {
  payload: {
    panes: Array<{
      paneId: PaneId;
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
    | "content.set"
    | "content.append"
    | "content.patch"
    | "content.clear"
    | "annotations.remove"
    | "snapshot.get"
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

export type SnapshotHintEvent = EventBase<"event.snapshot_hint"> & {
  payload: {
    reason: "after_render" | "after_reconnect" | "backpressure_drop";
  };
};

export type PaneCreatedEvent = EventBase<"event.pane_created"> & {
  payload: {
    surfaceId: SurfaceId;
    paneId: PaneId;
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
  | RelinquishRequest
  | ContentSetRequest
  | ContentAppendRequest
  | ContentPatchRequest
  | ContentClearRequest
  | AnnotationsRemoveRequest
  | SnapshotGetRequest
  | HeartbeatPingRequest
  | PanesListRequest
  | PaneSplitRequest
  | PaneRenameRequest
  | PaneCloseRequest;

export type Response =
  | SurfacesListResponse
  | PairResponse
  | RelinquishResponse
  | MutationAckResponse
  | AnnotationsRemoveResponse
  | SnapshotResponse
  | HeartbeatPongResponse
  | PanesListResponse
  | PaneSplitResponse
  | PaneRenameResponse
  | PaneCloseResponse
  | ErrorResponse;

export type Event =
  | DrawingFlushEvent
  | TapEvent
  | ScrollEvent
  | SelectionEvent
  | PageEvent
  | NavigationEvent
  | SurfaceAppearedEvent
  | SurfaceRemovedEvent
  | SurfaceResumedEvent
  | SnapshotHintEvent
  | PaneCreatedEvent
  | PaneRemovedEvent
  | PaneRenamedEvent;

export * from "./message-names.js";
export * from "./messages.js";
export * from "./schemas.js";
export * from "./schemas-manifest.js";
export * from "./pair-example.js";
