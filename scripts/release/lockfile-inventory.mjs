import fs from "node:fs/promises";
import path from "node:path";

function unquote(value) {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function splitPackageKey(raw) {
  const key = unquote(raw).replace(/\([^)]*\)+$/, "");
  const separator = key.lastIndexOf("@");
  if (separator <= 0) throw new Error(`invalid_lockfile_package_key:${raw}`);
  return { name: key.slice(0, separator), version: key.slice(separator + 1) };
}

export async function lockedPackages(lockfile) {
  const text = await fs.readFile(lockfile, "utf8");
  const lines = text.split(/\r?\n/);
  const packagesStart = lines.indexOf("packages:");
  const snapshotsStart = lines.indexOf("snapshots:");
  if (packagesStart < 0 || snapshotsStart < packagesStart) throw new Error("unsupported_pnpm_lockfile:missing_packages_or_snapshots");
  const inventory = new Map();
  let current;
  for (const line of lines.slice(packagesStart + 1, snapshotsStart)) {
    const packageMatch = /^  (\S.*):$/.exec(line);
    if (packageMatch) {
      current = splitPackageKey(packageMatch[1]);
      continue;
    }
    const integrityMatch = /^    resolution: \{[^}]*integrity: ([^,}]+)[^}]*\}$/.exec(line);
    if (integrityMatch && current) {
      const integrity = unquote(integrityMatch[1].trim());
      const key = `${current.name}@${current.version}`;
      const previous = inventory.get(key);
      if (previous && previous.integrity !== integrity) throw new Error(`ambiguous_lockfile_integrity:${key}`);
      inventory.set(key, { ...current, integrity });
    }
  }
  return inventory;
}

export async function cargoLockedPackages(lockfile) {
  const text = await fs.readFile(lockfile, "utf8");
  const inventory = [];
  for (const block of text.split("[[package]]").slice(1)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    const checksum = /^checksum = "([0-9a-f]+)"$/m.exec(block)?.[1];
    if (name && version && checksum) inventory.push({ checksum, name, version });
  }
  if (inventory.length === 0) throw new Error("cargo_lockfile_inventory_empty");
  return inventory.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

async function packageJsonFiles(root) {
  const files = [];
  const visited = new Set();
  async function visitPackage(directory) {
    const real = await fs.realpath(directory);
    if (visited.has(real)) return;
    visited.add(real);
    const manifest = path.join(directory, "package.json");
    if ((await fs.stat(manifest).catch(() => null))?.isFile()) files.push(manifest);
    const nested = path.join(directory, "node_modules");
    if ((await fs.stat(nested).catch(() => null))?.isDirectory()) await visitNodeModules(nested);
  }
  async function visitNodeModules(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".bin" || entry.name === ".pnpm") continue;
      const child = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await fs.readdir(child)) await visitPackage(path.join(child, scoped));
      } else {
        const metadata = await fs.stat(child).catch(() => null);
        if (metadata?.isDirectory()) await visitPackage(child);
      }
    }
  }
  await visitNodeModules(root);
  return files;
}

export async function packagedProductionInventory(packageDir, lockfile) {
  const lock = await lockedPackages(lockfile);
  const nodeModules = path.join(packageDir, "node_modules");
  const found = new Map();
  for (const file of await packageJsonFiles(nodeModules)) {
    const metadata = JSON.parse(await fs.readFile(file, "utf8"));
    if (!metadata.name || !metadata.version || metadata.name.startsWith("@surf-ace/")) continue;
    const key = `${metadata.name}@${metadata.version}`;
    const locked = lock.get(key);
    if (!locked) throw new Error(`packaged_dependency_not_locked:${key}`);
    found.set(key, locked);
  }
  if (found.size === 0) throw new Error("packaged_dependency_inventory_empty");
  return [...found.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}
