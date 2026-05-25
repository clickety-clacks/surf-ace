import net from "node:net";

import type { Rect, Revision, SurfaceId, TopologyRevision } from "../../protocol/src/index.js";

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
  windowGroup?: NativePaneWindowGroupRequest;
  target?: "terminal";
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
    clipToPane: true;
    constrainToPane: true;
    denyForeignToplevels: true;
    sameLaunchSecondaryToplevels: "accept";
  };
};

export type NativePaneWindowGroupMemberRole = "primary" | "dialog" | "palette" | "popup" | "secondary" | "unknown";

export type NativePaneWindowGroupMember = {
  id: string;
  role: NativePaneWindowGroupMemberRole;
  bounds: Rect | null;
  focused: boolean;
  lifecycle: "live" | "closing" | "closed" | "unknown";
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
  op: "native_pane.host" | "native_pane.update";
  panes: NativePaneMaterializationPane[];
  overlaySet?: NativePaneOverlaySet;
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
  | {
    panes: NativePaneMaterialization["panes"];
    type: NativePaneMaterialization["op"];
  }
  | {
    pane_ids: string[];
    type: "native_pane.release";
  }
  | {
    type: "get_status";
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
  };

export type CompositorControlResponse = Record<string, unknown>;

export type CompositorNativePaneStatusSummary = {
  nativeMaterializedPaneCount: number | null;
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
  return {
    panes: materialization.panes.map((pane) => {
      if (pane.geometry.coordinateSpace !== "compositor_logical") {
        throw new Error(`native pane ${pane.id} geometry missing compositor_logical coordinate space`);
      }
      if (!pane.geometry.paneInstanceId || pane.geometry.topologyEpoch === undefined || !pane.geometry.surfaceEpoch || pane.geometry.geometryRevision === undefined) {
        throw new Error(`native pane ${pane.id} geometry missing canonical revision identity`);
      }
      return pane;
    }),
    type: materialization.op,
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

export function nativePaneReleaseRequestForCompositor(paneIds: Array<number | string>): CompositorControlRequest {
  return {
    pane_ids: paneIds.map((paneId) => String(paneId)),
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
    nativePaneWindowGroups: nativePaneWindowGroupsFromCompositorStatus(response),
    topologyPaneCount: null,
    topologyPaneSource: "surf_ace_pair_or_panes_list",
  };
}

export function nativePaneWindowGroupsFromCompositorStatus(
  response: CompositorControlResponse,
): NativePaneWindowGroupStatus[] {
  const status = response.status;
  const nestedSource = status && typeof status === "object"
    ? (status as Record<string, unknown>).native_pane_window_groups
    : undefined;
  const source = nestedSource ?? response.native_pane_window_groups;
  if (!Array.isArray(source)) {
    return [];
  }
  return source.flatMap((group) => {
    if (!group || typeof group !== "object") {
      return [];
    }
    const record = group as Record<string, unknown>;
    const paneId = statusText(record, "pane_id") ?? statusText(record, "paneId");
    if (!paneId) {
      return [];
    }
    const deniedReasonsValue = record.denied_reasons ?? record.deniedReasons;
    const membersValue = record.members;
    return [{
      acceptedSecondaryCount: statusCount(record, "accepted_secondary_count") ?? statusCount(record, "acceptedSecondaryCount") ?? 0,
      clippingStatus: statusClipping(record.clipping_status ?? record.clippingStatus),
      deniedReasons: Array.isArray(deniedReasonsValue) ? deniedReasonsValue.filter((reason): reason is string => typeof reason === "string") : [],
      deniedToplevelCount: statusCount(record, "denied_toplevel_count") ?? statusCount(record, "deniedToplevelCount") ?? 0,
      focusedWindowId: statusText(record, "focused_window_id") ?? statusText(record, "focusedWindowId"),
      launchToken: statusText(record, "launch_token") ?? statusText(record, "launchToken"),
      members: Array.isArray(membersValue) ? membersValue.flatMap(nativePaneWindowGroupMemberFromStatus) : [],
      paneId,
      paneInstanceId: statusText(record, "pane_instance_id") ?? statusText(record, "paneInstanceId"),
      paneLocalBounds: statusRect(record.pane_local_bounds ?? record.paneLocalBounds),
      primaryWindowId: statusText(record, "primary_window_id") ?? statusText(record, "primaryWindowId"),
    }];
  });
}

function nativePaneWindowGroupMemberFromStatus(member: unknown): NativePaneWindowGroupMember[] {
  if (!member || typeof member !== "object") {
    return [];
  }
  const record = member as Record<string, unknown>;
  const id = statusText(record, "id");
  if (!id) {
    return [];
  }
  return [{
    bounds: statusRect(record.bounds),
    clippedToPane: typeof record.clipped_to_pane === "boolean"
      ? record.clipped_to_pane
      : typeof record.clippedToPane === "boolean"
        ? record.clippedToPane
        : null,
    focused: record.focused === true,
    id,
    lifecycle: statusLifecycle(record.lifecycle),
    role: statusMemberRole(record.role),
  }];
}

function statusText(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function statusCount(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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
  return value === "live" || value === "closing" || value === "closed" ? value : "unknown";
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
