import type { EventMessageName, RequestMessageName, ResponseMessageName } from "./message-names";

export type JsonObject = Record<string, unknown>;

export type WireEnvelope<TType extends string = string, TPayload extends JsonObject = JsonObject> = {
  type: TType;
  payload: TPayload;
};

export type Viewport = {
  width: number;
  height: number;
};

export type SurfaceSummary = {
  surfaceId: string;
  name: string;
  autoLabel: string;
  viewport: Viewport;
  paired: boolean;
};

// Request payloads
export type SurfacesListRequest = WireEnvelope<"surfaces.list", {}>;
export type PairRequest = WireEnvelope<
  "pair.request",
  {
    providerId: string;
    connectionId: string;
    surfaceId: string;
    protocolVersion: 1;
    resume?: string;
    takeover?: boolean;
    providerName?: string;
    eventProfile?: string;
    drawingFlushConfig?: {
      idleWindowMs?: number;
      maxIntervalMs?: number;
    };
  }
>;

export type ContentSetRequest = WireEnvelope<
  "content.set",
  {
    paneId?: string;
    contentId: string;
    revision: number;
    contentType: "html" | "image" | "pdf" | "terminal" | "markdown" | "video" | "canvas";
    content: unknown;
  }
>;

export type SnapshotGetRequest = WireEnvelope<
  "snapshot.get",
  {
    includeVisibleText?: boolean;
    includeDrawings?: boolean;
    includeImage?: boolean;
  }
>;

// Response payloads
export type SurfacesListResponse = WireEnvelope<
  "surfaces.list.response",
  {
    surfaces: SurfaceSummary[];
  }
>;

export type PairResponse = WireEnvelope<
  "pair.response",
  {
    sessionId: string;
    resumed: boolean;
    surface: {
      id: string;
      name: string;
      viewport: Viewport;
      capabilities?: JsonObject;
    };
    limits?: JsonObject;
    eventConfig?: {
      profile: string;
      activeEvents: string[];
      drawingFlushConfig?: {
        idleWindowMs: number;
        maxIntervalMs: number;
      };
    };
    currentContentId: string | null;
    currentRevision: number;
    contentType: string | null;
  }
>;

export type ErrorResponse = WireEnvelope<
  "error",
  {
    code: string;
    message: string;
    details?: JsonObject;
  }
>;

// Event payloads (minimum set scaffold)
export type DrawingStroke = {
  strokeId: string;
  points: Array<{ x: number; y: number; pressure?: number }>;
  startedAt?: string;
  endedAt?: string;
  videoTimestamp?: number;
};

export type DrawingFlushEvent = WireEnvelope<
  "event.drawing_flush",
  {
    contentId?: string;
    strokes: DrawingStroke[];
  }
>;

export type NavigationEvent = WireEnvelope<
  "event.navigation",
  {
    url: string;
  }
>;

export type SurfAceRequest = WireEnvelope<RequestMessageName>;
export type SurfAceResponse = WireEnvelope<ResponseMessageName>;
export type SurfAceEvent = WireEnvelope<EventMessageName>;
