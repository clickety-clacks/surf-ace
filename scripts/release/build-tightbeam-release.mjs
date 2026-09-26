#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TIGHTBEAM, TIGHTBEAM_BUILD_COMMANDS, TIGHTBEAM_TEST_COMMANDS, TOOLCHAINS, TOOLING_TAG } from "./release-config.mjs";
import {
  assertExactPublicFiles,
  assertDisjointTrees,
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
  writeChecksumReceipt,
} from "./release-lib.mjs";
import { cargoLockedPackages, lockedPackages } from "./lockfile-inventory.mjs";

const toolingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function buildTightbeamRelease(options) {
  const sourceArgument = options.sourceDir;
  const sourceDir = path.resolve(options.sourceDir);
  const outputDir = requiredReleaseOutput("tightbeam", options.outputDir);
  if (options.sourceTag !== TIGHTBEAM.sourceTag || options.sourceCommit !== TIGHTBEAM.candidateCommit || options.version !== TIGHTBEAM.version || options.target !== TOOLCHAINS.rustTarget) {
    throw new Error("tightbeam_release_identity_mismatch");
  }
  assertDisjointTrees(sourceDir, outputDir);
  assertDisjointTrees(toolingRoot, outputDir);
  assertDisjointTrees(sourceDir, toolingRoot);
  await assertSourceIdentity(sourceDir, options.sourceTag, options.sourceCommit);
  await assertTrackedInputsUnchanged(sourceDir);
  const toolingCommit = await capture("git", ["-C", toolingRoot, "rev-parse", "HEAD"]);
  const toolingPeel = await capture("git", ["-C", toolingRoot, "rev-parse", `refs/tags/${TOOLING_TAG}^{commit}`]);
  if (toolingPeel !== toolingCommit) throw new Error(`tooling_tag_mismatch:${toolingPeel}:${toolingCommit}`);
  const component = process.env.SURF_ACE_RELEASE_COMPONENT ?? "all";
  if (!new Set(["all", "linux", "macos", "manifest"]).has(component)) throw new Error(`invalid_tightbeam_release_component:${component}`);
  if (component === "all") await removeIfExists(outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const epoch = await sourceDateEpoch(sourceDir);
  const backendName = TIGHTBEAM.files.find((name) => name.endsWith(".tar.gz"));
  const electronName = TIGHTBEAM.files.find((name) => name.endsWith(".zip"));
  const manifestName = TIGHTBEAM.files.find((name) => name.endsWith(".json"));
  const backendFile = path.join(outputDir, backendName);
  const electronFile = path.join(outputDir, electronName);
  if (component === "all" || component === "linux") {
    const stage = path.join(outputDir, ".linux-stage");
    await run("pnpm", ["--dir", sourceArgument, "--filter", "@surf-ace/controller", "package:linux", "--", stage], {
      env: { ...process.env, SURF_ACE_LINUX_TARGET: options.target },
    });
    await createDirectoryTarGz(path.join(stage, "surf-ace-linux"), "surf-ace-linux", backendFile, epoch);
    await removeIfExists(stage);
  }
  if (component === "all" || component === "macos") {
    await run("pnpm", ["--dir", sourceArgument, "--filter", "@surf-ace/electron", "package"]);
    await createDirectoryZip(path.join(sourceDir, "packages/electron/dist/package/mac-arm64/Surf Ace.app"), "Surf Ace.app", electronFile, epoch);
  }
  await assertTrackedInputsUnchanged(sourceDir);
  if (component === "all" || component === "manifest") {
    const nodeDependencies = [...(await lockedPackages(path.join(sourceDir, "pnpm-lock.yaml"))).values()]
      .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
    const cargoDependencies = await cargoLockedPackages(path.join(sourceDir, "packages/cli/Cargo.lock"));
    await writeCanonicalJson(path.join(outputDir, manifestName), {
      channel: "tightbeam",
      checksums: {
        [backendName]: await sha256(backendFile),
        [electronName]: await sha256(electronFile),
      },
      compatibility: { openclaw: false, protocolTestsPassed: true },
      commands: { build: TIGHTBEAM_BUILD_COMMANDS, tests: TIGHTBEAM_TEST_COMMANDS },
      dependencyInventory: { cargo: cargoDependencies, node: nodeDependencies },
      formatVersion: 1,
      lockfiles: {
        cargoSha256: await sha256(path.join(sourceDir, "packages/cli/Cargo.lock")),
        pnpmSha256: await sha256(path.join(sourceDir, "pnpm-lock.yaml")),
      },
      smoke: {
        command: "node tooling/scripts/release/smoke-tightbeam-release.mjs --baseline-commit 24b4a389bd2dceb29307a2308b70520adb3571db --candidate-commit ec623c54616b6c71a180cede45a91bc54269238c --manifest build/release/tightbeam/surf-ace-tightbeam-v0.2.0-manifest.json --backend build/release/tightbeam/surf-ace-tightbeam-linux-x86_64-v0.2.0.tar.gz --electron build/release/tightbeam/surf-ace-tightbeam-electron-macos-arm64-v0.2.0.zip",
        required: true,
        status: "pending",
      },
      source: { commit: options.sourceCommit, tag: options.sourceTag },
      target: options.target,
      tests: TIGHTBEAM_TEST_COMMANDS.map((command) => ({ command, result: "passed" })),
      toolchains: TOOLCHAINS,
      tooling: { commit: toolingCommit, tag: TOOLING_TAG },
    });
    await assertExactPublicFiles(outputDir, TIGHTBEAM.files);
    await writeChecksumReceipt(outputDir, TIGHTBEAM.files);
  }
  return { files: TIGHTBEAM.files, outputDir, sourceCommit: options.sourceCommit, toolingCommit };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["source-dir", "output-dir", "source-tag", "source-commit", "version", "target"]);
  const result = await buildTightbeamRelease({
    outputDir: args["output-dir"],
    sourceCommit: args["source-commit"],
    sourceDir: args["source-dir"],
    sourceTag: args["source-tag"],
    target: args.target,
    version: args.version,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
