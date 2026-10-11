import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

export const NATIVE_SCALE_PINNED_SOURCES = [
  "packages/electron/scripts/create-browser-content-scale-native-pins.mjs",
  "packages/electron/scripts/native-scale-owned-process.mjs",
  "packages/electron/scripts/native-scale-process-supervisor.mjs",
  "packages/electron/scripts/native-scale-runner-guard.mjs",
  "packages/electron/scripts/native-scale-iframe-challenge.mjs",
  "packages/electron/scripts/run-browser-content-scale-native-private.mjs",
  "packages/electron/scripts/test-browser-content-scale-native.mjs",
  "packages/electron/src/guest-preload.ts",
  "packages/electron/src/renderer/browser-content-scale.ts",
  "packages/electron/src/renderer/index.html",
  "packages/electron/src/renderer/renderer.ts",
  "packages/electron/src/renderer/styles.css",
];

const PIN_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const REQUIRED_DIST_FILES = [
  "guest-preload.cjs",
  "renderer/index.html",
  "renderer/renderer.js",
  "renderer/styles.css",
];

export const NATIVE_SCALE_EXPECTED_POINTERS = [
  "scale-0.85-top-left",
  "scale-0.85-quarter",
  "scale-0.85-middle",
  "scale-0.85-right-upper",
  "scale-1.275-top-left",
  "scale-1.275-quarter",
  "scale-1.275-middle",
  "scale-1.275-right-upper",
];
export const NATIVE_SCALE_EXPECTED_IFRAME_POINTS = [
  "scale-0.85-iframe-center",
  "scale-0.85-iframe-bottom-right",
  "scale-1.275-iframe-center",
  "scale-1.275-iframe-bottom-right",
];
export const NATIVE_SCALE_EXPECTED_PNG_LABELS = [
  ...NATIVE_SCALE_EXPECTED_POINTERS.map((label) => `${label}-marker`),
  ...NATIVE_SCALE_EXPECTED_IFRAME_POINTS.map((label) => `${label}-iframe-paint`),
  "legacy-root-zoom-negative",
];

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

async function digestDirectory(root) {
  const files = {};
  const visit = async (directory, prefix = "") => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Pinned build contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        files[relative] = sha256(await fs.readFile(absolute));
      } else {
        throw new Error(`Pinned build contains a non-file entry: ${relative}`);
      }
    }
  };
  await visit(root);
  return files;
}

function runGit(repoDir, args) {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

export async function collectNativeScalePinSnapshot({ repoDir, packageDir, electronVersion }) {
  if (!/^\d+\.\d+\.\d+$/.test(electronVersion ?? "")) {
    throw new Error("A pinned three-part Electron version is required");
  }
  const status = runGit(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) throw new Error(`Native scale source worktree is not clean: ${status}`);
  const head = runGit(repoDir, ["rev-parse", "HEAD"]);
  const tree = runGit(repoDir, ["rev-parse", "HEAD^{tree}"]);
  if (!COMMIT_PATTERN.test(head) || !COMMIT_PATTERN.test(tree)) {
    throw new Error("Git returned an invalid native scale source pin");
  }

  const sourceDigests = {};
  for (const relativePath of NATIVE_SCALE_PINNED_SOURCES) {
    sourceDigests[relativePath] = sha256(await fs.readFile(path.join(repoDir, relativePath)));
  }
  const distRoot = path.join(packageDir, "dist");
  const distDigests = await digestDirectory(distRoot);
  for (const requiredPath of REQUIRED_DIST_FILES) {
    if (!distDigests[requiredPath]) throw new Error(`Pinned build is missing dist/${requiredPath}`);
  }
  return {
    schemaVersion: PIN_SCHEMA_VERSION,
    head,
    tree,
    electronVersion,
    sourceDigests,
    distDigests,
    distTreeSha256: sha256(Buffer.from(canonicalJson(distDigests))),
  };
}

export async function readNativeScalePinManifest(pinPath, expectedSha256, repoDir) {
  if (!SHA256_PATTERN.test(expectedSha256 ?? "")) {
    throw new Error("An exact SHA-256 for the native scale pin manifest is required");
  }
  const absolutePinPath = path.resolve(pinPath ?? "");
  const realRepoDir = await fs.realpath(repoDir);
  const realPinPath = await fs.realpath(absolutePinPath);
  const relativeToRepo = path.relative(realRepoDir, realPinPath);
  if (relativeToRepo === "" || (relativeToRepo !== ".." && !relativeToRepo.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToRepo))) {
    throw new Error("Native scale pin manifest must be outside the source worktree");
  }
  const bytes = await fs.readFile(realPinPath);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) throw new Error("Native scale pin manifest digest does not match admission");
  const pins = JSON.parse(bytes.toString("utf8"));
  if (!pins || typeof pins !== "object" || Array.isArray(pins) || pins.schemaVersion !== PIN_SCHEMA_VERSION) {
    throw new Error("Unsupported native scale pin manifest");
  }
  return { pins, sha256: actualSha256 };
}

export function validateNativeScaleAdmission({ admission, expectedPinsSha256, display, now = Date.now() }) {
  if (!admission || typeof admission !== "object" || Array.isArray(admission) || admission.schemaVersion !== 1) {
    throw new Error("Unsupported private native scale admission");
  }
  if (admission.privateGuiSlot !== true || !/^[a-z0-9][a-z0-9._-]{2,95}$/i.test(admission.slotId ?? "")) {
    throw new Error("A named private GUI slot admission is required");
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,95}$/i.test(admission.runId ?? "")) {
    throw new Error("A unique native scale run identity is required");
  }
  if (admission.sourcePinsSha256 !== expectedPinsSha256 || !SHA256_PATTERN.test(expectedPinsSha256 ?? "")) {
    throw new Error("Private native scale admission does not match the source pin manifest");
  }
  if (!Number.isSafeInteger(admission.issuedAtMs) || !Number.isSafeInteger(admission.expiresAtMs) ||
      admission.issuedAtMs > now + 30_000 || admission.expiresAtMs <= now ||
      admission.expiresAtMs <= admission.issuedAtMs) {
    throw new Error("Private native scale admission is invalid or expired");
  }
  if (!Number.isSafeInteger(admission.deadlineMs) || admission.deadlineMs < 5_000 || admission.deadlineMs > 180_000) {
    throw new Error("Private native scale admission has an unsafe deadline");
  }
  if (typeof display !== "string" || display.length === 0 || admission.display !== display) {
    throw new Error("Current display does not match the admitted private GUI slot");
  }
  if (!Array.isArray(admission.baselineElectronPids) || admission.baselineElectronPids.some((pid) =>
    !Number.isSafeInteger(pid) || pid <= 0) || new Set(admission.baselineElectronPids).size !== admission.baselineElectronPids.length) {
    throw new Error("Private native scale admission must pin the baseline Electron process census");
  }
  return {
    slotId: admission.slotId,
    runId: admission.runId,
    sourcePinsSha256: expectedPinsSha256,
    display,
    deadlineMs: admission.deadlineMs,
    baselineElectronPids: [...admission.baselineElectronPids].sort((left, right) => left - right),
  };
}

export async function verifyNativeScalePins({ repoDir, packageDir, pins, electronVersion }) {
  if (electronVersion && pins.electronVersion !== electronVersion) {
    throw new Error(`Electron runtime ${electronVersion} does not match pinned ${pins.electronVersion}`);
  }
  const actual = await collectNativeScalePinSnapshot({ repoDir, packageDir, electronVersion: pins.electronVersion });
  if (canonicalJson(actual) !== canonicalJson(pins)) {
    const location = actual.head !== pins.head ? "source HEAD" :
      actual.tree !== pins.tree ? "source tree" :
        actual.distTreeSha256 !== pins.distTreeSha256 ? "built dist" : "pinned source file";
    throw new Error(`Native scale ${location} does not match the admitted pin manifest`);
  }
  return actual;
}

export async function saveNativeScalePng({ bytes, evidenceDir, phaseId, label, source }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Native scale capture is not a PNG");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(phaseId ?? "")) {
    throw new Error("Native scale capture has an invalid phase identity");
  }
  const requestedRoot = path.resolve(evidenceDir);
  await fs.mkdir(requestedRoot, { recursive: true });
  const root = await fs.realpath(requestedRoot);
  const filePath = path.resolve(root, `${phaseId}.png`);
  if (path.dirname(filePath) !== root) throw new Error("Native scale capture path escaped the evidence directory");
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return {
    file: path.basename(filePath),
    label,
    phaseId,
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
    source,
  };
}

export async function digestEvidenceDirectory(root) {
  return digestDirectory(root);
}

export function decodeNativeScalePngPixel(bytes, pixelX, pixelY) {
  if (!Buffer.isBuffer(bytes) || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Native scale evidence image is not a PNG");
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const imageData = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (offset + 12 + length > bytes.length) throw new Error("Native scale PNG chunk is truncated");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === "IDAT") imageData.push(chunk);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0 || width < 1 || height < 1) {
    throw new Error("Native scale PNG must use non-interlaced 8-bit RGB or RGBA pixels");
  }
  if (!Number.isSafeInteger(pixelX) || !Number.isSafeInteger(pixelY) || pixelX < 0 || pixelX >= width || pixelY < 0 || pixelY >= height) {
    throw new Error(`Native scale PNG sample ${pixelX},${pixelY} is outside ${width}x${height}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(imageData));
  if (filtered.length !== height * (stride + 1)) throw new Error("Native scale PNG pixel buffer has an unexpected size");
  const pixels = Buffer.alloc(height * stride);
  let inputOffset = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[inputOffset++];
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[inputOffset++];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      else if (filter !== 0) throw new Error(`Unsupported native scale PNG filter ${filter}`);
      pixels[y * stride + x] = (raw + predictor) & 0xff;
    }
  }
  const offset = (pixelY * width + pixelX) * channels;
  return { width, height, rgba: [pixels[offset], pixels[offset + 1], pixels[offset + 2], channels === 4 ? pixels[offset + 3] : 255] };
}

function sameNumbers(left, right, tolerance = 0) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => Number.isFinite(value) && Math.abs(value - right[index]) <= tolerance);
}

function exactLabelSet(items, labels, field, description) {
  if (!Array.isArray(items)) throw new Error(`Fixture evidence is missing ${description}`);
  const actual = items.map((item) => item?.[field]);
  if (new Set(actual).size !== labels.length || labels.some((label) => !actual.includes(label)) || actual.length !== labels.length) {
    throw new Error(`Fixture evidence has incomplete or duplicate ${description}`);
  }
}

export async function validateNativeScaleFixtureEvidence({ evidenceDir, evidence, digestMap, admission, pins, pinsSha256 }) {
  if (!evidence || typeof evidence !== "object" || evidence.schemaVersion !== 1) throw new Error("Fixture evidence schema is missing or unsupported");
  if (evidence.result !== "passed" || evidence.failedStage !== null) throw new Error("Native scale fixture did not report a passed result");
  if (evidence.runId !== admission.runId || evidence.slotId !== admission.slotId || evidence.pinsManifestSha256 !== pinsSha256) {
    throw new Error("Fixture evidence identity does not match its admitted run");
  }
  const expectedSource = { head: pins.head, tree: pins.tree, distTreeSha256: pins.distTreeSha256, electronVersion: pins.electronVersion };
  if (canonicalJson(evidence.source) !== canonicalJson(expectedSource)) throw new Error("Fixture evidence source/build identity does not match its pin manifest");
  if (!Array.isArray(evidence.blockedRequests) || evidence.blockedRequests.length ||
      !Array.isArray(evidence.consoleErrors) || evidence.consoleErrors.length) {
    throw new Error("Fixture evidence reports blocked requests or console errors");
  }

  exactLabelSet(evidence.pointers, NATIVE_SCALE_EXPECTED_POINTERS, "label", "pointer phases");
  exactLabelSet(evidence.pngs, NATIVE_SCALE_EXPECTED_PNG_LABELS, "label", "PNG phase set");
  const pngByLabel = new Map(evidence.pngs.map((record) => [record.label, record]));
  for (const pointer of evidence.pointers) {
    const scale = pointer.label.includes("1.275") ? 1.275 : 0.85;
    const markerPng = pngByLabel.get(`${pointer.label}-marker`);
    if (pointer.scale !== scale || !sameNumbers([pointer.host?.x, pointer.host?.y], [pointer.markerHost?.x, pointer.markerHost?.y], 1.5) ||
        !sameNumbers([pointer.host?.x, pointer.host?.y], [pointer.guest?.x * scale, pointer.guest?.y * scale], 1.5) ||
        !markerPng?.phaseId || pointer.challengeId !== `${admission.runId}/${markerPng.label}/${markerPng.phaseId}`) {
      throw new Error(`Pointer evidence failed the guest/marker mapping for ${pointer.label}`);
    }
  }
  exactLabelSet(evidence.iframePoints, NATIVE_SCALE_EXPECTED_IFRAME_POINTS, "label", "iframe phases");
  for (const point of evidence.iframePoints) {
    const { iframePointer, iframeRect, expectedLocal, scale } = point;
    const iframePng = pngByLabel.get(`${point.label}-iframe-paint`);
    if (![0.85, 1.275].includes(scale) || !iframePointer || !iframeRect || !expectedLocal ||
        iframePointer.x < 0 || iframePointer.y < 0 || iframePointer.x >= iframeRect.width || iframePointer.y >= iframeRect.height ||
        !sameNumbers([iframePointer.x, iframePointer.y], [expectedLocal.x, expectedLocal.y], 2) ||
        iframePointer.challengeId !== point.challengeId || point.challengeId !== `${admission.runId}/${iframePng?.label}/${iframePng?.phaseId}`) {
      throw new Error(`Iframe evidence failed its local bounds for ${point.label}`);
    }
  }

  const imageRoot = await fs.realpath(evidenceDir);
  const pngNames = Object.keys(digestMap ?? {}).filter((name) => name.toLowerCase().endsWith(".png")).sort();
  const records = [...evidence.pngs].sort((left, right) => left.file.localeCompare(right.file));
  if (pngNames.length !== records.length || pngNames.some((name, index) => name !== records[index].file)) {
    throw new Error("Fixture evidence PNG set does not match the retained images");
  }
  const pointerPngs = new Set(NATIVE_SCALE_EXPECTED_POINTERS.map((label) => `${label}-marker`));
  const iframePngs = new Set(NATIVE_SCALE_EXPECTED_IFRAME_POINTS.map((label) => `${label}-iframe-paint`));
  const phaseIds = new Set();
  const paintColors = new Set();
  for (const record of records) {
    if (record.file !== `${record.phaseId}.png` || !/^[a-z0-9][a-z0-9._-]{0,95}\.png$/i.test(record.file) ||
        typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256) || digestMap[record.file] !== record.sha256) {
      throw new Error(`Fixture evidence has an invalid PNG receipt for ${record.label}`);
    }
    const colorKey = record.paint?.rgb?.join(",");
    if (phaseIds.has(record.phaseId) || paintColors.has(colorKey)) throw new Error(`Fixture evidence reused a phase or paint challenge for ${record.label}`);
    phaseIds.add(record.phaseId);
    paintColors.add(colorKey);
    if (!record.source || record.source.runId !== admission.runId || record.source.slotId !== admission.slotId ||
        record.source.pinsManifestSha256 !== pinsSha256 || record.source.head !== pins.head || record.source.tree !== pins.tree ||
        record.source.distTreeSha256 !== pins.distTreeSha256 || record.source.electronVersion !== pins.electronVersion) {
      throw new Error(`PNG phase identity does not match the admitted run for ${record.label}`);
    }
    const imagePath = path.join(imageRoot, record.file);
    const bytes = await fs.readFile(imagePath);
    if (sha256(bytes) !== record.sha256) throw new Error(`Retained PNG digest does not match its phase receipt for ${record.label}`);
    const paint = record.paint;
    if (!paint || paint.challengeId !== `${admission.runId}/${record.label}/${record.phaseId}` ||
        !Array.isArray(paint.rgb) || paint.rgb.length !== 3 || paint.rgb.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
      throw new Error(`PNG phase is missing its fresh paint challenge for ${record.label}`);
    }
    if (pointerPngs.has(record.label) || iframePngs.has(record.label)) {
      const sample = pointerPngs.has(record.label) ? record.sample : record.sample;
      if (!sample || !Number.isSafeInteger(sample.x) || !Number.isSafeInteger(sample.y) || !sameNumbers(sample.rgba?.slice(0, 3), paint.rgb)) {
        throw new Error(`PNG phase sample does not match its paint challenge for ${record.label}`);
      }
      const actual = decodeNativeScalePngPixel(bytes, sample.x, sample.y);
      if (!sameNumbers(actual.rgba.slice(0, 3), paint.rgb)) throw new Error(`PNG pixels are stale or missing the current phase paint for ${record.label}`);
      const expectedKind = pointerPngs.has(record.label) ? "marker" : "iframe";
      if (paint.kind !== expectedKind) throw new Error(`PNG phase has the wrong guest paint source for ${record.label}`);
    } else if (record.label === "legacy-root-zoom-negative") {
      if (paint.kind !== "legacy-negative" || !Array.isArray(record.samples) || record.samples.length !== 2) {
        throw new Error("Legacy root-zoom negative evidence is incomplete");
      }
      const target = record.samples.find(({ name }) => name === "pointer-target");
      const marker = record.samples.find(({ name }) => name === "painted-marker");
      if (!target || !marker || sameNumbers(target.rgba?.slice(0, 3), paint.rgb) || !sameNumbers(marker.rgba?.slice(0, 3), paint.rgb) ||
          !sameNumbers(decodeNativeScalePngPixel(bytes, target.pixel.x, target.pixel.y).rgba.slice(0, 3), target.rgba.slice(0, 3)) ||
          !sameNumbers(decodeNativeScalePngPixel(bytes, marker.pixel.x, marker.pixel.y).rgba.slice(0, 3), paint.rgb)) {
        throw new Error("Legacy root-zoom negative PNG does not prove displaced current-phase paint");
      }
    } else throw new Error(`Unexpected native scale PNG phase ${record.label}`);
  }
  return { valid: true, pngCount: records.length, pointerCount: evidence.pointers.length, iframeCount: evidence.iframePoints.length };
}

export function shouldRemoveNativeScaleScratch({ processOwnershipKnown, finalCensusKnown, groupEmpty, receiptPersisted,
  launchReceiptPersisted = true }) {
  return processOwnershipKnown === true && finalCensusKnown === true && groupEmpty === true &&
    receiptPersisted === true && launchReceiptPersisted === true;
}

export function nativeScaleRunFailures({ processReceipt, evidenceValidation, evidenceDigestError, unexpectedElectronPids,
  finalCensusKnown, groupEmpty, executionReceiptPersisted, launchReceiptPersisted = true }) {
  const failures = [];
  if (launchReceiptPersisted !== true) failures.push("launch ownership receipt was not persisted");
  if (!processReceipt) failures.push("owned process launch receipt is missing");
  if (processReceipt && processReceipt.code !== 0) failures.push(`fixture process exited ${processReceipt.code ?? processReceipt.signal ?? "without status"}`);
  if (processReceipt?.timedOut) failures.push("fixture process exceeded its deadline");
  if (!processReceipt?.ownershipKnown) failures.push("owned process group cleanup is unknown");
  if (evidenceDigestError) failures.push(`evidence digest failed: ${evidenceDigestError}`);
  if (!evidenceValidation?.valid) failures.push("complete successful fixture evidence is missing or invalid");
  if (!Array.isArray(unexpectedElectronPids) || unexpectedElectronPids.length) failures.push("unexpected Electron processes remain");
  if (finalCensusKnown !== true) failures.push("final Electron/process census is unknown");
  if (groupEmpty !== true) failures.push("owned process group is not confirmed empty");
  if (executionReceiptPersisted !== true) failures.push("execution receipt was not persisted");
  return failures;
}
