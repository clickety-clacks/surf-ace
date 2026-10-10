import assert from "node:assert/strict";
import test from "node:test";
import { compositorPaneIdForSurface, type NativePaneMaterialization } from "../src/native-pane-bridge.js";
import {
  acknowledgePanePresentation, assertPanePresentationAcknowledged,
  NativePresentationWindowBinding,
  panePresentationRequest, PANE_PRESENTATION_CAPABILITY,
  type PanePresentationControlRequest, panePresentationWindowRoute, type PresentationWindowRoute,
} from "../src/pane-presentation.js";

function materialization(): NativePaneMaterialization {
  return {
    op: "native_pane.update",
    focus: { surfaceId: "s", surfaceEpoch: "s:1", topologyEpoch: 2 as never,
      geometryRevision: 3 as never, focusRevision: 4, focusedPaneId: "7", focusedPaneInstanceId: "lineage-7" },
    panes: [{ id: "7", revision: 1 as never, binding_id: "binding-7",
      geometry: { coordinateSpace: "compositor_logical", x: 0, y: 0, width: 400, height: 300,
        geometryRevision: 3 as never, topologyEpoch: 2 as never, surfaceEpoch: "s:1", paneInstanceId: "lineage-7" } }],
  };
}
const host = { host_surface_id: 99, host_incarnation: "host-1", root_geometry_generation: 1,
  source_rect: { x: 0, y: 0, width: 1000, height: 700 }, logical_rect: { x: 0, y: 0, width: 1000, height: 700 } };
const route: PresentationWindowRoute = { window_id: "electron-window:1", renderer_surface_id: "s", host };

test("initial native window requires backend-observed peer PID, launch token and exact host role", () => {
  const binding = new NativePresentationWindowBinding(1234, "private-launch");
  binding.recordCreatedWindow("electron-window:1", "s");
  const status = { pane_presentation_host: host, runtime: {
    main_app_launch_state: { state: "attached", pid: 1234 }, main_app_launch_token: "private-launch",
    main_app_binding_evidence: { launchToken: "matched" }, main_app_surface_id: host.host_surface_id,
  } };
  const response = { ok: true, status };
  binding.assertObservedOwner(response, "electron-window:1", "s");
  for (const patch of [
    { main_app_launch_state: { state: "attached", pid: 5678 } },
    { main_app_launch_state: { state: "launching", pid: 1234 } },
    { main_app_launch_token: "old-launch" },
    { main_app_binding_evidence: { launchToken: "missing" } },
    { main_app_binding_evidence: { launchToken: "unavailable" } },
    { main_app_surface_id: 100 },
  ]) assert.throws(() => binding.assertObservedOwner({ ok: true,
    status: { ...status, runtime: { ...status.runtime, ...patch } } }, "electron-window:1", "s"));
  assert.throws(() => binding.assertObservedOwner(response, "electron-window:1", "foreign"));
  assert.throws(() => binding.assertObservedOwner({ ok: true, status: { pane_presentation_host: host } }, "electron-window:1", "s"));
  const unlaunched = new NativePresentationWindowBinding(1234, undefined);
  unlaunched.recordCreatedWindow("electron-window:1", "s");
  assert.throws(() => unlaunched.assertObservedOwner(response, "electron-window:1", "s"));
});

test("same-process equal-size replacement cannot first-bind to the retained old host", () => {
  const binding = new NativePresentationWindowBinding(1234, "private-launch");
  const response = { ok: true, status: { pane_presentation_host: host, runtime: {
    main_app_launch_state: { state: "attached", pid: 1234 }, main_app_launch_token: "private-launch",
    main_app_binding_evidence: { launchToken: "matched" }, main_app_surface_id: host.host_surface_id,
  } } };
  binding.recordCreatedWindow("electron-window:A", "A");
  binding.recordCreatedWindow("electron-window:B", "B");
  assert.throws(() => binding.assertObservedOwner(response, "electron-window:B", "B"));
  assert.throws(() => binding.assertObservedOwner(response, "electron-window:A", "A"),
    "closing B must not restore ambiguity to a sole-current-window claim");
  const restarted = new NativePresentationWindowBinding(2468, "new-private-launch");
  restarted.recordCreatedWindow("electron-window:B", "B");
  assert.throws(() => restarted.assertObservedOwner(response, "electron-window:B", "B"));
  restarted.assertObservedOwner({ ok: true, status: { ...response.status,
    runtime: { ...response.status.runtime, main_app_launch_state: { state: "attached", pid: 2468 },
      main_app_launch_token: "new-private-launch" } } }, "electron-window:B", "B");
});

const overlay = { x: 10, y: 10, width: 980, height: 680 };
const content = { x: 12, y: 42, width: 976, height: 646 };
function nativeRequest() {
  return panePresentationRequest(materialization(), 1, { paneId: 7, paneLineageId: "lineage-7" }, overlay, content, route);
}
function acknowledged(request: PanePresentationControlRequest) {
  const { version, request_revision, presentation_generation, window_route, selected, overlay_rect, content_rect } = request.request;
  return { ok: true, pane_presentation: structuredClone({ version, request_revision, presentation_generation, window_route, selected, overlay_rect, content_rect }) };
}
test("presentation native wire separates generation lineage from live host binding", () => {
  const request = nativeRequest();
  const id = compositorPaneIdForSurface("s", "7");
  assert.equal(request.type, "pane_presentation.set");
  assert.equal(request.request.presentation_generation.pane_instances![id], "lineage-7");
  assert.deepEqual(request.request.selected, { host: "native", renderer_pane_id: 7,
    pane_lineage_id: "lineage-7", native_pane_id: id, native_pane_instance_id: "binding-7" });
  assert.equal(materialization().panes[0]!.geometry.width, 400);
  assert.doesNotThrow(() => assertPanePresentationAcknowledged(acknowledged(request), request));
});
test("mixed renderer selection and Restore have distinct explicit acknowledged identities", () => {
  const mixed = panePresentationRequest(materialization(), 2, { paneId: 9, paneLineageId: "lineage-9" }, overlay, content, route);
  assert.deepEqual(mixed.request.selected, { host: "renderer", renderer_pane_id: 9, pane_lineage_id: "lineage-9" });
  const restore = panePresentationRequest(materialization(), 3, null, null, null, route);
  assert.equal(restore.request.selected, null);
  assert.throws(() => assertPanePresentationAcknowledged(acknowledged(mixed), restore), /exact/);
  assert.throws(() => panePresentationRequest(materialization(), 4, null, overlay, null, route), /Restore/);
});
test("unsupported capability never sends a mutating presentation request", async () => {
  for (const capabilities of [{}, { [PANE_PRESENTATION_CAPABILITY]: 2 }, { [PANE_PRESENTATION_CAPABILITY]: "1" }]) {
    const sent: unknown[] = [];
    await assert.rejects(acknowledgePanePresentation(async (request) => {
      sent.push(request); return { ok: true, status: { capabilities } };
    }, nativeRequest()), /unavailable/);
    assert.deepEqual(sent, [{ type: "get_status" }]);
  }
});
test("ok without exact version revision selection and generation acknowledgement fails closed", () => {
  const request = nativeRequest();
  assert.throws(() => assertPanePresentationAcknowledged({ ok: true }, request), /exact/);
  for (const field of ["version", "request_revision", "selected", "presentation_generation", "window_route", "overlay_rect", "content_rect"] as const) {
    const response = acknowledged(request);
    (response.pane_presentation as Record<string, unknown>)[field] = null;
    assert.throws(() => assertPanePresentationAcknowledged(response, request), /exact/);
  }
  const foreign = acknowledged(request);
  foreign.pane_presentation.presentation_generation.surface_epoch = "foreign";
  assert.throws(() => assertPanePresentationAcknowledged(foreign, request), /exact/);
});
test("pending request is copied before capability await and transport cannot mutate acknowledgement authority", async () => {
  const request = nativeRequest();
  const expected = structuredClone(request);
  await acknowledgePanePresentation(async (wire) => {
    if (wire.type === "get_status") {
      request.request.request_revision = 99;
      return { ok: true, status: { pane_presentation_host: host, capabilities: { [PANE_PRESENTATION_CAPABILITY]: 1 } } };
    }
    assert.deepEqual(wire, expected);
    return acknowledged(expected);
  }, request);
  await assert.rejects(acknowledgePanePresentation(async (wire) => {
    if (wire.type === "get_status") return { ok: true, status: { pane_presentation_host: host, capabilities: { [PANE_PRESENTATION_CAPABILITY]: 1 } } };
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected command");
    wire.request.request_revision += 1;
    return acknowledged(wire);
  }, nativeRequest()), /exact/);
  await assert.rejects(acknowledgePanePresentation(async (wire) => {
    if (wire.type === "get_status") return { ok: true, status: { pane_presentation_host: host,
      capabilities: { [PANE_PRESENTATION_CAPABILITY]: 1 } } };
    if (wire.type !== "pane_presentation.set") throw new Error("unexpected command");
    wire.request.content_rect!.width -= 1;
    return acknowledged(wire);
  }, nativeRequest()), /exact/, "rectangle changes cannot masquerade as exact acceptance");
});
test("foreign native lineage stale cohort and invalid rectangles are rejected before transport", () => {
  assert.throws(() => panePresentationRequest(materialization(), 1, { paneId: 7, paneLineageId: "foreign" }, overlay, content, route), /lineage/);
  const stale = materialization();
  stale.panes[0]!.geometry.geometryRevision = 2 as never;
  assert.throws(() => panePresentationRequest(stale, 1, { paneId: 9, paneLineageId: "lineage-9" }, overlay, content, route), /cohort/);
  assert.throws(() => panePresentationRequest(materialization(), 1, { paneId: 7, paneLineageId: "lineage-7" }, overlay, { ...content, width: NaN }, route), /rectangles/);
});

test("observed window route requires exact host incarnation and full-host identity transform", async () => {
  const status = { ok: true, status: { pane_presentation_host: host } };
  const resolved = panePresentationWindowRoute(status, route.window_id, "s", { width: 1000, height: 700 });
  assert.deepEqual(resolved, route);
  resolved.host.source_rect.width = 12;
  assert.equal(host.source_rect.width, 1000, "route cannot mutate observed authority");
  assert.throws(() => panePresentationWindowRoute(status, route.window_id, "s", { width: 999, height: 700 }), /identity/);
  for (const changed of [{ ...host, host_incarnation: "" }, { ...host, host_surface_id: 0 },
    { ...host, logical_rect: { ...host.logical_rect, x: 1 } },
    { ...host, logical_rect: { ...host.logical_rect, width: 2000 } }]) {
    assert.throws(() => panePresentationWindowRoute({ ok: true, status: { pane_presentation_host: changed } },
      route.window_id, "s", { width: 1000, height: 700 }), /identity/);
  }
  let mutations = 0;
  await assert.rejects(acknowledgePanePresentation(async (wire) => {
    if (wire.type === "get_status") return { ok: true, status: { pane_presentation_host: { ...host, host_incarnation: "replacement-host" },
      capabilities: { [PANE_PRESENTATION_CAPABILITY]: 1 } } };
    mutations++; return acknowledged(nativeRequest());
  }, nativeRequest()), /changed before mutation/);
  assert.equal(mutations, 0);
  const changedAck = acknowledged(nativeRequest());
  changedAck.pane_presentation.window_route.host.host_incarnation = "replacement-host";
  assert.throws(() => assertPanePresentationAcknowledged(changedAck, nativeRequest()), /exact/);
});
