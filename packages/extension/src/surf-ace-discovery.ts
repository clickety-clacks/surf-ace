import { Bonjour, type Browser, type Service } from "bonjour-service";
import { spawn } from "node:child_process";
import type { SurfaceViewport } from "../../protocol/src/index.js";

const SURF_ACE_SERVICE_TYPE = "surf-ace";
const DEFAULT_WS_PATH = "/ws";
const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 1_500;

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

function isIpv4Address(address: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address.trim());
}

function isLinkLocalIpv6Address(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  const scoped = normalized.split("%", 1)[0] ?? normalized;
  return scoped.startsWith("fe80:");
}

function rawServiceHost(service: Service): string {
  return service.host.replace(/\.$/, "").trim();
}

function decodeDnsSdEscapes(value: string): string {
  return value
    .replace(/\\([0-7]{3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)))
    .replace(/\\(.)/g, "$1");
}

function parseDnsSdTxtRecord(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  const matcher = /(^|\s)([A-Za-z0-9_-]+)=((?:\\.|[^\s])+)/g;
  for (const match of line.matchAll(matcher)) {
    const key = match[2];
    const rawValue = match[3];
    if (!key || rawValue === undefined) {
      continue;
    }
    result[key] = decodeDnsSdEscapes(rawValue);
  }
  return result;
}

function endpointFromResolvedService(params: {
  host: string;
  instanceName: string;
  now: () => number;
  port: number;
  txt: Record<string, string>;
}): SurfAceDiscoveryEndpoint {
  const host = params.host.replace(/\.$/, "").trim();
  const wsPath = normalizeWsPath(params.txt.ws);
  const endpointId = `${host}:${params.port}${wsPath}`;

  return {
    busy: params.txt.busy === "1",
    capabilitiesBitmask: parseIntSafe(params.txt.cap, 0),
    endpointId,
    fingerprintPrefix: params.txt.pk?.trim().toLowerCase() ?? "",
    host,
    instanceName: params.instanceName,
    lastSeenAt: params.now(),
    name: params.txt.name?.trim() || params.instanceName,
    port: params.port,
    protocolVersion: parseIntSafe(params.txt.v, 1),
    viewport: {
      height: parseIntSafe(params.txt.h, 0),
      scale: parseIntSafe(params.txt.s, 1),
      width: parseIntSafe(params.txt.w, 0),
    },
    wsPath,
  };
}

async function runDnsSd(args: string[], timeoutMs: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("dns-sd", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code, signal) => {
      finish(() => {
        if (code === 0 || signal === "SIGTERM") {
          resolve(stdout);
          return;
        }
        reject(new Error(`dns-sd ${args.join(" ")} failed (${code ?? signal}): ${stderr.trim() || stdout.trim()}`));
      });
    });
  });
}

function parseDnsSdBrowseOutput(output: string): string[] {
  const names = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.includes("_surf-ace._tcp.") || !rawLine.includes("Add")) {
      continue;
    }
    const match = rawLine.match(/_surf-ace\._tcp\.\s+(.*)$/);
    if (!match?.[1]) {
      continue;
    }
    names.add(decodeDnsSdEscapes(match[1].trim()));
  }
  return [...names];
}

function parseDnsSdLookupOutput(
  instanceName: string,
  output: string,
  now: () => number,
): SurfAceDiscoveryEndpoint | null {
  let host: string | null = null;
  let port: number | null = null;
  let txt: Record<string, string> | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.includes("can be reached at ")) {
      const match = line.match(/can be reached at (.+):(\d+)\s+\(interface/i);
      if (match?.[1] && match[2]) {
        host = decodeDnsSdEscapes(match[1]);
        port = Number.parseInt(match[2], 10);
      }
      continue;
    }

    if (line.includes(" ws=") || line.startsWith("ws=") || line.includes(" busy=") || line.includes(" pk=")) {
      txt = parseDnsSdTxtRecord(line);
    }
  }

  if (!host || !port) {
    return null;
  }

  return endpointFromResolvedService({
    host,
    instanceName,
    now,
    port,
    txt: txt ?? {},
  });
}

function resolveServiceHost(service: Service): string | null {
  const resolvedAddresses = (service.addresses ?? []).map((address) => address.trim()).filter(Boolean);
  const ipv4Address = resolvedAddresses.find(isIpv4Address);
  if (ipv4Address) {
    return ipv4Address;
  }

  const host = rawServiceHost(service);
  return host || null;
}

function serviceToEndpoint(
  service: Service,
  now: () => number,
): SurfAceDiscoveryEndpoint | null {
  const txt = (service.txt ?? {}) as Record<string, unknown>;
  const host = resolveServiceHost(service);
  if (!host) {
    return null;
  }
  return endpointFromResolvedService({
    host,
    instanceName: service.name,
    now,
    port: service.port,
    txt: {
      busy: txtStr(txt, "busy") ?? "",
      cap: txtStr(txt, "cap") ?? "",
      h: txtStr(txt, "h") ?? "",
      name: txtStr(txt, "name") ?? "",
      pk: txtStr(txt, "pk") ?? "",
      s: txtStr(txt, "s") ?? "",
      v: txtStr(txt, "v") ?? "",
      w: txtStr(txt, "w") ?? "",
      ws: txtStr(txt, "ws") ?? "",
    },
  });
}

class BonjourSurfAceDiscoveryService implements SurfAceDiscoveryService {
  private readonly intervalMs: number;
  private readonly logger: SurfAceLogger;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly listeners = new Set<(endpoints: SurfAceDiscoveryEndpoint[]) => void>();
  private readonly snapshot = new Map<string, SurfAceDiscoveryEndpoint>();
  private started = false;
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(params?: {
    intervalMs?: number;
    logger?: SurfAceLogger;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.intervalMs = params?.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.logger = params?.logger ?? console;
    this.now = params?.now ?? (() => Date.now());
    this.timeoutMs = params?.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
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
    this.attachBrowserHandlers(this.browser);
    this.browser.start();
    await this.refreshNow();
    this.refreshInterval = setInterval(() => {
      void this.refreshNow().catch((error) => {
        this.logger.warn?.(
          `[surf-ace:discovery] refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this.browser?.stop();
    this.bonjour?.destroy();
    this.browser = null;
    this.bonjour = null;
  }

  async refreshNow(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.browser?.update();
    const refreshedEndpoints = await this.queryCurrentEndpoints();
    if (refreshedEndpoints.length === 0) {
      return;
    }
    this.reconcileSnapshot(refreshedEndpoints);
  }

  private notify(): void {
    const payload = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(payload);
    }
  }

  private attachBrowserHandlers(browser: Browser): void {
    browser.on("up", (service: Service) => {
      this.upsertService(service);
    });

    browser.on("txt-update", (service: Service) => {
      this.upsertService(service);
    });

    browser.on("down", (service: Service) => {
      let changed = false;
      for (const [id, ep] of this.snapshot) {
        if (ep.instanceName === service.name) {
          this.snapshot.delete(id);
          changed = true;
        }
      }
      if (changed) {
        this.notify();
      }
    });
  }

  private upsertService(service: Service): void {
    try {
      const endpoint = serviceToEndpoint(service, this.now);
      if (!endpoint) {
        const addresses = (service.addresses ?? []).map((address) => address.trim()).filter(Boolean);
        const linkLocalAddresses = addresses.filter(isLinkLocalIpv6Address);
        const host = rawServiceHost(service);
        const reason =
          linkLocalAddresses.length > 0
            ? `only link-local IPv6 addresses available (${linkLocalAddresses.join(", ")}); hostname=${host || "none"}`
            : `no usable host in Bonjour records (${addresses.join(", ") || "none"}); hostname=${host || "none"}`;
        this.logger.warn?.(`[surf-ace:discovery] skipping ${service.name}: ${reason}`);
        return;
      }

      let changed = false;
      for (const [id, existing] of this.snapshot) {
        if (existing.instanceName === endpoint.instanceName && id !== endpoint.endpointId) {
          this.snapshot.delete(id);
          changed = true;
        }
      }

      const existing = this.snapshot.get(endpoint.endpointId);
      if (!existing || !sameEndpoint(existing, endpoint)) {
        this.snapshot.set(endpoint.endpointId, endpoint);
        changed = true;
      }

      if (changed) {
        this.notify();
      }
    } catch (err) {
      this.logger.warn?.(
        `[surf-ace:discovery] failed to parse service: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private reconcileSnapshot(endpoints: SurfAceDiscoveryEndpoint[]): void {
    let changed = false;
    const endpointsByInstance = new Map<string, SurfAceDiscoveryEndpoint>();
    for (const endpoint of endpoints) {
      endpointsByInstance.set(endpoint.instanceName, endpoint);
    }

    for (const [id, existing] of this.snapshot) {
      const refreshed = endpointsByInstance.get(existing.instanceName);
      if (refreshed && refreshed.endpointId !== id) {
        this.snapshot.delete(id);
        changed = true;
      }
    }

    for (const endpoint of endpoints) {
      const existing = this.snapshot.get(endpoint.endpointId);
      if (!existing || !sameEndpoint(existing, endpoint)) {
        this.snapshot.set(endpoint.endpointId, endpoint);
        changed = true;
      }
    }

    if (changed) {
      this.notify();
    }
  }

  private async queryCurrentEndpoints(): Promise<SurfAceDiscoveryEndpoint[]> {
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: SURF_ACE_SERVICE_TYPE, protocol: "tcp" });
    const services = new Map<string, Service>();
    const collect = (service: Service) => {
      const key = `${service.name}|${rawServiceHost(service)}|${service.port}`;
      services.set(key, service);
    };

    browser.on("up", collect);
    browser.on("txt-update", collect);
    browser.start();
    browser.update();

    await new Promise((resolve) => {
      setTimeout(resolve, this.timeoutMs);
    });

    browser.stop();
    bonjour.destroy();

    const endpoints = [...services.values()]
      .map((service) => serviceToEndpoint(service, this.now))
      .filter((endpoint): endpoint is SurfAceDiscoveryEndpoint => endpoint !== null);

    if (process.platform !== "darwin") {
      return endpoints;
    }

    // Always supplement with dns-sd on macOS — the JS Bonjour library
    // conflicts with mDNSResponder and can miss services on other
    // interfaces or subnets.
    const dnsSdEndpoints = await this.queryCurrentEndpointsViaDnsSd();
    if (dnsSdEndpoints.length === 0) {
      return endpoints;
    }
    const knownIds = new Set(endpoints.map((ep) => ep.endpointId));
    for (const ep of dnsSdEndpoints) {
      if (!knownIds.has(ep.endpointId)) {
        endpoints.push(ep);
      }
    }
    return endpoints;
  }

  private async queryCurrentEndpointsViaDnsSd(): Promise<SurfAceDiscoveryEndpoint[]> {
    try {
      const browseOutput = await runDnsSd(
        ["-B", `_${SURF_ACE_SERVICE_TYPE}._tcp`, "local."],
        this.timeoutMs,
      );
      const instanceNames = parseDnsSdBrowseOutput(browseOutput);
      if (instanceNames.length === 0) {
        return [];
      }

      const endpoints = await Promise.all(instanceNames.map(async (instanceName) => {
        const lookupOutput = await runDnsSd(
          ["-L", instanceName, `_${SURF_ACE_SERVICE_TYPE}._tcp`, "local."],
          this.timeoutMs,
        );
        return parseDnsSdLookupOutput(instanceName, lookupOutput, this.now);
      }));

      const resolved = endpoints.filter((endpoint): endpoint is SurfAceDiscoveryEndpoint => endpoint !== null);
      if (resolved.length > 0) {
        this.logger.info?.(
          `[surf-ace:discovery] dns-sd resolved ${resolved.length} surf ace endpoint(s)`,
        );
      }
      return resolved;
    } catch (error) {
      this.logger.warn?.(
        `[surf-ace:discovery] dns-sd supplement failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}

function sameEndpoint(
  left: SurfAceDiscoveryEndpoint,
  right: SurfAceDiscoveryEndpoint,
): boolean {
  return (
    left.endpointId === right.endpointId &&
    left.busy === right.busy &&
    left.capabilitiesBitmask === right.capabilitiesBitmask &&
    left.fingerprintPrefix === right.fingerprintPrefix &&
    left.host === right.host &&
    left.instanceName === right.instanceName &&
    left.name === right.name &&
    left.port === right.port &&
    left.protocolVersion === right.protocolVersion &&
    left.viewport.width === right.viewport.width &&
    left.viewport.height === right.viewport.height &&
    left.viewport.scale === right.viewport.scale &&
    left.wsPath === right.wsPath
  );
}

export function createBonjourSurfAceDiscoveryService(params?: {
  intervalMs?: number;
  logger?: SurfAceLogger;
  now?: () => number;
  timeoutMs?: number;
}): SurfAceDiscoveryService {
  return new BonjourSurfAceDiscoveryService(params);
}

export const __test = {
  decodeDnsSdEscapes,
  parseDnsSdBrowseOutput,
  parseDnsSdLookupOutput,
};
