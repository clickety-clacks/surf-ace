#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OPENCLAW, TOOLING_TAG } from "./release-config.mjs";
import { capture, parseArgs, removeIfExists, run, verifyManifestFiles, writeCanonicalJson } from "./release-lib.mjs";
import { electronHandshake, start, stop, waitForCommand } from "./smoke-lib.mjs";
import { verifySri } from "./verify-sri.mjs";

async function installHost(root) {
  const fetchDir = path.join(root, "openclaw-fetch");
  const prefix = path.join(root, "openclaw-prefix");
  await fs.mkdir(fetchDir, { recursive: true });
  await fs.mkdir(prefix, { recursive: true });
  await run("npm", ["pack", "--pack-destination", fetchDir, `openclaw@${OPENCLAW.hostVersion}`]);
  const archive = path.join(fetchDir, `openclaw-${OPENCLAW.hostVersion}.tgz`);
  await verifySri(archive, OPENCLAW.hostIntegrity);
  await run("npm", ["install", "--global", "--prefix", prefix, archive]);
  const openclaw = path.join(prefix, "bin/openclaw");
  const reportedVersion = await capture(openclaw, ["--version"], { env: { ...process.env, HOME: path.join(root, "home") } });
  if (!new RegExp(`(^|\\s)${OPENCLAW.hostVersion.replaceAll(".", "\\.")}($|\\s)`).test(reportedVersion)) {
    throw new Error("openclaw_host_version_mismatch");
  }
  return { openclaw, prefix };
}

async function verifyRuntime(openclaw, home) {
  await waitForCommand(openclaw, ["gateway", "status", "--deep", "--require-rpc"], { env: { ...process.env, HOME: home } });
  const { stdout } = await (async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    return promisify(execFile)(openclaw, ["plugins", "inspect", "surf-ace", "--runtime", "--json"], { env: { ...process.env, HOME: home } });
  })();
  const inspection = JSON.parse(stdout);
  const tools = inspection.tools ?? inspection.runtime?.tools ?? [];
  if (inspection.enabled !== true || (inspection.runtimeLoaded ?? inspection.loaded) !== true || !tools.includes("surf_ace_list") || inspection.diagnostic) {
    throw new Error(`openclaw_plugin_runtime_invalid:${stdout}`);
  }
}

async function installExtension(openclaw, home, archive) {
  await run(openclaw, ["plugins", "install", archive, "--force"], { env: { ...process.env, HOME: home } });
  await run(openclaw, ["plugins", "enable", "surf-ace"], { env: { ...process.env, HOME: home } });
  await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
  await writeCanonicalJson(path.join(home, ".openclaw/openclaw.json"), {
    plugins: { allow: ["surf-ace"], entries: { "surf-ace": { enabled: true } } },
    tools: { alsoAllow: ["surf-ace"], profile: "coding" },
  });
}

async function gatewayState(root, openclaw, extension, electron, port) {
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  await installExtension(openclaw, home, extension);
  const gateway = start(openclaw, ["gateway", "--port", "18789", "--verbose"], {
    env: { ...process.env, HOME: home, SURF_ACE_ALLOW_NON_TARS_PROVIDER: "1" },
  });
  try {
    await verifyRuntime(openclaw, home);
    const appDir = path.join(root, "electron");
    await removeIfExists(appDir);
    await fs.mkdir(appDir, { recursive: true });
    await run("unzip", ["-q", electron, "-d", appDir]);
    await electronHandshake(path.join(appDir, "Surf Ace.app/Contents/MacOS/Surf Ace"), home, port);
    return { home, openclaw };
  } finally {
    await stop(gateway);
  }
}

async function gatewayScenario(root, states) {
  await fs.mkdir(path.join(root, "home"), { recursive: true });
  const { openclaw } = await installHost(root);
  try {
    for (const state of states) await gatewayState(root, openclaw, state.extension, state.electron, state.port);
  } finally {
    await removeIfExists(root);
  }
}

export async function smokeOpenclaw(options) {
  if (options.baselineCommit !== OPENCLAW.baselineCommit || options.candidateCommit !== OPENCLAW.candidateCommit || options.openclawVersion !== OPENCLAW.hostVersion) {
    throw new Error("openclaw_smoke_identity_mismatch");
  }
  const manifest = await verifyManifestFiles(options.manifest, { electron: options.electron, extension: options.extension });
  if (manifest.source?.commit !== options.candidateCommit || manifest.source?.tag !== OPENCLAW.sourceTag || manifest.tooling?.tag !== TOOLING_TAG) {
    throw new Error("openclaw_smoke_manifest_identity_mismatch");
  }
  const baselineExtension = process.env.SURF_ACE_OPENCLAW_BASELINE_EXTENSION;
  const baselineElectron = process.env.SURF_ACE_OPENCLAW_BASELINE_ELECTRON;
  if (!baselineExtension || !baselineElectron) throw new Error("openclaw_smoke_baseline_artifacts_required");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-openclaw-smoke-"));
  try {
    await gatewayScenario(path.join(root, "clean"), [
      { electron: options.electron, extension: options.extension, port: 19051 },
    ]);
    await gatewayScenario(path.join(root, "upgrade"), [
      { electron: baselineElectron, extension: baselineExtension, port: 19052 },
      { electron: options.electron, extension: options.extension, port: 19053 },
    ]);
    await gatewayScenario(path.join(root, "rollback"), [
      { electron: baselineElectron, extension: baselineExtension, port: 19054 },
      { electron: options.electron, extension: options.extension, port: 19055 },
      { electron: baselineElectron, extension: baselineExtension, port: 19056 },
    ]);
    return { candidateCommit: options.candidateCommit, phases: ["clean-install", "upgrade", "rollback"], status: "passed" };
  } finally {
    await removeIfExists(root);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["baseline-commit", "candidate-commit", "openclaw-version", "manifest", "extension", "electron"]);
  const result = await smokeOpenclaw({
    baselineCommit: args["baseline-commit"],
    candidateCommit: args["candidate-commit"],
    electron: path.resolve(args.electron),
    extension: path.resolve(args.extension),
    manifest: path.resolve(args.manifest),
    openclawVersion: args["openclaw-version"],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
