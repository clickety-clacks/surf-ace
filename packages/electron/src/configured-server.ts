import { createHash, createPublicKey } from "node:crypto";
import { PublicControllerWireClient, parseRegistryIdentity } from "../../controller/src/wire.js";
import { matchesProvisionedClaims, type ProvisionedRegistryBinding } from "./registry-binding.js";
import type { SurfaceCore } from "./surface-core.js";

export function registrationClientId(publicKeyPem: string): string {
  return createHash("sha256").update(createPublicKey(publicKeyPem).export({ format: "der", type: "spki" })).digest("hex");
}

// The configured route uses normal DNS and WebSocket transport, including LAN,
// MagicDNS and stable Tailscale Service names. Discovery fallback is a later slice.
export class ConfiguredServerRegistration {
  private readonly wire: PublicControllerWireClient;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    address: string,
    private readonly clientId: string,
    private readonly core: SurfaceCore,
    private readonly persist: () => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
    requestTimeoutMs = 10_000,
    private readonly provisionedBinding: ProvisionedRegistryBinding | null = null,
  ) {
    const url = new URL(address);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("server address must use ws or wss");
    this.wire = new PublicControllerWireClient(url.toString(), requestTimeoutMs);
  }

  onClose(listener: () => void): () => void {
    return this.wire.onClose(listener);
  }

  async claimPaneLabel(surfaceId: string, paneId: number, paneLineageId: string): Promise<number> {
    if (this.stopped || !this.wire.isOpen()) throw new Error("allocator_unavailable");
    await this.confirmRegistryIdentity();
    const response = await this.wire.request("pane.claim", {
      clientId: this.clientId, surfaceId, paneId: String(paneId), paneLineageId,
    });
    if (!response.ok) throw new Error(response.error?.message ?? "pane_allocation_failed");
    const label = (response.payload as { paneLabel?: unknown })?.paneLabel;
    if (!Number.isSafeInteger(label) || Number(label) < 1) throw new Error("invalid_pane_assignment");
    return Number(label);
  }

  async synchronize(): Promise<void> {
    const run = this.pending.then(async () => {
      if (this.stopped) return;
      await this.wire.connect();
      await this.confirmRegistryIdentity();
      for (const surface of this.core.listSurfaces()) this.core.admitSurfaceToLockless(surface.surfaceId);
      const response = await this.wire.request("client.register", {
        clientId: this.clientId,
        surfaces: this.core.listSurfaces().map((surface) => ({
          surfaceId: surface.surfaceId,
          panes: [...surface.panes.values()].map((pane) => ({
            paneId: String(pane.paneId), paneLabel: pane.paneLabel,
            paneLineageId: pane.paneLineageId,
          })),
        })),
      });
      if (!response.ok) throw new Error(response.error?.message ?? "registration_failed");
      if (response.type !== "response" || response.v !== 1 || response.op !== "client.register") {
        throw new Error("invalid_registration_response");
      }
      const responseIdentity = parseRegistryIdentity(response.payload);
      const binding = this.core.registryBinding();
      if (!binding || binding.clientId !== this.clientId ||
          binding.allocatorId !== responseIdentity.allocatorId || binding.fleetId !== responseIdentity.fleetId) {
        throw new Error("foreign_registry_identity");
      }
      const payload = response.payload as { clientId: string; surfaces: Array<{
        surfaceId: string; windowLabel: string;
        panes: Array<{ paneId: string; paneLineageId: string; paneLabel: number }>;
      }> };
      const expectedSurfaceIds = new Set(this.core.listSurfaces().map((surface) => surface.surfaceId));
      if (payload.clientId !== this.clientId || !Array.isArray(payload.surfaces) ||
          payload.surfaces.length !== expectedSurfaceIds.size ||
          payload.surfaces.some((surface) => !expectedSurfaceIds.delete(surface.surfaceId)) ||
          expectedSurfaceIds.size !== 0) throw new Error("invalid_registration_response");
      await this.core.locklessAuthority.transactionAsync(() =>
        this.core.transactionAsync(async () => {
          this.core.applyWindowLabels(payload.surfaces);
          this.core.applyRegistryPaneLabels(payload.surfaces);
          await this.persist();
        }),
      );
      this.core.confirmRegistryPaneLabels(payload.surfaces);
      if (!this.wire.isOpen()) throw new Error("controller_wire_closed");
    });
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async confirmRegistryIdentity(): Promise<void> {
    const identity = await this.wire.readRegistryIdentity();
    let binding = this.core.registryBinding();
    if (binding) {
      if (binding.clientId !== this.clientId || binding.allocatorId !== identity.allocatorId ||
          binding.fleetId !== identity.fleetId) throw new Error("foreign_registry_identity");
      // Reconfirm durability on every mutation attempt. An ambiguous prior write
      // may leave the exact candidate in memory while local persistence is fenced.
      await this.persist();
      return;
    }
    const claims = this.core.confirmedRegistryClaims();
    if (claims.length > 0) {
      if (!this.provisionedBinding || !matchesProvisionedClaims(this.provisionedBinding, this.clientId, claims)) {
        throw new Error("legacy_registry_binding_pending");
      }
      binding = this.provisionedBinding.binding;
      if (binding.allocatorId !== identity.allocatorId || binding.fleetId !== identity.fleetId) {
        throw new Error("foreign_registry_identity");
      }
    } else {
      binding = { ...identity, clientId: this.clientId };
    }
    await this.core.locklessAuthority.transactionAsync(() =>
      this.core.transactionAsync(async () => {
        this.core.bindRegistryIdentity(binding);
        await this.persist();
      }),
    );
  }

  start(): void {
    const tick = async () => {
      try { await this.synchronize(); } catch (error) { this.onError(error); }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.wire.abort();
    await this.pending;
    await this.wire.close();
  }
}
