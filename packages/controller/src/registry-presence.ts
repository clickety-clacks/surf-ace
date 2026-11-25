import { PublicControllerWireClient } from "./wire.js";

export type ControllerRegistryTarget = Readonly<{ url: string; clientId: string }>;

export class ClientOfflineError extends Error {
  readonly code = "client_offline";

  constructor(readonly clientId: string, readonly lastSeenAtMs: number | null) {
    super("The registry reports that the client is offline");
    this.name = "ClientOfflineError";
  }
}

/** A registry observation can establish offline presence. Transport or store
 * failures do not establish the state of a direct session. */
export async function observeClientOffline(
  target: ControllerRegistryTarget,
): Promise<ClientOfflineError | null> {
  const wire = new PublicControllerWireClient(target.url, { registry: true, retryStoreFailures: false });
  try {
    await wire.connect();
    const response = await wire.request("fleet.topology");
    if (response.ok !== true || response.v !== 1 || response.op !== "fleet.topology") return null;
    const clients = (response.payload as { clients?: unknown } | null)?.clients;
    if (!Array.isArray(clients)) return null;
    const matches = clients.filter((row) => row?.clientId === target.clientId);
    if (matches.length !== 1 || matches[0].presence !== "offline") return null;
    const lastSeen = matches[0].lastSeenAtMs;
    return new ClientOfflineError(target.clientId,
      Number.isSafeInteger(lastSeen) && lastSeen >= 0 ? lastSeen : null);
  } catch {
    return null;
  } finally {
    await wire.close();
  }
}
