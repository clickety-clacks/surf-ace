import { AsyncLocalStorage } from "node:async_hooks";

export type ApplicationQueueScope = "surface" | "client" | "write";
type ObserveQueueWait = (scope: ApplicationQueueScope) => (() => void) | undefined;
export const applicationQueueWait = new AsyncLocalStorage<ObserveQueueWait>();

export async function waitForApplicationQueue(
  previous: Promise<void> | null | undefined,
  scope: ApplicationQueueScope,
  observe: ObserveQueueWait | null | undefined = applicationQueueWait.getStore(),
): Promise<void> {
  if (!previous) return;
  const finish = observe?.(scope);
  try {
    await previous.catch(() => undefined);
  } finally {
    finish?.();
  }
}

export type ApplicationStateMutation = {
  operation: string;
  requestId?: string;
  surfaceId?: string;
  startedAtMs: number;
};

export type SurfaceBlocker = Pick<ApplicationStateMutation, "operation" | "startedAtMs">;
export type OpenApplicationChange = SurfaceBlocker & {
  kind: "mutation" | "write";
  surfaceId?: string;
};

function blockerOperation(operation: string): string {
  const normalized = operation.toLowerCase().replace(/[^a-z]+/g, "_");
  return /^[a-z][a-z_]{0,29}$/.test(normalized) ? normalized : "application_change";
}

export function surfaceBlockerMessage(blocker: SurfaceBlocker): string {
  const change = blockerOperation(blocker.operation).replaceAll("_", " ");
  return `Blocked behind ${change} since ${new Date(blocker.startedAtMs).toISOString()}`;
}

export function surfaceBlockerLimitation(blocker: SurfaceBlocker): string {
  // surface.describe v1 only accepts lowercase letters and underscores in a
  // limitation code. Encode decimal timestamp digits as a–j in that channel.
  const since = String(blocker.startedAtMs).replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)));
  return `blocked_by_${blockerOperation(blocker.operation)}_since_${since}`;
}

export function surfaceWriteLimitationCodes(surfaceId?: string): string[] {
  if (surfaceId === undefined) return ["save_surface_shared"];
  // Companion codes follow the write's ordinary v1 blocker code. Two letters
  // per byte and at most 24 bytes per code stay within the v1 grammar and size.
  const encoded = Array.from(Buffer.from(surfaceId), (byte) =>
    String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
  return (encoded.match(/.{1,48}/g) ?? []).map((part) => `save_surface_${part}`);
}

/** Tracks durable writes and in-flight state mutations that are not yet safe to observe. */
export class PersistenceWriteReadiness {
  private readonly pending = new Map<ApplicationStateMutation, "mutation" | "write">();
  private readonly waiters = new Map<string, Set<ApplicationStateMutation[]>>();
  private readonly waitListeners = new Set<(surfaceId: string) => void>();
  private readonly changeListeners = new Set<() => void>();

  get isReady(): boolean {
    return this.pending.size === 0;
  }

  openMutations(): ApplicationStateMutation[] {
    return [...this.pending].flatMap(([entry, kind]) => kind === "mutation" ? [{ ...entry }] : []);
  }

  pendingWrites(): ApplicationStateMutation[] {
    return [...this.pending].flatMap(([entry, kind]) => kind === "write" ? [{ ...entry }] : []);
  }

  openChanges(surfaceId?: string, excludingRequestId?: string, scope?: ApplicationQueueScope): OpenApplicationChange[] {
    return this.pendingEntries(surfaceId, excludingRequestId, scope)
      .map(([{ operation, surfaceId, startedAtMs }, kind]) => ({ kind, operation, surfaceId, startedAtMs }));
  }

  blockersForSurface(surfaceId?: string, excludingRequestId?: string, scope?: ApplicationQueueScope): SurfaceBlocker[] {
    return this.openChanges(surfaceId, excludingRequestId, scope).map(({ operation, startedAtMs }) => ({ operation, startedAtMs }));
  }

  waitingBlockerForSurface(surfaceId: string): SurfaceBlocker | undefined {
    for (const entries of this.waiters.get(surfaceId) ?? []) {
      const blocking = entries.find((entry) => this.pending.has(entry));
      if (blocking) return { operation: blocking.operation, startedAtMs: blocking.startedAtMs };
    }
  }

  beginWait(surfaceId: string, scope: ApplicationQueueScope, excludingRequestId?: string): () => void {
    const waiters = this.waiters.get(surfaceId) ?? new Set();
    const entries = this.pendingEntries(scope === "surface" ? surfaceId : undefined, excludingRequestId, scope)
      .map(([entry]) => entry);
    if (!entries.length) return () => {};
    waiters.add(entries);
    this.waiters.set(surfaceId, waiters);
    this.notify(surfaceId);
    return () => {
      if (!waiters.delete(entries)) return;
      if (!waiters.size) this.waiters.delete(surfaceId);
      this.notify(surfaceId);
    };
  }

  subscribeToWaits(listener: (surfaceId: string) => void): void {
    this.waitListeners.add(listener);
  }

  subscribeToChanges(listener: () => void): void {
    this.changeListeners.add(listener);
  }

  beginAuthorityMutation(details: Omit<ApplicationStateMutation, "startedAtMs"> = { operation: "authority_mutation" }): () => void {
    return this.begin(details, "mutation");
  }

  async track<T>(write: () => Promise<T>, surfaceId?: string): Promise<T> {
    const finish = this.begin({ operation: "saving application state", surfaceId }, "write");
    try {
      return await write();
    } finally {
      finish();
    }
  }

  private pendingEntries(surfaceId?: string, excludingRequestId?: string, scope?: ApplicationQueueScope) {
    return [...this.pending].filter(([entry, kind]) =>
      (scope === undefined || (scope === "write" ? kind === "write" : kind === "mutation")) &&
      (kind === "write" || surfaceId === undefined || entry.surfaceId === undefined || entry.surfaceId === surfaceId) &&
      (excludingRequestId === undefined || entry.requestId !== excludingRequestId));
  }

  private begin(details: Omit<ApplicationStateMutation, "startedAtMs">, kind: "mutation" | "write"): () => void {
    const entry = { ...details, startedAtMs: Date.now() };
    this.pending.set(entry, kind);
    for (const listener of this.changeListeners) listener();
    return () => {
      if (!this.pending.delete(entry)) return;
      for (const listener of this.changeListeners) listener();
      for (const [surfaceId, waits] of this.waiters) {
        if ([...waits].some((predecessors) => predecessors.includes(entry))) this.notify(surfaceId);
      }
    };
  }

  private notify(surfaceId: string): void {
    for (const listener of this.waitListeners) listener(surfaceId);
  }
}
