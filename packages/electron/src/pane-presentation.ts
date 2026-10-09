import {
  compositorPaneIdForSurface,
  nativePaneInstanceIdsForCompositor,
  type CompositorControlRequest,
  type CompositorControlResponse,
  type NativePaneMaterialization,
  type NativePanePresentationGeneration,
} from "./native-pane-bridge.js";

export const PANE_PRESENTATION_CAPABILITY = "pane_pop_out_presentation";
type Rect = { x: number; y: number; width: number; height: number };
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
  selected: PanePresentationSelection | null;
  overlay_rect: Rect | null;
  content_rect: Rect | null;
};
export type PanePresentationControlRequest = {
  type: "pane_presentation.set";
  request: PanePresentationRequest;
};

function rectIsValid(rect: Rect): boolean {
  return Object.values(rect).every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 &&
    rect.width > 0 && rect.height > 0;
}

export function panePresentationRequest(
  materialization: NativePaneMaterialization,
  revision: number,
  selected: { paneId: number; paneLineageId: string } | null,
  overlay: Rect | null,
  content: Rect | null,
): PanePresentationControlRequest {
  const focus = materialization.focus;
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
  const { version, request_revision, presentation_generation, selected } = control.request;
  if (response.ok !== true || !sameValue(response.pane_presentation, {
    version, request_revision, presentation_generation, selected,
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
  assertPanePresentationAcknowledged(await send(structuredClone(request)), request);
}
