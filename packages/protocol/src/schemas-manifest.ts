import {
  annotationCommittedEventSchema,
  annotationsRemoveRequestSchema,
  annotationsRemoveResponseSchema,
  authorityStateRequestSchema,
  authorityStateResponseSchema,
  contentAppendRequestSchema,
  contentClearRequestSchema,
  contentPatchRequestSchema,
  contentSetRequestSchema,
  drawingFlushEventSchema,
  errorResponseSchema,
  heartbeatPingRequestSchema,
  heartbeatPongResponseSchema,
  mutationAckResponseSchema,
  navigationEventSchema,
  locklessRequestSchema,
  locklessResponseSchema,
  locklessTargetApplyResultEventSchema,
  pageEventSchema,
  pairRequestSchema,
  pairResponseSchema,
  relinquishRequestSchema,
  relinquishResponseSchema,
  surfaceWindowCloseRequestSchema,
  surfaceWindowCloseResponseSchema,
  surfaceWindowOpenRequestSchema,
  surfaceWindowOpenResponseSchema,
  targetApplyRequestSchema,
  targetApplyResponseSchema,
  targetRegisterRejectedResponseSchema,
  targetRegisteredResponseSchema,
  targetRegisterRequestSchema,
  paneCloseRequestSchema,
  paneCloseResponseSchema,
  paneCreatedEventSchema,
  paneRemovedEventSchema,
  paneRenamedEventSchema,
  paneRenameRequestSchema,
  paneRenameResponseSchema,
  panesListRequestSchema,
  panesListResponseSchema,
  paneSplitRequestSchema,
  paneSplitResponseSchema,
  scrollEventSchema,
  selectionEventSchema,
  snapshotGetRequestSchema,
  snapshotHintEventSchema,
  snapshotResponseSchema,
  surfaceAppearedEventSchema,
  surfaceRemovedEventSchema,
  surfaceResumedEventSchema,
  topologyChangedEventSchema,
  surfacesListRequestSchema,
  surfacesListResponseSchema,
  tapEventSchema,
} from "./schemas.js";

export const SURF_ACE_LOCKLESS_RECEIPT_SCHEMAS = {
  "operation.receipt.sync": {
    request: locklessRequestSchema,
    response: locklessResponseSchema,
    errorResponse: locklessResponseSchema,
  },
  "operation.receipt.ack": {
    request: locklessRequestSchema,
    response: locklessResponseSchema,
    errorResponse: locklessResponseSchema,
  },
} as const;

export const SURF_ACE_LOCKLESS_TARGET_SCHEMAS = {
  "event.target_apply_result": {
    event: locklessTargetApplyResultEventSchema,
  },
} as const;

export const SURF_ACE_PROTOCOL_SCHEMAS = {
  "surfaces.list": {
    request: surfacesListRequestSchema,
    response: surfacesListResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "pair.request": {
    request: pairRequestSchema,
    response: pairResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "ownership.relinquish": {
    request: relinquishRequestSchema,
    response: relinquishResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "surface.window.open": {
    request: surfaceWindowOpenRequestSchema,
    response: surfaceWindowOpenResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "surface.window.close": {
    request: surfaceWindowCloseRequestSchema,
    response: surfaceWindowCloseResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "target.apply": {
    request: targetApplyRequestSchema,
    response: targetApplyResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "target.register": {
    request: targetRegisterRequestSchema,
    response: targetRegisteredResponseSchema,
    rejectedResponse: targetRegisterRejectedResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "content.set": {
    request: contentSetRequestSchema,
    response: mutationAckResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "content.append": {
    request: contentAppendRequestSchema,
    response: mutationAckResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "content.patch": {
    request: contentPatchRequestSchema,
    response: mutationAckResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "content.clear": {
    request: contentClearRequestSchema,
    response: mutationAckResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "annotations.remove": {
    request: annotationsRemoveRequestSchema,
    response: annotationsRemoveResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "snapshot.get": {
    request: snapshotGetRequestSchema,
    response: snapshotResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "authority.state": {
    request: authorityStateRequestSchema,
    response: authorityStateResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "heartbeat.ping": {
    request: heartbeatPingRequestSchema,
    response: heartbeatPongResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "panes.list": {
    request: panesListRequestSchema,
    response: panesListResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "pane.split": {
    request: paneSplitRequestSchema,
    response: paneSplitResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "pane.rename": {
    request: paneRenameRequestSchema,
    response: paneRenameResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "pane.close": {
    request: paneCloseRequestSchema,
    response: paneCloseResponseSchema,
    errorResponse: errorResponseSchema,
  },
  "event.drawing_flush": {
    event: drawingFlushEventSchema,
  },
  "event.annotation_committed": {
    event: annotationCommittedEventSchema,
  },
  "event.tap": {
    event: tapEventSchema,
  },
  "event.scroll": {
    event: scrollEventSchema,
  },
  "event.selection": {
    event: selectionEventSchema,
  },
  "event.page": {
    event: pageEventSchema,
  },
  "event.navigation": {
    event: navigationEventSchema,
  },
  "event.surface_appeared": {
    event: surfaceAppearedEventSchema,
  },
  "event.surface_removed": {
    event: surfaceRemovedEventSchema,
  },
  "event.surface_resumed": {
    event: surfaceResumedEventSchema,
  },
  "event.topology_changed": {
    event: topologyChangedEventSchema,
  },
  "event.snapshot_hint": {
    event: snapshotHintEventSchema,
  },
  "event.pane_created": {
    event: paneCreatedEventSchema,
  },
  "event.pane_removed": {
    event: paneRemovedEventSchema,
  },
  "event.pane_renamed": {
    event: paneRenamedEventSchema,
  },
} as const;

export type SurfAceSchemaName = keyof typeof SURF_ACE_PROTOCOL_SCHEMAS;
export type SurfAceSchemaManifestEntry =
  (typeof SURF_ACE_PROTOCOL_SCHEMAS)[SurfAceSchemaName];
