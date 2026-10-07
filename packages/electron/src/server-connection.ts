import {
  createBonjourSurfAceDiscoveryService,
  type SurfAceDiscoveryEndpoint,
  type SurfAceDiscoveryService,
} from "./surf-ace-discovery.js";
import { ConfiguredServerRegistration } from "./configured-server.js";
import type { ProvisionedRegistryBinding } from "./registry-binding.js";
import type { SurfaceCore } from "./surface-core.js";

type SelectedRegistration = {
  address: string;
  configured: boolean;
  registration: ConfiguredServerRegistration;
};

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

function isServerContract(endpoint: SurfAceDiscoveryEndpoint): boolean {
  return endpoint.role === "server" && endpoint.protocolVersion === 1 && endpoint.wsPath === "/ws";
}

function isUnspecifiedAddress(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "0:0:0:0:0:0:0:0";
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
    clientId: string;
    core: SurfaceCore;
    persist: () => Promise<void>;
    onError?: (error: unknown) => void;
    discovery?: SurfAceDiscoveryService;
    requestTimeoutMs?: number;
    provisionedBinding?: ProvisionedRegistryBinding | null;
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

  async claimPaneLabel(surfaceId: string, paneId: number, paneLineageId: string): Promise<number> {
    if (this.status !== "connected" || !this.selected) throw new Error("allocator_unavailable");
    return await this.selected.registration.claimPaneLabel(surfaceId, paneId, paneLineageId);
  }

  synchronize(): Promise<void> {
    const run = this.pending.then(async () => {
      if (this.stopped) return;
      if (!this.selected || this.status !== "connected") this.setStatus("connecting");
      const failures: string[] = [];
      const tryAddress = async (address: string, configured = false, context = "configured registry"): Promise<boolean> => {
        let candidate: ConfiguredServerRegistration | null = null;
        try {
          candidate = new ConfiguredServerRegistration(
            address, this.options.clientId, this.options.core, this.options.persist,
            this.options.onError, this.options.requestTimeoutMs ?? 2000,
            this.options.provisionedBinding,
          );
          candidate.onClose(() => {
            if (this.selected?.registration === candidate) {
              this.setStatus("disconnected");
            }
          });
          await candidate.synchronize();
          if (this.stopped) { await candidate.stop(); return false; }
          const previous = this.selected;
          this.selected = { address, configured, registration: candidate };
          this.clearFailure();
          this.setStatus("connected");
          await previous?.registration.stop();
          return true;
        } catch (error) {
          await candidate?.stop();
          this.reportFailure(`${context} ${address} failed: ${describeError(error)}`, !this.selected, failures);
          return false;
        }
      };

      if (this.selected) {
        const current = this.selected;
        try {
          await current.registration.synchronize();
          if (this.stopped) return;
          this.clearFailure();
          this.setStatus("connected");
        } catch (error) {
          await current.registration.stop();
          this.selected = null;
          this.reportFailure(`registry ${current.address} reconnect failed: ${describeError(error)}`, true, failures);
          this.setStatus("connecting");
        }
        if (this.selected) {
          if (!this.selected.configured && this.options.configuredAddress) {
            await tryAddress(this.options.configuredAddress, true, "configured registry recovery");
          }
          return;
        }
      }

      if (this.options.configuredAddress && await tryAddress(this.options.configuredAddress)) {
        if (this.browsing) {
          await this.discovery.stop();
          this.browsing = false;
        }
        return;
      }
      if (this.stopped) return;

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
      if (discoveryError) {
        this.reportFailure(`DNS-SD discovery failed: ${discoveryError}`, true, failures);
      }
      if (servers.length === 0) {
        if (!discoveryError && endpoints.length === 0) {
          this.reportFailure("DNS-SD browse found no _surf-ace._tcp service with role=server v=1 ws=/ws", true, failures);
        } else if (!discoveryError && !endpoints.some((endpoint) => endpoint.role === "server")) {
          this.reportFailure("DNS-SD browse found no service with role=server", true, failures);
        }
      }

      for (const endpoint of servers) {
        // DNS-SD has already resolved these addresses for this service. Trying them
        // before the SRV hostname avoids a slow dual-stack .local lookup consuming
        // the WebSocket handshake deadline on an IPv4-only listener.
        const addresses = [...new Set((endpoint.transportAddresses ?? []).map((transportAddress) => {
          const unwrappedHost = transportAddress.replace(/^\[(.*)\]$/, "$1");
          const host = unwrappedHost.includes(":") ? `[${unwrappedHost}]` : unwrappedHost;
          return `ws://${host}:${endpoint.port}${endpoint.wsPath}`;
        }))];
        for (const address of new Set([...addresses, endpointAddress(endpoint)])) {
          if (await tryAddress(address, false, `discovered registry ${endpoint.instanceName}`)) {
            await this.discovery.stop();
            this.browsing = false;
            return;
          }
        }
      }

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
