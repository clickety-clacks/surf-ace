import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PersistentSurfaceState } from "../src/surface-core.js";
import {
  backupStateFileName,
  loadPersistentStateFile,
  shouldGuardUnrestorablePersistentState,
  writePersistentStateFile,
} from "../src/persistent-state-file.js";

const STATE_FILE_NAME = "surface-core-state.json";

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
