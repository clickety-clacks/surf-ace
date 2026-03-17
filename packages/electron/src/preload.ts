import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("surfAce", {
  clearToast: (paneId: number) => ipcRenderer.send("surface:clear-toast", { paneId }),
  command: (payload: Record<string, unknown>) => ipcRenderer.send("surface:command", payload),
  getBootstrap: () => ipcRenderer.invoke("surface:get-bootstrap"),
  onState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("surface:state", wrapped);
    return () => ipcRenderer.removeListener("surface:state", wrapped);
  },
  reportPage: (payload: Record<string, unknown>) => ipcRenderer.send("surface:page", payload),
  reportSnapshot: (payload: Record<string, unknown>) => ipcRenderer.send("surface:snapshot", payload),
});

declare global {
  interface Window {
    surfAce: {
      clearToast: (paneId: number) => void;
      command: (payload: Record<string, unknown>) => void;
      getBootstrap: () => Promise<unknown>;
      onState: (listener: (state: unknown) => void) => () => void;
      reportPage: (payload: Record<string, unknown>) => void;
      reportSnapshot: (payload: Record<string, unknown>) => void;
    };
  }
}
