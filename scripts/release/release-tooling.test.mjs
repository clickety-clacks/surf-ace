import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertExactPublicFiles,
  assertDisjointTrees,
  assertSourceIdentity,
  assertTrackedInputsUnchanged,
  canonicalJson,
  createTarGz,
  createZip,
  createDirectoryTarGz,
  createDirectoryZip,
  parseArgs,
  resolveInside,
  requiredReleaseOutput,
  sha256,
  writeChecksumReceipt,
} from "./release-lib.mjs";
import { compareReleaseBuilds } from "./compare-release-builds.mjs";
import { cargoLockedPackages, lockedPackages, packagedProductionInventory, workspaceProductionInventory } from "./lockfile-inventory.mjs";
import { verifySri } from "./verify-sri.mjs";
import {
  assembleTightbeamCliStage,
  assembleTightbeamLinuxStage,
  assertTightbeamLinuxQualificationClaims,
  buildTightbeamLinuxQualification,
  buildTightbeamRelease,
  installLinuxElectronLauncher,
  TIGHTBEAM_CLI_FILES,
  TIGHTBEAM_LINUX_SERVER_FILES,
  TIGHTBEAM_LINUX_RUNTIME_FILES,
  verifyStandaloneElectronSource,
  writeTightbeamManifest,
  verifyTightbeamCliStage,
  verifyTightbeamLinuxStage,
} from "./build-tightbeam-release.mjs";
import {
  TIGHTBEAM,
  TIGHTBEAM_BUILD_COMMANDS,
  TIGHTBEAM_PUBLIC_FILES,
  TIGHTBEAM_ROUTING,
  TIGHTBEAM_TEST_COMMANDS,
  TIGHTBEAM_TOOLING_TAG,
  TOOLCHAINS,
} from "./tightbeam-release-config.mjs";
import {
  assertTightbeamElectronPackageIdentity,
  assertTightbeamSmokeParticipantIdentities,
  assertTightbeamSmokeParticipantAssetBytes,
  electronSmokePlan,
  macosSmokePlan,
  buildTightbeamSmokeParticipantIdentities,
  formatSmokeFailure,
  installElectronArchive,
  runMacosSmokePlan,
  smokeLinuxFreshInstall,
  runLinuxFreshInstallStateDriver,
  smokeTightbeamLinuxQualification,
  validateTightbeamFreshInstallState,
  verifyTightbeamChecksums,
} from "./smoke-tightbeam-release.mjs";
import { verifyClientAppVersion } from "./smoke-lib.mjs";
import { verifySmokeReceipt, writeSmokeReceipt } from "./write-smoke-receipt.mjs";
import tightbeamServerLauncher from "./tightbeam-server-launcher.cjs";

const exec = promisify(execFile);
const workspaceRequire = createRequire(import.meta.url);
const { WebSocketServer } = workspaceRequire("../../packages/electron/node_modules/ws");
const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

function smokeParticipantIdentities(component, changes = {}) {
  const assetNames = component === "linux"
    ? TIGHTBEAM.assets.slice(0, 3)
    : [TIGHTBEAM.assets[3], TIGHTBEAM.assets[4]];
  const roles = component === "linux" ? ["server", "cli", "client"] : ["cli", "client"];
  const details = assetNames.map((name) => ({ name, sha256: "a".repeat(64), sizeBytes: 1 }));
  return buildTightbeamSmokeParticipantIdentities({
    assetDetails: details,
    component,
    identityBasis: "manifest-and-SHA256SUMS",
    sourceCommit: TIGHTBEAM.candidateCommit,
    toolingCommit: "b".repeat(40),
    version: TIGHTBEAM.version,
  }).map((identity) => ({ ...identity, ...changes[identity.participant] }));
}

async function recordClientAppLaunch(logPath, version = TIGHTBEAM.version) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, `2026-09-27T00:00:00.000Z [surf-ace:app] event=app_launch app_version=${version} platform=linux\n`);
}

function workflowRunScript(workflow, stepName) {
  const marker = `      - name: ${stepName}\n`;
  const stepOffset = workflow.indexOf(marker);
  assert.notEqual(stepOffset, -1, `missing workflow step: ${stepName}`);
  const runMarker = "        run: |\n";
  const runOffset = workflow.indexOf(runMarker, stepOffset + marker.length);
  assert.notEqual(runOffset, -1, `missing run block: ${stepName}`);
  const lines = workflow.slice(runOffset + runMarker.length).split("\n");
  const body = [];
  for (const line of lines) {
    if (line.startsWith("          ")) body.push(line.slice(10));
    else if (line === "") body.push("");
    else break;
  }
  return body.join("\n").trimEnd();
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-release-test-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

test("canonical JSON recursively sorts object keys without changing array order", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 4, b: 2 }, list: [{ y: 2, x: 1 }] }), '{\n  "a": {\n    "b": 2,\n    "d": 4\n  },\n  "list": [\n    {\n      "x": 1,\n      "y": 2\n    }\n  ],\n  "z": 1\n}\n');
});

test("argument parsing rejects missing, duplicate, and unknown release inputs", () => {
  assert.deepEqual(parseArgs(["--source", "a", "--output", "b"], ["source"], ["output"]), { source: "a", output: "b" });
  assert.throws(() => parseArgs([], ["source"]), /missing_argument/);
  assert.throws(() => parseArgs(["--source", "a", "--source", "b"], ["source"]), /duplicate_argument/);
  assert.throws(() => parseArgs(["--other", "a"], ["source"]), /unknown_argument/);
});

test("release paths cannot escape the owned root", () => {
  assert.equal(resolveInside("/tmp/release", "a/b"), "/tmp/release/a/b");
  assert.throws(() => resolveInside("/tmp/release", "../input"), /path_escapes_root/);
  assert.throws(() => assertDisjointTrees("/tmp/source", "/tmp/source/build"), /release_trees_overlap/);
  assert.equal(requiredReleaseOutput("tightbeam", "build/release/tightbeam"), path.resolve("build/release/tightbeam"));
  assert.throws(() => requiredReleaseOutput("tightbeam", "/tmp/output"), /release_output_mismatch/);
});

test("normalized tar-gzip and zip bytes are stable across mtime and creation order", async (t) => {
  const root = await temporary(t);
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  await fs.mkdir(path.join(left, "nested"), { recursive: true });
  await fs.writeFile(path.join(left, "nested/b.txt"), "b\n");
  await fs.writeFile(path.join(left, "a.txt"), "a\n");
  await fs.mkdir(path.join(right, "nested"), { recursive: true });
  await fs.writeFile(path.join(right, "a.txt"), "a\n");
  await fs.writeFile(path.join(right, "nested/b.txt"), "b\n");
  await fs.utimes(path.join(right, "a.txt"), new Date(1), new Date());
  for (const [format, build] of [["tgz", createTarGz], ["zip", createZip]]) {
    const one = path.join(root, `one.${format}`);
    const two = path.join(root, `two.${format}`);
    await build(left, one, 1_700_000_000);
    await build(right, two, 1_700_000_000);
    assert.equal(await sha256(one), await sha256(two));
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    if (format === "tgz") await exec("tar", ["-tzf", one]);
    else await exec("unzip", ["-t", one]);
  }
});

test("archive creation refuses absolute and escaping symbolic links", async (t) => {
  const root = await temporary(t);
  await fs.symlink("../outside", path.join(root, "escape"));
  await assert.rejects(createTarGz(root, path.join(root, "bad.tgz"), 1_700_000_000), /path_escapes_root/);
  const longRoot = path.join(root, "long-root");
  await fs.mkdir(longRoot);
  const longTarget = `dir/${"a".repeat(97)}`;
  await fs.mkdir(path.join(longRoot, "dir"));
  await fs.writeFile(path.join(longRoot, longTarget), "target\n");
  await fs.symlink(longTarget, path.join(longRoot, "long-link"));
  await assert.rejects(createTarGz(longRoot, path.join(root, "long.tgz"), 1_700_000_000), /tar_link_target_too_long/);
});

test("release archive wrappers retain the required install roots", async (t) => {
  const root = await temporary(t);
  const contents = path.join(root, "contents");
  await fs.mkdir(contents);
  await fs.writeFile(path.join(contents, "file.txt"), "bytes\n");
  const tarball = path.join(root, "package.tgz");
  const zip = path.join(root, "app.zip");
  await createDirectoryTarGz(contents, "package", tarball, 1_700_000_000);
  await createDirectoryZip(contents, "Surf Ace.app", zip, 1_700_000_000);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  assert.match((await exec("tar", ["-tzf", tarball])).stdout, /^package\//m);
  assert.match((await exec("unzip", ["-Z1", zip])).stdout, /^Surf Ace\.app\//m);
});

test("SRI verification compares literal SHA-512 bytes", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "package.tgz");
  await fs.writeFile(file, "literal package bytes");
  const expected = `sha512-${createHash("sha512").update("literal package bytes").digest("base64")}`;
  assert.equal(await verifySri(file, expected), expected);
  await assert.rejects(verifySri(file, `${expected.slice(0, -2)}AA`), /sri_mismatch/);
});

test("pnpm lock inventory binds every packaged third-party name and version to integrity", async (t) => {
  const root = await temporary(t);
  const lockfile = path.join(root, "pnpm-lock.yaml");
  await fs.writeFile(lockfile, "lockfileVersion: '9.0'\npackages:\n\n  alpha@1.2.3:\n    resolution: {integrity: sha512-AAAA}\n\nsnapshots:\n\n  alpha@1.2.3: {}\n");
  await fs.mkdir(path.join(root, "package/node_modules/alpha"), { recursive: true });
  await fs.writeFile(path.join(root, "package/node_modules/alpha/package.json"), '{"name":"alpha","version":"1.2.3"}\n');
  const locked = await lockedPackages(lockfile);
  assert.deepEqual(locked.get("alpha@1.2.3"), { integrity: "sha512-AAAA", name: "alpha", version: "1.2.3" });
  assert.deepEqual(await packagedProductionInventory(path.join(root, "package"), lockfile), [{ integrity: "sha512-AAAA", name: "alpha", version: "1.2.3" }]);
  await fs.writeFile(path.join(root, "package/node_modules/alpha/package.json"), '{"name":"alpha","version":"1.2.4"}\n');
  await assert.rejects(packagedProductionInventory(path.join(root, "package"), lockfile), /packaged_dependency_not_locked/);
});

test("Cargo lock inventory binds every registry dependency to its checksum", async (t) => {
  const root = await temporary(t);
  const lockfile = path.join(root, "Cargo.lock");
  await fs.writeFile(lockfile, 'version = 4\n\n[[package]]\nname = "alpha"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "aaaaaaaa"\n\n[[package]]\nname = "workspace-root"\nversion = "0.1.0"\n');
  assert.deepEqual(await cargoLockedPackages(lockfile), [{ checksum: "aaaaaaaa", name: "alpha", version: "1.2.3" }]);
});

test("two-build comparison requires identical receipts and every public byte", async (t) => {
  const root = await temporary(t);
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  for (const directory of [left, right]) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "a.tgz"), "same");
    await fs.writeFile(path.join(directory, "manifest.json"), "{}\n");
    await writeChecksumReceipt(directory, ["a.tgz", "manifest.json"]);
    await assertExactPublicFiles(directory, ["a.tgz", "manifest.json"]);
  }
  assert.equal((await compareReleaseBuilds(left, right, ["a.tgz", "manifest.json"])).length, 2);
  await fs.writeFile(path.join(right, "a.tgz"), "different");
  await assert.rejects(compareReleaseBuilds(left, right, ["a.tgz", "manifest.json"]), /release_file_bytes_differ/);
  await fs.writeFile(path.join(left, "extra.txt"), "not public\n");
  await assert.rejects(assertExactPublicFiles(left, ["a.tgz", "manifest.json"]), /public_file_set_mismatch/);
});

test("smoke receipts bind the manifest identity and unchanged release bytes", async (t) => {
  const root = await temporary(t);
  const manifest = path.join(root, "manifest.json");
  const artifact = path.join(root, "artifact.tgz");
  const receipt = path.join(root, "smoke.json");
  await fs.writeFile(manifest, '{"source":{"commit":"product","tag":"product-tag"},"tooling":{"commit":"tooling","tag":"tooling-tag"}}\n');
  await fs.writeFile(artifact, "candidate bytes");
  const options = { channel: "test", files: [artifact], manifest };
  await writeSmokeReceipt({ ...options, output: receipt });
  await verifySmokeReceipt({ ...options, receipt });
  await fs.writeFile(artifact, "changed bytes");
  await assert.rejects(verifySmokeReceipt({ ...options, receipt }), /smoke_receipt_mismatch/);
});

test("smoke receipt CLI writes and verifies multiple files and rejects tampering", async (t) => {
  const root = await temporary(t);
  const manifest = path.join(root, "manifest.json");
  const first = path.join(root, "first.tgz");
  const second = path.join(root, "second.zip");
  const receipt = path.join(root, "smoke.json");
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), "write-smoke-receipt.mjs");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const args = [
    script,
    "--channel", "test",
    "--manifest", manifest,
    "--files", `${first},${second}`,
  ];
  await fs.writeFile(manifest, '{"source":{"commit":"product","tag":"product-tag"},"tooling":{"commit":"tooling","tag":"tooling-tag"}}\n');
  await fs.writeFile(first, "first bytes");
  await fs.writeFile(second, "second bytes");

  await exec(process.execPath, [...args, "--output", receipt]);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(receipt, "utf8")).files), ["first.tgz", "second.zip"]);
  await exec(process.execPath, [...args, "--receipt", receipt]);

  await fs.writeFile(first, "tampered bytes");
  await assert.rejects(exec(process.execPath, [...args, "--receipt", receipt]), /smoke_receipt_mismatch/);
  await fs.writeFile(first, "first bytes");
  await fs.writeFile(manifest, '{"source":{"commit":"changed","tag":"product-tag"},"tooling":{"commit":"tooling","tag":"tooling-tag"}}\n');
  await assert.rejects(exec(process.execPath, [...args, "--receipt", receipt]), /smoke_receipt_mismatch/);
});

test("Electron handshake binds smoke identity to an explicit userData launch path", async (t) => {
  const root = await temporary(t);
  const home = path.join(root, "profile");
  const { electronLaunchConfig, launchElectron } = await import("./smoke-lib.mjs");
  const priorRegistry = process.env.SURF_ACE_SERVER;
  let launch;
  try {
    process.env.SURF_ACE_SERVER = "ws://operator-registry.invalid/ws";
    launch = electronLaunchConfig(home, 19101, null, undefined, "darwin");
    assert.equal(launch.userDataDir, path.join(home, "user-data"));
    assert.deepEqual(launch.args, [`--user-data-dir=${launch.userDataDir}`]);
    assert.equal(launch.env.HOME, home);
    assert.equal(launch.env.SURF_ACE_STATE_DIR, undefined);
    assert.equal(launch.env.SURF_ACE_SERVER, undefined, "unqualified host registry configuration is stripped");
    assert.equal(electronLaunchConfig(home, 19101, "ws://127.0.0.1:19301/ws").env.SURF_ACE_SERVER, "ws://127.0.0.1:19301/ws");
    assert.deepEqual(
      electronLaunchConfig(home, 19101, null, undefined, "linux").args,
      [`--user-data-dir=${launch.userDataDir}`, "--disable-gpu", "--disable-dev-shm-usage"],
    );
  } finally {
    if (priorRegistry === undefined) delete process.env.SURF_ACE_SERVER;
    else process.env.SURF_ACE_SERVER = priorRegistry;
  }
  const sentinel = {};
  let invocation;
  const launched = await launchElectron("/fixture/Surf Ace", home, 19101, (command, args, options) => {
    invocation = { args, command, options };
    return sentinel;
  });
  assert.equal(launched.started, sentinel);
  assert.deepEqual(invocation, {
    args: launched.launch.args,
    command: "/fixture/Surf Ace",
    options: { env: launched.launch.env },
  });
  assert.equal((await fs.stat(launch.userDataDir)).isDirectory(), true);
});

test("Linux Electron ZIP launcher binds the expected name and documented sandbox contract", async (t) => {
  const builder = await fs.readFile(path.join(repository, "scripts/release/build-tightbeam-release.mjs"), "utf8");
  assert.match(builder, /"--config\.executableName", "surf-ace"/);
  assert.match(builder, /installLinuxElectronLauncher\(electronRoot\)/);

  const root = await temporary(t);
  const electronRoot = path.join(root, "linux-unpacked");
  await fs.mkdir(electronRoot, { recursive: true });
  await fs.writeFile(path.join(electronRoot, "surf-ace"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
  const launcher = await installLinuxElectronLauncher(electronRoot);
  assert.equal(launcher, path.join(electronRoot, "surf-ace"));
  assert.equal((await fs.stat(launcher)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(electronRoot, "surf-ace-bin"))).mode & 0o777, 0o755);
  assert.match(await fs.readFile(launcher, "utf8"), /--no-sandbox/);
  const invoked = await exec(launcher, ["--fixture-argument", "value"]);
  assert.equal(invoked.stdout, "--no-sandbox\n--fixture-argument\nvalue\n");

  const packageSource = path.join(root, "package-source");
  const packagedRoot = path.join(packageSource, "Surf Ace");
  await fs.mkdir(packagedRoot, { recursive: true });
  await fs.cp(electronRoot, packagedRoot, { recursive: true });
  const archive = path.join(root, "electron.zip");
  await createDirectoryZip(packageSource, ".", archive, 1_790_000_000);
  const installed = await installElectronArchive(archive, path.join(root, "installed"), "linux");
  assert.equal(installed, path.join(root, "installed/Surf Ace/surf-ace"));
  assert.equal((await fs.stat(installed)).mode & 0o111, 0o111);
});

test("smoke stop treats an already signal-exited child as exited", async () => {
  const { start, stop } = await import("./smoke-lib.mjs");
  const started = start(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  const outcome = await new Promise((resolve) => started.child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, "SIGKILL");
  let timer;
  try {
    await Promise.race([
      stop(started),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("signal_exit_cleanup_timeout")), 2_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});

test("Tightbeam macOS smoke plans one exact candidate profile", async (t) => {
  const root = await temporary(t);
  const candidate = path.join(root, "candidate.zip");
  const { electronLaunchConfig } = await import("./smoke-lib.mjs");
  const { macosSmokePlan } = await import("./smoke-tightbeam-release.mjs");
  const plan = macosSmokePlan(root, candidate);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan.map(({ archive, phase }) => ({ archive, phase })), [{ archive: candidate, phase: "candidate" }]);
  assert.equal(plan[0].identityFile, path.join(electronLaunchConfig(plan[0].home, plan[0].port).userDataDir, "surface-identity.json"));
});

test("smoke participant identity gate binds server, CLI, and client to exact v0.2.0 package bytes", () => {
  const valid = smokeParticipantIdentities("linux");
  assert.deepEqual(assertTightbeamSmokeParticipantIdentities(valid, "linux").map(({ participant, version }) => ({ participant, version })), [
    { participant: "server", version: "0.2.0" },
    { participant: "cli", version: "0.2.0" },
    { participant: "client", version: "0.2.0" },
  ]);
  for (const participant of ["server", "cli", "client"]) {
    const mismatched = valid.map((identity) => identity.participant === participant
      ? { ...identity, version: "0.1.0" }
      : identity);
    assert.throws(() => assertTightbeamSmokeParticipantIdentities(mismatched, "linux"),
      new RegExp(`tightbeam_smoke_participant_identity_mismatch:${participant}`));
  }
  assert.deepEqual(assertTightbeamElectronPackageIdentity({ packageName: "@surf-ace/electron", version: TIGHTBEAM.version }), {
    packageName: "@surf-ace/electron", version: TIGHTBEAM.version,
  });
  assert.throws(() => assertTightbeamElectronPackageIdentity({ packageName: "@surf-ace/electron", version: "0.1.0" }),
    /tightbeam_smoke_electron_package_identity_mismatch/);
  assert.throws(() => assertTightbeamElectronPackageIdentity({ name: "@surf-ace/electron", version: TIGHTBEAM.version }),
    /tightbeam_smoke_electron_package_identity_mismatch/);
});

test("smoke hashes each actual server, CLI, and client archive before participant use", async (t) => {
  const root = await temporary(t);
  const roles = ["server", "cli", "client"];
  const assetNames = TIGHTBEAM.assets.slice(0, 3);
  const assetPaths = Object.fromEntries(await Promise.all(roles.map(async (role, index) => {
    const assetPath = path.join(root, assetNames[index]);
    await fs.writeFile(assetPath, `v0.2.0-${role}`);
    return [role, assetPath];
  })));
  const details = await Promise.all(roles.map(async (role, index) => {
    const assetPath = assetPaths[role];
    const bytes = await fs.readFile(assetPath);
    return { name: assetNames[index], sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
  }));
  const identities = buildTightbeamSmokeParticipantIdentities({
    assetDetails: details,
    component: "linux",
    identityBasis: "manifest-and-SHA256SUMS",
    sourceCommit: TIGHTBEAM.candidateCommit,
    toolingCommit: "b".repeat(40),
    version: TIGHTBEAM.version,
  });
  assert.deepEqual(await assertTightbeamSmokeParticipantAssetBytes(identities, "linux", assetPaths), identities);

  for (const role of roles) {
    const original = await fs.readFile(assetPaths[role]);
    await fs.writeFile(assetPaths[role], `${original.toString()}-substituted`);
    await assert.rejects(assertTightbeamSmokeParticipantAssetBytes(identities, "linux", assetPaths),
      new RegExp(`tightbeam_smoke_participant_asset_digest_mismatch:${role}`));
    await fs.writeFile(assetPaths[role], original);
  }
});

test("Linux smoke fails on a changed participant archive before requiring or launching the smoke fixture", async (t) => {
  const root = await temporary(t);
  const assetNames = TIGHTBEAM.assets.slice(0, 3);
  const roles = ["server", "cli", "client"];
  const assetPaths = Object.fromEntries(await Promise.all(roles.map(async (role, index) => {
    const name = assetNames[index];
    const assetPath = path.join(root, name);
    await fs.writeFile(assetPath, name);
    return [role, assetPath];
  })));
  const details = await Promise.all(roles.map(async (role, index) => {
    const name = assetNames[index];
    const bytes = await fs.readFile(assetPaths[role]);
    return { name, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
  }));
  const participantIdentities = buildTightbeamSmokeParticipantIdentities({
    assetDetails: details,
    component: "linux",
    identityBasis: "manifest-and-SHA256SUMS",
    sourceCommit: TIGHTBEAM.candidateCommit,
    toolingCommit: "b".repeat(40),
    version: TIGHTBEAM.version,
  });
  await fs.writeFile(assetPaths.server, "substituted server archive");
  const priorDriver = process.env.SURF_ACE_TIGHTBEAM_STATE_DRIVER;
  delete process.env.SURF_ACE_TIGHTBEAM_STATE_DRIVER;
  try {
    await assert.rejects(smokeLinuxFreshInstall({
      backend: assetPaths.server,
      cli: assetPaths.cli,
      electron: assetPaths.client,
      participantIdentities,
    }), /tightbeam_smoke_participant_asset_digest_mismatch:server/);
  } finally {
    if (priorDriver === undefined) delete process.env.SURF_ACE_TIGHTBEAM_STATE_DRIVER;
    else process.env.SURF_ACE_TIGHTBEAM_STATE_DRIVER = priorDriver;
  }
});

test("running Electron release identity is read from one app_launch diagnostic and hash-bound", async (t) => {
  const root = await temporary(t);
  const diagnostic = path.join(root, "client-flight-recorder.ndjson");
  await recordClientAppLaunch(diagnostic, "0.2.0");
  const identity = await verifyClientAppVersion(diagnostic, "0.2.0");
  assert.equal(identity.source, "electron.app.getVersion");
  assert.equal(identity.version, "0.2.0");
  assert.equal(identity.evidenceSha256, createHash("sha256").update(await fs.readFile(diagnostic)).digest("hex"));
  await recordClientAppLaunch(diagnostic, "0.1.0");
  await assert.rejects(verifyClientAppVersion(diagnostic, "0.2.0"), /tightbeam_client_app_version_mismatch/);
  await fs.writeFile(diagnostic, "no app launch evidence\n");
  await assert.rejects(verifyClientAppVersion(diagnostic, "0.2.0"), /tightbeam_client_app_launch_identity_missing_or_ambiguous/);
});

test("Electron smoke rejects a mismatched participant identity before launching a client", async (t) => {
  const root = await temporary(t);
  const plan = macosSmokePlan(root, "candidate.zip");
  let launches = 0;
  const identities = smokeParticipantIdentities("macos", { cli: { version: "0.1.0" } });
  await assert.rejects(runMacosSmokePlan(plan, {
    cliBinary: "/fixture/bin/surf-ace",
    participantIdentities: identities,
    launchClient: async () => { launches += 1; return { async stop() {} }; },
  }), /tightbeam_smoke_participant_identity_mismatch:cli/);
  assert.equal(launches, 0);
});

test("Electron smoke rejects the packaged client version before launching it", async (t) => {
  const root = await temporary(t);
  const plan = macosSmokePlan(root, "candidate.zip");
  let launches = 0;
  await assert.rejects(runMacosSmokePlan(plan, {
    cliBinary: "/fixture/bin/surf-ace",
    extract: async (_archive, installRoot) => fs.mkdir(path.join(installRoot, "Surf Ace.app/Contents/MacOS"), { recursive: true }),
    participantIdentities: smokeParticipantIdentities("macos"),
    readElectronPackageIdentity: async () => ({ packageName: "@surf-ace/electron", version: "0.1.0" }),
    launchClient: async () => { launches += 1; return { async stop() {} }; },
  }), /tightbeam_smoke_electron_package_identity_mismatch/);
  assert.equal(launches, 0);
});

test("Electron smoke checks the running app version before any CLI request", async (t) => {
  const root = await temporary(t);
  const plan = macosSmokePlan(root, "candidate.zip");
  let cliCalls = 0;
  await assert.rejects(runMacosSmokePlan(plan, {
    cliBinary: "/fixture/bin/surf-ace",
    extract: async (_archive, installRoot) => fs.mkdir(path.join(installRoot, "Surf Ace.app/Contents/MacOS"), { recursive: true }),
    participantIdentities: smokeParticipantIdentities("macos"),
    readElectronPackageIdentity: async () => ({ packageName: "@surf-ace/electron", version: TIGHTBEAM.version }),
    invokeCli: async () => { cliCalls += 1; throw new Error("CLI must not run after an identity Red"); },
    launchClient: async (_executable, step, _endpoint, evidence) => {
      await fs.mkdir(path.dirname(step.identityFile), { recursive: true });
      await fs.writeFile(step.identityFile, "test-identity");
      await recordClientAppLaunch(evidence.diagnosticLogPath, "0.1.0");
      return { async stop() {} };
    },
    stateRoot: path.join(root, "cli-state"),
    waitForEndpoint: async () => undefined,
  }), /tightbeam_client_app_version_mismatch:0\.1\.0:0\.2\.0/);
  assert.equal(cliCalls, 0);
});

test("Tightbeam macOS smoke uses the packaged CLI directly against one candidate client", async (t) => {
  const root = await temporary(t);
  const { macosSmokePlan, runMacosSmokePlan } = await import("./smoke-tightbeam-release.mjs");
  const plan = macosSmokePlan(root, "candidate.zip");
  let visibleId;
  const calls = [];
  let activePort;
  const launchClient = async (_exe, step, _endpoint, evidence) => {
    activePort = step.port;
    await fs.mkdir(path.dirname(step.identityFile), { recursive: true });
    await fs.writeFile(step.identityFile, "candidate");
    await recordClientAppLaunch(evidence.diagnosticLogPath);
    assert.ok(evidence.rawCliEvidencePath.endsWith("macos-candidate-raw-cli-evidence.ndjson"));
    return { async stop() {} };
  };
  const invokeCli = async (commandName, input, endpoint) => {
    if (endpoint === undefined) endpoint = `ws://127.0.0.1:${activePort}/ws`;
    calls.push({ commandName, endpoint, input });
    const surfaceId = "sf_macos_candidate";
    if (commandName === "list") return { ok: true, result: { surfaces: [{ surfaceId, topology: { panes: [{ paneId: 1 }], topologyRevision: 1 } }] } };
    if (commandName === "push") {
      if (input.surfaceId !== surfaceId) return { ok: false, error: "unknown_surface" };
      visibleId = input.contentId;
      return { ok: true, result: { accepted: true } };
    }
    if (commandName === "capture-pane") return { ok: true, result: {
      contentId: visibleId, visibleText: `${visibleId}:${surfaceId}:1`, paneId: input.paneId, revision: calls.length,
    } };
    if (commandName === "read") return { ok: true, result: {
      cacheStatus: "current", consumableLoss: null,
      currentContentRecord: { recordClass: "content", payload: {
        contentId: visibleId, historyEntryId: "history-1", paneId: 1, revision: calls.length, surfaceId,
      } }, scopeId: input.scopeId,
    } };
    throw new Error(`unexpected CLI command ${commandName}`);
  };
  const result = await runMacosSmokePlan(plan, {
    cliBinary: "/fixture/bin/surf-ace",
    extract: async (_archive, installRoot) => fs.mkdir(path.join(installRoot, "Surf Ace.app/Contents/MacOS"), { recursive: true }),
    invokeCli, launchClient,
    participantIdentities: smokeParticipantIdentities("macos"),
    readElectronPackageIdentity: async () => ({ packageName: "@surf-ace/electron", version: TIGHTBEAM.version }),
    stateRoot: path.join(root, "cli-state"), waitForEndpoint: async () => undefined,
  });
  assert.deepEqual(result.phases.map(({ phase }) => phase), ["candidate"]);
  assert.equal(result.phases[0].currentContentId, result.phases[0].contentId);
  assert.equal(result.phases[0].wrongSurfaceRejection.expectedSurfaceId, "sf_macos_candidate");
  assert.deepEqual(calls.map(({ commandName }) => commandName), ["list", "push", "capture-pane", "read", "push"]);
  assert.ok(calls.filter(({ commandName }) => commandName === "read").every(({ endpoint }) => endpoint === null));
  assert.ok(calls.filter(({ commandName }) => commandName !== "read").every(({ endpoint }) => endpoint === "ws://127.0.0.1:19101/ws"));
});

test("Tightbeam direct capture rejects a contradictory response surface", async (t) => {
  const root = await temporary(t);
  const { macosSmokePlan, runMacosSmokePlan } = await import("./smoke-tightbeam-release.mjs");
  const [step] = macosSmokePlan(root, "candidate.zip");
  await assert.rejects(runMacosSmokePlan([step], {
    cliBinary: "/fixture/bin/surf-ace",
    extract: async (_archive, installRoot) => fs.mkdir(path.join(installRoot, "Surf Ace.app/Contents/MacOS"), { recursive: true }),
    invokeCli: async (commandName, input) => {
      if (commandName === "list") return { ok: true, result: { surfaces: [{ surfaceId: "sf_expected", topology: { panes: [{ paneId: 1 }], topologyRevision: 1 } }] } };
      if (commandName === "push") return { ok: true, result: { accepted: true } };
      if (commandName === "capture-pane") return { ok: true, result: { contentId: "candidate-write", paneId: input.paneId, revision: 1, surfaceId: "sf_wrong" } };
      throw new Error(`unexpected CLI command ${commandName}`);
    },
    launchClient: async (_executable, launchedStep, _endpoint, evidence) => {
      await fs.mkdir(path.dirname(launchedStep.identityFile), { recursive: true });
      await fs.writeFile(launchedStep.identityFile, "test-identity");
      await recordClientAppLaunch(evidence.diagnosticLogPath);
      return { async stop() {} };
    },
    participantIdentities: smokeParticipantIdentities("macos"),
    readElectronPackageIdentity: async () => ({ packageName: "@surf-ace/electron", version: TIGHTBEAM.version }),
    stateRoot: path.join(root, "cli-state"), waitForEndpoint: async () => undefined,
  }), /tightbeam_macos_candidate_capture_target_mismatch/);
});

test("Tightbeam direct smoke rejects missing current content despite a matching scroll event", async (t) => {
  const root = await temporary(t);
  const { macosSmokePlan, runMacosSmokePlan } = await import("./smoke-tightbeam-release.mjs");
  const [step] = macosSmokePlan(root, "candidate.zip");
  await assert.rejects(runMacosSmokePlan([step], {
    cliBinary: "/fixture/bin/surf-ace",
    extract: async (_archive, installRoot) => fs.mkdir(path.join(installRoot, "Surf Ace.app/Contents/MacOS"), { recursive: true }),
    invokeCli: async (commandName, input) => {
      if (commandName === "list") return { ok: true, result: { surfaces: [{ surfaceId: "sf_expected", topology: { panes: [{ paneId: 1 }], topologyRevision: 1 } }] } };
      if (commandName === "push") return { ok: true, result: { accepted: true } };
      if (commandName === "capture-pane") return { ok: true, result: {
        contentId: "tightbeam-macos-candidate-write", paneId: input.paneId,
        visibleText: "tightbeam-macos-candidate-write:sf_expected:1",
      } };
      if (commandName === "read") return { ok: true, result: {
        cacheStatus: "current", consumableLoss: null, currentContentRecord: null,
        records: [{ recordClass: "scroll", payload: { contentId: "tightbeam-macos-candidate-write" } }],
        scopeId: input.scopeId,
      } };
      throw new Error(`unexpected CLI command ${commandName}`);
    },
    launchClient: async (_executable, launchedStep, _endpoint, evidence) => {
      await fs.mkdir(path.dirname(launchedStep.identityFile), { recursive: true });
      await fs.writeFile(launchedStep.identityFile, "test-identity");
      await recordClientAppLaunch(evidence.diagnosticLogPath);
      return { async stop() {} };
    },
    participantIdentities: smokeParticipantIdentities("macos"),
    readElectronPackageIdentity: async () => ({ packageName: "@surf-ace/electron", version: TIGHTBEAM.version }),
    stateRoot: path.join(root, "cli-state"), waitForEndpoint: async () => undefined,
  }), /tightbeam_macos_candidate_capture_read_content_mismatch/);
});

test("Tightbeam Linux Electron smoke plans one matching candidate client", async (t) => {
  const root = await temporary(t);
  const candidate = path.join(root, "candidate.zip");
  const { electronLaunchConfig } = await import("./smoke-lib.mjs");
  const plan = electronSmokePlan(root, candidate, "linux");
  assert.equal(plan.length, 1);
  assert.deepEqual(plan.map(({ archive, phase, platform }) => ({ archive, phase, platform })), [{ archive: candidate, phase: "candidate", platform: "linux" }]);
  assert.equal(plan[0].identityFile, path.join(electronLaunchConfig(plan[0].home, plan[0].port).userDataDir, "surface-identity.json"));
});

test("tracked-product guard detects worktree and index changes", async (t) => {
  const root = await temporary(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "release-test@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Release Test"], { cwd: root });
  await fs.writeFile(path.join(root, "tracked.txt"), "clean\n");
  await exec("git", ["add", "tracked.txt"], { cwd: root });
  await exec("git", ["commit", "-qm", "fixture"], { cwd: root });
  await assertTrackedInputsUnchanged(root);
  await fs.writeFile(path.join(root, "tracked.txt"), "dirty\n");
  await assert.rejects(assertTrackedInputsUnchanged(root));
});

test("source identity binds HEAD and the immutable source tag to one commit", async (t) => {
  const root = await temporary(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "release-test@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Release Test"], { cwd: root });
  await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
  await exec("git", ["add", "tracked.txt"], { cwd: root });
  await exec("git", ["commit", "-qm", "one"], { cwd: root });
  const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await assert.rejects(assertSourceIdentity(root, "product-v1", commit));
  await exec("git", ["tag", "product-v1"], { cwd: root });
  await assertSourceIdentity(root, "product-v1", commit);
  await fs.writeFile(path.join(root, "tracked.txt"), "two\n");
  await exec("git", ["commit", "-qam", "two"], { cwd: root });
  await assert.rejects(assertSourceIdentity(root, "product-v1", commit), /source_commit_mismatch/);
});

test("standalone release builder rejects source identity drift before I/O", async () => {
  await assert.rejects(buildTightbeamRelease({ sourceDir: ".", outputDir: "build/release/tightbeam", sourceTag: "wrong", sourceCommit: "wrong", version: "0", target: "wrong" }), /tightbeam_release_identity_mismatch/);
});

test("Linux qualification accepts only exact P and full tooling SHA claims", () => {
  const toolingCommit = "a".repeat(40);
  assert.doesNotThrow(() => assertTightbeamLinuxQualificationClaims({
    sourceCommit: TIGHTBEAM.candidateCommit,
    toolingCommit,
    version: TIGHTBEAM.version,
    target: TOOLCHAINS.linuxRustTarget,
  }));
  assert.throws(() => assertTightbeamLinuxQualificationClaims({
    sourceCommit: "b".repeat(40), toolingCommit, version: TIGHTBEAM.version, target: TOOLCHAINS.linuxRustTarget,
  }), /tightbeam_linux_qualification_identity_mismatch/);
  assert.throws(() => assertTightbeamLinuxQualificationClaims({
    sourceCommit: TIGHTBEAM.candidateCommit, toolingCommit: "short", version: TIGHTBEAM.version, target: TOOLCHAINS.linuxRustTarget,
  }), /tightbeam_linux_qualification_tooling_commit_invalid/);
  assert.throws(() => assertTightbeamLinuxQualificationClaims({
    sourceCommit: TIGHTBEAM.candidateCommit, toolingCommit, version: "0.0.0", target: TOOLCHAINS.linuxRustTarget,
  }), /tightbeam_linux_qualification_identity_mismatch/);
  assert.throws(() => assertTightbeamLinuxQualificationClaims({
    sourceCommit: TIGHTBEAM.candidateCommit, toolingCommit, version: TIGHTBEAM.version, target: "wrong-target",
  }), /tightbeam_linux_qualification_identity_mismatch/);
});

test("tagless Linux qualification verifies exact HEADs and emits only Linux packages", async (t) => {
  const root = await temporary(t);
  const sourceDir = path.join(root, "source");
  const toolingRoot = path.join(root, "tooling");
  const outputDir = path.join(root, "qualification-output");
  await fs.mkdir(sourceDir);
  await fs.mkdir(toolingRoot);
  const toolingCommit = "c".repeat(40);
  const gitCalls = [];
  const cleanCalls = [];
  let buildCalls = 0;
  const previousComponent = process.env.SURF_ACE_RELEASE_COMPONENT;
  process.env.SURF_ACE_RELEASE_COMPONENT = "linux";
  t.after(() => {
    if (previousComponent === undefined) delete process.env.SURF_ACE_RELEASE_COMPONENT;
    else process.env.SURF_ACE_RELEASE_COMPONENT = previousComponent;
  });

  const result = await buildTightbeamLinuxQualification({
    outputDir,
    sourceCommit: TIGHTBEAM.candidateCommit,
    sourceDir,
    target: TOOLCHAINS.linuxRustTarget,
    toolingCommit,
    version: TIGHTBEAM.version,
  }, {
    assertTrackedInputsUnchanged: async (tree) => { cleanCalls.push(tree); },
    buildLinuxPackages: async (inputs) => {
      buildCalls += 1;
      assert.deepEqual(inputs, { sourceDir, outputDir, target: TOOLCHAINS.linuxRustTarget });
      return { files: ["server.tar.gz", "cli.tar.gz", "electron.zip"], outputDir };
    },
    capture: async (command, args) => {
      gitCalls.push([command, args]);
      return args[1] === sourceDir ? TIGHTBEAM.candidateCommit : toolingCommit;
    },
    toolingRoot,
  });

  assert.deepEqual(gitCalls, [
    ["git", ["-C", sourceDir, "rev-parse", "HEAD"]],
    ["git", ["-C", toolingRoot, "rev-parse", "HEAD"]],
    ["git", ["-C", sourceDir, "rev-parse", "HEAD"]],
    ["git", ["-C", toolingRoot, "rev-parse", "HEAD"]],
  ]);
  assert.deepEqual(cleanCalls, [sourceDir, toolingRoot, sourceDir, toolingRoot]);
  assert.equal(buildCalls, 1);
  assert.equal(result.qualificationOnly, true);
  assert.equal(result.releaseAdmitted, false);
  assert.equal(result.sourceCommit, TIGHTBEAM.candidateCommit);
  assert.equal(result.toolingCommit, toolingCommit);
  assert.deepEqual(result.files, ["server.tar.gz", "cli.tar.gz", "electron.zip"]);
  assert.equal(Object.hasOwn(result, "manifestPath"), false);
});

test("tagless Linux qualification fails closed before output/build on drift or non-Linux component", async (t) => {
  const root = await temporary(t);
  const sourceDir = path.join(root, "source");
  const toolingRoot = path.join(root, "tooling");
  const outputDir = path.join(root, "output");
  await fs.mkdir(sourceDir);
  await fs.mkdir(toolingRoot);
  const previousComponent = process.env.SURF_ACE_RELEASE_COMPONENT;
  process.env.SURF_ACE_RELEASE_COMPONENT = "linux";
  t.after(() => {
    if (previousComponent === undefined) delete process.env.SURF_ACE_RELEASE_COMPONENT;
    else process.env.SURF_ACE_RELEASE_COMPONENT = previousComponent;
  });
  let buildCalls = 0;
  let readCount = 0;
  const options = {
    outputDir,
    sourceCommit: TIGHTBEAM.candidateCommit,
    sourceDir,
    target: TOOLCHAINS.linuxRustTarget,
    toolingCommit: "d".repeat(40),
    version: TIGHTBEAM.version,
  };
  const dependencies = {
    assertTrackedInputsUnchanged: async () => {},
    buildLinuxPackages: async () => { buildCalls += 1; return { files: [] }; },
    capture: async () => { readCount += 1; return "e".repeat(40); },
    toolingRoot,
  };
  await assert.rejects(buildTightbeamLinuxQualification(options, dependencies), /source_commit_mismatch/);
  assert.equal(readCount, 1);
  assert.equal(buildCalls, 0);
  await assert.rejects(fs.access(outputDir));

  process.env.SURF_ACE_RELEASE_COMPONENT = "manifest";
  await assert.rejects(buildTightbeamLinuxQualification(options, dependencies), /requires_linux_component/);
  assert.equal(readCount, 1);
  assert.equal(buildCalls, 0);
});

test("tagless Linux qualification refuses a non-empty output directory without replacing evidence", async (t) => {
  const root = await temporary(t);
  const sourceDir = path.join(root, "source");
  const toolingRoot = path.join(root, "tooling");
  const outputDir = path.join(root, "output");
  await fs.mkdir(sourceDir);
  await fs.mkdir(toolingRoot);
  await fs.mkdir(outputDir);
  const sentinel = path.join(outputDir, "preserve.txt");
  await fs.writeFile(sentinel, "do not overwrite\n");
  const previousComponent = process.env.SURF_ACE_RELEASE_COMPONENT;
  process.env.SURF_ACE_RELEASE_COMPONENT = "linux";
  t.after(() => {
    if (previousComponent === undefined) delete process.env.SURF_ACE_RELEASE_COMPONENT;
    else process.env.SURF_ACE_RELEASE_COMPONENT = previousComponent;
  });
  let buildCalls = 0;
  await assert.rejects(buildTightbeamLinuxQualification({
    outputDir,
    sourceCommit: TIGHTBEAM.candidateCommit,
    sourceDir,
    target: TOOLCHAINS.linuxRustTarget,
    toolingCommit: "e".repeat(40),
    version: TIGHTBEAM.version,
  }, {
    assertTrackedInputsUnchanged: async () => {},
    buildLinuxPackages: async () => { buildCalls += 1; return { files: [] }; },
    capture: async (_command, args) => args[1] === sourceDir ? TIGHTBEAM.candidateCommit : "e".repeat(40),
    toolingRoot,
  }), /output_not_empty/);
  assert.equal(buildCalls, 0);
  assert.equal(await fs.readFile(sentinel, "utf8"), "do not overwrite\n");
});

test("tagless Linux qualification detects a source HEAD change during packaging", async (t) => {
  const root = await temporary(t);
  const sourceDir = path.join(root, "source");
  const toolingRoot = path.join(root, "tooling");
  const outputDir = path.join(root, "output");
  await fs.mkdir(sourceDir);
  await fs.mkdir(toolingRoot);
  const previousComponent = process.env.SURF_ACE_RELEASE_COMPONENT;
  process.env.SURF_ACE_RELEASE_COMPONENT = "linux";
  t.after(() => {
    if (previousComponent === undefined) delete process.env.SURF_ACE_RELEASE_COMPONENT;
    else process.env.SURF_ACE_RELEASE_COMPONENT = previousComponent;
  });
  let sourceReads = 0;
  let buildCalls = 0;
  await assert.rejects(buildTightbeamLinuxQualification({
    outputDir,
    sourceCommit: TIGHTBEAM.candidateCommit,
    sourceDir,
    target: TOOLCHAINS.linuxRustTarget,
    toolingCommit: "a".repeat(40),
    version: TIGHTBEAM.version,
  }, {
    assertTrackedInputsUnchanged: async () => {},
    buildLinuxPackages: async () => { buildCalls += 1; return { files: ["partial-linux-output"] }; },
    capture: async (_command, args) => {
      if (args[1] === sourceDir) {
        sourceReads += 1;
        return sourceReads === 1 ? TIGHTBEAM.candidateCommit : "b".repeat(40);
      }
      return "a".repeat(40);
    },
    toolingRoot,
  }), /source_commit_changed_during_qualification/);
  assert.equal(sourceReads, 2);
  assert.equal(buildCalls, 1);
});

test("tagless Linux qualification smoke binds exact P/S heads and only the three Linux assets", async (t) => {
  const root = await temporary(t);
  const sourceDir = path.join(root, "source");
  const toolingRoot = path.join(root, "tooling");
  const packageDir = path.join(root, "packages");
  await fs.mkdir(sourceDir);
  await fs.mkdir(toolingRoot);
  await fs.mkdir(packageDir);
  for (const name of TIGHTBEAM.assets.slice(0, 3)) await fs.writeFile(path.join(packageDir, name), `fixture:${name}\n`);

  const previousComponent = process.env.SURF_ACE_SMOKE_COMPONENT;
  process.env.SURF_ACE_SMOKE_COMPONENT = "linux";
  t.after(() => {
    if (previousComponent === undefined) delete process.env.SURF_ACE_SMOKE_COMPONENT;
    else process.env.SURF_ACE_SMOKE_COMPONENT = previousComponent;
  });

  const toolingCommit = "f".repeat(40);
  const assetDetails = await Promise.all(TIGHTBEAM.assets.slice(0, 3).map(async (name) => {
    const bytes = await fs.readFile(path.join(packageDir, name));
    return { name, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
  }));
  const expectedParticipantIdentities = buildTightbeamSmokeParticipantIdentities({
    assetDetails,
    component: "linux",
    identityBasis: "source-tooling-HEAD-and-package-SHA256",
    sourceCommit: TIGHTBEAM.candidateCommit,
    toolingCommit,
    version: TIGHTBEAM.version,
  });
  const gitCalls = [];
  const cleanCalls = [];
  let smokeCalls = 0;
  const dependencies = {
    assertTrackedInputsUnchanged: async (tree) => { cleanCalls.push(tree); },
    capture: async (command, args) => {
      gitCalls.push([command, args]);
      return args[1] === sourceDir ? TIGHTBEAM.candidateCommit : toolingCommit;
    },
    runLinuxFreshInstallSmoke: async (options) => {
      smokeCalls += 1;
      assert.deepEqual(options, {
        backend: path.join(packageDir, TIGHTBEAM.assets[0]),
        candidateCommit: TIGHTBEAM.candidateCommit,
        cli: path.join(packageDir, TIGHTBEAM.assets[1]),
        electron: path.join(packageDir, TIGHTBEAM.assets[2]),
        participantIdentities: expectedParticipantIdentities,
        sourceDir,
      });
      return { component: "linux", mode: "fresh-install", status: "passed" };
    },
    toolingRoot,
  };
  const options = {
    packageDir,
    sourceCommit: TIGHTBEAM.candidateCommit,
    sourceDir,
    toolingCommit,
  };
  const result = await smokeTightbeamLinuxQualification(options, dependencies);
  assert.equal(smokeCalls, 1);
  assert.deepEqual(gitCalls, [
    ["git", ["-C", sourceDir, "rev-parse", "HEAD"]],
    ["git", ["-C", toolingRoot, "rev-parse", "HEAD"]],
    ["git", ["-C", sourceDir, "rev-parse", "HEAD"]],
    ["git", ["-C", toolingRoot, "rev-parse", "HEAD"]],
  ]);
  assert.deepEqual(cleanCalls, [sourceDir, toolingRoot, sourceDir, toolingRoot]);
  assert.equal(result.qualificationOnly, true);
  assert.equal(result.releaseAdmitted, false);
  assert.equal(result.sourceCommit, TIGHTBEAM.candidateCommit);
  assert.equal(result.toolingCommit, toolingCommit);
  assert.deepEqual(result.participantIdentities, expectedParticipantIdentities);
  assert.equal(result.status, "passed");
  assert.equal(Object.keys(result.assets).length, 3);
  assert.equal(Object.hasOwn(result, "manifest"), false);

  await fs.writeFile(path.join(packageDir, TIGHTBEAM.manifest), "not-an-admitted-manifest\n");
  await assert.rejects(smokeTightbeamLinuxQualification(options, dependencies), /asset_set_mismatch/);
  assert.equal(smokeCalls, 1);
});

test("tagless Linux qualification smoke rejects a moving source HEAD after smoke", async (t) => {
  const root = await temporary(t);
  const sourceDir = path.join(root, "source");
  const toolingRoot = path.join(root, "tooling");
  const packageDir = path.join(root, "packages");
  await fs.mkdir(sourceDir);
  await fs.mkdir(toolingRoot);
  await fs.mkdir(packageDir);
  for (const name of TIGHTBEAM.assets.slice(0, 3)) await fs.writeFile(path.join(packageDir, name), `fixture:${name}\n`);
  const previousComponent = process.env.SURF_ACE_SMOKE_COMPONENT;
  process.env.SURF_ACE_SMOKE_COMPONENT = "linux";
  t.after(() => {
    if (previousComponent === undefined) delete process.env.SURF_ACE_SMOKE_COMPONENT;
    else process.env.SURF_ACE_SMOKE_COMPONENT = previousComponent;
  });
  const toolingCommit = "c".repeat(40);
  let sourceReads = 0;
  let smokeCalls = 0;
  await assert.rejects(smokeTightbeamLinuxQualification({
    packageDir,
    sourceCommit: TIGHTBEAM.candidateCommit,
    sourceDir,
    toolingCommit,
  }, {
    assertTrackedInputsUnchanged: async () => {},
    capture: async (_command, args) => {
      if (args[1] === sourceDir) {
        sourceReads += 1;
        return sourceReads === 1 ? TIGHTBEAM.candidateCommit : "d".repeat(40);
      }
      return toolingCommit;
    },
    runLinuxFreshInstallSmoke: async () => { smokeCalls += 1; return { status: "passed" }; },
    toolingRoot,
  }), /source_commit_changed_during_qualification_smoke/);
  assert.equal(sourceReads, 2);
  assert.equal(smokeCalls, 1);
});

test("tagless qualification leaves release build and manifest-smoke tag admission intact", async () => {
  const builder = await fs.readFile(path.join(repository, "scripts/release/build-tightbeam-release.mjs"), "utf8");
  const builderRelease = builder.slice(builder.indexOf("export async function buildTightbeamRelease"), builder.indexOf("if (import.meta.url === pathToFileURL(process.argv[1]).href)"));
  assert.match(builderRelease, /await assertSourceIdentity\(sourceDir, options\.sourceTag, options\.sourceCommit\)/);
  assert.match(builderRelease, /refs\/tags\/\$\{TIGHTBEAM_TOOLING_TAG\}\^\{commit\}/);
  assert.doesNotMatch(builderRelease, /qualificationOnly|buildTightbeamLinuxQualification/);

  const smoke = await fs.readFile(path.join(repository, "scripts/release/smoke-tightbeam-release.mjs"), "utf8");
  const manifestSmoke = smoke.slice(smoke.indexOf("export async function smokeTightbeam(options)"));
  assert.match(manifestSmoke, /await verifyManifestFiles\(options\.manifest, assetFiles\)/);
  assert.match(manifestSmoke, /await verifyTightbeamChecksums\(options\.manifest\)/);
  assert.match(manifestSmoke, /manifest_identity_mismatch/);
  const linuxQualificationSmoke = smoke.slice(smoke.indexOf("async function smokeLinuxFreshInstall"), smoke.indexOf("export function macosSmokePlan"));
  assert.match(linuxQualificationSmoke, /runLinuxFreshInstallSmoke/);
  assert.match(linuxQualificationSmoke, /tightbeam_smoke_state_driver_not_current_tooling_input/);
  assert.doesNotMatch(linuxQualificationSmoke, /baselineCommit/);
  const freshInstallFixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  const freshInstallMain = freshInstallFixture.slice(freshInstallFixture.indexOf("async function freshInstallMain"), freshInstallFixture.indexOf("async function main()"));
  assert.ok(freshInstallMain.indexOf("await verifyDisplayReady()") < freshInstallMain.indexOf("await startPackagedElectronClient("));
  assert.match(freshInstallMain, /fresh_install_wrong_surface_changed_valid_target/);
});

test("Tightbeam v0.2.0 binds the reviewed candidate, five hosted assets, and tooling identity", () => {
  assert.equal(TIGHTBEAM_TOOLING_TAG, "surf-ace-release-tooling-tightbeam-v0.2.0");
  assert.deepEqual(TIGHTBEAM, {
    candidateCommit: "0c181cc512816ee3e03a0284fdcea9a70a175019",
    sourceTag: "surf-ace-tightbeam-v0.2.0", version: "0.2.0", toolingTag: TIGHTBEAM_TOOLING_TAG,
    assets: ["surf-ace-tightbeam-server-linux-x86_64-v0.2.0.tar.gz","surf-ace-tightbeam-cli-linux-x86_64-v0.2.0.tar.gz","surf-ace-tightbeam-electron-linux-x86_64-v0.2.0.zip","surf-ace-tightbeam-cli-macos-arm64-v0.2.0.tar.gz","surf-ace-tightbeam-electron-macos-arm64-v0.2.0.zip"],
    manifest: "surf-ace-tightbeam-v0.2.0-manifest.json", checksums: "SHA256SUMS",
  });
  assert.equal(TIGHTBEAM.assets.length, 5);
  assert.deepEqual(TIGHTBEAM_ROUTING, {
    clientOperations: "packaged-cli-direct-to-client-websocket",
    registryResponsibilities: ["client-registration", "global-window-label-allocation", "postgresql-backed-registry-health"],
    securityBoundary: "tailnet",
  });
});

test("Tightbeam SHA256SUMS binds exactly the five hosted assets and manifest", async (t) => {
  const root = await temporary(t);
  const names = [...TIGHTBEAM.assets, TIGHTBEAM.manifest].sort();
  const lines = [];
  for (const name of names) {
    const bytes = `fixture:${name}\n`;
    await fs.writeFile(path.join(root, name), bytes);
    lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  const sums = path.join(root, TIGHTBEAM.checksums);
  await fs.writeFile(sums, `${lines.join("\n")}\n`);
  assert.deepEqual((await verifyTightbeamChecksums(path.join(root, TIGHTBEAM.manifest))).files, names);
  await fs.writeFile(path.join(root, names[0]), "tampered\n");
  await assert.rejects(verifyTightbeamChecksums(path.join(root, TIGHTBEAM.manifest)), /tightbeam_checksum_mismatch/);
});

test("Tightbeam manifest assembles the five hosted assets without iOS distribution signing", async (t) => {
  const outputDir = await temporary(t);
  for (const name of TIGHTBEAM.assets) await fs.writeFile(path.join(outputDir, name), `fixture:${name}\n`);

  const result = await writeTightbeamManifest({
    outputDir,
    sourceDir: repository,
    toolingCommit: "a".repeat(40),
  });
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.deepEqual(result.files, TIGHTBEAM_PUBLIC_FILES);
  assert.deepEqual(manifest.assets.map(({ name }) => name), TIGHTBEAM.assets);
  assert.equal(Object.hasOwn(manifest, "iosSigning"), false);
  assert.deepEqual((await verifyTightbeamChecksums(result.manifestPath)).files,
    [...TIGHTBEAM.assets, TIGHTBEAM.manifest].sort());
  assert.deepEqual((await fs.readdir(outputDir)).sort(), [...TIGHTBEAM_PUBLIC_FILES].sort());

  await fs.writeFile(path.join(outputDir, "surf-ace-tightbeam-ios-ipad-v0.2.0.ipa"), "stale\n");
  await assert.rejects(writeTightbeamManifest({
    outputDir,
    sourceDir: repository,
    toolingCommit: "a".repeat(40),
  }), /public_file_set_mismatch/);
});

test("Tightbeam manifest inventory follows only Electron production dependencies", async () => {
  const inventory = await workspaceProductionInventory(path.join(repository, "pnpm-lock.yaml"), "packages/electron");
  const names = new Set(inventory.map(({ name }) => name));
  for (const name of ["bonjour-service", "linkedom", "pdfjs-dist", "ws"]) assert.ok(names.has(name));
  for (const name of ["electron", "electron-builder", "esbuild", "typescript"]) assert.equal(names.has(name), false);
  assert.ok(inventory.every(({ integrity }) => integrity.startsWith("sha512-")));
});

test("Tightbeam Linux stage contains only the standalone CLI, callable server closure, schemas, and lifecycle docs", async (t) => {
  const root = await temporary(t);
  const source = path.join(root, "source");
  const stage = path.join(root, "stage");
  const target = "x86_64-unknown-linux-gnu";
  const files = {
    [`packages/cli/target/${target}/release/surf-ace`]: "rust-cli",
    "packages/electron/dist/central-server.cjs": "module.exports={startCentralServer(){}};",
    "packages/electron/dist/schema.json": "{}\n",
    "packages/allocator/sql/001_allocator.sql": "-- schema\n",
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(source, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }

  await assembleTightbeamLinuxStage({ sourceDir: source, stageDir: stage, target });
  const actual = [];
  async function walk(directory, relative = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), child);
      else actual.push(child);
    }
  }
  await walk(stage);
  assert.deepEqual(actual.sort(), [...TIGHTBEAM_LINUX_SERVER_FILES].sort());
  assert.deepEqual(TIGHTBEAM_LINUX_RUNTIME_FILES, TIGHTBEAM_LINUX_SERVER_FILES);
  const guide = await fs.readFile(path.join(stage, "README.md"), "utf8");
  assert.match(guide, /startCentralServer\(config, name\)/);
  assert.match(guide, /await service\.close\(\)/);
  assert.match(guide, /already-provisioned PostgreSQL (?:16 )?custody/);
  assert.match(guide, /foreground launcher/);
  assert.match(guide, /does not install or enable a service/);
  assert.doesNotMatch(actual.join("\n"), /surf-ace-runtime|controller\/dist\/main\.js/);
  const unit = await fs.readFile(path.join(stage, "service/surf-ace-server@.service"), "utf8");
  assert.match(unit, /Type=simple/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /KillSignal=SIGTERM/);
  assert.match(unit, /TimeoutStopSec=30s/);
  assert.match(unit, /^Environment=SURF_ACE_CLIENT_DIAGNOSTIC_LOG=\/run\/surf-ace-server\/client-flight-recorder\.log$/m);
  const operations = await fs.readFile(path.join(stage, "docs/OPERATIONS.md"), "utf8");
  assert.match(operations, /pg_dump --format=custom/);
  assert.match(operations, /pg_restore --clean --if-exists --exit-on-error/);
  assert.match(operations, /discard-staging-and-retain-original/);

  await fs.chmod(path.join(stage, "bin/surf-ace"), 0o644);
  await assert.rejects(verifyTightbeamLinuxStage(stage), /tightbeam_linux_runtime_cli_not_executable/);
  await fs.chmod(path.join(stage, "bin/surf-ace"), 0o755);
  await fs.chmod(path.join(stage, "bin/surf-ace-server"), 0o644);
  await assert.rejects(verifyTightbeamLinuxStage(stage), /tightbeam_linux_server_launcher_not_executable/);
  await fs.chmod(path.join(stage, "bin/surf-ace-server"), 0o755);

  await fs.appendFile(path.join(stage, "service/surf-ace-server@.service"), "ExecStartPre=/usr/bin/pg_restore --dbname prod backup.dump\n");
  await assert.rejects(verifyTightbeamLinuxStage(stage), /tightbeam_linux_unit_performs_provisioning/);
  await fs.copyFile(path.join(repository, "scripts/release/templates/surf-ace-server@.service"), path.join(stage, "service/surf-ace-server@.service"));

  await fs.writeFile(path.join(stage, "surf-ace-runtime"), "obsolete daemon launcher\n");
  await assert.rejects(verifyTightbeamLinuxStage(stage), /tightbeam_linux_runtime_closure_mismatch/);
});

function validTightbeamServerConfig(overrides = {}) {
  return {
    custody: {
      expectedClusterSystemId: "7410123456789012345",
      fleetId: "fleet-release-smoke",
      primaryUrl: "postgresql://allocator_writer:fixture-password@127.0.0.1:5432/postgres",
      recoveryUrl: "postgresql://allocator_recovery:fixture-password@127.0.0.1:5432/postgres",
      witnessApplicationName: "surf_ace_witness",
      witnessPhysicalSlot: "surf_ace_smoke_witness_slot",
      witnessServerId: "witness-smoke",
      witnessUrl: "postgresql://allocator_witness:fixture-password@127.0.0.1:5433/postgres",
    },
    hostLockPath: "/var/run/surf-ace-server/controller.lock",
    listenHost: "127.0.0.1",
    listenPort: 19001,
    name: "Surf Ace test server",
    ...overrides,
  };
}

test("Tightbeam foreground launcher validates exact PG16 config and WebSocket health safely", async (t) => {
  const root = await temporary(t);
  const configPath = path.join(root, "server.json");
  await fs.writeFile(configPath, `${JSON.stringify(validTightbeamServerConfig())}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  assert.deepEqual(tightbeamServerLauncher.validateServerConfig(validTightbeamServerConfig()), validTightbeamServerConfig());
  assert.deepEqual(await tightbeamServerLauncher.readServerConfig(configPath), validTightbeamServerConfig());
  assert.throws(() => tightbeamServerLauncher.validateServerConfig(validTightbeamServerConfig({ listenPort: 0 })), /server_config_listen_port_invalid/);
  assert.throws(() => tightbeamServerLauncher.validateServerConfig(validTightbeamServerConfig({ listenPort: 65536 })), /server_config_listen_port_invalid/);
  assert.throws(() => tightbeamServerLauncher.validateServerConfig(validTightbeamServerConfig({ listenHost: "http://127.0.0.1" })), /server_config_listen_host_invalid/);
  assert.throws(() => tightbeamServerLauncher.validateServerConfig(validTightbeamServerConfig({ unexpected: true })), /server_config_shape_invalid/);
  assert.throws(() => tightbeamServerLauncher.validateServerConfig(validTightbeamServerConfig({
    custody: { ...validTightbeamServerConfig().custody, witnessApplicationName: "wrong" },
  })), /server_config_custody_shape_invalid|server_config_witness_application_invalid/);
  assert.throws(() => tightbeamServerLauncher.healthUrl("ws://user:secret@127.0.0.1:19001/ws"), /health_endpoint_invalid/);
  assert.throws(() => tightbeamServerLauncher.healthUrl("ws://127.0.0.1:19001/not-ws"), /health_endpoint_invalid/);
  assert.equal(tightbeamServerLauncher.healthUrl("ws://127.0.0.1:19001/ws").pathname, "/ws");
  if (process.platform === "linux") {
    await fs.chmod(configPath, 0o644);
    await assert.rejects(tightbeamServerLauncher.readServerConfig(configPath), /server_config_permissions_too_open/);
    await fs.chmod(configPath, 0o600);
  }

  const healthServer = new WebSocketServer({ host: "127.0.0.1", path: "/ws", port: 0 });
  await new Promise((resolve, reject) => {
    healthServer.once("error", reject);
    healthServer.once("listening", resolve);
  });
  const address = healthServer.address();
  const endpoint = `ws://127.0.0.1:${address.port}/ws`;
  try {
    assert.deepEqual(await tightbeamServerLauncher.checkHealth(endpoint), {
      endpoint: `ws://127.0.0.1:${address.port}`,
      status: "healthy",
      transport: "websocket-open",
    });
  } finally {
    await new Promise((resolve, reject) => healthServer.close((error) => error ? reject(error) : resolve()));
  }
  await assert.rejects(tightbeamServerLauncher.checkHealth(endpoint), /health_check_unavailable/);
});

test("Tightbeam foreground output separates product diagnostics from lifecycle events", () => {
  const diagnostic = "[surf-ace:server] event=server_bind_ok host=127.0.0.1 port=59625 ws_path=/ws";
  assert.deepEqual(tightbeamServerLauncher.parseForegroundOutputLine(diagnostic), {
    event: "server_bind_ok", kind: "diagnostic", scope: "server",
  });
  assert.deepEqual(tightbeamServerLauncher.parseForegroundOutputLine("[surf-ace:bonjour] event=publish_start port=59625"), {
    event: "publish_start", kind: "diagnostic", scope: "bonjour",
  });
  assert.deepEqual(tightbeamServerLauncher.parseForegroundOutputLine(JSON.stringify({
    endpoint: "ws://127.0.0.1:59625/ws", event: "ready", host: "127.0.0.1", pid: 1234, port: 59625,
  })), {
    event: { endpoint: "ws://127.0.0.1:59625/ws", event: "ready", host: "127.0.0.1", pid: 1234, port: 59625 },
    kind: "lifecycle",
  });
  assert.throws(() => tightbeamServerLauncher.parseForegroundOutputLine("unstructured unexpected output"), /server_output_line_invalid/);
  assert.throws(() => tightbeamServerLauncher.parseForegroundOutputLine(JSON.stringify({ event: "unknown" })), /server_output_line_invalid/);
  assert.throws(
    () => tightbeamServerLauncher.parseForegroundOutputLine("unstructured unexpected output"),
    (error) => error.publicCode === "server_output_line_invalid" && error.outputIssue === "not_json_or_server_diagnostic",
  );
  assert.throws(
    () => tightbeamServerLauncher.parseForegroundOutputLine(JSON.stringify({ event: "unknown" })),
    (error) => error.publicCode === "server_output_line_invalid" && error.outputIssue === "lifecycle_event_unexpected",
  );
  assert.throws(
    () => tightbeamServerLauncher.parseForegroundOutputLine("[surf-ace:allocator] event=unexpected"),
    (error) => error.publicCode === "server_output_line_invalid" && error.outputIssue === "product_diagnostic_scope_allocator",
  );
  const config = validTightbeamServerConfig({ hostLockPath: "/run/surf-ace-server/instance.lock" });
  assert.equal(tightbeamServerLauncher.defaultDiagnosticLogPath(config, {}), "/run/surf-ace-server/client-flight-recorder.log");
  assert.equal(tightbeamServerLauncher.defaultDiagnosticLogPath(config, {
    SURF_ACE_CLIENT_DIAGNOSTIC_LOG: "/private/tmp/fixture-diagnostics.log",
  }), "/private/tmp/fixture-diagnostics.log");
  assert.throws(() => tightbeamServerLauncher.defaultDiagnosticLogPath(config, {
    SURF_ACE_CLIENT_DIAGNOSTIC_LOG: "relative/diagnostics.log",
  }), /server_diagnostic_log_path_invalid/);
});

test("Tightbeam foreground lifecycle holds and releases its server on SIGTERM without logging custody URLs", async (t) => {
  const root = await temporary(t);
  const modulePath = path.join(root, "central-server.cjs");
  const markerPath = path.join(root, "closed.marker");
  await fs.writeFile(modulePath, `
    const fs = require("node:fs");
    module.exports = { startCentralServer: async () => ({
      server: { address: { host: "127.0.0.1", port: 19001, url: "ws://127.0.0.1:19001" } },
      close: async () => fs.writeFileSync(${JSON.stringify(markerPath)}, "closed\\n"),
    }) };
  `);
  const signals = new EventEmitter();
  const lines = [];
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const running = tightbeamServerLauncher.startForeground(validTightbeamServerConfig(), {
    serverModulePath: modulePath,
    signalSource: signals,
    write(line) {
      lines.push(JSON.parse(line));
      if (lines.at(-1).event === "ready") readyResolve();
    },
  });
  await ready;
  signals.emit("SIGTERM");
  assert.deepEqual(await running, { endpoint: "ws://127.0.0.1:19001/ws", status: "stopped" });
  assert.deepEqual(lines.map(({ event }) => event), ["ready", "stopped"]);
  assert.equal(await fs.readFile(markerPath, "utf8"), "closed\n");
  assert.doesNotMatch(JSON.stringify(lines), /fixture-password/);
});

test("Tightbeam CLI distribution is a separate exact client-only package", async (t) => {
  const root = await temporary(t);
  const binary = path.join(root, "surf-ace");
  const stage = path.join(root, "cli-stage");
  await fs.writeFile(binary, "offline fixture binary\n");
  await assembleTightbeamCliStage({ binary, stageDir: stage, platform: "Linux x86_64" });
  const verified = await verifyTightbeamCliStage(stage);
  assert.deepEqual(verified.files, [...TIGHTBEAM_CLI_FILES].sort());
  const guide = await fs.readFile(path.join(stage, "README.md"), "utf8");
  assert.match(guide, /does not start a\s+server or provision PostgreSQL/);
  assert.match(guide, /--state-root/);
  await fs.chmod(path.join(stage, "bin/surf-ace"), 0o644);
  await assert.rejects(verifyTightbeamCliStage(stage), /tightbeam_cli_not_executable/);
  await fs.chmod(path.join(stage, "bin/surf-ace"), 0o755);
  await fs.writeFile(path.join(stage, "server.cjs"), "must not ship\n");
  await assert.rejects(verifyTightbeamCliStage(stage), /tightbeam_cli_runtime_closure_mismatch/);
});

test("Tightbeam Linux builder creates source-declared dependencies before the Electron server bundle", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const builder = await fs.readFile(path.join(repository, "scripts/release/build-tightbeam-release.mjs"), "utf8");
  const functionStart = builder.indexOf("export async function buildTightbeamLinuxStage");
  const functionEnd = builder.indexOf("export async function buildTightbeamRelease", functionStart);
  const body = builder.slice(functionStart, functionEnd);
  const protocol = body.indexOf('"@surf-ace/protocol", "build"');
  const allocator = body.indexOf('"@surf-ace/allocator", "build"');
  const controller = body.indexOf('"@surf-ace/controller", "build"');
  const electron = body.indexOf('"@surf-ace/electron", "build"');
  assert.ok(protocol >= 0, "protocol build is required");
  assert.ok(allocator > protocol, "allocator smoke helpers must compile against the exact product source");
  assert.ok(controller > allocator, "controller build must follow allocator");
  assert.ok(electron > controller, "Electron server bundle must follow controller");
});

test("Tightbeam Linux clean tests build required workspace packages before controller tests and stop on prerequisite failure", async (t) => {
  const workflow = await fs.readFile(path.join(repository, ".github/workflows/release-tightbeam.yml"), "utf8");
  const script = workflowRunScript(workflow, "Install frozen dependencies and run Linux product tests");
  const protocolBuild = script.indexOf("pnpm --dir source --filter @surf-ace/protocol build");
  const allocatorBuild = script.indexOf("pnpm --dir source --filter @surf-ace/allocator build");
  const controllerBuild = script.indexOf("pnpm --dir source --filter @surf-ace/controller build");
  const controllerTest = script.indexOf("pnpm --dir source --filter @surf-ace/controller test");
  const protocolTest = script.indexOf("pnpm --dir source --filter @surf-ace/protocol test");
  assert.ok(protocolBuild >= 0 && allocatorBuild > protocolBuild && controllerBuild > allocatorBuild &&
    controllerTest > controllerBuild && protocolTest > controllerTest,
  "a clean install must build protocol and allocator before controller tests load dist entrypoints");
  assert.ok(TIGHTBEAM_TEST_COMMANDS.indexOf("pnpm --dir source --filter @surf-ace/protocol build") <
    TIGHTBEAM_TEST_COMMANDS.indexOf("pnpm --dir source --filter @surf-ace/allocator build"));
  assert.ok(TIGHTBEAM_TEST_COMMANDS.indexOf("pnpm --dir source --filter @surf-ace/allocator build") <
    TIGHTBEAM_TEST_COMMANDS.indexOf("pnpm --dir source --filter @surf-ace/controller test"));
  assert.ok(TIGHTBEAM_BUILD_COMMANDS.some((command) => command.includes("--config.executableName surf-ace")),
    "the manifest must bind the same Linux executable-name override as the packaged builder");

  const root = await temporary(t);
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(bin, "pnpm"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$COMMAND_LOG\"\nif test \"$*\" = \"$FAIL_COMMAND\"; then exit 37; fi\n", { mode: 0o755 });
  await fs.writeFile(path.join(bin, "cargo"), "#!/bin/sh\nprintf '%s\\n' \"cargo $*\" >> \"$COMMAND_LOG\"\n", { mode: 0o755 });
  const invoke = async (failCommand = "") => {
    await fs.writeFile(log, "");
    const invocation = exec("/bin/bash", ["-c", script], {
      cwd: root,
      env: { ...process.env, COMMAND_LOG: log, FAIL_COMMAND: failCommand, PATH: `${bin}:${process.env.PATH}` },
    });
    if (failCommand) await assert.rejects(invocation);
    else await invocation;
    return (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean);
  };
  const expected = [
    "--dir source fetch --frozen-lockfile",
    "--dir source install --offline --frozen-lockfile",
    "--dir source --filter @surf-ace/protocol build",
    "--dir source --filter @surf-ace/allocator build",
    "--dir source --filter @surf-ace/controller build",
    "--dir source --filter @surf-ace/controller test",
    "--dir source --filter @surf-ace/protocol test",
    "cargo test --manifest-path source/packages/cli/Cargo.toml --locked",
  ];
  assert.deepEqual(await invoke(), expected);
  assert.deepEqual(await invoke(expected[2]), expected.slice(0, 3));
});

function semanticPhase(sourceCommit, overrides = {}) {
  const phase = {
    allocatorAfterRegistration: {
      allocatorId: "allocator-owned", assignmentCount: 1, nextOrdinalFence: 7, primaryHeadSeq: 4, stateVersion: 1,
    },
    allocatorBeforeRegistration: {
      allocatorId: "allocator-owned", assignmentCount: 1, nextOrdinalFence: 7, primaryHeadSeq: 4, stateVersion: 1,
    },
    allocatorFence: 7,
    allocatorHeadSeq: 4,
    allocatorIdentity: "allocator-owned",
    allocatorStateVersion: 1,
    clientIdentity: "0123abcd",
    commandRoute: "direct-client-websocket",
    controllerIdentity: "controller-stable",
    currentContentRecord: null,
    databaseIdentity: "database-owned",
    directClientEndpoint: "ws://127.0.0.1:19001/ws",
    loss: null,
    registrationIdentity: `0123abcd${"a".repeat(56)}`,
    registryEndpoint: "ws://127.0.0.1:19002/ws",
    registryRegistration: {
      panes: [{ paneId: "1", paneLabel: 1 }],
      surfaceId: "sf_1",
      windowLabel: "a",
    },
    resetCount: 0,
    resetEvidence: { databaseIdentity: "database-owned", priorDatabaseIdentity: null },
    semanticState: {
      content: { seed: { contentId: "seed" } },
      history: { "pane:sf_1:1": ["seed"] },
      labels: { pane1: 1, surface: "a" },
      panes: [1, 2],
      tombstones: ["pane-old"],
    },
    sequence: 12,
    surfaceId: "sf_1",
    sourceCommit,
    ...overrides,
  };
  const records = Object.keys(phase.semanticState.content).map((contentId, index) => ({
    payload: { contentId },
    recordClass: "content",
    recordId: `record-${contentId}`,
    sequence: index + 1,
  }));
  if (!("allocatorAfterRegistration" in overrides)) {
    phase.allocatorAfterRegistration = {
      ...phase.allocatorAfterRegistration,
      allocatorId: phase.allocatorIdentity,
      nextOrdinalFence: phase.allocatorFence,
      primaryHeadSeq: phase.allocatorHeadSeq,
      stateVersion: phase.allocatorStateVersion,
    };
  }
  if (!("allocatorBeforeRegistration" in overrides)) {
    phase.allocatorBeforeRegistration = structuredClone(phase.allocatorAfterRegistration);
  }
  phase.readEvidence ??= [{
    captureOutput: {
      result: { contentId: records.at(-1)?.payload?.contentId ?? null, contentType: "html", paneId: 1, revision: 1 },
    },
    output: {
      controllerInstanceId: phase.controllerIdentity,
      result: {
        cacheStatus: "current",
        consumableLoss: null,
        currentContentRecord: records.at(-1) ?? null,
        records,
        scopeId: "pane:sf_1:1",
      },
    },
    endpoint: phase.directClientEndpoint,
    paneId: 1,
    scopeId: "pane:sf_1:1",
    surfaceId: phase.surfaceId,
  }];
  phase.readControllerIdentities ??= [phase.controllerIdentity];
  return phase;
}

function postgresRecoveryFixture(candidateContentId = "write-candidate-1", overrides = {}) {
  const lifecycleCheck = (phase, delta) => ({
    appendedRevisionHeads: delta,
    custodyRevisionDelta: delta,
    journalHeadUnchanged: true,
    leaseGenerationDelta: delta,
    ok: true,
    phase,
    semanticProjectionUnchanged: true,
  });
  return {
    backup: { bytes: 4096, format: "custom", listSha256: "b".repeat(64), sha256: "a".repeat(64) },
    rollback: {
      originalProjectionAfterStageSha256: "c".repeat(64),
      originalProjectionBeforeStageSha256: "c".repeat(64),
      strategy: "discard-staging-and-retain-original",
      verified: true,
    },
    schema: { has_fleets: true, has_journal: true, has_journal_validator: true, has_read_state: true },
    sourceDatabaseIdentity: "database-owned",
    stagedDatabaseIdentity: "staging-owned",
    stagedProjectionAfterServiceSha256: "e".repeat(64),
    stagedProjectionBeforeServiceSha256: "d".repeat(64),
    stagedLifecycleEvidence: {
      checks: {
        completeCycle: lifecycleCheck("completed", 2),
        healthRead: { afterProjectionSha256: "e".repeat(64), beforeProjectionSha256: "e".repeat(64), ok: true },
        serviceRelease: lifecycleCheck("released", 1),
        serviceStart: lifecycleCheck("active", 1),
      },
      path: "fixture/staged-server-lifecycle.json",
      sha256: "f".repeat(64),
    },
    clientObservation: {
      endpoint: "ws://127.0.0.1:19001/ws",
      paneId: 1,
      route: "packaged-cli-direct-client",
      surfaceId: "sf_1",
    },
    stagedServer: {
      health: { status: "healthy", transport: "websocket-open" },
      lifecycle: { exitCode: 0, stopped: { signal: "SIGTERM", status: "clean" } },
    },
    ...overrides,
  };
}

function postgresRestartFixture(overrides = {}) {
  const lifecycle = (pid) => ({
    pidAfter: pid + 1,
    pidBefore: pid,
    startExitCode: 0,
    startStdout: "server started\n",
    stopExitCode: 0,
    stopStdout: "server stopped\n",
  });
  return {
    databaseIdentity: "database-owned",
    lifecycle: { primary: lifecycle(101), witness: lifecycle(201) },
    projectionAfterSha256: "e".repeat(64),
    projectionBeforeSha256: "e".repeat(64),
    registryHealth: { event: "health", status: "healthy", transport: "websocket-open" },
    status: "verified",
    witnessSynchronized: true,
    ...overrides,
  };
}







test("Tightbeam PG restart continuity is part of candidate fresh-install smoke only", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const fixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  const main = fixture.slice(fixture.indexOf("async function main()"));
  assert.match(main, /await freshInstallMain\(options\)/);
  assert.doesNotMatch(fixture, /registryStopBeforePostgresRestart|async function runPhase/);
  assert.match(fixture, /const postgresRestart = await restartPostgresCluster\(cluster, allocatorProjectionAfterRegistryShutdown\)/);
  assert.match(fixture, /fresh-install-registry-after-restart/);
});

test("Tightbeam fresh install separates expected registry lease release from PostgreSQL restart continuity", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const fixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  const smoke = await fs.readFile(path.join(repository, "scripts/release/smoke-tightbeam-release.mjs"), "utf8");
  const freshInstall = fixture.slice(
    fixture.indexOf("async function freshInstallMain("),
    fixture.indexOf("async function main()"),
  );
  const projectionBeforeStop = freshInstall.indexOf("const allocatorProjectionBeforeRestart = await allocatorDatabaseProjection(cluster.adminUrl, cluster.config.fleetId);");
  const stop = freshInstall.indexOf("const registryShutdownBeforeRestart = await registryProcess.stop();");
  const projectionAfterStop = freshInstall.indexOf("const allocatorProjectionAfterRegistryShutdown = await allocatorDatabaseProjection(cluster.adminUrl, cluster.config.fleetId);");
  const releaseContinuity = freshInstall.indexOf("const registryShutdownContinuity = verifyAllocatorServiceLifecycle(");
  const restart = freshInstall.indexOf("const postgresRestart = await restartPostgresCluster(cluster, allocatorProjectionAfterRegistryShutdown);");
  const start = freshInstall.indexOf('"fresh-install-registry-after-restart"');
  assert.ok(projectionBeforeStop >= 0 && projectionBeforeStop < stop && stop < projectionAfterStop &&
    projectionAfterStop < releaseContinuity && releaseContinuity < restart && restart < start);
  assert.match(freshInstall, /if \(!registryShutdownContinuity\.ok\)\s*\{\s*throw new Error\(`fresh_install_registry_shutdown_semantics_changed:/);
  assert.match(freshInstall, /verifyAllocatorServiceLifecycle\(\s*allocatorProjectionBeforeRestart,\s*allocatorProjectionAfterRegistryShutdown,\s*"released",\s*\)/);
  assert.doesNotMatch(freshInstall, /allocatorProjectionBeforeRestart\.projectionSha256\s*!==\s*postgresRestart\.projectionBeforeSha256/);
  assert.match(fixture, /async function restartPostgresCluster\(\s*cluster: Cluster,\s*expectedProjectionBefore\?: Awaited<ReturnType<typeof allocatorDatabaseProjection>>,\s*\)/);
  assert.match(fixture, /const projectionBefore = expectedProjectionBefore \?\? await allocatorDatabaseProjection\(cluster\.adminUrl, cluster\.config\.fleetId\)/);
  assert.match(smoke, /const registryShutdown = restart\.registryShutdown/);
  assert.match(smoke, /registryShutdown\.releasedProjectionSha256 !== restart\.projectionBeforeSha256/);
  assert.match(smoke, /registryShutdown\.continuity\?\.semanticProjectionUnchanged !== true/);
});

test("Tightbeam registered direct targets bind client, surface, and valid pane IDs rather than display labels", async () => {
  const { matchesRegisteredDirectTarget } = await import("./smoke-lib.mjs");
  assert.equal(typeof matchesRegisteredDirectTarget, "function");
  const registration = {
    client: { clientId: "client-expected" },
    surface: {
      panes: [{ paneId: 99, paneLabel: 99 }],
      surfaceId: "sf_expected",
      windowLabel: "a",
    },
  };
  const directSurface = {
    surfaceId: "sf_expected",
    topology: { panes: [{ paneId: 1, paneLabel: 1 }, { paneId: 4, paneLabel: 2 }] },
    windowLabel: "b",
  };

  assert.equal(matchesRegisteredDirectTarget("client-expected", registration, directSurface), true,
    "the client's direct pane IDs and exact registered surface remain authoritative when display labels lag");
  assert.equal(matchesRegisteredDirectTarget("other-client", registration, directSurface), false);
  assert.equal(matchesRegisteredDirectTarget("client-expected", registration, { ...directSurface, surfaceId: "sf_wrong" }), false);
  assert.equal(matchesRegisteredDirectTarget("client-expected", registration, {
    ...directSurface, topology: { panes: [{ paneId: 0 }, { paneId: 1 }] },
  }), false);
  assert.equal(matchesRegisteredDirectTarget("client-expected", registration, {
    ...directSurface, topology: { panes: [{ paneId: 1 }, { paneId: 1 }] },
  }), false);
});

test("Tightbeam PG backup validation parses pg_restore schema and table tokens", async () => {
  const { hasRequiredAllocatorBackupObjects } = await import("./smoke-lib.mjs");
  assert.equal(typeof hasRequiredAllocatorBackupObjects, "function");
  const complete = [
    "222; 1259 16527 TABLE surf_ace_allocator custody_journal surf_ace_allocator_owner",
    "218; 1259 16437 TABLE surf_ace_allocator fleets surf_ace_allocator_owner",
    "3992; 0 16527 TABLE DATA surf_ace_allocator custody_journal surf_ace_allocator_owner",
    "3988; 0 16437 TABLE DATA surf_ace_allocator fleets surf_ace_allocator_owner",
  ].join("\n");
  assert.equal(hasRequiredAllocatorBackupObjects(complete), true);
  const missingFleets = [
    "222; 1259 16527 TABLE surf_ace_allocator custody_journal surf_ace_allocator_owner",
    "3992; 0 16527 TABLE DATA surf_ace_allocator custody_journal surf_ace_allocator_owner",
  ].join("\n");
  assert.equal(hasRequiredAllocatorBackupObjects(missingFleets), false);
  assert.equal(hasRequiredAllocatorBackupObjects(complete.replaceAll("surf_ace_allocator", "wrong_schema")), false);
});

test("Tightbeam staged restore preserves the packaged server custody config envelope", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const fixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  assert.match(fixture, /const serverConfig = \{\s* custody: stage\.config,/);
  assert.doesNotMatch(fixture, /const serverConfig = \{\s*\.\.\.stage\.config,/);
});

test("Tightbeam staged server allows only append-only writer lease bookkeeping", async () => {
  const { verifyAllocatorServiceLifecycle } = await import("./smoke-lib.mjs");
  assert.equal(typeof verifyAllocatorServiceLifecycle, "function");
  const beforeFleet = {
    accepted_generation_id: "gen-1", allocator_id: "alloc-smoke", custody_revision: 5,
    fleet_id: "fleet-smoke", head_hash: "head-3", head_seq: 3, last_commit_at: "before",
    lease_backend_pid: 111, lease_generation: 4, lease_id: "lease_old", lease_mode: "writer",
    lifecycle: "active", next_ordinal_fence: 2, state_version: 1,
  };
  const before = { databaseIdentity: "db-stage", tables: {
    allocation_transactions: [{ transaction_id: "tx-1", status: "committed" }],
    assignments: [{ surface_id: "sf_one", ordinal: 1, window_label: "a" }],
    authority_owners: [{ authority_id: "auth-one", owner_anchor_id: "owner-one" }],
    custody_journal: [{ head_seq: 3, head_hash: "head-3", event: { type: "allocation" } }],
    custody_revision_heads: [
      { custody_revision: 4, head_seq: 3, head_hash: "head-3" },
      { custody_revision: 5, head_seq: 3, head_hash: "head-3" },
    ],
    fleet_tombstones: [{ fleet_id: "fleet-smoke", first_allocator_id: "alloc-smoke" }],
    fleets: [beforeFleet],
    restore_generations: [],
  } };
  const acquiredFleet = {
    ...beforeFleet, custody_revision: 6, last_commit_at: "acquired", lease_backend_pid: 222,
    lease_generation: 5, lease_id: "lease_new", lease_mode: "writer",
  };
  const active = { ...before, tables: {
    ...before.tables,
    custody_revision_heads: [
      ...before.tables.custody_revision_heads,
      { custody_revision: 6, head_seq: 3, head_hash: "head-3" },
    ],
    fleets: [acquiredFleet],
  } };
  const releasedFleet = {
    ...acquiredFleet, custody_revision: 7, last_commit_at: "released", lease_backend_pid: null,
    lease_generation: 6, lease_id: null, lease_mode: null,
  };
  const released = { ...active, tables: {
    ...active.tables,
    custody_revision_heads: [
      ...active.tables.custody_revision_heads,
      { custody_revision: 7, head_seq: 3, head_hash: "head-3" },
    ],
    fleets: [releasedFleet],
  } };

  assert.equal(verifyAllocatorServiceLifecycle(before, active, "active").ok, true);
  assert.equal(verifyAllocatorServiceLifecycle(active, released, "released").ok, true);
  assert.equal(verifyAllocatorServiceLifecycle(before, released, "completed").ok, true);
  assert.equal(verifyAllocatorServiceLifecycle(before, { tables: {
    ...released.tables, assignments: [{ surface_id: "sf_wrong", ordinal: 1, window_label: "a" }],
  } }, "completed").ok, false);
  assert.equal(verifyAllocatorServiceLifecycle(before, { tables: {
    ...released.tables, custody_journal: [...released.tables.custody_journal, { head_seq: 4, head_hash: "head-4" }],
  } }, "completed").ok, false);
  assert.equal(verifyAllocatorServiceLifecycle(before, { tables: {
    ...released.tables, custody_revision_heads: released.tables.custody_revision_heads.slice(0, -1),
  } }, "completed").ok, false);
  assert.equal(verifyAllocatorServiceLifecycle(before, { tables: {
    ...released.tables, fleets: [{ ...releasedFleet, lease_id: "lease_still_active", lease_mode: "writer", lease_backend_pid: 222 }],
  } }, "completed").ok, false);
  assert.equal(verifyAllocatorServiceLifecycle(before, { ...active, tables: {
    ...active.tables, fleets: [{ ...acquiredFleet, custody_revision: 8 }],
  } }, "active").reason, "lease_revision_delta_invalid");
});

test("Tightbeam Linux acceptance uses packaged behavior, not transient acknowledgement helper fields", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const fixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  const smoke = await fs.readFile(path.join(repository, "scripts/release/smoke-tightbeam-release.mjs"), "utf8");
  const shared = await fs.readFile(path.join(repository, "scripts/release/smoke-lib.mjs"), "utf8");
  assert.doesNotMatch(fixture, /readPackagedControllerState|acknowledgeObservedReads|acknowledgementOutbox|acknowledgedWriteIds|clientCursor|lastRetainedSequence|acknowledgementEvidence/);
  assert.doesNotMatch(smoke, /acknowledgement_state_not_current|acknowledgedWriteIds|outboxBeforeCount|outboxAfterCount|clientCursor|lastRetainedSequence/);
  assert.doesNotMatch(shared, /acknowledgementEvidenceForReads/);
  assert.match(fixture, /raw-cli-evidence\.ndjson/);
  assert.match(fixture, /rawCliEvidenceSha256/);
  assert.match(fixture, /rawCliEvidenceBase64/);
  assert.match(fixture, /function summarizeFreshInstallPhase/);
  assert.match(fixture, /matchesFreshInstallCurrentContent\(firstRecord, contentId, surfaceId, paneId\)/);
  assert.match(fixture, /content: currentContentRecord/);
  assert.match(fixture, /const directList = await cli\(options\.cliBinary, cliStateRoot, "list", \{\}, app\.endpoint\)/);
  assert.match(fixture, /await cli\(options\.cliBinary, cliStateRoot, "push",/);
  assert.match(fixture, /pushOutput\.command !== "push" \|\| pushOutput\.ok !== true/);
  assert.match(fixture, /firstCapture\?\.contentId !== contentId/);
  assert.match(fixture, /const firstRead = await readPane\(options\.cliBinary, cliStateRoot, app\.endpoint, surfaceId, paneId\)/);
  assert.match(fixture, /const afterWrongSurfaceRead = await readPane\(options\.cliBinary, cliStateRoot, app\.endpoint, surfaceId, paneId\)/);
  assert.match(fixture, /rejectedWrongSurfacePush\(/);
  assert.match(fixture, /const registryShutdownBeforeRestart = await registryProcess\.stop\(\)/);
  assert.match(fixture, /const postgresRestart = await restartPostgresCluster\(cluster, allocatorProjectionAfterRegistryShutdown\)/);
  assert.match(fixture, /const registryStop = await registryProcess\.stop\(\)/);
  assert.match(smoke, /function requireLinuxFreshInstallRawCliCoverage/);
  assert.match(smoke, /matchesFreshInstallCurrentContent\(result\?\.currentContentRecord/);
  assert.match(fixture, /matchesRegisteredDirectTarget\(electronClientId, registration, listed\)/);
  assert.match(fixture, /await verifyDisplayReady\(\)/);
  assert.doesNotMatch(fixture, /function semanticState\(/);
  assert.doesNotMatch(fixture, /runPhase\("(?:baseline|candidate|rollback)"/);
});

function rawCliEvidenceFixture(endpoint = "ws://127.0.0.1:19001/ws", stateRoot = "/fixture/state/cli") {
  const events = [];
  const record = (command, input, target = endpoint) => {
    const inputJson = JSON.stringify(input);
    const args = ["--state-root", stateRoot];
    if (target) args.push("--endpoint", target, "--product-label", "Surf Ace release smoke");
    args.push(command, "--input-json", inputJson);
    const output = { ok: true, result: {} };
    events.push({
      args,
      command,
      endpoint: target,
      input,
      inputJson,
      output,
      route: target ? "direct-client-websocket" : "endpointless-local-read",
      status: 0,
      stderr: "",
      stdout: JSON.stringify(output),
    });
  };
  record("list", {});
  record("topology-intent", { action: "split", count: 3, paneId: 1, surfaceId: "sf_1" });
  record("push", { contentId: "candidate-write", paneId: 2, surfaceId: "sf_1" });
  record("capture-pane", { includeImage: true, paneId: 2, surfaceId: "sf_1" });
  record("read", { scopeId: "pane:sf_1:2" }, null);
  record("topology-intent", { action: "close", paneId: 3, surfaceId: "sf_1" });
  const bytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return {
    rawCliEvidenceBase64: bytes.toString("base64"),
    rawCliEvidenceBytes: bytes.byteLength,
    rawCliEvidenceSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("fresh-install Linux qualification requires direct current content, wrong-surface rejection, and restart continuity", async () => {
  const contentId = "linux-fresh-install-content";
  const visibleText = "fresh-install-visible-marker";
  const clientIdentity = "1234abcd";
  const registrationIdentity = `${clientIdentity}${"a".repeat(56)}`;
  const directClientEndpoint = "ws://127.0.0.1:19001/ws";
  const registryEndpoint = "ws://127.0.0.1:19999/ws";
  const phase = (overrides = {}) => ({
    capture: { contentId, paneId: 1, requestSurfaceId: "sf_fresh", responseSurfaceId: null, visibleText },
    clientIdentity,
    clientAppVersion: TIGHTBEAM.version,
    clientAppVersionEvidenceSha256: "d".repeat(64),
    commandRoute: "direct-client-websocket",
    controllerIdentity: "ctl_fresh",
    currentRead: {
      cacheStatus: "current",
      consumableLoss: null,
      content: {
        recordClass: "content",
        payload: {
          contentId,
          historyEntryId: "he_fresh_install_1",
          paneId: 1,
          revision: 1,
          surfaceId: "sf_fresh",
        },
      },
      contentId,
      scopeId: "pane:sf_fresh:1",
    },
    databaseIdentity: "db_fresh",
    directClientEndpoint,
    paneId: 1,
    paneLabel: 1,
    registeredClientId: registrationIdentity,
    registeredPaneIds: [1],
    registeredPaneLabel: 1,
    registeredSurfaceId: "sf_fresh",
    registeredWindowLabel: "a",
    registrationIdentity,
    registryEndpoint,
    sourceCommit: TIGHTBEAM.candidateCommit,
    surfaceId: "sf_fresh",
    windowLabel: "a",
    ...overrides,
  });
  const projection = "b".repeat(64);
  const evidence = {
    mode: "fresh-install",
    sourceCommit: TIGHTBEAM.candidateCommit,
    displayReady: { display: ":99", probeSha256: "a".repeat(64), status: "verified", tool: "xdpyinfo" },
    expectedContentId: contentId,
    expectedVisibleText: visibleText,
    expectedVersion: TIGHTBEAM.version,
    initial: phase(),
    afterRestart: phase(),
    wrongSurfaceRejection: {
      directClientEndpoint,
      expectedSurfaceId: "sf_fresh",
      requestedSurfaceId: "sf_wrong",
      status: "rejected",
      errorCode: "unknown_surface",
    },
    postgresRestart: {
      status: "verified",
      databaseIdentity: "db_fresh",
      projectionBeforeSha256: projection,
      projectionAfterSha256: projection,
      registryShutdown: {
        activeProjectionSha256: "c".repeat(64),
        releasedProjectionSha256: projection,
        continuity: {
          appendedRevisionHeads: 1,
          custodyRevisionDelta: 1,
          journalHeadUnchanged: true,
          leaseGenerationDelta: 1,
          ok: true,
          phase: "released",
          semanticProjectionUnchanged: true,
        },
      },
      witnessSynchronized: true,
      registryHealth: { event: "health", status: "healthy", transport: "websocket-open" },
      registryShutdownClean: true,
      initialRegistryHealth: { event: "health", status: "healthy", transport: "websocket-open" },
      schema: { has_fleets: true, has_journal: true, has_read_state: true, has_journal_validator: true },
      lifecycle: {
        primary: { stopExitCode: 0, startExitCode: 0, pidBefore: 100, pidAfter: 101, stopStdout: "stopped", startStdout: "started" },
        witness: { stopExitCode: 0, startExitCode: 0, pidBefore: 200, pidAfter: 201, stopStdout: "stopped", startStdout: "started" },
      },
    },
    cleanup: { clientStopped: true, registryStopped: true, postgresStopped: true },
  };

  const validated = validateTightbeamFreshInstallState(evidence);
  assert.equal(validated.status, "passed");
  assert.equal(validated.clientAppVersion, TIGHTBEAM.version);
  assert.equal(validated.clientAppVersionEvidenceSha256, "d".repeat(64));
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    postgresRestart: { ...evidence.postgresRestart, registryShutdown: undefined },
  }), /fresh_install_registry_shutdown_projection_not_verified/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    initial: phase({ currentRead: { ...phase().currentRead, contentId: "other" } }),
  }), /fresh_install_initial_content_read_mismatch/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    initial: phase({ currentRead: {
      ...phase().currentRead,
      content: {
        ...phase().currentRead.content,
        payload: { ...phase().currentRead.content.payload, surfaceId: "sf_wrong" },
      },
    } }),
  }), /fresh_install_initial_content_read_mismatch/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    initial: phase({ capture: { ...phase().capture, responseSurfaceId: "sf_wrong" } }),
  }), /fresh_install_initial_rendered_capture_mismatch/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    afterRestart: phase({ clientAppVersion: "0.1.0" }),
  }), /fresh_install_after_restart_client_release_identity_mismatch/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    wrongSurfaceRejection: { ...evidence.wrongSurfaceRejection, status: "accepted" },
  }), /fresh_install_wrong_surface_not_rejected/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    afterRestart: phase({
      clientIdentity: "deadbeef",
      registrationIdentity: `deadbeef${"c".repeat(56)}`,
      registeredClientId: `deadbeef${"c".repeat(56)}`,
    }),
  }), /fresh_install_client_identity_changed/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    postgresRestart: { ...evidence.postgresRestart, projectionAfterSha256: "c".repeat(64) },
  }), /fresh_install_postgres_restart_changed_projection/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    postgresRestart: {
      ...evidence.postgresRestart,
      registryShutdown: { ...evidence.postgresRestart.registryShutdown, releasedProjectionSha256: "d".repeat(64) },
    },
  }), /fresh_install_registry_shutdown_projection_not_verified/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    postgresRestart: {
      ...evidence.postgresRestart,
      registryShutdown: {
        ...evidence.postgresRestart.registryShutdown,
        continuity: { ...evidence.postgresRestart.registryShutdown.continuity, semanticProjectionUnchanged: false },
      },
    },
  }), /fresh_install_registry_shutdown_projection_not_verified/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    cleanup: { ...evidence.cleanup, postgresStopped: false },
  }), /fresh_install_owned_process_cleanup_unverified/);
  assert.throws(() => validateTightbeamFreshInstallState({
    ...evidence,
    afterRestart: phase({ directClientEndpoint: "ws://127.0.0.1:19002/ws" }),
  }), /fresh_install_endpoint_changed_after_restart/);
});

test("fresh-install wrong-surface probe omits fixture metadata from the packaged CLI request", async () => {
  const fixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  const start = fixture.indexOf("async function rejectedWrongSurfacePush(");
  const end = fixture.indexOf("\nfunction summarizeFreshInstallPhase", start);
  assert.ok(start >= 0 && end > start);
  const helper = fixture.slice(start, end);
  assert.match(helper, /const \{ expectedSurfaceId, \.\.\.request \} = input;/);
  assert.match(helper, /const inputJson = JSON\.stringify\(request\);/);
  assert.match(helper, /unknown_surface:\$\{request\.surfaceId\}/);
  assert.match(helper, /input: request/);
  assert.doesNotMatch(helper, /JSON\.stringify\(input\)/);
  const returnedSummary = helper.slice(helper.lastIndexOf("  return {"));
  assert.match(returnedSummary, /request,/,
    "the smoke summary must use the request field consumed by the independent validator");
  assert.doesNotMatch(returnedSummary, /input: request/);
});

test("Linux fresh-install acceptance is based on direct current-content evidence", () => {
  const phase = (contentId = "linux-fresh-install-content") => ({
    capture: { contentId, paneId: 1, requestSurfaceId: "sf_fresh", responseSurfaceId: null, visibleText: "fresh-install-visible-marker" },
    clientIdentity: "1234abcd",
    clientAppVersion: TIGHTBEAM.version,
    clientAppVersionEvidenceSha256: "d".repeat(64),
    commandRoute: "direct-client-websocket",
    controllerIdentity: "ctl_fresh",
    currentRead: {
      cacheStatus: "current",
      consumableLoss: null,
      content: { recordClass: "content", payload: { contentId, historyEntryId: "he_fresh", paneId: 1, revision: 1, surfaceId: "sf_fresh" } },
      contentId,
      scopeId: "pane:sf_fresh:1",
    },
    databaseIdentity: "db_fresh",
    directClientEndpoint: "ws://127.0.0.1:19001/ws",
    paneId: 1,
    paneLabel: 1,
    registeredClientId: `1234abcd${"a".repeat(56)}`,
    registeredPaneIds: [1],
    registeredPaneLabel: 1,
    registeredSurfaceId: "sf_fresh",
    registeredWindowLabel: "a",
    registrationIdentity: `1234abcd${"a".repeat(56)}`,
    registryEndpoint: "ws://127.0.0.1:19999/ws",
    sourceCommit: TIGHTBEAM.candidateCommit,
    surfaceId: "sf_fresh",
    windowLabel: "a",
  });
  const projection = "b".repeat(64);
  const contentId = "linux-fresh-install-content";
  const state = {
    mode: "fresh-install",
    sourceCommit: TIGHTBEAM.candidateCommit,
    displayReady: { display: ":99", probeSha256: "a".repeat(64), status: "verified", tool: "xdpyinfo" },
    expectedContentId: contentId,
    expectedVisibleText: "fresh-install-visible-marker",
    expectedVersion: TIGHTBEAM.version,
    initial: phase(contentId),
    afterRestart: phase(contentId),
    wrongSurfaceRejection: {
      directClientEndpoint: "ws://127.0.0.1:19001/ws",
      expectedSurfaceId: "sf_fresh",
      requestedSurfaceId: "sf_wrong",
      status: "rejected",
      errorCode: "unknown_surface",
    },
    postgresRestart: {
      status: "verified",
      databaseIdentity: "db_fresh",
      projectionBeforeSha256: projection,
      projectionAfterSha256: projection,
      registryShutdown: {
        activeProjectionSha256: "c".repeat(64),
        releasedProjectionSha256: projection,
        continuity: {
          appendedRevisionHeads: 1,
          custodyRevisionDelta: 1,
          journalHeadUnchanged: true,
          leaseGenerationDelta: 1,
          ok: true,
          phase: "released",
          semanticProjectionUnchanged: true,
        },
      },
      witnessSynchronized: true,
      registryHealth: { event: "health", status: "healthy", transport: "websocket-open" },
      registryShutdownClean: true,
      initialRegistryHealth: { event: "health", status: "healthy", transport: "websocket-open" },
      schema: { has_fleets: true, has_journal: true, has_read_state: true, has_journal_validator: true },
      lifecycle: {
        primary: { stopExitCode: 0, startExitCode: 0, pidBefore: 100, pidAfter: 101, stopStdout: "stopped", startStdout: "started" },
        witness: { stopExitCode: 0, startExitCode: 0, pidBefore: 200, pidAfter: 201, stopStdout: "stopped", startStdout: "started" },
      },
    },
    cleanup: { clientStopped: true, registryStopped: true, postgresStopped: true },
  };
  assert.equal(validateTightbeamFreshInstallState(state).status, "passed");
});

test("Linux fresh-install state driver binds candidate-only inputs and packaged CLI evidence", async (t) => {
  const root = await temporary(t);
  const output = path.join(root, "fresh-install-state.json");
  const stateRoot = path.join(root, "state");
  const driver = path.join(root, "tightbeam-state-smoke-fixture.ts");
  const productSourceDir = path.join(root, "product");
  const tsxLoader = path.join(productSourceDir, "packages/allocator/node_modules/tsx/dist/loader.mjs");
  await fs.mkdir(path.dirname(tsxLoader), { recursive: true });
  await fs.writeFile(tsxLoader, "export {};\n");
  const initialEndpoint = "ws://127.0.0.1:19001/ws";
  const contentId = "linux-fresh-install-content";
  const visibleText = "fresh-install-visible-marker";
  const clientIdentity = "1234abcd";
  const registrationIdentity = `${clientIdentity}${"a".repeat(56)}`;
  const phase = (endpoint) => ({
    capture: { contentId, paneId: 1, requestSurfaceId: "sf_fresh", responseSurfaceId: null, visibleText },
    clientIdentity,
    clientAppVersion: TIGHTBEAM.version,
    clientAppVersionEvidenceSha256: "d".repeat(64),
    commandRoute: "direct-client-websocket",
    controllerIdentity: "ctl_fresh",
    currentRead: {
      cacheStatus: "current",
      consumableLoss: null,
      content: {
        recordClass: "content",
        payload: {
          contentId,
          historyEntryId: "he_fresh_install_1",
          paneId: 1,
          revision: 1,
          surfaceId: "sf_fresh",
        },
      },
      contentId,
      scopeId: "pane:sf_fresh:1",
    },
    databaseIdentity: "db_fresh",
    directClientEndpoint: endpoint,
    paneId: 1,
    paneLabel: 1,
    registeredClientId: registrationIdentity,
    registeredPaneIds: [1],
    registeredPaneLabel: 1,
    registeredSurfaceId: "sf_fresh",
    registeredWindowLabel: "a",
    registrationIdentity,
    registryEndpoint: "ws://127.0.0.1:19999/ws",
    sourceCommit: TIGHTBEAM.candidateCommit,
    surfaceId: "sf_fresh",
    windowLabel: "a",
  });
  const stateSequence = {
    mode: "fresh-install",
    sourceCommit: TIGHTBEAM.candidateCommit,
    expectedVersion: TIGHTBEAM.version,
    displayReady: { display: ":99", probeSha256: "a".repeat(64), status: "verified", tool: "xdpyinfo" },
    expectedContentId: contentId,
    expectedVisibleText: visibleText,
    initial: phase(initialEndpoint),
    afterRestart: phase(initialEndpoint),
    wrongSurfaceRejection: {
      directClientEndpoint: initialEndpoint,
      endpoint: initialEndpoint,
      expectedSurfaceId: "sf_fresh",
      requestedSurfaceId: "sf_wrong",
      status: "rejected",
      errorCode: "unknown_surface",
      request: { surfaceId: "sf_wrong" },
      rawOutput: "unknown_surface:sf_wrong",
    },
    postgresRestart: {
      status: "verified",
      databaseIdentity: "db_fresh",
      projectionBeforeSha256: "b".repeat(64),
      projectionAfterSha256: "b".repeat(64),
      registryShutdown: {
        activeProjectionSha256: "c".repeat(64),
        releasedProjectionSha256: "b".repeat(64),
        continuity: {
          appendedRevisionHeads: 1,
          custodyRevisionDelta: 1,
          journalHeadUnchanged: true,
          leaseGenerationDelta: 1,
          ok: true,
          phase: "released",
          semanticProjectionUnchanged: true,
        },
      },
      witnessSynchronized: true,
      registryHealth: { event: "health", status: "healthy", transport: "websocket-open" },
      registryShutdownClean: true,
      initialRegistryHealth: { event: "health", status: "healthy", transport: "websocket-open" },
      schema: { has_fleets: true, has_journal: true, has_read_state: true, has_journal_validator: true },
      lifecycle: {
        primary: { stopExitCode: 0, startExitCode: 0, pidBefore: 100, pidAfter: 101, stopStdout: "stopped", startStdout: "started" },
        witness: { stopExitCode: 0, startExitCode: 0, pidBefore: 200, pidAfter: 201, stopStdout: "stopped", startStdout: "started" },
      },
    },
    cleanup: { clientStopped: true, registryStopped: true, postgresStopped: true },
  };
  const events = [];
  const record = (command, input, endpoint, response = {}) => {
    const inputJson = JSON.stringify(input);
    const args = ["--state-root", path.join(stateRoot, "cli")];
    if (endpoint) args.push("--endpoint", endpoint, "--product-label", "Surf Ace release smoke");
    args.push(command, "--input-json", inputJson);
    const output = { command, controllerInstanceId: "ctl_fresh", ok: true, result: { ok: true, ...response } };
    const stdout = JSON.stringify(output);
    events.push({ args, command, endpoint: endpoint ?? null, input, inputJson,
      route: endpoint ? "direct-client-websocket" : "endpointless-local-read", status: 0,
      stderr: "", output, stdout });
  };
  const listed = { surfaces: [{ surfaceId: "sf_fresh", topology: { panes: [{ paneId: 1 }] } }] };
  const capture = { contentId, paneId: 1, surfaceId: null, visibleText };
  const read = {
    cacheStatus: "current",
    consumableLoss: null,
    currentContentRecord: {
      recordClass: "content",
      payload: {
        contentId,
        historyEntryId: "he_fresh_install_1",
        paneId: 1,
        revision: 1,
        surfaceId: "sf_fresh",
      },
    },
    scopeId: "pane:sf_fresh:1",
  };
  record("list", {}, initialEndpoint, listed);
  record("push", { content: { html: `<main>${visibleText}</main>` }, contentId, paneId: 1, surfaceId: "sf_fresh" }, initialEndpoint);
  record("capture-pane", { includeImage: true, paneId: 1, surfaceId: "sf_fresh" }, initialEndpoint, capture);
  record("read", { scopeId: "pane:sf_fresh:1" }, null, read);
  events.push({
    args: ["--state-root", path.join(stateRoot, "cli"), "--endpoint", initialEndpoint,
      "--product-label", "Surf Ace release smoke", "push", "--input-json",
      JSON.stringify({ contentId: `${contentId}-wrong-surface`, paneId: 1, surfaceId: "sf_wrong" })],
    command: "push",
    endpoint: initialEndpoint,
    expectedRejection: { code: "unknown_surface", expectedSurfaceId: "sf_fresh", requestedSurfaceId: "sf_wrong" },
    input: { contentId: `${contentId}-wrong-surface`, paneId: 1, surfaceId: "sf_wrong" },
    inputJson: JSON.stringify({ contentId: `${contentId}-wrong-surface`, paneId: 1, surfaceId: "sf_wrong" }),
    route: "direct-client-websocket", status: 1, stderr: "", stdout: "unknown_surface:sf_wrong",
  });
  record("capture-pane", { includeImage: true, paneId: 1, surfaceId: "sf_fresh" }, initialEndpoint, capture);
  record("read", { scopeId: "pane:sf_fresh:1" }, null, read);
  record("list", {}, initialEndpoint, listed);
  record("capture-pane", { includeImage: true, paneId: 1, surfaceId: "sf_fresh" }, initialEndpoint, capture);
  record("read", { scopeId: "pane:sf_fresh:1" }, null, read);
  const bytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  Object.assign(stateSequence, {
    rawCliEvidenceBase64: bytes.toString("base64"),
    rawCliEvidenceBytes: bytes.byteLength,
    rawCliEvidenceSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  let calls = 0;
  const options = {
    candidateCommit: TIGHTBEAM.candidateCommit,
    candidateElectron: path.join(root, "candidate-electron/Surf Ace/surf-ace"),
    candidateRoot: path.join(root, "candidate"),
    cliBinary: path.join(root, "cli/bin/surf-ace"),
    driver,
    output,
    productSourceDir,
    stateRoot,
  };
  const result = await runLinuxFreshInstallStateDriver(options, async (command, args, invocationOptions) => {
    calls += 1;
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [
      "--import", tsxLoader,
      driver,
      "--mode", "fresh-install",
      "--candidate-commit", options.candidateCommit,
      "--expected-version", TIGHTBEAM.version,
      "--candidate-electron", options.candidateElectron,
      "--candidate-root", options.candidateRoot,
      "--cli-binary", options.cliBinary,
      "--product-source", options.productSourceDir,
      "--output", options.output,
      "--state-root", options.stateRoot,
    ]);
    assert.equal(invocationOptions.env.SURF_ACE_CLIENT_DIAGNOSTIC_LOG, path.join(stateRoot, "client-flight-recorder.log"));
    assert.equal(args.includes("--baseline-commit"), false);
    await fs.writeFile(output, JSON.stringify(stateSequence));
  });
  assert.equal(calls, 1);
  assert.equal(result.mode, "fresh-install");
  assert.equal(result.status, "passed");
  assert.equal(result.rawCliEvidence.events.length, 10);
  assert.equal(result.rawCliEvidence.events.at(-1).command, "read");
  const unacceptedPushEvents = events.map((event, index) => index === 1
    ? { ...event, output: { ...event.output, ok: false }, stdout: JSON.stringify({ ...event.output, ok: false }) }
    : event);
  const unacceptedPushBytes = Buffer.from(`${unacceptedPushEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const unacceptedPushSequence = {
    ...stateSequence,
    rawCliEvidenceBase64: unacceptedPushBytes.toString("base64"),
    rawCliEvidenceBytes: unacceptedPushBytes.byteLength,
    rawCliEvidenceSha256: createHash("sha256").update(unacceptedPushBytes).digest("hex"),
  };
  await assert.rejects(runLinuxFreshInstallStateDriver(options, async () => {
    await fs.writeFile(output, JSON.stringify(unacceptedPushSequence));
  }), /linux_fresh_install_raw_cli_stdout_result_mismatch/);
  const invalidEvents = [...events.map((event) => ({ ...event }))];
  invalidEvents[4] = {
    ...invalidEvents[4],
    expectedRejection: { ...invalidEvents[4].expectedRejection, code: "accepted" },
  };
  const invalidRawBytes = Buffer.from(`${invalidEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const invalidSequence = {
    ...stateSequence,
    rawCliEvidenceBase64: invalidRawBytes.toString("base64"),
    rawCliEvidenceBytes: invalidRawBytes.byteLength,
    rawCliEvidenceSha256: createHash("sha256").update(invalidRawBytes).digest("hex"),
  };
  await assert.rejects(runLinuxFreshInstallStateDriver(options, async () => {
    await fs.writeFile(output, JSON.stringify(invalidSequence));
  }), /linux_fresh_install_raw_cli_unexpected_nonzero_result/);
  const wrongCurrentRecordEvents = events.map((event) => {
    if (event.command !== "read") return event;
    const outputWithWrongTarget = {
      ...event.output,
      result: {
        ...event.output.result,
        currentContentRecord: {
          ...event.output.result.currentContentRecord,
          payload: { ...event.output.result.currentContentRecord.payload, surfaceId: "sf_wrong" },
        },
      },
    };
    return { ...event, output: outputWithWrongTarget, stdout: JSON.stringify(outputWithWrongTarget) };
  });
  const wrongCurrentRecordBytes = Buffer.from(`${wrongCurrentRecordEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const wrongCurrentRecordSequence = {
    ...stateSequence,
    rawCliEvidenceBase64: wrongCurrentRecordBytes.toString("base64"),
    rawCliEvidenceBytes: wrongCurrentRecordBytes.byteLength,
    rawCliEvidenceSha256: createHash("sha256").update(wrongCurrentRecordBytes).digest("hex"),
  };
  await assert.rejects(runLinuxFreshInstallStateDriver(options, async () => {
    await fs.writeFile(output, JSON.stringify(wrongCurrentRecordSequence));
  }), /linux_fresh_install_current_content_read_evidence_missing/);
  const wrongCaptureSurfaceEvents = events.map((event) => {
    if (event.command !== "capture-pane") return event;
    const outputWithWrongTarget = {
      ...event.output,
      result: { ...event.output.result, surfaceId: "sf_wrong" },
    };
    return { ...event, output: outputWithWrongTarget, stdout: JSON.stringify(outputWithWrongTarget) };
  });
  const wrongCaptureSurfaceBytes = Buffer.from(`${wrongCaptureSurfaceEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const wrongCaptureSurfaceSequence = {
    ...stateSequence,
    rawCliEvidenceBase64: wrongCaptureSurfaceBytes.toString("base64"),
    rawCliEvidenceBytes: wrongCaptureSurfaceBytes.byteLength,
    rawCliEvidenceSha256: createHash("sha256").update(wrongCaptureSurfaceBytes).digest("hex"),
  };
  await assert.rejects(runLinuxFreshInstallStateDriver(options, async () => {
    await fs.writeFile(output, JSON.stringify(wrongCaptureSurfaceSequence));
  }), /linux_fresh_install_direct_capture_target_mismatch/);
  await assert.rejects(runLinuxFreshInstallStateDriver(options, async () => {
    await fs.writeFile(output, JSON.stringify({ ...stateSequence, rawCliEvidenceSha256: "c".repeat(64) }));
  }), /raw_cli_evidence_digest_mismatch/);
});

test("Linux smoke reports the persisted state-driver failure and subprocess diagnostics", async (t) => {
  const root = await temporary(t);
  const output = path.join(root, "fresh-install-state.json");
  const productSourceDir = path.join(root, "product");
  const tsxLoader = path.join(productSourceDir, "packages/allocator/node_modules/tsx/dist/loader.mjs");
  await fs.mkdir(path.dirname(tsxLoader), { recursive: true });
  await fs.writeFile(tsxLoader, "export {};\n");
  const options = {
    candidateCommit: TIGHTBEAM.candidateCommit,
    candidateElectron: path.join(root, "candidate-electron/Surf Ace/surf-ace"),
    candidateRoot: path.join(root, "candidate"),
    cliBinary: path.join(root, "cli/bin/surf-ace"),
    driver: path.join(root, "tightbeam-state-smoke-fixture.ts"),
    output,
    productSourceDir,
    stateRoot: path.join(root, "state"),
  };
  const processError = Object.assign(new Error("state driver exited nonzero"), {
    code: 1,
    stderr: "client launch failed: ECONNREFUSED 127.0.0.1:19001 password=hunter2",
    stdout: "",
  });

  await assert.rejects(runLinuxFreshInstallStateDriver(options, async () => {
    await fs.mkdir(options.stateRoot, { recursive: true });
    await fs.writeFile(path.join(options.stateRoot, "client-flight-recorder.log"), [
      "[surf-ace:app] event=app_launch app_version=0.2.0 platform=linux",
      "[surf-ace:app] event=window_created error_message=ECONNREFUSED",
    ].join("\n"));
    await fs.writeFile(output, JSON.stringify({
      error: "fresh-install-direct-client-endpoint-timeout:last=ECONNREFUSED",
      mode: "fresh-install",
      sourceCommit: TIGHTBEAM.candidateCommit,
      status: "failed",
    }));
    throw processError;
  }), (error) => {
    const jobLog = formatSmokeFailure(error);
    assert.match(jobLog, /fresh-install-direct-client-endpoint-timeout:last=ECONNREFUSED/);
    assert.match(jobLog, /ECONNREFUSED 127\.0\.0\.1:19001/);
    assert.match(jobLog, /client_flight_recorder_tail:/);
    assert.match(jobLog, /event=window_created error_message=ECONNREFUSED/);
    assert.match(jobLog, /exit_code: 1/);
    assert.match(jobLog, /stderr:/);
    assert.match(jobLog, /password=\[REDACTED\]/);
    assert.doesNotMatch(jobLog, /hunter2/);
    return true;
  });
});

test("smoke CLI writes caught failures to stderr for the hosted job log", async () => {
  const smokeScript = path.join(repository, "scripts/release/smoke-tightbeam-release.mjs");
  await assert.rejects(exec(process.execPath, [smokeScript, "--invalid", "value"]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /tightbeam_release_smoke_failed/);
    assert.match(error.stderr, /unknown_argument:--invalid/);
    return true;
  });
});

test("Tightbeam Linux smoke fixture binds adapter dependencies to the exact product checkout", async () => {
  const fixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  const smoke = await fs.readFile(path.join(repository, "scripts/release/smoke-tightbeam-release.mjs"), "utf8");
  assert.match(fixture, /createRequire\(allocatorPackage\)/);
  assert.match(fixture, /packages\/allocator\/src\/custody\.ts/);
  assert.match(fixture, /packages\/protocol\/src\/lockless\.ts/);
  assert.match(fixture, /allocatorRequire\("pg"\)/);
  assert.match(fixture, /allocatorRequire\("ws"\)/);
  assert.match(smoke, /packages\/allocator\/node_modules\/tsx\/dist\/loader\.mjs/);
  assert.doesNotMatch(fixture, /^import\s+(?:pg|WebSocket)\s+from\s+["'](?:pg|ws)["']/m);
});

test("task-local PostgreSQL smoke uses disk-backed dynamic shared memory", async () => {
  const fixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  assert.match(fixture, /const primaryData = path\.join\(root, "primary"\)/);
  assert.match(fixture, /dynamic_shared_memory_type = 'mmap'/);
});

test("Linux smoke fixture starts through the product TSX loader and rejects retired phase inputs", async () => {
  const fixture = path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts");
  const loader = path.join(repository, "packages/allocator/node_modules/tsx/dist/loader.mjs");
  await fs.access(loader);
  await assert.rejects(exec(process.execPath, ["--import", loader, fixture, "--mode", "transition"]), (error) => {
    assert.match(error.stderr, /old_version_smoke_mode_forbidden/);
    assert.doesNotMatch(error.stderr, /Top-level await is currently not supported/);
    return true;
  });
  await assert.rejects(exec(process.execPath, ["--import", loader, fixture, "--baseline-commit", "cf91ef1baab26d6045fac5300487c29d0ddf332d"]), (error) => {
    assert.match(error.stderr, /old_version_smoke_inputs_forbidden/);
    assert.doesNotMatch(error.stderr, /Top-level await is currently not supported/);
    return true;
  });
});


test("standalone specification and release gates bind the fixed product and public assets", async () => {
  const specification = await fs.readFile(path.join(repository, "docs/release/tightbeam-standalone-v0.2.0.md"), "utf8");
  const workflowPath = path.join(repository, ".github/workflows/release-tightbeam.yml");
  const workflow = await fs.readFile(workflowPath, "utf8");
  assert.match(specification, /Product source: tag/);
  assert.match(specification, /0c181cc512816ee3e03a0284fdcea9a70a175019/);
  assert.match(specification, /No old baseline is built or launched/);
  assert.match(specification, /surf-ace-release-tooling-tightbeam-v0\.2\.0/);
  for (const name of TIGHTBEAM_PUBLIC_FILES) assert.ok(specification.includes(name));
  assert.match(specification, /custom-format backup/);
  assert.match(specification, /restore into (?:an isolated|a separate) staged cluster/);
  assert.match(specification, /packaged CLI connects\s+directly to the named client's own/);
  assert.match(specification, /Publication is separately opt-in/);
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  await exec("ruby", ["-e", "require \"yaml\"; YAML.load_file(ARGV.fetch(0))", workflowPath]);
  for (const match of workflow.matchAll(/^\s*uses:\s*([^\s]+)$/gm)) assert.match(match[1], /@[0-9a-f]{40}$/);
  assert.match(workflow, /run_smoke:[\s\S]*?default: false/);
  assert.match(workflow, /publish_release:[\s\S]*?default: false/);
  assert.match(workflow, /PRODUCT_COMMIT: 0c181cc512816ee3e03a0284fdcea9a70a175019/);
  assert.match(workflow, /PRODUCT_TAG: surf-ace-tightbeam-v0\.2\.0/);
  assert.match(workflow, /TOOLING_TAG: surf-ace-release-tooling-tightbeam-v0\.2\.0/);
  assert.match(workflow, /GITHUB_EVENT_NAME/);
  assert.match(workflow, /GITHUB_REF_TYPE/);
  assert.match(workflow, /node tooling\/scripts\/release\/build-tightbeam-release\.mjs/);
  assert.doesNotMatch(workflow, /build-ios|tightbeam-ios-ipa|xcodebuild archive|-exportArchive|\.ipa\b|IOS_CERTIFICATE|IOS_PROVISIONING_PROFILE|tightbeam-ios-signing/);
  const linuxStart = workflow.indexOf("  build-linux:\n");
  const macosStart = workflow.indexOf("  build-macos:\n", linuxStart);
  const linuxJob = workflow.slice(linuxStart, macosStart);
  assert.match(linuxJob, /^    defaults:\n      run:\n        shell: bash$/m);
  const linuxTests = workflowRunScript(workflow, "Install frozen dependencies and run Linux product tests");
  const linuxBuildOrder = [
    "pnpm --dir source --filter @surf-ace/protocol build",
    "pnpm --dir source --filter @surf-ace/allocator build",
    "pnpm --dir source --filter @surf-ace/controller build",
    "pnpm --dir source --filter @surf-ace/controller test",
  ].map((command) => linuxTests.indexOf(command));
  assert.ok(linuxBuildOrder.every((index) => index >= 0));
  assert.deepEqual([...linuxBuildOrder].sort((left, right) => left - right), linuxBuildOrder);
  const linuxSmoke = workflowRunScript(workflow, "Run PostgreSQL-backed server, packaged CLI, and Linux client acceptance");
  assert.match(linuxSmoke, /smoke_tmp="\$\(mktemp -d \/tmp\/sa\.XXXXXX\)"/);
  assert.match(linuxSmoke, /trap 'rm -rf "\$smoke_tmp"' EXIT/);
  assert.match(linuxSmoke, /TMPDIR="\$smoke_tmp" xvfb-run -a node tooling\/scripts\/release\/smoke-tightbeam-release\.mjs/);
  const macosTests = workflowRunScript(workflow, "Install frozen dependencies and run macOS/iPadOS tests");
  const macosBuildOrder = [
    "pnpm --dir source --filter @surf-ace/protocol build",
    "pnpm --dir source --filter @surf-ace/allocator build",
    "pnpm --dir source --filter @surf-ace/controller build",
    "pnpm --dir source --filter @surf-ace/electron build",
    "pnpm --dir source --filter @surf-ace/controller test",
    "pnpm --dir source --filter @surf-ace/protocol test",
    "pnpm --dir source --filter @surf-ace/electron test",
  ].map((command) => macosTests.indexOf(command));
  assert.ok(macosBuildOrder.every((index) => index >= 0));
  assert.deepEqual([...macosBuildOrder].sort((left, right) => left - right), macosBuildOrder);
  const macosSmokeDependencies = workflowRunScript(workflow, "Install packaged Electron inspection dependencies");
  assert.match(macosSmokeDependencies, /corepack prepare "pnpm@\$\{PNPM_VERSION\}" --activate/);
  assert.match(macosSmokeDependencies, /pnpm --dir source fetch --frozen-lockfile/);
  assert.match(macosSmokeDependencies, /pnpm --dir source install --offline --frozen-lockfile/);
  const macosSmokeDependencyOffset = workflow.indexOf("      - name: Install packaged Electron inspection dependencies\n");
  const macosSmokeRunOffset = workflow.indexOf("      - name: Run the matching macOS candidate client and CLI smoke\n");
  assert.ok(macosSmokeRunOffset > macosSmokeDependencyOffset,
    "macOS smoke must install source package-inspection dependencies before launching the packaged app");
  assert.ok(workflow.includes("xcodebuild test"), "hosted iPad simulator tests remain distinct from IPA distribution signing");
  assert.match(workflow, /name: tightbeam-linux-build-a/);
  assert.match(workflow, /name: tightbeam-linux-build-b/);
  assert.match(workflow, /name: tightbeam-macos-build-a/);
  assert.match(workflow, /name: tightbeam-macos-build-b/);
  assert.match(workflow, /subject-path: release\/\.receipts\/linux-smoke-receipt\.json/);
  assert.match(workflow, /subject-path: release\/\.receipts\/macos-smoke-receipt\.json/);
  const compareStart = workflow.indexOf("  compare:\n");
  const assembleStart = workflow.indexOf("  assemble:\n", compareStart);
  const compareJob = workflow.slice(compareStart, assembleStart);
  for (const name of TIGHTBEAM.assets.slice(0, 5)) assert.ok(compareJob.includes(name));
  assert.match(workflow, /needs: \[assemble, smoke-linux, smoke-macos\]/);
  for (const command of [
    "cargo build --manifest-path source/packages/cli/Cargo.toml",
    "pnpm --dir source --filter @surf-ace/protocol build",
    "pnpm --dir source --filter @surf-ace/controller build",
    "pnpm --dir source --filter @surf-ace/electron exec electron-builder",
  ]) assert.ok(TIGHTBEAM_BUILD_COMMANDS.some((item) => item.startsWith(command)));
  assert.doesNotMatch(TIGHTBEAM_BUILD_COMMANDS.join("\n"), /xcodebuild archive|-exportArchive|\.ipa\b/);
  assert.ok(TIGHTBEAM_TEST_COMMANDS.includes("cargo test --manifest-path source/packages/cli/Cargo.toml --locked"));
  assert.ok(TIGHTBEAM_TEST_COMMANDS.some((command) => command.startsWith("xcodebuild test ")));
});

test("v0.2.0 release smoke gates bind only matching candidate participants", async () => {
  const workflow = await fs.readFile(path.join(repository, ".github/workflows/release-tightbeam.yml"), "utf8");
  const smoke = await fs.readFile(path.join(repository, "scripts/release/smoke-tightbeam-release.mjs"), "utf8");
  const fixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  const specification = await fs.readFile(path.join(repository, "docs/release/tightbeam-standalone-v0.2.0.md"), "utf8");

  assert.equal(Object.hasOwn(TIGHTBEAM, "baselineCommit"), false);
  for (const input of [workflow, smoke]) assert.doesNotMatch(input, /cf91ef1baab26d6045fac5300487c29d0ddf332d/);
  assert.doesNotMatch(workflow, /build-smoke-baseline|BASELINE_(?:BACKEND|ELECTRON)|baseline-(?:commit|electron|root)/i);
  assert.doesNotMatch(smoke, /SURF_ACE_TIGHTBEAM_BASELINE|function smokeLinux\(|runLinuxStateDriver|validateTightbeamStateSequence/);
  assert.match(workflow, /--candidate-commit 0c181cc512816ee3e03a0284fdcea9a70a175019/);
  assert.match(smoke, /validateTightbeamFreshInstallState/);
  assert.match(fixture, /mode: "fresh-install"/);
  assert.doesNotMatch(fixture, /runPhase\("baseline"|runPhase\("candidate"|runPhase\("rollback"/);
  assert.match(specification, /Smoke is a separate opt-in, candidate-only v0\.2\.0 gate/);
  assert.match(specification, /Historical old-version results\s+remain archived/);
});
