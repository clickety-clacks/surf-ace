export type {
  AnnotationsRemoveRequest,
  AnnotationsRemoveResponse,
  DrawingFlushEvent,
  ErrorResponse,
  Event,
  NavigationEvent,
  PairRequest,
  PairResponse,
  Request,
  Response,
  SnapshotGetRequest,
  SnapshotResponse,
  SurfaceViewport as Viewport,
  SurfacesListRequest,
  SurfacesListResponse,
} from "./index.js";
export type JsonObject = Record<string, unknown>;
export type SurfAceRequest = import("./index.js").Request;
export type SurfAceResponse = import("./index.js").Response;
export type SurfAceEvent = import("./index.js").Event;
export type SurfaceSummary = import("./index.js").SurfacesListResponse["payload"]["surfaces"][number];
