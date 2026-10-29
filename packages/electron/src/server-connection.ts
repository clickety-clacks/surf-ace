import {
  createBonjourSurfAceDiscoveryService,
  type SurfAceDiscoveryEndpoint,
  type SurfAceDiscoveryService,
} from "./surf-ace-discovery.js";
import { ConfiguredServerRegistration, RegistrationStageTimeoutError } from "./configured-server.js";
import type { PaneLabelAllocation, SurfaceCore } from "./surface-core.js";
import { ControllerWireTimeoutError, type RegistryIdentity } from "../../controller/src/wire.js";

type SelectedRegistration = {
  address: string;
  configured: boolean;
  registration: ConfiguredServerRegistration;
};

type CandidateRegistration = SelectedRegistration & { context: string; identity: RegistryIdentity };

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
  return `${error.name}${code}: ${error.message}`;
}

function endpointAddress(endpoint: SurfAceDiscoveryEndpoint): string {
  const unwrappedHost = endpoint.host.replace(/^\[(.*)\]$/, "$1");
  const host = unwrappedHost.includes(":") ? `[${unwrappedHost}]` : unwrappedHost;
  return `ws://${host}:${endpoint.port}${endpoint.wsPath}`;
}

function endpointAddresses(endpoint: SurfAceDiscoveryEndpoint): string[] {
  const addresses = [...new Set((endpoint.transportAddresses ?? []).map((transportAddress) => {
    const unwrappedHost = transportAddress.replace(/^\[(.*)\]$/, "$1");
    const host = unwrappedHost.includes(":") ? `[${unwrappedHost}]` : unwrappedHost;
    return `ws://${host}:${endpoint.port}${endpoint.wsPath}`;
  }))];
  return [...new Set([...addresses, endpointAddress(endpoint)])];
}

function isServerContract(endpoint: SurfAceDiscoveryEndpoint): boolean {
  // Role and route identify a usable registry endpoint. A newer or missing
  // topology version may still speak the fields this client understands, so
  // let the request path establish compatibility instead of filtering it out.
  return endpoint.role === "server" && endpoint.wsPath === "/ws";
}

function isUnspecifiedAddress(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "0:0:0:0:0:0:0:0";
}

function sameRegistry(left: RegistryIdentity, right: RegistryIdentity): boolean {
  return left.allocatorId === right.allocatorId && left.fleetId === right.fleetId;
}

export class ServerConnection {
  private selected: SelectedRegistration | null = null;
  private status: "connected" | "connecting" | "disconnected" = "disconnected";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private browsing = false;
  private pending: Promise<void> | null = null;
  private cycleId = 0;
  private currentStage = "registry discovery";
  private readonly cycleRegistrations = new Map<number, Set<ConfiguredServerRegistration>>();
  private lastFailure: string | null = null;
  private lastReportedFailure: string | null = null;
  private readonly discovery: SurfAceDiscoveryService;

  constructor(private readonly options: {
    configuredAddress?: string;
    directEndpoint?: string | null;
    clientId: string;
    core: SurfaceCore;
    persist: () => Promise<void>;
    onError?: (error: unknown) => void;
    discovery?: SurfAceDiscoveryService;
    registryRebindWaitMs?: number;
    requestTimeoutMs?: number;
    registrationCycleTimeoutMs?: number;
    controlTimeoutMs?: number;
  }) {
    this.discovery = options.discovery ?? createBonjourSurfAceDiscoveryService({ timeoutMs: 1500 });
  }

  private setStatus(status: "connected" | "connecting" | "disconnected"): void {
    this.status = status;
    for (const surface of this.options.core.listSurfaces()) {
      this.options.core.setConnectionBar(surface.surfaceId, status, this.lastFailure);
    }
  }

  private isCurrentCycle(cycle: number): boolean {
    return !this.stopped && this.cycleId === cycle;
  }

  private reportFailure(message: string, visible: boolean, failures: string[], cycle?: number): void {
    if (cycle !== undefined && !this.isCurrentCycle(cycle)) return;
    failures.push(message);
    if (visible && !this.selected) {
      this.lastFailure = message;
      this.setStatus("connecting");
    }
    if (this.lastReportedFailure !== message) {
      this.lastReportedFailure = message;
      this.options.onError?.(new Error(message));
    }
  }

  private clearFailure(): void {
    this.lastFailure = null;
    this.lastReportedFailure = null;
  }

  private registrationForCycle(
    cycle: number,
    address: string,
  ): ConfiguredServerRegistration {
    let registration: ConfiguredServerRegistration;
    registration = new ConfiguredServerRegistration(
      address,
      this.options.clientId,
      this.options.core,
      this.options.persist,
      this.options.onError,
      this.options.requestTimeoutMs ?? 2000,
      this.options.directEndpoint ?? null,
      (stage) => {
        if (this.isCurrentCycle(cycle) || this.selected?.registration === registration) this.currentStage = stage;
      },
    );
    const registrations = this.cycleRegistrations.get(cycle) ?? new Set<ConfiguredServerRegistration>();
    registrations.add(registration);
    this.cycleRegistrations.set(cycle, registrations);
    return registration;
  }

  private isStallTimeout(error: unknown): boolean {
    return error instanceof ControllerWireTimeoutError || error instanceof RegistrationStageTimeoutError;
  }

  private reportStall(error: unknown, cycle: number): void {
    if (!this.isCurrentCycle(cycle)) return;
    const stage = error instanceof RegistrationStageTimeoutError ? error.stage : this.currentStage;
    this.abandonCycle(cycle, new Error(`registry_cycle_timed_out:${stage}`));
  }

  private abandonCycle(cycle: number, error: Error): void {
    if (!this.isCurrentCycle(cycle)) return;
    this.cycleId += 1;
    clearTimeout(this.leaseTimer);
    const registrations = this.cycleRegistrations.get(cycle) ?? new Set<ConfiguredServerRegistration>();
    this.cycleRegistrations.delete(cycle);
    for (const registration of registrations) registration.abandon();
    this.selected?.registration.abandon();
    this.selected = null;
    this.lastFailure = error.message;
    this.setStatus("disconnected");
    if (this.lastReportedFailure !== error.message) {
      this.lastReportedFailure = error.message;
      this.options.onError?.(error);
    }
    this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    if (this.stopped || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (!this.stopped) void this.synchronize().catch(() => undefined);
    }, 100);
  }

  private leaseIsFresh(): boolean {
    const lease = this.options.core.registryEndpointLease();
    return lease === null || Date.now() < lease.leaseExpiresAtMs;
  }

  private armLeaseExpiry(): void {
    clearTimeout(this.leaseTimer);
    if (this.status !== "connected" || !this.selected) return;
    const lease = this.options.core.registryEndpointLease();
    if (!lease) return;
    const expire = (): void => {
      if (this.stopped || this.status !== "connected" || !this.selected) return;
      const current = this.options.core.registryEndpointLease();
      if (!current || current.leaseGeneration !== lease.leaseGeneration) return;
      const remaining = current.leaseExpiresAtMs - Date.now();
      if (remaining > 0) {
        this.leaseTimer = setTimeout(expire, Math.min(remaining, 2_147_000_000));
        return;
      }
      this.lastFailure = "registry_lease_expired";
      this.setStatus("disconnected");
      const error = new Error("registry_lease_expired");
      if (this.lastReportedFailure !== error.message) {
        this.lastReportedFailure = error.message;
        this.options.onError?.(error);
      }
      this.scheduleRecovery();
    };
    this.leaseTimer = setTimeout(expire, Math.min(
      Math.max(0, lease.leaseExpiresAtMs - Date.now()),
      2_147_000_000,
    ));
  }

  async claimPaneLabel(surfaceId: string, paneId: number, paneLineageId: string): Promise<PaneLabelAllocation> {
    if (this.status !== "connected" || !this.selected) throw new Error("allocator_unavailable");
    if (this.options.core.locklessAuthority.listPendingPaneReleases().length > 0 ||
        this.options.core.locklessAuthority.listPendingWindowReleases().length > 0) {
      throw new Error("allocator_release_pending");
    }
    const registration = this.selected.registration;
    const timeoutMs = this.options.controlTimeoutMs ?? 10_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const allocation = await Promise.race([
        registration.claimPaneLabel(surfaceId, paneId, paneLineageId),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new RegistrationStageTimeoutError("pane.claim request")), timeoutMs);
        }),
      ]);
      if (this.status !== "connected" || this.selected?.registration !== registration || !this.leaseIsFresh()) {
        throw new Error("allocator_unavailable");
      }
      return allocation;
    } catch (error) {
      if (this.isStallTimeout(error) && this.selected?.registration === registration) {
        this.reportStall(error, this.cycleId);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async preparePaneLabelClaim(): Promise<void> {
    if (this.options.core.locklessAuthority.listPendingPaneReleases().length === 0 &&
        this.options.core.locklessAuthority.listPendingWindowReleases().length === 0) return;
    await this.synchronize();
    if (this.options.core.locklessAuthority.listPendingPaneReleases().length > 0 ||
        this.options.core.locklessAuthority.listPendingWindowReleases().length > 0) {
      throw new Error("allocator_release_pending");
    }
  }

  synchronize(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    const cycle = ++this.cycleId;
    this.currentStage = "registry discovery";
    const registrations = new Set<ConfiguredServerRegistration>();
    this.cycleRegistrations.set(cycle, registrations);
    if (this.selected) registrations.add(this.selected.registration);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new RegistrationStageTimeoutError(this.currentStage)),
        this.options.registrationCycleTimeoutMs ?? 10_000,
      );
    });
    const work = this.runSynchronization(cycle);
    const run = Promise.race([work, deadline]).catch((error: unknown) => {
      if (this.isStallTimeout(error)) this.reportStall(error, cycle);
      else if (this.isCurrentCycle(cycle) && !this.selected) this.setStatus("disconnected");
      throw error;
    }).finally(() => {
      clearTimeout(timeout);
      this.cycleRegistrations.delete(cycle);
      if (this.pending === run) this.pending = null;
      if (this.isCurrentCycle(cycle) && this.status === "connected") this.armLeaseExpiry();
      else if (!this.stopped && cycle !== this.cycleId && this.status === "disconnected" && !this.selected) {
        this.scheduleRecovery();
      }
    });
    this.pending = run;
    return run;
  }

  private async runSynchronization(cycle: number): Promise<void> {
    if (!this.isCurrentCycle(cycle)) return;
    if (!this.selected || this.status !== "connected") this.setStatus("connecting");
    const failures: string[] = [];

    if (this.selected) {
      const current = this.selected;
      try {
        await current.registration.synchronize();
        if (!this.isCurrentCycle(cycle)) return;
        if (!this.leaseIsFresh()) throw new RegistrationStageTimeoutError("registry lease");
        this.clearFailure();
        this.setStatus("connected");
        return;
      } catch (error) {
        if (this.isStallTimeout(error)) throw error;
        await current.registration.stop();
        if (!this.isCurrentCycle(cycle)) return;
        this.selected = null;
        this.reportFailure(`registry ${current.address} reconnect failed: ${describeError(error)}`, true, failures, cycle);
        this.setStatus("connecting");
      }
    }

    const addresses: Array<{ address: string; configured: boolean; context: string }> = [];
    if (this.options.configuredAddress) {
      addresses.push({ address: this.options.configuredAddress, configured: true, context: "configured registry" });
    }

    this.currentStage = "registry discovery";
    try {
      if (!this.browsing) {
        await this.discovery.start();
        if (!this.isCurrentCycle(cycle)) return;
        this.browsing = true;
      } else {
        await this.discovery.refreshNow();
        if (!this.isCurrentCycle(cycle)) return;
      }
    } catch (error) {
      if (!this.isCurrentCycle(cycle)) return;
      this.browsing = false;
      this.reportFailure(`DNS-SD browse failed: ${describeError(error)}`, true, failures, cycle);
    }

    const endpoints = this.discovery.getSnapshot();
    const servers: SurfAceDiscoveryEndpoint[] = [];
    for (const endpoint of endpoints) {
      if (endpoint.role !== "server") continue;
      if (!isServerContract(endpoint)) {
        this.reportFailure(
          `DNS-SD service ${endpoint.instanceName} rejected: expected role=server v=1 ws=/ws, received role=${endpoint.role ?? "missing"} v=${endpoint.protocolVersion} ws=${endpoint.wsPath || "missing"}`,
          true,
          failures,
          cycle,
        );
        continue;
      }
      if (endpoint.protocolVersion !== 1) {
        this.reportFailure(
          `DNS-SD service ${endpoint.instanceName} advertises topology version ${endpoint.protocolVersion ?? "unknown"}; trying the understood server fields`,
          false,
          failures,
          cycle,
        );
      }
      if (isUnspecifiedAddress(endpoint.host)) {
        this.reportFailure(
          `DNS-SD service ${endpoint.instanceName} rejected: SRV target ${endpoint.host} is a wildcard address, not a client destination`,
          true,
          failures,
          cycle,
        );
        continue;
      }
      servers.push(endpoint);
    }

    const discoveryError = this.discovery.getLastError?.();
    if (discoveryError) this.reportFailure(`DNS-SD discovery failed: ${discoveryError}`, true, failures, cycle);
    if (servers.length === 0) {
      if (!discoveryError && endpoints.length === 0) {
        this.reportFailure("DNS-SD browse found no _surf-ace._tcp service with role=server v=1 ws=/ws", true, failures, cycle);
      } else if (!discoveryError && !endpoints.some((endpoint) => endpoint.role === "server")) {
        this.reportFailure("DNS-SD browse found no service with role=server", true, failures, cycle);
      }
    }
    for (const endpoint of servers) {
      for (const address of endpointAddresses(endpoint)) {
        addresses.push({ address, configured: false, context: `discovered registry ${endpoint.instanceName}` });
      }
    }

    const binding = this.options.core.registryBinding();
    const boundForClient = binding?.clientId === this.options.clientId ? binding : null;
    let matchingRegistrySeen = false;
    let firstForeign: CandidateRegistration | null = null;
    const visited = new Set<string>();

    const adopt = async (candidate: CandidateRegistration, allowRebind: boolean): Promise<boolean> => {
      try {
        candidate.registration.onClose(() => {
          if (this.selected?.registration === candidate.registration) {
            clearTimeout(this.leaseTimer);
            this.lastFailure = "registry_connection_closed";
            this.setStatus("disconnected");
            this.scheduleRecovery();
          }
        });
        await candidate.registration.synchronize({
          allowRebind,
          expectedIdentity: candidate.identity,
        });
        if (!this.isCurrentCycle(cycle)) { candidate.registration.abandon(); return false; }
        if (!this.leaseIsFresh()) throw new RegistrationStageTimeoutError("registry lease");
        const previous = this.selected;
        this.selected = {
          address: candidate.address,
          configured: candidate.configured,
          registration: candidate.registration,
        };
        if (firstForeign && firstForeign.registration !== candidate.registration) {
          await firstForeign.registration.stop();
          if (!this.isCurrentCycle(cycle)) return false;
        }
        firstForeign = null;
        this.clearFailure();
        this.setStatus("connected");
        await previous?.registration.stop();
        if (!this.isCurrentCycle(cycle)) return false;
        if (this.browsing) {
          await this.discovery.stop();
          if (!this.isCurrentCycle(cycle)) return false;
          this.browsing = false;
        }
        return true;
      } catch (error) {
        if (this.isStallTimeout(error)) throw error;
        await candidate.registration.stop();
        if (!this.isCurrentCycle(cycle)) return false;
        this.reportFailure(`${candidate.context} ${candidate.address} failed: ${describeError(error)}`, !this.selected, failures, cycle);
        return false;
      }
    };

    for (const route of addresses) {
      if (!this.isCurrentCycle(cycle)) return;
      if (visited.has(route.address)) continue;
      visited.add(route.address);
      let registration: ConfiguredServerRegistration | null = null;
      try {
        registration = this.registrationForCycle(cycle, route.address);
        const identity = await registration.readRegistryIdentity();
        if (!this.isCurrentCycle(cycle)) { registration.abandon(); return; }
        const currentBinding = this.options.core.registryBinding();
        const currentForClient = currentBinding?.clientId === this.options.clientId ? currentBinding : null;
        if (!currentForClient) {
          const first = { ...route, registration, identity };
          if (await adopt(first, false)) return;
          const afterFailure = this.options.core.registryBinding();
          if (afterFailure?.clientId === this.options.clientId &&
              afterFailure.allocatorId === identity.allocatorId && afterFailure.fleetId === identity.fleetId) {
            matchingRegistrySeen = true;
          }
          registration = null;
          continue;
        }
        if (currentForClient.allocatorId === identity.allocatorId && currentForClient.fleetId === identity.fleetId) {
          matchingRegistrySeen = true;
          const matching = { ...route, registration, identity };
          if (await adopt(matching, false)) return;
          registration = null;
          continue;
        }
        if (!firstForeign) firstForeign = { ...route, registration, identity };
        else await registration.stop();
        registration = null;
      } catch (error) {
        if (error instanceof ControllerWireTimeoutError && this.currentStage === "registry identity request") {
          await registration?.stop();
          if (!this.isCurrentCycle(cycle)) return;
          registration = null;
          this.reportFailure(
            `${route.context} ${route.address} identity probe timed out at ${this.currentStage}: ${describeError(error)}`,
            true,
            failures,
            cycle,
          );
          continue;
        }
        if (this.isStallTimeout(error)) throw error;
        await registration?.stop();
        if (!this.isCurrentCycle(cycle)) return;
        this.reportFailure(`${route.context} ${route.address} identity probe failed: ${describeError(error)}`, true, failures, cycle);
      }
    }

    if (!matchingRegistrySeen && firstForeign && boundForClient) {
      const waitMs = Math.max(0, Math.min(2_000, this.options.registryRebindWaitMs ?? 250));
      const deadline = Date.now() + waitMs;
      while (this.isCurrentCycle(cycle) && Date.now() < deadline && !matchingRegistrySeen) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
        if (!this.isCurrentCycle(cycle)) return;
        try { await this.discovery.refreshNow(); } catch { /* Continue through the bounded rebind wait. */ }
        if (!this.isCurrentCycle(cycle)) return;
        const returningAddresses: Array<{ address: string; configured: boolean; context: string }> = [];
        if (this.options.configuredAddress) {
          returningAddresses.push({ address: this.options.configuredAddress, configured: true, context: "configured registry" });
        }
        for (const endpoint of this.discovery.getSnapshot()) {
          if (endpoint.role !== "server" || !isServerContract(endpoint) || isUnspecifiedAddress(endpoint.host)) continue;
          for (const address of endpointAddresses(endpoint)) {
            returningAddresses.push({ address, configured: false, context: `discovered registry ${endpoint.instanceName}` });
          }
        }
        const checked = new Set<string>();
        for (const route of returningAddresses) {
          if (!this.isCurrentCycle(cycle)) return;
          if (checked.has(route.address) || route.address === firstForeign.address) continue;
          checked.add(route.address);
          let registration: ConfiguredServerRegistration | null = null;
          try {
            registration = this.registrationForCycle(cycle, route.address);
            const identity = await registration.readRegistryIdentity();
            if (!this.isCurrentCycle(cycle)) { registration.abandon(); return; }
            if (identity.allocatorId === boundForClient.allocatorId && identity.fleetId === boundForClient.fleetId) {
              matchingRegistrySeen = true;
              const returning = { ...route, registration, identity };
              registration = null;
              if (await adopt(returning, false)) return;
              break;
            }
          } catch (error) {
            if (this.isStallTimeout(error)) throw error;
            if (!this.isCurrentCycle(cycle)) return;
            // A failed probe during the bounded wait does not make a foreign identity eligible.
          } finally {
            await registration?.stop();
          }
        }
      }
    }

    if (!matchingRegistrySeen && firstForeign) {
      if (await adopt(firstForeign, true)) return;
      if (!this.isCurrentCycle(cycle)) return;
      firstForeign = null;
    }
    await firstForeign?.registration.stop();
    if (!this.isCurrentCycle(cycle)) return;

    const message = failures.length > 0
      ? `no_surf_ace_server: ${failures.join("; ")}`
      : "no_surf_ace_server: no valid _surf-ace._tcp role=server ws=/ws advertisement";
    this.lastFailure = message;
    this.setStatus("disconnected");
    if (this.lastReportedFailure !== message) {
      this.lastReportedFailure = message;
      this.options.onError?.(new Error(message));
    }
    throw new Error(message);
  }

  start(): void {
    const tick = async () => {
      try { await this.synchronize(); } catch (error) {
        if (!this.isStallTimeout(error)) {
          const message = error instanceof Error ? error.message : String(error);
          if (this.lastReportedFailure !== message) {
            this.lastReportedFailure = message;
            this.options.onError?.(error);
          }
        }
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.leaseTimer);
    clearTimeout(this.recoveryTimer);
    this.cycleId += 1;
    for (const registrations of this.cycleRegistrations.values()) {
      for (const registration of registrations) registration.abandon();
    }
    this.cycleRegistrations.clear();
    await this.selected?.registration.stop();
    this.selected = null;
    await this.discovery.stop();
    this.setStatus("disconnected");
  }
}
