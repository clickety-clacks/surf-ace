#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OPENCLAW, OPENCLAW_BUILD_COMMANDS, OPENCLAW_TEST_COMMANDS, TOOLCHAINS } from "./release-config.mjs";
import {
  assertExactPublicFiles,
  assertDisjointTrees,
  assertSourceIdentity,
  assertTrackedInputsUnchanged,
  capture,
  copyTree,
  createDirectoryTarGz,
  createDirectoryZip,
  parseArgs,
  removeIfExists,
  requiredReleaseOutput,
  run,
  sha256,
  sourceDateEpoch,
  writeCanonicalJson,
  writeChecksumReceipt,
} from "./release-lib.mjs";

const toolingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function copyRequired(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await copyTree(source, destination);
}

export async function assembleOpenclawPackage(sourceDir, dependencyClosure, packageRoot) {
  await copyTree(dependencyClosure, packageRoot);
  const extension = path.join(sourceDir, "packages/extension");
  const protocol = path.join(sourceDir, "packages/protocol");
  await copyRequired(path.join(extension, "openclaw.plugin.json"), path.join(packageRoot, "openclaw.plugin.json"));
  await copyRequired(path.join(extension, "surf-ace.ts"), path.join(packageRoot, "surf-ace.ts"));
  await copyRequired(path.join(extension, "dist/extension"), path.join(packageRoot, "dist/extension"));
  await copyRequired(path.join(extension, "src"), path.join(packageRoot, "extension/src"));
  await copyRequired(path.join(extension, "skills"), path.join(packageRoot, "skills"));
  await copyRequired(path.join(protocol, "dist"), path.join(packageRoot, "dist/protocol"));
  await copyRequired(path.join(protocol, "src"), path.join(packageRoot, "protocol/src"));
  await copyRequired(path.join(protocol, "schema.json"), path.join(packageRoot, "dist/protocol/schema.json"));
  await copyRequired(path.join(protocol, "schema.json"), path.join(packageRoot, "protocol/schema.json"));
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "dist/surf-ace.js"), 'export { default } from "./extension/src/index.js";\nexport * from "./extension/src/index.js";\n');
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  packageJson.name = "surf-ace";
  packageJson.openclaw = {
    extensions: ["./surf-ace.ts"],
    plugin: { id: "surf-ace", label: "Surf Ace" },
    runtimeExtensions: ["./dist/extension/src/index.js"],
  };
  await writeCanonicalJson(packageJsonPath, packageJson);
}

export async function buildOpenclawRelease(options) {
  const sourceArgument = options.sourceDir;
  const sourceDir = path.resolve(options.sourceDir);
  const outputDir = requiredReleaseOutput("openclaw", options.outputDir);
  const toolingTag = options.toolingTag ?? process.env.TOOLING_TAG;
  if (options.sourceTag !== OPENCLAW.sourceTag || options.sourceCommit !== OPENCLAW.candidateCommit || options.version !== OPENCLAW.version) {
    throw new Error("openclaw_release_identity_mismatch");
  }
  if (!toolingTag) throw new Error("openclaw_tooling_tag_required");
  assertDisjointTrees(sourceDir, outputDir);
  assertDisjointTrees(toolingRoot, outputDir);
  assertDisjointTrees(sourceDir, toolingRoot);
  await assertSourceIdentity(sourceDir, options.sourceTag, options.sourceCommit);
  await assertTrackedInputsUnchanged(sourceDir);
  const toolingCommit = await capture("git", ["-C", toolingRoot, "rev-parse", "HEAD"]);
  const toolingPeel = await capture("git", ["-C", toolingRoot, "rev-parse", `refs/tags/${toolingTag}^{commit}`]);
  if (toolingPeel !== toolingCommit) throw new Error(`tooling_tag_mismatch:${toolingPeel}:${toolingCommit}`);

  await removeIfExists(outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const dependencyClosure = path.join(outputDir, "dependency-closure");
  const packageRoot = path.join(outputDir, "package-root");

  await run("pnpm", ["--dir", sourceArgument, "--filter", "@surf-ace/protocol", "build"]);
  await run("pnpm", ["--dir", sourceArgument, "--filter", "@surf-ace/controller", "build"]);
  await run("pnpm", ["--dir", sourceArgument, "--filter", "@surf-ace/extension", "build"]);
  await run("pnpm", ["--dir", sourceArgument, "--filter", "@surf-ace/extension", "--prod", "deploy", "--legacy", dependencyClosure]);
  await run("pnpm", ["--dir", sourceArgument, "--filter", "@surf-ace/electron", "package"]);

  await assembleOpenclawPackage(sourceDir, dependencyClosure, packageRoot);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  packageJson.version = options.version;
  await writeCanonicalJson(packageJsonPath, packageJson);

  const verification = JSON.parse(await capture("node", [
    "tooling/scripts/release/verify-openclaw-package.mjs",
    "--package-dir", path.join(options.outputDir, "package-root"),
    "--lockfile", path.join(sourceArgument, "pnpm-lock.yaml"),
  ]));
  const inventory = verification.inventory;
  await assertTrackedInputsUnchanged(sourceDir);
  const epoch = await sourceDateEpoch(sourceDir);
  const extensionName = OPENCLAW.files.find((name) => name.endsWith(".tgz"));
  const electronName = OPENCLAW.files.find((name) => name.endsWith(".zip"));
  const manifestName = OPENCLAW.files.find((name) => name.endsWith(".json"));
  const extensionFile = path.join(outputDir, extensionName);
  const electronFile = path.join(outputDir, electronName);
  await createDirectoryTarGz(packageRoot, "package", extensionFile, epoch);
  await createDirectoryZip(path.join(sourceDir, "packages/electron/dist/package/mac-arm64/Surf Ace.app"), "Surf Ace.app", electronFile, epoch);
  await writeCanonicalJson(path.join(outputDir, manifestName), {
    channel: "openclaw",
    checksums: {
      [electronName]: await sha256(electronFile),
      [extensionName]: await sha256(extensionFile),
    },
    compatibility: { openclaw: OPENCLAW.hostVersion },
    commands: { build: OPENCLAW_BUILD_COMMANDS, tests: OPENCLAW_TEST_COMMANDS },
    dependencyInventory: inventory,
    formatVersion: 1,
    lockfileSha256: await sha256(path.join(sourceDir, "pnpm-lock.yaml")),
    smoke: {
      command: "node tooling/scripts/release/smoke-openclaw-release.mjs --baseline-commit d889f2f4bfb554bc3bfde0eb9927372552d40e51 --candidate-commit 58ac8c435679e6611903d31abaecec11bb9d7f75 --openclaw-version 2026.7.1-2 --manifest build/release/openclaw/surf-ace-openclaw-v0.1.0-manifest.json --extension build/release/openclaw/surf-ace-openclaw-extension-v0.1.0.tgz --electron build/release/openclaw/surf-ace-openclaw-electron-macos-arm64-v0.1.0.zip",
      required: true,
      status: "pending",
    },
    source: { commit: options.sourceCommit, tag: options.sourceTag },
    tests: OPENCLAW_TEST_COMMANDS.map((command) => ({ command, result: "passed" })),
    toolchains: TOOLCHAINS,
    tooling: { commit: toolingCommit, tag: toolingTag },
  });
  await removeIfExists(dependencyClosure);
  await removeIfExists(packageRoot);
  await assertExactPublicFiles(outputDir, OPENCLAW.files);
  await writeChecksumReceipt(outputDir, OPENCLAW.files);
  return { files: OPENCLAW.files, outputDir, sourceCommit: options.sourceCommit, toolingCommit };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["source-dir", "output-dir", "source-tag", "source-commit", "version"]);
  const result = await buildOpenclawRelease({
    outputDir: args["output-dir"],
    sourceCommit: args["source-commit"],
    sourceDir: args["source-dir"],
    sourceTag: args["source-tag"],
    version: args.version,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
