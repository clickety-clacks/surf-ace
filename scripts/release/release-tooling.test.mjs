import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
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
import { cargoLockedPackages, lockedPackages, packagedProductionInventory } from "./lockfile-inventory.mjs";
import { verifySri } from "./verify-sri.mjs";
import { verifyOpenclawPackage } from "./verify-openclaw-package.mjs";
import * as openclawReleaseBuilder from "./build-openclaw-release.mjs";
import {
  assembleTightbeamLinuxStage,
  buildTightbeamRelease,
  TIGHTBEAM_LINUX_RUNTIME_FILES,
  verifyTightbeamLinuxStage,
} from "./build-tightbeam-release.mjs";
import { OPENCLAW, OPENCLAW_BUILD_COMMANDS, TIGHTBEAM, TOOLING_TAG } from "./release-config.mjs";
import { runLinuxStateDriver, validateTightbeamStateSequence } from "./smoke-tightbeam-release.mjs";
import { verifySmokeReceipt, writeSmokeReceipt } from "./write-smoke-receipt.mjs";

const exec = promisify(execFile);
const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { buildOpenclawRelease } = openclawReleaseBuilder;

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

async function workflowAtRevision(revision, relativePath) {
  return (await exec("git", ["show", `${revision}:${relativePath}`], { cwd: repository })).stdout;
}

async function runWorkflowGuard(t, script, overrides = {}) {
  const root = await temporary(t);
  const bin = path.join(root, "bin");
  const ghLog = path.join(root, "gh.log");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const [command, endpoint] = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify({ command, endpoint }) + "\\n");
if (command !== "api") process.exit(90);
if (endpoint.endsWith("/git/ref/tags/" + process.env.TOOLING_TAG)) {
  console.log("commit " + process.env.MOCK_TOOLING_REMOTE);
} else if (endpoint.endsWith("/git/ref/tags/" + process.env.PRODUCT_TAG)) {
  console.log("commit " + process.env.MOCK_PRODUCT_REMOTE);
} else if (endpoint.includes("/actions/runs/")) {
  console.log([
    process.env.MOCK_GATE4_EVENT,
    process.env.MOCK_GATE4_STATUS,
    process.env.MOCK_GATE4_CONCLUSION,
    process.env.MOCK_GATE4_HEAD_SHA,
    process.env.MOCK_GATE4_PATH,
  ].join("\\t"));
} else {
  process.exit(91);
}
`, { mode: 0o755 });
  await fs.writeFile(ghLog, "");

  const toolingCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const productCommit = "58ac8c435679e6611903d31abaecec11bb9d7f75";
  const toolingTag = "surf-ace-release-tooling-openclaw-v0.1.2";
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_LOG: ghLog,
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: "clickety-clacks/surf-ace",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF: `refs/tags/${toolingTag}`,
    GITHUB_SHA: toolingCommit,
    TOOLING_TAG: toolingTag,
    PRODUCT_TAG: "surf-ace-openclaw-v0.1.0",
    PRODUCT_COMMIT: productCommit,
    GATE4_RUN_ID: "123456",
    TRIGGER_REF: "refs/heads/release/run-tightbeam-v0.2.0",
    MOCK_TOOLING_REMOTE: toolingCommit,
    MOCK_PRODUCT_REMOTE: productCommit,
    MOCK_GATE4_EVENT: "workflow_dispatch",
    MOCK_GATE4_STATUS: "completed",
    MOCK_GATE4_CONCLUSION: "success",
    MOCK_GATE4_HEAD_SHA: toolingCommit,
    MOCK_GATE4_PATH: ".github/workflows/release-openclaw.yml",
    ...overrides,
  };
  try {
    const result = await exec("/bin/bash", ["-c", script], { cwd: root, env: environment });
    return { ...result, exitCode: 0, ghLog: await fs.readFile(ghLog, "utf8") };
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      ghLog: await fs.readFile(ghLog, "utf8"),
    };
  }
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
  assert.equal(requiredReleaseOutput("openclaw", "build/release/openclaw"), path.resolve("build/release/openclaw"));
  assert.throws(() => requiredReleaseOutput("openclaw", "/tmp/output"), /release_output_mismatch/);
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

test("OpenClaw deploy normalization removes only the exact diagnosed workspace self-link", async (t) => {
  const root = await temporary(t);
  const sourceDir = path.join(root, "build/source");
  const dependencyClosure = path.join(root, "build/release/openclaw/dependency-closure");
  const extensionDir = path.join(sourceDir, "packages/extension");
  const selfLink = path.join(dependencyClosure, "node_modules/.pnpm/node_modules/@surf-ace/extension");
  await fs.mkdir(extensionDir, { recursive: true });
  await fs.writeFile(path.join(extensionDir, "package.json"), '{"name":"@surf-ace/extension"}\n');
  await fs.mkdir(path.dirname(selfLink), { recursive: true });
  await fs.symlink(path.relative(path.dirname(selfLink), extensionDir), selfLink);

  await assert.rejects(
    createTarGz(dependencyClosure, path.join(root, "before.tgz"), 1_700_000_000),
    /path_escapes_root:\.\.\/\.\.\/\.\.\/source\/packages\/extension/,
  );

  const normalize = openclawReleaseBuilder.normalizeOpenclawDependencyClosure;
  assert.equal(typeof normalize, "function", "shipped builder must expose its deploy normalizer");
  await normalize(sourceDir, dependencyClosure);
  await assert.rejects(fs.lstat(selfLink), { code: "ENOENT" });
  await createTarGz(dependencyClosure, path.join(root, "after.tgz"), 1_700_000_000);

  const builder = await fs.readFile(path.join(repository, "scripts/release/build-openclaw-release.mjs"), "utf8");
  const deployOffset = builder.indexOf('"deploy", "--legacy", dependencyClosure');
  const normalizeOffset = builder.indexOf("await normalizeOpenclawDependencyClosure(sourceDir, dependencyClosure)");
  const assembleOffset = builder.indexOf("await assembleOpenclawPackage(sourceDir, dependencyClosure, packageRoot)");
  const archiveOffset = builder.indexOf("await createDirectoryTarGz(packageRoot");
  assert.ok(deployOffset >= 0 && deployOffset < normalizeOffset);
  assert.ok(normalizeOffset < assembleOffset && assembleOffset < archiveOffset);
});

test("OpenClaw deploy normalization rejects every non-exact self-link shape and preserves unrelated root escapes", async (t) => {
  const normalize = openclawReleaseBuilder.normalizeOpenclawDependencyClosure;
  assert.equal(typeof normalize, "function", "shipped builder must expose its deploy normalizer");

  const fixture = async (name, configure) => {
    const root = path.join(await temporary(t), name);
    const sourceDir = path.join(root, "build/source");
    const dependencyClosure = path.join(root, "build/release/openclaw/dependency-closure");
    const extensionDir = path.join(sourceDir, "packages/extension");
    const selfLink = path.join(dependencyClosure, "node_modules/.pnpm/node_modules/@surf-ace/extension");
    await fs.mkdir(extensionDir, { recursive: true });
    await fs.writeFile(path.join(extensionDir, "package.json"), '{"name":"@surf-ace/extension"}\n');
    await fs.mkdir(path.dirname(selfLink), { recursive: true });
    await configure({ dependencyClosure, extensionDir, root, selfLink, sourceDir });
    return { dependencyClosure, extensionDir, root, selfLink, sourceDir };
  };

  const missing = await fixture("missing", async () => {});
  await assert.rejects(normalize(missing.sourceDir, missing.dependencyClosure), /openclaw_deploy_self_link_missing/);

  const changed = await fixture("changed", async ({ selfLink }) => fs.symlink("../../../../../../../changed/packages/extension", selfLink));
  await assert.rejects(normalize(changed.sourceDir, changed.dependencyClosure), /openclaw_deploy_self_link_target_mismatch/);

  const sibling = await fixture("sibling", async ({ selfLink, sourceDir }) => {
    const siblingDir = path.join(sourceDir, "packages/controller");
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.symlink(path.relative(path.dirname(selfLink), siblingDir), selfLink);
  });
  await assert.rejects(normalize(sibling.sourceDir, sibling.dependencyClosure), /openclaw_deploy_self_link_target_mismatch/);

  const absolute = await fixture("absolute", async ({ extensionDir, selfLink }) => fs.symlink(extensionDir, selfLink));
  await assert.rejects(normalize(absolute.sourceDir, absolute.dependencyClosure), /openclaw_deploy_self_link_absolute/);

  const nonLink = await fixture("non-link", async ({ selfLink }) => fs.writeFile(selfLink, "not a link\n"));
  await assert.rejects(normalize(nonLink.sourceDir, nonLink.dependencyClosure), /openclaw_deploy_self_link_not_symlink/);

  const unrelated = await fixture("unrelated", async ({ dependencyClosure, extensionDir, selfLink }) => {
    await fs.symlink(path.relative(path.dirname(selfLink), extensionDir), selfLink);
    await fs.symlink("../../outside", path.join(dependencyClosure, "unrelated-escape"));
  });
  await normalize(unrelated.sourceDir, unrelated.dependencyClosure);
  await assert.rejects(
    createTarGz(unrelated.dependencyClosure, path.join(unrelated.root, "unrelated.tgz"), 1_700_000_000),
    /path_escapes_root/,
  );
});

test("OpenClaw Electron packaging is explicitly nonpublishing in ordinary and tag environments", async () => {
  const packageElectron = openclawReleaseBuilder.packageOpenclawElectron;
  assert.equal(typeof packageElectron, "function", "shipped builder must expose its Electron packaging step");

  for (const environment of [
    { PATH: process.env.PATH },
    {
      PATH: process.env.PATH,
      GITHUB_REF: "refs/tags/surf-ace-release-tooling-openclaw-v0.1.2",
      GITHUB_REF_NAME: "surf-ace-release-tooling-openclaw-v0.1.2",
      GITHUB_REF_TYPE: "tag",
    },
  ]) {
    const calls = [];
    await packageElectron("source", async (command, args, options) => {
      calls.push({ args, command, env: options.env });
    }, environment);
    assert.deepEqual(calls.map(({ args, command }) => ({ args, command })), [
      {
        command: "pnpm",
        args: ["--dir", "source", "--filter", "@surf-ace/electron", "build"],
      },
      {
        command: "pnpm",
        args: [
          "--dir", "source", "--filter", "@surf-ace/electron", "exec",
          "electron-builder", "--mac", "dir", "--arm64", "--publish", "never",
        ],
      },
    ]);
    const packagerArgs = calls[1].args;
    assert.equal(packagerArgs.filter((argument) => argument === "--publish").length, 1);
    assert.equal(packagerArgs.at(packagerArgs.indexOf("--publish") + 1), "never");
    assert.equal(calls.some(({ args, command }) => /(?:github|release|upload)/i.test([command, ...args].join(" "))), false);
  }

  assert.deepEqual(OPENCLAW_BUILD_COMMANDS.slice(-3), [
    "pnpm --dir source --filter @surf-ace/electron build",
    "pnpm --dir source --filter @surf-ace/electron exec electron-builder --mac dir --arm64 --publish never",
    "node tooling/scripts/release/verify-openclaw-package.mjs --package-dir build/release/openclaw/package-root --lockfile source/pnpm-lock.yaml",
  ]);
  const builder = await fs.readFile(path.join(repository, "scripts/release/build-openclaw-release.mjs"), "utf8");
  assert.match(builder, /await packageOpenclawElectron\(sourceArgument\)/);
  assert.doesNotMatch(builder, /"@surf-ace\/electron", "package"/);
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

test("OpenClaw package verification enforces runtime layout, tools, and the locked production closure", async (t) => {
  const root = await temporary(t);
  const packageDir = path.join(root, "package");
  const files = {
    "dist/extension/src/index.js": 'export { type OpenClawPluginApi } from "openclaw/plugin-sdk";\n',
    "dist/extension/src/openclaw-lockless-controller.js": "export {};\n",
    "dist/extension/src/surf-ace-tools.js": 'export const surfAceToolNames = ["surf_ace_list"];\n',
    "dist/protocol/schema.json": "{}\n",
    "dist/protocol/src/schemas.js": 'new URL("../schema.json", import.meta.url);\n',
    "dist/surf-ace.js": "export {};\n",
    "node_modules/@surf-ace/controller/dist/index.js": "export {};\n",
    "node_modules/@surf-ace/protocol/dist/index.js": "export {};\n",
    "node_modules/@surf-ace/protocol/schema.json": "{}\n",
    "node_modules/alpha/package.json": '{"name":"alpha","version":"1.2.3"}\n',
    "node_modules/bonjour-service/package.json": '{"name":"bonjour-service","version":"1.0.0"}\n',
    "node_modules/ws/package.json": '{"name":"ws","version":"1.0.0"}\n',
    "openclaw.plugin.json": '{"tools":["surf_ace_list"],"contracts":{"tools":["surf_ace_list"]}}\n',
    "package.json": '{"name":"surf-ace","type":"module","openclaw":{"extensions":["./surf-ace.ts"],"runtimeExtensions":["./dist/extension/src/index.js"]}}\n',
    "surf-ace.ts": "export {};\n",
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(packageDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  const lockfile = path.join(root, "pnpm-lock.yaml");
  await fs.writeFile(lockfile, "lockfileVersion: '9.0'\npackages:\n\n  alpha@1.2.3:\n    resolution: {integrity: sha512-AAAA}\n\n  bonjour-service@1.0.0:\n    resolution: {integrity: sha512-BBBB}\n\n  ws@1.0.0:\n    resolution: {integrity: sha512-CCCC}\n\nsnapshots:\n\n  alpha@1.2.3: {}\n\n  bonjour-service@1.0.0: {}\n\n  ws@1.0.0: {}\n");
  const cutoffVerifier = path.join(root, "cutoff/packages/extension/scripts/verify-openclaw-package.mjs");
  await fs.mkdir(path.dirname(cutoffVerifier), { recursive: true });
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  await fs.writeFile(cutoffVerifier, await fs.readFile(path.join(repository, "packages/extension/scripts/verify-openclaw-package.mjs")));
  assert.deepEqual(await verifyOpenclawPackage(packageDir, lockfile, cutoffVerifier), [
    { integrity: "sha512-AAAA", name: "alpha", version: "1.2.3" },
    { integrity: "sha512-BBBB", name: "bonjour-service", version: "1.0.0" },
    { integrity: "sha512-CCCC", name: "ws", version: "1.0.0" },
  ]);
  await fs.rm(path.join(packageDir, "node_modules/bonjour-service"), { force: true, recursive: true });
  await assert.rejects(verifyOpenclawPackage(packageDir, lockfile, cutoffVerifier));
  await fs.mkdir(path.join(packageDir, "node_modules/bonjour-service"), { recursive: true });
  await fs.writeFile(path.join(packageDir, "node_modules/bonjour-service/package.json"), '{"name":"bonjour-service","version":"1.0.0"}\n');
  await fs.rm(path.join(packageDir, "node_modules/ws"), { force: true, recursive: true });
  await assert.rejects(verifyOpenclawPackage(packageDir, lockfile, cutoffVerifier));
  await fs.mkdir(path.join(packageDir, "node_modules/ws"), { recursive: true });
  await fs.writeFile(path.join(packageDir, "node_modules/ws/package.json"), '{"name":"ws","version":"1.0.0"}\n');
  await fs.rm(path.join(packageDir, "dist/extension/src/openclaw-lockless-controller.js"));
  await assert.rejects(verifyOpenclawPackage(packageDir, lockfile, cutoffVerifier));
  await fs.writeFile(path.join(packageDir, "dist/extension/src/openclaw-lockless-controller.js"), "export {};\n");
  await fs.writeFile(path.join(packageDir, "openclaw.plugin.json"), '{"tools":["wrong"],"contracts":{"tools":["wrong"]}}\n');
  await assert.rejects(verifyOpenclawPackage(packageDir, lockfile, cutoffVerifier));
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
  const launch = electronLaunchConfig(home, 19101);
  assert.equal(launch.userDataDir, path.join(home, "user-data"));
  assert.deepEqual(launch.args, [`--user-data-dir=${launch.userDataDir}`]);
  assert.equal(launch.env.HOME, home);
  assert.equal(launch.env.SURF_ACE_STATE_DIR, undefined);
  const sentinel = {};
  let invocation;
  const launched = await launchElectron("/fixture/Surf Ace", home, 19101, (command, args, options) => {
    invocation = { args, command, options };
    return sentinel;
  });
  assert.equal(launched.started, sentinel);
  assert.deepEqual(invocation, {
    args: launch.args,
    command: "/fixture/Surf Ace",
    options: { env: launch.env },
  });
  assert.equal((await fs.stat(launch.userDataDir)).isDirectory(), true);
});

test("Tightbeam macOS smoke retains one profile across baseline upgrade and rollback", async (t) => {
  const root = await temporary(t);
  const candidate = path.join(root, "candidate.zip");
  const baseline = path.join(root, "baseline.zip");
  const { electronLaunchConfig } = await import("./smoke-lib.mjs");
  const { macosSmokePlan, runMacosSmokePlan } = await import("./smoke-tightbeam-release.mjs");
  const plan = macosSmokePlan(root, candidate, baseline);
  assert.deepEqual(plan.map(({ archive, phase }) => ({ archive, phase })), [
    { archive: candidate, phase: "clean-install" },
    { archive: baseline, phase: "baseline" },
    { archive: candidate, phase: "upgrade" },
    { archive: baseline, phase: "rollback" },
  ]);
  assert.notEqual(plan[0].home, plan[1].home);
  assert.equal(plan[1].home, plan[2].home);
  assert.equal(plan[2].home, plan[3].home);
  assert.equal(new Set(plan.map(({ installRoot }) => installRoot)).size, 4);
  for (const step of plan) {
    assert.equal(step.identityFile, path.join(electronLaunchConfig(step.home, step.port).userDataDir, "surface-identity.json"));
  }

  const handshakes = [];
  const extract = async (_archive, installRoot) => fs.mkdir(path.join(installRoot, "Surf Ace.app/Contents/MacOS"), { recursive: true });
  const handshake = async (_executable, home, port) => {
    handshakes.push({ home, port });
    const identity = path.join(electronLaunchConfig(home, port).userDataDir, "surface-identity.json");
    await fs.mkdir(path.dirname(identity), { recursive: true });
    try {
      await fs.access(identity);
    } catch {
      await fs.writeFile(identity, `identity:${home}`);
    }
  };
  await runMacosSmokePlan(plan, { extract, handshake });
  assert.deepEqual(handshakes.map(({ home }) => home), plan.map(({ home }) => home));

  let transition = 0;
  await assert.rejects(runMacosSmokePlan(plan, {
    extract,
    handshake: async (_executable, home, port) => {
      const identity = path.join(electronLaunchConfig(home, port).userDataDir, "surface-identity.json");
      await fs.mkdir(path.dirname(identity), { recursive: true });
      if (home === plan[1].home && transition++ === 1) await fs.writeFile(identity, "changed identity");
      else if (!(await fs.stat(identity).catch(() => null))) await fs.writeFile(identity, `identity:${home}`);
    },
  }), /tightbeam_macos_upgrade_did_not_reuse_canonical_identity/);
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
  await exec("git", ["tag", "product-v1"], { cwd: root });
  await assertSourceIdentity(root, "product-v1", commit);
  await fs.writeFile(path.join(root, "tracked.txt"), "two\n");
  await exec("git", ["commit", "-qam", "two"], { cwd: root });
  await assert.rejects(assertSourceIdentity(root, "product-v1", commit), /source_commit_mismatch/);
});

test("channel builders reject any source identity outside the reviewed constants before I/O", async () => {
  await assert.rejects(buildOpenclawRelease({ sourceDir: ".", outputDir: "build/release/openclaw", sourceTag: "wrong", sourceCommit: "wrong", toolingTag: "wrong", version: "0" }), /openclaw_release_identity_mismatch/);
  await assert.rejects(buildOpenclawRelease({ sourceDir: ".", outputDir: "build/release/openclaw", sourceTag: OPENCLAW.sourceTag, sourceCommit: OPENCLAW.candidateCommit, version: OPENCLAW.version }), /openclaw_tooling_tag_required/);
  await assert.rejects(buildTightbeamRelease({ sourceDir: ".", outputDir: "build/release/tightbeam", sourceTag: "wrong", sourceCommit: "wrong", version: "0", target: "wrong" }), /tightbeam_release_identity_mismatch/);
});

test("Tightbeam v0.2.0 binds the reviewed cutoff, same-architecture baseline, and unissued tooling successor", () => {
  assert.equal(TOOLING_TAG, "surf-ace-release-tooling-v0.1.1");
  assert.deepEqual(TIGHTBEAM, {
    baselineCommit: "cf91ef1baab26d6045fac5300487c29d0ddf332d",
    candidateCommit: "8fc9f508ae9b4371a3c25f6318920940fbad10cd",
    files: [
      "surf-ace-tightbeam-electron-macos-arm64-v0.2.0.zip",
      "surf-ace-tightbeam-linux-x86_64-v0.2.0.tar.gz",
      "surf-ace-tightbeam-v0.2.0-manifest.json",
    ],
    sourceTag: "surf-ace-tightbeam-v0.2.0",
    version: "0.2.0",
  });
});

test("committed channel guards enforce their actual selected tooling tags", async (t) => {
  const predecessor = "6bdf393a234c73174185032e61b0b155d65124d4";
  const openclawTag = "surf-ace-release-tooling-openclaw-v0.1.2";
  const tightbeamTag = TOOLING_TAG;
  const reservedTag = "surf-ace-release-tooling-openclaw-v0.1.1";
  const arbitraryTag = "surf-ace-release-tooling-other-v9.9.9";
  const gate4Path = ".github/workflows/release-openclaw.yml";
  const gate5Path = ".github/workflows/release-openclaw-gate5.yml";
  const gate4Step = "Require immutable tooling dispatch and product tag";
  const gate5Step = "Require an exact successful Gate 4 run and immutable refs";
  const gate4 = workflowRunScript(await fs.readFile(path.join(repository, gate4Path), "utf8"), gate4Step);
  const gate5 = workflowRunScript(await fs.readFile(path.join(repository, gate5Path), "utf8"), gate5Step);
  const predecessorGate4 = workflowRunScript(await workflowAtRevision(predecessor, gate4Path), gate4Step);
  const predecessorGate5 = workflowRunScript(await workflowAtRevision(predecessor, gate5Path), gate5Step);

  for (const [name, script] of [["Gate 4", predecessorGate4], ["Gate 5", predecessorGate5]]) {
    await t.test(`${name} predecessor accepted the Tightbeam tag at the same tooling commit`, async (t) => {
      const result = await runWorkflowGuard(t, script, {
        TOOLING_TAG: tightbeamTag,
        GITHUB_REF: `refs/tags/${tightbeamTag}`,
      });
      assert.equal(result.exitCode, 0, result.stderr);
    });
  }

  for (const [name, script] of [["Gate 4", gate4], ["Gate 5", gate5]]) {
    await t.test(`${name} accepts only its own valid channel dispatch`, async (t) => {
      const result = await runWorkflowGuard(t, script);
      assert.equal(result.exitCode, 0, result.stderr);
    });
    for (const rejectedTag of [tightbeamTag, reservedTag, arbitraryTag]) {
      await t.test(`${name} rejects ${rejectedTag} even when it peels to the same commit`, async (t) => {
        const result = await runWorkflowGuard(t, script, {
          TOOLING_TAG: rejectedTag,
          GITHUB_REF: `refs/tags/${rejectedTag}`,
        });
        assert.notEqual(result.exitCode, 0);
        assert.equal(result.ghLog, "", "wrong-channel tag must stop before any GitHub API call");
      });
    }
    for (const [failure, overrides] of [
      ["wrong event", { GITHUB_EVENT_NAME: "push" }],
      ["wrong ref type", { GITHUB_REF_TYPE: "branch" }],
      ["wrong ref", { GITHUB_REF: `refs/tags/${openclawTag}-other` }],
      ["wrong tooling peel", { MOCK_TOOLING_REMOTE: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
      ["wrong product peel", { MOCK_PRODUCT_REMOTE: "cccccccccccccccccccccccccccccccccccccccc" }],
    ]) {
      await t.test(`${name} rejects ${failure}`, async (t) => {
        const result = await runWorkflowGuard(t, script, overrides);
        assert.notEqual(result.exitCode, 0);
      });
    }
  }

  await t.test("Gate 5 rejects a mismatched Gate 4 receipt", async (t) => {
    const result = await runWorkflowGuard(t, gate5, {
      MOCK_GATE4_HEAD_SHA: "dddddddddddddddddddddddddddddddddddddddd",
    });
    assert.notEqual(result.exitCode, 0);
  });

  await t.test("Tightbeam committed guard accepts its own valid channel dispatch", async (t) => {
    const workflow = await fs.readFile(path.join(repository, ".github/workflows/release-tightbeam.yml"), "utf8");
    const script = workflowRunScript(workflow, "Require immutable tooling dispatch and reviewed product tag");
    const result = await runWorkflowGuard(t, script, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF: "refs/heads/release/run-tightbeam-v0.2.0",
      GITHUB_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      TOOLING_TAG: tightbeamTag,
      PRODUCT_TAG: "surf-ace-tightbeam-v0.2.0",
      PRODUCT_COMMIT: "8fc9f508ae9b4371a3c25f6318920940fbad10cd",
      MOCK_PRODUCT_REMOTE: "8fc9f508ae9b4371a3c25f6318920940fbad10cd",
    });
    assert.equal(result.exitCode, 0, result.stderr);
  });
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
  assert.deepEqual(actual.sort(), [...TIGHTBEAM_LINUX_RUNTIME_FILES].sort());
  const guide = await fs.readFile(path.join(stage, "README.md"), "utf8");
  assert.match(guide, /startCentralServer\(config, name\)/);
  assert.match(guide, /await service\.close\(\)/);
  assert.match(guide, /already-provisioned PostgreSQL custody/);
  assert.doesNotMatch(actual.join("\n"), /systemd|service|surf-ace-runtime|controller\/dist\/main\.js/);

  await fs.writeFile(path.join(stage, "surf-ace-runtime"), "obsolete daemon launcher\n");
  await assert.rejects(verifyTightbeamLinuxStage(stage), /tightbeam_linux_runtime_closure_mismatch/);
});

test("Tightbeam Linux builder creates source-declared dependencies before the Electron server bundle", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const builder = await fs.readFile(path.join(repository, "scripts/release/build-tightbeam-release.mjs"), "utf8");
  const functionStart = builder.indexOf("export async function buildTightbeamLinuxStage");
  const functionEnd = builder.indexOf("export async function buildTightbeamRelease", functionStart);
  const body = builder.slice(functionStart, functionEnd);
  const protocol = body.indexOf('"@surf-ace/protocol", "build"');
  const controller = body.indexOf('"@surf-ace/controller", "build"');
  const electron = body.indexOf('"@surf-ace/electron", "build"');
  assert.ok(protocol >= 0, "protocol build is required");
  assert.ok(controller > protocol, "controller build must follow protocol");
  assert.ok(electron > controller, "Electron server bundle must follow controller");
});

function semanticPhase(sourceCommit, overrides = {}) {
  const phase = {
    acknowledgedWriteIds: [],
    acknowledgementEvidence: [],
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
    clientIdentity: "client-stable",
    currentContentRecord: null,
    databaseIdentity: "database-owned",
    loss: null,
    registrationIdentity: "registered-client-stable",
    resetCount: 0,
    resetEvidence: { databaseIdentity: "database-owned", priorDatabaseIdentity: null },
    semanticState: {
      content: { seed: { contentId: "seed" } },
      history: { "pane:sf_1:1": ["seed"] },
      labels: { pane1: 1, surface: "a" },
      outbox: ["ack-seed"],
      panes: [1, 2],
      tombstones: ["pane-old"],
    },
    sequence: 12,
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
      controllerInstanceId: phase.clientIdentity,
      result: { contentId: records.at(-1)?.payload?.contentId ?? null, contentType: "html", paneId: 1, revision: 1 },
    },
    output: {
      controllerInstanceId: phase.clientIdentity,
      result: {
        cacheStatus: "current",
        consumableLoss: null,
        currentContentRecord: records.at(-1) ?? null,
        records,
        scopeId: "pane:sf_1:1",
      },
    },
    scopeId: "pane:sf_1:1",
  }];
  phase.readControllerIdentities ??= [phase.clientIdentity];
  phase.acknowledgementEvidence ??= [];
  if (phase.acknowledgedWriteIds.length > 0 && phase.acknowledgementEvidence.length === 0) {
    phase.acknowledgementEvidence = [{
      cursor: records.length + 1,
      idempotencyKey: "pane:sf_1:1:ack",
      scopeId: "pane:sf_1:1",
      writeIds: [...phase.acknowledgedWriteIds],
    }];
  }
  const state = {
    acknowledgementOutbox: [],
    controllerInstanceId: phase.clientIdentity,
    scopes: {
      "pane:sf_1:1": {
        clientCursor: records.length + 1,
        lastRetainedSequence: records.length,
        records: [],
        synchronized: true,
      },
    },
    version: 1,
  };
  phase.controllerStateBeforeAcknowledgement ??= state;
  phase.controllerStateAfterAcknowledgement ??= structuredClone(state);
  return phase;
}

test("Tightbeam state sequence preserves one database and identity and retains candidate-acknowledged writes through rollback", () => {
  const baselineBefore = semanticPhase(TIGHTBEAM.baselineCommit);
  const semanticState = {
    ...baselineBefore.semanticState,
    content: { ...baselineBefore.semanticState.content, "write-candidate-1": { contentId: "write-candidate-1" } },
    history: { ...baselineBefore.semanticState.history, "pane:sf_1:2": ["write-candidate-1"] },
  };
  const candidateAfter = semanticPhase(TIGHTBEAM.candidateCommit, {
    acknowledgedWriteIds: ["write-candidate-1"],
    allocatorFence: 8,
    currentContentRecord: { contentId: "write-candidate-1", revision: 2 },
    semanticState,
    sequence: 20,
  });
  const rollbackAfter = semanticPhase(TIGHTBEAM.baselineCommit, {
    acknowledgedWriteIds: ["write-candidate-1"],
    allocatorFence: 8,
    currentContentRecord: { contentId: "write-candidate-1", revision: 2 },
    semanticState,
    sequence: 21,
  });
  assert.deepEqual(validateTightbeamStateSequence({ baselineBefore, candidateAfter, rollbackAfter }), {
    acknowledgedWriteIds: ["write-candidate-1"],
    baselineCommit: TIGHTBEAM.baselineCommit,
    candidateCommit: TIGHTBEAM.candidateCommit,
    clientIdentity: "client-stable",
    databaseIdentity: "database-owned",
    status: "passed",
  });
});

test("Tightbeam state sequence rejects dropped or regressed packaged controller scopes even when capture remains current", () => {
  const baselineBefore = semanticPhase(TIGHTBEAM.baselineCommit);
  const semanticState = {
    ...baselineBefore.semanticState,
    content: { ...baselineBefore.semanticState.content, "write-candidate-1": { contentId: "write-candidate-1" } },
    history: { ...baselineBefore.semanticState.history, "pane:sf_1:2": ["write-candidate-1"] },
  };
  const candidateAfter = semanticPhase(TIGHTBEAM.candidateCommit, {
    acknowledgedWriteIds: ["write-candidate-1"],
    currentContentRecord: { contentId: "write-candidate-1", revision: 2 },
    semanticState,
    sequence: 20,
  });
  const rollbackAfter = semanticPhase(TIGHTBEAM.baselineCommit, {
    acknowledgedWriteIds: ["write-candidate-1"],
    currentContentRecord: { contentId: "write-candidate-1", revision: 2 },
    semanticState,
    sequence: 21,
  });
  const scopeId = "pane:sf_1:1";
  const validateCandidateState = (controllerStateAfterAcknowledgement) => validateTightbeamStateSequence({
    baselineBefore,
    candidateAfter: { ...candidateAfter, controllerStateAfterAcknowledgement },
    rollbackAfter,
  });
  const validateRollbackState = (controllerStateAfterAcknowledgement) => validateTightbeamStateSequence({
    baselineBefore,
    candidateAfter,
    rollbackAfter: { ...rollbackAfter, controllerStateAfterAcknowledgement },
  });

  const droppedScope = structuredClone(candidateAfter.controllerStateAfterAcknowledgement);
  delete droppedScope.scopes[scopeId];
  assert.throws(() => validateCandidateState(droppedScope), /candidate_controller_state_scope_missing/);

  const droppedRollbackScope = structuredClone(rollbackAfter.controllerStateAfterAcknowledgement);
  delete droppedRollbackScope.scopes[scopeId];
  assert.throws(() => validateRollbackState(droppedRollbackScope), /rollback_controller_state_scope_missing/);

  for (const [field, value] of [["clientCursor", 0], ["lastRetainedSequence", 0]]) {
    const regressedScope = structuredClone(candidateAfter.controllerStateAfterAcknowledgement);
    regressedScope.scopes[scopeId][field] = value;
    assert.throws(() => validateCandidateState(regressedScope), new RegExp(`candidate_controller_state_scope_${field}_regression`));
  }

  const unsynchronizedScope = structuredClone(candidateAfter.controllerStateAfterAcknowledgement);
  unsynchronizedScope.scopes[scopeId].synchronized = false;
  assert.throws(() => validateCandidateState(unsynchronizedScope), /candidate_controller_state_scope_not_synchronized/);

  assert.ok(candidateAfter.readEvidence[0].captureOutput, "negative cases retain packaged capture evidence");
});

test("Tightbeam state sequence rejects wrong sources, loss, reset, identity drift, and stale rollback", () => {
  const before = semanticPhase(TIGHTBEAM.baselineCommit);
  const semanticState = {
    ...before.semanticState,
    content: { ...before.semanticState.content, "write-candidate-1": { contentId: "write-candidate-1" } },
    history: { ...before.semanticState.history, "pane:sf_1:2": ["write-candidate-1"] },
  };
  const candidate = semanticPhase(TIGHTBEAM.candidateCommit, {
    acknowledgedWriteIds: ["write-candidate-1"],
    currentContentRecord: { contentId: "write-candidate-1", revision: 2 },
    semanticState,
    sequence: 20,
  });
  const rollback = semanticPhase(TIGHTBEAM.baselineCommit, {
    acknowledgedWriteIds: ["write-candidate-1"],
    currentContentRecord: { contentId: "write-candidate-1", revision: 2 },
    semanticState,
    sequence: 21,
  });
  const validate = (change) => validateTightbeamStateSequence({ baselineBefore: before, candidateAfter: candidate, rollbackAfter: rollback, ...change });
  assert.throws(() => validate({ baselineBefore: { ...before, sourceCommit: "wrong" } }), /baseline_source_mismatch/);
  assert.throws(() => validate({ candidateAfter: { ...candidate, sourceCommit: TIGHTBEAM.baselineCommit } }), /candidate_source_mismatch/);
  assert.throws(() => validate({ candidateAfter: { ...candidate, loss: { from: 13, to: 14 } } }), /consumable_loss/);
  assert.throws(() => validate({
    rollbackAfter: {
      ...rollback,
      allocatorIdentity: "changed",
      allocatorAfterRegistration: { ...rollback.allocatorAfterRegistration, allocatorId: "changed" },
    },
  }), /allocator_reset/);
  assert.throws(() => validate({ rollbackAfter: { ...rollback, clientIdentity: "changed" } }), /controller_state_identity_mismatch/);
  assert.throws(() => validate({ rollbackAfter: { ...rollback, semanticState: before.semanticState } }), /candidate_discarded_baseline_content/);
  assert.throws(() => validate({ rollbackAfter: { ...rollback, sequence: 11 } }), /sequence_regression/);
  assert.throws(() => validate({ rollbackAfter: { ...rollback, resetCount: 1 } }), /database_reset/);
  assert.throws(() => validate({
    candidateAfter: {
      ...candidate,
      semanticState: {
        ...candidate.semanticState,
        content: { "write-candidate-1": { contentId: "write-candidate-1" } },
      },
    },
  }), /candidate_discarded_baseline_content/);
  assert.throws(() => validate({
    candidateAfter: {
      ...candidate,
      semanticState: {
        ...candidate.semanticState,
        history: { "pane:sf_1:2": ["write-candidate-1"] },
      },
    },
  }), /candidate_discarded_baseline_history/);
  assert.throws(() => validate({
    rollbackAfter: {
      ...rollback,
      semanticState: {
        ...rollback.semanticState,
        tombstones: [],
      },
    },
  }), /candidate_discarded_baseline_tombstones/);
  assert.throws(() => validate({
    candidateAfter: {
      ...candidate,
      readEvidence: [{
        output: {
          controllerInstanceId: candidate.clientIdentity,
          result: {
            cacheStatus: "current",
            consumableLoss: null,
            currentContentRecord: null,
            records: [],
            scopeId: "pane:sf_1:1",
          },
        },
        scopeId: "pane:sf_1:1",
      }],
    },
  }), /candidate_packaged_read_content_missing/);
});

test("cf91 macOS baseline is packaged from a clean external source and output root", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const script = await fs.readFile(path.join(repository, "scripts/release/build-smoke-baseline.mjs"), "utf8");
  assert.match(script, /git.*archive/);
  assert.match(script, /\.macos-source/);
  assert.match(script, /--config\.directories\.output=/);
  assert.match(script, /tightbeam_baseline_macos_recursive_package/);
  assert.doesNotMatch(script, /stagedSource, "--filter", "@surf-ace\/electron", "package"/);
});

test("Tightbeam Linux publication gate requires the executable state driver and validates its three phases", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const smoke = await fs.readFile(path.join(repository, "scripts/release/smoke-tightbeam-release.mjs"), "utf8");
  const fixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  const workflow = await fs.readFile(path.join(repository, ".github/workflows/release-tightbeam.yml"), "utf8");
  assert.match(smoke, /tightbeam_smoke_state_driver_required/);
  assert.match(smoke, /validateTightbeamStateSequence\(stateSequence\)/);
  assert.match(fixture, /startCentralServer/);
  assert.match(fixture, /PostgresCustodyAdapter\.initializeAbsentFleet/);
  assert.match(fixture, /bin\/surf-ace/);
  assert.match(fixture, /await runPhase\("baseline"/);
  assert.match(fixture, /await runPhase\("candidate"/);
  assert.match(fixture, /await runPhase\("rollback"/);
  assert.match(workflow, /tightbeam-state-smoke-fixture\.ts/);
  assert.match(workflow, /pnpm --dir tooling --filter @surf-ace\/electron exec esbuild/);
  assert.doesNotMatch(workflow, /pnpm --dir tooling exec esbuild/);
  assert.match(workflow, /--banner:js='import \{ createRequire as __createRequire \} from "node:module"; const require = __createRequire\(import\.meta\.url\);'/);
  assert.match(fixture, /const nodeRequire = createRequire\(import\.meta\.url\)/);
  assert.doesNotMatch(fixture, /const require = createRequire\(import\.meta\.url\)/);
  assert.match(workflow, /SURF_ACE_TIGHTBEAM_STATE_DRIVER/);
  assert.match(workflow, /^  attest-and-publish:\n    needs: \[smoke-linux, smoke-macos\]/m);
});

test("Tightbeam Linux state evidence comes from packaged CLI reads and durable controller state", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const fixture = await fs.readFile(path.join(repository, "scripts/release/tightbeam-state-smoke-fixture.ts"), "utf8");
  assert.match(fixture, /readPackagedControllerState/);
  assert.match(fixture, /controllerStateBeforeAcknowledgement/);
  assert.match(fixture, /controllerStateAfterAcknowledgement/);
  assert.match(fixture, /acknowledgementOutbox/);
  assert.match(fixture, /controllerInstanceId/);
  assert.match(fixture, /primaryHeadSeq/);
  assert.match(fixture, /resultDerivedSplitChildren\(split, paneId, 3\)/);
  assert.match(fixture, /raw-cli-evidence\.ndjson/);
  assert.match(fixture, /rawCliEvidenceSha256/);
  assert.match(fixture, /rollback-observer-cli/);
  assert.match(fixture, /latestContentRecord\(\[rollbackRead\]\)/);
  assert.match(fixture, /currentCaptureObservation\(\[rollbackRead\]\)/);
  assert.match(fixture, /source: "packaged-capture-pane"/);
  assert.match(fixture, /semanticContentProjection/);
  assert.match(fixture, /readControllerIdentities/);
  assert.match(fixture, /priorDatabaseIdentity !== databaseIdentity/);
  assert.match(fixture, /resetEvidence: \{ databaseIdentity, priorDatabaseIdentity \}/);
  assert.doesNotMatch(fixture, /splitPayload\?\.createdPaneIds/);
  assert.match(fixture, /witnessApplicationName: "surf_ace_witness"/);
  assert.doesNotMatch(fixture, /application_name=surf_ace_smoke_witness/);
  assert.doesNotMatch(fixture, /ALTER SYSTEM SET synchronous_commit = 'remote_apply'; SELECT pg_reload_conf\(\);/);
  assert.doesNotMatch(fixture, /semanticState\(core, writes\)/);
  assert.doesNotMatch(fixture, /resetCount:\s*0/);
});

test("Linux state driver gate executes one driver and rejects a baseline-to-candidate loss", async (t) => {
  const root = await temporary(t);
  const output = path.join(root, "state.json");
  const baselineBefore = semanticPhase(TIGHTBEAM.baselineCommit);
  const retained = {
    ...baselineBefore.semanticState,
    content: { ...baselineBefore.semanticState.content, "candidate-write": { contentId: "candidate-write" } },
    history: { ...baselineBefore.semanticState.history, "pane:sf_1:2": ["candidate-write"] },
    outbox: [...baselineBefore.semanticState.outbox, "candidate-write"],
  };
  const candidateAfter = semanticPhase(TIGHTBEAM.candidateCommit, {
    acknowledgedWriteIds: ["candidate-write"],
    currentContentRecord: { contentId: "candidate-write", revision: 2 },
    semanticState: retained,
    sequence: 20,
  });
  const rollbackAfter = semanticPhase(TIGHTBEAM.baselineCommit, {
    acknowledgedWriteIds: ["candidate-write"],
    currentContentRecord: { contentId: "candidate-write", revision: 2 },
    semanticState: retained,
    sequence: 21,
  });
  let calls = 0;
  const options = {
    baselineCommit: TIGHTBEAM.baselineCommit,
    baselineRoot: path.join(root, "baseline"),
    candidateCommit: TIGHTBEAM.candidateCommit,
    candidateRoot: path.join(root, "candidate"),
    driver: path.join(root, "driver.mjs"),
    output,
    stateRoot: path.join(root, "state"),
  };
  const execute = async (command, args) => {
    calls++;
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [
      options.driver,
      "--baseline-commit", options.baselineCommit,
      "--baseline-root", options.baselineRoot,
      "--candidate-commit", options.candidateCommit,
      "--candidate-root", options.candidateRoot,
      "--output", options.output,
      "--state-root", options.stateRoot,
    ]);
    await fs.writeFile(output, JSON.stringify({ baselineBefore, candidateAfter, rollbackAfter }));
  };
  assert.equal((await runLinuxStateDriver(options, execute)).status, "passed");
  assert.equal(calls, 1);
  await assert.rejects(runLinuxStateDriver(options, async () => {
    await fs.writeFile(output, JSON.stringify({
      baselineBefore,
      candidateAfter: {
        ...candidateAfter,
        semanticState: { ...retained, content: { "candidate-write": { contentId: "candidate-write" } } },
      },
      rollbackAfter,
    }));
  }), /candidate_discarded_baseline_content/);
});

test("canonical spec and workflows preserve reviewed bytes and immutable action pins", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const specificationPath = path.join(repository, "docs/release/openclaw-tightbeam-release-split.md");
  const specification = await fs.readFile(specificationPath, "utf8");
  assert.equal(await sha256(specificationPath), "fceccf7de4241f8dd4a4d788310d221cbf009e4e4f4d68fe4a2abdce5cbb471e");
  assert.match(specification, /58ac8c435679e6611903d31abaecec11bb9d7f75/);
  assert.match(specification, /8fc9f508ae9b4371a3c25f6318920940fbad10cd/);
  assert.match(specification, /cf91ef1baab26d6045fac5300487c29d0ddf332d/);
  assert.match(specification, /surf-ace-release-tooling-v0\.1\.1/);
  assert.match(specification, /surf-ace-release-tooling-openclaw-v0\.1\.2/);
  assert.equal((specification.match(/surf-ace-release-tooling-v0\.1\.0/g) ?? []).length, 1);
  assert.match(specification, /surf-ace-release-tooling-v0\.1\.0` points to\n`9d8ca5a490a32a57c5177e4769aef4100dd5f5bf`/);
  assert.match(specification, /incident tag `surf-ace-release-tooling-openclaw-v0\.1\.1` is present and\nreserved/);
  assert.match(specification, /26ce99cf43463e817c5322c8793bcdd2d9eadc2e/);
  assert.match(specification, /failed Gate 4 runs `36222148637` and `36222183104`/);
  assert.doesNotMatch(specification, /absent incident|currently absent incident/);
  assert.match(specification, /surf-ace-tightbeam-v0\.2\.0` always resolves to exact product commit/);
  assert.match(specification, /Any copied or generated rendering is non-authoritative/);
  assert.doesNotMatch(specification, /surf-ace-tightbeam-v0\.2\.0` at the exact new `main` commit/);
  assert.doesNotMatch(specification, /resident controller, thin Rust CLI, systemd unit/);
  assert.ok((await lockedPackages(path.join(repository, "pnpm-lock.yaml"))).size > 100);
  assert.ok((await cargoLockedPackages(path.join(repository, "packages/cli/Cargo.lock"))).length > 10);
  for (const workflow of ["release-openclaw.yml", "release-openclaw-gate5.yml", "release-tightbeam.yml"]) {
    const text = await fs.readFile(path.join(repository, ".github/workflows", workflow), "utf8");
    for (const match of text.matchAll(/^\s*uses:\s*([^\s]+)$/gm)) {
      assert.match(match[1], /@[0-9a-f]{40}$/);
    }
    if (workflow !== "release-openclaw-gate5.yml") {
      assert.match(text, /git -C source diff --exit-code HEAD -- \./);
      assert.match(text, /git -C source diff --cached --exit-code HEAD -- \./);
    }
  }
  const tightbeamWorkflow = await fs.readFile(path.join(repository, ".github/workflows/release-tightbeam.yml"), "utf8");
  assert.doesNotMatch(tightbeamWorkflow, /workflow_dispatch/);
  assert.match(tightbeamWorkflow, /release\/run-tightbeam-v0\.2\.0/);
  assert.match(tightbeamWorkflow, /test "\$\{GITHUB_REF\}" = "\$\{TRIGGER_REF\}"/);
  assert.match(tightbeamWorkflow, /--output linux-smoke-receipt\.json/);
  assert.match(tightbeamWorkflow, /--output macos-smoke-receipt\.json/);
  assert.match(tightbeamWorkflow, /subject-path: release\/\.receipts\/linux-smoke-receipt\.json/);
  assert.match(tightbeamWorkflow, /subject-path: release\/\.receipts\/macos-smoke-receipt\.json/);
  assert.match(tightbeamWorkflow, /PRODUCT_COMMIT: 8fc9f508ae9b4371a3c25f6318920940fbad10cd/);
  assert.match(tightbeamWorkflow, /TOOLING_TAG: surf-ace-release-tooling-v0\.1\.1/);
  assert.match(tightbeamWorkflow, /tooling_remote="\$\(peel_tag "\$\{TOOLING_TAG\}"\)"/);
  assert.match(tightbeamWorkflow, /test "\$\{tooling_remote\}" = "\$\{GITHUB_SHA\}"/);
  assert.match(tightbeamWorkflow, /ref: cf91ef1baab26d6045fac5300487c29d0ddf332d/);
  assert.doesNotMatch(tightbeamWorkflow, /24b4a389|ec623c546|package:linux|surf-ace-runtime|systemd-analyze/);
  assert.match(tightbeamWorkflow, /^  attest-and-publish:\n    needs: \[smoke-linux, smoke-macos\]/m);
});

test("OpenClaw Gate 4 dispatch cannot reach smoke or publication", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const workflow = await fs.readFile(path.join(repository, ".github/workflows/release-openclaw.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /TOOLING_TAG: \$\{\{ github\.ref_name \}\}/);
  assert.match(workflow, /test "\$\{GITHUB_REF_TYPE\}" = tag/);
  assert.match(workflow, /test "\$\{TOOLING_TAG\}" = surf-ace-release-tooling-openclaw-v0\.1\.2/);
  assert.match(workflow, /test "\$\{GITHUB_REF\}" = "refs\/tags\/\$\{TOOLING_TAG\}"/);
  assert.match(workflow, /tooling_remote="\$\(peel_tag "\$\{TOOLING_TAG\}"\)"/);
  assert.match(workflow, /test "\$\{tooling_remote\}" = "\$\{GITHUB_SHA\}"/);
  assert.doesNotMatch(workflow, /surf-ace-release-tooling-v0\.1\.1/);
  assert.match(workflow, /^  build:\n    needs: guard/m);
  assert.match(workflow, /^  compare:\n    needs: build/m);
  assert.match(workflow, /^  compare:/m);
  assert.doesNotMatch(workflow, /^  smoke:/m);
  assert.doesNotMatch(workflow, /^  attest-and-publish:/m);
  assert.doesNotMatch(workflow, /^\s+contents: write$/m);
  assert.doesNotMatch(workflow, /^\s+id-token:/m);
  assert.doesNotMatch(workflow, /^\s+attestations:/m);
});

test("OpenClaw Gate 4 builds imported workspace prerequisites before extension tests and stops on failure", async (t) => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const workflow = await fs.readFile(path.join(repository, ".github/workflows/release-openclaw.yml"), "utf8");
  const marker = "      - name: Run exact OpenClaw tests without changing tracked inputs\n        run: |\n";
  const markerOffset = workflow.indexOf(marker);
  assert.notEqual(markerOffset, -1, "missing exact OpenClaw test step");
  const lines = workflow.slice(markerOffset + marker.length).split("\n");
  const body = [];
  for (const line of lines) {
    if (line.startsWith("          ")) body.push(line.slice(10));
    else if (line === "") body.push("");
    else break;
  }
  const script = body.join("\n").trimEnd();
  const expected = [
    "guard",
    "pnpm --dir source --filter @surf-ace/protocol build",
    "guard",
    "pnpm --dir source --filter @surf-ace/controller build",
    "guard",
    "pnpm --dir source/packages/extension exec sh -c 'node --import tsx --test src/*.test.ts scripts/*.test.mjs'",
    "guard",
    "pnpm --dir source --filter @surf-ace/controller test",
    "guard",
    "pnpm --dir source --filter @surf-ace/protocol test",
    "guard",
    "pnpm --dir source --filter @surf-ace/electron build",
    "guard",
    "pnpm --dir source --filter @surf-ace/electron test",
    "guard",
  ];
  let offset = -1;
  for (const command of expected) {
    const next = script.indexOf(command, offset + 1);
    assert.ok(next > offset, `missing or misordered Gate 4 command: ${command}`);
    offset = next;
  }

  const root = await temporary(t);
  const bin = path.join(root, "bin");
  const log = path.join(root, "pnpm.log");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(bin, "pnpm"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PNPM_LOG\"\nif test \"$*\" = \"$FAIL_COMMAND\"; then exit 29; fi\n", { mode: 0o755 });
  const runStep = async (failCommand) => {
    await fs.writeFile(log, "");
    const result = exec("/bin/bash", ["-c", script], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PNPM_LOG: log,
        FAIL_COMMAND: failCommand,
      },
    });
    if (failCommand) await assert.rejects(result);
    else await result;
    return (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean);
  };

  assert.deepEqual(await runStep("--dir source --filter @surf-ace/protocol build"), [
    "--dir source --filter @surf-ace/protocol build",
  ]);
  assert.deepEqual(await runStep("--dir source --filter @surf-ace/controller build"), [
    "--dir source --filter @surf-ace/protocol build",
    "--dir source --filter @surf-ace/controller build",
  ]);
  assert.deepEqual(await runStep(""), [
    "--dir source --filter @surf-ace/protocol build",
    "--dir source --filter @surf-ace/controller build",
    "--dir source/packages/extension exec sh -c node --import tsx --test src/*.test.ts scripts/*.test.mjs",
    "--dir source --filter @surf-ace/controller test",
    "--dir source --filter @surf-ace/protocol test",
    "--dir source --filter @surf-ace/electron build",
    "--dir source --filter @surf-ace/electron test",
  ]);
});

test("OpenClaw Gate 5 requires a separate exact successful Gate 4 run", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const workflow = await fs.readFile(path.join(repository, ".github/workflows/release-openclaw-gate5.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /gate4_run_id:/);
  assert.match(workflow, /TOOLING_TAG: \$\{\{ github\.ref_name \}\}/);
  assert.match(workflow, /test "\$\{TOOLING_TAG\}" = surf-ace-release-tooling-openclaw-v0\.1\.2/);
  assert.match(workflow, /test "\$\{gate4_conclusion\}" = success/);
  assert.match(workflow, /test "\$\{gate4_head_sha\}" = "\$\{GITHUB_SHA\}"/);
  assert.match(workflow, /test "\$\{gate4_path\}" = \.github\/workflows\/release-openclaw\.yml/);
  assert.match(workflow, /run-id: \$\{\{ inputs\.gate4_run_id \}\}/);
  assert.match(workflow, /^  smoke:\n    needs: guard/m);
  assert.match(workflow, /^  attest-and-publish:\n    needs: smoke/m);
});
