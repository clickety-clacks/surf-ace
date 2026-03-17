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
} from "./index";

export type JsonObject = Record<string, unknown>;
export type SurfAceRequest = import("./index").Request;
export type SurfAceResponse = import("./index").Response;
export type SurfAceEvent = import("./index").Event;
export type SurfaceSummary = import("./index").SurfacesListResponse["payload"]["surfaces"][number];
