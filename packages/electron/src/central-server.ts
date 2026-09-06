import { AllocatorServer, type AllocatorServerConfig } from "../../allocator/src/server.js";
import { BonjourAdvertiser } from "./bonjour-advertiser.js";

// Central serving bootstrap: the existing custody-backed listener advertises
// itself, while clients browse and register over that listener.
export async function startCentralServer(config: AllocatorServerConfig, name = "Surf Ace Server") {
  const server = await AllocatorServer.start(config);
  const advertiser = new BonjourAdvertiser({
    name, port: server.address.port,
    txtProvider: () => ({ role: "server", v: "1", ws: "/", name }),
  });
  try {
    advertiser.start();
  } catch (error) {
    await advertiser.stop();
    await server.close();
    throw error;
  }
  return {
    server,
    async close(): Promise<void> {
      await advertiser.stop();
      await server.close();
    },
  };
}
