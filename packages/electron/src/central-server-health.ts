import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

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
  if (normalized === "localhost" || normalized.endsWith(".localhost") || !isUsableAddress(host)) {
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
    return first !== 0 && first !== 127 && first !== 169 && (first ?? 0) < 224;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isUsableAddress(normalized.slice(7));
    return normalized !== "::" && normalized !== "::1" &&
      !normalized.startsWith("fe80:") && !normalized.startsWith("ff");
  }
  return true;
}

function usableTransportAddresses(service: BonjourResolvedService): string[] {
  const addresses = Array.isArray(service.addresses) ? service.addresses : [];
  return [...new Set(addresses
    .filter((address): address is string => typeof address === "string")
    .map((address) => address.trim())
    .filter((address) => isIP(address) !== 0 && isUsableAddress(address)))];
}

function websocketUrl(host: string, port: number, path: string): string {
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return `ws://${formattedHost}:${port}${path}`;
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
  const request = options.requestTopology ?? requestFleetTopology;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = websocketUrl(host, port, path);
  try {
    await request(endpoint, timeoutMs);
    return { endpoint, transport: "srv-target" };
  } catch (error) {
    if (!isDnsFailure(error)) throw error;
    const addresses = usableTransportAddresses(service);
    if (addresses.length === 0) {
      throw new CentralServerHealthError(`srv_target_resolution_failed:${errorCode(error)}`, true, { cause: error });
    }
    let lastError: unknown = error;
    for (const address of addresses) {
      const addressEndpoint = websocketUrl(address, port, path);
      try {
        await request(addressEndpoint, timeoutMs);
        return { endpoint: addressEndpoint, transport: "dns-sd-address" };
      } catch (fallbackError) {
        lastError = fallbackError;
        if (!isDnsFailure(fallbackError)) {
          throw new CentralServerHealthError(
            `dns_sd_address_unreachable:${address}:${errorCode(fallbackError)}`,
            false,
            { cause: fallbackError },
          );
        }
      }
    }
    throw new CentralServerHealthError(`dns_sd_addresses_unresolvable:${errorCode(lastError)}`, true, { cause: lastError });
  }
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
