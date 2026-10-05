import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

import { centralServerAdvertisement, centralServerAdvertisedHost } from "../src/central-server-advertisement.js";
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

test("central server derives an explicit SRV target from its listener", () => {
  assert.equal(centralServerAdvertisedHost("0.0.0.0", "racter"), "racter.local");
  assert.equal(centralServerAdvertisedHost("::", "racter.local."), "racter.local");
  assert.equal(centralServerAdvertisedHost("0:0:0:0:0:0:0:0", "racter"), "racter.local");
  assert.equal(centralServerAdvertisedHost("192.168.50.93", "racter"), "192.168.50.93");
});

test("server self-check uses the Bonjour SRV target's resolved address, listener port, and advertised path", async () => {
  const attempted: string[] = [];
  const result = await checkPublishedServerRecord(record({ addresses: ["192.0.2.18"] }), LISTENER_PORT, {
    expectedHost: "registry.local",
    resolveTargetAddresses: async () => ["192.0.2.18"],
    requestTopology: async (endpoint) => {
      attempted.push(endpoint);
      return { clients: [] };
    },
  });

  assert.deepEqual(attempted, ["ws://192.0.2.18:19001/ws"]);
  assert.deepEqual(result, {
    endpoint: "ws://192.0.2.18:19001/ws",
    transport: "srv-target",
  });
});

test("server self-check rejects an SRV target that resolves only through loopback", async () => {
  const attempted: string[] = [];
  await assert.rejects(
    checkPublishedServerRecord(record({ host: "racter", addresses: ["192.0.2.18"] }), LISTENER_PORT, {
      resolveTargetAddresses: async () => ["127.0.1.1"],
      requestTopology: async (endpoint) => {
        attempted.push(endpoint);
        return { clients: [] };
      },
    }),
    (error: unknown) => error instanceof CentralServerHealthError &&
      error.code === "advertised_target_loopback_resolution:127.0.1.1",
  );
  assert.deepEqual(attempted, []);
});

test("server self-check rejects DNS-SD targets that resolve only to link-local addresses", async () => {
  await assert.rejects(
    checkPublishedServerRecord(record({ addresses: ["fe80::1"] }), LISTENER_PORT, {
      resolveTargetAddresses: async () => {
        throw Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
      },
      requestTopology: async () => ({ clients: [] }),
    }),
    (error: unknown) => error instanceof CentralServerHealthError &&
      error.code === "advertised_target_link_local_resolution:fe80::1",
  );
});

test("server self-check rejects an SRV target that disagrees with its DNS-SD addresses", async () => {
  let attempted = false;
  await assert.rejects(
    checkPublishedServerRecord(record({ addresses: ["192.0.2.19"] }), LISTENER_PORT, {
      resolveTargetAddresses: async () => ["192.0.2.18"],
      requestTopology: async () => {
        attempted = true;
        return { clients: [] };
      },
    }),
    (error: unknown) => error instanceof CentralServerHealthError &&
      error.code === "advertised_target_address_mismatch:192.0.2.18",
  );
  assert.equal(attempted, false);
});

test("server self-check rejects a published host that differs from the listener-derived target", async () => {
  await assert.rejects(
    checkPublishedServerRecord(record({ host: "other.local" }), LISTENER_PORT, {
      expectedHost: "registry.local",
      resolveTargetAddresses: async () => ["192.0.2.18"],
      requestTopology: async () => ({ clients: [] }),
    }),
    (error: unknown) => error instanceof CentralServerHealthError &&
      error.code === "advertised_host_mismatch:other.local:expected:registry.local",
  );
});

test("server self-check rejects wrong TXT identity, path, listener port, and wildcard host", async () => {
  const cases = [
    { record: record({ txt: { role: "client", v: "1", ws: "/ws" } }), code: "advertised_role_mismatch" },
    { record: record({ txt: { role: "server", v: "2", ws: "/ws" } }), code: "advertised_version_mismatch" },
    { record: record({ txt: { role: "server", v: "1", ws: "/" } }), code: "advertised_ws_path_mismatch" },
    { record: record({ txt: { role: "server", v: "1", ws: "/ws", serverId: "another-instance" } }), code: "advertised_server_id_mismatch" },
    { record: record({ port: LISTENER_PORT + 1 }), code: `advertised_port_mismatch:${LISTENER_PORT + 1}:listener:${LISTENER_PORT}` },
    { record: record({ host: "0.0.0.0" }), code: "advertised_target_unusable" },
    { record: record({ host: "127.0.0.1" }), code: "advertised_target_loopback" },
  ];

  for (const entry of cases) {
    await assert.rejects(
      checkPublishedServerRecord(entry.record, LISTENER_PORT, {
        serverId: "server-instance-1",
        requestTopology: async () => ({ clients: [] }),
      }),
      (error: unknown) => error instanceof CentralServerHealthError && error.code === entry.code,
    );
  }
});

test("DNS-SD transport addresses are used only after SRV target resolution fails", async () => {
  const attempted: string[] = [];
  const result = await checkPublishedServerRecord(record({ addresses: ["192.0.2.18", "127.0.0.1", "fe80::1"] }), LISTENER_PORT, {
    resolveTargetAddresses: async () => {
      throw Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
    },
    requestTopology: async (endpoint) => {
      attempted.push(endpoint);
      return { clients: [] };
    },
  });

  assert.deepEqual(attempted, ["ws://192.0.2.18:19001/ws"]);
  assert.deepEqual(result, {
    endpoint: "ws://192.0.2.18:19001/ws",
    transport: "dns-sd-address",
  });
});

test("a reachable wrong host and a failed topology handshake remain unhealthy", async () => {
  await assert.rejects(
    checkPublishedServerRecord(record({ host: "wrong.registry.local" }), LISTENER_PORT, {
      resolveTargetAddresses: async () => ["192.0.2.18"],
      requestTopology: async () => {
        throw new CentralServerHealthError("websocket_connect_failed:ECONNREFUSED");
      },
    }),
    (error: unknown) => error instanceof CentralServerHealthError && error.code === "websocket_connect_failed:ECONNREFUSED",
  );

  let rejectTopology = true;
  const health = new CentralServerDiscoveryHealth(LISTENER_PORT, "server-instance-1", {
    resolveTargetAddresses: async () => ["192.0.2.18"],
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
    assert.equal(health.snapshot().endpoint, "ws://192.0.2.18:19001/ws");
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
