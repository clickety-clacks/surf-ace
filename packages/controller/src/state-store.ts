import fs from "node:fs/promises";
import path from "node:path";

export interface ControllerStateStore {
  load(): Promise<unknown | null>;
  save(value: unknown): Promise<void>;
}

export class FileControllerStateStore implements ControllerStateStore {
  constructor(readonly statePath: string) {}

  async load(): Promise<unknown | null> {
    try {
      return JSON.parse(await fs.readFile(this.statePath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async save(value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(temporaryPath, this.statePath);
  }
}
