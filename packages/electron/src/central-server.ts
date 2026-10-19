import { randomUUID } from "node:crypto";

import { startRecoveringAllocatorServer, type AllocatorServerConfig } from "../../allocator/src/server.js";
import { BonjourAdvertiser } from "./bonjour-advertiser.js";
import {
  centralServerAdvertisement,
  centralServerAdvertisedHost,
  centralServerBonjourDisableIPv6,
} from "./central-server-advertisement.js";
import { CentralServerDiscoveryHealth } from "./central-server-health.js";

// Central serving bootstrap: the existing custody-backed listener advertises
// itself, while clients browse and register over that listener.
export async function startCentralServer(config: AllocatorServerConfig, name = "Surf Ace Server") {
  let discoveryHealth: CentralServerDiscoveryHealth | undefined;
  let advertisement: BonjourAdvertiser | undefined;
  const registry = await startRecoveringAllocatorServer(config, {
    unavailable: () => discoveryHealth?.markUnhealthy("registration_writer_unavailable"),
    recovered: () => advertisement?.refresh(),
  });
  const server = registry.server;
  const serverId = randomUUID();
  const advertisedHost = centralServerAdvertisedHost(config.listenHost);
  const health = new CentralServerDiscoveryHealth(server.address.port, serverId, {
    expectedHost: advertisedHost,
  });
  discoveryHealth = health;
  const advertiser = new BonjourAdvertiser({
    disableIPv6: centralServerBonjourDisableIPv6(config.listenHost),
    host: advertisedHost,
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
  advertisement = advertiser;
  try {
    advertiser.start();
  } catch (error) {
    health.stop();
    await advertiser.stop();
    await registry.close();
    throw error;
  }
  return {
    health,
    get server() { return registry.server; },
    async close(): Promise<void> {
      health.stop();
      await advertiser.stop();
      await registry.close();
    },
  };
}
