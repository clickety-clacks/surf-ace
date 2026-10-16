import assert from "node:assert/strict";
import { SurfaceCore } from "../src/surface-core.js";
import { PanePresentationCoordinator } from "../src/pane-presentation-coordinator.js";
import { PANE_PRESENTATION_CAPABILITY } from "../src/pane-presentation.js";
import type { CompositorControlRequest } from "../src/native-pane-bridge.js";

/** Actual serialized coordinator outcomes for the held-A / queued-B alias race. */
export async function queuedAuthorityRace(rounds = 1, priorRequests = 0) {
  const core = new SurfaceCore({ persistentState: { primarySurfaceId: null, version: 1 }, now: () => 1 });
  const { surfaceId } = core.ensurePrimarySurface("race", { width: 1000, height: 700, scale: 1 });
  core.applyProviderBootstrapTopology(surfaceId, { initialPaneId: 7, initialPaneLabel: 7, windowLabel: "a" });
  const identity = core.resolvedPaneGeometryIdentity(surfaceId);
  const paneLineageId = core.panesList(surfaceId).panes[0]!.paneLineageId;
  assert.ok(paneLineageId);
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  const viewport = { contentSize: { width: 400, height: 300 }, visibleRect: { ...bounds },
    scrollOffset: { x: 0, y: 0 }, zoomLevel: 1 };
  core.updatePaneSnapshot(surfaceId, 7, { ...identity, bounds, viewport });
  core.markNativePaneMaterialized(surfaceId, { op: "native_pane.host", focus: core.projectNativePaneFocus(surfaceId),
    panes: [{ id: "7", binding_id: "race-binding", content_id: "race-content", revision: 1 as never,
      geometry: { ...bounds, coordinateSpace: "compositor_logical", paneInstanceId: paneLineageId,
        surfaceEpoch: identity.surfaceEpoch, topologyEpoch: identity.topologyRevision as never,
        geometryRevision: identity.geometryRevision as never } }] });
  const host = { host_surface_id: 99, host_incarnation: "race-host", root_geometry_generation: 1,
    source_rect: { x: 0, y: 0, width: 1000, height: 700 }, logical_rect: { x: 0, y: 0, width: 1000, height: 700 } };
  const gate = () => { let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };
  let firstSent = gate(), firstAck = gate(), secondRoute = gate(), releaseRoute = gate();
  let selections = 0, routeCalls = 0, allowRetirement = true, racing = false;
  const controls: boolean[] = [];
  const cases: Array<{ clear: Awaited<ReturnType<PanePresentationCoordinator["applyRendererOutcome"]>>;
    blocked: Awaited<ReturnType<PanePresentationCoordinator["applyRendererOutcome"]>>;
    recovery: Awaited<ReturnType<PanePresentationCoordinator["applyRendererOutcome"]>> }> = [];
  const coordinator = new PanePresentationCoordinator(core, () => async (wire: CompositorControlRequest) => {
    if (wire.type === "get_status") return { ok: true, status: { pane_presentation_host: host,
      capabilities: { [PANE_PRESENTATION_CAPABILITY]: 1 } } };
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected control");
    controls.push(wire.request.selected !== null);
    if (wire.request.selected) {
      if (++selections === 1) { firstSent.release(); await firstAck.promise; }
      else throw new Error("lost B selection reply");
    } else if (!allowRetirement) throw new Error("B retirement unavailable");
    const { version, request_revision, presentation_generation, window_route, selected, overlay_rect, content_rect } = wire.request;
    return { ok: true, pane_presentation: { version, request_revision, presentation_generation, window_route, selected, overlay_rect, content_rect } };
  }, undefined, async () => {
    if (racing && ++routeCalls === 2) { secondRoute.release(); await releaseRoute.promise; }
    return { window_id: "race-window", renderer_surface_id: surfaceId, host };
  });
  const payload = { identity, paneId: 7, bounds: { x: 10, y: 10, width: 980, height: 680 }, viewport };
  const saved = core.getPersistentState();
  for (let seed = 0; seed < priorRequests; seed++) {
    await coordinator.applyRendererOutcome(surfaceId, { identity, paneId: null });
  }
  racing = true;
  for (let round = 0; round < rounds; round++) {
  firstSent = gate(); firstAck = gate(); secondRoute = gate(); releaseRoute = gate();
  selections = 0; routeCalls = 0; allowRetirement = true; controls.length = 0;
  const first = coordinator.applyRendererOutcome(surfaceId, payload);
  await firstSent.promise;
  const second = coordinator.applyRendererOutcome(surfaceId, payload);
  firstAck.release();
  const clear = await first;
  await secondRoute.promise;
  assert.equal(clear.ok, false);
  assert.equal(clear.presentationCleared, true);
  assert.equal(clear.presentationBlocked, false);
  assert.deepEqual(controls, [true, false], "B is held before native send");
  assert.deepEqual(coordinator.authorityReceipt(surfaceId), {
    authorityRevision: clear.authorityRevision, presentationCleared: true, presentationBlocked: false,
  }, "queued B cannot certify authority settlement");
  allowRetirement = false;
  releaseRoute.release();
  const blocked = await second;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.presentationBlocked, true);
  assert.equal(blocked.presentationCleared, false);
  assert.ok(blocked.authorityRevision > clear.authorityRevision, "B uncertainty cannot alias A clear");
  assert.deepEqual(controls, [true, false, true, false]);
  allowRetirement = true;
  const recovery = await coordinator.applyRendererOutcome(surfaceId, { identity, paneId: null });
  assert.equal(recovery.ok, true);
  assert.equal(recovery.presentationCleared, true);
  assert.equal(recovery.presentationBlocked, false);
  assert.ok(recovery.authorityRevision > blocked.authorityRevision);
  assert.deepEqual(core.getPersistentState(), saved);
  cases.push({ clear, blocked, recovery });
  }
  return cases;
}
