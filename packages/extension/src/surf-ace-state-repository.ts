import fs from "node:fs/promises";
import path from "node:path";

export class SurfAceStateRepository<TState> {
  private readonly fileName: string;
  private readonly stateDir: string;

  constructor(stateDir: string, fileName: string) {
    this.fileName = fileName;
    this.stateDir = stateDir;
  }

  get statePath(): string {
    return path.join(this.stateDir, this.fileName);
  }

  async load(): Promise<unknown | null> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  async save(state: TState): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2));
  }
}
