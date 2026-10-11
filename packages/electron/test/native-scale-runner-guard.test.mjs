import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { deflateSync } from "node:zlib";
import {
  buildGuestMessageReceiverScript,
  buildIframeChallengeAckHostProgram,
  buildIframeChallengeGuestProgram,
  buildIframeChallengeHostProgram,
  buildIframeDocumentReceiverScript,
} from "../scripts/native-scale-iframe-challenge.mjs";
import {
  NATIVE_SCALE_EXPECTED_IFRAME_POINTS,
  NATIVE_SCALE_EXPECTED_POINTERS,
  NATIVE_SCALE_EXPECTED_PNG_LABELS,
  NATIVE_SCALE_PINNED_SOURCES,
  collectNativeScalePinSnapshot,
  decodeNativeScalePngPixel,
  digestEvidenceDirectory,
  nativeScaleRunFailures,
  readNativeScalePinManifest,
  saveNativeScalePng,
  sha256,
  shouldRemoveNativeScaleScratch,
  validateNativeScaleAdmission,
  validateNativeScaleFixtureEvidence,
  verifyNativeScalePins,
} from "../scripts/native-scale-runner-guard.mjs";
import { processCensus, processGroupCensus, runOwnedProcess } from "../scripts/native-scale-owned-process.mjs";

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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function encodeRgbaPng(width, height, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < width; x += 1) rows.push(Buffer.from(pixelAt(x, y)));
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function makeValidNativeEvidence(evidenceDir) {
  const runId = "semantic-run-001";
  const slotId = "private-slot-semantic";
  const pinsSha256 = "a".repeat(64);
  const pins = { head: "b".repeat(40), tree: "c".repeat(40), distTreeSha256: "d".repeat(64), electronVersion: "42.0.0" };
  const admission = { runId, slotId };
  const source = { ...pins };
  const pointers = NATIVE_SCALE_EXPECTED_POINTERS.map((label) => {
    const scale = label.includes("1.275") ? 1.275 : 0.85;
    const host = { x: 24, y: 26 };
    return { label, scale, host, guest: { x: host.x / scale, y: host.y / scale }, markerHost: host };
  });
  const iframePoints = NATIVE_SCALE_EXPECTED_IFRAME_POINTS.map((label) => {
    const scale = label.includes("1.275") ? 1.275 : 0.85;
    return { label, scale, iframeRect: { x: 0, y: 0, width: 130, height: 100 },
      iframePointer: { x: 20, y: 20 }, expectedLocal: { x: 20, y: 20 } };
  });
  const pngs = [];
  for (const [index, label] of NATIVE_SCALE_EXPECTED_PNG_LABELS.entries()) {
    const phaseId = `phase-${String(index + 1).padStart(3, "0")}-${label}`;
    const rgb = [20 + index * 13, 30 + index * 7, 40 + index * 5];
    const negative = label === "legacy-root-zoom-negative";
    const bytes = encodeRgbaPng(4, 3, (x, y) => {
      if (negative && x === 2 && y === 1) return [...rgb, 255];
      if (!negative && x === 1 && y === 1) return [...rgb, 255];
      return [255, 255, 255, 255];
    });
    const saved = await saveNativeScalePng({ bytes, evidenceDir, phaseId, label, source: {
      runId, slotId, pinsManifestSha256: pinsSha256, head: pins.head, tree: pins.tree,
      distTreeSha256: pins.distTreeSha256, electronVersion: pins.electronVersion,
    } });
    const paint = { challengeId: `${runId}/${label}/${phaseId}`, rgb,
      kind: negative ? "legacy-negative" : label.endsWith("-marker") ? "marker" : "iframe" };
    if (negative) {
      pngs.push({ ...saved, paint, samples: [
        { name: "pointer-target", pixel: { x: 1, y: 1 }, rgba: [255, 255, 255, 255] },
        { name: "painted-marker", pixel: { x: 2, y: 1 }, rgba: [...rgb, 255] },
      ] });
    } else pngs.push({ ...saved, paint, sample: { x: 1, y: 1, rgba: [...rgb, 255] } });
  }
  for (const pointer of pointers) {
    const png = pngs.find(({ label }) => label === `${pointer.label}-marker`);
    pointer.challengeId = png.paint.challengeId;
  }
  for (const point of iframePoints) {
    const png = pngs.find(({ label }) => label === `${point.label}-iframe-paint`);
    point.challengeId = png.paint.challengeId;
    point.iframePointer.challengeId = png.paint.challengeId;
  }
  const evidence = { schemaVersion: 1, runId, slotId, pinsManifestSha256: pinsSha256, source,
    result: "passed", failedStage: null, blockedRequests: [], consoleErrors: [], pointers, iframePoints, pngs };
  return { runId, slotId, pinsSha256, pins, admission, evidence };
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

test("fixture evidence requires all admitted phases and the exact fresh paint pixels", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-scale-semantic-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeValidNativeEvidence(root);
  const digestMap = await digestEvidenceDirectory(root);
  const input = { evidenceDir: root, digestMap, admission: fixture.admission, pins: fixture.pins, pinsSha256: fixture.pinsSha256 };
  assert.deepEqual(await validateNativeScaleFixtureEvidence({ ...input, evidence: fixture.evidence }), {
    valid: true, pngCount: 13, pointerCount: 8, iframeCount: 4,
  });
  assert.deepEqual(decodeNativeScalePngPixel(await readFile(path.join(root, fixture.evidence.pngs[0].file)), 1, 1).rgba.slice(0, 3),
    fixture.evidence.pngs[0].paint.rgb);

  await assert.rejects(validateNativeScaleFixtureEvidence({ ...input,
    evidence: { ...fixture.evidence, runId: "wrong-run" } }), /identity does not match/);
  await assert.rejects(validateNativeScaleFixtureEvidence({ ...input,
    evidence: { ...fixture.evidence, result: "failed", failedStage: "pointer" } }), /did not report a passed/);
  await assert.rejects(validateNativeScaleFixtureEvidence({ ...input,
    evidence: { ...fixture.evidence, pointers: fixture.evidence.pointers.slice(1) } }), /incomplete or duplicate pointer/);

  const missingImage = fixture.evidence.pngs[0];
  const missingBytes = await readFile(path.join(root, missingImage.file));
  await rm(path.join(root, missingImage.file));
  await assert.rejects(validateNativeScaleFixtureEvidence({ ...input, digestMap: await digestEvidenceDirectory(root),
    evidence: fixture.evidence }), /PNG set does not match/);
  await writeFile(path.join(root, missingImage.file), missingBytes, { flag: "wx" });

  const first = fixture.evidence.pngs[0];
  const second = fixture.evidence.pngs[1];
  const oldPhaseBytes = await readFile(path.join(root, second.file));
  await writeFile(path.join(root, first.file), oldPhaseBytes);
  const staleDigestMap = await digestEvidenceDirectory(root);
  const staleEvidence = structuredClone(fixture.evidence);
  staleEvidence.pngs[0].sha256 = staleDigestMap[first.file];
  await assert.rejects(validateNativeScaleFixtureEvidence({ ...input, digestMap: staleDigestMap, evidence: staleEvidence }),
    /stale or missing the current phase paint/);

  await writeFile(path.join(root, first.file), missingBytes);
  const validDigestMap = await digestEvidenceDirectory(root);
  const wrongGuest = structuredClone(fixture.evidence);
  wrongGuest.pngs[0].paint.kind = "iframe";
  await assert.rejects(validateNativeScaleFixtureEvidence({ ...input, digestMap: validDigestMap, evidence: wrongGuest }), /wrong guest paint source/);
  const missingChallenge = structuredClone(fixture.evidence);
  delete missingChallenge.pngs[0].paint;
  await assert.rejects(validateNativeScaleFixtureEvidence({ ...input, digestMap: validDigestMap, evidence: missingChallenge }), /missing its fresh paint challenge/);
  const wrongPhase = structuredClone(fixture.evidence);
  wrongPhase.pngs[0].paint.challengeId = `${fixture.runId}/old-phase`;
  await assert.rejects(validateNativeScaleFixtureEvidence({ ...input, digestMap: validDigestMap, evidence: wrongPhase }), /missing its fresh paint challenge/);

  assert.deepEqual(nativeScaleRunFailures({ processReceipt: { code: 0, ownershipKnown: true },
    evidenceValidation: null, evidenceDigestError: "missing receipt", unexpectedElectronPids: [],
    finalCensusKnown: true, groupEmpty: true, executionReceiptPersisted: true }).length > 0, true);
  assert.equal(shouldRemoveNativeScaleScratch({ processOwnershipKnown: false, finalCensusKnown: true,
    groupEmpty: true, receiptPersisted: true }), false);
  assert.equal(shouldRemoveNativeScaleScratch({ processOwnershipKnown: true, finalCensusKnown: false,
    groupEmpty: false, receiptPersisted: true }), false);
  assert.equal(shouldRemoveNativeScaleScratch({ processOwnershipKnown: true, finalCensusKnown: true,
    groupEmpty: true, receiptPersisted: false }), false);
  assert.equal(shouldRemoveNativeScaleScratch({ processOwnershipKnown: true, finalCensusKnown: true,
    groupEmpty: true, receiptPersisted: true, launchReceiptPersisted: false }), false);
  assert.equal(shouldRemoveNativeScaleScratch({ processOwnershipKnown: true, finalCensusKnown: true,
    groupEmpty: true, receiptPersisted: true }), true);
});

test("private native runner retains multi-position, iframe, and old root-zoom negative oracles", async () => {
  assert.ok(NATIVE_SCALE_PINNED_SOURCES.includes("packages/electron/scripts/native-scale-iframe-challenge.mjs"),
    "iframe program builders and receiver code must be included in the pinned source manifest");
  const runnerPath = new URL("../scripts/test-browser-content-scale-native.mjs", import.meta.url);
  const supervisorPath = new URL("../scripts/native-scale-process-supervisor.mjs", import.meta.url);
  const ownedPath = new URL("../scripts/native-scale-owned-process.mjs", import.meta.url);
  const challengePath = new URL("../scripts/native-scale-iframe-challenge.mjs", import.meta.url);
  const runner = await readFile(runnerPath, "utf8");
  const supervisor = await readFile(supervisorPath, "utf8");
  const owned = await readFile(ownedPath, "utf8");
  const challengeBuilder = await readFile(challengePath, "utf8");
  const guardTest = await readFile(new URL(import.meta.url), "utf8");
  assert.match(runner, /assertLegacyRootZoomRejected/);
  assert.match(runner, /legacy-root-zoom-negative/);
  assert.match(runner, /iframePointer\.x < iframeRect\.width/);
  assert.match(runner, /iframePointer\.y < iframeRect\.height/);
  assert.match(runner, /saveNativeScalePng/);
  assert.match(runner, /scale-1\.275-quarter/);
  assert.match(runner, /scale-0\.85-right-upper/);
  assert.match(runner, /__nativeScaleChallenge/);
  assert.match(challengeBuilder, /iframe-paint-challenge/);
  assert.match(runner, /buildIframeDocumentReceiverScript\(\)/);
  assert.match(runner, /buildGuestMessageReceiverScript\(\)/);
  assert.match(runner, /challengeId/);
  assert.match(runner, /buildIframeChallengeGuestProgram\(challenge\.paint\)/);
  assert.match(runner, /buildIframeChallengeHostProgram\(guestProgram\)/);
  assert.match(runner, /buildIframeChallengeAckHostProgram\(challenge\.paint\.challengeId\)/);
  assert.match(challengeBuilder, /JSON\.stringify\(guestProgram\)/);
  assert.doesNotMatch(runner, /const payload = JSON\.stringify\(\{ \.\.\.challenge\.paint/);
  assert.match(runner, /2_500/);
  assert.match(supervisor, /process\.kill\(-process\.pid, signal\)/);
  assert.match(supervisor, /detached: false/);
  assert.doesNotMatch(owned, /process\.kill\(-pgid/);
  assert.match(owned, /onLaunch/);
  assert.match(owned, /censusTimeoutMs/);
  assert.match(guardTest, /orphanParentGroupObservation\.target\.pgid, orphan\.pgid/);
  assert.match(guardTest, /orphanChildGroupObservation\?\.pgid, orphan\.pgid/);
  assert.match(guardTest, /orphan\.termSent, true/);
  assert.doesNotMatch(guardTest, /assert\.equal\(parentExitProof\.parentPid, orphan\.pid\)/);
  assert.match(runner, /app\.quit\(\)/);
  assert.doesNotMatch(runner, /app\.exit\(/);
  assert.doesNotMatch(runner, /fs\.rm\(scratch/);
});

test("iframe challenge executes as an object through generated host, guest, and receiver programs", async () => {
  function makeHarness() {
    const iframeListeners = new Map();
    const guestListeners = new Map();
    const iframeWindow = { addEventListener: (type, callback) => iframeListeners.set(type, callback) };
    const guestWindow = { addEventListener: (type, callback) => guestListeners.set(type, callback) };
    const iframeDocument = { body: { style: {} } };
    let receiverDataType = null;
    const frame = { contentWindow: { postMessage: (data, origin) => {
      receiverDataType = typeof data;
      queueMicrotask(() => iframeListeners.get("message")?.({ data, origin, source: guestWindow }));
    } } };
    const guestDocument = { querySelector: (selector) => {
      assert.equal(selector, "#edge-frame");
      return frame;
    } };
    const iframeContext = vm.createContext({
      window: iframeWindow,
      document: iframeDocument,
      parent: { postMessage: (data, origin) => queueMicrotask(() =>
        guestListeners.get("message")?.({ data, origin, source: iframeWindow })) },
    });
    vm.runInContext(buildIframeDocumentReceiverScript(), iframeContext);
    const guestContext = vm.createContext({ window: guestWindow, document: guestDocument });
    vm.runInContext(buildGuestMessageReceiverScript(), guestContext);
    const executedGuestPrograms = [];
    const webview = { executeJavaScript: async (program) => {
      executedGuestPrograms.push(program);
      return vm.runInContext(program, guestContext);
    } };
    const hostContext = vm.createContext({ document: { querySelector: (selector) => {
      assert.equal(selector, "webview");
      return webview;
    } } });
    return { iframeWindow, iframeDocument, guestWindow, hostContext, executedGuestPrograms,
      get receiverDataType() { return receiverDataType; } };
  }

  const paint = { challengeId: "fixture-run/scale-1.275-iframe/phase-012", rgb: [40, 70, 180] };
  const guestProgram = buildIframeChallengeGuestProgram(paint);
  const hostProgram = buildIframeChallengeHostProgram(guestProgram);
  const harness = makeHarness();
  assert.equal(await vm.runInContext(hostProgram, harness.hostContext), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.executedGuestPrograms[0], guestProgram,
    "the host passes the generated guest program as one JSON-serialized argument");
  assert.equal(harness.receiverDataType, "object", "iframe receiver must receive an object, not JSON text");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.iframeWindow.__iframePaintChallenge)), paint);
  assert.equal(harness.iframeDocument.body.style.backgroundColor, "rgb(40, 70, 180)");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.guestWindow.__iframeChallengeAck)), {
    type: "iframe-challenge-painted", ...paint,
  });
  assert.equal(await vm.runInContext(buildIframeChallengeAckHostProgram(paint.challengeId), harness.hostContext), true,
    "host acknowledgement predicate observes the receiver-set challenge id");

  const legacyPayload = JSON.stringify({ ...paint, type: "iframe-paint-challenge" });
  const exactLegacyHostBytes = `(async()=>{const view=document.querySelector('webview');\n    return view.executeJavaScript("(()=>{const message=${JSON.stringify(legacyPayload)};document.querySelector('#edge-frame').contentWindow.postMessage(message,'*');return true})()");})()`;
  assert.throws(() => new vm.Script(exactLegacyHostBytes), SyntaxError,
    "the previous host bytes must remain a parse-failure negative control");

  const escapedStringGuestProgram = `(()=>{const message=${JSON.stringify(legacyPayload)};document.querySelector('#edge-frame').contentWindow.postMessage(message,'*');return true})()`;
  const escapedHarness = makeHarness();
  assert.equal(await vm.runInContext(buildIframeChallengeHostProgram(escapedStringGuestProgram), escapedHarness.hostContext), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(escapedHarness.receiverDataType, "string", "escaping only the old payload still posts JSON text");
  assert.equal(await vm.runInContext(buildIframeChallengeAckHostProgram(paint.challengeId), escapedHarness.hostContext), false,
    "the object-only iframe receiver must not acknowledge the escaped string negative");
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
  assert.equal(quickExit.ownershipKnown, true);
  assert.deepEqual(quickExit.remaining, []);
  assert.deepEqual(processGroupCensus(quickExit.pgid, await processCensus()), []);

  const timeout = await runOwnedProcess({
    command: process.execPath,
    args: ["-e", "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"],
    deadlineMs: 300,
    terminateGraceMs: 500,
    reapTimeoutMs: 2_000,
  });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.termSent, true);
  assert.equal(timeout.ownershipKnown, true);
  assert.deepEqual(timeout.remaining, []);
  assert.deepEqual(processGroupCensus(timeout.pgid, await processCensus()), []);

  const orphanSuffix = `${process.pid}-${Date.now()}`;
  const orphanParentMarker = `native-scale-orphan-parent-${orphanSuffix}`;
  const orphanChildMarker = `native-scale-orphan-child-${orphanSuffix}`;
  const orphanChildSource = `const marker=${JSON.stringify(orphanChildMarker)};setInterval(()=>{},1000)`;
  const orphanParentSource = `const marker=${JSON.stringify(orphanParentMarker)};const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(orphanChildSource)}],{stdio:'ignore'});child.once('spawn',()=>{child.unref();process.stdout.write(JSON.stringify({event:'parent-exiting',parentPid:process.pid,childPid:child.pid})+'\\n');setTimeout(()=>process.exit(0),800)});`;
  let orphanLaunch = null;
  let orphanParentGroupObservation = null;
  let orphanChildGroupObservation = null;
  const orphanRun = runOwnedProcess({
    command: process.execPath,
    args: ["-e", orphanParentSource],
    deadlineMs: 3_000,
    terminateGraceMs: 500,
    reapTimeoutMs: 2_000,
    onLaunch: (receipt) => { orphanLaunch = receipt; },
    census: async () => {
      const rows = await processCensus();
      if (orphanLaunch) {
        const group = processGroupCensus(orphanLaunch.pgid, rows);
        const childMember = group.find(({ command: processCommand }) => processCommand.includes(orphanChildMarker));
        if (childMember) orphanChildGroupObservation = childMember;
      }
      return rows;
    },
  });
  const parentObservationDeadline = Date.now() + 2_000;
  while (!orphanParentGroupObservation && Date.now() < parentObservationDeadline) {
    if (orphanLaunch) {
      const rows = await processCensus();
      const group = processGroupCensus(orphanLaunch.pgid, rows);
      const target = group.find(({ command: processCommand }) => processCommand.includes(orphanParentMarker));
      const anchor = group.find(({ pid }) => pid === orphanLaunch.pid);
      if (target && anchor) orphanParentGroupObservation = { target, anchor };
    }
    if (!orphanParentGroupObservation) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(orphanParentGroupObservation, "target and supervisor must be observed together in the owned group");
  const orphan = await orphanRun;
  const parentExitProof = JSON.parse(orphan.stdout.trim());
  assert.equal(parentExitProof.event, "parent-exiting");
  assert.equal(parentExitProof.parentPid, orphanParentGroupObservation.target.pid);
  assert.equal(orphanParentGroupObservation.target.pgid, orphan.pgid);
  assert.equal(orphanParentGroupObservation.anchor.pid, orphan.pid);
  assert.notEqual(parentExitProof.parentPid, orphanParentGroupObservation.anchor.pid,
    "the target process is a member, not the process-group anchor");
  assert.notEqual(parentExitProof.childPid, parentExitProof.parentPid);
  assert.notEqual(parentExitProof.childPid, orphan.pid);
  assert.equal(orphan.pgid, orphan.pid, "the retained supervisor is the process-group anchor");
  assert.equal(orphanChildGroupObservation?.pid, parentExitProof.childPid,
    "the unref'd orphan must remain observable in the owned group before cleanup");
  assert.equal(orphanChildGroupObservation?.pgid, orphan.pgid,
    "the unref'd child must remain in the supervisor-owned process group");
  assert.equal(orphan.code, 0);
  assert.equal(orphan.timedOut, false);
  assert.equal(orphan.termSent, true, "orphaned child should receive owned-group cleanup");
  assert.equal(orphan.ownershipKnown, true);
  assert.deepEqual(orphan.remaining, []);
  assert.deepEqual(processGroupCensus(orphan.pgid, await processCensus()), []);
});

test("owned process launch receipts survive census errors, bounded hangs, and receipt failures",
  { skip: sourceOnlyValidation ? "source-only mode does not spawn process groups" : false }, async (t) => {
  let launchReceipt = null;
  let censusCalls = 0;
  const transient = await runOwnedProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('census-recovered')"],
    deadlineMs: 2_000,
    onLaunch: (receipt) => { launchReceipt = receipt; },
    census: async () => {
      censusCalls += 1;
      if (censusCalls === 1) throw new Error("injected post-spawn census error");
      return processCensus();
    },
  });
  assert.equal(launchReceipt.pgid, transient.pgid, "immutable launch receipt must exist before target launch");
  assert.equal(transient.stdout, "census-recovered");
  assert.equal(transient.ownershipKnown, true, "temporary census failure should recover before cleanup closes");
  assert.ok(censusCalls >= 2);

  let hungLaunch = null;
  const startedAt = Date.now();
  await assert.rejects(runOwnedProcess({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    deadlineMs: 2_000,
    terminateGraceMs: 50,
    reapTimeoutMs: 800,
    censusTimeoutMs: 30,
    onLaunch: (receipt) => { hungLaunch = receipt; },
    census: () => new Promise(() => {}),
  }), (error) => {
    assert.equal(error.receipt.pid, hungLaunch.pid);
    assert.equal(error.receipt.pgid, hungLaunch.pgid);
    assert.equal(error.receipt.ownershipKnown, false);
    assert.match(error.receipt.censusError ?? error.message, /census|cleanup/i);
    return true;
  });
  assert.ok(Date.now() - startedAt < 2_500, "hung census path must honor cleanup bounds");
  assert.deepEqual(processGroupCensus(hungLaunch.pgid, await processCensus()), [], "the anchor self-reaps after a bounded owner failure");

  let finalCensusLaunch = null;
  let finalCensusCalls = 0;
  await assert.rejects(runOwnedProcess({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    deadlineMs: 2_000,
    onLaunch: (receipt) => { finalCensusLaunch = receipt; },
    census: async () => {
      finalCensusCalls += 1;
      if (finalCensusCalls >= 2) throw new Error("injected final census failure");
      return processCensus();
    },
  }), (error) => {
    assert.equal(error.receipt.pid, finalCensusLaunch.pid);
    assert.equal(error.receipt.pgid, finalCensusLaunch.pgid);
    assert.equal(error.receipt.ownershipKnown, false, "failed final census is not treated as empty");
    assert.match(error.receipt.censusError, /final census failure/);
    return true;
  });
  assert.deepEqual(processGroupCensus(finalCensusLaunch.pgid, await processCensus()), []);

  let failedReceiptLaunch = null;
  await assert.rejects(runOwnedProcess({
    command: process.execPath,
    args: ["-e", "process.exit(17)"],
    deadlineMs: 2_000,
    onLaunch: (receipt) => { failedReceiptLaunch = receipt; throw new Error("injected launch receipt write failure"); },
  }), (error) => {
    assert.equal(error.receipt.pid, failedReceiptLaunch.pid);
    assert.equal(error.receipt.pgid, failedReceiptLaunch.pgid);
    assert.equal(error.receipt.ownershipKnown, true, "unlaunched target must still leave a durable ownership outcome");
    return true;
  });
  assert.deepEqual(processGroupCensus(failedReceiptLaunch.pgid, await processCensus()), []);
  assert.equal(shouldRemoveNativeScaleScratch({ processOwnershipKnown: true, finalCensusKnown: true,
    groupEmpty: true, receiptPersisted: false }), false, "receipt write failure preserves scratch");
});

test("owned process refuses TERM/KILL when the observed process-group generation loses its owner", {
  skip: sourceOnlyValidation ? "source-only mode does not spawn process groups" : false,
}, async () => {
  for (const lostSignal of ["SIGTERM", "SIGKILL"]) {
    let launchReceipt;
    const ownerCommands = [];
    const error = await runOwnedProcess({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      deadlineMs: 2_000,
      terminateGraceMs: 70,
      reapTimeoutMs: 1_500,
      censusTimeoutMs: 100,
      onLaunch: (receipt) => { launchReceipt = receipt; },
      census: async () => [{ pid: launchReceipt.pid, pgid: launchReceipt.pgid, command: "owned-anchor" },
        { pid: 987654, pgid: launchReceipt.pgid, command: "injected-generation-member" }],
      beforeOwnerCommand: ({ signal }) => {
        ownerCommands.push(signal);
        return signal !== lostSignal;
      },
    }).then(() => null, (failure) => failure);
    assert.ok(error, `${lostSignal} generation loss must reject the run`);
    assert.equal(error.receipt.pid, launchReceipt.pid);
    assert.equal(error.receipt.pgid, launchReceipt.pgid);
    assert.equal(error.receipt.ownershipKnown, false, "lost ownership is unknown even when the injected census is not trusted");
    assert.ok(ownerCommands.includes(lostSignal), `the ${lostSignal} interleaving must be exercised`);
    assert.deepEqual(processGroupCensus(launchReceipt.pgid, await processCensus()), [],
      "only the retained supervisor may self-clean after its owner command is refused");
  }
});
