import type { RuntimeAppBindingDiagnostics } from "../../protocol/src/index.js";

export const SURF_ACE_ELECTRON_RUNTIME_ID = "surf-ace.runtime.electron";
export const SURF_ACE_ELECTRON_PACKAGE_NAME = "@surf-ace/electron";
export const SURF_ACE_ELECTRON_BUNDLE_ID = "ai.surf-ace.electron";

export const SURF_ACE_EXPECTED_RUNTIME_ID_ENV = "SURF_ACE_EXPECTED_RUNTIME_ID";
export const SURF_ACE_LAUNCH_TOKEN_ENV = "SURF_ACE_LAUNCH_TOKEN";
export const SURF_ACE_WAYLAND_APP_ID_ENV = "SURF_ACE_WAYLAND_APP_ID";

export type CompositorBindingAuthority = "trusted" | "degraded" | "blocked";
export type CompositorBindingEvidenceStatus = "matched" | "missing" | "mismatched";

export type CompositorAppBindingEvidence = {
  diagnosticDrift?: string[];
  differentAuthorizedBindingProven?: boolean;
  expectedBundleId?: string | null;
  expectedPackageName?: string | null;
  expectedRuntimeId: string;
  expectedUiLabel?: string | null;
  expectedWaylandAppId?: string | null;
  expectedWindowTitle?: string | null;
  launchTokenStatus: CompositorBindingEvidenceStatus;
  observedUiLabel?: string | null;
  observedWaylandAppId?: string | null;
  observedWindowTitle?: string | null;
  processLineageStatus: CompositorBindingEvidenceStatus;
  reportedBundleId?: string | null;
  reportedPackageName?: string | null;
  reportedRuntimeId: string;
};

export type CompositorAppBindingDiagnostics = {
  bindingAuthority: CompositorBindingAuthority;
  bindingBlockReason?: string;
  bindingDegradedReasons: string[];
  diagnosticDrift: string[];
  expectedBundleId: string | null;
  expectedPackageName: string | null;
  expectedRuntimeId: string;
  launchTokenStatus: CompositorBindingEvidenceStatus;
  observedUiLabel: string | null;
  observedWaylandAppId: string | null;
  observedWindowTitle: string | null;
  processLineageStatus: CompositorBindingEvidenceStatus;
  reportedBundleId: string | null;
  reportedPackageName: string | null;
  reportedRuntimeId: string;
};

export type CompositorAppBindingRequest = {
  evidence: {
    expectedBundleId: string;
    expectedPackageName: string;
    expectedRuntimeId: string;
    launchToken?: string;
    observedUiLabel: string;
    observedWaylandAppId?: string;
    observedWindowTitle: string;
    process: {
      pid: number;
      ppid: number;
    };
    reportedBundleId: string;
    reportedPackageName: string;
    reportedRuntimeId: string;
  };
  type: "main_app.bind";
};

type CompositorAppBindingResponseLike = {
  bindingAuthority?: unknown;
  bindingBlockReason?: unknown;
  bindingDegradedReasons?: unknown;
  diagnosticDrift?: unknown;
  expectedBundleId?: unknown;
  expectedPackageName?: unknown;
  expectedRuntimeId?: unknown;
  failureMessage?: unknown;
  launchTokenStatus?: unknown;
  message?: unknown;
  observedUiLabel?: unknown;
  observedWaylandAppId?: unknown;
  observedWindowTitle?: unknown;
  ok?: unknown;
  processLineageStatus?: unknown;
  ready?: unknown;
  reportedBundleId?: unknown;
  reportedPackageName?: unknown;
  reportedRuntimeId?: unknown;
  runtimeAppBinding?: unknown;
};

export function buildCompositorAppBindingRequest(params: {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  ppid?: number;
  uiLabel: string;
  windowTitle: string;
}): CompositorAppBindingRequest {
  const env = params.env ?? process.env;
  const launchToken = trimToUndefined(env[SURF_ACE_LAUNCH_TOKEN_ENV]);
  const observedWaylandAppId = trimToUndefined(env[SURF_ACE_WAYLAND_APP_ID_ENV]);
  return {
    evidence: {
      expectedBundleId: SURF_ACE_ELECTRON_BUNDLE_ID,
      expectedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
      expectedRuntimeId: trimToUndefined(env[SURF_ACE_EXPECTED_RUNTIME_ID_ENV]) ?? SURF_ACE_ELECTRON_RUNTIME_ID,
      ...(launchToken ? { launchToken } : {}),
      observedUiLabel: params.uiLabel,
      ...(observedWaylandAppId ? { observedWaylandAppId } : {}),
      observedWindowTitle: params.windowTitle,
      process: {
        pid: params.pid ?? process.pid,
        ppid: params.ppid ?? process.ppid,
      },
      reportedBundleId: SURF_ACE_ELECTRON_BUNDLE_ID,
      reportedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
      reportedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
    },
    type: "main_app.bind",
  };
}

export function evaluateCompositorAppBindingEvidence(
  evidence: CompositorAppBindingEvidence,
): CompositorAppBindingDiagnostics {
  const diagnosticDrift = [...(evidence.diagnosticDrift ?? [])];
  addDiagnosticDrift(diagnosticDrift, "package_name_mismatch", evidence.expectedPackageName, evidence.reportedPackageName);
  addDiagnosticDrift(diagnosticDrift, "bundle_id_mismatch", evidence.expectedBundleId, evidence.reportedBundleId);
  addDiagnosticDrift(diagnosticDrift, "wayland_app_id_mismatch", evidence.expectedWaylandAppId, evidence.observedWaylandAppId);
  addDiagnosticDrift(diagnosticDrift, "window_title_mismatch", evidence.expectedWindowTitle, evidence.observedWindowTitle);
  addDiagnosticDrift(diagnosticDrift, "ui_label_mismatch", evidence.expectedUiLabel, evidence.observedUiLabel);

  let bindingAuthority: CompositorBindingAuthority = "trusted";
  let bindingBlockReason: string | undefined;
  const bindingDegradedReasons: string[] = [];

  if (evidence.expectedRuntimeId !== evidence.reportedRuntimeId) {
    bindingAuthority = "blocked";
    bindingBlockReason = "runtime_id_mismatch";
  } else if (evidence.launchTokenStatus === "mismatched") {
    bindingAuthority = "blocked";
    bindingBlockReason = "launch_token_mismatch";
  } else if (evidence.processLineageStatus === "mismatched") {
    bindingAuthority = "blocked";
    bindingBlockReason = "process_lineage_mismatch";
  } else if (evidence.differentAuthorizedBindingProven) {
    bindingAuthority = "blocked";
    bindingBlockReason = "different_authorized_binding";
  } else {
    if (evidence.launchTokenStatus === "missing") {
      bindingDegradedReasons.push("launch_token_missing");
    }
    if (evidence.processLineageStatus === "missing") {
      bindingDegradedReasons.push("process_lineage_missing");
    }
    if (bindingDegradedReasons.length > 0) {
      bindingAuthority = "degraded";
    }
  }

  return {
    bindingAuthority,
    ...(bindingBlockReason ? { bindingBlockReason } : {}),
    bindingDegradedReasons,
    diagnosticDrift,
    expectedBundleId: evidence.expectedBundleId ?? null,
    expectedPackageName: evidence.expectedPackageName ?? null,
    expectedRuntimeId: evidence.expectedRuntimeId,
    launchTokenStatus: evidence.launchTokenStatus,
    observedUiLabel: evidence.observedUiLabel ?? null,
    observedWaylandAppId: evidence.observedWaylandAppId ?? null,
    observedWindowTitle: evidence.observedWindowTitle ?? null,
    processLineageStatus: evidence.processLineageStatus,
    reportedBundleId: evidence.reportedBundleId ?? null,
    reportedPackageName: evidence.reportedPackageName ?? null,
    reportedRuntimeId: evidence.reportedRuntimeId,
  };
}

export function pendingRuntimeAppBindingDiagnostics(
  request: CompositorAppBindingRequest,
  checkedAt = Date.now(),
): RuntimeAppBindingDiagnostics {
  return runtimeDiagnosticsFromEvaluated(
    "pending",
    evaluateCompositorAppBindingEvidence({
      ...evidenceFromRequest(request, {
        launchTokenStatus: request.evidence.launchToken ? "matched" : "missing",
        processLineageStatus: "missing",
      }),
    }),
    checkedAt,
  );
}

export function runtimeAppBindingDiagnosticsFromCompositorResponse(
  request: CompositorAppBindingRequest,
  response: Record<string, unknown>,
  checkedAt = Date.now(),
): RuntimeAppBindingDiagnostics {
  const explicit = explicitRuntimeDiagnostics(response);
  if (explicit) {
    return {
      ...explicit,
      acknowledgement: response.ok === false ? "failed" : explicit.acknowledgement,
      checkedAt: checkedAt as RuntimeAppBindingDiagnostics["checkedAt"],
      failureMessage: stringOrUndefined(response.message) ?? explicit.failureMessage,
      ready: explicit.bindingAuthority === "trusted" && explicit.launchTokenStatus === "matched" &&
        explicit.processLineageStatus === "matched",
    };
  }

  const evaluated = evaluateCompositorAppBindingEvidence(evidenceFromRequest(request, {
    launchTokenStatus: request.evidence.launchToken ? "matched" : "missing",
    processLineageStatus: "missing",
  }));
  if (response.ok === false && !evaluated.bindingDegradedReasons.includes("binding_ack_failed")) {
    evaluated.bindingDegradedReasons.push("binding_ack_failed");
  }
  return runtimeDiagnosticsFromEvaluated(
    response.ok === false ? "failed" : "accepted",
    evaluated,
    checkedAt,
    stringOrUndefined(response.message),
  );
}

export function runtimeAppBindingDiagnosticsFromCompositorError(
  request: CompositorAppBindingRequest,
  error: unknown,
  checkedAt = Date.now(),
): RuntimeAppBindingDiagnostics {
  const evaluated = evaluateCompositorAppBindingEvidence(evidenceFromRequest(request, {
    launchTokenStatus: request.evidence.launchToken ? "matched" : "missing",
    processLineageStatus: "missing",
  }));
  if (!evaluated.bindingDegradedReasons.includes("binding_ack_failed")) {
    evaluated.bindingDegradedReasons.push("binding_ack_failed");
  }
  return runtimeDiagnosticsFromEvaluated("failed", evaluated, checkedAt, String(error));
}

function addDiagnosticDrift(
  drift: string[],
  reason: string,
  expected: string | null | undefined,
  observed: string | null | undefined,
): void {
  if (!expected || !observed || expected === observed || drift.includes(reason)) {
    return;
  }
  drift.push(reason);
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function evidenceFromRequest(
  request: CompositorAppBindingRequest,
  authority: Pick<CompositorAppBindingEvidence, "launchTokenStatus" | "processLineageStatus">,
): CompositorAppBindingEvidence {
  return {
    expectedBundleId: request.evidence.expectedBundleId,
    expectedPackageName: request.evidence.expectedPackageName,
    expectedRuntimeId: request.evidence.expectedRuntimeId,
    launchTokenStatus: authority.launchTokenStatus,
    observedUiLabel: request.evidence.observedUiLabel,
    observedWaylandAppId: request.evidence.observedWaylandAppId,
    observedWindowTitle: request.evidence.observedWindowTitle,
    processLineageStatus: authority.processLineageStatus,
    reportedBundleId: request.evidence.reportedBundleId,
    reportedPackageName: request.evidence.reportedPackageName,
    reportedRuntimeId: request.evidence.reportedRuntimeId,
  };
}

function runtimeDiagnosticsFromEvaluated(
  acknowledgement: RuntimeAppBindingDiagnostics["acknowledgement"],
  evaluated: CompositorAppBindingDiagnostics,
  checkedAt: number,
  failureMessage?: string,
): RuntimeAppBindingDiagnostics {
  const ready = evaluated.bindingAuthority === "trusted" &&
    evaluated.launchTokenStatus === "matched" &&
    evaluated.processLineageStatus === "matched";
  return {
    acknowledgement,
    bindingAuthority: evaluated.bindingAuthority,
    ...(evaluated.bindingBlockReason ? { bindingBlockReason: evaluated.bindingBlockReason } : {}),
    bindingDegradedReasons: evaluated.bindingDegradedReasons,
    checkedAt: checkedAt as RuntimeAppBindingDiagnostics["checkedAt"],
    diagnosticDrift: evaluated.diagnosticDrift,
    expectedBundleId: evaluated.expectedBundleId,
    expectedPackageName: evaluated.expectedPackageName,
    expectedRuntimeId: evaluated.expectedRuntimeId,
    ...(failureMessage ? { failureMessage } : {}),
    launchTokenStatus: evaluated.launchTokenStatus,
    observedUiLabel: evaluated.observedUiLabel,
    observedWaylandAppId: evaluated.observedWaylandAppId,
    observedWindowTitle: evaluated.observedWindowTitle,
    processLineageStatus: evaluated.processLineageStatus,
    ready,
    reportedBundleId: evaluated.reportedBundleId,
    reportedPackageName: evaluated.reportedPackageName,
    reportedRuntimeId: evaluated.reportedRuntimeId,
  };
}

function explicitRuntimeDiagnostics(response: Record<string, unknown>): RuntimeAppBindingDiagnostics | null {
  const candidate = nestedDiagnostics(response) ?? response;
  const typed = candidate as CompositorAppBindingResponseLike;
  const bindingAuthority = authorityOrNull(typed.bindingAuthority);
  const launchTokenStatus = evidenceStatusOrNull(typed.launchTokenStatus);
  const processLineageStatus = evidenceStatusOrNull(typed.processLineageStatus);
  const expectedRuntimeId = stringOrUndefined(typed.expectedRuntimeId);
  const reportedRuntimeId = stringOrUndefined(typed.reportedRuntimeId);
  if (
    !bindingAuthority ||
    !launchTokenStatus ||
    !processLineageStatus ||
    !expectedRuntimeId ||
    !reportedRuntimeId ||
    !hasOwn(candidate, "expectedBundleId") ||
    !hasOwn(candidate, "expectedPackageName") ||
    !hasOwn(candidate, "observedUiLabel") ||
    !hasOwn(candidate, "observedWaylandAppId") ||
    !hasOwn(candidate, "observedWindowTitle") ||
    !hasOwn(candidate, "reportedBundleId") ||
    !hasOwn(candidate, "reportedPackageName")
  ) {
    return null;
  }
  return {
    acknowledgement: typed.ok === false ? "failed" : "accepted",
    bindingAuthority,
    ...(stringOrUndefined(typed.bindingBlockReason) ? { bindingBlockReason: stringOrUndefined(typed.bindingBlockReason) } : {}),
    bindingDegradedReasons: stringArray(typed.bindingDegradedReasons),
    diagnosticDrift: stringArray(typed.diagnosticDrift),
    expectedBundleId: nullableString(typed.expectedBundleId),
    expectedPackageName: nullableString(typed.expectedPackageName),
    expectedRuntimeId,
    ...(stringOrUndefined(typed.failureMessage) ?? stringOrUndefined(typed.message)
      ? { failureMessage: stringOrUndefined(typed.failureMessage) ?? stringOrUndefined(typed.message) }
      : {}),
    launchTokenStatus,
    observedUiLabel: nullableString(typed.observedUiLabel),
    observedWaylandAppId: nullableString(typed.observedWaylandAppId),
    observedWindowTitle: nullableString(typed.observedWindowTitle),
    processLineageStatus,
    ready: typed.ready === true && bindingAuthority === "trusted" &&
      launchTokenStatus === "matched" && processLineageStatus === "matched",
    reportedBundleId: nullableString(typed.reportedBundleId),
    reportedPackageName: nullableString(typed.reportedPackageName),
    reportedRuntimeId,
  };
}

function nestedDiagnostics(response: Record<string, unknown>): Record<string, unknown> | null {
  const nested = (response as CompositorAppBindingResponseLike).runtimeAppBinding;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null;
}

function authorityOrNull(value: unknown): RuntimeAppBindingDiagnostics["bindingAuthority"] | null {
  return value === "trusted" || value === "degraded" || value === "blocked" ? value : null;
}

function evidenceStatusOrNull(value: unknown): RuntimeAppBindingDiagnostics["launchTokenStatus"] | null {
  return value === "matched" || value === "missing" || value === "mismatched" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return stringOrUndefined(value) ?? null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
