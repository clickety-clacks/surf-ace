#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, removeIfExists, run } from "./release-lib.mjs";
import { packagedProductionInventory } from "./lockfile-inventory.mjs";

export async function verifyOpenclawPackage(packageDir, lockfile, cutoffVerifier) {
  const verifier = path.resolve(cutoffVerifier);
  const verifierPackageRoot = path.resolve(path.dirname(verifier), "../dist/openclaw-package");
  if (await fs.lstat(verifierPackageRoot).catch(() => null)) {
    throw new Error(`cutoff_verifier_package_root_not_empty:${verifierPackageRoot}`);
  }
  await fs.mkdir(path.dirname(verifierPackageRoot), { recursive: true });
  await fs.symlink(path.resolve(packageDir), verifierPackageRoot, "dir");
  try {
    await run(process.execPath, [verifier]);
  } finally {
    await removeIfExists(verifierPackageRoot);
  }
  return packagedProductionInventory(path.resolve(packageDir), path.resolve(lockfile));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["package-dir", "lockfile"]);
  const lockfile = path.resolve(args.lockfile);
  const inventory = await verifyOpenclawPackage(
    path.resolve(args["package-dir"]),
    lockfile,
    path.join(path.dirname(lockfile), "packages/extension/scripts/verify-openclaw-package.mjs"),
  );
  process.stdout.write(`${JSON.stringify({ dependencies: inventory.length, inventory, verified: true })}\n`);
}
