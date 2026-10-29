import { isIP } from "node:net";
import os from "node:os";

export type ListenerAddress = { address: string; port: number } | string | null;
export type NetworkInterfaceMap = ReturnType<typeof os.networkInterfaces>;

type Candidate = { address: string; family: 4 | 6; interfaceName: string };

const VPN_TUNNEL_INTERFACE = /^(?:utun\d*|tailscale\d*|wg\d+|tun\d+)$/i;

/**
 * Return the endpoint this listener can accept on only when the OS reports a
 * qualifying address on a known VPN tunnel interface. Unknown interface names
 * are not enough evidence to publish a remembered address.
 */
export function tailnetEndpointForListener(
  listener: ListenerAddress,
  interfaces: NetworkInterfaceMap | null,
): string | null {
  if (!listener || typeof listener === "string" || !interfaces ||
      !Number.isSafeInteger(listener.port) || listener.port < 1 || listener.port > 65_535) {
    return null;
  }

  const listenerAddress = normalizeIpAddress(listener.address);
  const listenerFamily = listenerAddress === null ? 0 : isIP(listenerAddress);
  if (listenerFamily !== 4 && listenerFamily !== 6) return null;
  const wildcard = listenerAddress === "0.0.0.0" || listenerAddress === "::";

  const candidates: Candidate[] = [];
  for (const [interfaceName, records] of Object.entries(interfaces)) {
    if (!VPN_TUNNEL_INTERFACE.test(interfaceName)) continue;
    for (const record of records ?? []) {
      if (!record || record.internal) continue;
      const address = normalizeIpAddress(record.address);
      if (address === null) continue;
      const family = isIP(address);
      if (family !== 4 && family !== 6) continue;
      if (!isTailnetAddress(address, family)) continue;

      const listenerAcceptsAddress = wildcard
        ? family === listenerFamily
        : address === listenerAddress;
      if (listenerAcceptsAddress) candidates.push({ address, family, interfaceName });
    }
  }

  candidates.sort((left, right) => {
    if (left.family !== right.family) return left.family === 4 ? -1 : 1;
    if (left.address !== right.address) return left.address.localeCompare(right.address);
    return left.interfaceName.localeCompare(right.interfaceName);
  });

  const selected = candidates[0];
  if (!selected) return null;
  const host = selected.family === 6 ? `[${selected.address}]` : selected.address;
  return `ws://${host}:${listener.port}/ws`;
}

function normalizeIpAddress(value: string): string | null {
  const unscoped = value.split("%", 1)[0] ?? "";
  const family = isIP(unscoped);
  if (family === 4) return unscoped;
  if (family === 6) {
    try {
      return new URL(`ws://[${unscoped}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

function isTailnetAddress(address: string, family: number): boolean {
  if (family === 4) {
    const octets = address.split(".").map(Number);
    return octets.length === 4 && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
  }
  if (family !== 6) return false;

  const firstHextet = Number.parseInt(address.split(":", 1)[0] ?? "", 16);
  return Number.isInteger(firstHextet) && (firstHextet & 0xfe00) === 0xfc00;
}
