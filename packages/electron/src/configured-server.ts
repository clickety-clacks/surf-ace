import { createHash, createPublicKey } from "node:crypto";
import { PublicControllerWireClient } from "../../controller/src/wire.js";
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
  ) {
    const url = new URL(address);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("server address must use ws or wss");
    this.wire = new PublicControllerWireClient(url.toString(), requestTimeoutMs);
    this.wire.onClose(() => this.core.clearRegistryPaneConfirmations());
  }

  onClose(listener: () => void): () => void {
    return this.wire.onClose(listener);
  }

  async claimPaneLabel(surfaceId: string, paneId: number, paneLineageId: string): Promise<number> {
    if (this.stopped || !this.wire.isOpen()) throw new Error("allocator_unavailable");
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
    this.pending = run.catch(() => {
      this.core.clearRegistryPaneConfirmations();
    });
    return run;
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
    this.core.clearRegistryPaneConfirmations();
    clearTimeout(this.timer);
    this.wire.abort();
    await this.pending;
    await this.wire.close();
  }
}
