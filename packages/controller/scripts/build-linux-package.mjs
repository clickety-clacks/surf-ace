#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const output = path.resolve(process.argv[2] ?? path.join(repo, "build/linux-package"));
const target = process.env.SURF_ACE_LINUX_TARGET ?? "x86_64-unknown-linux-gnu";
const stage = path.join(output, "surf-ace-linux");
const controllerStage = path.join(stage, "controller");

async function run(command, args, options = {}) {
  await exec(command, args, {
    cwd: repo,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

async function regularFiles(root) {
  const entries = [];
  for (const name of await fs.readdir(root)) {
    const absolute = path.join(root, name);
    const metadata = await fs.lstat(absolute);
    if (metadata.isDirectory()) {
      entries.push(...await regularFiles(absolute));
    } else if (metadata.isFile()) {
      entries.push(absolute);
    }
  }
  return entries;
}

async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

const sourceStatus = (await exec("git", [
  "status",
  "--porcelain",
  "--untracked-files=all",
], { cwd: repo })).stdout.trim();
if (sourceStatus) {
  throw new Error(`linux_package_requires_clean_source:\n${sourceStatus}`);
}
await fs.mkdir(output, { recursive: false });
await fs.mkdir(stage);
await run("pnpm", ["--filter", "@surf-ace/protocol", "build"]);
await run("pnpm", ["--filter", "@surf-ace/controller", "build"]);

const cargoEnvironment = { ...process.env };
if (process.platform === "darwin" && target === "x86_64-unknown-linux-gnu") {
  cargoEnvironment.CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER = path.join(
    repo,
    "packages/cli/scripts/zig-x86_64-linux-gnu.sh",
  );
}
await run("cargo", [
  "build",
  "--locked",
  "--release",
  "--target",
  target,
  "--manifest-path",
  "packages/cli/Cargo.toml",
], { env: cargoEnvironment });

await run("pnpm", [
  "--filter",
  "@surf-ace/controller",
  "deploy",
  "--prod",
  "--legacy",
  controllerStage,
]);
await fs.mkdir(path.join(stage, "bin"));
await fs.copyFile(
  path.join(repo, "packages/cli/target", target, "release/surf-ace"),
  path.join(stage, "bin/surf-ace"),
);
await fs.chmod(path.join(stage, "bin/surf-ace"), 0o755);
await fs.copyFile(
  path.join(repo, "packages/controller/packaging/surf-ace-controller.service"),
  path.join(stage, "surf-ace-controller.service"),
);
await fs.copyFile(
  path.join(repo, "packages/controller/packaging/surf-ace-runtime"),
  path.join(stage, "surf-ace-runtime"),
);
await fs.chmod(path.join(stage, "surf-ace-runtime"), 0o755);

const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo }))
  .stdout.trim();
const files = await regularFiles(stage);
const hashes = {};
for (const file of files.sort()) {
  const relative = path.relative(stage, file);
  if (relative !== "manifest.json") {
    hashes[relative] = await sha256(file);
  }
}
await fs.writeFile(path.join(stage, "manifest.json"), `${JSON.stringify({
  architecture: target,
  files: hashes,
  formatVersion: 1,
  sourceCommit: commit,
}, null, 2)}\n`);

const archive = path.join(output, `surf-ace-linux-${target}.tar.gz`);
await run("tar", ["-czf", archive, "-C", output, "surf-ace-linux"]);
await fs.writeFile(`${archive}.sha256`, `${await sha256(archive)}  ${path.basename(archive)}\n`);
process.stdout.write(`${JSON.stringify({
  archive,
  archiveSha256: await sha256(archive),
  manifest: path.join(stage, "manifest.json"),
  target,
}, null, 2)}\n`);
