import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LocklessAuthorityError,
  LocklessClientAuthority,
  appendLocklessHistory,
  createEmptyLocklessClientState,
  createLocklessHistory,
  exactDurableBytes,
  navigateLocklessHistory,
  type PersistentLocklessClientState,
} from "../src/lockless-client-authority.js";
import {
  SURF_ACE_LOCKLESS_V1_CAPABILITY,
  locklessRecoverableSurfaceMinimumBytes,
  type LocklessCapacityLimits,
} from "../../protocol/src/lockless.js";

const limits: LocklessCapacityLimits = {
  version: 1,
  maxPanesPerSurface: 2,
  maxSurfaceRecoverableBaseBytes: 1_000,
  maxPaneRecoverableStateBytes: 4_096,
  maxPaneAnnotationRestoreBytes: 2_048,
  maxRetainedTombstones: 2,
  maxRetainedTombstoneBytes: 30_000,
  maxRecoverableSurfaceBytes: 23_000,
  maxPaneConsumableRecords: 2,
  maxPaneConsumableBytes: 600,
  maxSurfaceConsumableRecords: 2,
  maxSurfaceConsumableBytes: 600,
  maxConsumableRecordBytes: 300,
  maxConsumableCursorStateBytesPerScope: 256,
  maxAdmittedControllerEntries: 2,
  maxDormantControllerEntries: 1,
  maxDormantControllerBytes: 2_048,
  maxPendingOperationReceiptsPerController: 2,
  maxPendingOperationReceiptBytesPerController: 2_048,
};

test("canonical target precommit vector pins unreceipted rejection classification", () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../../protocol/vectors/authority-conformance.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Array<{ id: string; tokens?: string[] }> };
  const target = vectors.vectors.find(
    (vector) => vector.id === "lockless-target-precommit-rejection-classification",
  );

  assert.deepEqual(target?.tokens, [
    "unsupported_operation",
    "invalid_payload",
    "capability_missing",
    "pane_lineage_missing",
    "policy_denied",
    "unsafe_payload",
    "not_committed",
  ]);
});

function authority(): LocklessClientAuthority {
  return new LocklessClientAuthority(createEmptyLocklessClientState(limits));
}

function admit(
  target: LocklessClientAuthority,
  controllerInstanceId: string,
  token = controllerInstanceId,
): void {
  target.admit(
    {
      controllerInstanceId,
      projectionCapacityBytes: 856,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    },
    token,
    `admit-${controllerInstanceId}`,
  );
}

test("lockless history always appends client identity and evicts cross-branch LRU", () => {
  const history = createLocklessHistory("bootstrap");
  for (let index = 0; index < 22; index += 1) {
    const entry = appendLocklessHistory(history, {
      content: `entry-${index}`,
      contentId: `content-${index}`,
      contentType: "markdown",
      provenance: {
        controllerProductName: index % 2 ? "Tight Beam" : "OpenClaw",
        friendlyChatName: `chat-${index}`,
      },
    });
    assert.equal(entry.revision, index + 1);
    assert.match(entry.historyEntryId, /^he_/);
  }
  assert.equal(history.back.length + history.forward.length, 20);
  const prior = navigateLocklessHistory(history, "back");
  assert.equal(prior?.content, "entry-20");
  assert.equal(prior?.provenance.controllerProductName, "OpenClaw");
});

test("controller instance is deconflicted and retained across restart as dormant", () => {
  const target = authority();
  admit(target, "controller-a", "socket-a");
  assert.throws(
    () => admit(target, "controller-a", "socket-b"),
    (error) =>
      error instanceof LocklessAuthorityError &&
      error.code === "duplicate_controller_instance",
  );
  target.disconnect("controller-a", "socket-a");
  const restored = new LocklessClientAuthority(target.exportState());
  assert.deepEqual(restored.liveControllerIds(), []);
  assert.equal(
    restored.admit(
      {
        controllerInstanceId: "controller-a",
        projectionCapacityBytes: 856,
        protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
      },
      "socket-c",
      "resume-a",
    ).resumed,
    true,
  );
});

test("same controller may hold one lifecycle and one per-surface slot", () => {
  const target = authority();
  const admission = {
    controllerInstanceId: "controller-a",
    projectionCapacityBytes: 856,
    protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY] as [
      typeof SURF_ACE_LOCKLESS_V1_CAPABILITY,
    ],
  };
  target.admit(admission, "lifecycle-token", "lifecycle", "lifecycle");
  assert.equal(
    target.admit(
      admission,
      "surface-token",
      "surface-a",
      "surface:surface-a",
    ).resumed,
    true,
  );
  assert.throws(
    () =>
      target.admit(
        admission,
        "duplicate-token",
        "duplicate",
        "surface:surface-a",
      ),
    (error) =>
      error instanceof LocklessAuthorityError &&
      error.code === "duplicate_controller_instance",
  );
  target.disconnect("controller-a", "lifecycle-token", "lifecycle");
  assert.deepEqual(target.liveControllerIds(), ["controller-a"]);
  target.disconnect(
    "controller-a",
    "surface-token",
    "surface:surface-a",
  );
  assert.deepEqual(target.liveControllerIds(), []);
});

test("operation receipts survive connections until explicit acknowledgement", () => {
  const target = authority();
  admit(target, "controller-a");
  target.beginOperationReceipt("controller-a", "mutation-a", "content.set");
  target.completeOperationReceipt(
    "controller-a",
    "mutation-a",
    "content.set",
    "resolved_success",
    { id: "mutation-a", ok: true, payload: { revision: 2 } },
    { commitSequence: 7, requestId: "mutation-a" },
  );
  const stored = target.exportState().controllers["controller-a"]!
    .pendingOperationReceipts["mutation-a"]!;
  assert.equal(stored.bytes, exactDurableBytes({ version: 1, ...stored }));
  assert.deepEqual(
    target.resolveOperationReceipts("controller-a", ["mutation-a"]),
    [{
      operationReceipt: { commitSequence: 7, requestId: "mutation-a" },
      outcome: "resolved_success",
      requestId: "mutation-a",
      terminalResponse: {
        id: "mutation-a",
        ok: true,
        payload: { revision: 2 },
      },
    }],
  );
  target.disconnect("controller-a", "controller-a");
  const restored = new LocklessClientAuthority(target.exportState());
  assert.equal(
    restored.resolveOperationReceipts("controller-a", ["mutation-a"])[0]
      ?.outcome,
    "resolved_success",
  );
  assert.equal(
    restored.acknowledgeOperationReceipt("controller-a", "mutation-a"),
    true,
  );
  assert.equal(
    restored.resolveOperationReceipts("controller-a", ["mutation-a"])[0]
      ?.outcome,
    "resolved_success",
  );
  assert.equal(
    restored.acknowledgeOperationReceipt("controller-a", "mutation-a", true),
    true,
  );
  assert.deepEqual(
    restored.resolveOperationReceipts("controller-a", ["mutation-a"]),
    [{ outcome: "not_committed", requestId: "mutation-a" }],
  );
  assert.equal(
    restored.acknowledgeOperationReceipt("controller-a", "mutation-a", true),
    true,
  );
});

test("receipt resolution distinguishes failure, no commit, pending, and reclaimed", () => {
  const target = authority();
  admit(target, "controller-a");
  target.beginOperationReceipt("controller-a", "failed", "pane.close");
  target.completeOperationReceipt(
    "controller-a",
    "failed",
    "pane.close",
    "resolved_failure",
    { error: { code: "stale_topology" }, id: "failed", ok: false },
    { commitSequence: 8, requestId: "failed" },
  );
  target.beginOperationReceipt("controller-a", "pending", "content.set");
  assert.deepEqual(
    target.resolveOperationReceipts("controller-a", [
      "failed",
      "missing",
      "pending",
    ]).map((resolution) => resolution.outcome),
    ["resolved_failure", "not_committed", "still_pending"],
  );
  assert.deepEqual(
    target.resolveOperationReceipts("controller-a", ["pending"], true),
    [{
      cause: "controller_reclaimed",
      outcome: "receipt_unavailable",
      requestId: "pending",
    }],
  );
});

test("receipt capacity refuses a new reservation without evicting stored receipts", () => {
  const target = authority();
  admit(target, "controller-a");
  for (const [index, requestId] of ["one", "two"].entries()) {
    target.beginOperationReceipt("controller-a", requestId, "content.set");
    target.completeOperationReceipt(
      "controller-a",
      requestId,
      "content.set",
      "resolved_success",
      { id: requestId, ok: true },
      { commitSequence: index + 1, requestId },
    );
  }
  assert.throws(
    () => target.beginOperationReceipt("controller-a", "three", "content.set"),
    (error) =>
      error instanceof LocklessAuthorityError &&
      error.code === "receipt_capacity",
  );
  assert.deepEqual(
    target.resolveOperationReceipts("controller-a", ["one", "two"])
      .map((resolution) => resolution.outcome),
    ["resolved_success", "resolved_success"],
  );
});

test("target apply work survives restart and terminalizes as correlated append-only surface truth", () => {
  const roomyLimits: LocklessCapacityLimits = {
    ...limits,
    maxConsumableRecordBytes: 2_000,
    maxSurfaceConsumableBytes: 4_000,
    maxSurfaceRecoverableBaseBytes: 4_000,
  };
  roomyLimits.maxRecoverableSurfaceBytes =
    locklessRecoverableSurfaceMinimumBytes(roomyLimits);
  roomyLimits.maxRetainedTombstoneBytes = Math.max(
    roomyLimits.maxRetainedTombstoneBytes,
    roomyLimits.maxRecoverableSurfaceBytes,
  );
  const target = new LocklessClientAuthority(
    createEmptyLocklessClientState(roomyLimits),
  );
  target.admit(
    {
      controllerInstanceId: "controller-a",
      projectionCapacityBytes: 10_000,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
    },
    "controller-a",
    "admit-controller-a",
  );
  const admitted = target.admitTargetApplyWorkItem({
    controllerInstanceId: "controller-a",
    currentSurfaceBase: { panes: [{ paneId: 1 }] },
    intentCommitSequence: 11,
    operationRequestId: "operation-a",
    request: {
      paneId: 1,
      requestId: "materialization-a",
      restoreReason: "initial",
      surfaceId: "surface-a",
      targetEpoch: 3,
      targetHeader: {},
      targetId: "target-a",
      targetKind: "browser_url",
      targetPayload: { url: "https://example.com" },
    },
  });
  assert.equal(admitted.state, "intent_committed");
  assert.equal(
    admitted.bytes,
    exactDurableBytes({ version: 1, ...admitted }),
  );

  const restored = new LocklessClientAuthority(target.exportState());
  assert.equal(restored.targetApplyWorkItems()[0]?.state, "intent_committed");
  restored.markTargetApplyMaterializing("controller-a", "operation-a");
  assert.equal(
    restored.markTargetApplyMaterializing("controller-a", "operation-a"),
    null,
  );
  const materializingState = restored.exportState();
  const afterMaterializationCrash = new LocklessClientAuthority(
    materializingState,
  );
  assert.equal(
    afterMaterializationCrash.targetApplyWorkItems()[0]?.state,
    "materializing",
  );
  const events: Array<Record<string, unknown>> = [];
  afterMaterializationCrash.subscribe((event) =>
    events.push(event as unknown as Record<string, unknown>),
  );
  const completed = afterMaterializationCrash.completeTargetApplyWorkItem(
    "controller-a",
    "operation-a",
    { errorCode: "materialization_outcome_unknown", status: "failed" },
  );
  assert.equal(completed?.record.recordClass, "target_result");
  assert.deepEqual(completed?.result, {
    errorCode: "materialization_outcome_unknown",
    intentCommitSequence: 11,
    operationRequestId: "operation-a",
    status: "failed",
    surfaceId: "surface-a",
    targetEpoch: 3,
    targetId: "target-a",
    targetRequestId: "materialization-a",
  });
  assert.deepEqual(afterMaterializationCrash.targetApplyWorkItems(), []);
  assert.equal(
    afterMaterializationCrash.scopeSnapshot(
      "controller-a",
      "surface:surface-a",
    ).records[0]?.recordClass,
    "target_result",
  );
  const resultEvent = events.find(
    (event) => event.type === "event.target_apply_result",
  );
  assert.equal(resultEvent?.scopeId, "surface:surface-a");
  assert.deepEqual(resultEvent?.result, completed?.result);
});

test("target apply surface capacity refusal leaves no durable work item", () => {
  const constrained = new LocklessClientAuthority(
    createEmptyLocklessClientState({
      ...limits,
      maxSurfaceRecoverableBaseBytes: 64,
    }),
  );
  admit(constrained, "controller-a");
  assert.throws(
    () =>
      constrained.admitTargetApplyWorkItem({
        controllerInstanceId: "controller-a",
        currentSurfaceBase: {},
        intentCommitSequence: 1,
        operationRequestId: "operation-too-large",
        request: {
          requestId: "materialization-too-large",
          restoreReason: "initial",
          surfaceId: "surface-a",
          targetEpoch: 1,
          targetHeader: {},
          targetId: "target-a",
          targetKind: "native_app",
          targetPayload: {},
        },
      }),
    (error) =>
      error instanceof LocklessAuthorityError &&
      error.code === "surface_state_capacity",
  );
  assert.deepEqual(constrained.targetApplyWorkItems(), []);
});

test("bounded consumables preserve independent cursors and sticky structured gaps", () => {
  const target = authority();
  admit(target, "controller-a");
  admit(target, "controller-b");
  target.ensureScope("pane:1", "pane");
  for (let index = 0; index < 3; index += 1) {
    target.appendConsumable({
      payload: { value: index },
      recordClass: "tap",
      scopeId: "pane:1",
      scopeKind: "pane",
      triggerOperation: "tap",
    });
  }
  const first = target.scopeSnapshot("controller-a", "pane:1");
  const second = target.scopeSnapshot("controller-b", "pane:1");
  assert.equal(first.records.length, 2);
  assert.equal(first.cursor.gap?.cause, "scope_capacity");
  assert.deepEqual(first.cursor.gap, second.cursor.gap);
  target.acknowledge("controller-a", {
    cursor: first.lastRetainedSequence + 1,
    gapGeneration: first.cursor.gapGeneration,
    scopeId: "pane:1",
  });
  assert.equal(target.scopeSnapshot("controller-a", "pane:1").cursor.gap, null);
  assert.notEqual(
    target.scopeSnapshot("controller-b", "pane:1").cursor.gap,
    null,
  );
});

test("scope snapshots use first-unread cursors and include current live frames", () => {
  const target = authority();
  admit(target, "controller-a");
  target.ensureScope("pane:1", "pane");
  const first = target.appendConsumable({
    payload: { kind: "tap" },
    recordClass: "tap",
    scopeId: "pane:1",
    scopeKind: "pane",
    triggerOperation: "tap",
  })!;
  const live = target.updateLiveFrame({
    frameId: "frame-a",
    payload: { strokes: ["one"] },
    scopeId: "pane:1",
    triggerOperation: "drawing",
  })!;
  let snapshot = target.scopeSnapshot("controller-a", "pane:1");
  assert.equal(snapshot.cursor.cursor, first.sequence);
  assert.deepEqual(
    snapshot.records.map((record) => record.sequence),
    [first.sequence, live.sequence],
  );
  target.acknowledge("controller-a", {
    cursor: first.sequence + 1,
    scopeId: "pane:1",
  });
  snapshot = target.scopeSnapshot("controller-a", "pane:1");
  assert.equal(snapshot.cursor.cursor, live.sequence);
  assert.deepEqual(
    snapshot.records.map((record) => record.sequence),
    [live.sequence],
  );
});

test("legacy migration imports gaps transactionally and rolls back oversize material", () => {
  const target = authority();
  admit(target, "controller-a");
  target.transaction(() =>
    target.importLegacyMigrationMaterial("controller-a", {
      gaps: [
        {
          gap: {
            cause: "legacy_overflow",
            droppedBytes: 12,
            droppedEventCount: 1,
            droppedFrameCount: 0,
            droppedRecordCount: 1,
            firstLostSequence: 1,
            lastLostSequence: 1,
            lossExtent: "exact",
            recordClasses: ["tap"],
          },
          scopeId: "pane:surface-a:1",
        },
      ],
      scopes: [
        {
          records: [
            { payload: { value: "retained" }, recordClass: "tap" },
          ],
          scopeId: "pane:surface-a:1",
          scopeKind: "pane",
        },
      ],
    }),
  );
  assert.equal(
    target.scopeSnapshot("controller-a", "pane:surface-a:1").cursor.gap
      ?.cause,
    "legacy_overflow",
  );
  const before = target.exportState();
  assert.throws(() =>
    target.transaction(() =>
      target.importLegacyMigrationMaterial("controller-a", {
        scopes: [
          {
            records: [
              {
                payload: { value: "x".repeat(1_000) },
                recordClass: "tap",
              },
            ],
            scopeId: "pane:surface-a:2",
            scopeKind: "pane",
          },
        ],
      }),
    ),
  );
  assert.deepEqual(target.exportState(), before);
});

test("latest-wins records coalesce and tombstones reclaim oldest sequence", () => {
  const target = authority();
  const events: Array<Record<string, unknown>> = [];
  target.subscribe((event) =>
    events.push(event as unknown as Record<string, unknown>),
  );
  admit(target, "controller-a");
  target.appendConsumable({
    payload: { y: 1 },
    recordClass: "scroll",
    scopeId: "pane:1",
    scopeKind: "pane",
    triggerOperation: "scroll",
  });
  target.appendConsumable({
    payload: { y: 2 },
    recordClass: "scroll",
    scopeId: "pane:1",
    scopeKind: "pane",
    triggerOperation: "scroll",
  });
  const snapshot = target.scopeSnapshot("controller-a", "pane:1");
  assert.equal(snapshot.records.length, 1);
  assert.deepEqual(snapshot.records[0]?.payload, { y: 2 });

  const first = target.createTombstone({
    kind: "pane",
    payload: { paneId: 1 },
    surfaceId: "surface-a",
  });
  const second = target.createTombstone({
    kind: "pane",
    payload: { paneId: 2 },
    surfaceId: "surface-a",
  });
  target.createTombstone({
    kind: "pane",
    payload: { paneId: 3 },
    surfaceId: "surface-a",
  });
  assert.deepEqual(
    target.listTombstones().map((entry) => entry.tombstoneId),
    [second.tombstoneId, target.listTombstones()[1]?.tombstoneId],
  );
  assert.equal(
    target.listTombstones().some((entry) => entry.tombstoneId === first.tombstoneId),
    false,
  );
  const reclaimed = events.find(
    (event) =>
      event.type === "event.tombstone_reclaimed" &&
      event.tombstoneId === first.tombstoneId,
  );
  assert.equal(reclaimed?.reason, "count_capacity");
  const reclamationAudit = events.find(
    (event) =>
      event.type === "diagnostic.lockless_audit" &&
      event.record.operation === "tombstone.reclaimed" &&
      event.record.resultCorrelation?.tombstoneId === first.tombstoneId,
  );
  assert.equal(
    reclaimed?.type === "event.tombstone_reclaimed"
      ? reclaimed.commitSequence
      : null,
    reclamationAudit?.type === "diagnostic.lockless_audit"
      ? reclamationAudit.record.commitSequence
      : null,
  );
});

test("surface tombstone reclamation audits nested pane and unread disposition", () => {
  const target = authority();
  const events: Array<Record<string, unknown>> = [];
  target.subscribe((event) =>
    events.push(event as unknown as Record<string, unknown>),
  );
  admit(target, "controller-a");
  target.updateLiveFrame({
    frameId: "frame-nested",
    payload: { strokes: ["nested-unread"] },
    scopeId: "pane:surface-a:1",
    triggerOperation: "drawing",
  });
  target.createTombstone({
    kind: "pane",
    payload: { pane: { paneId: 1 } },
    surfaceId: "surface-a",
  });
  const nestedPaneTombstones =
    target.takePaneTombstonesForSurface("surface-a");
  target.appendConsumable({
    payload: { value: "live-unread" },
    recordClass: "tap",
    scopeId: "pane:surface-a:2",
    scopeKind: "pane",
    triggerOperation: "tap",
  });
  const surfaceTombstone = target.createTombstone({
    kind: "surface",
    payload: {
      paneTombstones: nestedPaneTombstones,
      surface: {
        panes: [{ paneId: 2 }, { paneId: 3 }],
      },
    },
    surfaceId: "surface-a",
  });
  const discardedRecords = [
    ...Object.values(surfaceTombstone.scopes).flatMap((scope) => [
      ...scope.records,
      ...Object.values(scope.liveFrames),
    ]),
    ...nestedPaneTombstones.flatMap((tombstone) =>
      Object.values(tombstone.scopes).flatMap((scope) => [
        ...scope.records,
        ...Object.values(scope.liveFrames),
      ])
    ),
  ];
  target.createTombstone({
    kind: "pane",
    payload: { pane: { paneId: 4 } },
    surfaceId: "surface-b",
  });
  target.createTombstone({
    kind: "pane",
    payload: { pane: { paneId: 5 } },
    surfaceId: "surface-c",
  });

  const audit = events.find(
    (event) =>
      event.type === "diagnostic.lockless_audit" &&
      (event.record as {
        operation?: string;
        resultCorrelation?: Record<string, unknown>;
      }).operation === "tombstone.reclaimed" &&
      (event.record as {
        resultCorrelation?: Record<string, unknown>;
      }).resultCorrelation?.tombstoneId === surfaceTombstone.tombstoneId,
  ) as {
    record: {
      commitSequence: number;
      resultCorrelation: Record<string, unknown>;
    };
  };
  const reclaimed = events.find(
    (event) =>
      event.type === "event.tombstone_reclaimed" &&
      event.tombstoneId === surfaceTombstone.tombstoneId,
  );
  assert.equal(audit.record.resultCorrelation.nestedLivePaneCount, 2);
  assert.equal(audit.record.resultCorrelation.nestedPaneTombstoneCount, 1);
  assert.equal(audit.record.resultCorrelation.unreadFrameCount, 1);
  assert.equal(
    audit.record.resultCorrelation.unreadBytesDiscarded,
    discardedRecords.reduce((total, record) => total + record.bytes, 0),
  );
  assert.equal(reclaimed?.commitSequence, audit.record.commitSequence);
});

test("pane tombstones contain and restore authoritative cursor scope state", () => {
  const target = authority();
  admit(target, "controller-a");
  const scopeId = "pane:surface-a:1";
  target.appendConsumable({
    payload: { value: "unread" },
    recordClass: "tap",
    scopeId,
    scopeKind: "pane",
    triggerOperation: "tap",
  });
  const before = target.scopeSnapshot("controller-a", scopeId);
  const tombstone = target.createTombstone({
    kind: "pane",
    payload: { pane: { paneId: 1 } },
    surfaceId: "surface-a",
  });
  assert.equal(target.exportState().scopes[scopeId], undefined);
  assert.deepEqual(
    tombstone.scopes[scopeId]?.cursors["controller-a"],
    before.cursor,
  );
  target.restoreTombstone(tombstone.tombstoneId, "pane");
  assert.deepEqual(
    target.scopeSnapshot("controller-a", scopeId),
    before,
  );
});

test("dormant reclamation charges and reports live-frame-only unread state", () => {
  const target = authority();
  const events: Array<Record<string, unknown>> = [];
  target.subscribe((event) => events.push(event as unknown as Record<string, unknown>));
  admit(target, "controller-a");
  target.updateLiveFrame({
    frameId: "frame-a",
    payload: { strokes: ["unread"] },
    scopeId: "pane:surface-a:1",
    triggerOperation: "drawing",
  });
  const retained = target.createTombstone({
    kind: "pane",
    payload: { pane: { paneId: 1 } },
    surfaceId: "surface-a",
  });
  target.appendConsumable({
    payload: { value: "other-surface-unread" },
    recordClass: "tap",
    scopeId: "pane:surface-b:1",
    scopeKind: "pane",
    triggerOperation: "tap",
  });
  target.disconnect("controller-a", "controller-a");
  admit(target, "controller-b");
  target.disconnect("controller-b", "controller-b");
  const reclaimed = events.find(
    (event) =>
      event.type === "event.controller_retention_reclaimed" &&
      event.controllerInstanceId === "controller-a",
  ) as {
    commitSequence: number;
    surfaceCount?: number;
    tombstoneCount?: number;
    unreadBytes?: number;
    unreadFrameCount?: number;
    unreadRecordCount?: number;
  };
  assert.equal(reclaimed.unreadRecordCount, 2);
  assert.equal((reclaimed.unreadBytes ?? 0) > 0, true);
  assert.equal(reclaimed.unreadFrameCount, 1);
  assert.equal(reclaimed.surfaceCount, 2);
  assert.equal(reclaimed.tombstoneCount, 1);
  const reclamationAudit = events.find(
    (event) =>
      event.type === "diagnostic.lockless_audit" &&
      event.record.operation === "controller.retention.reclaimed" &&
      event.record.controllerInstanceId === "controller-a",
  );
  assert.equal(
    reclaimed.commitSequence,
    reclamationAudit?.type === "diagnostic.lockless_audit"
      ? reclamationAudit.record.commitSequence
      : null,
  );
  assert.deepEqual(
    target.listTombstones("pane")
      .find((entry) => entry.tombstoneId === retained.tombstoneId)
      ?.scopes["pane:surface-a:1"]?.liveFrames,
    {},
  );
});

test("persistent export restores authoritative limits and scopes without retaining diagnostics", () => {
  const target = authority();
  admit(target, "controller-a");
  target.setSurfaceMode("surface-a", "lockless");
  target.ensureScope("surface:surface-a", "surface");
  const persisted: PersistentLocklessClientState = target.exportState();
  const restored = new LocklessClientAuthority(persisted);
  assert.equal(restored.surfaceMode("surface-a"), "lockless");
  assert.deepEqual(restored.limits, limits);
  assert.equal(
    restored.scopeSnapshot("controller-a", "surface:surface-a").version,
    1,
  );
  assert.equal("audit" in restored.exportState(), false);
});

test("authority FIFO isolates persisted work, ordinary mutations, failure rollback, and restart", async () => {
  const target = authority();
  admit(target, "controller-a");
  let releaseFirst = (): void => {};
  let firstPersistStarted = (): void => {};
  const firstStarted = new Promise<void>((resolve) => {
    firstPersistStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];
  const first = target.transactionPersisted(
    () => {
      order.push("first-mutation");
      target.setSurfaceMode("surface-a", "lockless");
    },
    async () => {
      order.push("first-persist-start");
      firstPersistStarted();
      await firstGate;
      order.push("first-persist-end");
    },
  );
  await firstStarted;
  const ordinary = target.transactionAsync(async () => {
    order.push("ordinary-mutation");
    target.appendConsumable({
      payload: { value: "queued" },
      recordClass: "tap",
      scopeId: "surface:surface-b",
      scopeKind: "surface",
      triggerOperation: "test.ordinary",
    });
  });
  const second = target.transactionPersisted(
    () => {
      order.push("second-mutation");
      target.setSurfaceMode("surface-b", "lockless");
    },
    async () => {
      order.push("second-persist");
    },
  );
  await Promise.resolve();
  assert.deepEqual(order, ["first-mutation", "first-persist-start"]);
  releaseFirst();
  await Promise.all([first, ordinary, second]);
  assert.deepEqual(order, [
    "first-mutation",
    "first-persist-start",
    "first-persist-end",
    "ordinary-mutation",
    "second-mutation",
    "second-persist",
  ]);

  await assert.rejects(
    target.transactionPersisted(
      () => target.setSurfaceMode("surface-failed", "lockless"),
      async () => {
        throw new Error("persist failed");
      },
    ),
    /persist failed/,
  );
  await target.transactionPersisted(
    () => target.setSurfaceMode("surface-after-failure", "lockless"),
    async () => {},
  );
  assert.equal(target.surfaceMode("surface-failed"), null);
  assert.equal(target.surfaceMode("surface-after-failure"), "lockless");
  const restored = new LocklessClientAuthority(target.exportState());
  assert.equal(restored.surfaceMode("surface-a"), "lockless");
  assert.equal(restored.surfaceMode("surface-b"), "lockless");
  assert.equal(restored.scopeSnapshot("controller-a", "surface:surface-b").records.length, 1);
});
