import type { BrowserWindow, NativeImage, WebContents } from "electron";
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
  keepFramesForCoveredCapture: boolean;
  offscreen: false | { useSharedTexture: false };
  showAfterReady: boolean;
};

type PaneCaptureWindow = Pick<BrowserWindow, "capturePage" | "webContents">;
type PaneCaptureRectangle = { height: number; width: number; x: number; y: number };

type CoveredCaptureHold = {
  count: number;
  restoreBackgroundThrottling: boolean;
};

const COVERED_CAPTURE_FRAME_WAIT_TIMEOUT_MS = 250;
const coveredCaptureHolds = new WeakMap<WebContents, CoveredCaptureHold>();

function holdFramesForCoveredCapture(webContents: WebContents): void {
  let hold = coveredCaptureHolds.get(webContents);
  if (!hold) {
    const restoreBackgroundThrottling = webContents.getBackgroundThrottling();
    if (restoreBackgroundThrottling) {
      webContents.setBackgroundThrottling(false);
    }
    hold = { count: 0, restoreBackgroundThrottling };
    coveredCaptureHolds.set(webContents, hold);
  }
  hold.count += 1;
}

function releaseFramesForCoveredCapture(webContents: WebContents): void {
  const hold = coveredCaptureHolds.get(webContents);
  if (!hold) {
    return;
  }
  hold.count -= 1;
  if (hold.count === 0) {
    coveredCaptureHolds.delete(webContents);
    if (hold.restoreBackgroundThrottling && !webContents.isDestroyed()) {
      webContents.setBackgroundThrottling(true);
    }
  }
}

function waitForCoveredCaptureFrames(webContents: WebContents[]): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const firstFrames = Promise.all(webContents.map((contents) => Promise.resolve()
    .then(() => contents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    ))
    .then(() => undefined, () => undefined))).then(() => undefined);
  const timeoutFallback = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, COVERED_CAPTURE_FRAME_WAIT_TIMEOUT_MS);
  });

  return Promise.race([firstFrames, timeoutFallback]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

export function shouldDisableGpuForSoftwareCapture(params: {
  commandLineHasDisableGpu: boolean;
  envValue?: string;
}): boolean {
  const value = params.envValue?.trim().toLowerCase();
  return params.commandLineHasDisableGpu || value === "1" || value === "true" || value === "yes";
}

export function surfaceWindowCaptureMode(params: {
  compositorSocketPath: string | null;
  gpuDisabled: boolean;
  platform: NodeJS.Platform;
}): SurfaceWindowCaptureMode {
  const useOffscreenCapture = params.platform === "linux"
    && params.gpuDisabled
    && params.compositorSocketPath === null;
  const keepFramesForCoveredCapture = params.platform === "linux"
    && !params.gpuDisabled
    && params.compositorSocketPath === null;
  return {
    keepFramesForCoveredCapture,
    offscreen: useOffscreenCapture
      ? { useSharedTexture: false }
      : false,
    showAfterReady: !useOffscreenCapture,
  };
}

// Pane webviews are separate guest WebContents; a covered window stops producing their frames
// unless each guest is also unthrottled for the capture.
export async function captureWindowPageForPane(
  window: PaneCaptureWindow,
  rectangle: PaneCaptureRectangle,
  keepFramesForCoveredCapture: boolean,
  guestWebContents: readonly WebContents[] = [],
): Promise<NativeImage> {
  if (!keepFramesForCoveredCapture) {
    return window.capturePage(rectangle);
  }

  const contents = [window.webContents, ...guestWebContents.filter((guest) => !guest.isDestroyed())];
  contents.forEach(holdFramesForCoveredCapture);
  try {
    await waitForCoveredCaptureFrames(contents);
    return await window.capturePage(rectangle);
  } finally {
    contents.forEach(releaseFramesForCoveredCapture);
  }
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
