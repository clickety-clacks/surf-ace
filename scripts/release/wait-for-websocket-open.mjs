export function waitForWebSocketOpen(socket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === 1) return resolve();
    if (socket.readyState !== 0) return reject(new Error("annotation_registry_websocket_not_connecting"));
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error("annotation_registry_websocket_open_timeout_10s"));
    }, timeoutMs);
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}
