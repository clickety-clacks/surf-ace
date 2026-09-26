#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyTightbeamLinuxStage } from "./build-tightbeam-release.mjs";
import { TIGHTBEAM, TOOLING_TAG } from "./release-config.mjs";
import { parseArgs, removeIfExists, run, verifyManifestFiles } from "./release-lib.mjs";
import { electronHandshake, electronLaunchConfig } from "./smoke-lib.mjs";

function sameJson(left, right) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function requireSemanticBaseline(before, after, field, pathPrefix = field) {
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length < before.length) {
      throw new Error(`candidate_discarded_baseline_${field}:${pathPrefix}`);
    }
    for (let index = 0; index < before.length; index += 1) {
      requireSemanticBaseline(before[index], after[index], field, `${pathPrefix}[${index}]`);
    }
    return;
  }
  if (before && typeof before === "object") {
    if (!after || typeof after !== "object" || Array.isArray(after)) {
      throw new Error(`candidate_discarded_baseline_${field}:${pathPrefix}`);
    }
    for (const [key, value] of Object.entries(before)) {
      if (!Object.hasOwn(after, key)) throw new Error(`candidate_discarded_baseline_${field}:${pathPrefix}.${key}`);
      requireSemanticBaseline(value, after[key], field, `${pathPrefix}.${key}`);
    }
    return;
  }
  if (!sameJson(before, after)) throw new Error(`candidate_discarded_baseline_${field}:${pathPrefix}`);
}

function requireBaselineStateRetained(baseline, candidate) {
  for (const field of ["content", "history", "labels", "outbox", "panes", "tombstones"]) {
    requireSemanticBaseline(baseline[field], candidate[field], field);
  }
}

function packagedReadContentIds(phase) {
  const ids = new Set();
  for (const evidence of phase.readEvidence ?? []) {
    const result = evidence?.output?.result?.payload ?? evidence?.output?.result;
    for (const record of [
      ...(Array.isArray(result?.records) ? result.records : []),
      ...(result?.currentContentRecord ? [result.currentContentRecord] : []),
    ]) {
      const contentId = record?.payload?.contentId ?? record?.contentId;
      if (record?.recordClass === "content" && typeof contentId === "string" && contentId) ids.add(contentId);
    }
    if (result?.cacheStatus !== "current" || result?.consumableLoss !== null) {
      throw new Error("packaged_cli_read_not_current");
    }
  }
  return ids;
}

function currentContentId(record) {
  const value = record?.payload?.contentId ?? record?.contentId;
  return typeof value === "string" && value ? value : null;
}

function packagedCapturedContentIds(phase) {
  return new Set((phase.readEvidence ?? []).flatMap((evidence) => {
    const result = evidence?.captureOutput?.result?.payload ?? evidence?.captureOutput?.result;
    return typeof result?.contentId === "string" && result.contentId ? [result.contentId] : [];
  }));
}

function requireControllerStateScopesRetained(baselinePhase, phase, name) {
  const baselineScopes = baselinePhase.controllerStateAfterAcknowledgement?.scopes;
  const phaseScopes = phase.controllerStateAfterAcknowledgement?.scopes;
  if (!baselineScopes || typeof baselineScopes !== "object" || Array.isArray(baselineScopes)) {
    throw new Error("baseline_controller_state_scopes_invalid");
  }
  if (!phaseScopes || typeof phaseScopes !== "object" || Array.isArray(phaseScopes)) {
    throw new Error(`${name}_controller_state_scopes_invalid`);
  }
  for (const [scopeId, baselineScope] of Object.entries(baselineScopes)) {
    if (!baselineScope || typeof baselineScope !== "object" || Array.isArray(baselineScope) ||
        !Number.isSafeInteger(baselineScope.clientCursor) || baselineScope.clientCursor < 0 ||
        !Number.isSafeInteger(baselineScope.lastRetainedSequence) || baselineScope.lastRetainedSequence < 0 ||
        baselineScope.synchronized !== true) {
      throw new Error(`baseline_controller_state_scope_invalid:${scopeId}`);
    }
    if (!Object.hasOwn(phaseScopes, scopeId)) {
      throw new Error(`${name}_controller_state_scope_missing:${scopeId}`);
    }
    const phaseScope = phaseScopes[scopeId];
    if (!phaseScope || typeof phaseScope !== "object" || Array.isArray(phaseScope)) {
      throw new Error(`${name}_controller_state_scope_invalid:${scopeId}`);
    }
    for (const field of ["clientCursor", "lastRetainedSequence"]) {
      if (!Number.isSafeInteger(phaseScope[field]) || phaseScope[field] < baselineScope[field]) {
        throw new Error(`${name}_controller_state_scope_${field}_regression:${scopeId}`);
      }
    }
    if (phaseScope.synchronized !== true) {
      throw new Error(`${name}_controller_state_scope_not_synchronized:${scopeId}`);
    }
  }
}

function requireSemanticPhase(phase, name, expectedCommit) {
  if (!phase || typeof phase !== "object") throw new Error(`${name}_missing`);
  if (phase.sourceCommit !== expectedCommit) throw new Error(`${name}_source_mismatch`);
  if (typeof phase.databaseIdentity !== "string" || !phase.databaseIdentity) throw new Error(`${name}_database_identity_missing`);
  if (typeof phase.clientIdentity !== "string" || !phase.clientIdentity) throw new Error(`${name}_client_identity_missing`);
  if (typeof phase.registrationIdentity !== "string" || !phase.registrationIdentity) throw new Error(`${name}_registration_identity_missing`);
  if (typeof phase.allocatorIdentity !== "string" || !phase.allocatorIdentity) throw new Error(`${name}_allocator_identity_missing`);
  if (!phase.allocatorBeforeRegistration || !phase.allocatorAfterRegistration) throw new Error(`${name}_allocator_registration_evidence_missing`);
  if (phase.allocatorAfterRegistration.allocatorId !== phase.allocatorIdentity ||
      phase.allocatorAfterRegistration.stateVersion !== phase.allocatorStateVersion ||
      phase.allocatorAfterRegistration.primaryHeadSeq !== phase.allocatorHeadSeq ||
      phase.allocatorAfterRegistration.nextOrdinalFence !== phase.allocatorFence) {
    throw new Error(`${name}_allocator_registration_evidence_mismatch`);
  }
  if (!Number.isSafeInteger(phase.allocatorStateVersion) || phase.allocatorStateVersion < 1) throw new Error(`${name}_allocator_state_version_invalid`);
  if (!Number.isSafeInteger(phase.allocatorHeadSeq) || phase.allocatorHeadSeq < 0) throw new Error(`${name}_allocator_head_sequence_invalid`);
  if (!Number.isSafeInteger(phase.sequence) || phase.sequence < 0) throw new Error(`${name}_sequence_invalid`);
  if (!Number.isSafeInteger(phase.allocatorFence) || phase.allocatorFence < 0) throw new Error(`${name}_allocator_fence_invalid`);
  if (!Number.isSafeInteger(phase.resetCount) || phase.resetCount < 0) throw new Error(`${name}_reset_count_invalid`);
  if (phase.resetEvidence?.databaseIdentity !== phase.databaseIdentity) throw new Error(`${name}_reset_evidence_mismatch`);
  if (!Array.isArray(phase.acknowledgedWriteIds)) throw new Error(`${name}_acknowledged_writes_invalid`);
  if (!Array.isArray(phase.acknowledgementEvidence)) throw new Error(`${name}_acknowledgement_evidence_invalid`);
  if (!Array.isArray(phase.readEvidence) || phase.readEvidence.length === 0) throw new Error(`${name}_read_evidence_missing`);
  if (!Array.isArray(phase.readControllerIdentities) || phase.readControllerIdentities.length === 0 ||
      phase.readControllerIdentities.some((identity) => typeof identity !== "string" || !identity)) {
    throw new Error(`${name}_read_controller_identity_invalid`);
  }
  for (const evidence of phase.readEvidence) {
    if (!phase.readControllerIdentities.includes(evidence?.output?.controllerInstanceId)) {
      throw new Error(`${name}_read_controller_identity_mismatch`);
    }
  }
  if (phase.controllerStateBeforeAcknowledgement?.controllerInstanceId !== phase.clientIdentity ||
      phase.controllerStateAfterAcknowledgement?.controllerInstanceId !== phase.clientIdentity) {
    throw new Error(`${name}_controller_state_identity_mismatch`);
  }
  if (!Array.isArray(phase.controllerStateBeforeAcknowledgement?.acknowledgementOutbox) ||
      !Array.isArray(phase.controllerStateAfterAcknowledgement?.acknowledgementOutbox)) {
    throw new Error(`${name}_controller_state_outbox_invalid`);
  }
  if (!phase.semanticState || typeof phase.semanticState !== "object") throw new Error(`${name}_semantic_state_missing`);
  for (const field of ["content", "history", "labels", "outbox", "panes", "tombstones"]) {
    if (!(field in phase.semanticState)) throw new Error(`${name}_semantic_${field}_missing`);
  }
  const observedContent = new Set([...packagedReadContentIds(phase), ...packagedCapturedContentIds(phase)]);
  for (const contentId of Object.keys(phase.semanticState.content ?? {})) {
    if (!observedContent.has(contentId)) throw new Error(`${name}_packaged_read_content_missing:${contentId}`);
  }
  const evidencedWrites = new Set(phase.acknowledgementEvidence.flatMap((evidence) => evidence?.writeIds ?? []));
  for (const contentId of phase.acknowledgedWriteIds) {
    if (typeof contentId !== "string" || !evidencedWrites.has(contentId)) {
      throw new Error(`${name}_acknowledged_write_not_evidenced:${String(contentId)}`);
    }
  }
  if (phase.loss !== null) throw new Error("consumable_loss");
}

export function validateTightbeamStateSequence({ baselineBefore, candidateAfter, rollbackAfter }) {
  requireSemanticPhase(baselineBefore, "baseline", TIGHTBEAM.baselineCommit);
  requireSemanticPhase(candidateAfter, "candidate", TIGHTBEAM.candidateCommit);
  requireSemanticPhase(rollbackAfter, "rollback", TIGHTBEAM.baselineCommit);
  requireControllerStateScopesRetained(baselineBefore, candidateAfter, "candidate");
  requireControllerStateScopesRetained(baselineBefore, rollbackAfter, "rollback");
  if (candidateAfter.currentContentRecord === null || typeof candidateAfter.currentContentRecord !== "object") {
    throw new Error("candidate_current_content_record_missing");
  }
  if (baselineBefore.databaseIdentity !== candidateAfter.databaseIdentity || candidateAfter.databaseIdentity !== rollbackAfter.databaseIdentity) {
    throw new Error("database_identity_changed");
  }
  if (baselineBefore.clientIdentity !== candidateAfter.clientIdentity || candidateAfter.clientIdentity !== rollbackAfter.clientIdentity) {
    throw new Error("client_identity_changed");
  }
  if (baselineBefore.registrationIdentity !== candidateAfter.registrationIdentity || candidateAfter.registrationIdentity !== rollbackAfter.registrationIdentity) {
    throw new Error("registration_identity_changed");
  }
  if (baselineBefore.allocatorIdentity !== candidateAfter.allocatorIdentity || candidateAfter.allocatorIdentity !== rollbackAfter.allocatorIdentity ||
      baselineBefore.allocatorStateVersion !== candidateAfter.allocatorStateVersion ||
      candidateAfter.allocatorStateVersion !== rollbackAfter.allocatorStateVersion) {
    throw new Error("allocator_reset");
  }
  if (baselineBefore.resetCount !== candidateAfter.resetCount || candidateAfter.resetCount !== rollbackAfter.resetCount) {
    throw new Error("database_reset");
  }
  if (candidateAfter.allocatorBeforeRegistration.assignmentCount < 1 || rollbackAfter.allocatorBeforeRegistration.assignmentCount < 1 ||
      candidateAfter.allocatorBeforeRegistration.nextOrdinalFence < 1 || rollbackAfter.allocatorBeforeRegistration.nextOrdinalFence < 1 ||
      candidateAfter.allocatorBeforeRegistration.assignmentCount !== candidateAfter.allocatorAfterRegistration.assignmentCount ||
      rollbackAfter.allocatorBeforeRegistration.assignmentCount !== rollbackAfter.allocatorAfterRegistration.assignmentCount ||
      candidateAfter.allocatorBeforeRegistration.nextOrdinalFence !== candidateAfter.allocatorAfterRegistration.nextOrdinalFence ||
      rollbackAfter.allocatorBeforeRegistration.nextOrdinalFence !== rollbackAfter.allocatorAfterRegistration.nextOrdinalFence) {
    throw new Error("central_registration_not_retained");
  }
  if (candidateAfter.sequence < baselineBefore.sequence || rollbackAfter.sequence < candidateAfter.sequence) {
    throw new Error("sequence_regression");
  }
  if (candidateAfter.allocatorHeadSeq < baselineBefore.allocatorHeadSeq || rollbackAfter.allocatorHeadSeq < candidateAfter.allocatorHeadSeq) {
    throw new Error("allocator_head_sequence_regression");
  }
  if (candidateAfter.allocatorFence < baselineBefore.allocatorFence || rollbackAfter.allocatorFence < candidateAfter.allocatorFence) {
    throw new Error("allocator_fence_regression");
  }
  if (candidateAfter.acknowledgedWriteIds.length === 0) throw new Error("candidate_acknowledged_write_missing");
  const candidateCurrentContentId = currentContentId(candidateAfter.currentContentRecord);
  const rollbackCurrentContentId = currentContentId(rollbackAfter.currentContentRecord ?? rollbackAfter.currentContentObservation);
  if (!candidateCurrentContentId || candidateCurrentContentId !== rollbackCurrentContentId ||
      !packagedReadContentIds(candidateAfter).has(candidateCurrentContentId) ||
      !(packagedReadContentIds(rollbackAfter).has(candidateCurrentContentId) ||
        packagedCapturedContentIds(rollbackAfter).has(candidateCurrentContentId))) {
    throw new Error("rollback_current_content_mismatch");
  }
  requireBaselineStateRetained(baselineBefore.semanticState, candidateAfter.semanticState);
  requireBaselineStateRetained(baselineBefore.semanticState, rollbackAfter.semanticState);
  requireBaselineStateRetained(candidateAfter.semanticState, rollbackAfter.semanticState);
  const rollbackWrites = new Set(rollbackAfter.acknowledgedWriteIds);
  if (candidateAfter.acknowledgedWriteIds.some((writeId) => typeof writeId !== "string" || !rollbackWrites.has(writeId))) {
    throw new Error("rollback_discarded_candidate_write");
  }
  for (const field of ["content", "history", "labels", "panes"]) {
    if (!sameJson(candidateAfter.semanticState[field], rollbackAfter.semanticState[field])) {
      throw new Error(`rollback_discarded_candidate_state:${field}`);
    }
  }
  return {
    acknowledgedWriteIds: [...candidateAfter.acknowledgedWriteIds],
    baselineCommit: TIGHTBEAM.baselineCommit,
    candidateCommit: TIGHTBEAM.candidateCommit,
    clientIdentity: baselineBefore.clientIdentity,
    databaseIdentity: baselineBefore.databaseIdentity,
    status: "passed",
  };
}

async function installArchive(archive, installRoot) {
  await removeIfExists(installRoot);
  await fs.mkdir(installRoot, { recursive: true });
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-tightbeam-unpack-"));
  try {
    await run("tar", ["-xzf", archive, "-C", staging]);
    const roots = (await fs.readdir(staging, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (roots.length !== 1) throw new Error("tightbeam_archive_root_invalid");
    await fs.cp(path.join(staging, roots[0].name), installRoot, { recursive: true });
  } finally {
    await removeIfExists(staging);
  }
}

async function linuxPackageContract(archive, installRoot) {
  await installArchive(archive, installRoot);
  return verifyTightbeamLinuxStage(installRoot);
}

export async function runLinuxStateDriver(options, execute = run) {
  await execute(process.execPath, [
    path.resolve(options.driver),
    "--baseline-commit", options.baselineCommit,
    "--baseline-root", path.resolve(options.baselineRoot),
    "--candidate-commit", options.candidateCommit,
    "--candidate-root", path.resolve(options.candidateRoot),
    "--output", path.resolve(options.output),
    "--state-root", path.resolve(options.stateRoot),
  ]);
  const stateSequence = JSON.parse(await fs.readFile(options.output, "utf8"));
  return validateTightbeamStateSequence(stateSequence);
}

async function smokeLinux(options) {
  const baseline = process.env.SURF_ACE_TIGHTBEAM_BASELINE_BACKEND;
  if (!baseline) throw new Error("tightbeam_smoke_baseline_backend_required");
  const stateDriver = process.env.SURF_ACE_TIGHTBEAM_STATE_DRIVER;
  if (!stateDriver) throw new Error("tightbeam_smoke_state_driver_required");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-tightbeam-linux-smoke-"));
  try {
    const candidateRoot = path.join(root, "candidate");
    const baselineRoot = path.join(root, "baseline");
    const stateRoot = path.join(root, "state");
    const stateResult = path.join(root, "state-sequence.json");
    const candidateContract = await linuxPackageContract(options.backend, candidateRoot);
    const baselineContract = await linuxPackageContract(baseline, baselineRoot);
    const validation = await runLinuxStateDriver({
      baselineCommit: options.baselineCommit,
      baselineRoot,
      candidateCommit: options.candidateCommit,
      candidateRoot,
      driver: stateDriver,
      output: stateResult,
      stateRoot,
    });
    return {
      baselineCommit: options.baselineCommit,
      candidateCommit: options.candidateCommit,
      component: "linux",
      packages: { baseline: baselineContract, candidate: candidateContract },
      stateSequence: validation,
      status: "passed",
    };
  } finally {
    await removeIfExists(root);
  }
}

export function macosSmokePlan(root, candidate, baseline) {
  const transitionHome = path.join(root, "transition-profile");
  return [
    { archive: candidate, home: path.join(root, "clean-profile"), installRoot: path.join(root, "clean-install"), phase: "clean-install", port: 19101 },
    { archive: baseline, home: transitionHome, installRoot: path.join(root, "transition-baseline"), phase: "baseline", port: 19102 },
    { archive: candidate, home: transitionHome, installRoot: path.join(root, "transition-upgrade"), phase: "upgrade", port: 19103 },
    { archive: baseline, home: transitionHome, installRoot: path.join(root, "transition-rollback"), phase: "rollback", port: 19104 },
  ].map((step) => ({
    ...step,
    identityFile: path.join(electronLaunchConfig(step.home, step.port).userDataDir, "surface-identity.json"),
  }));
}

export async function runMacosSmokePlan(plan, operations = {}) {
  const extract = operations.extract ?? (async (archive, installRoot) => run("unzip", ["-q", archive, "-d", installRoot]));
  const handshake = operations.handshake ?? electronHandshake;
  let canonicalIdentity;
  for (const step of plan) {
    await removeIfExists(step.installRoot);
    await fs.mkdir(step.installRoot, { recursive: true });
    await extract(step.archive, step.installRoot);
    await handshake(path.join(step.installRoot, "Surf Ace.app/Contents/MacOS/Surf Ace"), step.home, step.port);
    const identity = await fs.readFile(step.identityFile);
    if (identity.length === 0) throw new Error(`tightbeam_macos_${step.phase}_identity_empty`);
    if (step.phase === "baseline") canonicalIdentity = identity;
    if (step.phase === "upgrade" && !identity.equals(canonicalIdentity)) throw new Error("tightbeam_macos_upgrade_did_not_reuse_canonical_identity");
    if (step.phase === "rollback" && !identity.equals(canonicalIdentity)) throw new Error("tightbeam_macos_rollback_did_not_reuse_canonical_identity");
  }
}

async function smokeMacos(options) {
  const baseline = process.env.SURF_ACE_TIGHTBEAM_BASELINE_ELECTRON;
  if (!baseline) throw new Error("tightbeam_smoke_baseline_electron_required");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-tightbeam-electron-"));
  try {
    await runMacosSmokePlan(macosSmokePlan(root, options.electron, baseline));
    return { component: "macos", phases: ["clean-install", "upgrade", "rollback"], status: "passed" };
  } finally {
    await removeIfExists(root);
  }
}

export async function smokeTightbeam(options) {
  if (options.baselineCommit !== TIGHTBEAM.baselineCommit || options.candidateCommit !== TIGHTBEAM.candidateCommit) {
    throw new Error("tightbeam_smoke_identity_mismatch");
  }
  const manifest = await verifyManifestFiles(options.manifest, { backend: options.backend, electron: options.electron });
  if (manifest.source?.commit !== options.candidateCommit || manifest.source?.tag !== TIGHTBEAM.sourceTag || manifest.tooling?.tag !== TOOLING_TAG) {
    throw new Error("tightbeam_smoke_manifest_identity_mismatch");
  }
  const component = process.env.SURF_ACE_SMOKE_COMPONENT;
  if (component === "linux") return smokeLinux(options);
  if (component === "macos") return smokeMacos(options);
  throw new Error("SURF_ACE_SMOKE_COMPONENT_must_be_linux_or_macos");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["baseline-commit", "candidate-commit", "manifest", "backend", "electron"]);
  const result = await smokeTightbeam({
    backend: path.resolve(args.backend),
    baselineCommit: args["baseline-commit"],
    candidateCommit: args["candidate-commit"],
    electron: path.resolve(args.electron),
    manifest: path.resolve(args.manifest),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
