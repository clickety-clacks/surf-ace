export const SURF_ACE_LOCKLESS_V1_CAPABILITY =
  "surf-ace.lockless-multi-controller.v1" as const;

export const LOCKLESS_MAX_REQUEST_ID_LENGTH = 64;
export const LOCKLESS_MAX_CONTROLLER_INSTANCE_ID_LENGTH = 64;
export const LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS = 256;
export const LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES = 128 * 1024;
export const LOCKLESS_MAX_ADMISSION_REASON_CODE_LENGTH = 64;
export const LOCKLESS_MAX_ADMISSION_REASON_JSON_BYTES = 512;

const LOCKLESS_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const LOCKLESS_CONTROLLER_INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const LOCKLESS_SURFACE_ID_PATTERN = /^sf_[A-Za-z0-9._:-]{3,64}$/;
const LOCKLESS_ADMISSION_REASON_CODE_PATTERN = /^[a-z_]{1,64}$/;

export function validLocklessRequestId(value: unknown): value is string {
  return typeof value === "string" && LOCKLESS_REQUEST_ID_PATTERN.test(value);
}

export function validLocklessControllerInstanceId(
  value: unknown,
): value is string {
  return typeof value === "string" &&
    LOCKLESS_CONTROLLER_INSTANCE_ID_PATTERN.test(value);
}

export function validLocklessSurfaceId(value: unknown): value is string {
  return typeof value === "string" && LOCKLESS_SURFACE_ID_PATTERN.test(value);
}

export function validLocklessAdmissionReasonCode(
  value: unknown,
): value is string {
  return typeof value === "string" &&
    LOCKLESS_ADMISSION_REASON_CODE_PATTERN.test(value);
}

export type ControllerInstanceId = string;
export type LocklessScopeId = string;
export type TombstoneId = string;

export function locklessPaneScopeId(
  surfaceId: string,
  paneId: number,
): LocklessScopeId {
  return `pane:${encodeURIComponent(surfaceId)}:${paneId}`;
}

export function locklessSurfaceScopeId(surfaceId: string): LocklessScopeId {
  return `surface:${encodeURIComponent(surfaceId)}`;
}

export type LocklessCapacityLimits = {
  version: 1;
  maxPanesPerSurface: number;
  maxSurfaceRecoverableBaseBytes: number;
  maxPaneRecoverableStateBytes: number;
  maxPaneAnnotationRestoreBytes: number;
  maxRetainedTombstones: number;
  maxRetainedTombstoneBytes: number;
  maxRecoverableSurfaceBytes: number;
  maxPaneConsumableRecords: number;
  maxPaneConsumableBytes: number;
  maxSurfaceConsumableRecords: number;
  maxSurfaceConsumableBytes: number;
  maxConsumableRecordBytes: number;
  maxConsumableCursorStateBytesPerScope: number;
  maxAdmittedControllerEntries: number;
  maxDormantControllerEntries: number;
  maxDormantControllerBytes: number;
  maxPendingOperationReceiptsPerController: number;
  maxPendingOperationReceiptBytesPerController: number;
};

export type LocklessControllerAdmission = {
  controllerInstanceId: ControllerInstanceId;
  controllerProductName?: string;
  projectionCapacityBytes: number;
  protocolFeatures: [typeof SURF_ACE_LOCKLESS_V1_CAPABILITY, ...string[]];
};

export type LocklessEntryProvenance = {
  friendlyChatName: string | null;
  controllerProductName: string | null;
};

export type ConsumableRecordClass =
  | "annotation_frame"
  | "tap"
  | "content"
  | "history"
  | "topology"
  | "scroll"
  | "selection"
  | "page"
  | "playback"
  | "navigation"
  | "target_result";

export type ConsumableRecord = {
  bytes: number;
  payload: unknown;
  recordClass: ConsumableRecordClass;
  recordId: string;
  sequence: number;
};

export type ConsumableGap = {
  cause: "legacy_overflow" | "scope_capacity" | "record_oversize";
  droppedBytes: number | null;
  droppedEventCount: number | null;
  droppedFrameCount: number | null;
  droppedRecordCount: number | null;
  firstLostSequence: number | null;
  generation: number;
  lastLostSequence: number | null;
  lossExtent: "exact" | "unknown";
  recordClasses: ConsumableRecordClass[];
};

export type ConsumableCursorProjection = {
  cursor: number;
  gap: ConsumableGap | null;
  gapGeneration: number;
};

export type ConsumableScopeSnapshot = {
  cursor: ConsumableCursorProjection;
  firstRetainedSequence: number;
  lastRetainedSequence: number;
  records: ConsumableRecord[];
  scopeId: LocklessScopeId;
  version: 1;
};

export type LocklessContentPush = {
  content: unknown;
  contentId: string;
  contentType: string;
  display?: Record<string, unknown>;
  friendlyChatName?: string;
  paneId: number;
};

export type LocklessContentCommit = {
  contentId: string;
  historyEntryId: string;
  paneId: number;
  revision: number;
};

export type LocklessContentAppendIntent = {
  contentId: string;
  expectedRevision: number;
  lines: string[];
  paneId: number;
};

export type LocklessContentPatchIntent = {
  contentId: string;
  expectedRevision: number;
  paneId: number;
  patch: {
    action:
      | "replace_inner"
      | "replace_outer"
      | "insert_before"
      | "insert_after"
      | "remove";
    html?: string;
    selector: string;
  };
};

export type LocklessContentClearIntent = {
  expectedRevision: number;
  paneId: number;
};

export type LocklessTopologyExpectation = {
  expectedTopologyRevision: number;
};

export type LocklessSurfaceSetExpectation = {
  expectedSurfaceSetRevision: number;
};

export type LocklessPaneSplitIntent = LocklessTopologyExpectation & {
  count: number;
  direction: "horizontal" | "vertical";
  paneId: number;
};

export type LocklessPaneCloseIntent = LocklessTopologyExpectation & {
  paneId: number;
};

export type LocklessPaneRenameIntent = LocklessTopologyExpectation & {
  name: string | null;
  paneId: number;
};

export type LocklessPaneRestoreIntent = LocklessTopologyExpectation & {
  anchorPaneId: number;
  direction: "horizontal" | "vertical";
  tombstoneId: TombstoneId;
};

export type LocklessConsumableAck = {
  cursor: number;
  gapGeneration?: number;
  scopeId: LocklessScopeId;
};

export type LocklessResumeState = {
  pendingAcks: LocklessConsumableAck[];
  unresolvedRequestIds?: string[];
  scopes: Record<
    LocklessScopeId,
    {
      cursor: number;
      gapGeneration: number;
    }
  >;
};

export type LocklessOperationReceipt = {
  commitSequence: number;
  requestId: string;
};

export type LocklessReceiptResolution =
  | {
      operationReceipt: LocklessOperationReceipt;
      outcome: "resolved_success" | "resolved_failure";
      requestId: string;
      terminalResponse: unknown;
    }
  | {
      outcome: "not_committed" | "still_pending";
      requestId: string;
    }
  | {
      cause: "controller_reclaimed";
      outcome: "receipt_unavailable";
      requestId: string;
    };

export type LocklessPairPayload = LocklessControllerAdmission & {
  migrationMaterial?: {
    gaps?: Array<{
      gap: Omit<ConsumableGap, "cause" | "generation"> & {
        cause: "legacy_overflow";
      };
      scopeId: LocklessScopeId;
    }>;
    scopes: Array<{
      liveFrames?: Array<{ frameId: string; payload: unknown }>;
      records: Array<{
        payload: unknown;
        recordClass: ConsumableRecordClass;
      }>;
      scopeId: LocklessScopeId;
      scopeKind: "pane" | "surface";
    }>;
  };
  protocolVersion: 1;
  resume?: LocklessResumeState;
  surfaceId?: string;
};

type LocklessPairResultBase = {
  capabilities: Record<string, unknown>;
  controllerInstanceId: ControllerInstanceId;
  limits: LocklessCapacityLimits;
  mode: "lockless";
  resumed: boolean;
  scopes: ConsumableScopeSnapshot[];
  sessionId: string;
  state: unknown | null;
  surfaceId: string | null;
  surfaceSetRevision: number;
  receiptResolutions: LocklessReceiptResolution[];
};

export type LocklessPairResult = LocklessPairResultBase &
  (
    | {
        migrationAccepted: true;
        migrationReceiptId: string;
      }
    | {
        migrationAccepted?: never;
        migrationReceiptId?: never;
      }
  );

export type LocklessConsumableDelta = {
  firstRetainedSequence: number;
  lastRetainedSequence: number;
  records: ConsumableRecord[];
  scopeId: LocklessScopeId;
};

export type LocklessConsumableOverflow = {
  firstRetainedSequence: number;
  gap: ConsumableGap;
  lastRetainedSequence: number;
  scopeId: LocklessScopeId;
};

export type LocklessSurfaceOpenIntent = LocklessSurfaceSetExpectation & {
  placement?: Record<string, unknown>;
};

export type LocklessSurfaceCloseIntent = LocklessSurfaceSetExpectation &
  LocklessTopologyExpectation & {
    surfaceId: string;
  };

export type LocklessSurfaceRestoreIntent = LocklessSurfaceSetExpectation & {
  placement?: Record<string, unknown>;
  tombstoneId: TombstoneId;
};

export type LocklessTopologyRealizeIntent = LocklessTopologyExpectation & {
  allowDestroyPaneIds: number[];
  desired: unknown;
  surfaceId: string;
  target: { root: true } | { paneId: number };
};

export type LocklessDestroyedPaneTombstone = {
  closedSequence: number;
  paneId: number;
  tombstoneId: TombstoneId;
};

export type LocklessTopologyRealizeResult = {
  createdPaneIds: number[];
  destroyedPaneIds: number[];
  destroyedPaneTombstones: LocklessDestroyedPaneTombstone[];
  panes: Array<Record<string, unknown>>;
  preservedPaneIds: number[];
  topology: unknown;
  topologyRevision: number;
};

export type LocklessTargetApplyIntent = {
  display?: Record<string, unknown>;
  paneId?: number;
  paneLineageId?: string;
  requestId: string;
  restoreReason: string;
  surfaceId: string;
  targetEpoch: number;
  targetHeader: Record<string, unknown>;
  targetId: string;
  targetKind: string;
  targetPayload: unknown;
};

export type LocklessTargetApplyAccepted = {
  operationReceipt: LocklessOperationReceipt;
  operationRequestId: string;
  status: "intent_committed";
  surfaceId: string;
  targetEpoch: number;
  targetId: string;
  targetRequestId: string;
};

export type LocklessTargetApplyResult = {
  errorCode?: string;
  intentCommitSequence: number;
  materializedState?: unknown;
  operationRequestId: string;
  status: "applied" | "failed";
  surfaceId: string;
  targetEpoch: number;
  targetId: string;
  targetRequestId: string;
};

export type LocklessTargetApplyWorkItem = {
  controllerInstanceId: ControllerInstanceId;
  intentCommitSequence: number;
  operationRequestId: string;
  request: LocklessTargetApplyIntent;
  state: "intent_committed" | "materializing";
  surfaceId: string;
  targetEpoch: number;
  targetId: string;
  targetRequestId: string;
};

export type LocklessTargetApplyResultEvent = LocklessTargetApplyResult & {
  consumableSequence: number;
  recordId: string;
};

export type LocklessTargetRegisterIntent = {
  expectedPreviousTargetEpoch: number | null;
  idempotencyKey: string;
  launchedAt: string;
  paneId?: number;
  paneLineageId?: string;
  registrationState: "before_attach" | "attached";
  restorePolicy?: string;
  surfaceId: string;
  targetHeader: Record<string, unknown>;
  targetKind: string;
  targetPayload: unknown;
};

type LocklessWireRequest<TOp extends string, TPayload> = {
  id: string;
  op: TOp;
  payload: TPayload;
  sentAt: number;
  type: "request";
  v: 1;
};

type LocklessWireEvent<TOp extends string, TPayload> = {
  eventId: string;
  op: TOp;
  payload: TPayload;
  sentAt: number;
  type: "event";
  v: 1;
};

export type LocklessRequest =
  | LocklessWireRequest<"pair.request", LocklessPairPayload>
  | LocklessWireRequest<"surfaces.list", Record<string, never>>
  | LocklessWireRequest<
      "panes.list",
      {
        surfaceId?: string;
      }
    >
  | LocklessWireRequest<"consumable.ack", LocklessConsumableAck>
  | LocklessWireRequest<
      "consumable.sync",
      {
        scopeIds: LocklessScopeId[];
      }
    >
  | LocklessWireRequest<
      "operation.receipt.sync",
      { requestIds: string[] }
    >
  | LocklessWireRequest<
      "operation.receipt.ack",
      { release?: boolean; requestId: string }
    >
  | LocklessWireRequest<
      "content.set",
      LocklessContentPush & { surfaceId: string }
    >
  | LocklessWireRequest<
      "content.append",
      LocklessContentAppendIntent & { surfaceId: string }
    >
  | LocklessWireRequest<
      "content.patch",
      LocklessContentPatchIntent & { surfaceId: string }
    >
  | LocklessWireRequest<
      "content.clear",
      LocklessContentClearIntent & { surfaceId: string }
    >
  | LocklessWireRequest<
      "pane.split",
      LocklessPaneSplitIntent & { surfaceId: string }
    >
  | LocklessWireRequest<
      "pane.close",
      LocklessPaneCloseIntent & { surfaceId: string }
    >
  | LocklessWireRequest<
      "pane.rename",
      LocklessPaneRenameIntent & { surfaceId: string }
    >
  | LocklessWireRequest<
      "pane.restore",
      LocklessPaneRestoreIntent & { surfaceId: string }
    >
  | LocklessWireRequest<"surface.window.open", LocklessSurfaceOpenIntent>
  | LocklessWireRequest<"surface.window.close", LocklessSurfaceCloseIntent>
  | LocklessWireRequest<
      "surface.window.restore",
      LocklessSurfaceRestoreIntent
    >
  | LocklessWireRequest<
      "surface.mode.convert",
      {
        currentMode: "legacy" | "lockless" | "unknown";
        surfaceId: string;
      }
    >
  | LocklessWireRequest<"topology.apply", LocklessTopologyRealizeIntent>
  | LocklessWireRequest<"target.apply", LocklessTargetApplyIntent>
  | LocklessWireRequest<"target.register", LocklessTargetRegisterIntent>
  | LocklessWireRequest<
      "annotations.remove",
      {
        contentId: string;
        paneId: number;
        strokeIds: string[];
        surfaceId: string;
      }
    >
  | LocklessWireRequest<
      "snapshot.get",
      {
        includeDrawings?: boolean;
        includeImage?: boolean;
        includeVisibleText?: boolean;
        paneId: number;
        surfaceId: string;
      }
    >
  | LocklessWireRequest<"heartbeat.ping", { nonce: string }>;

export type LocklessEvent =
  | LocklessWireEvent<
      "event.lockless_content_committed",
      LocklessContentCommit & { surfaceId: string }
    >
  | LocklessWireEvent<
      "event.lockless_scope_snapshot",
      { snapshot: ConsumableScopeSnapshot }
    >
  | LocklessWireEvent<
      "event.lockless_consumable_delta",
      LocklessConsumableDelta
    >
  | LocklessWireEvent<
      "event.consumable_available",
      { scopeId: LocklessScopeId }
    >
  | LocklessWireEvent<
      "event.consumable_overflow",
      LocklessConsumableOverflow
    >
  | LocklessWireEvent<
      "event.controller_retention_reclaimed",
      Record<string, unknown>
    >
  | LocklessWireEvent<
      "event.tombstone_reclaimed",
      Record<string, unknown>
    >
  | LocklessWireEvent<
      "event.target_apply_result",
      LocklessTargetApplyResultEvent
    >;

export type LocklessResponse = {
  id: string;
  ok: true;
  op: LocklessRequest["op"];
  payload: unknown;
  sentAt: number;
  type: "response";
  v: 1;
};

export type LocklessSurfaceAdmissionAttempt = {
  attemptSequence: number;
  controllerInstanceId: string;
  outcome: "failed" | "pending" | "succeeded";
  reason: string | null;
  reasonCode: string | null;
  requestId: string;
  stage:
    | "requested"
    | "surface_lookup"
    | "controller_admission"
    | "surface_preflight"
    | "legacy_migration"
    | "mode_commit";
  startedAt: number;
  surfaceId: string;
  updatedAt: number;
};

export type LocklessErrorCode =
  | "admission_failed"
  | "capability_mismatch"
  | "controller_capacity"
  | "duplicate_controller_instance"
  | "internal_error"
  | "invalid_controller_instance"
  | "invalid_operation"
  | "invalid_payload"
  | "not_paired"
  | "receipt_capacity"
  | "pane_capacity"
  | "pane_state_capacity"
  | "stale_content"
  | "stale_surface_set"
  | "stale_topology"
  | "surface_state_capacity"
  | "tombstone_capacity"
  | "tombstone_not_found"
  | "unsupported_operation";

export type LocklessAuditRecord = {
  commitSequence: number;
  controllerInstanceId: ControllerInstanceId | null;
  errorCode: LocklessErrorCode | null;
  operation: string;
  requestId: string;
  resultCorrelation: Record<string, unknown> | null;
  result: "accepted" | "rejected";
  surfaceId: string | null;
  timestamp: number;
};

export function locklessRecoverableSurfaceMinimumBytes(
  limits: LocklessCapacityLimits,
): number {
  const paneEnvelope =
    limits.maxPaneRecoverableStateBytes +
    limits.maxPaneConsumableBytes +
    limits.maxAdmittedControllerEntries *
      limits.maxConsumableCursorStateBytesPerScope;
  return (
    limits.maxSurfaceRecoverableBaseBytes +
    limits.maxSurfaceConsumableBytes +
    limits.maxAdmittedControllerEntries *
      limits.maxConsumableCursorStateBytesPerScope +
    (limits.maxPanesPerSurface + limits.maxRetainedTombstones) * paneEnvelope
  );
}

export function assertLocklessCapacityLimits(
  limits: LocklessCapacityLimits,
): void {
  for (const [name, value] of Object.entries(limits)) {
    if (name === "version") {
      continue;
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`invalid_lockless_limit:${name}`);
    }
  }
  if (
    limits.maxPaneAnnotationRestoreBytes >
    limits.maxPaneRecoverableStateBytes
  ) {
    throw new Error("invalid_lockless_limit:annotation_exceeds_pane");
  }
  if (
    limits.maxRecoverableSurfaceBytes >
    limits.maxRetainedTombstoneBytes
  ) {
    throw new Error("invalid_lockless_limit:surface_exceeds_tombstone_pool");
  }
  if (
    limits.maxRecoverableSurfaceBytes <
    locklessRecoverableSurfaceMinimumBytes(limits)
  ) {
    throw new Error("invalid_lockless_limit:recoverable_surface_envelope");
  }
}

const LOCKLESS_REQUEST_FIELDS: Record<
  LocklessRequest["op"],
  { optional?: string[]; required: string[] }
> = {
  "pair.request": {
    optional: [
      "controllerProductName",
      "migrationMaterial",
      "resume",
      "surfaceId",
    ],
    required: [
      "controllerInstanceId",
      "projectionCapacityBytes",
      "protocolFeatures",
      "protocolVersion",
    ],
  },
  "surfaces.list": { required: [] },
  "panes.list": { optional: ["surfaceId"], required: [] },
  "consumable.ack": {
    optional: ["gapGeneration"],
    required: ["cursor", "scopeId"],
  },
  "consumable.sync": { required: ["scopeIds"] },
  "operation.receipt.sync": { required: ["requestIds"] },
  "operation.receipt.ack": { optional: ["release"], required: ["requestId"] },
  "content.set": {
    optional: ["display", "friendlyChatName"],
    required: [
      "content",
      "contentId",
      "contentType",
      "paneId",
      "surfaceId",
    ],
  },
  "content.append": {
    required: [
      "contentId",
      "expectedRevision",
      "lines",
      "paneId",
      "surfaceId",
    ],
  },
  "content.patch": {
    required: [
      "contentId",
      "expectedRevision",
      "paneId",
      "patch",
      "surfaceId",
    ],
  },
  "content.clear": {
    required: ["expectedRevision", "paneId", "surfaceId"],
  },
  "pane.split": {
    required: [
      "count",
      "direction",
      "expectedTopologyRevision",
      "paneId",
      "surfaceId",
    ],
  },
  "pane.close": {
    required: ["expectedTopologyRevision", "paneId", "surfaceId"],
  },
  "pane.rename": {
    required: [
      "expectedTopologyRevision",
      "name",
      "paneId",
      "surfaceId",
    ],
  },
  "pane.restore": {
    required: [
      "anchorPaneId",
      "direction",
      "expectedTopologyRevision",
      "surfaceId",
      "tombstoneId",
    ],
  },
  "surface.window.open": {
    optional: ["placement"],
    required: ["expectedSurfaceSetRevision"],
  },
  "surface.window.close": {
    required: [
      "expectedSurfaceSetRevision",
      "expectedTopologyRevision",
      "surfaceId",
    ],
  },
  "surface.window.restore": {
    optional: ["placement"],
    required: ["expectedSurfaceSetRevision", "tombstoneId"],
  },
  "surface.mode.convert": {
    required: ["currentMode", "surfaceId"],
  },
  "topology.apply": {
    required: [
      "allowDestroyPaneIds",
      "desired",
      "expectedTopologyRevision",
      "surfaceId",
      "target",
    ],
  },
  "target.apply": {
    optional: ["display", "paneId", "paneLineageId"],
    required: [
      "requestId",
      "restoreReason",
      "surfaceId",
      "targetEpoch",
      "targetHeader",
      "targetId",
      "targetKind",
      "targetPayload",
    ],
  },
  "target.register": {
    optional: ["paneId", "paneLineageId", "restorePolicy"],
    required: [
      "expectedPreviousTargetEpoch",
      "idempotencyKey",
      "launchedAt",
      "registrationState",
      "surfaceId",
      "targetHeader",
      "targetKind",
      "targetPayload",
    ],
  },
  "annotations.remove": {
    required: ["contentId", "paneId", "strokeIds", "surfaceId"],
  },
  "snapshot.get": {
    optional: ["includeDrawings", "includeImage", "includeVisibleText"],
    required: ["paneId", "surfaceId"],
  },
  "heartbeat.ping": {
    required: ["nonce"],
  },
};

const LOCKLESS_EVENT_OPS = new Set<LocklessEvent["op"]>([
  "event.lockless_content_committed",
  "event.lockless_scope_snapshot",
  "event.lockless_consumable_delta",
  "event.consumable_available",
  "event.consumable_overflow",
  "event.controller_retention_reclaimed",
  "event.tombstone_reclaimed",
  "event.target_apply_result",
]);

const LOCKLESS_ERROR_CODES = new Set<LocklessErrorCode>([
  "admission_failed",
  "capability_mismatch",
  "controller_capacity",
  "duplicate_controller_instance",
  "internal_error",
  "invalid_controller_instance",
  "invalid_operation",
  "invalid_payload",
  "not_paired",
  "receipt_capacity",
  "pane_capacity",
  "pane_state_capacity",
  "stale_content",
  "stale_surface_set",
  "stale_topology",
  "surface_state_capacity",
  "tombstone_capacity",
  "tombstone_not_found",
  "unsupported_operation",
]);

const LEGACY_AUTHORITY_FIELDS = new Set([
  "connectionId",
  "historyOwnerToken",
  "initialPaneId",
  "initialPaneLabel",
  "newPaneIds",
  "newPaneLabels",
  "ownershipEpoch",
  "ownershipSessionId",
  "providerId",
  "revision",
  "takeover",
  "windowLabel",
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function forbiddenLegacyPath(
  value: unknown,
  path = "payload",
): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = forbiddenLegacyPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!plainRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (
      LEGACY_AUTHORITY_FIELDS.has(key) &&
      !(key === "revision" && path !== "payload")
    ) {
      return `${path}.${key}`;
    }
    const found = forbiddenLegacyPath(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function revision(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function rfc3339Timestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    month < 1 || month > 12 ||
    hour > 23 || minute > 59 || second > 60 ||
    offsetHour > 23 || offsetMinute > 59
  ) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function nonemptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function jsonStringBytes(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function optionalBoolean(
  payload: Record<string, unknown>,
  key: string,
): boolean {
  return !(key in payload) || typeof payload[key] === "boolean";
}

function validContentValue(contentType: unknown, content: unknown): boolean {
  if (contentType === "video") return typeof content === "string";
  if (contentType === "canvas") {
    return content === "" ||
      (plainRecord(content) &&
        hasExactKeys(content, [], ["color", "grid"]) &&
        (content.color === undefined || typeof content.color === "string") &&
        (content.grid === undefined || typeof content.grid === "boolean"));
  }
  if (!plainRecord(content)) return false;
  switch (contentType) {
    case "html":
      return hasExactKeys(content, ["html"], ["baseUrl"]) &&
        typeof content.html === "string" &&
        (content.baseUrl === undefined || typeof content.baseUrl === "string");
    case "image":
      return hasExactKeys(content, ["data", "mediaType"], ["alt"]) &&
        typeof content.data === "string" &&
        typeof content.mediaType === "string" &&
        (content.alt === undefined || typeof content.alt === "string");
    case "pdf":
      return hasExactKeys(content, ["data"]) &&
        typeof content.data === "string";
    case "terminal":
      return hasExactKeys(content, ["lines", "scrollback"]) &&
        Array.isArray(content.lines) &&
        content.lines.every((line) => typeof line === "string") &&
        revision(content.scrollback);
    case "markdown":
      return hasExactKeys(content, ["markdown"]) &&
        typeof content.markdown === "string";
    default:
      return false;
  }
}

function validDesiredTopology(value: unknown): boolean {
  if (!plainRecord(value)) return false;
  if (value.type === "pane") {
    return value.paneId === undefined || positiveInteger(value.paneId);
  }
  return (
    value.type === "split" &&
    (value.direction === "horizontal" ||
      value.direction === "vertical") &&
    Array.isArray(value.children) &&
    value.children.length >= 2 &&
    value.children.every(validDesiredTopology)
  );
}

function validRealizedTopology(value: unknown): boolean {
  if (!plainRecord(value)) return false;
  if (value.type === "pane") return positiveInteger(value.paneId);
  return (
    value.type === "split" &&
    (value.direction === "horizontal" ||
      value.direction === "vertical") &&
    Array.isArray(value.children) &&
    value.children.length >= 2 &&
    value.children.every(validRealizedTopology)
  );
}

function validTopologyRealizeResult(value: unknown): boolean {
  if (
    !plainRecord(value) ||
    !hasExactKeys(
      value,
      [
        "createdPaneIds",
        "destroyedPaneIds",
        "destroyedPaneTombstones",
        "panes",
        "preservedPaneIds",
        "topology",
        "topologyRevision",
      ],
      ["receipt"],
    )
  ) {
    return false;
  }
  const validPaneIds = (candidate: unknown) =>
    Array.isArray(candidate) && candidate.every(positiveInteger);
  return (
    validPaneIds(value.createdPaneIds) &&
    validPaneIds(value.destroyedPaneIds) &&
    validPaneIds(value.preservedPaneIds) &&
    Array.isArray(value.destroyedPaneTombstones) &&
    value.destroyedPaneTombstones.every(
      (candidate) =>
        plainRecord(candidate) &&
        hasExactKeys(candidate, [
          "closedSequence",
          "paneId",
          "tombstoneId",
        ]) &&
        positiveInteger(candidate.closedSequence) &&
        positiveInteger(candidate.paneId) &&
        nonemptyString(candidate.tombstoneId),
    ) &&
    Array.isArray(value.panes) &&
    value.panes.every(
      (candidate) =>
        plainRecord(candidate) && positiveInteger(candidate.paneId),
    ) &&
    validRealizedTopology(value.topology) &&
    revision(value.topologyRevision) &&
    (value.receipt === undefined || plainRecord(value.receipt))
  );
}

const CONSUMABLE_RECORD_CLASSES = new Set<ConsumableRecordClass>([
  "annotation_frame",
  "tap",
  "content",
  "history",
  "topology",
  "scroll",
  "selection",
  "page",
  "playback",
  "navigation",
  "target_result",
]);

function validTargetApplyResult(value: unknown): value is LocklessTargetApplyResult {
  if (
    !plainRecord(value) ||
    !hasExactKeys(
      value,
      [
        "intentCommitSequence",
        "operationRequestId",
        "status",
        "surfaceId",
        "targetEpoch",
        "targetId",
        "targetRequestId",
      ],
      ["errorCode", "materializedState"],
    )
  ) {
    return false;
  }
  return (
    positiveInteger(value.intentCommitSequence) &&
    nonemptyString(value.operationRequestId) &&
    (value.status === "applied" || value.status === "failed") &&
    nonemptyString(value.surfaceId) &&
    positiveInteger(value.targetEpoch) &&
    nonemptyString(value.targetId) &&
    nonemptyString(value.targetRequestId) &&
    (value.errorCode === undefined || nonemptyString(value.errorCode))
  );
}

function validTargetApplyAccepted(
  value: unknown,
  envelopeRequestId: string,
): value is LocklessTargetApplyAccepted {
  return (
    plainRecord(value) &&
    hasExactKeys(value, [
      "operationReceipt",
      "operationRequestId",
      "status",
      "surfaceId",
      "targetEpoch",
      "targetId",
      "targetRequestId",
    ]) &&
    plainRecord(value.operationReceipt) &&
    hasExactKeys(value.operationReceipt, ["commitSequence", "requestId"]) &&
    positiveInteger(value.operationReceipt.commitSequence) &&
    value.operationReceipt.requestId === envelopeRequestId &&
    value.operationRequestId === envelopeRequestId &&
    value.status === "intent_committed" &&
    nonemptyString(value.surfaceId) &&
    positiveInteger(value.targetEpoch) &&
    nonemptyString(value.targetId) &&
    nonemptyString(value.targetRequestId)
  );
}

function validConsumableGap(
  value: unknown,
  includeGeneration = false,
): value is ConsumableGap {
  if (
    !plainRecord(value) ||
    !hasExactKeys(
      value,
      [
        "cause",
        "droppedBytes",
        "droppedEventCount",
        "droppedFrameCount",
        "droppedRecordCount",
        "firstLostSequence",
        "lastLostSequence",
        "lossExtent",
        "recordClasses",
        ...(includeGeneration ? ["generation"] : []),
      ],
    )
  ) {
    return false;
  }
  const unknownExtent = value.lossExtent === "unknown";
  return (
    (value.cause === "legacy_overflow" ||
      (includeGeneration &&
        (value.cause === "scope_capacity" ||
          value.cause === "record_oversize"))) &&
    (!includeGeneration || positiveInteger(value.generation)) &&
    (value.lossExtent === "exact" || unknownExtent) &&
    (unknownExtent
      ? value.droppedBytes === null &&
        value.droppedEventCount === null &&
        value.droppedFrameCount === null &&
        value.droppedRecordCount === null &&
        value.firstLostSequence === null &&
        value.lastLostSequence === null
      : revision(value.droppedBytes) &&
        revision(value.droppedEventCount) &&
        revision(value.droppedFrameCount) &&
        revision(value.droppedRecordCount) &&
        positiveInteger(value.firstLostSequence) &&
        positiveInteger(value.lastLostSequence) &&
        Number(value.lastLostSequence) >=
          Number(value.firstLostSequence)) &&
    Array.isArray(value.recordClasses) &&
    value.recordClasses.length > 0 &&
    value.recordClasses.every((recordClass) =>
      CONSUMABLE_RECORD_CLASSES.has(recordClass as ConsumableRecordClass),
    ) &&
    new Set(value.recordClasses).size === value.recordClasses.length
  );
}

function validConsumableRecord(value: unknown): value is ConsumableRecord {
  return (
    plainRecord(value) &&
    hasExactKeys(value, [
      "bytes",
      "payload",
      "recordClass",
      "recordId",
      "sequence",
    ]) &&
    revision(value.bytes) &&
    CONSUMABLE_RECORD_CLASSES.has(
      value.recordClass as ConsumableRecordClass,
    ) &&
    nonemptyString(value.recordId) &&
    positiveInteger(value.sequence)
  );
}

function validScopeSnapshot(value: unknown): value is ConsumableScopeSnapshot {
  if (
    !plainRecord(value) ||
    !hasExactKeys(value, [
      "cursor",
      "firstRetainedSequence",
      "lastRetainedSequence",
      "records",
      "scopeId",
      "version",
    ]) ||
    value.version !== 1 ||
    !nonemptyString(value.scopeId) ||
    !positiveInteger(value.firstRetainedSequence) ||
    !revision(value.lastRetainedSequence) ||
    !Array.isArray(value.records) ||
    !value.records.every(validConsumableRecord) ||
    !plainRecord(value.cursor) ||
    !hasExactKeys(value.cursor, [
      "cursor",
      "gap",
      "gapGeneration",
    ]) ||
    !positiveInteger(value.cursor.cursor) ||
    !revision(value.cursor.gapGeneration)
  ) {
    return false;
  }
  return (
    value.cursor.gap === null ||
    validConsumableGap(value.cursor.gap, true)
  );
}

function validateLocklessEventPayload(
  op: LocklessEvent["op"],
  payload: Record<string, unknown>,
): boolean {
  switch (op) {
    case "event.lockless_content_committed":
      return (
        hasExactKeys(payload, [
          "contentId",
          "historyEntryId",
          "paneId",
          "revision",
          "surfaceId",
        ]) &&
        nonemptyString(payload.contentId) &&
        nonemptyString(payload.historyEntryId) &&
        positiveInteger(payload.paneId) &&
        positiveInteger(payload.revision) &&
        nonemptyString(payload.surfaceId)
      );
    case "event.lockless_scope_snapshot":
      return (
        hasExactKeys(payload, ["snapshot"]) &&
        validScopeSnapshot(payload.snapshot)
      );
    case "event.lockless_consumable_delta":
      return (
        hasExactKeys(payload, [
          "firstRetainedSequence",
          "lastRetainedSequence",
          "records",
          "scopeId",
        ]) &&
        positiveInteger(payload.firstRetainedSequence) &&
        revision(payload.lastRetainedSequence) &&
        Array.isArray(payload.records) &&
        payload.records.every(validConsumableRecord) &&
        nonemptyString(payload.scopeId)
      );
    case "event.consumable_available":
      return (
        hasExactKeys(payload, ["scopeId"]) &&
        nonemptyString(payload.scopeId)
      );
    case "event.consumable_overflow":
      return (
        hasExactKeys(payload, [
          "firstRetainedSequence",
          "gap",
          "lastRetainedSequence",
          "scopeId",
        ]) &&
        positiveInteger(payload.firstRetainedSequence) &&
        revision(payload.lastRetainedSequence) &&
        validConsumableGap(payload.gap, true) &&
        nonemptyString(payload.scopeId)
      );
    case "event.controller_retention_reclaimed":
    case "event.tombstone_reclaimed":
      return true;
    case "event.target_apply_result": {
      const { consumableSequence, recordId, ...result } = payload;
      return (
        positiveInteger(consumableSequence) &&
        nonemptyString(recordId) &&
        validTargetApplyResult(result)
      );
    }
  }
}

function validMigrationMaterial(value: unknown): boolean {
  if (
    !plainRecord(value) ||
    !hasExactKeys(value, ["scopes"], ["gaps"]) ||
    !Array.isArray(value.scopes)
  ) {
    return false;
  }
  const scopeIds = new Set<string>();
  if (
    !value.scopes.every((candidate) => {
      if (
        !plainRecord(candidate) ||
        !hasExactKeys(
          candidate,
          ["records", "scopeId", "scopeKind"],
          ["liveFrames"],
        ) ||
        !nonemptyString(candidate.scopeId)
      ) {
        return false;
      }
      const scopeId = String(candidate.scopeId);
      if (scopeIds.has(scopeId)) return false;
      scopeIds.add(scopeId);
      const frameIds = new Set<string>();
      return (
        (candidate.scopeKind === "pane" ||
          candidate.scopeKind === "surface") &&
        String(candidate.scopeId).startsWith(
          `${candidate.scopeKind}:`,
        ) &&
        Array.isArray(candidate.records) &&
        candidate.records.every(
          (record) =>
            plainRecord(record) &&
            hasExactKeys(record, ["payload", "recordClass"]) &&
            CONSUMABLE_RECORD_CLASSES.has(
              record.recordClass as ConsumableRecordClass,
            ),
        ) &&
        (candidate.liveFrames === undefined ||
          (Array.isArray(candidate.liveFrames) &&
            candidate.liveFrames.every(
              (frame) =>
                plainRecord(frame) &&
                hasExactKeys(frame, ["frameId", "payload"]) &&
                nonemptyString(frame.frameId) &&
                !frameIds.has(String(frame.frameId)) &&
                Boolean(frameIds.add(String(frame.frameId))),
            )))
      );
    })
  ) {
    return false;
  }
  if (value.gaps === undefined) return true;
  if (!Array.isArray(value.gaps)) return false;
  const gapScopeIds = new Set<string>();
  return value.gaps.every((candidate) => {
    if (
      !plainRecord(candidate) ||
      !hasExactKeys(candidate, ["gap", "scopeId"]) ||
      !nonemptyString(candidate.scopeId)
    ) {
      return false;
    }
    const scopeId = String(candidate.scopeId);
    return (
      scopeIds.has(scopeId) &&
      !gapScopeIds.has(scopeId) &&
      Boolean(gapScopeIds.add(scopeId)) &&
      validConsumableGap(candidate.gap)
    );
  });
}

function validReceiptResolution(value: unknown): boolean {
  if (!plainRecord(value) || !nonemptyString(value.requestId)) return false;
  if (value.outcome === "not_committed" || value.outcome === "still_pending") {
    return hasExactKeys(value, ["outcome", "requestId"]);
  }
  if (value.outcome === "receipt_unavailable") {
    return hasExactKeys(value, ["cause", "outcome", "requestId"]) &&
      value.cause === "controller_reclaimed";
  }
  if (value.outcome !== "resolved_success" && value.outcome !== "resolved_failure") {
    return false;
  }
  if (
    !hasExactKeys(value, [
      "operationReceipt",
      "outcome",
      "requestId",
      "terminalResponse",
    ]) ||
    !plainRecord(value.operationReceipt)
  ) {
    return false;
  }
  return hasExactKeys(value.operationReceipt, ["commitSequence", "requestId"]) &&
    revision(value.operationReceipt.commitSequence) &&
    value.operationReceipt.requestId === value.requestId;
}

function validateLocklessRequestPayload(
  op: LocklessRequest["op"],
  payload: Record<string, unknown>,
): string | null {
  const paneAndSurface = () =>
    positiveInteger(payload.paneId) && nonemptyString(payload.surfaceId);
  const requestIds = (value: unknown) =>
    Array.isArray(value) &&
    value.every(nonemptyString) &&
    new Set(value).size === value.length;
  switch (op) {
    case "pair.request":
      return validLocklessControllerInstanceId(payload.controllerInstanceId) &&
        (payload.surfaceId === undefined ||
          validLocklessSurfaceId(payload.surfaceId)) &&
        positiveInteger(payload.projectionCapacityBytes) &&
        payload.protocolVersion === 1 &&
        Array.isArray(payload.protocolFeatures) &&
        payload.protocolFeatures.length >= 1 &&
        payload.protocolFeatures[0] === SURF_ACE_LOCKLESS_V1_CAPABILITY &&
        payload.protocolFeatures.every(nonemptyString) &&
        (payload.migrationMaterial === undefined ||
          validMigrationMaterial(payload.migrationMaterial))
        ? null
        : "invalid_lockless_admission";
    case "surfaces.list":
      return null;
    case "panes.list":
      return payload.surfaceId === undefined ||
        nonemptyString(payload.surfaceId)
        ? null
        : "invalid_surface_id";
    case "consumable.ack":
      return revision(payload.cursor) &&
        Number(payload.cursor) >= 1 &&
        nonemptyString(payload.scopeId) &&
        /^(?:pane|surface):[^:]+(?::[1-9]\d*)?$/.test(
          String(payload.scopeId),
        ) &&
        (payload.gapGeneration === undefined ||
          revision(payload.gapGeneration))
        ? null
        : "invalid_consumable_ack";
    case "consumable.sync":
      return Array.isArray(payload.scopeIds) &&
        payload.scopeIds.every(
          (scopeId) =>
            nonemptyString(scopeId) &&
            /^(?:pane|surface):[^:]+(?::[1-9]\d*)?$/.test(scopeId),
        )
        ? null
        : "invalid_consumable_sync";
    case "operation.receipt.sync":
      return requestIds(payload.requestIds)
        ? null
        : "invalid_operation_receipt_sync";
    case "operation.receipt.ack":
      return nonemptyString(payload.requestId) &&
        (payload.release === undefined || typeof payload.release === "boolean")
        ? null
        : "invalid_operation_receipt_ack";
    case "content.set":
      return paneAndSurface() &&
        nonemptyString(payload.contentId) &&
        validContentValue(payload.contentType, payload.content) &&
        (payload.friendlyChatName === undefined ||
          typeof payload.friendlyChatName === "string") &&
        (payload.display === undefined || plainRecord(payload.display))
        ? null
        : "invalid_content_set";
    case "content.append":
      return paneAndSurface() &&
        nonemptyString(payload.contentId) &&
        revision(payload.expectedRevision) &&
        Array.isArray(payload.lines) &&
        payload.lines.every((line) => typeof line === "string")
        ? null
        : "invalid_content_append";
    case "content.patch":
      return paneAndSurface() &&
        nonemptyString(payload.contentId) &&
        revision(payload.expectedRevision) &&
        plainRecord(payload.patch) &&
        nonemptyString(payload.patch.selector) &&
        [
          "replace_inner",
          "replace_outer",
          "insert_before",
          "insert_after",
          "remove",
        ].includes(String(payload.patch.action))
        ? null
        : "invalid_content_patch";
    case "content.clear":
      return paneAndSurface() && revision(payload.expectedRevision)
        ? null
        : "invalid_content_clear";
    case "pane.split":
      return paneAndSurface() &&
        revision(payload.expectedTopologyRevision) &&
        positiveInteger(payload.count) &&
        Number(payload.count) >= 2 &&
        (payload.direction === "horizontal" ||
          payload.direction === "vertical")
        ? null
        : "invalid_pane_split";
    case "pane.close":
      return paneAndSurface() && revision(payload.expectedTopologyRevision)
        ? null
        : "invalid_pane_close";
    case "pane.rename":
      return paneAndSurface() &&
        revision(payload.expectedTopologyRevision) &&
        (payload.name === null || typeof payload.name === "string")
        ? null
        : "invalid_pane_rename";
    case "pane.restore":
      return nonemptyString(payload.surfaceId) &&
        nonemptyString(payload.tombstoneId) &&
        positiveInteger(payload.anchorPaneId) &&
        revision(payload.expectedTopologyRevision) &&
        (payload.direction === "horizontal" ||
          payload.direction === "vertical")
        ? null
        : "invalid_pane_restore";
    case "surface.window.open":
      return revision(payload.expectedSurfaceSetRevision) &&
        (payload.placement === undefined ||
          plainRecord(payload.placement))
        ? null
        : "invalid_surface_open";
    case "surface.window.close":
      return nonemptyString(payload.surfaceId) &&
        revision(payload.expectedSurfaceSetRevision) &&
        revision(payload.expectedTopologyRevision)
        ? null
        : "invalid_surface_close";
    case "surface.window.restore":
      return nonemptyString(payload.tombstoneId) &&
        revision(payload.expectedSurfaceSetRevision) &&
        (payload.placement === undefined ||
          plainRecord(payload.placement))
        ? null
        : "invalid_surface_restore";
    case "surface.mode.convert":
      return nonemptyString(payload.surfaceId) &&
        ["legacy", "lockless", "unknown"].includes(String(payload.currentMode))
        ? null
        : "invalid_surface_mode_conversion";
    case "topology.apply":
      return nonemptyString(payload.surfaceId) &&
        revision(payload.expectedTopologyRevision) &&
        Array.isArray(payload.allowDestroyPaneIds) &&
        payload.allowDestroyPaneIds.every(positiveInteger) &&
        plainRecord(payload.target) &&
        (payload.target.root === true ||
          positiveInteger(payload.target.paneId)) &&
        validDesiredTopology(payload.desired)
        ? null
        : "invalid_topology_intent";
    case "target.apply":
      return nonemptyString(payload.surfaceId) &&
        nonemptyString(payload.requestId) &&
        typeof payload.restoreReason === "string" &&
        nonemptyString(payload.targetId) &&
        positiveInteger(payload.targetEpoch) &&
        nonemptyString(payload.targetKind) &&
        plainRecord(payload.targetHeader) &&
        (payload.display === undefined || plainRecord(payload.display)) &&
        (payload.paneId === undefined || positiveInteger(payload.paneId)) &&
        (payload.paneLineageId === undefined ||
          nonemptyString(payload.paneLineageId))
        ? null
        : "invalid_target_apply";
    case "target.register":
      return nonemptyString(payload.surfaceId) &&
        nonemptyString(payload.idempotencyKey) &&
        rfc3339Timestamp(payload.launchedAt) &&
        (payload.expectedPreviousTargetEpoch === null ||
          revision(payload.expectedPreviousTargetEpoch)) &&
        (payload.registrationState === "before_attach" ||
          payload.registrationState === "attached") &&
        nonemptyString(payload.targetKind) &&
        plainRecord(payload.targetHeader) &&
        (payload.restorePolicy === undefined ||
          typeof payload.restorePolicy === "string") &&
        (payload.paneId === undefined || positiveInteger(payload.paneId)) &&
        (payload.paneLineageId === undefined ||
          nonemptyString(payload.paneLineageId))
        ? null
        : "invalid_target_register";
    case "annotations.remove":
      return paneAndSurface() &&
        nonemptyString(payload.contentId) &&
        Array.isArray(payload.strokeIds) &&
        payload.strokeIds.every(nonemptyString)
        ? null
        : "invalid_annotations_remove";
    case "snapshot.get":
      return paneAndSurface() &&
        optionalBoolean(payload, "includeDrawings") &&
        optionalBoolean(payload, "includeImage") &&
        optionalBoolean(payload, "includeVisibleText")
        ? null
        : "invalid_snapshot_get";
    case "heartbeat.ping":
      return nonemptyString(payload.nonce) ? null : "invalid_heartbeat";
  }
}

export function validLocklessSurfaceAdmissionAttempt(value: unknown): boolean {
  if (
    !plainRecord(value) ||
    !hasExactKeys(value, [
      "attemptSequence",
      "controllerInstanceId",
      "outcome",
      "reason",
      "reasonCode",
      "requestId",
      "stage",
      "startedAt",
      "surfaceId",
      "updatedAt",
    ])
  ) {
    return false;
  }
  return (
    positiveInteger(value.attemptSequence) &&
    validLocklessControllerInstanceId(value.controllerInstanceId) &&
    ["failed", "pending", "succeeded"].includes(String(value.outcome)) &&
    (value.reason === null ||
      (typeof value.reason === "string" && value.reason.length > 0 &&
        jsonStringBytes(value.reason) <=
          LOCKLESS_MAX_ADMISSION_REASON_JSON_BYTES)) &&
    (value.reasonCode === null ||
      validLocklessAdmissionReasonCode(value.reasonCode)) &&
    validLocklessRequestId(value.requestId) &&
    [
      "requested",
      "surface_lookup",
      "controller_admission",
      "surface_preflight",
      "legacy_migration",
      "mode_commit",
    ].includes(String(value.stage)) &&
    revision(value.startedAt) &&
    validLocklessSurfaceId(value.surfaceId) &&
    revision(value.updatedAt)
  );
}

export function validateLocklessEnvelope(
  envelope: unknown,
):
  | { ok: true }
  | { ok: false; reason: string } {
  if (!plainRecord(envelope)) {
    return { ok: false, reason: "envelope_not_object" };
  }
  if (
    envelope.v !== 1 ||
    typeof envelope.op !== "string" ||
    typeof envelope.sentAt !== "number"
  ) {
    return { ok: false, reason: "invalid_envelope" };
  }
  if (envelope.type === "request") {
    if (
      !hasExactKeys(envelope, [
        "id",
        "op",
        "payload",
        "sentAt",
        "type",
        "v",
      ]) ||
      !validLocklessRequestId(envelope.id) ||
      !plainRecord(envelope.payload)
    ) {
      return { ok: false, reason: "invalid_request" };
    }
    const fields =
      LOCKLESS_REQUEST_FIELDS[envelope.op as LocklessRequest["op"]];
    if (!fields) return { ok: false, reason: "unsupported_operation" };
    for (const key of fields.required) {
      if (!(key in envelope.payload)) {
        return { ok: false, reason: `missing_required:${key}` };
      }
    }
    const allowed = new Set([...fields.required, ...(fields.optional ?? [])]);
    for (const key of Object.keys(envelope.payload)) {
      if (LEGACY_AUTHORITY_FIELDS.has(key)) {
        return { ok: false, reason: `forbidden_legacy_field:${key}` };
      }
      if (!allowed.has(key)) {
        return { ok: false, reason: `unknown_property:${key}` };
      }
    }
    const forbiddenPath = forbiddenLegacyPath(envelope.payload);
    if (forbiddenPath) {
      return {
        ok: false,
        reason: `forbidden_legacy_field:${forbiddenPath}`,
      };
    }
    const payloadFailure = validateLocklessRequestPayload(
      envelope.op as LocklessRequest["op"],
      envelope.payload,
    );
    if (payloadFailure) return { ok: false, reason: payloadFailure };
    if (envelope.op === "pair.request") {
      const features = envelope.payload.protocolFeatures;
      if (
        envelope.payload.protocolVersion !== 1 ||
        !Array.isArray(features) ||
        features[0] !== SURF_ACE_LOCKLESS_V1_CAPABILITY ||
        !Number.isSafeInteger(envelope.payload.projectionCapacityBytes) ||
        Number(envelope.payload.projectionCapacityBytes) <= 0
      ) {
        return { ok: false, reason: "invalid_lockless_admission" };
      }
    }
    return { ok: true };
  }
  if (envelope.type === "response") {
    if (envelope.ok === false) {
      if (
        !hasExactKeys(envelope, [
          "error",
          "id",
          "ok",
          "op",
          "sentAt",
          "type",
          "v",
        ]) ||
        typeof envelope.id !== "string" ||
        !LOCKLESS_REQUEST_FIELDS[
          envelope.op as LocklessRequest["op"]
        ] ||
        !plainRecord(envelope.error) ||
        !hasExactKeys(
          envelope.error,
          ["code", "message"],
          ["details"],
        ) ||
        !LOCKLESS_ERROR_CODES.has(
          envelope.error.code as LocklessErrorCode,
        ) ||
        typeof envelope.error.message !== "string"
      ) {
        return { ok: false, reason: "invalid_error_response" };
      }
      return { ok: true };
    }
    if (
      !hasExactKeys(envelope, [
        "id",
        "ok",
        "op",
        "payload",
        "sentAt",
        "type",
        "v",
      ]) ||
      envelope.ok !== true ||
      typeof envelope.id !== "string" ||
      !LOCKLESS_REQUEST_FIELDS[
        envelope.op as LocklessRequest["op"]
      ] ||
      !("payload" in envelope)
    ) {
      return { ok: false, reason: "invalid_response" };
    }
    if (envelope.op === "pair.request") {
      if (!plainRecord(envelope.payload)) {
        return { ok: false, reason: "invalid_pair_response" };
      }
      if (
        !hasExactKeys(
          envelope.payload,
          [
            "capabilities",
            "controllerInstanceId",
            "limits",
            "mode",
            "receiptResolutions",
            "resumed",
            "scopes",
            "sessionId",
            "state",
            "surfaceId",
            "surfaceSetRevision",
          ],
          ["admissionAttempt", "migrationAccepted", "migrationReceiptId"],
        ) ||
        !nonemptyString(envelope.payload.controllerInstanceId) ||
        typeof envelope.payload.resumed !== "boolean" ||
        !Array.isArray(envelope.payload.receiptResolutions) ||
        !envelope.payload.receiptResolutions.every(validReceiptResolution) ||
        !Array.isArray(envelope.payload.scopes) ||
        !envelope.payload.scopes.every(validScopeSnapshot) ||
        !nonemptyString(envelope.payload.sessionId) ||
        (envelope.payload.surfaceId !== null &&
          !nonemptyString(envelope.payload.surfaceId)) ||
        !revision(envelope.payload.surfaceSetRevision) ||
        envelope.payload.mode !== "lockless" ||
        !plainRecord(envelope.payload.limits)
      ) {
        return { ok: false, reason: "lockless_limits_missing" };
      }
      if (
        envelope.payload.admissionAttempt !== undefined &&
        !validLocklessSurfaceAdmissionAttempt(envelope.payload.admissionAttempt)
      ) {
        return { ok: false, reason: "invalid_admission_attempt" };
      }
      const hasMigrationAccepted =
        "migrationAccepted" in envelope.payload;
      const hasMigrationReceipt =
        "migrationReceiptId" in envelope.payload;
      if (
        hasMigrationAccepted !== hasMigrationReceipt ||
        (hasMigrationAccepted &&
          (envelope.payload.migrationAccepted !== true ||
            envelope.payload.migrationReceiptId !== envelope.id))
      ) {
        return { ok: false, reason: "invalid_migration_receipt" };
      }
      try {
        assertLocklessCapacityLimits(
          envelope.payload.limits as LocklessCapacityLimits,
        );
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : "invalid_limits",
        };
      }
      for (const key of LEGACY_AUTHORITY_FIELDS) {
        if (key in envelope.payload) {
          return { ok: false, reason: `forbidden_legacy_field:${key}` };
        }
      }
      const capabilities = envelope.payload.capabilities;
      if (
        !plainRecord(capabilities) ||
        !Array.isArray(capabilities.protocolFeatures) ||
        capabilities.protocolFeatures.length !== 1 ||
        capabilities.protocolFeatures[0] !==
          SURF_ACE_LOCKLESS_V1_CAPABILITY
      ) {
        return { ok: false, reason: "lockless_mode_not_exclusive" };
      }
    }
    if (envelope.op === "surfaces.list") {
      if (!plainRecord(envelope.payload)) {
        return { ok: false, reason: "invalid_surfaces_list_response" };
      }
      const capabilities = envelope.payload.capabilities;
      if (
        !plainRecord(capabilities) ||
        !Array.isArray(capabilities.protocolFeatures) ||
        !capabilities.protocolFeatures.includes(
          SURF_ACE_LOCKLESS_V1_CAPABILITY,
        ) ||
        !plainRecord(capabilities.limits)
      ) {
        return { ok: false, reason: "lockless_discovery_missing" };
      }
      try {
        assertLocklessCapacityLimits(
          capabilities.limits as LocklessCapacityLimits,
        );
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : "invalid_limits",
        };
      }
      if (
        envelope.payload.admissionAttempts !== undefined &&
        (!Array.isArray(envelope.payload.admissionAttempts) ||
          !envelope.payload.admissionAttempts.every(
            validLocklessSurfaceAdmissionAttempt,
          ))
      ) {
        return { ok: false, reason: "invalid_admission_attempts" };
      }
    }
    if (
      envelope.op === "topology.apply" &&
      !validTopologyRealizeResult(envelope.payload)
    ) {
      return {
        ok: false,
        reason: "invalid_topology_realize_response",
      };
    }
    if (
      envelope.op === "target.apply" &&
      !validTargetApplyAccepted(envelope.payload, envelope.id)
    ) {
      return { ok: false, reason: "invalid_target_apply_response" };
    }
    if (envelope.op === "operation.receipt.sync") {
      if (
        !plainRecord(envelope.payload) ||
        !hasExactKeys(envelope.payload, ["resolutions"]) ||
        !Array.isArray(envelope.payload.resolutions) ||
        !envelope.payload.resolutions.every(validReceiptResolution)
      ) {
        return { ok: false, reason: "invalid_operation_receipt_sync_response" };
      }
    }
    if (envelope.op === "operation.receipt.ack") {
      if (
        !plainRecord(envelope.payload) ||
        !hasExactKeys(envelope.payload, ["accepted", "requestId"]) ||
        typeof envelope.payload.accepted !== "boolean" ||
        !nonemptyString(envelope.payload.requestId)
      ) {
        return { ok: false, reason: "invalid_operation_receipt_ack_response" };
      }
    }
    return { ok: true };
  }
  if (envelope.type === "event") {
    if (
      !hasExactKeys(envelope, [
        "eventId",
        "op",
        "payload",
        "sentAt",
        "type",
        "v",
      ]) ||
      typeof envelope.eventId !== "string" ||
      !LOCKLESS_EVENT_OPS.has(envelope.op as LocklessEvent["op"]) ||
      !plainRecord(envelope.payload) ||
      !validateLocklessEventPayload(
        envelope.op as LocklessEvent["op"],
        envelope.payload,
      )
    ) {
      return { ok: false, reason: "invalid_lockless_event" };
    }
    return { ok: true };
  }
  return { ok: false, reason: "invalid_envelope_type" };
}
