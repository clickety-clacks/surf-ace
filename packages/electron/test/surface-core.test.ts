import assert from "node:assert/strict";
import test from "node:test";

import { SurfaceCore } from "../src/surface-core.js";

function applyProviderBootstrap(core: SurfaceCore, surfaceId: string, initialPaneId: number): number {
  core.applyProviderBootstrapTopology(surfaceId, {
    initialPaneId,
    windowLabel: "a",
  });
  return core.getRendererWindowState(surfaceId).panes[0]!.paneId;
}

test("surface core waits for provider bootstrap before creating the initial pane", () => {
  const core = new SurfaceCore({
    persistentState: {
      primarySurfaceId: null,
      version: 1,
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const windowState = core.getRendererWindowState(surface.surfaceId);

  assert.equal(windowState.windowLabel, "");
  assert.equal(windowState.layout, null);
  assert.deepEqual(windowState.panes, []);
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
    paneId: initialPaneId,
  });

  assert.deepEqual(split.panes.map((pane) => pane.paneId), [initialPaneId, 9]);

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
