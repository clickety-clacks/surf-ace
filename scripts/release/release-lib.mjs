import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const exec = promisify(execFile);

export function parseArgs(argv, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid_argument_pair:${flag ?? "<missing>"}`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown_argument:${flag}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate_argument:${flag}`);
    values[name] = value;
  }
  for (const name of required) {
    if (!values[name]) throw new Error(`missing_argument:--${name}`);
  }
  return values;
}

export async function run(command, args, options = {}) {
  const result = await exec(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

export async function capture(command, args, options = {}) {
  return (await exec(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })).stdout.trim();
}

export async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

export async function sri(file, algorithm = "sha512") {
  return `${algorithm}-${createHash(algorithm).update(await fs.readFile(file)).digest("base64")}`;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export async function writeCanonicalJson(file, value) {
  await fs.writeFile(file, canonicalJson(value));
}

export function resolveInside(root, requested) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, requested);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`path_escapes_root:${requested}`);
  }
  return absolute;
}

export function assertDisjointTrees(left, right) {
  const absoluteLeft = path.resolve(left);
  const absoluteRight = path.resolve(right);
  if (absoluteLeft === absoluteRight || absoluteLeft.startsWith(`${absoluteRight}${path.sep}`) || absoluteRight.startsWith(`${absoluteLeft}${path.sep}`)) {
    throw new Error(`release_trees_overlap:${absoluteLeft}:${absoluteRight}`);
  }
}

export function requiredReleaseOutput(channel, requested) {
  const expected = path.resolve("build/release", channel);
  const actual = path.resolve(requested);
  if (actual !== expected) throw new Error(`release_output_mismatch:${actual}:${expected}`);
  return actual;
}

export async function assertSourceIdentity(sourceDir, sourceTag, sourceCommit) {
  const head = await capture("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  if (head !== sourceCommit) throw new Error(`source_commit_mismatch:${head}:${sourceCommit}`);
  const peeled = await capture("git", ["-C", sourceDir, "rev-parse", `refs/tags/${sourceTag}^{commit}`]);
  if (peeled !== sourceCommit) throw new Error(`source_tag_mismatch:${peeled}:${sourceCommit}`);
}

export async function assertTrackedInputsUnchanged(sourceDir) {
  await run("git", ["-C", sourceDir, "diff", "--exit-code", "HEAD", "--", "."]);
  await run("git", ["-C", sourceDir, "diff", "--cached", "--exit-code", "HEAD", "--", "."]);
}

export async function sourceDateEpoch(sourceDir) {
  const raw = await capture("git", ["-C", sourceDir, "show", "-s", "--format=%ct", "HEAD"]);
  if (!/^\d+$/.test(raw)) throw new Error(`invalid_source_date_epoch:${raw}`);
  return Number(raw);
}

export async function copyTree(source, destination) {
  await fs.cp(source, destination, {
    dereference: false,
    errorOnExist: false,
    force: true,
    preserveTimestamps: false,
    recursive: true,
    verbatimSymlinks: true,
  });
}

async function walk(root, relative = "") {
  const directory = resolveInside(root, relative || ".");
  const names = (await fs.readdir(directory)).sort();
  const entries = [];
  for (const name of names) {
    const childRelative = path.posix.join(relative.split(path.sep).join(path.posix.sep), name);
    const absolute = resolveInside(root, childRelative);
    const metadata = await fs.lstat(absolute);
    if (metadata.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      if (path.isAbsolute(target)) throw new Error(`absolute_link:${childRelative}:${target}`);
      resolveInside(root, path.join(path.dirname(childRelative), target));
      entries.push({ absolute, mode: 0o777, relative: childRelative, target, type: "symlink" });
    } else if (metadata.isDirectory()) {
      entries.push({ absolute, mode: metadata.mode & 0o777, relative: `${childRelative}/`, type: "directory" });
      entries.push(...await walk(root, childRelative));
    } else if (metadata.isFile()) {
      entries.push({ absolute, mode: metadata.mode & 0o777, relative: childRelative, type: "file" });
    } else {
      throw new Error(`unsupported_archive_entry:${childRelative}`);
    }
  }
  return entries;
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarHeader(entry, size, epoch) {
  const header = Buffer.alloc(512);
  const bytes = Buffer.from(entry.relative.replace(/\/$/, ""));
  let name = bytes;
  let prefix = Buffer.alloc(0);
  if (bytes.length > 100) {
    const split = entry.relative.lastIndexOf("/", 155);
    if (split < 1) throw new Error(`tar_path_too_long:${entry.relative}`);
    prefix = Buffer.from(entry.relative.slice(0, split));
    name = Buffer.from(entry.relative.slice(split + 1).replace(/\/$/, ""));
  }
  if (name.length > 100 || prefix.length > 155) throw new Error(`tar_path_too_long:${entry.relative}`);
  name.copy(header, 0);
  header.write(octal(entry.type === "directory" ? 0o755 : entry.mode, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(size, 12), 124, "ascii");
  header.write(octal(epoch, 12), 136, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 53 : entry.type === "symlink" ? 50 : 48;
  if (entry.type === "symlink") {
    const linkTarget = Buffer.from(entry.target);
    if (linkTarget.length > 100) throw new Error(`tar_link_target_too_long:${entry.relative}`);
    linkTarget.copy(header, 157);
  }
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  prefix.copy(header, 345);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

export async function createTarGz(root, output, epoch) {
  const blocks = [];
  for (const entry of await walk(root)) {
    const data = entry.type === "file" ? await fs.readFile(entry.absolute) : Buffer.alloc(0);
    blocks.push(tarHeader(entry, entry.type === "file" ? data.length : 0, epoch));
    if (entry.type === "file") {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  await fs.writeFile(output, gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 }));
}

export async function createDirectoryTarGz(source, entryName, output, epoch) {
  const stage = `${output}.stage`;
  await removeIfExists(stage);
  await fs.mkdir(stage, { recursive: true });
  try {
    await copyTree(source, path.join(stage, entryName));
    await createTarGz(stage, output, epoch);
  } finally {
    await removeIfExists(stage);
  }
}

const crcTable = Array.from({ length: 256 }, (_, start) => {
  let value = start;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(epoch) {
  const date = new Date(Math.max(epoch, 315532800) * 1000);
  const time = (date.getUTCSeconds() >> 1) | (date.getUTCMinutes() << 5) | (date.getUTCHours() << 11);
  const day = date.getUTCDate() | ((date.getUTCMonth() + 1) << 5) | ((date.getUTCFullYear() - 1980) << 9);
  return { day, time };
}

export async function createZip(root, output, epoch) {
  const local = [];
  const central = [];
  let offset = 0;
  const timestamp = dosTime(epoch);
  for (const entry of await walk(root)) {
    const name = Buffer.from(entry.relative);
    const data = entry.type === "file" ? await fs.readFile(entry.absolute) : entry.type === "symlink" ? Buffer.from(entry.target) : Buffer.alloc(0);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(timestamp.time, 10);
    localHeader.writeUInt16LE(timestamp.day, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(timestamp.time, 12);
    centralHeader.writeUInt16LE(timestamp.day, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    const unixMode = entry.type === "directory" ? 0o040755 : entry.type === "symlink" ? 0o120777 : 0o100000 | entry.mode;
    centralHeader.writeUInt32LE((unixMode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    local.push(localHeader, name, data);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }
  const centralOffset = offset;
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  await fs.writeFile(output, Buffer.concat([...local, centralBytes, end]));
}

export async function createDirectoryZip(source, entryName, output, epoch) {
  const stage = `${output}.stage`;
  await removeIfExists(stage);
  await fs.mkdir(stage, { recursive: true });
  try {
    await copyTree(source, path.join(stage, entryName));
    await createZip(stage, output, epoch);
  } finally {
    await removeIfExists(stage);
  }
}

export async function writeChecksumReceipt(outputDir, filenames) {
  const receiptDir = path.join(outputDir, ".receipts");
  await fs.mkdir(receiptDir, { recursive: true });
  const lines = [];
  for (const filename of [...filenames].sort()) {
    lines.push(`${await sha256(path.join(outputDir, filename))}  ${filename}`);
  }
  await fs.writeFile(path.join(receiptDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

export async function assertExactPublicFiles(outputDir, expected) {
  const actual = (await fs.readdir(outputDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`public_file_set_mismatch:${actual.join(",")}:${wanted.join(",")}`);
  }
}

export async function verifyManifestFiles(manifestPath, supplied) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  for (const [kind, file] of Object.entries(supplied)) {
    const expected = manifest.checksums?.[path.basename(file)];
    if (!expected) throw new Error(`manifest_checksum_missing:${kind}:${path.basename(file)}`);
    const actual = await sha256(file);
    if (actual !== expected) throw new Error(`manifest_checksum_mismatch:${kind}:${actual}:${expected}`);
  }
  return manifest;
}

export async function removeIfExists(target) {
  const absolute = path.resolve(target);
  if (absolute === path.parse(absolute).root) throw new Error(`refusing_broad_removal:${absolute}`);
  await fs.rm(absolute, { force: true, recursive: true });
}
