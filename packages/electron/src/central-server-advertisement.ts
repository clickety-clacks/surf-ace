import { isIP } from "node:net";
import os from "node:os";

export function centralServerAdvertisement(name: string, serverId: string): Record<string, string> {
  return { role: "server", v: "1", ws: "/ws", name, serverId };
}

export function centralServerAdvertisedHost(listenHost: string, machineHostname = os.hostname()): string {
  const listenerHost = listenHost.trim();
  const unbracketedListenerHost = listenerHost.replace(/^\[|\]$/g, "").split("%", 1)[0] ?? listenerHost;
  const wildcardIPv6 = isIP(unbracketedListenerHost) === 6 &&
    unbracketedListenerHost.split(":").every((group) => group === "" || /^0+$/.test(group));
  if (listenerHost !== "0.0.0.0" && !wildcardIPv6) return listenerHost;

  // Wildcard binds are not client destinations; health validates this DNS-SD name against the resolved record.
  const hostname = machineHostname.trim().replace(/\.$/, "");
  if (!hostname) throw new Error("advertised_target_source_missing");
  return hostname.includes(".") ? hostname : `${hostname}.local`;
}
