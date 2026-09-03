import assert from "node:assert/strict";
import test from "node:test";

import type { Revision } from "../../protocol/src/index.js";
import {
  LOCKLESS_MAX_ADMISSION_REASON_CODE_LENGTH,
  LOCKLESS_MAX_ADMISSION_REASON_JSON_BYTES,
  LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
  LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES,
  type LocklessSurfaceAdmissionAttempt,
} from "../../protocol/src/lockless.js";
import type { NativePaneMaterialization } from "../src/native-pane-bridge.js";
import { SurfaceCore, SurfaceCoreError } from "../src/surface-core.js";
import { PersistentStateOutcomeUnknownError } from "../src/persistent-state-file.js";
import {
  createEmptyLocklessClientState,
  DEFAULT_LOCKLESS_LIMITS,
} from "../src/lockless-client-authority.js";
import { LocklessAuthorityError } from "../src/lockless-client-authority.js";

function applyProviderBootstrap(
  core: SurfaceCore,
  surfaceId: string,
  initialPaneId: number,
  windowLabel = "a",
): number {
  core.applyProviderBootstrapTopology(surfaceId, {
    initialPaneId,
    initialPaneLabel: initialPaneId,
    windowLabel,
  });
  return core.getRendererWindowState(surfaceId).panes[0]!.paneId;
}

function resolvePaneSnapshot(core: SurfaceCore, surfaceId: string, paneId: number): void {
  updateResolvedPaneSnapshot(core, surfaceId, paneId, {
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
  });
}

function updateResolvedPaneSnapshot(
  core: SurfaceCore,
  surfaceId: string,
  paneId: number,
  snapshot: Parameters<SurfaceCore["updatePaneSnapshot"]>[2],
): void {
  core.updatePaneSnapshot(surfaceId, paneId, {
    ...snapshot,
    ...core.resolvedPaneGeometryIdentity(surfaceId),
  });
}

function admissionLedgerBytes(
  attempts: LocklessSurfaceAdmissionAttempt[],
): number {
  return Buffer.byteLength(JSON.stringify(attempts), "utf8");
}

function reservedAdmissionLedgerBytes(
  attempts: LocklessSurfaceAdmissionAttempt[],
): number {
  return admissionLedgerBytes(
    attempts.map((attempt) =>
      attempt.outcome === "pending"
        ? {
            ...attempt,
            outcome: "failed",
            reason: "x".repeat(
              LOCKLESS_MAX_ADMISSION_REASON_JSON_BYTES - 2,
            ),
            reasonCode: "x".repeat(
              LOCKLESS_MAX_ADMISSION_REASON_CODE_LENGTH,
            ),
            stage: "controller_admission",
            updatedAt: Number.MAX_SAFE_INTEGER,
            // Mirrors production's own worst-case reservation (B2):
            // "not_started" is the longer of the two witness values.
            ...(attempt.witness !== undefined
              ? { witness: "not_started" as const }
              : {}),
          }
        : attempt
    ),
  );
}

function failedAdmissionAttempt(
  attemptSequence: number,
  reason: string,
): LocklessSurfaceAdmissionAttempt {
  return {
    attemptSequence,
    controllerInstanceId: `controller_${attemptSequence}`,
    outcome: "failed",
    reason,
    reasonCode: "invalid_payload",
    requestId: `rq_${attemptSequence}`,
    stage: "surface_lookup",
    startedAt: attemptSequence,
    surfaceId: "sf_test",
    updatedAt: attemptSequence,
  };
}

test("surface admission ledger self-unbricks at the count bound and preserves retained rows across restart", () => {
  const core = new SurfaceCore();
  for (
    let attemptSequence = 1;
    attemptSequence <= LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS;
    attemptSequence++
  ) {
    const attempt = core.beginSurfaceAdmissionAttempt({
      controllerInstanceId: `controller_${attemptSequence}`,
      requestId: `rq_${attemptSequence}`,
      surfaceId: "sf_test",
    });
    core.succeedSurfaceAdmissionAttempt(attempt.attemptSequence);
  }
  const atEquality = core.getPersistentState();
  assert.equal(
    atEquality.admissionAttempts?.length,
    LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
  );
  const newestBefore = atEquality.admissionAttempts?.find(
    (attempt) =>
      attempt.attemptSequence === LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
  );
  assert(newestBefore);

  // Terminal history alone must never brick the next request. The ledger is
  // global, so a request from a different surface is what proves it.
  const admitted = core.beginSurfaceAdmissionAttempt({
    controllerInstanceId: "controller_over_count",
    requestId: "rq_over_count",
    surfaceId: "sf_other",
  });
  assert.equal(
    admitted.attemptSequence,
    LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS + 1,
  );

  const compacted = core.listSurfaceAdmissionAttempts();
  assert(compacted.length <= LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS);
  // oldest committed terminal sequence evicted first
  assert.equal(compacted.some((attempt) => attempt.attemptSequence === 1), false);
  // newest terminal suffix retained, byte-for-byte identical
  assert.deepEqual(
    compacted.find(
      (attempt) =>
        attempt.attemptSequence === LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
    ),
    newestBefore,
  );
  assert(
    compacted.some(
      (attempt) =>
        attempt.attemptSequence === LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS + 1,
    ),
  );
  assert.equal(
    core.getPersistentState().nextAdmissionAttemptSequence,
    LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS + 2,
  );

  // The saturated persisted form must also self-unbrick after a restart,
  // which is what the incident proved the baseline could not do.
  const restarted = new SurfaceCore({ persistentState: atEquality });
  assert.equal(
    restarted.listSurfaceAdmissionAttempts().length,
    LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
  );
  const admittedAfterRestart = restarted.beginSurfaceAdmissionAttempt({
    controllerInstanceId: "controller_restart_over_count",
    requestId: "rq_restart_over_count",
    surfaceId: "sf_test",
  });
  assert.equal(
    admittedAfterRestart.attemptSequence,
    LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS + 1,
  );
  assert(
    restarted.listSurfaceAdmissionAttempts().length <=
      LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
  );
});

test("surface admission ledger self-unbricks at the exact byte bound and stays within it", () => {
  let attempts: LocklessSurfaceAdmissionAttempt[] | null = null;
  for (
    let count = 1;
    count < LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS;
    count++
  ) {
    const minimum = Array.from(
      { length: count },
      (_, index) => failedAdmissionAttempt(index + 1, "x"),
    );
    const maximum = minimum.map((attempt) => ({
      ...attempt,
      reason: "x".repeat(LOCKLESS_MAX_ADMISSION_REASON_JSON_BYTES - 2),
    }));
    if (
      admissionLedgerBytes(minimum) <=
        LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES &&
      admissionLedgerBytes(maximum) >=
        LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES
    ) {
      attempts = minimum;
      break;
    }
  }
  assert(attempts);
  let remaining =
    LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES -
    admissionLedgerBytes(attempts);
  for (const attempt of attempts) {
    const added = Math.min(
      remaining,
      LOCKLESS_MAX_ADMISSION_REASON_JSON_BYTES - 3,
    );
    attempt.reason = "x".repeat(1 + added);
    remaining -= added;
  }
  assert.equal(remaining, 0);
  assert.equal(
    admissionLedgerBytes(attempts),
    LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES,
  );

  const core = new SurfaceCore({
    persistentState: {
      admissionAttempts: attempts,
      nextAdmissionAttemptSequence: attempts.length + 1,
      primarySurfaceId: null,
      version: 1,
    },
  });
  // At the exact byte bound the ledger must still admit, by compacting oldest
  // terminal rows rather than refusing forever.
  const admitted = core.beginSurfaceAdmissionAttempt({
    controllerInstanceId: "controller_over_bytes",
    requestId: "rq_over_bytes",
    surfaceId: "sf_test",
  });
  assert.equal(admitted.attemptSequence, attempts.length + 1);

  const compacted = core.listSurfaceAdmissionAttempts();
  assert(
    admissionLedgerBytes(compacted) <=
      LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES,
  );
  assert(compacted.length <= LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS);
  assert.equal(compacted.some((attempt) => attempt.attemptSequence === 1), false);
  assert(
    compacted.some(
      (attempt) => attempt.attemptSequence === attempts.length + 1,
    ),
  );
});

test("surface admission reservation at exact byte bound survives terminalization and restart", () => {
  const now = Number.MAX_SAFE_INTEGER;
  const pendingAttempt = (attemptSequence: number) => ({
    attemptSequence,
    controllerInstanceId: "controller_terminal_equality",
    outcome: "pending" as const,
    reason: null,
    reasonCode: null,
    requestId: "rq_terminal_equality",
    stage: "requested" as const,
    startedAt: now,
    surfaceId: "sf_test",
    updatedAt: now,
    // beginSurfaceAdmissionAttempt (B2) always stamps a real candidate with
    // this witness, so the calibration template must carry it too, or this
    // fixture pads to a total that falls short the moment the real candidate
    // is created and compaction correctly evicts a row to make room.
    witness: "not_started" as const,
  });
  let attempts: LocklessSurfaceAdmissionAttempt[] | null = null;
  for (
    let count = 1;
    count < LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS;
    count++
  ) {
    const minimum = Array.from(
      { length: count },
      (_, index) => failedAdmissionAttempt(index + 1, "x"),
    );
    const maximum = minimum.map((attempt) => ({
      ...attempt,
      reason: "x".repeat(LOCKLESS_MAX_ADMISSION_REASON_JSON_BYTES - 2),
    }));
    const pending = pendingAttempt(count + 1);
    if (
      reservedAdmissionLedgerBytes([...minimum, pending]) <=
        LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES &&
      reservedAdmissionLedgerBytes([...maximum, pending]) >=
        LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES
    ) {
      attempts = minimum;
      break;
    }
  }
  assert(attempts);
  const pending = pendingAttempt(attempts.length + 1);
  let remaining =
    LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES -
    reservedAdmissionLedgerBytes([...attempts, pending]);
  for (const attempt of attempts) {
    const added = Math.min(
      remaining,
      LOCKLESS_MAX_ADMISSION_REASON_JSON_BYTES - 3,
    );
    attempt.reason = "x".repeat(1 + added);
    remaining -= added;
  }
  assert.equal(remaining, 0);

  const core = new SurfaceCore({
    now: () => now,
    persistentState: {
      admissionAttempts: attempts,
      nextAdmissionAttemptSequence: attempts.length + 1,
      primarySurfaceId: null,
      version: 1,
    },
  });
  const begun = core.beginSurfaceAdmissionAttempt({
    controllerInstanceId: pending.controllerInstanceId,
    requestId: pending.requestId,
    surfaceId: pending.surfaceId,
  });
  assert.equal(
    reservedAdmissionLedgerBytes(core.listSurfaceAdmissionAttempts()),
    LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES,
  );
  core.advanceSurfaceAdmissionAttempt(
    begun.attemptSequence,
    "controller_admission",
  );
  core.failSurfaceAdmissionAttempt(
    begun.attemptSequence,
    "x".repeat(LOCKLESS_MAX_ADMISSION_REASON_CODE_LENGTH),
    "x".repeat(LOCKLESS_MAX_ADMISSION_REASON_JSON_BYTES - 2),
  );
  const persisted = core.getPersistentState();
  assert.equal(
    admissionLedgerBytes(persisted.admissionAttempts ?? []),
    LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPT_BYTES,
  );

  const restarted = new SurfaceCore({ persistentState: persisted });
  assert.equal(
    restarted.listSurfaceAdmissionAttempts().length,
    attempts.length + 1,
  );
});

test("surface admission append bounds identifiers and terminal failure text", () => {
  const core = new SurfaceCore();
  assert.throws(
    () =>
      core.beginSurfaceAdmissionAttempt({
        controllerInstanceId: "c".repeat(65),
        requestId: "rq_invalid",
        surfaceId: "sf_test",
      }),
    (error) =>
      error instanceof LocklessAuthorityError &&
      error.code === "invalid_payload",
  );
  assert.equal(core.listSurfaceAdmissionAttempts().length, 0);

  const pending = core.beginSurfaceAdmissionAttempt({
    controllerInstanceId: "controller_reason",
    requestId: "rq_reason",
    surfaceId: "sf_test",
  });
  const failed = core.failSurfaceAdmissionAttempt(
    pending.attemptSequence,
    "r".repeat(80),
    'quoted " failure '.repeat(100),
  );
  assert.equal(failed.reasonCode, "internal_error");
  assert.match(failed.reason ?? "", /…\[truncated\]$/);
  assert(
    Buffer.byteLength(JSON.stringify(failed.reason), "utf8") <=
      LOCKLESS_MAX_ADMISSION_REASON_JSON_BYTES,
  );
});

test("surface core initializes with a bootstrap pane before provider topology arrives", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const windowState = core.getRendererWindowState(surface.surfaceId);

  assert.equal(windowState.windowLabel, "");
  assert.deepEqual(windowState.layout, { paneId: 0, type: "pane" });
  assert.equal(windowState.panes.length, 1);
  assert.equal(windowState.panes[0]?.paneId, 0);
  assert.equal(windowState.panes[0]?.label, "");
});

test("surface core replaces the bootstrap pane with the provider initial pane", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const initialPaneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  const windowState = core.getRendererWindowState(surface.surfaceId);

  assert.equal(initialPaneId, 7);
  assert.deepEqual(windowState.layout, { paneId: 7, type: "pane" });
  assert.equal(windowState.panes.length, 1);
  assert.equal(windowState.panes[0]?.paneId, 7);
  assert.equal(windowState.panes[0]?.label, "7");
  assert.equal(windowState.panes[0]?.activeKeyboardPane, true);
});

test("surface core marks unresolved single-pane geometry as non-authoritative", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  const listedPane = core.panesList(surface.surfaceId).panes[0]!;

  assert.equal(listedPane.geometry.geometryUnavailable, true);
  assert.equal(listedPane.geometry.unavailableReason, "missing_resolved_snapshot");
  assert.equal(listedPane.geometry.geometryRevision, 0);
  assert.deepEqual(core.missingResolvedPaneGeometry(surface.surfaceId, [paneId]), [paneId]);
  assert.throws(
    () => core.projectNativePaneMaterialization(surface.surfaceId, {
      paneLineageId: listedPane.paneLineageId!,
      requestId: "restore_btop",
      restoreReason: "resume_restore",
      surfaceId: surface.surfaceId as never,
      targetEpoch: 3,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "launch_equivalent",
        requiredCapabilities: ["target.terminal_app.v1"],
        safeToLogFields: ["command", "args"],
        safetyClass: "process",
        summary: "btop",
      },
      targetId: "target_btop",
      targetKind: "terminal_app",
      targetPayload: { args: [], command: "btop", envPolicy: "surface_default", pty: true, restartPolicy: "manual_only" },
    }),
    /has no authoritative resolved Surf Ace geometry snapshot/,
  );
});

test("surface core rejects stale pane bounds until the current geometry revision resolves", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  resolvePaneSnapshot(core, surface.surfaceId, paneId);
  const staleIdentity = core.resolvedPaneGeometryIdentity(surface.surfaceId);

  core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "horizontal",
    newPaneIds: [9],
    newPaneLabels: [9],
    paneId,
  });
  core.updatePaneSnapshot(surface.surfaceId, paneId, {
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    ...staleIdentity,
  });

  const stalePane = core.panesList(surface.surfaceId).panes[0]!;
  assert.equal(stalePane.geometry.geometryUnavailable, true);
  assert.equal(stalePane.geometry.unavailableReason, "missing_resolved_snapshot");

  updateResolvedPaneSnapshot(core, surface.surfaceId, paneId, {
    bounds: { height: 400, width: 1200, x: 0, y: 0 },
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, 9, {
    bounds: { height: 400, width: 1200, x: 0, y: 400 },
  });
  const currentIdentity = core.resolvedPaneGeometryIdentity(surface.surfaceId);
  for (const pane of core.panesList(surface.surfaceId).panes) {
    assert.equal(pane.geometry.geometryUnavailable, undefined);
    assert.equal(pane.geometry.geometryRevision, currentIdentity.geometryRevision);
    assert.equal(pane.geometry.topologyEpoch, currentIdentity.topologyRevision);
  }
});

test("surface core removes closed windows from live topology immediately", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const primary = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const secondary = core.createAdditionalSurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const events: Array<string> = [];
  const unsubscribe = core.subscribe((event) => {
    events.push(`${event.type}:${event.surfaceId}`);
  });

  try {
    assert.deepEqual(
      core.listSurfaces().map((surface) => surface.surfaceId),
      [primary.surfaceId, secondary.surfaceId],
    );

    core.removeSurface(secondary.surfaceId);

    assert.deepEqual(
      core.listSurfaces().map((surface) => surface.surfaceId),
      [primary.surfaceId],
    );
    assert.throws(
      () => core.getRendererWindowState(secondary.surfaceId),
      (error) => error instanceof SurfaceCoreError && error.code === "invalid_payload",
    );
    assert.ok(events.includes(`surface-removed:${secondary.surfaceId}`));
  } finally {
    unsubscribe();
  }
});

test("surface core persists and restores multiple live windows with pane content", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const primary = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const secondary = core.createAdditionalSurface("Surf Ace", { height: 700, scale: 1, width: 1000 });
  applyProviderBootstrap(core, primary.surfaceId, 3);
  core.applyProviderBootstrapTopology(secondary.surfaceId, {
    initialPaneId: 5,
    initialPaneLabel: 17,
    windowLabel: "d",
  });
  core.contentSet(secondary.surfaceId, {
    content: { markdown: "# recovered" },
    contentId: "ct_recovered" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_recovered" as never,
    paneId: 5 as never,
    revision: 1 as Revision,
  });

  const persistentState = core.getPersistentState();
  const restoredCore = new SurfaceCore({ persistentState });
  const restoredSurfaces = restoredCore.restorePersistedSurfaces("Surf Ace", { height: 800, scale: 2, width: 1200 });

  assert.deepEqual(
    restoredSurfaces.map((surface) => restoredCore.getRendererWindowState(surface.surfaceId).panes.length),
    [1, 1],
  );
  const restoredSecondary = restoredCore.getRendererWindowState(secondary.surfaceId);
  assert.equal(restoredSecondary.panes[0]?.paneId, 5);
  assert.equal(restoredSecondary.panes[0]?.label, "17");
  assert.equal(restoredSecondary.panes[0]?.content.contentId, "ct_recovered");
  assert.equal(restoredSecondary.panes[0]?.content.contentType, "markdown");
});

test("surface core rejects persisted surfaces with invalid pane history", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  applyProviderBootstrap(core, surface.surfaceId, 3);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# recovered" },
    contentId: "ct_recovered" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_recovered" as never,
    paneId: 3 as never,
    revision: 1 as Revision,
  });

  const persistentState = core.getPersistentState();
  persistentState.surfaces![0]!.panes[0]!.history = [];
  const restoredCore = new SurfaceCore({ persistentState });
  const restoredSurfaces = restoredCore.restorePersistedSurfaces("Surf Ace", { height: 800, scale: 2, width: 1200 });

  assert.deepEqual(restoredSurfaces, []);
  assert.deepEqual(restoredCore.listSurfaces(), []);
});

test("surface core rejects persisted surfaces with partially restorable pane topology", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const initialPaneId = applyProviderBootstrap(core, surface.surfaceId, 3);
  core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "horizontal",
    newPaneIds: [5],
    newPaneLabels: [5],
    paneId: initialPaneId,
  });

  const invalidPaneOrderState = core.getPersistentState();
  invalidPaneOrderState.surfaces![0]!.paneOrder = [3, 404];
  const invalidPaneOrderCore = new SurfaceCore({ persistentState: invalidPaneOrderState });
  assert.deepEqual(
    invalidPaneOrderCore.restorePersistedSurfaces("Surf Ace", { height: 800, scale: 2, width: 1200 }),
    [],
  );

  const invalidLayoutState = core.getPersistentState();
  invalidLayoutState.surfaces![0]!.layout = { paneId: 404, type: "pane" };
  const invalidLayoutCore = new SurfaceCore({ persistentState: invalidLayoutState });
  assert.deepEqual(
    invalidLayoutCore.restorePersistedSurfaces("Surf Ace", { height: 800, scale: 2, width: 1200 }),
    [],
  );
});

test("surface core persists and restores local window placement without changing surface identity", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  applyProviderBootstrap(core, surface.surfaceId, 3);

  core.setWindowPlacement(surface.surfaceId, {
    bounds: { height: 768, width: 1024, x: 44, y: 88 },
    displayId: 7,
    fullscreen: true,
  });

  const persistentState = core.getPersistentState();
  const restoredCore = new SurfaceCore({ persistentState });
  const restoredSurfaces = restoredCore.restorePersistedSurfaces("Surf Ace", { height: 800, scale: 2, width: 1200 });

  assert.deepEqual(restoredSurfaces.map((restored) => restored.surfaceId), [surface.surfaceId]);
  assert.deepEqual(restoredCore.getWindowPlacement(surface.surfaceId), {
    bounds: { height: 768, width: 1024, x: 44, y: 88 },
    displayId: 7,
    fullscreen: true,
  });
});

test("surface core does not restore a closed stale primary over remaining windows", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const primary = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const secondary = core.createAdditionalSurface("Surf Ace", { height: 700, scale: 1, width: 1000 });
  applyProviderBootstrap(core, primary.surfaceId, 3);
  core.applyProviderBootstrapTopology(secondary.surfaceId, {
    initialPaneId: 5,
    initialPaneLabel: 17,
    windowLabel: "d",
  });
  core.removeSurface(primary.surfaceId);

  const persistentState = core.getPersistentState();
  assert.equal(persistentState.primarySurfaceId, primary.surfaceId);
  assert.deepEqual(persistentState.surfaces?.map((record) => record.surfaceId), [secondary.surfaceId]);

  const restoredCore = new SurfaceCore({ persistentState });
  const restoredSurfaces = restoredCore.restorePersistedSurfaces("Surf Ace", { height: 800, scale: 2, width: 1200 });

  assert.deepEqual(restoredSurfaces.map((surface) => surface.surfaceId), [secondary.surfaceId]);
  assert.deepEqual(restoredCore.listSurfaces().map((surface) => surface.surfaceId), [secondary.surfaceId]);
  assert.equal(restoredCore.getPersistentState().primarySurfaceId, secondary.surfaceId);
});

test("surface core tracks the active keyboard pane and falls back when it closes", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const initialPaneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  core.paneSplit(surface.surfaceId, {
    count: 3,
    direction: "horizontal",
    newPaneIds: [9, 11],
    newPaneLabels: [9, 11],
    paneId: initialPaneId,
  });

  assert.equal(core.activeKeyboardPaneId(surface.surfaceId), initialPaneId);
  core.setActiveKeyboardPane(surface.surfaceId, 11);
  let windowState = core.getRendererWindowState(surface.surfaceId);
  assert.deepEqual(
    windowState.panes.map((pane) => [pane.paneId, pane.activeKeyboardPane]),
    [
      [initialPaneId, false],
      [9, false],
      [11, true],
    ],
  );

  core.paneClose(surface.surfaceId, 11);
  windowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(core.activeKeyboardPaneId(surface.surfaceId), initialPaneId);
  assert.deepEqual(
    windowState.panes.map((pane) => [pane.paneId, pane.activeKeyboardPane]),
    [
      [initialPaneId, true],
      [9, false],
    ],
  );
});

test("surface core navigates the active keyboard pane by resolved geometry", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const initialPaneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "vertical",
    newPaneIds: [9],
    newPaneLabels: [9],
    paneId: initialPaneId,
  });
  core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "horizontal",
    newPaneIds: [11],
    newPaneLabels: [11],
    paneId: initialPaneId,
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, initialPaneId, {
    bounds: { height: 400, width: 600, x: 0, y: 0 },
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, 11, {
    bounds: { height: 400, width: 600, x: 0, y: 400 },
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, 9, {
    bounds: { height: 800, width: 600, x: 600, y: 0 },
  });

  assert.equal(core.activeKeyboardPaneId(surface.surfaceId), initialPaneId);
  assert.equal(core.navigateActiveKeyboardPane(surface.surfaceId, "right"), 9);
  assert.equal(core.activeKeyboardPaneId(surface.surfaceId), 9);
  assert.equal(core.navigateActiveKeyboardPane(surface.surfaceId, "left"), initialPaneId);
  assert.equal(core.navigateActiveKeyboardPane(surface.surfaceId, "down"), 11);
  assert.equal(core.activeKeyboardPaneId(surface.surfaceId), 11);
  assert.equal(core.navigateActiveKeyboardPane(surface.surfaceId, "up"), initialPaneId);
  assert.equal(core.navigateActiveKeyboardPane(surface.surfaceId, "left"), null);
});

test("surface core preserves resize weights in topology and renderer geometry", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  applyProviderBootstrap(core, surface.surfaceId, 7);

  const events: string[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event.type));
  try {
    core.topologyApply(surface.surfaceId, {
      layout: {
        children: [
          { paneId: 7 as never, type: "pane", weight: 3 },
          { paneId: 9 as never, type: "pane", weight: 1 },
        ],
        direction: "vertical",
        type: "split",
      },
      panes: [
        { name: null, paneId: 7 as never, paneLabel: 1 },
        { name: null, paneId: 9 as never, paneLabel: 2 },
      ],
      topologyRevision: 1 as never,
      windowLabel: "a",
    });

    const state = core.getRendererWindowState(surface.surfaceId);
    assert.deepEqual(state.layout, {
      children: [
        { paneId: 7, type: "pane", weight: 3 },
        { paneId: 9, type: "pane", weight: 1 },
      ],
      direction: "vertical",
      type: "split",
    });
    updateResolvedPaneSnapshot(core, surface.surfaceId, 7, {
      bounds: { height: 800, width: 900, x: 0, y: 0 },
    });
    updateResolvedPaneSnapshot(core, surface.surfaceId, 9, {
      bounds: { height: 800, width: 300, x: 900, y: 0 },
    });
    assert.deepEqual(
      core.panesList(surface.surfaceId).panes.map((pane) => pane.viewport),
      [
        { height: 800, scale: 2, width: 900 },
        { height: 800, scale: 2, width: 300 },
      ],
    );

    core.resizeSplit(surface.surfaceId, [], [1, 3]);
    assert.equal(core.topologyState(surface.surfaceId).topologyRevision, 2);
    assert.deepEqual(core.topologyState(surface.surfaceId).layout, {
      children: [
        { paneId: 7, type: "pane", weight: 1 },
        { paneId: 9, type: "pane", weight: 3 },
      ],
      direction: "vertical",
      type: "split",
    });
    assert.ok(events.includes("topology-changed"));
    updateResolvedPaneSnapshot(core, surface.surfaceId, 7, {
      bounds: { height: 800, width: 300, x: 0, y: 0 },
    });
    updateResolvedPaneSnapshot(core, surface.surfaceId, 9, {
      bounds: { height: 800, width: 900, x: 300, y: 0 },
    });

    const nativePane = core.panesList(surface.surfaceId).panes.find((pane) => Number(pane.paneId) === 7)!;
    core.markNativePaneMaterialized(surface.surfaceId, {
      op: "native_pane.host",
      panes: [
        {
          id: "7",
          binding_id: "7:target_top",
          content_id: "target_top",
          geometry: {
            coordinateSpace: "compositor_logical",
            geometryRevision: nativePane.geometry.geometryRevision,
            height: nativePane.geometry.contentViewport.height,
            paneInstanceId: nativePane.geometry.paneInstanceId,
            surfaceEpoch: nativePane.geometry.surfaceEpoch,
            topologyEpoch: nativePane.geometry.topologyEpoch,
            width: nativePane.geometry.contentViewport.width,
            x: nativePane.geometry.contentViewport.x,
            y: nativePane.geometry.contentViewport.y,
          },
          process: { args: ["top"], command: "top" },
          revision: 1 as Revision,
          target: "terminal",
        },
      ],
    });

    core.resizeSplit(surface.surfaceId, [], [2, 2]);
    updateResolvedPaneSnapshot(core, surface.surfaceId, 7, {
      bounds: { height: 800, width: 600, x: 0, y: 0 },
    });
    updateResolvedPaneSnapshot(core, surface.surfaceId, 9, {
      bounds: { height: 800, width: 600, x: 600, y: 0 },
    });
    const projectedResize = core.projectCurrentNativePaneGeometry(surface.surfaceId, [7]);
    const resizedPane = core.panesList(surface.surfaceId).panes.find((pane) => Number(pane.paneId) === 7)!;
    assert.equal(projectedResize.panes[0]?.id, "7");
    assert.equal(projectedResize.panes[0]?.geometry.width, 600);
    assert.equal(projectedResize.panes[0]?.geometry.geometryRevision, resizedPane.geometry.geometryRevision);
    assert.equal(projectedResize.overlaySet.revision, resizedPane.geometry.geometryRevision);
    assert.equal(projectedResize.overlaySet.topologyEpoch, resizedPane.geometry.topologyEpoch);
  } finally {
    unsubscribe();
  }
});

test("surface core renders the visible pane label separately from paneId", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: 7,
    initialPaneLabel: 41,
    windowLabel: "a",
  });

  const windowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(windowState.panes[0]?.paneId, 7);
  assert.equal(windowState.panes[0]?.label, "41");
  assert.equal(windowState.panes[0]?.displayId, "41");
  assert.equal(windowState.panes[0]?.visibleAddress, "41");

  core.paneRename(surface.surfaceId, 7, "Notes");
  const renamedState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(renamedState.panes[0]?.name, "Notes");
  assert.equal(renamedState.panes[0]?.label, "41");
  assert.equal(renamedState.panes[0]?.displayId, "41");
  assert.equal(renamedState.panes[0]?.visibleAddress, "41");
});

test("surface core never projects window-letter composites as pane display ids", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: 16,
    initialPaneLabel: 16,
    windowLabel: "e",
  });

  const pane = core.getRendererWindowState(surface.surfaceId).panes[0];
  assert.equal(core.getRendererWindowState(surface.surfaceId).windowLabel, "e");
  assert.equal(pane?.displayId, "16");
  assert.equal(pane?.visibleAddress, "16");
  assert.notEqual(pane?.displayId, "e16");
  assert.notEqual(pane?.displayId, "e1");
  assert.notEqual(pane?.displayId, "b13");
  assert.doesNotMatch(pane?.displayId ?? "", /^[a-z]+\d+$/i);
});

test("same pane id, different initial pane label - Electron bootstrap enforces provider label", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: 7,
    initialPaneLabel: 7,
    windowLabel: "a",
  });
  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: 7,
    initialPaneLabel: 41,
    windowLabel: "a",
  });

  const windowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(windowState.panes[0]?.paneId, 7);
  assert.equal(windowState.panes[0]?.label, "41");
});

test("surface core ignores snapshot updates for stale pane ids", () => {
  const warnings: string[] = [];
  const core = new SurfaceCore({
    logger: {
      warn: (message: string) => {
        warnings.push(message);
      },
    },
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  assert.doesNotThrow(() => {
    updateResolvedPaneSnapshot(core, surface.surfaceId, 819, {
      visibleText: "stale",
    });
  });
  assert.ok(warnings.some((warning) => warning.includes("unknown pane 819")));
});

test("surface core falls back to authoritative html text when renderer snapshot is still empty", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  core.contentSet(surface.surfaceId, {
    content: { html: "<html><body><h1>pane two</h1><p>ready</p></body></html>" },
    contentId: "ct_html" as never,
    contentType: "html",
    historyOwnerToken: "hot_html",
    paneId: paneId as never,
    revision: 1 as never,
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, paneId, {
    visibleText: "",
  });

  const snapshot = core.captureSnapshot(surface.surfaceId, paneId);
  assert.equal(snapshot.visibleText, "pane two\nready");
});

test("surface core starts browser_url targets without reporting unverified navigation as applied", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  const paneLineageId = core.pairState(surface.surfaceId).panes[0]!.paneLineageId;

  const result = core.targetApply(surface.surfaceId, {
    paneLineageId,
    requestId: "tr_test",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: "https://google.com/",
    },
    targetId: "tg_google",
    targetKind: "browser_url",
    targetPayload: { url: "https://google.com/" },
    display: {
      provenance: {
        displayName: "Browser Pusher",
        sessionKey: "agent:test:browser",
      },
      title: "Browser Pusher",
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "materialization_failed");
  assert.equal(result.materializedState?.navigationStatus, "started_unverified");
  const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(pane.content.contentType, "browser_url");
  assert.deepEqual(pane.content.content, { url: "https://google.com/" });
  assert.equal(pane.ownerName, "Browser Pusher");
  assert.equal(pane.provenanceName, "Browser Pusher");
  const snapshot = core.captureSnapshot(surface.surfaceId, paneId);
  assert.equal(snapshot.contentId, null);
  assert.equal(snapshot.contentType, null);
});

test("surface core persists browser_url renderer history across restart", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  const paneLineageId = core.pairState(surface.surfaceId).panes[0]!.paneLineageId;

  core.targetApply(surface.surfaceId, {
    paneLineageId,
    requestId: "tr_test",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: "https://google.com/",
    },
    targetId: "tg_google",
    targetKind: "browser_url",
    targetPayload: { url: "https://google.com/" },
  });

  const restoredCore = new SurfaceCore({ persistentState: core.getPersistentState() });
  restoredCore.restorePersistedSurfaces("Surf Ace", { height: 800, scale: 2, width: 1200 });

  const restoredPane = restoredCore.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(restoredPane.content.contentType, "browser_url");
  assert.equal(restoredPane.content.contentId, "tg_google");
  assert.deepEqual(restoredPane.content.content, { url: "https://google.com/" });
});

test("surface core exposes reload only for browser_url and file-backed content", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  const paneLineageId = core.pairState(surface.surfaceId).panes[0]!.paneLineageId;

  core.contentSet(surface.surfaceId, {
    content: { html: "<p>raw</p>" },
    contentId: "ct_11111111" as never,
    contentType: "html",
    historyOwnerToken: "hot_html",
    paneId: paneId as never,
    revision: 1 as never,
  });
  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]!.content.reloadable, false);

  core.contentSet(surface.surfaceId, {
    content: { html: "<p>file</p>" },
    contentId: "ct_22222222" as never,
    contentType: "html",
    historyOwnerToken: "hot_html",
    paneId: paneId as never,
    reloadSource: { kind: "file", path: "/tmp/source.html" },
    revision: 2 as never,
  });
  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]!.content.reloadable, true);
  assert.deepEqual(core.reloadSource(surface.surfaceId, paneId), { kind: "file", path: "/tmp/source.html" });

  core.targetApply(surface.surfaceId, {
    paneLineageId,
    requestId: "tr_browser",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 3,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: "https://example.com/",
    },
    targetId: "target_browser",
    targetKind: "browser_url",
    targetPayload: { url: "https://example.com/" },
  });
  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]!.content.reloadable, true);

  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  core.markNativePaneMaterialized(surface.surfaceId, {
    op: "native_pane.host",
    panes: [
      {
        id: String(paneId),
        binding_id: `${paneId}:target_top`,
        content_id: "target_top",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: listedPane.geometry.geometryRevision,
          height: listedPane.geometry.contentViewport.height,
          paneInstanceId: listedPane.geometry.paneInstanceId,
          surfaceEpoch: listedPane.geometry.surfaceEpoch,
          topologyEpoch: listedPane.geometry.topologyEpoch,
          width: listedPane.geometry.contentViewport.width,
          x: listedPane.geometry.contentViewport.x,
          y: listedPane.geometry.contentViewport.y,
        },
        process: { args: ["top"], command: "top" },
        revision: 4 as Revision,
        target: "terminal",
      },
    ],
  });
  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]!.content.reloadable, false);
});

test("surface core promotes html navigation into browser_url history with normalized URL", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  core.contentSet(surface.surfaceId, {
    content: { html: "<a href=\"/docs#intro\">docs</a>" },
    contentId: "ct_html" as never,
    contentType: "html",
    historyOwnerToken: "hot_html",
    paneId: paneId as never,
    revision: 1 as never,
  });

  const navigation = core.applyNavigation(surface.surfaceId, paneId, "https://example.com/docs#intro");
  assert.deepEqual(navigation, {
    blocked: false,
    contentId: "ct_html",
    revision: 1,
    url: "https://example.com/docs#intro",
  });

  const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(pane.content.contentId, "ct_html");
  assert.equal(pane.content.contentType, "browser_url");
  assert.deepEqual(pane.content.content, { url: "https://example.com/docs#intro" });
  assert.equal(pane.canGoBack, true);
});

test("surface core reloads file-backed content without changing content identity or revision", () => {
  const core = new SurfaceCore({
    now: () => 2000,
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  core.contentSet(surface.surfaceId, {
    content: { html: "<p>before</p>" },
    contentId: "ct_11111111" as never,
    contentType: "html",
    historyOwnerToken: "hot_html",
    paneId: paneId as never,
    reloadSource: { kind: "file", path: "/tmp/source.html" },
    revision: 1 as never,
  });

  core.replaceCurrentContentFromReloadSource(surface.surfaceId, paneId, { html: "<p>after</p>" });

  const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(pane.content.contentId, "ct_11111111");
  assert.equal(pane.content.revision, 1);
  assert.deepEqual(pane.content.content, { html: "<p>after</p>" });
});

test("surface core blocks file-backed reload while annotating", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  core.contentSet(surface.surfaceId, {
    content: { html: "<p>before</p>" },
    contentId: "ct_11111111" as never,
    contentType: "html",
    historyOwnerToken: "hot_html",
    paneId: paneId as never,
    reloadSource: { kind: "file", path: "/tmp/source.html" },
    revision: 1 as never,
  });
  core.setAnnotating(surface.surfaceId, paneId, true);

  assert.equal(core.reloadSource(surface.surfaceId, paneId), null);
  core.replaceCurrentContentFromReloadSource(surface.surfaceId, paneId, { html: "<p>after</p>" });

  const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.deepEqual(pane.content.content, { html: "<p>before</p>" });
  assert.equal(pane.toast, "Finish annotation (Done) to navigate");
});

test("surface core ignores file-backed reload when current entry changed", () => {
  let now = 3000;
  const core = new SurfaceCore({
    now: () => now++,
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  core.contentSet(surface.surfaceId, {
    content: { html: "<p>before</p>" },
    contentId: "ct_11111111" as never,
    contentType: "html",
    historyOwnerToken: "hot_html",
    paneId: paneId as never,
    reloadSource: { kind: "file", path: "/tmp/source.html" },
    revision: 1 as never,
  });
  const staleRenderVersion = core.getRendererWindowState(surface.surfaceId).panes[0]!.content.renderVersion;

  core.contentSet(surface.surfaceId, {
    content: { html: "<p>newer</p>" },
    contentId: "ct_22222222" as never,
    contentType: "html",
    historyOwnerToken: "hot_html",
    paneId: paneId as never,
    reloadSource: { kind: "file", path: "/tmp/newer.html" },
    revision: 2 as never,
  });

  core.replaceCurrentContentFromReloadSource(
    surface.surfaceId,
    paneId,
    { html: "<p>stale</p>" },
    {
      contentId: "ct_11111111",
      contentType: "html",
      reloadSource: { kind: "file", path: "/tmp/source.html" },
      renderVersion: staleRenderVersion,
      revision: 1,
    },
  );

  const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(pane.content.contentId, "ct_22222222");
  assert.equal(pane.content.revision, 2);
  assert.deepEqual(pane.content.content, { html: "<p>newer</p>" });
});

test("surface core clears browser_url renderer content when native pane materializes", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  const paneLineageId = core.pairState(surface.surfaceId).panes[0]!.paneLineageId;

  core.targetApply(surface.surfaceId, {
    paneLineageId,
    requestId: "tr_browser",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 6,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: "https://example.com/",
    },
    targetId: "target_browser",
    targetKind: "browser_url",
    targetPayload: { url: "https://example.com/" },
  });
  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]!.content.contentType, "browser_url");

  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  core.markNativePaneMaterialized(surface.surfaceId, {
    op: "native_pane.host",
    panes: [
      {
        id: String(paneId),
        binding_id: `${paneId}:target_top`,
        content_id: "target_top",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: listedPane.geometry.geometryRevision,
          height: listedPane.geometry.contentViewport.height,
          paneInstanceId: listedPane.geometry.paneInstanceId,
          surfaceEpoch: listedPane.geometry.surfaceEpoch,
          topologyEpoch: listedPane.geometry.topologyEpoch,
          width: listedPane.geometry.contentViewport.width,
          x: listedPane.geometry.contentViewport.x,
          y: listedPane.geometry.contentViewport.y,
        },
        process: { args: ["top"], command: "top" },
        revision: 2 as Revision,
        target: "terminal",
      },
    ],
  });

  const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(pane.externalNative, true);
  assert.equal(pane.content.content, null);
  assert.equal(pane.content.contentId, null);
  assert.equal(pane.content.contentType, null);
  assert.equal(pane.content.revision, 6);
  assert.equal(core.panesList(surface.surfaceId).panes[0]!.activeContentId, null);
  assert.equal(core.panesList(surface.surfaceId).panes[0]!.contentType, null);
});

test("surface core rejects browser_url targets while the pane is native-hosted", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  resolvePaneSnapshot(core, surface.surfaceId, paneId);
  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  const launchToken = `${surface.surfaceId}:${paneId}:target_top:1`;
  const materialization: NativePaneMaterialization = {
    op: "native_pane.host",
    panes: [
      {
        id: String(paneId),
        binding_id: `${paneId}:target_top`,
        content_id: "target_top",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: listedPane.geometry.geometryRevision,
          height: listedPane.geometry.contentViewport.height,
          paneInstanceId: listedPane.geometry.paneInstanceId,
          surfaceEpoch: listedPane.geometry.surfaceEpoch,
          topologyEpoch: listedPane.geometry.topologyEpoch,
          width: listedPane.geometry.contentViewport.width,
          x: listedPane.geometry.contentViewport.x,
          y: listedPane.geometry.contentViewport.y,
        },
        process: { args: ["top"], command: "top" },
        revision: 1 as Revision,
        target: "terminal",
      },
    ],
  };
  core.markNativePaneMaterialized(surface.surfaceId, materialization);
  const paneLineageId = core.pairState(surface.surfaceId).panes[0]!.paneLineageId;

  const result = core.targetApply(surface.surfaceId, {
    paneLineageId,
    requestId: "tr_test",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: "https://example.com/",
    },
    targetId: "tg_example",
    targetKind: "browser_url",
    targetPayload: { url: "https://example.com/" },
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.errorCode, "materialization_failed");
  assert.match(result.message, /native-hosted pane/);
  const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(pane.externalNative, true);
  assert.equal(pane.content.contentType, null);
});

test("surface core rejects stale native materialization identity after geometry revision changes", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  resolvePaneSnapshot(core, surface.surfaceId, paneId);
  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  const launchToken = `${surface.surfaceId}:${paneId}:target_top:1`;
  const materialization: NativePaneMaterialization = {
    op: "native_pane.host",
    panes: [
      {
        id: String(paneId),
        binding_id: `${paneId}:target_top`,
        content_id: "target_top",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: listedPane.geometry.geometryRevision,
          height: listedPane.geometry.contentViewport.height,
          paneInstanceId: listedPane.geometry.paneInstanceId,
          surfaceEpoch: listedPane.geometry.surfaceEpoch,
          topologyEpoch: listedPane.geometry.topologyEpoch,
          width: listedPane.geometry.contentViewport.width,
          x: listedPane.geometry.contentViewport.x,
          y: listedPane.geometry.contentViewport.y,
        },
        process: { args: ["top"], command: "top" },
        revision: 1 as Revision,
        target: "terminal",
      },
    ],
  };

  core.contentSet(surface.surfaceId, {
    content: { markdown: "# replacement" },
    contentId: "ct_replacement" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_replacement",
    paneId: paneId as never,
    revision: 1 as never,
  });
  resolvePaneSnapshot(core, surface.surfaceId, paneId);

  assert.equal(
    core.validateNativePaneMaterializationLayout(surface.surfaceId, materialization),
    `native pane ${paneId} geometry identity does not match resolved Surf Ace pane geometry`,
  );
});

test("surface core projects native topology overlay identity from accepted topology payload", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  resolvePaneSnapshot(core, surface.surfaceId, paneId);
  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  core.markNativePaneMaterialized(surface.surfaceId, {
    op: "native_pane.host",
    panes: [
      {
        id: String(paneId),
        binding_id: `${paneId}:target_top`,
        content_id: "target_top",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: listedPane.geometry.geometryRevision,
          height: listedPane.geometry.contentViewport.height,
          paneInstanceId: listedPane.geometry.paneInstanceId,
          surfaceEpoch: listedPane.geometry.surfaceEpoch,
          topologyEpoch: listedPane.geometry.topologyEpoch,
          width: listedPane.geometry.contentViewport.width,
          x: listedPane.geometry.contentViewport.x,
          y: listedPane.geometry.contentViewport.y,
        },
        process: { args: ["top"], command: "top" },
        revision: 1 as Revision,
        target: "terminal",
      },
    ],
  });

  core.topologyApply(surface.surfaceId, {
    layout: {
      children: [
        { paneId: paneId as never, type: "pane" },
        { paneId: 9 as never, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    },
    panes: [
      { name: "Docs", paneId: paneId as never, paneLabel: 7 },
      { name: "Other", paneId: 9 as never, paneLabel: 8 },
    ],
    topologyRevision: 2 as never,
    windowLabel: "docs",
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, paneId, {
    bounds: { height: 400, width: 1200, x: 0, y: 0 },
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, 9, {
    bounds: { height: 400, width: 1200, x: 0, y: 400 },
  });
  const projected = core.projectCurrentNativePaneGeometry(surface.surfaceId, [paneId]);

  assert.equal(projected.overlaySet.windowId, "docs");
});

test("surface core resyncs native topology overlays on window relabel without geometry changes", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  resolvePaneSnapshot(core, surface.surfaceId, paneId);
  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  core.markNativePaneMaterialized(surface.surfaceId, {
    op: "native_pane.host",
    panes: [
      {
        id: String(paneId),
        binding_id: `${paneId}:target_top`,
        content_id: "target_top",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: listedPane.geometry.geometryRevision,
          height: listedPane.geometry.contentViewport.height,
          paneInstanceId: listedPane.geometry.paneInstanceId,
          surfaceEpoch: listedPane.geometry.surfaceEpoch,
          topologyEpoch: listedPane.geometry.topologyEpoch,
          width: listedPane.geometry.contentViewport.width,
          x: listedPane.geometry.contentViewport.x,
          y: listedPane.geometry.contentViewport.y,
        },
        process: { args: ["top"], command: "top" },
        revision: 1 as Revision,
        target: "terminal",
      },
    ],
  });

  const beforeRevision = core.panesList(surface.surfaceId).panes[0]!.geometry.geometryRevision;
  core.topologyApply(surface.surfaceId, {
    layout: { paneId: paneId as never, type: "pane" },
    panes: [
      { name: "Docs", paneId: paneId as never, paneLabel: 7 },
    ],
    topologyRevision: 2 as never,
    windowLabel: "b",
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, paneId, {
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
  });
  const projected = core.projectCurrentNativePaneGeometry(surface.surfaceId, [paneId]);

  assert.equal(projected.overlaySet.windowId, "b");
  assert.deepEqual(projected.panes.map((pane) => pane.id), [String(paneId)]);
  assert.equal(projected.panes[0]!.geometry.geometryRevision, Number(beforeRevision) + 1);
  assert.equal(core.panesList(surface.surfaceId).panes[0]!.geometry.geometryRevision, Number(beforeRevision) + 1);
});

test("surface core advances native overlay revision on label-only provider resume relabel", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  resolvePaneSnapshot(core, surface.surfaceId, paneId);
  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  core.markNativePaneMaterialized(surface.surfaceId, {
    op: "native_pane.host",
    panes: [
      {
        id: String(paneId),
        binding_id: `${paneId}:target_top`,
        content_id: "target_top",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: listedPane.geometry.geometryRevision,
          height: listedPane.geometry.contentViewport.height,
          paneInstanceId: listedPane.geometry.paneInstanceId,
          surfaceEpoch: listedPane.geometry.surfaceEpoch,
          topologyEpoch: listedPane.geometry.topologyEpoch,
          width: listedPane.geometry.contentViewport.width,
          x: listedPane.geometry.contentViewport.x,
          y: listedPane.geometry.contentViewport.y,
        },
        process: { args: ["top"], command: "top" },
        revision: 1 as Revision,
        target: "terminal",
      },
    ],
  });

  const beforeRevision = core.panesList(surface.surfaceId).panes[0]!.geometry.geometryRevision;
  core.applyWindowLabelOnly(surface.surfaceId, "b");
  updateResolvedPaneSnapshot(core, surface.surfaceId, paneId, {
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
  });
  const projected = core.projectCurrentNativePaneGeometry(surface.surfaceId, [paneId]);

  assert.equal(projected.overlaySet.windowId, "b");
  assert.equal(projected.panes[0]?.geometry.geometryRevision, Number(beforeRevision) + 1);

  const windowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(windowState.windowLabel, "b");
  assert.equal(core.panesList(surface.surfaceId).panes[0]!.geometry.geometryRevision, Number(beforeRevision) + 1);
});

test("surface core records confirmed browser_url navigation success evidence", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  const paneLineageId = core.pairState(surface.surfaceId).panes[0]!.paneLineageId;
  core.targetApply(surface.surfaceId, {
    paneLineageId,
    requestId: "tr_test",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: "https://google.com/",
    },
    targetId: "tg_google",
    targetKind: "browser_url",
    targetPayload: { url: "https://google.com/" },
  });

  const result = core.completeBrowserUrlNavigation(surface.surfaceId, paneId, {
    status: "applied",
    targetId: "tg_google",
    url: "https://google.com/",
  });

  assert.equal(result?.status, "applied");
  assert.equal(result?.materializedState?.navigationStatus, "loaded");
  const pairTarget = core.pairState(surface.surfaceId).panes[0]!.currentTarget;
  assert.equal(pairTarget?.lastApplyEvidence?.status, "applied");
  assert.equal(pairTarget?.lastApplyEvidence?.materializedState?.navigationStatus, "loaded");
  const listedTarget = core.panesList(surface.surfaceId).panes[0]!.currentTarget;
  assert.equal(listedTarget?.lastApplyEvidence?.status, "applied");
  assert.equal(listedTarget?.lastApplyEvidence?.materializedState?.navigationStatus, "loaded");
});

test("surface core records confirmed browser_url navigation failure evidence", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  const paneLineageId = core.pairState(surface.surfaceId).panes[0]!.paneLineageId;
  core.targetApply(surface.surfaceId, {
    paneLineageId,
    requestId: "tr_test",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: "https://blocked.invalid/",
    },
    targetId: "tg_blocked",
    targetKind: "browser_url",
    targetPayload: { url: "https://blocked.invalid/" },
  });

  const result = core.completeBrowserUrlNavigation(surface.surfaceId, paneId, {
    errorMessage: "Blocked",
    status: "failed",
    targetId: "tg_blocked",
    url: "https://blocked.invalid/",
  });

  assert.equal(result?.status, "failed");
  assert.equal(result?.errorCode, "materialization_failed");
  assert.equal(result?.materializedState?.navigationStatus, "failed");
});

test("surface core rejects browser_url target when live browser capability is not requested", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  applyProviderBootstrap(core, surface.surfaceId, 7);
  const paneLineageId = core.pairState(surface.surfaceId).panes[0]!.paneLineageId;

  const result = core.targetApply(surface.surfaceId, {
    paneLineageId,
    requestId: "tr_test",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "bytes",
      requiredCapabilities: ["target.html.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: "https://google.com/",
    },
    targetId: "tg_google",
    targetKind: "browser_url",
    targetPayload: { url: "https://google.com/" },
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.errorCode, "capability_missing");
});

test("surface core rejects browser_url target with unsupported extra required capability", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  applyProviderBootstrap(core, surface.surfaceId, 7);
  const paneLineageId = core.pairState(surface.surfaceId).panes[0]!.paneLineageId;

  const result = core.targetApply(surface.surfaceId, {
    paneLineageId,
    requestId: "tr_test",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1", "target.future_only.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: "https://example.com/",
    },
    targetId: "tg_future",
    targetKind: "browser_url",
    targetPayload: { url: "https://example.com/" },
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.errorCode, "capability_missing");
  assert.equal(core.pairState(surface.surfaceId).panes[0]!.currentTarget ?? null, null);
});

test("surface core rejects browser_url targets for non-web schemes", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  applyProviderBootstrap(core, surface.surfaceId, 7);
  const paneLineageId = core.pairState(surface.surfaceId).panes[0]!.paneLineageId;

  const result = core.targetApply(surface.surfaceId, {
    paneLineageId,
    requestId: "tr_test",
    restoreReason: "initial_apply",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 1,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "navigate",
      requiredCapabilities: ["target.browser_url.v1"],
      safeToLogFields: ["url"],
      safetyClass: "network",
      summary: "file:///etc/passwd",
    },
    targetId: "tg_file",
    targetKind: "browser_url",
    targetPayload: { url: "file:///etc/passwd" },
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.errorCode, "unsafe_payload");
});

test("surface core treats stale pane access as best-effort instead of crashing", () => {
  const warnings: string[] = [];
  const core = new SurfaceCore({
    logger: {
      warn: (message: string) => {
        warnings.push(message);
      },
    },
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  applyProviderBootstrap(core, surface.surfaceId, 7);

  assert.equal(core.paneBounds(surface.surfaceId, 819), null);
  assert.doesNotThrow(() => {
    core.noteTap(surface.surfaceId, 819);
  });
  assert.equal(
    core.buildDrawingFlush(surface.surfaceId, 819, { idleWindowMs: 8000, maxIntervalMs: 30000 }, "idle_window"),
    null,
  );
  assert.ok(warnings.some((warning) => warning.includes("unknown pane 819")));
});

test("surface core rejects video and canvas content types with unsupported_content_type", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 5);

  assert.throws(
    () =>
      core.contentSet(surface.surfaceId, {
        content: "about:blank",
        contentId: "ct_video" as never,
        contentType: "video",
        historyOwnerToken: "hot_video",
        paneId: paneId as never,
        revision: 1 as never,
      }),
    (err: unknown) => {
      return err instanceof SurfaceCoreError && err.code === "unsupported_content_type";
    },
  );

  assert.throws(
    () =>
      core.contentSet(surface.surfaceId, {
        content: { color: "#fff", grid: true },
        contentId: "ct_canvas" as never,
        contentType: "canvas",
        historyOwnerToken: "hot_canvas",
        paneId: paneId as never,
        revision: 1 as never,
      }),
    (err: unknown) => {
      return err instanceof SurfaceCoreError && err.code === "unsupported_content_type";
    },
  );

  assert.equal(core.supportsContentType("video"), false);
  assert.equal(core.supportsContentType("canvas"), false);
});

test("surface core assigns pane history and split topology", () => {
  const core = new SurfaceCore({
    now: () => 1000,
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const initialPaneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  const split = core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "horizontal",
    newPaneIds: [9],
    newPaneLabels: [9],
    paneId: initialPaneId,
  });

  assert.deepEqual(split.panes.map((pane) => pane.paneId), [initialPaneId, 9]);
  updateResolvedPaneSnapshot(core, surface.surfaceId, initialPaneId, {
    bounds: { height: 400, width: 1200, x: 0, y: 0 },
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, 9, {
    bounds: { height: 400, width: 1200, x: 0, y: 400 },
  });
  const paneViewports = core.panesList(surface.surfaceId).panes.map((pane) => pane.viewport);
  assert.deepEqual(paneViewports, [
    { height: 400, scale: 2, width: 1200 },
    { height: 400, scale: 2, width: 1200 },
  ]);

  core.contentSet(surface.surfaceId, {
    content: { markdown: "# First" },
    contentId: "ct_a1b2c3d4" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_session_a",
    paneId: initialPaneId as never,
    revision: 1 as never,
  });
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Second" },
    contentId: "ct_b1b2c3d4" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_session_b",
    paneId: initialPaneId as never,
    revision: 2 as never,
  });

  core.navigateHistory(surface.surfaceId, initialPaneId, "back");

  const windowState = core.getRendererWindowState(surface.surfaceId);
  const firstPane = windowState.panes.find((pane) => pane.paneId === initialPaneId)!;
  assert.equal(firstPane.content.contentId, "ct_a1b2c3d4");
  assert.equal(firstPane.canGoForward, true);
});

test("surface core topology.apply reuses existing pane content and replaces provisional layout", () => {
  const core = new SurfaceCore({
    now: () => 1000,
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const initialPaneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Preserved" },
    contentId: "ct_preserved" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_session_a",
    paneId: initialPaneId as never,
    revision: 1 as never,
  });

  const applied = core.topologyApply(surface.surfaceId, {
    layout: {
      children: [
        { paneId: initialPaneId as never, type: "pane" },
        { paneId: 9 as never, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    },
    panes: [
      { name: "Left", paneId: initialPaneId as never, paneLabel: 41 },
      { name: "Right", paneId: 9 as never, paneLabel: 42 },
    ],
    topologyRevision: 3 as never,
    windowLabel: "a",
  });

  assert.equal(applied.topologyRevision, 3);
  assert.deepEqual(applied.panes.map((pane) => [pane.paneId, pane.paneLabel, pane.name]), [
    [initialPaneId, 41, "Left"],
    [9, 42, "Right"],
  ]);

  const windowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(windowState.windowLabel, "a");
  assert.deepEqual(windowState.layout, {
    children: [
      { paneId: initialPaneId, type: "pane" },
      { paneId: 9, type: "pane" },
    ],
    direction: "horizontal",
    type: "split",
  });
  assert.equal(windowState.panes.find((pane) => pane.paneId === initialPaneId)?.content.contentId, "ct_preserved");
  assert.equal(windowState.panes.find((pane) => pane.paneId === initialPaneId)?.label, "41");
  assert.equal(windowState.panes.find((pane) => pane.paneId === 9)?.label, "42");
});

test("surface core rejects topology.apply with duplicate pane labels inside one surface payload", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  assert.throws(
    () => core.topologyApply(surface.surfaceId, {
      layout: {
        children: [
          { paneId: paneId as never, type: "pane" },
          { paneId: 9 as never, type: "pane" },
        ],
        direction: "horizontal",
        type: "split",
      },
      panes: [
        { name: "Left", paneId: paneId as never, paneLabel: 41 },
        { name: "Right", paneId: 9 as never, paneLabel: 41 },
      ],
      topologyRevision: 3 as never,
      windowLabel: "a",
    }),
    /Duplicate paneLabel in surface payload: 41/,
  );

  const windowState = core.getRendererWindowState(surface.surfaceId);
  assert.deepEqual(windowState.panes.map((pane) => pane.label), ["7"]);
});

test("surface core rejects caller-controlled human strings as window labels", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });

  assert.throws(
    () => core.applyProviderBootstrapTopology(surface.surfaceId, {
      initialPaneId: 7,
      initialPaneLabel: 7,
      windowLabel: "DOCS",
    }),
    /windowLabel must be a lowercase alphabetic provider identity label/,
  );
  assert.throws(
    () => core.applyProviderBootstrapTopology(surface.surfaceId, {
      initialPaneId: 7,
      initialPaneLabel: 7,
      windowLabel: "portrait-display GRAPHICAL NATIVE",
    }),
    /windowLabel must be a lowercase alphabetic provider identity label/,
  );

  const windowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(windowState.windowLabel, "");
});

test("surface core accepts provider window labels beyond zz", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });

  assert.doesNotThrow(() => core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: 7,
    initialPaneLabel: 7,
    windowLabel: "aaa",
  }));

  const windowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(windowState.windowLabel, "aaa");
});

test("surface core lets fresh provider bootstrap replace stale local window labels", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });

  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: 7,
    initialPaneLabel: 7,
    windowLabel: "a",
  });
  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: 7,
    initialPaneLabel: 7,
    windowLabel: "b",
  });

  const windowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(windowState.windowLabel, "b");
  assert.deepEqual(windowState.panes.map((pane) => pane.label), ["7"]);
});

test("surface core commits topology.apply provider window relabels atomically", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  assert.throws(
    () => core.topologyApply(surface.surfaceId, {
      layout: { paneId: paneId as never, type: "pane" },
      panes: [
        { name: "Docs", paneId: paneId as never, paneLabel: 41 },
        { name: "Duplicate", paneId: 8 as never, paneLabel: 41 },
      ],
      topologyRevision: 3 as never,
      windowLabel: "b",
    }),
    /Duplicate paneLabel in surface payload/,
  );

  const rejectedWindowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(rejectedWindowState.windowLabel, "a");
  assert.deepEqual(rejectedWindowState.panes.map((pane) => pane.label), ["7"]);

  assert.doesNotThrow(() => core.topologyApply(surface.surfaceId, {
    layout: { paneId: paneId as never, type: "pane" },
    panes: [
      { name: "Docs", paneId: paneId as never, paneLabel: 41 },
    ],
    topologyRevision: 4 as never,
    windowLabel: "b",
  }));

  const acceptedWindowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(acceptedWindowState.windowLabel, "b");
  assert.deepEqual(acceptedWindowState.panes.map((pane) => pane.label), ["41"]);
});

test("surface core rejects provider window relabels that collide with another live surface", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const primary = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const secondary = core.createAdditionalSurface("Surf Ace", { height: 700, scale: 1, width: 1000 });
  const primaryPaneId = applyProviderBootstrap(core, primary.surfaceId, 7, "a");
  const secondaryPaneId = applyProviderBootstrap(core, secondary.surfaceId, 11, "b");

  assert.throws(
    () => core.applyWindowLabelOnly(secondary.surfaceId, "a"),
    /Duplicate windowLabel in live surface set: a/,
  );
  assert.throws(
    () => core.assertProviderWindowLabelAvailable(secondary.surfaceId, "a"),
    /Duplicate windowLabel in live surface set: a/,
  );
  assert.throws(
    () => core.applyProviderBootstrapTopology(secondary.surfaceId, {
      initialPaneId: secondaryPaneId,
      initialPaneLabel: secondaryPaneId,
      windowLabel: "a",
    }),
    /Duplicate windowLabel in live surface set: a/,
  );
  assert.throws(
    () => core.topologyApply(secondary.surfaceId, {
      layout: { paneId: secondaryPaneId as never, type: "pane" },
      panes: [
        { name: "Secondary", paneId: secondaryPaneId as never, paneLabel: secondaryPaneId },
      ],
      topologyRevision: 2 as never,
      windowLabel: "a",
    }),
    /Duplicate windowLabel in live surface set: a/,
  );
  assert.throws(
    () => core.topologyApply(secondary.surfaceId, {
      layout: { paneId: secondaryPaneId as never, type: "pane" },
      panes: [
        { name: "Secondary", paneId: secondaryPaneId as never, paneLabel: secondaryPaneId },
      ],
      topologyRevision: 2 as never,
      windowLabel: "a",
    }),
    /Duplicate windowLabel in live surface set: a/,
  );

  assert.equal(core.getRendererWindowState(primary.surfaceId).windowLabel, "a");
  assert.deepEqual(core.getRendererWindowState(primary.surfaceId).panes.map((pane) => pane.paneId), [primaryPaneId]);
  assert.equal(core.getRendererWindowState(secondary.surfaceId).windowLabel, "b");
  assert.deepEqual(core.getRendererWindowState(secondary.surfaceId).panes.map((pane) => pane.paneId), [secondaryPaneId]);
});

test("surface core rejects pane.split with duplicate pane labels inside one surface", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  assert.throws(
    () => core.paneSplit(surface.surfaceId, {
      count: 2,
      direction: "horizontal",
      newPaneIds: [9],
      newPaneLabels: [7],
      paneId,
    }),
    /Duplicate paneLabel in surface payload: 7/,
  );

  const windowState = core.getRendererWindowState(surface.surfaceId);
  assert.deepEqual(windowState.panes.map((pane) => pane.label), ["7"]);
});

test("surface core emits history navigation after back/forward", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const events: Array<{
    contentId: string | null;
    direction: string;
    paneId: number;
    revision: number;
    surfaceId: string;
    type: string;
  }> = [];
  core.subscribe((event) => {
    if (event.type === "history-navigated") {
      events.push(event);
    }
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 5);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# First" },
    contentId: "ct_first" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_a",
    paneId: paneId as never,
    revision: 1 as never,
  });
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Second" },
    contentId: "ct_second" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_b",
    paneId: paneId as never,
    revision: 2 as never,
  });

  core.navigateHistory(surface.surfaceId, paneId, "back");

  assert.deepEqual(events, [
    {
      contentId: "ct_first",
      direction: "back",
      paneId,
      revision: 1,
      surfaceId: surface.surfaceId,
      type: "history-navigated",
    },
  ]);
  assert.equal(core.canNavigateHistory(surface.surfaceId, paneId, "back"), false);
  assert.equal(core.canNavigateHistory(surface.surfaceId, paneId, "forward"), true);
});

test("surface core reports history no-op before native release planning", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 5);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Only" },
    contentId: "ct_only" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_only",
    paneId: paneId as never,
    revision: 1 as never,
  });

  assert.equal(core.canNavigateHistory(surface.surfaceId, paneId, "back"), false);
  assert.equal(core.canNavigateHistory(surface.surfaceId, paneId, "forward"), false);
});

test("surface core reports pane-scoped viewport data in panes.list", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "horizontal",
    newPaneIds: [9],
    newPaneLabels: [9],
    paneId,
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, paneId, {
    bounds: { height: 400, width: 1200, x: 0, y: 0 },
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, 9, {
    bounds: { height: 400, width: 1200, x: 0, y: 400 },
  });

  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  assert.deepEqual(listedPane.viewport, { height: 400, scale: 2, width: 1200 });
  assert.deepEqual(listedPane.geometry.contentViewport, { height: 400, width: 1200, x: 0, y: 0 });
  assert.deepEqual(listedPane.geometry.protocolViewport, {
    coordinateSpace: "protocol_viewport",
    rect: { height: 400, width: 1200, x: 0, y: 0 },
    viewport: { height: 400, scale: 2, width: 1200 },
  });
  assert.equal(listedPane.geometry.coordinateSpace, "surface_logical");
  const geometryIdentity = core.resolvedPaneGeometryIdentity(surface.surfaceId);
  assert.equal(listedPane.geometry.geometryRevision, geometryIdentity.geometryRevision);
  assert.equal(listedPane.geometry.topologyEpoch, geometryIdentity.topologyRevision);
});

test("surface core materializes terminal_app targets through Surf Ace terminal host", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  resolvePaneSnapshot(core, surface.surfaceId, paneId);
  const pane = core.pairState(surface.surfaceId).panes[0]!;

  const materialization = core.projectNativePaneMaterialization(surface.surfaceId, {
    paneLineageId: pane.paneLineageId,
    requestId: "restore_btop",
    restoreReason: "resume_restore",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 3,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "launch_equivalent",
      requiredCapabilities: ["target.terminal_app.v1"],
      safeToLogFields: ["command", "args"],
      safetyClass: "process",
      summary: "btop",
    },
    targetId: "target_btop",
    targetKind: "terminal_app",
    targetPayload: { args: [], command: "btop", envPolicy: "surface_default", pty: true, restartPolicy: "manual_only" },
  });

  assert.equal(materialization.op, "native_pane.host");
  assert.deepEqual(materialization.panes[0]?.process, { args: ["-e", "btop"], command: "foot" });
  assert.equal(materialization.panes[0]?.target, "terminal");
  assert.deepEqual(materialization.panes[0]?.windowGroup, {
    launchIdentity: {
      launchToken: `${surface.surfaceId}:${pane.paneId}:target_btop:3`,
      paneId: String(pane.paneId),
      paneInstanceId: pane.paneLineageId,
      surfaceId: surface.surfaceId,
      targetId: "target_btop",
    },
    policy: {
      chromeInsets: { bottom: 44, left: 44, right: 44, top: 44 },
      clipToPane: true,
      constrainToPane: true,
      denyForeignToplevels: true,
      sameLaunchSecondaryToplevels: "accept",
    },
  });
  assert.equal(materialization.overlaySet?.regions[0]?.kind, "native_pane");
  assert.deepEqual(materialization.overlaySet?.regions[0]?.captures, ["pointer_hover", "pointer_button", "pointer_axis"]);
});

for (const { command, processEnv } of [
  { command: "/usr/bin/galculator", processEnv: undefined },
  { command: "/usr/bin/kolourpaint", processEnv: { QT_QPA_PLATFORM: "wayland" } },
  { command: "/usr/bin/weston-simple-egl", processEnv: undefined },
]) {
  test(`surface core materializes allowlisted Wayland GUI terminal_app command ${command} as a direct native pane process`, () => {
    const core = new SurfaceCore({
      persistentState: {
        primarySurfaceId: null,
        version: 1,
      },
    });

    const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
    const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
    resolvePaneSnapshot(core, surface.surfaceId, paneId);
    const pane = core.pairState(surface.surfaceId).panes[0]!;

    const materialization = core.projectNativePaneMaterialization(surface.surfaceId, {
      paneLineageId: pane.paneLineageId,
      requestId: "restore_weston_simple_egl",
      restoreReason: "resume_restore",
      surfaceId: surface.surfaceId as never,
      targetEpoch: 3,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "launch_equivalent",
        requiredCapabilities: ["target.terminal_app.v1"],
        safeToLogFields: ["command", "args"],
        safetyClass: "process",
        summary: command,
      },
      targetId: "target_wayland_gui",
      targetKind: "terminal_app",
      targetPayload: {
        args: [],
        command,
        envPolicy: "surface_default",
        pty: true,
        restartPolicy: "manual_only",
      },
    });

    assert.equal(materialization.op, "native_pane.host");
    assert.deepEqual(materialization.panes[0]?.process, {
      args: [],
      command,
      ...(processEnv ? { env: processEnv } : {}),
    });
    assert.equal(materialization.panes[0]?.target, "terminal");
    assert.equal(materialization.overlaySet?.regions[0]?.kind, "native_pane");
    assert.deepEqual(materialization.overlaySet?.regions[0]?.captures, ["pointer_hover", "pointer_button", "pointer_axis"]);
  });
}

test("surface core materializes KolourPaint native_app with direct native pane process env", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  resolvePaneSnapshot(core, surface.surfaceId, paneId);
  const pane = core.pairState(surface.surfaceId).panes[0]!;

  const materialization = core.projectNativePaneMaterialization(surface.surfaceId, {
    paneLineageId: pane.paneLineageId,
    requestId: "restore_kolourpaint",
    restoreReason: "resume_restore",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 3,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "launch_equivalent",
      requiredCapabilities: ["target.native_app.v1"],
      safeToLogFields: ["appId", "args"],
      safetyClass: "process",
      summary: "kolourpaint",
    },
    targetId: "target_kolourpaint",
    targetKind: "native_app",
    targetPayload: { appId: "kolourpaint", args: [], launchMode: "new_instance" },
  });

  assert.equal(materialization.op, "native_pane.host");
  assert.deepEqual(materialization.panes[0]?.process, {
    args: [],
    command: "kolourpaint",
    env: { QT_QPA_PLATFORM: "wayland" },
  });
  assert.equal(materialization.panes[0]?.target, "native_app");
  assert.equal(materialization.panes[0]?.nativeApp?.appId, "kolourpaint");
});

test("surface core snaps terminal native geometry to compositor integer bounds", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 3840, scale: 1, width: 2160 });
  const topPaneId = applyProviderBootstrap(core, surface.surfaceId, 6);
  core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "horizontal",
    newPaneIds: [7],
    newPaneLabels: [7],
    paneId: topPaneId,
  });
  updateResolvedPaneSnapshot(core, surface.surfaceId, 7, {
    bounds: { height: 1920.5, width: 2160, x: 0, y: 1919.5 },
  });
  const bottomPane = core.pairState(surface.surfaceId).panes.find((pane) => pane.paneId === 7)!;

  const materialization = core.projectNativePaneMaterialization(surface.surfaceId, {
    paneLineageId: bottomPane.paneLineageId,
    requestId: "restore_btop",
    restoreReason: "resume_restore",
    surfaceId: surface.surfaceId as never,
    targetEpoch: 3,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "launch_equivalent",
      requiredCapabilities: ["target.terminal_app.v1"],
      safeToLogFields: ["command", "args"],
      safetyClass: "process",
      summary: "btop",
    },
    targetId: "target_btop",
    targetKind: "terminal_app",
    targetPayload: { args: [], command: "btop", envPolicy: "surface_default", pty: true, restartPolicy: "manual_only" },
  });

  assert.equal(materialization.panes[0]?.geometry.coordinateSpace, "compositor_logical");
  assert.equal(materialization.panes[0]?.geometry.height, 1920);
  assert.equal(materialization.panes[0]?.geometry.paneInstanceId, bottomPane.paneLineageId);
  assert.match(materialization.panes[0]?.geometry.surfaceEpoch ?? "", new RegExp(`^${surface.surfaceId}:`));
  assert.equal(materialization.panes[0]?.geometry.width, 2160);
  assert.equal(materialization.panes[0]?.geometry.x, 0);
  assert.equal(materialization.panes[0]?.geometry.y, 1920);
  assert.deepEqual(materialization.overlaySet?.regions[0]?.rect, { height: 1920, width: 2160, x: 0, y: 1920 });
  assert.equal(core.validateNativePaneMaterializationLayout(surface.surfaceId, materialization), null);
});

test("surface core exposes native materialized panes to the renderer until content changes", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  resolvePaneSnapshot(core, surface.surfaceId, paneId);
  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  const launchToken = `${surface.surfaceId}:${paneId}:target_top:1`;
  const materialization: NativePaneMaterialization = {
    op: "native_pane.host",
    panes: [
      {
        id: String(paneId),
        binding_id: `${paneId}:target_top`,
        content_id: "target_top",
        geometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: listedPane.geometry.geometryRevision,
          height: listedPane.geometry.contentViewport.height,
          paneInstanceId: listedPane.geometry.paneInstanceId,
          surfaceEpoch: listedPane.geometry.surfaceEpoch,
          topologyEpoch: listedPane.geometry.topologyEpoch,
          width: listedPane.geometry.contentViewport.width,
          x: listedPane.geometry.contentViewport.x,
          y: listedPane.geometry.contentViewport.y,
        },
        process: { args: ["top"], command: "btop" },
        revision: 1 as Revision,
        target: "terminal",
        windowGroup: {
          launchIdentity: {
            launchToken,
            paneId: String(paneId),
            paneInstanceId: listedPane.geometry.paneInstanceId,
            surfaceId: surface.surfaceId,
            targetId: "target_top",
          },
          policy: {
            chromeInsets: { bottom: 44, left: 44, right: 44, top: 44 },
            clipToPane: true,
            constrainToPane: true,
            denyForeignToplevels: true,
            sameLaunchSecondaryToplevels: "accept",
          },
        },
      },
    ],
  };

  core.markNativePaneMaterialized(surface.surfaceId, materialization);
  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.externalNative, true);
  assert.equal(core.panesList(surface.surfaceId).panes[0]?.nativeWindowGroup, undefined);
  core.markNativePaneWindowGroups(surface.surfaceId, [{
    acceptedSecondaryCount: 1,
    clippingStatus: "clipped",
    deniedReasons: ["foreign_launch_token"],
    deniedToplevelCount: 1,
    focusedWindowId: "dialog-1",
    launchToken,
    members: [{
      bounds: { height: 120, width: 160, x: 8, y: 12 },
      clippedToPane: true,
      focused: true,
      id: "dialog-1",
      lifecycle: "live",
      role: "dialog",
    }],
    paneId: String(paneId),
    paneInstanceId: listedPane.geometry.paneInstanceId,
    paneLocalBounds: listedPane.geometry.contentViewport,
    primaryWindowId: `${paneId}:target_top`,
  }]);
  assert.equal(core.panesList(surface.surfaceId).panes[0]?.nativeWindowGroup?.acceptedSecondaryCount, 1);
  assert.equal(core.panesList(surface.surfaceId).panes[0]?.nativeWindowGroup?.focusedWindowId, "dialog-1");
  core.markNativePaneWindowGroups(surface.surfaceId, [{
    acceptedSecondaryCount: 99,
    clippingStatus: "unclipped",
    deniedReasons: [],
    deniedToplevelCount: 0,
    focusedWindowId: "foreign-dialog",
    launchToken: "foreign-launch-token",
    members: [],
    paneId: String(paneId),
    paneInstanceId: listedPane.geometry.paneInstanceId,
    paneLocalBounds: listedPane.geometry.contentViewport,
    primaryWindowId: "foreign-primary",
  }]);
  assert.equal(core.panesList(surface.surfaceId).panes[0]?.nativeWindowGroup, undefined);
  core.markNativePaneWindowGroups(surface.surfaceId, [{
    acceptedSecondaryCount: 2,
    clippingStatus: "clipped",
    deniedReasons: [],
    deniedToplevelCount: 0,
    focusedWindowId: "dialog-2",
    launchToken: null,
    members: [],
    paneId: String(paneId),
    paneInstanceId: listedPane.geometry.paneInstanceId,
    paneLocalBounds: listedPane.geometry.contentViewport,
    primaryWindowId: null,
  }]);
  assert.equal(core.panesList(surface.surfaceId).panes[0]?.nativeWindowGroup, undefined);

  core.contentClear(surface.surfaceId, {
    paneId: paneId as never,
    revision: 1 as never,
  });
  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.externalNative, false);
});

test("surface core advances geometry revision when pane chrome state changes", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  const initialRevision = core.getRendererWindowState(surface.surfaceId).geometryRevision;

  core.setAnnotating(surface.surfaceId, paneId, true);
  const annotatingRevision = core.getRendererWindowState(surface.surfaceId).geometryRevision;
  assert.equal(annotatingRevision, initialRevision + 1);

  core.setAnnotating(surface.surfaceId, paneId, false);
  const controlsRevision = core.getRendererWindowState(surface.surfaceId).geometryRevision;
  assert.equal(controlsRevision, annotatingRevision + 1);

  core.contentSet(surface.surfaceId, {
    content: { html: "<p>Hello</p>" },
    contentId: "ct_content" as never,
    contentType: "html",
    historyOwnerToken: "hot_content",
    paneId: paneId as never,
    revision: 1 as never,
  });
  const contentSetRevision = core.getRendererWindowState(surface.surfaceId).geometryRevision;
  assert.equal(contentSetRevision, controlsRevision + 1);

  core.contentClear(surface.surfaceId, {
    paneId: paneId as never,
    revision: 2 as never,
  });
  const contentClearRevision = core.getRendererWindowState(surface.surfaceId).geometryRevision;
  assert.equal(contentClearRevision, contentSetRevision + 1);
});

test("surface core updates terminal content in place", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 5);

  core.contentSet(surface.surfaceId, {
    content: { lines: ["one"], scrollback: 50 },
    contentId: "ct_deadbeef" as never,
    contentType: "terminal",
    historyOwnerToken: "hot_terminal",
    paneId: paneId as never,
    revision: 1 as never,
  });

  core.contentAppend(surface.surfaceId, {
    contentId: "ct_deadbeef" as never,
    lines: ["two"],
    paneId: paneId as never,
    revision: 2 as never,
  });

  const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.deepEqual((pane.content.content as { lines: string[] }).lines, ["one", "two"]);
});

test("surface core replaces visible content for the same paired session", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 11);

  core.contentSet(
    surface.surfaceId,
    {
      content: { markdown: "# First" },
      contentId: "ct_owner_a" as never,
      contentType: "markdown",
      historyOwnerToken: "hot_same_session",
      paneId: paneId as never,
      revision: 1 as never,
    },
  );
  core.contentSet(
    surface.surfaceId,
    {
      content: { markdown: "# Second" },
      contentId: "ct_owner_b" as never,
      contentType: "markdown",
      historyOwnerToken: "hot_same_session",
      paneId: paneId as never,
      revision: 2 as never,
    },
  );

  const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(pane.content.contentId, "ct_owner_b");
  assert.equal(pane.canGoBack, false);
});

test("surface core keeps history when a different paired session displaces content", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 13);

  core.contentSet(
    surface.surfaceId,
    {
      content: { markdown: "# First" },
      contentId: "ct_owner_a" as never,
      contentType: "markdown",
      historyOwnerToken: "hot_session_a",
      paneId: paneId as never,
      revision: 1 as never,
    },
  );
  core.contentSet(
    surface.surfaceId,
    {
      content: { markdown: "# Second" },
      contentId: "ct_owner_b" as never,
      contentType: "markdown",
      historyOwnerToken: "hot_session_b",
      paneId: paneId as never,
      revision: 2 as never,
    },
  );

  const visible = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(visible.content.contentId, "ct_owner_b");
  assert.equal(visible.canGoBack, true);

  core.navigateHistory(surface.surfaceId, paneId, "back");
  const restored = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(restored.content.contentId, "ct_owner_a");
});

test("surface core reports the current history entry owner name for chrome", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 15);
  core.setProviderName(surface.surfaceId, "Fallback Session");

  core.contentSet(
    surface.surfaceId,
    {
      content: { markdown: "# First" },
      contentId: "ct_owner_a" as never,
      contentType: "markdown",
      display: { senderDisplayName: "Session A", title: "Document A" },
      historyOwnerToken: "hot_session_a",
      paneId: paneId as never,
      revision: 1 as never,
    },
  );
  core.contentSet(
    surface.surfaceId,
    {
      content: { markdown: "# Second" },
      contentId: "ct_owner_b" as never,
      contentType: "markdown",
      display: { senderDisplayName: "Session B", title: "Document B" },
      historyOwnerToken: "hot_session_b",
      paneId: paneId as never,
      revision: 2 as never,
    },
  );

  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.ownerName, "Session B");
  core.navigateHistory(surface.surfaceId, paneId, "back");
  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.ownerName, "Session A");
});

test("surface core exposes provenance display name separately from content title", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 31);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Provenance" },
    contentId: "ct_provn1" as never,
    contentType: "markdown",
    display: {
      senderDisplayName: "Session One",
      provenance: {
        displayName: "T231 Pusher",
        streamLabel: "Pusher Stream",
      },
      title: "Document Title",
    },
    historyOwnerToken: "hot_provenance",
    paneId: paneId as never,
    revision: 1 as never,
  });

  const visible = core.getRendererWindowState(surface.surfaceId).panes[0];
  assert.equal(visible?.ownerName, "Session One");
  assert.equal(visible?.provenanceName, "Session One");
  assert.equal(visible?.content.display?.title, "Document Title");
  assert.equal(visible?.content.display?.provenance?.displayName, "T231 Pusher");
});

test("surface core uses supplied provenance session key when display name is absent", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 32);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Provenance" },
    contentId: "ct_provn2" as never,
    contentType: "markdown",
    display: {
      provenance: {
        sessionKey: "agent:test:session-only",
      },
      title: "Document Title",
    },
    historyOwnerToken: "hot_provenance",
    paneId: paneId as never,
    revision: 1 as never,
  });

  const visible = core.getRendererWindowState(surface.surfaceId).panes[0];
  assert.equal(visible?.ownerName, "agent:test:session-only");
  assert.equal(visible?.provenanceName, "agent:test:session-only");
  assert.equal(visible?.content.display?.title, "Document Title");
});

test("surface core does not leak provider name as chrome owner fallback", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 15);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Untitled" },
    contentId: "ct_untitled" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_untitled",
    paneId: paneId as never,
    revision: 1 as never,
  });

  core.setProviderName(surface.surfaceId, "Fallback Session");
  const visible = core.getRendererWindowState(surface.surfaceId).panes[0];
  assert.equal(visible?.ownerName, null);
});

test("surface core returns the number of flushed annotation batches discarded on pane close", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Annotate" },
    contentId: "ct_markdown" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_markdown",
    paneId: paneId as never,
    revision: 1 as never,
  });
  core.setAnnotating(surface.surfaceId, paneId, true);
  core.addStroke(surface.surfaceId, paneId, {
    points: [{ timestamp: 1, x: 5, y: 6 }],
    strokeId: "stroke_1" as never,
    tool: "mouse",
  });
  core.markDrawingFlushSent(surface.surfaceId, paneId);

  core.paneSplit(surface.surfaceId, {
    count: 2,
    direction: "horizontal",
    newPaneIds: [8],
    newPaneLabels: [8],
    paneId,
  });

  const response = core.paneClose(surface.surfaceId, paneId);
  assert.equal(response.closedFramesDiscarded, 1);
});

test("surface core rebroadcasts committed strokes into renderer state immediately", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);
  const events: Array<string> = [];
  const unsubscribe = core.subscribe((event) => {
    events.push(event.type);
  });

  try {
    core.contentSet(surface.surfaceId, {
      content: { markdown: "# Annotate" },
      contentId: "ct_markdown" as never,
      contentType: "markdown",
      historyOwnerToken: "hot_markdown",
      paneId: paneId as never,
      revision: 1 as never,
    });
    core.setAnnotating(surface.surfaceId, paneId, true);

    core.addStroke(surface.surfaceId, paneId, {
      points: [{ timestamp: 1, x: 5, y: 6 }],
      strokeId: "stroke_live" as never,
      tool: "mouse",
    });

    const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
    assert.deepEqual(
      pane.drawings.map((stroke) => stroke.strokeId),
      ["stroke_live"],
    );
    assert.deepEqual(events.slice(-2), ["surface-changed", "drawing-dirty"]);
  } finally {
    unsubscribe();
  }
});

// --- V3 section 4: durable-evidence recovery for pending write-ahead rows ---

const pendingLedger = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    attemptSequence: index + 1,
    controllerInstanceId: `controller_${index + 1}`,
    outcome: "pending" as const,
    reason: null,
    reasonCode: null,
    requestId: `rq_${index + 1}`,
    stage: "requested" as const,
    startedAt: 1,
    surfaceId: "sf_test",
    updatedAt: 1,
  }));


// Real durable evidence: persisted operation receipts. `receipts` maps a
// requestId to the outcomes recorded for it; two outcomes for one requestId
// are seeded on two controllers, which is how genuine conflicting evidence
// arises in durable state.
const coreWithPendingAndReceipts = (
  count: number,
  receipts: Record<string, ("resolved_success" | "resolved_failure")[]>,
) => {
  const lockless = createEmptyLocklessClientState();
  const entries = Object.entries(receipts);
  const maxDepth = Math.max(0, ...entries.map(([, list]) => list.length));
  // Receipts are capped per controller by maxPendingOperationReceiptsPerController,
  // so a large pending set must be spread across controllers rather than piled
  // onto one. That is also how it looks in reality: many controllers, each
  // holding its own receipts.
  const receiptsPerController = DEFAULT_LOCKLESS_LIMITS
    .maxPendingOperationReceiptsPerController;
  for (let depth = 0; depth < maxDepth; depth++) {
    let chunk = 0;
    let pendingOperationReceipts: Record<string, unknown> = {};
    const flushController = () => {
      if (Object.keys(pendingOperationReceipts).length === 0) {
        return;
      }
      const controllerInstanceId = `ctl_evidence_${depth}_${chunk}`;
      (lockless as any).controllers[controllerInstanceId] = {
        controllerInstanceId,
        controllerProductName: null,
        disconnectedAt: null,
        dormantSequence: null,
        pendingOperationReceipts,
        projectionCapacityBytes: 1024,
        status: "dormant",
      };
      chunk += 1;
      pendingOperationReceipts = {};
    };
    for (const [requestId, list] of entries) {
      const outcome = list[depth];
      if (!outcome) continue;
      // `bytes` is validated against the serialized receipt that CONTAINS
      // it, so solve the self-reference by iterating to a fixed point.
      const shape = (bytes: number) => ({
        bytes,
        operation: "pair.request",
        operationReceipt: { commitSequence: 1, requestId },
        outcome,
        requestId,
        status: "terminal" as const,
        terminalResponse: null,
      });
      let bytes = 0;
      for (let pass = 0; pass < 6; pass++) {
        bytes = Buffer.byteLength(
          JSON.stringify({ version: 1, ...shape(bytes) }),
          "utf8",
        );
      }
      pendingOperationReceipts[requestId] = shape(bytes);
      if (
        Object.keys(pendingOperationReceipts).length >= receiptsPerController
      ) {
        flushController();
      }
    }
    flushController();
  }
  return new SurfaceCore({
    persistentState: {
      admissionAttempts: pendingLedger(count),
      lockless,
      nextAdmissionAttemptSequence: count + 1,
      primarySurfaceId: null,
      version: 1,
    } as any,
  });
};

const coreWithPending = (count: number) =>
  new SurfaceCore({
    persistentState: {
      admissionAttempts: pendingLedger(count),
      nextAdmissionAttemptSequence: count + 1,
      primarySurfaceId: null,
      version: 1,
    },
  });

test("conflicting exact evidence keeps its pending row unchanged and never picks a side", () => {
  const core = coreWithPendingAndReceipts(2, {
    rq_1: ["resolved_success", "resolved_failure"],
  });
  const before = core.listSurfaceAdmissionAttempts()[0];
  const plan = core.recoverPendingSurfaceAdmissionAttempts();
  assert.deepEqual(plan.terminalize, []);
  assert.deepEqual(plan.unresolved, [1, 2]);
  // byte-for-byte unchanged
  assert.deepEqual(core.listSurfaceAdmissionAttempts()[0], before);
});

test("evidence naming a different request or sequence is not evidence for this row", () => {
  const core = coreWithPending(1);
  const plan = core.recoverPendingSurfaceAdmissionAttempts();
  assert.deepEqual(plan.unresolved, [1]);
  assert.equal(core.listSurfaceAdmissionAttempts()[0].outcome, "pending");
});

test("mixed pending set terminalizes every determinate row in one transition and reports unresolved in order", () => {
  // 1 succeeded, 2 failed, 3 conflicting, 4 and 5 no receipt at all.
  // NOTE: the contract's third authoritative class, never-began, has no
  // durable source in this system — absence of a receipt is indistinguishable
  // from an operation that never started — so it is not exercised here rather
  // than faked.
  const core = coreWithPendingAndReceipts(5, {
    rq_1: ["resolved_success"],
    rq_2: ["resolved_failure"],
    rq_3: ["resolved_success", "resolved_failure"],
  });
  const unchangedBefore = core
    .listSurfaceAdmissionAttempts()
    .filter((attempt) => attempt.attemptSequence >= 3);
  const plan = core.recoverPendingSurfaceAdmissionAttempts();
  assert.deepEqual(plan.unresolved, [3, 4, 5]);

  const after = core.listSurfaceAdmissionAttempts();
  const bySequence = (sequence: number) =>
    after.find((attempt) => attempt.attemptSequence === sequence);
  assert.equal(bySequence(1)?.outcome, "succeeded");
  assert.equal(bySequence(2)?.outcome, "failed");
  // unresolved rows survive byte-for-byte
  assert.deepEqual(
    after.filter((attempt) => attempt.attemptSequence >= 3),
    unchangedBefore,
  );
});

const largestPendingLedger = () => {
  for (
    let count = LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS;
    count >= 1;
    count--
  ) {
    try {
      return { core: coreWithPending(count), count };
    } catch {
      // this many pending rows exceed a bound; try one fewer
    }
  }
  throw new Error("no fitting pending ledger");
};

test("pending-only saturation returns admission_recovery_pending, never surface_state_capacity", () => {
  // Pending rows are charged at their worst-case terminal representation, so
  // the byte bound is reached well before 256 rows. Derive the largest pending
  // ledger that actually fits rather than assuming the count bound is
  // reachable with pending rows.
  const { core, count } = largestPendingLedger();
  let raised: unknown = null;
  try {
    core.beginSurfaceAdmissionAttempt({
      controllerInstanceId: "controller_candidate",
      requestId: "rq_candidate",
      surfaceId: "sf_other",
    });
  } catch (error) {
    raised = error;
  }
  assert(raised instanceof LocklessAuthorityError);
  assert.equal(raised.code, "admission_recovery_pending");
  assert.notEqual(raised.code, "surface_state_capacity");
  // nothing evicted, every pending sequence reported in order
  assert.equal(core.listSurfaceAdmissionAttempts().length, count);
  assert.deepEqual(
    core.listUnresolvedSurfaceAdmissionAttempts(),
    Array.from({ length: count }, (_, index) => index + 1),
  );
});

test("candidate admission proceeds only after recovery leaves no unresolved sequence", () => {
  const { count } = largestPendingLedger();
  const core = coreWithPendingAndReceipts(
    count,
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `rq_${index + 1}`,
        ["resolved_success" as const],
      ]),
    ),
  );
  const admitted = core.beginSurfaceAdmissionAttempt({
    controllerInstanceId: "controller_candidate",
    requestId: "rq_candidate",
    surfaceId: "sf_other",
  });
  assert.equal(admitted.attemptSequence, count + 1);
  assert(
    core.listSurfaceAdmissionAttempts().length <=
      LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
  );
  // every previously unresolved row terminalized; the only pending row left is
  // the candidate this call just admitted, which is pending by definition.
  assert.deepEqual(core.listUnresolvedSurfaceAdmissionAttempts(), [count + 1]);
});

// --- V3 s3.3 / s5 / s6: queued prepare, provisional sequences, atomicity ---

const seededTerminalCore = (count: number) => {
  const core = new SurfaceCore();
  for (let index = 1; index <= count; index++) {
    const attempt = core.beginSurfaceAdmissionAttempt({
      controllerInstanceId: `controller_${index}`,
      requestId: `rq_${index}`,
      surfaceId: index % 2 === 0 ? "sf_alpha" : "sf_beta",
    });
    core.succeedSurfaceAdmissionAttempt(attempt.attemptSequence);
  }
  return core;
};

test("second caller cannot enter the global boundary until the first transition settles", async () => {
  const core = seededTerminalCore(4);
  const order: string[] = [];
  let releaseFirst: (() => void) | null = null;
  const firstPersisting = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = core.prepareSurfaceAdmissionAttempt(
    { controllerInstanceId: "c_one", requestId: "rq_one", surfaceId: "sf_alpha" },
    async () => {
      order.push("first:persist_begin");
      await firstPersisting;
      order.push("first:persist_end");
    },
  );
  // give caller one a chance to reach its persist boundary
  await new Promise((resolve) => setImmediate(resolve));

  const second = core.prepareSurfaceAdmissionAttempt(
    { controllerInstanceId: "c_two", requestId: "rq_two", surfaceId: "sf_beta" },
    async () => {
      order.push("second:persist_begin");
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  // caller two must not have entered prepare at all while one is in flight
  assert.deepEqual(order, ["first:persist_begin"]);

  releaseFirst?.();
  const [firstAttempt, secondAttempt] = await Promise.all([first, second]);
  assert.deepEqual(order, [
    "first:persist_begin",
    "first:persist_end",
    "second:persist_begin",
  ]);
  // distinct committed sequences, strictly increasing, nothing lost
  assert.notEqual(firstAttempt.attemptSequence, secondAttempt.attemptSequence);
  assert(secondAttempt.attemptSequence > firstAttempt.attemptSequence);
  assert(
    core.listSurfaceAdmissionAttempts().length <=
      LOCKLESS_MAX_SURFACE_ADMISSION_ATTEMPTS,
  );
});

test("known pre-state persistence failure rolls the whole transition back and frees the provisional sequence for reuse", async () => {
  const core = seededTerminalCore(3);
  const before = core.getPersistentState();
  const provisional = before.nextAdmissionAttemptSequence;

  await assert.rejects(
    core.prepareSurfaceAdmissionAttempt(
      { controllerInstanceId: "c_fail", requestId: "rq_fail", surfaceId: "sf_alpha" },
      async () => {
        throw new Error("disk full, nothing written");
      },
    ),
  );

  const after = core.getPersistentState();
  // exact pre-state: no candidate row, no high-water advance
  assert.deepEqual(after.admissionAttempts, before.admissionAttempts);
  assert.equal(after.nextAdmissionAttemptSequence, provisional);
  assert.equal(core.isAdmissionFailStopped(), false);

  // the never-committed provisional value is reused, not skipped
  const retried = await core.prepareSurfaceAdmissionAttempt(
    { controllerInstanceId: "c_retry", requestId: "rq_retry", surfaceId: "sf_alpha" },
    async () => {},
  );
  assert.equal(retried.attemptSequence, provisional);
});

test("unknown persistence outcome fail-stops the boundary until durable state is reloaded", async () => {
  const core = seededTerminalCore(3);
  await assert.rejects(
    core.prepareSurfaceAdmissionAttempt(
      { controllerInstanceId: "c_unknown", requestId: "rq_unknown", surfaceId: "sf_alpha" },
      async () => {
        throw new PersistentStateOutcomeUnknownError(new Error("selector commit ambiguous"));
      },
    ),
  );
  assert.equal(core.isAdmissionFailStopped(), true);

  // no new prepare may start while the outcome is unproven
  await assert.rejects(
    core.prepareSurfaceAdmissionAttempt(
      { controllerInstanceId: "c_after", requestId: "rq_after", surfaceId: "sf_alpha" },
      async () => {
        throw new Error("persist must not be reached while fail-stopped");
      },
    ),
    (error) =>
      error instanceof LocklessAuthorityError && error.code === "internal_error",
  );

  // The real reload path is reconstruction from durable state, which is what
  // the app does after a fail-stop. A fresh core is not fail-stopped.
  const reloaded = new SurfaceCore({ persistentState: core.getPersistentState() });
  assert.equal(reloaded.isAdmissionFailStopped(), false);
  const resumed = await reloaded.prepareSurfaceAdmissionAttempt(
    { controllerInstanceId: "c_resume", requestId: "rq_resume", surfaceId: "sf_alpha" },
    async () => {},
  );
  assert(resumed.attemptSequence > 0);
});

test("a failed transition leaves a later caller a complete state, never a partial one", async () => {
  const core = seededTerminalCore(4);
  const before = core.getPersistentState();
  const failing = core.prepareSurfaceAdmissionAttempt(
    { controllerInstanceId: "c_first", requestId: "rq_first", surfaceId: "sf_alpha" },
    async () => {
      throw new Error("known pre-state");
    },
  );
  const following = core.prepareSurfaceAdmissionAttempt(
    { controllerInstanceId: "c_second", requestId: "rq_second", surfaceId: "sf_beta" },
    async () => {},
  );
  await assert.rejects(failing);
  const secondAttempt = await following;
  // caller two observed the exact pre-state, so it took the provisional value
  assert.equal(
    secondAttempt.attemptSequence,
    before.nextAdmissionAttemptSequence,
  );
});

test("a small unresolved set blocks admission even far from either bound", () => {
  // Two stale pending rows out of a 256-row budget: nowhere near capacity, so
  // this proves blocking is driven by unresolved recovery state and not by a
  // capacity shortfall.
  const core = coreWithPending(2);
  let raised: unknown = null;
  try {
    core.beginSurfaceAdmissionAttempt({
      controllerInstanceId: "controller_candidate",
      requestId: "rq_candidate",
      surfaceId: "sf_other",
    });
  } catch (error) {
    raised = error;
  }
  assert(raised instanceof LocklessAuthorityError);
  assert.equal(raised.code, "admission_recovery_pending");
  assert.deepEqual(raised.details?.unresolvedSequences, [1, 2]);
  // unchanged, and nothing evicted
  assert.equal(core.listSurfaceAdmissionAttempts().length, 2);
  assert.deepEqual(core.listUnresolvedSurfaceAdmissionAttempts(), [1, 2]);
});

test("resolving only some rows still blocks until none remains unresolved", () => {
  const core = coreWithPendingAndReceipts(3, {
    rq_1: ["resolved_success"],
  });
  let raised: unknown = null;
  try {
    core.beginSurfaceAdmissionAttempt({
      controllerInstanceId: "controller_candidate",
      requestId: "rq_candidate",
      surfaceId: "sf_other",
    });
  } catch (error) {
    raised = error;
  }
  assert(raised instanceof LocklessAuthorityError);
  assert.equal(raised.code, "admission_recovery_pending");
  // row 1 terminalized in the same recovery commit; 2 and 3 still block
  assert.deepEqual(raised.details?.unresolvedSequences, [2, 3]);
  assert.equal(
    core.listSurfaceAdmissionAttempts().find((a) => a.attemptSequence === 1)
      ?.outcome,
    "succeeded",
  );
});

test("a single unresolved row blocks a candidate that would otherwise fit easily", () => {
  const core = coreWithPending(1);
  let raised: unknown = null;
  try {
    core.beginSurfaceAdmissionAttempt({
      controllerInstanceId: "controller_candidate",
      requestId: "rq_candidate",
      surfaceId: "sf_other",
    });
  } catch (error) {
    raised = error;
  }
  assert(raised instanceof LocklessAuthorityError);
  assert.equal(raised.code, "admission_recovery_pending");
  assert.deepEqual(raised.details?.unresolvedSequences, [1]);
  assert.equal(core.listSurfaceAdmissionAttempts().length, 1);
});

