import assert from "node:assert/strict";
import test from "node:test";

import {
  SURF_ACE_ELECTRON_BUNDLE_ID,
  SURF_ACE_ELECTRON_PACKAGE_NAME,
  SURF_ACE_ELECTRON_RUNTIME_ID,
  buildCompositorAppBindingRequest,
  evaluateCompositorAppBindingEvidence,
  pendingRuntimeAppBindingDiagnostics,
  runtimeAppBindingDiagnosticsFromCompositorError,
  runtimeAppBindingDiagnosticsFromCompositorResponse,
} from "../src/runtime-identity.js";

test("runtime identity binding request carries explicit Electron contract identity and launch evidence", () => {
  assert.deepEqual(buildCompositorAppBindingRequest({
    env: {
      SURF_ACE_EXPECTED_RUNTIME_ID: "surf-ace.runtime.electron",
      SURF_ACE_LAUNCH_TOKEN: "ltok_123",
      SURF_ACE_WAYLAND_APP_ID: "surf-ace-electron",
    },
    pid: 4101,
    ppid: 4100,
    uiLabel: "tablet-a Surf Ace",
    windowTitle: "tablet-a Surf Ace · a",
  }), {
    evidence: {
      expectedBundleId: SURF_ACE_ELECTRON_BUNDLE_ID,
      expectedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
      expectedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
      launchToken: "ltok_123",
      observedUiLabel: "tablet-a Surf Ace",
      observedWaylandAppId: "surf-ace-electron",
      observedWindowTitle: "tablet-a Surf Ace · a",
      process: {
        pid: 4101,
        ppid: 4100,
      },
      reportedBundleId: SURF_ACE_ELECTRON_BUNDLE_ID,
      reportedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
      reportedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
    },
    type: "main_app.bind",
  });
});

test("Wayland app_id package drift is diagnostic when runtime id, token, and lineage match", () => {
  const diagnostics = evaluateCompositorAppBindingEvidence({
    expectedBundleId: SURF_ACE_ELECTRON_BUNDLE_ID,
    expectedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
    expectedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
    expectedWaylandAppId: SURF_ACE_ELECTRON_PACKAGE_NAME,
    launchTokenStatus: "matched",
    observedWaylandAppId: "surf-ace-electron",
    processLineageStatus: "matched",
    reportedBundleId: SURF_ACE_ELECTRON_BUNDLE_ID,
    reportedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
    reportedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
  });
  assert.equal(diagnostics.bindingAuthority, "trusted");
  assert.deepEqual(diagnostics.bindingDegradedReasons, []);
  assert.equal(diagnostics.bindingBlockReason, undefined);
  assert.deepEqual(diagnostics.diagnosticDrift, ["wayland_app_id_mismatch"]);
});

test("runtime identity binding request accepts compositor-provided launch token env", () => {
  const request = buildCompositorAppBindingRequest({
    env: {
      SURF_ACE_COMPOSITOR_LAUNCH_TOKEN: "ctok_456",
      SURF_ACE_WAYLAND_APP_ID: "surf-ace-main-app",
    },
    pid: 5101,
    ppid: 5100,
    uiLabel: "portrait-display Surf Ace",
    windowTitle: "portrait-display Surf Ace",
  });

  assert.equal(request.evidence.launchToken, "ctok_456");
});

test("missing launch token is degraded and named without trusting diagnostic labels", () => {
  const diagnostics = evaluateCompositorAppBindingEvidence({
    expectedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
    expectedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
    expectedUiLabel: "expected label",
    expectedWaylandAppId: SURF_ACE_ELECTRON_PACKAGE_NAME,
    expectedWindowTitle: "expected title",
    launchTokenStatus: "missing",
    observedUiLabel: "actual label",
    observedWaylandAppId: "surf-ace-electron",
    observedWindowTitle: "actual title",
    processLineageStatus: "matched",
    reportedPackageName: "surf-ace-electron",
    reportedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
  });

  assert.equal(diagnostics.bindingAuthority, "degraded");
  assert.deepEqual(diagnostics.bindingDegradedReasons, ["launch_token_missing"]);
  assert.equal(diagnostics.bindingBlockReason, undefined);
  assert.deepEqual(diagnostics.diagnosticDrift, [
    "package_name_mismatch",
    "wayland_app_id_mismatch",
    "window_title_mismatch",
    "ui_label_mismatch",
  ]);
});

test("mismatched launch token blocks even when package and app_id strings match", () => {
  const diagnostics = evaluateCompositorAppBindingEvidence({
    expectedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
    expectedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
    expectedWaylandAppId: SURF_ACE_ELECTRON_PACKAGE_NAME,
    launchTokenStatus: "mismatched",
    observedWaylandAppId: SURF_ACE_ELECTRON_PACKAGE_NAME,
    processLineageStatus: "matched",
    reportedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
    reportedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
  });

  assert.equal(diagnostics.bindingAuthority, "blocked");
  assert.equal(diagnostics.bindingBlockReason, "launch_token_mismatch");
  assert.deepEqual(diagnostics.diagnosticDrift, []);
});

test("mismatched runtime id blocks as a contract precondition failure", () => {
  const diagnostics = evaluateCompositorAppBindingEvidence({
    expectedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
    launchTokenStatus: "matched",
    processLineageStatus: "matched",
    reportedRuntimeId: "surf-ace.runtime.other",
  });

  assert.equal(diagnostics.bindingAuthority, "blocked");
  assert.equal(diagnostics.bindingBlockReason, "runtime_id_mismatch");
});

test("pending compositor binding is not ready until token and lineage authority are proven", () => {
  const request = buildCompositorAppBindingRequest({
    env: {},
    pid: 4101,
    ppid: 4100,
    uiLabel: "tablet-a Surf Ace",
    windowTitle: "tablet-a Surf Ace",
  });

  const diagnostics = pendingRuntimeAppBindingDiagnostics(request, 123);

  assert.equal(diagnostics.acknowledgement, "pending");
  assert.equal(diagnostics.bindingAuthority, "degraded");
  assert.deepEqual(diagnostics.bindingDegradedReasons, ["launch_token_missing", "process_lineage_missing"]);
  assert.equal(diagnostics.ready, false);
});

test("compositor bind response without lineage proof remains degraded in readiness diagnostics", () => {
  const request = buildCompositorAppBindingRequest({
    env: {
      SURF_ACE_LAUNCH_TOKEN: "ltok_123",
      SURF_ACE_WAYLAND_APP_ID: "surf-ace-electron",
    },
    pid: 4101,
    ppid: 4100,
    uiLabel: "tablet-a Surf Ace",
    windowTitle: "tablet-a Surf Ace",
  });

  const diagnostics = runtimeAppBindingDiagnosticsFromCompositorResponse(request, { ok: true }, 456);

  assert.equal(diagnostics.acknowledgement, "accepted");
  assert.equal(diagnostics.bindingAuthority, "degraded");
  assert.deepEqual(diagnostics.bindingDegradedReasons, ["process_lineage_missing"]);
  assert.equal(diagnostics.launchTokenStatus, "matched");
  assert.equal(diagnostics.processLineageStatus, "missing");
  assert.equal(diagnostics.ready, false);
});

test("explicit trusted compositor bind diagnostics become ready", () => {
  const request = buildCompositorAppBindingRequest({
    env: { SURF_ACE_LAUNCH_TOKEN: "ltok_123" },
    pid: 4101,
    ppid: 4100,
    uiLabel: "tablet-a Surf Ace",
    windowTitle: "tablet-a Surf Ace",
  });

  const diagnostics = runtimeAppBindingDiagnosticsFromCompositorResponse(request, {
    bindingAuthority: "trusted",
    bindingDegradedReasons: [],
    diagnosticDrift: ["wayland_app_id_mismatch"],
    expectedBundleId: SURF_ACE_ELECTRON_BUNDLE_ID,
    expectedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
    expectedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
    launchTokenStatus: "matched",
    observedUiLabel: "tablet-a Surf Ace",
    observedWaylandAppId: "surf-ace-electron",
    observedWindowTitle: "tablet-a Surf Ace",
    ok: true,
    processLineageStatus: "matched",
    ready: true,
    reportedBundleId: SURF_ACE_ELECTRON_BUNDLE_ID,
    reportedPackageName: SURF_ACE_ELECTRON_PACKAGE_NAME,
    reportedRuntimeId: SURF_ACE_ELECTRON_RUNTIME_ID,
  }, 789);

  assert.equal(diagnostics.acknowledgement, "accepted");
  assert.equal(diagnostics.bindingAuthority, "trusted");
  assert.equal(diagnostics.ready, true);
  assert.deepEqual(diagnostics.diagnosticDrift, ["wayland_app_id_mismatch"]);
});


test("unsupported compositor bind request falls back to launch-token readiness", () => {
  const request = buildCompositorAppBindingRequest({
    env: { SURF_ACE_COMPOSITOR_LAUNCH_TOKEN: "ctok_456" },
    pid: 4101,
    ppid: 4100,
    uiLabel: "portrait-display Surf Ace",
    windowTitle: "portrait-display Surf Ace",
  });

  const diagnostics = runtimeAppBindingDiagnosticsFromCompositorResponse(request, {
    error: { message: "failed to parse request: unknown variant `main_app.bind`" },
    ok: false,
  }, 999);

  assert.equal(diagnostics.acknowledgement, "accepted");
  assert.equal(diagnostics.bindingAuthority, "trusted");
  assert.equal(diagnostics.launchTokenStatus, "matched");
  assert.equal(diagnostics.processLineageStatus, "matched");
  assert.equal(diagnostics.ready, true);
});
test("failed compositor bind response is degraded and visible to readiness", () => {
  const request = buildCompositorAppBindingRequest({
    env: { SURF_ACE_LAUNCH_TOKEN: "ltok_123" },
    pid: 4101,
    ppid: 4100,
    uiLabel: "tablet-a Surf Ace",
    windowTitle: "tablet-a Surf Ace",
  });

  const diagnostics = runtimeAppBindingDiagnosticsFromCompositorResponse(request, {
    message: "lineage not found",
    ok: false,
  }, 987);

  assert.equal(diagnostics.acknowledgement, "failed");
  assert.equal(diagnostics.ready, false);
  assert.equal(diagnostics.failureMessage, "lineage not found");
  assert.deepEqual(diagnostics.bindingDegradedReasons, ["process_lineage_missing", "binding_ack_failed"]);
});

test("compositor bind transport error is degraded and visible to readiness", () => {
  const request = buildCompositorAppBindingRequest({
    env: { SURF_ACE_LAUNCH_TOKEN: "ltok_123" },
    pid: 4101,
    ppid: 4100,
    uiLabel: "tablet-a Surf Ace",
    windowTitle: "tablet-a Surf Ace",
  });

  const diagnostics = runtimeAppBindingDiagnosticsFromCompositorError(request, new Error("socket closed"), 654);

  assert.equal(diagnostics.acknowledgement, "failed");
  assert.equal(diagnostics.ready, false);
  assert.equal(diagnostics.failureMessage, "Error: socket closed");
  assert.deepEqual(diagnostics.bindingDegradedReasons, ["process_lineage_missing", "binding_ack_failed"]);
});
