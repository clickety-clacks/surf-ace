const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('surfAce', {
  emitSnapshot: (payload) => ipcRenderer.send('surface:snapshot-update', payload),
  emitStrokeCommitted: (payload) => ipcRenderer.send('surface:stroke-committed', payload),
  emitSurfaceEvent: (payload) => ipcRenderer.send('surface:event', payload),
  emitViewport: (payload) => ipcRenderer.send('surface:viewport-update', payload),
  getBootstrap: () => ipcRenderer.invoke('surface:get-bootstrap'),
  onAnnotationsRemove: (handler) =>
    ipcRenderer.on('surface:annotations-remove', (_event, payload) => handler(payload)),
  onFlushIndicator: (handler) =>
    ipcRenderer.on('surface:flush-indicator', (_event, payload) => handler(payload)),
  onFrame: (handler) => ipcRenderer.on('surface:frame', (_event, frame) => handler(frame)),
  onSession: (handler) =>
    ipcRenderer.on('surface:session', (_event, session) => handler(session)),
  version: 1
});
