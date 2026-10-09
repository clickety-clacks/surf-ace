import assert from "node:assert/strict";
import test from "node:test";
import { SurfaceCore } from "../src/surface-core.js";
import { PanePresentationCoordinator } from "../src/pane-presentation-coordinator.js";
import { PANE_PRESENTATION_CAPABILITY } from "../src/pane-presentation.js";
import type { CompositorControlRequest } from "../src/native-pane-bridge.js";

function fixture(native = true) {
  const core = new SurfaceCore({ persistentState: { primarySurfaceId: null, version: 1 }, now: () => 1 });
  const surface = core.ensurePrimarySurface("test", { width: 1000, height: 700, scale: 1 });
  core.applyProviderBootstrapTopology(surface.surfaceId, {
    initialPaneId: 7, initialPaneLabel: 7, windowLabel: "a",
  });
  const paneId = core.getRendererWindowState(surface.surfaceId).panes[0]!.paneId;
  const identity = core.resolvedPaneGeometryIdentity(surface.surfaceId);
  const viewport = { contentSize: { width: 400, height: 300 }, visibleRect: { x: 0, y: 0, width: 400, height: 300 },
    scrollOffset: { x: 0, y: 0 }, zoomLevel: 1 };
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  core.updatePaneSnapshot(surface.surfaceId, paneId, { ...identity, bounds, viewport });
  const paneLineageId = core.panesList(surface.surfaceId).panes[0]!.paneLineageId;
  if (native) core.markNativePaneMaterialized(surface.surfaceId, {
    op: "native_pane.host", focus: core.projectNativePaneFocus(surface.surfaceId),
    panes: [{ id: String(paneId), binding_id: "binding-7", content_id: "content-7", revision: 1 as never,
      geometry: { ...bounds, coordinateSpace: "compositor_logical", paneInstanceId: paneLineageId,
        surfaceEpoch: identity.surfaceEpoch, topologyEpoch: identity.topologyRevision as never,
        geometryRevision: identity.geometryRevision as never } }],
  });
  const presentation = { paneId, paneLineageId, snapshot: { ...identity,
    bounds: { x: 10, y: 10, width: 980, height: 680 }, viewport, selection: null } };
  return { core, surfaceId: surface.surfaceId, paneId, identity, bounds, presentation };
}
function ack(wire: CompositorControlRequest) {
  if (wire.type !== "pane_presentation.set") throw new Error("unexpected mutation");
  const { version, request_revision, presentation_generation, selected } = wire.request;
  return { ok: true, pane_presentation: { version, request_revision, presentation_generation, selected } };
}
const capability = { ok: true, status: { capabilities: { [PANE_PRESENTATION_CAPABILITY]: 1 } } };

test("renderer request resolves lineage locally and rejects malformed identity before transport", async () => {
  const f = fixture(false);
  const coordinator = new PanePresentationCoordinator(f.core, () => null);
  await assert.rejects(coordinator.applyRendererRequest(f.surfaceId, { paneId: f.paneId }), /identity/);
  await assert.rejects(coordinator.applyRendererRequest(f.surfaceId, {
    identity: f.identity, paneId: -1,
  }), /pane/);
  await coordinator.applyRendererRequest(f.surfaceId, {
    identity: f.identity, paneId: f.paneId, paneLineageId: "forged-lineage",
    bounds: f.presentation.snapshot.bounds, viewport: f.presentation.snapshot.viewport,
  });
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.presentation.snapshot.bounds);
});

test("expanded ordinary reports cannot overwrite tiled persistence or acknowledged geometry", async () => {
  const f = fixture(false);
  const saved = f.core.getPersistentState();
  await new PanePresentationCoordinator(f.core, () => null).apply(f.surfaceId, f.presentation, f.identity);
  const viewport = structuredClone(f.presentation.snapshot.viewport);
  viewport.scrollOffset.y = 17;
  viewport.visibleRect.height = 676;
  f.core.updatePaneSnapshot(f.surfaceId, f.paneId, { ...f.identity,
    bounds: { x: 0, y: 0, width: 1000, height: 700 }, viewport });
  assert.deepEqual(f.core.getPersistentState(), saved);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.presentation.snapshot.bounds);
  assert.deepEqual(f.core.captureSnapshot(f.surfaceId, f.paneId).viewport, viewport);
  f.core.updatePaneSnapshot(f.surfaceId, f.paneId, { viewport: { ...viewport, zoomLevel: 5 } });
  assert.deepEqual(f.core.captureSnapshot(f.surfaceId, f.paneId).viewport, viewport, "unfenced report is ignored");
  f.core.setPanePresentation(f.surfaceId, null);
  f.core.updatePaneSnapshot(f.surfaceId, f.paneId, { ...f.identity,
    bounds: f.presentation.snapshot.bounds, viewport }, true);
  assert.deepEqual(f.core.getPersistentState(), saved, "late display-only report after Restore is discarded");
});

test("native presentation remains tiled until exact acknowledgement and never changes persistence", async () => {
  const f = fixture();
  const saved = f.core.getPersistentState();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new PanePresentationCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    await pending;
    return ack(wire);
  });
  const transition = coordinator.apply(f.surfaceId, f.presentation, f.identity);
  await Promise.resolve();
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
  release();
  await transition;
  assert.equal(f.core.paneBounds(f.surfaceId, f.paneId)!.width, 980);
  assert.deepEqual(f.core.getPersistentState(), saved);
  await coordinator.apply(f.surfaceId, null, f.identity);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
});
test("rejected acknowledgement or missing native transport preserves tile", async () => {
  const f = fixture();
  const rejected = new PanePresentationCoordinator(f.core, () => async (wire) =>
    wire.type === "get_status" ? capability : { ok: true });
  await assert.rejects(rejected.apply(f.surfaceId, f.presentation, f.identity), /exact/);
  const missing = new PanePresentationCoordinator(f.core, () => null);
  await assert.rejects(missing.apply(f.surfaceId, f.presentation, f.identity), /routed/);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
});
test("late acknowledgement cannot re-enter after explicit invalidation", async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new PanePresentationCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    await pending; return ack(wire);
  });
  const transition = coordinator.apply(f.surfaceId, f.presentation, f.identity);
  coordinator.invalidate(f.surfaceId);
  release();
  await assert.rejects(transition, /superseded/);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
});
test("topology change while acknowledgement is pending prevents display commit", async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new PanePresentationCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    await pending; return ack(wire);
  });
  const transition = coordinator.apply(f.surfaceId, f.presentation, f.identity);
  f.core.setViewport(f.surfaceId, { width: 900, height: 600, scale: 1 });
  release();
  await assert.rejects(transition, /stale/);
});
test("invalid bounds and malformed viewports reject before any transport request", async () => {
  const f = fixture();
  let calls = 0;
  const coordinator = new PanePresentationCoordinator(f.core, () => async () => { calls++; return capability; });
  f.presentation.snapshot.bounds.width = Infinity;
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /bounds/);
  f.presentation.snapshot.bounds.width = 980;
  f.presentation.snapshot.viewport.zoomLevel = NaN;
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /viewport/);
  assert.equal(calls, 0);
});
test("renderer-only local window needs no native transport", async () => {
  const f = fixture(false);
  await new PanePresentationCoordinator(f.core, () => null).apply(f.surfaceId, f.presentation, f.identity);
  assert.equal(f.core.paneBounds(f.surfaceId, f.paneId)!.width, 980);
});
test("native binding replacement during acknowledgement cannot apply old display authority", async () => {
  const f = fixture();
  const coordinator = new PanePresentationCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    const replacement = f.core.projectCurrentNativePaneGeometry(f.surfaceId, [f.paneId]);
    replacement.panes[0]!.binding_id = "replacement-binding";
    f.core.markNativePaneMaterialized(f.surfaceId, replacement);
    return ack(wire);
  });
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /exact/);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
});
