import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClientDiagnosticFields = Record<string, boolean | number | string | null | undefined>;

const MAX_CLIENT_FLIGHT_RECORDER_LOG_BYTES = 8 * 1024 * 1024;
// Keep headroom after trimming so normal appends do not rewrite the tail on every entry.
const RETAINED_CLIENT_FLIGHT_RECORDER_LOG_BYTES = MAX_CLIENT_FLIGHT_RECORDER_LOG_BYTES / 2;
const TRUNCATED_DIAGNOSTIC_SUFFIX = Buffer.from("...[truncated]\n");

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
    const entry = `${new Date().toISOString()} ${line}\n`;
    appendBoundedDiagnosticEntry(
      CLIENT_FLIGHT_RECORDER_LOG_PATH,
      boundDiagnosticEntry(entry),
    );
  } catch {
    // Diagnostics must never change Surf Ace runtime behavior.
  }
  console[level](line);
}

function boundDiagnosticEntry(entry: string): Buffer {
  const bytes = Buffer.from(entry);
  if (bytes.length <= MAX_CLIENT_FLIGHT_RECORDER_LOG_BYTES) return bytes;

  let prefixEnd = MAX_CLIENT_FLIGHT_RECORDER_LOG_BYTES - TRUNCATED_DIAGNOSTIC_SUFFIX.length;
  while (prefixEnd > 0 && (bytes[prefixEnd] & 0b1100_0000) === 0b1000_0000) {
    prefixEnd -= 1;
  }
  return Buffer.concat([bytes.subarray(0, prefixEnd), TRUNCATED_DIAGNOSTIC_SUFFIX]);
}

function appendBoundedDiagnosticEntry(logPath: string, entry: Buffer): void {
  if (fs.existsSync(logPath)) {
    const fileSize = fs.statSync(logPath).size;
    if (fileSize + entry.length > MAX_CLIENT_FLIGHT_RECORDER_LOG_BYTES) {
      const retainedLimit = Math.min(
        RETAINED_CLIENT_FLIGHT_RECORDER_LOG_BYTES,
        MAX_CLIENT_FLIGHT_RECORDER_LOG_BYTES - entry.length,
      );
      retainRecentClientDiagnosticRecords(logPath, retainedLimit);
    }
  }
  fs.appendFileSync(logPath, entry);
}

function retainRecentClientDiagnosticRecords(logPath: string, retainedLimit: number): void {
  const fileSize = fs.statSync(logPath).size;
  if (fileSize <= retainedLimit) return;
  if (retainedLimit === 0) {
    fs.writeFileSync(logPath, Buffer.alloc(0));
    return;
  }

  const tail = Buffer.alloc(Math.min(retainedLimit, fileSize));
  const readFd = fs.openSync(logPath, "r");
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(
      readFd,
      tail,
      0,
      tail.length,
      fileSize - tail.length,
    );
  } finally {
    fs.closeSync(readFd);
  }

  const recentBytes = tail.subarray(0, bytesRead);
  const firstNewline = recentBytes.indexOf(0x0a);
  // Keep the first line only when the selected byte tail starts at an ISO-8601 record boundary.
  const startsAtRecord = /^\d{4}-\d{2}-\d{2}T/.test(
    recentBytes.subarray(0, 20).toString("ascii"),
  );
  let retainedStart = recentBytes.length;
  if (startsAtRecord) retainedStart = 0;
  else if (firstNewline >= 0) retainedStart = firstNewline + 1;
  fs.writeFileSync(logPath, recentBytes.subarray(retainedStart));
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
