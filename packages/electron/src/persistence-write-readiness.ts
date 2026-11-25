import { AsyncLocalStorage } from "node:async_hooks";

export const applicationQueueWait = new AsyncLocalStorage<(scope: "surface" | "client") => void>();

export type ApplicationStateMutation = {
  operation: string;
  requestId?: string;
  surfaceId?: string;
  startedAtMs: number;
};

export type SurfaceBlocker = Pick<ApplicationStateMutation, "operation" | "startedAtMs">;

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

/** Tracks durable writes and in-flight state mutations that are not yet safe to observe. */
export class PersistenceWriteReadiness {
  private readonly pending = new Map<ApplicationStateMutation, "mutation" | "write">();
  private readonly listeners = new Set<(surfaceId?: string) => void>();

  get isReady(): boolean {
    return this.pending.size === 0;
  }

  openMutations(): ApplicationStateMutation[] {
    return [...this.pending].flatMap(([entry, kind]) => kind === "mutation" ? [{ ...entry }] : []);
  }

  blockersForSurface(surfaceId?: string, excludingRequestId?: string): SurfaceBlocker[] {
    return Array.from(this.pending.keys())
      .filter((entry) =>
        (surfaceId === undefined || entry.surfaceId === undefined || entry.surfaceId === surfaceId) &&
        (excludingRequestId === undefined || entry.requestId !== excludingRequestId))
      .map(({ operation, startedAtMs }) => ({ operation, startedAtMs }));
  }

  subscribe(listener: (surfaceId?: string) => void): void {
    this.listeners.add(listener);
  }

  beginAuthorityMutation(details: Omit<ApplicationStateMutation, "startedAtMs"> = { operation: "authority_mutation" }): () => void {
    return this.begin(details, "mutation");
  }

  async track<T>(write: () => Promise<T>): Promise<T> {
    // Saved state shares one write queue and checkpoint across all windows.
    if ([...this.pending.values()].includes("write")) applicationQueueWait.getStore()?.("client");
    const finish = this.begin({ operation: "saving application state" }, "write");
    try {
      return await write();
    } finally {
      finish();
    }
  }

  private begin(details: Omit<ApplicationStateMutation, "startedAtMs">, kind: "mutation" | "write"): () => void {
    const entry = { ...details, startedAtMs: Date.now() };
    this.pending.set(entry, kind);
    this.notify(entry.surfaceId);
    return () => {
      if (this.pending.delete(entry)) this.notify(entry.surfaceId);
    };
  }

  private notify(surfaceId?: string): void {
    for (const listener of this.listeners) listener(surfaceId);
  }
}
