import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CANONICAL_SKILL_SOURCE,
  canonicalJson,
  renderIphoneManifest,
  sha256,
} from "./skill-delivery-consumer.mjs";

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function runCommand(file, args, { input, cwd, env, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputSize = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(error);
    };
    child.on("error", () => fail(new Error(`command_unavailable:${path.basename(file)}`)));
    child.stdout.on("data", (chunk) => {
      outputSize += chunk.length;
      if (outputSize > maxBuffer) return fail(new Error("command_output_limit_exceeded"));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) return reject(new Error(`command_failed:${path.basename(file)}:${code}`));
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end(input);
  });
}

function parseJson(bytes, code) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(code); }
}

async function commandJson(file, args, options = {}) {
  const { command = runCommand, ...commandOptions } = options;
  const { stdout } = await command(file, args, commandOptions);
  return parseJson(stdout, "delivery_command_json_invalid");
}

function safeAssetName(name) {
  return typeof name === "string" && /^[A-Za-z0-9._+-]+$/.test(name) && name !== "." && name !== "..";
}

function releaseEventKey(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return sha256(Buffer.from(canonicalJson({
    source: "github-release",
    id: release.id,
    tag: release.tag_name ?? null,
    updatedAt: release.updated_at ?? null,
    assets: assets.map(({ id, name, digest, size, updated_at }) => ({
      id: id ?? null,
      name: name ?? null,
      digest: digest ?? null,
      size: size ?? null,
      updatedAt: updated_at ?? null,
    })),
  })));
}

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flat(Infinity).filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

async function downloadReleaseAsset({ owner, repo, assetId, name, command = runCommand }) {
  if (!safeAssetName(name) || !Number.isSafeInteger(assetId) || assetId <= 0) {
    throw new Error("delivery_release_asset_identity_invalid");
  }
  const { stdout } = await command("gh", [
    "api",
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${assetId}`,
    "--header", "Accept: application/octet-stream",
  ]);
  return stdout;
}

export function createGitHubSourceReader({ owner, repo, command = runCommand }) {
  const repository = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const readTagCommit = async (tag) => {
    if (typeof tag !== "string" || tag.length === 0 || tag.startsWith("/") || tag.split("/").includes("..")) {
      throw new Error("delivery_source_tag_invalid");
    }
    const encodedTag = tag.split("/").map(encodeURIComponent).join("/");
    let response = await commandJson("gh", ["api", `${repository}/git/ref/tags/${encodedTag}`], { command });
    let object = response?.object;
    for (let depth = 0; depth < 4; depth += 1) {
      if (object?.type === "commit" && COMMIT.test(object.sha ?? "")) return object.sha;
      if (object?.type !== "tag" || !COMMIT.test(object.sha ?? "")) break;
      response = await commandJson("gh", ["api", `${repository}/git/tags/${object.sha}`], { command });
      object = response?.object;
    }
    throw new Error("delivery_source_tag_target_invalid");
  };
  return {
    async readFileAtCommit(commit, filePath) {
      if (!COMMIT.test(commit) || typeof filePath !== "string" || filePath.startsWith("/")) {
        throw new Error("delivery_source_read_identity_invalid");
      }
      const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
      const response = await commandJson("gh", ["api", `${repository}/contents/${encodedPath}?ref=${commit}`], { command });
      if (response?.encoding !== "base64" || typeof response.content !== "string") {
        throw new Error("delivery_source_file_unavailable");
      }
      return Buffer.from(response.content.replace(/\s/g, ""), "base64");
    },
    async compareCommits(base, head) {
      if (!COMMIT.test(base) || !COMMIT.test(head)) throw new Error("delivery_source_order_identity_invalid");
      if (base === head) return "identical";
      const response = await commandJson("gh", ["api", `${repository}/compare/${base}...${head}`], { command });
      if (["ahead", "behind", "identical"].includes(response?.status)) return response.status;
      return "diverged";
    },
    readTagCommit,
  };
}

export function createGitHubReleaseSource({ owner, repo, publishedAfter, command = runCommand }) {
  return {
    async listCandidates({ terminalEventKeys = [] } = {}) {
      const pages = await commandJson("gh", ["api", "--paginate", "--slurp", `${`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`}/releases?per_page=100`], { command });
      const terminal = new Set(terminalEventKeys);
      const releases = flattenPages(pages)
        .filter((release) => release.draft !== true && typeof release.published_at === "string" &&
          (!publishedAfter || release.published_at >= publishedAfter));
      const candidates = [];
      for (const release of releases) {
        const releaseOrBuildId = `github-release-${release.id}`;
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const eventKey = releaseEventKey(release);
        if (terminal.has(eventKey)) continue;
        const manifestAssets = assets.filter(({ name }) => typeof name === "string" && name.endsWith("-manifest.json"));
        if (manifestAssets.length !== 1) {
          candidates.push({ channel: "desktop-cli-release", identity: { releaseOrBuildId, releaseTag: release.tag_name, eventKey } });
          continue;
        }
        const manifestAsset = manifestAssets[0];
        let manifestBytes;
        let manifest;
        try {
          manifestBytes = await downloadReleaseAsset({ owner, repo, assetId: manifestAsset.id, name: manifestAsset.name, command });
          manifest = parseJson(manifestBytes, "delivery_manifest_invalid");
        } catch {
          candidates.push({ channel: "desktop-cli-release", identity: { releaseOrBuildId, releaseTag: release.tag_name } });
          continue;
        }
        const skillName = manifest?.operatingSkill?.asset;
        const checksumAssets = assets.filter(({ name }) => name === "SHA256SUMS");
        const skillAssets = assets.filter(({ name }) => name === skillName);
        let checksumBytes;
        let skillBytes;
        try {
          if (checksumAssets.length === 1) {
            checksumBytes = await downloadReleaseAsset({ owner, repo, assetId: checksumAssets[0].id, name: "SHA256SUMS", command });
          }
          if (skillAssets.length === 1 && safeAssetName(skillName)) {
            skillBytes = await downloadReleaseAsset({ owner, repo, assetId: skillAssets[0].id, name: skillName, command });
          }
        } catch {
          // The verifier records absent or unreadable assets as a blocked input.
        }
        const assetSha256ByName = {};
        for (const asset of manifest.assets ?? []) {
          const metadata = assets.find(({ name }) => name === asset.name);
          if (!metadata) continue;
          let digest = typeof metadata.digest === "string" && metadata.digest.startsWith("sha256:")
            ? metadata.digest.slice("sha256:".length)
            : null;
          if (asset.name === skillName && skillBytes) digest = sha256(skillBytes);
          if (digest !== null) assetSha256ByName[asset.name] = digest;
        }
        const identity = {
          releaseOrBuildId,
          eventKey,
          releaseTag: release.tag_name,
          sourceCommit: manifest?.source?.commit,
          sourceTag: manifest?.source?.tag,
          toolingCommit: manifest?.tooling?.commit,
          toolingTag: manifest?.tooling?.tag,
          version: manifest?.version,
          manifestAssetName: manifestAsset.name,
          manifestAssetSha256: sha256(manifestBytes),
          checksumsAssetName: "SHA256SUMS",
          releaseAssetNames: assets.map(({ name }) => name),
          assetSha256ByName,
          ...(checksumBytes ? { artifactSha256: sha256(checksumBytes) } : {}),
        };
        candidates.push({
          channel: "desktop-cli-release",
          identity,
          manifestBytes,
          checksumBytes,
          skillBytes,
        });
      }
      return candidates;
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function remoteCommand(script) {
  return `sh -c ${shellQuote(script)}`;
}

function targetCommand(target, command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function hashScript(fileExpression) {
  return `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${fileExpression} | awk '{print $1}'; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 ${fileExpression} | awk '{print $1}'; else exit 47; fi`;
}

export function createSshTargetAdapter(destinations, { command = runCommand } = {}) {
  const targets = new Map(destinations.map((destination) => [destination.id, destination]));
  const read = async (id) => {
    const destination = targets.get(id);
    if (!destination || typeof destination.route?.sshTarget !== "string") throw new Error("delivery_target_route_missing");
    const file = shellQuote(destination.path);
    const script = `if [ -f ${file} ]; then mode=$(stat -c %a ${file} 2>/dev/null || stat -f %Lp ${file}) || exit 45; case "$mode" in ''|*[!0-7]*) exit 46 ;; esac; printf 'PRESENT %s\\n' "$mode"; cat ${file}; elif [ -e ${file} ]; then exit 44; else printf 'ABSENT\\n'; fi`;
    const { stdout } = await command("ssh", ["-T", destination.route.sshTarget, remoteCommand(script)]);
    const newline = stdout.indexOf(10);
    if (newline < 0) throw new Error("delivery_target_read_invalid");
    const marker = stdout.subarray(0, newline).toString("utf8");
    if (marker === "ABSENT") return { available: true, bytes: null, mode: null };
    const present = /^PRESENT ([0-7]{3,4})$/.exec(marker);
    if (!present) throw new Error("delivery_target_read_invalid");
    return {
      available: true,
      bytes: stdout.subarray(newline + 1),
      mode: destination.kind === "shared-identity" ? null : Number.parseInt(present[1], 8),
    };
  };
  const stage = async (id, value, envelopeId, { mode } = {}) => {
    const destination = targets.get(id);
    if (!destination || typeof destination.route?.sshTarget !== "string") throw new Error("delivery_target_route_missing");
    const stagedPath = `${destination.path}.surf-ace-stage-${envelopeId.slice(0, 16)}`;
    const pathArg = shellQuote(stagedPath);
    const stageMode = Number.isSafeInteger(mode) ? mode : 0o600;
    if (stageMode < 0 || stageMode > 0o7777) throw new Error("delivery_target_mode_invalid");
    const modeText = stageMode.toString(8);
    const script = `set -eu; umask 077; cat > ${pathArg}; chmod ${modeText} ${pathArg}; ${hashScript(pathArg)}`;
    const { stdout } = await command("ssh", ["-T", destination.route.sshTarget, remoteCommand(script)], { input: value });
    const digest = stdout.toString("utf8").trim();
    if (!SHA256.test(digest)) throw new Error("delivery_stage_hash_invalid");
    return { id: stagedPath, sha256: digest };
  };
  const discardStage = async (id, stageRecord) => {
    const destination = targets.get(id);
    if (!destination || typeof stageRecord?.id !== "string") return;
    const script = `rm -f ${shellQuote(stageRecord.id)}`;
    await command("ssh", ["-T", destination.route.sshTarget, remoteCommand(script)]);
  };
  const commit = async (id, stageRecord, { expectedPriorSha256, expectedPriorMode, targetMode } = {}) => {
    const destination = targets.get(id);
    if (!destination || typeof stageRecord?.id !== "string") throw new Error("delivery_stage_missing");
    const current = await read(id);
    const actualPrior = current.bytes === null ? null : sha256(current.bytes);
    if (actualPrior !== expectedPriorSha256 ||
        (destination.kind === "standalone-skill" && current.mode !== expectedPriorMode)) {
      throw new Error("target_prior_state_changed");
    }
    if (destination.kind === "shared-identity") {
      const { identityArchetype, identitySkillName } = destination.route;
      if (typeof identityArchetype !== "string" || typeof identitySkillName !== "string") {
        throw new Error("delivery_identity_cli_route_missing");
      }
      const args = ["identity", "edit", identityArchetype, "--skill", identitySkillName, "--file", stageRecord.id];
      if (typeof destination.route.identityAsUser === "string") args.unshift("--as-user", destination.route.identityAsUser);
      try {
        await command("ssh", ["-T", destination.route.sshTarget, remoteCommand(targetCommand(destination, destination.route.tightbeamCommand ?? "tightbeam", args))]);
      } finally {
        await discardStage(id, stageRecord);
      }
      return;
    }
    const destinationPath = shellQuote(destination.path);
    const stagePath = shellQuote(stageRecord.id);
    const expected = shellQuote(expectedPriorSha256 ?? "ABSENT");
    const actualHash = `if [ -f ${destinationPath} ]; then ${hashScript(destinationPath)}; else printf 'ABSENT'; fi`;
    const expectedMode = Number.isSafeInteger(targetMode) ? targetMode : 0o644;
    const expectedModeText = expectedMode.toString(8);
    const actualMode = `if [ -f ${destinationPath} ]; then stat -c %a ${destinationPath} 2>/dev/null || stat -f %Lp ${destinationPath}; else printf 'ABSENT'; fi`;
    const script = `set -eu; actual="$(${actualHash})"; test "$actual" = ${expected}; mode="$(${actualMode})"; test "$mode" = ${shellQuote(expectedPriorMode == null ? "ABSENT" : expectedPriorMode.toString(8))}; mv -f ${stagePath} ${destinationPath}; actual="$(${hashScript(destinationPath)})"; test "$actual" = ${shellQuote(stageRecord.sha256)}; mode=$(stat -c %a ${destinationPath} 2>/dev/null || stat -f %Lp ${destinationPath}) || exit 45; test "$mode" = ${shellQuote(expectedModeText)}`;
    await command("ssh", ["-T", destination.route.sshTarget, remoteCommand(script)]);
  };
  const restore = async (id, previousBytes, { expectedCurrentSha256, expectedCurrentMode, priorMode } = {}) => {
    const destination = targets.get(id);
    if (!destination) throw new Error("delivery_target_route_missing");
    const current = await read(id);
    if (current.bytes === null || sha256(current.bytes) !== expectedCurrentSha256 ||
        (destination.kind === "standalone-skill" && current.mode !== expectedCurrentMode)) {
      throw new Error("target_restore_state_changed");
    }
    if (destination.kind === "shared-identity") {
      const { identityArchetype, identitySkillName } = destination.route;
      if (typeof identityArchetype !== "string" || typeof identitySkillName !== "string") throw new Error("delivery_identity_cli_route_missing");
      if (previousBytes === null) {
        const args = ["identity", "edit", identityArchetype, "--skill", identitySkillName, "--rm"];
        if (typeof destination.route.identityAsUser === "string") args.unshift("--as-user", destination.route.identityAsUser);
        await command("ssh", ["-T", destination.route.sshTarget, remoteCommand(targetCommand(destination, destination.route.tightbeamCommand ?? "tightbeam", args))]);
        return;
      }
      const temporaryStage = await stage(id, previousBytes, `restore-${sha256(previousBytes)}`);
      const args = ["identity", "edit", identityArchetype, "--skill", identitySkillName, "--file", temporaryStage.id];
      if (typeof destination.route.identityAsUser === "string") args.unshift("--as-user", destination.route.identityAsUser);
      try {
        await command("ssh", ["-T", destination.route.sshTarget, remoteCommand(targetCommand(destination, destination.route.tightbeamCommand ?? "tightbeam", args))]);
      } finally {
        await discardStage(id, temporaryStage);
      }
      return;
    }
    if (previousBytes === null) {
      const file = shellQuote(destination.path);
      const expected = shellQuote(expectedCurrentSha256);
      const actualHash = `if [ -f ${file} ]; then ${hashScript(file)}; else printf 'ABSENT'; fi`;
      await command("ssh", ["-T", destination.route.sshTarget, remoteCommand(`set -eu; actual="$(${actualHash})"; test "$actual" = ${expected}; rm -f ${file}`)]);
      return;
    }
    const temporaryStage = await stage(id, previousBytes, `restore-${sha256(previousBytes)}`, { mode: priorMode });
    try {
      const file = shellQuote(destination.path);
      const staged = shellQuote(temporaryStage.id);
      const actualHash = `if [ -f ${file} ]; then ${hashScript(file)}; else printf 'ABSENT'; fi`;
      const expectedMode = Number.isSafeInteger(priorMode) ? priorMode : 0o644;
      const script = `set -eu; actual="$(${actualHash})"; test "$actual" = ${shellQuote(expectedCurrentSha256)}; mode=$(stat -c %a ${file} 2>/dev/null || stat -f %Lp ${file}) || exit 45; test "$mode" = ${shellQuote(expectedCurrentMode == null ? "ABSENT" : expectedCurrentMode.toString(8))}; mv -f ${staged} ${file}; actual="$(${hashScript(file)})"; test "$actual" = ${shellQuote(sha256(previousBytes))}; mode=$(stat -c %a ${file} 2>/dev/null || stat -f %Lp ${file}) || exit 45; test "$mode" = ${shellQuote(expectedMode.toString(8))}`;
      await command("ssh", ["-T", destination.route.sshTarget, remoteCommand(script)]);
    } finally {
      await discardStage(id, temporaryStage);
    }
  };
  return { read, stage, discardStage, commit, restore };
}

async function readJsonFile(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error("delivery_journal_invalid");
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
}

export async function createFileDeliveryJournal(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, "delivery-journal.json");
  let state = await readJsonFile(filePath, { entries: {}, backups: {}, highWater: null });
  const save = async () => writeJsonAtomic(filePath, state);
  return {
    async read(id) { return state.entries[id] ?? null; },
    async readHighWater() { return state.highWater; },
    async initializeHighWater(value) {
      if (state.highWater && canonicalJson(state.highWater) !== canonicalJson(value)) throw new Error("delivery_high_water_conflict");
      state.highWater ??= value;
      await save();
    },
    async listPublishing() {
      return Object.entries(state.entries).filter(([, entry]) => entry.status === "publishing")
        .map(([envelopeId, entry]) => ({ envelopeId, ...entry }));
    },
    async listTerminalEventKeys() {
      const terminalStatuses = new Set(["complete", "no_change", "unresolved", "rolled_back"]);
      return [...new Set(Object.values(state.entries)
        .filter((entry) => terminalStatuses.has(entry.status) || (entry.status === "blocked" && entry.terminal === true))
        .map((entry) => entry.terminalEventKey ?? entry.envelope?.eventKey ?? entry.plan?.envelope?.eventKey)
        .filter((key) => SHA256.test(key ?? "")))].sort();
    },
    async saveBackup(envelopeId, targetId, value, { key }) {
      const ref = sha256(Buffer.from(`${envelopeId}\0${targetId}\0${key}`));
      state.backups[ref] = value === null ? null : Buffer.from(value).toString("base64");
      await save();
      return ref;
    },
    async readBackup(_envelopeId, _targetId, ref) {
      if (!Object.hasOwn(state.backups, ref)) throw new Error("delivery_backup_missing");
      return state.backups[ref] === null ? null : Buffer.from(state.backups[ref], "base64");
    },
    async recordBlocked(id, detail) { state.entries[id] = { ...state.entries[id], status: "blocked", envelopeId: id, ...detail }; await save(); },
    async recordPending(id, detail) { state.entries[id] = { status: "pending", envelopeId: id, ...detail }; await save(); },
    async recordPublishing(id, detail) { state.entries[id] = { status: "publishing", envelopeId: id, ...detail }; await save(); },
    async recordTargetReceipt(id, receipt) {
      const entry = state.entries[id] ?? { status: "publishing", envelopeId: id, targetReceipts: [] };
      entry.targetReceipts ??= [];
      entry.targetReceipts.push(receipt);
      state.entries[id] = entry;
      await save();
    },
    async recordRollback(id, receipts, detail) {
      state.entries[id] = { ...state.entries[id], rollbackReceipts: receipts, ...detail };
      await save();
    },
    async recordFailure(id, detail) {
      const terminal = ["unresolved", "rolled_back"].includes(detail.status);
      state.entries[id] = {
        ...state.entries[id],
        envelopeId: id,
        ...(terminal ? { terminal: true } : {}),
        ...detail,
      };
      await save();
    },
    async recordNoChange(id, detail) {
      state.entries[id] = { status: "no_change", terminal: true, envelopeId: id, ...detail };
      state.highWater = detail.highWater;
      await save();
    },
    async recordComplete(id, detail) {
      state.entries[id] = { status: "complete", terminal: true, envelopeId: id, ...detail };
      state.highWater = detail.highWater;
      await save();
    },
  };
}

// The configured private command forwards a persisted, exact-plan envelope to
// its accountable owner and returns a receipt in resultDirectory. It must use
// handoffId as an idempotency key. It creates no approval and may not write a
// target; the receipt must come from the matching ruled operator record.
export function createApprovalHandoffAdapter({ directory, handoffCommand, requiredRuler, command = runCommand }) {
  const statePath = path.join(directory, "approval-handoffs.json");
  const requestDirectory = path.join(directory, "approval-handoffs");
  const resultDirectory = path.join(directory, "approval-results");
  const keyFor = (envelopeId, planSha256) => sha256(Buffer.from(canonicalJson({ envelopeId, planSha256 })));
  async function load() { return readJsonFile(statePath, { requests: {} }); }
  async function save(value) { return writeJsonAtomic(statePath, value); }
  async function prepare(plan, planSha256) {
    if (typeof handoffCommand !== "string" || handoffCommand.length === 0) {
      throw new Error("delivery_approval_handoff_unavailable");
    }
    const handoffId = keyFor(plan.envelopeId, planSha256);
    const requestPath = path.join(requestDirectory, `${handoffId}.json`);
    const resultPath = path.join(resultDirectory, `${handoffId}.json`);
    const state = await load();
    const existing = state.requests[handoffId];
    if (existing && canonicalJson(existing.plan) !== canonicalJson(plan)) {
      throw new Error("delivery_approval_handoff_plan_conflict");
    }
    const item = existing ?? {
      handoffId,
      envelopeId: plan.envelopeId,
      planSha256,
      destinationSetSha256: plan.destinationSetSha256,
      destinationMapSha256: plan.destinationMapSha256,
      status: "queued",
      requestPath,
      resultPath,
      plan,
    };
    state.requests[handoffId] = item;
    await save(state);
    await fs.mkdir(requestDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(resultDirectory, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(requestPath, {
      handoffId,
      envelopeId: plan.envelopeId,
      planSha256,
      destinationSetSha256: plan.destinationSetSha256,
      destinationMapSha256: plan.destinationMapSha256,
      plan,
    });
    if (item.status !== "submitted") {
      try {
        await command(handoffCommand, [], {
          input: Buffer.from(JSON.stringify({ handoffId, requestPath, resultPath })),
        });
      } catch (error) {
        item.status = "retryable";
        state.requests[handoffId] = item;
        await save(state);
        throw error;
      }
      item.status = "submitted";
      state.requests[handoffId] = item;
      await save(state);
    }
    return { item, resultPath };
  }
  return {
    async request(plan) {
      await prepare(plan, plan.planSha256);
    },
    async read(envelopeId, planSha256) {
      const state = await load();
      const handoffId = keyFor(envelopeId, planSha256);
      const item = state.requests[handoffId];
      if (!item) return null;
      if (item.status !== "submitted") return null;
      const resultPath = path.join(resultDirectory, `${handoffId}.json`);
      const result = await readJsonFile(resultPath, null);
      if (!result) return {
        status: "pending",
        envelopeId,
        planSha256,
        destinationSetSha256: item.destinationSetSha256,
        destinationMapSha256: item.destinationMapSha256,
      };
      if (result.handoffId !== handoffId || result.envelopeId !== envelopeId ||
          result.planSha256 !== planSha256 ||
          result.destinationSetSha256 !== item.destinationSetSha256 ||
          result.destinationMapSha256 !== item.destinationMapSha256 ||
          typeof result.requestRef !== "string" || result.requestRef.length === 0) {
        return { status: "mismatch" };
      }
      if (result.status !== "ruled") return {
        status: result.status === "pending" ? "pending" : result.status,
        envelopeId,
        planSha256,
        destinationSetSha256: item.destinationSetSha256,
        destinationMapSha256: item.destinationMapSha256,
      };
      const principal = result.ruling?.principal;
      const onBehalfOf = result.ruling?.onBehalfOf;
      if (typeof requiredRuler !== "string" || principal !== requiredRuler || onBehalfOf !== requiredRuler ||
          !["approve", "decline"].includes(result.decision)) return { status: "mismatch" };
      return {
        status: "ruled",
        decision: result.decision,
        requestRef: result.requestRef,
        ruling: result.ruling,
        envelopeId,
        planSha256,
        destinationSetSha256: item.destinationSetSha256,
        destinationMapSha256: item.destinationMapSha256,
      };
    },
  };
}

function uniqueProjectSetting(projectText, name) {
  const values = [...projectText.matchAll(new RegExp(`^\\s*${name}:\\s*([A-Za-z0-9._+-]+)\\s*$`, "gm"))]
    .map((match) => match[1]);
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw new Error("delivery_iphone_project_settings_ambiguous");
  return unique[0];
}

function verifyEmbedScript(script) {
  const required = [
    'source_sha=$(hash_file "$skill_source")',
    'embedded_sha=$(hash_file "$skill_tmp")',
    '[ "$source_sha" = "$embedded_sha" ]',
    '"sha256": "$embedded_sha"',
    '"xcodeCloudCommit": "$cloud_commit"',
  ];
  if (required.some((fragment) => !script.includes(fragment))) throw new Error("delivery_iphone_embed_contract_missing");
}

function verifyProjectEmbedConfiguration(projectText) {
  const targets = [...projectText.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):\s*$/gm)];
  const targetIndex = targets.findIndex((match) => match[1] === "SurfAce");
  if (targetIndex < 0) throw new Error("delivery_iphone_embed_target_missing");
  const targetStart = targets[targetIndex].index;
  const targetEnd = targets[targetIndex + 1]?.index ?? projectText.length;
  const target = projectText.slice(targetStart, targetEnd);
  if (!target.includes("name: Embed Surf Ace operating skill") ||
      !target.includes("path: scripts/embed-operating-skill.sh") ||
      !target.includes("basedOnDependencyAnalysis: false")) {
    throw new Error("delivery_iphone_embed_target_missing");
  }
}

export function createXcodeCloudSource({ sshTarget, nodeExecutable = "node", collectorScript, collectorConfig, expectedWorkflowId, startReasonToCondition = {}, sourceReader, command = runCommand }) {
  return {
    async listCandidates({ terminalEventKeys = [] } = {}) {
      const remote = [nodeExecutable, collectorScript, "--config", collectorConfig, "--json", "--terminal-event-keys-stdin"]
        .map(shellQuote).join(" ");
      const { stdout } = await command("ssh", ["-T", sshTarget, remoteCommand(remote)], {
        input: Buffer.from(JSON.stringify({ terminalEventKeys })),
      });
      const records = parseJson(stdout, "delivery_asc_collector_json_invalid");
      if (!Array.isArray(records)) throw new Error("delivery_asc_collector_response_invalid");
      const candidates = [];
      for (const record of records) {
        const identity = record.identity ?? {};
        if (identity.workflowId !== expectedWorkflowId || !COMMIT.test(identity.sourceCommit ?? "") ||
            identity.completionStatus !== "SUCCEEDED" || identity.isPullRequestBuild !== false ||
            identity.sourceBranch !== "main" || identity.gitRef !== "refs/heads/main" ||
            startReasonToCondition[identity.startReason] !== "push") continue;
        identity.startCondition = "push";
        identity.scheme = "SurfAce";
        identity.platform = "iOS";
        identity.action = "archive";
        if (identity.archiveEvidence === "ambiguous" || identity.archiveEvidence === "invalid") {
          candidates.push({
            channel: "iphone-build",
            identity: { ...identity, evidenceFailure: "delivery_iphone_archive_evidence_invalid" },
            manifestBytes: Buffer.alloc(0),
            skillBytes: Buffer.alloc(0),
          });
          continue;
        }

        const hasManifest = typeof record.manifestBase64 === "string";
        const hasSkill = typeof record.skillBase64 === "string";
        if (hasManifest || hasSkill) {
          const manifestBytes = hasManifest ? Buffer.from(record.manifestBase64, "base64") : Buffer.alloc(0);
          const skillBytes = hasSkill ? Buffer.from(record.skillBase64, "base64") : Buffer.alloc(0);
          let manifest;
          try { manifest = parseJson(manifestBytes, "delivery_manifest_invalid"); }
          catch {
            candidates.push({ channel: "iphone-build", identity, manifestBytes, skillBytes });
            continue;
          }
          identity.appVersion = identity.appStoreAppVersion ?? manifest.appVersion;
          identity.appBuildNumber = identity.appStoreBuildNumber ?? manifest.appBuildNumber;
          identity.manifestAppBuildNumber = manifest.appBuildNumber;
          identity.deliveryRoute = "xcode-cloud-archive";
          candidates.push({ channel: "iphone-build", identity, manifestBytes, skillBytes });
          continue;
        }

        try {
          const canonicalSkillBytes = await sourceReader.readFileAtCommit(identity.sourceCommit, CANONICAL_SKILL_SOURCE);
          const [scriptBytes, projectBytes] = await Promise.all([
            sourceReader.readFileAtCommit(identity.sourceCommit, "packages/ios/scripts/embed-operating-skill.sh"),
            sourceReader.readFileAtCommit(identity.sourceCommit, "packages/ios/project.yml"),
          ]);
          verifyEmbedScript(scriptBytes.toString("utf8"));
          const projectText = projectBytes.toString("utf8");
          verifyProjectEmbedConfiguration(projectText);
          const projectVersion = uniqueProjectSetting(projectText, "MARKETING_VERSION");
          const projectBuildNumber = uniqueProjectSetting(projectText, "CURRENT_PROJECT_VERSION");
          identity.appVersion = identity.appStoreAppVersion ?? projectVersion;
          identity.appBuildNumber = identity.appStoreBuildNumber ?? projectBuildNumber;
          identity.manifestAppBuildNumber = projectBuildNumber;
          identity.deliveryRoute = "source-commit-fallback";
          identity.releaseOrBuildId = identity.buildId;
          const manifestBytes = renderIphoneManifest({
            ...identity,
            appVersion: projectVersion,
            manifestAppBuildNumber: projectBuildNumber,
          }, sha256(canonicalSkillBytes));
          candidates.push({
            channel: "iphone-build",
            identity,
            manifestBytes,
            skillBytes: canonicalSkillBytes,
          });
        } catch {
          candidates.push({
            channel: "iphone-build",
            identity: { ...identity, evidenceFailure: "delivery_iphone_source_evidence_invalid" },
            manifestBytes: Buffer.alloc(0),
            skillBytes: Buffer.alloc(0),
          });
        }
      }
      return candidates;
    },
  };
}

export async function readPrivateConfig(filePath) {
  if (!filePath) return { enabled: false };
  return parseJson(await fs.readFile(filePath), "delivery_config_invalid");
}

export async function createRuntime(config, { command = runCommand } = {}) {
  if (config?.enabled !== true) return { status: "disabled", processed: 0 };
  const { owner, repo, publishedAfter } = config.github ?? {};
  const { sshTarget, nodeExecutable, collectorScript, collectorConfig, expectedWorkflowId, startReasonToCondition } = config.xcodeCloud ?? {};
  const { directory: journalDirectory } = config.journal ?? {};
  const { handoffCommand, requiredRuler } = config.approval ?? {};
  if (![owner, repo, publishedAfter, sshTarget, collectorScript, collectorConfig, expectedWorkflowId,
    journalDirectory, handoffCommand, requiredRuler].every((value) => typeof value === "string" && value.length > 0) ||
      !Array.isArray(config.destinations) || config.destinations.length === 0 ||
      !COMMIT.test(config.initialHighWater?.sourceCommit ?? "") || !SHA256.test(config.initialHighWater?.skillSha256 ?? "")) {
    throw new Error("delivery_private_config_incomplete");
  }
  const sourceReader = createGitHubSourceReader({ owner, repo, command });
  const destinations = config.destinations;
  const [journal, approvals] = await Promise.all([
    createFileDeliveryJournal(journalDirectory),
    createApprovalHandoffAdapter({ directory: journalDirectory, handoffCommand, requiredRuler, command }),
  ]);
  const sources = [
    createGitHubReleaseSource({ owner, repo, publishedAfter, command }),
    createXcodeCloudSource({
      sshTarget,
      nodeExecutable: nodeExecutable ?? "node",
      collectorScript,
      collectorConfig,
      expectedWorkflowId,
      startReasonToCondition,
      sourceReader,
      command,
    }),
  ];
  const { runSkillDeliveryConsumer } = await import("./skill-delivery-consumer.mjs");
  return runSkillDeliveryConsumer({
    enabled: true,
    sources,
    sourceReader,
    destinations,
    initialHighWater: config.initialHighWater,
    targets: createSshTargetAdapter(destinations, { command }),
    approvals,
    journal,
  });
}
