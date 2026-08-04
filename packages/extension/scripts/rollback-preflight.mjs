import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function rollbackPreflight(state) {
  const endpoints = state?.locklessMigrationContinuity?.endpoints ?? {};
  const hasPreparation = Object.values(endpoints).some((endpoint) =>
    Object.keys(endpoint?.surfaces ?? {}).length > 0
  );
  return hasPreparation
    ? { allowed: false, error: "rollback_requires_full_reset" }
    : { allowed: true };
}

async function main() {
  const index = process.argv.indexOf("--state-file");
  const stateFile = index >= 0 ? process.argv[index + 1] : undefined;
  if (!stateFile) throw new Error("--state-file is required");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const result = rollbackPreflight(state);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.allowed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
