import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const NATIVE_SCALE_PINNED_SOURCES = [
  "packages/electron/scripts/create-browser-content-scale-native-pins.mjs",
  "packages/electron/scripts/native-scale-owned-process.mjs",
  "packages/electron/scripts/native-scale-runner-guard.mjs",
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
