export type SurfaceWindowCloseOrigin = "compositor-startup-rejection" | "user";

export type SurfaceWindowCloseEvent = {
  preventDefault(): void;
};

export type SurfaceWindowCloseLifecycle = {
  beginClose(): void;
  clearOverlayRegions(): Promise<void>;
  closeWindowWithoutFinalizing(): void;
  closeSurfaceFromLocalUser(): Promise<void>;
  isClosePending(): boolean;
  isPersistenceOutcomeUnknown(): boolean;
  isProgrammaticClose(): boolean;
  isQuitting(): boolean;
  onClosePausedForPersistence(): void;
  onCloseReleaseFailed(error: unknown): void;
  onCloseFailed(error: unknown): void;
  onOverlayClearFailed(error: unknown): void;
  persistState(): Promise<void>;
  releaseNativePanes(): Promise<void>;
  finishClose(): void;
};

export function surfaceWindowCloseOrigin(params: {
  compositorStartupRejected: boolean;
  rendererReady: boolean;
}): SurfaceWindowCloseOrigin {
  return params.compositorStartupRejected && !params.rendererReady
    ? "compositor-startup-rejection"
    : "user";
}

export async function handleSurfaceWindowClose(
  event: SurfaceWindowCloseEvent,
  origin: SurfaceWindowCloseOrigin,
  lifecycle: SurfaceWindowCloseLifecycle,
): Promise<void> {
  if (lifecycle.isQuitting() || lifecycle.isProgrammaticClose()) return;

  event.preventDefault();
  if (lifecycle.isPersistenceOutcomeUnknown()) {
    lifecycle.onClosePausedForPersistence();
    return;
  }
  if (lifecycle.isClosePending()) return;

  lifecycle.beginClose();
  try {
    if (origin === "compositor-startup-rejection") {
      await lifecycle.persistState();
      if (!lifecycle.isQuitting()) lifecycle.closeWindowWithoutFinalizing();
      return;
    }

    try {
      await lifecycle.releaseNativePanes();
    } catch (error) {
      lifecycle.onCloseReleaseFailed(error);
      try {
        await lifecycle.clearOverlayRegions();
      } catch (overlayError) {
        lifecycle.onOverlayClearFailed(overlayError);
      }
    }
    if (!lifecycle.isQuitting()) await lifecycle.closeSurfaceFromLocalUser();
  } catch (error) {
    lifecycle.onCloseFailed(error);
  } finally {
    lifecycle.finishClose();
  }
}
