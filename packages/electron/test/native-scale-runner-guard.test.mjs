import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NATIVE_SCALE_PINNED_SOURCES,
  collectNativeScalePinSnapshot,
  digestEvidenceDirectory,
  readNativeScalePinManifest,
  saveNativeScalePng,
  sha256,
  validateNativeScaleAdmission,
  verifyNativeScalePins,
} from "../scripts/native-scale-runner-guard.mjs";
import { processGroupCensus, runOwnedProcess } from "../scripts/native-scale-owned-process.mjs";

const sourceOnlyValidation = process.env.SURF_ACE_NATIVE_SOURCE_ONLY === "1";

async function makePinnedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-scale-pins-test-"));
  const packageDir = path.join(root, "packages/electron");
  for (const relative of NATIVE_SCALE_PINNED_SOURCES) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `fixture source ${relative}\n`);
  }
  await writeFile(path.join(root, ".gitignore"), "packages/electron/dist/\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "native-scale-test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Native Scale Fixture Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "pin fixture source"], { cwd: root });
  const distDir = path.join(packageDir, "dist");
  for (const relative of ["guest-preload.cjs", "renderer/index.html", "renderer/renderer.js", "renderer/styles.css"]) {
    const file = path.join(distDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `fixture dist ${relative}\n`);
  }
  return { root, packageDir, distDir };
}

test("native scale pin manifest binds clean source, Electron version, and every built dist file",
  { skip: sourceOnlyValidation ? "source-only mode does not spawn git" : false }, async (t) => {
  const fixture = await makePinnedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const snapshotArgs = { repoDir: fixture.root, packageDir: fixture.packageDir, electronVersion: "42.0.0" };
  const pins = await collectNativeScalePinSnapshot(snapshotArgs);
  assert.equal((await verifyNativeScalePins({ ...snapshotArgs, pins })).head, pins.head);
  await assert.rejects(verifyNativeScalePins({ ...snapshotArgs, pins, electronVersion: "41.0.0" }), /runtime .* does not match pinned/);

  await writeFile(path.join(fixture.distDir, "renderer/renderer.js"), "tampered built renderer\n");
  await assert.rejects(verifyNativeScalePins({ ...snapshotArgs, pins }), /built dist/);
  await writeFile(path.join(fixture.distDir, "renderer/renderer.js"), "fixture dist renderer/renderer.js\n");

  const changedSource = path.join(fixture.root, NATIVE_SCALE_PINNED_SOURCES[0]);
  const originalSource = await readFile(changedSource);
  await writeFile(changedSource, Buffer.concat([originalSource, Buffer.from("dirty\n")]));
  await assert.rejects(verifyNativeScalePins({ ...snapshotArgs, pins }), /worktree is not clean/);
  await writeFile(changedSource, originalSource);
  await writeFile(path.join(fixture.root, "untracked-native-scale-file"), "must reject\n");
  await assert.rejects(verifyNativeScalePins({ ...snapshotArgs, pins }), /worktree is not clean/);
});

test("pin manifest reads require the exact digest and an external path",
  { skip: sourceOnlyValidation ? "source-only mode does not spawn git" : false }, async (t) => {
  const fixture = await makePinnedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const pins = await collectNativeScalePinSnapshot({ repoDir: fixture.root, packageDir: fixture.packageDir, electronVersion: "42.0.0" });
  const manifest = path.join(path.dirname(fixture.root), `${path.basename(fixture.root)}-pins.json`);
  t.after(() => rm(manifest, { force: true }));
  const bytes = Buffer.from(`${JSON.stringify(pins)}\n`);
  await writeFile(manifest, bytes, { flag: "wx" });
  const digest = sha256(bytes);
  assert.deepEqual((await readNativeScalePinManifest(manifest, digest, fixture.root)).pins, pins);
  await assert.rejects(readNativeScalePinManifest(manifest, "0".repeat(64), fixture.root), /digest does not match/);
  const inside = path.join(fixture.root, "pins.json");
  await writeFile(inside, bytes);
  await assert.rejects(readNativeScalePinManifest(inside, digest, fixture.root), /must be outside/);
});

test("admission is pinned to a live private slot, display, bounded deadline, and process baseline", () => {
  const now = Date.now();
  const sourcePinsSha256 = "a".repeat(64);
  const admission = {
    schemaVersion: 1,
    privateGuiSlot: true,
    slotId: "private-slot-01",
    runId: "scale-run-20261011-01",
    sourcePinsSha256,
    issuedAtMs: now - 100,
    expiresAtMs: now + 10_000,
    deadlineMs: 60_000,
    display: "{\"DISPLAY\":\":99\",\"WAYLAND_DISPLAY\":\"\"}",
    baselineElectronPids: [41, 52],
  };
  assert.deepEqual(validateNativeScaleAdmission({ admission, expectedPinsSha256: sourcePinsSha256, display: admission.display, now }), {
    slotId: admission.slotId,
    runId: admission.runId,
    sourcePinsSha256,
    display: admission.display,
    deadlineMs: 60_000,
    baselineElectronPids: [41, 52],
  });
  assert.throws(() => validateNativeScaleAdmission({ admission, expectedPinsSha256: "b".repeat(64), display: admission.display, now }), /does not match/);
  assert.throws(() => validateNativeScaleAdmission({ admission: { ...admission, expiresAtMs: now }, expectedPinsSha256: sourcePinsSha256, display: admission.display, now }), /expired/);
  assert.throws(() => validateNativeScaleAdmission({ admission, expectedPinsSha256: sourcePinsSha256, display: ":other", now }), /display does not match/);
  assert.throws(() => validateNativeScaleAdmission({ admission: { ...admission, baselineElectronPids: [41, 41] }, expectedPinsSha256: sourcePinsSha256, display: admission.display, now }), /baseline Electron process census/);
  assert.throws(() => validateNativeScaleAdmission({ admission: { ...admission, deadlineMs: 181_000 }, expectedPinsSha256: sourcePinsSha256, display: admission.display, now }), /unsafe deadline/);
});

test("PNG evidence is phase-bound, hashed, and refuses invalid or colliding paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-scale-evidence-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceDir = path.join(root, "evidence");
  const bytes = Buffer.from("89504e470d0a1a0a" + "00010203", "hex");
  const record = await saveNativeScalePng({ bytes, evidenceDir, phaseId: "phase-001-marker-scale-085",
    label: "marker at quarter pane", source: { runId: "run-001", head: "a".repeat(40) } });
  assert.equal(record.sha256, sha256(bytes));
  assert.equal(record.phaseId, "phase-001-marker-scale-085");
  assert.deepEqual(await digestEvidenceDirectory(evidenceDir), { [record.file]: record.sha256 });
  await assert.rejects(saveNativeScalePng({ bytes, evidenceDir, phaseId: "phase-001-marker-scale-085", label: "collision", source: {} }), /EEXIST/);
  await assert.rejects(saveNativeScalePng({ bytes: Buffer.from("not a png"), evidenceDir, phaseId: "bad", label: "bad", source: {} }), /not a PNG/);
  await assert.rejects(saveNativeScalePng({ bytes, evidenceDir, phaseId: "../escape", label: "escape", source: {} }), /invalid phase identity/);
});

test("private native runner retains multi-position, iframe, and old root-zoom negative oracles", async () => {
  const runnerPath = new URL("../scripts/test-browser-content-scale-native.mjs", import.meta.url);
  const runner = await readFile(runnerPath, "utf8");
  assert.match(runner, /assertLegacyRootZoomRejected/);
  assert.match(runner, /legacy-root-zoom-negative/);
  assert.match(runner, /iframePointer\.x < iframeRect\.width/);
  assert.match(runner, /iframePointer\.y < iframeRect\.height/);
  assert.match(runner, /saveNativeScalePng/);
  assert.match(runner, /scale-1\.275-quarter/);
  assert.match(runner, /scale-0\.85-right-upper/);
  assert.match(runner, /app\.quit\(\)/);
  assert.doesNotMatch(runner, /app\.exit\(/);
  assert.doesNotMatch(runner, /fs\.rm\(scratch/);
});

test("owned process wrapper reaps a timed-out process group and an orphaned group member",
  { skip: sourceOnlyValidation ? "source-only mode does not spawn process groups" : false }, async () => {
  const quickExit = await runOwnedProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('quick-exit-before-parent-await')"],
    deadlineMs: 3_000,
  });
  assert.equal(quickExit.code, 0, "exit listeners must be installed before waiting for spawn");
  assert.equal(quickExit.timedOut, false);
  assert.equal(quickExit.stdout, "quick-exit-before-parent-await");
  assert.deepEqual(quickExit.remaining, []);
  assert.deepEqual(processGroupCensus(quickExit.pgid), []);

  const timeout = await runOwnedProcess({
    command: process.execPath,
    args: ["-e", "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"],
    deadlineMs: 300,
    terminateGraceMs: 500,
    reapTimeoutMs: 2_000,
  });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.termSent, true);
  assert.deepEqual(timeout.remaining, []);
  assert.deepEqual(processGroupCensus(timeout.pgid), []);

  const orphan = await runOwnedProcess({
    command: process.execPath,
    args: ["-e", "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});"],
    deadlineMs: 3_000,
    terminateGraceMs: 500,
    reapTimeoutMs: 2_000,
  });
  assert.equal(orphan.code, 0);
  assert.equal(orphan.timedOut, false);
  assert.equal(orphan.termSent, true, "orphaned child should receive owned-group cleanup");
  assert.deepEqual(orphan.remaining, []);
  assert.deepEqual(processGroupCensus(orphan.pgid), []);
});
