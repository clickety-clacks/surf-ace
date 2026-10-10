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
  assert.ok(typeof paneLineageId === "string" && paneLineageId);
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
  const { version, request_revision, presentation_generation, window_route, selected, overlay_rect, content_rect } = wire.request;
  return { ok: true, pane_presentation: { version, request_revision, presentation_generation, window_route, selected, overlay_rect, content_rect } };
}
const host = { host_surface_id: 99, host_incarnation: "host-1", root_geometry_generation: 1,
  source_rect: { x: 0, y: 0, width: 1000, height: 700 }, logical_rect: { x: 0, y: 0, width: 1000, height: 700 } };
function createCoordinator(core: SurfaceCore, transport: ConstructorParameters<typeof PanePresentationCoordinator>[1],
  failure?: ConstructorParameters<typeof PanePresentationCoordinator>[2],
  notice?: ConstructorParameters<typeof PanePresentationCoordinator>[4]) {
  return new PanePresentationCoordinator(core, transport, failure, async (surfaceId) => ({
    window_id: `window:${surfaceId}`, renderer_surface_id: surfaceId, host: structuredClone(host),
  }), notice);
}
const capability = { ok: true, status: { pane_presentation_host: host, capabilities: { [PANE_PRESENTATION_CAPABILITY]: 1 } } };

test("renderer request resolves lineage locally and rejects malformed identity before transport", async () => {
  const f = fixture(false);
  const coordinator = createCoordinator(f.core, () => null);
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
  await createCoordinator(f.core, () => null).apply(f.surfaceId, f.presentation, f.identity);
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
  const coordinator = createCoordinator(f.core, () => async (wire) => {
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
  const rejected = createCoordinator(f.core, () => async (wire) =>
    wire.type === "get_status" ? capability : { ok: true });
  await assert.rejects(rejected.apply(f.surfaceId, f.presentation, f.identity), /exact/);
  const missing = createCoordinator(f.core, () => null);
  await assert.rejects(missing.apply(f.surfaceId, f.presentation, f.identity), /routed/);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
});
test("late acknowledgement cannot re-enter after explicit invalidation", async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = createCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    await pending; return ack(wire);
  });
  const transition = coordinator.apply(f.surfaceId, f.presentation, f.identity);
  coordinator.invalidate(f.surfaceId);
  release();
  await assert.rejects(transition, /superseded/);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
});

test("acknowledged stale native selection is remotely restored before invalidation settles", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const sent = new Promise<void>((resolve) => { entered = resolve; });
  const controls: Array<Extract<CompositorControlRequest, { type: "pane_presentation.set" }>> = [];
  const coordinator = createCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected request");
    controls.push(structuredClone(wire));
    if (wire.request.selected) { entered(); await pending; }
    return ack(wire);
  });
  const transition = coordinator.apply(f.surfaceId, f.presentation, f.identity);
  await sent;
  const retired = coordinator.invalidate(f.surfaceId);
  release();
  await assert.rejects(transition, /superseded/);
  await retired;
  assert.deepEqual(controls.map((wire) => wire.request.request_revision), [1, 2]);
  assert.equal(controls[1]!.request.selected, null);
  assert.deepEqual(controls[1]!.request.presentation_generation, controls[0]!.request.presentation_generation);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
});

test("new selection waits for stale acknowledgement retirement and uses a later wire revision", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const sent = new Promise<void>((resolve) => { entered = resolve; });
  const revisions: number[] = [];
  const selected: boolean[] = [];
  const coordinator = createCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected request");
    revisions.push(wire.request.request_revision);
    selected.push(wire.request.selected !== null);
    if (revisions.length === 1) { entered(); await pending; }
    return ack(wire);
  });
  const first = coordinator.apply(f.surfaceId, f.presentation, f.identity);
  await sent;
  const replacement = structuredClone(f.presentation);
  replacement.snapshot.bounds.width = 960;
  const second = coordinator.apply(f.surfaceId, replacement, f.identity);
  release();
  await assert.rejects(first, /superseded/);
  await second;
  assert.deepEqual(revisions, [1, 2, 3]);
  assert.deepEqual(selected, [true, false, true]);
  assert.equal(f.core.paneBounds(f.surfaceId, f.paneId)!.width, 960);
});

test("authoritative topology and surface close automatically retire accepted remote presentation", async () => {
  for (const change of ["topology", "close"] as const) {
    const f = fixture();
    const controls: Array<Extract<CompositorControlRequest, { type: "pane_presentation.set" }>> = [];
    const failures: unknown[] = [];
    const coordinator = createCoordinator(f.core, () => async (wire) => {
      if (wire.type === "get_status") return capability;
      if (wire.type !== "pane_presentation.set") throw new Error("unexpected request");
      controls.push(structuredClone(wire));
      return ack(wire);
    }, (_surface, error) => failures.push(error));
    await coordinator.apply(f.surfaceId, f.presentation, f.identity);
    if (change === "topology") {
      f.core.paneSplit(f.surfaceId, { count: 2, direction: "horizontal",
        newPaneIds: [9], newPaneLabels: [9], paneId: f.paneId });
    } else f.core.removeSurface(f.surfaceId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(controls.length, 2, change);
    assert.equal(controls[1]!.request.selected, null, change);
    assert.deepEqual(controls[1]!.request.presentation_generation,
      controls[0]!.request.presentation_generation, change);
    assert.deepEqual(failures, []);
  }
});

test("lost mutation reply blocks new selection until exact retirement is acknowledged", async () => {
  const f = fixture();
  let allowRestore = false;
  let first = true;
  const controls: Array<Extract<CompositorControlRequest, { type: "pane_presentation.set" }>> = [];
  const failures: unknown[] = [];
  const coordinator = createCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected request");
    controls.push(structuredClone(wire));
    if (wire.request.selected && first) { first = false; throw new Error("lost mutation reply"); }
    if (!wire.request.selected && !allowRestore) throw new Error("retirement unavailable");
    return ack(wire);
  }, (_surface, error) => failures.push(error));
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /lost mutation/);
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /retirement unavailable/);
  assert.equal(controls.filter((wire) => wire.request.selected).length, 1,
    "uncertain retirement forbids sending a second selection");
  assert.equal(failures.length, 1);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
  allowRestore = true;
  await coordinator.apply(f.surfaceId, f.presentation, f.identity);
  assert.deepEqual(controls.map((wire) => wire.request.request_revision), [1, 2, 3, 4, 5]);
  assert.equal(controls[3]!.request.selected, null);
  assert.equal(f.core.paneBounds(f.surfaceId, f.paneId)!.width, 980);
});
test("an earlier confirmed clear cannot hide a later unretired native selection", async () => {
  const f = fixture();
  let retire = true;
  const coordinator = createCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected request");
    if (wire.request.selected) throw new Error("lost selection reply");
    if (!retire) throw new Error("retirement unavailable");
    return ack(wire);
  });
  await coordinator.apply(f.surfaceId, null, f.identity);
  assert.equal(coordinator.wasPresentationCleared(f.surfaceId), true);
  retire = false;
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /lost selection/);
  assert.equal(coordinator.hasUnretiredPresentation(f.surfaceId), true);
  assert.equal(coordinator.wasPresentationCleared(f.surfaceId), false,
    "the renderer must not admit tiled mutation on stale clear evidence");
  retire = true;
  await coordinator.apply(f.surfaceId, null, f.identity);
  assert.equal(coordinator.hasUnretiredPresentation(f.surfaceId), false);
  assert.equal(coordinator.wasPresentationCleared(f.surfaceId), true);
});

test("topology change while acknowledgement is pending prevents display commit", async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = createCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    await pending; return ack(wire);
  });
  const transition = coordinator.apply(f.surfaceId, f.presentation, f.identity);
  f.core.setViewport(f.surfaceId, { width: 900, height: 600, scale: 1 });
  release();
  await assert.rejects(transition, /stale|superseded/);
});
test("invalid bounds and malformed viewports reject before any transport request", async () => {
  const f = fixture();
  let calls = 0;
  const coordinator = createCoordinator(f.core, () => async () => { calls++; return capability; });
  f.presentation.snapshot.bounds.width = Infinity;
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /bounds/);
  f.presentation.snapshot.bounds.width = 980;
  f.presentation.snapshot.viewport.zoomLevel = NaN;
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /viewport/);
  assert.equal(calls, 0);
});
test("renderer-only local window needs no native transport", async () => {
  const f = fixture(false);
  await createCoordinator(f.core, () => null).apply(f.surfaceId, f.presentation, f.identity);
  assert.equal(f.core.paneBounds(f.surfaceId, f.paneId)!.width, 980);
});
test("native binding replacement during acknowledgement cannot apply old display authority", async () => {
  const f = fixture();
  const coordinator = createCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    const replacement = f.core.projectCurrentNativePaneGeometry(f.surfaceId, [f.paneId]);
    replacement.panes[0]!.binding_id = "replacement-binding";
    f.core.markNativePaneMaterialized(f.surfaceId, replacement);
    return ack(wire);
  });
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /exact/);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
});

test("host incarnation replacement before ack display commit rejects and never restores onto replacement", async () => {
  const f = fixture();
  let currentHost = structuredClone(host);
  const selected: boolean[] = [];
  const coordinator = new PanePresentationCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return { ...capability, status: { ...capability.status, pane_presentation_host: currentHost } };
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected request");
    selected.push(wire.request.selected !== null);
    const response = ack(wire);
    currentHost = { ...host, host_incarnation: "replacement-host" };
    return response;
  }, undefined, async (surfaceId) => ({ window_id: `window:${surfaceId}`, renderer_surface_id: surfaceId,
    host: structuredClone(currentHost) }));
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /exact/);
  assert.deepEqual(selected, [true], "old Restore cannot mutate replacement host");
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
  assert.equal(coordinator.wasPresentationCleared(f.surfaceId), true);
});

test("native presentation without independently resolved window route cannot mutate", async () => {
  const f = fixture();
  let calls = 0;
  const coordinator = new PanePresentationCoordinator(f.core, () => async () => { calls++; return capability; });
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /verified.*route/);
  assert.equal(calls, 0);
});


test("second owned window retires accepted route using original sender and blocks both surfaces", async () => {
  const f = fixture();
  const wires: Array<Extract<CompositorControlRequest, { type: "pane_presentation.set" }>> = [];
  const notices: Array<{ phase: string; revision: number }> = [];
  const send = async (wire: CompositorControlRequest) => {
    if (wire.type === "get_status") return capability;
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected");
    wires.push(structuredClone(wire)); return ack(wire);
  };
  let routeBlocked = false;
  const coordinator = createCoordinator(f.core, () => {
    if (routeBlocked) throw new Error("new route must not be used for retirement");
    return send;
  }, undefined, (notice) => notices.push(notice));
  await coordinator.setOwnedWindows([f.surfaceId]);
  await coordinator.apply(f.surfaceId, f.presentation, f.identity);
  const other = f.core.createAdditionalSurface("second", { width: 1000, height: 700, scale: 1 });
  const saved = f.core.getPersistentState();
  const otherBefore = f.core.getRendererWindowState(other.surfaceId);
  routeBlocked = true;
  await coordinator.setOwnedWindows([f.surfaceId, other.surfaceId]);
  assert.deepEqual(wires.map((wire) => Boolean(wire.request.selected)), [true, false]);
  assert.deepEqual(wires[1]!.request.window_route, wires[0]!.request.window_route);
  assert.deepEqual(notices.map((notice) => notice.phase), ["blocked", "cleared"]);
  assert.equal(notices[0]!.revision, notices[1]!.revision);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
  assert.deepEqual(f.core.getPersistentState(), saved);
  assert.deepEqual(f.core.getRendererWindowState(other.surfaceId), otherBefore);
  await assert.rejects(coordinator.apply(f.surfaceId, f.presentation, f.identity), /ownership/);
  const otherPane = f.core.panesList(other.surfaceId).panes[0]!;
  assert.ok(typeof otherPane.paneLineageId === "string" && otherPane.paneLineageId);
  await assert.rejects(coordinator.apply(other.surfaceId, { ...f.presentation, paneId: otherPane.paneId,
    paneLineageId: otherPane.paneLineageId, snapshot: { ...f.presentation.snapshot,
      ...f.core.resolvedPaneGeometryIdentity(other.surfaceId) } }, f.core.resolvedPaneGeometryIdentity(other.surfaceId)), /ownership/);
  assert.equal(wires.length, 2, "neither ambiguous surface may mutate compositor");
  routeBlocked = false;
  await coordinator.setOwnedWindows([f.surfaceId]);
  const revision = await coordinator.apply(f.surfaceId, f.presentation, f.identity);
  assert.ok(revision > notices[1]!.revision);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.presentation.snapshot.bounds);
});

test("second window fences a pending ack and confirms clear only after old projection retires", async () => {
  const f = fixture();
  let entered!: () => void; let release!: () => void;
  const sent = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const notices: string[] = []; const selected: boolean[] = [];
  const coordinator = createCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected");
    selected.push(Boolean(wire.request.selected));
    if (wire.request.selected) { entered(); await pending; }
    return ack(wire);
  }, undefined, (notice) => notices.push(notice.phase));
  await coordinator.setOwnedWindows([f.surfaceId]);
  const transition = coordinator.apply(f.surfaceId, f.presentation, f.identity);
  await sent;
  const rejection = assert.rejects(transition, /superseded/);
  const ownershipChanged = coordinator.setOwnedWindows([f.surfaceId, "second-window"]);
  assert.deepEqual(notices, ["blocked"]);
  release(); await rejection; await ownershipChanged;
  assert.deepEqual(selected, [true, false]);
  assert.deepEqual(notices, ["blocked", "cleared"]);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
});

test("failed ownership retirement stays uncertain and Restore retries original sender while blocked", async () => {
  const f = fixture(); let fail = false;
  const notices: string[] = []; const restores: number[] = [];
  const coordinator = createCoordinator(f.core, () => async (wire) => {
    if (wire.type === "get_status") return capability;
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected");
    if (!wire.request.selected) { restores.push(wire.request.request_revision); if (fail) throw new Error("retirement offline"); }
    return ack(wire);
  }, undefined, (notice) => notices.push(notice.phase));
  await coordinator.setOwnedWindows([f.surfaceId]);
  await coordinator.apply(f.surfaceId, f.presentation, f.identity);
  fail = true;
  await assert.rejects(coordinator.setOwnedWindows([f.surfaceId, "second-window"]), /offline/);
  assert.deepEqual(notices, ["blocked"], "failed retirement must not claim confirmed clear");
  assert.equal(coordinator.wasPresentationCleared(f.surfaceId), false);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.presentation.snapshot.bounds);
  fail = false;
  await coordinator.apply(f.surfaceId, null, f.identity);
  assert.equal(coordinator.wasPresentationCleared(f.surfaceId), true);
  assert.deepEqual(f.core.paneBounds(f.surfaceId, f.paneId), f.bounds);
  assert.ok(restores[1]! > restores[0]!);
});
