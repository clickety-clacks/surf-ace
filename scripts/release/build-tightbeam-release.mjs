#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  assertDisjointTrees,
  assertExactPublicFiles,
  assertSourceIdentity,
  assertTrackedInputsUnchanged,
  capture,
  createDirectoryTarGz,
  createDirectoryZip,
  parseArgs,
  removeIfExists,
  requiredReleaseOutput,
  run,
  sha256,
  sourceDateEpoch,
  writeCanonicalJson,
} from "./release-lib.mjs";
import { cargoLockedPackages, workspaceProductionInventory } from "./lockfile-inventory.mjs";

const toolingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const TIGHTBEAM_LINUX_SERVER_FILES = Object.freeze([
  "docs/OPERATIONS.md",
  "README.md",
  "bin/surf-ace-server",
  "bin/surf-ace",
  "schemas/allocator/001_allocator.sql",
  "schemas/protocol/schema.json",
  "server/central-server.cjs",
  "service/surf-ace-server@.service",
]);
export const TIGHTBEAM_LINUX_RUNTIME_FILES = TIGHTBEAM_LINUX_SERVER_FILES;
export const TIGHTBEAM_CLI_FILES = Object.freeze(["README.md", "bin/surf-ace"]);

async function filesBelow(root) {
  const files = [];
  async function walk(directory, relative = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), child);
      else if (entry.isFile()) files.push(child);
      else throw new Error(`tightbeam_package_entry_unsupported:${child}`);
    }
  }
  await walk(root);
  return files.sort();
}

async function verifyExactStage(stageDir, expected, errorCode) {
  const stage = path.resolve(stageDir);
  const actual = await filesBelow(stage);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${errorCode}:${actual.join(",")}`);
  }
  return { files: actual, stageDir: stage };
}

export async function verifyTightbeamLinuxStage(stageDir) {
  const result = await verifyExactStage(stageDir, TIGHTBEAM_LINUX_SERVER_FILES, "tightbeam_linux_runtime_closure_mismatch");
  const binary = await fs.stat(path.join(result.stageDir, "bin/surf-ace"));
  if ((binary.mode & 0o111) === 0) throw new Error("tightbeam_linux_runtime_cli_not_executable");
  const launcher = await fs.stat(path.join(result.stageDir, "bin/surf-ace-server"));
  if ((launcher.mode & 0o111) === 0) throw new Error("tightbeam_linux_server_launcher_not_executable");
  const guide = await fs.readFile(path.join(result.stageDir, "README.md"), "utf8");
  if (!/startCentralServer\(config, name\)/.test(guide) || !/await service\.close\(\)/.test(guide)) {
    throw new Error("tightbeam_linux_lifecycle_documentation_missing");
  }
  if (!/already-provisioned PostgreSQL (?:16 )?custody/.test(guide)) throw new Error("tightbeam_linux_custody_contract_missing");
  if (!/foreground launcher/.test(guide) || !/does not install or enable a service/.test(guide)) {
    throw new Error("tightbeam_linux_foreground_service_boundary_missing");
  }
  const unit = await fs.readFile(path.join(result.stageDir, "service/surf-ace-server@.service"), "utf8");
  for (const line of [
    "Type=simple",
    "Restart=on-failure",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=30s",
    "UMask=0077",
    "RuntimeDirectoryMode=0750",
    "Environment=SURF_ACE_CLIENT_DIAGNOSTIC_LOG=/run/surf-ace-server/client-flight-recorder.log",
  ]) {
    if (!unit.split("\n").includes(line)) throw new Error(`tightbeam_linux_unit_contract_missing:${line}`);
  }
  if (!/ExecStart=.*bin\/surf-ace-server start --config /.test(unit)) {
    throw new Error("tightbeam_linux_unit_launcher_missing");
  }
  if (/^(?:ExecStartPre|ExecStartPost)=.*(?:systemctl|initdb|createdb|pg_restore)/m.test(unit)) {
    throw new Error("tightbeam_linux_unit_performs_provisioning");
  }
  const operations = await fs.readFile(path.join(result.stageDir, "docs/OPERATIONS.md"), "utf8");
  for (const pattern of [
    /PostgreSQL 16/,
    /pg_dump --format=custom/,
    /pg_restore --list/,
    /pg_restore --clean --if-exists --exit-on-error/,
    /staging cluster/i,
    /rollback target/i,
    /cacheStatus=current/,
    /consumableLoss=null/,
    /does not auto-migrate/,
  ]) {
    if (!pattern.test(operations)) throw new Error(`tightbeam_linux_operations_contract_missing:${pattern.source}`);
  }
  return result;
}

export async function verifyStandaloneElectronSource(sourceDir) {
  const packageJsonPath = path.join(sourceDir, "packages/electron/package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  if (packageJson.name !== "@surf-ace/electron" || !packageJson.dependencies || typeof packageJson.dependencies !== "object") {
    throw new Error("tightbeam_electron_package_identity_invalid");
  }
  return { packageJsonPath, packageName: packageJson.name };
}

export async function verifyTightbeamCliStage(stageDir) {
  const result = await verifyExactStage(stageDir, TIGHTBEAM_CLI_FILES, "tightbeam_cli_runtime_closure_mismatch");
  const binary = await fs.stat(path.join(result.stageDir, "bin/surf-ace"));
  if ((binary.mode & 0o111) === 0) throw new Error("tightbeam_cli_not_executable");
  const guide = await fs.readFile(path.join(result.stageDir, "README.md"), "utf8");
  if (!/does not start a\s+server or provision PostgreSQL/.test(guide)) {
    throw new Error("tightbeam_cli_server_boundary_missing");
  }
  return result;
}

const linuxServerReadme = [
  "# Surf Ace standalone Linux server and CLI",
  "",
  "This package provides the standalone `surf-ace` CLI, callable",
  "`server/central-server.cjs` module, foreground `bin/surf-ace-server` launcher,",
  "optional systemd unit template, and protocol/allocator schemas.",
  "The foreground launcher (`bin/surf-ace-server`) validates the existing server",
  "configuration, starts one owner,",
  "reports readiness without credentials and exposes a bounded WebSocket handshake health check at `/ws`,",
  "and closes on SIGTERM/SIGINT. It does not install or enable a service,",
  "provision PostgreSQL, or modify host services.",
  "",
  "The consumer supplies already-provisioned PostgreSQL 16 custody matching",
  "`schemas/allocator/001_allocator.sql`. The packaged server configuration",
  "uses the existing AllocatorServerConfig fields and a single owned host lock.",
  "The callable module remains available for embedding by one process owner:",
  "",
  "```js",
  'const { startCentralServer } = require("./server/central-server.cjs");',
  "const service = await startCentralServer(config, name);",
  "try {",
  "  // Use service.server.address.url while this owner retains custody.",
  "} finally {",
  "  await service.close();",
  "}",
  "```",
  "",
  "`config` is the existing AllocatorServerConfig, including one owned host lock",
  "and the existing PostgreSQL custody URLs. The package performs no database",
  "initialization or in-place schema migration. `docs/OPERATIONS.md` describes the",
  "PG16 backup, staged restore, validation, and rollback procedure. The systemd",
  "template is a file for operator review; the archive does not install it. A",
  "separate CLI-only archive is available for clients that do not own the server.",
  "",
].join("\n");

const cliReadme = (platform) => [
  `# Surf Ace standalone ${platform} CLI`,
  "",
  "This package contains only the standalone `surf-ace` CLI. It does not start a",
  "server or provision PostgreSQL, install a host service. Every command names",
  "its state root explicitly.",
  "",
  "Networked command endpoints are the target client's own WebSocket `/ws` URL.",
  "The CLI speaks directly to that client; it does not send pair or content",
  "operations to the registry/allocator endpoint. The product label is",
  "explicit on every network command:",
  "",
  "```sh",
  './bin/surf-ace --state-root /path/to/controller-state --endpoint "ws://<client-host>:<port>/ws" --product-label "Surf Ace" list',
  "```",
  "",
  "The central service owns client registration, global window-label allocation,",
  "and PostgreSQL-backed registry state. The Electron client registers to that",
  "service with `SURF_ACE_SERVER`; the CLI separately targets the Electron",
  "client endpoint for pair/list/capture/push/topology/read operations. The CLI",
  "is not a second registry server or a proxy through the central service.",
  "",
].join("\n");

async function copyExecutable(binary, stageDir) {
  const output = path.join(stageDir, "bin/surf-ace");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.copyFile(binary, output);
  await fs.chmod(output, 0o755);
}

export async function assembleTightbeamLinuxStage({ sourceDir, stageDir, target }) {
  const source = path.resolve(sourceDir);
  const stage = path.resolve(stageDir);
  const inputs = {
    "bin/surf-ace-server": path.join(toolingRoot, "scripts/release/tightbeam-server-launcher.cjs"),
    "docs/OPERATIONS.md": path.join(toolingRoot, "docs/release/tightbeam-linux-operations.md"),
    "schemas/allocator/001_allocator.sql": path.join(source, "packages/allocator/sql/001_allocator.sql"),
    "schemas/protocol/schema.json": path.join(source, "packages/electron/dist/schema.json"),
    "server/central-server.cjs": path.join(source, "packages/electron/dist/central-server.cjs"),
    "service/surf-ace-server@.service": path.join(toolingRoot, "scripts/release/templates/surf-ace-server@.service"),
  };
  await removeIfExists(stage);
  await fs.mkdir(stage, { recursive: true });
  await copyExecutable(path.join(source, "packages/cli/target", target, "release/surf-ace"), stage);
  for (const [relative, input] of Object.entries(inputs)) {
    const output = path.join(stage, relative);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(input, output);
  }
  await fs.chmod(path.join(stage, "bin/surf-ace-server"), 0o755);
  await fs.writeFile(path.join(stage, "README.md"), linuxServerReadme);
  return verifyTightbeamLinuxStage(stage);
}

export async function assembleTightbeamCliStage({ binary, stageDir, platform }) {
  const stage = path.resolve(stageDir);
  await removeIfExists(stage);
  await fs.mkdir(stage, { recursive: true });
  await copyExecutable(path.resolve(binary), stage);
  await fs.writeFile(path.join(stage, "README.md"), cliReadme(platform));
  return verifyTightbeamCliStage(stage);
}

export async function buildTightbeamLinuxStage({ sourceDir, stageDir, target = TOOLCHAINS.linuxRustTarget }) {
  const source = path.resolve(sourceDir);
  await verifyStandaloneElectronSource(source);
  await run("cargo", [
    "build", "--manifest-path", path.join(source, "packages/cli/Cargo.toml"),
    "--target-dir", path.join(source, "packages/cli/target"), "--release", "--locked", "--target", target,
  ]);
  await run("pnpm", ["--dir", source, "--filter", "@surf-ace/protocol", "build"]);
  await run("pnpm", ["--dir", source, "--filter", "@surf-ace/allocator", "build"]);
  await run("pnpm", ["--dir", source, "--filter", "@surf-ace/controller", "build"]);
  await run("pnpm", ["--dir", source, "--filter", "@surf-ace/electron", "build"]);
  return assembleTightbeamLinuxStage({ sourceDir: source, stageDir, target });
}

export async function buildTightbeamLinuxPackages({ sourceDir, outputDir, target = TOOLCHAINS.linuxRustTarget }) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  const epoch = await sourceDateEpoch(source);
  await verifyStandaloneElectronSource(source);

  const serverStage = path.join(output, ".linux-server-stage");
  await buildTightbeamLinuxStage({ sourceDir: source, stageDir: serverStage, target });
  const binary = path.join(source, "packages/cli/target", target, "release/surf-ace");
  const cliStage = path.join(output, ".linux-cli-stage");
  const serverArchive = path.join(output, TIGHTBEAM.assets[0]);
  const cliArchive = path.join(output, TIGHTBEAM.assets[1]);
  const electronArchive = path.join(output, TIGHTBEAM.assets[2]);
  await createDirectoryTarGz(serverStage, "surf-ace-server", serverArchive, epoch);
  await assembleTightbeamCliStage({ binary, stageDir: cliStage, platform: "Linux x86_64" });
  await createDirectoryTarGz(cliStage, "surf-ace-cli", cliArchive, epoch);
  await removeIfExists(serverStage);
  await removeIfExists(cliStage);

  await removeIfExists(path.join(source, "packages/electron/dist/package"));
  await run("pnpm", ["--dir", source, "--filter", "@surf-ace/electron", "exec", "electron-builder", "--linux", "dir", "--x64", "--publish", "never", "--config.executableName", "surf-ace", "--config.extraMetadata.version", TIGHTBEAM.version]);
  const electronRoot = path.join(source, "packages/electron/dist/package/linux-unpacked");
  await fs.access(path.join(electronRoot, "resources/app.asar"));
  await installLinuxElectronLauncher(electronRoot);
  await createDirectoryZip(electronRoot, "Surf Ace", electronArchive, epoch);
  await assertTrackedInputsUnchanged(source);
  return { files: TIGHTBEAM.assets.slice(0, 3), outputDir: output };
}

export async function buildTightbeamMacosPackages({ sourceDir, outputDir }) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  const epoch = await sourceDateEpoch(source);
  const target = TOOLCHAINS.macosRustTarget;
  await verifyStandaloneElectronSource(source);
  await run("cargo", [
    "build", "--manifest-path", path.join(source, "packages/cli/Cargo.toml"),
    "--target-dir", path.join(source, "packages/cli/target"), "--release", "--locked", "--target", target,
  ]);
  await run("pnpm", ["--dir", source, "--filter", "@surf-ace/protocol", "build"]);
  await run("pnpm", ["--dir", source, "--filter", "@surf-ace/controller", "build"]);
  await run("pnpm", ["--dir", source, "--filter", "@surf-ace/electron", "build"]);
  const cliStage = path.join(output, ".macos-cli-stage");
  const cliArchive = path.join(output, TIGHTBEAM.assets[3]);
  const electronArchive = path.join(output, TIGHTBEAM.assets[4]);
  await assembleTightbeamCliStage({
    binary: path.join(source, "packages/cli/target", target, "release/surf-ace"),
    stageDir: cliStage,
    platform: "macOS arm64",
  });
  await createDirectoryTarGz(cliStage, "surf-ace-cli", cliArchive, epoch);
  await removeIfExists(cliStage);
  await removeIfExists(path.join(source, "packages/electron/dist/package"));
  await run("pnpm", ["--dir", source, "--filter", "@surf-ace/electron", "exec", "electron-builder", "--mac", "dir", "--arm64", "--publish", "never", "--config.extraMetadata.version", TIGHTBEAM.version]);
  const app = path.join(source, "packages/electron/dist/package/mac-arm64/Surf Ace.app");
  await fs.access(path.join(app, "Contents/Resources/app.asar"));
  await createDirectoryZip(app, "Surf Ace.app", electronArchive, epoch);
  await assertTrackedInputsUnchanged(source);
  return { files: TIGHTBEAM.assets.slice(3, 5), outputDir: output };
}

const LINUX_ELECTRON_LAUNCHER = `#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$script_dir/surf-ace-bin" --no-sandbox "$@"
`;

export async function installLinuxElectronLauncher(electronRoot) {
  const root = path.resolve(electronRoot);
  const launcher = path.join(root, "surf-ace");
  const executable = path.join(root, "surf-ace-bin");
  const launcherStat = await fs.lstat(launcher).catch((error) => {
    if (error?.code === "ENOENT") throw new Error("tightbeam_linux_electron_executable_missing");
    throw error;
  });
  if (!launcherStat.isFile()) throw new Error("tightbeam_linux_electron_executable_invalid");
  try {
    await fs.lstat(executable);
    throw new Error("tightbeam_linux_electron_binary_collision");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.rename(launcher, executable);
  try {
    await fs.writeFile(launcher, LINUX_ELECTRON_LAUNCHER, { mode: 0o755, flag: "wx" });
    await fs.chmod(launcher, 0o755);
  } catch (error) {
    await fs.rm(launcher, { force: true });
    await fs.rename(executable, launcher);
    throw error;
  }
  return launcher;
}

export async function writeTightbeamManifest({ sourceDir, outputDir, toolingCommit }) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  await verifyStandaloneElectronSource(source);
  const assetDetails = [];
  for (const name of TIGHTBEAM.assets) {
    const file = path.join(output, name);
    const info = await fs.stat(file);
    if (!info.isFile() || info.size === 0) throw new Error(`tightbeam_asset_missing_or_empty:${name}`);
    assetDetails.push({ name, sha256: await sha256(file), sizeBytes: info.size });
  }
  const nodeDependencies = await workspaceProductionInventory(path.join(source, "pnpm-lock.yaml"), "packages/electron");
  const cargoDependencies = await cargoLockedPackages(path.join(source, "packages/cli/Cargo.lock"));
  const manifestPath = path.join(output, TIGHTBEAM.manifest);
  await writeCanonicalJson(manifestPath, {
    acceptance: {
      clientRegistration: "electron-client-to-registry",
      clientOperations: TIGHTBEAM_ROUTING.clientOperations,
      publicationEligible: false,
      registryResponsibilities: TIGHTBEAM_ROUTING.registryResponsibilities,
      securityBoundary: TIGHTBEAM_ROUTING.securityBoundary,
      status: "pending-separate-smoke-and-operator-approval",
      stateTranslation: false,
    },
    assets: assetDetails,
    channel: "tightbeam-standalone",
    checksums: Object.fromEntries(assetDetails.map(({ name, sha256: digest }) => [name, digest])),
    commands: { build: TIGHTBEAM_BUILD_COMMANDS, tests: TIGHTBEAM_TEST_COMMANDS },
    dependencyInventory: { cargo: cargoDependencies, node: nodeDependencies },
    formatVersion: 2,
    lockfiles: {
      cargoSha256: await sha256(path.join(source, "packages/cli/Cargo.lock")),
      pnpmSha256: await sha256(path.join(source, "pnpm-lock.yaml")),
    },
    source: { commit: TIGHTBEAM.candidateCommit, tag: TIGHTBEAM.sourceTag },
    toolchains: TOOLCHAINS,
    tooling: { commit: toolingCommit, tag: TIGHTBEAM_TOOLING_TAG },
    version: TIGHTBEAM.version,
  });
  const checksumNames = [...TIGHTBEAM.assets, TIGHTBEAM.manifest].sort();
  const lines = [];
  for (const name of checksumNames) lines.push(`${await sha256(path.join(output, name))}  ${name}`);
  await fs.writeFile(path.join(output, TIGHTBEAM.checksums), `${lines.join("\n")}\n`);
  await assertExactPublicFiles(output, TIGHTBEAM_PUBLIC_FILES);
  return { files: TIGHTBEAM_PUBLIC_FILES, manifestPath };
}

export function assertTightbeamLinuxQualificationClaims({ sourceCommit, toolingCommit, version, target }) {
  if (sourceCommit !== TIGHTBEAM.candidateCommit || version !== TIGHTBEAM.version || target !== TOOLCHAINS.linuxRustTarget) {
    throw new Error("tightbeam_linux_qualification_identity_mismatch");
  }
  if (!/^[a-f0-9]{40}$/.test(toolingCommit ?? "")) {
    throw new Error("tightbeam_linux_qualification_tooling_commit_invalid");
  }
}

async function ensureEmptyQualificationOutput(outputDir) {
  try {
    const metadata = await fs.lstat(outputDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`tightbeam_linux_qualification_output_not_directory:${outputDir}`);
    }
    const entries = await fs.readdir(outputDir);
    if (entries.length > 0) throw new Error(`tightbeam_linux_qualification_output_not_empty:${outputDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function buildTightbeamLinuxQualification(options, dependencies = {}) {
  if (process.env.SURF_ACE_RELEASE_COMPONENT !== "linux") {
    throw new Error("tightbeam_linux_qualification_requires_linux_component");
  }
  if (!path.isAbsolute(options.outputDir ?? "")) {
    throw new Error("tightbeam_linux_qualification_output_must_be_absolute");
  }
  assertTightbeamLinuxQualificationClaims(options);

  const sourceDir = path.resolve(options.sourceDir);
  const outputDir = path.resolve(options.outputDir);
  const currentToolingRoot = path.resolve(dependencies.toolingRoot ?? toolingRoot);
  const captureCommand = dependencies.capture ?? capture;
  const cleanInputs = dependencies.assertTrackedInputsUnchanged ?? assertTrackedInputsUnchanged;
  const buildLinuxPackages = dependencies.buildLinuxPackages ?? buildTightbeamLinuxPackages;

  assertDisjointTrees(sourceDir, outputDir);
  assertDisjointTrees(currentToolingRoot, outputDir);
  assertDisjointTrees(sourceDir, currentToolingRoot);

  const sourceHead = await captureCommand("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  if (sourceHead !== options.sourceCommit) throw new Error(`source_commit_mismatch:${sourceHead}:${options.sourceCommit}`);
  const toolingHead = await captureCommand("git", ["-C", currentToolingRoot, "rev-parse", "HEAD"]);
  if (toolingHead !== options.toolingCommit) throw new Error(`tooling_commit_mismatch:${toolingHead}:${options.toolingCommit}`);

  await cleanInputs(sourceDir);
  await cleanInputs(currentToolingRoot);
  await ensureEmptyQualificationOutput(outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const assets = await buildLinuxPackages({ sourceDir, outputDir, target: options.target });
  await cleanInputs(sourceDir);
  await cleanInputs(currentToolingRoot);
  const sourceHeadAfter = await captureCommand("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  if (sourceHeadAfter !== sourceHead) throw new Error(`source_commit_changed_during_qualification:${sourceHead}:${sourceHeadAfter}`);
  const toolingHeadAfter = await captureCommand("git", ["-C", currentToolingRoot, "rev-parse", "HEAD"]);
  if (toolingHeadAfter !== toolingHead) throw new Error(`tooling_commit_changed_during_qualification:${toolingHead}:${toolingHeadAfter}`);
  return {
    ...assets,
    qualificationOnly: true,
    releaseAdmitted: false,
    sourceCommit: sourceHead,
    toolingCommit: toolingHead,
  };
}

export async function buildTightbeamRelease(options) {
  const sourceArgument = options.sourceDir;
  const sourceDir = path.resolve(sourceArgument);
  const outputDir = requiredReleaseOutput("tightbeam", options.outputDir);
  if (options.sourceTag !== TIGHTBEAM.sourceTag || options.sourceCommit !== TIGHTBEAM.candidateCommit ||
      options.version !== TIGHTBEAM.version || (options.target && options.target !== TOOLCHAINS.linuxRustTarget)) {
    throw new Error("tightbeam_release_identity_mismatch");
  }
  assertDisjointTrees(sourceDir, outputDir);
  assertDisjointTrees(toolingRoot, outputDir);
  assertDisjointTrees(sourceDir, toolingRoot);
  await assertSourceIdentity(sourceDir, options.sourceTag, options.sourceCommit);
  await assertTrackedInputsUnchanged(sourceDir);
  const toolingCommit = await capture("git", ["-C", toolingRoot, "rev-parse", "HEAD"]);
  const toolingPeel = await capture("git", ["-C", toolingRoot, "rev-parse", `refs/tags/${TIGHTBEAM_TOOLING_TAG}^{commit}`]);
  if (toolingPeel !== toolingCommit) throw new Error(`tooling_tag_mismatch:${toolingPeel}:${toolingCommit}`);
  const component = process.env.SURF_ACE_RELEASE_COMPONENT;
  if (!["linux", "macos", "manifest"].includes(component)) {
    throw new Error(`invalid_or_missing_tightbeam_release_component:${component ?? "<missing>"}`);
  }
  await fs.mkdir(outputDir, { recursive: true });
  if (component === "linux") {
    return { ...await buildTightbeamLinuxPackages({ sourceDir: sourceArgument, outputDir, target: options.target ?? TOOLCHAINS.linuxRustTarget }), sourceCommit: options.sourceCommit, toolingCommit };
  }
  if (component === "macos") {
    return { ...await buildTightbeamMacosPackages({ sourceDir: sourceArgument, outputDir }), sourceCommit: options.sourceCommit, toolingCommit };
  }
  const manifest = await writeTightbeamManifest({
    outputDir,
    sourceDir,
    toolingCommit,
  });
  return { ...manifest, outputDir, sourceCommit: options.sourceCommit, toolingCommit };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["source-dir", "output-dir", "version"], ["qualification-only", "source-tag", "source-commit", "tooling-commit", "target"]);
  let result;
  if (args["qualification-only"] !== undefined) {
    if (args["qualification-only"] !== "linux" || args["source-tag"] !== undefined) {
      throw new Error("invalid_tightbeam_qualification_arguments");
    }
    result = await buildTightbeamLinuxQualification({
      outputDir: args["output-dir"],
      sourceCommit: args["source-commit"],
      sourceDir: args["source-dir"],
      target: args.target,
      toolingCommit: args["tooling-commit"],
      version: args.version,
    });
  } else {
    if (!args["source-tag"] || !args["source-commit"] || args["tooling-commit"] !== undefined) {
      throw new Error("missing_or_invalid_tightbeam_release_identity_arguments");
    }
    result = await buildTightbeamRelease({
      outputDir: args["output-dir"],
      sourceCommit: args["source-commit"],
      sourceDir: args["source-dir"],
      sourceTag: args["source-tag"],
      target: args.target,
      version: args.version,
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
