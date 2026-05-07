import os from "node:os";
import { execFileSync } from "node:child_process";

export const NON_TARS_AUTOSTART_OVERRIDE_ENV = "SURF_ACE_ALLOW_NON_TARS_AUTOSTART";

const TARS_AUTOSTART_HOSTS = new Set(["tars", "tars-2", "tars.tail4105e8.ts.net"]);

export function normalizeHostName(hostName) {
  const normalized = String(hostName ?? "").trim().toLowerCase().replace(/\.$/, "");
  return normalized.endsWith(".local") ? normalized.slice(0, -".local".length) : normalized;
}

function uniqueHostNames(hostNames) {
  return Array.from(
    new Set(
      hostNames
        .map(normalizeHostName)
        .filter((hostName) => hostName.length > 0),
    ),
  );
}

function readScutilLocalHostName() {
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

export function resolveLocalHostNames() {
  return uniqueHostNames([os.hostname(), readScutilLocalHostName()]);
}

export function evaluateAutostartHostGuard(hostNames, env = process.env) {
  const normalizedHostNames = uniqueHostNames(hostNames);
  if (env[NON_TARS_AUTOSTART_OVERRIDE_ENV] === "1") {
    return { allowed: true, hostNames: normalizedHostNames, reason: "override" };
  }
  if (normalizedHostNames.some((hostName) => TARS_AUTOSTART_HOSTS.has(hostName))) {
    return { allowed: true, hostNames: normalizedHostNames, reason: "tars_host" };
  }
  const detectedHostNames = normalizedHostNames.length > 0 ? normalizedHostNames.join(", ") : "unknown";
  return {
    allowed: false,
    hostNames: normalizedHostNames,
    message:
      `Surf Ace launchd/auto-start installation is TARS-only; detected host(s): ${detectedHostNames}. ` +
      `Run the Electron client manually on non-TARS hosts for display/testing. ` +
      `Set ${NON_TARS_AUTOSTART_OVERRIDE_ENV}=1 only for an explicit approved override.`,
    reason: "non_tars_host",
  };
}

export function assertAutostartInstallAllowed(logger = console) {
  const result = evaluateAutostartHostGuard(resolveLocalHostNames());
  if (result.allowed) {
    if (result.reason === "override") {
      logger.warn?.(
        `[surf-ace] ${NON_TARS_AUTOSTART_OVERRIDE_ENV}=1 is allowing launchd/auto-start install on non-TARS host(s): ${
          result.hostNames.join(", ") || "unknown"
        }`,
      );
    }
    return;
  }
  logger.error?.(result.message);
  throw new Error(result.message);
}
