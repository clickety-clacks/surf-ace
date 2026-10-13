#!/usr/bin/env node
// Read one private fleet.topology response. No registration or claim is sent.
import os from "node:os";

const fail = (code) => { throw new Error(code); };
try {
  if (process.argv.length !== 3) fail("topology_endpoint_required");
  const url = new URL(process.argv[2]);
  const port = Number(url.port);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== "/ws" ||
      url.search || url.hash || !Number.isSafeInteger(port) || port < 20000 || port > 60999 ||
      Object.keys(os.networkInterfaces()).some((name) => name !== "lo")) fail("topology_route_not_private");
  const socket = new WebSocket(url);
  const id = "rq_private_topology_read";
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("topology_timeout")), 5000);
    const stop = (error, value) => {
      clearTimeout(timer);
      socket.close();
      error ? reject(error) : resolve(value);
    };
    socket.addEventListener("error", () => stop(new Error("topology_socket_error")), { once: true });
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "request", v: 1, id,
      op: "fleet.topology", payload: {}, sentAt: Date.now() })), { once: true });
    socket.addEventListener("message", (event) => {
      let reply;
      try { reply = JSON.parse(String(event.data)); } catch { stop(new Error("topology_json_invalid")); return; }
      if (reply.id !== id) return;
      if (reply.ok !== true || reply.op !== "fleet.topology" || !reply.payload?.registryIdentity) {
        stop(new Error("topology_response_invalid")); return;
      }
      stop(null, reply.payload);
    });
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`foreign_first_topology_failed=${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 1;
}
