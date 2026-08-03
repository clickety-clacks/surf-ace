import fs from "node:fs/promises";

import {
  applyLegacyRollbackPreview,
  previewCommittedLegacyRollback,
  restoreCapturedPersistentGeneration,
  type LegacyRollbackPreview,
} from "./legacy-rollback-migration.js";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function run(): Promise<void> {
  const command = process.argv[2];
  const stateDir = option("--state-dir");
  const stateFile = option("--state-file");
  if (command === "preview") {
    const preview = await previewCommittedLegacyRollback(
      stateDir,
      stateFile,
      option("--legacy-snapshot"),
    );
    await fs.writeFile(option("--output"), `${JSON.stringify(preview, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(preview)}\n`);
    return;
  }
  if (command === "apply") {
    const preview = JSON.parse(await fs.readFile(option("--preview"), "utf8")) as LegacyRollbackPreview;
    await applyLegacyRollbackPreview(stateDir, stateFile, preview);
    process.stdout.write(`${JSON.stringify({ legacySnapshotIdentity: preview.legacySnapshotIdentity, status: "applied" })}\n`);
    return;
  }
  if (command === "restore") {
    await restoreCapturedPersistentGeneration(stateDir, stateFile, option("--generation"));
    process.stdout.write(`${JSON.stringify({ status: "restored" })}\n`);
    return;
  }
  throw new Error("Usage: legacy-rollback <preview|apply|restore> --state-dir DIR --state-file FILE ...");
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
