import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SURF_ACE_LOCKLESS_V1_CAPABILITY,
  locklessPaneScopeId,
  type LocklessPairPayload,
} from "../../protocol/src/lockless.js";
import {
  LocklessAuthorityError,
  type PersistentLocklessClientState,
} from "../src/lockless-client-authority.js";
import {
  SurfaceCore,
  type PersistentSurfaceState,
} from "../src/surface-core.js";

const viewport = { height: 800, scale: 2, width: 1200 };

function migrationMaterial(
  surfaceId: string,
  paneId: number,
  marker = "original",
): NonNullable<LocklessPairPayload["migrationMaterial"]> {
  return {
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
        scopeId: locklessPaneScopeId(surfaceId, paneId),
      },
    ],
    scopes: [
      {
        liveFrames: [
          { frameId: "legacy-live-frame", payload: { marker, strokes: [1] } },
        ],
        records: [
          { payload: { marker, x: 10, y: 20 }, recordClass: "tap" },
          { payload: { marker, page: 2 }, recordClass: "page" },
          { payload: { marker, offset: 44 }, recordClass: "scroll" },
          { payload: { marker, text: "selected" }, recordClass: "selection" },
          { payload: { marker, url: "https://example.com" }, recordClass: "navigation" },
          { payload: { marker, state: "paused", position: 4 }, recordClass: "playback" },
          { payload: { marker, contentId: "legacy-content" }, recordClass: "content" },
          { payload: { marker, entryId: "legacy-history" }, recordClass: "history" },
          { payload: { marker, revision: 7 }, recordClass: "topology" },
        ],
        scopeId: locklessPaneScopeId(surfaceId, paneId),
        scopeKind: "pane",
      },
    ],
  };
}

function candidate(clientIdentity = "electron-client-a"): {
  core: SurfaceCore;
  material: NonNullable<LocklessPairPayload["migrationMaterial"]>;
  paneId: number;
  requestId: string;
  surfaceId: string;
} {
  const core = new SurfaceCore({ clientIdentity });
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: 1,
    initialPaneLabel: 1,
    windowLabel: "a",
  });
  const paneId = core.activePaneIds(surface.surfaceId)[0]!;
  return {
    core,
    material: migrationMaterial(surface.surfaceId, paneId),
    paneId,
    requestId: "rq_migration_stable",
    surfaceId: surface.surfaceId,
  };
}

async function commit(
  core: SurfaceCore,
  input: {
    material: NonNullable<LocklessPairPayload["migrationMaterial"]>;
    requestId: string;
    surfaceId: string;
  },
  persist: () => Promise<void>,
): Promise<void> {
  await core.transactionAsync(async () =>
    await core.locklessAuthority.transactionPersisted(
      () => {
        core.locklessAuthority.admit(
          {
            controllerInstanceId: "openclaw-controller",
            projectionCapacityBytes: 32 * 1024 * 1024,
            protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
          },
          "socket-token",
          input.requestId,
          `surface:${input.surfaceId}`,
        );
        core.admitSurfaceToLockless(
          input.surfaceId,
          input.material,
          "openclaw-controller",
          input.requestId,
        );
      },
      persist,
    )
  );
}

function restart(
  state: PersistentSurfaceState,
  clientIdentity = "electron-client-a",
): SurfaceCore {
  const core = new SurfaceCore({ clientIdentity, persistentState: state });
  core.restorePersistedSurfaces("Surf Ace", viewport);
  return core;
}

function resolveReplay(
  core: SurfaceCore,
  input: {
    material: NonNullable<LocklessPairPayload["migrationMaterial"]>;
    requestId: string;
    surfaceId: string;
  },
): void {
  core.admitSurfaceToLockless(
    input.surfaceId,
    input.material,
    "openclaw-controller",
    input.requestId,
  );
}

test("E-MIG-RECEIPT :: before prepared or pair send Electron has no migration commit or receipt", () => {
  const input = candidate();
  const state = input.core.getPersistentState();
  assert.equal(input.core.locklessAuthority.surfaceMode(input.surfaceId), null);
  assert.deepEqual(state.lockless?.migrationReceipts, {});
  assert.deepEqual(input.core.activePaneIds(input.surfaceId), [input.paneId]);
});

test("E-MIG-RECEIPT :: pair sent without a proven client commit rolls back and permits only the same stable attempt", async () => {
  const input = candidate();
  const before = input.core.getPersistentState();
  await assert.rejects(
    commit(input.core, input, async () => {
      throw new Error("injected before durable client commit");
    }),
    /before durable client commit/,
  );
  assert.deepEqual(input.core.getPersistentState(), before);
  await commit(input.core, input, async () => {});
  assert.equal(input.core.locklessAuthority.surfaceMode(input.surfaceId), "lockless");
  assert.equal(
    input.core.locklessAuthority.exportState().migrationReceipts[input.requestId]
      ?.requestId,
    input.requestId,
  );
});

test("E-MIG-RECEIPT :: client commit before response survives restart and replays the exact migration receipt", async () => {
  const input = candidate();
  let durable: PersistentSurfaceState | null = null;
  await commit(input.core, input, async () => {
    durable = input.core.getPersistentState();
  });
  assert(durable);
  const restored = restart(durable);
  assert.doesNotThrow(() => resolveReplay(restored, input));
  assert.equal(
    restored.locklessAuthority.exportState().migrationReceipts[input.requestId]
      ?.requestId,
    input.requestId,
  );
});

test("E-MIG-RECEIPT :: already-lockless source-pending recovery resolves the same ID without reimporting material", async () => {
  const input = candidate();
  await commit(input.core, input, async () => {});
  const before = input.core.getPersistentState();
  resolveReplay(input.core, input);
  assert.deepEqual(input.core.getPersistentState(), before);
  const scope = input.core.locklessAuthority.exportState().scopes[
    locklessPaneScopeId(input.surfaceId, input.paneId)
  ]!;
  assert.equal(scope.records.length, input.material.scopes[0]!.records.length);
  assert.equal(Object.keys(scope.liveFrames).length, 1);
});

test("E-MIG-RECEIPT :: source-cleared-before-complete recovery remains idempotent from the durable Electron receipt", async () => {
  const input = candidate();
  let durable: PersistentSurfaceState | null = null;
  await commit(input.core, input, async () => {
    durable = input.core.getPersistentState();
  });
  assert(durable);
  const first = restart(durable);
  resolveReplay(first, input);
  const afterFirst = first.getPersistentState();
  const second = restart(afterFirst);
  resolveReplay(second, input);
  assert.deepEqual(second.getPersistentState(), afterFirst);
});

test("E-MIG-RECEIPT :: same-ID material controller surface and persisted-client mismatches hard fail", async () => {
  const input = candidate();
  await commit(input.core, input, async () => {});
  const state = input.core.getPersistentState();
  const mismatchedMaterial = migrationMaterial(
    input.surfaceId,
    input.paneId,
    "different",
  );
  assert.throws(
    () => input.core.admitSurfaceToLockless(
      input.surfaceId,
      mismatchedMaterial,
      "openclaw-controller",
      input.requestId,
    ),
    (error) => error instanceof LocklessAuthorityError && error.code === "invalid_payload",
  );
  assert.throws(
    () => input.core.admitSurfaceToLockless(
      input.surfaceId,
      input.material,
      "different-controller",
      input.requestId,
    ),
    (error) => error instanceof LocklessAuthorityError && error.code === "invalid_payload",
  );
  const copied = restart(state, "electron-client-b");
  assert.throws(
    () => resolveReplay(copied, input),
    (error) => error instanceof LocklessAuthorityError && error.code === "invalid_payload",
  );
  const receipt = (state.lockless as PersistentLocklessClientState)
    .migrationReceipts[input.requestId]!;
  assert.equal(receipt.surfaceId, input.surfaceId);
  assert.equal(receipt.controllerInstanceId, "openclaw-controller");
});

test("E-MIG-RECEIPT :: a fresh pair ID is rejected while the durable migration receipt exists", async () => {
  const input = candidate();
  await commit(input.core, input, async () => {});
  assert.throws(
    () => input.core.admitSurfaceToLockless(
      input.surfaceId,
      input.material,
      "openclaw-controller",
      "rq_migration_fresh_forbidden",
    ),
    (error) => error instanceof LocklessAuthorityError && error.code === "invalid_operation",
  );
});

test("AC-MIG-03: Electron platform gate enumerates every formerly pending canonical parity row in the built suite", () => {
  const sources = [
    "lockless-acceptance.test.ts",
    "lockless-client-authority.test.ts",
    "lockless-ws-server.test.ts",
    "migration-receipt.test.ts",
  ].map((fileName) =>
    readFileSync(new URL(`../../test/${fileName}`, import.meta.url), "utf8")
  ).join("\n");
  for (const row of [
    "AC-ID-03",
    "AC-SYNC-02",
    "AC-SYNC-03",
    "AC-PROV-05",
    "AC-TOPO-03",
    "AC-TOPO-04",
    "AC-SURF-01",
    "AC-SURF-02",
    "AC-SURF-04",
    "AC-SURF-05",
    "AC-RET-01",
    "AC-RET-02",
    "AC-RET-04",
    "AC-MIG-01",
    "AC-MIG-03",
    "AC-OPS-01",
  ]) {
    assert.match(sources, new RegExp(`test\\(\"[^\"]*${row}`), row);
  }
  const build = readFileSync(
    new URL("../../scripts/build.mjs", import.meta.url),
    "utf8",
  );
  for (const fileName of [
    "lockless-acceptance.test.ts",
    "lockless-client-authority.test.ts",
    "lockless-ws-server.test.ts",
    "migration-receipt.test.ts",
  ]) {
    assert.match(build, new RegExp(fileName.replaceAll(".", "\\.")));
  }
});
