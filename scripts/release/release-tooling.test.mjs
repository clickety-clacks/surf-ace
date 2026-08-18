import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
import { buildOpenclawRelease } from "./build-openclaw-release.mjs";
import { buildTightbeamRelease } from "./build-tightbeam-release.mjs";
import { verifySmokeReceipt, writeSmokeReceipt } from "./write-smoke-receipt.mjs";

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
  await assert.rejects(buildOpenclawRelease({ sourceDir: ".", outputDir: "build/release/openclaw", sourceTag: "wrong", sourceCommit: "wrong", version: "0" }), /openclaw_release_identity_mismatch/);
  await assert.rejects(buildTightbeamRelease({ sourceDir: ".", outputDir: "build/release/tightbeam", sourceTag: "wrong", sourceCommit: "wrong", version: "0", target: "wrong" }), /tightbeam_release_identity_mismatch/);
});

test("canonical spec and workflows preserve reviewed bytes and immutable action pins", async () => {
  const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  assert.equal(await sha256(path.join(repository, "docs/release/openclaw-tightbeam-release-split.md")), "fc5dd8fdbcf458284cb119a385877bbac757a131c8145eecea1290571e68419c");
  assert.ok((await lockedPackages(path.join(repository, "pnpm-lock.yaml"))).size > 100);
  assert.ok((await cargoLockedPackages(path.join(repository, "packages/cli/Cargo.lock"))).length > 10);
  for (const workflow of ["release-openclaw.yml", "release-tightbeam.yml"]) {
    const text = await fs.readFile(path.join(repository, ".github/workflows", workflow), "utf8");
    for (const match of text.matchAll(/^\s*uses:\s*([^\s]+)$/gm)) {
      assert.match(match[1], /@[0-9a-f]{40}$/);
    }
    assert.match(text, /git -C source diff --exit-code HEAD -- \./);
    assert.match(text, /git -C source diff --cached --exit-code HEAD -- \./);
  }
  const tightbeamWorkflow = await fs.readFile(path.join(repository, ".github/workflows/release-tightbeam.yml"), "utf8");
  const openclawWorkflow = await fs.readFile(path.join(repository, ".github/workflows/release-openclaw.yml"), "utf8");
  assert.doesNotMatch(openclawWorkflow, /workflow_dispatch/);
  assert.match(openclawWorkflow, /release\/run-openclaw-v0\.1\.0/);
  assert.match(openclawWorkflow, /test "\$\{GITHUB_REF\}" = "\$\{TRIGGER_REF\}"/);
  assert.doesNotMatch(tightbeamWorkflow, /workflow_dispatch/);
  assert.match(tightbeamWorkflow, /release\/run-tightbeam-v0\.2\.0/);
  assert.match(tightbeamWorkflow, /test "\$\{GITHUB_REF\}" = "\$\{TRIGGER_REF\}"/);
  assert.match(tightbeamWorkflow, /--output linux-smoke-receipt\.json/);
  assert.match(tightbeamWorkflow, /--output macos-smoke-receipt\.json/);
  assert.match(tightbeamWorkflow, /subject-path: release\/\.receipts\/linux-smoke-receipt\.json/);
  assert.match(tightbeamWorkflow, /subject-path: release\/\.receipts\/macos-smoke-receipt\.json/);
});
