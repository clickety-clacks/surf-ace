import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import os from "node:os";

import WebSocket from "ws";

import type { BonjourResolvedService } from "./bonjour-advertiser.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DNS_FAILURE_CODES = new Set(["EAI_AGAIN", "EAI_NODATA", "ENODATA", "ENOTFOUND"]);

export type CentralServerHealthState = {
  checkedAt: string | null;
  endpoint: string | null;
  error: string | null;
  status: "starting" | "healthy" | "unhealthy";
};

export type ServerHealthOptions = {
  expectedHost?: string;
  networkInterfaces?: ReturnType<typeof os.networkInterfaces>;
  resolveTargetAddresses?: (host: string) => Promise<string[]>;
  requestTopology?: (endpoint: string, timeoutMs: number) => Promise<unknown>;
  serverId?: string;
  timeoutMs?: number;
};

export class CentralServerHealthError extends Error {
  constructor(
    readonly code: string,
    readonly dnsResolutionFailure = false,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "CentralServerHealthError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (error instanceof CentralServerHealthError) return error.code;
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") {
    return (error as NodeJS.ErrnoException).code!;
  }
  if (isPlainObject(error) && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}

function isDnsFailure(error: unknown): boolean {
  if (error instanceof CentralServerHealthError) return error.dnsResolutionFailure;
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") {
    return DNS_FAILURE_CODES.has((error as NodeJS.ErrnoException).code!);
  }
  return isPlainObject(error) && typeof error.code === "string" && DNS_FAILURE_CODES.has(error.code);
}

function normalizeHost(value: unknown): string {
  if (typeof value !== "string") throw new CentralServerHealthError("advertised_target_missing");
  const host = value.trim().replace(/\.$/, "");
  if (!host || /[\s\u0000-\u001f\u007f/\\?#]/.test(host)) {
    throw new CentralServerHealthError("advertised_target_invalid");
  }
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    throw new CentralServerHealthError("advertised_target_unusable");
  }
  if (!isUsableAddress(host)) {
    if (isLoopbackAddress(host)) throw new CentralServerHealthError("advertised_target_loopback");
    throw new CentralServerHealthError("advertised_target_unusable");
  }
  return host;
}

function isUsableAddress(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").split("%", 1)[0] ?? host;
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const first = octets[0];
    return first !== 0 && first !== 127 && (first ?? 0) < 224;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isUsableAddress(normalized.slice(7));
    return normalized !== "::" && normalized !== "::1" && !normalized.startsWith("ff");
  }
  return true;
}

function isLoopbackAddress(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").split("%", 1)[0] ?? host;
  const family = isIP(address);
  if (family === 4) return Number(address.split(".")[0]) === 127;
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) {
    return isLoopbackAddress(address.slice(7));
  }
  return family === 6 && (address === "::1" || address.toLowerCase() === "0:0:0:0:0:0:0:1");
}

function isLinkLocalAddress(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").split("%", 1)[0] ?? host;
  const family = isIP(address);
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) {
    return isLinkLocalAddress(address.slice(7));
  }
  if (family === 4) {
    return Number(address.split(".")[0]) === 169 && Number(address.split(".")[1]) === 254;
  }
  if (family !== 6) return false;
  const firstGroup = Number.parseInt(address.split(":", 1)[0] ?? "", 16);
  return Number.isFinite(firstGroup) && (firstGroup & 0xffc0) === 0xfe80;
}

function advertisedTargetResolutionError(address: string): string {
  if (isLoopbackAddress(address)) return `advertised_target_loopback_resolution:${address}`;
  if (isLinkLocalAddress(address)) return `advertised_target_link_local_scope_unavailable:${address}`;
  return `advertised_target_unusable_resolution:${address}`;
}

function addressWithoutScope(value: string): string {
  return value.replace(/^\[|\]$/g, "").split("%", 1)[0] ?? value;
}

function addressFamily(value: string): number {
  return isIP(addressWithoutScope(value));
}

function scopedTransportAddresses(
  values: unknown[],
  networkInterfaces: ReturnType<typeof os.networkInterfaces>,
): { addresses: string[]; unscopedLinkLocal: string[] } {
  const addresses: string[] = [];
  const unscopedLinkLocal: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const raw = value.trim().replace(/^\[|\]$/g, "");
    const address = addressWithoutScope(raw);
    const family = isIP(address);
    if (family === 0 || !isUsableAddress(address)) continue;
    if (family === 4 && isLinkLocalAddress(address)) {
      const onLocalInterface = Object.values(networkInterfaces).some((records) =>
        (records ?? []).some((record) => record.family === "IPv4" && addressWithoutScope(record.address) === address),
      );
      if (onLocalInterface) addresses.push(address);
      else unscopedLinkLocal.push(address);
      continue;
    }
    if (family !== 6 || !isLinkLocalAddress(address)) {
      addresses.push(address);
      continue;
    }

    const suppliedScope = raw.includes("%") ? raw.slice(raw.indexOf("%") + 1) : "";
    const matchingInterfaces = Object.entries(networkInterfaces).flatMap(([name, records]) =>
      (records ?? [])
        .filter((record) => record.family === "IPv6" && addressWithoutScope(record.address).toLowerCase() === address.toLowerCase())
        .filter((record) => !suppliedScope || suppliedScope === name || suppliedScope === String(record.scopeid ?? ""))
        .map((record) => ({ name, scopeid: record.scopeid })),
    );
    if (matchingInterfaces.length === 0) {
      unscopedLinkLocal.push(address);
      continue;
    }
    for (const match of matchingInterfaces) {
      addresses.push(`${address}%${match.scopeid && match.scopeid > 0 ? match.scopeid : match.name}`);
    }
  }
  return { addresses: [...new Set(addresses)], unscopedLinkLocal: [...new Set(unscopedLinkLocal)] };
}

function sameTransportAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function websocketUrl(host: string, port: number, path: string): string {
  const unbracketedHost = host.replace(/^\[|\]$/g, "");
  const scopeIndex = unbracketedHost.indexOf("%");
  const address = scopeIndex < 0 ? unbracketedHost : unbracketedHost.slice(0, scopeIndex);
  const scope = scopeIndex < 0 ? "" : unbracketedHost.slice(scopeIndex + 1);
  const formattedHost = isIP(address) === 6
    ? `[${address}${scope ? `%25${encodeURIComponent(scope)}` : ""}]`
    : unbracketedHost.includes(":") ? `[${unbracketedHost}]` : unbracketedHost;
  return `ws://${formattedHost}:${port}${path}`;
}

function selfCheckHostForAddress(address: string, srvHost: string): string {
  const unscopedAddress = addressWithoutScope(address);
  return isIP(unscopedAddress) === 6 && isLinkLocalAddress(unscopedAddress) &&
    isIP(addressWithoutScope(srvHost)) === 0
    ? srvHost
    : address;
}

function recordEndpoint(service: BonjourResolvedService, listenerPort: number, serverId?: string): {
  host: string;
  port: number;
  path: string;
} {
  const txt = service.txt ?? {};
  if (txt.role !== "server") throw new CentralServerHealthError("advertised_role_mismatch");
  if (txt.v !== "1") throw new CentralServerHealthError("advertised_version_mismatch");
  if (txt.ws !== "/ws") throw new CentralServerHealthError("advertised_ws_path_mismatch");
  if (serverId && txt.serverId !== serverId) throw new CentralServerHealthError("advertised_server_id_mismatch");
  if (!Number.isSafeInteger(service.port) || (service.port ?? 0) < 1 || (service.port ?? 0) > 65535) {
    throw new CentralServerHealthError("advertised_port_invalid");
  }
  if (service.port !== listenerPort) {
    throw new CentralServerHealthError(`advertised_port_mismatch:${service.port}:listener:${listenerPort}`);
  }
  return { host: normalizeHost(service.host), port: service.port, path: txt.ws };
}

async function resolveSrvTarget(
  host: string,
  timeoutMs: number,
  resolver?: (target: string) => Promise<string[]>,
): Promise<string[]> {
  const resolution = resolver
    ? resolver(host)
    : (() => {
      const address = host.replace(/^\[|\]$/g, "").split("%", 1)[0] ?? host;
      if (isIP(address) !== 0) return Promise.resolve([address]);
      return lookup(host, { all: true, verbatim: true }).then((records) => records.map(({ address: resolvedAddress }) => resolvedAddress));
    })();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      resolution,
      new Promise<string[]>((_, reject) => {
        timer = setTimeout(() => reject(new CentralServerHealthError("srv_target_resolution_timeout", true)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function requestFleetTopology(endpoint: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const id = `rq_server_health_${randomUUID()}`;
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { handshakeTimeout: timeoutMs });
    let settled = false;
    let phase: "connect" | "topology" = "connect";
    const timer = setTimeout(() => {
      const code = phase === "connect" ? "websocket_connect_timeout" : "fleet_topology_timeout";
      finish(new CentralServerHealthError(code));
    }, timeoutMs);

    const finish = (error?: Error, payload?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.terminate();
        }
        reject(error);
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "server_health_check");
      resolve(payload);
    };

    socket.once("open", () => {
      phase = "topology";
      try {
        socket.send(JSON.stringify({
          id,
          op: "fleet.topology",
          payload: {},
          sentAt: Date.now(),
          type: "request",
          v: 1,
        }));
      } catch (error) {
        finish(new CentralServerHealthError(`fleet_topology_send_failed:${errorCode(error)}`, false, { cause: error }));
      }
    });

    socket.on("message", (raw) => {
      let response: unknown;
      try {
        response = JSON.parse(raw.toString());
      } catch (error) {
        finish(new CentralServerHealthError("fleet_topology_response_invalid_json", false, { cause: error }));
        return;
      }
      if (!isPlainObject(response)) {
        finish(new CentralServerHealthError("fleet_topology_response_invalid"));
        return;
      }
      if (response.type === "event") return;
      if (response.id !== id || response.op !== "fleet.topology" || response.type !== "response" || response.v !== 1) {
        finish(new CentralServerHealthError("fleet_topology_response_correlation_mismatch"));
        return;
      }
      if (response.ok !== true) {
        const error = isPlainObject(response.error) ? response.error : {};
        const reason = typeof error.code === "string" ? error.code
          : typeof error.message === "string" ? error.message : "request_rejected";
        finish(new CentralServerHealthError(`fleet_topology_rejected:${reason}`));
        return;
      }
      if (!isPlainObject(response.payload) || !Array.isArray(response.payload.clients)) {
        finish(new CentralServerHealthError("fleet_topology_payload_invalid"));
        return;
      }
      finish(undefined, response.payload);
    });

    socket.once("error", (error) => {
      const reason = errorCode(error);
      const prefix = phase === "connect" ? "websocket_connect_failed" : "fleet_topology_transport_failed";
      finish(new CentralServerHealthError(`${prefix}:${reason}`, phase === "connect" && isDnsFailure(error), { cause: error }));
    });

    socket.once("close", (code, reason) => {
      if (settled) return;
      const detail = reason.toString();
      finish(new CentralServerHealthError(phase === "connect"
        ? `websocket_closed_before_open:${code}${detail ? `:${detail}` : ""}`
        : `fleet_topology_closed:${code}${detail ? `:${detail}` : ""}`));
    });
  });
}

export async function checkPublishedServerRecord(
  service: BonjourResolvedService,
  listenerPort: number,
  options: ServerHealthOptions = {},
): Promise<{ endpoint: string; transport: "srv-target" | "dns-sd-address" }> {
  if (!Number.isSafeInteger(listenerPort) || listenerPort < 1 || listenerPort > 65535) {
    throw new CentralServerHealthError("listener_port_invalid");
  }
  const { host, port, path } = recordEndpoint(service, listenerPort, options.serverId);
  if (options.expectedHost && normalizeHost(options.expectedHost).toLowerCase() !== host.toLowerCase()) {
    throw new CentralServerHealthError(`advertised_host_mismatch:${host}:expected:${options.expectedHost}`);
  }
  const request = options.requestTopology ?? requestFleetTopology;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const networkInterfaces = options.networkInterfaces ?? os.networkInterfaces();
  const rawRecordAddresses = Array.isArray(service.addresses) ? service.addresses : [];
  const loopbackRecordAddress = rawRecordAddresses.find((address) => typeof address === "string" && isLoopbackAddress(address));
  if (loopbackRecordAddress) {
    throw new CentralServerHealthError(`advertised_record_loopback_address:${loopbackRecordAddress}`);
  }
  const recordAddressResolution = scopedTransportAddresses(rawRecordAddresses, networkInterfaces);
  const recordAddresses = recordAddressResolution.addresses;
  if (recordAddressResolution.unscopedLinkLocal.length > 0) {
    throw new CentralServerHealthError(
      advertisedTargetResolutionError(recordAddressResolution.unscopedLinkLocal[0]!),
    );
  }
  let targetAddresses: string[];
  let targetResolutionError: unknown;
  try {
    targetAddresses = await resolveSrvTarget(host, timeoutMs, options.resolveTargetAddresses);
  } catch (error) {
    if (!isDnsFailure(error)) {
      throw new CentralServerHealthError(`srv_target_resolution_failed:${errorCode(error)}`, false, { cause: error });
    }
    targetResolutionError = error;
    targetAddresses = [];
  }

  if (targetAddresses.length > 0 && recordAddresses.length > 0) {
    // DNS lookup can include local loopback aliases and address families this
    // Bonjour record does not publish (for example, IPv6 on an IPv4-only
    // listener). The DNS-SD record defines which transport families this
    // instance actually serves; compare only those families, while still
    // rejecting a target that resolves to loopback in a served family.
    const recordFamilies = new Set(recordAddresses.map(addressFamily));
    const targetAddressesForRecordFamilies = targetAddresses.filter((address) =>
      recordFamilies.has(addressFamily(address)),
    );
    const nonLoopbackTargetAddresses = targetAddressesForRecordFamilies.filter((address) =>
      !isLoopbackAddress(address),
    );
    if (nonLoopbackTargetAddresses.length > 0) {
      targetAddresses = nonLoopbackTargetAddresses;
    } else {
      const loopback = targetAddressesForRecordFamilies.find(isLoopbackAddress) ??
        (targetAddresses.every(isLoopbackAddress) ? targetAddresses[0] : undefined);
      if (loopback) throw new CentralServerHealthError(advertisedTargetResolutionError(loopback));

      if (targetAddressesForRecordFamilies.length === 0) {
        const unservedAddress = targetAddresses.find((address) =>
          addressFamily(address) !== 0 && !isLoopbackAddress(address),
        );
        if (unservedAddress) {
          // A successful lookup of the published SRV target that returns only
          // an unserved family is still a broken service record. DNS-SD numeric
          // addresses are probed separately below; they cannot make this SRV target valid.
          throw new CentralServerHealthError(`advertised_target_family_unserved:${unservedAddress}`);
        }
        const invalidAddress = targetAddresses.find((address) => addressFamily(address) === 0);
        if (invalidAddress) {
          throw new CentralServerHealthError(`advertised_target_invalid_resolution:${invalidAddress}`);
        }
        throw new CentralServerHealthError("advertised_target_resolution_unusable");
      }
    }
  }

  if (targetAddresses.length > 0) {
    // Check the resolver result before opening a socket so a local /etc/hosts loopback alias cannot look healthy.
    const loopback = targetAddresses.find(isLoopbackAddress);
    if (loopback) throw new CentralServerHealthError(advertisedTargetResolutionError(loopback));
    const resolvedAddressResolution = scopedTransportAddresses(targetAddresses, networkInterfaces);
    const resolvedUsableAddresses = resolvedAddressResolution.addresses;
    if (resolvedAddressResolution.unscopedLinkLocal.length > 0) {
      throw new CentralServerHealthError(
        advertisedTargetResolutionError(resolvedAddressResolution.unscopedLinkLocal[0]!),
      );
    }
    if (resolvedUsableAddresses.length === 0) {
      const linkLocal = resolvedAddressResolution.unscopedLinkLocal[0] ?? targetAddresses[0] ?? host;
      throw new CentralServerHealthError(advertisedTargetResolutionError(linkLocal));
    }
    if (recordAddresses.length > 0) {
      const hasRecordOverlap = resolvedUsableAddresses.some((address) =>
        recordAddresses.some((recordAddress) => sameTransportAddress(recordAddress, address)),
      );
      if (!hasRecordOverlap) {
        const mismatchedAddress = resolvedUsableAddresses[0]!;
        throw new CentralServerHealthError(`advertised_target_address_mismatch:${mismatchedAddress}`);
      }
    }
    const addressesToProbe = recordAddresses.length > 0 ? recordAddresses : resolvedUsableAddresses;
    const failures: Array<{ address: string; reason: string }> = [];
    for (const address of addressesToProbe) {
      try {
        await request(websocketUrl(selfCheckHostForAddress(address, host), port, path), timeoutMs);
      } catch (error) {
        failures.push({ address, reason: errorCode(error) });
      }
    }
    if (failures.length > 0) {
      const code = failures.length === 1 && recordAddresses.length === 0
        ? failures[0]!.reason
        : `advertised_target_unreachable:${failures.map(({ address, reason }) => `${address}:${reason}`).join(",")}`;
      throw new CentralServerHealthError(code);
    }
    return {
      endpoint: websocketUrl(selfCheckHostForAddress(addressesToProbe[0]!, host), port, path),
      transport: "srv-target",
    };
  }

  if (targetAddresses.length === 0 && recordAddresses.length === 0) {
    const linkLocalRecordAddress = recordAddressResolution.unscopedLinkLocal[0];
    if (linkLocalRecordAddress) {
      throw new CentralServerHealthError(advertisedTargetResolutionError(linkLocalRecordAddress));
    }
    throw new CentralServerHealthError(
      `srv_target_resolution_failed:${errorCode(targetResolutionError ?? "no_usable_dns_sd_addresses")}`,
      true,
      { cause: targetResolutionError },
    );
  }
  // DNS-SD's resolved A/AAAA records are the contract fallback when the SRV name itself cannot resolve.
  const failures: Array<{ address: string; reason: string }> = [];
  for (const address of recordAddresses) {
    const addressEndpoint = websocketUrl(selfCheckHostForAddress(address, host), port, path);
    try {
      await request(addressEndpoint, timeoutMs);
    } catch (fallbackError) {
      failures.push({ address, reason: errorCode(fallbackError) });
    }
  }
  if (failures.length === 0) {
    return {
      endpoint: websocketUrl(selfCheckHostForAddress(recordAddresses[0]!, host), port, path),
      transport: "dns-sd-address",
    };
  }
  const code = failures.length === 1
    ? `dns_sd_address_unreachable:${failures[0]!.address}:${failures[0]!.reason}`
    : `dns_sd_addresses_unreachable:${failures.map(({ address, reason }) => `${address}:${reason}`).join(",")}`;
  throw new CentralServerHealthError(code, false);
}

export class CentralServerDiscoveryHealth {
  private state: CentralServerHealthState = {
    checkedAt: null,
    endpoint: null,
    error: null,
    status: "starting",
  };
  private generation = 0;
  private stopped = false;
  private readonly listeners = new Set<(state: CentralServerHealthState) => void>();

  constructor(
    private readonly listenerPort: number,
    private readonly serverId: string,
    private readonly options: ServerHealthOptions = {},
  ) {}

  snapshot(): CentralServerHealthState {
    return { ...this.state };
  }

  subscribe(listener: (state: CentralServerHealthState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  markUnhealthy(error: string): void {
    if (this.stopped) return;
    this.generation += 1;
    this.update({
      checkedAt: new Date().toISOString(),
      endpoint: this.state.endpoint,
      error,
      status: "unhealthy",
    });
  }

  async observe(service: BonjourResolvedService): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    try {
      const checked = await checkPublishedServerRecord(service, this.listenerPort, {
        ...this.options,
        serverId: this.serverId,
      });
      if (this.stopped || generation !== this.generation) return;
      this.update({
        checkedAt: new Date().toISOString(),
        endpoint: checked.endpoint,
        error: null,
        status: "healthy",
      });
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.update({
        checkedAt: new Date().toISOString(),
        endpoint: this.state.endpoint,
        error: errorCode(error),
        status: "unhealthy",
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.listeners.clear();
  }

  private update(state: CentralServerHealthState): void {
    const changed = state.status !== this.state.status || state.endpoint !== this.state.endpoint || state.error !== this.state.error;
    const previousStatus = this.state.status;
    this.state = state;
    if (!changed) return;
    const event = state.status === "healthy"
      ? previousStatus === "unhealthy" ? "self_check_recovered" : "self_check_healthy"
      : "self_check_unhealthy";
    console.info(
      `[surf-ace:server] event=${event} status=${state.status}${state.endpoint ? ` endpoint=${JSON.stringify(state.endpoint)}` : ""}${state.error ? ` error=${JSON.stringify(state.error)}` : ""}`,
    );
    for (const listener of this.listeners) listener(this.snapshot());
  }
}
