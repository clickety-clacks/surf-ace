import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SURF_ACE_LOCKLESS_V1_CAPABILITY } from "../../protocol/src/lockless.js";
import {
  createEmptyLocklessClientState,
  DEFAULT_LOCKLESS_LIMITS,
  type PersistentLocklessClientState,
} from "../src/lockless-client-authority.js";
import {
  applyLegacyRollbackPreview,
  previewCommittedLegacyRollback,
  previewLegacyRollback,
  restoreCapturedPersistentGeneration,
} from "../src/legacy-rollback-migration.js";
import { loadPersistentStateFile, writePersistentStateFile } from "../src/persistent-state-file.js";
import type { PersistentSurfaceState } from "../src/surface-core.js";

const FILE_NAME = "surface-core-state.json";

function scope(scopeId: string) {
  return {
    cursors: {
      "controller-a": {
        cursor: 8,
        gap: {
          cause: "scope_capacity" as const,
          droppedBytes: 40,
          droppedEventCount: 1,
          droppedFrameCount: 0,
          droppedRecordCount: 1,
          firstLostSequence: 7,
          generation: 2,
          lastLostSequence: 7,
          lossExtent: "exact" as const,
          recordClasses: ["content" as const],
        },
        gapGeneration: 2,
      },
      "controller-b": { cursor: 7, gap: null, gapGeneration: 0 },
    },
    liveFrames: {
      "frame-1": {
        bytes: 30,
        payload: { strokes: ["unread"] },
        recordClass: "annotation_frame" as const,
        recordId: "frame-1",
        sequence: 10,
      },
    },
    nextSequence: 12,
    records: [
      { bytes: 20, payload: { revision: 2 }, recordClass: "content" as const, recordId: "record-9", sequence: 9 },
      { bytes: 24, payload: { paneIds: [11, 12] }, recordClass: "topology" as const, recordId: "record-11", sequence: 11 },
    ],
    scopeId,
    scopeKind: "pane" as const,
  };
}

function representativeState(): PersistentSurfaceState {
  const lockless: PersistentLocklessClientState = {
    ...createEmptyLocklessClientState(DEFAULT_LOCKLESS_LIMITS),
    capability: SURF_ACE_LOCKLESS_V1_CAPABILITY,
    controllers: {
      "controller-a": {
        controllerInstanceId: "controller-a",
        controllerProductName: "OpenClaw",
        disconnectedAt: null,
        dormantSequence: null,
        pendingOperationReceipts: {
          "request-a": {
            bytes: 80,
            operation: "content.set",
            operationReceipt: { commitSequence: 12, requestId: "request-a" },
            outcome: "resolved_success",
            requestId: "request-a",
            status: "terminal",
            terminalResponse: { ok: true },
          },
        },
        projectionCapacityBytes: 8_392_704,
        status: "live",
      },
      "controller-b": {
        controllerInstanceId: "controller-b",
        controllerProductName: "Direct CLI",
        disconnectedAt: 100,
        dormantSequence: 3,
        pendingOperationReceipts: {
          "request-b": { bytes: 20, operation: "pane.split", requestId: "request-b", status: "pending" },
        },
        projectionCapacityBytes: 8_392_704,
        status: "dormant",
      },
    },
    modeBySurfaceId: { "surface-a": "lockless" },
    nextClosedSequence: 4,
    nextCommitSequence: 13,
    nextDormantSequence: 4,
    scopes: { "pane:surface-a:11": scope("pane:surface-a:11") },
    surfaceSetRevision: 5,
    targetApplyWorkItems: {
      "target-work-1": {
        bytes: 90,
        controllerInstanceId: "controller-b",
        intentCommitSequence: 12,
        operationRequestId: "request-target",
        request: { target: { kind: "url", url: "https://example.com" } } as never,
        state: "intent_committed",
        surfaceId: "surface-a",
        targetEpoch: 2,
        targetId: "target-1",
        targetRequestId: "target-request-1",
      },
    },
    tombstones: [
      { bytes: 100, closedSequence: 2, kind: "pane", payload: { paneId: 13 }, scopes: {}, surfaceId: "surface-a", tombstoneId: "pane-dead" },
      { bytes: 120, closedSequence: 3, kind: "surface", payload: { surfaceId: "surface-dead" }, scopes: {}, surfaceId: "surface-dead", tombstoneId: "surface-dead" },
    ],
    version: 1,
  };
  return {
    lockless,
    primarySurfaceId: "surface-a" as never,
    surfaces: [{
      activeKeyboardPaneId: 11,
      geometryRevision: 4,
      layout: { children: [{ paneId: 11, type: "pane" }, { paneId: 12, type: "pane" }], direction: "horizontal", type: "split" },
      name: "Research",
      paneOrder: [11, 12],
      panes: [11, 12].map((paneId) => ({
        annotating: false,
        annotationFrameOpen: false,
        deliveredClosedFrameCount: 1,
        dirtyStrokeIds: [],
        externalNative: false,
        firstDirtyStrokeAt: null,
        flushInFlight: false,
        history: [{ annotations: [{ id: `stroke-${paneId}`, points: [] }], content: { html: `<p>pane ${paneId}</p>` }, contentId: `content-${paneId}`, contentType: "html", ownerToken: null, revision: 3 }],
        historyIndex: 0,
        lastDirtyStrokeAt: null,
        lastSuccessfulFlushAt: 90,
        latestContentEventAt: 91,
        name: paneId === 11 ? "Notes" : "Sources",
        nextRevision: 4,
        paneId,
        paneLabel: paneId === 11 ? 1 : 2,
        paneLineageId: `lineage-${paneId}`,
        pendingAnnotationCommit: false,
        snapshot: { bounds: null, geometryRevision: 4, selection: null, surfaceEpoch: "surface-a:1", topologyRevision: 7, viewport: { contentSize: { height: 800, width: 1200 }, scrollOffset: { x: 0, y: 20 }, visibleRect: { height: 700, width: 1200, x: 0, y: 20 }, zoomLevel: 1 }, visibleText: `pane ${paneId}` },
        toast: null,
      })),
      providerOwnership: { ownershipEpoch: 9, providerId: "controller-a", sessionId: "legacy-session" },
      surfaceEpochRevision: 1,
      surfaceId: "surface-a",
      topologyRevision: 7,
      viewport: { height: 800, scale: 2, width: 1200 },
      windowLabel: "A",
      windowPlacement: null,
    }],
    version: 1,
  } as unknown as PersistentSurfaceState;
}

test("preview preserves legacy material without an owner and reports every lockless-only item", () => {
  const state = representativeState();
  const preview = previewLegacyRollback(state, "portrait-display-pre-rollout-snapshot");

  assert.equal(preview.legacySnapshotIdentity, "portrait-display-pre-rollout-snapshot");
  assert.equal(preview.legacyState.lockless, undefined);
  assert.equal(preview.legacyState.surfaces?.[0]?.providerOwnership, null);
  assert.deepEqual(preview.legacyState.surfaces?.[0]?.panes, state.surfaces?.[0]?.panes);
  assert.deepEqual(preview.legacyState.surfaces?.[0]?.layout, state.surfaces?.[0]?.layout);
  assert.deepEqual(preview.unrepresentableItems.map(({ kind, path }) => [kind, path]), [
    ["authority_metadata", "/lockless/capability"],
    ["authority_metadata", "/lockless/limits"],
    ["authority_metadata", "/lockless/nextClosedSequence"],
    ["authority_metadata", "/lockless/nextCommitSequence"],
    ["authority_metadata", "/lockless/nextDormantSequence"],
    ["authority_metadata", "/lockless/surfaceSetRevision"],
    ["authority_metadata", "/lockless/version"],
    ["surface_mode", "/lockless/modeBySurfaceId/surface-a"],
    ["controller", "/lockless/controllers/controller-a"],
    ["operation_receipt", "/lockless/controllers/controller-a/pendingOperationReceipts/request-a"],
    ["controller", "/lockless/controllers/controller-b"],
    ["operation_receipt", "/lockless/controllers/controller-b/pendingOperationReceipts/request-b"],
    ["consumable_scope", "/lockless/scopes/pane:surface-a:11"],
    ["consumable_cursor", "/lockless/scopes/pane:surface-a:11/cursors/controller-a"],
    ["consumable_gap", "/lockless/scopes/pane:surface-a:11/cursors/controller-a/gap"],
    ["consumable_cursor", "/lockless/scopes/pane:surface-a:11/cursors/controller-b"],
    ["consumable_live_frame", "/lockless/scopes/pane:surface-a:11/liveFrames/frame-1"],
    ["consumable_record", "/lockless/scopes/pane:surface-a:11/records/record-9"],
    ["consumable_record", "/lockless/scopes/pane:surface-a:11/records/record-11"],
    ["target_apply_work", "/lockless/targetApplyWorkItems/target-work-1"],
    ["tombstone", "/lockless/tombstones/pane-dead"],
    ["tombstone", "/lockless/tombstones/surface-dead"],
  ]);
});

test("offline preview/apply installs legacy state and captured generation restores exactly", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-legacy-rollback-"));
  const original = representativeState();
  await writePersistentStateFile(stateDir, FILE_NAME, original);
  const capturedPath = path.join(stateDir, "rollout-captured-generation.json");
  await fs.copyFile(path.join(stateDir, FILE_NAME), capturedPath);

  const preview = await previewCommittedLegacyRollback(stateDir, FILE_NAME, "snapshot-from-portrait-display");
  await applyLegacyRollbackPreview(stateDir, FILE_NAME, preview);
  const applied = await loadPersistentStateFile(stateDir, FILE_NAME);
  assert.deepEqual(applied.state, preview.legacyState);
  assert.equal(applied.state?.surfaces?.[0]?.providerOwnership, null);

  await restoreCapturedPersistentGeneration(stateDir, FILE_NAME, capturedPath);
  const restored = await loadPersistentStateFile(stateDir, FILE_NAME);
  assert.deepEqual(restored.state, original);
  assert.equal(
    await fs.readFile(path.join(stateDir, FILE_NAME), "utf8"),
    await fs.readFile(capturedPath, "utf8"),
  );
});
