import { Bonjour, type Browser, type Service } from "bonjour-service";
import type { SurfaceViewport } from "../../protocol/src/index.js";

const SURF_ACE_SERVICE_TYPE = "surf-ace";
const DEFAULT_WS_PATH = "/ws";

export type SurfAceLogger = {
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
};

export type SurfAceDiscoveryEndpoint = {
  busy: boolean;
  capabilitiesBitmask: number;
  endpointId: string;
  fingerprintPrefix: string;
  host: string;
  instanceName: string;
  lastSeenAt: number;
  name: string;
  port: number;
  protocolVersion: number;
  viewport: SurfaceViewport;
  wsPath: string;
};

export interface SurfAceDiscoveryService {
  getSnapshot(): SurfAceDiscoveryEndpoint[];
  refreshNow(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (endpoints: SurfAceDiscoveryEndpoint[]) => void): () => void;
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeWsPath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_WS_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function txtStr(txt: Record<string, unknown>, key: string): string | undefined {
  const v = txt[key];
  return typeof v === "string" ? v : undefined;
}

function serviceToEndpoint(service: Service, now: () => number): SurfAceDiscoveryEndpoint {
  const txt = (service.txt ?? {}) as Record<string, unknown>;
  const rawHost = service.host.replace(/\.$/, "");
  // Prefer a resolved IPv4 address from the mDNS A records to avoid secondary hostname
  // resolution that can pick an unexpected interface (IPv6, Tailscale, etc.).
  const ipv4Address = (service.addresses ?? []).find((addr) => !addr.includes(":"));
  const host = ipv4Address ?? rawHost;
  const { port } = service;
  const wsPath = normalizeWsPath(txtStr(txt, "ws"));
  const endpointId = `${host}:${port}${wsPath}`;

  return {
    busy: txtStr(txt, "busy") === "1",
    capabilitiesBitmask: parseIntSafe(txtStr(txt, "cap"), 0),
    endpointId,
    fingerprintPrefix: txtStr(txt, "pk")?.trim().toLowerCase() ?? "",
    host,
    instanceName: service.name,
    lastSeenAt: now(),
    name: txtStr(txt, "name")?.trim() || service.name,
    port,
    protocolVersion: parseIntSafe(txtStr(txt, "v"), 1),
    viewport: {
      height: parseIntSafe(txtStr(txt, "h"), 0),
      scale: parseIntSafe(txtStr(txt, "s"), 1),
      width: parseIntSafe(txtStr(txt, "w"), 0),
    },
    wsPath,
  };
}

class BonjourSurfAceDiscoveryService implements SurfAceDiscoveryService {
  private readonly logger: SurfAceLogger;
  private readonly now: () => number;
  private readonly listeners = new Set<(endpoints: SurfAceDiscoveryEndpoint[]) => void>();
  private readonly snapshot = new Map<string, SurfAceDiscoveryEndpoint>();
  private started = false;
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;

  constructor(params?: {
    intervalMs?: number;
    logger?: SurfAceLogger;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.logger = params?.logger ?? console;
    this.now = params?.now ?? (() => Date.now());
  }

  getSnapshot(): SurfAceDiscoveryEndpoint[] {
    return [...this.snapshot.values()];
  }

  subscribe(listener: (endpoints: SurfAceDiscoveryEndpoint[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    this.bonjour = new Bonjour();
    this.browser = this.bonjour.find({ type: SURF_ACE_SERVICE_TYPE, protocol: "tcp" });

    this.browser.on("up", (service: Service) => {
      try {
        const endpoint = serviceToEndpoint(service, this.now);
        this.snapshot.set(endpoint.endpointId, endpoint);
        this.notify();
      } catch (err) {
        this.logger.warn?.(
          `[surf-ace:discovery] failed to parse service: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    this.browser.on("down", (service: Service) => {
      for (const [id, ep] of this.snapshot) {
        if (ep.instanceName === service.name) {
          this.snapshot.delete(id);
        }
      }
      this.notify();
    });

    this.browser.start();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.browser?.stop();
    this.bonjour?.destroy();
    this.browser = null;
    this.bonjour = null;
  }

  async refreshNow(): Promise<void> {
    this.browser?.update();
  }

  private notify(): void {
    const payload = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(payload);
    }
  }
}

export function createBonjourSurfAceDiscoveryService(params?: {
  intervalMs?: number;
  logger?: SurfAceLogger;
  now?: () => number;
  timeoutMs?: number;
}): SurfAceDiscoveryService {
  return new BonjourSurfAceDiscoveryService(params);
}
