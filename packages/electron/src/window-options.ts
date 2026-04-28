import type { SurfaceViewport } from "../../protocol/src/index.js";

export type SurfaceWindowOptions = {
  backgroundColor: string;
  frame: boolean;
  height: number;
  show: boolean;
  title: string;
  useContentSize: boolean;
  width: number;
};

export function surfaceWindowOptions(params: {
  compositorSocketPath: string | null;
  endpointName: string;
  viewport: SurfaceViewport;
  windowLabel?: string | null;
}): SurfaceWindowOptions {
  const hostedByCompositor = params.compositorSocketPath !== null;
  return {
    backgroundColor: "#0b1324",
    frame: !hostedByCompositor,
    height: Math.max(720, params.viewport.height),
    show: hostedByCompositor,
    title: params.windowLabel ? `${params.endpointName} · ${params.windowLabel}` : params.endpointName,
    useContentSize: true,
    width: Math.max(960, params.viewport.width),
  };
}
