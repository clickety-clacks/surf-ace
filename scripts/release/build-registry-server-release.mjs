#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertDisjointTrees,
  assertExactPublicFiles,
  assertTrackedInputsUnchanged,
  capture,
  createDirectoryTarGz,
  parseArgs,
  removeIfExists,
  run,
  sha256,
  sourceDateEpoch,
  writeCanonicalJson,
} from "./release-lib.mjs";
import {
  buildTightbeamLinuxStage,
  TIGHTBEAM_LINUX_SERVER_FILES,
  verifyTightbeamLinuxStage,
} from "./build-tightbeam-release.mjs";
import { REGISTRY_SERVER_RELEASE } from "./registry-server-release-config.mjs";

const toolingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationPath = "schemas/allocator/004_pane_label_reuse.sql";
const outputFiles = [REGISTRY_SERVER_RELEASE.asset, REGISTRY_SERVER_RELEASE.manifest, REGISTRY_SERVER_RELEASE.checksums];

async function listStageFiles(root, relative = "") {
  const entries = [];
  for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, item.name);
    if (item.isDirectory()) entries.push(...await listStageFiles(root, child));
    else if (item.isFile()) entries.push(child);
    else throw new Error(`registry_server_stage_entry_unsupported:${child}`);
  }
  return entries.sort();
}

async function describeStageFiles(stageDir) {
  const files = [];
  for (const relative of await listStageFiles(stageDir)) {
    const file = path.join(stageDir, relative);
    const metadata = await fs.stat(file);
    files.push({
      mode: metadata.mode & 0o777,
      path: relative,
      sha256: await sha256(file),
      size: metadata.size,
    });
  }
  return files;
}

function expectedArchiveEntries(files) {
  const entries = new Set(["surf-ace-server"]);
  for (const { path: relative } of files) {
    const segments = relative.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      entries.add(`surf-ace-server/${segments.slice(0, index).join("/")}`);
    }
    entries.add(`surf-ace-server/${relative}`);
  }
  return [...entries].sort();
}

async function inspectArchive(archivePath, outputDir, manifestFiles) {
  const listed = (await capture("tar", ["-tzf", archivePath])).split("\n").filter(Boolean).sort();
  if (listed.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
    throw new Error("registry_server_archive_path_invalid");
  }
  const expected = expectedArchiveEntries(manifestFiles);
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    throw new Error(`registry_server_archive_entry_set_mismatch:${listed.join(",")}`);
  }

  const verifyRoot = await fs.mkdtemp(path.join(outputDir, ".verify-"));
  try {
    await run("tar", ["-xzf", archivePath, "-C", verifyRoot]);
    const extractedStage = path.join(verifyRoot, "surf-ace-server");
    await verifyTightbeamLinuxStage(extractedStage);
    const extractedFiles = await describeStageFiles(extractedStage);
    if (JSON.stringify(extractedFiles) !== JSON.stringify(manifestFiles)) {
      throw new Error("registry_server_archive_content_mismatch");
    }
    return extractedFiles;
  } finally {
    await removeIfExists(verifyRoot);
  }
}

export async function verifyRegistryServerRelease(outputDir) {
  const output = path.resolve(outputDir);
  const actualEntries = await fs.readdir(output, { withFileTypes: true });
  if (actualEntries.some((entry) => !entry.isFile())) {
    throw new Error("registry_server_output_contains_non_file_entry");
  }
  await assertExactPublicFiles(output, outputFiles);

  const manifestPath = path.join(output, REGISTRY_SERVER_RELEASE.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.formatVersion !== 1 || manifest.release?.version !== REGISTRY_SERVER_RELEASE.version ||
      manifest.release?.tag !== REGISTRY_SERVER_RELEASE.sourceTag ||
      manifest.source?.commit !== REGISTRY_SERVER_RELEASE.sourceCommit ||
      manifest.source?.tree !== REGISTRY_SERVER_RELEASE.sourceTree ||
      manifest.tooling?.tag !== REGISTRY_SERVER_RELEASE.toolingTag ||
      manifest.package?.asset?.name !== REGISTRY_SERVER_RELEASE.asset) {
    throw new Error("registry_server_manifest_identity_mismatch");
  }
  if (JSON.stringify(manifest.files?.map(({ path: relative }) => relative).sort()) !==
      JSON.stringify([...TIGHTBEAM_LINUX_SERVER_FILES].sort())) {
    throw new Error("registry_server_manifest_file_set_mismatch");
  }
  const migration = manifest.files.find(({ path: relative }) => relative === migrationPath);
  if (!migration || manifest.migration?.sha256 !== migration.sha256 || manifest.migration?.autoAppliedAtStartup !== false ||
      manifest.migration?.paneLabelReuseEnabledByDefault !== false) {
    throw new Error("registry_server_manifest_migration_boundary_mismatch");
  }

  const archivePath = path.join(output, REGISTRY_SERVER_RELEASE.asset);
  const archiveStat = await fs.stat(archivePath);
  const archiveHash = await sha256(archivePath);
  if (manifest.package.asset.size !== archiveStat.size || manifest.package.asset.sha256 !== archiveHash) {
    throw new Error("registry_server_manifest_archive_hash_mismatch");
  }
  await inspectArchive(archivePath, output, manifest.files);

  const expectedChecksums = [
    `${archiveHash}  ${REGISTRY_SERVER_RELEASE.asset}`,
    `${await sha256(manifestPath)}  ${REGISTRY_SERVER_RELEASE.manifest}`,
  ].sort().join("\n") + "\n";
  const actualChecksums = await fs.readFile(path.join(output, REGISTRY_SERVER_RELEASE.checksums), "utf8");
  if (actualChecksums !== expectedChecksums) throw new Error("registry_server_checksum_receipt_mismatch");
  return {
    asset: { name: REGISTRY_SERVER_RELEASE.asset, sha256: archiveHash, size: archiveStat.size },
    files: manifest.files,
    manifest: { name: REGISTRY_SERVER_RELEASE.manifest, sha256: await sha256(manifestPath) },
    checksums: { name: REGISTRY_SERVER_RELEASE.checksums, sha256: await sha256(path.join(output, REGISTRY_SERVER_RELEASE.checksums)) },
  };
}

async function assertToolchain() {
  const node = await capture("node", ["--version"], { cwd: toolingRoot });
  const pnpm = await capture("pnpm", ["--version"], { cwd: toolingRoot });
  const rustc = await capture("rustc", ["--version"], { cwd: toolingRoot });
  const cargo = await capture("cargo", ["--version"], { cwd: toolingRoot });
  if (node !== REGISTRY_SERVER_RELEASE.node || pnpm !== REGISTRY_SERVER_RELEASE.pnpm ||
      !rustc.startsWith(`rustc ${REGISTRY_SERVER_RELEASE.rust} `) ||
      !cargo.startsWith(`cargo ${REGISTRY_SERVER_RELEASE.rust} `)) {
    throw new Error(`registry_server_toolchain_mismatch:${JSON.stringify({ node, pnpm, rustc, cargo })}`);
  }
  return { cargo, node, pnpm, rustc };
}

export async function buildRegistryServerRelease({ sourceDir, outputDir, target = REGISTRY_SERVER_RELEASE.target }) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  if (target !== REGISTRY_SERVER_RELEASE.target) {
    throw new Error(`registry_server_target_mismatch:${target}`);
  }
  assertDisjointTrees(source, output);
  assertDisjointTrees(toolingRoot, source);
  assertDisjointTrees(toolingRoot, output);

  const sourceCommit = await capture("git", ["-C", source, "rev-parse", "HEAD"]);
  const sourceTree = await capture("git", ["-C", source, "rev-parse", "HEAD^{tree}"]);
  const toolingCommit = await capture("git", ["-C", toolingRoot, "rev-parse", "HEAD"]);
  const toolingTree = await capture("git", ["-C", toolingRoot, "rev-parse", "HEAD^{tree}"]);
  const toolingStatus = await capture("git", ["-C", toolingRoot, "status", "--porcelain", "--untracked-files=no"]);
  if (sourceCommit !== REGISTRY_SERVER_RELEASE.sourceCommit || sourceTree !== REGISTRY_SERVER_RELEASE.sourceTree) {
    throw new Error(`registry_server_source_identity_mismatch:${sourceCommit}:${sourceTree}`);
  }
  if (toolingStatus) throw new Error("registry_server_tooling_worktree_dirty");
  await assertTrackedInputsUnchanged(source);
  const toolchains = await assertToolchain();

  await fs.mkdir(output, { recursive: true });
  if ((await fs.readdir(output)).length !== 0) throw new Error("registry_server_output_directory_not_empty");
  const stageDir = path.join(output, ".linux-server-stage");
  const archivePath = path.join(output, REGISTRY_SERVER_RELEASE.asset);
  try {
    const epoch = await sourceDateEpoch(source);
    await buildTightbeamLinuxStage({ sourceDir: source, stageDir, target });
    const files = await describeStageFiles(stageDir);
    if (JSON.stringify(files.map(({ path: relative }) => relative).sort()) !==
        JSON.stringify([...TIGHTBEAM_LINUX_SERVER_FILES].sort())) {
      throw new Error("registry_server_stage_manifest_mismatch");
    }
    await createDirectoryTarGz(stageDir, "surf-ace-server", archivePath, epoch);
    const archiveStat = await fs.stat(archivePath);
    const archiveHash = await sha256(archivePath);
    const migration = files.find(({ path: relative }) => relative === migrationPath);
    if (!migration) throw new Error("registry_server_stage_migration_004_missing");

    const manifest = {
      build: {
        command: "node scripts/release/build-registry-server-release.mjs --source-dir <source> --output-dir <output>",
        epoch,
        target,
        toolchains,
      },
      files,
      formatVersion: 1,
      migration: {
        autoAppliedAtStartup: false,
        file: migrationPath,
        paneLabelReuseEnabledByDefault: false,
        sha256: migration.sha256,
      },
      package: {
        asset: { name: REGISTRY_SERVER_RELEASE.asset, sha256: archiveHash, size: archiveStat.size },
        kind: "registry-server-linux-x86_64",
      },
      release: { tag: REGISTRY_SERVER_RELEASE.sourceTag, version: REGISTRY_SERVER_RELEASE.version },
      source: { commit: sourceCommit, tree: sourceTree },
      tooling: { commit: toolingCommit, tag: REGISTRY_SERVER_RELEASE.toolingTag, tree: toolingTree },
    };
    const manifestPath = path.join(output, REGISTRY_SERVER_RELEASE.manifest);
    await writeCanonicalJson(manifestPath, manifest);
    const checksums = [
      `${archiveHash}  ${REGISTRY_SERVER_RELEASE.asset}`,
      `${await sha256(manifestPath)}  ${REGISTRY_SERVER_RELEASE.manifest}`,
    ].sort().join("\n") + "\n";
    await fs.writeFile(path.join(output, REGISTRY_SERVER_RELEASE.checksums), checksums);
    await removeIfExists(stageDir);
    const verification = await verifyRegistryServerRelease(output);
    await assertTrackedInputsUnchanged(source);
    return {
      outputDir: output,
      source: { commit: sourceCommit, tree: sourceTree },
      tooling: { commit: toolingCommit, tree: toolingTree },
      toolchains,
      verification,
    };
  } finally {
    await removeIfExists(stageDir);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2), ["source-dir", "output-dir"], ["target"]);
    const result = await buildRegistryServerRelease({
      sourceDir: args["source-dir"],
      outputDir: args["output-dir"],
      ...(args.target ? { target: args.target } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
