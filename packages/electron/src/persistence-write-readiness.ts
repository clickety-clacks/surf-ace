/** Tracks durable writes and in-flight state mutations that are not yet safe to observe. */
export class PersistenceWriteReadiness {
  private pendingWrites = 0;
  private pendingAuthorityMutations = 0;

  get isReady(): boolean {
    return this.pendingWrites === 0 && this.pendingAuthorityMutations === 0;
  }

  beginAuthorityMutation(): () => void {
    this.pendingAuthorityMutations += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.pendingAuthorityMutations -= 1;
    };
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
