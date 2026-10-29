import { createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "./skill-delivery-runtime.mjs";
import { canonicalJson, sha256 } from "./skill-delivery-consumer.mjs";

const API_ORIGIN = "https://api.appstoreconnect.apple.com";
const COMMIT = /^[a-f0-9]{40}$/;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function createToken({ issuerId, keyId, privateKeyBytes, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iss: issuerId, iat: issuedAt, exp: issuedAt + 15 * 60, aud: "appstoreconnect-v1" }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(privateKeyBytes),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

function requireAscUrl(value, allowSignedArtifact = false) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || (!allowSignedArtifact && parsed.origin !== API_ORIGIN)) {
    throw new Error("delivery_asc_url_invalid");
  }
  return parsed;
}

export async function createAscReadOnlyClient({ issuerId, keyId, privateKeyPath, fetchImpl = fetch, now }) {
  const privateKeyBytes = await fs.readFile(privateKeyPath);
  const token = createToken({ issuerId, keyId, privateKeyBytes, now });
  const get = async (url, { signedArtifact = false } = {}) => {
    const parsed = requireAscUrl(url, signedArtifact);
    const headers = signedArtifact ? {} : { authorization: `Bearer ${token}`, accept: "application/json" };
    const response = await fetchImpl(parsed, { method: "GET", headers, redirect: "follow" });
    return response;
  };
  const getJson = async (url) => {
    const response = await get(url);
    if (!response.ok) throw new Error(`delivery_asc_get_failed:${response.status}`);
    try { return await response.json(); } catch { throw new Error("delivery_asc_json_invalid"); }
  };
  const getPaged = async (url) => {
    const data = [];
    const included = [];
    let next = String(url);
    while (next) {
      requireAscUrl(next);
      const page = await getJson(next);
      data.push(...(Array.isArray(page.data) ? page.data : []));
      included.push(...(Array.isArray(page.included) ? page.included : []));
      next = page.links?.next ?? "";
    }
    return { data, included };
  };
  const getArtifact = async (url) => {
    const response = await get(url, { signedArtifact: true });
    if ([403, 404].includes(response.status)) return null;
    if (!response.ok || !response.body) throw new Error(`delivery_asc_artifact_get_failed:${response.status}`);
    return response;
  };
  return { get, getJson, getPaged, getArtifact };
}

function includedResource(resources, type, id) {
  return resources.find((resource) => resource.type === type && resource.id === id) ?? null;
}

function sourceBranchRecord(run, included) {
  const relationship = run.relationships?.sourceBranchOrTag?.data;
  const resource = relationship && includedResource(included, relationship.type, relationship.id);
  const attributes = resource?.attributes ?? {};
  const gitRef = attributes.canonicalName ?? null;
  const branchName = attributes.name ?? (typeof gitRef === "string" ? gitRef.replace(/^refs\/heads\//, "") : null);
  return { branchName, gitRef };
}

function connectedBuildRecords(builds, included, bundleId) {
  const expandedBuilds = builds.map((reference) =>
    includedResource(included, reference?.type, reference?.id) ?? reference);
  const matches = expandedBuilds.filter((build) => {
    const app = build.relationships?.app?.data;
    if (!app) return false;
    const resource = includedResource(included, app.type, app.id);
    return resource?.attributes?.bundleId === bundleId;
  });
  if (matches.length > 1) throw new Error("delivery_asc_build_join_ambiguous");
  if (matches.length === 0) return null;
  const build = matches[0];
  const preRelease = build.relationships?.preReleaseVersion?.data;
  const preReleaseResource = preRelease && includedResource(included, preRelease.type, preRelease.id);
  return {
    id: build.id,
    appBuildNumber: build.attributes?.version ?? null,
    appVersion: preReleaseResource?.attributes?.version ?? null,
  };
}

async function listArchiveArtifacts(client, buildRunId) {
  const actionsUrl = `${API_ORIGIN}/v1/ciBuildRuns/${encodeURIComponent(buildRunId)}/actions?limit=200&fields%5BciBuildActions%5D=name,actionType,completionStatus,artifacts`;
  const actions = await client.getPaged(actionsUrl);
  const ids = new Set();
  for (const action of actions.data) {
    if (action.attributes?.completionStatus !== "SUCCEEDED") continue;
    let artifacts = action.relationships?.artifacts?.data ?? [];
    if (artifacts.length === 0) {
      const related = action.relationships?.artifacts?.links?.related ??
        `${API_ORIGIN}/v1/ciBuildActions/${encodeURIComponent(action.id)}/artifacts?limit=200`;
      artifacts = (await client.getPaged(related)).data;
    }
    for (const artifact of artifacts) {
      if (typeof artifact?.id === "string") ids.add(artifact.id);
    }
  }
  const archives = [];
  for (const id of ids) {
    const metadata = await client.getJson(`${API_ORIGIN}/v1/ciArtifacts/${encodeURIComponent(id)}?fields%5BciArtifacts%5D=fileType,fileName,fileSize,downloadUrl`);
    if (metadata.data?.attributes?.fileType === "ARCHIVE") archives.push(metadata.data);
  }
  return archives;
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function extractArchiveSkill(archivePath, command) {
  const { stdout: listing } = await command("unzip", ["-Z1", archivePath], { maxBuffer: 8 * 1024 * 1024 });
  const paths = listing.toString("utf8").split(/\r?\n/).filter(Boolean);
  const manifestPaths = paths.filter((entry) => entry.endsWith("/SurfAceOperatingSkill/manifest.json") || entry === "SurfAceOperatingSkill/manifest.json");
  const skillPaths = paths.filter((entry) => entry.endsWith("/SurfAceOperatingSkill/SKILL.md") || entry === "SurfAceOperatingSkill/SKILL.md");
  if (manifestPaths.length !== 1 || skillPaths.length !== 1) throw new Error("delivery_asc_archive_skill_missing_or_ambiguous");
  const [manifest, skill] = await Promise.all([
    command("unzip", ["-p", archivePath, manifestPaths[0]], { maxBuffer: 1024 * 1024 }),
    command("unzip", ["-p", archivePath, skillPaths[0]], { maxBuffer: 1024 * 1024 }),
  ]);
  return { manifestBytes: manifest.stdout, skillBytes: skill.stdout };
}

async function downloadArchive(client, metadata, { command = runCommand } = {}) {
  const downloadUrl = metadata.attributes?.downloadUrl;
  if (typeof downloadUrl !== "string") return null;
  const response = await client.getArtifact(downloadUrl);
  if (!response) return null;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-xcode-archive-"));
  const archivePath = path.join(directory, "build.xcarchive.zip");
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath, { mode: 0o600 }));
    if (Number.isSafeInteger(metadata.attributes?.fileSize) && (await fs.stat(archivePath)).size !== metadata.attributes.fileSize) {
      throw new Error("delivery_asc_archive_size_mismatch");
    }
    const artifactSha256 = await hashFile(archivePath);
    const extracted = await extractArchiveSkill(archivePath, command);
    return { ...extracted, artifactSha256 };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function collectXcodeCloudBuilds(config, { fetchImpl = fetch, command = runCommand, now, terminalEventKeys = [] } = {}) {
  if (typeof config.workflowId !== "string" || config.workflowId.length === 0 ||
      typeof config.bundleId !== "string" || config.bundleId.length === 0) {
    throw new Error("delivery_asc_app_identity_required");
  }
  const client = await createAscReadOnlyClient({ ...config, fetchImpl, now });
  const query = new URLSearchParams({
    limit: "200",
    sort: "-number",
    include: "workflow,sourceBranchOrTag,builds",
    "fields[ciBuildRuns]": "number,createdDate,sourceCommit,isPullRequestBuild,completionStatus,startReason,workflow,sourceBranchOrTag,builds",
    "fields[ciWorkflows]": "name",
    "fields[scmGitReferences]": "name,canonicalName",
    "fields[builds]": "version,app,preReleaseVersion",
    "fields[apps]": "bundleId",
    "fields[preReleaseVersions]": "version",
  });
  const workflowUrl = `${API_ORIGIN}/v1/ciWorkflows/${encodeURIComponent(config.workflowId)}/buildRuns?${query}`;
  const result = await client.getPaged(workflowUrl);
  const records = [];
  const terminal = new Set(terminalEventKeys);
  for (const run of result.data) {
    const attrs = run.attributes ?? {};
    const workflow = run.relationships?.workflow?.data;
    const sourceCommit = attrs.sourceCommit?.commitSha;
    const { branchName, gitRef } = sourceBranchRecord(run, result.included);
    if (workflow?.id !== config.workflowId || attrs.completionStatus !== "SUCCEEDED" ||
        attrs.isPullRequestBuild !== false || !COMMIT.test(sourceCommit ?? "") ||
        branchName !== "main" || gitRef !== "refs/heads/main" ||
        (config.createdAfter && typeof attrs.createdDate === "string" && attrs.createdDate < config.createdAfter)) continue;

    let connectedBuild = connectedBuildRecords(run.relationships?.builds?.data ?? [], result.included, config.bundleId);
    if (!connectedBuild) {
      const buildQuery = new URLSearchParams({
        limit: "50",
        include: "app,preReleaseVersion",
        "fields[builds]": "version,app,preReleaseVersion",
        "fields[apps]": "bundleId",
        "fields[preReleaseVersions]": "version",
      });
      const builds = await client.getPaged(`${API_ORIGIN}/v1/ciBuildRuns/${encodeURIComponent(run.id)}/builds?${buildQuery}`);
      connectedBuild = connectedBuildRecords(builds.data, builds.included, config.bundleId);
    }

    const buildRecordSha256 = sha256(Buffer.from(canonicalJson({ run, connectedBuild })));
    const identity = {
      releaseOrBuildId: run.id,
      buildId: run.id,
      buildNumber: String(attrs.number),
      workflowId: workflow.id,
      sourceCommit,
      sourceBranch: branchName,
      gitRef,
      completionStatus: attrs.completionStatus,
      isPullRequestBuild: attrs.isPullRequestBuild,
      startReason: attrs.startReason,
      buildRecordSha256,
      eventKey: sha256(Buffer.from(canonicalJson({
        source: "xcode-cloud-build",
        buildId: run.id,
        buildNumber: String(attrs.number),
        workflowId: workflow.id,
        sourceCommit,
        buildRecordSha256,
      }))),
      appVersion: connectedBuild?.appVersion ?? null,
      appBuildNumber: connectedBuild?.appBuildNumber ?? null,
      ...(connectedBuild ? {
        appStoreBuildId: connectedBuild.id,
        appStoreAppVersion: connectedBuild.appVersion,
        appStoreBuildNumber: connectedBuild.appBuildNumber,
      } : {}),
    };

    if (terminal.has(identity.eventKey)) continue;

    let artifacts;
    try {
      artifacts = await listArchiveArtifacts(client, run.id);
    } catch (error) {
      if (/delivery_asc_get_failed:(403|404)$/.test(error.message)) artifacts = [];
      else throw error;
    }
    if (artifacts.length > 1) {
      identity.archiveEvidence = "ambiguous";
      records.push({ identity, manifestBase64: null, skillBase64: null });
      continue;
    }
    if (artifacts.length === 1) {
      try {
        const archive = await downloadArchive(client, artifacts[0], { command });
        if (archive) {
          identity.archiveEvidence = "available";
          identity.artifactSha256 = archive.artifactSha256;
          records.push({
            identity,
            manifestBase64: archive.manifestBytes.toString("base64"),
            skillBase64: archive.skillBytes.toString("base64"),
          });
          continue;
        }
        identity.archiveEvidence = "unavailable";
      } catch {
        identity.archiveEvidence = "invalid";
        records.push({ identity, manifestBase64: null, skillBase64: null });
        continue;
      }
    } else {
      identity.archiveEvidence = "unavailable";
    }
    identity.appVersion = connectedBuild?.appVersion ?? null;
    identity.appBuildNumber = connectedBuild?.appBuildNumber ?? null;
    records.push({ identity, manifestBase64: null, skillBase64: null });
  }
  return records;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const configIndex = process.argv.indexOf("--config");
    if (configIndex < 0 || !process.argv[configIndex + 1]) throw new Error("asc_collector_config_required");
    const config = JSON.parse(await fs.readFile(process.argv[configIndex + 1], "utf8"));
    const terminalIndex = process.argv.indexOf("--terminal-event-keys-stdin");
    let terminalEventKeys = [];
    if (terminalIndex >= 0) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(input?.terminalEventKeys) ||
          input.terminalEventKeys.some((key) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))) {
        throw new Error("asc_terminal_event_keys_invalid");
      }
      terminalEventKeys = input.terminalEventKeys;
    }
    const records = await collectXcodeCloudBuilds(config, { terminalEventKeys });
    process.stdout.write(`${JSON.stringify(records)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
