import { randomUUID } from "node:crypto";

import { AllocatorServer, type AllocatorServerConfig } from "../../allocator/src/server.js";
import { BonjourAdvertiser } from "./bonjour-advertiser.js";
import { centralServerAdvertisement } from "./central-server-advertisement.js";
import { CentralServerDiscoveryHealth } from "./central-server-health.js";

// Central serving bootstrap: the existing custody-backed listener advertises
// itself, while clients browse and register over that listener.
export async function startCentralServer(config: AllocatorServerConfig, name = "Surf Ace Server") {
  const server = await AllocatorServer.start(config);
  const serverId = randomUUID();
  const health = new CentralServerDiscoveryHealth(server.address.port, serverId);
  const advertiser = new BonjourAdvertiser({
    name, port: server.address.port,
    onSelfDiscovery: ({ error, service }) => {
      if (service) {
        void health.observe(service);
      } else if (error) {
        health.markUnhealthy(error);
      }
    },
    txtProvider: () => centralServerAdvertisement(name, serverId),
  });
  try {
    advertiser.start();
  } catch (error) {
    health.stop();
    await advertiser.stop();
    await server.close();
    throw error;
  }
  return {
    health,
    server,
    async close(): Promise<void> {
      health.stop();
      await advertiser.stop();
      await server.close();
    },
  };
}
