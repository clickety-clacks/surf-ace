import { randomUUID } from "node:crypto";

import type { ControllerInstanceId } from "@surf-ace/protocol";

import type { ControllerStateStore } from "./state-store.js";

type PersistedControllerIdentity = {
  controllerInstanceId: ControllerInstanceId;
  version: 1;
};

function isPersistedControllerIdentity(
  value: unknown,
): value is PersistedControllerIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.version === 1 &&
    typeof record.controllerInstanceId === "string" &&
    record.controllerInstanceId.length > 0;
}

export class ControllerIdentity {
  private value: ControllerInstanceId | null = null;

  constructor(
    private readonly store: ControllerStateStore,
    private readonly createId: () => ControllerInstanceId = () =>
      `ci_${randomUUID().replaceAll("-", "")}`,
  ) {}

  async loadOrCreate(): Promise<ControllerInstanceId> {
    if (this.value) {
      return this.value;
    }
    const persisted = await this.store.load();
    if (isPersistedControllerIdentity(persisted)) {
      this.value = persisted.controllerInstanceId;
      return this.value;
    }
    this.value = this.createId();
    await this.store.save({
      controllerInstanceId: this.value,
      version: 1,
    } satisfies PersistedControllerIdentity);
    return this.value;
  }
}
