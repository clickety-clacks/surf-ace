import { isIP } from "node:net";

export type EndpointLease = {
  leaseGeneration: number;
  registrationObservedAtMs: number;
  leaseExpiresAtMs: number;
};

export type DirectEndpointSource = "configured" | "client-reported" | "registry-observed";

export type ResolvedDirectEndpoint = {
  directEndpoint: string | null;
  directEndpointSource: DirectEndpointSource | null;
};

type LeaseRecord = {
  lease: EndpointLease;
  signature: string;
};

const GENERATIONS_PER_WRITER_EPOCH = 1_000_000;

export function endpointLeaseGenerationRange(writerLeaseGeneration: number): { first: number; last: number } {
  if (!Number.isSafeInteger(writerLeaseGeneration) || writerLeaseGeneration < 1) {
    throw new RangeError("endpoint_lease_generation_exhausted");
  }
  const first = writerLeaseGeneration * GENERATIONS_PER_WRITER_EPOCH + 1;
  const last = first + GENERATIONS_PER_WRITER_EPOCH - 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) {
    throw new RangeError("endpoint_lease_generation_exhausted");
  }
  return { first, last };
}

export function validateDirectEndpoint(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("invalid_direct_endpoint");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid_direct_endpoint");
  }
  if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
      !parsed.hostname || parsed.username || parsed.password || value.includes("#")) {
    throw new Error("invalid_direct_endpoint");
  }
  return value;
}

/**
 * Resolve registration endpoint inputs without allowing a client to assert a
 * registry-observed source. The accepted peer is captured from the actual
 * registry WebSocket connection, never from forwarded headers or the payload.
 */
export function resolveDirectEndpoint(
  directEndpointValue: unknown,
  directEndpointSourceValue: unknown,
  directEndpointListenerValue: unknown,
  acceptedPeerAddress: string | null,
): ResolvedDirectEndpoint {
  const directEndpoint = validateDirectEndpoint(directEndpointValue);
  const requestedSource = parseDirectEndpointSource(directEndpointSourceValue);
  const listener = parseDirectEndpointListener(directEndpointListenerValue);

  if (directEndpoint !== null) {
    return {
      directEndpoint,
      // Older clients sent only directEndpoint, which represented their
      // configured endpoint. A client cannot mint registry-observed.
      directEndpointSource: requestedSource === "configured" || requestedSource === null
        ? "configured"
        : "client-reported",
    };
  }

  if (listener !== null && acceptedPeerAddress !== null) {
    const endpoint = endpointFromAcceptedPeer(listener, acceptedPeerAddress);
    if (endpoint !== null) return { directEndpoint: endpoint, directEndpointSource: "registry-observed" };
  }
  return { directEndpoint: null, directEndpointSource: null };
}

function parseDirectEndpointSource(value: unknown): DirectEndpointSource | null {
  if (value === undefined || value === null) return null;
  if (value === "configured" || value === "client-reported" || value === "registry-observed") return value;
  throw new Error("invalid_direct_endpoint_source");
}

function parseDirectEndpointListener(value: unknown): { scheme: "ws" | "wss"; port: number; path: string } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_direct_endpoint_listener");
  const listener = value as Record<string, unknown>;
  if ((listener.scheme !== "ws" && listener.scheme !== "wss") ||
      !Number.isSafeInteger(listener.port) || Number(listener.port) < 1 || Number(listener.port) > 65_535 ||
      typeof listener.path !== "string" || !listener.path.startsWith("/")) {
    throw new Error("invalid_direct_endpoint_listener");
  }

  try {
    const parsed = new URL(`${listener.scheme}://endpoint.invalid:${listener.port}${listener.path}`);
    const parsedPort = parsed.port === ""
      ? (listener.scheme === "ws" ? 80 : 443)
      : Number(parsed.port);
    if (parsed.hostname !== "endpoint.invalid" || parsedPort !== listener.port ||
        parsed.pathname !== listener.path || parsed.search !== "" || parsed.hash !== "" ||
        parsed.username !== "" || parsed.password !== "") {
      throw new Error("invalid_direct_endpoint_listener");
    }
  } catch {
    throw new Error("invalid_direct_endpoint_listener");
  }
  return { scheme: listener.scheme, port: Number(listener.port), path: listener.path };
}

function endpointFromAcceptedPeer(
  listener: { scheme: "ws" | "wss"; port: number; path: string },
  acceptedPeerAddress: string,
): string | null {
  const host = endpointHost(acceptedPeerAddress);
  if (host === null) return null;
  const endpoint = `${listener.scheme}://${host}:${listener.port}${listener.path}`;
  try {
    return validateDirectEndpoint(endpoint);
  } catch {
    return null;
  }
}

function endpointHost(acceptedPeerAddress: string): string | null {
  const mappedV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(acceptedPeerAddress);
  if (mappedV4 && isIP(mappedV4[1]!) === 4) return mappedV4[1]!;

  const scopeIndex = acceptedPeerAddress.lastIndexOf("%");
  const ipv6Address = scopeIndex >= 0 ? acceptedPeerAddress.slice(0, scopeIndex) : acceptedPeerAddress;
  if (isIP(ipv6Address) === 4 && scopeIndex < 0) return ipv6Address;
  if (isIP(ipv6Address) !== 6) return null;

  const scope = scopeIndex >= 0 ? acceptedPeerAddress.slice(scopeIndex + 1) : "";
  const encodedScope = scope ? `%25${encodeURIComponent(scope)}` : "";
  return `[${ipv6Address}${encodedScope}]`;
}

/**
 * In-memory registrations are deliberately rebuilt after server restart.
 * Writer lease generations provide a durable restart epoch. Each epoch owns
 * the disjoint range (generation * 1,000,000, (generation + 1) * 1,000,000],
 * independent of wall-clock time, so a clock rollback cannot reuse a lease.
 */
export class EndpointLeaseBook {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly clock: () => number;
  readonly maxEndpointLeaseMs: number;
  private nextGeneration: number;
  private issuedInEpoch = 0;
  private lastServerTimeMs: number;

  constructor(
    writerLeaseGeneration: number,
    maxEndpointLeaseMs: number,
    clock: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(writerLeaseGeneration) || writerLeaseGeneration < 1 ||
        !Number.isSafeInteger(maxEndpointLeaseMs) || maxEndpointLeaseMs < 1) {
      throw new RangeError("invalid_endpoint_lease_configuration");
    }
    this.maxEndpointLeaseMs = maxEndpointLeaseMs;
    this.clock = clock;
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("invalid_registry_clock");
    this.lastServerTimeMs = now;
    this.nextGeneration = endpointLeaseGenerationRange(writerLeaseGeneration).first - 1;
  }

  serverTimeMs(): number {
    const clockValue = this.clock();
    if (!Number.isSafeInteger(clockValue) || clockValue < 0) throw new RangeError("invalid_registry_clock");
    this.lastServerTimeMs = Math.max(clockValue, this.lastServerTimeMs + 1);
    if (!Number.isSafeInteger(this.lastServerTimeMs)) throw new RangeError("registry_clock_exhausted");
    return this.lastServerTimeMs;
  }

  renew(clientId: string, signature: string, eligible: boolean): EndpointLease | null {
    if (!eligible) {
      this.leases.delete(clientId);
      return null;
    }
    const now = this.serverTimeMs();
    const previous = this.leases.get(clientId);
    let lease: EndpointLease;
    if (previous?.signature === signature) {
      lease = {
        ...previous.lease,
        leaseExpiresAtMs: now + this.maxEndpointLeaseMs,
      };
    } else {
      if (this.issuedInEpoch >= GENERATIONS_PER_WRITER_EPOCH) {
        throw new RangeError("endpoint_lease_generation_exhausted");
      }
      this.issuedInEpoch += 1;
      this.nextGeneration += 1;
      lease = {
        leaseGeneration: this.nextGeneration,
        registrationObservedAtMs: now,
        leaseExpiresAtMs: now + this.maxEndpointLeaseMs,
      };
    }
    if (!Number.isSafeInteger(lease.leaseExpiresAtMs)) throw new RangeError("endpoint_lease_expiry_exhausted");
    this.leases.set(clientId, { lease, signature });
    return { ...lease };
  }
}
