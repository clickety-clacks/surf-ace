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

export async function workspaceProductionInventory(lockfile, importer) {
  const text = await fs.readFile(lockfile, "utf8");
  const lines = text.split(/\r?\n/);
  const importerHeader = `  ${importer}:`;
  const importersStart = lines.indexOf("importers:");
  const packagesStart = lines.indexOf("packages:");
  const snapshotsStart = lines.indexOf("snapshots:");
  if (importersStart < 0 || packagesStart < 0 || snapshotsStart < packagesStart) {
    throw new Error("unsupported_pnpm_lockfile:missing_workspace_sections");
  }

  const importerIndex = lines.indexOf(importerHeader, importersStart + 1);
  if (importerIndex < 0 || importerIndex >= packagesStart) throw new Error(`lockfile_importer_missing:${importer}`);
  const importerRefs = [];
  let section = null;
  let dependencyName = null;
  for (let index = importerIndex + 1; index < packagesStart; index += 1) {
    const line = lines[index];
    if (/^  \S.*:$/.test(line)) break;
    const sectionMatch = /^    (dependencies|optionalDependencies):$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      dependencyName = null;
      continue;
    }
    if (/^    [A-Za-z][A-Za-z0-9]*:$/.test(line)) {
      section = null;
      dependencyName = null;
      continue;
    }
    if (!section) continue;
    const nameMatch = /^      (.+):$/.exec(line);
    if (nameMatch) {
      dependencyName = unquote(nameMatch[1]);
      continue;
    }
    const versionMatch = /^        version: (.+)$/.exec(line);
    if (versionMatch && dependencyName) importerRefs.push({ name: dependencyName, version: unquote(versionMatch[1].trim()) });
  }
  if (importerRefs.length === 0) throw new Error(`lockfile_importer_dependencies_missing:${importer}`);

  const snapshots = new Map();
  let currentSnapshot = null;
  section = null;
  for (const line of lines.slice(snapshotsStart + 1)) {
    const snapshotMatch = /^  (\S.*):(?: \{\})?$/.exec(line);
    if (snapshotMatch) {
      currentSnapshot = unquote(snapshotMatch[1]);
      snapshots.set(currentSnapshot, []);
      section = null;
      continue;
    }
    if (!currentSnapshot) continue;
    const sectionMatch = /^    (dependencies|optionalDependencies):$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (/^    [A-Za-z][A-Za-z0-9]*:/.test(line)) {
      section = null;
      continue;
    }
    const dependencyMatch = /^      (.+): (.+)$/.exec(line);
    if (section && dependencyMatch) {
      snapshots.get(currentSnapshot).push({ name: unquote(dependencyMatch[1]), version: unquote(dependencyMatch[2].trim()) });
    }
  }

  const lock = await lockedPackages(lockfile);
  const visited = new Set();
  const result = new Map();
  const visit = (name, version) => {
    if (version.startsWith("link:") || name.startsWith("@surf-ace/")) return;
    const snapshotKey = `${name}@${version}`;
    if (visited.has(snapshotKey)) return;
    visited.add(snapshotKey);
    const { name: packageName, version: packageVersion } = splitPackageKey(snapshotKey);
    const locked = lock.get(`${packageName}@${packageVersion}`);
    if (!locked) throw new Error(`workspace_dependency_not_locked:${snapshotKey}`);
    const dependencies = snapshots.get(snapshotKey);
    if (!dependencies) throw new Error(`workspace_dependency_snapshot_missing:${snapshotKey}`);
    result.set(`${packageName}@${packageVersion}`, locked);
    for (const dependency of dependencies) visit(dependency.name, dependency.version);
  };
  for (const dependency of importerRefs) visit(dependency.name, dependency.version);
  return [...result.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
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
