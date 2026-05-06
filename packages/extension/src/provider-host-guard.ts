import { execFileSync } from "node:child_process";
import os from "node:os";

export const NON_TARS_PROVIDER_OVERRIDE_ENV = "SURF_ACE_ALLOW_NON_TARS_PROVIDER";

const TARS_PROVIDER_HOSTS = new Set(["tars", "tars-2", "tars.tail4105e8.ts.net"]);

export type ProviderHostGuardResult = {
  allowed: boolean;
  hostNames: string[];
  reason: "non_tars_host" | "override" | "tars_host";
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
  if (env[NON_TARS_PROVIDER_OVERRIDE_ENV] === "1") {
    return { allowed: true, hostNames: normalizedHostNames, reason: "override" };
  }
  if (normalizedHostNames.some((hostName) => TARS_PROVIDER_HOSTS.has(hostName))) {
    return { allowed: true, hostNames: normalizedHostNames, reason: "tars_host" };
  }
  const detectedHostNames = normalizedHostNames.length > 0 ? normalizedHostNames.join(", ") : "unknown";
  return {
    allowed: false,
    hostNames: normalizedHostNames,
    message:
      `Surf Ace OpenClaw extension/provider state is TARS-only; detected host(s): ${detectedHostNames}. ` +
      `Run the Electron client elsewhere if needed, but install/run this provider only on TARS. ` +
      `Set ${NON_TARS_PROVIDER_OVERRIDE_ENV}=1 only for an explicit approved override.`,
    reason: "non_tars_host",
  };
}

export function assertProviderHostAllowed(logger: ProviderHostGuardLogger = console): void {
  const result = evaluateProviderHostGuard(resolveLocalProviderHostNames());
  if (result.allowed) {
    if (result.reason === "override") {
      logger.warn?.(
        `[surf-ace] ${NON_TARS_PROVIDER_OVERRIDE_ENV}=1 is allowing provider startup on non-TARS host(s): ${
          result.hostNames.join(", ") || "unknown"
        }`,
      );
    }
    return;
  }
  logger.error?.(result.message);
  throw new Error(result.message);
}
