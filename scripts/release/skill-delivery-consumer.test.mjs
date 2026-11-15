import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_SKILL_SOURCE,
  runSkillDeliveryConsumer,
  sha256,
  verifyDeliveryCandidate,
} from "./skill-delivery-consumer.mjs";

const sourceCommit = "a".repeat(40);
const toolingCommit = "b".repeat(40);
const destinations = ["target-a", "target-b", "target-c", "target-d", "target-e"];
const destinationRecords = destinations.map((id, index) => ({
  id,
  kind: index === 0 ? "shared-identity" : "standalone-skill",
  host: `fixture-machine-${index < 3 ? "a" : "b"}`,
  path: `/fixture/${id}/SKILL.md`,
  writer: index === 0 ? "supported-identity-cli" : "existing-ssh",
  route: index === 0
    ? { identityArchetype: "fixture-archetype", identitySkillName: "surf-ace" }
    : { sshTarget: `fixture-ssh-${index}` },
  effects: index === 0
    ? {
      service: "publishes a shared identity revision for future loads",
      database: "records publication and projection state; no schema change",
      downtime: "no restart or downtime expected",
    }
    : {
      service: "replaces one standalone skill file for future loads",
      database: "none",
      downtime: "none",
    },
}));
const skillBytes = Buffer.from("# Surf Ace operating skill\n");
const skillSha256 = sha256(skillBytes);

const testRuling = { principal: "user:operator", onBehalfOf: "user:operator" };

function approvedReceipt(plan, overrides = {}) {
  return {
    status: "ruled",
    decision: "approve",
    handoffId: "test-handoff-record",
    requestRef: "test-approval-record",
    ruling: testRuling,
    envelopeId: plan.envelopeId,
    destinationSetSha256: plan.destinationSetSha256,
    destinationMapSha256: plan.destinationMapSha256,
    planSha256: plan.planSha256,
    ...overrides,
  };
}

function desktopCandidate(overrides = {}) {
  const {
    skillBytes: candidateSkillBytes = skillBytes,
    identity: identityOverrides = {},
    ...candidateOverrides
  } = overrides;
  const candidateSkillSha256 = sha256(candidateSkillBytes);
  const asset = "surf-ace-skill-v0.2.10.md";
  const manifestAssetName = "surf-ace-v0.2.10-manifest.json";
  const manifest = {
    version: "0.2.10",
    source: { commit: identityOverrides.sourceCommit ?? sourceCommit, tag: "surf-ace-v0.2.10-r1" },
    tooling: { commit: toolingCommit, tag: "surf-ace-release-tooling-v0.2.10-r1" },
    assets: [{ name: asset, sha256: candidateSkillSha256 }],
    checksums: { [asset]: candidateSkillSha256 },
    operatingSkill: {
      asset,
      clientPlatforms: ["desktop", "cli"],
      publication: "github-release-asset",
      sha256: candidateSkillSha256,
      sourcePath: CANONICAL_SKILL_SOURCE,
      version: "0.2.10",
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const checksumBytes = Buffer.from(`${candidateSkillSha256}  ${asset}\n${sha256(manifestBytes)}  ${manifestAssetName}\n`);
  return {
    channel: "desktop-cli-release",
    identity: {
      releaseOrBuildId: "release-0.2.10-r1",
      releaseTag: "surf-ace-v0.2.10-r1",
      sourceCommit: identityOverrides.sourceCommit ?? sourceCommit,
      toolingCommit,
      sourceTag: "surf-ace-v0.2.10-r1",
      toolingTag: "surf-ace-release-tooling-v0.2.10-r1",
      version: "0.2.10",
      manifestAssetName,
      manifestAssetSha256: sha256(manifestBytes),
      checksumsAssetName: "SHA256SUMS",
      releaseAssetNames: [asset, manifestAssetName, "SHA256SUMS"],
      assetSha256ByName: { [asset]: candidateSkillSha256 },
      artifactSha256: sha256(checksumBytes),
      eventKey: sha256(Buffer.from(`desktop-event:${identityOverrides.sourceCommit ?? sourceCommit}:${candidateSkillSha256}`)),
      ...identityOverrides,
    },
    manifestBytes,
    checksumBytes,
    skillBytes: candidateSkillBytes,
    ...candidateOverrides,
  };
}

function iphoneCandidate() {
  const manifest = {
    appVersion: "0.1.0",
    appBuildNumber: "17",
    operatingSkill: {
      asset: "SurfAceOperatingSkill/SKILL.md",
      clientPlatforms: ["ios"],
      publication: "app-bundle",
      sha256: skillSha256,
      sourcePath: CANONICAL_SKILL_SOURCE,
      version: "0.1.0",
    },
    xcodeCloudBuildId: "build-123",
    xcodeCloudBuildNumber: "30",
    xcodeCloudCommit: sourceCommit,
    xcodeCloudWorkflowId: "workflow-123",
    xcodeCloudStartCondition: "push",
    xcodeCloudBranch: "main",
    xcodeCloudGitRef: "refs/heads/main",
    xcodeCloudScheme: "SurfAce",
    xcodeCloudPlatform: "iOS",
    xcodeCloudAction: "archive",
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return {
    channel: "iphone-build",
    identity: {
      releaseOrBuildId: "build-123",
      eventKey: sha256(Buffer.from("iphone-event:build-123")),
      sourceCommit,
      appVersion: "0.1.0",
      appBuildNumber: "30",
      manifestAppBuildNumber: "17",
      buildId: "build-123",
      buildNumber: "30",
      workflowId: "workflow-123",
      appStoreBuildId: "app-build-30",
      appStoreAppVersion: "0.1.0",
      appStoreBuildNumber: "30",
      deliveryRoute: "xcode-cloud-archive",
      artifactSha256: "e".repeat(64),
      completionStatus: "SUCCEEDED",
      isPullRequestBuild: false,
      startCondition: "push",
      sourceBranch: "main",
      gitRef: "refs/heads/main",
      scheme: "SurfAce",
      platform: "iOS",
      action: "archive",
      buildRecordSha256: "d".repeat(64),
    },
    manifestBytes,
    skillBytes,
  };
}

function makeJournal() {
  const entries = new Map();
  const backups = new Map();
  let highWater = { sourceCommit, skillSha256 };
  return {
    entries,
    async read(envelopeId) { return entries.get(envelopeId); },
    async readHighWater() { return highWater; },
    async initializeHighWater(value) { highWater ??= value; },
    async listPublishing() {
      return [...entries.entries()]
        .filter(([, entry]) => entry.status === "publishing")
        .map(([envelopeId, entry]) => ({ envelopeId, ...entry }));
    },
    async listTerminalEventKeys() {
      return [...new Set([...entries.values()]
        .filter((entry) => ["complete", "no_change", "unresolved", "rolled_back"].includes(entry.status) ||
          (entry.status === "blocked" && entry.terminal === true))
        .map((entry) => entry.terminalEventKey ?? entry.envelope?.eventKey ?? entry.plan?.envelope?.eventKey)
        .filter((key) => typeof key === "string"))];
    },
    async readBackup(_envelopeId, _targetId, ref) { return backups.get(ref); },
    async saveBackup(envelopeId, targetId, value, { key }) {
      const ref = `backup-${sha256(Buffer.from(key)).slice(0, 16)}`;
      backups.set(ref, value === null ? null : Buffer.from(value));
      return ref;
    },
    async recordBlocked(envelopeId, detail) { entries.set(envelopeId, { ...entries.get(envelopeId), status: "blocked", ...detail }); },
    async recordPending(envelopeId, detail) { entries.set(envelopeId, { status: "pending", ...detail }); },
    async recordPublishing(envelopeId, detail) {
      entries.set(envelopeId, { ...entries.get(envelopeId), status: "publishing", envelopeId, ...detail });
    },
    async recordTargetReceipt(envelopeId, receipt) {
      const entry = entries.get(envelopeId) ?? { targetReceipts: [] };
      entry.targetReceipts ??= [];
      entry.targetReceipts.push(receipt);
      entries.set(envelopeId, entry);
    },
    async recordRollback(envelopeId, receipts, detail) {
      entries.set(envelopeId, { ...entries.get(envelopeId), rollbackReceipts: receipts, ...detail });
    },
    async recordNoChange(envelopeId, detail) {
      entries.set(envelopeId, { status: "no_change", terminal: true, envelopeId, ...detail });
      highWater = detail.highWater;
    },
    async recordFailure(envelopeId, detail) { entries.set(envelopeId, { ...entries.get(envelopeId), ...detail }); },
    async recordComplete(envelopeId, detail) {
      entries.set(envelopeId, { status: "complete", terminal: true, ...detail });
      highWater = detail.highWater;
    },
  };
}

function makeTargets(initialValues = {}, targetIds = destinations, initialModes = {}) {
  const values = new Map(targetIds.map((id) => [id, Buffer.from(initialValues[id] ?? `old:${id}`)]));
  const sharedIds = new Set(destinationRecords.filter(({ kind }) => kind === "shared-identity").map(({ id }) => id));
  const modes = new Map(targetIds.map((id) => [id, sharedIds.has(id) ? null : (initialModes[id] ?? 0o644)]));
  const stages = new Map();
  const targetStore = {
    values,
    modes,
    async read(id) { return { available: true, bytes: values.has(id) ? Buffer.from(values.get(id)) : null, mode: values.has(id) ? modes.get(id) : null }; },
    async stage(id, value, envelopeId, { mode } = {}) {
      const stageId = `${envelopeId}:${id}`;
      stages.set(stageId, { bytes: Buffer.from(value), mode });
      return { id: stageId, sha256: sha256(value) };
    },
    async discardStage(_id, stage) { stages.delete(stage.id); },
    async commit(id, stage, { expectedPriorSha256, expectedPriorMode, targetMode } = {}) {
      const actualPriorSha256 = values.has(id) ? sha256(values.get(id)) : null;
      if (actualPriorSha256 !== expectedPriorSha256 || modes.get(id) !== expectedPriorMode) throw new Error("target_prior_state_changed");
      values.set(id, Buffer.from(stages.get(stage.id).bytes));
      modes.set(id, sharedIds.has(id) ? null : targetMode);
      if (sharedIds.has(id)) {
        const digest = sha256(values.get(id));
        const readback = { available: true, bytes: Buffer.from(values.get(id)), mode: null };
        return {
          status: "complete",
          readback,
          ownerReceipt: { action: "commit", targetId: id, finalSha256: digest, readbackSha256: digest },
        };
      }
      return { status: "complete" };
    },
    async restore(id, previousBytes, { expectedCurrentSha256, expectedCurrentMode, priorMode } = {}) {
      if ((values.has(id) ? sha256(values.get(id)) : null) !== expectedCurrentSha256 || modes.get(id) !== expectedCurrentMode) {
        throw new Error("target_restore_state_changed");
      }
      if (previousBytes === null) {
        values.delete(id);
        modes.set(id, null);
      } else {
        values.set(id, Buffer.from(previousBytes));
        modes.set(id, sharedIds.has(id) ? null : priorMode);
      }
      if (sharedIds.has(id)) {
        const digest = values.has(id) ? sha256(values.get(id)) : null;
        const readback = { available: true, bytes: values.has(id) ? Buffer.from(values.get(id)) : null, mode: null };
        return {
          status: "complete",
          readback,
          ownerReceipt: { action: "restore", targetId: id, finalSha256: digest, readbackSha256: digest },
        };
      }
      return { status: "complete" };
    },
  };
  return targetStore;
}

function sourceReader() {
  return {
    async readFileAtCommit(commit, path) {
      assert.equal(path, CANONICAL_SKILL_SOURCE);
      assert.match(commit, /^[a-f0-9]{40}$/);
      return skillBytes;
    },
    async compareCommits(base, head) { return base === head ? "identical" : "ahead"; },
    async readTagCommit(tag) {
      if (tag === "surf-ace-v0.2.10-r1") return sourceCommit;
      if (tag === "surf-ace-release-tooling-v0.2.10-r1") return toolingCommit;
      throw new Error("unknown fixture tag");
    },
  };
}

function sourceFor(candidate, onList = () => {}) {
  return { async listCandidates(options) { onList(options); return [candidate]; } };
}

test("disabled consumer does not poll sources or read destinations", async () => {
  let calls = 0;
  const result = await runSkillDeliveryConsumer({
    sources: [{ async listCandidates() { calls += 1; return []; } }],
    targets: { async read() { calls += 1; } },
  });
  assert.deepEqual(result, { status: "disabled", processed: 0 });
  assert.equal(calls, 0);
});

test("iPhone build is bound to canonical skill bytes and embedded build identity", async () => {
  const result = await verifyDeliveryCandidate(iphoneCandidate(), {
    destinations: destinationRecords,
    sourceReader: sourceReader(),
  });
  assert.equal(result.envelope.channel, "iphone-build");
  assert.equal(result.envelope.sourceCommit, sourceCommit);
  assert.equal(result.envelope.skillSha256, skillSha256);
  assert.equal(result.envelope.skillAssetName, "SurfAceOperatingSkill/SKILL.md");
  assert.equal(result.envelope.appBuildNumber, "30");
  assert.equal(result.envelope.buildIdentity.manifestAppBuildNumber, "17");
  assert.equal(result.envelope.buildIdentity.appStoreBuildNumber, "30");
  assert.equal(result.envelope.buildIdentity.deliveryRoute, "xcode-cloud-archive");
});

test("desktop release tags must resolve to the commits named by its manifest", async () => {
  const candidate = desktopCandidate();
  await assert.rejects(() => verifyDeliveryCandidate(candidate, {
    destinations: destinationRecords,
    sourceReader: {
      ...sourceReader(),
      async readTagCommit(tag) {
        return tag === "surf-ace-v0.2.10-r1" ? "c".repeat(40) : toolingCommit;
      },
    },
  }), /delivery_release_tag_target_mismatch/);
});

test("a source or manifest mismatch is rejected before any target read or write", async () => {
  const candidate = desktopCandidate({ skillBytes: Buffer.from("different skill\n") });
  const targetStore = makeTargets();
  const journal = makeJournal();
  const approvals = { async read() { return null; }, async request() { assert.fail("invalid source requested approval"); } };
  const result = await runSkillDeliveryConsumer({
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals,
    journal,
  });
  assert.equal(result.results[0].status, "rejected");
  assert.equal(result.results[0].code, "delivery_skill_source_mismatch");
  assert.equal(journal.entries.size, 1);
  assert.equal([...journal.entries.values()][0].reason, "delivery_skill_source_mismatch");
});

test("a rejected immutable event is journaled once and skipped on later polls", async () => {
  const candidate = desktopCandidate({ skillBytes: Buffer.from("different skill\n") });
  const journal = makeJournal();
  const sourceOptions = [];
  let blockedRecords = 0;
  let canonicalReads = 0;
  const recordBlocked = journal.recordBlocked.bind(journal);
  journal.recordBlocked = async (...args) => { blockedRecords += 1; return recordBlocked(...args); };
  const reader = {
    ...sourceReader(),
    async readFileAtCommit(...args) {
      canonicalReads += 1;
      return sourceReader().readFileAtCommit(...args);
    },
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate, (options) => sourceOptions.push(options))],
    sourceReader: reader,
    destinations: destinationRecords,
    targets: makeTargets(),
    approvals: { async read() { return null; }, async request() { assert.fail("rejected event must not request approval"); } },
    journal,
  };

  const first = await runSkillDeliveryConsumer(args);
  const second = await runSkillDeliveryConsumer(args);

  assert.equal(first.results[0].code, "delivery_skill_source_mismatch");
  assert.equal(second.processed, 0);
  assert.equal(blockedRecords, 1);
  assert.equal(canonicalReads, 1);
  assert.ok(sourceOptions[1].terminalEventKeys.includes(candidate.identity.eventKey));
});

test("exact matching approval is required before all five future-load copies", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  let targetReads = 0;
  let backupSaves = 0;
  const targetRead = targetStore.read.bind(targetStore);
  const backupSave = journal.saveBackup.bind(journal);
  targetStore.read = async (...args) => { targetReads += 1; return targetRead(...args); };
  journal.saveBackup = async (...args) => { backupSaves += 1; return backupSave(...args); };
  let ruling = null;
  let requestedPlan;
  const approvals = {
    async read() { return ruling; },
    async request(plan) { requestedPlan = plan; },
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals,
    journal,
  };

  const pending = await runSkillDeliveryConsumer(args);
  assert.equal(pending.results[0].status, "awaiting_approval");
  assert.ok(requestedPlan);
  assert.equal(targetReads, destinations.length);
  assert.equal(backupSaves, destinations.length);
  assert.deepEqual([...targetStore.values.values()].map((value) => value.toString()), destinations.map((id) => `old:${id}`));

  ruling = {
    status: "pending",
    envelopeId: requestedPlan.envelopeId,
    destinationSetSha256: requestedPlan.destinationSetSha256,
    destinationMapSha256: requestedPlan.destinationMapSha256,
    planSha256: requestedPlan.planSha256,
  };
  const stillPending = await runSkillDeliveryConsumer(args);
  assert.equal(stillPending.results[0].status, "awaiting_approval");
  assert.equal(targetReads, destinations.length);
  assert.equal(backupSaves, destinations.length);
  assert.deepEqual([...targetStore.values.values()].map((value) => value.toString()), destinations.map((id) => `old:${id}`));

  ruling = {
    status: "ruled",
    decision: "approve",
    handoffId: "test-handoff-record",
    requestRef: "test-approval-record",
    ruling: testRuling,
    envelopeId: requestedPlan.envelopeId,
    destinationSetSha256: requestedPlan.destinationSetSha256,
    destinationMapSha256: requestedPlan.destinationMapSha256,
    planSha256: requestedPlan.planSha256,
  };
  const completed = await runSkillDeliveryConsumer(args);
  assert.equal(completed.results[0].status, "complete");
  assert.deepEqual([...targetStore.values.values()].map((value) => sha256(value)), destinations.map(() => skillSha256));
  assert.equal(journal.entries.get(requestedPlan.envelopeId).targetReceipts.length, destinations.length);
  assert.deepEqual(requestedPlan.destinationRecords, destinationRecords);
});

test("a pending shared identity edit holds standalone writes and resumes with the same plan", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  let requestedPlan;
  let holdShared = true;
  let ownerAlreadyWrote = false;
  const committedIds = [];
  let sharedReads = 0;
  const originalRead = targetStore.read.bind(targetStore);
  targetStore.read = async (id, options) => {
    if (id === destinations[0]) sharedReads += 1;
    return originalRead(id, options);
  };
  const originalCommit = targetStore.commit.bind(targetStore);
  targetStore.commit = async (id, stage, options) => {
    committedIds.push(id);
    if (id === destinations[0] && holdShared) {
      holdShared = false;
      const content = skillBytes;
      targetStore.values.set(id, Buffer.from(content));
      ownerAlreadyWrote = true;
      return { status: "pending", operationId: "owner-operation-1" };
    }
    if (id === destinations[0] && ownerAlreadyWrote) {
      const content = targetStore.values.get(id);
      const digest = sha256(content);
      return {
        status: "complete",
        readback: { available: true, bytes: Buffer.from(content), mode: null },
        ownerReceipt: {
          operationId: "owner-operation-1",
          action: "commit",
          targetId: id,
          finalSha256: digest,
          readbackSha256: digest,
        },
      };
    }
    return originalCommit(id, stage, options);
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals: {
      async read() { return requestedPlan && approvedReceipt(requestedPlan); },
      async request(plan) { requestedPlan = plan; },
    },
    journal,
  };

  await runSkillDeliveryConsumer(args);
  const pending = await runSkillDeliveryConsumer(args);
  assert.equal(pending.results[0].status, "awaiting_shared_identity");
  assert.deepEqual(committedIds, [destinations[0]]);
  assert.deepEqual(destinations.map((id) => sha256(targetStore.values.get(id))),
    [skillSha256, ...destinations.slice(1).map((id) => sha256(Buffer.from(`old:${id}`)))]);
  const pendingEntry = journal.entries.get(requestedPlan.envelopeId);
  assert.equal(pendingEntry.status, "publishing");
  assert.equal(pendingEntry.sharedOperationPending, true);
  assert.equal(sha256(targetStore.values.get(destinations[0])), skillSha256,
    "the owner may finish the exact edit before the next consumer poll");

  const resumed = await runSkillDeliveryConsumer(args);
  assert.equal(resumed.results[0].status, "complete");
  assert.deepEqual(committedIds, [destinations[0], ...destinations]);
  assert.equal(sharedReads, 2, "resume consumes the original owner receipt instead of re-reading the changed shared target");
  assert.deepEqual(destinations.map((id) => sha256(targetStore.values.get(id))), destinations.map(() => skillSha256));
});

test("a pending shared preflight read resumes the same owner operation without blocking the event", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  const originalRead = targetStore.read.bind(targetStore);
  const sharedReadOperationIds = [];
  let pendingFirstRead = true;
  let approvalsRequested = 0;
  let requestedPlan;
  targetStore.read = async (id, options) => {
    if (id === destinations[0]) {
      sharedReadOperationIds.push(options?.operationId);
      if (pendingFirstRead) {
        pendingFirstRead = false;
        return { status: "pending", operationId: options?.operationId };
      }
    }
    return originalRead(id, options);
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals: {
      async read() { return null; },
      async request(plan) { approvalsRequested += 1; requestedPlan = plan; },
    },
    journal,
  };

  const first = await runSkillDeliveryConsumer(args);
  assert.equal(first.results[0].status, "awaiting_shared_identity");
  assert.equal(approvalsRequested, 0);
  assert.equal(journal.entries.size, 0);
  const second = await runSkillDeliveryConsumer(args);
  assert.equal(second.results[0].status, "awaiting_approval");
  assert.equal(approvalsRequested, 1);
  assert.equal(sharedReadOperationIds.length, 2);
  assert.equal(sharedReadOperationIds[0], sharedReadOperationIds[1]);
  assert.match(sharedReadOperationIds[0], /^[a-f0-9]{64}$/);
  assert.ok(requestedPlan);
});

test("pending shared reconciliation read is retried during recovery without terminalizing the event", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  let requestedPlan;
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals: {
      async read() { return null; },
      async request(plan) { requestedPlan = plan; },
    },
    journal,
  };
  await runSkillDeliveryConsumer(args);
  const entry = journal.entries.get(requestedPlan.envelopeId);
  journal.entries.set(requestedPlan.envelopeId, {
    ...entry,
    status: "publishing",
    approval: approvedReceipt(requestedPlan),
    sharedOperationPending: false,
  });

  const originalRead = targetStore.read.bind(targetStore);
  const sharedReadOperationIds = [];
  let firstSharedReadPending = true;
  targetStore.read = async (id, options) => {
    if (id === destinations[0]) {
      sharedReadOperationIds.push(options?.operationId);
      if (firstSharedReadPending) {
        firstSharedReadPending = false;
        return { status: "pending", operationId: options?.operationId };
      }
    }
    return originalRead(id, options);
  };

  const pending = await runSkillDeliveryConsumer(args);
  assert.equal(pending.results[0].status, "awaiting_shared_identity");
  assert.equal(journal.entries.get(requestedPlan.envelopeId).status, "publishing");
  assert.notEqual(journal.entries.get(requestedPlan.envelopeId).status, "unresolved");
  const recovered = await runSkillDeliveryConsumer(args);
  assert.equal(recovered.results[0].status, "rolled_back");
  assert.equal(sharedReadOperationIds[0], sharedReadOperationIds[1]);
  assert.equal(journal.entries.get(requestedPlan.envelopeId).status, "rolled_back");
});

test("pending shared read during partial rollback resumes recovery with the same read operation", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  let requestedPlan;
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals: {
      async read() { return requestedPlan && approvedReceipt(requestedPlan); },
      async request(plan) { requestedPlan = plan; },
    },
    journal,
  };
  await runSkillDeliveryConsumer(args);
  const originalRead = targetStore.read.bind(targetStore);
  const sharedReadOperationIds = [];
  let sharedReadCount = 0;
  targetStore.read = async (id, options) => {
    if (id === destinations[0]) {
      sharedReadCount += 1;
      sharedReadOperationIds.push(options?.operationId);
      if (sharedReadCount === 2) return { status: "pending", operationId: options?.operationId };
    }
    return originalRead(id, options);
  };
  const originalCommit = targetStore.commit.bind(targetStore);
  targetStore.commit = async (id, stage, options) => {
    if (id === destinations[2]) throw new Error("third standalone destination unavailable");
    return originalCommit(id, stage, options);
  };

  const awaiting = await runSkillDeliveryConsumer(args);
  assert.equal(awaiting.results[0].status, "awaiting_shared_identity");
  assert.equal(journal.entries.get(requestedPlan.envelopeId).sharedOperationAction, "read");
  assert.equal(sha256(targetStore.values.get(destinations[0])), skillSha256);
  assert.equal(targetStore.values.get(destinations[1]).toString(), `old:${destinations[1]}`);

  const recovered = await runSkillDeliveryConsumer(args);
  assert.equal(recovered.results[0].status, "rolled_back");
  assert.equal(sharedReadCount, 3);
  assert.equal(sharedReadOperationIds[1], sharedReadOperationIds[2]);
  assert.deepEqual(destinations.map((id) => targetStore.values.get(id).toString()),
    destinations.map((id) => `old:${id}`));
});

test("pending shared restore is resumed from its exact owner operation before terminal rollback", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  let requestedPlan;
  let sharedRestoreCalls = 0;
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals: {
      async read() { return requestedPlan && approvedReceipt(requestedPlan); },
      async request(plan) { requestedPlan = plan; },
    },
    journal,
  };
  await runSkillDeliveryConsumer(args);
  const originalCommit = targetStore.commit.bind(targetStore);
  targetStore.commit = async (id, stage, options) => {
    if (id === destinations[2]) throw new Error("third standalone destination unavailable");
    return originalCommit(id, stage, options);
  };
  const originalRestore = targetStore.restore.bind(targetStore);
  targetStore.restore = async (id, previousBytes, options) => {
    if (id !== destinations[0]) return originalRestore(id, previousBytes, options);
    sharedRestoreCalls += 1;
    if (sharedRestoreCalls === 1) {
      await originalRestore(id, previousBytes, options);
      return { status: "pending", operationId: "shared-restore-operation-1" };
    }
    const current = targetStore.values.get(id);
    const digest = sha256(current);
    assert.equal(digest, sha256(previousBytes), "the first owner poll already restored the shared skill");
    return {
      status: "complete",
      readback: { available: true, bytes: Buffer.from(current), mode: null },
      ownerReceipt: {
        operationId: "shared-restore-operation-1",
        action: "restore",
        targetId: id,
        finalSha256: digest,
        readbackSha256: digest,
      },
    };
  };

  const awaiting = await runSkillDeliveryConsumer(args);
  assert.equal(awaiting.results[0].status, "awaiting_shared_identity");
  assert.equal(journal.entries.get(requestedPlan.envelopeId).sharedOperationAction, "restore");
  assert.equal(targetStore.values.get(destinations[0]).toString(), `old:${destinations[0]}`);
  const recovered = await runSkillDeliveryConsumer(args);
  assert.equal(recovered.results[0].status, "rolled_back");
  assert.equal(sharedRestoreCalls, 2);
  assert.deepEqual(destinations.map((id) => targetStore.values.get(id).toString()),
    destinations.map((id) => `old:${id}`));
  const receipt = journal.entries.get(requestedPlan.envelopeId).rollbackReceipts.find(({ targetId }) => targetId === destinations[0]);
  assert.equal(receipt.ownerReceipt.operationId, "shared-restore-operation-1");
  assert.equal(receipt.ownerReceipt.action, "restore");
});

test("matching hashes produce a no-change receipt without asking for approval", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets(Object.fromEntries(destinations.map((id) => [id, skillBytes])));
  const journal = makeJournal();
  let approvalsRequested = 0;
  const result = await runSkillDeliveryConsumer({
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals: {
      async read() { return null; },
      async request() { approvalsRequested += 1; },
    },
    journal,
  });

  assert.equal(result.results[0].status, "no_change");
  assert.equal(approvalsRequested, 0);
  assert.equal(journal.entries.get(result.results[0].envelopeId).status, "no_change");
  assert.equal(targetStore.values.size, destinations.length);

  const repeated = await runSkillDeliveryConsumer({
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals: {
      async read() { assert.fail("terminal no-change events do not reread approval"); },
      async request() { assert.fail("terminal no-change events do not request approval"); },
    },
    journal,
  });
  assert.equal(repeated.processed, 0);
});

test("an out-of-order older source commit is recorded and never reaches targets", async () => {
  const candidate = desktopCandidate({ identity: { sourceCommit: "f".repeat(40) } });
  const targetStore = makeTargets();
  let targetReads = 0;
  const read = targetStore.read.bind(targetStore);
  targetStore.read = async (...args) => { targetReads += 1; return read(...args); };
  let approvalRequests = 0;
  const journal = makeJournal();
  const result = await runSkillDeliveryConsumer({
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: {
      ...sourceReader(),
      async compareCommits() { return "behind"; },
      async readTagCommit(tag) {
        return tag === "surf-ace-v0.2.10-r1" ? "f".repeat(40) : toolingCommit;
      },
    },
    destinations: destinationRecords,
    targets: targetStore,
    approvals: {
      async read() { return null; },
      async request() { approvalRequests += 1; },
    },
    journal,
  });

  assert.equal(result.results[0].code, "delivery_older_skill_rollback");
  assert.equal(targetReads, 0);
  assert.equal(approvalRequests, 0);
  assert.equal(journal.entries.get(result.results[0].envelopeId).reason, "delivery_older_skill_rollback");
});

test("destination count is driven by private configuration and included in the approval", async () => {
  const candidate = desktopCandidate();
  const expandedDestinations = [
    ...destinationRecords,
    {
      id: "target-f",
      kind: "standalone-skill",
      host: "fixture-machine-c",
      path: "/fixture/target-f/SKILL.md",
      writer: "existing-ssh",
      route: { sshTarget: "fixture-ssh-f" },
      effects: { service: "replaces one skill file", database: "none", downtime: "none" },
    },
  ];
  const allIds = expandedDestinations.map(({ id }) => id);
  const targetStore = makeTargets({}, allIds);
  const journal = makeJournal();
  let requestedPlan;
  const approvals = {
    async read() { return requestedPlan && {
      ...approvedReceipt(requestedPlan),
      envelopeId: requestedPlan.envelopeId,
      destinationSetSha256: requestedPlan.destinationSetSha256,
      destinationMapSha256: requestedPlan.destinationMapSha256,
      planSha256: requestedPlan.planSha256,
    }; },
    async request(plan) { requestedPlan = plan; },
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: expandedDestinations,
    targets: targetStore,
    approvals,
    journal,
  };

  await runSkillDeliveryConsumer(args);
  const result = await runSkillDeliveryConsumer(args);

  assert.equal(result.results[0].status, "complete");
  assert.equal(requestedPlan.destinationRecords.length, 6);
  assert.equal(targetStore.values.size, 6);
  assert.deepEqual([...targetStore.values.values()].map((value) => value.toString()), Array(6).fill(skillBytes.toString()));
});

test("approval binds exact resolved destination routes and effects", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  const rulings = new Map();
  const requestedPlans = [];
  const approvals = {
    async read(envelopeId) { return rulings.get(envelopeId) ?? null; },
    async request(plan) { requestedPlans.push(plan); },
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals,
    journal,
  };

  const pending = await runSkillDeliveryConsumer(args);
  assert.equal(pending.results[0].status, "awaiting_approval");
  const firstPlan = requestedPlans[0];
  rulings.set(firstPlan.envelopeId, {
    status: "ruled",
    decision: "approve",
    handoffId: "test-handoff-record",
    requestRef: "test-approval-record",
    ruling: testRuling,
    envelopeId: firstPlan.envelopeId,
    destinationSetSha256: firstPlan.destinationSetSha256,
    destinationMapSha256: firstPlan.destinationMapSha256,
    planSha256: firstPlan.planSha256,
  });

  const changedRoutes = destinationRecords.map((destination, index) => index === 1
    ? { ...destination, path: "/fixture/relocated/SKILL.md" }
    : destination);
  const changed = await runSkillDeliveryConsumer({ ...args, destinations: changedRoutes });

  assert.equal(changed.results[0].status, "awaiting_approval");
  assert.equal(requestedPlans.length, 2);
  assert.notEqual(requestedPlans[1].envelopeId, firstPlan.envelopeId);
  assert.notEqual(requestedPlans[1].destinationMapSha256, firstPlan.destinationMapSha256);
  assert.equal(requestedPlans[1].destinationRecords[1].path, "/fixture/relocated/SKILL.md");
  assert.deepEqual([...targetStore.values.values()].map((value) => value.toString()), destinations.map((id) => `old:${id}`));
});

test("a target changed after preflight is preserved by the expected-prior commit", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  let requestedPlan;
  const approvals = {
    async read() { return requestedPlan && {
      status: "ruled",
      decision: "approve",
      handoffId: "test-handoff-record",
      requestRef: "test-approval-record",
      ruling: testRuling,
      envelopeId: requestedPlan.envelopeId,
      destinationSetSha256: requestedPlan.destinationSetSha256,
      destinationMapSha256: requestedPlan.destinationMapSha256,
      planSha256: requestedPlan.planSha256,
    }; },
    async request(plan) { requestedPlan = plan; },
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals,
    journal,
  };
  await runSkillDeliveryConsumer(args);
  const originalStage = targetStore.stage.bind(targetStore);
  targetStore.stage = async (id, value, envelopeId) => {
    const stage = await originalStage(id, value, envelopeId);
    if (id === destinations[0]) targetStore.values.set(id, Buffer.from("concurrent-change"));
    return stage;
  };

  const result = await runSkillDeliveryConsumer(args);

  assert.equal(result.results[0].status, "unresolved");
  assert.equal(targetStore.values.get(destinations[0]).toString(), "concurrent-change");
  assert.deepEqual(destinations.slice(1).map((id) => targetStore.values.get(id).toString()),
    destinations.slice(1).map((id) => `old:${id}`));
});

test("uncertain write with a third-state readback stops and never overwrites it", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  let requestedPlan;
  const approvals = {
    async read() { return requestedPlan && approvedReceipt(requestedPlan); },
    async request(plan) { requestedPlan = plan; },
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals,
    journal,
  };
  await runSkillDeliveryConsumer(args);
  const originalCommit = targetStore.commit.bind(targetStore);
  let count = 0;
  targetStore.commit = async (id, stage, options) => {
    count += 1;
    if (count === 2) {
      targetStore.values.set(id, Buffer.from("third-state"));
      throw new Error("write result unknown");
    }
    return originalCommit(id, stage, options);
  };

  const result = await runSkillDeliveryConsumer(args);
  assert.equal(result.results[0].status, "unresolved");
  assert.equal(targetStore.values.get(destinations[1]).toString(), "third-state");
  assert.equal(targetStore.values.get(destinations[0]).toString(), `old:${destinations[0]}`);
  const receipts = journal.entries.get(requestedPlan.envelopeId).targetReceipts;
  assert.equal(receipts.find((receipt) => receipt.targetId === destinations[1]).state, "conflict");
  const retry = await runSkillDeliveryConsumer(args);
  assert.equal(retry.processed, 0);
  assert.equal(targetStore.values.get(destinations[1]).toString(), "third-state");
});

test("a restart reads back and rolls back an interrupted publication before retry", async () => {
  const candidate = desktopCandidate();
  const initialModes = Object.fromEntries(destinations.slice(1).map((id, index) => [id, index % 2 === 0 ? 0o640 : 0o600]));
  const targetStore = makeTargets({}, destinations, initialModes);
  const journal = makeJournal();
  let requestedPlan;
  const approvals = {
    async read() { return null; },
    async request(plan) { requestedPlan = plan; },
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals,
    journal,
  };
  await runSkillDeliveryConsumer(args);
  const envelopeId = requestedPlan.envelopeId;
  targetStore.values.set(destinations[0], Buffer.from(skillBytes));
  await journal.recordPublishing(envelopeId, { plan: requestedPlan, planSha256: requestedPlan.planSha256 });

  const result = await runSkillDeliveryConsumer(args);
  assert.equal(result.results[0].status, "rolled_back");
  assert.deepEqual([...targetStore.values.values()].map((value) => value.toString()), destinations.map((id) => `old:${id}`));
  assert.deepEqual([...targetStore.modes.values()], destinations.map((id) => id === destinations[0] ? null : initialModes[id]));
  assert.equal(requestedPlan.envelopeId, envelopeId);
});

test("an incomplete private destination set is rejected before sources are polled", async () => {
  let polled = false;
  await assert.rejects(() => runSkillDeliveryConsumer({
      enabled: true,
      sources: [{ async listCandidates() { polled = true; return []; } }],
      sourceReader: sourceReader(),
      destinations: destinationRecords.slice(1),
      targets: makeTargets(),
      approvals: { async read() { return null; }, async request() {} },
      journal: makeJournal(),
    }),
    /delivery_destination_set_invalid/,
  );
  assert.equal(polled, false);
});

test("approval from a different release cannot authorize a copy", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  const approvals = {
    async read() { return approvedReceipt({ envelopeId: "other-envelope" }); },
    async request() { assert.fail("mismatched approval must not be replaced automatically"); },
  };
  const result = await runSkillDeliveryConsumer({
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals,
    journal,
  });
  assert.equal(result.results[0].code, "approval_mismatch");
  assert.deepEqual([...targetStore.values.values()].map((value) => value.toString()), destinations.map((id) => `old:${id}`));
});

test("a ruling whose principal and behalf identity disagree cannot authorize target writes", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  let requestedPlan;
  const approvals = {
    async read() { return requestedPlan && {
      status: "ruled",
      decision: "approve",
      handoffId: "test-handoff-record",
      requestRef: "test-approval-record",
      ruling: { principal: "user:other", onBehalfOf: "user:operator" },
      envelopeId: requestedPlan.envelopeId,
      destinationSetSha256: requestedPlan.destinationSetSha256,
      destinationMapSha256: requestedPlan.destinationMapSha256,
      planSha256: requestedPlan.planSha256,
    }; },
    async request(plan) { requestedPlan = plan; },
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals,
    journal,
  };
  await runSkillDeliveryConsumer(args);
  const result = await runSkillDeliveryConsumer(args);
  assert.equal(result.results[0].code, "approval_mismatch");
  assert.deepEqual([...targetStore.values.values()].map((value) => value.toString()),
    destinations.map((id) => `old:${id}`));
});

test("partial commit failure restores prior bytes in reverse order", async () => {
  const candidate = desktopCandidate();
  const initialModes = Object.fromEntries(destinations.slice(1).map((id, index) => [id, index % 2 === 0 ? 0o640 : 0o600]));
  const targetStore = makeTargets({}, destinations, initialModes);
  const journal = makeJournal();
  let requestedPlan;
  const approvals = {
    async read() { return requestedPlan && approvedReceipt(requestedPlan); },
    async request(plan) { requestedPlan = plan; },
  };
  const args = {
    enabled: true,
    sources: [sourceFor(candidate)],
    sourceReader: sourceReader(),
    destinations: destinationRecords,
    targets: targetStore,
    approvals,
    journal,
  };
  await runSkillDeliveryConsumer(args);
  const originalCommit = targetStore.commit.bind(targetStore);
  const originalRestore = targetStore.restore.bind(targetStore);
  const operations = [];
  let count = 0;
  targetStore.commit = async (id, stage, options) => {
    operations.push({ action: "commit", id });
    count += 1;
    if (count === 2) throw new Error("destination unavailable");
    return originalCommit(id, stage, options);
  };
  targetStore.restore = async (id, previousBytes, options) => {
    operations.push({ action: "restore", id });
    return originalRestore(id, previousBytes, options);
  };

  const result = await runSkillDeliveryConsumer(args);
  assert.equal(result.results[0].status, "rolled_back");
  assert.deepEqual([...targetStore.values.values()].map((value) => value.toString()), destinations.map((id) => `old:${id}`));
  assert.deepEqual([...targetStore.modes.values()], destinations.map((id) => id === destinations[0] ? null : initialModes[id]));
  assert.equal(journal.entries.get(requestedPlan.envelopeId).rollbackReceipts[0].state, "restored");
  assert.deepEqual(operations, [
    { action: "commit", id: destinations[0] },
    { action: "commit", id: destinations[1] },
    { action: "restore", id: destinations[0] },
  ]);
  assert.equal(journal.entries.get(requestedPlan.envelopeId).rollbackReceipts[0].ownerReceipt.action, "restore");
});
