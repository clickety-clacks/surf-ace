import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import type { PersistentSurfaceState } from "./surface-core.js";

export type PersistentStateRecoverySource = "primary" | "backup" | "temporary";

type PersistentStateSelector = {
  acceptedSha256: string | null;
  candidateSha256?: string;
  phase: "committed" | "pending";
  version: 1;
};

export class PersistentStateOutcomeUnknownError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Persistent state commit outcome is unknown");
    this.name = "PersistentStateOutcomeUnknownError";
    this.cause = cause;
  }
}

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
      writeGuard: "ambiguous-persistence" | "corrupt-primary";
    }
  | {
      error: unknown;
      state: undefined;
      writeGuard: false;
    };

export function backupStateFileName(fileName: string): string {
  return `${fileName}.bak`;
}

export function persistentStateSelectorFileName(fileName: string): string {
  return `${fileName}.selector`;
}

function persistentStateManagedFileName(fileName: string): string {
  return `${fileName}.managed`;
}

function temporaryStateFileName(fileName: string): string {
  return `${fileName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

async function readStateFile(filePath: string): Promise<PersistentSurfaceState> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as PersistentSurfaceState;
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function selectorContents(selector: PersistentStateSelector): string {
  return `${JSON.stringify(selector, null, 2)}\n`;
}

function parseSelector(contents: string): PersistentStateSelector {
  const selector = JSON.parse(contents) as Partial<PersistentStateSelector>;
  if (
    selector.version !== 1 ||
    (selector.phase !== "committed" && selector.phase !== "pending") ||
    (selector.acceptedSha256 !== null &&
      (typeof selector.acceptedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(selector.acceptedSha256))) ||
    (selector.phase === "pending" &&
      (typeof selector.candidateSha256 !== "string" || !/^[0-9a-f]{64}$/.test(selector.candidateSha256))) ||
    (selector.phase === "committed" && selector.candidateSha256 !== undefined)
  ) {
    throw new Error("Invalid persistent state selector");
  }
  return selector as PersistentStateSelector;
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
  try {
    await fs.rename(temporaryPath, filePath);
    const directory = await fs.open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function restoreCommittedPrimary(
  stateDir: string,
  statePath: string,
  previousContents: string | undefined,
): Promise<void> {
  if (previousContents !== undefined) {
    await atomicWriteFile(statePath, previousContents);
    return;
  }
  await fs.unlink(statePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const directory = await fs.open(stateDir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readMatchingContents(filePath: string, expectedSha256: string): Promise<string | undefined> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return sha256(contents) === expectedSha256 ? contents : undefined;
  } catch {
    return undefined;
  }
}

async function loadExplicitlyAcceptedState(
  stateDir: string,
  fileName: string,
  selector: PersistentStateSelector,
): Promise<PersistentStateLoadResult> {
  const statePath = path.join(stateDir, fileName);
  const selectorPath = path.join(stateDir, persistentStateSelectorFileName(fileName));
  if (selector.acceptedSha256 === null) {
    try {
      await restoreCommittedPrimary(stateDir, statePath, undefined);
      if (selector.phase === "pending") {
        await atomicWriteFile(selectorPath, selectorContents({
          acceptedSha256: null,
          phase: "committed",
          version: 1,
        }));
      }
      return {
        error: Object.assign(new Error("No committed persistent state"), { code: "ENOENT" }),
        state: undefined,
        writeGuard: false,
      };
    } catch (error) {
      return { error, state: undefined, writeGuard: "ambiguous-persistence" };
    }
  }

  const backupPath = path.join(stateDir, backupStateFileName(fileName));
  const primaryContents = await readMatchingContents(statePath, selector.acceptedSha256);
  const backupContents = await readMatchingContents(backupPath, selector.acceptedSha256);
  let acceptedContents = primaryContents ?? backupContents;
  let recoverySource: PersistentStateRecoverySource = primaryContents ? "primary" : "backup";
  if (!acceptedContents) {
    const temporaryRecovery = await loadNewestTemporaryState(stateDir, fileName).catch(() => undefined);
    if (temporaryRecovery) {
      const temporaryContents = await fs.readFile(temporaryRecovery.filePath, "utf8");
      if (sha256(temporaryContents) === selector.acceptedSha256) {
        acceptedContents = temporaryContents;
        recoverySource = "temporary";
      }
    }
  }
  if (!acceptedContents) {
    return {
      error: new Error("The explicitly accepted persistent state generation is unavailable"),
      state: undefined,
      writeGuard: "ambiguous-persistence",
    };
  }
  try {
    const state = JSON.parse(acceptedContents) as PersistentSurfaceState;
    if (!primaryContents || selector.phase === "pending") {
      await atomicWriteFile(statePath, acceptedContents);
    }
    if (selector.phase === "pending") {
      await atomicWriteFile(selectorPath, selectorContents({
        acceptedSha256: selector.acceptedSha256,
        phase: "committed",
        version: 1,
      }));
    }
    return {
      recoveredFromBackup: recoverySource === "backup",
      recoverySource,
      state,
      writeGuard: false,
    };
  } catch (error) {
    return { error, state: undefined, writeGuard: "ambiguous-persistence" };
  }
}

export async function loadPersistentStateFile(stateDir: string, fileName: string): Promise<PersistentStateLoadResult> {
  const statePath = path.join(stateDir, fileName);
  const selectorPath = path.join(stateDir, persistentStateSelectorFileName(fileName));
  const managedPath = path.join(stateDir, persistentStateManagedFileName(fileName));
  let selectorContentsValue: string | undefined;
  let managed = false;
  try {
    selectorContentsValue = await fs.readFile(selectorPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { error, state: undefined, writeGuard: "ambiguous-persistence" };
    }
  }
  try {
    await fs.access(managedPath);
    managed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { error, state: undefined, writeGuard: "ambiguous-persistence" };
    }
  }
  if (selectorContentsValue !== undefined) {
    try {
      return await loadExplicitlyAcceptedState(stateDir, fileName, parseSelector(selectorContentsValue));
    } catch (error) {
      return { error, state: undefined, writeGuard: "ambiguous-persistence" };
    }
  }
  if (managed) {
    return {
      error: new Error("Managed persistent state is missing its durable selector"),
      state: undefined,
      writeGuard: "ambiguous-persistence",
    };
  }
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
  const statePath = path.join(stateDir, fileName);
  const backupPath = path.join(stateDir, backupStateFileName(fileName));
  const selectorPath = path.join(stateDir, persistentStateSelectorFileName(fileName));
  const managedPath = path.join(stateDir, persistentStateManagedFileName(fileName));
  let selector: PersistentStateSelector | undefined;
  try {
    selector = parseSelector(await fs.readFile(selectorPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await fs.access(managedPath);
      throw new Error("Managed persistent state is missing its durable selector");
    } catch (managedError) {
      if ((managedError as NodeJS.ErrnoException).code !== "ENOENT") throw managedError;
    }
  }
  let previousContents: string | undefined;
  if (selector) {
    const loaded = await loadExplicitlyAcceptedState(stateDir, fileName, selector);
    if (loaded.writeGuard) throw loaded.error;
    if (loaded.state) previousContents = await fs.readFile(statePath, "utf8");
  } else {
    try {
      previousContents = await fs.readFile(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWriteFile(managedPath, "persistent-state-selector-v1\n");
    await atomicWriteFile(selectorPath, selectorContents({
      acceptedSha256: previousContents === undefined ? null : sha256(previousContents),
      phase: "committed",
      version: 1,
    }));
  }
  if (previousContents !== undefined) {
    await atomicWriteFile(backupPath, previousContents);
  }
  const pendingSelector: PersistentStateSelector = {
    acceptedSha256: previousContents === undefined ? null : sha256(previousContents),
    candidateSha256: sha256(contents),
    phase: "pending",
    version: 1,
  };
  await atomicWriteFile(selectorPath, selectorContents(pendingSelector));
  try {
    await atomicWriteFile(statePath, contents);
  } catch (error) {
    try {
      await restoreCommittedPrimary(stateDir, statePath, previousContents);
      await atomicWriteFile(selectorPath, selectorContents({
        acceptedSha256: pendingSelector.acceptedSha256,
        phase: "committed",
        version: 1,
      }));
    } catch {
      // The durable pending selector remains authoritative and makes the
      // candidate primary ineligible until restart repairs the prior state.
    }
    throw error;
  }
  try {
    await atomicWriteFile(selectorPath, selectorContents({
      acceptedSha256: pendingSelector.candidateSha256!,
      phase: "committed",
      version: 1,
    }));
  } catch (error) {
    throw new PersistentStateOutcomeUnknownError(error);
  }
  // Primary is committed. Backup refresh may lag at the prior committed
  // generation, but it must never turn this transaction into a rejection.
  await atomicWriteFile(backupPath, contents).catch(() => {});
}
