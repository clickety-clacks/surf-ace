import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { WebSocketServer } from "ws";

import { PublicControllerWireClient, type RegistryIdentity } from "./wire.js";

async function registryFixture(registryIdentity: unknown, responseOp?: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const operations: string[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(String(raw)) as { id: string; op: string };
      operations.push(request.op);
      socket.send(JSON.stringify({
        id: request.id,
        ok: true,
        op: responseOp ?? request.op,
        payload: { clients: [], registrationReady: true, registryIdentity },
        type: "response",
        v: 1,
      }));
    });
  });
  const address = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    address,
    operations,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("read-only registry identity preflight distinguishes two private fleets before registration", async () => {
  const identityA: RegistryIdentity = { allocatorId: "alloc_fixture_a", fleetId: "fleet-a" };
  const identityB: RegistryIdentity = { allocatorId: "alloc_fixture_b", fleetId: "fleet-b" };
  const a = await registryFixture(identityA);
  const b = await registryFixture(identityB);
  const wireA = new PublicControllerWireClient(a.address, 500);
  const wireB = new PublicControllerWireClient(b.address, 500);
  try {
    assert.deepEqual(await wireA.readRegistryIdentity(), identityA);
    assert.deepEqual(await wireB.readRegistryIdentity(), identityB);
    assert.notDeepEqual(identityA, identityB);
    assert.deepEqual(a.operations, ["fleet.topology"]);
    assert.deepEqual(b.operations, ["fleet.topology"]);
  } finally {
    await Promise.all([wireA.close(), wireB.close()]);
    await Promise.all([a.close(), b.close()]);
  }
});

test("registry identity preflight rejects missing durable identity", async () => {
  const registry = await registryFixture({ allocatorId: "alloc_fixture_a" });
  const wire = new PublicControllerWireClient(registry.address, 500);
  try {
    await assert.rejects(wire.readRegistryIdentity(), /registry_identity_missing_or_invalid/);
    assert.deepEqual(registry.operations, ["fleet.topology"]);
  } finally {
    await wire.close();
    await registry.close();
  }
});

test("registry identity preflight rejects a mismatched response operation", async () => {
  const registry = await registryFixture(
    { allocatorId: "alloc_fixture_a", fleetId: "fleet-a" },
    "client.register",
  );
  const wire = new PublicControllerWireClient(registry.address, 500);
  try {
    await assert.rejects(wire.readRegistryIdentity(), /registry_identity_response_mismatch/);
    assert.deepEqual(registry.operations, ["fleet.topology"]);
  } finally {
    await wire.close();
    await registry.close();
  }
});
