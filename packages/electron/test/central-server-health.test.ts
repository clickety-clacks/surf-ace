import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

import { centralServerAdvertisement } from "../src/central-server-advertisement.js";
import {
  CentralServerDiscoveryHealth,
  CentralServerHealthError,
  checkPublishedServerRecord,
  requestFleetTopology,
} from "../src/central-server-health.js";

const LISTENER_PORT = 19001;

function record(overrides: {
  addresses?: string[];
  host?: string;
  port?: number;
  txt?: Record<string, unknown>;
} = {}) {
  return {
    addresses: [],
    host: "registry.local.",
    name: "Surf Ace Server",
    port: LISTENER_PORT,
    txt: { role: "server", v: "1", ws: "/ws", serverId: "server-instance-1" },
    ...overrides,
  };
}

test("central server publishes the server role, v1 protocol, and the served WebSocket path", () => {
  assert.deepEqual(centralServerAdvertisement("Registry", "server-instance-1"), {
    role: "server",
    v: "1",
    ws: "/ws",
    name: "Registry",
    serverId: "server-instance-1",
  });
});

test("server self-check uses the Bonjour SRV target, listener port, and advertised path", async () => {
  const attempted: string[] = [];
  const result = await checkPublishedServerRecord(record(), LISTENER_PORT, {
    requestTopology: async (endpoint) => {
      attempted.push(endpoint);
      return { clients: [] };
    },
  });

  assert.deepEqual(attempted, ["ws://registry.local:19001/ws"]);
  assert.deepEqual(result, {
    endpoint: "ws://registry.local:19001/ws",
    transport: "srv-target",
  });
});

test("server self-check rejects wrong TXT identity, path, listener port, and wildcard host", async () => {
  const cases = [
    { record: record({ txt: { role: "client", v: "1", ws: "/ws" } }), code: "advertised_role_mismatch" },
    { record: record({ txt: { role: "server", v: "2", ws: "/ws" } }), code: "advertised_version_mismatch" },
    { record: record({ txt: { role: "server", v: "1", ws: "/" } }), code: "advertised_ws_path_mismatch" },
    { record: record({ txt: { role: "server", v: "1", ws: "/ws", serverId: "another-instance" } }), code: "advertised_server_id_mismatch" },
    { record: record({ port: LISTENER_PORT + 1 }), code: `advertised_port_mismatch:${LISTENER_PORT + 1}:listener:${LISTENER_PORT}` },
    { record: record({ host: "0.0.0.0" }), code: "advertised_target_unusable" },
  ];

  for (const entry of cases) {
    await assert.rejects(
      checkPublishedServerRecord(entry.record, LISTENER_PORT, {
        requestTopology: async () => ({ clients: [] }),
      }),
      (error: unknown) => error instanceof CentralServerHealthError && error.code === entry.code,
    );
  }
});

test("DNS-SD transport addresses are used only after SRV target resolution fails", async () => {
  const attempted: string[] = [];
  const result = await checkPublishedServerRecord(record({ addresses: ["192.0.2.18", "127.0.0.1", "fe80::1"] }), LISTENER_PORT, {
    requestTopology: async (endpoint) => {
      attempted.push(endpoint);
      if (endpoint.includes("registry.local")) {
        throw new CentralServerHealthError("websocket_connect_failed:ENOTFOUND", true);
      }
      return { clients: [] };
    },
  });

  assert.deepEqual(attempted, ["ws://registry.local:19001/ws", "ws://192.0.2.18:19001/ws"]);
  assert.deepEqual(result, {
    endpoint: "ws://192.0.2.18:19001/ws",
    transport: "dns-sd-address",
  });
});

test("a reachable wrong host and a failed topology handshake remain unhealthy", async () => {
  await assert.rejects(
    checkPublishedServerRecord(record({ host: "wrong.registry.local" }), LISTENER_PORT, {
      requestTopology: async () => {
        throw new CentralServerHealthError("websocket_connect_failed:ECONNREFUSED");
      },
    }),
    (error: unknown) => error instanceof CentralServerHealthError && error.code === "websocket_connect_failed:ECONNREFUSED",
  );

  let rejectTopology = true;
  const health = new CentralServerDiscoveryHealth(LISTENER_PORT, "server-instance-1", {
    requestTopology: async () => {
      if (rejectTopology) throw new CentralServerHealthError("fleet_topology_rejected:registry_unavailable");
      return { clients: [] };
    },
  });
  const states: string[] = [];
  const unsubscribe = health.subscribe((state) => states.push(state.status));
  try {
    await health.observe(record());
    assert.equal(health.snapshot().status, "unhealthy");
    assert.equal(health.snapshot().error, "fleet_topology_rejected:registry_unavailable");

    rejectTopology = false;
    await health.observe(record());
    assert.equal(health.snapshot().status, "healthy");
    assert.equal(health.snapshot().endpoint, "ws://registry.local:19001/ws");
    assert.deepEqual(states, ["starting", "unhealthy", "healthy"]);
  } finally {
    unsubscribe();
    health.stop();
  }
});

test("the self-check performs a real fleet.topology WebSocket request and validates its reply", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", path: "/ws", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let received: Record<string, unknown> | null = null;
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as Record<string, unknown>;
      received = request;
      socket.send(JSON.stringify({
        id: request.id,
        op: "fleet.topology",
        payload: { clients: [] },
        sentAt: Date.now(),
        type: "response",
        v: 1,
        ok: true,
      }));
    });
  });

  try {
    const payload = await requestFleetTopology(`ws://127.0.0.1:${address.port}/ws`);
    assert.deepEqual(payload, { clients: [] });
    assert.equal(received?.op, "fleet.topology");
    assert.deepEqual(received?.payload, {});
    assert.equal(received?.type, "request");
    assert.equal(received?.v, 1);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
