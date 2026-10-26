import {
  createBonjourSurfAceDiscoveryService,
  type SurfAceDiscoveryEndpoint,
  type SurfAceDiscoveryService,
} from "./surf-ace-discovery.js";
import { ConfiguredServerRegistration } from "./configured-server.js";
import type { PaneLabelAllocation, SurfaceCore } from "./surface-core.js";
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
  return endpoint.role === "server" && endpoint.protocolVersion === 1 && endpoint.wsPath === "/ws";
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
  private stopped = false;
  private browsing = false;
  private pending: Promise<void> = Promise.resolve();
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
  }) {
    this.discovery = options.discovery ?? createBonjourSurfAceDiscoveryService({ timeoutMs: 1500 });
  }

  private setStatus(status: "connected" | "connecting" | "disconnected"): void {
    this.status = status;
    for (const surface of this.options.core.listSurfaces()) {
      this.options.core.setConnectionBar(surface.surfaceId, status, this.lastFailure);
    }
  }

  private reportFailure(message: string, visible: boolean, failures: string[]): void {
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

  async claimPaneLabel(surfaceId: string, paneId: number, paneLineageId: string): Promise<PaneLabelAllocation> {
    if (this.status !== "connected" || !this.selected) throw new Error("allocator_unavailable");
    if (this.options.core.locklessAuthority.listPendingPaneReleases().length > 0 ||
        this.options.core.locklessAuthority.listPendingWindowReleases().length > 0) {
      throw new Error("allocator_release_pending");
    }
    return await this.selected.registration.claimPaneLabel(surfaceId, paneId, paneLineageId);
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
    const run = this.pending.then(async () => {
      if (this.stopped) return;
      if (!this.selected || this.status !== "connected") this.setStatus("connecting");
      const failures: string[] = [];

      if (this.selected) {
        const current = this.selected;
        try {
          await current.registration.synchronize();
          if (this.stopped) return;
          this.clearFailure();
          this.setStatus("connected");
          return;
        } catch (error) {
          await current.registration.stop();
          this.selected = null;
          this.reportFailure(`registry ${current.address} reconnect failed: ${describeError(error)}`, true, failures);
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
          this.browsing = true;
        } else {
          await this.discovery.refreshNow();
        }
      } catch (error) {
        this.browsing = false;
        this.reportFailure(`DNS-SD browse failed: ${describeError(error)}`, true, failures);
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
          );
          continue;
        }
        if (isUnspecifiedAddress(endpoint.host)) {
          this.reportFailure(
            `DNS-SD service ${endpoint.instanceName} rejected: SRV target ${endpoint.host} is a wildcard address, not a client destination`,
            true,
            failures,
          );
          continue;
        }
        servers.push(endpoint);
      }

      const discoveryError = this.discovery.getLastError?.();
      if (discoveryError) this.reportFailure(`DNS-SD discovery failed: ${discoveryError}`, true, failures);
      if (servers.length === 0) {
        if (!discoveryError && endpoints.length === 0) {
          this.reportFailure("DNS-SD browse found no _surf-ace._tcp service with role=server v=1 ws=/ws", true, failures);
        } else if (!discoveryError && !endpoints.some((endpoint) => endpoint.role === "server")) {
          this.reportFailure("DNS-SD browse found no service with role=server", true, failures);
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
            if (this.selected?.registration === candidate.registration) this.setStatus("disconnected");
          });
          await candidate.registration.synchronize({
            allowRebind,
            expectedIdentity: candidate.identity,
          });
          if (this.stopped) { await candidate.registration.stop(); return false; }
          const previous = this.selected;
          this.selected = {
            address: candidate.address,
            configured: candidate.configured,
            registration: candidate.registration,
          };
          if (firstForeign && firstForeign.registration !== candidate.registration) {
            await firstForeign.registration.stop();
          }
          firstForeign = null;
          this.clearFailure();
          this.setStatus("connected");
          await previous?.registration.stop();
          if (this.browsing) {
            await this.discovery.stop();
            this.browsing = false;
          }
          return true;
        } catch (error) {
          await candidate.registration.stop();
          this.reportFailure(`${candidate.context} ${candidate.address} failed: ${describeError(error)}`, !this.selected, failures);
          return false;
        }
      };

      for (const route of addresses) {
        if (visited.has(route.address)) continue;
        visited.add(route.address);
        let registration: ConfiguredServerRegistration | null = null;
        try {
          registration = new ConfiguredServerRegistration(
            route.address,
            this.options.clientId,
            this.options.core,
            this.options.persist,
            this.options.onError,
            this.options.requestTimeoutMs ?? 2000,
            this.options.directEndpoint ?? null,
          );
          const identity = await registration.readRegistryIdentity();
          if (this.stopped) { await registration.stop(); return; }
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
          this.reportFailure(`${route.context} ${route.address} identity probe failed: ${describeError(error)}`, true, failures);
        }
      }

      if (!matchingRegistrySeen && firstForeign && boundForClient) {
        const waitMs = Math.max(0, Math.min(2_000, this.options.registryRebindWaitMs ?? 250));
        const deadline = Date.now() + waitMs;
        while (!this.stopped && Date.now() < deadline && !matchingRegistrySeen) {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
          try { await this.discovery.refreshNow(); } catch { /* Continue through the bounded rebind wait. */ }
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
            if (checked.has(route.address) || route.address === firstForeign.address) continue;
            checked.add(route.address);
            let registration: ConfiguredServerRegistration | null = null;
            try {
              registration = new ConfiguredServerRegistration(
                route.address,
                this.options.clientId,
                this.options.core,
                this.options.persist,
                this.options.onError,
                this.options.requestTimeoutMs ?? 2000,
                this.options.directEndpoint ?? null,
              );
              const identity = await registration.readRegistryIdentity();
              if (identity.allocatorId === boundForClient.allocatorId && identity.fleetId === boundForClient.fleetId) {
                matchingRegistrySeen = true;
                const returning = { ...route, registration, identity };
                registration = null;
                if (await adopt(returning, false)) return;
                break;
              }
            } catch {
              // A failed probe during the bounded wait does not make a foreign identity eligible.
            } finally {
              await registration?.stop();
            }
          }
        }
      }

      if (!matchingRegistrySeen && firstForeign) {
        if (await adopt(firstForeign, true)) return;
        firstForeign = null;
      }
      await firstForeign?.registration.stop();

      const message = failures.length > 0
        ? `no_surf_ace_server: ${failures.join("; ")}`
        : "no_surf_ace_server: no valid _surf-ace._tcp role=server v=1 ws=/ws advertisement";
      this.lastFailure = message;
      this.setStatus("disconnected");
      if (this.lastReportedFailure !== message) {
        this.lastReportedFailure = message;
        this.options.onError?.(new Error(message));
      }
      throw new Error(message);
    });
    this.pending = run.catch(() => { if (!this.selected) this.setStatus("disconnected"); });
    return run;
  }

  start(): void {
    const tick = async () => {
      try { await this.synchronize(); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.lastReportedFailure !== message) {
          this.lastReportedFailure = message;
          this.options.onError?.(error);
        }
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    await this.selected?.registration.stop();
    this.selected = null;
    await this.discovery.stop();
    this.setStatus("disconnected");
  }
}
