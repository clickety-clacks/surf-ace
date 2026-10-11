import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestEvidenceDirectory,
  readNativeScalePinManifest,
  sha256,
  validateNativeScaleAdmission,
  verifyNativeScalePins,
} from "./native-scale-runner-guard.mjs";
import { electronProcessCensus, processCensus, runOwnedProcess } from "./native-scale-owned-process.mjs";

function readArgs(argv) {
  const values = new Map();
  const flags = new Set(["--verify-only"]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (flags.has(key)) {
      if (values.has(key)) throw new Error(`Duplicate argument ${key}`);
      values.set(key, true);
      continue;
    }
    if (!key.startsWith("--") || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error(`Expected --name value, got ${key}`);
    }
    if (values.has(key)) throw new Error(`Duplicate argument ${key}`);
    values.set(key, argv[++index]);
  }
  return values;
}

async function canonicalizePotentialPath(candidate) {
  let cursor = path.resolve(candidate);
  const suffix = [];
  while (true) {
    try {
      return path.join(await fs.realpath(cursor), ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function outsideRepo(repoDir, candidate, label) {
  if (!candidate) throw new Error(`${label} must be an external path outside the source worktree`);
  const realRepoDir = await fs.realpath(repoDir);
  const absolute = await canonicalizePotentialPath(candidate);
  const relative = path.relative(realRepoDir, absolute);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be an external path outside the source worktree`);
  }
  return absolute;
}

async function readHashedJson(file, expectedSha256, label) {
  const bytes = await fs.readFile(file);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) throw new Error(`${label} SHA-256 does not match admission`);
  return JSON.parse(bytes.toString("utf8"));
}

function displayIdentity(environment) {
  return JSON.stringify({ DISPLAY: environment.DISPLAY ?? "", WAYLAND_DISPLAY: environment.WAYLAND_DISPLAY ?? "" });
}

function currentElectronPids(electronPath) {
  return electronProcessCensus(electronPath, processCensus()).map(({ pid }) => pid).sort((left, right) => left - right);
}

async function main(argv) {
  const args = readArgs(argv);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(scriptDir, "..");
  const repoDir = path.resolve(packageDir, "../..");
  const pinsPath = await outsideRepo(repoDir, args.get("--pins"), "Pin manifest");
  const pinsSha256 = args.get("--pins-sha256");
  const { pins } = await readNativeScalePinManifest(pinsPath, pinsSha256, repoDir);
  await verifyNativeScalePins({ repoDir, packageDir, pins, electronVersion: pins.electronVersion });
  if (args.has("--verify-only")) {
    process.stdout.write(JSON.stringify({ verified: true, head: pins.head, tree: pins.tree,
      electronVersion: pins.electronVersion, distTreeSha256: pins.distTreeSha256 }) + "\n");
    return;
  }

  const admissionPath = await outsideRepo(repoDir, args.get("--admission"), "Admission manifest");
  const admissionSha256 = args.get("--admission-sha256");
  const admissionJson = await readHashedJson(admissionPath, admissionSha256, "Private native scale admission");
  const display = displayIdentity(process.env);
  const admission = validateNativeScaleAdmission({ admission: admissionJson,
    expectedPinsSha256: pinsSha256, display });
  const electronArgument = args.get("--electron") ?? "";
  const electronPath = path.resolve(electronArgument);
  if (!args.has("--electron") || !path.isAbsolute(electronArgument)) throw new Error("An explicit absolute Electron executable is required");
  const electronRealPath = await fs.realpath(electronPath);
  const evidenceDir = await outsideRepo(repoDir, args.get("--evidence-dir"), "Evidence directory");
  await fs.mkdir(path.dirname(evidenceDir), { recursive: true });
  await fs.mkdir(evidenceDir, { recursive: false });

  const baseline = currentElectronPids(electronRealPath);
  if (JSON.stringify(baseline) !== JSON.stringify(admission.baselineElectronPids)) {
    throw new Error(`Electron process census changed since admission: expected ${admission.baselineElectronPids}, found ${baseline}`);
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `surf-ace-native-${admission.runId}-`));
  const runner = path.join(scriptDir, "test-browser-content-scale-native.mjs");
  let processReceipt = null;
  let thrown = null;
  try {
    await fs.writeFile(path.join(evidenceDir, "preflight.json"), JSON.stringify({
      runId: admission.runId,
      slotId: admission.slotId,
      sourcePinsSha256: pinsSha256,
      head: pins.head,
      tree: pins.tree,
      distTreeSha256: pins.distTreeSha256,
      electronVersion: pins.electronVersion,
      electronPath: electronRealPath,
      display,
      baselineElectronPids: baseline,
      deadlineMs: admission.deadlineMs,
    }, null, 2) + "\n", { flag: "wx" });
    processReceipt = await runOwnedProcess({
      command: electronRealPath,
      args: ["--no-sandbox", runner],
      options: {
        cwd: packageDir,
        env: {
          ...process.env,
          SURF_ACE_NATIVE_PINS: pinsPath,
          SURF_ACE_NATIVE_PINS_SHA256: pinsSha256,
          SURF_ACE_NATIVE_RUN_ID: admission.runId,
          SURF_ACE_NATIVE_EVIDENCE_DIR: evidenceDir,
          SURF_ACE_NATIVE_SCRATCH_DIR: scratch,
          SURF_ACE_NATIVE_SLOT_ID: admission.slotId,
        },
      },
      deadlineMs: admission.deadlineMs,
      maxOutputBytes: 4_000_000,
    });
    await fs.writeFile(path.join(evidenceDir, "electron.stdout.log"), processReceipt.stdout, { flag: "wx" });
    await fs.writeFile(path.join(evidenceDir, "electron.stderr.log"), processReceipt.stderr, { flag: "wx" });
    if (processReceipt.timedOut) throw new Error(`Private Electron fixture exceeded ${admission.deadlineMs} ms`);
    if (processReceipt.code !== 0) throw new Error(`Private Electron fixture exited ${processReceipt.code ?? processReceipt.signal}`);
  } catch (error) {
    processReceipt = error?.receipt ?? processReceipt;
    thrown = error;
    if (processReceipt?.stdout) await fs.writeFile(path.join(evidenceDir, "electron.stdout.log"), processReceipt.stdout, { flag: "wx" }).catch(() => {});
    if (processReceipt?.stderr) await fs.writeFile(path.join(evidenceDir, "electron.stderr.log"), processReceipt.stderr, { flag: "wx" }).catch(() => {});
  } finally {
    const after = currentElectronPids(electronRealPath);
    const baselineSet = new Set(baseline);
    const unexpectedElectronPids = after.filter((pid) => !baselineSet.has(pid));
    const fixtureEvidence = await digestEvidenceDirectory(evidenceDir).catch((error) => ({ evidenceDigestError: String(error) }));
    const receipt = {
      runId: admission.runId,
      slotId: admission.slotId,
      sourcePinsSha256: pinsSha256,
      process: processReceipt && { pid: processReceipt.pid, pgid: processReceipt.pgid,
        code: processReceipt.code, signal: processReceipt.signal, timedOut: processReceipt.timedOut,
        termSent: processReceipt.termSent, killSent: processReceipt.killSent, remaining: processReceipt.remaining },
      electronPidsBefore: baseline,
      electronPidsAfter: after,
      unexpectedElectronPids,
      evidenceFiles: fixtureEvidence,
      error: thrown ? String(thrown.stack ?? thrown) : null,
    };
    await fs.writeFile(path.join(evidenceDir, "execution-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    const ownedGroupEmpty = processReceipt ? processCensus().every(({ pgid }) => pgid !== processReceipt.pgid) : true;
    if (ownedGroupEmpty) await fs.rm(scratch, { recursive: true, force: true });
    if (unexpectedElectronPids.length) throw new Error(`Unexpected Electron processes remain: ${unexpectedElectronPids}`);
    if (!ownedGroupEmpty) throw new Error(`Owned Electron process group ${processReceipt?.pgid} remains; scratch was preserved at ${scratch}`);
  }
  if (thrown) throw thrown;
  process.stdout.write(JSON.stringify({ passed: true, runId: admission.runId, evidenceDir,
    sourcePinsSha256: pinsSha256, processGroup: processReceipt?.pgid }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
