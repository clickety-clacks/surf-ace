import { createHash } from "node:crypto";

export const CANONICAL_SKILL_SOURCE = "integrations/tightbeam/skills/surf-ace/SKILL.md";

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST_TOKEN = /^[A-Za-z0-9._+/-]+$/;
const CHANNELS = new Set(["desktop-cli-release", "iphone-build"]);
const DESTINATION_KINDS = new Set(["shared-identity", "standalone-skill"]);
const CHECKSUM_LINE = /^([a-f0-9]{64})[ \t]+[*]?(.+)$/;

function bytes(value, field) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  throw new Error(`delivery_${field}_invalid`);
}

function rejectedCandidateId(candidate) {
  const digestIfBytes = (value) => Buffer.isBuffer(value) || value instanceof Uint8Array ? sha256(value) : null;
  const identity = candidate?.identity ?? {};
  return sha256(Buffer.from(canonicalJson({
    channel: candidate?.channel ?? null,
    releaseOrBuildId: identity.releaseOrBuildId ?? null,
    sourceCommit: identity.sourceCommit ?? null,
    manifestSha256: digestIfBytes(candidate?.manifestBytes),
    checksumsSha256: digestIfBytes(candidate?.checksumBytes),
    skillSha256: digestIfBytes(candidate?.skillBytes),
    artifactSha256: identity.artifactSha256 ?? null,
  })));
}

const TERMINAL_CANDIDATE_ERRORS = new Set([
  "delivery_channel_invalid",
  "delivery_release_identity_invalid",
  "delivery_build_identity_invalid",
  "delivery_iphone_archive_evidence_invalid",
  "delivery_iphone_source_evidence_invalid",
  "delivery_manifest_invalid",
  "delivery_source_commit_invalid",
  "delivery_skill_source_mismatch",
  "delivery_desktop_manifest_mismatch",
  "delivery_release_identity_mismatch",
  "delivery_release_tag_target_mismatch",
  "delivery_release_integrity_identity_mismatch",
  "delivery_release_asset_set_invalid",
  "delivery_release_asset_set_mismatch",
  "delivery_checksums_asset_set_mismatch",
  "delivery_manifest_asset_set_invalid",
  "delivery_manifest_checksums_mismatch",
  "delivery_checksums_manifest_mismatch",
  "delivery_release_asset_digest_mismatch",
  "delivery_manifest_checksum_mismatch",
  "delivery_skill_checksum_mismatch",
  "delivery_iphone_manifest_mismatch",
  "delivery_build_record_digest_invalid",
]);

function isTerminalCandidateError(error) {
  return TERMINAL_CANDIDATE_ERRORS.has(error?.message);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`delivery_${field}_invalid`);
  return value;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeDestinationRecords(destinations) {
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw new Error("delivery_destination_set_invalid");
  }
  const records = destinations.map((destination) => {
    const { id, kind, host, path, writer, effects, route = {} } = destination ?? {};
    if (typeof id !== "string" || id.length === 0 ||
        !DESTINATION_KINDS.has(kind) ||
        typeof host !== "string" || host.length === 0 ||
        typeof path !== "string" || !path.startsWith("/") ||
        writer !== (kind === "shared-identity" ? "supported-identity-cli" : "existing-ssh") ||
        !effects || typeof effects !== "object" ||
        [effects.service, effects.database, effects.downtime].some((value) => typeof value !== "string" || value.length === 0) ||
        !route || typeof route !== "object" || Array.isArray(route)) {
      throw new Error("delivery_destination_set_invalid");
    }
    let normalizedRoute;
    try {
      normalizedRoute = JSON.parse(canonicalJson(route));
    } catch {
      throw new Error("delivery_destination_set_invalid");
    }
    if (Object.values(normalizedRoute).some((value) =>
      value === null || typeof value === "object" || !["string", "number", "boolean"].includes(typeof value))) {
      throw new Error("delivery_destination_set_invalid");
    }
    return {
      id,
      kind,
      host,
      path,
      writer,
      route: normalizedRoute,
      effects: {
        service: effects.service,
        database: effects.database,
        downtime: effects.downtime,
      },
    };
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const sharedCount = records.filter(({ kind }) => kind === "shared-identity").length;
  const uniqueIds = new Set(records.map(({ id }) => id)).size;
  const uniqueTargets = new Set(records.map(({ host, path }) => `${host}\u0000${path}`)).size;
  if (uniqueIds !== records.length || uniqueTargets !== records.length || sharedCount !== 1) {
    throw new Error("delivery_destination_set_invalid");
  }
  return records;
}

function parseChecksums(checksumBytes) {
  const checksums = new Map();
  for (const line of bytes(checksumBytes, "checksums").toString("utf8").split(/\r?\n/)) {
    if (line.length === 0) continue;
    const match = CHECKSUM_LINE.exec(line);
    if (!match || match[2].startsWith("/") || match[2].split("/").includes("..") || checksums.has(match[2])) {
      throw new Error("delivery_checksums_invalid");
    }
    checksums.set(match[2], match[1]);
  }
  if (checksums.size === 0) throw new Error("delivery_checksums_invalid");
  return checksums;
}

export function renderIphoneManifest(identity, skillSha256) {
  const fields = {
    appVersion: identity?.appVersion,
    appBuildNumber: identity?.manifestAppBuildNumber ?? identity?.appBuildNumber,
    buildId: identity?.buildId,
    buildNumber: identity?.buildNumber,
    sourceCommit: identity?.sourceCommit,
    workflowId: identity?.workflowId,
    startCondition: identity?.startCondition,
    branch: identity?.sourceBranch,
    gitRef: identity?.gitRef,
    scheme: identity?.scheme,
    platform: identity?.platform,
    action: identity?.action,
  };
  if (Object.values(fields).some((value) => typeof value !== "string" || !MANIFEST_TOKEN.test(value)) ||
      !SHA256.test(skillSha256 ?? "")) {
    throw new Error("delivery_iphone_identity_invalid");
  }
  return Buffer.from(`{\n  "appVersion": "${fields.appVersion}",\n  "appBuildNumber": "${fields.appBuildNumber}",\n  "operatingSkill": {\n    "asset": "SurfAceOperatingSkill/SKILL.md",\n    "clientPlatforms": ["ios"],\n    "publication": "app-bundle",\n    "sha256": "${skillSha256}",\n    "sourcePath": "${CANONICAL_SKILL_SOURCE}",\n    "version": "${fields.appVersion}"\n  },\n  "xcodeCloudBuildId": "${fields.buildId}",\n  "xcodeCloudBuildNumber": "${fields.buildNumber}",\n  "xcodeCloudCommit": "${fields.sourceCommit}",\n  "xcodeCloudWorkflowId": "${fields.workflowId}",\n  "xcodeCloudStartCondition": "${fields.startCondition}",\n  "xcodeCloudBranch": "${fields.branch}",\n  "xcodeCloudGitRef": "${fields.gitRef}",\n  "xcodeCloudScheme": "${fields.scheme}",\n  "xcodeCloudPlatform": "${fields.platform}",\n  "xcodeCloudAction": "${fields.action}"\n}\n`);
}

function parseManifest(manifestBytes) {
  try {
    return JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("delivery_manifest_invalid");
  }
}

function verifyDesktopManifest(manifest, identity, skillSha256) {
  const skill = manifest?.operatingSkill;
  const asset = Array.isArray(manifest?.assets)
    ? manifest.assets.find((item) => item?.name === skill?.asset)
    : null;
  if (manifest?.version !== identity.version ||
      manifest?.source?.commit !== identity.sourceCommit ||
      manifest?.source?.tag !== identity.sourceTag ||
      identity.releaseTag !== identity.sourceTag ||
      (identity.toolingCommit && manifest?.tooling?.commit !== identity.toolingCommit) ||
      (identity.toolingTag && manifest?.tooling?.tag !== identity.toolingTag) ||
      skill?.sourcePath !== CANONICAL_SKILL_SOURCE ||
      skill?.version !== identity.version ||
      skill?.publication !== "github-release-asset" ||
      JSON.stringify(skill?.clientPlatforms) !== JSON.stringify(["desktop", "cli"]) ||
      typeof skill?.asset !== "string" ||
      asset?.sha256 !== skillSha256 ||
      skill?.sha256 !== skillSha256 ||
      manifest?.checksums?.[skill?.asset] !== skillSha256) {
    throw new Error("delivery_desktop_manifest_mismatch");
  }
}

function verifyDesktopChecksums(candidate, manifest, manifestBytes, skillSha256) {
  const identity = candidate.identity ?? {};
  const checksumBytes = bytes(candidate.checksumBytes, "checksums");
  const checksums = parseChecksums(checksumBytes);
  const manifestAssetName = requiredString(identity.manifestAssetName, "manifest_asset_name");
  const checksumsAssetName = requiredString(identity.checksumsAssetName, "checksums_asset_name");
  const releaseAssetNames = identity.releaseAssetNames;
  if (checksumsAssetName !== "SHA256SUMS" ||
      !/^[A-Za-z0-9._+-]+-manifest\.json$/.test(manifestAssetName) ||
      !Array.isArray(releaseAssetNames) ||
      releaseAssetNames.some((name) => typeof name !== "string" || name.length === 0 || name.includes("/") || name.includes("\\"))) {
    throw new Error("delivery_release_asset_set_invalid");
  }

  const assetNames = manifest.assets?.map((asset) => asset?.name);
  if (!Array.isArray(assetNames) || assetNames.length === 0 ||
      assetNames.some((name) => typeof name !== "string" || name.length === 0 || name.includes("/") || name.includes("\\")) ||
      new Set(assetNames).size !== assetNames.length || assetNames.includes(manifestAssetName) || assetNames.includes(checksumsAssetName)) {
    throw new Error("delivery_manifest_asset_set_invalid");
  }
  const expectedReleaseAssets = [...assetNames, manifestAssetName, checksumsAssetName].sort();
  if (canonicalJson([...releaseAssetNames].sort()) !== canonicalJson(expectedReleaseAssets)) {
    throw new Error("delivery_release_asset_set_mismatch");
  }
  const expectedChecksumNames = [...assetNames, manifestAssetName].sort();
  if (canonicalJson([...checksums.keys()].sort()) !== canonicalJson(expectedChecksumNames)) {
    throw new Error("delivery_checksums_asset_set_mismatch");
  }
  const manifestChecksums = manifest.checksums;
  if (!manifestChecksums || typeof manifestChecksums !== "object" || Array.isArray(manifestChecksums) ||
      canonicalJson(Object.keys(manifestChecksums).sort()) !== canonicalJson([...assetNames].sort())) {
    throw new Error("delivery_manifest_checksums_mismatch");
  }
  for (const asset of manifest.assets) {
    if (!SHA256.test(asset.sha256 ?? "") ||
        manifestChecksums[asset.name] !== asset.sha256 ||
        checksums.get(asset.name) !== asset.sha256) {
      throw new Error("delivery_checksums_manifest_mismatch");
    }
    const reportedAssetHash = identity.assetSha256ByName?.[asset.name];
    if (reportedAssetHash !== undefined && reportedAssetHash !== asset.sha256) {
      throw new Error("delivery_release_asset_digest_mismatch");
    }
  }
  if (checksums.get(manifestAssetName) !== sha256(manifestBytes) ||
      checksums.get(manifestAssetName) !== identity.manifestAssetSha256) {
    throw new Error("delivery_manifest_checksum_mismatch");
  }
  const skill = manifest.operatingSkill;
  if (checksums.get(skill?.asset) !== skillSha256) throw new Error("delivery_skill_checksum_mismatch");
  return { checksumBytes, checksumSha256: sha256(checksumBytes), manifestAssetName, checksumsAssetName };
}

function verifyIphoneManifest(manifest, identity, skillSha256) {
  const skill = manifest?.operatingSkill;
  const expectedIdentity = {
    appVersion: manifest?.appVersion,
    manifestAppBuildNumber: manifest?.appBuildNumber,
    buildId: manifest?.xcodeCloudBuildId,
    buildNumber: manifest?.xcodeCloudBuildNumber,
    workflowId: manifest?.xcodeCloudWorkflowId,
    sourceCommit: manifest?.xcodeCloudCommit,
    startCondition: manifest?.xcodeCloudStartCondition,
  };
  const deliveryRoute = identity.deliveryRoute;
  const hasAppStoreBuild = typeof identity.appStoreBuildId === "string" && identity.appStoreBuildId.length > 0;
  if (manifest?.appVersion !== identity.appVersion ||
      manifest?.appBuildNumber !== identity.manifestAppBuildNumber ||
      manifest?.xcodeCloudBuildId !== identity.buildId ||
      manifest?.xcodeCloudBuildNumber !== identity.buildNumber ||
      manifest?.xcodeCloudWorkflowId !== identity.workflowId ||
      manifest?.xcodeCloudCommit !== identity.sourceCommit ||
      manifest?.xcodeCloudStartCondition !== identity.startCondition ||
      manifest?.xcodeCloudBranch !== identity.sourceBranch ||
      manifest?.xcodeCloudGitRef !== identity.gitRef ||
      manifest?.xcodeCloudScheme !== identity.scheme ||
      manifest?.xcodeCloudPlatform !== identity.platform ||
      manifest?.xcodeCloudAction !== identity.action ||
      Object.values(expectedIdentity).some((value) => typeof value !== "string" || value.length === 0) ||
      identity.completionStatus !== "SUCCEEDED" ||
      identity.isPullRequestBuild !== false ||
      identity.sourceBranch !== "main" ||
      identity.scheme !== "SurfAce" ||
      identity.platform !== "iOS" ||
      identity.action !== "archive" ||
      !["xcode-cloud-archive", "source-commit-fallback"].includes(deliveryRoute) ||
      (deliveryRoute === "xcode-cloud-archive" && !SHA256.test(identity.artifactSha256 ?? "")) ||
      (deliveryRoute === "source-commit-fallback" && identity.artifactSha256 != null) ||
      (hasAppStoreBuild &&
        (!identity.appStoreAppVersion || !identity.appStoreBuildNumber ||
         identity.appStoreAppVersion !== identity.appVersion ||
         identity.appStoreBuildNumber !== identity.appBuildNumber)) ||
      (!hasAppStoreBuild && identity.appBuildNumber !== identity.manifestAppBuildNumber) ||
      skill?.asset !== "SurfAceOperatingSkill/SKILL.md" ||
      skill?.sourcePath !== CANONICAL_SKILL_SOURCE ||
      skill?.version !== identity.appVersion ||
      skill?.publication !== "app-bundle" ||
      JSON.stringify(skill?.clientPlatforms) !== JSON.stringify(["ios"]) ||
      skill?.sha256 !== skillSha256) {
    throw new Error("delivery_iphone_manifest_mismatch");
  }
}

export async function verifyDeliveryCandidate(candidate, { destinations, sourceReader }) {
  const channel = requiredString(candidate?.channel, "channel");
  if (!CHANNELS.has(channel)) throw new Error("delivery_channel_invalid");
  const destinationRecords = normalizeDestinationRecords(destinations);
  if (!sourceReader || typeof sourceReader.readFileAtCommit !== "function") {
    throw new Error("delivery_source_reader_missing");
  }

  const identity = candidate.identity ?? {};
  if (identity.eventKey !== undefined && !SHA256.test(identity.eventKey)) {
    throw new Error("delivery_event_key_invalid");
  }
  const releaseOrBuildId = requiredString(identity.releaseOrBuildId, "release_or_build_id");
  const sourceCommit = requiredString(identity.sourceCommit, "source_commit");
  if (!COMMIT.test(sourceCommit)) throw new Error("delivery_source_commit_invalid");
  if (channel === "desktop-cli-release" &&
      (!COMMIT.test(identity.toolingCommit ?? "") ||
       typeof identity.sourceTag !== "string" || typeof identity.toolingTag !== "string")) {
    throw new Error("delivery_release_identity_invalid");
  }
  if (channel === "iphone-build" && releaseOrBuildId !== identity.buildId) {
    throw new Error("delivery_build_identity_invalid");
  }
  if (identity.evidenceFailure === "delivery_iphone_archive_evidence_invalid" ||
      identity.evidenceFailure === "delivery_iphone_source_evidence_invalid") {
    throw new Error(identity.evidenceFailure);
  }
  const manifestBytes = bytes(candidate.manifestBytes, "manifest");
  const skillBytes = bytes(candidate.skillBytes, "skill");
  const manifest = parseManifest(manifestBytes);
  const canonicalSkillBytes = bytes(
    await sourceReader.readFileAtCommit(sourceCommit, CANONICAL_SKILL_SOURCE),
    "canonical_skill",
  );
  const skillSha256 = sha256(skillBytes);
  const manifestSha256 = sha256(manifestBytes);
  const artifactSha256 = identity.artifactSha256 ?? null;
  if (artifactSha256 !== null && !SHA256.test(artifactSha256)) throw new Error("delivery_artifact_digest_invalid");
  if (skillSha256 !== sha256(canonicalSkillBytes)) throw new Error("delivery_skill_source_mismatch");

  let checksumEvidence = null;
  if (channel === "desktop-cli-release") {
    const version = requiredString(identity.version, "version");
    verifyDesktopManifest(manifest, { ...identity, version, sourceCommit }, skillSha256);
    if (!COMMIT.test(identity.toolingCommit ?? "") ||
        typeof identity.sourceTag !== "string" || typeof identity.toolingTag !== "string" ||
        identity.sourceTag !== manifest.source.tag || identity.toolingTag !== manifest.tooling.tag) {
      throw new Error("delivery_release_identity_mismatch");
    }
    if (typeof sourceReader.readTagCommit !== "function") throw new Error("delivery_tag_reader_missing");
    const [sourceTagCommit, toolingTagCommit] = await Promise.all([
      sourceReader.readTagCommit(identity.sourceTag),
      sourceReader.readTagCommit(identity.toolingTag),
    ]);
    if (sourceTagCommit !== identity.sourceCommit || toolingTagCommit !== identity.toolingCommit) {
      throw new Error("delivery_release_tag_target_mismatch");
    }
    checksumEvidence = verifyDesktopChecksums(candidate, manifest, manifestBytes, skillSha256);
    if (identity.artifactSha256 !== checksumEvidence.checksumSha256) {
      throw new Error("delivery_release_integrity_identity_mismatch");
    }
  } else {
    verifyIphoneManifest(manifest, { ...identity, sourceCommit }, skillSha256);
    if (!SHA256.test(identity.buildRecordSha256 ?? "")) throw new Error("delivery_build_record_digest_invalid");
  }

  const destinationSetSha256 = sha256(canonicalJson(destinationRecords));
  const destinationMapSha256 = destinationSetSha256;
  const toolingCommit = identity.toolingCommit ?? null;
  if (toolingCommit !== null && !COMMIT.test(toolingCommit)) throw new Error("delivery_tooling_commit_invalid");
  const envelope = {
    schemaVersion: 1,
    channel,
    releaseOrBuildId,
    eventKey: identity.eventKey ?? null,
    sourceCommit,
    toolingCommit,
    version: channel === "desktop-cli-release" ? identity.version : identity.appVersion,
    appBuildNumber: channel === "iphone-build" ? identity.appBuildNumber : null,
    buildIdentity: {
      releaseOrBuildId,
      sourceCommit,
      ...(toolingCommit ? { toolingCommit } : {}),
      ...(channel === "desktop-cli-release" ? {
        sourceTag: identity.sourceTag,
        toolingTag: identity.toolingTag,
      } : {}),
      ...(channel === "iphone-build" ? {
        buildId: identity.buildId,
        buildNumber: identity.buildNumber,
        workflowId: identity.workflowId,
        deliveryRoute: identity.deliveryRoute,
        manifestAppBuildNumber: identity.manifestAppBuildNumber,
        ...(identity.appStoreBuildId ? { appStoreBuildId: identity.appStoreBuildId } : {}),
        ...(identity.appStoreAppVersion ? { appStoreAppVersion: identity.appStoreAppVersion } : {}),
        ...(identity.appStoreBuildNumber ? { appStoreBuildNumber: identity.appStoreBuildNumber } : {}),
        startCondition: manifest.xcodeCloudStartCondition,
        branch: manifest.xcodeCloudBranch,
        gitRef: manifest.xcodeCloudGitRef,
        scheme: manifest.xcodeCloudScheme,
        platform: manifest.xcodeCloudPlatform,
        action: manifest.xcodeCloudAction,
      } : {}),
    },
    skillSourcePath: CANONICAL_SKILL_SOURCE,
    skillAssetName: manifest.operatingSkill.asset,
    skillSha256,
    manifestSha256: sha256(manifestBytes),
    artifactSha256,
    buildRecordSha256: identity.buildRecordSha256 ?? null,
    integrityFileSha256: checksumEvidence?.checksumSha256 ?? null,
    destinationSetSha256,
    destinationMapSha256,
  };
  return {
    envelope,
    envelopeId: sha256(canonicalJson(envelope)),
    manifest,
    manifestBytes,
    skillBytes,
    skillSha256,
    checksumBytes: checksumEvidence?.checksumBytes ?? null,
    destinations: destinationRecords,
  };
}

function snapshotDigest(snapshot) {
  if (snapshot?.available !== true) throw new Error("delivery_destination_unavailable");
  if (snapshot.bytes === null) return null;
  return sha256(bytes(snapshot.bytes, "destination_snapshot"));
}

function approvalMatches(approval, plan) {
  return approval?.status === "ruled" &&
    approval?.decision === "approve" &&
    typeof approval?.requestRef === "string" && approval.requestRef.length > 0 &&
    typeof approval?.ruling?.principal === "string" &&
    approval.ruling.principal === approval.ruling.onBehalfOf &&
    approval?.envelopeId === plan.envelopeId &&
    approval?.destinationSetSha256 === plan.destinationSetSha256 &&
    approval?.destinationMapSha256 === plan.destinationMapSha256 &&
    approval?.planSha256 === plan.planSha256;
}

function approvalMatchesPendingPlan(approval, plan) {
  return approval?.status === "pending" &&
    approval?.envelopeId === plan.envelopeId &&
    approval?.destinationSetSha256 === plan.destinationSetSha256 &&
    approval?.destinationMapSha256 === plan.destinationMapSha256 &&
    approval?.planSha256 === plan.planSha256;
}

async function readCurrentState(targets, targetId) {
  const current = await targets.read(targetId);
  return { sha256: snapshotDigest(current), mode: current.mode ?? null };
}

function targetMode(snapshot, destination) {
  if (destination.kind === "shared-identity") return null;
  return snapshot.priorMode ?? 0o644;
}

async function rollbackCommitted({ targets, journal, envelopeId, committed, skillSha256 }) {
  const receipts = [];
  let unresolved = false;
  for (const item of [...committed].reverse()) {
    try {
      const current = await readCurrentState(targets, item.targetId);
      if (current.sha256 === item.priorSha256 && current.mode === item.priorMode) {
        receipts.push({ targetId: item.targetId, state: "already_restored", sha256: current.sha256, mode: current.mode });
        continue;
      }
      if (current.sha256 !== skillSha256 || current.mode !== item.targetMode) {
        unresolved = true;
        receipts.push({ targetId: item.targetId, state: "conflict", sha256: current.sha256, mode: current.mode });
        continue;
      }
      await targets.restore(item.targetId, item.backupBytes, {
        expectedCurrentSha256: skillSha256,
        expectedCurrentMode: item.targetMode,
        priorMode: item.priorMode,
      });
      const restored = await readCurrentState(targets, item.targetId);
      if (restored.sha256 !== item.priorSha256 || restored.mode !== item.priorMode) {
        unresolved = true;
        receipts.push({ targetId: item.targetId, state: "restore_mismatch", sha256: restored.sha256, mode: restored.mode });
        continue;
      }
      receipts.push({ targetId: item.targetId, state: "restored", sha256: restored.sha256, mode: restored.mode });
    } catch {
      unresolved = true;
      receipts.push({ targetId: item.targetId, state: "restore_unknown" });
    }
  }
  try {
    await journal.recordRollback(envelopeId, receipts, { unresolved });
  } catch {
    unresolved = true;
    receipts.push({ state: "rollback_receipt_unavailable" });
  }
  return { receipts, unresolved };
}

async function recoverInterruptedTransaction(entry, { targets, journal }) {
  const envelopeId = entry?.envelopeId;
  const plan = entry?.plan;
  const skillSha256 = plan?.envelope?.skillSha256;
  if (typeof envelopeId !== "string" || !Array.isArray(plan?.snapshots) || !SHA256.test(skillSha256 ?? "")) {
    await journal.recordFailure(envelopeId ?? "unknown", {
      code: "delivery_interrupted_journal_invalid",
      status: "unresolved",
      unresolved: true,
    });
    return { status: "unresolved", envelopeId, code: "delivery_interrupted_journal_invalid" };
  }

  const receipts = [];
  let unresolved = false;
  for (const snapshot of [...plan.snapshots].reverse()) {
    try {
      const current = await readCurrentState(targets, snapshot.targetId);
      if (current.sha256 === snapshot.priorSha256 && current.mode === snapshot.priorMode) {
        receipts.push({ targetId: snapshot.targetId, state: "prior_state_confirmed", sha256: current.sha256, mode: current.mode });
        continue;
      }
      if (current.sha256 !== skillSha256 || current.mode !== snapshot.targetMode) {
        unresolved = true;
        receipts.push({ targetId: snapshot.targetId, state: "conflict", sha256: current.sha256, mode: current.mode });
        continue;
      }
      if (snapshot.priorSha256 === skillSha256) {
        receipts.push({ targetId: snapshot.targetId, state: "desired_state_was_prior_state", sha256: current.sha256, mode: current.mode });
        continue;
      }
      const previousBytes = await journal.readBackup(envelopeId, snapshot.targetId, snapshot.backupRef);
      if (snapshot.priorSha256 === null ? previousBytes !== null : sha256(bytes(previousBytes, "backup")) !== snapshot.priorSha256) {
        unresolved = true;
        receipts.push({ targetId: snapshot.targetId, state: "backup_missing_or_mismatched" });
        continue;
      }
      await targets.restore(snapshot.targetId, previousBytes, {
        expectedCurrentSha256: skillSha256,
        expectedCurrentMode: snapshot.targetMode,
        priorMode: snapshot.priorMode,
      });
      const restored = await readCurrentState(targets, snapshot.targetId);
      if (restored.sha256 !== snapshot.priorSha256 || restored.mode !== snapshot.priorMode) {
        unresolved = true;
        receipts.push({ targetId: snapshot.targetId, state: "restore_mismatch", sha256: restored.sha256, mode: restored.mode });
        continue;
      }
      receipts.push({ targetId: snapshot.targetId, state: "restored", sha256: restored.sha256, mode: restored.mode });
    } catch {
      unresolved = true;
      receipts.push({ targetId: snapshot.targetId, state: "recovery_unknown" });
    }
  }

  try {
    await journal.recordRollback(envelopeId, receipts, { unresolved, recovery: true });
  } catch {
    unresolved = true;
    receipts.push({ state: "recovery_receipt_unavailable" });
  }
  const status = unresolved ? "unresolved" : "rolled_back";
  try {
    await journal.recordFailure(envelopeId, {
      code: unresolved ? "delivery_interrupted_recovery_unresolved" : "delivery_interrupted_recovered",
      status,
      unresolved,
      rollback: { receipts, unresolved },
    });
  } catch {
    return { status: "unresolved", envelopeId, code: "delivery_recovery_receipt_unavailable" };
  }
  return { status, envelopeId };
}

export async function runSkillDeliveryConsumer({
  enabled = false,
  sources,
  sourceReader,
  destinations,
  initialHighWater,
  targets,
  approvals,
  journal,
}) {
  if (enabled !== true) return { status: "disabled", processed: 0 };
  // Readers, target writers, approval lookup, and durable receipts are supplied
  // separately from this product-level consumer. Readers are read-only; target
  // adapters provide stage/commit/restore semantics; approvals bind to one exact
  // envelope and destination set; and the journal retains plans and backup bytes.
  if (!Array.isArray(sources) || sources.length === 0 ||
      !targets || !approvals || !journal ||
      typeof targets.read !== "function" ||
      typeof targets.stage !== "function" ||
      typeof targets.discardStage !== "function" ||
      typeof targets.commit !== "function" ||
      typeof targets.restore !== "function" ||
      typeof approvals.read !== "function" ||
      typeof approvals.request !== "function" ||
      ["read", "readHighWater", "initializeHighWater", "listPublishing", "listTerminalEventKeys", "readBackup", "saveBackup", "recordBlocked", "recordPending", "recordPublishing", "recordTargetReceipt", "recordRollback", "recordFailure", "recordNoChange", "recordComplete"]
        .some((method) => typeof journal[method] !== "function") ||
      sources.some((source) => typeof source?.listCandidates !== "function") ||
      typeof sourceReader?.compareCommits !== "function") {
    throw new Error("delivery_adapters_missing");
  }
  const destinationRecords = normalizeDestinationRecords(destinations);

  let highWater = await journal.readHighWater();
  if (!highWater) {
    if (!COMMIT.test(initialHighWater?.sourceCommit ?? "") || !SHA256.test(initialHighWater?.skillSha256 ?? "")) {
      throw new Error("delivery_high_water_missing");
    }
    const baselineBytes = bytes(
      await sourceReader.readFileAtCommit(initialHighWater.sourceCommit, CANONICAL_SKILL_SOURCE),
      "high_water_skill",
    );
    if (sha256(baselineBytes) !== initialHighWater.skillSha256) throw new Error("delivery_high_water_mismatch");
    await journal.initializeHighWater(initialHighWater);
    highWater = initialHighWater;
  }
  if (!COMMIT.test(highWater?.sourceCommit ?? "") || !SHA256.test(highWater?.skillSha256 ?? "")) {
    throw new Error("delivery_high_water_invalid");
  }

  const results = [];
  const recoveredEnvelopeIds = new Set();
  const terminalEventKeys = new Set(await journal.listTerminalEventKeys());
  for (const entry of await journal.listPublishing()) {
    const recovery = await recoverInterruptedTransaction(entry, { targets, journal });
    if (recovery.envelopeId) recoveredEnvelopeIds.add(recovery.envelopeId);
    results.push(recovery);
  }
  for (const source of sources) {
    const candidates = await source.listCandidates({ terminalEventKeys: [...terminalEventKeys] });
    for (const candidate of candidates) {
      const eventKey = candidate?.identity?.eventKey;
      if (typeof eventKey === "string" && terminalEventKeys.has(eventKey)) continue;
      let verified;
      try {
        verified = await verifyDeliveryCandidate(candidate, { destinations: destinationRecords, sourceReader });
      } catch (error) {
        const rejectedId = rejectedCandidateId(candidate);
        const terminal = isTerminalCandidateError(error) && typeof eventKey === "string";
        await journal.recordBlocked(rejectedId, {
          reason: error.message,
          channel: candidate?.channel ?? null,
          releaseOrBuildId: candidate?.identity?.releaseOrBuildId ?? null,
          terminal,
          terminalEventKey: terminal ? eventKey : null,
        });
        if (terminal) terminalEventKeys.add(eventKey);
        results.push({ status: "rejected", code: error.message });
        continue;
      }

      const { envelope, envelopeId, destinations: resolvedTargets, skillBytes, skillSha256 } = verified;
      if (recoveredEnvelopeIds.has(envelopeId)) continue;
      const prior = await journal.read(envelopeId);
      if (prior?.status === "complete" || prior?.status === "no_change") {
        results.push({ status: "already_complete", envelopeId });
        continue;
      }
      if (prior?.status === "unresolved") {
        results.push({ status: "unresolved", envelopeId, code: "delivery_previous_attempt_unresolved" });
        if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
        continue;
      }

      let sourceOrder;
      try {
        sourceOrder = await sourceReader.compareCommits(highWater.sourceCommit, envelope.sourceCommit);
      } catch (error) {
        await journal.recordBlocked(envelopeId, {
          reason: "delivery_source_order_unknown",
          detail: error.message,
          highWaterSourceCommit: highWater.sourceCommit,
          candidateSourceCommit: envelope.sourceCommit,
        });
        results.push({ status: "blocked", envelopeId, code: "delivery_source_order_unknown" });
        continue;
      }
      if (sourceOrder === "identical" && skillSha256 !== highWater.skillSha256) {
        await journal.recordBlocked(envelopeId, {
          reason: "delivery_source_commit_content_mismatch",
          highWaterSourceCommit: highWater.sourceCommit,
          candidateSourceCommit: envelope.sourceCommit,
          terminal: true,
          terminalEventKey: envelope.eventKey,
        });
        if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
        results.push({ status: "blocked", envelopeId, code: "delivery_source_commit_content_mismatch" });
        continue;
      }
      if (sourceOrder === "behind") {
        await journal.recordBlocked(envelopeId, {
          reason: "delivery_older_skill_rollback",
          highWaterSourceCommit: highWater.sourceCommit,
          candidateSourceCommit: envelope.sourceCommit,
          sourceOrder,
          terminal: true,
          terminalEventKey: envelope.eventKey,
        });
        if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
        results.push({ status: "blocked", envelopeId, code: "delivery_older_skill_rollback" });
        continue;
      }
      if (sourceOrder !== "identical" && sourceOrder !== "ahead") {
        await journal.recordBlocked(envelopeId, {
          reason: "delivery_source_order_unknown",
          highWaterSourceCommit: highWater.sourceCommit,
          candidateSourceCommit: envelope.sourceCommit,
          sourceOrder,
        });
        results.push({ status: "blocked", envelopeId, code: "delivery_source_order_unknown" });
        continue;
      }

      let snapshots = [];
      let plan;
      let planSha256;
      let approval;
      let approvedPendingPlan = false;
      if (prior?.status === "pending") {
        plan = prior.plan;
        planSha256 = prior.planSha256;
        const { planSha256: storedHash, ...storedBody } = plan ?? {};
        const storedSnapshots = plan?.snapshots;
        const expectedDestinationIds = resolvedTargets.map(({ id }) => id);
        if (storedHash !== planSha256 || sha256(canonicalJson(storedBody)) !== storedHash ||
            plan?.envelopeId !== envelopeId || canonicalJson(plan?.envelope) !== canonicalJson(envelope) ||
            canonicalJson(plan?.destinationRecords) !== canonicalJson(resolvedTargets) ||
            !Array.isArray(storedSnapshots) ||
            canonicalJson(storedSnapshots.map(({ targetId }) => targetId)) !== canonicalJson(expectedDestinationIds)) {
          await journal.recordBlocked(envelopeId, {
            reason: "pending_approval_plan_mismatch",
            terminal: true,
            terminalEventKey: envelope.eventKey,
          });
          if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
          results.push({ status: "blocked", envelopeId, code: "approval_mismatch" });
          continue;
        }
        approval = await approvals.read(envelopeId, planSha256);
        if (!approval) {
          await approvals.request(plan, { idempotencyKey: `${envelopeId}:${planSha256}` });
          results.push({ status: "awaiting_approval", envelopeId, planSha256 });
          continue;
        }
        if (approval.status === "pending" && approvalMatchesPendingPlan(approval, plan)) {
          results.push({ status: "awaiting_approval", envelopeId, planSha256 });
          continue;
        }
        if (approval.status === "ruled" && approval.decision !== "approve") {
          await journal.recordBlocked(envelopeId, {
            reason: "approval_declined",
            planSha256,
            terminal: true,
            terminalEventKey: envelope.eventKey,
          });
          if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
          results.push({ status: "blocked", envelopeId, code: "approval_declined" });
          continue;
        }
        if (!approvalMatches(approval, plan)) {
          await journal.recordBlocked(envelopeId, {
            reason: "approval_mismatch",
            planSha256,
            terminal: true,
            terminalEventKey: envelope.eventKey,
          });
          if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
          results.push({ status: "blocked", envelopeId, code: "approval_mismatch" });
          continue;
        }
        try {
          for (const stored of storedSnapshots) {
            const destination = resolvedTargets.find(({ id }) => id === stored.targetId);
            const backupBytes = await journal.readBackup(envelopeId, stored.targetId, stored.backupRef);
            if (stored.priorSha256 === null
                ? backupBytes !== null
                : sha256(bytes(backupBytes, "backup")) !== stored.priorSha256) {
              throw new Error("delivery_backup_verification_failed");
            }
            snapshots.push({ ...stored, backupBytes, targetMode: targetMode(stored, destination) });
          }
        } catch (error) {
          await journal.recordFailure(envelopeId, {
            code: error.message,
            status: "unresolved",
            unresolved: true,
            terminalEventKey: envelope.eventKey,
          });
          if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
          results.push({ status: "unresolved", envelopeId, code: error.message });
          continue;
        }
        approvedPendingPlan = true;
      } else {
        try {
          for (const { id: targetId, ...destination } of resolvedTargets) {
            const snapshot = await targets.read(targetId);
            const priorSha256 = snapshotDigest(snapshot);
            const priorMode = snapshot.mode ?? null;
            snapshots.push({
              targetId,
              priorSha256,
              priorMode,
              targetMode: targetMode({ priorMode }, { ...destination, id: targetId }),
              snapshotBytes: snapshot.bytes,
            });
          }
        } catch (error) {
          await journal.recordBlocked(envelopeId, { reason: error.message });
          results.push({ status: "blocked", envelopeId, code: error.message });
          continue;
        }

        if (snapshots.every(({ priorSha256 }) => priorSha256 === skillSha256)) {
          const receipts = snapshots.map(({ targetId, priorSha256, priorMode }) => ({
            envelopeId,
            targetId,
            priorSha256,
            priorMode,
            finalSha256: priorSha256,
            finalMode: priorMode,
            state: "already_current",
          }));
          await journal.recordNoChange(envelopeId, {
            envelope,
            reason: "all_configured_destinations_already_match",
            targetReceipts: receipts,
            highWater: { sourceCommit: envelope.sourceCommit, skillSha256 },
            terminalEventKey: envelope.eventKey,
          });
          if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
          highWater = { sourceCommit: envelope.sourceCommit, skillSha256 };
          results.push({ status: "no_change", envelopeId, targetReceipts: receipts });
          continue;
        }

        try {
          for (const snapshot of snapshots) {
            const backupKey = `${envelopeId}:${snapshot.targetId}:${snapshot.priorSha256 ?? "absent"}:${snapshot.priorMode ?? "none"}`;
            snapshot.backupRef = await journal.saveBackup(envelopeId, snapshot.targetId, snapshot.snapshotBytes, { key: backupKey });
            snapshot.backupBytes = await journal.readBackup(envelopeId, snapshot.targetId, snapshot.backupRef);
            if (snapshot.priorSha256 === null
                ? snapshot.backupBytes !== null
                : sha256(bytes(snapshot.backupBytes, "backup")) !== snapshot.priorSha256) {
              throw new Error("delivery_backup_verification_failed");
            }
            delete snapshot.snapshotBytes;
          }
        } catch (error) {
          await journal.recordBlocked(envelopeId, { reason: error.message });
          results.push({ status: "blocked", envelopeId, code: error.message });
          continue;
        }

        const planBody = {
          envelopeId,
          envelope,
          destinationIds: resolvedTargets.map(({ id }) => id),
          destinationRecords: resolvedTargets,
          destinationSetSha256: envelope.destinationSetSha256,
          destinationMapSha256: envelope.destinationMapSha256,
          snapshots: snapshots.map(({ targetId, priorSha256, priorMode, targetMode, backupRef }) => ({
            targetId, priorSha256, priorMode, targetMode, backupRef,
          })),
          rollbackPlan: "restore prior bytes and modes in reverse commit order; verify every restored hash, mode, or absence",
        };
        planSha256 = sha256(canonicalJson(planBody));
        plan = { ...planBody, planSha256 };
        approval = await approvals.read(envelopeId, planSha256);
      }

      if (!approvedPendingPlan) {
        if (!approval) {
          await approvals.request(plan, { idempotencyKey: `${envelopeId}:${planSha256}` });
          await journal.recordPending(envelopeId, { envelope, plan, planSha256, terminalEventKey: envelope.eventKey });
          results.push({ status: "awaiting_approval", envelopeId, planSha256 });
          continue;
        }
        if (approval.status === "pending" && approvalMatchesPendingPlan(approval, plan)) {
          await journal.recordPending(envelopeId, { envelope, plan, planSha256, terminalEventKey: envelope.eventKey });
          results.push({ status: "awaiting_approval", envelopeId, planSha256 });
          continue;
        }
        if (approval.status === "pending" && approval.envelopeId === envelopeId &&
            approval.destinationSetSha256 === plan.destinationSetSha256 &&
            approval.destinationMapSha256 === plan.destinationMapSha256 &&
            approval.planSha256 !== planSha256) {
          await approvals.request(plan, { idempotencyKey: `${envelopeId}:${planSha256}` });
          await journal.recordPending(envelopeId, { envelope, plan, planSha256, terminalEventKey: envelope.eventKey });
          results.push({ status: "awaiting_approval", envelopeId, planSha256 });
          continue;
        }
        if (approval.status === "ruled" && approval.decision !== "approve") {
          await journal.recordBlocked(envelopeId, {
            reason: "approval_declined", planSha256, terminal: true, terminalEventKey: envelope.eventKey,
          });
          if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
          results.push({ status: "blocked", envelopeId, code: "approval_declined" });
          continue;
        }
        if (approval?.envelopeId === envelopeId &&
            approval?.destinationSetSha256 === plan.destinationSetSha256 &&
            approval?.destinationMapSha256 === plan.destinationMapSha256 &&
            approval?.planSha256 !== planSha256) {
          await approvals.request(plan, { idempotencyKey: `${envelopeId}:${planSha256}` });
          await journal.recordPending(envelopeId, { envelope, plan, planSha256, terminalEventKey: envelope.eventKey });
          results.push({ status: "awaiting_approval", envelopeId, planSha256 });
          continue;
        }
        if (!approvalMatches(approval, plan)) {
          await journal.recordBlocked(envelopeId, {
            reason: "approval_mismatch", planSha256, terminal: true, terminalEventKey: envelope.eventKey,
          });
          if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
          results.push({ status: "blocked", envelopeId, code: "approval_mismatch" });
          continue;
        }
      }

      const staged = [];
      try {
        for (const snapshot of snapshots) {
          const current = await readCurrentState(targets, snapshot.targetId);
          if (current.sha256 !== snapshot.priorSha256 || current.mode !== snapshot.priorMode) {
            throw new Error("delivery_destination_changed_after_approval");
          }
        }
        for (const { targetId } of snapshots) {
          const snapshot = snapshots.find((item) => item.targetId === targetId);
          const stage = await targets.stage(targetId, skillBytes, envelopeId, { mode: snapshot.targetMode });
          if (stage?.sha256 !== skillSha256) throw new Error("delivery_stage_hash_mismatch");
          staged.push({ targetId, stage });
        }
      } catch (error) {
        for (const { targetId, stage } of staged.reverse()) {
          try { await targets.discardStage(targetId, stage); } catch { /* staging cleanup remains in the journal */ }
        }
        await journal.recordBlocked(envelopeId, { reason: error.message, planSha256 });
        results.push({ status: "blocked", envelopeId, code: error.message });
        continue;
      }

      try {
        await journal.recordPublishing(envelopeId, { envelope, plan, planSha256, terminalEventKey: envelope.eventKey });
      } catch {
        for (const { targetId, stage } of staged.reverse()) {
          try { await targets.discardStage(targetId, stage); } catch { /* publication did not start; stage cleanup is auxiliary */ }
        }
        results.push({ status: "blocked", envelopeId, code: "delivery_journal_publish_start_failed" });
        continue;
      }

      const committed = [];
      let failure = null;
      for (const snapshot of snapshots) {
        const stage = staged.find((item) => item.targetId === snapshot.targetId)?.stage;
        try {
          await targets.commit(snapshot.targetId, stage, {
            expectedPriorSha256: snapshot.priorSha256,
            expectedPriorMode: snapshot.priorMode,
            targetMode: snapshot.targetMode,
          });
        } catch {
          // Readback below distinguishes a completed write from an uncertain result.
        }
        let currentHash;
        let current;
        try {
          current = await readCurrentState(targets, snapshot.targetId);
          currentHash = current.sha256;
          if (currentHash === skillSha256 && current.mode !== snapshot.targetMode) {
            await journal.recordTargetReceipt(envelopeId, {
              envelopeId,
              targetId: snapshot.targetId,
              priorSha256: snapshot.priorSha256,
              priorMode: snapshot.priorMode,
              targetMode: snapshot.targetMode,
              backupRef: snapshot.backupRef,
              stagedSha256: skillSha256,
              finalSha256: currentHash,
              finalMode: current.mode,
              state: "mode_mismatch",
            });
            failure = { code: "delivery_write_readback_mode_mismatch", unresolved: true };
            break;
          }
        } catch {
          try {
            await journal.recordTargetReceipt(envelopeId, {
              envelopeId,
              targetId: snapshot.targetId,
              priorSha256: snapshot.priorSha256,
              priorMode: snapshot.priorMode,
              targetMode: snapshot.targetMode,
              backupRef: snapshot.backupRef,
              stagedSha256: skillSha256,
              state: "readback_unknown",
            });
          } catch { /* the unresolved state is also captured in the transaction failure below */ }
          failure = { code: "delivery_write_readback_unknown", unresolved: true };
          break;
        }
        if (currentHash !== skillSha256) {
          try {
            await journal.recordTargetReceipt(envelopeId, {
              envelopeId,
              targetId: snapshot.targetId,
              priorSha256: snapshot.priorSha256,
              priorMode: snapshot.priorMode,
              targetMode: snapshot.targetMode,
              backupRef: snapshot.backupRef,
              stagedSha256: skillSha256,
              finalSha256: currentHash,
              finalMode: current.mode,
              state: currentHash === snapshot.priorSha256 ? "not_committed" : "conflict",
            });
          } catch { /* the unresolved state is also captured in the transaction failure below */ }
          failure = currentHash === snapshot.priorSha256
            ? { code: "delivery_write_not_committed", unresolved: false }
            : { code: "delivery_write_readback_conflict", unresolved: true };
          break;
        }
        const receipt = {
          envelopeId,
          targetId: snapshot.targetId,
          priorSha256: snapshot.priorSha256,
          priorMode: snapshot.priorMode,
          targetMode: snapshot.targetMode,
          backupRef: snapshot.backupRef,
          stagedSha256: skillSha256,
          finalSha256: currentHash,
          finalMode: current.mode,
        };
        committed.push({ ...snapshot, receipt });
        try {
          await journal.recordTargetReceipt(envelopeId, receipt);
        } catch {
          failure = { code: "delivery_receipt_record_failed", unresolved: true };
          break;
        }
      }

      if (failure) {
        const rollback = await rollbackCommitted({ targets, journal, envelopeId, committed, skillSha256 });
        for (const { targetId, stage } of staged.reverse()) {
          try { await targets.discardStage(targetId, stage); } catch { /* retain the unresolved stage reference in the failure receipt */ }
        }
        const unresolved = rollback.unresolved || failure.unresolved;
        try {
          await journal.recordFailure(envelopeId, {
            ...failure,
            rollback,
            status: unresolved ? "unresolved" : "rolled_back",
            terminalEventKey: envelope.eventKey,
          });
          if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
        } catch {
          results.push({ status: "unresolved", envelopeId, code: "delivery_failure_receipt_unavailable" });
          continue;
        }
        results.push({ status: unresolved ? "unresolved" : "rolled_back", envelopeId, code: failure.code });
        continue;
      }

      for (const { targetId, stage } of staged.reverse()) {
        try { await targets.discardStage(targetId, stage); } catch { /* final target receipts remain authoritative; stage cleanup is auxiliary */ }
      }

      try {
        await journal.recordComplete(envelopeId, {
          envelope,
          targetReceipts: committed.map(({ receipt }) => receipt),
          highWater: { sourceCommit: envelope.sourceCommit, skillSha256 },
          terminalEventKey: envelope.eventKey,
        });
        if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
        highWater = { sourceCommit: envelope.sourceCommit, skillSha256 };
      } catch {
        const rollback = await rollbackCommitted({ targets, journal, envelopeId, committed, skillSha256 });
        await journal.recordFailure(envelopeId, {
          code: "delivery_completion_receipt_failed",
          unresolved: true,
          rollback,
          status: "unresolved",
          terminalEventKey: envelope.eventKey,
        });
        if (envelope.eventKey) terminalEventKeys.add(envelope.eventKey);
        results.push({ status: "unresolved", envelopeId, code: "delivery_completion_receipt_failed" });
        continue;
      }
      results.push({ status: "complete", envelopeId });
    }
  }
  return { status: "processed", processed: results.length, results };
}
