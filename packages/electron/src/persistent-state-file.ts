import fs from "node:fs/promises";
import path from "node:path";

import type { PersistentSurfaceState } from "./surface-core.js";

export type PersistentStateRecoverySource = "primary" | "backup" | "temporary";

export type PersistentStateLoadResult =
  | {
      recoveredFromBackup: boolean;
      recoverySource: PersistentStateRecoverySource;
      state: PersistentSurfaceState;
      writeGuard: false | "unrestorable-primary";
    }
  | {
      error: unknown;
      state: undefined;
      writeGuard: "corrupt-primary";
    }
  | {
      error: unknown;
      state: undefined;
      writeGuard: false;
    };

export function backupStateFileName(fileName: string): string {
  return `${fileName}.bak`;
}

function temporaryStateFileName(fileName: string): string {
  return `${fileName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

async function readStateFile(filePath: string): Promise<PersistentSurfaceState> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as PersistentSurfaceState;
}

function temporaryStateFilePattern(fileName: string): RegExp {
  return new RegExp(`^${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.\\d+\\.[0-9a-f]+\\.tmp$`);
}

async function loadNewestTemporaryState(
  stateDir: string,
  fileName: string,
): Promise<{ filePath: string; state: PersistentSurfaceState } | undefined> {
  const pattern = temporaryStateFilePattern(fileName);
  const entries = await fs.readdir(stateDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(stateDir, entry.name));
  const newestFirst = await Promise.all(
    candidates.map(async (filePath) => ({
      filePath,
      mtimeMs: (await fs.stat(filePath)).mtimeMs,
    })),
  );
  newestFirst.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of newestFirst) {
    try {
      return {
        filePath: candidate.filePath,
        state: await readStateFile(candidate.filePath),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function shouldGuardUnrestorablePersistentState(
  state: PersistentSurfaceState | undefined,
  restoredSurfaceCount: number,
): boolean {
  const persistedSurfaceCount = state?.surfaces?.length ?? 0;
  return persistedSurfaceCount > 0 && restoredSurfaceCount < persistedSurfaceCount;
}

async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const temporaryPath = path.join(path.dirname(filePath), temporaryStateFileName(path.basename(filePath)));
  const temporaryFile = await fs.open(temporaryPath, "w");
  try {
    await temporaryFile.writeFile(contents);
    await temporaryFile.sync();
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  } finally {
    await temporaryFile.close();
  }
  await fs.rename(temporaryPath, filePath);
  const directory = await fs.open(path.dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function loadPersistentStateFile(stateDir: string, fileName: string): Promise<PersistentStateLoadResult> {
  const statePath = path.join(stateDir, fileName);
  try {
    return {
      recoveredFromBackup: false,
      recoverySource: "primary",
      state: await readStateFile(statePath),
      writeGuard: false,
    };
  } catch (primaryError) {
    try {
      const backupPath = path.join(stateDir, backupStateFileName(fileName));
      const state = await readStateFile(backupPath);
      await atomicWriteFile(statePath, JSON.stringify(state, null, 2)).catch(() => {});
      return {
        recoveredFromBackup: true,
        recoverySource: "backup",
        state,
        writeGuard: false,
      };
    } catch {
      const temporaryRecovery = await loadNewestTemporaryState(stateDir, fileName).catch(() => undefined);
      if (temporaryRecovery) {
        await atomicWriteFile(statePath, JSON.stringify(temporaryRecovery.state, null, 2)).catch(() => {});
        await atomicWriteFile(
          path.join(stateDir, backupStateFileName(fileName)),
          JSON.stringify(temporaryRecovery.state, null, 2),
        ).catch(() => {});
        return {
          recoveredFromBackup: false,
          recoverySource: "temporary",
          state: temporaryRecovery.state,
          writeGuard: false,
        };
      }
      if ((primaryError as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          error: primaryError,
          state: undefined,
          writeGuard: false,
        };
      }
      return {
        error: primaryError,
        state: undefined,
        writeGuard: false,
      };
    }
  }
}

export async function writePersistentStateFile(
  stateDir: string,
  fileName: string,
  state: PersistentSurfaceState,
): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const contents = JSON.stringify(state, null, 2);
  await atomicWriteFile(path.join(stateDir, fileName), contents);
  await atomicWriteFile(path.join(stateDir, backupStateFileName(fileName)), contents);
}
