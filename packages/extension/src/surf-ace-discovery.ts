import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SurfaceViewport } from "../../protocol/src/index.js";

const execFileAsync = promisify(execFile);

const SURF_ACE_SERVICE_TYPE = "_surf-ace._tcp";
const DEFAULT_WS_PATH = "/ws";

export type SurfAceLogger = {
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
};

type DiscoveryRecord = {
  host: string;
  instanceName: string;
  port: number;
  txt: Record<string, string>;
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

function decodeDnsSdEscapes(value: string): string {
  let decoded = false;
  const bytes: number[] = [];
  let pending = "";

  const flush = () => {
    if (!pending) {
      return;
    }
    bytes.push(...Buffer.from(pending, "utf8"));
    pending = "";
  };

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index] ?? "";
    if (ch === "\\" && index + 1 < value.length && /\s/.test(value[index + 1] ?? "")) {
      pending += value[index + 1];
      decoded = true;
      index += 1;
      continue;
    }
    if (ch === "\\" && index + 3 < value.length) {
      const escaped = value.slice(index + 1, index + 4);
      if (/^[0-9]{3}$/.test(escaped)) {
        const byte = Number.parseInt(escaped, 10);
        if (Number.isFinite(byte) && byte >= 0 && byte <= 255) {
          flush();
          bytes.push(byte);
          decoded = true;
          index += 3;
          continue;
        }
      }
    }
    pending += ch;
  }

  if (!decoded) {
    return value;
  }
  flush();
  return Buffer.from(bytes).toString("utf8");
}

function splitDnsSdTokens(line: string): string[] {
  const tokens: string[] = [];
  let token = "";

  const pushToken = () => {
    if (!token) {
      return;
    }
    tokens.push(token);
    token = "";
  };

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index] ?? "";
    if (ch === "\\" && index + 1 < line.length && /\s/.test(line[index + 1] ?? "")) {
      token += `\\${line[index + 1] ?? ""}`;
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    token += ch;
  }

  pushToken();
  return tokens;
}

function parseBrowseInstances(stdout: string): string[] {
  const instances = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || !line.includes("Add") || !line.includes(SURF_ACE_SERVICE_TYPE)) {
      continue;
    }
    const match = line.match(/_surf-ace\._tcp\.?\s+(.+)$/i);
    if (match?.[1]) {
      instances.add(decodeDnsSdEscapes(match[1].trim()));
    }
  }
  return [...instances];
}

function parseTxtTokens(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of tokens) {
    const index = token.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = token.slice(0, index).trim();
    const value = decodeDnsSdEscapes(token.slice(index + 1).trim());
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function parseResolve(stdout: string, instanceName: string): DiscoveryRecord | null {
  let host: string | null = null;
  let port: number | null = null;
  let txt: Record<string, string> = {};

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.includes("can be reached at")) {
      const match = line.match(/can be reached at\s+([^\s:]+):(\d+)/i);
      if (match?.[1] && match[2]) {
        host = match[1].replace(/\.$/, "");
        const parsedPort = Number.parseInt(match[2], 10);
        if (Number.isFinite(parsedPort) && parsedPort > 0) {
          port = parsedPort;
        }
      }
      continue;
    }

    if (line.startsWith("txt") || line.includes("=")) {
      const tokens = splitDnsSdTokens(line).filter((entry) => entry.includes("="));
      const parsed = parseTxtTokens(tokens);
      if (Object.keys(parsed).length > 0) {
        txt = { ...txt, ...parsed };
      }
    }
  }

  if (!host || !port) {
    return null;
  }

  return {
    host,
    instanceName,
    port,
    txt,
  };
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

async function runDnsSd(args: string[], timeoutMs: number): Promise<string> {
  const result = await execFileAsync("dns-sd", args, {
    maxBuffer: 2 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return result.stdout;
}

async function discoverSurfAceEndpoints(params: {
  now: () => number;
  timeoutMs: number;
}): Promise<SurfAceDiscoveryEndpoint[]> {
  const browseOutput = await runDnsSd(["-B", SURF_ACE_SERVICE_TYPE, "local."], params.timeoutMs);
  const instances = parseBrowseInstances(browseOutput);
  const endpoints = new Map<string, SurfAceDiscoveryEndpoint>();

  for (const instanceName of instances) {
    const resolveOutput = await runDnsSd(
      ["-L", instanceName, SURF_ACE_SERVICE_TYPE, "local."],
      params.timeoutMs,
    );
    const resolved = parseResolve(resolveOutput, instanceName);
    if (!resolved) {
      continue;
    }

    const wsPath = normalizeWsPath(resolved.txt.ws);
    const endpointId = `${resolved.host}:${resolved.port}${wsPath}`;
    endpoints.set(endpointId, {
      busy: resolved.txt.busy === "1",
      capabilitiesBitmask: parseIntSafe(resolved.txt.cap, 0),
      endpointId,
      fingerprintPrefix: resolved.txt.pk?.trim().toLowerCase() || "",
      host: resolved.host,
      instanceName,
      lastSeenAt: params.now(),
      name: decodeDnsSdEscapes(resolved.txt.name?.trim() || instanceName),
      port: resolved.port,
      protocolVersion: parseIntSafe(resolved.txt.v, 1),
      viewport: {
        height: parseIntSafe(resolved.txt.h, 0),
        scale: parseIntSafe(resolved.txt.s, 1),
        width: parseIntSafe(resolved.txt.w, 0),
      },
      wsPath,
    });
  }

  return [...endpoints.values()];
}

class BonjourSurfAceDiscoveryService implements SurfAceDiscoveryService {
  private readonly intervalMs: number;
  private readonly logger: SurfAceLogger;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly listeners = new Set<(endpoints: SurfAceDiscoveryEndpoint[]) => void>();
  private snapshot: SurfAceDiscoveryEndpoint[] = [];
  private started = false;
  private refreshInFlight = false;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(params?: {
    intervalMs?: number;
    logger?: SurfAceLogger;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.intervalMs = params?.intervalMs ?? 5_000;
    this.logger = params?.logger ?? console;
    this.now = params?.now ?? (() => Date.now());
    this.timeoutMs = params?.timeoutMs ?? 1_500;
  }

  getSnapshot(): SurfAceDiscoveryEndpoint[] {
    return structuredClone(this.snapshot);
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
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refreshNow(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.started || this.refreshInFlight) {
      return;
    }
    this.refreshInFlight = true;
    try {
      this.snapshot = await discoverSurfAceEndpoints({
        now: this.now,
        timeoutMs: this.timeoutMs,
      });
      const payload = this.getSnapshot();
      for (const listener of this.listeners) {
        listener(payload);
      }
    } catch (error) {
      this.logger.warn?.(
        `[surf-ace:discovery] refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.refreshInFlight = false;
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
