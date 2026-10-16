import {
  compositorPaneIdForSurface,
  nativePaneInstanceIdsForCompositor,
  type CompositorControlRequest,
  type CompositorControlResponse,
  type NativePaneMaterialization,
  type NativePanePresentationGeneration,
} from "./native-pane-bridge.js";

export const PANE_PRESENTATION_CAPABILITY = "pane_pop_out_presentation";

// A sole *current* window is insufficient: an old Wayland host can outlive
// window A while same-sized window B is created in the same Electron process.
// This initial implementation admits only the first window of a token-bound
// process. Replacement/multiple windows require an explicit per-window backend.
export class NativePresentationWindowBinding {
  private firstWindow: { windowId: string; surfaceId: string } | null = null;
  private ambiguous = false;

  constructor(private readonly processId: number, private readonly launchToken: string | undefined) {}

  recordCreatedWindow(windowId: string, surfaceId: string): void {
    if (this.firstWindow || !windowId || !surfaceId) this.ambiguous = true;
    else this.firstWindow = { windowId, surfaceId };
  }

  assertObservedOwner(response: CompositorControlResponse, windowId: string, surfaceId: string): void {
    const status = response.status as Record<string, unknown> | undefined;
    const runtime = status?.runtime as Record<string, unknown> | undefined;
    const attached = runtime?.main_app_launch_state as { state?: unknown; pid?: unknown } | undefined;
    const evidence = runtime?.main_app_binding_evidence as { launchToken?: unknown } | undefined;
    const host = status?.pane_presentation_host as { host_surface_id?: unknown } | undefined;
    if (this.ambiguous || !this.firstWindow || this.firstWindow.windowId !== windowId || this.firstWindow.surfaceId !== surfaceId ||
        !Number.isSafeInteger(this.processId) || this.processId <= 0 || !this.launchToken || response.ok !== true ||
        attached?.state !== "attached" || attached.pid !== this.processId ||
        runtime?.main_app_launch_token !== this.launchToken || evidence?.launchToken !== "matched" ||
        !Number.isSafeInteger(host?.host_surface_id) || runtime?.main_app_surface_id !== host?.host_surface_id) {
      throw new Error("native presentation lacks an independently observed initial-window process binding");
    }
  }
}

type Rect = { x: number; y: number; width: number; height: number };
export type ObservedPresentationHost = {
  host_surface_id: number;
  host_incarnation: string;
  root_geometry_generation: number;
  source_rect: Rect;
  logical_rect: Rect;
};
export type PresentationWindowRoute = {
  window_id: string;
  renderer_surface_id: string;
  host: ObservedPresentationHost;
};
export type PanePresentationSelection = {
  host: "renderer";
  renderer_pane_id: number;
  pane_lineage_id: string;
} | {
  host: "native";
  renderer_pane_id: number;
  pane_lineage_id: string;
  native_pane_id: string;
  native_pane_instance_id: string;
};
export type PanePresentationRequest = {
  version: 1;
  request_revision: number;
  presentation_generation: NativePanePresentationGeneration;
  window_route: PresentationWindowRoute;
  selected: PanePresentationSelection | null;
  overlay_rect: Rect | null;
  content_rect: Rect | null;
};
export type PanePresentationControlRequest = {
  type: "pane_presentation.set";
  request: PanePresentationRequest;
};

function rectIsValid(rect: Rect): boolean {
  return Boolean(rect) && Object.keys(rect).length === 4 && Object.values(rect).every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 &&
    rect.width > 0 && rect.height > 0;
}

export function panePresentationWindowRoute(
  response: CompositorControlResponse, windowId: string, surfaceId: string,
  viewport: { width: number; height: number },
): PresentationWindowRoute {
  const host = (response.status as { pane_presentation_host?: ObservedPresentationHost } | undefined)?.pane_presentation_host;
  if (response.ok !== true || !windowId || !surfaceId || !host || Object.keys(host).length !== 5 ||
      !Number.isSafeInteger(host.host_surface_id) || host.host_surface_id < 1 || host.host_surface_id > 0xffffffff ||
      typeof host.host_incarnation !== "string" || !host.host_incarnation ||
      !Number.isSafeInteger(host.root_geometry_generation) || host.root_geometry_generation < 0 ||
      !rectIsValid(host.source_rect) || !rectIsValid(host.logical_rect) ||
      host.source_rect.x !== 0 || host.source_rect.y !== 0 || !sameValue(host.source_rect, host.logical_rect) ||
      host.source_rect.width !== viewport.width || host.source_rect.height !== viewport.height) {
    throw new Error("compositor window host coordinate identity is unavailable or stale");
  }
  return { window_id: windowId, renderer_surface_id: surfaceId, host: structuredClone(host) };
}

export function panePresentationRequest(
  materialization: NativePaneMaterialization,
  revision: number,
  selected: { paneId: number; paneLineageId: string } | null,
  overlay: Rect | null,
  content: Rect | null,
  route: PresentationWindowRoute,
): PanePresentationControlRequest {
  const focus = materialization.focus;
  const validated = panePresentationWindowRoute({ ok: true, status: { pane_presentation_host: route?.host } },
    route?.window_id, String(focus.surfaceId), route?.host?.source_rect ?? { width: 0, height: 0 });
  if (!sameValue(route, validated)) throw new Error("presentation window route does not own its renderer surface");
  const ids = new Set<string>();
  for (const pane of materialization.panes) {
    const id = String(pane.id);
    if (ids.has(id) || !pane.geometry.paneInstanceId ||
        pane.geometry.coordinateSpace !== "compositor_logical" ||
        pane.geometry.surfaceEpoch !== focus.surfaceEpoch ||
        pane.geometry.topologyEpoch !== focus.topologyEpoch ||
        pane.geometry.geometryRevision !== focus.geometryRevision) {
      throw new Error("native cohort does not match its routed lineage/generation");
    }
    ids.add(id);
  }
  if (!Number.isSafeInteger(revision) || revision <= 0 || !focus.surfaceId || !focus.surfaceEpoch ||
      ![focus.geometryRevision, focus.topologyEpoch, focus.focusRevision ?? 0]
        .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("invalid pane presentation generation or revision");
  }
  if (selected && (!Number.isSafeInteger(selected.paneId) || selected.paneId <= 0 ||
      !selected.paneLineageId || !overlay || !content || !rectIsValid(overlay) || !rectIsValid(content) ||
      content.x < overlay.x || content.y < overlay.y ||
      content.x + content.width > overlay.x + overlay.width ||
      content.y + content.height > overlay.y + overlay.height)) {
    throw new Error("invalid selected pane identity or display rectangles");
  }
  if (!selected && (overlay !== null || content !== null)) {
    throw new Error("Restore cannot carry display rectangles");
  }
  const native = selected ? materialization.panes.find((pane) => String(pane.id) === String(selected.paneId)) : null;
  if (native && (native.geometry.paneInstanceId !== selected!.paneLineageId ||
      native.geometry.surfaceEpoch !== focus.surfaceEpoch ||
      native.geometry.topologyEpoch !== focus.topologyEpoch ||
      native.geometry.geometryRevision !== focus.geometryRevision)) {
    throw new Error("selected native pane does not match its routed lineage/generation");
  }
  const instances = nativePaneInstanceIdsForCompositor(materialization);
  return {
    type: "pane_presentation.set",
    request: {
      version: 1, request_revision: revision,
      window_route: structuredClone(route),
      presentation_generation: {
        surface_id: String(focus.surfaceId), surface_epoch: focus.surfaceEpoch,
        topology_epoch: Number(focus.topologyEpoch), geometry_revision: Number(focus.geometryRevision),
        focus_revision: focus.focusRevision ?? 0,
        pane_instances: Object.fromEntries(materialization.panes.map((pane) => [
          compositorPaneIdForSurface(focus.surfaceId, pane.id), pane.geometry.paneInstanceId,
        ])),
      },
      selected: selected ? {
        renderer_pane_id: selected.paneId, pane_lineage_id: selected.paneLineageId,
        ...(native ? {
          host: "native" as const,
          native_pane_id: compositorPaneIdForSurface(focus.surfaceId, native.id),
          native_pane_instance_id: instances.get(String(native.id))!,
        } : { host: "renderer" as const }),
      } : null,
      overlay_rect: overlay ? { ...overlay } : null,
      content_rect: content ? { ...content } : null,
    },
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" ||
      Array.isArray(a) || Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

export function assertPanePresentationAcknowledged(
  response: CompositorControlResponse,
  control: PanePresentationControlRequest,
): void {
  const { version, request_revision, presentation_generation, window_route, selected, overlay_rect, content_rect } = control.request;
  if (response.ok !== true || !sameValue(response.pane_presentation, {
    version, request_revision, presentation_generation, window_route, selected, overlay_rect, content_rect,
  })) throw new Error("compositor did not acknowledge the exact pane presentation");
}

export async function acknowledgePanePresentation(
  send: (request: CompositorControlRequest) => Promise<CompositorControlResponse>,
  control: PanePresentationControlRequest,
): Promise<void> {
  const request = structuredClone(control);
  const status = await send({ type: "get_status" });
  const capabilities = (status.status as { capabilities?: Record<string, unknown> } | undefined)?.capabilities;
  if (status.ok !== true || capabilities?.[PANE_PRESENTATION_CAPABILITY] !== 1) {
    throw new Error("compositor pane pop-out presentation is unavailable");
  }
  if (request.request.selected !== null) {
    const route = panePresentationWindowRoute(status, request.request.window_route.window_id,
      request.request.window_route.renderer_surface_id, request.request.window_route.host.source_rect);
    if (!sameValue(route, request.request.window_route)) throw new Error("compositor presentation host changed before mutation");
  }
  assertPanePresentationAcknowledged(await send(structuredClone(request)), request);
}
