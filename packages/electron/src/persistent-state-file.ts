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
  readonly acceptedSha256?: string | null;

  constructor(cause: unknown, acceptedSha256?: string | null) {
    super("Persistent state commit outcome is unknown");
    this.name = "PersistentStateOutcomeUnknownError";
    this.cause = cause;
    this.acceptedSha256 = acceptedSha256;
  }
}

/** A restored state was not fully proven, so no durable write was attempted. */
export class PersistentStateWriteGuardError extends Error {
  constructor(readonly reason: string) {
    super(`Local persistence is guarded: ${reason}`);
    this.name = "PersistentStateWriteGuardError";
  }
}

export type PersistentStateLoadResult =
  | {
      recoveredFromBackup: boolean;
      recoverySource: PersistentStateRecoverySource;
      state: PersistentSurfaceState;
      writeGuard: false;
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
  return parsePersistentState(await fs.readFile(filePath, "utf8"));
}

function parsePersistentState(contents: string): PersistentSurfaceState {
  const state = JSON.parse(contents) as unknown;
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      (state as { version?: unknown }).version !== 1 ||
      !((state as { primarySurfaceId?: unknown }).primarySurfaceId === null ||
        typeof (state as { primarySurfaceId?: unknown }).primarySurfaceId === "string") ||
      ((state as { surfaces?: unknown }).surfaces !== undefined && !Array.isArray((state as { surfaces?: unknown }).surfaces))) {
    throw new SyntaxError("Invalid persistent surface state");
  }
  return state as PersistentSurfaceState;
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
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(stateDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(stateDir, entry.name));
  const newestFirst = await Promise.all(
    candidates.map(async (filePath) => {
      try {
        return { filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  const available = newestFirst.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
  available.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of available) {
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

async function readOptionalContents(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
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
  const primaryContents = await readOptionalContents(statePath);
  const backupContents = await readOptionalContents(backupPath);
  let acceptedContents = primaryContents !== undefined && sha256(primaryContents) === selector.acceptedSha256
    ? primaryContents
    : backupContents !== undefined && sha256(backupContents) === selector.acceptedSha256
      ? backupContents
      : undefined;
  let recoverySource: PersistentStateRecoverySource = acceptedContents === primaryContents ? "primary" : "backup";
  const entries = await fs.readdir(stateDir, { withFileTypes: true }).catch(() => []);
  const temporaryPaths = entries
    .filter((entry) => entry.isFile() && temporaryStateFilePattern(fileName).test(entry.name))
    .map((entry) => path.join(stateDir, entry.name));
  for (const temporaryPath of temporaryPaths) {
    const temporaryContents = await readOptionalContents(temporaryPath);
    if (temporaryContents !== undefined && sha256(temporaryContents) === selector.acceptedSha256) {
      acceptedContents = temporaryContents;
      recoverySource = "temporary";
      break;
    }
  }
  if (!acceptedContents) {
    return {
      error: new Error("The explicitly accepted persistent state generation is unavailable"),
      state: undefined,
      writeGuard: selector.phase === "pending" ? "ambiguous-persistence" : "corrupt-primary",
    };
  }
  let state: PersistentSurfaceState;
  try {
    state = parsePersistentState(acceptedContents);
  } catch (error) {
    return {
      error,
      state: undefined,
      writeGuard: selector.phase === "pending" ? "ambiguous-persistence" : "corrupt-primary",
    };
  }
  try {
    if (recoverySource !== "primary" || selector.phase === "pending") {
      await atomicWriteFile(statePath, acceptedContents);
    }
    if (selector.phase === "pending") {
      await atomicWriteFile(selectorPath, selectorContents({
        acceptedSha256: selector.acceptedSha256,
        phase: "committed",
        version: 1,
      }));
    }
  } catch (error) {
    // If the accepted generation cannot be repaired durably, keep writes
    // guarded so a later candidate cannot replace the only readable copy.
    return { error, state: undefined, writeGuard: "ambiguous-persistence" };
  }
  return {
    recoveredFromBackup: recoverySource === "backup",
    recoverySource,
    state,
    writeGuard: false,
  };
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
      return { error, state: undefined, writeGuard: false };
    }
  }
  try {
    await fs.access(managedPath);
    managed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { error, state: undefined, writeGuard: false };
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
      let temporaryRecovery: { filePath: string; state: PersistentSurfaceState } | undefined;
      try {
        temporaryRecovery = await loadNewestTemporaryState(stateDir, fileName);
      } catch {
        temporaryRecovery = undefined;
      }
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
    if (loaded.writeGuard === "ambiguous-persistence") throw loaded.error;
    if (loaded.writeGuard === "corrupt-primary") previousContents = undefined;
    else if (loaded.state) previousContents = await fs.readFile(statePath, "utf8");
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
    throw new PersistentStateOutcomeUnknownError(error, pendingSelector.acceptedSha256);
  }
  // Primary is committed. Backup refresh may lag at the prior committed
  // generation, but it must never turn this transaction into a rejection.
  await atomicWriteFile(backupPath, contents).catch(() => {});
}
