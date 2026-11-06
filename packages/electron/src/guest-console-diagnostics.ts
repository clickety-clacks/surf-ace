import type { ClientDiagnosticFields } from "./client-flight-recorder.js";

export const GUEST_CONSOLE_DIAGNOSTIC_INTERVAL_MS = 1_000;

const MAX_DIAGNOSTIC_TEXT_LENGTH = 240;
const MAX_TRACKED_PANES = 256;
const TRACKED_PANE_IDLE_MS = 60_000;
const DATA_URL_IN_TEXT_PATTERN = /(^|[\s"'(=]|\u0060)data:(?!\[omitted \d+ characters\])([^\s"'\)\u0060]*)/gi;

type GuestConsolePayload = Record<string, unknown>;

type SafeUrlSummary = {
  display: string;
  host: string;
  length: number;
  port: string;
  scheme: string;
};

type PaneWindow = {
  lastEmittedAt: number;
  latestFields: ClientDiagnosticFields;
  suppressedCount: number;
};

export function safeDiagnosticUrl(value: string): SafeUrlSummary {
  const omittedSummary = /^data:\[omitted (\d+) characters\]$/i.exec(value);
  if (omittedSummary) {
    return {
      display: value,
      host: "",
      length: Number(omittedSummary[1]),
      port: "",
      scheme: "data",
    };
  }
  const scheme = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1]?.toLowerCase() ?? "invalid";
  if (scheme === "data") {
    return {
      display: `data:[omitted ${value.length} characters]`,
      host: "",
      length: value.length,
      port: "",
      scheme,
    };
  }
  try {
    const parsed = new URL(value);
    return {
      display: value.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH),
      host: parsed.hostname.slice(0, 120),
      length: value.length,
      port: parsed.port,
      scheme: parsed.protocol.replace(/:$/, ""),
    };
  } catch {
    return {
      display: value.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH),
      host: "",
      length: value.length,
      port: "",
      scheme,
    };
  }
}

export function safeGuestConsoleText(value: unknown, maxLength = MAX_DIAGNOSTIC_TEXT_LENGTH): string {
  const text = String(value ?? "");
  let cursor = 0;
  let sanitized = "";
  for (const match of text.matchAll(DATA_URL_IN_TEXT_PATTERN)) {
    const boundary = match[1] ?? "";
    const dataUrlStart = (match.index ?? 0) + boundary.length;
    const dataUrl = "data:" + (match[2] ?? "");
    sanitized += text.slice(cursor, dataUrlStart);
    sanitized += "data:[omitted " + dataUrl.length + " characters]";
    cursor = dataUrlStart + dataUrl.length;
  }
  if (cursor === 0) return text.slice(0, maxLength);
  sanitized += text.slice(cursor);
  return sanitized.slice(0, maxLength);
}

export function guestConsoleDiagnosticFields(
  surfaceId: string | null,
  senderId: number,
  payload: GuestConsolePayload,
): ClientDiagnosticFields {
  const currentUrl = typeof payload.currentUrl === "string" ? payload.currentUrl : "";
  const initialUrl = typeof payload.url === "string" ? payload.url : "";
  const currentSummary = currentUrl ? safeDiagnosticUrl(currentUrl) : null;
  const initialSummary = initialUrl && initialUrl !== currentUrl ? safeDiagnosticUrl(initialUrl) : null;
  const currentUrlLength = finiteNumber(payload.currentUrlLength) ?? currentSummary?.length;
  const initialUrlLength = finiteNumber(payload.urlLength) ?? initialSummary?.length;
  const sourceId = typeof payload.sourceId === "string" ? payload.sourceId : "";
  const sourceIdLength = finiteNumber(payload.sourceIdLength) ?? sourceId.length;
  const sourceSummary = sourceId.toLowerCase().startsWith("data:")
    ? safeDiagnosticUrl(sourceId).display
    : safeGuestConsoleText(sourceId, 160);

  return {
    routed_surface_id: surfaceId ?? "none",
    sender_id: senderId,
    renderer_event: "browser_content_console_message",
    renderer_currentUrl: currentSummary?.display,
    renderer_currentUrlLength: currentUrlLength,
    renderer_currentUrlScheme: currentSummary?.scheme,
    renderer_level: safeGuestConsoleText(payload.level, 32),
    renderer_lineNumber: finiteNumber(payload.lineNumber),
    renderer_message: safeGuestConsoleText(payload.message),
    renderer_paneId: finiteNumber(payload.paneId),
    renderer_sourceId: sourceSummary,
    renderer_sourceIdLength: sourceIdLength,
    renderer_targetId: safeGuestConsoleText(payload.targetId, 120),
    renderer_url: initialSummary?.display,
    renderer_urlHost: initialSummary?.host || currentSummary?.host || boundedString(payload.urlHost, 120),
    renderer_urlLength: initialUrlLength,
    renderer_urlPort: initialSummary?.port || currentSummary?.port || boundedString(payload.urlPort, 32),
    renderer_urlScheme: initialSummary?.scheme ?? currentSummary?.scheme ?? boundedString(payload.urlScheme, 32),
    renderer_webContentsId: finiteNumber(payload.webContentsId),
  };
}

export class GuestConsoleDiagnosticLimiter {
  private readonly panes = new Map<string, PaneWindow>();

  constructor(
    private readonly intervalMs = GUEST_CONSOLE_DIAGNOSTIC_INTERVAL_MS,
    private readonly maxTrackedPanes = MAX_TRACKED_PANES,
    private readonly idleMs = TRACKED_PANE_IDLE_MS,
  ) {}

  record(fields: ClientDiagnosticFields, now = Date.now()): ClientDiagnosticFields | null {
    if (!isGuestConsoleError(fields)) return fields;

    const surfaceId = String(fields.routed_surface_id ?? "none");
    const paneId = fields.renderer_paneId ?? fields.sender_id ?? "unknown";
    const key = `${surfaceId}:${String(paneId)}`;
    this.removeIdlePanes(now);

    let pane = this.panes.get(key);
    if (!pane) {
      if (this.panes.size >= this.maxTrackedPanes) {
        const oldestKey = this.panes.keys().next().value;
        if (oldestKey !== undefined) this.panes.delete(oldestKey);
      }
      this.panes.set(key, { lastEmittedAt: now, latestFields: fields, suppressedCount: 0 });
      return fields;
    }

    this.panes.delete(key);
    this.panes.set(key, pane);
    pane.latestFields = fields;
    if (now - pane.lastEmittedAt < this.intervalMs) {
      pane.suppressedCount += 1;
      return null;
    }

    const summary = {
      ...pane.latestFields,
      ...(pane.suppressedCount > 0 ? { renderer_suppressed_count: pane.suppressedCount } : {}),
    };
    pane.lastEmittedAt = now;
    pane.suppressedCount = 0;
    return summary;
  }

  private removeIdlePanes(now: number): void {
    for (const [key, pane] of this.panes) {
      if (now - pane.lastEmittedAt > this.idleMs) this.panes.delete(key);
    }
  }
}

function isGuestConsoleError(fields: ClientDiagnosticFields): boolean {
  if (fields.renderer_event !== "browser_content_console_message") return false;
  const level = String(fields.renderer_level ?? "").trim().toLowerCase();
  return level === "error" || level === "3";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" ? safeGuestConsoleText(value, maxLength) : undefined;
}
