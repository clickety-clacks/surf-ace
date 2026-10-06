#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertTightbeamLinuxQualificationClaims, verifyTightbeamCliStage, verifyTightbeamLinuxStage } from "./build-tightbeam-release.mjs";
import { TIGHTBEAM, TIGHTBEAM_TOOLING_TAG, TOOLCHAINS } from "./tightbeam-release-config.mjs";
import { assertDisjointTrees, assertTrackedInputsUnchanged, capture, parseArgs, removeIfExists, run, sha256, verifyManifestFiles } from "./release-lib.mjs";
import { electronLaunchConfig, launchElectron, stop as stopElectron, verifyClientAppVersion } from "./smoke-lib.mjs";
import pngPixelEvidence from "./png-pixel-evidence.cjs";

const toolingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expectedScreenshotColors = ["246bce", "d93636"];
const { inspectScreenshotPixels } = pngPixelEvidence;

const participantAssets = Object.freeze({
  linux: [
    ["server", TIGHTBEAM.assets[0]],
    ["cli", TIGHTBEAM.assets[1]],
    ["client", TIGHTBEAM.assets[2]],
  ],
  macos: [
    ["cli", TIGHTBEAM.assets[3]],
    ["client", TIGHTBEAM.assets[4]],
  ],
});

export function buildTightbeamSmokeParticipantIdentities({
  assetDetails,
  component,
  identityBasis,
  sourceCommit,
  toolingCommit,
  version,
}) {
  const expected = participantAssets[component];
  if (!expected || version !== TIGHTBEAM.version || sourceCommit !== TIGHTBEAM.candidateCommit ||
      !/^[a-f0-9]{40}$/.test(toolingCommit ?? "") ||
      !["manifest-and-SHA256SUMS", "source-tooling-HEAD-and-package-SHA256"].includes(identityBasis) ||
      !Array.isArray(assetDetails)) {
    throw new Error("tightbeam_smoke_participant_identity_binding_invalid");
  }
  const byName = new Map(assetDetails.map((detail) => [detail.name, detail]));
  return expected.map(([participant, assetName]) => {
    const detail = byName.get(assetName);
    if (!detail || detail.name !== assetName ||
        !assetName.includes(`-v${TIGHTBEAM.version}.`) ||
        !/^[a-f0-9]{64}$/.test(detail.sha256 ?? "") ||
        !Number.isSafeInteger(detail.sizeBytes) || detail.sizeBytes < 1) {
      throw new Error(`tightbeam_smoke_participant_identity_invalid:${participant}`);
    }
    return {
      assetName,
      assetSha256: detail.sha256,
      assetSizeBytes: detail.sizeBytes,
      identityBasis,
      participant,
      productCommit: sourceCommit,
      toolingCommit,
      version,
    };
  });
}

export function assertTightbeamSmokeParticipantIdentities(identities, component) {
  const expected = participantAssets[component];
  if (!expected || !Array.isArray(identities) || identities.length !== expected.length) {
    throw new Error("tightbeam_smoke_participant_identity_set_invalid");
  }
  const byParticipant = new Map(identities.map((identity) => [identity?.participant, identity]));
  if (byParticipant.size !== expected.length) throw new Error("tightbeam_smoke_participant_identity_duplicate");
  return expected.map(([participant, assetName]) => {
    const identity = byParticipant.get(participant);
    if (!identity || identity.assetName !== assetName || identity.version !== TIGHTBEAM.version ||
        identity.productCommit !== TIGHTBEAM.candidateCommit ||
        !/^[a-f0-9]{40}$/.test(identity.toolingCommit ?? "") ||
        !/^[a-f0-9]{64}$/.test(identity.assetSha256 ?? "") ||
        !Number.isSafeInteger(identity.assetSizeBytes) || identity.assetSizeBytes < 1 ||
        !["manifest-and-SHA256SUMS", "source-tooling-HEAD-and-package-SHA256"].includes(identity.identityBasis)) {
      throw new Error(`tightbeam_smoke_participant_identity_mismatch:${participant}`);
    }
    return identity;
  });
}

export async function assertTightbeamSmokeParticipantAssetBytes(identities, component, assetPaths) {
  const participants = assertTightbeamSmokeParticipantIdentities(identities, component);
  for (const identity of participants) {
    const assetPath = assetPaths?.[identity.participant];
    if (typeof assetPath !== "string" || !path.isAbsolute(assetPath)) {
      throw new Error(`tightbeam_smoke_participant_asset_path_missing:${identity.participant}`);
    }
    const metadata = await fs.stat(assetPath);
    if (!metadata.isFile() || metadata.size !== identity.assetSizeBytes ||
        await sha256(assetPath) !== identity.assetSha256) {
      throw new Error(`tightbeam_smoke_participant_asset_digest_mismatch:${identity.participant}`);
    }
  }
  return participants;
}

export function assertTightbeamElectronPackageIdentity(packageIdentity) {
  if (!packageIdentity || packageIdentity.packageName !== "@surf-ace/electron" ||
      packageIdentity.version !== TIGHTBEAM.version) {
    throw new Error("tightbeam_smoke_electron_package_identity_mismatch");
  }
  return { packageName: packageIdentity.packageName, version: packageIdentity.version };
}

async function readTightbeamElectronPackageIdentity(asarPath, sourceDir) {
  const productRequire = createRequire(path.join(path.resolve(sourceDir), "packages/electron/package.json"));
  const electronBuilderRequire = createRequire(productRequire.resolve("electron-builder"));
  const asar = electronBuilderRequire("@electron/asar");
  const packageBytes = asar.extractFile(path.resolve(asarPath), "package.json");
  const packageMetadata = JSON.parse(packageBytes.toString("utf8"));
  return assertTightbeamElectronPackageIdentity({
    packageName: packageMetadata.name,
    version: packageMetadata.version,
  });
}

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

function matchesFreshInstallCurrentContent(record, { contentId, surfaceId, paneId }) {
  const payload = record?.payload;
  return record?.recordClass === "content" && payload && typeof payload === "object" && !Array.isArray(payload) &&
    payload.contentId === contentId && payload.surfaceId === surfaceId &&
    Number.isSafeInteger(payload.paneId) && payload.paneId === paneId &&
    typeof payload.historyEntryId === "string" && payload.historyEntryId.length > 0 &&
    Number.isSafeInteger(payload.revision) && payload.revision > 0;
}

function decodeRawCliEvidence(base64, expectedBytes, expectedSha256, name) {
  if (typeof base64 !== "string" || !base64 || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) {
    throw new Error(`${name}_raw_cli_evidence_missing`);
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64 || bytes.byteLength !== expectedBytes ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error(`${name}_raw_cli_evidence_digest_mismatch`);
  }
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error(`${name}_raw_cli_evidence_truncated`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => !line)) throw new Error(`${name}_raw_cli_evidence_empty_line`);
  const events = lines.map((line) => {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`${name}_raw_cli_event_invalid_json`); }
    if (!Array.isArray(event?.args) || typeof event.command !== "string" ||
        !["list", "capture-pane", "read", "push", "topology-intent"].includes(event.command) ||
        !event.input || typeof event.input !== "object" || Array.isArray(event.input) ||
        event.inputJson !== JSON.stringify(event.input) ||
        typeof event.stdout !== "string" || typeof event.stderr !== "string") {
      throw new Error(`${name}_raw_cli_event_invalid_envelope`);
    }
    if (event.status === 0) {
      let stdout;
      try { stdout = JSON.parse(event.stdout); } catch { throw new Error(`${name}_raw_cli_stdout_invalid_json`); }
      if (event.output?.ok !== true || !sameJson(stdout, event.output)) {
        throw new Error(`${name}_raw_cli_stdout_result_mismatch`);
      }
    } else if (!Number.isSafeInteger(event.status) || event.status < 1 || event.command !== "push" ||
        event.expectedRejection?.code !== "unknown_surface" ||
        event.expectedRejection?.requestedSurfaceId !== event.input.surfaceId ||
        event.expectedRejection?.requestedSurfaceId === event.expectedRejection?.expectedSurfaceId ||
        !`${event.stdout}\n${event.stderr}`.includes(`unknown_surface:${event.input.surfaceId}`)) {
      throw new Error(`${name}_raw_cli_unexpected_nonzero_result`);
    } else if (event.output !== undefined) {
      let stdout;
      try { stdout = JSON.parse(event.stdout); } catch { throw new Error(`${name}_raw_cli_rejected_stdout_invalid_json`); }
      if (!sameJson(stdout, event.output)) throw new Error(`${name}_raw_cli_rejected_stdout_result_mismatch`);
    }
    const stateRootIndex = event.args.indexOf("--state-root");
    if (stateRootIndex < 0 || typeof event.args[stateRootIndex + 1] !== "string" || !event.args[stateRootIndex + 1]) {
      throw new Error(`${name}_raw_cli_state_root_missing`);
    }
    const commandIndex = event.args.indexOf(event.command);
    const inputIndex = event.args.indexOf("--input-json");
    if (commandIndex < 0 || inputIndex !== commandIndex + 1 || event.args[inputIndex + 1] !== event.inputJson) {
      throw new Error(`${name}_raw_cli_argv_request_mismatch`);
    }
    if (event.endpoint !== null) {
      const endpointIndex = event.args.indexOf("--endpoint");
      const labelIndex = event.args.indexOf("--product-label");
      if (typeof event.endpoint !== "string" || !event.endpoint.endsWith("/ws") ||
          event.route !== "direct-client-websocket" || event.args[endpointIndex + 1] !== event.endpoint ||
          event.args[labelIndex + 1] !== "Surf Ace release smoke") {
        throw new Error(`${name}_raw_cli_not_direct_client_route`);
      }
    } else if (event.command !== "read" || event.route !== "endpointless-local-read" ||
        event.args.includes("--endpoint") || event.args.includes("--product-label")) {
      throw new Error(`${name}_raw_cli_endpointless_nonread`);
    }
    return event;
  });
  return { base64, byteLength: bytes.byteLength, events, sha256: expectedSha256 };
}

export function assertLinuxFreshInstallCliStateRoots(events, bindings) {
  const invalid = () => { throw new Error("linux_fresh_install_cli_state_root_not_bound"); };
  const firstEndpoint = bindings?.firstEndpoint;
  const secondEndpoint = bindings?.secondEndpoint;
  const firstStateRoot = bindings?.firstStateRoot;
  const secondStateRoot = bindings?.secondStateRoot;
  if (!Array.isArray(events) || typeof firstEndpoint !== "string" || !firstEndpoint.endsWith("/ws") ||
      typeof secondEndpoint !== "string" || !secondEndpoint.endsWith("/ws") || firstEndpoint === secondEndpoint ||
      typeof firstStateRoot !== "string" || !path.isAbsolute(firstStateRoot) ||
      typeof secondStateRoot !== "string" || !path.isAbsolute(secondStateRoot) ||
      path.resolve(firstStateRoot) === path.resolve(secondStateRoot)) invalid();

  const expectedRoots = new Map([
    [firstEndpoint, path.resolve(firstStateRoot)],
    [secondEndpoint, path.resolve(secondStateRoot)],
  ]);
  const observedEndpoints = new Set();
  const observedRoots = new Set();
  for (const event of events) {
    const stateRootIndex = event?.args?.indexOf("--state-root") ?? -1;
    const stateRoot = event?.args?.[stateRootIndex + 1];
    if (stateRootIndex < 0 || typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) invalid();
    const endpoint = event.endpoint;
    const expectedRoot = endpoint === null ? expectedRoots.get(firstEndpoint) : expectedRoots.get(endpoint);
    if (!expectedRoot || path.resolve(stateRoot) !== expectedRoot) invalid();
    observedRoots.add(path.resolve(stateRoot));
    if (endpoint !== null) observedEndpoints.add(endpoint);
  }
  if (observedRoots.size !== 2 || observedEndpoints.size !== 2 ||
      !observedEndpoints.has(firstEndpoint) || !observedEndpoints.has(secondEndpoint)) invalid();
  return { clientCount: 2, stateRoots: [...observedRoots].sort() };
}

async function readRawCliEvidence(evidencePath, name, required = true) {
  let bytes;
  try { bytes = await fs.readFile(evidencePath); } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    throw error;
  }
  return decodeRawCliEvidence(
    bytes.toString("base64"),
    bytes.byteLength,
    createHash("sha256").update(bytes).digest("hex"),
    name,
  );
}

function requireElectronRawCliCoverage(channel, endpoint, stateRoot, expected, rawCliEvidence) {
  if (!rawCliEvidence) throw new Error(`${channel}_candidate_raw_cli_evidence_missing`);
  const expectedStateRoot = path.resolve(stateRoot);
  if (rawCliEvidence.events.some((event) =>
    path.resolve(event.args[event.args.indexOf("--state-root") + 1]) !== expectedStateRoot)) {
    throw new Error(`${channel}_candidate_cli_state_root_changed`);
  }
  if (rawCliEvidence.events.some((event) => event.endpoint !== null && event.endpoint !== endpoint)) {
    throw new Error(`${channel}_candidate_cli_not_direct_to_client`);
  }
  const events = rawCliEvidence.events;
  const direct = events.filter((event) => event.endpoint === endpoint);
  if (!direct.some((event) => event.command === "list" && event.status === 0)) {
    throw new Error(`${channel}_candidate_direct_list_missing`);
  }
  if (!direct.some((event) => event.command === "push" && event.status === 0 &&
      event.input.surfaceId === expected.surfaceId && event.input.paneId === expected.paneId &&
      event.input.contentId === expected.contentId)) {
    throw new Error(`${channel}_candidate_direct_push_missing`);
  }
  if (!direct.some((event) => event.command === "capture-pane" && event.status === 0 &&
      event.input.surfaceId === expected.surfaceId && event.input.paneId === expected.paneId)) {
    throw new Error(`${channel}_candidate_direct_capture_missing`);
  }
  if (!events.some((event) => event.command === "read" && event.endpoint === null && event.status === 0 &&
      event.input.scopeId === `pane:${encodeURIComponent(expected.surfaceId)}:${expected.paneId}`)) {
    throw new Error(`${channel}_candidate_endpointless_current_read_missing`);
  }
  if (!direct.some((event) => event.command === "push" && event.status !== 0 &&
      event.expectedRejection?.code === "unknown_surface" &&
      event.expectedRejection.requestedSurfaceId === expected.wrongSurfaceId &&
      event.expectedRejection.expectedSurfaceId === expected.surfaceId)) {
    throw new Error(`${channel}_candidate_wrong_surface_rejection_missing`);
  }
}

function requireLinuxFreshInstallRawCliCoverage(stateSequence, rawCliEvidence) {
  if (!rawCliEvidence) throw new Error("linux_fresh_install_raw_cli_evidence_missing");
  const fleet = stateSequence.fleetPaneUniqueness;
  const endpoints = new Set([
    stateSequence.initial?.directClientEndpoint,
    stateSequence.afterRestart?.directClientEndpoint,
    fleet?.secondDirectClientEndpoint,
  ]);
  const registryEndpoints = new Set([
    stateSequence.initial?.registryEndpoint,
    stateSequence.afterRestart?.registryEndpoint,
  ]);
  if (endpoints.size !== 2 || endpoints.has(undefined) || registryEndpoints.has(undefined) ||
      [...registryEndpoints].some((endpoint) => endpoints.has(endpoint))) {
    throw new Error("linux_fresh_install_endpoint_bindings_invalid");
  }
  if (rawCliEvidence.events.some((event) => !["list", "push", "capture-pane", "read"].includes(event.command))) {
    throw new Error("linux_fresh_install_unapproved_cli_operation");
  }
  const direct = rawCliEvidence.events.filter((event) => event.endpoint !== null);
  for (const event of direct) {
    if (!endpoints.has(event.endpoint) || registryEndpoints.has(event.endpoint)) {
      throw new Error("linux_fresh_install_cli_endpoint_not_bound_client");
    }
  }
  const secondListEvent = rawCliEvidence.events.find((event) => {
    if (event.command !== "list" || event.status !== 0 || event.endpoint !== fleet.secondDirectClientEndpoint) return false;
    const result = event.output?.result?.payload ?? event.output?.result;
    return result?.surfaces?.some((surface) => surface.surfaceId === fleet.secondSurfaceId) === true;
  });
  if (!secondListEvent) throw new Error("linux_fresh_install_second_direct_list_missing");
  const initial = stateSequence.initial;
  const afterRestart = stateSequence.afterRestart;
  const expectedScope = `pane:${encodeURIComponent(initial.surfaceId)}:${initial.paneId}`;
  const events = rawCliEvidence.events;
  const eventIndex = (predicate, start = 0) => events.findIndex((event, index) => index >= start && predicate(event));
  const phaseList = (phase) => (event) => event.command === "list" && event.status === 0 &&
    event.output?.ok === true && event.output?.command === "list" && event.endpoint === phase.directClientEndpoint &&
    (event.output?.result?.payload ?? event.output?.result)?.surfaces?.some((surface) => surface.surfaceId === phase.surfaceId);
  const initialListIndex = eventIndex(phaseList(initial));
  if (initialListIndex < 0) throw new Error("linux_fresh_install_initial_direct_list_missing");
  const pushIndex = eventIndex((event) => event.command === "push" && event.endpoint === initial.directClientEndpoint &&
    event.status === 0 && event.output?.ok === true && event.output?.command === "push" &&
    event.input.surfaceId === initial.surfaceId && event.input.paneId === initial.paneId &&
    event.input.contentId === stateSequence.expectedContentId &&
    expectedScreenshotColors.every((color) => JSON.stringify(event.input.content ?? {}).includes(`#${color}`)), initialListIndex + 1);
  if (pushIndex < 0) throw new Error("linux_fresh_install_direct_push_target_mismatch");
  const rejectedPushIndex = eventIndex((event) => event.command === "push" && event.status !== 0 &&
    event.endpoint === initial.directClientEndpoint &&
    event.input.surfaceId === stateSequence.wrongSurfaceRejection?.requestedSurfaceId &&
    event.input.paneId === initial.paneId &&
    event.expectedRejection?.code === "unknown_surface" &&
    event.expectedRejection?.expectedSurfaceId === initial.surfaceId, pushIndex + 1);
  if (rejectedPushIndex < 0) throw new Error("linux_fresh_install_wrong_surface_raw_event_missing");
  // The first post-rejection list is the resumed client's baseline.
  const resumedListIndex = eventIndex(phaseList(afterRestart), rejectedPushIndex + 1);
  if (resumedListIndex < 0) throw new Error("linux_fresh_install_post_restart_direct_list_missing");
  const currentReads = events.filter((event) => event.command === "read" && event.status === 0 &&
    event.output?.ok === true && event.output?.command === "read" && event.endpoint === null &&
    event.input.scopeId === expectedScope &&
    (() => {
      const result = event.output?.result?.payload ?? event.output?.result;
      return result?.scopeId === expectedScope && result?.cacheStatus === "current" &&
        result?.consumableLoss === null &&
        matchesFreshInstallCurrentContent(result?.currentContentRecord, {
          contentId: stateSequence.expectedContentId,
          surfaceId: initial.surfaceId,
          paneId: initial.paneId,
        });
    })());
  if (currentReads.length < 3 || currentReads[0].args.length === 0 ||
      events.findIndex((event) => event === currentReads[0]) <= pushIndex ||
      events.findIndex((event) => event === currentReads.at(-1)) <= resumedListIndex) {
    throw new Error("linux_fresh_install_current_content_read_evidence_missing");
  }
  const captureMatches = (phase) => (event) => {
    const capture = event.output?.result?.payload ?? event.output?.result;
    if (!(event.command === "capture-pane" && event.endpoint === phase.directClientEndpoint && event.status === 0 &&
      event.output?.ok === true && event.output?.command === "capture-pane" &&
      event.input.surfaceId === phase.surfaceId && event.input.paneId === phase.paneId &&
      (capture?.surfaceId == null || capture.surfaceId === phase.surfaceId) && capture?.paneId === phase.paneId &&
      capture?.contentId === stateSequence.expectedContentId)) return false;
    try {
      inspectScreenshotPixels(capture?.image, expectedScreenshotColors);
      return true;
    } catch {
      return false;
    }
  };
  const initialCaptureIndex = eventIndex(captureMatches(initial), pushIndex + 1);
  const postDenialCaptureIndex = eventIndex(captureMatches(initial), rejectedPushIndex + 1);
  const resumedCaptureIndex = eventIndex(captureMatches(afterRestart), resumedListIndex + 1);
  if (initialCaptureIndex < 0 || initialCaptureIndex >= rejectedPushIndex ||
      postDenialCaptureIndex < 0 || postDenialCaptureIndex >= resumedListIndex ||
      resumedCaptureIndex < 0) {
    throw new Error("linux_fresh_install_direct_capture_target_mismatch");
  }
  const readIndices = currentReads.map((event) => events.findIndex((candidate) => candidate === event));
  if (!(readIndices.some((index) => index > pushIndex && index < rejectedPushIndex) &&
        readIndices.some((index) => index > rejectedPushIndex && index < resumedListIndex) &&
        readIndices.some((index) => index > resumedListIndex))) {
    throw new Error("linux_fresh_install_current_read_phase_order_invalid");
  }
}

function requireFreshInstallPhase(phase, name, expected) {
  if (!phase || typeof phase !== "object") throw new Error(`${name}_missing`);
  if (phase.sourceCommit !== TIGHTBEAM.candidateCommit) throw new Error(`${name}_source_mismatch`);
  if (phase.clientAppVersion !== TIGHTBEAM.version ||
      !/^[a-f0-9]{64}$/.test(phase.clientAppVersionEvidenceSha256 ?? "")) {
    throw new Error(`${name}_client_release_identity_mismatch`);
  }
  if (!/^[a-f0-9]{8}$/.test(phase.clientIdentity ?? "") ||
      !/^[a-f0-9]{64}$/.test(phase.registrationIdentity ?? "") ||
      !phase.registrationIdentity.startsWith(phase.clientIdentity) ||
      phase.registeredClientId !== phase.registrationIdentity) {
    throw new Error(`${name}_client_registration_identity_invalid`);
  }
  if (phase.commandRoute !== "direct-client-websocket" ||
      typeof phase.directClientEndpoint !== "string" || !phase.directClientEndpoint.endsWith("/ws") ||
      typeof phase.registryEndpoint !== "string" || !phase.registryEndpoint.endsWith("/ws") ||
      phase.directClientEndpoint === phase.registryEndpoint) {
    throw new Error(`${name}_direct_client_route_invalid`);
  }
  if (typeof phase.controllerIdentity !== "string" || !phase.controllerIdentity ||
      typeof phase.databaseIdentity !== "string" || !phase.databaseIdentity ||
      typeof phase.surfaceId !== "string" || !phase.surfaceId ||
      !Number.isSafeInteger(phase.paneId) || phase.paneId < 1 ||
      phase.registeredSurfaceId !== phase.surfaceId ||
      !Array.isArray(phase.registeredPaneIds) || !phase.registeredPaneIds.includes(phase.paneId) ||
      typeof phase.windowLabel !== "string" || !phase.windowLabel ||
      !Number.isSafeInteger(phase.paneLabel) ||
      phase.registeredWindowLabel !== phase.windowLabel || phase.registeredPaneLabel !== phase.paneLabel) {
    throw new Error(`${name}_registered_target_invalid`);
  }
  const read = phase.currentRead;
  if (read?.cacheStatus !== "current" || read.consumableLoss !== null ||
      read.contentId !== expected.contentId ||
      read.scopeId !== `pane:${encodeURIComponent(phase.surfaceId)}:${phase.paneId}` ||
      !matchesFreshInstallCurrentContent(read.content, {
        contentId: expected.contentId,
        surfaceId: phase.surfaceId,
        paneId: phase.paneId,
      })) {
    throw new Error(`${name}_content_read_mismatch`);
  }
  const capture = phase.capture;
  if (capture?.contentId !== expected.contentId || capture.requestSurfaceId !== phase.surfaceId ||
      (capture.responseSurfaceId !== null && capture.responseSurfaceId !== undefined && capture.responseSurfaceId !== phase.surfaceId) ||
      capture.paneId !== phase.paneId ||
      capture.pixelEvidence?.width < 1 || capture.pixelEvidence?.height < 1 ||
      capture.pixelEvidence?.pngBytes < 1 || !/^[a-f0-9]{64}$/.test(capture.pixelEvidence?.sha256 ?? "") ||
      JSON.stringify(capture.pixelEvidence?.matchedRgbHex) !== JSON.stringify(expected.screenshotColors)) {
    throw new Error(`${name}_screenshot_pixel_evidence_mismatch`);
  }
}

export function validateTightbeamFreshInstallState(stateSequence) {
  if (stateSequence?.mode !== "fresh-install" ||
      stateSequence.sourceCommit !== TIGHTBEAM.candidateCommit ||
      stateSequence.expectedVersion !== TIGHTBEAM.version ||
      typeof stateSequence.expectedContentId !== "string" || !stateSequence.expectedContentId ||
      JSON.stringify(stateSequence.expectedScreenshotColors) !== JSON.stringify(expectedScreenshotColors)) {
    throw new Error("fresh_install_state_identity_invalid");
  }
  if (stateSequence.displayReady?.status !== "verified" ||
      stateSequence.displayReady?.tool !== "xdpyinfo" ||
      typeof stateSequence.displayReady?.display !== "string" || !stateSequence.displayReady.display ||
      !/^[a-f0-9]{64}$/.test(stateSequence.displayReady.probeSha256 ?? "")) {
    throw new Error("fresh_install_display_readiness_unverified");
  }
  const expected = {
    contentId: stateSequence.expectedContentId,
    screenshotColors: expectedScreenshotColors,
  };
  requireFreshInstallPhase(stateSequence.initial, "fresh_install_initial", expected);
  requireFreshInstallPhase(stateSequence.afterRestart, "fresh_install_after_restart", expected);
  const before = stateSequence.initial;
  const after = stateSequence.afterRestart;
  const fleet = stateSequence.fleetPaneUniqueness;
  if (!fleet || fleet.firstClientId === fleet.secondClientId ||
      fleet.firstSurfaceId === fleet.secondSurfaceId ||
      fleet.firstClientId !== before.registeredClientId ||
      fleet.firstSurfaceId !== before.surfaceId ||
      fleet.firstPaneNumber !== before.paneLabel ||
      !Number.isSafeInteger(fleet.secondPaneNumber) || fleet.secondPaneNumber < 1 ||
      fleet.secondPaneNumber === fleet.firstPaneNumber ||
      fleet.sharedRegistryEndpoint !== before.registryEndpoint ||
      typeof fleet.secondDirectClientEndpoint !== "string" || !fleet.secondDirectClientEndpoint.endsWith("/ws") ||
      fleet.secondDirectClientEndpoint === before.directClientEndpoint ||
      fleet.secondDirectClientEndpoint === before.registryEndpoint) {
    throw new Error("fresh_install_fleet_pane_uniqueness_unverified");
  }
  const migration = stateSequence.migrationEvidence;
  if (!migration || !/^[a-f0-9]{64}$/.test(migration.backupSha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(migration.headHashBefore ?? "") ||
      migration.headHashAfter !== migration.headHashBefore ||
      migration.restoredHeadHash !== migration.headHashBefore ||
      !Number.isSafeInteger(migration.headSeqBefore) || migration.headSeqBefore < 1 ||
      migration.headSeqAfter !== migration.headSeqBefore ||
      migration.writerCanClaim !== true || migration.witnessSynchronized !== true) {
    throw new Error("fresh_install_v023_migration_unverified");
  }
  for (const field of ["clientIdentity", "registrationIdentity", "surfaceId", "paneId", "windowLabel", "paneLabel", "databaseIdentity"]) {
    if (after[field] !== before[field]) throw new Error(`fresh_install_${field === "clientIdentity" ? "client_identity" : field}_changed`);
  }
  if (after.controllerIdentity !== before.controllerIdentity) {
    throw new Error("fresh_install_cli_controller_identity_changed");
  }
  if (after.directClientEndpoint !== before.directClientEndpoint || after.registryEndpoint !== before.registryEndpoint) {
    throw new Error("fresh_install_endpoint_changed_after_restart");
  }
  const wrong = stateSequence.wrongSurfaceRejection;
  if (wrong?.status !== "rejected" || wrong.errorCode !== "unknown_surface" ||
      wrong.expectedSurfaceId !== before.surfaceId || wrong.requestedSurfaceId === before.surfaceId ||
      wrong.directClientEndpoint !== before.directClientEndpoint) {
    throw new Error("fresh_install_wrong_surface_not_rejected");
  }
  const restart = stateSequence.postgresRestart;
  if (restart?.status !== "verified" || restart.databaseIdentity !== before.databaseIdentity ||
      restart.projectionBeforeSha256 !== restart.projectionAfterSha256 ||
      !/^[a-f0-9]{64}$/.test(restart.projectionBeforeSha256 ?? "") ||
      restart.witnessSynchronized !== true || restart.registryShutdownClean !== true ||
      restart.registryHealth?.event !== "health" || restart.registryHealth?.status !== "healthy" ||
      restart.registryHealth?.transport !== "fleet.topology") {
    throw new Error("fresh_install_postgres_restart_changed_projection");
  }
  const registryShutdown = restart.registryShutdown;
  const witnessEvent = /^release_witness_(?:recovered_verified|(?:retry|exhausted)_(?:primary_version|primary_identity|primary_durability|primary_sync_config|sender_count|sender_slot|witness_endpoint|receiver_primary|receiver_sender_replay|required_commit_replay|other_fence))$/;
  for (const field of ["releaseWitnessEventsBeforeRestart", "releaseWitnessEventsAfterRestart"]) {
    if (!Array.isArray(registryShutdown?.[field]) ||
        registryShutdown[field].some((event) => typeof event !== "string" || !witnessEvent.test(event))) {
      throw new Error("fresh_install_registry_release_witness_evidence_invalid");
    }
  }
  if (!/^[a-f0-9]{64}$/.test(registryShutdown?.activeProjectionSha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(registryShutdown?.releasedProjectionSha256 ?? "") ||
      registryShutdown.activeProjectionSha256 === registryShutdown.releasedProjectionSha256 ||
      registryShutdown.releasedProjectionSha256 !== restart.projectionBeforeSha256 ||
      registryShutdown.continuity?.ok !== true || registryShutdown.continuity?.phase !== "released" ||
      registryShutdown.continuity?.semanticProjectionUnchanged !== true ||
      registryShutdown.continuity?.journalHeadUnchanged !== true ||
      registryShutdown.continuity?.custodyRevisionDelta !== 1 ||
      registryShutdown.continuity?.leaseGenerationDelta !== 1 ||
      registryShutdown.continuity?.appendedRevisionHeads !== 1) {
    throw new Error("fresh_install_registry_shutdown_projection_not_verified");
  }
  if (restart.schema?.has_fleets !== true || restart.schema?.has_journal !== true ||
      restart.schema?.has_read_state !== true || restart.schema?.has_journal_validator !== true) {
    throw new Error("fresh_install_postgres_schema_contract_missing");
  }
  for (const role of ["primary", "witness"]) {
    const lifecycle = restart.lifecycle?.[role];
    if (!lifecycle || lifecycle.stopExitCode !== 0 || lifecycle.startExitCode !== 0 ||
        !Number.isSafeInteger(lifecycle.pidBefore) || lifecycle.pidBefore < 1 ||
        !Number.isSafeInteger(lifecycle.pidAfter) || lifecycle.pidAfter < 1 ||
        typeof lifecycle.stopStdout !== "string" || typeof lifecycle.startStdout !== "string") {
      throw new Error(`fresh_install_postgres_${role}_restart_lifecycle_invalid`);
    }
  }
  if (restart.initialRegistryHealth?.event !== "health" || restart.initialRegistryHealth?.status !== "healthy" ||
      restart.initialRegistryHealth?.transport !== "fleet.topology") {
    throw new Error("fresh_install_initial_registry_unhealthy");
  }
  if (stateSequence.cleanup?.clientStopped !== true || stateSequence.cleanup?.registryStopped !== true ||
      stateSequence.cleanup?.postgresStopped !== true) {
    throw new Error("fresh_install_owned_process_cleanup_unverified");
  }
  return {
    clientAppVersion: before.clientAppVersion,
    clientAppVersionEvidenceSha256: before.clientAppVersionEvidenceSha256,
    contentId: expected.contentId,
    databaseIdentity: before.databaseIdentity,
    mode: "fresh-install",
    sourceCommit: stateSequence.sourceCommit,
    status: "passed",
    surfaceId: before.surfaceId,
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

async function cliPackageContract(archive, installRoot) {
  await installArchive(archive, installRoot);
  return verifyTightbeamCliStage(installRoot);
}

export async function installElectronArchive(archive, installRoot, platform) {
  await removeIfExists(installRoot);
  await fs.mkdir(installRoot, { recursive: true });
  await run("unzip", ["-q", archive, "-d", installRoot]);
  const executable = platform === "macos"
    ? path.join(installRoot, "Surf Ace.app/Contents/MacOS/Surf Ace")
    : path.join(installRoot, "Surf Ace/surf-ace");
  await fs.access(executable);
  return executable;
}

export async function runLinuxFreshInstallStateDriver(options, execute = run) {
  const productSourceDir = path.resolve(options.productSourceDir);
  const tsxLoader = path.join(productSourceDir, "packages/allocator/node_modules/tsx/dist/loader.mjs");
  await fs.access(tsxLoader);
  try {
    await execute(process.execPath, [
      "--import", tsxLoader,
      path.resolve(options.driver),
      "--mode", "fresh-install",
      "--candidate-commit", options.candidateCommit,
      "--expected-version", TIGHTBEAM.version,
      "--candidate-electron", path.resolve(options.candidateElectron),
      "--candidate-root", path.resolve(options.candidateRoot),
      "--cli-binary", path.resolve(options.cliBinary),
      "--product-source", productSourceDir,
      "--output", path.resolve(options.output),
      "--state-root", path.resolve(options.stateRoot),
    ], {
      env: {
        ...process.env,
        SURF_ACE_CLIENT_DIAGNOSTIC_LOG: path.join(path.resolve(options.stateRoot), "client-flight-recorder.log"),
      },
    });
  } catch (error) {
    let driverFailure;
    try {
      const state = JSON.parse(await fs.readFile(path.resolve(options.output), "utf8"));
      if (state?.mode === "fresh-install" && state?.status === "failed" && typeof state.error === "string") {
        driverFailure = state.error;
      }
    } catch {
      // The child may have failed before it could write its structured state.
    }
    const clientDiagnostics = await readFailureFileTail(
      path.join(path.resolve(options.stateRoot), "client-flight-recorder.log"),
    );
    const exit = Number.isInteger(error?.code) ? `exit=${error.code}` :
      (error?.signal ? `signal=${error.signal}` : "exit=unknown");
    const diagnosticDetail = clientDiagnostics ? `\nclient_flight_recorder_tail:\n${clientDiagnostics}` : "";
    throw new Error(`linux_state_driver_failed:${driverFailure ?? exit}${diagnosticDetail}`, { cause: error });
  }
  const stateSequence = JSON.parse(await fs.readFile(options.output, "utf8"));
  const validated = validateTightbeamFreshInstallState(stateSequence);
  const rawCliEvidence = decodeRawCliEvidence(
    stateSequence.rawCliEvidenceBase64,
    stateSequence.rawCliEvidenceBytes,
    stateSequence.rawCliEvidenceSha256,
    "linux_fresh_install",
  );
  const expectedStateRoot = path.resolve(options.stateRoot);
  assertLinuxFreshInstallCliStateRoots(rawCliEvidence.events, {
    firstEndpoint: stateSequence.initial.directClientEndpoint,
    firstStateRoot: path.join(expectedStateRoot, "cli"),
    secondEndpoint: stateSequence.fleetPaneUniqueness.secondDirectClientEndpoint,
    secondStateRoot: path.join(expectedStateRoot, "second-cli"),
  });
  requireLinuxFreshInstallRawCliCoverage(stateSequence, rawCliEvidence);
  const wrong = stateSequence.wrongSurfaceRejection;
  if (!wrong?.request || wrong.request.surfaceId !== wrong.requestedSurfaceId ||
      wrong.requestedSurfaceId === wrong.expectedSurfaceId ||
      wrong.endpoint !== wrong.directClientEndpoint ||
      !String(wrong.rawOutput ?? "").includes(`unknown_surface:${wrong.requestedSurfaceId}`)) {
    throw new Error("linux_fresh_install_wrong_surface_raw_evidence_invalid");
  }
  return { ...validated, rawCliEvidence, wrongSurfaceRejection: wrong };
}

const FAILURE_DIAGNOSTIC_LIMIT = 6_000;

async function readFailureFileTail(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, FAILURE_DIAGNOSTIC_LIMIT);
    const contents = Buffer.alloc(length);
    if (length > 0) await handle.read(contents, 0, length, size - length);
    return boundedFailureText(contents.toString("utf8").trim());
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function boundedFailureText(value) {
  const text = String(value ?? "");
  const redacted = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/((?:postgres(?:ql)?:\/\/)[^:@/\s]+(?::[^@/\s]*)?@)/gi, "[REDACTED DATABASE CREDENTIALS]@")
    .replace(/((?:authorization|access[_-]?token|password|secret|private[_-]?key)(?:[\"']?\s*[:=]\s*[\"']?))[^\s,\"'}]+/gi, "$1[REDACTED]");
  if (redacted.length <= FAILURE_DIAGNOSTIC_LIMIT) return redacted;
  return `[truncated to final ${FAILURE_DIAGNOSTIC_LIMIT} characters]\n${redacted.slice(-FAILURE_DIAGNOSTIC_LIMIT)}`;
}

export function formatSmokeFailure(error) {
  const lines = ["tightbeam_release_smoke_failed"];
  const seen = new Set();
  let current = error;
  let depth = 0;
  while (current && depth < 8 && !seen.has(current)) {
    seen.add(current);
    const name = current.name || "Error";
    const message = boundedFailureText(current.message ?? current);
    lines.push(`${depth === 0 ? "error" : `cause[${depth}]`}: ${name}: ${message}`);
    if (current.code !== undefined) {
      const field = typeof current.code === "number" ? "exit_code" : "error_code";
      lines.push(`  ${field}: ${boundedFailureText(current.code)}`);
    }
    if (current.signal) lines.push(`  signal: ${boundedFailureText(current.signal)}`);
    if (current.stdout) lines.push(`  stdout:\n${boundedFailureText(current.stdout)}`);
    if (current.stderr) lines.push(`  stderr:\n${boundedFailureText(current.stderr)}`);
    current = current.cause;
    depth += 1;
  }
  return lines.join("\n");
}

export async function verifyTightbeamChecksums(manifestPath) {
  const directory = path.dirname(path.resolve(manifestPath));
  const checksumPath = path.join(directory, TIGHTBEAM.checksums);
  const lines = (await fs.readFile(checksumPath, "utf8")).trimEnd().split("\n");
  const expectedNames = [...TIGHTBEAM.assets, TIGHTBEAM.manifest].sort();
  const parsed = lines.map((line) => {
    const match = line.match(/^([a-f0-9]{64})  ([^/]+)$/);
    if (!match) throw new Error("tightbeam_checksum_line_invalid");
    return { digest: match[1], name: match[2] };
  });
  if (JSON.stringify(parsed.map(({ name }) => name)) !== JSON.stringify(expectedNames)) {
    throw new Error("tightbeam_checksum_file_set_mismatch");
  }
  for (const { digest, name } of parsed) {
    if (await sha256(path.join(directory, name)) !== digest) throw new Error(`tightbeam_checksum_mismatch:${name}`);
  }
  return { files: expectedNames, status: "verified" };
}

export async function smokeLinuxFreshInstall(options) {
  const participantIdentities = assertTightbeamSmokeParticipantIdentities(options.participantIdentities, "linux");
  await assertTightbeamSmokeParticipantAssetBytes(participantIdentities, "linux", {
    cli: options.cli,
    client: options.electron,
    server: options.backend,
  });
  const configuredStateDriver = process.env.SURF_ACE_TIGHTBEAM_STATE_DRIVER;
  if (!configuredStateDriver) throw new Error("tightbeam_smoke_state_driver_required");
  const stateDriver = path.resolve(configuredStateDriver);
  const expectedStateDriver = path.join(toolingRoot, "scripts/release/tightbeam-state-smoke-fixture.ts");
  if (stateDriver !== expectedStateDriver) throw new Error("tightbeam_smoke_state_driver_not_current_tooling_input");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-tightbeam-linux-fresh-install-"));
  let passed = false;
  try {
    const candidateRoot = path.join(root, "candidate");
    const candidateElectron = await installElectronArchive(options.electron, path.join(root, "candidate-electron"), "linux");
    const electronPackageIdentity = await readTightbeamElectronPackageIdentity(
      path.join(path.dirname(candidateElectron), "resources/app.asar"),
      options.sourceDir,
    );
    const cliRoot = path.join(root, "cli-only");
    const stateRoot = path.join(root, "state");
    const stateResult = path.join(root, "fresh-install-state.json");
    const candidateContract = await linuxPackageContract(options.backend, candidateRoot);
    const cliContract = await cliPackageContract(options.cli, cliRoot);
    const validation = await runLinuxFreshInstallStateDriver({
      candidateCommit: options.candidateCommit,
      candidateElectron,
      candidateRoot,
      cliBinary: path.join(cliRoot, "bin/surf-ace"),
      driver: stateDriver,
      expectedVersion: TIGHTBEAM.version,
      output: stateResult,
      productSourceDir: options.sourceDir,
      stateRoot,
    });
    passed = true;
    return {
      candidateCommit: options.candidateCommit,
      component: "linux",
      mode: "fresh-install",
      packages: { candidate: candidateContract, cliOnly: cliContract },
      participantIdentities: participantIdentities.map((identity) => identity.participant === "client"
        ? {
          ...identity,
          packageName: electronPackageIdentity.packageName,
          packageVersion: electronPackageIdentity.version,
          runtimeVersion: validation.clientAppVersion,
          runtimeVersionEvidenceSha256: validation.clientAppVersionEvidenceSha256,
          runtimeVersionSource: "electron.app.getVersion",
        }
        : identity),
      state: validation,
      status: "passed",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`linux_fresh_install_failed:${message}:evidence_root:${root}`, { cause: error });
  } finally {
    // A Red retains the isolated logs/state for diagnosis; successful runs return
    // the validated raw CLI evidence and remove their disposable package/PG state.
    if (passed) await removeIfExists(root);
  }
}

export async function smokeTightbeamLinuxQualification(options, dependencies = {}) {
  if (process.env.SURF_ACE_SMOKE_COMPONENT !== "linux") {
    throw new Error("tightbeam_linux_qualification_smoke_requires_linux_component");
  }
  if (!path.isAbsolute(options.sourceDir ?? "") || !path.isAbsolute(options.packageDir ?? "")) {
    throw new Error("tightbeam_linux_qualification_smoke_paths_must_be_absolute");
  }
  assertTightbeamLinuxQualificationClaims({
    sourceCommit: options.sourceCommit,
    toolingCommit: options.toolingCommit,
    version: TIGHTBEAM.version,
    target: TOOLCHAINS.linuxRustTarget,
  });

  const sourceDir = path.resolve(options.sourceDir);
  const packageDir = path.resolve(options.packageDir);
  const currentToolingRoot = path.resolve(dependencies.toolingRoot ?? toolingRoot);
  assertDisjointTrees(sourceDir, packageDir);
  assertDisjointTrees(currentToolingRoot, packageDir);
  assertDisjointTrees(sourceDir, currentToolingRoot);

  const captureCommand = dependencies.capture ?? capture;
  const cleanInputs = dependencies.assertTrackedInputsUnchanged ?? assertTrackedInputsUnchanged;
  const sourceHead = await captureCommand("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  if (sourceHead !== options.sourceCommit) throw new Error(`source_commit_mismatch:${sourceHead}:${options.sourceCommit}`);
  const toolingHead = await captureCommand("git", ["-C", currentToolingRoot, "rev-parse", "HEAD"]);
  if (toolingHead !== options.toolingCommit) throw new Error(`tooling_commit_mismatch:${toolingHead}:${options.toolingCommit}`);
  await cleanInputs(sourceDir);
  await cleanInputs(currentToolingRoot);

  const linuxAssets = TIGHTBEAM.assets.slice(0, 3).sort();
  const entries = await fs.readdir(packageDir, { withFileTypes: true });
  if (JSON.stringify(entries.map(({ name }) => name).sort()) !== JSON.stringify(linuxAssets) || entries.some((entry) => !entry.isFile())) {
    throw new Error("tightbeam_linux_qualification_asset_set_mismatch");
  }
  const assetEvidence = {};
  for (const name of linuxAssets) {
    const file = path.join(packageDir, name);
    const metadata = await fs.stat(file);
    if (metadata.size === 0) throw new Error(`tightbeam_linux_qualification_asset_empty:${name}`);
    assetEvidence[name] = { sha256: await sha256(file), sizeBytes: metadata.size };
  }

  const participantIdentities = buildTightbeamSmokeParticipantIdentities({
    assetDetails: Object.entries(assetEvidence).map(([name, detail]) => ({ name, ...detail })),
    component: "linux",
    identityBasis: "source-tooling-HEAD-and-package-SHA256",
    sourceCommit: sourceHead,
    toolingCommit: toolingHead,
    version: TIGHTBEAM.version,
  });

  const runSmoke = dependencies.runLinuxFreshInstallSmoke ?? smokeLinuxFreshInstall;
  const result = await runSmoke({
    backend: path.join(packageDir, TIGHTBEAM.assets[0]),
    candidateCommit: TIGHTBEAM.candidateCommit,
    cli: path.join(packageDir, TIGHTBEAM.assets[1]),
    electron: path.join(packageDir, TIGHTBEAM.assets[2]),
    participantIdentities,
    sourceDir,
  });
  await cleanInputs(sourceDir);
  await cleanInputs(currentToolingRoot);
  const sourceHeadAfter = await captureCommand("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  if (sourceHeadAfter !== sourceHead) throw new Error(`source_commit_changed_during_qualification_smoke:${sourceHead}:${sourceHeadAfter}`);
  const toolingHeadAfter = await captureCommand("git", ["-C", currentToolingRoot, "rev-parse", "HEAD"]);
  if (toolingHeadAfter !== toolingHead) throw new Error(`tooling_commit_changed_during_qualification_smoke:${toolingHead}:${toolingHeadAfter}`);
  const entriesAfter = await fs.readdir(packageDir, { withFileTypes: true });
  if (JSON.stringify(entriesAfter.map(({ name }) => name).sort()) !== JSON.stringify(linuxAssets) || entriesAfter.some((entry) => !entry.isFile())) {
    throw new Error("tightbeam_linux_qualification_asset_set_changed");
  }
  for (const [name, before] of Object.entries(assetEvidence)) {
    const file = path.join(packageDir, name);
    const metadata = await fs.stat(file);
    if (metadata.size !== before.sizeBytes || await sha256(file) !== before.sha256) {
      throw new Error(`tightbeam_linux_qualification_asset_changed:${name}`);
    }
  }
  return {
    assets: assetEvidence,
    qualificationOnly: true,
    releaseAdmitted: false,
    sourceCommit: sourceHead,
    status: result.status,
    toolingCommit: toolingHead,
    participantIdentities: result.participantIdentities ?? participantIdentities,
    transitions: result,
  };
}

export function macosSmokePlan(root, candidate) {
  return electronSmokePlan(root, candidate, "macos");
}

export function electronSmokePlan(root, candidate, platform) {
  const step = {
    archive: candidate,
    home: path.join(root, "candidate-profile"),
    installRoot: path.join(root, "candidate-install"),
    phase: "candidate",
    platform,
    port: 19101,
  };
  return [{
    ...step,
    identityFile: path.join(electronLaunchConfig(step.home, step.port).userDataDir, "surface-identity.json"),
  }];
}

function cliResult(output) {
  const result = output?.result?.payload ?? output?.result;
  if (output?.ok !== true || !result || typeof result !== "object") throw new Error("packaged_cli_smoke_result_invalid");
  return result;
}

function cliSurface(output, expectedSurfaceId) {
  const surfaces = cliResult(output).surfaces;
  if (!Array.isArray(surfaces)) throw new Error("packaged_cli_smoke_surfaces_missing");
  const surface = expectedSurfaceId
    ? surfaces.find((candidate) => candidate?.surfaceId === expectedSurfaceId)
    : surfaces.length === 1 ? surfaces[0] : undefined;
  if (!surface || typeof surface.surfaceId !== "string" || !Array.isArray(surface.topology?.panes)) {
    throw new Error("packaged_cli_smoke_surface_invalid");
  }
  return surface;
}

function paneScopeId(surfaceId, paneId) {
  return `pane:${encodeURIComponent(surfaceId)}:${paneId}`;
}

async function invokePackagedCli(binary, stateRoot, commandName, input, endpoint, evidencePath, expectedRejection) {
  const args = ["--state-root", stateRoot];
  if (endpoint) args.push("--endpoint", endpoint, "--product-label", "Surf Ace release smoke");
  args.push(commandName, "--input-json", JSON.stringify(input));
  let stdout = "";
  let stderr = "";
  let status = 0;
  try {
    const result = await run(binary, args);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    status = Number.isInteger(error?.code) ? error.code : "launch-failed";
    stdout = error?.stdout ?? "";
    stderr = error?.stderr ?? "";
    const rejectionEvidence = expectedRejection && status > 0 && commandName === "push" &&
      `${stdout}\n${stderr}`.includes(`unknown_surface:${expectedRejection.requestedSurfaceId}`)
      ? expectedRejection
      : undefined;
    await fs.appendFile(evidencePath, `${JSON.stringify({
      args, command: commandName, endpoint: endpoint ?? null, input,
      inputJson: JSON.stringify(input),
      route: endpoint ? "direct-client-websocket" : "endpointless-local-read",
      ...(rejectionEvidence ? { expectedRejection: rejectionEvidence } : {}),
      status, stderr, stdout,
    })}\n`);
    if (rejectionEvidence) return { ok: false, error: rejectionEvidence.code };
    throw error;
  }
  let output;
  try {
    output = JSON.parse(stdout);
  } catch {
    await fs.appendFile(evidencePath, `${JSON.stringify({
      args, command: commandName, endpoint: endpoint ?? null, input,
      inputJson: JSON.stringify(input),
      route: endpoint ? "direct-client-websocket" : "endpointless-local-read",
      status, stderr, stdout, parseError: "invalid-json",
    })}\n`);
    throw new Error(`packaged_cli_${commandName}_output_invalid`);
  }
  await fs.appendFile(evidencePath, `${JSON.stringify({
    args, command: commandName, endpoint: endpoint ?? null, input,
    inputJson: JSON.stringify(input),
    route: endpoint ? "direct-client-websocket" : "endpointless-local-read",
    status, stderr, output, stdout,
  })}\n`);
  if (output.ok !== true) throw new Error(`packaged_cli_${commandName}_failed:${stdout.trim()}`);
  return output;
}

async function waitForClientWebSocket(endpoint, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(endpoint);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("websocket_open_timeout"));
        }, 1_000);
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          socket.close();
          resolve();
        }, { once: true });
        socket.addEventListener("error", (event) => {
          clearTimeout(timer);
          socket.close();
          reject(event.error ?? new Error("websocket_open_failed"));
        }, { once: true });
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`tightbeam_direct_client_endpoint_timeout:${lastError?.message ?? "not_ready"}`);
}

async function runDirectClientCandidate(step, executable, cliBinary, stateRoot, channel, operations) {
  const endpoint = `ws://127.0.0.1:${step.port}/ws`;
  const evidencePaths = {
    diagnosticLogPath: path.join(path.dirname(stateRoot), `${channel}-${step.phase}-client-flight-recorder.ndjson`),
    rawCliEvidencePath: path.join(path.dirname(stateRoot), `${channel}-${step.phase}-raw-cli-evidence.ndjson`),
  };
  const disableGpu = channel === "macos";
  const launchClient = operations.launchClient ?? (async (_executable, _step, _endpoint, paths) => {
    const { started } = await launchElectron(executable, step.home, step.port, undefined, undefined, paths.diagnosticLogPath, paths.disableGpu);
    return { started, async stop() { await stopElectron(started); } };
  });
  const client = await launchClient(executable, step, endpoint, { ...evidencePaths, disableGpu });
  try {
    await (operations.waitForEndpoint ?? waitForClientWebSocket)(endpoint);
    const clientRuntimeIdentity = await verifyClientAppVersion(evidencePaths.diagnosticLogPath, TIGHTBEAM.version);
    const identity = await fs.readFile(step.identityFile);
    if (identity.length === 0) throw new Error(`tightbeam_${channel}_${step.phase}_identity_empty`);

    const invoke = operations.invokeCli ?? ((commandName, input, target = endpoint, expectedRejection) =>
      invokePackagedCli(cliBinary, stateRoot, commandName, input, target, evidencePaths.rawCliEvidencePath, expectedRejection));
    const list = await invoke("list", {});
    const listed = cliSurface(list, step.expectedSurfaceId);
    const surfaceId = listed.surfaceId;
    const paneId = Number(listed.topology.panes[0]?.paneId);
    if (!Number.isSafeInteger(paneId) || paneId < 1) throw new Error(`tightbeam_${channel}_${step.phase}_pane_missing`);
    if (step.expectedSurfaceId && surfaceId !== step.expectedSurfaceId) throw new Error(`tightbeam_${channel}_${step.phase}_surface_changed`);

    const reads = [];
    const captureRead = async (targetPaneId) => {
      const captureOutput = await invoke("capture-pane", {
        includeDrawings: true, paneId: targetPaneId, surfaceId,
      });
      const capture = cliResult(captureOutput);
      if (Number(capture.paneId) !== targetPaneId ||
          (capture.surfaceId !== undefined && capture.surfaceId !== surfaceId)) {
        throw new Error(`tightbeam_${channel}_candidate_capture_target_mismatch`);
      }
      const readOutput = await invoke("read", { scopeId: paneScopeId(surfaceId, targetPaneId) }, null);
      const read = cliResult(readOutput);
      if (read.cacheStatus !== "current" || read.consumableLoss !== null || read.scopeId !== paneScopeId(surfaceId, targetPaneId)) {
        throw new Error(`tightbeam_${channel}_candidate_read_not_current`);
      }
      const capturedContentId = capture.contentId ?? capture.currentContentRecord?.payload?.contentId ?? capture.currentContentRecord?.contentId;
      const readContentId = read.currentContentRecord?.payload?.contentId ?? read.currentContentRecord?.contentId;
      if (typeof capturedContentId !== "string" || !capturedContentId || capturedContentId !== readContentId) {
        throw new Error(`tightbeam_${channel}_candidate_capture_read_content_mismatch`);
      }
      const evidence = { captureOutput, output: readOutput, paneId: targetPaneId, scopeId: paneScopeId(surfaceId, targetPaneId), surfaceId };
      reads.push(evidence);
      return { capture, read, evidence };
    };
    const contentId = `tightbeam-${channel}-v023-candidate-write`;
    const html = [
      "<style>",
      "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}",
      ".left,.right{position:absolute;top:0;bottom:0;width:50%}",
      ".left{left:0;background:#d93636}",
      ".right{right:0;background:#246bce}",
      "</style><div class=left></div><div class=right></div>",
    ].join("");
    await invoke("push", {
      content: { html }, contentId, contentType: "html", paneId, surfaceId,
    });
    const visible = await captureRead(paneId);
    const pixelEvidence = inspectScreenshotPixels(visible.capture.image, expectedScreenshotColors);
    const observedId = visible.read.currentContentRecord?.payload?.contentId ?? visible.read.currentContentRecord?.contentId;
    if (observedId !== contentId || !matchesFreshInstallCurrentContent(visible.read.currentContentRecord, {
      contentId, surfaceId, paneId,
    })) {
      throw new Error(`tightbeam_${channel}_candidate_content_not_current`);
    }
    const wrongSurfaceId = `${surfaceId}-wrong-release-target`;
    const wrongSurfaceRejection = await invoke("push", {
      content: { html: "<p>must not be written to another surface</p>" },
      contentId: `${contentId}-wrong-surface`,
      contentType: "html",
      paneId,
      surfaceId: wrongSurfaceId,
    }, endpoint, { code: "unknown_surface", expectedSurfaceId: surfaceId, requestedSurfaceId: wrongSurfaceId });
    if (wrongSurfaceRejection?.ok !== false || wrongSurfaceRejection?.error !== "unknown_surface") {
      throw new Error(`tightbeam_${channel}_candidate_wrong_surface_was_not_rejected`);
    }
    const rawCliEvidence = await readRawCliEvidence(evidencePaths.rawCliEvidencePath, `${channel}_candidate`, !operations.invokeCli);
    if (rawCliEvidence) requireElectronRawCliCoverage(channel, endpoint, stateRoot, {
      contentId, paneId, surfaceId, wrongSurfaceId,
    }, rawCliEvidence);
    return {
      commandRoute: "direct-client-websocket",
      clientEndpoint: endpoint,
      clientIdentitySha256: await sha256(step.identityFile),
      clientRuntimeIdentity,
      contentId,
      paneId,
      phase: "candidate",
      pixelEvidence,
      rawCliEvidence,
      readEvidence: reads,
      sourceCommit: step.sourceCommit,
      surfaceId,
      currentContentId: observedId ?? null,
      wrongSurfaceRejection: { code: "unknown_surface", expectedSurfaceId: surfaceId, requestedSurfaceId: wrongSurfaceId },
    };
  } finally {
    await client.stop();
  }
}

export async function runElectronSmokePlan(plan, platform, operations = {}) {
  const extract = operations.extract ?? (async (archive, installRoot) => run("unzip", ["-q", archive, "-d", installRoot]));
  const channel = platform === "macos" ? "macos" : "linux";
  const participantIdentities = assertTightbeamSmokeParticipantIdentities(operations.participantIdentities, channel);
  if (plan.length !== 1 || plan[0].phase !== "candidate") {
    throw new Error("tightbeam_smoke_requires_one_candidate_only");
  }
  const candidateStateRoot = operations.stateRoot;
  const clientResults = [];
  for (const step of plan) {
    await removeIfExists(step.installRoot);
    await fs.mkdir(step.installRoot, { recursive: true });
    await extract(step.archive, step.installRoot);
    const executable = platform === "macos"
      ? path.join(step.installRoot, "Surf Ace.app/Contents/MacOS/Surf Ace")
      : path.join(step.installRoot, "Surf Ace/surf-ace");
    const appArchive = platform === "macos"
      ? path.join(step.installRoot, "Surf Ace.app/Contents/Resources/app.asar")
      : path.join(step.installRoot, "Surf Ace/resources/app.asar");
    const readPackageIdentity = operations.readElectronPackageIdentity ?? readTightbeamElectronPackageIdentity;
    const clientPackageIdentity = assertTightbeamElectronPackageIdentity(
      await readPackageIdentity(appArchive, operations.sourceDir),
    );
    if (!operations.cliBinary) throw new Error("tightbeam_candidate_smoke_requires_packaged_cli");
    const directResult = await runDirectClientCandidate({
      ...step,
      sourceCommit: TIGHTBEAM.candidateCommit,
    }, executable, operations.cliBinary, candidateStateRoot, channel, {
      ...operations,
      clientPackageIdentity,
    });
    clientResults.push(directResult);
  }
  const clientRuntimeIdentity = clientResults[0]?.clientRuntimeIdentity;
  return {
    commandRoute: "direct-client-websocket",
    mode: "candidate-only",
    participantIdentities: participantIdentities.map((identity) => identity.participant === "client"
      ? {
        ...identity,
        packageName: "@surf-ace/electron",
        packageVersion: TIGHTBEAM.version,
        runtimeVersion: clientRuntimeIdentity?.version,
        runtimeVersionEvidenceSha256: clientRuntimeIdentity?.evidenceSha256,
        runtimeVersionSource: clientRuntimeIdentity?.source,
      }
      : identity),
    phases: clientResults,
  };
}

export async function runMacosSmokePlan(plan, operations = {}) {
  return runElectronSmokePlan(plan, "macos", operations);
}

async function smokeMacos(options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-tightbeam-electron-"));
  try {
    await assertTightbeamSmokeParticipantAssetBytes(options.participantIdentities, "macos", {
      cli: options.cli,
      client: options.electron,
    });
    const cliRoot = path.join(root, "cli-only");
    const cliContract = await cliPackageContract(options.cli, cliRoot);
    const transitions = await runMacosSmokePlan(macosSmokePlan(root, options.electron), {
      cliBinary: path.join(cliRoot, "bin/surf-ace"),
      participantIdentities: options.participantIdentities,
      sourceDir: options.sourceDir,
      stateRoot: path.join(root, "macos-cli-state"),
    });
    return { cliOnly: cliContract, component: "macos", mode: "candidate-only", transitions, status: "passed" };
  } finally {
    await removeIfExists(root);
  }
}

export async function smokeTightbeam(options) {
  if (options.candidateCommit !== TIGHTBEAM.candidateCommit ||
      typeof options.sourceDir !== "string" || !options.sourceDir ||
      typeof options.sourceCommit !== "string" || !options.sourceCommit ||
      typeof options.toolingCommit !== "string" || !options.toolingCommit) {
    throw new Error("tightbeam_smoke_identity_mismatch");
  }
  const sourceDir = path.resolve(options.sourceDir);
  const sourceHead = await capture("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  const toolingHead = await capture("git", ["-C", toolingRoot, "rev-parse", "HEAD"]);
  if (sourceHead !== options.sourceCommit || sourceHead !== TIGHTBEAM.candidateCommit) {
    throw new Error(`tightbeam_smoke_source_head_mismatch:${sourceHead}:${options.sourceCommit}`);
  }
  if (toolingHead !== options.toolingCommit) {
    throw new Error(`tightbeam_smoke_tooling_head_mismatch:${toolingHead}:${options.toolingCommit}`);
  }
  await assertTrackedInputsUnchanged(sourceDir);
  await assertTrackedInputsUnchanged(toolingRoot);
  const assetFiles = Object.fromEntries(TIGHTBEAM.assets.map((name) => [name, path.join(path.dirname(options.manifest), name)]));
  const manifest = await verifyManifestFiles(options.manifest, assetFiles);
  await verifyTightbeamChecksums(options.manifest);
  if (manifest.source?.commit !== options.candidateCommit || manifest.source?.tag !== TIGHTBEAM.sourceTag ||
      manifest.tooling?.commit !== options.toolingCommit || manifest.tooling?.tag !== TIGHTBEAM_TOOLING_TAG ||
      manifest.version !== TIGHTBEAM.version) {
    throw new Error("tightbeam_smoke_manifest_identity_mismatch");
  }
  const component = process.env.SURF_ACE_SMOKE_COMPONENT;
  if (!(component in participantAssets)) throw new Error("SURF_ACE_SMOKE_COMPONENT_must_be_linux_or_macos");
  const participantIdentities = buildTightbeamSmokeParticipantIdentities({
    assetDetails: manifest.assets,
    component,
    identityBasis: "manifest-and-SHA256SUMS",
    sourceCommit: manifest.source.commit,
    toolingCommit: manifest.tooling.commit,
    version: manifest.version,
  });
  const names = TIGHTBEAM.assets;
  options.backend = assetFiles[names[0]];
  options.cli = assetFiles[component === "linux" ? names[1] : names[3]];
  options.electron = assetFiles[component === "linux" ? names[2] : names[4]];
  options.participantIdentities = participantIdentities;
  let result;
  if (component === "linux") result = await smokeLinuxFreshInstall({ ...options, sourceDir });
  else result = await smokeMacos(options);
  await assertTrackedInputsUnchanged(sourceDir);
  await assertTrackedInputsUnchanged(toolingRoot);
  if (await capture("git", ["-C", sourceDir, "rev-parse", "HEAD"]) !== sourceHead ||
      await capture("git", ["-C", toolingRoot, "rev-parse", "HEAD"]) !== toolingHead) {
    throw new Error("tightbeam_smoke_identity_changed_during_candidate_run");
  }
  const observedParticipants = component === "linux"
    ? result.participantIdentities
    : result.transitions.participantIdentities;
  return {
    ...result,
    participantIdentities: {
      productCommit: sourceHead,
      toolingCommit: toolingHead,
      version: TIGHTBEAM.version,
      participants: observedParticipants,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), [], ["qualification-only", "source-dir", "source-commit", "tooling-commit", "package-dir", "candidate-commit", "manifest"]);
  let result;
  if (args["qualification-only"] !== undefined) {
    if (args["qualification-only"] !== "linux" || args.manifest !== undefined || args["candidate-commit"] !== undefined) {
      throw new Error("invalid_tightbeam_smoke_qualification_arguments");
    }
    result = await smokeTightbeamLinuxQualification({
      packageDir: args["package-dir"],
      sourceCommit: args["source-commit"],
      sourceDir: args["source-dir"],
      toolingCommit: args["tooling-commit"],
    });
  } else {
    if (!args.manifest || !args["candidate-commit"] || !args["tooling-commit"] || !args["source-dir"] ||
        !args["source-commit"] || args["package-dir"] !== undefined) {
      throw new Error("missing_or_invalid_tightbeam_release_smoke_arguments");
    }
    result = await smokeTightbeam({
      candidateCommit: args["candidate-commit"],
      manifest: path.resolve(args.manifest),
      sourceCommit: args["source-commit"],
      sourceDir: args["source-dir"],
      toolingCommit: args["tooling-commit"],
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${formatSmokeFailure(error)}\n`);
    process.exitCode = 1;
  });
}
