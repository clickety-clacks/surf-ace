export type {
  AnnotationsRemoveRequest,
  AnnotationsRemoveResponse,
  DrawingFlushEvent,
  ErrorResponse,
  Event,
  NavigationEvent,
  PairRequest,
  PairResponse,
  RelinquishRequest,
  RelinquishResponse,
  Request,
  Response,
  SnapshotGetRequest,
  SnapshotResponse,
  SurfaceWindowOpenRequest,
  SurfaceWindowOpenResponse,
  SurfaceViewport as Viewport,
  TargetApplyRequest,
  TargetApplyResponse,
  TargetErrorCode,
  TargetHeader,
  TargetKind,
  SurfacesListRequest,
  SurfacesListResponse,
} from "./index.js";
export type JsonObject = Record<string, unknown>;
export type SurfAceRequest = import("./index.js").Request;
export type SurfAceResponse = import("./index.js").Response;
export type SurfAceEvent = import("./index.js").Event;
export type SurfaceSummary = import("./index.js").SurfacesListResponse["payload"]["surfaces"][number];
