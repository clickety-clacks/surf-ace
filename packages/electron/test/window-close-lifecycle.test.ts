import assert from "node:assert/strict";
import test from "node:test";

import { SurfaceCore } from "../src/surface-core.js";
import {
  handleSurfaceWindowClose,
  surfaceWindowCloseOrigin,
  type SurfaceWindowCloseLifecycle,
} from "../src/window-close-lifecycle.js";

const viewport = { height: 800, scale: 2, width: 1200 };

function coreWithSavedContent(): { core: SurfaceCore; surfaceId: string } {
  const core = new SurfaceCore({
    persistentState: { primarySurfaceId: null, version: 1 },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", viewport);
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Keep this window" },
    contentId: "ct_window_close" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_window_close" as never,
    paneId: 0 as never,
    revision: 1 as never,
  });
  return { core, surfaceId: surface.surfaceId };
}

function lifecycle(
  overrides: Partial<SurfaceWindowCloseLifecycle> = {},
): SurfaceWindowCloseLifecycle & { calls: string[] } {
  const calls: string[] = [];
  return {
    beginClose: () => calls.push("begin"),
    clearOverlayRegions: async () => { calls.push("clear-overlays"); },
    closeWindowWithoutFinalizing: () => calls.push("close-window-nonfinal"),
    closeSurfaceFromLocalUser: async () => { calls.push("final-close"); },
    finishClose: () => calls.push("finish"),
    isClosePending: () => false,
    isPersistenceOutcomeUnknown: () => false,
    isProgrammaticClose: () => false,
    isQuitting: () => false,
    onCloseFailed: () => calls.push("close-failed"),
    onClosePausedForPersistence: () => calls.push("persistence-paused"),
    onCloseReleaseFailed: () => calls.push("release-failed"),
    onOverlayClearFailed: () => calls.push("overlay-clear-failed"),
    persistState: async () => { calls.push("persist"); },
    releaseNativePanes: async () => { calls.push("release-panes"); },
    ...overrides,
    calls,
  };
}

test("a deliberate user close commits final close through the window lifecycle", async () => {
  const deps = lifecycle();
  let prevented = false;

  await handleSurfaceWindowClose(
    { preventDefault: () => { prevented = true; } },
    surfaceWindowCloseOrigin({ compositorStartupRejected: false, rendererReady: true }),
    deps,
  );

  assert.equal(prevented, true);
  assert.deepEqual(deps.calls, ["begin", "release-panes", "final-close", "finish"]);
});

test("a rejected startup close persists readable content without final close", async () => {
  const { core, surfaceId } = coreWithSavedContent();
  let savedState: ReturnType<SurfaceCore["getPersistentState"]> | null = null;
  let prevented = false;
  let pending = false;
  let programmatic = false;
  const deps = lifecycle({
    beginClose: () => { pending = true; },
    closeWindowWithoutFinalizing: () => { programmatic = true; },
    finishClose: () => { pending = false; },
    isClosePending: () => pending,
    isProgrammaticClose: () => programmatic,
    persistState: async () => { savedState = core.getPersistentState(); },
  });

  await handleSurfaceWindowClose(
    { preventDefault: () => { prevented = true; } },
    surfaceWindowCloseOrigin({ compositorStartupRejected: true, rendererReady: false }),
    deps,
  );

  assert.equal(prevented, true);
  assert.equal(programmatic, true);
  assert.deepEqual(deps.calls, ["begin", "close-window-nonfinal", "finish"]);
  assert.ok(savedState);
  assert.equal(core.ensurePrimarySurface("Surf Ace", viewport).surfaceId, surfaceId);

  const restored = new SurfaceCore({ persistentState: savedState! });
  const surfaces = restored.restorePersistedSurfaces("Surf Ace", viewport);
  assert.equal(surfaces[0]?.surfaceId, surfaceId);
  const restoredContent = restored.getRendererWindowState(surfaceId).panes[0]?.content;
  assert.deepEqual(restoredContent?.content, { markdown: "# Keep this window" });
  assert.equal(restoredContent?.contentId, "ct_window_close");
  assert.equal(restoredContent?.contentType, "markdown");
});

test("a renderer-ready window close remains final after a rejected startup", () => {
  assert.equal(
    surfaceWindowCloseOrigin({ compositorStartupRejected: true, rendererReady: true }),
    "user",
  );
});

test("a rejected startup window stays open if preserving its state fails", async () => {
  const deps = lifecycle({
    persistState: async () => { throw new Error("state write refused"); },
  });
  let prevented = false;

  await handleSurfaceWindowClose(
    { preventDefault: () => { prevented = true; } },
    "compositor-startup-rejection",
    deps,
  );

  assert.equal(prevented, true);
  assert.deepEqual(deps.calls, ["begin", "close-failed", "finish"]);
});
