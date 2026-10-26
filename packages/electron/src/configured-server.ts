import { createHash, createPublicKey } from "node:crypto";
import {
  PublicControllerWireClient,
  parseRegistryIdentity,
  type ControllerWireEnvelope,
  type RegistryIdentity,
} from "../../controller/src/wire.js";
import type { PersistentPaneRetirement, PersistentWindowRetirement } from "./lockless-client-authority.js";
import type { PaneLabelAllocation, PersistentRegistryEndpointLease, SurfaceCore } from "./surface-core.js";

export function registrationClientId(publicKeyPem: string): string {
  return createHash("sha256").update(createPublicKey(publicKeyPem).export({ format: "der", type: "spki" })).digest("hex");
}

function sameRegistry(left: RegistryIdentity, right: RegistryIdentity): boolean {
  return left.allocatorId === right.allocatorId && left.fleetId === right.fleetId;
}

function validateConfiguredDirectEndpoint(address: string | null): string | null {
  if (address === null || address.length === 0) return null;
  if (address.length > 2048 || address.includes("#")) throw new Error("invalid_direct_endpoint");
  let url: URL;
  try { url = new URL(address); } catch { throw new Error("invalid_direct_endpoint"); }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !url.hostname ||
      url.username || url.password || url.hash) throw new Error("invalid_direct_endpoint");
  return address;
}

function registrationEndpointLease(payload: unknown): PersistentRegistryEndpointLease | null {
  const lease = (payload as { endpointLease?: unknown } | null)?.endpointLease;
  if (lease === null || lease === undefined) return null;
  if (typeof lease !== "object" || Array.isArray(lease)) throw new Error("invalid_registration_response");
  const value = lease as Record<string, unknown>;
  if (!Number.isSafeInteger(value.leaseGeneration) || Number(value.leaseGeneration) < 1 ||
      !Number.isSafeInteger(value.registrationObservedAtMs) || Number(value.registrationObservedAtMs) < 0 ||
      !Number.isSafeInteger(value.leaseExpiresAtMs) || Number(value.leaseExpiresAtMs) <= Number(value.registrationObservedAtMs)) {
    throw new Error("invalid_registration_response");
  }
  return {
    leaseGeneration: Number(value.leaseGeneration),
    registrationObservedAtMs: Number(value.registrationObservedAtMs),
    leaseExpiresAtMs: Number(value.leaseExpiresAtMs),
  };
}

type RegistrationPane = {
  allocationGeneration: number | null;
  paneId: string;
  paneLabel: number;
  paneLineageId: string;
};

type RegistrationSurface = {
  panes: RegistrationPane[];
  surfaceId: string;
  windowGeneration: number | null;
};

type RegistrationPayload = {
  allocationGenerationV1: true;
  clientId: string;
  directEndpoint: string | null;
  pendingPaneReleases: PersistentPaneRetirement[];
  pendingWindowReleases: PersistentWindowRetirement[];
  prePairDescribeV1: true;
  surfaces: RegistrationSurface[];
  windowGenerationV1: true;
};

function responseError(response: ControllerWireEnvelope): Error {
  return new Error(response.error?.message ?? "registration_failed");
}

// The configured route uses normal DNS and WebSocket transport, including LAN,
// MagicDNS and stable Tailscale Service names. Discovery fallback is a later slice.
export class ConfiguredServerRegistration {
  private readonly wire: PublicControllerWireClient;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();
  private reportedPendingWindowReleaseIds = new Set<string>();
  private registryIdentity: RegistryIdentity | null = null;

  constructor(
    address: string,
    private readonly clientId: string,
    private readonly core: SurfaceCore,
    private readonly persist: () => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
    requestTimeoutMs = 10_000,
    directEndpoint: string | null = null,
  ) {
    const url = new URL(address);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("server address must use ws or wss");
    this.wire = new PublicControllerWireClient(url.toString(), requestTimeoutMs);
    this.directEndpoint = validateConfiguredDirectEndpoint(directEndpoint);
  }

  private readonly directEndpoint: string | null;

  onClose(listener: () => void): () => void {
    return this.wire.onClose(listener);
  }

  async readRegistryIdentity(): Promise<RegistryIdentity> {
    if (this.stopped) throw new Error("registration_stopped");
    await this.wire.connect();
    return await this.wire.readRegistryIdentity();
  }

  async claimPaneLabel(surfaceId: string, paneId: number, paneLineageId: string): Promise<PaneLabelAllocation> {
    if (this.stopped || !this.wire.isOpen()) throw new Error("allocator_unavailable");
    if (this.core.locklessAuthority.listPendingPaneReleases().length > 0 ||
        this.core.locklessAuthority.listPendingWindowReleases().length > 0) {
      throw new Error("allocator_release_pending");
    }
    await this.confirmRegistryIdentity(await this.wire.readRegistryIdentity(), false);
    const response = await this.wire.request("pane.claim", {
      clientId: this.clientId, surfaceId, paneId: String(paneId), paneLineageId,
    });
    if (!response.ok) throw new Error(response.error?.message ?? "pane_allocation_failed");
    const payload = response.payload as { allocationGeneration?: unknown; paneLabel?: unknown };
    if (!Number.isSafeInteger(payload?.paneLabel) || Number(payload.paneLabel) < 1 ||
        !Number.isSafeInteger(payload?.allocationGeneration) || Number(payload.allocationGeneration) < 1) {
      throw new Error("invalid_pane_assignment");
    }
    return {
      allocationGeneration: Number(payload.allocationGeneration),
      paneLabel: Number(payload.paneLabel),
    };
  }

  async synchronize(options: { allowRebind?: boolean; expectedIdentity?: RegistryIdentity } = {}): Promise<void> {
    const run = this.pending.then(async () => {
      if (this.stopped) return;
      await this.wire.connect();
      const identity = await this.wire.readRegistryIdentity();
      if (options.expectedIdentity && !sameRegistry(identity, options.expectedIdentity)) {
        throw new Error("registry_identity_changed_during_connection");
      }
      await this.confirmRegistryIdentity(identity, options.allowRebind === true);
      this.registryIdentity = identity;

      const registrationPayload = await this.buildRegistrationPayload();
      await this.deliverPendingReleases(registrationPayload);
      const registered = await this.registerLiveClaims(registrationPayload);
      const parsed = this.parseRegistrationResponse(registered.response, registered.payload, identity);
      await this.core.locklessAuthority.transactionAsync(() =>
        this.core.transactionAsync(async () => {
          this.core.applyWindowLabels(parsed.surfaces.map((surface) => ({
            ...surface,
            windowGeneration: parsed.windowGenerationV1 ? surface.windowGeneration : null,
          })));
          this.core.applyRegistryPaneLabels(parsed.surfaces);
          this.core.completeRegistryBinding();
          this.core.setRegistryEndpointLease(parsed.endpointLease);
          await this.persist();
        }),
      );
      this.core.confirmRegistryPaneLabels(parsed.surfaces);

      const pendingWindowReleaseIdsAfterSync = new Set(
        this.core.locklessAuthority.listPendingWindowReleases().map((release) => release.releaseId),
      );
      for (const releaseId of pendingWindowReleaseIdsAfterSync) {
        if (!this.reportedPendingWindowReleaseIds.has(releaseId)) this.onError(new Error("allocator_release_pending"));
      }
      this.reportedPendingWindowReleaseIds = pendingWindowReleaseIdsAfterSync;
      if (!this.wire.isOpen()) throw new Error("controller_wire_closed");
    });
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async confirmRegistryIdentity(identity: RegistryIdentity, allowRebind: boolean): Promise<void> {
    const existing = this.core.registryBinding();
    if (existing && existing.clientId === this.clientId && sameRegistry(existing, identity)) {
      // Reconfirm durability on every mutation attempt. An ambiguous prior write
      // may leave the exact candidate in memory while local persistence is fenced.
      await this.core.locklessAuthority.transactionAsync(() =>
        this.core.transactionAsync(async () => { await this.persist(); }),
      );
      return;
    }
    if (existing && existing.clientId === this.clientId && !allowRebind) {
      throw new Error("foreign_registry_identity");
    }
    await this.core.locklessAuthority.transactionAsync(() =>
      this.core.transactionAsync(async () => {
        this.core.beginRegistryBinding({ ...identity, clientId: this.clientId });
        await this.persist();
      }),
    );
  }

  private async buildRegistrationPayload(): Promise<RegistrationPayload> {
    return await this.core.locklessAuthority.transactionAsync(() =>
      this.core.transactionAsync(async () => {
        if (this.core.normalizeRefusedRegistryClaims()) await this.persist();
        const surfaces = this.core.listSurfaces();
        for (const surface of surfaces) this.core.admitSurfaceToLockless(surface.surfaceId);
        const hasPendingReleases = this.core.locklessAuthority.listPendingPaneReleases().length > 0 ||
          this.core.locklessAuthority.listPendingWindowReleases().length > 0;
        if (hasPendingReleases) {
          // Persist the live snapshot and terminal close evidence together before
          // the allocator can observe either the release or replacement claims.
          await this.persist();
        }
        return {
          clientId: this.clientId,
          directEndpoint: this.directEndpoint,
          allocationGenerationV1: true,
          prePairDescribeV1: true,
          windowGenerationV1: true,
          pendingPaneReleases: [],
          pendingWindowReleases: [],
          surfaces: surfaces.map((surface) => ({
            windowGeneration: surface.windowAllocationGeneration,
            surfaceId: surface.surfaceId,
            panes: [...surface.panes.values()].map((pane) => ({
              allocationGeneration: pane.allocationGeneration,
              paneId: String(pane.paneId),
              paneLabel: pane.paneLabel,
              paneLineageId: pane.paneLineageId,
            })),
          })),
        } satisfies RegistrationPayload;
      }),
    );
  }

  private async sendRegistration(payload: RegistrationPayload): Promise<ControllerWireEnvelope> {
    const response = await this.wire.request("client.register", payload);
    if (response.type !== "response" || response.v !== 1 || response.op !== "client.register") {
      throw new Error("invalid_registration_response");
    }
    if (!response.ok) return response;
    const identity = parseRegistryIdentity(response.payload);
    if (!this.registryIdentity || !sameRegistry(identity, this.registryIdentity)) {
      throw new Error("foreign_registry_identity");
    }
    const result = response.payload as { clientId?: unknown; surfaces?: unknown };
    const expected = new Set(payload.surfaces.map((surface) => surface.surfaceId));
    if (result.clientId !== this.clientId || !Array.isArray(result.surfaces) ||
        result.surfaces.length !== expected.size ||
        result.surfaces.some((surface) => !surface || typeof surface !== "object" ||
          !expected.delete((surface as { surfaceId?: string }).surfaceId ?? "")) || expected.size !== 0) {
      throw new Error("invalid_registration_response");
    }
    return response;
  }

  private async registerLiveClaims(initial: RegistrationPayload): Promise<{
    payload: RegistrationPayload;
    response: ControllerWireEnvelope;
  }> {
    let payload = initial;
    const refusalBudget = initial.surfaces.reduce((total, surface) => total + 1 + surface.panes.length, 0) + 1;
    for (let attempt = 0; attempt < refusalBudget; attempt += 1) {
      const full = await this.sendRegistration(payload);
      if (full.ok) return { payload, response: full };

      let accepted: RegistrationPayload = { ...payload, surfaces: [] };
      const empty = await this.sendRegistration(accepted);
      if (!empty.ok) throw responseError(empty);

      let refused = false;
      for (const surface of payload.surfaces) {
        const windowOnly = { ...surface, panes: [] };
        const surfaceCandidate = { ...accepted, surfaces: [...accepted.surfaces, windowOnly] };
        const surfaceResponse = await this.sendRegistration(surfaceCandidate);
        if (!surfaceResponse.ok) {
          await this.reidentifyRefusedClaim(surface.surfaceId);
          refused = true;
          break;
        }
        accepted = surfaceCandidate;

        for (const pane of surface.panes) {
          const previousSurface = accepted.surfaces.at(-1)!;
          const paneCandidateSurface = { ...surface, panes: [...previousSurface.panes, pane] };
          const paneCandidate = {
            ...accepted,
            surfaces: [...accepted.surfaces.slice(0, -1), paneCandidateSurface],
          };
          const paneResponse = await this.sendRegistration(paneCandidate);
          if (!paneResponse.ok) {
            await this.reidentifyRefusedClaim(surface.surfaceId, Number(pane.paneId));
            refused = true;
            break;
          }
          accepted = paneCandidate;
        }
        if (refused) break;
      }
      if (!refused) {
        if (accepted.surfaces.length === 0) return { payload: accepted, response: empty };
        const response = await this.sendRegistration(accepted);
        if (!response.ok) throw responseError(response);
        return { payload: accepted, response };
      }
      payload = await this.buildRegistrationPayload();
    }
    throw new Error("registry_claim_recovery_exhausted");
  }

  private async reidentifyRefusedClaim(surfaceId: string, paneId?: number): Promise<void> {
    await this.core.locklessAuthority.transactionAsync(() =>
      this.core.transactionAsync(async () => {
        this.core.reidentifyRegistryClaim(surfaceId, paneId);
        await this.persist();
      }),
    );
  }

  private parseRegistrationResponse(
    response: ControllerWireEnvelope,
    registrationPayload: RegistrationPayload,
    identity: RegistryIdentity,
  ): {
    endpointLease: PersistentRegistryEndpointLease | null;
    surfaces: Array<{ surfaceId: string; windowLabel: string; windowGeneration: number | null;
      panes: Array<{ allocationGeneration: number; paneId: string; paneLineageId: string; paneLabel: number }> }>;
    windowGenerationV1: boolean;
  } {
    if (!response.ok) throw responseError(response);
    const responseIdentity = parseRegistryIdentity(response.payload);
    if (!sameRegistry(responseIdentity, identity)) throw new Error("foreign_registry_identity");
    const responsePayload = response.payload as {
      clientId?: unknown;
      directEndpoint?: unknown;
      endpointLease?: unknown;
      prePairDescribeV1?: unknown;
      windowGenerationV1?: unknown;
      completedPaneReleaseIds?: unknown;
      completedWindowReleaseIds?: unknown;
      surfaces?: unknown;
    };
    const endpointLease = registrationEndpointLease(response.payload);
    if (this.directEndpoint !== null &&
        (responsePayload.directEndpoint !== this.directEndpoint ||
         responsePayload.prePairDescribeV1 !== true || endpointLease === null)) {
      throw new Error("invalid_registration_response");
    }
    if (this.directEndpoint === null &&
        ((responsePayload.directEndpoint !== undefined && responsePayload.directEndpoint !== null) || endpointLease !== null)) {
      throw new Error("invalid_registration_response");
    }
    const payload = response.payload as { clientId: string; surfaces: Array<{
      surfaceId: string; windowLabel: string; windowGeneration?: number | null;
      panes: Array<{ allocationGeneration: number; paneId: string; paneLineageId: string; paneLabel: number }>;
    }>; windowGenerationV1?: unknown; completedPaneReleaseIds?: string[]; completedWindowReleaseIds?: unknown };
    const expectedSurfaceIds = new Set(registrationPayload.surfaces.map((surface) => surface.surfaceId));
    if (payload.clientId !== this.clientId || !Array.isArray(payload.surfaces) ||
        payload.surfaces.length !== expectedSurfaceIds.size ||
        payload.surfaces.some((surface) => !expectedSurfaceIds.delete(surface.surfaceId)) ||
        expectedSurfaceIds.size !== 0 ||
        (payload.windowGenerationV1 !== undefined && typeof payload.windowGenerationV1 !== "boolean")) {
      throw new Error("invalid_registration_response");
    }
    const windowGenerationV1 = payload.windowGenerationV1 === true;
    if (windowGenerationV1 && payload.surfaces.some((surface) =>
      !Number.isSafeInteger(surface.windowGeneration) || Number(surface.windowGeneration) < 1)) {
      throw new Error("invalid_registration_response");
    }
    if (!Array.isArray(payload.completedPaneReleaseIds) || payload.completedPaneReleaseIds.length !== 0 ||
        (payload.completedWindowReleaseIds !== undefined &&
          (!Array.isArray(payload.completedWindowReleaseIds) || payload.completedWindowReleaseIds.length !== 0))) {
      throw new Error("invalid_registration_response");
    }
    const completedWindowReleaseIds = payload.completedWindowReleaseIds as unknown[] | undefined;
    if (windowGenerationV1 && (!Array.isArray(completedWindowReleaseIds) || completedWindowReleaseIds.length !== 0)) {
      throw new Error("invalid_registration_response");
    }
    return {
      endpointLease,
      surfaces: payload.surfaces.map((surface) => ({
        ...surface,
        windowGeneration: windowGenerationV1 ? Number(surface.windowGeneration) : null,
      })),
      windowGenerationV1,
    };
  }

  private async deliverPendingReleases(
    livePayload: RegistrationPayload,
  ): Promise<void> {
    const paneReleases = this.core.locklessAuthority.listPendingPaneReleases();
    const windowReleases = this.core.locklessAuthority.listPendingWindowReleases();
    if (paneReleases.length === 0 && windowReleases.length === 0) return;
    // Free old allocations before registering any live claims that may reuse
    // their labels. A release request must never carry replacement claims.
    const releaseOnlyPayload: RegistrationPayload = {
      ...livePayload,
      surfaces: [],
      pendingPaneReleases: paneReleases,
      pendingWindowReleases: windowReleases,
    };
    try {
      const response = await this.sendRegistration(releaseOnlyPayload);
      if (response.ok && this.completedReleasesMatch(response, paneReleases, windowReleases)) {
        await this.acknowledgeReleases(paneReleases, windowReleases);
        return;
      }
      // A refusal or incomplete acknowledgement can follow partial commits;
      // resolve each exact release idempotently below, still without claims.
    } catch {
      // The request may have reached the allocator. Resolve each release using
      // its idempotent evidence before any later label claims are sent.
    }

    const baseline: RegistrationPayload = {
      ...livePayload,
      surfaces: [],
      pendingPaneReleases: [],
      pendingWindowReleases: [],
    };
    let baselineAccepted = false;
    try {
      baselineAccepted = (await this.sendRegistration(baseline)).ok;
    } catch {
      // Keep unresolved release evidence pending when the no-release baseline
      // cannot establish that the registry is accepting registrations.
    }
    if (!baselineAccepted) return;

    for (const [kind, release] of [
      ...paneReleases.map((release) => ["pane", release] as const),
      ...windowReleases.map((release) => ["window", release] as const),
    ]) {
      const response = await this.tryRelease(baseline, kind, release);
      if (response === "unknown") break;
      if (response === "accepted") {
        await this.acknowledgeReleases(kind === "pane" ? [release as PersistentPaneRetirement] : [],
          kind === "window" ? [release as PersistentWindowRetirement] : []);
      } else {
        await this.discardRejectedRelease(kind, release.releaseId);
      }
    }
  }

  private completedReleasesMatch(
    response: ControllerWireEnvelope,
    paneReleases: PersistentPaneRetirement[],
    windowReleases: PersistentWindowRetirement[],
  ): boolean {
    const body = response.payload as { completedPaneReleaseIds?: unknown; completedWindowReleaseIds?: unknown };
    const paneIds = paneReleases.map((release) => release.releaseId);
    const windowIds = windowReleases.map((release) => release.releaseId);
    return Array.isArray(body?.completedPaneReleaseIds) &&
      body.completedPaneReleaseIds.length === paneIds.length &&
      body.completedPaneReleaseIds.every((releaseId, index) => releaseId === paneIds[index]) &&
      Array.isArray(body?.completedWindowReleaseIds) &&
      body.completedWindowReleaseIds.length === windowIds.length &&
      body.completedWindowReleaseIds.every((releaseId, index) => releaseId === windowIds[index]);
  }

  private async acknowledgeReleases(
    paneReleases: PersistentPaneRetirement[],
    windowReleases: PersistentWindowRetirement[],
  ): Promise<void> {
    await this.core.locklessAuthority.transactionAsync(() => this.core.transactionAsync(async () => {
      this.core.locklessAuthority.acknowledgePaneReleases(paneReleases.map((release) => release.releaseId));
      this.core.locklessAuthority.acknowledgeWindowReleases(windowReleases.map((release) => release.releaseId));
      await this.persist();
    }));
  }

  private async discardRejectedRelease(kind: "pane" | "window", releaseId: string): Promise<void> {
    await this.core.locklessAuthority.transactionAsync(() => this.core.transactionAsync(async () => {
      if (kind === "pane") this.core.locklessAuthority.discardRejectedPaneRelease(releaseId);
      else this.core.locklessAuthority.discardRejectedWindowRelease(releaseId);
      await this.persist();
    }));
  }

  private async tryRelease(
    releaseOnlyPayload: RegistrationPayload,
    kind: "pane" | "window",
    release: PersistentPaneRetirement | PersistentWindowRetirement,
  ): Promise<"accepted" | "rejected" | "unknown"> {
    const payload = kind === "pane"
      ? { ...releaseOnlyPayload, pendingPaneReleases: [release as PersistentPaneRetirement] }
      : { ...releaseOnlyPayload, pendingWindowReleases: [release as PersistentWindowRetirement] };
    try {
      const response = await this.sendRegistration(payload);
      if (response.ok) {
        const body = response.payload as { completedPaneReleaseIds?: unknown; completedWindowReleaseIds?: unknown };
        const completed = kind === "pane" ? body.completedPaneReleaseIds : body.completedWindowReleaseIds;
        if (Array.isArray(completed) && completed.length === 1 && completed[0] === release.releaseId) {
          return "accepted";
        }
        return "unknown";
      }
      const retry = await this.sendRegistration(payload);
      if (retry.ok) {
        const body = retry.payload as { completedPaneReleaseIds?: unknown; completedWindowReleaseIds?: unknown };
        const completed = kind === "pane" ? body.completedPaneReleaseIds : body.completedWindowReleaseIds;
        if (Array.isArray(completed) && completed.length === 1 && completed[0] === release.releaseId) {
          return "accepted";
        }
        return "unknown";
      }
      const baseline = await this.sendRegistration(releaseOnlyPayload);
      if (baseline.ok) return "rejected";
      return "unknown";
    } catch {
      try {
        const baseline = await this.sendRegistration(releaseOnlyPayload);
        if (baseline.ok) return "unknown";
      } catch {
        // Keep the release pending until a later attempt can isolate its outcome.
      }
      return "unknown";
    }
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
