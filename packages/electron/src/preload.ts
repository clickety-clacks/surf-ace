import { contextBridge, ipcRenderer } from "electron";
import path from "node:path";

contextBridge.exposeInMainWorld("surfAce", {
  clearToast: (paneId: number) => ipcRenderer.send("surface:clear-toast", { paneId }),
  command: (payload: Record<string, unknown>) => ipcRenderer.send("surface:command", payload),
  guestPreloadPath: path.join(__dirname, "guest-preload.cjs"),
  getBootstrap: () => ipcRenderer.invoke("surface:get-bootstrap"),
  onKeyboardIntent: (listener: (intent: unknown) => void) => {
    const wrapped = (_event: unknown, intent: unknown) => listener(intent);
    ipcRenderer.on("surface:keyboard-intent", wrapped);
    return () => ipcRenderer.removeListener("surface:keyboard-intent", wrapped);
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
      clearToast: (paneId: number) => void;
      command: (payload: Record<string, unknown>) => void;
      guestPreloadPath: string;
      getBootstrap: () => Promise<unknown>;
      onKeyboardIntent: (listener: (intent: unknown) => void) => () => void;
      onState: (listener: (state: unknown) => void) => () => void;
      reportOverlayRegions: (payload: Record<string, unknown>) => void;
      reportPage: (payload: Record<string, unknown>) => void;
      reportRendererDiagnostic: (payload: Record<string, unknown>) => void;
      reportSnapshot: (payload: Record<string, unknown>) => void;
    };
  }
}
