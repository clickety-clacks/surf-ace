import { execFileSync } from "node:child_process";
import os from "node:os";

export const PROVIDER_ALLOWED_HOSTS_ENV = "SURF_ACE_PROVIDER_ALLOWED_HOSTS";

export type ProviderHostGuardResult = {
  allowed: boolean;
  hostNames: string[];
  reason: "configuration_missing_or_invalid" | "configured_host" | "host_not_allowed";
  message?: string;
};

type ProviderHostGuardLogger = {
  error?: (message?: unknown, ...args: unknown[]) => void;
  warn?: (message?: unknown, ...args: unknown[]) => void;
};

export function normalizeProviderHostName(hostName: string): string {
  const normalized = hostName.trim().toLowerCase().replace(/\.$/, "");
  return normalized.endsWith(".local") ? normalized.slice(0, -".local".length) : normalized;
}

function uniqueProviderHostNames(hostNames: string[]): string[] {
  return Array.from(
    new Set(
      hostNames
        .map(normalizeProviderHostName)
        .filter((hostName) => hostName.length > 0),
    ),
  );
}

function configuredProviderHostNames(
  env: Record<string, string | undefined>,
): { error: string | null; hostNames: string[] } {
  const configured = env[PROVIDER_ALLOWED_HOSTS_ENV];
  if (typeof configured !== "string" || configured.trim().length === 0) {
    return { error: `${PROVIDER_ALLOWED_HOSTS_ENV} is required`, hostNames: [] };
  }
  const rawHostNames = configured.split(",").map((hostName) => hostName.trim());
  if (rawHostNames.some((hostName) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostName) || hostName.includes(".."))) {
    return { error: `${PROVIDER_ALLOWED_HOSTS_ENV} must be a comma-separated list of host names`, hostNames: [] };
  }
  const hostNames = uniqueProviderHostNames(rawHostNames);
  return hostNames.length > 0
    ? { error: null, hostNames }
    : { error: `${PROVIDER_ALLOWED_HOSTS_ENV} must contain at least one host name`, hostNames: [] };
}

function readScutilLocalHostName(): string {
  if (process.platform !== "darwin") {
    return "";
  }
  try {
    return execFileSync("scutil", ["--get", "LocalHostName"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

export function resolveLocalProviderHostNames(): string[] {
  return uniqueProviderHostNames([os.hostname(), readScutilLocalHostName()]);
}

export function evaluateProviderHostGuard(
  hostNames: string[],
  env: Record<string, string | undefined> = process.env,
): ProviderHostGuardResult {
  const normalizedHostNames = uniqueProviderHostNames(hostNames);
  const allowed = configuredProviderHostNames(env);
  if (allowed.error) {
    return {
      allowed: false,
      hostNames: normalizedHostNames,
      message: `Surf Ace OpenClaw extension/provider startup requires explicit host configuration: ${allowed.error}.`,
      reason: "configuration_missing_or_invalid",
    };
  }
  if (normalizedHostNames.some((hostName) => allowed.hostNames.includes(hostName))) {
    return { allowed: true, hostNames: normalizedHostNames, reason: "configured_host" };
  }
  const detectedHostNames = normalizedHostNames.length > 0 ? normalizedHostNames.join(", ") : "unknown";
  return {
    allowed: false,
    hostNames: normalizedHostNames,
    message:
      `Surf Ace OpenClaw extension/provider startup is not allowed on detected host(s): ${detectedHostNames}. ` +
      `Configure ${PROVIDER_ALLOWED_HOSTS_ENV} with the approved comma-separated host names.`,
    reason: "host_not_allowed",
  };
}

export function assertProviderHostAllowed(logger: ProviderHostGuardLogger = console): void {
  const result = evaluateProviderHostGuard(resolveLocalProviderHostNames());
  if (result.allowed) {
    return;
  }
  logger.error?.(result.message);
  throw new Error(result.message);
}
