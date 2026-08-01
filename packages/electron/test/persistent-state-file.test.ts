import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SURF_ACE_LOCKLESS_V1_CAPABILITY } from "../../protocol/src/lockless.js";
import { LocklessClientAuthority } from "../src/lockless-client-authority.js";
import type { PersistentSurfaceState } from "../src/surface-core.js";
import {
  backupStateFileName,
  loadPersistentStateFile,
  PersistentStateOutcomeUnknownError,
  persistentStateSelectorFileName,
  shouldGuardUnrestorablePersistentState,
  writePersistentStateFile,
} from "../src/persistent-state-file.js";

const STATE_FILE_NAME = "surface-core-state.json";

type RollbackFault =
  | "cleanup"
  | "close"
  | "directory-open"
  | "directory-sync"
  | "file-sync"
  | "open"
  | "rename"
  | "write";

async function temporaryStateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-persistent-state-"));
}

function multiWindowState(): PersistentSurfaceState {
  return {
    primarySurfaceId: "sf_primary" as never,
    surfaces: [
      {
        createdAt: 1,
        endpointName: "Surf Ace",
        pairState: {
          layout: { paneId: 1, type: "pane" },
          panes: [
            {
              annotating: false,
              annotationFrameOpen: false,
              deliveredClosedFrameCount: 0,
              dirtyStrokeIds: [],
              externalNative: false,
              firstDirtyStrokeAt: null,
              flushInFlight: false,
              history: [],
              historyIndex: -1,
              lastDirtyStrokeAt: null,
              lastSuccessfulFlushAt: null,
              latestContentEventAt: 1,
              name: null,
              nativeHost: null,
              nativeWindowGroup: null,
              paneId: 1,
              paneLabel: 1,
              paneLineageId: "pl_primary" as never,
              pendingAnnotationCommit: false,
              snapshot: {
                bounds: null,
                selection: { text: "" },
                viewport: { height: 1, scale: 1, width: 1 },
                visibleText: "",
              },
              toast: null,
            },
          ],
          topologyRevision: 1 as never,
        },
        surfaceId: "sf_primary" as never,
        viewport: { height: 800, scale: 2, width: 1200 },
        windowPlacement: null,
      },
      {
        createdAt: 2,
        endpointName: "Surf Ace",
        pairState: {
          layout: { paneId: 2, type: "pane" },
          panes: [],
          topologyRevision: 1 as never,
        },
        surfaceId: "sf_secondary" as never,
        viewport: { height: 700, scale: 1, width: 1000 },
        windowPlacement: null,
      },
    ],
    version: 1,
  };
}

async function rejectAfterCandidateDirectorySyncFailure(
  stateDir: string,
  state: PersistentSurfaceState,
  fault: RollbackFault,
  hasPriorGeneration: boolean,
): Promise<void> {
  const statePath = path.join(stateDir, STATE_FILE_NAME);
  const selectorName = persistentStateSelectorFileName(STATE_FILE_NAME);
  const originalOpen = fs.open;
  const originalRename = fs.rename;
  const originalUnlink = fs.unlink;
  let awaitingCandidateDirectorySync = false;
  let candidateDirectorySyncFailed = false;
  let candidateTemporaryPath = "";
  let faultInjected = false;
  const rollbackTemporaryName = hasPriorGeneration ? STATE_FILE_NAME : selectorName;
  const isRollbackTemporary = (filePath: unknown): boolean => {
    if (typeof filePath !== "string" || filePath === candidateTemporaryPath) return false;
    const name = path.basename(filePath);
    return name.startsWith(`${rollbackTemporaryName}.`) && name.endsWith(".tmp");
  };

  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args;
    if (
      candidateDirectorySyncFailed &&
      fault === "rename" &&
      isRollbackTemporary(source)
    ) {
      faultInjected = true;
      throw Object.assign(new Error("injected rollback rename failure"), { code: "EIO" });
    }
    await originalRename(...args);
    if (!candidateDirectorySyncFailed && destination === statePath) {
      candidateTemporaryPath = String(source);
      awaitingCandidateDirectorySync = true;
    }
  }) as typeof fs.rename;
  fs.unlink = (async (...args: Parameters<typeof fs.unlink>) => {
    const [filePath] = args;
    if (
      candidateDirectorySyncFailed &&
      fault === "cleanup" &&
      isRollbackTemporary(filePath)
    ) {
      faultInjected = true;
      throw Object.assign(new Error("injected rollback cleanup failure"), { code: "EIO" });
    }
    return await originalUnlink(...args);
  }) as typeof fs.unlink;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const [filePath] = args;
    if (
      candidateDirectorySyncFailed &&
      fault === "open" &&
      isRollbackTemporary(filePath)
    ) {
      faultInjected = true;
      throw Object.assign(new Error("injected rollback open failure"), { code: "EIO" });
    }
    if (
      candidateDirectorySyncFailed &&
      fault === "directory-open" &&
      filePath === stateDir
    ) {
      faultInjected = true;
      throw Object.assign(new Error("injected rollback directory open failure"), { code: "EIO" });
    }
    const handle = await originalOpen(...args);
    if (filePath === stateDir && awaitingCandidateDirectorySync) {
      awaitingCandidateDirectorySync = false;
      handle.sync = async () => {
        candidateDirectorySyncFailed = true;
        throw Object.assign(new Error("injected candidate directory sync failure"), { code: "EIO" });
      };
      return handle;
    }
    if (candidateDirectorySyncFailed && filePath === stateDir && fault === "directory-sync") {
      handle.sync = async () => {
        faultInjected = true;
        throw Object.assign(new Error("injected rollback directory sync failure"), { code: "EIO" });
      };
      return handle;
    }
    if (candidateDirectorySyncFailed && isRollbackTemporary(filePath)) {
      if (fault === "write" || fault === "cleanup") {
        handle.writeFile = async () => {
          if (fault === "write") faultInjected = true;
          throw Object.assign(new Error("injected rollback write failure"), { code: "EIO" });
        };
      } else if (fault === "file-sync") {
        handle.sync = async () => {
          faultInjected = true;
          throw Object.assign(new Error("injected rollback file sync failure"), { code: "EIO" });
        };
      } else if (fault === "close") {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          faultInjected = true;
          throw Object.assign(new Error("injected rollback close failure"), { code: "EIO" });
        };
      }
    }
    return handle;
  }) as typeof fs.open;
  try {
    await assert.rejects(
      writePersistentStateFile(stateDir, STATE_FILE_NAME, state),
      /injected candidate directory sync failure/,
    );
  } finally {
    fs.open = originalOpen;
    fs.rename = originalRename;
    fs.unlink = originalUnlink;
  }
  assert.equal(candidateDirectorySyncFailed, true, "candidate directory sync fault was not reached");
  assert.equal(faultInjected, true, `rollback ${fault} fault was not reached`);
}

test("persistent state writes primary and last-good backup as valid JSON", async () => {
  const stateDir = await temporaryStateDir();
  const state = multiWindowState();

  await writePersistentStateFile(stateDir, STATE_FILE_NAME, state);

  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, STATE_FILE_NAME), "utf8")), state);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(stateDir, backupStateFileName(STATE_FILE_NAME)), "utf8")),
    state,
  );
});

test("persistent state recovers last-good backup when primary JSON is truncated", async () => {
  const stateDir = await temporaryStateDir();
  const state = multiWindowState();
  await writePersistentStateFile(stateDir, STATE_FILE_NAME, state);
  await fs.writeFile(path.join(stateDir, STATE_FILE_NAME), "{");

  const result = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);

  assert.equal(result.writeGuard, false);
  assert.equal(result.recoveredFromBackup, true);
  assert.deepEqual(result.state, state);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, STATE_FILE_NAME), "utf8")), state);
});

test("backup failure cannot durably replace the primary before transaction rollback", async () => {
  const stateDir = await temporaryStateDir();
  const committed = multiWindowState();
  const rejected = {
    ...multiWindowState(),
    primarySurfaceId: "sf_rejected" as never,
  };
  await writePersistentStateFile(stateDir, STATE_FILE_NAME, committed);
  const backupPath = path.join(stateDir, backupStateFileName(STATE_FILE_NAME));
  await fs.unlink(backupPath);
  await fs.mkdir(backupPath);

  await assert.rejects(
    writePersistentStateFile(stateDir, STATE_FILE_NAME, rejected),
  );

  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(stateDir, STATE_FILE_NAME), "utf8")),
    committed,
  );
  assert.deepEqual(
    (await fs.readdir(stateDir)).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

test("primary failure cannot place a rejected candidate in recovery truth", async () => {
  const stateDir = await temporaryStateDir();
  const committed = multiWindowState();
  const rejected = {
    ...multiWindowState(),
    primarySurfaceId: "sf_rejected" as never,
  };
  await writePersistentStateFile(stateDir, STATE_FILE_NAME, committed);
  const statePath = path.join(stateDir, STATE_FILE_NAME);
  await fs.unlink(statePath);
  await fs.mkdir(statePath);

  await assert.rejects(
    writePersistentStateFile(stateDir, STATE_FILE_NAME, rejected),
  );

  await fs.rmdir(statePath);
  const result = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);
  assert.equal(result.state?.primarySurfaceId, committed.primarySurfaceId);
  assert.equal(result.recoveredFromBackup, true);
  assert.notEqual(result.state?.primarySurfaceId, rejected.primarySurfaceId);
  assert.deepEqual(
    (await fs.readdir(stateDir)).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

test("primary directory sync failure rolls back before reporting rejection", async () => {
  const stateDir = await temporaryStateDir();
  const committed = multiWindowState();
  const rejected = {
    ...multiWindowState(),
    primarySurfaceId: "sf_rejected" as never,
  };
  await writePersistentStateFile(stateDir, STATE_FILE_NAME, committed);
  const originalOpen = fs.open;
  const originalRename = fs.rename;
  const statePath = path.join(stateDir, STATE_FILE_NAME);
  let awaitingCandidateDirectorySync = false;
  let candidateDirectorySyncInjected = false;
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args);
    if (args[1] === statePath && !candidateDirectorySyncInjected) {
      awaitingCandidateDirectorySync = true;
    }
  }) as typeof fs.rename;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === stateDir && awaitingCandidateDirectorySync) {
      awaitingCandidateDirectorySync = false;
      handle.sync = async () => {
        candidateDirectorySyncInjected = true;
        throw Object.assign(new Error("injected directory sync failure"), {
          code: "EIO",
        });
      };
    }
    return handle;
  }) as typeof fs.open;
  try {
    await assert.rejects(
      writePersistentStateFile(stateDir, STATE_FILE_NAME, rejected),
      /injected directory sync failure/,
    );
  } finally {
    fs.open = originalOpen;
    fs.rename = originalRename;
  }

  const result = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);
  assert.equal(result.recoverySource, "primary");
  assert.equal(result.state?.primarySurfaceId, committed.primarySurfaceId);
  assert.notEqual(result.state?.primarySurfaceId, rejected.primarySurfaceId);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(stateDir, backupStateFileName(STATE_FILE_NAME)), "utf8")),
    committed,
  );
  assert.deepEqual(
    (await fs.readdir(stateDir)).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

test("pending selector excludes rejected primary across the complete rollback fault matrix", async (t) => {
  const faults: RollbackFault[] = [
    "open",
    "write",
    "file-sync",
    "close",
    "rename",
    "directory-open",
    "directory-sync",
    "cleanup",
  ];
  for (const hasPriorGeneration of [true, false]) {
    for (const fault of faults) {
      await t.test(`${hasPriorGeneration ? "prior" : "initial"} generation / rollback ${fault}`, async () => {
        const stateDir = await temporaryStateDir();
        const committed = multiWindowState();
        const rejected = {
          ...multiWindowState(),
          primarySurfaceId: "sf_rejected" as never,
        };
        if (hasPriorGeneration) {
          await writePersistentStateFile(stateDir, STATE_FILE_NAME, committed);
        }

        await rejectAfterCandidateDirectorySyncFailure(
          stateDir,
          rejected,
          fault,
          hasPriorGeneration,
        );

        const recovered = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);
        assert.equal(recovered.writeGuard, false);
        if (hasPriorGeneration) {
          assert.equal(recovered.state?.primarySurfaceId, committed.primarySurfaceId);
          assert.notEqual(recovered.state?.primarySurfaceId, rejected.primarySurfaceId);
        } else {
          assert.equal(recovered.state, undefined);
          await assert.rejects(fs.access(path.join(stateDir, STATE_FILE_NAME)));
        }
      });
    }
  }
});

test("selector finalization ambiguity is typed and restart resolves either durable survival", async () => {
  const stateDir = await temporaryStateDir();
  const committed = multiWindowState();
  const authority = new LocklessClientAuthority();
  authority.admit({
    controllerInstanceId: "controller-selector-recovery",
    projectionCapacityBytes: 5 * 1024 * 1024,
    protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY],
  }, "selector-recovery-token", "selector-recovery-admit");
  authority.beginOperationReceipt(
    "controller-selector-recovery",
    "request-selector-recovery",
    "target.apply",
  );
  authority.completeOperationReceipt(
    "controller-selector-recovery",
    "request-selector-recovery",
    "target.apply",
    "resolved_success",
    { id: "request-selector-recovery", ok: true, payload: { status: "intent_committed" } },
    { commitSequence: 7, requestId: "request-selector-recovery" },
  );
  const candidate = {
    ...multiWindowState(),
    lockless: authority.exportState(),
    primarySurfaceId: "sf_candidate" as never,
  };
  await writePersistentStateFile(stateDir, STATE_FILE_NAME, committed);
  const statePath = path.join(stateDir, STATE_FILE_NAME);
  const selectorPath = path.join(stateDir, persistentStateSelectorFileName(STATE_FILE_NAME));
  const originalOpen = fs.open;
  const originalRename = fs.rename;
  let candidateRenamed = false;
  let awaitingSelectorDirectorySync = false;
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args);
    if (args[1] === statePath) candidateRenamed = true;
    if (candidateRenamed && args[1] === selectorPath) awaitingSelectorDirectorySync = true;
  }) as typeof fs.rename;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === stateDir && awaitingSelectorDirectorySync) {
      awaitingSelectorDirectorySync = false;
      handle.sync = async () => {
        throw Object.assign(new Error("injected selector directory sync failure"), { code: "EIO" });
      };
    }
    return handle;
  }) as typeof fs.open;
  try {
    await assert.rejects(
      writePersistentStateFile(stateDir, STATE_FILE_NAME, candidate),
      PersistentStateOutcomeUnknownError,
    );
  } finally {
    fs.open = originalOpen;
    fs.rename = originalRename;
  }

  const committedSelectorSurvived = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);
  assert.equal(committedSelectorSurvived.writeGuard, false);
  assert.equal(committedSelectorSurvived.state?.primarySurfaceId, candidate.primarySurfaceId);
  const restoredAuthority = new LocklessClientAuthority(committedSelectorSurvived.state?.lockless);
  assert.deepEqual(
    restoredAuthority.resolveOperationReceipts(
      "controller-selector-recovery",
      ["request-selector-recovery"],
    ),
    [{
      operationReceipt: { commitSequence: 7, requestId: "request-selector-recovery" },
      outcome: "resolved_success",
      requestId: "request-selector-recovery",
      terminalResponse: {
        id: "request-selector-recovery",
        ok: true,
        payload: { status: "intent_committed" },
      },
    }],
  );

  const committedContents = JSON.stringify(committed, null, 2);
  const candidateContents = JSON.stringify(candidate, null, 2);
  await fs.writeFile(path.join(stateDir, backupStateFileName(STATE_FILE_NAME)), committedContents);
  await fs.writeFile(selectorPath, `${JSON.stringify({
    acceptedSha256: createHash("sha256").update(committedContents).digest("hex"),
    candidateSha256: createHash("sha256").update(candidateContents).digest("hex"),
    phase: "pending",
    version: 1,
  }, null, 2)}\n`);
  const pendingSelectorSurvived = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);
  assert.equal(pendingSelectorSurvived.writeGuard, false);
  assert.equal(pendingSelectorSurvived.state?.primarySurfaceId, committed.primarySurfaceId);
});

test("managed recovery refuses missing or corrupt selector instead of inferring from parseable state", async () => {
  for (const selectorMutation of ["missing", "corrupt"] as const) {
    const stateDir = await temporaryStateDir();
    await writePersistentStateFile(stateDir, STATE_FILE_NAME, multiWindowState());
    const selectorPath = path.join(stateDir, persistentStateSelectorFileName(STATE_FILE_NAME));
    if (selectorMutation === "missing") await fs.unlink(selectorPath);
    else await fs.writeFile(selectorPath, "{");

    const result = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);
    assert.equal(result.state, undefined);
    assert.equal(result.writeGuard, "ambiguous-persistence");
  }
});

test("pending recovery selects only named truth when primary, backup, or temporary artifacts are corrupt or removed", async (t) => {
  for (const hasPriorGeneration of [true, false]) {
    for (const artifact of ["primary", "backup", "temporary"] as const) {
      for (const mutation of ["corrupt", "removed"] as const) {
        await t.test(`${hasPriorGeneration ? "prior" : "initial"} / ${artifact} ${mutation}`, async () => {
          const stateDir = await temporaryStateDir();
          const committed = multiWindowState();
          const rejected = { ...multiWindowState(), primarySurfaceId: "sf_rejected" as never };
          if (hasPriorGeneration) {
            await writePersistentStateFile(stateDir, STATE_FILE_NAME, committed);
          }
          await rejectAfterCandidateDirectorySyncFailure(stateDir, rejected, "open", hasPriorGeneration);
          const artifactPath = artifact === "primary"
            ? path.join(stateDir, STATE_FILE_NAME)
            : artifact === "backup"
            ? path.join(stateDir, backupStateFileName(STATE_FILE_NAME))
            : path.join(stateDir, `${STATE_FILE_NAME}.1.1000.abc.tmp`);
          if (artifact === "temporary") {
            await fs.writeFile(artifactPath, JSON.stringify(rejected));
          }
          if (mutation === "corrupt") {
            await fs.writeFile(artifactPath, "{");
          } else {
            await fs.unlink(artifactPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
          }

          const recovered = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);
          if (hasPriorGeneration && artifact === "backup") {
            assert.equal(recovered.state, undefined);
            assert.equal(recovered.writeGuard, "ambiguous-persistence");
          } else if (hasPriorGeneration) {
            assert.equal(recovered.writeGuard, false);
            assert.equal(recovered.state?.primarySurfaceId, committed.primarySurfaceId);
          } else {
            assert.equal(recovered.writeGuard, false);
            assert.equal(recovered.state, undefined);
          }
          assert.notEqual(recovered.state?.primarySurfaceId, rejected.primarySurfaceId);
        });
      }
    }
  }
});

test("pending recovery uses only the named accepted generation and ignores rollback temporary candidates", async () => {
  const stateDir = await temporaryStateDir();
  const committed = multiWindowState();
  const rejected = { ...multiWindowState(), primarySurfaceId: "sf_rejected" as never };
  await writePersistentStateFile(stateDir, STATE_FILE_NAME, committed);
  await rejectAfterCandidateDirectorySyncFailure(stateDir, rejected, "cleanup", true);
  const rollbackTemporary = (await fs.readdir(stateDir)).find((entry) => entry.endsWith(".tmp"));
  assert.ok(rollbackTemporary);
  await fs.writeFile(path.join(stateDir, rollbackTemporary), JSON.stringify(rejected));

  const recovered = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);
  assert.equal(recovered.writeGuard, false);
  assert.equal(recovered.state?.primarySurfaceId, committed.primarySurfaceId);
});

test("persistent state recovers newest valid atomic temp snapshot when primary and backup are corrupt", async () => {
  const stateDir = await temporaryStateDir();
  const olderState = multiWindowState();
  const newestState = {
    ...multiWindowState(),
    primarySurfaceId: "sf_newest" as never,
    surfaces: [
      {
        ...multiWindowState().surfaces[0],
        surfaceId: "sf_newest" as never,
      },
    ],
  };
  await fs.writeFile(path.join(stateDir, STATE_FILE_NAME), "");
  await fs.writeFile(path.join(stateDir, backupStateFileName(STATE_FILE_NAME)), "{");
  const olderTempPath = path.join(stateDir, `${STATE_FILE_NAME}.1.1000.abc.tmp`);
  const newestTempPath = path.join(stateDir, `${STATE_FILE_NAME}.1.2000.def.tmp`);
  await fs.writeFile(olderTempPath, JSON.stringify(olderState, null, 2));
  await fs.writeFile(newestTempPath, JSON.stringify(newestState, null, 2));
  await fs.utimes(olderTempPath, new Date(1_000), new Date(1_000));
  await fs.utimes(newestTempPath, new Date(2_000), new Date(2_000));

  const result = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);

  assert.equal(result.writeGuard, false);
  assert.equal(result.recoveredFromBackup, false);
  assert.equal(result.recoverySource, "temporary");
  assert.deepEqual(result.state, newestState);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, STATE_FILE_NAME), "utf8")), newestState);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(stateDir, backupStateFileName(STATE_FILE_NAME)), "utf8")),
    newestState,
  );
});

test("persistent state leaves unrecoverable corrupt primary available for future valid writes", async () => {
  const stateDir = await temporaryStateDir();
  await fs.writeFile(path.join(stateDir, STATE_FILE_NAME), "{");

  const result = await loadPersistentStateFile(stateDir, STATE_FILE_NAME);

  assert.equal(result.state, undefined);
  assert.equal(result.writeGuard, false);
  assert.equal(await fs.readFile(path.join(stateDir, STATE_FILE_NAME), "utf8"), "{");
});

test("persistent state guards parsed saved surfaces when any saved surface does not restore", () => {
  assert.equal(shouldGuardUnrestorablePersistentState(multiWindowState(), 0), true);
  assert.equal(shouldGuardUnrestorablePersistentState(multiWindowState(), 1), true);
  assert.equal(shouldGuardUnrestorablePersistentState(multiWindowState(), 2), false);
  assert.equal(shouldGuardUnrestorablePersistentState(undefined, 0), false);
  assert.equal(
    shouldGuardUnrestorablePersistentState({ primarySurfaceId: null, surfaces: [], version: 1 }, 0),
    false,
  );
});
