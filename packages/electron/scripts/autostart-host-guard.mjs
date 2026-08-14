import os from "node:os";
import { execFileSync } from "node:child_process";

export const AUTOSTART_ALLOWED_HOSTS_ENV = "SURF_ACE_AUTOSTART_ALLOWED_HOSTS";

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

function configuredHostNames(env) {
  const configured = env[AUTOSTART_ALLOWED_HOSTS_ENV];
  if (typeof configured !== "string" || configured.trim().length === 0) {
    return { error: `${AUTOSTART_ALLOWED_HOSTS_ENV} is required`, hostNames: [] };
  }
  const rawHostNames = configured.split(",").map((hostName) => hostName.trim());
  if (rawHostNames.some((hostName) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostName) || hostName.includes(".."))) {
    return { error: `${AUTOSTART_ALLOWED_HOSTS_ENV} must be a comma-separated list of host names`, hostNames: [] };
  }
  const hostNames = uniqueHostNames(rawHostNames);
  return hostNames.length > 0
    ? { error: null, hostNames }
    : { error: `${AUTOSTART_ALLOWED_HOSTS_ENV} must contain at least one host name`, hostNames: [] };
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
  const allowed = configuredHostNames(env);
  if (allowed.error) {
    return {
      allowed: false,
      hostNames: normalizedHostNames,
      message: `Surf Ace launchd/auto-start installation requires explicit host configuration: ${allowed.error}.`,
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
      `Surf Ace launchd/auto-start installation is not allowed on detected host(s): ${detectedHostNames}. ` +
      `Configure ${AUTOSTART_ALLOWED_HOSTS_ENV} with the approved comma-separated host names.`,
    reason: "host_not_allowed",
  };
}

export function assertAutostartInstallAllowed(logger = console) {
  const result = evaluateAutostartHostGuard(resolveLocalHostNames());
  if (result.allowed) {
    return;
  }
  logger.error?.(result.message);
  throw new Error(result.message);
}
