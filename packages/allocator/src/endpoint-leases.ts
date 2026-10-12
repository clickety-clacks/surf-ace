export type EndpointLease = {
  leaseGeneration: number;
  registrationObservedAtMs: number;
  leaseExpiresAtMs: number;
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
