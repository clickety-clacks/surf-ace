import { readFileSync } from "node:fs";

type JsonSchema = Readonly<Record<string, unknown>>;

type ProtocolSchemaDefName =
  | "SurfacesListRequest"
  | "SurfacesListResponse"
  | "PairRequest"
  | "PairResponse"
  | "RelinquishRequest"
  | "RelinquishResponse"
  | "TargetApplyRequest"
  | "TargetApplyResponse"
  | "TargetRegisterRequest"
  | "TargetRegisteredResponse"
  | "TargetRegisterRejectedResponse"
  | "ContentSetRequest"
  | "ContentAppendRequest"
  | "ContentPatchRequest"
  | "ContentClearRequest"
  | "AnnotationsRemoveRequest"
  | "SnapshotGetRequest"
  | "AuthorityStateRequest"
  | "HeartbeatPingRequest"
  | "PanesListRequest"
  | "PaneSplitRequest"
  | "PaneRenameRequest"
  | "PaneCloseRequest"
  | "MutationAckResponse"
  | "AnnotationsRemoveResponse"
  | "SnapshotResponse"
  | "AuthorityStateResponse"
  | "HeartbeatPongResponse"
  | "PanesListResponse"
  | "PaneSplitResponse"
  | "PaneRenameResponse"
  | "PaneCloseResponse"
  | "ErrorResponse"
  | "DrawingFlushEvent"
  | "AnnotationCommittedEvent"
  | "TapEvent"
  | "ScrollEvent"
  | "SelectionEvent"
  | "PageEvent"
  | "NavigationEvent"
  | "SurfaceAppearedEvent"
  | "SurfaceRemovedEvent"
  | "SurfaceResumedEvent"
  | "TopologyChangedEvent"
  | "SnapshotHintEvent"
  | "PaneCreatedEvent"
  | "PaneRemovedEvent"
  | "PaneRenamedEvent";

type ProtocolSchemaDocument = {
  $defs: Record<string, JsonSchema>;
};

const protocolSchemaDocument = JSON.parse(
  readFileSync(new URL("../schema.json", import.meta.url), "utf8"),
) as ProtocolSchemaDocument;

function getSchemaDef(name: ProtocolSchemaDefName): JsonSchema {
  return protocolSchemaDocument.$defs[name];
}

export const protocolSchemaDefs = protocolSchemaDocument.$defs;

export const surfacesListRequestSchema = getSchemaDef("SurfacesListRequest");
export const surfacesListResponseSchema = getSchemaDef("SurfacesListResponse");
export const pairRequestSchema = getSchemaDef("PairRequest");
export const pairResponseSchema = getSchemaDef("PairResponse");
export const relinquishRequestSchema = getSchemaDef("RelinquishRequest");
export const relinquishResponseSchema = getSchemaDef("RelinquishResponse");
export const targetApplyRequestSchema = getSchemaDef("TargetApplyRequest");
export const targetApplyResponseSchema = getSchemaDef("TargetApplyResponse");
export const targetRegisterRequestSchema = getSchemaDef("TargetRegisterRequest");
export const targetRegisteredResponseSchema = getSchemaDef("TargetRegisteredResponse");
export const targetRegisterRejectedResponseSchema = getSchemaDef("TargetRegisterRejectedResponse");
export const contentSetRequestSchema = getSchemaDef("ContentSetRequest");
export const contentAppendRequestSchema = getSchemaDef("ContentAppendRequest");
export const contentPatchRequestSchema = getSchemaDef("ContentPatchRequest");
export const contentClearRequestSchema = getSchemaDef("ContentClearRequest");
export const annotationsRemoveRequestSchema = getSchemaDef("AnnotationsRemoveRequest");
export const snapshotGetRequestSchema = getSchemaDef("SnapshotGetRequest");
export const authorityStateRequestSchema = getSchemaDef("AuthorityStateRequest");
export const heartbeatPingRequestSchema = getSchemaDef("HeartbeatPingRequest");
export const panesListRequestSchema = getSchemaDef("PanesListRequest");
export const paneSplitRequestSchema = getSchemaDef("PaneSplitRequest");
export const paneRenameRequestSchema = getSchemaDef("PaneRenameRequest");
export const paneCloseRequestSchema = getSchemaDef("PaneCloseRequest");

export const mutationAckResponseSchema = getSchemaDef("MutationAckResponse");
export const annotationsRemoveResponseSchema = getSchemaDef("AnnotationsRemoveResponse");
export const snapshotResponseSchema = getSchemaDef("SnapshotResponse");
export const authorityStateResponseSchema = getSchemaDef("AuthorityStateResponse");
export const heartbeatPongResponseSchema = getSchemaDef("HeartbeatPongResponse");
export const panesListResponseSchema = getSchemaDef("PanesListResponse");
export const paneSplitResponseSchema = getSchemaDef("PaneSplitResponse");
export const paneRenameResponseSchema = getSchemaDef("PaneRenameResponse");
export const paneCloseResponseSchema = getSchemaDef("PaneCloseResponse");
export const errorResponseSchema = getSchemaDef("ErrorResponse");

export const drawingFlushEventSchema = getSchemaDef("DrawingFlushEvent");
export const annotationCommittedEventSchema = getSchemaDef("AnnotationCommittedEvent");
export const tapEventSchema = getSchemaDef("TapEvent");
export const scrollEventSchema = getSchemaDef("ScrollEvent");
export const selectionEventSchema = getSchemaDef("SelectionEvent");
export const pageEventSchema = getSchemaDef("PageEvent");
export const navigationEventSchema = getSchemaDef("NavigationEvent");
export const surfaceAppearedEventSchema = getSchemaDef("SurfaceAppearedEvent");
export const surfaceRemovedEventSchema = getSchemaDef("SurfaceRemovedEvent");
export const surfaceResumedEventSchema = getSchemaDef("SurfaceResumedEvent");
export const topologyChangedEventSchema = getSchemaDef("TopologyChangedEvent");
export const snapshotHintEventSchema = getSchemaDef("SnapshotHintEvent");
export const paneCreatedEventSchema = getSchemaDef("PaneCreatedEvent");
export const paneRemovedEventSchema = getSchemaDef("PaneRemovedEvent");
export const paneRenamedEventSchema = getSchemaDef("PaneRenamedEvent");
