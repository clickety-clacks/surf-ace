import fs from "node:fs/promises";

import type { PersistentLocklessClientState, PersistentConsumableScope } from "./lockless-client-authority.js";
import {
  loadPersistentStateFile,
  writePersistentStateFile,
} from "./persistent-state-file.js";
import type { PersistentSurfaceState } from "./surface-core.js";

export type LegacyRollbackUnrepresentableItem = {
  kind:
    | "authority_metadata"
    | "consumable_cursor"
    | "consumable_gap"
    | "consumable_live_frame"
    | "consumable_record"
    | "consumable_scope"
    | "controller"
    | "operation_receipt"
    | "surface_mode"
    | "target_apply_work"
    | "tombstone";
  path: string;
  reason: "lockless_only";
};

export type LegacyRollbackPreview = {
  legacySnapshotIdentity: string;
  legacyState: PersistentSurfaceState;
  unrepresentableItems: LegacyRollbackUnrepresentableItem[];
  version: 1;
};

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function item(
  kind: LegacyRollbackUnrepresentableItem["kind"],
  path: string,
): LegacyRollbackUnrepresentableItem {
  return { kind, path, reason: "lockless_only" };
}

function reportScope(
  items: LegacyRollbackUnrepresentableItem[],
  scope: PersistentConsumableScope,
  path: string,
): void {
  items.push(item("consumable_scope", path));
  for (const controllerId of Object.keys(scope.cursors).sort()) {
    const cursorPath = `${path}/cursors/${pointerSegment(controllerId)}`;
    items.push(item("consumable_cursor", cursorPath));
    if (scope.cursors[controllerId]!.gap) {
      items.push(item("consumable_gap", `${cursorPath}/gap`));
    }
  }
  for (const frameId of Object.keys(scope.liveFrames).sort()) {
    items.push(item("consumable_live_frame", `${path}/liveFrames/${pointerSegment(frameId)}`));
  }
  for (const record of [...scope.records].sort((left, right) => left.sequence - right.sequence)) {
    items.push(item("consumable_record", `${path}/records/${pointerSegment(record.recordId)}`));
  }
}

function reportLocklessState(lockless: PersistentLocklessClientState): LegacyRollbackUnrepresentableItem[] {
  const items: LegacyRollbackUnrepresentableItem[] = [
    item("authority_metadata", "/lockless/capability"),
    item("authority_metadata", "/lockless/limits"),
    item("authority_metadata", "/lockless/nextClosedSequence"),
    item("authority_metadata", "/lockless/nextCommitSequence"),
    item("authority_metadata", "/lockless/nextDormantSequence"),
    item("authority_metadata", "/lockless/surfaceSetRevision"),
    item("authority_metadata", "/lockless/version"),
  ];
  for (const surfaceId of Object.keys(lockless.modeBySurfaceId).sort()) {
    items.push(item("surface_mode", `/lockless/modeBySurfaceId/${pointerSegment(surfaceId)}`));
  }
  for (const controllerId of Object.keys(lockless.controllers).sort()) {
    const controllerPath = `/lockless/controllers/${pointerSegment(controllerId)}`;
    items.push(item("controller", controllerPath));
    for (const requestId of Object.keys(lockless.controllers[controllerId]!.pendingOperationReceipts).sort()) {
      items.push(item("operation_receipt", `${controllerPath}/pendingOperationReceipts/${pointerSegment(requestId)}`));
    }
  }
  for (const scopeId of Object.keys(lockless.scopes).sort()) {
    reportScope(items, lockless.scopes[scopeId]!, `/lockless/scopes/${pointerSegment(scopeId)}`);
  }
  for (const workId of Object.keys(lockless.targetApplyWorkItems).sort()) {
    items.push(item("target_apply_work", `/lockless/targetApplyWorkItems/${pointerSegment(workId)}`));
  }
  for (const tombstone of [...lockless.tombstones].sort((left, right) => left.tombstoneId.localeCompare(right.tombstoneId))) {
    const tombstonePath = `/lockless/tombstones/${pointerSegment(tombstone.tombstoneId)}`;
    items.push(item("tombstone", tombstonePath));
    for (const scopeId of Object.keys(tombstone.scopes).sort()) {
      reportScope(items, tombstone.scopes[scopeId]!, `${tombstonePath}/scopes/${pointerSegment(scopeId)}`);
    }
  }
  return items;
}

export function previewLegacyRollback(
  state: PersistentSurfaceState,
  legacySnapshotIdentity: string,
): LegacyRollbackPreview {
  const legacyState = structuredClone(state);
  for (const surface of legacyState.surfaces ?? []) {
    surface.providerOwnership = null;
  }
  delete legacyState.lockless;
  return {
    legacySnapshotIdentity,
    legacyState,
    unrepresentableItems: state.lockless ? reportLocklessState(state.lockless) : [],
    version: 1,
  };
}

export async function previewCommittedLegacyRollback(
  stateDir: string,
  fileName: string,
  legacySnapshotIdentity: string,
): Promise<LegacyRollbackPreview> {
  const loaded = await loadPersistentStateFile(stateDir, fileName);
  if (!loaded.state) throw loaded.error;
  return previewLegacyRollback(loaded.state, legacySnapshotIdentity);
}

export async function applyLegacyRollbackPreview(
  stateDir: string,
  fileName: string,
  preview: LegacyRollbackPreview,
): Promise<void> {
  await writePersistentStateFile(stateDir, fileName, preview.legacyState);
}

export async function restoreCapturedPersistentGeneration(
  stateDir: string,
  fileName: string,
  generationPath: string,
): Promise<void> {
  const state = JSON.parse(await fs.readFile(generationPath, "utf8")) as PersistentSurfaceState;
  await writePersistentStateFile(stateDir, fileName, state);
}
