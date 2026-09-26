#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assembleOpenclawPackage } from "./build-openclaw-release.mjs";
import { buildTightbeamLinuxStage } from "./build-tightbeam-release.mjs";
import { assertDisjointTrees, assertTrackedInputsUnchanged, capture, createDirectoryTarGz, createDirectoryZip, parseArgs, removeIfExists, run, sourceDateEpoch } from "./release-lib.mjs";
import { verifyOpenclawPackage } from "./verify-openclaw-package.mjs";

export async function buildSmokeBaseline(options) {
  const sourceDir = path.resolve(options.sourceDir);
  const outputDir = path.resolve(options.outputDir);
  assertDisjointTrees(sourceDir, outputDir);
  const head = await capture("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  if (head !== options.sourceCommit) throw new Error(`baseline_source_commit_mismatch:${head}:${options.sourceCommit}`);
  await assertTrackedInputsUnchanged(sourceDir);
  await removeIfExists(outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const epoch = await sourceDateEpoch(sourceDir);
  if (options.component === "openclaw") {
    const closure = path.join(outputDir, ".dependency-closure");
    const packageRoot = path.join(outputDir, ".package-root");
    await run("pnpm", ["--dir", sourceDir, "--filter", "@surf-ace/protocol", "build"]);
    await run("pnpm", ["--dir", sourceDir, "--filter", "@surf-ace/controller", "build"]);
    await run("pnpm", ["--dir", sourceDir, "--filter", "@surf-ace/extension", "build"]);
    await run("pnpm", ["--dir", sourceDir, "--filter", "@surf-ace/extension", "--prod", "deploy", "--legacy", closure]);
    await run("pnpm", ["--dir", sourceDir, "--filter", "@surf-ace/electron", "package"]);
    await assembleOpenclawPackage(sourceDir, closure, packageRoot);
    await verifyOpenclawPackage(
      packageRoot,
      path.join(sourceDir, "pnpm-lock.yaml"),
      path.join(sourceDir, "packages/extension/scripts/verify-openclaw-package.mjs"),
    );
    await createDirectoryTarGz(packageRoot, "package", path.join(outputDir, "baseline-extension.tgz"), epoch);
    await createDirectoryZip(path.join(sourceDir, "packages/electron/dist/package/mac-arm64/Surf Ace.app"), "Surf Ace.app", path.join(outputDir, "baseline-electron.zip"), epoch);
  } else if (options.component === "tightbeam-linux") {
    if (!options.target) throw new Error("tightbeam_baseline_target_required");
    const stage = path.join(outputDir, ".stage");
    await buildTightbeamLinuxStage({ sourceDir, stageDir: stage, target: options.target });
    await createDirectoryTarGz(stage, "surf-ace-linux", path.join(outputDir, "baseline-backend.tar.gz"), epoch);
    await removeIfExists(stage);
  } else if (options.component === "tightbeam-macos") {
    const stagedSource = path.join(outputDir, ".macos-source");
    const stagedArchive = path.join(outputDir, ".macos-source.tar");
    const stagedPackage = path.join(outputDir, ".macos-package");
    await run("git", ["-C", sourceDir, "archive", "--format=tar", `--output=${stagedArchive}`, head]);
    await fs.mkdir(stagedSource, { recursive: true });
    await run("tar", ["-xf", stagedArchive, "-C", stagedSource]);
    await fs.rm(stagedArchive);
    await run("pnpm", ["--dir", stagedSource, "install", "--offline", "--frozen-lockfile"]);
    await run("pnpm", ["--dir", stagedSource, "--filter", "@surf-ace/electron", "build"]);
    await run("pnpm", [
      "--dir", stagedSource,
      "--filter", "@surf-ace/electron",
      "exec", "electron-builder",
      "--mac", "dir", "--arm64",
      `--config.directories.output=${stagedPackage}`,
    ]);
    const app = path.join(stagedPackage, "mac-arm64/Surf Ace.app");
    const nestedPackage = path.join(app, "Contents/Resources/app/dist/package");
    try {
      await fs.access(nestedPackage);
      throw new Error("tightbeam_baseline_macos_recursive_package");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await createDirectoryZip(app, "Surf Ace.app", path.join(outputDir, "baseline-electron.zip"), epoch);
    await removeIfExists(stagedSource);
    await removeIfExists(stagedPackage);
  } else {
    throw new Error(`unknown_baseline_component:${options.component}`);
  }
  await assertTrackedInputsUnchanged(sourceDir);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["component", "source-dir", "output-dir", "source-commit"], ["target"]);
  await buildSmokeBaseline({
    component: args.component,
    outputDir: args["output-dir"],
    sourceCommit: args["source-commit"],
    sourceDir: args["source-dir"],
    target: args.target,
  });
  process.stdout.write(`${JSON.stringify({ component: args.component, status: "built" })}\n`);
}
