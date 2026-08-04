import type { OpenClawLocklessController } from "./openclaw-lockless-controller.js";
import type { SurfAceRuntime } from "./surf-ace-runtime.js";

export function capabilityGatedPreparationRuntime(
  legacyRuntime: SurfAceRuntime,
  locklessController: OpenClawLocklessController,
): SurfAceRuntime {
  return new Proxy(legacyRuntime, {
    get(target, property, receiver) {
      if (property === "prepareLegacyLocklessMigrationNow") {
        return async (fingerprint: string) =>
          await locklessController.prepareLegacyMigrationNow(fingerprint);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
