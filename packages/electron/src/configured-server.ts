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
          })),
        })),
      });
      if (!response.ok) throw new Error(response.error?.message ?? "registration_failed");
      const payload = response.payload as { clientId: string; surfaces: Array<{ surfaceId: string; windowLabel: string }> };
      if (payload.clientId !== this.clientId || !Array.isArray(payload.surfaces)) throw new Error("invalid_registration_response");
      await this.core.locklessAuthority.transactionAsync(() =>
        this.core.transactionAsync(async () => {
          this.core.applyWindowLabels(payload.surfaces);
          await this.persist();
        }),
      );
    });
    this.pending = run.catch(() => undefined);
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
    clearTimeout(this.timer);
    this.wire.abort();
    await this.pending;
    await this.wire.close();
  }
}
