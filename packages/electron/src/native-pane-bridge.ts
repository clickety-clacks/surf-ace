import type {
  ContentId,
  NativeSurfaceContent,
  NativeSurfaceStatusEvent,
  PaneId,
  Revision,
  SurfaceId,
} from "../../protocol/src/index.js";

export type NativePaneGeometry = {
  height: number;
  width: number;
  x: number;
  y: number;
};

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

export interface NativePaneHostBridge {
  readonly available: boolean;
  host(plan: NativePaneHostPlan): Promise<NativePaneStatusPayload | null>;
  release(plan: Pick<NativePaneHostPlan, "contentId" | "paneId" | "revision" | "surfaceId">): Promise<void>;
}

export type CompositorHostModeState = {
  enabled: boolean;
  outputRotation: string | null;
  waylandDisplay: string | null;
};

export function detectCompositorHostMode(env: NodeJS.ProcessEnv = process.env): CompositorHostModeState {
  return {
    enabled: env["SURF_ACE_COMPOSITOR"] === "1",
    outputRotation: env["SURF_ACE_OUTPUT_ROTATION"] ?? null,
    waylandDisplay: env["WAYLAND_DISPLAY"] ?? null,
  };
}

export function buildNativePaneHostPlan(input: {
  content: NativeSurfaceContent;
  contentId: string;
  geometry: NativePaneGeometry;
  paneId: number;
  revision: number;
  surfaceId: string;
}): NativePaneHostPlan {
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

export function createUnavailableNativePaneHostBridge(): NativePaneHostBridge {
  return {
    available: false,
    async host() {
      return null;
    },
    async release() {},
  };
}
