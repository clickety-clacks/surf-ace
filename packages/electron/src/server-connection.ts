import {
  createBonjourSurfAceDiscoveryService,
  type SurfAceDiscoveryEndpoint,
  type SurfAceDiscoveryService,
} from "./surf-ace-discovery.js";
import { ConfiguredServerRegistration, type PendingCommittedRegistration } from "./configured-server.js";
import type { PaneLabelAllocation, RegistryRegistrationState, SurfaceCore } from "./surface-core.js";
import { reconnectDelayMs } from "../../protocol/src/connection-liveness.js";
import type { RegistryIdentity } from "../../controller/src/wire.js";

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
  private running = false;
  private retryAttempt = 0;
  private lastReportedAt = 0;
  private commitPending = false;
  private readonly pendingRegistration: { request: PendingCommittedRegistration | null } = { request: null };
  private readonly pendingClaimsBySurface = new Map<string, number>();
  private readonly connectedWaiters = new Set<() => void>();
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private browsing = false;
  private pending: Promise<void> | null = null;
  private cycleId = 0;
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
    committedState?: () => RegistryRegistrationState;
    onClaimStatusChange?: (surfaceId: string) => void;
    onError?: (error: unknown) => void;
    discovery?: SurfAceDiscoveryService;
    registryRebindWaitMs?: number;
    requestTimeoutMs?: number;
    registrationCycleTimeoutMs?: number;
  }) {
    this.discovery = options.discovery ?? createBonjourSurfAceDiscoveryService({ timeoutMs: 1500 });
  }

  private setStatus(status: "connected" | "connecting" | "disconnected"): void {
    this.status = status;
    if (status === "connected") {
      for (const resolve of this.connectedWaiters) resolve();
      this.connectedWaiters.clear();
    }
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
    this.logFailure(message);
  }

  private logFailure(message: string): void {
    const now = Date.now();
    if (this.lastReportedFailure === message && now - this.lastReportedAt < 60_000) return;
    this.lastReportedFailure = message;
    this.lastReportedAt = now;
    this.options.onError?.(new Error(message));
  }

  private clearFailure(): void {
    this.lastFailure = null;
    this.lastReportedFailure = null;
  }

  private registrationForCycle(
    cycle: number,
    address: string,
  ): ConfiguredServerRegistration {
    const registration = new ConfiguredServerRegistration(
      address,
      this.options.clientId,
      this.options.core,
      this.options.persist,
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "registry store not responding" || message === "registry store unavailable") {
          this.lastFailure = message;
          this.setStatus(this.status);
        }
        this.logFailure(message);
      },
      undefined,
      this.options.directEndpoint ?? null,
      undefined,
      this.options.committedState,
      this.pendingRegistration,
    );
    registration.onClose(() => {
      registration.abandon();
      if (this.selected?.registration !== registration) return;
      this.selected = null;
      this.lastFailure = "registry unreachable";
      this.setStatus("disconnected");
      this.logFailure(this.lastFailure);
      this.scheduleRecovery();
    });
    const registrations = this.cycleRegistrations.get(cycle) ?? new Set<ConfiguredServerRegistration>();
    registrations.add(registration);
    this.cycleRegistrations.set(cycle, registrations);
    return registration;
  }

  private scheduleRecovery(): void {
    if (this.stopped || !this.running || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.synchronize().catch(() => undefined);
    }, reconnectDelayMs(this.retryAttempt++));
  }

  labelClaimPending(surfaceId: string): boolean {
    return this.pendingClaimsBySurface.has(surfaceId);
  }

  async claimPaneLabel(surfaceId: string, paneId: number, paneLineageId: string): Promise<PaneLabelAllocation> {
    this.pendingClaimsBySurface.set(surfaceId, (this.pendingClaimsBySurface.get(surfaceId) ?? 0) + 1);
    this.options.onClaimStatusChange?.(surfaceId);
    try {
      return await this.sendPaneClaim(surfaceId, paneId, paneLineageId);
    } finally {
      const pending = this.pendingClaimsBySurface.get(surfaceId) ?? 1;
      if (pending === 1) this.pendingClaimsBySurface.delete(surfaceId);
      else this.pendingClaimsBySurface.set(surfaceId, pending - 1);
      this.options.onClaimStatusChange?.(surfaceId);
    }
  }

  private async sendPaneClaim(surfaceId: string, paneId: number, paneLineageId: string): Promise<PaneLabelAllocation> {
    for (;;) {
      if (this.stopped) throw new Error("allocator_unavailable");
      if (this.status !== "connected" || !this.selected) {
        if (!this.running) throw new Error("allocator_unavailable");
        await new Promise<void>((resolve) => this.connectedWaiters.add(resolve));
        continue;
      }
      if (this.options.core.locklessAuthority.listPendingPaneReleases().length > 0 ||
          this.options.core.locklessAuthority.listPendingWindowReleases().length > 0) {
        throw new Error("allocator_release_pending");
      }
      const registration = this.selected.registration;
      try {
        return await registration.claimPaneLabel(surfaceId, paneId, paneLineageId);
      } catch (error) {
        if (this.selected?.registration === registration && registration.isOpen()) throw error;
      }
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

  registrationStateCommitted(): void {
    this.commitPending = true;
    if (this.pending || !this.selected || this.stopped) return;
    this.commitPending = false;
    void this.synchronize().catch(() => undefined);
  }

  synchronize(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    const cycle = ++this.cycleId;
    const registrations = new Set<ConfiguredServerRegistration>();
    this.cycleRegistrations.set(cycle, registrations);
    if (this.selected) registrations.add(this.selected.registration);
    const run = this.runSynchronization(cycle).catch((error) => {
      if (this.isCurrentCycle(cycle) && !this.selected) {
        this.lastFailure ??= "registry unreachable";
        this.setStatus("disconnected");
        this.logFailure(this.lastFailure);
        this.scheduleRecovery();
      }
      throw error;
    }).finally(() => {
      this.cycleRegistrations.delete(cycle);
      if (this.pending === run) this.pending = null;
      if (this.commitPending && this.selected) this.registrationStateCommitted();
    });
    this.pending = run;
    return run;
  }

  private async runSynchronization(cycle: number): Promise<void> {
    if (!this.isCurrentCycle(cycle)) return;
    if (!this.selected || this.status !== "connected") this.setStatus("connecting");
    const failures: string[] = [];
    const visited = new Set<string>();

    if (this.selected) {
      const current = this.selected;
      try {
        await current.registration.synchronize();
        if (!this.isCurrentCycle(cycle)) return;
        this.retryAttempt = 0;
        this.clearFailure();
        this.setStatus("connected");
        return;
      } catch (error) {
        visited.add(current.address);
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
    const adopt = async (candidate: CandidateRegistration, allowRebind: boolean): Promise<boolean> => {
      try {
        await candidate.registration.synchronize({
          allowRebind,
          expectedIdentity: candidate.identity,
        });
        if (!this.isCurrentCycle(cycle)) { candidate.registration.abandon(); return false; }
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
        this.retryAttempt = 0;
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
    this.logFailure(message);
    throw new Error(message);
  }

  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void this.synchronize().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const resolve of this.connectedWaiters) resolve();
    this.connectedWaiters.clear();
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
