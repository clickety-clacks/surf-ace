#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TIGHTBEAM, TOOLING_TAG } from "./release-config.mjs";
import { parseArgs, removeIfExists, run, verifyManifestFiles } from "./release-lib.mjs";
import { electronHandshake, start, stop, waitForCommand } from "./smoke-lib.mjs";

async function installArchive(archive, installRoot) {
  await removeIfExists(installRoot);
  await fs.mkdir(installRoot, { recursive: true });
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-tightbeam-unpack-"));
  try {
    await run("tar", ["-xzf", archive, "-C", staging]);
    const roots = (await fs.readdir(staging, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (roots.length !== 1) throw new Error("tightbeam_archive_root_invalid");
    await fs.cp(path.join(staging, roots[0].name), installRoot, { recursive: true });
  } finally {
    await removeIfExists(staging);
  }
}

async function linuxHealth(installRoot, stateRoot) {
  if (installRoot !== "/opt/surf-ace") throw new Error(`tightbeam_install_path_mismatch:${installRoot}`);
  await run("systemd-analyze", ["verify", "/opt/surf-ace/surf-ace-controller.service"]);
  const runtimeDir = path.join(stateRoot, "runtime");
  const home = path.join(stateRoot, "home");
  const socket = path.join(runtimeDir, "surf-ace/controller.sock");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(path.join(home, ".config/@surf-ace/electron/controller"), { recursive: true });
  const supervisor = start(path.join(installRoot, "surf-ace-runtime"), [], {
    env: {
      ...process.env,
      HOME: home,
      SURF_ACE_CLIENT_COMMAND: "tail -f /dev/null",
      SURF_ACE_CONTROLLER_SOCKET: socket,
      XDG_RUNTIME_DIR: runtimeDir,
    },
  });
  try {
    const list = await waitForCommand(path.join(installRoot, "bin/surf-ace"), ["--socket", socket, "list", "--input-json", "{}"]);
    const response = JSON.parse(list.stdout.trim().split("\n").at(-1));
    if (response.ok !== true) throw new Error(`tightbeam_list_health_failed:${list.stdout}`);
    if (supervisor.child.exitCode !== null) throw new Error(`tightbeam_supervisor_exited:${supervisor.output().stderr}`);
    const childIds = (await fs.readFile(`/proc/${supervisor.child.pid}/task/${supervisor.child.pid}/children`, "utf8"))
      .trim().split(/\s+/).filter(Boolean);
    const controllers = [];
    for (const childId of childIds) {
      const command = (await fs.readFile(`/proc/${childId}/cmdline`)).toString().split("\0").filter(Boolean);
      if (command.includes("/opt/surf-ace/controller/dist/main.js")) controllers.push(childId);
    }
    if (controllers.length !== 1) throw new Error(`tightbeam_controller_process_count:${controllers.length}`);
    const status = await fs.readFile(`/proc/${controllers[0]}/status`, "utf8");
    const owner = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    if (owner !== process.getuid?.()) throw new Error(`tightbeam_controller_owner_mismatch:${owner}`);
    return { owner, response, socket };
  } finally {
    await stop(supervisor);
  }
}

async function smokeLinux(options) {
  const baseline = process.env.SURF_ACE_TIGHTBEAM_BASELINE_BACKEND;
  if (!baseline) throw new Error("tightbeam_smoke_baseline_backend_required");
  const installRoot = process.env.SURF_ACE_INSTALL_ROOT ?? "/opt/surf-ace";
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-tightbeam-state-"));
  try {
    await installArchive(options.backend, installRoot);
    await linuxHealth(installRoot, stateRoot);
    const identityFile = path.join(stateRoot, "home/.config/@surf-ace/electron/controller/controller-identity.json");
    const canonicalIdentity = await fs.readFile(identityFile);
    await installArchive(baseline, installRoot);
    await linuxHealth(installRoot, stateRoot);
    if (!(await fs.readFile(identityFile)).equals(canonicalIdentity)) throw new Error("tightbeam_baseline_did_not_reuse_canonical_identity");
    await installArchive(options.backend, installRoot);
    await linuxHealth(installRoot, stateRoot);
    if (!(await fs.readFile(identityFile)).equals(canonicalIdentity)) throw new Error("tightbeam_upgrade_did_not_reuse_canonical_identity");
    await installArchive(baseline, installRoot);
    await linuxHealth(installRoot, stateRoot);
    if (!(await fs.readFile(identityFile)).equals(canonicalIdentity)) throw new Error("tightbeam_rollback_did_not_reuse_canonical_identity");
    return { component: "linux", phases: ["clean-install", "upgrade", "rollback"], status: "passed" };
  } finally {
    await removeIfExists(installRoot);
    await removeIfExists(stateRoot);
  }
}

async function smokeMacos(options) {
  const baseline = process.env.SURF_ACE_TIGHTBEAM_BASELINE_ELECTRON;
  if (!baseline) throw new Error("tightbeam_smoke_baseline_electron_required");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-tightbeam-electron-"));
  try {
    let port = 19101;
    for (const archive of [options.electron, baseline, options.electron, baseline]) {
      const phase = path.join(root, String(port));
      await fs.mkdir(phase, { recursive: true });
      await run("unzip", ["-q", archive, "-d", phase]);
      await electronHandshake(path.join(phase, "Surf Ace.app/Contents/MacOS/Surf Ace"), phase, port);
      port += 1;
    }
    return { component: "macos", phases: ["clean-install", "upgrade", "rollback"], status: "passed" };
  } finally {
    await removeIfExists(root);
  }
}

export async function smokeTightbeam(options) {
  if (options.baselineCommit !== TIGHTBEAM.baselineCommit || options.candidateCommit !== TIGHTBEAM.candidateCommit) {
    throw new Error("tightbeam_smoke_identity_mismatch");
  }
  const manifest = await verifyManifestFiles(options.manifest, { backend: options.backend, electron: options.electron });
  if (manifest.source?.commit !== options.candidateCommit || manifest.source?.tag !== TIGHTBEAM.sourceTag || manifest.tooling?.tag !== TOOLING_TAG) {
    throw new Error("tightbeam_smoke_manifest_identity_mismatch");
  }
  const component = process.env.SURF_ACE_SMOKE_COMPONENT;
  if (component === "linux") return smokeLinux(options);
  if (component === "macos") return smokeMacos(options);
  throw new Error("SURF_ACE_SMOKE_COMPONENT_must_be_linux_or_macos");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["baseline-commit", "candidate-commit", "manifest", "backend", "electron"]);
  const result = await smokeTightbeam({
    backend: path.resolve(args.backend),
    baselineCommit: args["baseline-commit"],
    candidateCommit: args["candidate-commit"],
    electron: path.resolve(args.electron),
    manifest: path.resolve(args.manifest),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
