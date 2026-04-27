import type {
  ContentId,
  NativeSurfaceContent,
  NativeSurfaceStatusEvent,
  PaneId,
  Revision,
  SurfaceId,
} from "../../protocol/src/index.js";
import { connect } from "node:net";

const DEFAULT_COMPOSITOR_CONTROL_SOCKET = "/tmp/surf-ace-compositor.sock";
const COMPOSITOR_LOGICAL_GEOMETRY_EPSILON = 0.000001;

export type CompositorLogicalCoordinateSpace = "compositor_logical";

export type NativePaneRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type NativePaneGeometry = NativePaneRect & {
  coordinateSpace: CompositorLogicalCoordinateSpace;
};

export type SurfaceLogicalCoordinateSpace = "surface_logical";

export type NativePaneHostPlan = {
  contentId: ContentId;
  geometry: NativePaneGeometry;
  paneId: PaneId;
  process: NativeSurfaceContent["process"];
  revision: Revision;
  surfaceId: SurfaceId;
  targetClass: NativeSurfaceContent["targetClass"];
};

export type NativePaneStatusPayload = NativeSurfaceStatusEvent["payload"];

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
  paneId: PaneId | number | string;
  paneInstanceId: string;
  rect: NativePaneRect;
  regionId: string;
  zIndex?: number;
};

export interface NativePaneHostBridge {
  readonly available: boolean;
  host(plan: NativePaneHostPlan): Promise<NativePaneStatusPayload | null>;
  update(plan: NativePaneHostPlan): Promise<NativePaneStatusPayload | null>;
  release(plan: Pick<NativePaneHostPlan, "contentId" | "paneId" | "revision" | "surfaceId">): Promise<void>;
}

export interface CompositorOverlayRegionBridge {
  readonly available: boolean;
  clear(surfaceId: SurfaceId | string): Promise<void>;
  set(snapshot: {
    regions: CompositorOverlayRegion[];
    revision: number;
    surfaceId: SurfaceId | string;
    topologyEpoch: string;
    updateReason?: "animation" | "clear" | "drag" | "initial" | "layout" | "native_attach" | "native_detach" | "resize" | "visibility";
  }): Promise<void>;
}

export type CompositorHostModeState = {
  controlSocketPath?: string | null;
  enabled: boolean;
  outputRotation: string | null;
  waylandDisplay: string | null;
};

export function detectCompositorHostMode(env: NodeJS.ProcessEnv = process.env): CompositorHostModeState {
  const controlSocketPath = resolveCompositorControlSocketPath(env);
  return {
    controlSocketPath,
    enabled:
      Boolean(env["SURF_ACE_COMPOSITOR_SOCKET"]) ||
      env["SURF_ACE_COMPOSITOR"] === "1" ||
      env["SURF_ACE_COMPOSITOR_MAIN_APP"] === "1" ||
      env["SURF_ACE_COMPOSITOR_HOST_MODE"] === "1",
    outputRotation: env["SURF_ACE_OUTPUT_ROTATION"] ?? null,
    waylandDisplay: env["WAYLAND_DISPLAY"] ?? null,
  };
}

export function resolveCompositorControlSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    env["SURF_ACE_COMPOSITOR_SOCKET"] ??
    (env["SURF_ACE_COMPOSITOR"] === "1" ||
    env["SURF_ACE_COMPOSITOR_MAIN_APP"] === "1" ||
    env["SURF_ACE_COMPOSITOR_HOST_MODE"] === "1"
      ? DEFAULT_COMPOSITOR_CONTROL_SOCKET
      : null)
  );
}

export function buildNativePaneHostPlan(input: {
  content: NativeSurfaceContent;
  contentId: string;
  geometry: NativePaneGeometry;
  paneId: number;
  revision: number;
  surfaceId: string;
}): NativePaneHostPlan {
  if (input.geometry.coordinateSpace !== "compositor_logical") {
    throw new Error("Native pane geometry must use compositor_logical coordinate space");
  }
  return {
    contentId: input.contentId as ContentId,
    geometry: { ...input.geometry },
    paneId: input.paneId as PaneId,
    process: structuredClone(input.content.process),
    revision: input.revision as Revision,
    surfaceId: input.surfaceId as SurfaceId,
    targetClass: input.content.targetClass,
  };
}

export function buildCompositorLogicalPaneGeometry(
  rect: NativePaneRect,
  logicalSurface: Pick<NativePaneRect, "height" | "width">,
): NativePaneGeometry {
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > logicalSurface.width + COMPOSITOR_LOGICAL_GEOMETRY_EPSILON ||
    rect.y + rect.height > logicalSurface.height + COMPOSITOR_LOGICAL_GEOMETRY_EPSILON
  ) {
    throw new Error("Native pane geometry is outside compositor logical surface bounds");
  }
  return {
    ...rect,
    coordinateSpace: "compositor_logical",
  };
}

type CompositorPaneId = string;

type CompositorNativePaneRequest = {
  binding_id: string;
  content_id: string;
  geometry: NativePaneGeometry;
  id: string;
  process: {
    args: string[];
    command: string;
    cwd?: string;
    env?: Record<string, string>;
  };
  revision: number;
  target: "terminal";
};

type CompositorOverlayRegionRequest = {
  captures: CompositorOverlayCapture[];
  kind: CompositorOverlayKind;
  paneId: string;
  paneInstanceId: string;
  rect: NativePaneRect;
  regionId: string;
  zIndex?: number;
};

type CompositorControlRequest =
  | {
      type: "get_status";
    }
  | {
      type: "overlay_regions.status";
    }
  | {
      surfaceId: string;
      type: "overlay_regions.clear";
      windowId?: string;
    }
  | {
      coordinateSpace: SurfaceLogicalCoordinateSpace;
      regions: CompositorOverlayRegionRequest[];
      revision: number;
      surfaceId: string;
      topologyEpoch: string;
      type: "overlay_regions.set";
      updateReason?: "animation" | "clear" | "drag" | "initial" | "layout" | "native_attach" | "native_detach" | "resize" | "visibility";
      windowId?: string;
    }
  | {
      panes: CompositorNativePaneRequest[];
      type: "native_pane.host";
    }
  | {
      panes: CompositorNativePaneRequest[];
      type: "native_pane.update";
    }
  | {
      pane_ids: CompositorPaneId[];
      type: "native_pane.release";
    };

type CompositorControlResponse = {
  error?: string;
  ok: boolean;
  status?: CompositorStatusSnapshot;
};

type CompositorStatusSnapshot = {
  overlay?: CompositorOverlayStatus;
  overlay_regions?: CompositorOverlayStatus;
  panes?: CompositorPaneStatus[];
};

type CompositorOverlayStatus = {
  activeRevision?: number | null;
  windowId?: string | null;
  topologyEpoch?: string | null;
};

type CompositorPaneStatus = {
  external_native_state?: CompositorExternalNativeState;
  id: CompositorPaneId;
  nativeHost?: CompositorNativeHostStatus;
};

type CompositorExternalNativeState =
  | { state: "absent" }
  | { pid: number; state: "launching" }
  | { pid: number; state: "attached" }
  | { reason: string; state: "failed" }
  | { exit_code?: number | null; pid: number; state: "exited" };

type CompositorNativeHostStatus = {
  bindingEvidence?: unknown;
  bindingId?: string;
  contentId?: string;
  lifecycle: CompositorExternalNativeState;
  paneId: string;
  process: {
    args?: string[];
    command: string;
    cwd?: string;
    env?: Record<string, string>;
  };
  revision: number;
  surfaceId?: number;
};

export interface CompositorControlTransport {
  send(request: CompositorControlRequest): Promise<CompositorControlResponse>;
}

export class UnixSocketCompositorControlTransport implements CompositorControlTransport {
  constructor(private readonly socketPath: string) {}

  async send(request: CompositorControlRequest): Promise<CompositorControlResponse> {
    return await sendCompositorControlRequest(this.socketPath, request);
  }
}

export function createCompositorNativePaneHostBridge(options?: {
  hostMode?: CompositorHostModeState;
  pollAttempts?: number;
  pollIntervalMs?: number;
  transport?: CompositorControlTransport;
}): NativePaneHostBridge {
  const hostMode = options?.hostMode ?? detectCompositorHostMode();
  const pollAttempts = options?.pollAttempts ?? 20;
  const pollIntervalMs = options?.pollIntervalMs ?? 250;
  const transport = options?.transport ?? (
    hostMode.controlSocketPath
      ? new UnixSocketCompositorControlTransport(hostMode.controlSocketPath)
      : null
  );
  if (!hostMode.enabled || !transport) {
    return createUnavailableNativePaneHostBridge();
  }

  return {
    available: true,
    async host(plan) {
      const response = await assertCompositorOk(transport.send(buildNativePaneHostRequest(plan)));
      const initialStatus = nativeStatusFromCompositorStatus(plan, response.status) ?? {
        contentId: plan.contentId,
        lifecycle: "launching",
        paneId: plan.paneId,
        revision: plan.revision,
      };
      if (initialStatus.lifecycle !== "launching") {
        return initialStatus;
      }
      return await pollNativePaneHostStatus(transport, plan, initialStatus, pollAttempts, pollIntervalMs);
    },
    async update(plan) {
      const response = await assertCompositorOk(transport.send(buildNativePaneUpdateRequest(plan)));
      return nativeStatusFromCompositorStatus(plan, response.status);
    },
    async release(plan) {
      await assertCompositorOk(
        transport.send({
          pane_ids: [compositorPaneId(plan)],
          type: "native_pane.release",
        }),
      );
    },
  };
}

export function createCompositorOverlayRegionBridge(options?: {
  hostMode?: CompositorHostModeState;
  transport?: CompositorControlTransport;
}): CompositorOverlayRegionBridge {
  const hostMode = options?.hostMode ?? detectCompositorHostMode();
  const transport = options?.transport ?? (
    hostMode.controlSocketPath
      ? new UnixSocketCompositorControlTransport(hostMode.controlSocketPath)
      : null
  );
  if (!hostMode.enabled || !transport) {
    return createUnavailableCompositorOverlayRegionBridge();
  }

  return {
    available: true,
    async clear(surfaceId) {
      const statusResponse = await assertCompositorOk(transport.send(buildCompositorOverlayStatusRequest()));
      const overlayStatus = overlayStatusFromCompositorStatus(statusResponse.status);
      await assertCompositorOk(
        transport.send({
          surfaceId: String(surfaceId),
          type: "overlay_regions.clear",
          ...(overlayStatus.windowId ? { windowId: overlayStatus.windowId } : {}),
        }),
      );
    },
    async set(snapshot) {
      const statusResponse = await assertCompositorOk(transport.send(buildCompositorOverlayStatusRequest()));
      const overlayStatus = overlayStatusFromCompositorStatus(statusResponse.status);
      await assertCompositorOk(
        transport.send(
          buildOverlayRegionsSetRequest(
            snapshot.surfaceId,
            Math.max(snapshot.revision, (overlayStatus.activeRevision ?? 0) + 1),
            overlayStatus.topologyEpoch ?? snapshot.topologyEpoch,
            snapshot.regions,
            snapshot.updateReason,
            overlayStatus.windowId,
          ),
        ),
      );
    },
  };
}

export function overlayStatusFromCompositorStatus(
  status: CompositorStatusSnapshot | undefined,
): { activeRevision: number | null; topologyEpoch: string | null; windowId: string | null } {
  const overlay = status?.overlay_regions ?? status?.overlay;
  return {
    activeRevision: typeof overlay?.activeRevision === "number" ? overlay.activeRevision : null,
    topologyEpoch: typeof overlay?.topologyEpoch === "string" ? overlay.topologyEpoch : null,
    windowId: typeof overlay?.windowId === "string" ? overlay.windowId : null,
  };
}

export function buildCompositorGetStatusRequest(): CompositorControlRequest {
  return { type: "get_status" };
}

export function buildCompositorOverlayStatusRequest(): CompositorControlRequest {
  return { type: "overlay_regions.status" };
}

export function createUnavailableNativePaneHostBridge(): NativePaneHostBridge {
  return {
    available: false,
    async host() {
      return null;
    },
    async update() {
      return null;
    },
    async release() {},
  };
}

export function createUnavailableCompositorOverlayRegionBridge(): CompositorOverlayRegionBridge {
  return {
    available: false,
    async clear() {},
    async set() {},
  };
}

export function buildNativePaneHostRequest(plan: NativePaneHostPlan): CompositorControlRequest {
  return {
    panes: [buildCompositorNativePane(plan)],
    type: "native_pane.host",
  };
}

export function buildNativePaneUpdateRequest(plan: NativePaneHostPlan): CompositorControlRequest {
  return {
    panes: [buildCompositorNativePane(plan)],
    type: "native_pane.update",
  };
}

export function buildOverlayRegionsSetRequest(
  surfaceId: SurfaceId | string,
  revision: number,
  topologyEpoch: string,
  regions: CompositorOverlayRegion[],
  updateReason?: "animation" | "clear" | "drag" | "initial" | "layout" | "native_attach" | "native_detach" | "resize" | "visibility",
  windowId?: string | null,
): CompositorControlRequest {
  return {
    coordinateSpace: "surface_logical",
    regions: regions.map((region) => ({
      captures: [...region.captures],
      kind: region.kind,
      paneId: String(region.paneId),
      paneInstanceId: region.paneInstanceId,
      rect: {
        x: Math.round(region.rect.x),
        y: Math.round(region.rect.y),
        width: Math.max(1, Math.round(region.rect.width)),
        height: Math.max(1, Math.round(region.rect.height)),
      },
      regionId: region.regionId,
      ...(region.zIndex !== undefined ? { zIndex: region.zIndex } : {}),
    })),
    revision,
    surfaceId: String(surfaceId),
    topologyEpoch,
    type: "overlay_regions.set",
    ...(updateReason ? { updateReason } : {}),
    ...(windowId ? { windowId } : {}),
  };
}

export function serializeCompositorControlRequest(request: CompositorControlRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function nativeStatusFromCompositorStatus(
  plan: NativePaneHostPlan,
  status: CompositorStatusSnapshot | undefined,
): NativePaneStatusPayload | null {
  const paneId = compositorPaneId(plan);
  const pane = status?.panes?.find((entry) => compositorPaneIdText(entry.id) === paneId);
  const nativeHost = pane?.nativeHost;
  if (
    nativeHost &&
    (nativeHost.paneId !== paneId ||
      nativeHost.contentId !== String(plan.contentId) ||
      nativeHost.revision !== Number(plan.revision))
  ) {
    return null;
  }
  const nativeState = nativeHost?.lifecycle ?? pane?.external_native_state;
  if (!nativeState) {
    return null;
  }
  const base = {
    contentId: plan.contentId,
    paneId: plan.paneId,
    revision: plan.revision,
  };
  switch (nativeState.state) {
    case "launching":
      return { ...base, lifecycle: "launching" };
    case "attached":
      return { ...base, lifecycle: "attached" };
    case "failed":
      return {
        ...base,
        errorCode: "render_failed",
        errorMessage: nativeState.reason,
        lifecycle: "failed",
      };
    case "exited":
      return {
        ...base,
        exitCode: nativeState.exit_code ?? null,
        lifecycle: "exited",
      };
    case "absent":
      return null;
  }
}

async function assertCompositorOk(
  responsePromise: Promise<CompositorControlResponse>,
): Promise<CompositorControlResponse> {
  const response = await responsePromise;
  if (!response.ok) {
    throw new Error(response.error ?? "Compositor native pane control request failed");
  }
  return response;
}

async function pollNativePaneHostStatus(
  transport: CompositorControlTransport,
  plan: NativePaneHostPlan,
  initialStatus: NativePaneStatusPayload,
  attempts: number,
  intervalMs: number,
): Promise<NativePaneStatusPayload> {
  let latest = initialStatus;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delay(intervalMs);
    const response = await assertCompositorOk(transport.send(buildCompositorGetStatusRequest()));
    const next = nativeStatusFromCompositorStatus(plan, response.status);
    if (!next) {
      continue;
    }
    latest = next;
    if (next.lifecycle !== "launching") {
      return next;
    }
  }
  return latest;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sendCompositorControlRequest(
  socketPath: string,
  request: CompositorControlRequest,
): Promise<CompositorControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(serializeCompositorControlRequest(request));
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\n")) {
        socket.end();
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const line = response.split("\n")[0]?.trim();
      if (!line) {
        reject(new Error("Compositor native pane control returned an empty response"));
        return;
      }
      try {
        resolve(JSON.parse(line) as CompositorControlResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function compositorPaneId(plan: Pick<NativePaneHostPlan, "paneId" | "surfaceId">): CompositorPaneId {
  return `${plan.surfaceId}:${plan.paneId}`;
}

function compositorPaneIdText(value: CompositorPaneId): string {
  return value;
}

function buildCompositorNativePane(plan: NativePaneHostPlan): CompositorNativePaneRequest {
  return {
    binding_id: nativePaneBindingId(plan),
    content_id: String(plan.contentId),
    geometry: {
      x: Math.round(plan.geometry.x),
      y: Math.round(plan.geometry.y),
      width: Math.max(1, Math.round(plan.geometry.width)),
      height: Math.max(1, Math.round(plan.geometry.height)),
      coordinateSpace: plan.geometry.coordinateSpace,
    },
    id: compositorPaneId(plan),
    process: buildCompositorProcess(plan),
    revision: Number(plan.revision),
    target: "terminal",
  };
}

function nativePaneBindingId(plan: NativePaneHostPlan): string {
  return `${plan.surfaceId}:${plan.paneId}:${plan.contentId}`;
}

function buildCompositorProcess(plan: NativePaneHostPlan): CompositorNativePaneRequest["process"] {
  return {
    args: plan.process.args ? [...plan.process.args] : [],
    command: plan.process.command,
    ...(plan.process.cwd ? { cwd: plan.process.cwd } : {}),
    ...(plan.process.env && Object.keys(plan.process.env).length > 0 ? { env: { ...plan.process.env } } : {}),
  };
}
