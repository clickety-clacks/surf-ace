import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectXcodeCloudBuilds, createAscReadOnlyClient } from "./asc-build-collector.mjs";
import { canonicalJson, sha256, verifyDeliveryCandidate } from "./skill-delivery-consumer.mjs";
import {
  createFileDeliveryJournal,
  createGitHubSourceReader,
  createGitHubReleaseSource,
  createRuntime,
  createOwnerSessionIdentityAdapter,
  createSshTargetAdapter,
  createApprovalHandoffAdapter,
  createXcodeCloudSource,
} from "./skill-delivery-runtime.mjs";

async function withPrivateKey(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-delivery-test-"));
  const privateKeyPath = path.join(directory, "asc-key.p8");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await fs.writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  try { return await callback({ directory, privateKeyPath }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("disabled runtime exits before invoking any source or target command", async () => {
  let commands = 0;
  const result = await createRuntime({ enabled: false }, {
    command: async () => { commands += 1; throw new Error("command must not run"); },
  });
  assert.deepEqual(result, { status: "disabled", processed: 0 });
  assert.equal(commands, 0);
});

test("a ruled source tag is dereferenced to the exact commit", async () => {
  const calls = [];
  const reader = createGitHubSourceReader({
    owner: "example-owner",
    repo: "example-repo",
    command: async (_file, args) => {
      calls.push(args);
      const endpoint = args[1];
      if (endpoint.endsWith("/git/ref/tags/release-1")) {
        return { stdout: Buffer.from(JSON.stringify({ object: { type: "tag", sha: "a".repeat(40) } })) };
      }
      if (endpoint.endsWith(`/git/tags/${"a".repeat(40)}`)) {
        return { stdout: Buffer.from(JSON.stringify({ object: { type: "commit", sha: "b".repeat(40) } })) };
      }
      throw new Error(`unexpected GitHub request: ${endpoint}`);
    },
  });

  assert.equal(await reader.readTagCommit("release-1"), "b".repeat(40));
  assert.equal(calls.length, 2);
});

test("GitHub collection reads the published release manifest, checksums and canonical skill asset", async () => {
  const skillBytes = Buffer.from("# release skill\n");
  const executableName = "surf-ace-cli-linux-x64.tar.gz";
  const skillName = "surf-ace-SKILL.md";
  const manifestAssetName = "surf-ace-v0.2.10-manifest.json";
  const manifestBytes = Buffer.from(JSON.stringify({
    version: "0.2.10",
    source: { commit: "a".repeat(40), tag: "surf-ace-v0.2.10-r1" },
    tooling: { commit: "b".repeat(40), tag: "surf-ace-tools-v0.2.10-r1" },
    operatingSkill: { asset: skillName },
    assets: [
      { name: executableName, sha256: "c".repeat(64) },
      { name: skillName, sha256: sha256(skillBytes) },
    ],
  }));
  const checksumBytes = Buffer.from([
    `${"c".repeat(64)}  ${executableName}`,
    `${sha256(skillBytes)}  ${skillName}`,
    `${sha256(manifestBytes)}  ${manifestAssetName}`,
    "",
  ].join("\n"));
  const release = {
    id: 42,
    tag_name: "surf-ace-v0.2.10-r1",
    published_at: "2026-10-28T12:00:00Z",
    draft: false,
    assets: [
      { id: 1, name: manifestAssetName },
      { id: 2, name: "SHA256SUMS" },
      { id: 3, name: skillName, digest: `sha256:${sha256(skillBytes)}` },
      { id: 4, name: executableName, digest: `sha256:${"c".repeat(64)}` },
    ],
  };
  const requested = [];
  const source = createGitHubReleaseSource({
    owner: "example-owner",
    repo: "surf-ace",
    publishedAfter: "2026-10-01T00:00:00Z",
    command: async (_file, args) => {
      if (args.includes("--paginate")) return { stdout: Buffer.from(JSON.stringify([release])) };
      const assetId = Number(/\/assets\/(\d+)$/.exec(args[1])?.[1]);
      requested.push(assetId);
      const assetBytes = new Map([[1, manifestBytes], [2, checksumBytes], [3, skillBytes]]).get(assetId);
      if (!assetBytes) throw new Error("unexpected release asset read");
      return { stdout: assetBytes };
    },
  });

  const [candidate] = await source.listCandidates();
  assert.deepEqual(requested, [1, 2, 3]);
  assert.equal(candidate.identity.releaseOrBuildId, "github-release-42");
  assert.equal(candidate.identity.sourceCommit, "a".repeat(40));
  assert.equal(candidate.identity.manifestAssetSha256, sha256(manifestBytes));
  assert.equal(candidate.identity.artifactSha256, sha256(checksumBytes));
  assert.deepEqual(candidate.skillBytes, skillBytes);
  assert.deepEqual(candidate.checksumBytes, checksumBytes);
  assert.deepEqual(await source.listCandidates({ terminalEventKeys: [candidate.identity.eventKey] }), []);
  assert.deepEqual(requested, [1, 2, 3]);
});

test("the ASC API client sends read-only GET requests and rejects other origins", async () => {
  await withPrivateKey(async ({ privateKeyPath }) => {
    const requests = [];
    const client = await createAscReadOnlyClient({
      issuerId: "issuer-fixture",
      keyId: "key-fixture",
      privateKeyPath,
      now: 1_800_000_000_000,
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), ...options });
        return jsonResponse({ data: [] });
      },
    });
    await client.getJson("https://api.appstoreconnect.apple.com/v1/apps");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.match(requests[0].headers.authorization, /^Bearer [A-Za-z0-9_.-]+$/);
    await assert.rejects(() => client.getJson("https://example.invalid/v1/apps"), /delivery_asc_url_invalid/);
    assert.equal(requests.length, 1);
  });
});

test("ASC collection binds successful main builds to the configured app and hashes the build record", async () => {
  await withPrivateKey(async ({ privateKeyPath }) => {
    const sourceCommit = "a".repeat(40);
    const requests = [];
    const fetchImpl = async (url, options) => {
      const parsed = new URL(url);
      requests.push({ url: parsed, options });
      assert.equal(options.method, "GET");
      if (parsed.pathname === "/v1/ciWorkflows/workflow-fixture/buildRuns") {
        return jsonResponse({
          data: [{
            id: "xcode-run-42",
            type: "ciBuildRuns",
            attributes: {
              number: 42,
              createdDate: "2026-10-28T12:00:00Z",
              sourceCommit: { commitSha: sourceCommit },
              isPullRequestBuild: false,
              completionStatus: "SUCCEEDED",
              startReason: "SCM_PUSH",
            },
            relationships: {
              workflow: { data: { type: "ciWorkflows", id: "workflow-fixture" } },
              sourceBranchOrTag: { data: { type: "scmGitReferences", id: "main-ref" } },
              builds: { data: [{ type: "builds", id: "app-build-30" }] },
            },
          }],
          included: [
            { id: "workflow-fixture", type: "ciWorkflows", attributes: { name: "Surf Ace build workflow" } },
            { id: "main-ref", type: "scmGitReferences", attributes: { name: "main", canonicalName: "refs/heads/main" } },
            {
              id: "app-build-30",
              type: "builds",
              attributes: { version: "30" },
              relationships: {
                app: { data: { type: "apps", id: "app-fixture" } },
                preReleaseVersion: { data: { type: "preReleaseVersions", id: "version-fixture" } },
              },
            },
            { id: "app-fixture", type: "apps", attributes: { bundleId: "co.example.surf" } },
            { id: "version-fixture", type: "preReleaseVersions", attributes: { version: "0.1.0" } },
          ],
        });
      }
      if (parsed.pathname === "/v1/ciBuildRuns/xcode-run-42/actions") return jsonResponse({ data: [] });
      throw new Error(`unexpected ASC request: ${parsed.pathname}`);
    };
    const records = await collectXcodeCloudBuilds({
      issuerId: "issuer-fixture",
      keyId: "key-fixture",
      privateKeyPath,
      workflowId: "workflow-fixture",
      bundleId: "co.example.surf",
      startReasonToCondition: { SCM_PUSH: "push" },
    }, { fetchImpl, now: 1_800_000_000_000 });

    assert.equal(records.length, 1);
    assert.equal(records[0].identity.buildId, "xcode-run-42");
    assert.equal(records[0].identity.sourceCommit, sourceCommit);
    assert.equal(records[0].identity.appStoreBuildId, "app-build-30");
    assert.equal(records[0].identity.appStoreBuildNumber, "30");
    assert.equal(records[0].identity.appStoreAppVersion, "0.1.0");
    assert.equal(records[0].identity.appBuildNumber, "30");
    assert.equal(records[0].identity.appVersion, "0.1.0");
    assert.match(records[0].identity.buildRecordSha256, /^[a-f0-9]{64}$/);
    assert.match(records[0].identity.eventKey, /^[a-f0-9]{64}$/);
    assert.equal(records[0].manifestBase64, null);
    assert.ok(requests.every(({ options }) => options.method === "GET"));
    const beforeSkip = requests.length;
    assert.deepEqual(await collectXcodeCloudBuilds({
      issuerId: "issuer-fixture",
      keyId: "key-fixture",
      privateKeyPath,
      workflowId: "workflow-fixture",
      bundleId: "co.example.surf",
      startReasonToCondition: { SCM_PUSH: "push" },
    }, { fetchImpl, now: 1_800_000_000_000, terminalEventKeys: [records[0].identity.eventKey] }), []);
    assert.equal(requests.length, beforeSkip + 1);
    assert.equal(requests.at(-1).url.pathname, "/v1/ciWorkflows/workflow-fixture/buildRuns");
  });
});

test("ASC fallback reconstructs only the configured build-time skill contract at its source commit", async () => {
  const skillBytes = Buffer.from("# exact canonical skill\n");
  const scriptBytes = Buffer.from([
    'source_sha=$(hash_file "$skill_source")',
    'embedded_sha=$(hash_file "$skill_tmp")',
    '[ "$source_sha" = "$embedded_sha" ]',
    '"sha256": "$embedded_sha"',
    '"xcodeCloudCommit": "$cloud_commit"',
  ].join("\n"));
  const projectBytes = Buffer.from(`  SurfAce:\n    postBuildScripts:\n      - name: Embed Surf Ace operating skill\n        path: scripts/embed-operating-skill.sh\n        basedOnDependencyAnalysis: false\n        settings:\n          MARKETING_VERSION: 0.1.0\n          CURRENT_PROJECT_VERSION: 17\n  SurfAceSpatial:\n    settings:\n      MARKETING_VERSION: 0.1.0\n      CURRENT_PROJECT_VERSION: 17\n`);
  const sourceCommit = "b".repeat(40);
  const record = {
    identity: {
      releaseOrBuildId: "xcode-run-43",
      buildId: "xcode-run-43",
      buildNumber: "43",
      workflowId: "workflow-fixture",
      sourceCommit,
      sourceBranch: "main",
      gitRef: "refs/heads/main",
      completionStatus: "SUCCEEDED",
      isPullRequestBuild: false,
      startReason: "SCM_PUSH",
      buildRecordSha256: "c".repeat(64),
      appStoreBuildId: "app-build-30",
      appStoreAppVersion: "0.1.0",
      appStoreBuildNumber: "30",
    },
    manifestBase64: null,
    skillBase64: null,
  };
  const sourceReader = {
    async readFileAtCommit(_commit, filePath) {
      if (filePath === "integrations/tightbeam/skills/surf-ace/SKILL.md") return skillBytes;
      if (filePath === "packages/ios/scripts/embed-operating-skill.sh") return scriptBytes;
      if (filePath === "packages/ios/project.yml") return projectBytes;
      throw new Error(`unexpected source path: ${filePath}`);
    },
  };
  const source = createXcodeCloudSource({
    sshTarget: "collector-fixture",
    collectorScript: "/private/collector.mjs",
    collectorConfig: "/private/asc.json",
    expectedWorkflowId: "workflow-fixture",
    startReasonToCondition: { SCM_PUSH: "push" },
    sourceReader,
    command: async () => ({ stdout: Buffer.from(JSON.stringify([record])), stderr: Buffer.alloc(0) }),
  });

  const [candidate] = await source.listCandidates();
  const manifest = JSON.parse(candidate.manifestBytes.toString("utf8"));
  assert.equal(candidate.identity.sourceCommit, sourceCommit);
  assert.equal(candidate.identity.appBuildNumber, "30");
  assert.equal(candidate.identity.appStoreBuildNumber, "30");
  assert.equal(candidate.identity.manifestAppBuildNumber, "17");
  assert.equal(candidate.identity.deliveryRoute, "source-commit-fallback");
  assert.equal(manifest.appBuildNumber, "17");
  assert.equal(manifest.operatingSkill.sha256, sha256(skillBytes));
  assert.equal(manifest.xcodeCloudBuildId, "xcode-run-43");
});

test("Xcode Cloud archive keeps ASC build 30 distinct from embedded manifest build 17", async () => {
  const skillBytes = Buffer.from("# build 30 skill\n");
  const sourceCommit = "a".repeat(40);
  const manifestBytes = Buffer.from(JSON.stringify({
    appVersion: "0.1.0",
    appBuildNumber: "17",
    operatingSkill: {
      asset: "SurfAceOperatingSkill/SKILL.md",
      clientPlatforms: ["ios"],
      publication: "app-bundle",
      sha256: sha256(skillBytes),
      sourcePath: "integrations/tightbeam/skills/surf-ace/SKILL.md",
      version: "0.1.0",
    },
    xcodeCloudBuildId: "xcode-run-30",
    xcodeCloudBuildNumber: "30",
    xcodeCloudCommit: sourceCommit,
    xcodeCloudWorkflowId: "workflow-fixture",
    xcodeCloudStartCondition: "push",
    xcodeCloudBranch: "main",
    xcodeCloudGitRef: "refs/heads/main",
    xcodeCloudScheme: "SurfAce",
    xcodeCloudPlatform: "iOS",
    xcodeCloudAction: "archive",
  }));
  const record = {
    identity: {
      releaseOrBuildId: "xcode-run-30",
      buildId: "xcode-run-30",
      buildNumber: "30",
      workflowId: "workflow-fixture",
      sourceCommit,
      eventKey: "f".repeat(64),
      sourceBranch: "main",
      gitRef: "refs/heads/main",
      completionStatus: "SUCCEEDED",
      isPullRequestBuild: false,
      startReason: "SCM_PUSH",
      buildRecordSha256: "c".repeat(64),
      appStoreBuildId: "app-build-30",
      appStoreAppVersion: "0.1.0",
      appStoreBuildNumber: "30",
      archiveEvidence: "available",
      artifactSha256: "d".repeat(64),
    },
    manifestBase64: manifestBytes.toString("base64"),
    skillBase64: skillBytes.toString("base64"),
  };
  const source = createXcodeCloudSource({
    sshTarget: "collector-fixture",
    collectorScript: "/private/collector.mjs",
    collectorConfig: "/private/asc.json",
    expectedWorkflowId: "workflow-fixture",
    startReasonToCondition: { SCM_PUSH: "push" },
    sourceReader: {},
    command: async (_file, _args, options) => {
      assert.deepEqual(JSON.parse(options.input.toString("utf8")), { terminalEventKeys: [] });
      return { stdout: Buffer.from(JSON.stringify([record])), stderr: Buffer.alloc(0) };
    },
  });
  const [candidate] = await source.listCandidates();
  const verified = await verifyDeliveryCandidate(candidate, {
    destinations: [{
      id: "shared", kind: "shared-identity", host: "fixture", path: "/fixture/SKILL.md",
      writer: "supported-identity-cli", route: { identityArchetype: "fixture", identitySkillName: "surf-ace" },
      effects: { service: "future loads", database: "publication record", downtime: "none" },
    }],
    sourceReader: {
      async readFileAtCommit() { return skillBytes; },
    },
  });

  assert.equal(candidate.identity.appBuildNumber, "30");
  assert.equal(candidate.identity.manifestAppBuildNumber, "17");
  assert.equal(candidate.identity.deliveryRoute, "xcode-cloud-archive");
  assert.equal(verified.envelope.appBuildNumber, "30");
  assert.equal(verified.envelope.buildIdentity.manifestAppBuildNumber, "17");
  assert.equal(verified.envelope.buildIdentity.appStoreBuildNumber, "30");
  assert.equal(verified.envelope.buildIdentity.deliveryRoute, "xcode-cloud-archive");
});

test("ASC fallback accepts the repository's actual iOS target and canonical skill source", async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const files = new Map([
    ["integrations/tightbeam/skills/surf-ace/SKILL.md", await fs.readFile(path.join(repoRoot, "integrations/tightbeam/skills/surf-ace/SKILL.md"))],
    ["packages/ios/scripts/embed-operating-skill.sh", await fs.readFile(path.join(repoRoot, "packages/ios/scripts/embed-operating-skill.sh"))],
    ["packages/ios/project.yml", await fs.readFile(path.join(repoRoot, "packages/ios/project.yml"))],
  ]);
  const sourceCommit = "d".repeat(40);
  const record = {
    identity: {
      releaseOrBuildId: "xcode-run-44",
      buildId: "xcode-run-44",
      buildNumber: "44",
      workflowId: "workflow-fixture",
      sourceCommit,
      sourceBranch: "main",
      gitRef: "refs/heads/main",
      completionStatus: "SUCCEEDED",
      isPullRequestBuild: false,
      startReason: "SCM_PUSH",
      buildRecordSha256: "f".repeat(64),
      archiveEvidence: "unavailable",
    },
    manifestBase64: null,
    skillBase64: null,
  };
  const source = createXcodeCloudSource({
    sshTarget: "collector-fixture",
    collectorScript: "/private/collector.mjs",
    collectorConfig: "/private/asc.json",
    expectedWorkflowId: "workflow-fixture",
    startReasonToCondition: { SCM_PUSH: "push" },
    sourceReader: {
      async readFileAtCommit(_commit, filePath) {
        assert.ok(files.has(filePath), `expected canonical source file ${filePath}`);
        return files.get(filePath);
      },
    },
    command: async () => ({ stdout: Buffer.from(JSON.stringify([record])), stderr: Buffer.alloc(0) }),
  });

  const [candidate] = await source.listCandidates();
  const manifest = JSON.parse(candidate.manifestBytes.toString("utf8"));
  assert.equal(manifest.operatingSkill.sha256, sha256(files.get("integrations/tightbeam/skills/surf-ace/SKILL.md")));
  assert.equal(manifest.xcodeCloudCommit, sourceCommit);
  assert.equal(manifest.xcodeCloudBuildId, "xcode-run-44");
});

test("shared identity changes use a bound owner-session handoff and never SSH", async () => {
  const priorBytes = Buffer.from("prior skill\n");
  const nextBytes = Buffer.from("next skill\n");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-owner-identity-test-"));
  const { destination, plan, approval, commitOptions } = ownerIdentityFixture();
  let current = priorBytes;
  let revision = 1;
  const command = async (file, _args, { input }) => {
    assert.equal(file, "private-owner-session-handoff");
    const descriptor = JSON.parse(input.toString("utf8"));
    const request = JSON.parse(await fs.readFile(descriptor.requestPath, "utf8"));
    let readback;
    if (request.action === "read") {
      readback = current;
    } else {
      assert.equal(request.approvalHandoffId, "approval-handoff-1");
      assert.equal(request.requestRef, "decision-1");
      assert.equal(request.approval.requestRef, "decision-1");
      assert.equal(sha256(current), request.expectedPriorSha256);
      current = request.desiredBytesBase64 === null ? null : Buffer.from(request.desiredBytesBase64, "base64");
      revision += 1;
      readback = current;
    }
    const digest = readback === null ? null : sha256(readback);
    const result = {
      status: "complete",
      operationId: request.operationId,
      action: request.action,
      targetId: request.targetId,
      identityRevision: `revision-${revision}`,
      bytesBase64: readback === null ? null : readback.toString("base64"),
      sha256: digest,
      envelopeId: request.envelopeId,
      planSha256: request.planSha256,
      destinationSetSha256: request.destinationSetSha256,
      destinationMapSha256: request.destinationMapSha256,
      approvalHandoffId: request.approvalHandoffId,
      requestRef: request.requestRef,
      decision: request.approval?.decision,
      rulingPrincipal: request.approval?.ruling?.principal,
      rulingOnBehalfOf: request.approval?.ruling?.onBehalfOf,
      priorSha256: request.expectedPriorSha256,
      desiredSha256: request.desiredSha256,
      finalSha256: digest,
      readbackSha256: digest,
      readbackBase64: readback === null ? null : readback.toString("base64"),
    };
    await fs.mkdir(path.dirname(descriptor.resultPath), { recursive: true });
    await fs.writeFile(descriptor.resultPath, JSON.stringify(result));
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const targets = createOwnerSessionIdentityAdapter([destination], {
    directory,
    handoffCommand: "private-owner-session-handoff",
    requiredRuler: "user:operator",
    command,
  });
  try {
    assert.deepEqual((await targets.read(destination.id)).bytes, priorBytes);
    const stage = await targets.stage(destination.id, nextBytes, plan.envelopeId);
    const committed = await targets.commit(destination.id, stage, commitOptions);
    assert.equal(committed.status, "complete");
    assert.equal(committed.ownerReceipt.action, "commit");
    assert.deepEqual(committed.readback.bytes, nextBytes);
    const restored = await targets.restore(destination.id, priorBytes, {
      envelopeId: plan.envelopeId,
      plan,
      planSha256: plan.planSha256,
      approval,
      expectedCurrentSha256: sha256(nextBytes),
      destinationSetSha256: plan.destinationSetSha256,
      destinationMapSha256: plan.destinationMapSha256,
    });
    assert.equal(restored.ownerReceipt.action, "restore");
    assert.deepEqual(restored.readback.bytes, priorBytes);
    assert.throws(() => createSshTargetAdapter([destination]), /delivery_ssh_shared_identity_forbidden/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("pending owner-session reads reuse one operation and return the later readback", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-owner-read-resume-test-"));
  const { destination } = ownerIdentityFixture();
  const current = Buffer.from("current shared skill\n");
  const operationId = "a".repeat(64);
  const requests = [];
  let calls = 0;
  const targets = createOwnerSessionIdentityAdapter([destination], {
    directory,
    handoffCommand: "private-owner-session-handoff",
    requiredRuler: "user:operator",
    command: async (_file, _args, { input }) => {
      calls += 1;
      const descriptor = JSON.parse(input.toString("utf8"));
      requests.push(descriptor);
      const request = JSON.parse(await fs.readFile(descriptor.requestPath, "utf8"));
      assert.equal(request.operationId, operationId);
      assert.equal(request.action, "read");
      if (calls === 1) {
        await fs.mkdir(path.dirname(descriptor.resultPath), { recursive: true });
        await fs.writeFile(descriptor.resultPath, JSON.stringify({ status: "pending", operationId }));
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      const result = {
        status: "complete",
        operationId,
        action: "read",
        targetId: destination.id,
        identityRevision: "revision-after-owner-read",
        bytesBase64: current.toString("base64"),
        sha256: sha256(current),
      };
      await fs.mkdir(path.dirname(descriptor.resultPath), { recursive: true });
      await fs.writeFile(descriptor.resultPath, JSON.stringify(result));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  try {
    const first = await targets.read(destination.id, { operationId });
    assert.deepEqual(first, { status: "pending", operationId });
    const second = await targets.read(destination.id, { operationId });
    assert.deepEqual(second.bytes, current);
    assert.equal(second.identityRevision, "revision-after-owner-read");
    assert.equal(calls, 2);
    assert.equal(requests[0].operationId, requests[1].operationId);
    assert.equal(requests[0].requestPath, requests[1].requestPath);
    assert.equal(requests[0].resultPath, requests[1].resultPath);
    assert.equal((await fs.readdir(path.join(directory, "shared-identity-requests"))).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function ownerIdentityFixture() {
  const destination = {
    id: "shared-skill",
    kind: "shared-identity",
    host: "configured-host",
    path: "/configured/identity/skills/surf-ace/SKILL.md",
    writer: "supported-identity-cli",
    route: { identityArchetype: "configured-archetype", identitySkillName: "surf-ace" },
    effects: { service: "future loads", database: "publication record", downtime: "none" },
  };
  const plan = {
    envelopeId: "event-1",
    envelope: { skillSha256: sha256(Buffer.from("next skill\n")) },
    destinationSetSha256: "b".repeat(64),
    destinationMapSha256: "c".repeat(64),
    snapshots: [{
      targetId: "shared-skill",
      priorSha256: sha256(Buffer.from("prior skill\n")),
      priorMode: null,
      targetMode: null,
    }],
  };
  plan.planSha256 = sha256(canonicalJson(plan));
  const approval = {
    status: "ruled",
    decision: "approve",
    handoffId: "approval-handoff-1",
    requestRef: "decision-1",
    ruling: { principal: "user:operator", onBehalfOf: "user:operator" },
    envelopeId: plan.envelopeId,
    planSha256: plan.planSha256,
    destinationSetSha256: plan.destinationSetSha256,
    destinationMapSha256: plan.destinationMapSha256,
  };
  return {
    destination,
    plan,
    approval,
    commitOptions: {
      envelopeId: plan.envelopeId,
      plan,
      planSha256: plan.planSha256,
      approval,
      destinationSetSha256: plan.destinationSetSha256,
      destinationMapSha256: plan.destinationMapSha256,
      expectedPriorSha256: sha256(Buffer.from("prior skill\n")),
    },
  };
}

test("owner-session write remains pending when its receipt is absent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-owner-pending-test-"));
  const { destination, commitOptions } = ownerIdentityFixture();
  try {
    const targets = createOwnerSessionIdentityAdapter([destination], {
      directory,
      handoffCommand: "private-owner-session-handoff",
      requiredRuler: "user:operator",
      command: async (_file, _args, { input }) => {
        const descriptor = JSON.parse(input.toString("utf8"));
        const request = JSON.parse(await fs.readFile(descriptor.requestPath, "utf8"));
        assert.equal(request.action, "commit");
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    const stage = await targets.stage(destination.id, Buffer.from("next skill\n"), commitOptions.envelopeId);
    const result = await targets.commit(destination.id, stage, commitOptions);
    assert.equal(result.status, "pending");
    assert.match(result.operationId, /^[a-f0-9]{64}$/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("owner-session write rejects a mismatched receipt", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-owner-mismatch-test-"));
  const { destination, commitOptions } = ownerIdentityFixture();
  try {
    const targets = createOwnerSessionIdentityAdapter([destination], {
      directory,
      handoffCommand: "private-owner-session-handoff",
      requiredRuler: "user:operator",
      command: async (_file, _args, { input }) => {
        const descriptor = JSON.parse(input.toString("utf8"));
        const request = JSON.parse(await fs.readFile(descriptor.requestPath, "utf8"));
        await fs.mkdir(path.dirname(descriptor.resultPath), { recursive: true });
        await fs.writeFile(descriptor.resultPath, JSON.stringify({
          status: "complete",
          operationId: request.operationId,
          action: "commit",
          targetId: request.targetId,
          identityRevision: "revision-2",
          envelopeId: request.envelopeId,
          planSha256: request.planSha256,
          destinationSetSha256: request.destinationSetSha256,
          destinationMapSha256: request.destinationMapSha256,
          approvalHandoffId: "another-approval",
          requestRef: request.requestRef,
          decision: "approve",
          rulingPrincipal: "user:operator",
          rulingOnBehalfOf: "user:operator",
          priorSha256: request.expectedPriorSha256,
          desiredSha256: request.desiredSha256,
          finalSha256: request.desiredSha256,
          readbackSha256: request.desiredSha256,
          readbackBase64: request.desiredBytesBase64,
        }));
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    const stage = await targets.stage(destination.id, Buffer.from("next skill\n"), commitOptions.envelopeId);
    await assert.rejects(() => targets.commit(destination.id, stage, commitOptions), /delivery_identity_receipt_mismatch/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("standalone SSH copies stage and commit with the existing file mode", async () => {
  const priorBytes = Buffer.from("prior skill\n");
  const nextBytes = Buffer.from("next skill\n");
  const calls = [];
  const destination = {
    id: "standalone-skill",
    kind: "standalone-skill",
    host: "configured-host",
    path: "/configured/codex/skills/surf-ace/SKILL.md",
    writer: "existing-ssh",
    route: { sshTarget: "configured-alias" },
    effects: { service: "future loads", database: "none", downtime: "none" },
  };
  const targets = createSshTargetAdapter([destination], {
    command: async (file, args, options = {}) => {
      calls.push({ file, args, options });
      if (args[2].includes("PRESENT")) {
        return { stdout: Buffer.concat([Buffer.from("PRESENT 640\n"), priorBytes]), stderr: Buffer.alloc(0) };
      }
      if (args[2].includes("cat >")) {
        return { stdout: Buffer.from(`${sha256(options.input)}\n`), stderr: Buffer.alloc(0) };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });

  assert.deepEqual(await targets.read(destination.id), { available: true, bytes: priorBytes, mode: 0o640 });
  const stage = await targets.stage(destination.id, nextBytes, "f".repeat(64), { mode: 0o640 });
  assert.equal(stage.sha256, sha256(nextBytes));
  await targets.commit(destination.id, stage, {
    expectedPriorSha256: sha256(priorBytes),
    expectedPriorMode: 0o640,
    targetMode: 0o640,
  });
  assert.ok(calls.some(({ args }) => args[2].includes("chmod 640")));
  assert.ok(calls.some(({ args }) => args[2].includes("mode") && args[2].includes("640") && args[2].includes("mv -f")));
});

test("approval handoff keeps one exact event request and accepts only its ruled owner receipt", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-approval-test-"));
  try {
    const plan = {
      envelopeId: "event-1",
      envelope: { releaseOrBuildId: "event-1", skillSha256: "d".repeat(64) },
      planSha256: "e".repeat(64),
      destinationSetSha256: "f".repeat(64),
      destinationMapSha256: "f".repeat(64),
    };
    let requestCount = 0;
    let requestDescriptor;
    const adapter = createApprovalHandoffAdapter({
      directory,
      handoffCommand: "private-approval-handoff",
      requiredRuler: "user:operator",
      command: async (file, _args, { input }) => {
        assert.equal(file, "private-approval-handoff");
        requestCount += 1;
        requestDescriptor = JSON.parse(input.toString("utf8"));
        const request = JSON.parse(await fs.readFile(requestDescriptor.requestPath, "utf8"));
        assert.equal(request.planSha256, plan.planSha256);
        assert.deepEqual(request.plan, plan);
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });

    await adapter.request(plan);
    assert.equal((await adapter.read(plan.envelopeId, plan.planSha256)).status, "pending");
    await adapter.request(plan);
    assert.equal(requestCount, 1, "repeated scans must reuse one event handoff");

    const receipt = {
      handoffId: requestDescriptor.handoffId,
      requestRef: "ruled-decision-record",
      status: "ruled",
      decision: "approve",
      ruling: {
        principal: "user:operator",
        onBehalfOf: "user:operator",
        performer: { kind: "agent-session" },
      },
      envelopeId: plan.envelopeId,
      planSha256: plan.planSha256,
      destinationSetSha256: plan.destinationSetSha256,
      destinationMapSha256: plan.destinationMapSha256,
    };
    await fs.mkdir(path.dirname(requestDescriptor.resultPath), { recursive: true });
    await fs.writeFile(requestDescriptor.resultPath, `${JSON.stringify(receipt)}\n`);
    assert.equal((await adapter.read(plan.envelopeId, plan.planSha256)).ruling.principal, "user:operator");
    receipt.ruling.onBehalfOf = "user:other";
    await fs.writeFile(requestDescriptor.resultPath, `${JSON.stringify(receipt)}\n`);
    assert.equal((await adapter.read(plan.envelopeId, plan.planSha256)).status, "mismatch");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("file journal retains no-change state, high-water and exact backup bytes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-delivery-journal-test-"));
  try {
    const journal = await createFileDeliveryJournal(directory);
    const highWater = { sourceCommit: "d".repeat(40), skillSha256: "e".repeat(64) };
    await journal.initializeHighWater(highWater);
    const backup = Buffer.from("previous skill bytes\n");
    const ref = await journal.saveBackup("event-1", "destination-1", backup, { key: "fixed-key" });
    await journal.recordNoChange("event-2", {
      targetReceipts: [{ targetId: "destination-1", finalSha256: sha256(backup) }],
      highWater,
      terminalEventKey: "f".repeat(64),
    });

    const reloaded = await createFileDeliveryJournal(directory);
    assert.deepEqual(await reloaded.readHighWater(), highWater);
    assert.deepEqual(await reloaded.readBackup("event-1", "destination-1", ref), backup);
    assert.equal((await reloaded.read("event-2")).status, "no_change");
    assert.deepEqual(await reloaded.listTerminalEventKeys(), ["f".repeat(64)]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
