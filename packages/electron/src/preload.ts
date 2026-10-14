import { contextBridge, ipcRenderer } from "electron";
import { PANE_PRESENTATION_ENABLED } from "./pane-presentation-policy.js";

const guestPreloadPath = String(ipcRenderer.sendSync("surface:get-guest-preload-path"));

contextBridge.exposeInMainWorld("surfAce", {
  panePresentationEnabled: PANE_PRESENTATION_ENABLED,
  clearToast: (paneId: number) => ipcRenderer.send("surface:clear-toast", { paneId }),
  command: (payload: Record<string, unknown>) => ipcRenderer.send("surface:command", payload),
  finishAnnotation: (payload: Record<string, unknown>) => ipcRenderer.invoke("surface:annotation-done", payload) as Promise<import("./annotation-done-state.js").AnnotationDoneState>,
  resizeSplit: (payload: Record<string, unknown>) => ipcRenderer.invoke("surface:resize-split", payload) as Promise<boolean>,
  captureAnnotationOpen: (paneId: number, openedAt: number) =>
    ipcRenderer.invoke("surface:annotation-open", { paneId, openedAt }) as Promise<boolean>,
  guestPreloadPath,
  getBootstrap: () => ipcRenderer.invoke("surface:get-bootstrap"),
  setPanePresentation: (payload: Record<string, unknown>) => ipcRenderer.invoke("surface:pane-presentation", payload),
  onPanePresentationOwnership: (listener: (notice: unknown) => void) => {
    const wrapped = (_event: unknown, notice: unknown) => listener(notice);
    ipcRenderer.on("surface:pane-presentation-ownership", wrapped);
    return () => ipcRenderer.removeListener("surface:pane-presentation-ownership", wrapped);
  },
  onKeyboardIntent: (listener: (intent: unknown) => void) => {
    const wrapped = (_event: unknown, intent: unknown) => listener(intent);
    ipcRenderer.on("surface:keyboard-intent", wrapped);
    return () => ipcRenderer.removeListener("surface:keyboard-intent", wrapped);
  },
  onPanePaintRead: (listener: (request: unknown) => unknown) => {
    const wrapped = (_event: unknown, request: unknown) => {
      let descriptor: unknown = null;
      try { descriptor = listener(request); } catch { /* No stale fallback. */ }
      if (request && typeof request === "object") ipcRenderer.send("surface:pane-paint-reply", { ...request, descriptor });
    };
    ipcRenderer.on("surface:pane-paint-read", wrapped);
    return () => ipcRenderer.removeListener("surface:pane-paint-read", wrapped);
  },
  onState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("surface:state", wrapped);
    return () => ipcRenderer.removeListener("surface:state", wrapped);
  },
  reportOverlayRegions: (payload: Record<string, unknown>) => ipcRenderer.send("surface:overlay-regions", payload),
  reportPage: (payload: Record<string, unknown>) => ipcRenderer.send("surface:page", payload),
  reportRendererDiagnostic: (payload: Record<string, unknown>) => ipcRenderer.send("surface:renderer-diagnostic", payload),
  reportSnapshot: (payload: Record<string, unknown>) => ipcRenderer.send("surface:snapshot", payload),
});

declare global {
  interface Window {
    surfAce: {
      panePresentationEnabled?: boolean;
      clearToast: (paneId: number) => void;
      command: (payload: Record<string, unknown>) => void;
      finishAnnotation: (payload: Record<string, unknown>) => Promise<import("./annotation-done-state.js").AnnotationDoneState>;
      resizeSplit: (payload: Record<string, unknown>) => Promise<boolean>;
      captureAnnotationOpen: (paneId: number, openedAt: number) => Promise<boolean>;
      guestPreloadPath: string;
      getBootstrap: () => Promise<unknown>;
      setPanePresentation: (payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; revision?: number; authorityRevision?: number; presentationCleared?: boolean; presentationBlocked?: boolean }>;
      onPanePresentationOwnership: (listener: (notice: unknown) => void) => () => void;
      onKeyboardIntent: (listener: (intent: unknown) => void) => () => void;
      onPanePaintRead?: (listener: (request: unknown) => unknown) => () => void;
      onState: (listener: (state: unknown) => void) => () => void;
      reportOverlayRegions: (payload: Record<string, unknown>) => void;
      reportPage: (payload: Record<string, unknown>) => void;
      reportRendererDiagnostic: (payload: Record<string, unknown>) => void;
      reportSnapshot: (payload: Record<string, unknown>) => void;
    };
  }
}
