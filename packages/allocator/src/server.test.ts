import assert from "node:assert/strict";
import test from "node:test";

import { WindowLabelAuthority } from "./authority.js";
import type { AcceptedState, PostgresCustodyAdapter } from "./custody.js";
import { AllocatorServer } from "./server.js";

function acceptedState(allocatorId: string): AcceptedState {
  return {
    allocatorId,
    fleetId: "fleet-current",
  } as AcceptedState;
}

function serverForTopology(
  authority: WindowLabelAuthority,
  custody: PostgresCustodyAdapter<"writer">,
): { fleetTopology: () => Promise<Record<string, unknown>> } {
  const server = Object.create(AllocatorServer.prototype) as object;
  Object.assign(server, {
    authority,
    custody,
    endpointLeases: {
      maxEndpointLeaseMs: 5_000,
      serverTimeMs: () => 1234,
    },
    registeredClients: new Map(),
  });
  return {
    fleetTopology: (server as { fleetTopology: () => Promise<Record<string, unknown>> }).fleetTopology.bind(server),
  };
}

test("fleet topology returns the accepted state validated for its request", async () => {
  const validated = acceptedState("allocator-validated");
  let validationReads = 0;
  let fallbackReads = 0;
  const custody = {
    recoverWriterWithState: async () => {
      validationReads += 1;
      return validated;
    },
    readAcceptedState: async () => {
      fallbackReads += 1;
      return acceptedState("allocator-fallback");
    },
  } as unknown as PostgresCustodyAdapter<"writer">;
  const authority = new WindowLabelAuthority(custody);
  const topology = await serverForTopology(authority, custody).fleetTopology();

  assert.equal(topology.registrationReady, true);
  assert.deepEqual(topology.registryIdentity, {
    allocatorId: "allocator-validated",
    fleetId: "fleet-current",
  });
  assert.equal(validationReads, 1);
  assert.equal(fallbackReads, 0);
});

test("fleet topology remains unready and reads current identity after validation fails", async () => {
  let fallbackReads = 0;
  const custody = {
    recoverWriterWithState: async () => null,
    readAcceptedState: async () => {
      fallbackReads += 1;
      return acceptedState("allocator-current");
    },
  } as unknown as PostgresCustodyAdapter<"writer">;
  const authority = new WindowLabelAuthority(custody);
  const topology = await serverForTopology(authority, custody).fleetTopology();

  assert.equal(topology.registrationReady, false);
  assert.deepEqual(topology.registryIdentity, {
    allocatorId: "allocator-current",
    fleetId: "fleet-current",
  });
  assert.equal(fallbackReads, 1);
});
