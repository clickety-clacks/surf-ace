/** Tracks state writes whose in-memory mutations are not yet durably committed. */
export class PersistenceWriteReadiness {
  private pendingWrites = 0;

  get isReady(): boolean {
    return this.pendingWrites === 0;
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
