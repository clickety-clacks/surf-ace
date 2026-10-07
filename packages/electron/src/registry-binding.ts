import fs from "node:fs/promises";
import path from "node:path";

import type { ConfirmedRegistryClaim, PersistentRegistryBinding } from "./surface-core.js";

/** Written only by an owner-verified provisioning workflow, never by discovery. */
export type ProvisionedRegistryBinding = {
  binding: PersistentRegistryBinding;
  confirmedClaims: ConfirmedRegistryClaim[];
};

export function matchesProvisionedClaims(
  provisioned: ProvisionedRegistryBinding,
  clientId: string,
  claims: ConfirmedRegistryClaim[],
): boolean {
  return provisioned.binding.clientId === clientId &&
    claims.length > 0 &&
    JSON.stringify(provisioned.confirmedClaims) === JSON.stringify(claims);
}

export async function loadProvisionedRegistryBinding(stateDir: string): Promise<ProvisionedRegistryBinding | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(stateDir, "registry-binding.provisioned.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(raw) as ProvisionedRegistryBinding;
  const binding = value?.binding;
  if (!binding || typeof binding.clientId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(binding.clientId) ||
      typeof binding.allocatorId !== "string" || !/^alloc_[A-Za-z0-9._:-]{3,64}$/.test(binding.allocatorId) ||
      typeof binding.fleetId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(binding.fleetId) ||
      !Array.isArray(value.confirmedClaims) || !value.confirmedClaims.every((claim) =>
        typeof claim.surfaceId === "string" && typeof claim.windowLabel === "string" &&
        Array.isArray(claim.panes) && claim.panes.length > 0 && claim.panes.every((pane) =>
          typeof pane.paneId === "string" && Number.isSafeInteger(pane.paneLabel) && pane.paneLabel > 0 &&
          typeof pane.paneLineageId === "string"))) {
    throw new Error("invalid_provisioned_registry_binding");
  }
  return value;
}
