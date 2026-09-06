import {
  createBonjourSurfAceDiscoveryService,
  type SurfAceDiscoveryService,
} from "../../extension/src/surf-ace-discovery.js";
import { ConfiguredServerRegistration } from "./configured-server.js";
import type { SurfaceCore } from "./surface-core.js";

export class ServerConnection {
  private selected: ConfiguredServerRegistration | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private browsing = false;
  private pending: Promise<void> = Promise.resolve();
  private readonly discovery: SurfAceDiscoveryService;

  constructor(private readonly options: {
    configuredAddress?: string;
    clientId: string;
    core: SurfaceCore;
    persist: () => Promise<void>;
    onError?: (error: unknown) => void;
    discovery?: SurfAceDiscoveryService;
    requestTimeoutMs?: number;
  }) {
    this.discovery = options.discovery ?? createBonjourSurfAceDiscoveryService({ timeoutMs: 1500 });
  }

  synchronize(): Promise<void> {
    const run = this.pending.then(async () => {
      if (this.stopped) return;
      if (this.selected) {
        try { await this.selected.synchronize(); return; }
        catch { await this.selected.stop(); this.selected = null; }
      }
      const tryAddress = async (address: string): Promise<boolean> => {
        let candidate: ConfiguredServerRegistration | null = null;
        try {
          candidate = new ConfiguredServerRegistration(
            address, this.options.clientId, this.options.core, this.options.persist,
            this.options.onError, this.options.requestTimeoutMs ?? 2000,
          );
          await candidate.synchronize();
          if (this.stopped) { await candidate.stop(); return false; }
          this.selected = candidate;
          return true;
        } catch {
          await candidate?.stop();
          return false;
        }
      };
      if (this.options.configuredAddress && await tryAddress(this.options.configuredAddress)) {
        if (this.browsing) {
          await this.discovery.stop();
          this.browsing = false;
        }
        return;
      }
      if (this.stopped) return;
      if (!this.browsing) {
        this.browsing = true;
        await this.discovery.start();
      } else {
        await this.discovery.refreshNow();
      }
      for (const endpoint of this.discovery.getSnapshot()) {
        if (endpoint.role !== "server") continue;
        const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
        if (await tryAddress(`ws://${host}:${endpoint.port}${endpoint.wsPath}`)) {
          await this.discovery.stop();
          this.browsing = false;
          return;
        }
      }
      throw new Error("no_surf_ace_server");
    });
    this.pending = run.catch(() => undefined);
    return run;
  }

  start(): void {
    const tick = async () => {
      try { await this.synchronize(); } catch (error) { this.options.onError?.(error); }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    await this.selected?.stop();
    await this.discovery.stop();
  }
}
