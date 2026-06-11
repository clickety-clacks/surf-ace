import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClientDiagnosticFields = Record<string, boolean | number | string | null | undefined>;

export const CLIENT_FLIGHT_RECORDER_LOG_PATH = process.env.SURF_ACE_CLIENT_DIAGNOSTIC_LOG
  ?? defaultClientFlightRecorderLogPath();

export function clientFlightRecorderTailCommand(logPath = CLIENT_FLIGHT_RECORDER_LOG_PATH): string {
  return `tail -n 200 ${shellQuote(logPath)}`;
}

export function clientFlightRecorderGrepCommand(logPath = CLIENT_FLIGHT_RECORDER_LOG_PATH): string {
  return `rg 'event=(app_|server_|socket_|pair_|panes_|topology_|surface_|window_)' ${shellQuote(logPath)}`;
}

export function formatClientDiagnosticValue(value: string | number | boolean): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : JSON.stringify(text);
}

export function clientDiagnosticLine(
  scope: string,
  event: string,
  fields: ClientDiagnosticFields = {},
): string {
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatClientDiagnosticValue(value)}`)
    .join(" ");
  const prefix = `[surf-ace:${scope}] event=${event}`;
  return suffix.length > 0 ? `${prefix} ${suffix}` : prefix;
}

export function errorDiagnosticFields(error: unknown): ClientDiagnosticFields {
  if (error instanceof Error) {
    return {
      error_message: error.message,
      error_name: error.name,
    };
  }
  return { error_message: String(error) };
}

export function recordClientDiagnostic(
  level: "info" | "warn" | "error",
  scope: string,
  event: string,
  fields: ClientDiagnosticFields = {},
): void {
  const line = clientDiagnosticLine(scope, event, fields);
  try {
    fs.mkdirSync(path.dirname(CLIENT_FLIGHT_RECORDER_LOG_PATH), { recursive: true });
    fs.appendFileSync(CLIENT_FLIGHT_RECORDER_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Diagnostics must never change Surf Ace runtime behavior.
  }
  console[level](line);
}

function defaultClientFlightRecorderLogPath(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "@surf-ace", "electron", "client-flight-recorder.log");
    case "linux":
      return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "surf-ace", "client-flight-recorder.log");
    default:
      return path.join(os.homedir(), ".surf-ace", "client-flight-recorder.log");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
