import type { SurfaceViewport } from "../../protocol/src/index.js";

export type SurfaceWindowOptions = {
  backgroundColor: string;
  frame: boolean;
  hasShadow: boolean;
  height: number;
  show: boolean;
  title: string;
  transparent: boolean;
  useContentSize: boolean;
  width: number;
};

export type SurfaceWindowCaptureMode = {
  offscreen: false | { useSharedTexture: false };
  showAfterReady: boolean;
};

export function surfaceWindowCaptureMode(params: {
  compositorSocketPath: string | null;
  gpuDisabled: boolean;
  platform: NodeJS.Platform;
}): SurfaceWindowCaptureMode {
  const useOffscreenCapture = params.platform === "linux"
    && params.gpuDisabled
    && params.compositorSocketPath === null;
  return {
    offscreen: useOffscreenCapture
      ? { useSharedTexture: false }
      : false,
    showAfterReady: !useOffscreenCapture,
  };
}

export function surfaceWindowOptions(params: {
  compositorSocketPath: string | null;
  endpointName: string;
  viewport: SurfaceViewport;
  windowLabel?: string | null;
}): SurfaceWindowOptions {
  const hostedByCompositor = params.compositorSocketPath !== null;
  return {
    backgroundColor: hostedByCompositor ? "#00000000" : "#0b1324",
    frame: !hostedByCompositor,
    hasShadow: !hostedByCompositor,
    height: Math.max(720, params.viewport.height),
    show: hostedByCompositor,
    title: params.windowLabel ? `${params.endpointName} · ${params.windowLabel}` : params.endpointName,
    transparent: hostedByCompositor,
    useContentSize: true,
    width: Math.max(960, params.viewport.width),
  };
}

export function surfaceWindowLoadQuery(params: {
  compositorSocketPath: string | null;
  surfaceId: string;
}): Record<string, string> {
  return {
    ...(params.compositorSocketPath ? { compositorHosted: "1" } : {}),
    surfaceId: params.surfaceId,
  };
}
