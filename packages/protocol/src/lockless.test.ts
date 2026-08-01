import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  SURF_ACE_LOCKLESS_V1_CAPABILITY,
  type LocklessCapacityLimits,
  validateLocklessEnvelope,
} from "./lockless.js";
import { protocolSchemaDefs } from "./schemas.js";

const limits: LocklessCapacityLimits = {
  version: 1,
  maxPanesPerSurface: 1,
  maxSurfaceRecoverableBaseBytes: 1,
  maxPaneRecoverableStateBytes: 1,
  maxPaneAnnotationRestoreBytes: 1,
  maxRetainedTombstones: 1,
  maxRetainedTombstoneBytes: 9,
  maxRecoverableSurfaceBytes: 9,
  maxPaneConsumableRecords: 1,
  maxPaneConsumableBytes: 1,
  maxSurfaceConsumableRecords: 1,
  maxSurfaceConsumableBytes: 1,
  maxConsumableRecordBytes: 1,
  maxConsumableCursorStateBytesPerScope: 1,
  maxAdmittedControllerEntries: 1,
  maxDormantControllerEntries: 1,
  maxDormantControllerBytes: 1,
  maxPendingOperationReceiptsPerController: 1,
  maxPendingOperationReceiptBytesPerController: 1,
};

function request(op: string, payload: Record<string, unknown>) {
  return {
    id: `rq-${op}`,
    op,
    payload,
    sentAt: 1,
    type: "request",
    v: 1,
  };
}

test("production validator accepts every serialized Rust CLI network variant", () => {
  const vector = JSON.parse(
    fs.readFileSync(
      new URL("../../cli/vectors/network-request-conformance.json", import.meta.url),
      "utf8",
    ),
  ) as { requests: unknown[] };
  assert.equal(vector.requests.length, 15);
  for (const envelope of vector.requests) {
    assert.deepEqual(validateLocklessEnvelope(envelope), { ok: true });
  }
});

test("production validation matches the shared Rust CLI boundary vector", () => {
  const vector = JSON.parse(
    fs.readFileSync(
      new URL("../../cli/vectors/network-validation-conformance.json", import.meta.url),
      "utf8",
    ),
  ) as {
    cases: Array<{
      accepted: boolean;
      id: string;
      input: Record<string, unknown>;
      operation: string;
    }>;
  };
  assert.equal(vector.cases.length, 74);
  for (const entry of vector.cases) {
    const { action: _action, ...payload } = entry.input;
    const envelope = request(entry.operation, payload);
    assert.equal(
      validateLocklessEnvelope(envelope).ok,
      entry.accepted,
      entry.id,
    );
  }
});

test("lockless schema exports request, response, and event branches", () => {
  assert.equal(protocolSchemaDefs.LocklessRequest?.type, "object");
  assert.equal(protocolSchemaDefs.LocklessResponse?.type, "object");
  assert.equal(protocolSchemaDefs.LocklessEvent?.type, "object");
  assert.deepEqual(
    protocolSchemaDefs.LocklessRequest?.properties.op.enum,
    protocolSchemaDefs.LocklessResponse?.properties.op.enum,
  );
  assert.deepEqual(
    protocolSchemaDefs.LocklessEvent?.properties.op.enum,
    [
      "event.lockless_content_committed",
      "event.lockless_scope_snapshot",
      "event.lockless_consumable_delta",
      "event.consumable_available",
      "event.consumable_overflow",
      "event.controller_retention_reclaimed",
      "event.tombstone_reclaimed",
      "event.target_apply_result",
    ],
  );
});

test("target apply result event requires exact durable correlation", () => {
  const valid = {
    eventId: "ev-target-result",
    op: "event.target_apply_result",
    payload: {
      consumableSequence: 9,
      intentCommitSequence: 7,
      materializedState: { url: "https://example.com" },
      operationRequestId: "rq-target-apply",
      recordId: "record-target-result",
      status: "applied",
      surfaceId: "surface-a",
      targetEpoch: 2,
      targetId: "target-a",
      targetRequestId: "materialize-a",
    },
    sentAt: 1,
    type: "event",
    v: 1,
  };
  assert.deepEqual(validateLocklessEnvelope(valid), { ok: true });
  const { intentCommitSequence: _missing, ...incomplete } = valid.payload;
  assert.deepEqual(
    validateLocklessEnvelope({ ...valid, payload: incomplete }),
    { ok: false, reason: "invalid_lockless_event" },
  );
  assert.deepEqual(
    validateLocklessEnvelope({
      ...valid,
      payload: { ...valid.payload, unexpected: true },
    }),
    { ok: false, reason: "invalid_lockless_event" },
  );
});

test("target apply response proves only the exact committed intent", () => {
  const response = {
    id: "rq-target-apply",
    ok: true,
    op: "target.apply",
    payload: {
      operationReceipt: {
        commitSequence: 7,
        requestId: "rq-target-apply",
      },
      operationRequestId: "rq-target-apply",
      status: "intent_committed",
      surfaceId: "surface-a",
      targetEpoch: 2,
      targetId: "target-a",
      targetRequestId: "materialization-a",
    },
    sentAt: 1,
    type: "response",
    v: 1,
  };
  assert.deepEqual(validateLocklessEnvelope(response), { ok: true });
  assert.deepEqual(
    validateLocklessEnvelope({
      ...response,
      payload: { ...response.payload, status: "applied" },
    }),
    { ok: false, reason: "invalid_target_apply_response" },
  );
  assert.deepEqual(
    validateLocklessEnvelope({
      ...response,
      payload: {
        ...response.payload,
        operationReceipt: {
          ...response.payload.operationReceipt,
          requestId: "wrong-request",
        },
      },
    }),
    { ok: false, reason: "invalid_target_apply_response" },
  );
});

test("topology.apply response validation requires restorable destruction material", () => {
  const response = {
    id: "rq-topology",
    ok: true,
    op: "topology.apply",
    payload: {
      createdPaneIds: [3],
      destroyedPaneIds: [2],
      destroyedPaneTombstones: [{
        closedSequence: 7,
        paneId: 2,
        tombstoneId: "pt_2",
      }],
      panes: [
        { paneId: 1, paneLabel: 1 },
        { paneId: 3, paneLabel: 3 },
      ],
      preservedPaneIds: [1],
      topology: {
        children: [
          { paneId: 1, type: "pane" },
          { paneId: 3, type: "pane" },
        ],
        direction: "horizontal",
        type: "split",
      },
      topologyRevision: 4,
    },
    sentAt: 1,
    type: "response",
    v: 1,
  };
  assert.deepEqual(validateLocklessEnvelope(response), { ok: true });
  const { destroyedPaneTombstones: _omitted, ...incompletePayload } =
    response.payload;
  assert.deepEqual(validateLocklessEnvelope({
    ...response,
    payload: incompletePayload,
  }), {
    ok: false,
    reason: "invalid_topology_realize_response",
  });
});

test("lockless validator accepts every converted and new request shape", () => {
  const cases = [
    request("pair.request", {
      controllerInstanceId: "controller-a",
      projectionCapacityBytes: 10,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
      protocolVersion: 1,
    }),
    request("surfaces.list", {}),
    request("panes.list", { surfaceId: "surface-a" }),
    request("consumable.ack", { cursor: 2, scopeId: "pane:surface-a:1" }),
    request("consumable.sync", { scopeIds: ["pane:surface-a:1"] }),
    request("operation.receipt.sync", { requestIds: ["mutation-a"] }),
    request("operation.receipt.ack", { requestId: "mutation-a" }),
    request("operation.receipt.ack", { release: true, requestId: "mutation-a" }),
    request("content.set", {
      content: { markdown: "hello" },
      contentId: "content-a",
      contentType: "markdown",
      paneId: 1,
      surfaceId: "surface-a",
    }),
    request("content.append", {
      contentId: "content-a",
      expectedRevision: 1,
      lines: ["next"],
      paneId: 1,
      surfaceId: "surface-a",
    }),
    request("content.patch", {
      contentId: "content-a",
      expectedRevision: 1,
      paneId: 1,
      patch: { action: "remove", selector: "p" },
      surfaceId: "surface-a",
    }),
    request("content.clear", {
      expectedRevision: 1,
      paneId: 1,
      surfaceId: "surface-a",
    }),
    request("pane.split", {
      count: 2,
      direction: "horizontal",
      expectedTopologyRevision: 0,
      paneId: 1,
      surfaceId: "surface-a",
    }),
    request("pane.close", {
      expectedTopologyRevision: 1,
      paneId: 2,
      surfaceId: "surface-a",
    }),
    request("pane.rename", {
      expectedTopologyRevision: 1,
      name: "Notes",
      paneId: 1,
      surfaceId: "surface-a",
    }),
    request("pane.restore", {
      anchorPaneId: 1,
      direction: "vertical",
      expectedTopologyRevision: 2,
      surfaceId: "surface-a",
      tombstoneId: "pt-a",
    }),
    request("surface.window.open", { expectedSurfaceSetRevision: 0 }),
    request("surface.window.close", {
      expectedSurfaceSetRevision: 1,
      expectedTopologyRevision: 0,
      surfaceId: "surface-a",
    }),
    request("surface.window.restore", {
      expectedSurfaceSetRevision: 2,
      tombstoneId: "st-a",
    }),
    request("topology.apply", {
      allowDestroyPaneIds: [],
      desired: { type: "pane" },
      expectedTopologyRevision: 2,
      surfaceId: "surface-a",
      target: { root: true },
    }),
    request("target.apply", {
      requestId: "target-a",
      restoreReason: "initial",
      surfaceId: "surface-a",
      targetEpoch: 1,
      targetHeader: {},
      targetId: "target-a",
      targetKind: "native_app",
      targetPayload: { appId: "example" },
    }),
    request("target.register", {
      expectedPreviousTargetEpoch: null,
      idempotencyKey: "register-a",
      launchedAt: "2026-07-30T00:00:00Z",
      paneId: 1,
      registrationState: "attached",
      surfaceId: "surface-a",
      targetHeader: {},
      targetKind: "native_app",
      targetPayload: { appId: "example" },
    }),
    request("annotations.remove", {
      contentId: "content-a",
      paneId: 1,
      strokeIds: ["stroke-a"],
      surfaceId: "surface-a",
    }),
    request("snapshot.get", {
      includeDrawings: true,
      paneId: 1,
      surfaceId: "surface-a",
    }),
    request("heartbeat.ping", { nonce: "alive" }),
  ];
  for (const envelope of cases) {
    assert.deepEqual(
      validateLocklessEnvelope(envelope),
      { ok: true },
      envelope.op,
    );
  }
});

test("lockless pair and discovery require exact capability and finite limits", () => {
  const discovery = {
    id: "rq-list",
    ok: true,
    op: "surfaces.list",
    payload: {
      capabilities: {
        limits,
        protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
      },
      surfaces: [],
    },
    sentAt: 1,
    type: "response",
    v: 1,
  };
  assert.deepEqual(validateLocklessEnvelope(discovery), { ok: true });
  assert.equal(
    validateLocklessEnvelope({
      ...discovery,
      payload: {
        ...discovery.payload,
        capabilities: {
          ...discovery.payload.capabilities,
          limits: { ...limits, maxPanesPerSurface: 0 },
        },
      },
    }).ok,
    false,
  );

  const pair = {
    id: "rq-pair",
    ok: true,
    op: "pair.request",
    payload: {
      capabilities: {
        protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
      },
      controllerInstanceId: "controller-a",
      limits,
      mode: "lockless",
      receiptResolutions: [],
      resumed: false,
      scopes: [],
      sessionId: "lockless_controller-a",
      state: null,
      surfaceId: null,
      surfaceSetRevision: 0,
    },
    sentAt: 1,
    type: "response",
    v: 1,
  };
  assert.deepEqual(validateLocklessEnvelope(pair), { ok: true });
  assert.equal(
    validateLocklessEnvelope({
      ...pair,
      payload: {
        ...pair.payload,
        capabilities: {
          protocolFeatures: [
            SURF_ACE_LOCKLESS_V1_CAPABILITY,
            "authority.state.v1",
          ],
        },
      },
    }).ok,
    false,
  );
});

test("receipt sync and ack responses validate all public outcomes", () => {
  const sync = {
    id: "rq-receipt-sync",
    ok: true,
    op: "operation.receipt.sync",
    payload: {
      resolutions: [
        {
          operationReceipt: { commitSequence: 4, requestId: "success" },
          outcome: "resolved_success",
          requestId: "success",
          terminalResponse: { id: "success", ok: true },
        },
        {
          operationReceipt: { commitSequence: 5, requestId: "failure" },
          outcome: "resolved_failure",
          requestId: "failure",
          terminalResponse: { id: "failure", ok: false },
        },
        { outcome: "not_committed", requestId: "missing" },
        { outcome: "still_pending", requestId: "pending" },
        {
          cause: "controller_reclaimed",
          outcome: "receipt_unavailable",
          requestId: "reclaimed",
        },
      ],
    },
    sentAt: 1,
    type: "response",
    v: 1,
  };
  assert.deepEqual(validateLocklessEnvelope(sync), { ok: true });
  assert.deepEqual(
    validateLocklessEnvelope({
      ...sync,
      payload: {
        resolutions: [{ outcome: "receipt_unavailable", requestId: "bad" }],
      },
    }),
    { ok: false, reason: "invalid_operation_receipt_sync_response" },
  );
  assert.deepEqual(validateLocklessEnvelope({
    id: "rq-receipt-ack",
    ok: true,
    op: "operation.receipt.ack",
    payload: { accepted: true, requestId: "success" },
    sentAt: 1,
    type: "response",
    v: 1,
  }), { ok: true });
});

test("lockless content.set enforces canonical typed content values", () => {
  const contentCases = [
    ["html", { html: "<p>hello</p>", baseUrl: "https://example.com" }],
    ["image", { alt: "proof", data: "AA==", mediaType: "image/png" }],
    ["pdf", { data: "AA==" }],
    ["terminal", { lines: ["hello"], scrollback: 0 }],
    ["markdown", { markdown: "hello" }],
    ["video", "https://example.com/proof.mp4"],
    ["canvas", ""],
    ["canvas", { color: "#fff", grid: true }],
  ] as const;
  for (const [contentType, content] of contentCases) {
    assert.deepEqual(
      validateLocklessEnvelope(request("content.set", {
        content,
        contentId: `content-${contentType}`,
        contentType,
        paneId: 1,
        surfaceId: "surface-a",
      })),
      { ok: true },
      contentType,
    );
  }

  for (const [contentType, content] of [
    ["text", "hello"],
    ["markdown", "hello"],
    ["markdown", { html: "hello" }],
    ["terminal", { lines: ["hello"], scrollback: -1 }],
    ["canvas", { color: "#fff", unexpected: true }],
  ] as const) {
    assert.deepEqual(
      validateLocklessEnvelope(request("content.set", {
        content,
        contentId: "content-invalid",
        contentType,
        paneId: 1,
        surfaceId: "surface-a",
      })),
      { ok: false, reason: "invalid_content_set" },
      contentType,
    );
  }
  assert.deepEqual(
    validateLocklessEnvelope(request("content.set", {
      content: { markdown: "hello" },
      contentId: "content-invalid-friendly-name",
      contentType: "markdown",
      friendlyChatName: 7,
      paneId: 1,
      surfaceId: "surface-a",
    })),
    { ok: false, reason: "invalid_content_set" },
  );
});

test("lockless request rejects legacy authority and allocation fields", () => {
  for (const [op, field] of [
    ["pair.request", "providerId"],
    ["content.set", "revision"],
    ["content.set", "historyOwnerToken"],
    ["pane.split", "newPaneIds"],
    ["pane.split", "newPaneLabels"],
  ] as const) {
    const base =
      op === "pair.request"
        ? {
            controllerInstanceId: "controller-a",
            projectionCapacityBytes: 10,
            protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
            protocolVersion: 1,
          }
        : op === "content.set"
          ? {
              content: { markdown: "hello" },
              contentId: "content-a",
              contentType: "markdown",
              paneId: 1,
              surfaceId: "surface-a",
            }
          : {
              count: 2,
              direction: "horizontal",
              expectedTopologyRevision: 0,
              paneId: 1,
              surfaceId: "surface-a",
            };
    const result = validateLocklessEnvelope(
      request(op, { ...base, [field]: "forbidden" }),
    );
    assert.equal(result.ok, false, `${op}:${field}`);
    if (!result.ok) {
      assert.equal(result.reason, `forbidden_legacy_field:${field}`);
    }
  }
});

test("lockless request rejects nested authority fields and invalid intent ranges", () => {
  assert.deepEqual(
    validateLocklessEnvelope(
      request("target.apply", {
        requestId: "target-a",
        restoreReason: "initial",
        surfaceId: "surface-a",
        targetEpoch: 1,
        targetHeader: {},
        targetId: "target-a",
        targetKind: "native_app",
        targetPayload: { ownershipEpoch: 7 },
      }),
    ),
    {
      ok: false,
      reason:
        "forbidden_legacy_field:payload.targetPayload.ownershipEpoch",
    },
  );
  assert.deepEqual(
    validateLocklessEnvelope(
      request("pane.split", {
        count: 1,
        direction: "diagonal",
        expectedTopologyRevision: -1,
        paneId: 0,
        surfaceId: "surface-a",
      }),
    ),
    { ok: false, reason: "invalid_pane_split" },
  );
});

test("migration material rejects ambiguous or injected nested authority", () => {
  const gap = {
    cause: "legacy_overflow",
    droppedBytes: null,
    droppedEventCount: null,
    droppedFrameCount: null,
    droppedRecordCount: null,
    firstLostSequence: null,
    lastLostSequence: null,
    lossExtent: "unknown",
    recordClasses: ["tap"],
  };
  const material = {
    gaps: [{ gap, scopeId: "pane:surface-a:1" }],
    scopes: [
      {
        liveFrames: [{ frameId: "frame-a", payload: {} }],
        records: [{ payload: {}, recordClass: "tap" }],
        scopeId: "pane:surface-a:1",
        scopeKind: "pane",
      },
    ],
  };
  const pair = (migrationMaterial: unknown) =>
    request("pair.request", {
      controllerInstanceId: "controller-a",
      migrationMaterial,
      projectionCapacityBytes: 10,
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
      protocolVersion: 1,
      surfaceId: "surface-a",
    });

  assert.deepEqual(validateLocklessEnvelope(pair(material)), { ok: true });
  for (const invalid of [
    { ...material, unexpected: true },
    { ...material, scopes: [...material.scopes, material.scopes[0]] },
    {
      ...material,
      gaps: [...material.gaps, material.gaps[0]],
    },
    {
      ...material,
      gaps: [{ gap, scopeId: "pane:surface-a:2" }],
    },
    {
      ...material,
      scopes: [
        {
          ...material.scopes[0],
          liveFrames: [
            material.scopes[0].liveFrames[0],
            material.scopes[0].liveFrames[0],
          ],
        },
      ],
    },
    {
      ...material,
      gaps: [
        {
          gap: { ...gap, recordClasses: [] },
          scopeId: "pane:surface-a:1",
        },
      ],
    },
    {
      ...material,
      scopes: [{ ...material.scopes[0], unexpected: true }],
    },
  ]) {
    assert.equal(validateLocklessEnvelope(pair(invalid)).ok, false);
  }
});

test("lockless events and stable error responses validate", () => {
  const record = {
    bytes: 1,
    payload: {},
    recordClass: "tap",
    recordId: "cr-a",
    sequence: 1,
  };
  const gap = {
    cause: "scope_capacity",
    droppedBytes: 1,
    droppedEventCount: 1,
    droppedFrameCount: 0,
    droppedRecordCount: 1,
    firstLostSequence: 1,
    generation: 1,
    lastLostSequence: 1,
    lossExtent: "exact",
    recordClasses: ["tap"],
  };
  const eventPayloads = {
    "event.lockless_content_committed": {
      contentId: "content-a",
      historyEntryId: "he-a",
      paneId: 1,
      revision: 1,
      surfaceId: "surface-a",
    },
    "event.lockless_scope_snapshot": {
      snapshot: {
        cursor: { cursor: 1, gap: null, gapGeneration: 0 },
        firstRetainedSequence: 1,
        lastRetainedSequence: 1,
        records: [record],
        scopeId: "pane:surface-a:1",
        version: 1,
      },
    },
    "event.lockless_consumable_delta": {
      firstRetainedSequence: 1,
      lastRetainedSequence: 1,
      records: [record],
      scopeId: "pane:surface-a:1",
    },
    "event.consumable_available": {
      scopeId: "pane:surface-a:1",
    },
    "event.consumable_overflow": {
      firstRetainedSequence: 2,
      gap,
      lastRetainedSequence: 1,
      scopeId: "pane:surface-a:1",
    },
  } as const;
  for (const [op, payload] of Object.entries(eventPayloads)) {
    assert.deepEqual(
      validateLocklessEnvelope({
        eventId: `ev-${op}`,
        op,
        payload,
        sentAt: 1,
        type: "event",
        v: 1,
      }),
      { ok: true },
    );
  }
  assert.deepEqual(
    validateLocklessEnvelope({
      error: {
        code: "stale_topology",
        details: { currentTopologyRevision: 4 },
        message: "Expected topology revision 4",
      },
      id: "rq-stale",
      ok: false,
      op: "pane.split",
      sentAt: 1,
      type: "response",
      v: 1,
    }),
    { ok: true },
  );
});
