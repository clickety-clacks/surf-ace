import net from "node:net";

import type {
  NativePaneInteractionState,
  NativePaneSurfaceFocus,
  NativePaneWindowGroupLifecycle,
  NativePaneWindowGroupRestoration,
  NativePaneWindowGroupVisibility,
  NativePaneCompositorRuntimeStatus,
  NativePaneCompositorFocusGeneration,
  Rect,
  Revision,
  SurfaceId,
  TopologyRevision,
} from "../../protocol/src/index.js";
import type { CompositorAppBindingRequest } from "./runtime-identity.js";

export type NativePaneGeometry = Rect & {
  coordinateSpace: "compositor_logical";
  paneInstanceId: string;
  topologyEpoch: TopologyRevision;
  surfaceEpoch: string;
  geometryRevision: Revision;
};

export type NativePaneMaterializationPane = {
  id: string;
  content_id?: string;
  binding_id?: string;
  revision: Revision;
  geometry: NativePaneGeometry;
  nativeApp?: {
    appId: string;
    args: string[];
    launchMode: "new_instance" | "attach_or_launch";
  };
  windowGroup?: NativePaneWindowGroupRequest;
  target?: "native_app" | "terminal";
  process?: {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
};

export type NativePaneLaunchIdentity = {
  launchToken: string;
  paneId: string;
  paneInstanceId: string;
  surfaceId: SurfaceId | string;
  targetId?: string;
};

export type NativePaneWindowGroupRequest = {
  launchIdentity: NativePaneLaunchIdentity;
  policy: {
    accessoryVisibility: "focused_pane_only";
    clipToPane: false;
    constrainToPane: false;
    denyForeignToplevels: true;
    primaryVisibility: "always";
    sameLaunchSecondaryToplevels: "accept";
  };
};

export type NativePaneWindowGroupMemberRole = "primary" | "dialog" | "palette" | "popup" | "secondary" | "unknown";

export type NativePaneWindowGroupMember = {
  acceptsInput: boolean | null;
  id: string;
  role: NativePaneWindowGroupMemberRole;
  bounds: Rect | null;
  destroyedWhileHidden: boolean | null;
  focused: boolean;
  hiddenReason: string | null;
  lifecycle: NativePaneWindowGroupLifecycle;
  restorationState: NativePaneWindowGroupRestoration;
  visibility: NativePaneWindowGroupVisibility;
  zOrder: number | null;
  clippedToPane: boolean | null;
};

export type NativePaneWindowGroupStatus = {
  paneId: string;
  paneInstanceId: string | null;
  launchToken: string | null;
  primaryWindowId: string | null;
  focusedWindowId: string | null;
  acceptedSecondaryCount: number;
  deniedToplevelCount: number;
  deniedReasons: string[];
  paneLocalBounds: Rect | null;
  clippingStatus: "clipped" | "unclipped" | "unknown";
  focusedPaneId: string | null;
  paneFocused: boolean | null;
  primaryVisible: boolean | null;
  surfaceFocus: NativePaneSurfaceFocus;
  interactionState: NativePaneInteractionState;
  lifecycleDiagnostic: string | null;
  members: NativePaneWindowGroupMember[];
};

export type NativePaneOverlaySet = {
  surfaceId: SurfaceId;
  windowId: string;
  revision: Revision;
  topologyEpoch: TopologyRevision;
  coordinateSpace: "surface_logical";
  regions: Array<{
    regionId: string;
    paneId: string;
    paneInstanceId: string;
    kind: "native_pane";
    rect: Rect;
    zIndex: number;
    captures: string[];
  }>;
};

export type NativePaneMaterialization = {
  focus: NativePaneFocusProjection;
  op: "native_pane.host" | "native_pane.update";
  panes: NativePaneMaterializationPane[];
  overlaySet?: NativePaneOverlaySet;
};

export type NativePaneFocusProjection = {
  focusedPaneId: string | null;
  focusedPaneInstanceId: string | null;
  geometryRevision: Revision;
  surfaceEpoch: string;
  surfaceId: SurfaceId | string;
  topologyEpoch: TopologyRevision;
  focusRevision?: number;
};

export type NativePanePresentationGeneration = {
  focus_revision: number;
  geometry_revision: number;
  pane_instances?: Record<string, string>;
  surface_epoch: string;
  surface_id: string;
  topology_epoch: number;
};

export type NativePaneFocusGeneration = NativePanePresentationGeneration & {
  focused_pane_id: string | null;
  focused_pane_instance_id: string | null;
};

export type CompositorOverlayCapture = "pointer_axis" | "pointer_button" | "pointer_hover";

export type CompositorOverlayKind =
  | "annotation_control"
  | "history_back"
  | "history_forward"
  | "other"
  | "pane_badge"
  | "pane_handle";

export type CompositorOverlayRegion = {
  captures: CompositorOverlayCapture[];
  kind: CompositorOverlayKind;
  paneId: number | string;
  paneInstanceId: string;
  rect: { height: number; width: number; x: number; y: number };
  regionId: string;
  zIndex?: number;
};

export type CompositorOverlayUpdateReason =
  | "animation"
  | "clear"
  | "drag"
  | "initial"
  | "layout"
  | "native_attach"
  | "native_detach"
  | "resize"
  | "update"
  | "visibility";

type NativePaneOverlaySetRequest = Omit<NativePaneOverlaySet, "regions"> & {
  regions: CompositorOverlayRegion[];
  type: "overlay_regions.set";
  updateReason: "initial" | "update";
};

export type CompositorControlRequest =
  | CompositorAppBindingRequest
  | {
    type: "get_status";
  }
  | {
    focus_generation?: NativePaneFocusGeneration;
    target: "main_app" | {
      native_pane: { pane_id: string };
    };
    type: "set_runtime_focus_target";
  }
  | {
    focus_generation?: NativePaneFocusGeneration;
    type: "clear_runtime_focus_target";
  }
  | {
    focus_revision: number;
    focused_pane_id: string | null;
    focused_pane_instance_id: string | null;
    geometry_revision: Revision;
    panes: NativePaneMaterialization["panes"];
    presentation_generation?: NativePanePresentationGeneration;
    surface_epoch: string;
    surface_id: string;
    topology_epoch: TopologyRevision;
    type: NativePaneMaterialization["op"];
  }
  | {
    pane_ids: string[];
    type: "native_pane.release";
  }
  | NativePaneOverlaySetRequest
  | {
    coordinateSpace: "surface_logical";
    regions: CompositorOverlayRegion[];
    revision: number;
    surfaceId: string;
    topologyEpoch: string;
    type: "overlay_regions.set";
    updateReason: CompositorOverlayUpdateReason;
    windowId?: string;
  }
  | {
    surfaceId: string;
    type: "overlay_regions.clear";
    windowId?: string;
  }
  | {
    output_path: string;
    type: "capture_screen";
  };

const COMPOSITOR_PANE_ID_PREFIX = "surf-ace-pane:v1:";

/**
 * SurfaceCore pane IDs are local to one surface, while the compositor indexes
 * native panes by one global PaneId. Keep the local ID inside a reversible,
 * length-prefixed surface namespace at the compositor boundary.
 */
export function compositorPaneIdForSurface(surfaceId: SurfaceId | string, paneId: number | string): string {
  const surface = String(surfaceId);
  const localPaneId = String(paneId);
  if (surface.length === 0 || localPaneId.length === 0) {
    throw new Error("compositor pane identity requires non-empty surface and pane ids");
  }
  return `${COMPOSITOR_PANE_ID_PREFIX}${surface.length}:${surface}:${localPaneId.length}:${localPaneId}`;
}

export function localPaneIdForSurfaceCompositorPaneId(surfaceId: SurfaceId | string, compositorPaneId: string): string | null {
  const surface = String(surfaceId);
  const prefix = `${COMPOSITOR_PANE_ID_PREFIX}${surface.length}:${surface}:`;
  if (surface.length === 0 || !compositorPaneId.startsWith(prefix)) {
    return null;
  }
  const localIdentity = compositorPaneId.slice(prefix.length);
  const separator = localIdentity.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const lengthText = localIdentity.slice(0, separator);
  if (!/^[1-9][0-9]*$/.test(lengthText)) {
    return null;
  }
  const declaredLength = Number(lengthText);
  const localPaneId = localIdentity.slice(separator + 1);
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || localPaneId.length !== declaredLength) {
    return null;
  }
  return localPaneId;
}

export type CompositorControlResponse = Record<string, unknown>;

export type CompositorNativePaneStatusSummary = {
  nativeMaterializedPaneCount: number | null;
  nativeRuntimeStatus: NativePaneCompositorRuntimeStatus | null;
  nativePaneWindowGroups: NativePaneWindowGroupStatus[];
  topologyPaneCount: null;
  topologyPaneSource: "surf_ace_pair_or_panes_list";
};

type PaneGeometry = {
  geometry?: {
    coordinateSpace?: string;
    geometryRevision?: number;
    height: number;
    paneInstanceId?: string;
    surfaceEpoch?: string;
    topologyEpoch?: number | string;
    width: number;
    x: number;
    y: number;
  };
  id: number | string;
};

export type ResolvedNativePaneGeometry = Required<PaneGeometry> & {
  paneInstanceId: string;
};

export function resolveCompositorControlSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return env.SURF_ACE_COMPOSITOR_SOCKET ?? null;
}

export function requestForCompositor(
  materialization: NativePaneMaterialization,
): CompositorControlRequest {
  const surfaceId = materialization.focus.surfaceId;
  if (materialization.overlaySet && String(materialization.overlaySet.surfaceId) !== String(surfaceId)) {
    throw new Error("native pane materialization focus and overlay surface identities do not match");
  }
  return {
    ...nativePaneFocusFieldsForCompositor(materialization.focus),
    presentation_generation: {
      ...nativePanePresentationGenerationForCompositor(materialization.focus),
      pane_instances: Object.fromEntries(materialization.panes.map((pane) => [
        compositorPaneIdForSurface(surfaceId, pane.id),
        pane.geometry.paneInstanceId,
      ])),
    },
    panes: materialization.panes.map((pane) => {
      if (pane.geometry.coordinateSpace !== "compositor_logical") {
        throw new Error(`native pane ${pane.id} geometry missing compositor_logical coordinate space`);
      }
      if (!pane.geometry.paneInstanceId || pane.geometry.topologyEpoch === undefined || !pane.geometry.surfaceEpoch || pane.geometry.geometryRevision === undefined) {
        throw new Error(`native pane ${pane.id} geometry missing canonical revision identity`);
      }
      if (pane.windowGroup && (
        String(pane.windowGroup.launchIdentity.surfaceId) !== String(surfaceId) ||
        String(pane.windowGroup.launchIdentity.paneId) !== String(pane.id)
      )) {
        throw new Error(`native pane ${pane.id} launch identity does not match its surface and pane`);
      }
      return {
        ...pane,
        id: compositorPaneIdForSurface(materialization.focus.surfaceId, pane.id),
        ...(pane.windowGroup
          ? {
              windowGroup: {
                ...pane.windowGroup,
                launchIdentity: {
                  ...pane.windowGroup.launchIdentity,
                  paneId: compositorPaneIdForSurface(surfaceId, pane.id),
                },
              },
            }
          : {}),
        ...(pane.windowGroup?.launchIdentity.launchToken ? { launchToken: pane.windowGroup.launchIdentity.launchToken } : {}),
      };
    }),
    type: materialization.op,
  };
}

export function nativePaneFocusRequestForCompositor(
  focus: NativePaneFocusProjection,
  nativePaneIds: ReadonlySet<string>,
): CompositorControlRequest {
  const focus_generation: NativePaneFocusGeneration = {
    ...nativePanePresentationGenerationForCompositor(focus),
    focused_pane_id: focus.focusedPaneId === null
      ? null
      : compositorPaneIdForSurface(focus.surfaceId, focus.focusedPaneId),
    focused_pane_instance_id: focus.focusedPaneId === null ? null : focus.focusedPaneInstanceId,
  };
  if (focus.focusedPaneId === null) {
    return { focus_generation, type: "clear_runtime_focus_target" };
  }
  if (!nativePaneIds.has(focus.focusedPaneId)) {
    return { focus_generation, target: "main_app", type: "set_runtime_focus_target" };
  }
  return {
    focus_generation,
    target: { native_pane: { pane_id: compositorPaneIdForSurface(focus.surfaceId, focus.focusedPaneId) } },
    type: "set_runtime_focus_target",
  };
}

function nativePanePresentationGenerationForCompositor(
  focus: NativePaneFocusProjection,
): NativePanePresentationGeneration {
  return {
    focus_revision: focus.focusRevision ?? 0,
    geometry_revision: Number(focus.geometryRevision),
    surface_epoch: focus.surfaceEpoch,
    surface_id: String(focus.surfaceId),
    topology_epoch: Number(focus.topologyEpoch),
  };
}

function nativePaneFocusFieldsForCompositor(focus: NativePaneFocusProjection): {
  focus_revision: number;
  focused_pane_id: string | null;
  focused_pane_instance_id: string | null;
  geometry_revision: Revision;
  surface_epoch: string;
  surface_id: string;
  topology_epoch: TopologyRevision;
} {
  return {
    focus_revision: focus.focusRevision ?? 0,
    focused_pane_id: focus.focusedPaneId === null
      ? null
      : compositorPaneIdForSurface(focus.surfaceId, focus.focusedPaneId),
    focused_pane_instance_id: focus.focusedPaneId === null ? null : focus.focusedPaneInstanceId,
    geometry_revision: focus.geometryRevision,
    surface_epoch: focus.surfaceEpoch,
    surface_id: String(focus.surfaceId),
    topology_epoch: focus.topologyEpoch,
  };
}

export function overlayRequestForCompositor(
  materialization: NativePaneMaterialization,
  options: { topologyEpoch?: number | string } = {},
): CompositorControlRequest | null {
  if (!materialization.overlaySet) {
    return null;
  }
  const panesById = new Map(materialization.panes.map((pane) => [String(pane.id), pane]));
  return {
    ...materialization.overlaySet,
    regions: materialization.overlaySet.regions.map((region) => {
      const pane = panesById.get(String(region.paneId));
      if (!pane || region.kind !== "native_pane") {
        return region;
      }
      return {
        ...region,
        kind: "other",
        paneId: compositorPaneIdForSurface(materialization.focus.surfaceId, pane.id),
        paneInstanceId: nativePaneInstanceIdForCompositor(pane),
        rect: {
          height: pane.geometry.height,
          width: pane.geometry.width,
          x: pane.geometry.x,
          y: pane.geometry.y,
        },
      };
    }),
    revision: materialization.panes[0]?.geometry.geometryRevision ?? materialization.overlaySet.revision,
    topologyEpoch: options.topologyEpoch ?? materialization.panes[0]?.geometry.topologyEpoch ?? materialization.overlaySet.topologyEpoch,
    type: "overlay_regions.set",
    updateReason: materialization.op === "native_pane.host" ? "initial" : "update",
  };
}

export function overlayTopologyEpochFromCompositorResponse(response: CompositorControlResponse): number | string | null {
  const status = response.status;
  if (!status || typeof status !== "object") {
    return null;
  }
  const overlayRegions = (status as Record<string, unknown>).overlay_regions;
  if (!overlayRegions || typeof overlayRegions !== "object") {
    return null;
  }
  const topologyEpoch = (overlayRegions as Record<string, unknown>).topologyEpoch;
  return typeof topologyEpoch === "string" || typeof topologyEpoch === "number" ? topologyEpoch : null;
}

export function overlayRegionsSetRequestForCompositor(snapshot: {
  regions: CompositorOverlayRegion[];
  revision: number;
  surfaceId: string;
  topologyEpoch: number | string;
  updateReason?: CompositorOverlayUpdateReason;
  windowId?: string | null;
}): CompositorControlRequest {
  return {
    coordinateSpace: "surface_logical",
    regions: snapshot.regions.map((region) => ({
      ...region,
      paneId: compositorPaneIdForSurface(snapshot.surfaceId, region.paneId),
      rect: {
        height: Number(region.rect.height),
        width: Number(region.rect.width),
        x: Number(region.rect.x),
        y: Number(region.rect.y),
      },
    })),
    revision: Number(snapshot.revision),
    surfaceId: snapshot.surfaceId,
    topologyEpoch: String(snapshot.topologyEpoch),
    type: "overlay_regions.set",
    updateReason: snapshot.updateReason ?? "layout",
    ...(snapshot.windowId ? { windowId: snapshot.windowId } : {}),
  };
}

export function resolvedOverlayRegionsForCompositor(
  regions: CompositorOverlayRegion[],
  panes: Iterable<ResolvedNativePaneGeometry>,
): CompositorOverlayRegion[] {
  const paneById = new Map([...panes].map((pane) => [String(pane.id), pane]));

  return regions.flatMap((region) => {
    const pane = paneById.get(String(region.paneId));
    if (!pane) {
      return [];
    }
    return [{
      ...region,
      paneInstanceId: pane.paneInstanceId,
    }];
  });
}

export function nativePaneInstanceIdsForCompositor(
  materialization: NativePaneMaterialization,
): Map<string, string> {
  return new Map(materialization.panes.map((pane) => [
    String(pane.id),
    nativePaneInstanceIdForCompositor(pane),
  ]));
}

function nativePaneInstanceIdForCompositor(
  pane: NativePaneMaterialization["panes"][number],
): string {
  return String(pane.binding_id ?? `${pane.id}:${pane.content_id ?? pane.geometry.paneInstanceId ?? "none"}`);
}

export function overlayRegionsClearRequestForCompositor(
  surfaceId: string,
  windowId?: string | null,
): CompositorControlRequest {
  return {
    surfaceId,
    type: "overlay_regions.clear",
    ...(windowId ? { windowId } : {}),
  };
}

export function nativePaneReleaseRequestForCompositor(
  surfaceId: SurfaceId | string,
  paneIds: Array<number | string>,
): CompositorControlRequest {
  return {
    pane_ids: paneIds.map((paneId) => compositorPaneIdForSurface(surfaceId, paneId)),
    type: "native_pane.release",
  };
}

export function validatePaneHandleOverlayAlignment(snapshot: {
  maxBottomInset?: number;
  panes: PaneGeometry[];
  regions: CompositorOverlayRegion[];
  tolerance?: number;
}): string[] {
  const tolerance = snapshot.tolerance ?? 2;
  const maxBottomInset = snapshot.maxBottomInset ?? 128;
  const paneById = new Map(snapshot.panes.map((pane) => [String(pane.id), pane]));
  const errors: string[] = [];

  for (const region of snapshot.regions) {
    if (region.kind !== "pane_handle") {
      continue;
    }
    const pane = paneById.get(String(region.paneId));
    if (!pane?.geometry) {
      errors.push(`pane handle ${region.regionId} references pane ${region.paneId} without geometry`);
      continue;
    }
    if (pane.geometry.coordinateSpace && pane.geometry.coordinateSpace !== "compositor_logical") {
      errors.push(`pane ${pane.id} geometry coordinate space is ${pane.geometry.coordinateSpace}, expected compositor_logical`);
      continue;
    }
    const expectedX = pane.geometry.x + ((pane.geometry.width - region.rect.width) / 2);
    const bottomInset = (pane.geometry.y + pane.geometry.height) - (region.rect.y + region.rect.height);
    if (Math.abs(region.rect.x - expectedX) > tolerance) {
      errors.push(`pane ${pane.id} handle x=${region.rect.x} is not centered in resolved pane x=${pane.geometry.x} width=${pane.geometry.width}`);
    }
    if (bottomInset < -tolerance || bottomInset > maxBottomInset) {
      errors.push(`pane ${pane.id} handle bottom inset ${bottomInset} is not bottom-aligned within resolved pane y=${pane.geometry.y} height=${pane.geometry.height}`);
    }
  }

  return errors;
}

export function compositorFailureMessage(response: CompositorControlResponse): string | null {
  if (response.ok !== false) {
    return null;
  }
  const message = response.message;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  const error = response.error;
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === "string" && errorRecord.message.length > 0) {
      return errorRecord.message;
    }
    if (typeof errorRecord.code === "string" && errorRecord.code.length > 0) {
      return errorRecord.code;
    }
  }
  return "compositor rejected materialization";
}

export function isOverlayNativePaneLivenessFailure(response: CompositorControlResponse): boolean {
  const message = compositorFailureMessage(response);
  return Boolean(message && /^invalid overlay region: pane .+ is not a live native-hosted pane$/.test(message));
}

export function overlayLivePaneInstanceIdFromCompositorResponse(response: CompositorControlResponse): string | null {
  const authority = overlayLivePaneAuthorityFromCompositorResponse(response);
  if (authority) {
    return authority.paneInstanceId;
  }
  const message = compositorFailureMessage(response);
  if (!message) {
    return null;
  }
  const match = /does not match live pane instance '([^']+)'/.exec(message);
  return match?.[1] ?? null;
}

export function overlayLivePaneAuthorityFromCompositorResponse(response: CompositorControlResponse): { paneId: string; paneInstanceId: string } | null {
  const message = compositorFailureMessage(response);
  if (!message) {
    return null;
  }
  const match = /pane PaneId\("([^"]+)"\) pane instance '[^']+' does not match live pane instance '([^']+)'/.exec(message);
  return match ? { paneId: match[1]!, paneInstanceId: match[2]! } : null;
}

export function overlayRegionsWithLivePaneInstanceAuthority<Region extends { paneId: number | string; paneInstanceId: string }>(
  regions: Region[],
  response: CompositorControlResponse,
): Region[] | null {
  const authority = overlayLivePaneAuthorityFromCompositorResponse(response);
  if (authority) {
    let updated = false;
    const nextRegions = regions.map((region) => {
      if (String(region.paneId) !== authority.paneId) {
        return region;
      }
      updated = true;
      return { ...region, paneInstanceId: authority.paneInstanceId };
    });
    return updated ? nextRegions : null;
  }

  const paneInstanceId = overlayLivePaneInstanceIdFromCompositorResponse(response);
  if (!paneInstanceId || regions.length !== 1) {
    return null;
  }
  return [{ ...regions[0]!, paneInstanceId }];
}

function statusNumber(response: CompositorControlResponse, field: string): number | null {
  const direct = response[field];
  if (typeof direct === "number") {
    return direct;
  }
  const status = response.status;
  if (!status || typeof status !== "object") {
    return null;
  }
  const nested = (status as Record<string, unknown>)[field];
  return typeof nested === "number" ? nested : null;
}

function statusString(response: CompositorControlResponse, field: string): string | null {
  const direct = response[field];
  if (typeof direct === "string") {
    return direct;
  }
  const status = response.status;
  if (!status || typeof status !== "object") {
    return null;
  }
  const nested = (status as Record<string, unknown>)[field];
  return typeof nested === "string" ? nested : null;
}

export function compositorNativePaneStatusSummary(
  response: CompositorControlResponse,
): CompositorNativePaneStatusSummary {
  const status = response.status;
  const panes = status && typeof status === "object"
    ? (status as Record<string, unknown>).panes
    : response.panes;
  return {
    nativeMaterializedPaneCount: Array.isArray(panes) ? panes.length : null,
    nativeRuntimeStatus: nativePaneCompositorRuntimeStatusFromStatus(response),
    nativePaneWindowGroups: nativePaneWindowGroupsFromCompositorStatus(response),
    topologyPaneCount: null,
    topologyPaneSource: "surf_ace_pair_or_panes_list",
  };
}

export function nativePaneCompositorRuntimeStatusFromStatus(
  response: CompositorControlResponse,
): NativePaneCompositorRuntimeStatus | null {
  const status = response.status;
  const statusRecord = status && typeof status === "object"
    ? status as Record<string, unknown>
    : null;
  const runtimeStatus = statusRecord ? statusValue(statusRecord, "runtime") : undefined;
  const runtimeRecord = runtimeStatus && typeof runtimeStatus === "object"
    ? runtimeStatus as Record<string, unknown>
    : null;
  const sources: Record<string, unknown>[] = [];
  if (runtimeRecord) {
    sources.push(runtimeRecord);
  }
  if (statusRecord) {
    sources.push(statusRecord);
  }
  sources.push(response);
  const projection: NativePaneCompositorRuntimeStatus = {};
  for (const source of sources) {
    const activeFocusTarget = statusValue(source, "active_focus_target", "activeFocusTarget");
    if (activeFocusTarget !== undefined && projection.activeFocusTarget === undefined) {
      projection.activeFocusTarget = activeFocusTarget;
    }
    const focusGeneration = nativePaneFocusGenerationFromStatus(
      statusValue(source, "active_focus_generation", "activeFocusGeneration"),
    );
    if (focusGeneration && projection.activeFocusGeneration === undefined) {
      projection.activeFocusGeneration = focusGeneration;
    }
    const lastDiagnostic = statusValue(source, "last_diagnostic", "lastDiagnostic");
    if (lastDiagnostic !== undefined && projection.lastDiagnostic === undefined) {
      projection.lastDiagnostic = lastDiagnostic;
    }
  }
  return Object.keys(projection).length > 0 ? projection : null;
}

export function nativePaneWindowGroupsFromCompositorStatus(
  response: CompositorControlResponse,
): NativePaneWindowGroupStatus[] {
  const status = response.status;
  const nestedSource = status && typeof status === "object"
    ? statusValue(status as Record<string, unknown>, "native_pane_window_groups", "nativePaneWindowGroups", "window_groups", "windowGroups")
    : undefined;
  const source = nestedSource ?? statusValue(response, "native_pane_window_groups", "nativePaneWindowGroups", "window_groups", "windowGroups");
  if (!Array.isArray(source)) {
    return [];
  }
  return source.flatMap((group) => {
    if (!group || typeof group !== "object") {
      return [];
    }
    const record = group as Record<string, unknown>;
    const paneId = statusText(record, "pane_id", "paneId");
    if (!paneId) {
      return [];
    }
    const deniedReasonsValue = record.denied_reasons ?? record.deniedReasons;
    const membersValue = record.members;
    return [{
      acceptedSecondaryCount: statusCount(record, "accepted_secondary_count", "acceptedSecondaryCount") ?? 0,
      clippingStatus: statusClipping(statusValue(record, "clipping_status", "clippingStatus")),
      deniedReasons: Array.isArray(deniedReasonsValue) ? deniedReasonsValue.filter((reason): reason is string => typeof reason === "string") : [],
      deniedToplevelCount: statusCount(record, "denied_toplevel_count", "deniedToplevelCount") ?? 0,
      focusedWindowId: statusText(record, "focused_window_id", "focusedWindowId"),
      focusedPaneId: statusText(record, "focused_pane_id", "focusedPaneId"),
      interactionState: statusInteractionState(statusValue(record, "interaction_state", "interactionState")),
      lifecycleDiagnostic: statusText(record, "lifecycle_diagnostic", "lifecycleDiagnostic"),
      launchToken: statusText(record, "launch_token", "launchToken"),
      members: Array.isArray(membersValue) ? membersValue.flatMap(nativePaneWindowGroupMemberFromStatus) : [],
      paneId,
      paneInstanceId: statusText(record, "pane_instance_id", "paneInstanceId"),
      paneLocalBounds: statusRect(statusValue(record, "pane_local_bounds", "paneLocalBounds")),
      paneFocused: statusBoolean(record, "pane_focused", "paneFocused"),
      primaryVisible: statusBoolean(record, "primary_visible", "primaryVisible"),
      primaryWindowId: statusText(record, "primary_window_id", "primaryWindowId"),
      surfaceFocus: statusSurfaceFocus(statusValue(record, "surface_focus", "surfaceFocus")),
    }];
  });
}

function nativePaneWindowGroupMemberFromStatus(member: unknown): NativePaneWindowGroupMember[] {
  if (!member || typeof member !== "object") {
    return [];
  }
  const record = member as Record<string, unknown>;
  const id = statusText(record, "id", "window_id", "windowId");
  if (!id) {
    return [];
  }
  return [{
    acceptsInput: statusBoolean(record, "accepts_input", "acceptsInput"),
    bounds: statusRect(statusValue(record, "bounds", "pane_local_bounds", "paneLocalBounds")),
    clippedToPane: statusBoolean(record, "clipped_to_pane", "clippedToPane"),
    destroyedWhileHidden: statusBoolean(record, "destroyed_while_hidden", "destroyedWhileHidden"),
    focused: record.focused === true,
    hiddenReason: statusText(record, "hidden_reason", "hiddenReason"),
    id,
    lifecycle: statusLifecycle(record.lifecycle),
    restorationState: statusRestorationState(statusValue(record, "restoration_state", "restorationState")),
    role: statusMemberRole(record.role),
    visibility: statusVisibility(statusValue(record, "visibility", "visibility_state", "visibilityState")),
    zOrder: statusFiniteNumber(record, "z_order", "zOrder"),
  }];
}

function nativePaneFocusGenerationFromStatus(value: unknown): NativePaneCompositorFocusGeneration | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const surfaceId = statusText(record, "surface_id", "surfaceId");
  const surfaceEpoch = statusText(record, "surface_epoch", "surfaceEpoch");
  const focusedPaneInstanceId = statusText(record, "focused_pane_instance_id", "focusedPaneInstanceId");
  const geometryRevision = statusCount(record, "geometry_revision", "geometryRevision");
  const focusRevision = statusCount(record, "focus_revision", "focusRevision");
  const topologyEpoch = statusCount(record, "topology_epoch", "topologyEpoch");
  const focusedPaneIdValue = statusValue(record, "focused_pane_id", "focusedPaneId");
  const focusedPaneId = typeof focusedPaneIdValue === "string" && focusedPaneIdValue.length > 0
    ? focusedPaneIdValue
    : null;
  if (
    surfaceId === null ||
    surfaceEpoch === null ||
    geometryRevision === null ||
    focusRevision === null ||
    topologyEpoch === null ||
    (focusedPaneId !== null && focusedPaneInstanceId === null)
  ) {
    return null;
  }
  return {
    focusRevision,
    focusedPaneId,
    focusedPaneInstanceId,
    geometryRevision,
    surfaceEpoch,
    surfaceId,
    topologyEpoch,
  };
}

function statusText(record: Record<string, unknown>, ...fields: string[]): string | null {
  const value = statusValue(record, ...fields);
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function statusCount(record: Record<string, unknown>, ...fields: string[]): number | null {
  const value = statusValue(record, ...fields);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function statusFiniteNumber(record: Record<string, unknown>, ...fields: string[]): number | null {
  const value = statusValue(record, ...fields);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusBoolean(record: Record<string, unknown>, ...fields: string[]): boolean | null {
  const value = statusValue(record, ...fields);
  return typeof value === "boolean" ? value : null;
}

function statusValue(record: Record<string, unknown>, ...fields: string[]): unknown {
  for (const field of fields) {
    if (field in record) {
      return record[field];
    }
  }
  return undefined;
}

function statusRect(value: unknown): Rect | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { height, width, x, y } = record;
  return typeof height === "number" && typeof width === "number" && typeof x === "number" && typeof y === "number"
    ? { height, width, x, y }
    : null;
}

function statusClipping(value: unknown): NativePaneWindowGroupStatus["clippingStatus"] {
  return value === "clipped" || value === "unclipped" ? value : "unknown";
}

function statusLifecycle(value: unknown): NativePaneWindowGroupMember["lifecycle"] {
  return value === "live" || value === "closing" || value === "closed" || value === "disappeared" ? value : "unknown";
}

function statusVisibility(value: unknown): NativePaneWindowGroupMember["visibility"] {
  return value === "visible" || value === "focus_hidden" || value === "hidden" ? value : "unknown";
}

function statusRestorationState(value: unknown): NativePaneWindowGroupMember["restorationState"] {
  return value === "preserved" || value === "removed" || value === "not_applicable" ? value : "unknown";
}

function statusSurfaceFocus(value: unknown): NativePaneWindowGroupStatus["surfaceFocus"] {
  return value === "surf_ace" || value === "native_primary" || value === "native_accessory" ? value : "unknown";
}

function statusInteractionState(value: unknown): NativePaneWindowGroupStatus["interactionState"] {
  return value === "idle" || value === "active" || value === "cancelled" ? value : "unknown";
}

function statusMemberRole(value: unknown): NativePaneWindowGroupMemberRole {
  return value === "primary" || value === "dialog" || value === "palette" || value === "popup" || value === "secondary"
    ? value
    : "unknown";
}

export function validateMaterializationAgainstCompositorStatus(
  request: CompositorControlRequest,
  status: CompositorControlResponse,
): string | null {
  if (!("panes" in request)) {
    return null;
  }
  const coordinateSpace = statusString(status, "pane_geometry_coordinate_space");
  if (coordinateSpace && coordinateSpace !== "compositor_logical") {
    return `compositor pane geometry coordinate space is ${coordinateSpace}, expected compositor_logical`;
  }
  const logicalWidth = statusNumber(status, "logical_surface_width");
  const logicalHeight = statusNumber(status, "logical_surface_height");
  if (logicalWidth === null || logicalHeight === null) {
    return null;
  }
  for (const pane of request.panes) {
    const { geometry } = pane;
    if (geometry.width <= 0 || geometry.height <= 0) {
      return `native pane ${pane.id} has empty geometry`;
    }
    if (
      geometry.x < 0 ||
      geometry.y < 0 ||
      geometry.x + geometry.width > logicalWidth ||
      geometry.y + geometry.height > logicalHeight
    ) {
      return `native pane ${pane.id} geometry is outside compositor logical surface ${logicalWidth}x${logicalHeight}`;
    }
  }
  return null;
}

export async function sendCompositorControl(
  socketPath: string,
  request: CompositorControlRequest,
): Promise<CompositorControlResponse> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      callback();
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10_000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      settle(() => {
        try {
          resolve(JSON.parse(line) as CompositorControlResponse);
        } catch (error) {
          reject(error);
        }
      });
    });
    socket.on("timeout", () => {
      settle(() => reject(new Error("compositor control request timed out")));
    });
    socket.on("error", (error) => {
      settle(() => reject(error));
    });
    socket.on("end", () => {
      if (settled) {
        return;
      }
      const line = buffer.trim();
      settle(() => {
        if (line.length === 0) {
          reject(new Error("compositor control closed without a response"));
          return;
        }
        try {
          resolve(JSON.parse(line) as CompositorControlResponse);
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}
