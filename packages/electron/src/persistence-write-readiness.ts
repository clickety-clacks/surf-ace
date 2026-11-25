export type ApplicationStateMutation = {
  operation: string;
  requestId?: string;
  surfaceId?: string;
  startedAtMs: number;
};

/** Tracks durable writes and in-flight state mutations that are not yet safe to observe. */
export class PersistenceWriteReadiness {
  private pendingWrites = 0;
  private readonly authorityMutations = new Set<ApplicationStateMutation>();

  get isReady(): boolean {
    return this.pendingWrites === 0 && this.authorityMutations.size === 0;
  }

  openMutations(): ApplicationStateMutation[] {
    return Array.from(this.authorityMutations, (mutation) => ({ ...mutation }));
  }

  beginAuthorityMutation(details: Omit<ApplicationStateMutation, "startedAtMs"> = { operation: "authority_mutation" }): () => void {
    const mutation = { ...details, startedAtMs: Date.now() };
    this.authorityMutations.add(mutation);
    return () => { this.authorityMutations.delete(mutation); };
  }

  async track<T>(write: () => Promise<T>): Promise<T> {
    this.pendingWrites += 1;
    try {
      return await write();
    } finally {
      this.pendingWrites -= 1;
    }
  }
}
