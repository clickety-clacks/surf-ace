#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assembleOpenclawPackage } from "./build-openclaw-release.mjs";
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
    const stage = path.join(outputDir, ".stage");
    await run("pnpm", ["--dir", sourceDir, "--filter", "@surf-ace/controller", "package:linux", "--", stage]);
    await createDirectoryTarGz(path.join(stage, "surf-ace-linux"), "surf-ace-linux", path.join(outputDir, "baseline-backend.tar.gz"), epoch);
    await removeIfExists(stage);
  } else if (options.component === "tightbeam-macos") {
    await run("pnpm", ["--dir", sourceDir, "--filter", "@surf-ace/electron", "package"]);
    await createDirectoryZip(path.join(sourceDir, "packages/electron/dist/package/mac-arm64/Surf Ace.app"), "Surf Ace.app", path.join(outputDir, "baseline-electron.zip"), epoch);
  } else {
    throw new Error(`unknown_baseline_component:${options.component}`);
  }
  await assertTrackedInputsUnchanged(sourceDir);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["component", "source-dir", "output-dir", "source-commit"]);
  await buildSmokeBaseline({
    component: args.component,
    outputDir: args["output-dir"],
    sourceCommit: args["source-commit"],
    sourceDir: args["source-dir"],
  });
  process.stdout.write(`${JSON.stringify({ component: args.component, status: "built" })}\n`);
}
