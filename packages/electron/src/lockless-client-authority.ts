import { randomUUID } from "node:crypto";

import {
  SURF_ACE_LOCKLESS_V1_CAPABILITY,
  assertLocklessCapacityLimits,
  type ConsumableCursorProjection,
  type ConsumableGap,
  type ConsumableRecord,
  type ConsumableRecordClass,
  type ConsumableScopeSnapshot,
  type ControllerInstanceId,
  type LocklessAuditRecord,
  type LocklessCapacityLimits,
  type LocklessControllerAdmission,
  type LocklessEntryProvenance,
  type LocklessErrorCode,
  type LocklessPairPayload,
  type LocklessOperationReceipt,
  type LocklessReceiptResolution,
  type LocklessTargetApplyIntent,
  type LocklessTargetApplyResult,
} from "../../protocol/src/lockless.js";

export const DEFAULT_LOCKLESS_LIMITS: LocklessCapacityLimits = {
  version: 1,
  maxPanesPerSurface: 16,
  maxSurfaceRecoverableBaseBytes: 1 * 1024 * 1024,
  maxPaneRecoverableStateBytes: 8 * 1024 * 1024,
  maxPaneAnnotationRestoreBytes: 4 * 1024 * 1024,
  maxRetainedTombstones: 32,
  maxRetainedTombstoneBytes: 1024 * 1024 * 1024,
  maxRecoverableSurfaceBytes: 640 * 1024 * 1024,
  maxPaneConsumableRecords: 256,
  maxPaneConsumableBytes: 4 * 1024 * 1024,
  maxSurfaceConsumableRecords: 1024,
  maxSurfaceConsumableBytes: 4 * 1024 * 1024,
  maxConsumableRecordBytes: 1 * 1024 * 1024,
  maxConsumableCursorStateBytesPerScope: 4096,
  maxAdmittedControllerEntries: 16,
  maxDormantControllerEntries: 12,
  maxDormantControllerBytes: 64 * 1024 * 1024,
  maxPendingOperationReceiptsPerController: 128,
  maxPendingOperationReceiptBytesPerController: 8 * 1024 * 1024,
};

export type LocklessHistoryEntry<T> = {
  annotations: unknown[];
  content: T;
  contentId: string | null;
  contentType: string | null;
  historyEntryId: string;
  lastVisibleSequence: number;
  provenance: LocklessEntryProvenance;
  revision: number;
};

export type LocklessHistoryState<T> = {
  back: LocklessHistoryEntry<T>[];
  forward: LocklessHistoryEntry<T>[];
  nextRevision: number;
  nextVisibleSequence: number;
  visible: LocklessHistoryEntry<T>;
};

export type PersistentConsumableScope = {
  cursors: Record<ControllerInstanceId, ConsumableCursorProjection>;
  liveFrames: Record<string, ConsumableRecord>;
  nextSequence: number;
  records: ConsumableRecord[];
  scopeId: string;
  scopeKind: "pane" | "surface";
};

export type PersistentControllerEntry = {
  controllerInstanceId: ControllerInstanceId;
  controllerProductName: string | null;
  disconnectedAt: number | null;
  dormantSequence: number | null;
  projectionCapacityBytes: number;
  pendingOperationReceipts: Record<string, PersistentOperationReceipt>;
  status: "dormant" | "live";
};

export type PersistentOperationReceipt =
  | {
      bytes: number;
      operation: string;
      requestId: string;
      status: "pending";
    }
  | {
      bytes: number;
      operation: string;
      operationReceipt: LocklessOperationReceipt;
      outcome: "resolved_success" | "resolved_failure";
      requestId: string;
      status: "acked" | "terminal";
      terminalResponse: unknown;
    };

export type PersistentTargetApplyWorkItem = {
  bytes: number;
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

export type PersistentTombstone = {
  bytes: number;
  closedSequence: number;
  kind: "pane" | "surface";
  payload: unknown;
  scopes: Record<string, PersistentConsumableScope>;
  surfaceId: string;
  tombstoneId: string;
};

export type PersistentLocklessClientState = {
  capability: typeof SURF_ACE_LOCKLESS_V1_CAPABILITY;
  controllers: Record<ControllerInstanceId, PersistentControllerEntry>;
  limits: LocklessCapacityLimits;
  modeBySurfaceId: Record<string, "legacy" | "lockless">;
  nextClosedSequence: number;
  nextCommitSequence: number;
  nextDormantSequence: number;
  scopes: Record<string, PersistentConsumableScope>;
  surfaceSetRevision: number;
  targetApplyWorkItems: Record<string, PersistentTargetApplyWorkItem>;
  tombstones: PersistentTombstone[];
  version: 1;
};

export type AuthorityEvent =
  | {
      record: LocklessAuditRecord;
      type: "diagnostic.lockless_audit";
    }
  | {
      commitSequence: number;
      controllerInstanceId: string;
      gap: ConsumableGap;
      scopeId: string;
      type: "event.consumable_overflow";
    }
  | {
      controllerInstanceId: string;
      scopeId: string;
      type: "event.consumable_available";
    }
  | {
      commitSequence: number;
      controllerInstanceId: string;
      cursorBytes: number;
      cursorCount: number;
      disconnectedAt: number | null;
      dormantSequence: number;
      maxDormantControllerBytes: number;
      maxDormantControllerEntries: number;
      reason: "dormant_capacity" | "entry_capacity";
      registryBytes: number;
      receiptBytes: number;
      receiptCount: number;
      scopeCount: number;
      surfaceCount: number;
      tombstoneCount: number;
      trigger: string;
      type: "event.controller_retention_reclaimed";
      unreadBytes: number;
      unreadFrameCount: number;
      unreadRecordCount: number;
    }
  | {
      bytes: number;
      closedSequence: number;
      commitSequence: number;
      kind: "pane" | "surface";
      maxRetainedTombstoneBytes: number;
      maxRetainedTombstones: number;
      nestedLivePaneCount: number;
      nestedPaneTombstoneCount: number;
      reason: "count_capacity" | "byte_capacity";
      surfaceId: string;
      tombstoneId: string;
      type: "event.tombstone_reclaimed";
      unreadBytesDiscarded: number;
      unreadFrameCount: number;
    }
  | {
      record: ConsumableRecord;
      result: LocklessTargetApplyResult;
      retained: boolean;
      scopeId: string;
      type: "event.target_apply_result";
    };

export class LocklessAuthorityError extends Error {
  constructor(
    readonly code: LocklessErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

export function exactDurableBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function exactVersionedReceiptBytes(
  value: Record<string, unknown>,
): number {
  let bytes = 0;
  for (;;) {
    const next = exactDurableBytes({ version: 1, bytes, ...value });
    if (next === bytes) return next;
    bytes = next;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nestedTombstones(
  tombstone: PersistentTombstone,
): PersistentTombstone[] {
  const nested = (
    tombstone.payload as { paneTombstones?: PersistentTombstone[] }
  )?.paneTombstones ?? [];
  return nested.flatMap((entry) => [
    entry,
    ...nestedTombstones(entry),
  ]);
}

function tombstoneScopes(
  tombstone: PersistentTombstone,
): PersistentConsumableScope[] {
  return [
    ...Object.values(tombstone.scopes),
    ...nestedTombstones(tombstone).flatMap(
      (entry) => Object.values(entry.scopes),
    ),
  ];
}

function scopeSurfaceId(scopeId: string): string | null {
  if (scopeId.startsWith("surface:")) {
    return decodeURIComponent(scopeId.slice("surface:".length));
  }
  if (scopeId.startsWith("pane:")) {
    return decodeURIComponent(scopeId.split(":")[1] ?? "") || null;
  }
  return null;
}

function newOpaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function targetApplyWorkItemKey(
  controllerInstanceId: string,
  operationRequestId: string,
): string {
  return JSON.stringify([controllerInstanceId, operationRequestId]);
}

function validControllerInstanceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function createEmptyLocklessClientState(
  limits: LocklessCapacityLimits = DEFAULT_LOCKLESS_LIMITS,
): PersistentLocklessClientState {
  assertLocklessCapacityLimits(limits);
  return {
    capability: SURF_ACE_LOCKLESS_V1_CAPABILITY,
    controllers: {},
    limits: clone(limits),
    modeBySurfaceId: {},
    nextClosedSequence: 1,
    nextCommitSequence: 1,
    nextDormantSequence: 1,
    scopes: {},
    surfaceSetRevision: 0,
    targetApplyWorkItems: {},
    tombstones: [],
    version: 1,
  };
}

export function migrateLocklessClientState(
  value: unknown,
  limits: LocklessCapacityLimits = DEFAULT_LOCKLESS_LIMITS,
): PersistentLocklessClientState {
  if (value === undefined || value === null) {
    return createEmptyLocklessClientState(limits);
  }
  if (
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1 ||
    (value as { capability?: unknown }).capability !==
      SURF_ACE_LOCKLESS_V1_CAPABILITY
  ) {
    throw new LocklessAuthorityError(
      "capability_mismatch",
      "Persisted lockless authority is incompatible; source state was preserved",
    );
  }
  const state = clone(value as PersistentLocklessClientState);
  state.limits.maxPendingOperationReceiptsPerController ??=
    DEFAULT_LOCKLESS_LIMITS.maxPendingOperationReceiptsPerController;
  state.limits.maxPendingOperationReceiptBytesPerController ??=
    DEFAULT_LOCKLESS_LIMITS.maxPendingOperationReceiptBytesPerController;
  assertLocklessCapacityLimits(state.limits);
  state.controllers ??= {};
  state.modeBySurfaceId ??= {};
  state.scopes ??= {};
  state.targetApplyWorkItems ??= {};
  state.tombstones ??= [];
  for (const tombstone of state.tombstones) {
    tombstone.scopes ??= {};
  }
  state.surfaceSetRevision = Math.max(0, Math.trunc(state.surfaceSetRevision));
  state.nextClosedSequence = Math.max(1, Math.trunc(state.nextClosedSequence));
  state.nextCommitSequence = Math.max(1, Math.trunc(state.nextCommitSequence));
  state.nextDormantSequence = Math.max(
    1,
    Math.trunc(state.nextDormantSequence),
  );
  for (const controller of Object.values(state.controllers).sort((left, right) =>
    left.controllerInstanceId.localeCompare(right.controllerInstanceId),
  )) {
    controller.pendingOperationReceipts ??= {};
    controller.status = "dormant";
    controller.disconnectedAt ??= 0;
    controller.dormantSequence ??= state.nextDormantSequence++;
  }
  return state;
}

export function createLocklessHistory<T>(
  content: T,
  contentId: string | null = null,
  contentType: string | null = null,
): LocklessHistoryState<T> {
  return {
    back: [],
    forward: [],
    nextRevision: 1,
    nextVisibleSequence: 2,
    visible: {
      annotations: [],
      content,
      contentId,
      contentType,
      historyEntryId: newOpaqueId("he"),
      lastVisibleSequence: 1,
      provenance: {
        controllerProductName: null,
        friendlyChatName: null,
      },
      revision: 0,
    },
  };
}

function trimNonVisibleHistory<T>(history: LocklessHistoryState<T>): void {
  while (history.back.length + history.forward.length > 20) {
    const candidates = [
      ...history.back.map((entry, index) => ({
        branch: "back" as const,
        entry,
        index,
      })),
      ...history.forward.map((entry, index) => ({
        branch: "forward" as const,
        entry,
        index,
      })),
    ].sort(
      (left, right) =>
        left.entry.lastVisibleSequence - right.entry.lastVisibleSequence,
    );
    const victim = candidates[0]!;
    history[victim.branch].splice(victim.index, 1);
  }
}

export function appendLocklessHistory<T>(
  history: LocklessHistoryState<T>,
  input: {
    annotations?: unknown[];
    content: T;
    contentId: string | null;
    contentType: string | null;
    provenance: LocklessEntryProvenance;
  },
): LocklessHistoryEntry<T> {
  history.forward = [];
  history.back.push(history.visible);
  const entry: LocklessHistoryEntry<T> = {
    annotations: clone(input.annotations ?? []),
    content: clone(input.content),
    contentId: input.contentId,
    contentType: input.contentType,
    historyEntryId: newOpaqueId("he"),
    lastVisibleSequence: history.nextVisibleSequence++,
    provenance: {
      controllerProductName:
        input.provenance.controllerProductName?.trim() || null,
      friendlyChatName: input.provenance.friendlyChatName?.trim() || null,
    },
    revision: history.nextRevision++,
  };
  history.visible = entry;
  trimNonVisibleHistory(history);
  return clone(entry);
}

export function navigateLocklessHistory<T>(
  history: LocklessHistoryState<T>,
  direction: "back" | "forward",
): LocklessHistoryEntry<T> | null {
  const source = direction === "back" ? history.back : history.forward;
  if (source.length === 0) {
    return null;
  }
  const destination =
    direction === "back" ? history.forward : history.back;
  destination.push(history.visible);
  history.visible = source.pop()!;
  history.visible.lastVisibleSequence = history.nextVisibleSequence++;
  trimNonVisibleHistory(history);
  return clone(history.visible);
}

export class LocklessClientAuthority {
  private authorityWorkTail: Promise<void> = Promise.resolve();
  private readonly connectionTokens = new Map<
    string,
    Map<string, string>
  >();
  private readonly listeners = new Set<(event: AuthorityEvent) => void>();
  private pendingEvents: AuthorityEvent[] | null = null;
  private state: PersistentLocklessClientState;

  constructor(
    persisted?: unknown,
    private readonly now: () => number = () => Date.now(),
    private readonly clientIdentity: string | null = null,
  ) {
    this.state = migrateLocklessClientState(persisted);
    this.assertPersistentInvariants();
  }

  subscribe(listener: (event: AuthorityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async serializeAuthorityWork<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.authorityWorkTail;
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.authorityWorkTail = queued;
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.authorityWorkTail === queued) {
        this.authorityWorkTail = Promise.resolve();
      }
    }
  }

  transaction<T>(operation: () => T): T {
    const ownsEvents = this.pendingEvents === null;
    const beforeEventCount = this.pendingEvents?.length ?? 0;
    const beforeState = clone(this.state);
    const beforeTokens = new Map(
      [...this.connectionTokens].map(([controllerId, slots]) => [
        controllerId,
        new Map(slots),
      ]),
    );
    if (ownsEvents) this.pendingEvents = [];
    try {
      const result = operation();
      if (ownsEvents) {
        const events = this.pendingEvents!;
        this.pendingEvents = null;
        for (const event of events) this.deliver(event);
      }
      return result;
    } catch (error) {
      this.state = beforeState;
      this.connectionTokens.clear();
      for (const [key, value] of beforeTokens) {
        this.connectionTokens.set(key, value);
      }
      if (ownsEvents) this.pendingEvents = null;
      else this.pendingEvents?.splice(beforeEventCount);
      throw error;
    }
  }

  async transactionAsync<T>(operation: () => Promise<T>): Promise<T> {
    return await this.serializeAuthorityWork(async () => {
      return await this.transactionAsyncExclusive(operation);
    });
  }

  private async transactionAsyncExclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const ownsEvents = this.pendingEvents === null;
    const beforeEventCount = this.pendingEvents?.length ?? 0;
    const beforeState = clone(this.state);
    const beforeTokens = new Map(
      [...this.connectionTokens].map(([controllerId, slots]) => [
        controllerId,
        new Map(slots),
      ]),
    );
    if (ownsEvents) this.pendingEvents = [];
    try {
      const result = await operation();
      if (ownsEvents) {
        const events = this.pendingEvents!;
        this.pendingEvents = null;
        for (const event of events) this.deliver(event);
      }
      return result;
    } catch (error) {
      this.state = beforeState;
      this.connectionTokens.clear();
      for (const [key, value] of beforeTokens) {
        this.connectionTokens.set(key, value);
      }
      if (ownsEvents) this.pendingEvents = null;
      else this.pendingEvents?.splice(beforeEventCount);
      throw error;
    }
  }

  async transactionPersisted<T>(
    operation: () => T,
    persist: () => Promise<void>,
  ): Promise<T> {
    return await this.serializeAuthorityWork(async () => {
      return await this.transactionPersistedExclusive(operation, persist);
    });
  }

  private async transactionPersistedExclusive<T>(
    operation: () => T,
    persist: () => Promise<void>,
  ): Promise<T> {
    if (this.pendingEvents !== null) {
      throw new LocklessAuthorityError(
        "internal_error",
        "Durable authority transaction cannot be nested",
      );
    }
    const beforeState = clone(this.state);
    const beforeTokens = new Map(
      [...this.connectionTokens].map(([controllerId, slots]) => [
        controllerId,
        new Map(slots),
      ]),
    );
    this.pendingEvents = [];
    try {
      const result = operation();
      await persist();
      const events = this.pendingEvents;
      this.pendingEvents = null;
      for (const event of events) this.deliver(event);
      return result;
    } catch (error) {
      this.state = beforeState;
      this.connectionTokens.clear();
      for (const [key, value] of beforeTokens) {
        this.connectionTokens.set(key, value);
      }
      this.pendingEvents = null;
      throw error;
    }
  }

  restorePersistentState(state: PersistentLocklessClientState): void {
    this.state = clone(state);
    this.assertPersistentInvariants();
  }

  exportState(): PersistentLocklessClientState {
    return clone(this.state);
  }

  get limits(): LocklessCapacityLimits {
    return clone(this.state.limits);
  }

  get surfaceSetRevision(): number {
    return this.state.surfaceSetRevision;
  }

  setSurfaceMode(surfaceId: string, mode: "legacy" | "lockless"): void {
    const current = this.state.modeBySurfaceId[surfaceId];
    if (current && current !== mode) {
      throw new LocklessAuthorityError(
        "capability_mismatch",
        `Surface ${surfaceId} is already admitted in ${current} mode`,
        { currentMode: current, requestedMode: mode },
      );
    }
    this.state.modeBySurfaceId[surfaceId] = mode;
  }

  convertSurfaceToLocklessMode(surfaceId: string): void {
    this.state.modeBySurfaceId[surfaceId] = "lockless";
  }

  surfaceMode(surfaceId: string): "legacy" | "lockless" | null {
    return this.state.modeBySurfaceId[surfaceId] ?? null;
  }

  admit(
    admission: LocklessControllerAdmission,
    connectionToken: string,
    requestId: string,
    connectionSlot = "lifecycle",
  ): { resumed: boolean } {
    const controllerInstanceId = admission.controllerInstanceId;
    if (!validControllerInstanceId(controllerInstanceId)) {
      this.rejectAudit(
        requestId,
        "controller.admit",
        null,
        "invalid_controller_instance",
      );
      throw new LocklessAuthorityError(
        "invalid_controller_instance",
        "controllerInstanceId is missing or malformed",
      );
    }
    if (
      !admission.protocolFeatures.includes(SURF_ACE_LOCKLESS_V1_CAPABILITY)
    ) {
      this.rejectAudit(
        requestId,
        "controller.admit",
        controllerInstanceId,
        "capability_mismatch",
      );
      throw new LocklessAuthorityError(
        "capability_mismatch",
        `Controller did not negotiate ${SURF_ACE_LOCKLESS_V1_CAPABILITY}`,
      );
    }
    const requiredProjectionBytes = Math.max(
      this.state.limits.maxPaneConsumableBytes,
      this.state.limits.maxSurfaceConsumableBytes,
    ) + this.state.limits.maxConsumableCursorStateBytesPerScope;
    if (admission.projectionCapacityBytes < requiredProjectionBytes) {
      throw new LocklessAuthorityError(
        "capability_mismatch",
        "Controller projection cannot hold the negotiated retained window",
        {
          requiredProjectionBytes,
          projectionCapacityBytes: admission.projectionCapacityBytes,
        },
      );
    }
    const liveSlots = this.connectionTokens.get(controllerInstanceId);
    const liveToken = liveSlots?.get(connectionSlot);
    if (liveToken && liveToken !== connectionToken) {
      this.rejectAudit(
        requestId,
        "controller.admit",
        controllerInstanceId,
        "duplicate_controller_instance",
      );
      throw new LocklessAuthorityError(
        "duplicate_controller_instance",
        "A live connection already holds controllerInstanceId",
      );
    }
    const existing = this.state.controllers[controllerInstanceId];
    if (!existing) {
      this.reclaimDormantUntilControllerAdmissionFits();
      if (
        Object.keys(this.state.controllers).length >=
        this.state.limits.maxAdmittedControllerEntries
      ) {
        throw new LocklessAuthorityError(
          "controller_capacity",
          "All admitted controller entries are live",
        );
      }
    }
    const resumed = Boolean(existing);
    this.state.controllers[controllerInstanceId] = {
      controllerInstanceId,
      controllerProductName:
        admission.controllerProductName?.trim() || null,
      disconnectedAt: null,
      dormantSequence: null,
      projectionCapacityBytes: admission.projectionCapacityBytes,
      pendingOperationReceipts:
        existing?.pendingOperationReceipts ?? {},
      status: "live",
    };
    const slots = liveSlots ?? new Map<string, string>();
    slots.set(connectionSlot, connectionToken);
    this.connectionTokens.set(controllerInstanceId, slots);
    for (const scope of this.allScopes()) {
      scope.cursors[controllerInstanceId] ??= {
        cursor: this.scopeTail(scope),
        gap: null,
        gapGeneration: 0,
      };
    }
    this.acceptAudit(
      requestId,
      "controller.admit",
      controllerInstanceId,
      null,
    );
    return { resumed };
  }

  disconnect(
    controllerInstanceId: string,
    connectionToken: string,
    connectionSlot?: string,
  ): void {
    const slots = this.connectionTokens.get(controllerInstanceId);
    const slot =
      connectionSlot ??
      [...(slots?.entries() ?? [])].find(
        ([, token]) => token === connectionToken,
      )?.[0];
    if (!slots || !slot || slots.get(slot) !== connectionToken) {
      return;
    }
    slots.delete(slot);
    if (slots.size > 0) {
      return;
    }
    this.connectionTokens.delete(controllerInstanceId);
    const controller = this.state.controllers[controllerInstanceId];
    if (!controller) {
      return;
    }
    controller.status = "dormant";
    controller.disconnectedAt = this.now();
    controller.dormantSequence = this.state.nextDormantSequence++;
    this.enforceDormantBounds("disconnect");
  }

  liveControllerIds(): string[] {
    return Object.values(this.state.controllers)
      .filter((entry) => entry.status === "live")
      .map((entry) => entry.controllerInstanceId);
  }

  hasController(controllerInstanceId: string): boolean {
    return Boolean(this.state.controllers[controllerInstanceId]);
  }

  controllerProductName(controllerInstanceId: string): string | null {
    return (
      this.state.controllers[controllerInstanceId]?.controllerProductName ??
      null
    );
  }

  beginOperationReceipt(
    controllerInstanceId: string,
    requestId: string,
    operation: string,
  ): void {
    const controller = this.state.controllers[controllerInstanceId];
    if (!controller) {
      throw new LocklessAuthorityError(
        "not_paired",
        "Operation receipt reservation requires an admitted controller",
      );
    }
    const receipts = controller.pendingOperationReceipts;
    const existing = receipts[requestId];
    if (existing) {
      throw new LocklessAuthorityError(
        "invalid_operation",
        "Request ID already has receipt state",
        { requestId, status: existing.status },
      );
    }
    const blocking = Object.values(receipts).find(
      (receipt) => receipt.status === "pending",
    );
    if (blocking) {
      throw new LocklessAuthorityError(
        "invalid_operation",
        "An earlier mutation receipt is still pending",
        { pendingRequestId: blocking.requestId },
      );
    }
    const candidate = {
      bytes: 0,
      operation,
      requestId,
      status: "pending" as const,
    };
    candidate.bytes = exactVersionedReceiptBytes({
      operation,
      requestId,
      status: "pending",
    });
    this.assertReceiptCapacity(controller, candidate.bytes, 1);
    receipts[requestId] = candidate;
  }

  completeOperationReceipt(
    controllerInstanceId: string,
    requestId: string,
    operation: string,
    outcome: "resolved_success" | "resolved_failure",
    terminalResponse: unknown,
    operationReceipt: LocklessOperationReceipt,
  ): void {
    const controller = this.state.controllers[controllerInstanceId];
    const pending = controller?.pendingOperationReceipts[requestId];
    if (!controller || pending?.status !== "pending") {
      throw new LocklessAuthorityError(
        "invalid_operation",
        "Operation receipt was not reserved",
        { requestId },
      );
    }
    const terminalWithoutBytes = {
      operation,
      operationReceipt: clone(operationReceipt),
      outcome,
      requestId,
      status: "terminal" as const,
      terminalResponse: clone(terminalResponse),
    };
    const bytes = exactVersionedReceiptBytes(terminalWithoutBytes);
    this.assertReceiptCapacity(controller, bytes - pending.bytes, 0);
    controller.pendingOperationReceipts[requestId] = {
      bytes,
      ...terminalWithoutBytes,
    };
  }

  resolveOperationReceipts(
    controllerInstanceId: string,
    requestIds: string[],
    controllerWasReclaimed = false,
  ): LocklessReceiptResolution[] {
    const controller = this.state.controllers[controllerInstanceId];
    return requestIds.map((requestId) => {
      if (!controller || controllerWasReclaimed) {
        return {
          cause: "controller_reclaimed" as const,
          outcome: "receipt_unavailable" as const,
          requestId,
        };
      }
      const receipt = controller.pendingOperationReceipts[requestId];
      if (!receipt) return { outcome: "not_committed" as const, requestId };
      if (receipt.status === "pending") {
        return { outcome: "still_pending" as const, requestId };
      }
      return {
        operationReceipt: clone(receipt.operationReceipt),
        outcome: receipt.outcome,
        requestId,
        terminalResponse: clone(receipt.terminalResponse),
      };
    });
  }

  acknowledgeOperationReceipt(
    controllerInstanceId: string,
    requestId: string,
    release = false,
  ): boolean {
    const receipts = this.state.controllers[controllerInstanceId]
      ?.pendingOperationReceipts;
    if (!receipts) return release;
    const receipt = receipts[requestId];
    if (release) {
      if (receipt?.status === "terminal") return false;
      if (receipt?.status === "acked") delete receipts[requestId];
      return true;
    }
    if (!receipt || receipt.status === "pending") return false;
    if (receipt.status === "terminal") {
      receipt.status = "acked";
      receipt.bytes = exactVersionedReceiptBytes({
        operation: receipt.operation,
        operationReceipt: receipt.operationReceipt,
        outcome: receipt.outcome,
        requestId: receipt.requestId,
        status: receipt.status,
        terminalResponse: receipt.terminalResponse,
      });
    }
    return true;
  }

  operationReceiptBytes(controllerInstanceId: string): number {
    return Object.values(
      this.state.controllers[controllerInstanceId]
        ?.pendingOperationReceipts ?? {},
    ).reduce((total, receipt) => total + receipt.bytes, 0);
  }

  admitTargetApplyWorkItem(input: {
    controllerInstanceId: string;
    currentSurfaceBase: unknown;
    intentCommitSequence: number;
    operationRequestId: string;
    request: LocklessTargetApplyIntent;
  }): PersistentTargetApplyWorkItem {
    const key = targetApplyWorkItemKey(
      input.controllerInstanceId,
      input.operationRequestId,
    );
    if (this.state.targetApplyWorkItems[key]) {
      throw new LocklessAuthorityError(
        "invalid_operation",
        "Target apply work item already exists",
        { operationRequestId: input.operationRequestId },
      );
    }
    const withoutBytes = {
      controllerInstanceId: input.controllerInstanceId,
      intentCommitSequence: input.intentCommitSequence,
      operationRequestId: input.operationRequestId,
      request: clone(input.request),
      state: "intent_committed" as const,
      surfaceId: input.request.surfaceId,
      targetEpoch: input.request.targetEpoch,
      targetId: input.request.targetId,
      targetRequestId: input.request.requestId,
    };
    const item: PersistentTargetApplyWorkItem = {
      bytes: exactVersionedReceiptBytes(withoutBytes),
      ...withoutBytes,
    };
    const currentBytes =
      exactDurableBytes(input.currentSurfaceBase) +
      Object.values(this.state.targetApplyWorkItems)
        .filter((candidate) => candidate.surfaceId === item.surfaceId)
        .reduce((total, candidate) => total + candidate.bytes, 0);
    const prospectiveBytes = currentBytes + item.bytes;
    if (
      prospectiveBytes >
      this.state.limits.maxSurfaceRecoverableBaseBytes
    ) {
      throw new LocklessAuthorityError(
        "surface_state_capacity",
        "Target apply work item exceeds surface recoverable base capacity",
        {
          currentBytes,
          maximumBytes:
            this.state.limits.maxSurfaceRecoverableBaseBytes,
          prospectiveBytes,
        },
      );
    }
    this.state.targetApplyWorkItems[key] = item;
    return clone(item);
  }

  targetApplyWorkItems(): PersistentTargetApplyWorkItem[] {
    return Object.values(this.state.targetApplyWorkItems)
      .sort(
        (left, right) =>
          left.intentCommitSequence - right.intentCommitSequence,
      )
      .map(clone);
  }

  markTargetApplyMaterializing(
    controllerInstanceId: string,
    operationRequestId: string,
  ): PersistentTargetApplyWorkItem | null {
    const item = this.state.targetApplyWorkItems[
      targetApplyWorkItemKey(controllerInstanceId, operationRequestId)
    ];
    if (!item) return null;
    if (item.state !== "intent_committed") {
      return null;
    }
    item.state = "materializing";
    item.bytes = exactVersionedReceiptBytes({
      controllerInstanceId: item.controllerInstanceId,
      intentCommitSequence: item.intentCommitSequence,
      operationRequestId: item.operationRequestId,
      request: item.request,
      state: item.state,
      surfaceId: item.surfaceId,
      targetEpoch: item.targetEpoch,
      targetId: item.targetId,
      targetRequestId: item.targetRequestId,
    });
    return clone(item);
  }

  completeTargetApplyWorkItem(
    controllerInstanceId: string,
    operationRequestId: string,
    result: Omit<
      LocklessTargetApplyResult,
      "intentCommitSequence" | "operationRequestId" | "surfaceId" |
        "targetEpoch" | "targetId" | "targetRequestId"
    >,
  ): {
    record: ConsumableRecord;
    result: LocklessTargetApplyResult;
    retained: boolean;
  } | null {
    const key = targetApplyWorkItemKey(
      controllerInstanceId,
      operationRequestId,
    );
    const item = this.state.targetApplyWorkItems[key];
    if (!item) return null;
    if (item.state !== "materializing") {
      throw new LocklessAuthorityError(
        "invalid_operation",
        "Target apply cannot terminalize before materializing",
        { operationRequestId, state: item.state },
      );
    }
    const terminal: LocklessTargetApplyResult = {
      ...clone(result),
      intentCommitSequence: item.intentCommitSequence,
      operationRequestId: item.operationRequestId,
      surfaceId: item.surfaceId,
      targetEpoch: item.targetEpoch,
      targetId: item.targetId,
      targetRequestId: item.targetRequestId,
    };
    const occurrence = this.appendConsumableOccurrence({
      payload: terminal,
      recordClass: "target_result",
      scopeId: `surface:${encodeURIComponent(item.surfaceId)}`,
      scopeKind: "surface",
      triggerOperation: "target.apply.materialization",
    });
    delete this.state.targetApplyWorkItems[key];
    this.acceptAudit(
      newOpaqueId("target_result"),
      "target.apply.materialization",
      controllerInstanceId,
      item.surfaceId,
      {
        intentCommitSequence: item.intentCommitSequence,
        operationRequestId: item.operationRequestId,
        recordId: occurrence.record.recordId,
        status: terminal.status,
        targetEpoch: item.targetEpoch,
        targetId: item.targetId,
        targetRequestId: item.targetRequestId,
      },
    );
    this.emit({
      record: clone(occurrence.record),
      result: clone(terminal),
      retained: occurrence.retained,
      scopeId: `surface:${encodeURIComponent(item.surfaceId)}`,
      type: "event.target_apply_result",
    });
    return {
      record: clone(occurrence.record),
      result: clone(terminal),
      retained: occurrence.retained,
    };
  }

  ensureScope(
    scopeId: string,
    scopeKind: "pane" | "surface",
  ): PersistentConsumableScope {
    const existing = this.state.scopes[scopeId];
    if (existing) {
      return existing;
    }
    const created: PersistentConsumableScope = {
      cursors: {},
      liveFrames: {},
      nextSequence: 1,
      records: [],
      scopeId,
      scopeKind,
    };
    for (const controllerId of Object.keys(this.state.controllers)) {
      created.cursors[controllerId] = {
        cursor: 1,
        gap: null,
        gapGeneration: 0,
      };
    }
    this.state.scopes[scopeId] = created;
    return created;
  }

  appendConsumable(input: {
    payload: unknown;
    recordClass: ConsumableRecordClass;
    scopeId: string;
    scopeKind: "pane" | "surface";
    triggerOperation: string;
  }): ConsumableRecord | null {
    const occurrence = this.appendConsumableOccurrence(input);
    return occurrence.retained ? clone(occurrence.record) : null;
  }

  private appendConsumableOccurrence(input: {
    payload: unknown;
    recordClass: ConsumableRecordClass;
    scopeId: string;
    scopeKind: "pane" | "surface";
    triggerOperation: string;
  }): { record: ConsumableRecord; retained: boolean } {
    const scope = this.ensureScope(input.scopeId, input.scopeKind);
    const sequence = scope.nextSequence++;
    const candidateWithoutBytes = {
      payload: clone(input.payload),
      recordClass: input.recordClass,
      recordId: newOpaqueId("cr"),
      sequence,
    };
    const candidate: ConsumableRecord = {
      ...candidateWithoutBytes,
      bytes: exactDurableBytes({
        version: 1,
        ...candidateWithoutBytes,
      }),
    };
    if (this.isLatestWins(input.recordClass)) {
      scope.records = scope.records.filter(
        (record) => record.recordClass !== input.recordClass,
      );
    }
    const { maxBytes, maxRecords } = this.scopeLimits(scope.scopeKind);
    if (
      candidate.bytes > this.state.limits.maxConsumableRecordBytes ||
      candidate.bytes > maxBytes
    ) {
      this.applyLoss(
        scope,
        [candidate],
        "record_oversize",
        input.triggerOperation,
      );
      return { record: clone(candidate), retained: false };
    }
    scope.records.push(candidate);
    const victims: ConsumableRecord[] = [];
    while (
      scope.records.length > maxRecords ||
      this.scopeBytes(scope) > maxBytes
    ) {
      victims.push(scope.records.shift()!);
    }
    if (victims.length > 0) {
      this.applyLoss(
        scope,
        victims,
        "scope_capacity",
        input.triggerOperation,
      );
    }
    for (const controllerId of this.liveControllerIds()) {
      const cursor = scope.cursors[controllerId]!;
      if (cursor.cursor <= candidate.sequence) {
        this.emit({
          controllerInstanceId: controllerId,
          scopeId: scope.scopeId,
          type: "event.consumable_available",
        });
      }
    }
    this.enforceDormantBounds("consumable_ingress");
    return {
      record: clone(candidate),
      retained: scope.records.some(
        (record) => record.recordId === candidate.recordId,
      ),
    };
  }

  importLegacyMigrationMaterial(
    controllerInstanceId: string,
    material: NonNullable<LocklessPairPayload["migrationMaterial"]>,
  ): void {
    for (const imported of material.scopes) {
      this.ensureScope(imported.scopeId, imported.scopeKind);
      for (const source of imported.records) {
        const record = this.appendConsumable({
          payload: source.payload,
          recordClass: source.recordClass,
          scopeId: imported.scopeId,
          scopeKind: imported.scopeKind,
          triggerOperation: "legacy_migration",
        });
        if (!record) {
          throw new LocklessAuthorityError(
            "capability_mismatch",
            "Legacy consumable record exceeds advertised lockless capacity",
            { scopeId: imported.scopeId },
          );
        }
      }
      for (const frame of imported.liveFrames ?? []) {
        if (imported.scopeKind !== "pane") {
          throw new LocklessAuthorityError(
            "invalid_payload",
            "Legacy live annotation frames require a pane scope",
            { scopeId: imported.scopeId },
          );
        }
        const record = this.updateLiveFrame({
          frameId: frame.frameId,
          payload: frame.payload,
          scopeId: imported.scopeId,
          triggerOperation: "legacy_migration",
        });
        if (!record) {
          throw new LocklessAuthorityError(
            "capability_mismatch",
            "Legacy live frame exceeds advertised lockless capacity",
            { scopeId: imported.scopeId },
          );
        }
      }
      const projection = this.state.scopes[imported.scopeId]!.cursors[
        controllerInstanceId
      ];
      if (projection?.gap) {
        throw new LocklessAuthorityError(
          "capability_mismatch",
          "Legacy consumable window exceeds advertised lockless capacity",
          { gap: projection.gap, scopeId: imported.scopeId },
        );
      }
    }
    for (const imported of material.gaps ?? []) {
      const scope = this.state.scopes[imported.scopeId];
      const projection = scope?.cursors[controllerInstanceId];
      if (!scope || !projection) {
        throw new LocklessAuthorityError(
          "invalid_payload",
          "Legacy overflow references an unknown migrated scope",
          { scopeId: imported.scopeId },
        );
      }
      const generation = projection.gapGeneration + 1;
      projection.gapGeneration = generation;
      projection.gap = {
        ...clone(imported.gap),
        cause: "legacy_overflow",
        generation,
      };
      projection.cursor = Math.max(
        projection.cursor,
        this.scopeProjectionRecords(scope)[0]?.sequence ??
          scope.nextSequence,
      );
    }
  }

  updateLiveFrame(input: {
    frameId: string;
    payload: unknown;
    scopeId: string;
    triggerOperation: string;
  }): ConsumableRecord | null {
    const scope = this.ensureScope(input.scopeId, "pane");
    const sequence = scope.nextSequence++;
    const recordWithoutBytes = {
      payload: clone(input.payload),
      recordClass: "annotation_frame" as const,
      recordId: input.frameId,
      sequence,
    };
    const record: ConsumableRecord = {
      ...recordWithoutBytes,
      bytes: exactDurableBytes({ version: 1, ...recordWithoutBytes }),
    };
    if (
      record.bytes > this.state.limits.maxConsumableRecordBytes ||
      record.bytes > this.state.limits.maxPaneConsumableBytes
    ) {
      delete scope.liveFrames[input.frameId];
      this.applyLoss(
        scope,
        [record],
        "record_oversize",
        input.triggerOperation,
      );
      return null;
    }
    scope.liveFrames[input.frameId] = record;
    while (
      scope.records.length + Object.keys(scope.liveFrames).length >
        this.state.limits.maxPaneConsumableRecords ||
      this.scopeBytes(scope) > this.state.limits.maxPaneConsumableBytes
    ) {
      const victim = scope.records.shift();
      if (!victim) {
        delete scope.liveFrames[input.frameId];
        this.applyLoss(
          scope,
          [record],
          "scope_capacity",
          input.triggerOperation,
        );
        return null;
      }
      this.applyLoss(
        scope,
        [victim],
        "scope_capacity",
        input.triggerOperation,
      );
    }
    return clone(record);
  }

  finalizeLiveFrame(
    scopeId: string,
    frameId: string,
    triggerOperation: string,
  ): ConsumableRecord | null {
    const scope = this.state.scopes[scopeId];
    const frame = scope?.liveFrames[frameId];
    if (!scope || !frame) {
      return null;
    }
    delete scope.liveFrames[frameId];
    return this.appendConsumable({
      payload: frame.payload,
      recordClass: "annotation_frame",
      scopeId,
      scopeKind: "pane",
      triggerOperation,
    });
  }

  scopeSnapshot(
    controllerInstanceId: string,
    scopeId: string,
  ): ConsumableScopeSnapshot {
    const scope = this.state.scopes[scopeId];
    if (!scope) {
      throw new Error(`Unknown consumable scope: ${scopeId}`);
    }
    const cursor = scope.cursors[controllerInstanceId];
    if (!cursor) {
      throw new Error(`Controller is not admitted for scope: ${scopeId}`);
    }
    const records = this.scopeProjectionRecords(scope);
    return {
      cursor: clone(cursor),
      firstRetainedSequence: records[0]?.sequence ?? scope.nextSequence,
      lastRetainedSequence: this.scopeTail(scope) - 1,
      records: clone(records),
      scopeId,
      version: 1,
    };
  }

  acknowledge(
    controllerInstanceId: string,
    input: { cursor: number; gapGeneration?: number; scopeId: string },
  ): void {
    const scope = this.state.scopes[input.scopeId];
    const projection = scope?.cursors[controllerInstanceId];
    if (!scope || !projection) {
      return;
    }
    projection.cursor = Math.max(
      projection.cursor,
      Math.min(Math.trunc(input.cursor), this.scopeTail(scope)),
    );
    if (
      input.gapGeneration !== undefined &&
      projection.gap?.generation === input.gapGeneration
    ) {
      projection.gap = null;
      projection.gapGeneration = input.gapGeneration;
    }
    this.dropFullyConsumedRecords(scope);
  }

  createTombstone(input: {
    kind: "pane" | "surface";
    payload: unknown;
    surfaceId: string;
  }): PersistentTombstone {
    const scopeIds =
      input.kind === "surface"
        ? Object.keys(this.state.scopes).filter(
            (scopeId) =>
              scopeId ===
                `surface:${encodeURIComponent(input.surfaceId)}` ||
              scopeId.startsWith(
                `pane:${encodeURIComponent(input.surfaceId)}:`,
              ),
          )
        : (() => {
            const paneId = (
              input.payload as { pane?: { paneId?: unknown } }
            )?.pane?.paneId;
            return Number.isInteger(paneId)
              ? [
                  `pane:${encodeURIComponent(input.surfaceId)}:${Number(
                    paneId,
                  )}`,
                ].filter((scopeId) => Boolean(this.state.scopes[scopeId]))
              : [];
          })();
    const scopes = Object.fromEntries(
      scopeIds.map((scopeId) => [
        scopeId,
        clone(this.state.scopes[scopeId]!),
      ]),
    );
    const tombstoneWithoutBytes = {
      closedSequence: this.state.nextClosedSequence++,
      kind: input.kind,
      payload: clone(input.payload),
      scopes,
      surfaceId: input.surfaceId,
      tombstoneId: newOpaqueId(input.kind === "pane" ? "pt" : "st"),
    };
    const tombstone: PersistentTombstone = {
      ...tombstoneWithoutBytes,
      bytes: exactDurableBytes({ version: 1, ...tombstoneWithoutBytes }),
    };
    if (tombstone.bytes > this.state.limits.maxRetainedTombstoneBytes) {
      throw new LocklessAuthorityError(
        "tombstone_capacity",
        "Tombstone exceeds the retained tombstone byte limit",
        {
          bytes: tombstone.bytes,
          maximumBytes: this.state.limits.maxRetainedTombstoneBytes,
        },
      );
    }
    const proposed = [...this.state.tombstones];
    const reclaimed: Array<{
      reason: "count_capacity" | "byte_capacity";
      tombstone: PersistentTombstone;
    }> = [];
    while (
      proposed.length + 1 > this.state.limits.maxRetainedTombstones ||
      proposed.reduce((total, entry) => total + entry.bytes, 0) +
        tombstone.bytes >
        this.state.limits.maxRetainedTombstoneBytes
    ) {
      const exceedsCount =
        proposed.length + 1 >
        this.state.limits.maxRetainedTombstones;
      const victim = proposed.shift();
      if (!victim) {
        throw new LocklessAuthorityError(
          "tombstone_capacity",
          "Tombstone pool cannot admit the close",
        );
      }
      reclaimed.push({
        reason: exceedsCount ? "count_capacity" : "byte_capacity",
        tombstone: victim,
      });
    }
    this.state.tombstones = [...proposed, tombstone];
    for (const scopeId of scopeIds) {
      delete this.state.scopes[scopeId];
    }
    for (const { reason, tombstone: victim } of reclaimed) {
      const nested = nestedTombstones(victim);
      const discardedRecords = tombstoneScopes(victim).flatMap(
        (scope) => this.scopeProjectionRecords(scope),
      );
      const nestedLivePaneCount = victim.kind === "surface"
        ? (
            victim.payload as {
              surface?: { panes?: unknown[] };
            }
          )?.surface?.panes?.length ?? 0
        : 0;
      const nestedPaneTombstoneCount = nested.filter(
        (entry) => entry.kind === "pane",
      ).length;
      const unreadBytesDiscarded = discardedRecords.reduce(
        (total, record) => total + record.bytes,
        0,
      );
      const unreadFrameCount = discardedRecords.filter(
        (record) => record.recordClass === "annotation_frame",
      ).length;
      const paneId = victim.kind === "pane"
        ? (
            victim.payload as { pane?: { paneId?: unknown } }
          )?.pane?.paneId
        : null;
      const audit = this.acceptAudit(
        newOpaqueId("reclamation"),
        "tombstone.reclaimed",
        null,
        victim.surfaceId,
        {
          bytes: victim.bytes,
          clientIdentity: this.clientIdentity,
          closedSequence: victim.closedSequence,
          kind: victim.kind,
          maxRetainedTombstoneBytes:
            this.state.limits.maxRetainedTombstoneBytes,
          maxRetainedTombstones:
            this.state.limits.maxRetainedTombstones,
          nestedLivePaneCount,
          nestedPaneTombstoneCount,
          paneId: Number.isInteger(paneId) ? Number(paneId) : null,
          reason,
          surfaceId: victim.surfaceId,
          tombstoneId: victim.tombstoneId,
          unreadBytesDiscarded,
          unreadFrameCount,
        },
      );
      this.emit({
        bytes: victim.bytes,
        closedSequence: victim.closedSequence,
        commitSequence: audit.commitSequence,
        kind: victim.kind,
        maxRetainedTombstoneBytes:
          this.state.limits.maxRetainedTombstoneBytes,
        maxRetainedTombstones:
          this.state.limits.maxRetainedTombstones,
        nestedLivePaneCount,
        nestedPaneTombstoneCount,
        reason,
        surfaceId: victim.surfaceId,
        tombstoneId: victim.tombstoneId,
        type: "event.tombstone_reclaimed",
        unreadBytesDiscarded,
        unreadFrameCount,
      });
    }
    return clone(tombstone);
  }

  restoreTombstone(
    tombstoneId: string,
    kind: "pane" | "surface",
  ): PersistentTombstone {
    const index = this.state.tombstones.findIndex(
      (entry) =>
        entry.tombstoneId === tombstoneId && entry.kind === kind,
    );
    if (index < 0) {
      throw new LocklessAuthorityError(
        "tombstone_not_found",
        `Unknown ${kind} tombstone`,
        { tombstoneId },
      );
    }
    const tombstone = this.state.tombstones[index]!;
    for (const scopeId of Object.keys(tombstone.scopes)) {
      if (this.state.scopes[scopeId]) {
        throw new LocklessAuthorityError(
          "invalid_operation",
          "Tombstone scope conflicts with live authority state",
          { scopeId, tombstoneId },
        );
      }
    }
    this.state.tombstones.splice(index, 1);
    for (const [scopeId, scope] of Object.entries(tombstone.scopes)) {
      this.state.scopes[scopeId] = clone(scope);
    }
    return clone(tombstone);
  }

  listTombstones(
    kind?: "pane" | "surface",
  ): PersistentTombstone[] {
    return clone(
      kind
        ? this.state.tombstones.filter((entry) => entry.kind === kind)
        : this.state.tombstones,
    );
  }

  retainedPaneIds(surfaceId: string): number[] {
    const paneIds: number[] = [];
    for (const tombstone of this.state.tombstones) {
      if (tombstone.surfaceId !== surfaceId) continue;
      if (tombstone.kind === "pane") {
        const paneId = (
          tombstone.payload as { pane?: { paneId?: unknown } }
        )?.pane?.paneId;
        if (Number.isInteger(paneId)) paneIds.push(Number(paneId));
        continue;
      }
      const nested = (
        tombstone.payload as {
          paneTombstones?: PersistentTombstone[];
          surface?: { panes?: Array<{ paneId?: unknown }> };
        }
      );
      for (const pane of nested.surface?.panes ?? []) {
        if (Number.isInteger(pane.paneId)) paneIds.push(Number(pane.paneId));
      }
      for (const paneTombstone of nested.paneTombstones ?? []) {
        const paneId = (
          paneTombstone.payload as { pane?: { paneId?: unknown } }
        )?.pane?.paneId;
        if (Number.isInteger(paneId)) paneIds.push(Number(paneId));
      }
    }
    return [...new Set(paneIds)];
  }

  takePaneTombstonesForSurface(surfaceId: string): PersistentTombstone[] {
    const selected = this.state.tombstones.filter(
      (entry) => entry.kind === "pane" && entry.surfaceId === surfaceId,
    );
    this.state.tombstones = this.state.tombstones.filter(
      (entry) => entry.kind !== "pane" || entry.surfaceId !== surfaceId,
    );
    return clone(selected);
  }

  restoreExactTombstones(tombstones: PersistentTombstone[]): void {
    const combined = [...this.state.tombstones, ...clone(tombstones)].sort(
      (left, right) => left.closedSequence - right.closedSequence,
    );
    if (
      combined.length > this.state.limits.maxRetainedTombstones ||
      combined.reduce((total, entry) => total + entry.bytes, 0) >
        this.state.limits.maxRetainedTombstoneBytes
    ) {
      throw new LocklessAuthorityError(
        "tombstone_capacity",
        "Exact tombstone restore exceeds retained pool",
      );
    }
    this.state.tombstones = combined;
  }

  assertTopologyRevision(
    expected: number,
    current: number,
    topology: unknown,
  ): void {
    if (expected !== current) {
      throw new LocklessAuthorityError(
        "stale_topology",
        `Expected topology revision ${current}`,
        { currentTopology: clone(topology), currentTopologyRevision: current },
      );
    }
  }

  assertSurfaceSetRevision(expected: number, surfaces: unknown): void {
    if (expected !== this.state.surfaceSetRevision) {
      throw new LocklessAuthorityError(
        "stale_surface_set",
        `Expected surface-set revision ${this.state.surfaceSetRevision}`,
        {
          currentSurfaceSetRevision: this.state.surfaceSetRevision,
          surfaces: clone(surfaces),
        },
      );
    }
  }

  advanceSurfaceSetRevision(): number {
    this.state.surfaceSetRevision += 1;
    return this.state.surfaceSetRevision;
  }

  assertPaneCreationCapacity(
    currentLivePaneCount: number,
    requestedResultingCount: number,
  ): void {
    if (requestedResultingCount > this.state.limits.maxPanesPerSurface) {
      throw new LocklessAuthorityError(
        "pane_capacity",
        "Pane-creating operation exceeds maxPanesPerSurface",
        {
          currentLivePaneCount,
          maxPanesPerSurface: this.state.limits.maxPanesPerSurface,
          requestedResultingCount,
        },
      );
    }
  }

  assertSurfaceRecoverableBaseCapacity(
    currentValue: unknown,
    prospectiveValue: unknown,
  ): void {
    const currentBytes = exactDurableBytes(currentValue);
    const prospectiveBytes = exactDurableBytes(prospectiveValue);
    if (
      prospectiveBytes >
      this.state.limits.maxSurfaceRecoverableBaseBytes
    ) {
      throw new LocklessAuthorityError(
        "surface_state_capacity",
        "Surface recoverable base exceeds configured capacity",
        {
          currentBytes,
          maximumBytes:
            this.state.limits.maxSurfaceRecoverableBaseBytes,
          prospectiveBytes,
        },
      );
    }
  }

  assertPaneRecoverableCapacity(
    currentValue: unknown,
    prospectiveValue: unknown,
    annotationRestoreValue: unknown,
  ): void {
    const currentBytes = exactDurableBytes(currentValue);
    const prospectiveBytes = exactDurableBytes(prospectiveValue);
    const annotationRestoreBytes = exactDurableBytes(annotationRestoreValue);
    if (
      prospectiveBytes > this.state.limits.maxPaneRecoverableStateBytes ||
      annotationRestoreBytes >
        this.state.limits.maxPaneAnnotationRestoreBytes
    ) {
      throw new LocklessAuthorityError(
        "pane_state_capacity",
        "Pane recoverable state exceeds configured capacity",
        {
          annotationRestoreBytes,
          currentBytes,
          exceededLimit:
            annotationRestoreBytes >
            this.state.limits.maxPaneAnnotationRestoreBytes
              ? "maxPaneAnnotationRestoreBytes"
              : "maxPaneRecoverableStateBytes",
          maximumBytes:
            annotationRestoreBytes >
            this.state.limits.maxPaneAnnotationRestoreBytes
              ? this.state.limits.maxPaneAnnotationRestoreBytes
              : this.state.limits.maxPaneRecoverableStateBytes,
          prospectiveBytes,
        },
      );
    }
  }

  allocatePaneIdentity(
    usedPaneIds: Iterable<number>,
    usedPaneLabels: Iterable<number>,
  ): { paneId: number; paneLabel: number } {
    const ids = new Set(usedPaneIds);
    const labels = new Set(usedPaneLabels);
    let paneId = 1;
    let paneLabel = 1;
    while (ids.has(paneId)) paneId += 1;
    while (labels.has(paneLabel)) paneLabel += 1;
    return { paneId, paneLabel };
  }

  auditAccepted(
    requestId: string,
    operation: string,
    controllerInstanceId: string | null,
    surfaceId: string | null,
    resultCorrelation: Record<string, unknown> | null = null,
  ): LocklessAuditRecord {
    return this.acceptAudit(
      requestId,
      operation,
      controllerInstanceId,
      surfaceId,
      resultCorrelation,
    );
  }

  auditRejected(
    requestId: string,
    operation: string,
    controllerInstanceId: string | null,
    errorCode: LocklessErrorCode,
    surfaceId: string | null,
  ): LocklessAuditRecord {
    return this.rejectAudit(
      requestId,
      operation,
      controllerInstanceId,
      errorCode,
      surfaceId,
    );
  }

  private assertPersistentInvariants(): void {
    assertLocklessCapacityLimits(this.state.limits);
    for (const controller of Object.values(this.state.controllers)) {
      controller.pendingOperationReceipts ??= {};
      const receipts = Object.values(controller.pendingOperationReceipts);
      const bytes = receipts.reduce((total, receipt) => {
        const exact = exactDurableBytes({ version: 1, ...receipt });
        if (receipt.bytes !== exact) {
          throw new LocklessAuthorityError(
            "capability_mismatch",
            "Persisted operation receipt byte accounting is invalid",
            { requestId: receipt.requestId },
          );
        }
        return total + exact;
      }, 0);
      if (
        receipts.length >
          this.state.limits.maxPendingOperationReceiptsPerController ||
        bytes >
          this.state.limits.maxPendingOperationReceiptBytesPerController
      ) {
        throw new LocklessAuthorityError(
          "capability_mismatch",
          "Persisted operation receipt ledger exceeds advertised limits",
          { bytes, count: receipts.length },
        );
      }
    }
    for (const [key, item] of Object.entries(
      this.state.targetApplyWorkItems,
    )) {
      const exact = exactDurableBytes({
        version: 1,
        bytes: item.bytes,
        controllerInstanceId: item.controllerInstanceId,
        intentCommitSequence: item.intentCommitSequence,
        operationRequestId: item.operationRequestId,
        request: item.request,
        state: item.state,
        surfaceId: item.surfaceId,
        targetEpoch: item.targetEpoch,
        targetId: item.targetId,
        targetRequestId: item.targetRequestId,
      });
      if (
        item.bytes !== exact ||
        key !==
          targetApplyWorkItemKey(
            item.controllerInstanceId,
            item.operationRequestId,
          ) ||
        (item.state !== "intent_committed" &&
          item.state !== "materializing")
      ) {
        throw new LocklessAuthorityError(
          "capability_mismatch",
          "Persisted target apply work item is invalid",
          { operationRequestId: item.operationRequestId },
        );
      }
    }
    for (const scope of this.allScopes()) {
      scope.records.sort((left, right) => left.sequence - right.sequence);
      scope.nextSequence = Math.max(
        scope.nextSequence,
        (scope.records.at(-1)?.sequence ?? 0) + 1,
      );
    }
  }

  private allScopes(): PersistentConsumableScope[] {
    const scopes = [...Object.values(this.state.scopes)];
    const visit = (tombstone: PersistentTombstone): void => {
      scopes.push(...Object.values(tombstone.scopes));
      const nested = (
        tombstone.payload as { paneTombstones?: PersistentTombstone[] }
      )?.paneTombstones;
      for (const child of nested ?? []) visit(child);
    };
    for (const tombstone of this.state.tombstones) visit(tombstone);
    return scopes;
  }

  private scopeLimits(kind: "pane" | "surface"): {
    maxBytes: number;
    maxRecords: number;
  } {
    return kind === "pane"
      ? {
          maxBytes: this.state.limits.maxPaneConsumableBytes,
          maxRecords: this.state.limits.maxPaneConsumableRecords,
        }
      : {
          maxBytes: this.state.limits.maxSurfaceConsumableBytes,
          maxRecords: this.state.limits.maxSurfaceConsumableRecords,
        };
  }

  private scopeBytes(scope: PersistentConsumableScope): number {
    return (
      scope.records.reduce((total, record) => total + record.bytes, 0) +
      Object.values(scope.liveFrames).reduce(
        (total, record) => total + record.bytes,
        0,
      )
    );
  }

  private scopeProjectionRecords(
    scope: PersistentConsumableScope,
  ): ConsumableRecord[] {
    return [...scope.records, ...Object.values(scope.liveFrames)].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }

  private scopeTail(scope: PersistentConsumableScope): number {
    return scope.nextSequence;
  }

  private isLatestWins(recordClass: ConsumableRecordClass): boolean {
    return new Set<ConsumableRecordClass>([
      "scroll",
      "selection",
      "page",
      "playback",
      "navigation",
    ]).has(recordClass);
  }

  private applyLoss(
    scope: PersistentConsumableScope,
    lostRecords: ConsumableRecord[],
    cause: ConsumableGap["cause"],
    triggerOperation: string,
  ): void {
    if (lostRecords.length === 0) return;
    const firstLostSequence = Math.min(
      ...lostRecords.map((record) => record.sequence),
    );
    const lastLostSequence = Math.max(
      ...lostRecords.map((record) => record.sequence),
    );
    const droppedBytes = lostRecords.reduce(
      (total, record) => total + record.bytes,
      0,
    );
    const classes = [
      ...new Set(lostRecords.map((record) => record.recordClass)),
    ];
    const firstRetained =
      this.scopeProjectionRecords(scope)[0]?.sequence ?? scope.nextSequence;
    const affected: Array<{
      controllerInstanceId: string;
      gap: ConsumableGap;
    }> = [];
    for (const [controllerInstanceId, cursor] of Object.entries(
      scope.cursors,
    )) {
      if (cursor.cursor > lastLostSequence) {
        continue;
      }
      const generation = cursor.gapGeneration + 1;
      const previous = cursor.gap;
      cursor.cursor = Math.max(cursor.cursor, firstRetained);
      cursor.gapGeneration = generation;
      cursor.gap = {
        cause,
        droppedBytes:
          previous?.lossExtent === "unknown"
            ? null
            : saturatingAdd(previous?.droppedBytes ?? 0, droppedBytes),
        droppedEventCount:
          previous?.lossExtent === "unknown"
            ? null
            : saturatingAdd(
                previous?.droppedEventCount ?? 0,
                lostRecords.filter((record) =>
                  ["tap", "content", "history", "topology"].includes(
                    record.recordClass,
                  ),
                ).length,
              ),
        droppedFrameCount:
          previous?.lossExtent === "unknown"
            ? null
            : saturatingAdd(
                previous?.droppedFrameCount ?? 0,
                lostRecords.filter(
                  (record) =>
                    record.recordClass === "annotation_frame",
                ).length,
              ),
        droppedRecordCount:
          previous?.lossExtent === "unknown"
            ? null
            : saturatingAdd(
                previous?.droppedRecordCount ?? 0,
                lostRecords.length,
              ),
        firstLostSequence:
          previous?.lossExtent === "unknown"
            ? null
            : Math.min(
                previous?.firstLostSequence ?? firstLostSequence,
                firstLostSequence,
              ),
        generation,
        lastLostSequence:
          previous?.lossExtent === "unknown"
            ? null
            : Math.max(
                previous?.lastLostSequence ?? lastLostSequence,
                lastLostSequence,
              ),
        lossExtent:
          previous?.lossExtent === "unknown" ? "unknown" : "exact",
        recordClasses: [
          ...new Set([...(previous?.recordClasses ?? []), ...classes]),
        ],
      };
      affected.push({
        controllerInstanceId,
        gap: clone(cursor.gap),
      });
    }
    const eventCount = lostRecords.filter((record) =>
      ["tap", "content", "history", "topology"].includes(record.recordClass)
    ).length;
    const frameCount = lostRecords.filter(
      (record) => record.recordClass === "annotation_frame",
    ).length;
    const limits = this.scopeLimits(scope.scopeKind);
    const surfaceId = scope.scopeId.startsWith("pane:")
      ? decodeURIComponent(scope.scopeId.split(":")[1] ?? "")
      : scope.scopeId.startsWith("surface:")
        ? decodeURIComponent(scope.scopeId.slice("surface:".length))
        : null;
    const audit = this.acceptAudit(
      newOpaqueId("overflow"),
      `consumable_overflow:${triggerOperation}`,
      null,
      surfaceId,
      {
        affectedControllers: affected.map((entry) => ({
          controllerInstanceId: entry.controllerInstanceId,
          gapGeneration: entry.gap.generation,
        })),
        activeLimits: {
          maxBytes: limits.maxBytes,
          maxConsumableRecordBytes:
            this.state.limits.maxConsumableRecordBytes,
          maxRecords: limits.maxRecords,
        },
        cause,
        clientIdentity: this.clientIdentity,
        droppedBytes,
        droppedEventCount: eventCount,
        droppedFrameCount: frameCount,
        droppedRecordCount: lostRecords.length,
        firstLostSequence,
        lastLostSequence,
        recordClasses: classes,
        resultingRetainedRange: {
          firstRetainedSequence: firstRetained,
          lastRetainedSequence: scope.nextSequence - 1,
        },
        scopeId: scope.scopeId,
        scopeKind: scope.scopeKind,
        triggerOperation,
      },
    );
    for (const entry of affected) {
      if (this.connectionTokens.has(entry.controllerInstanceId)) {
        this.emit({
          commitSequence: audit.commitSequence,
          controllerInstanceId: entry.controllerInstanceId,
          gap: entry.gap,
          scopeId: scope.scopeId,
          type: "event.consumable_overflow",
        });
      }
    }
  }

  private dropFullyConsumedRecords(scope: PersistentConsumableScope): void {
    const cursors = Object.values(scope.cursors);
    if (cursors.length === 0) {
      scope.records = [];
      return;
    }
    const floor = Math.min(...cursors.map((cursor) => cursor.cursor));
    scope.records = scope.records.filter(
      (record) => record.sequence >= floor,
    );
  }

  private dormantEntries(): PersistentControllerEntry[] {
    return Object.values(this.state.controllers)
      .filter((entry) => entry.status === "dormant")
      .sort(
        (left, right) =>
          (left.dormantSequence ?? 0) - (right.dormantSequence ?? 0),
      );
  }

  private assertReceiptCapacity(
    controller: PersistentControllerEntry,
    addedBytes: number,
    addedCount: number,
  ): void {
    const receipts = Object.values(controller.pendingOperationReceipts);
    const currentBytes = receipts.reduce(
      (total, receipt) => total + receipt.bytes,
      0,
    );
    const prospectiveBytes = currentBytes + addedBytes;
    const prospectiveCount = receipts.length + addedCount;
    if (
      prospectiveCount >
        this.state.limits.maxPendingOperationReceiptsPerController ||
      prospectiveBytes >
        this.state.limits.maxPendingOperationReceiptBytesPerController
    ) {
      throw new LocklessAuthorityError(
        "receipt_capacity",
        "Pending operation receipt ledger is at capacity",
        {
          currentBytes,
          currentCount: receipts.length,
          maxBytes:
            this.state.limits.maxPendingOperationReceiptBytesPerController,
          maxCount:
            this.state.limits.maxPendingOperationReceiptsPerController,
          prospectiveBytes,
          prospectiveCount,
        },
      );
    }
  }

  private dormantBytes(): number {
    const dormantIds = new Set(
      this.dormantEntries().map((entry) => entry.controllerInstanceId),
    );
    let bytes = this.dormantEntries().reduce(
      (total, entry) => total + exactDurableBytes(entry),
      0,
    );
    for (const scope of this.allScopes()) {
      for (const [controllerId, cursor] of Object.entries(scope.cursors)) {
        if (dormantIds.has(controllerId)) {
          bytes += exactDurableBytes(cursor);
        }
      }
      const liveCursors = Object.entries(scope.cursors)
        .filter(([id]) => !dormantIds.has(id))
        .map(([, cursor]) => cursor.cursor);
      for (const record of this.scopeProjectionRecords(scope)) {
        if (liveCursors.some((cursor) => cursor <= record.sequence)) {
          continue;
        }
        const needingDormant = Object.entries(scope.cursors)
          .filter(
            ([id, cursor]) =>
              dormantIds.has(id) && cursor.cursor <= record.sequence,
          )
          .sort(
            ([left], [right]) =>
              (this.state.controllers[left]?.dormantSequence ?? 0) -
              (this.state.controllers[right]?.dormantSequence ?? 0),
          );
        if (needingDormant.length > 0) {
          bytes += record.bytes;
        }
      }
    }
    return bytes;
  }

  private enforceDormantBounds(trigger: string): void {
    while (
      this.dormantEntries().length >
        this.state.limits.maxDormantControllerEntries ||
      this.dormantBytes() > this.state.limits.maxDormantControllerBytes
    ) {
      const victim = this.dormantEntries()[0];
      if (!victim) break;
      this.reclaimDormant(victim, trigger);
    }
  }

  private reclaimDormantUntilControllerAdmissionFits(): void {
    while (
      Object.keys(this.state.controllers).length >=
        this.state.limits.maxAdmittedControllerEntries &&
      this.dormantEntries().length > 0
    ) {
      this.reclaimDormant(this.dormantEntries()[0]!, "controller_admission");
    }
  }

  private reclaimDormant(
    victim: PersistentControllerEntry,
    trigger: string,
  ): void {
    const affectedScopes = this.allScopes().filter(
      (scope) => scope.cursors[victim.controllerInstanceId],
    );
    const cursorBytes = affectedScopes.reduce(
      (total, scope) =>
        total +
        exactDurableBytes(scope.cursors[victim.controllerInstanceId]),
      0,
    );
    const unread = affectedScopes.flatMap((scope) => {
      const cursor = scope.cursors[victim.controllerInstanceId]!.cursor;
      return this.scopeProjectionRecords(scope).filter(
        (record) => record.sequence >= cursor,
      );
    });
    const registryBytes = exactDurableBytes(victim);
    const receiptBytes = Object.values(victim.pendingOperationReceipts).reduce(
      (total, receipt) => total + receipt.bytes,
      0,
    );
    const receiptCount = Object.keys(victim.pendingOperationReceipts).length;
    const affectedSurfaceIds = new Set(
      affectedScopes
        .map((scope) => scopeSurfaceId(scope.scopeId))
        .filter((surfaceId): surfaceId is string => surfaceId !== null),
    );
    const retainedTombstones = this.state.tombstones.flatMap(
      (entry) => [entry, ...nestedTombstones(entry)],
    );
    const affectedTombstoneCount = retainedTombstones.filter(
      (entry) =>
        Object.values(entry.scopes).some(
          (scope) => scope.cursors[victim.controllerInstanceId],
        ),
    ).length;
    delete this.state.controllers[victim.controllerInstanceId];
    this.connectionTokens.delete(victim.controllerInstanceId);
    for (const scope of this.allScopes()) {
      delete scope.cursors[victim.controllerInstanceId];
      for (const [frameId, frame] of Object.entries(scope.liveFrames)) {
        const retainedForAnotherController = Object.values(
          scope.cursors,
        ).some((cursor) => cursor.cursor <= frame.sequence);
        if (!retainedForAnotherController) {
          delete scope.liveFrames[frameId];
        }
      }
      this.dropFullyConsumedRecords(scope);
    }
    const correlation = {
      clientIdentity: this.clientIdentity,
      controllerInstanceId: victim.controllerInstanceId,
      cursorBytes,
      cursorCount: affectedScopes.length,
      disconnectedAt: victim.disconnectedAt,
      dormantSequence: victim.dormantSequence!,
      maxDormantControllerBytes:
        this.state.limits.maxDormantControllerBytes,
      maxDormantControllerEntries:
        this.state.limits.maxDormantControllerEntries,
      reason: trigger === "controller_admission"
        ? "entry_capacity"
        : "dormant_capacity",
      registryBytes,
      receiptBytes,
      receiptCount,
      scopeCount: affectedScopes.length,
      surfaceCount: affectedSurfaceIds.size,
      tombstoneCount: affectedTombstoneCount,
      trigger,
      unreadBytes: unread.reduce(
        (total, record) => total + record.bytes,
        0,
      ),
      unreadFrameCount: unread.filter(
        (record) => record.recordClass === "annotation_frame",
      ).length,
      unreadRecordCount: unread.length,
    };
    const audit = this.acceptAudit(
      newOpaqueId("reclamation"),
      "controller.retention.reclaimed",
      victim.controllerInstanceId,
      null,
      correlation,
    );
    this.emit({
      commitSequence: audit.commitSequence,
      ...correlation,
      type: "event.controller_retention_reclaimed",
    });
  }

  private emit(event: AuthorityEvent): void {
    if (this.pendingEvents) {
      this.pendingEvents.push(clone(event));
      return;
    }
    this.deliver(event);
  }

  private deliver(event: AuthorityEvent): void {
    for (const listener of this.listeners) listener(clone(event));
  }

  private acceptAudit(
    requestId: string,
    operation: string,
    controllerInstanceId: string | null,
    surfaceId: string | null,
    resultCorrelation: Record<string, unknown> | null = null,
  ): LocklessAuditRecord {
    const record: LocklessAuditRecord = {
      commitSequence: this.state.nextCommitSequence++,
      controllerInstanceId,
      errorCode: null,
      operation,
      requestId,
      result: "accepted",
      resultCorrelation: clone(resultCorrelation),
      surfaceId,
      timestamp: this.now(),
    };
    this.emit({
      type: "diagnostic.lockless_audit",
      record,
    });
    return clone(record);
  }

  private rejectAudit(
    requestId: string,
    operation: string,
    controllerInstanceId: string | null,
    errorCode: LocklessErrorCode,
    surfaceId: string | null = null,
  ): LocklessAuditRecord {
    const record: LocklessAuditRecord = {
      commitSequence: this.state.nextCommitSequence++,
      controllerInstanceId,
      errorCode,
      operation,
      requestId,
      result: "rejected",
      resultCorrelation: null,
      surfaceId,
      timestamp: this.now(),
    };
    this.emit({
      type: "diagnostic.lockless_audit",
      record,
    });
    return clone(record);
  }
}
