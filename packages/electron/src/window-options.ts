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
  return {
    backgroundColor: "#0b1324",
    frame: params.compositorSocketPath === null,
    height: Math.max(720, params.viewport.height),
    show: false,
    title: params.windowLabel ? `${params.endpointName} · ${params.windowLabel}` : params.endpointName,
    useContentSize: true,
    width: Math.max(960, params.viewport.width),
  };
}
