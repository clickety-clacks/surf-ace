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
const artifactSha256 = "c".repeat(64);

function desktopCandidate(overrides = {}) {
  const { skillBytes: candidateSkillBytes = skillBytes, ...candidateOverrides } = overrides;
  const candidateSkillSha256 = sha256(candidateSkillBytes);
  const asset = "surf-ace-skill-v0.2.10.md";
  const manifest = {
    version: "0.2.10",
    source: { commit: sourceCommit, tag: "surf-ace-v0.2.10-r1" },
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
  return {
    channel: "desktop-cli-release",
    identity: {
      releaseOrBuildId: "release-0.2.10-r1",
      sourceCommit,
      toolingCommit,
      sourceTag: "surf-ace-v0.2.10-r1",
      toolingTag: "surf-ace-release-tooling-v0.2.10-r1",
      version: "0.2.10",
      artifactSha256,
    },
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    skillBytes: candidateSkillBytes,
    artifactProofBytes: Buffer.from(JSON.stringify({
      channel: "desktop-cli-release",
      releaseOrBuildId: "release-0.2.10-r1",
      sourceCommit,
      toolingCommit,
      sourceTag: "surf-ace-v0.2.10-r1",
      toolingTag: "surf-ace-release-tooling-v0.2.10-r1",
      version: "0.2.10",
      manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))),
      skillSha256: candidateSkillSha256,
      artifactSha256,
    })),
    ...candidateOverrides,
  };
}

function iphoneCandidate() {
  const manifest = {
    appVersion: "0.1.0",
    appBuildNumber: "30",
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
  return {
    channel: "iphone-build",
    identity: {
      releaseOrBuildId: "build-123",
      sourceCommit,
      appVersion: "0.1.0",
      appBuildNumber: "30",
      buildId: "build-123",
      buildNumber: "30",
      workflowId: "workflow-123",
      artifactSha256,
    },
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    skillBytes,
    artifactProofBytes: Buffer.from(JSON.stringify({
      channel: "iphone-build",
      releaseOrBuildId: "build-123",
      sourceCommit,
      buildId: "build-123",
      buildNumber: "30",
      workflowId: "workflow-123",
      appVersion: "0.1.0",
      appBuildNumber: "30",
      manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))),
      skillSha256,
      artifactSha256,
    })),
  };
}

function makeJournal() {
  const entries = new Map();
  const backups = new Map();
  return {
    entries,
    async read(envelopeId) { return entries.get(envelopeId); },
    async listPublishing() {
      return [...entries.entries()]
        .filter(([, entry]) => entry.status === "publishing")
        .map(([envelopeId, entry]) => ({ envelopeId, ...entry }));
    },
    async readBackup(_envelopeId, _targetId, ref) { return backups.get(ref); },
    async saveBackup(envelopeId, targetId, value, { key }) {
      const ref = `backup-${sha256(Buffer.from(key)).slice(0, 16)}`;
      backups.set(ref, value === null ? null : Buffer.from(value));
      return ref;
    },
    async recordBlocked(envelopeId, detail) { entries.set(envelopeId, { status: "blocked", ...detail }); },
    async recordPending(envelopeId, detail) { entries.set(envelopeId, { status: "pending", ...detail }); },
    async recordPublishing(envelopeId, detail) { entries.set(envelopeId, { status: "publishing", envelopeId, ...detail }); },
    async recordTargetReceipt(envelopeId, receipt) {
      const entry = entries.get(envelopeId) ?? { targetReceipts: [] };
      entry.targetReceipts ??= [];
      entry.targetReceipts.push(receipt);
      entries.set(envelopeId, entry);
    },
    async recordRollback(envelopeId, receipts, detail) {
      entries.set(envelopeId, { ...entries.get(envelopeId), rollbackReceipts: receipts, ...detail });
    },
    async recordFailure(envelopeId, detail) { entries.set(envelopeId, { ...entries.get(envelopeId), status: "failed", ...detail }); },
    async recordComplete(envelopeId, detail) { entries.set(envelopeId, { status: "complete", ...detail }); },
  };
}

function makeTargets(initialValues = {}) {
  const values = new Map(destinations.map((id) => [id, Buffer.from(initialValues[id] ?? `old:${id}`)]));
  const stages = new Map();
  const targetStore = {
    values,
    async read(id) { return { available: true, bytes: values.has(id) ? Buffer.from(values.get(id)) : null }; },
    async stage(id, value, envelopeId) {
      const stageId = `${envelopeId}:${id}`;
      stages.set(stageId, Buffer.from(value));
      return { id: stageId, sha256: sha256(value) };
    },
    async discardStage(_id, stage) { stages.delete(stage.id); },
    async commit(id, stage, { expectedPriorSha256 } = {}) {
      const actualPriorSha256 = values.has(id) ? sha256(values.get(id)) : null;
      if (actualPriorSha256 !== expectedPriorSha256) throw new Error("target_prior_state_changed");
      values.set(id, Buffer.from(stages.get(stage.id)));
    },
    async restore(id, previousBytes) {
      if (previousBytes === null) values.delete(id);
      else values.set(id, Buffer.from(previousBytes));
    },
  };
  return targetStore;
}

function sourceReader() {
  return { async readFileAtCommit(commit, path) {
    assert.equal(commit, sourceCommit);
    assert.equal(path, CANONICAL_SKILL_SOURCE);
    return skillBytes;
  } };
}

function sourceFor(candidate) {
  return { async listCandidates() { return [candidate]; } };
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

test("exact matching approval is required before all five future-load copies", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
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
  assert.deepEqual([...targetStore.values.values()].map((value) => value.toString()), destinations.map((id) => `old:${id}`));

  ruling = {
    status: "ruled",
    approved: true,
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
    approved: true,
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
      approved: true,
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
    async read() { return requestedPlan && { status: "ruled", approved: true, envelopeId: requestedPlan.envelopeId, destinationSetSha256: requestedPlan.destinationSetSha256, destinationMapSha256: requestedPlan.destinationMapSha256, planSha256: requestedPlan.planSha256 }; },
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
    await originalCommit(id, stage, options);
  };

  const result = await runSkillDeliveryConsumer(args);
  assert.equal(result.results[0].status, "unresolved");
  assert.equal(targetStore.values.get(destinations[1]).toString(), "third-state");
  assert.equal(targetStore.values.get(destinations[0]).toString(), `old:${destinations[0]}`);
  const receipts = journal.entries.get(requestedPlan.envelopeId).targetReceipts;
  assert.equal(receipts.find((receipt) => receipt.targetId === destinations[1]).state, "conflict");
  const retry = await runSkillDeliveryConsumer(args);
  assert.equal(retry.results[0].code, "delivery_previous_attempt_unresolved");
  assert.equal(targetStore.values.get(destinations[1]).toString(), "third-state");
});

test("a restart reads back and rolls back an interrupted publication before retry", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
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
    async read() { return { status: "ruled", approved: true, envelopeId: "other-envelope" }; },
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

test("partial commit failure restores prior bytes in reverse order", async () => {
  const candidate = desktopCandidate();
  const targetStore = makeTargets();
  const journal = makeJournal();
  let requestedPlan;
  const approvals = {
    async read() { return requestedPlan && { status: "ruled", approved: true, envelopeId: requestedPlan.envelopeId, destinationSetSha256: requestedPlan.destinationSetSha256, destinationMapSha256: requestedPlan.destinationMapSha256, planSha256: requestedPlan.planSha256 }; },
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
    if (count === 2) throw new Error("destination unavailable");
    await originalCommit(id, stage, options);
  };

  const result = await runSkillDeliveryConsumer(args);
  assert.equal(result.results[0].status, "rolled_back");
  assert.deepEqual([...targetStore.values.values()].map((value) => value.toString()), destinations.map((id) => `old:${id}`));
  assert.equal(journal.entries.get(requestedPlan.envelopeId).rollbackReceipts[0].state, "restored");
});
