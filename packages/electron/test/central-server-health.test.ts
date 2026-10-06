import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { WebSocketServer } from "ws";

import {
  centralServerAdvertisement,
  centralServerAdvertisedHost,
  centralServerBonjourDisableIPv6,
} from "../src/central-server-advertisement.js";
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
  assert.equal(centralServerBonjourDisableIPv6("0.0.0.0"), true);
  assert.equal(centralServerBonjourDisableIPv6("192.168.50.93"), true);
  assert.equal(centralServerBonjourDisableIPv6("::"), false);
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

test("IPv4-only Bonjour records ignore macOS loopback aliases and unserved IPv6 results", async () => {
  const attempted: string[] = [];
  const result = await checkPublishedServerRecord(record({
    addresses: ["192.168.50.159"],
    host: "eezo.local",
  }), LISTENER_PORT, {
    expectedHost: "eezo.local",
    resolveTargetAddresses: async () => [
      "::1",
      "127.0.0.1",
      "fe80::1",
      "192.168.50.159",
      "fe80::c76:1234:5678:9abc",
      "fd44:c7ed:abcd::8f5",
    ],
    requestTopology: async (endpoint) => {
      attempted.push(endpoint);
      return { clients: [] };
    },
  });

  assert.deepEqual(attempted, ["ws://192.168.50.159:19001/ws"]);
  assert.deepEqual(result, {
    endpoint: "ws://192.168.50.159:19001/ws",
    transport: "srv-target",
  });
});

test("a loopback-only IPv4 target stays unhealthy when only unserved IPv6 addresses accompany it", async () => {
  const attempted: string[] = [];
  await assert.rejects(
    checkPublishedServerRecord(record({ addresses: ["192.168.50.159"] }), LISTENER_PORT, {
      resolveTargetAddresses: async () => ["127.0.1.1", "::1", "fe80::1", "fd44:c7ed:abcd::8f5"],
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

test("an SRV target resolving only to an unserved family cannot pass by DNS-SD address fallback", async () => {
  const attempted: string[] = [];
  await assert.rejects(
    checkPublishedServerRecord(record({
      addresses: ["192.0.2.18"],
      host: "ipv6-only.registry.local",
    }), LISTENER_PORT, {
      resolveTargetAddresses: async () => ["2001:db8::18"],
      requestTopology: async (endpoint) => {
        attempted.push(endpoint);
        return { clients: [] };
      },
    }),
    (error: unknown) => error instanceof CentralServerHealthError &&
      error.code === "advertised_target_family_unserved:2001:db8::18",
  );
  assert.deepEqual(attempted, []);
});

test("server self-check rejects a link-local target without a matching local interface scope", async () => {
  await assert.rejects(
    checkPublishedServerRecord(record({ addresses: ["fe80::1"] }), LISTENER_PORT, {
      resolveTargetAddresses: async () => {
        throw Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
      },
      requestTopology: async () => ({ clients: [] }),
      networkInterfaces: {},
    }),
    (error: unknown) => error instanceof CentralServerHealthError &&
      error.code === "advertised_target_link_local_scope_unavailable:fe80::1",
  );
});

test("a scoped IPv6 link-local target uses its SRV hostname so the OS can apply interface scope", async () => {
  const endpointAttempts: string[] = [];
  const networkInterfaces = {
    veth0: [{ address: "fe80::1234", family: "IPv6", internal: false, scopeid: 7 }],
  } as ReturnType<typeof os.networkInterfaces>;
  const result = await checkPublishedServerRecord(record({ addresses: ["fe80::1234"] }), LISTENER_PORT, {
    expectedHost: "registry.local",
    resolveTargetAddresses: async () => ["fe80::1234"],
    requestTopology: async (endpoint) => {
      endpointAttempts.push(endpoint);
      return { clients: [] };
    },
    networkInterfaces,
  });

  assert.deepEqual(endpointAttempts, ["ws://registry.local:19001/ws"]);
  assert.deepEqual(result, {
    endpoint: "ws://registry.local:19001/ws",
    transport: "srv-target",
  });
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

test("multi-homed target stays healthy when its published LAN address handshakes", async () => {
  const attempted: string[] = [];
  const result = await checkPublishedServerRecord(record({
    host: "gibson.local",
    addresses: ["192.168.50.216"],
  }), LISTENER_PORT, {
    resolveTargetAddresses: async () => ["100.92.53.87", "192.168.50.216"],
    requestTopology: async (endpoint) => {
      attempted.push(endpoint);
      return { clients: [] };
    },
  });

  assert.deepEqual(attempted, ["ws://192.168.50.216:19001/ws"]);
  assert.deepEqual(result, {
    endpoint: "ws://192.168.50.216:19001/ws",
    transport: "srv-target",
  });
});

test("server self-check rejects a published address when any DNS-SD endpoint fails the handshake", async () => {
  const attempted: string[] = [];
  await assert.rejects(
    checkPublishedServerRecord(record({ addresses: ["192.0.2.18", "192.0.2.19"] }), LISTENER_PORT, {
      resolveTargetAddresses: async () => ["192.0.2.18", "192.0.2.19"],
      requestTopology: async (endpoint) => {
        attempted.push(endpoint);
        if (endpoint.includes("192.0.2.19")) {
          throw new CentralServerHealthError("websocket_connect_failed:ECONNREFUSED");
        }
        return { clients: [] };
      },
    }),
    (error: unknown) => error instanceof CentralServerHealthError &&
      error.code === "advertised_target_unreachable:192.0.2.19:websocket_connect_failed:ECONNREFUSED",
  );
  assert.deepEqual(attempted, ["ws://192.0.2.18:19001/ws", "ws://192.0.2.19:19001/ws"]);
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
  const result = await checkPublishedServerRecord(record({ addresses: ["192.0.2.18"] }), LISTENER_PORT, {
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

test("a published loopback DNS-SD address is rejected even when another address is usable", async () => {
  let attempted = false;
  await assert.rejects(
    checkPublishedServerRecord(record({ addresses: ["192.0.2.18", "127.0.1.1"] }), LISTENER_PORT, {
      resolveTargetAddresses: async () => ["192.0.2.18"],
      requestTopology: async () => {
        attempted = true;
        return { clients: [] };
      },
    }),
    (error: unknown) => error instanceof CentralServerHealthError &&
      error.code === "advertised_record_loopback_address:127.0.1.1",
  );
  assert.equal(attempted, false);
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

test("the self-check performs fleet.topology over an isolated IPv4 link-local endpoint", {
  skip: process.env.SURF_ACE_TEST_LINK_LOCAL_INTERFACE !== "veth0",
}, async () => {
  const interfaceName = process.env.SURF_ACE_TEST_LINK_LOCAL_INTERFACE!;
  const networkInterfaces = os.networkInterfaces();
  const interfaceRecords = networkInterfaces[interfaceName] ?? [];
  const interfaceAddress = interfaceRecords.find((entry) => entry.family === "IPv4" && entry.address.startsWith("169.254."));
  assert.ok(interfaceAddress, `${interfaceName} has no IPv4 link-local address`);
  const server = new WebSocketServer({ host: interfaceAddress.address, path: "/ws", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as Record<string, unknown>;
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
    const checked = await checkPublishedServerRecord(record({
      addresses: [interfaceAddress.address],
      host: "link-local.registry.local",
      port: address.port,
    }), address.port, {
      expectedHost: "link-local.registry.local",
      networkInterfaces,
      resolveTargetAddresses: async () => [interfaceAddress.address],
    });
    assert.equal(checked.transport, "srv-target");
    assert.match(checked.endpoint, /^ws:\/\/169\.254\.\d+\.\d+:\d+\/ws$/);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
