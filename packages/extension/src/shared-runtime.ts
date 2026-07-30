import type { SurfAceRuntime } from "./surf-ace-runtime.js";

export type SharedRuntimeEntry = {
  referenceCount: number;
  runtime: SurfAceRuntime;
  startWork: Promise<void> | null;
  stopWork: Promise<void> | null;
};

type SurfAceGlobal = typeof globalThis & {
  __surfAceOpenClawRuntimeRegistryV1?: Map<string, SharedRuntimeEntry>;
};

export function sharedRuntimeRegistry(): Map<string, SharedRuntimeEntry> {
  const scope = globalThis as SurfAceGlobal;
  scope.__surfAceOpenClawRuntimeRegistryV1 ??= new Map();
  return scope.__surfAceOpenClawRuntimeRegistryV1;
}

export function acquireSharedRuntime(
  stateDir: string,
  create: () => SurfAceRuntime,
): SharedRuntimeEntry {
  const registry = sharedRuntimeRegistry();
  const existing = registry.get(stateDir);
  if (existing) {
    existing.referenceCount += 1;
    return existing;
  }
  const entry: SharedRuntimeEntry = {
    referenceCount: 1,
    runtime: create(),
    startWork: null,
    stopWork: null,
  };
  registry.set(stateDir, entry);
  return entry;
}

export async function startSharedRuntime(
  entry: SharedRuntimeEntry,
): Promise<void> {
  if (entry.stopWork) {
    await entry.stopWork;
  }
  entry.startWork ??= entry.runtime.start().catch((error) => {
    entry.startWork = null;
    throw error;
  });
  await entry.startWork;
}

export async function releaseSharedRuntime(
  stateDir: string,
  entry: SharedRuntimeEntry,
): Promise<void> {
  entry.referenceCount = Math.max(0, entry.referenceCount - 1);
  if (entry.referenceCount > 0) {
    return;
  }
  await entry.startWork?.catch(() => {});
  if (entry.referenceCount > 0) {
    return;
  }
  entry.stopWork ??= entry.runtime.stop().finally(() => {
    entry.startWork = null;
    entry.stopWork = null;
    if (entry.referenceCount === 0) {
      sharedRuntimeRegistry().delete(stateDir);
    }
  });
  await entry.stopWork;
}
