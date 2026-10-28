import { createHash } from "node:crypto";

export const CANONICAL_SKILL_SOURCE = "integrations/tightbeam/skills/surf-ace/SKILL.md";

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CHANNELS = new Set(["desktop-cli-release", "iphone-build"]);
const DESTINATION_KINDS = new Set(["shared-identity", "standalone-skill"]);

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
    skillSha256: digestIfBytes(candidate?.skillBytes),
    artifactProofSha256: digestIfBytes(candidate?.artifactProofBytes),
  })));
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
  if (!Array.isArray(destinations) || destinations.length !== 5) {
    throw new Error("delivery_destination_set_invalid");
  }
  const records = destinations.map((destination) => {
    const { id, kind, host, path, writer, effects } = destination ?? {};
    if (typeof id !== "string" || id.length === 0 ||
        !DESTINATION_KINDS.has(kind) ||
        typeof host !== "string" || host.length === 0 ||
        typeof path !== "string" || !path.startsWith("/") ||
        writer !== (kind === "shared-identity" ? "supported-identity-cli" : "existing-ssh") ||
        !effects || typeof effects !== "object" ||
        [effects.service, effects.database, effects.downtime].some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error("delivery_destination_set_invalid");
    }
    return {
      id,
      kind,
      host,
      path,
      writer,
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
  if (uniqueIds !== 5 || uniqueTargets !== 5 || sharedCount !== 1) {
    throw new Error("delivery_destination_set_invalid");
  }
  return records;
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

function verifyIphoneManifest(manifest, identity, skillSha256) {
  const skill = manifest?.operatingSkill;
  const expectedIdentity = {
    appVersion: manifest?.appVersion,
    appBuildNumber: manifest?.appBuildNumber,
    buildId: manifest?.xcodeCloudBuildId,
    buildNumber: manifest?.xcodeCloudBuildNumber,
    workflowId: manifest?.xcodeCloudWorkflowId,
    sourceCommit: manifest?.xcodeCloudCommit,
    startCondition: manifest?.xcodeCloudStartCondition,
  };
  if (manifest?.appVersion !== identity.appVersion ||
      manifest?.appBuildNumber !== identity.appBuildNumber ||
      manifest?.xcodeCloudBuildId !== identity.buildId ||
      manifest?.xcodeCloudBuildNumber !== identity.buildNumber ||
      manifest?.xcodeCloudWorkflowId !== identity.workflowId ||
      manifest?.xcodeCloudCommit !== identity.sourceCommit ||
      manifest?.xcodeCloudBranch !== "main" ||
      manifest?.xcodeCloudGitRef !== "refs/heads/main" ||
      manifest?.xcodeCloudScheme !== "SurfAce" ||
      manifest?.xcodeCloudPlatform !== "iOS" ||
      manifest?.xcodeCloudAction !== "archive" ||
      Object.values(expectedIdentity).some((value) => typeof value !== "string" || value.length === 0) ||
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
  const manifestBytes = bytes(candidate.manifestBytes, "manifest");
  const skillBytes = bytes(candidate.skillBytes, "skill");
  const artifactProofBytes = bytes(candidate.artifactProofBytes, "artifact_proof");
  const manifest = parseManifest(manifestBytes);
  const artifactProof = parseManifest(artifactProofBytes);
  const canonicalSkillBytes = bytes(
    await sourceReader.readFileAtCommit(sourceCommit, CANONICAL_SKILL_SOURCE),
    "canonical_skill",
  );
  const skillSha256 = sha256(skillBytes);
  const manifestSha256 = sha256(manifestBytes);
  const artifactSha256 = requiredString(identity.artifactSha256, "artifact_sha256");
  if (!SHA256.test(artifactSha256) ||
      artifactProof?.channel !== channel ||
      artifactProof?.releaseOrBuildId !== releaseOrBuildId ||
      artifactProof?.sourceCommit !== sourceCommit ||
      artifactProof?.manifestSha256 !== manifestSha256 ||
      artifactProof?.skillSha256 !== skillSha256 ||
      artifactProof?.artifactSha256 !== artifactSha256) {
    throw new Error("delivery_artifact_proof_mismatch");
  }
  if (skillSha256 !== sha256(canonicalSkillBytes)) throw new Error("delivery_skill_source_mismatch");

  if (channel === "desktop-cli-release") {
    const version = requiredString(identity.version, "version");
    verifyDesktopManifest(manifest, { ...identity, version, sourceCommit }, skillSha256);
    if (artifactProof?.sourceTag !== identity.sourceTag ||
        artifactProof?.toolingTag !== identity.toolingTag ||
        artifactProof?.toolingCommit !== identity.toolingCommit ||
        artifactProof?.version !== identity.version) {
      throw new Error("delivery_artifact_proof_mismatch");
    }
  } else {
    verifyIphoneManifest(manifest, { ...identity, sourceCommit }, skillSha256);
    if (artifactProof?.buildId !== identity.buildId ||
        artifactProof?.buildNumber !== identity.buildNumber ||
        artifactProof?.workflowId !== identity.workflowId ||
        artifactProof?.appVersion !== identity.appVersion ||
        artifactProof?.appBuildNumber !== identity.appBuildNumber) {
      throw new Error("delivery_artifact_proof_mismatch");
    }
  }

  const destinationSetSha256 = sha256(canonicalJson(destinationRecords));
  const destinationMapSha256 = destinationSetSha256;
  const toolingCommit = identity.toolingCommit ?? null;
  if (toolingCommit !== null && !COMMIT.test(toolingCommit)) throw new Error("delivery_tooling_commit_invalid");
  const envelope = {
    schemaVersion: 1,
    channel,
    releaseOrBuildId,
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
    artifactProofSha256: sha256(artifactProofBytes),
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
    artifactProofBytes,
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
    approval?.approved === true &&
    approval?.envelopeId === plan.envelopeId &&
    approval?.destinationSetSha256 === plan.destinationSetSha256 &&
    approval?.destinationMapSha256 === plan.destinationMapSha256 &&
    approval?.planSha256 === plan.planSha256;
}

async function readCurrentHash(targets, targetId) {
  const current = await targets.read(targetId);
  return snapshotDigest(current);
}

async function rollbackCommitted({ targets, journal, envelopeId, committed, skillSha256 }) {
  const receipts = [];
  let unresolved = false;
  for (const item of [...committed].reverse()) {
    try {
      const currentHash = await readCurrentHash(targets, item.targetId);
      if (currentHash === item.priorSha256) {
        receipts.push({ targetId: item.targetId, state: "already_restored", sha256: currentHash });
        continue;
      }
      if (currentHash !== skillSha256) {
        unresolved = true;
        receipts.push({ targetId: item.targetId, state: "conflict", sha256: currentHash });
        continue;
      }
      await targets.restore(item.targetId, item.backupBytes);
      const restoredHash = await readCurrentHash(targets, item.targetId);
      if (restoredHash !== item.priorSha256) {
        unresolved = true;
        receipts.push({ targetId: item.targetId, state: "restore_mismatch", sha256: restoredHash });
        continue;
      }
      receipts.push({ targetId: item.targetId, state: "restored", sha256: restoredHash });
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
      const currentHash = await readCurrentHash(targets, snapshot.targetId);
      if (currentHash === snapshot.priorSha256) {
        receipts.push({ targetId: snapshot.targetId, state: "prior_state_confirmed", sha256: currentHash });
        continue;
      }
      if (currentHash !== skillSha256) {
        unresolved = true;
        receipts.push({ targetId: snapshot.targetId, state: "conflict", sha256: currentHash });
        continue;
      }
      if (snapshot.priorSha256 === skillSha256) {
        receipts.push({ targetId: snapshot.targetId, state: "desired_state_was_prior_state", sha256: currentHash });
        continue;
      }
      const previousBytes = await journal.readBackup(envelopeId, snapshot.targetId, snapshot.backupRef);
      if (snapshot.priorSha256 === null ? previousBytes !== null : sha256(bytes(previousBytes, "backup")) !== snapshot.priorSha256) {
        unresolved = true;
        receipts.push({ targetId: snapshot.targetId, state: "backup_missing_or_mismatched" });
        continue;
      }
      await targets.restore(snapshot.targetId, previousBytes);
      const restoredHash = await readCurrentHash(targets, snapshot.targetId);
      if (restoredHash !== snapshot.priorSha256) {
        unresolved = true;
        receipts.push({ targetId: snapshot.targetId, state: "restore_mismatch", sha256: restoredHash });
        continue;
      }
      receipts.push({ targetId: snapshot.targetId, state: "restored", sha256: restoredHash });
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
      ["read", "listPublishing", "readBackup", "saveBackup", "recordBlocked", "recordPending", "recordPublishing", "recordTargetReceipt", "recordRollback", "recordFailure", "recordComplete"]
        .some((method) => typeof journal[method] !== "function") ||
      sources.some((source) => typeof source?.listCandidates !== "function")) {
    throw new Error("delivery_adapters_missing");
  }
  const destinationRecords = normalizeDestinationRecords(destinations);

  const results = [];
  const recoveredEnvelopeIds = new Set();
  for (const entry of await journal.listPublishing()) {
    const recovery = await recoverInterruptedTransaction(entry, { targets, journal });
    if (recovery.envelopeId) recoveredEnvelopeIds.add(recovery.envelopeId);
    results.push(recovery);
  }
  for (const source of sources) {
    const candidates = await source.listCandidates();
    for (const candidate of candidates) {
      let verified;
      try {
        verified = await verifyDeliveryCandidate(candidate, { destinations: destinationRecords, sourceReader });
      } catch (error) {
        const rejectedId = rejectedCandidateId(candidate);
        await journal.recordBlocked(rejectedId, {
          reason: error.message,
          channel: candidate?.channel ?? null,
          releaseOrBuildId: candidate?.identity?.releaseOrBuildId ?? null,
        });
        results.push({ status: "rejected", code: error.message });
        continue;
      }

      const { envelope, envelopeId, destinations: resolvedTargets, skillBytes, skillSha256 } = verified;
      if (recoveredEnvelopeIds.has(envelopeId)) continue;
      const prior = await journal.read(envelopeId);
      if (prior?.status === "complete") {
        results.push({ status: "already_complete", envelopeId });
        continue;
      }
      if (prior?.status === "unresolved") {
        results.push({ status: "unresolved", envelopeId, code: "delivery_previous_attempt_unresolved" });
        continue;
      }

      const snapshots = [];
      try {
        for (const { id: targetId } of resolvedTargets) {
          const snapshot = await targets.read(targetId);
          const priorSha256 = snapshotDigest(snapshot);
          const backupKey = `${envelopeId}:${targetId}:${priorSha256 ?? "absent"}`;
          const backupRef = await journal.saveBackup(envelopeId, targetId, snapshot.bytes, { key: backupKey });
          const backupBytes = await journal.readBackup(envelopeId, targetId, backupRef);
          if (priorSha256 === null ? backupBytes !== null : sha256(bytes(backupBytes, "backup")) !== priorSha256) {
            throw new Error("delivery_backup_verification_failed");
          }
          snapshots.push({ targetId, priorSha256, backupRef, backupBytes });
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
        snapshots: snapshots.map(({ targetId, priorSha256, backupRef }) => ({ targetId, priorSha256, backupRef })),
        rollbackPlan: "restore prior bytes in reverse commit order; verify every restored hash or absence",
      };
      const planSha256 = sha256(canonicalJson(planBody));
      const plan = { ...planBody, planSha256 };
      let approval = await approvals.read(envelopeId);
      if (!approval) {
        await approvals.request(plan, { idempotencyKey: `${envelopeId}:${planSha256}` });
        await journal.recordPending(envelopeId, { envelope, plan, planSha256 });
        results.push({ status: "awaiting_approval", envelopeId, planSha256 });
        continue;
      }
      if (approval.status === "pending" && approval.planSha256 === planSha256 &&
          approval.envelopeId === envelopeId &&
          approval.destinationSetSha256 === plan.destinationSetSha256 &&
          approval.destinationMapSha256 === plan.destinationMapSha256) {
        await journal.recordPending(envelopeId, { envelope, plan, planSha256 });
        results.push({ status: "awaiting_approval", envelopeId, planSha256 });
        continue;
      }
      if (approval.status === "pending" && approval.envelopeId === envelopeId &&
          approval.destinationSetSha256 === plan.destinationSetSha256 &&
          approval.destinationMapSha256 === plan.destinationMapSha256 &&
          approval.planSha256 !== planSha256) {
        await approvals.request(plan, { idempotencyKey: `${envelopeId}:${planSha256}` });
        await journal.recordPending(envelopeId, { envelope, plan, planSha256 });
        results.push({ status: "awaiting_approval", envelopeId, planSha256 });
        continue;
      }
      if (approval.status === "ruled" && approval.approved !== true) {
        await journal.recordBlocked(envelopeId, { reason: "approval_declined", planSha256 });
        results.push({ status: "blocked", envelopeId, code: "approval_declined" });
        continue;
      }
      if (approval?.envelopeId === envelopeId &&
          approval?.destinationSetSha256 === plan.destinationSetSha256 &&
          approval?.destinationMapSha256 === plan.destinationMapSha256 &&
          approval?.planSha256 !== planSha256) {
        await approvals.request(plan, { idempotencyKey: `${envelopeId}:${planSha256}` });
        await journal.recordPending(envelopeId, { envelope, plan, planSha256 });
        results.push({ status: "awaiting_approval", envelopeId, planSha256 });
        continue;
      }
      if (!approvalMatches(approval, plan)) {
        await journal.recordBlocked(envelopeId, { reason: "approval_mismatch", planSha256 });
        results.push({ status: "blocked", envelopeId, code: "approval_mismatch" });
        continue;
      }

      const staged = [];
      try {
        for (const snapshot of snapshots) {
          const currentHash = await readCurrentHash(targets, snapshot.targetId);
          if (currentHash !== snapshot.priorSha256) throw new Error("delivery_destination_changed_after_approval");
        }
        for (const { targetId } of snapshots) {
          const stage = await targets.stage(targetId, skillBytes, envelopeId);
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
        await journal.recordPublishing(envelopeId, { envelope, plan, planSha256 });
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
          await targets.commit(snapshot.targetId, stage, { expectedPriorSha256: snapshot.priorSha256 });
        } catch {
          // Readback below distinguishes a completed write from an uncertain result.
        }
        let currentHash;
        try {
          currentHash = await readCurrentHash(targets, snapshot.targetId);
        } catch {
          try {
            await journal.recordTargetReceipt(envelopeId, {
              envelopeId,
              targetId: snapshot.targetId,
              priorSha256: snapshot.priorSha256,
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
              backupRef: snapshot.backupRef,
              stagedSha256: skillSha256,
              finalSha256: currentHash,
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
          backupRef: snapshot.backupRef,
          stagedSha256: skillSha256,
          finalSha256: currentHash,
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
          });
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
        });
      } catch {
        const rollback = await rollbackCommitted({ targets, journal, envelopeId, committed, skillSha256 });
        await journal.recordFailure(envelopeId, {
          code: "delivery_completion_receipt_failed",
          unresolved: true,
          rollback,
          status: "unresolved",
        });
        results.push({ status: "unresolved", envelopeId, code: "delivery_completion_receipt_failed" });
        continue;
      }
      results.push({ status: "complete", envelopeId });
    }
  }
  return { status: "processed", processed: results.length, results };
}
