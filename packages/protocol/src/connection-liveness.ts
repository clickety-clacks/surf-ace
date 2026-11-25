// DESIGN §4.4 and §4.5.
export const WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;
export const WEBSOCKET_PING_INTERVAL_MS = 15_000;
export const REGISTRY_FRAME_TIMEOUT_MS = 2 * WEBSOCKET_PING_INTERVAL_MS;

export function reconnectDelayMs(attempt: number, initialMs = 500): number {
  return Math.random() * Math.min(30_000, initialMs * 2 ** attempt);
}

/** Only a pong answering the latest ping resets the missed-pong count. */
export function keepWebSocketAlive(socket: {
  readonly readyState: number;
  readonly OPEN: number;
  on(event: "pong", callback: (data: { toString(): string }) => void): unknown;
  once(event: "close", callback: () => void): unknown;
  ping(data: string, mask: boolean, callback: (error?: Error) => void): void;
  terminate(): void;
}): void {
  let sequence = 0;
  let outstanding: string | null = null;
  let misses = 0;
  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (outstanding !== null && ++misses >= 2) {
      socket.terminate();
      return;
    }
    outstanding = String(++sequence);
    socket.ping(outstanding, false, (error) => {
      if (error) socket.terminate();
    });
  }, WEBSOCKET_PING_INTERVAL_MS);
  socket.on("pong", (data) => {
    if (data.toString() === outstanding) {
      outstanding = null;
      misses = 0;
    }
  });
  socket.once("close", () => clearInterval(timer));
}
