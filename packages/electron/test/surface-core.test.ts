import assert from "node:assert/strict";
import test from "node:test";

import type { Revision } from "../../protocol/src/index.js";
import type { NativePaneMaterialization } from "../src/native-pane-bridge.js";
import { SurfaceCore, SurfaceCoreError } from "../src/surface-core.js";

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
  const paneId = applyProviderBootstrap(core, surface.surfaceId, 7);

  assert.doesNotThrow(() => {
    core.updatePaneSnapshot(surface.surfaceId, 819, {
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
  core.updatePaneSnapshot(surface.surfaceId, paneId, {
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
    ownershipEpoch: 0,
    ownershipSessionId: "sa_test",
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
  const snapshot = core.captureSnapshot(surface.surfaceId, paneId);
  assert.equal(snapshot.contentId, null);
  assert.equal(snapshot.contentType, null);
});

test("surface core does not persist browser_url renderer history across restart", () => {
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
    ownershipEpoch: 0,
    ownershipSessionId: "sa_test",
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
  assert.equal(restoredPane.content.contentType, null);
  assert.equal(restoredPane.content.contentId, null);
  assert.equal(restoredPane.content.content, null);
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
    ownershipEpoch: 0,
    ownershipSessionId: "sa_test",
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
    ownershipEpoch: 0,
    ownershipSessionId: "sa_test",
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
  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
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
    ownershipEpoch: 0,
    ownershipSessionId: "sa_test",
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
  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
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

  const projected = core.projectNativePaneGeometryUpdateForTopologyApply(surface.surfaceId, {
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

  assert.equal(projected?.overlaySet.windowId, "docs");
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

  const projected = core.projectNativePaneGeometryUpdateForTopologyApply(surface.surfaceId, {
    layout: { paneId: paneId as never, type: "pane" },
    panes: [
      { name: "Docs", paneId: paneId as never, paneLabel: 7 },
    ],
    topologyRevision: 2 as never,
    windowLabel: "b",
  });

  assert.equal(projected?.overlaySet.windowId, "b");
  assert.deepEqual(projected?.panes.map((pane) => pane.id), [String(paneId)]);

  const beforeRevision = core.panesList(surface.surfaceId).panes[0]!.geometry.geometryRevision;
  core.topologyApply(surface.surfaceId, {
    layout: { paneId: paneId as never, type: "pane" },
    panes: [
      { name: "Docs", paneId: paneId as never, paneLabel: 7 },
    ],
    topologyRevision: 2 as never,
    windowLabel: "b",
  });
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
  const projected = core.projectNativePaneOverlayWindowLabelUpdate(surface.surfaceId, "b");

  assert.equal(projected?.overlaySet.windowId, "b");
  assert.equal(projected?.panes[0]?.geometry.geometryRevision, Number(beforeRevision) + 1);

  core.applyWindowLabelOnly(surface.surfaceId, "b");

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
    ownershipEpoch: 0,
    ownershipSessionId: "sa_test",
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
    ownershipEpoch: 0,
    ownershipSessionId: "sa_test",
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
    ownershipEpoch: 0,
    ownershipSessionId: "sa_test",
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
    ownershipEpoch: 0,
    ownershipSessionId: "sa_test",
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
      windowLabel: "RACTER GRAPHICAL NATIVE",
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
    () => core.projectNativePaneOverlayWindowLabelUpdate(secondary.surfaceId, "a"),
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
    () => core.projectNativePaneGeometryUpdateForTopologyApply(secondary.surfaceId, {
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

  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
  assert.deepEqual(listedPane.viewport, { height: 400, scale: 2, width: 1200 });
  assert.deepEqual(listedPane.geometry.contentViewport, { height: 400, width: 1200, x: 0, y: 0 });
  assert.deepEqual(listedPane.geometry.protocolViewport, {
    coordinateSpace: "protocol_viewport",
    rect: { height: 400, width: 1200, x: 0, y: 0 },
    viewport: { height: 400, scale: 2, width: 1200 },
  });
  assert.equal(listedPane.geometry.coordinateSpace, "surface_logical");
  assert.equal(listedPane.geometry.geometryRevision, 3);
  assert.equal(listedPane.geometry.topologyEpoch, 0);
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
  const listedPane = core.panesList(surface.surfaceId).panes[0]!;
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
      },
    ],
  };

  core.markNativePaneMaterialized(surface.surfaceId, materialization);
  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.externalNative, true);

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
      display: { title: "Session A" },
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
      display: { title: "Session B" },
      historyOwnerToken: "hot_session_b",
      paneId: paneId as never,
      revision: 2 as never,
    },
  );

  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.ownerName, "Session B");
  core.navigateHistory(surface.surfaceId, paneId, "back");
  assert.equal(core.getRendererWindowState(surface.surfaceId).panes[0]?.ownerName, "Session A");
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
