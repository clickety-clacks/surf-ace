import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestEvidenceDirectory,
  readNativeScalePinManifest,
  sha256,
  validateNativeScaleAdmission,
  validateNativeScaleFixtureEvidence,
  nativeScaleRunFailures,
  shouldRemoveNativeScaleScratch,
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

async function writeWithin(file, contents, options, timeoutMs = 2_000) {
  let timer;
  try {
    await Promise.race([
      fs.writeFile(file, contents, options),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Receipt write exceeded ${timeoutMs} ms`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function currentElectronPids(electronPath) {
  return electronProcessCensus(electronPath, await processCensus({ timeoutMs: 1_500 }))
    .map(({ pid }) => pid).sort((left, right) => left - right);
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

  const baseline = await currentElectronPids(electronRealPath);
  if (JSON.stringify(baseline) !== JSON.stringify(admission.baselineElectronPids)) {
    throw new Error(`Electron process census changed since admission: expected ${admission.baselineElectronPids}, found ${baseline}`);
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `surf-ace-native-${admission.runId}-`));
  const runner = path.join(scriptDir, "test-browser-content-scale-native.mjs");
  let processReceipt = null;
  let launchReceipt = null;
  let launchReceiptPersisted = false;
  let launchReceiptPersistenceError = null;
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
      onLaunch: async (receipt) => {
        launchReceipt = receipt;
        try {
          await writeWithin(path.join(evidenceDir, "launch-receipt.json"), JSON.stringify({
          runId: admission.runId,
          slotId: admission.slotId,
          sourcePinsSha256: pinsSha256,
          pid: receipt.pid,
          pgid: receipt.pgid,
          ownerToken: receipt.ownerToken,
          startedAt: receipt.startedAt,
          supervisorPath: receipt.supervisorPath,
          command: receipt.command,
          args: receipt.args,
          startedMonotonic: receipt.startedMonotonic,
          }, null, 2) + "\n", { flag: "wx" });
          launchReceiptPersisted = true;
        } catch (error) {
          launchReceiptPersistenceError = error;
          throw error;
        }
      },
    });
    await fs.writeFile(path.join(evidenceDir, "electron.stdout.log"), processReceipt.stdout, { flag: "wx" });
    await fs.writeFile(path.join(evidenceDir, "electron.stderr.log"), processReceipt.stderr, { flag: "wx" });
    if (processReceipt.timedOut) throw new Error(`Private Electron fixture exceeded ${admission.deadlineMs} ms`);
    if (processReceipt.code !== 0) throw new Error(`Private Electron fixture exited ${processReceipt.code ?? processReceipt.signal}`);
  } catch (error) {
    processReceipt = error?.receipt ?? processReceipt;
    launchReceipt ??= error?.receipt ?? null;
    thrown = error;
    if (processReceipt?.stdout) await fs.writeFile(path.join(evidenceDir, "electron.stdout.log"), processReceipt.stdout, { flag: "wx" }).catch(() => {});
    if (processReceipt?.stderr) await fs.writeFile(path.join(evidenceDir, "electron.stderr.log"), processReceipt.stderr, { flag: "wx" }).catch(() => {});
  }

  const finalizationErrors = [];
  let after = null;
  let finalCensusKnown = false;
  let unexpectedElectronPids = null;
  try {
    after = await currentElectronPids(electronRealPath);
    finalCensusKnown = true;
    const baselineSet = new Set(baseline);
    unexpectedElectronPids = after.filter((pid) => !baselineSet.has(pid));
  } catch (error) { finalizationErrors.push(error); }

  let digestMap = null;
  let evidenceDigestError = null;
  let evidenceValidation = null;
  let fixtureEvidence = null;
  try {
    digestMap = await digestEvidenceDirectory(evidenceDir);
    fixtureEvidence = JSON.parse(await fs.readFile(path.join(evidenceDir, "fixture-evidence.json"), "utf8"));
    evidenceValidation = await validateNativeScaleFixtureEvidence({ evidenceDir, evidence: fixtureEvidence,
      digestMap, admission, pins, pinsSha256 });
  } catch (error) {
    evidenceDigestError = String(error.stack ?? error);
    finalizationErrors.push(error);
  }

  let processRows = null;
  let ownedGroupEmpty = false;
  try {
    processRows = await processCensus({ timeoutMs: 1_500 });
    ownedGroupEmpty = Boolean(processReceipt?.pgid) && processRows.every(({ pgid }) => pgid !== processReceipt.pgid);
  } catch (error) { finalizationErrors.push(error); }

  const executionReceipt = {
    schemaVersion: 1,
    runId: admission.runId,
    slotId: admission.slotId,
    sourcePinsSha256: pinsSha256,
    launch: launchReceipt && { pid: launchReceipt.pid, pgid: launchReceipt.pgid,
      ownerToken: launchReceipt.ownerToken, startedAt: launchReceipt.startedAt },
    launchReceiptPersisted,
    launchReceiptPersistenceError: launchReceiptPersistenceError && String(launchReceiptPersistenceError.stack ?? launchReceiptPersistenceError),
    process: processReceipt && { pid: processReceipt.pid, pgid: processReceipt.pgid,
      code: processReceipt.code, signal: processReceipt.signal, timedOut: processReceipt.timedOut,
      termSent: processReceipt.termSent, killSent: processReceipt.killSent,
      ownershipKnown: processReceipt.ownershipKnown, remaining: processReceipt.remaining,
      censusError: processReceipt.censusError },
    electronPidsBefore: baseline,
    electronPidsAfter: after,
    finalCensusKnown,
    unexpectedElectronPids,
    ownedGroupEmpty,
    evidenceValidation,
    evidenceDigestError,
    evidenceFiles: digestMap,
    fixtureResult: fixtureEvidence?.result ?? null,
    errors: [...(thrown ? [String(thrown.stack ?? thrown)] : []), ...finalizationErrors.map((error) => String(error.stack ?? error))],
  };
  let executionReceiptPersisted = false;
  try {
    await writeWithin(path.join(evidenceDir, "execution-receipt.json"), JSON.stringify(executionReceipt, null, 2) + "\n", { flag: "wx" });
    executionReceiptPersisted = true;
  } catch (error) { finalizationErrors.push(error); }

  const scratchMayBeRemoved = shouldRemoveNativeScaleScratch({
    processOwnershipKnown: processReceipt?.ownershipKnown,
    finalCensusKnown: finalCensusKnown && processRows !== null,
    groupEmpty: ownedGroupEmpty,
    receiptPersisted: executionReceiptPersisted,
    launchReceiptPersisted,
  });
  if (scratchMayBeRemoved) {
    try { await fs.rm(scratch, { recursive: true, force: true }); }
    catch (error) { finalizationErrors.push(error); }
  }

  const failures = nativeScaleRunFailures({ processReceipt, evidenceValidation, evidenceDigestError,
    unexpectedElectronPids, finalCensusKnown: finalCensusKnown && processRows !== null,
    groupEmpty: ownedGroupEmpty, executionReceiptPersisted, launchReceiptPersisted });
  const allErrors = [...(thrown ? [thrown] : []), ...finalizationErrors];
  if (failures.length) allErrors.push(new Error(`${failures.join("; ")}${scratchMayBeRemoved ? "" : `; scratch preserved at ${scratch}`}`));
  if (allErrors.length) throw new AggregateError(allErrors, "Private native scale run did not produce a complete, safely reaped result");
  process.stdout.write(JSON.stringify({ passed: true, runId: admission.runId, evidenceDir,
    sourcePinsSha256: pinsSha256, processGroup: processReceipt?.pgid }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
