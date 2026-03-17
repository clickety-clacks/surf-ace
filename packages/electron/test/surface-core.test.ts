import assert from "node:assert/strict";
import test from "node:test";

import { SurfaceCore } from "../src/surface-core.js";

test("surface core assigns pane history and split topology", () => {
  const core = new SurfaceCore({
    now: () => 1000,
    persistentState: {
      nextPaneId: 1,
      nextWindowLabelIndex: 0,
      primarySurfaceId: null,
      version: 1,
      windowLabels: {},
    },
  });

  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const initialPaneId = core.getRendererWindowState(surface.surfaceId).panes[0]!.paneId;

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
    paneId: initialPaneId as never,
    revision: 1 as never,
  });
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Second" },
    contentId: "ct_b1b2c3d4" as never,
    contentType: "markdown",
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
      nextPaneId: 1,
      nextWindowLabelIndex: 0,
      primarySurfaceId: null,
      version: 1,
      windowLabels: {},
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = core.getRendererWindowState(surface.surfaceId).panes[0]!.paneId;

  core.contentSet(surface.surfaceId, {
    content: { lines: ["one"], scrollback: 50 },
    contentId: "ct_deadbeef" as never,
    contentType: "terminal",
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
      nextPaneId: 1,
      nextWindowLabelIndex: 0,
      primarySurfaceId: null,
      version: 1,
      windowLabels: {},
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = core.getRendererWindowState(surface.surfaceId).panes[0]!.paneId;

  core.contentSet(
    surface.surfaceId,
    {
      content: { markdown: "# First" },
      contentId: "ct_owner_a" as never,
      contentType: "markdown",
      paneId: paneId as never,
      revision: 1 as never,
    },
    { ownerToken: "session-a" },
  );
  core.contentSet(
    surface.surfaceId,
    {
      content: { markdown: "# Second" },
      contentId: "ct_owner_b" as never,
      contentType: "markdown",
      paneId: paneId as never,
      revision: 2 as never,
    },
    { ownerToken: "session-a" },
  );

  const pane = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(pane.content.contentId, "ct_owner_b");
  assert.equal(pane.canGoBack, false);
});

test("surface core keeps history when a different paired session displaces content", () => {
  const core = new SurfaceCore({
    persistentState: {
      nextPaneId: 1,
      nextWindowLabelIndex: 0,
      primarySurfaceId: null,
      version: 1,
      windowLabels: {},
    },
  });
  const surface = core.ensurePrimarySurface("Surf Ace", { height: 800, scale: 2, width: 1200 });
  const paneId = core.getRendererWindowState(surface.surfaceId).panes[0]!.paneId;

  core.contentSet(
    surface.surfaceId,
    {
      content: { markdown: "# First" },
      contentId: "ct_owner_a" as never,
      contentType: "markdown",
      paneId: paneId as never,
      revision: 1 as never,
    },
    { ownerToken: "session-a" },
  );
  core.contentSet(
    surface.surfaceId,
    {
      content: { markdown: "# Second" },
      contentId: "ct_owner_b" as never,
      contentType: "markdown",
      paneId: paneId as never,
      revision: 2 as never,
    },
    { ownerToken: "session-b" },
  );

  const visible = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(visible.content.contentId, "ct_owner_b");
  assert.equal(visible.canGoBack, true);

  core.navigateHistory(surface.surfaceId, paneId, "back");
  const restored = core.getRendererWindowState(surface.surfaceId).panes[0]!;
  assert.equal(restored.content.contentId, "ct_owner_a");
});
