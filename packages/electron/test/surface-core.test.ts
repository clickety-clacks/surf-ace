import assert from "node:assert/strict";
import test from "node:test";

import { SurfaceCore, SurfaceCoreError } from "../src/surface-core.js";

function applyProviderBootstrap(core: SurfaceCore, surfaceId: string, initialPaneId: number): number {
  core.applyProviderBootstrapTopology(surfaceId, {
    initialPaneId,
    initialPaneLabel: initialPaneId,
    windowLabel: "a",
  });
  return core.getRendererWindowState(surfaceId).panes[0]!.paneId;
}

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

  core.paneRename(surface.surfaceId, 7, "Notes");
  const renamedState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(renamedState.panes[0]?.name, "Notes");
  assert.equal(renamedState.panes[0]?.label, "41");
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
  applyProviderBootstrap(core, surface.surfaceId, 7);

  assert.doesNotThrow(() => {
    core.updatePaneSnapshot(surface.surfaceId, 819, {
      visibleText: "stale",
    });
  });
  assert.ok(warnings.some((warning) => warning.includes("unknown pane 819")));
});

test("surface core falls back to authoritative html text when renderer snapshot is still placeholder", () => {
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
  core.updatePaneSnapshot(surface.surfaceId, paneId, {
    visibleText: "Surface readyWaiting for content.",
  });

  const snapshot = core.captureSnapshot(surface.surfaceId, paneId);
  assert.equal(snapshot.visibleText, "pane two\nready");
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
  const paneViewports = core.panesList(surface.surfaceId).panes.map((pane) => pane.viewport);
  assert.deepEqual(paneViewports, [
    { height: 800, scale: 2, width: 600 },
    { height: 800, scale: 2, width: 600 },
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
        { paneId: 7 as never, type: "pane" },
        { paneId: 9 as never, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    },
    panes: [
      { name: "Left", paneId: 7 as never, paneLabel: 41 },
      { name: "Right", paneId: 9 as never, paneLabel: 42 },
    ],
    topologyRevision: 3 as never,
    windowLabel: "b",
  });

  assert.equal(applied.topologyRevision, 3);
  assert.deepEqual(applied.panes.map((pane) => [pane.paneId, pane.paneLabel, pane.name]), [
    [7, 41, "Left"],
    [9, 42, "Right"],
  ]);

  const windowState = core.getRendererWindowState(surface.surfaceId);
  assert.equal(windowState.windowLabel, "b");
  assert.deepEqual(windowState.layout, {
    children: [
      { paneId: 7, type: "pane" },
      { paneId: 9, type: "pane" },
    ],
    direction: "horizontal",
    type: "split",
  });
  assert.equal(windowState.panes.find((pane) => pane.paneId === 7)?.content.contentId, "ct_preserved");
  assert.equal(windowState.panes.find((pane) => pane.paneId === 7)?.label, "41");
  assert.equal(windowState.panes.find((pane) => pane.paneId === 9)?.label, "42");
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

  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  assert.deepEqual(listedPane.viewport, { height: 800, scale: 2, width: 600 });
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
