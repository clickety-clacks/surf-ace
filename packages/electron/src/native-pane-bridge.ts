import net from "node:net";

import type { NativePaneMaterialization } from "../../protocol/src/index.js";

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

export type CompositorControlRequest =
  | {
    panes: NativePaneMaterialization["panes"];
    type: NativePaneMaterialization["op"];
  }
  | {
    type: "get_status";
  }
  | (NonNullable<NativePaneMaterialization["overlaySet"]> & {
    type: "overlay_regions.set";
    updateReason: "initial" | "update";
  })
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

type PaneGeometry = {
  geometry?: {
    coordinateSpace?: string;
    height: number;
    width: number;
    x: number;
    y: number;
  };
  id: number | string;
};

export type ResolvedNativePaneGeometry = Required<PaneGeometry> & {
  paneInstanceId: string;
};

const PANE_CHROME_BOTTOM_INSET = 49;

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
      return pane;
    }),
    type: materialization.op,
  };
}

export function overlayRequestForCompositor(
  materialization: NativePaneMaterialization,
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
        paneInstanceId: String(pane.binding_id ?? region.paneInstanceId),
        rect: {
          height: pane.geometry.height,
          width: pane.geometry.width,
          x: pane.geometry.x,
          y: pane.geometry.y,
        },
      };
    }),
    type: "overlay_regions.set",
    updateReason: materialization.op === "native_pane.host" ? "initial" : "update",
  };
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
  const handleByPaneId = new Map<string, CompositorOverlayRegion>();
  for (const region of regions) {
    if (region.kind === "pane_handle") {
      handleByPaneId.set(String(region.paneId), region);
    }
  }

  return regions.map((region) => {
    const pane = paneById.get(String(region.paneId));
    if (!pane) {
      return region;
    }
    const handle = handleByPaneId.get(String(region.paneId));
    if (!handle || !isPaneChromeRegion(region.kind)) {
      return {
        ...region,
        paneInstanceId: pane.paneInstanceId,
      };
    }
    const resolvedHandle = resolvedPaneHandleRect(pane, handle.rect);
    return {
      ...region,
      paneInstanceId: pane.paneInstanceId,
      rect: {
        height: region.rect.height,
        width: region.rect.width,
        x: resolvedHandle.x + (region.rect.x - handle.rect.x),
        y: resolvedHandle.y + (region.rect.y - handle.rect.y),
      },
    };
  });
}

export function nativePaneInstanceIdsForCompositor(
  materialization: NativePaneMaterialization,
): Map<string, string> {
  return new Map(materialization.panes.map((pane) => [
    String(pane.id),
    String(pane.binding_id ?? `${pane.id}:${pane.content_id ?? "none"}`),
  ]));
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

function isPaneChromeRegion(kind: CompositorOverlayKind): boolean {
  return kind === "pane_handle" ||
    kind === "history_back" ||
    kind === "history_forward" ||
    kind === "annotation_control";
}

function resolvedPaneHandleRect(
  pane: ResolvedNativePaneGeometry,
  handleRect: CompositorOverlayRegion["rect"],
): CompositorOverlayRegion["rect"] {
  return {
    height: handleRect.height,
    width: handleRect.width,
    x: pane.geometry.x + ((pane.geometry.width - handleRect.width) / 2),
    y: pane.geometry.y + pane.geometry.height - handleRect.height - PANE_CHROME_BOTTOM_INSET,
  };
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
