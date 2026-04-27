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
  return {
    ...materialization.overlaySet,
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
