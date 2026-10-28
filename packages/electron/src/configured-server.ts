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
  if (!isRecord(lease)) return null;
  const value = lease as Record<string, unknown>;
  if (!Number.isSafeInteger(value.leaseGeneration) || Number(value.leaseGeneration) < 1 ||
      !Number.isSafeInteger(value.registrationObservedAtMs) || Number(value.registrationObservedAtMs) < 0 ||
      !Number.isSafeInteger(value.leaseExpiresAtMs) || Number(value.leaseExpiresAtMs) <= Number(value.registrationObservedAtMs)) {
    return null;
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
  registrationResultsV1: true;
  surfaces: RegistrationSurface[];
  windowGenerationV1: true;
};

type RegistrationRefusal = {
  errorCode: string;
  paneId?: string;
  paneLineageId?: string;
  surfaceId: string;
};

type ParsedRegistrationResponse = {
  allocationGenerationV1: boolean;
  endpointLease: PersistentRegistryEndpointLease | null;
  partial: boolean;
  refusedPanes: RegistrationRefusal[];
  refusedSurfaces: RegistrationRefusal[];
  surfaces: Array<{
    surfaceId: string;
    windowLabel: string;
    windowGeneration: number | null;
    panes: Array<{ allocationGeneration: number | null; paneId: string; paneLineageId: string; paneLabel: number }>;
  }>;
  windowGenerationV1: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refusalCode(value: unknown): string {
  return isRecord(value) && isRecord(value.error) && typeof value.error.code === "string"
    ? value.error.code
    : "registration_claim_refused";
}

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
  private readonly retrySuppressedClaimKeys = new Set<string>();
  private readonly reportedCompatibilityWarnings = new Set<string>();
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
        (payload?.allocationGeneration !== undefined && payload.allocationGeneration !== null &&
          (!Number.isSafeInteger(payload.allocationGeneration) || Number(payload.allocationGeneration) < 1))) {
      throw new Error("invalid_pane_assignment");
    }
    if (payload.allocationGeneration === undefined || payload.allocationGeneration === null) {
      this.reportCompatibilityWarning("pane-claim-generation", "Registry pane claim did not include an allocation generation; the label is usable, but generation-dependent operations remain unavailable");
    }
    return {
      allocationGeneration: Number.isSafeInteger(payload.allocationGeneration) && Number(payload.allocationGeneration) > 0
        ? Number(payload.allocationGeneration)
        : null,
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
      if (!await this.deliverPendingReleases(registrationPayload)) {
        this.reportPendingWindowReleases();
        return;
      }
      const registered = await this.registerLiveClaims(registrationPayload);
      if (!registered.partialApplied) {
        const parsed = this.parseRegistrationResponse(registered.response, registered.payload, identity);
        await this.applyRegistrationResponse(parsed, registered.payload);
      }
      this.reportPendingWindowReleases();
      if (!this.wire.isOpen()) throw new Error("controller_wire_closed");
    });
    this.pending = run.catch(() => undefined);
    return run;
  }

  private reportPendingWindowReleases(): void {
    const pending = new Set(
      this.core.locklessAuthority.listPendingWindowReleases().map((release) => release.releaseId),
    );
    for (const releaseId of pending) {
      if (!this.reportedPendingWindowReleaseIds.has(releaseId)) {
        this.reportWarning(new Error("allocator_release_pending"));
      }
    }
    this.reportedPendingWindowReleaseIds = pending;
  }

  private reportWarning(error: unknown): void {
    try { this.onError(error); } catch { /* warning delivery cannot cancel neighboring claims */ }
  }

  private reportCompatibilityWarning(key: string, message: string): void {
    if (this.reportedCompatibilityWarnings.has(key)) return;
    this.reportedCompatibilityWarnings.add(key);
    this.reportWarning(new Error(message));
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
          registrationResultsV1: true,
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
    const result = response.payload as { clientId?: unknown; registrationResultsV1?: unknown };
    this.validateClientEcho(result.clientId);
    return response;
  }

  private validateClientEcho(value: unknown): void {
    if (typeof value === "string" && value.length > 0 && value !== this.clientId) {
      throw new Error("foreign_client_identity");
    }
    if (value !== this.clientId) {
      this.reportCompatibilityWarning("missing-client-id", "Registry registration reply omitted a client identity echo; assuming the identity from the correlated request");
    }
  }

  private async registerLiveClaims(initial: RegistrationPayload): Promise<{
    partialApplied?: boolean;
    payload: RegistrationPayload;
    response: ControllerWireEnvelope;
  }> {
    let payload = initial;
    const refusalBudget = initial.surfaces.reduce((total, surface) => total + 1 + surface.panes.length, 0) + 1;
    for (let attempt = 0; attempt < refusalBudget; attempt += 1) {
      const full = await this.sendRegistration(payload);
      if (full.ok) {
        const parsed = this.parseRegistrationResponse(full, payload, this.registryIdentity!);
        if (parsed.refusedPanes.length === 0 && parsed.refusedSurfaces.length === 0) {
          return { payload, response: full };
        }
        const reidentified = await this.applyRegistrationResponse(parsed, payload);
        if (reidentified === 0) return { partialApplied: true, payload, response: full };
        payload = await this.buildRegistrationPayload();
        continue;
      }

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
  ): ParsedRegistrationResponse {
    if (!response.ok) throw responseError(response);
    if (!isRecord(response.payload)) throw new Error("invalid_registration_response");
    const responsePayload = response.payload;
    const responseIdentity = parseRegistryIdentity(responsePayload);
    if (!sameRegistry(responseIdentity, identity)) throw new Error("foreign_registry_identity");
    this.validateClientEcho(responsePayload.clientId);

    const windowGenerationV1 = this.readCapabilityFlag(
      responsePayload.windowGenerationV1, "window-generation", "window allocation generations",
    );
    const allocationGenerationV1 = this.readCapabilityFlag(
      responsePayload.allocationGenerationV1, "pane-generation", "pane allocation generations",
    );
    if (!windowGenerationV1 || !allocationGenerationV1) {
      this.reportCompatibilityWarning("allocation-generations-unavailable",
        "Registry reply omits allocation generations; labels remain available, while operations needing a generation stay unavailable");
    }
    const endpointLease = this.registrationEndpointLease(responsePayload);
    if (!Array.isArray(responsePayload.completedPaneReleaseIds) ||
        !Array.isArray(responsePayload.completedWindowReleaseIds) ||
        !Array.isArray(responsePayload.paneReleaseResults) ||
        !Array.isArray(responsePayload.windowReleaseResults)) {
      this.reportCompatibilityWarning("release-confirmations-unavailable",
        "Registry reply does not include release confirmations; unconfirmed release items remain pending");
    }

    if (responsePayload.registrationResultsV1 !== undefined &&
        typeof responsePayload.registrationResultsV1 !== "boolean") {
      this.reportCompatibilityWarning("registration-results-flag",
        "Registry reply has an invalid per-item results flag; using the reply fields that can be correlated safely");
    }
    const hasPartialRows = Array.isArray(responsePayload.surfaceResults);
    const partial = responsePayload.registrationResultsV1 === true || hasPartialRows;
    if (partial && hasPartialRows) {
      return this.parsePartialRegistrationResponse(
        responsePayload, registrationPayload, endpointLease, allocationGenerationV1, windowGenerationV1,
      );
    }
    if (partial) {
      this.reportCompatibilityWarning("partial-results-missing",
        "Registry reply omitted its per-item results; trying the legacy projection and retrying claims that cannot be matched");
    }
    return this.parseLegacyRegistrationResponse(
      responsePayload, registrationPayload, endpointLease, allocationGenerationV1, windowGenerationV1,
    );
  }

  private readCapabilityFlag(value: unknown, key: string, label: string): boolean {
    if (value === true) return true;
    if (value !== undefined && value !== false) {
      this.reportCompatibilityWarning(`${key}-flag`, `Registry reply has an invalid ${label} flag; treating that capability as unavailable`);
    }
    return false;
  }

  private registrationEndpointLease(payload: Record<string, unknown>): PersistentRegistryEndpointLease | null {
    const rawLease = payload.endpointLease;
    const lease = registrationEndpointLease(payload);
    if (rawLease !== undefined && rawLease !== null && lease === null) {
      this.reportCompatibilityWarning("endpoint-lease-invalid", "Registry endpoint lease is unavailable or malformed; registration labels remain usable");
    }

    if (this.directEndpoint !== null) {
      if (payload.directEndpoint === this.directEndpoint && payload.prePairDescribeV1 === true && lease !== null) {
        return lease;
      }
      this.reportCompatibilityWarning("endpoint-lease-unavailable",
        "Registry endpoint metadata could not be confirmed; using registration labels without a direct endpoint lease");
      return null;
    }

    if ((payload.directEndpoint !== undefined && payload.directEndpoint !== null) || lease !== null) {
      this.reportCompatibilityWarning("endpoint-lease-unrequested",
        "Registry returned endpoint metadata that was not requested; ignoring that optional metadata");
    }
    return null;
  }

  private parsePartialRegistrationResponse(
    payload: Record<string, unknown>,
    registrationPayload: RegistrationPayload,
    endpointLease: PersistentRegistryEndpointLease | null,
    allocationGenerationV1: boolean,
    windowGenerationV1: boolean,
  ): ParsedRegistrationResponse {
    const rawResults = payload.surfaceResults as unknown[];
    const surfaces: ParsedRegistrationResponse["surfaces"] = [];
    const refusedSurfaces: RegistrationRefusal[] = [];
    const refusedPanes: RegistrationRefusal[] = [];
    const refuseSurface = (requested: RegistrationSurface, errorCode: string) => {
      refusedSurfaces.push({ surfaceId: requested.surfaceId, errorCode });
    };
    const refusePane = (requested: RegistrationSurface, pane: RegistrationPane, errorCode: string) => {
      refusedPanes.push({
        surfaceId: requested.surfaceId,
        paneId: pane.paneId,
        paneLineageId: pane.paneLineageId,
        errorCode,
      });
    };

    if (rawResults.length > registrationPayload.surfaces.length) {
      this.reportCompatibilityWarning("partial-results-extra", "Registry returned extra surface results; ignoring unrequested rows");
    }
    for (let index = 0; index < registrationPayload.surfaces.length; index += 1) {
      const requested = registrationPayload.surfaces[index]!;
      const result = rawResults[index];
      if (!isRecord(result)) {
        refuseSurface(requested, "missing_surface_result");
        this.reportCompatibilityWarning("partial-surface-row", "Registry omitted or malformed a surface result; retrying that claim");
        continue;
      }
      if (result.index !== undefined && result.index !== index) throw new Error("invalid_registration_response");
      if (result.index === undefined) {
        this.reportCompatibilityWarning("partial-surface-index", "Registry omitted a result index; correlating by its ordered request slot");
      }
      if (result.surfaceId !== undefined && result.surfaceId !== requested.surfaceId) {
        throw new Error("invalid_registration_response");
      }
      if (result.surfaceId === undefined) {
        this.reportCompatibilityWarning("partial-surface-identity", "Registry omitted a surface identity; assuming the identity from its matching request index");
      }
      if (typeof result.ok !== "boolean") {
        refuseSurface(requested, "invalid_surface_result");
        this.reportCompatibilityWarning("partial-surface-row", "Registry returned a malformed surface result; retrying that claim");
        continue;
      }
      if (!result.ok) {
        refuseSurface(requested, refusalCode(result));
        continue;
      }
      if (typeof result.windowLabel !== "string" || !/^[a-z]+$/.test(result.windowLabel)) {
        refuseSurface(requested, "invalid_window_label");
        this.reportCompatibilityWarning("partial-surface-row", "Registry returned an invalid window label; retrying that surface claim");
        continue;
      }

      let windowGeneration: number | null = null;
      if (result.windowGeneration !== undefined && result.windowGeneration !== null) {
        if (!Number.isSafeInteger(result.windowGeneration) || Number(result.windowGeneration) < 1) {
          refuseSurface(requested, "invalid_window_generation");
          this.reportCompatibilityWarning("partial-surface-row", "Registry returned an invalid window generation; retrying that surface claim");
          continue;
        }
        if (windowGenerationV1) windowGeneration = Number(result.windowGeneration);
      } else if (windowGenerationV1) {
        refuseSurface(requested, "missing_window_generation");
        this.reportCompatibilityWarning("partial-surface-row", "Registry omitted a required window generation; retrying that surface claim");
        continue;
      }

      const panes: ParsedRegistrationResponse["surfaces"][number]["panes"] = [];
      if (!Array.isArray(result.paneResults)) {
        for (const pane of requested.panes) refusePane(requested, pane, "missing_pane_results");
        this.reportCompatibilityWarning("partial-pane-row", "Registry omitted pane results; retrying those pane claims while keeping the window label");
      } else {
        if (result.paneResults.length > requested.panes.length) {
          this.reportCompatibilityWarning("partial-pane-extra", "Registry returned extra pane results; ignoring unrequested rows");
        }
        for (let paneIndex = 0; paneIndex < requested.panes.length; paneIndex += 1) {
          const requestedPane = requested.panes[paneIndex]!;
          const paneResult = result.paneResults[paneIndex];
          if (!isRecord(paneResult)) {
            refusePane(requested, requestedPane, "missing_pane_result");
            this.reportCompatibilityWarning("partial-pane-row", "Registry omitted or malformed a pane result; retrying that pane claim");
            continue;
          }
          if (paneResult.index !== undefined && paneResult.index !== paneIndex) throw new Error("invalid_registration_response");
          if (paneResult.index === undefined) {
            this.reportCompatibilityWarning("partial-pane-index", "Registry omitted a pane result index; correlating by its ordered request slot");
          }
          if ((paneResult.paneId !== undefined && paneResult.paneId !== requestedPane.paneId) ||
              (paneResult.paneLineageId !== undefined && paneResult.paneLineageId !== requestedPane.paneLineageId)) {
            refusePane(requested, requestedPane, "pane_identity_mismatch");
            this.reportCompatibilityWarning("partial-pane-row", "Registry pane identity did not match its request slot; retrying that pane claim");
            continue;
          }
          if (paneResult.paneId === undefined || paneResult.paneLineageId === undefined) {
            this.reportCompatibilityWarning("partial-pane-identity", "Registry omitted a pane identity; assuming the identity from its matching request index");
          }
          if (typeof paneResult.ok !== "boolean") {
            refusePane(requested, requestedPane, "invalid_pane_result");
            this.reportCompatibilityWarning("partial-pane-row", "Registry returned a malformed pane result; retrying that pane claim");
            continue;
          }
          if (!paneResult.ok) {
            refusePane(requested, requestedPane, refusalCode(paneResult));
            continue;
          }
          if (!Number.isSafeInteger(paneResult.paneLabel) || Number(paneResult.paneLabel) < 1) {
            refusePane(requested, requestedPane, "invalid_pane_label");
            this.reportCompatibilityWarning("partial-pane-row", "Registry returned an invalid pane label; retrying that pane claim");
            continue;
          }
          const hasGeneration = paneResult.allocationGeneration !== undefined && paneResult.allocationGeneration !== null;
          if (hasGeneration && (!Number.isSafeInteger(paneResult.allocationGeneration) ||
              Number(paneResult.allocationGeneration) < 1)) {
            refusePane(requested, requestedPane, "invalid_pane_generation");
            this.reportCompatibilityWarning("partial-pane-row", "Registry returned an invalid pane generation; retrying that pane claim");
            continue;
          }
          if (!hasGeneration && allocationGenerationV1) {
            refusePane(requested, requestedPane, "missing_pane_generation");
            this.reportCompatibilityWarning("partial-pane-row", "Registry omitted a required pane generation; retrying that pane claim");
            continue;
          }
          const allocationGeneration = hasGeneration ? Number(paneResult.allocationGeneration) : null;
          if (allocationGeneration === null) {
            this.reportCompatibilityWarning("allocation-generations-unavailable",
              "Registry reply omits allocation generations; labels remain available, while operations needing a generation stay unavailable");
          }
          panes.push({
            allocationGeneration,
            paneId: requestedPane.paneId,
            paneLineageId: requestedPane.paneLineageId,
            paneLabel: Number(paneResult.paneLabel),
          });
        }
      }
      surfaces.push({
        surfaceId: requested.surfaceId,
        windowLabel: result.windowLabel,
        windowGeneration,
        panes,
      });
    }

    return {
      allocationGenerationV1,
      endpointLease,
      partial: true,
      refusedPanes,
      refusedSurfaces,
      surfaces,
      windowGenerationV1,
    };
  }

  private parseLegacyRegistrationResponse(
    payload: Record<string, unknown>,
    registrationPayload: RegistrationPayload,
    endpointLease: PersistentRegistryEndpointLease | null,
    allocationGenerationV1: boolean,
    windowGenerationV1: boolean,
  ): ParsedRegistrationResponse {
    const requestedBySurfaceId = new Map(registrationPayload.surfaces.map((surface) => [surface.surfaceId, surface]));
    if (requestedBySurfaceId.size !== registrationPayload.surfaces.length) throw new Error("invalid_registration_response");
    const refusedSurfaces: RegistrationRefusal[] = [];
    const refusedPanes: RegistrationRefusal[] = [];
    const surfaces: ParsedRegistrationResponse["surfaces"] = [];
    const rawSurfaces = payload.surfaces;
    if (!Array.isArray(rawSurfaces)) {
      for (const requested of registrationPayload.surfaces) {
        refusedSurfaces.push({ surfaceId: requested.surfaceId, errorCode: "missing_surface_projection" });
      }
      this.reportCompatibilityWarning("legacy-surface-projection", "Registry omitted its surface projection; retrying window claims");
      return { allocationGenerationV1, endpointLease, partial: false, refusedPanes, refusedSurfaces, surfaces, windowGenerationV1 };
    }

    const rowsBySurface = new Map<string, Record<string, unknown>[]>();
    for (let index = 0; index < rawSurfaces.length; index += 1) {
      const raw = rawSurfaces[index];
      let surfaceId: string | null = null;
      if (isRecord(raw) && typeof raw.surfaceId === "string") {
        if (!requestedBySurfaceId.has(raw.surfaceId)) throw new Error("invalid_registration_response");
        surfaceId = raw.surfaceId;
      } else if ((!isRecord(raw) || raw.surfaceId === undefined) && rawSurfaces.length === registrationPayload.surfaces.length) {
        surfaceId = registrationPayload.surfaces[index]?.surfaceId ?? null;
        this.reportCompatibilityWarning("legacy-surface-identity", "Registry omitted a surface identity; assuming the identity from its ordered request slot");
      }
      if (surfaceId === null || !isRecord(raw)) {
        this.reportCompatibilityWarning("legacy-surface-row", "Registry returned a malformed surface row; retrying the unmatched window claim");
        continue;
      }
      const rows = rowsBySurface.get(surfaceId) ?? [];
      rows.push(raw);
      rowsBySurface.set(surfaceId, rows);
    }

    for (const requested of registrationPayload.surfaces) {
      const matchingRows = rowsBySurface.get(requested.surfaceId) ?? [];
      if (matchingRows.length !== 1) {
        refusedSurfaces.push({
          surfaceId: requested.surfaceId,
          errorCode: matchingRows.length === 0 ? "missing_surface_projection" : "duplicate_surface_projection",
        });
        this.reportCompatibilityWarning("legacy-surface-row", "Registry omitted or duplicated a surface row; retrying that window claim");
        continue;
      }
      const rawSurface = matchingRows[0]!;
      if (typeof rawSurface.windowLabel !== "string" || !/^[a-z]+$/.test(rawSurface.windowLabel)) {
        refusedSurfaces.push({ surfaceId: requested.surfaceId, errorCode: "invalid_window_label" });
        this.reportCompatibilityWarning("legacy-surface-row", "Registry returned an invalid window label; retrying that surface claim");
        continue;
      }
      let windowGeneration: number | null = null;
      if (rawSurface.windowGeneration !== undefined && rawSurface.windowGeneration !== null) {
        if (!Number.isSafeInteger(rawSurface.windowGeneration) || Number(rawSurface.windowGeneration) < 1) {
          refusedSurfaces.push({ surfaceId: requested.surfaceId, errorCode: "invalid_window_generation" });
          this.reportCompatibilityWarning("legacy-surface-row", "Registry returned an invalid window generation; retrying that surface claim");
          continue;
        }
        if (windowGenerationV1) windowGeneration = Number(rawSurface.windowGeneration);
      } else if (windowGenerationV1) {
        refusedSurfaces.push({ surfaceId: requested.surfaceId, errorCode: "missing_window_generation" });
        this.reportCompatibilityWarning("legacy-surface-row", "Registry omitted a required window generation; retrying that surface claim");
        continue;
      }

      const panes: ParsedRegistrationResponse["surfaces"][number]["panes"] = [];
      const rawPanes = rawSurface.panes;
      const refusedPaneIds = new Set<string>();
      if (!Array.isArray(rawPanes)) {
        for (const pane of requested.panes) {
          refusedPanes.push({ surfaceId: requested.surfaceId, paneId: pane.paneId, paneLineageId: pane.paneLineageId, errorCode: "missing_pane_projection" });
          refusedPaneIds.add(pane.paneId);
        }
        this.reportCompatibilityWarning("legacy-pane-projection", "Registry omitted pane projections; keeping the window label and retrying pane claims");
      } else {
        const requestedPanes = new Map(requested.panes.map((pane) => [pane.paneId, pane]));
        const seenPaneIds = new Set<string>();
        for (let index = 0; index < rawPanes.length; index += 1) {
          const rawPane = rawPanes[index];
          if (!isRecord(rawPane)) {
            const positional = rawPanes.length === requested.panes.length ? requested.panes[index] : undefined;
            if (positional) {
              refusedPanes.push({ surfaceId: requested.surfaceId, paneId: positional.paneId, paneLineageId: positional.paneLineageId, errorCode: "invalid_pane_projection" });
              refusedPaneIds.add(positional.paneId);
            }
            this.reportCompatibilityWarning("legacy-pane-row", "Registry returned a malformed pane row; retrying the affected pane claim");
            continue;
          }
          const paneIdValue = rawPane.paneId;
          const lineageValue = rawPane.paneLineageId;
          let requestedPane = typeof paneIdValue === "string" ? requestedPanes.get(paneIdValue) : undefined;
          if (!requestedPane && typeof lineageValue === "string") {
            requestedPane = requested.panes.find((pane) => pane.paneLineageId === lineageValue);
          }
          if (!requestedPane && (paneIdValue === undefined || typeof paneIdValue !== "string") &&
              (lineageValue === undefined || typeof lineageValue !== "string") &&
              rawPanes.length === requested.panes.length) {
            requestedPane = requested.panes[index];
          }
          if (!requestedPane) {
            this.reportCompatibilityWarning("legacy-pane-row", "Registry returned an unrequested pane row; ignoring it and retrying unmatched claims");
            continue;
          }
          if (seenPaneIds.has(requestedPane.paneId)) throw new Error("invalid_registration_response");
          seenPaneIds.add(requestedPane.paneId);
          const refuse = (errorCode: string) => {
            refusedPanes.push({
              surfaceId: requested.surfaceId,
              paneId: requestedPane!.paneId,
              paneLineageId: requestedPane!.paneLineageId,
              errorCode,
            });
            refusedPaneIds.add(requestedPane!.paneId);
          };
          if (typeof paneIdValue !== "string" || typeof lineageValue !== "string") {
            this.reportCompatibilityWarning("legacy-pane-identity", "Registry omitted a pane identity; assuming the identity from its matching projection slot");
          }
          if ((typeof paneIdValue === "string" && paneIdValue !== requestedPane.paneId) ||
              (typeof lineageValue === "string" && lineageValue !== requestedPane.paneLineageId)) {
            refuse("pane_identity_mismatch");
            this.reportCompatibilityWarning("legacy-pane-row", "Registry pane identity did not match a requested pane; retrying that pane claim");
            continue;
          }
          if (!Number.isSafeInteger(rawPane.paneLabel) || Number(rawPane.paneLabel) < 1) {
            refuse("invalid_pane_label");
            this.reportCompatibilityWarning("legacy-pane-row", "Registry returned an invalid pane label; retrying that pane claim");
            continue;
          }
          const generationPresent = rawPane.allocationGeneration !== undefined && rawPane.allocationGeneration !== null;
          if (generationPresent && (!Number.isSafeInteger(rawPane.allocationGeneration) || Number(rawPane.allocationGeneration) < 1)) {
            refuse("invalid_pane_generation");
            this.reportCompatibilityWarning("legacy-pane-row", "Registry returned an invalid pane generation; retrying that pane claim");
            continue;
          }
          if (!generationPresent && allocationGenerationV1) {
            refuse("missing_pane_generation");
            this.reportCompatibilityWarning("legacy-pane-row", "Registry omitted a required pane generation; retrying that pane claim");
            continue;
          }
          const allocationGeneration = generationPresent ? Number(rawPane.allocationGeneration) : null;
          if (allocationGeneration === null) {
            this.reportCompatibilityWarning("allocation-generations-unavailable",
              "Registry reply omits allocation generations; labels remain available, while operations needing a generation stay unavailable");
          }
          panes.push({
            allocationGeneration,
            paneId: requestedPane.paneId,
            paneLineageId: requestedPane.paneLineageId,
            paneLabel: Number(rawPane.paneLabel),
          });
        }
        for (const pane of requested.panes) {
          if (!seenPaneIds.has(pane.paneId)) {
            refusedPanes.push({
              surfaceId: requested.surfaceId,
              paneId: pane.paneId,
              paneLineageId: pane.paneLineageId,
              errorCode: "missing_pane_projection",
            });
            refusedPaneIds.add(pane.paneId);
          }
        }
      }
      surfaces.push({
        surfaceId: requested.surfaceId,
        windowLabel: rawSurface.windowLabel,
        windowGeneration,
        panes: panes.filter((pane) => !refusedPaneIds.has(pane.paneId)),
      });
    }

    return {
      allocationGenerationV1,
      endpointLease,
      partial: false,
      refusedPanes,
      refusedSurfaces,
      surfaces,
      windowGenerationV1,
    };
  }

  private async applyRegistrationResponse(
    parsed: ParsedRegistrationResponse,
    registrationPayload: RegistrationPayload,
  ): Promise<number> {
    const requestedBySurfaceId = new Map(
      registrationPayload.surfaces.map((surface) => [surface.surfaceId, surface]),
    );
    const refusedSurfaceIds = new Set(parsed.refusedSurfaces.map((claim) => claim.surfaceId));
    const warnings: Error[] = [];
    let reidentifiedCount = 0;
    const paneAssignments: Array<{
      surfaceId: string;
      panes: Array<{ allocationGeneration: number | null; paneId: string; paneLineageId: string; paneLabel: number }>;
    }> = [];
    await this.core.locklessAuthority.transactionAsync(() => this.core.transactionAsync(async () => {
      for (const refused of parsed.refusedSurfaces) {
        const requested = requestedBySurfaceId.get(refused.surfaceId);
        const surface = this.core.listSurfaces().find((candidate) => candidate.surfaceId === refused.surfaceId);
        if (!requested || !surface || surface.windowAllocationGeneration !== requested.windowGeneration) {
          warnings.push(new Error(`Registry declined a window claim that is no longer current (${refused.errorCode})`));
          continue;
        }
        warnings.push(new Error(`Registry declined a window claim (${refused.errorCode})`));
        if (this.retrySuppressedClaimKeys.has(this.surfaceClaimKey(refused.surfaceId))) continue;
        const changed = this.core.reidentifyRegistryClaim(refused.surfaceId);
        if (changed.kind !== "surface") throw new Error("invalid_registry_claim_reidentification");
        this.retrySuppressedClaimKeys.add(this.surfaceClaimKey(changed.newSurfaceId));
        reidentifiedCount += 1;
      }

      for (const refused of parsed.refusedPanes) {
        if (refusedSurfaceIds.has(refused.surfaceId)) continue;
        const requested = requestedBySurfaceId.get(refused.surfaceId);
        const surface = this.core.listSurfaces().find((candidate) => candidate.surfaceId === refused.surfaceId);
        const paneId = Number(refused.paneId);
        const requestedPane = requested?.panes.find((pane) => pane.paneId === refused.paneId);
        const pane = surface?.panes.get(paneId);
        if (!requested || !surface || !requestedPane || !pane ||
            surface.windowAllocationGeneration !== requested.windowGeneration ||
            pane.paneLineageId !== refused.paneLineageId ||
            pane.paneLabel !== requestedPane.paneLabel ||
            pane.allocationGeneration !== requestedPane.allocationGeneration) {
          warnings.push(new Error(`Registry declined a pane claim that is no longer current (${refused.errorCode})`));
          continue;
        }
        warnings.push(new Error(`Registry declined a pane claim (${refused.errorCode})`));
        const key = this.paneClaimKey(refused.surfaceId, refused.paneId!, refused.paneLineageId!);
        if (this.retrySuppressedClaimKeys.has(key)) continue;
        const changed = this.core.reidentifyRegistryClaim(refused.surfaceId, paneId);
        if (changed.kind !== "pane") throw new Error("invalid_registry_claim_reidentification");
        const freshPane = this.core.getSurface(refused.surfaceId).panes.get(changed.newPaneId)!;
        this.retrySuppressedClaimKeys.add(this.paneClaimKey(refused.surfaceId, String(changed.newPaneId), freshPane.paneLineageId));
        reidentifiedCount += 1;
      }

      const windowAssignments: Array<{ surfaceId: string; windowGeneration: number | null; windowLabel: string }> = [];
      for (const assignment of parsed.surfaces) {
        const requested = requestedBySurfaceId.get(assignment.surfaceId);
        const surface = this.core.listSurfaces().find((candidate) => candidate.surfaceId === assignment.surfaceId);
        if (!requested || !surface || surface.windowAllocationGeneration !== requested.windowGeneration) {
          warnings.push(new Error("Registry reply no longer matches the current window; it was ignored"));
          continue;
        }
        windowAssignments.push({
          surfaceId: assignment.surfaceId,
          windowLabel: assignment.windowLabel,
          windowGeneration: parsed.windowGenerationV1 ? assignment.windowGeneration : null,
        });

        const acceptedPanes = assignment.panes.filter((registered) => {
          const pane = surface.panes.get(Number(registered.paneId));
          const requestedPane = requested.panes.find((entry) => entry.paneId === registered.paneId);
          const current = Boolean(pane && requestedPane && pane.paneLineageId === registered.paneLineageId &&
            pane.paneLineageId === requestedPane.paneLineageId &&
            pane.paneLabel === requestedPane.paneLabel &&
            pane.allocationGeneration === requestedPane.allocationGeneration);
          if (!current) warnings.push(new Error("Registry reply no longer matches the current pane; its label was ignored"));
          else this.retrySuppressedClaimKeys.delete(this.paneClaimKey(
            assignment.surfaceId, registered.paneId, registered.paneLineageId,
          ));
          return current;
        });
        const acceptedPaneIds = new Set(acceptedPanes.map((pane) => Number(pane.paneId)));
        const omittedPanesAreFresh = [...surface.panes.values()].every((pane) =>
          acceptedPaneIds.has(pane.paneId) || (pane.paneLabel === 0 && pane.allocationGeneration === null));
        if (omittedPanesAreFresh) {
          paneAssignments.push({ surfaceId: assignment.surfaceId, panes: acceptedPanes });
        } else {
          warnings.push(new Error("Registry pane labels were deferred while a current pane claim is changing"));
        }
        this.retrySuppressedClaimKeys.delete(this.surfaceClaimKey(assignment.surfaceId));
      }

      this.core.applyWindowLabels(windowAssignments);
      this.core.applyRegistryPaneLabels(paneAssignments, { allowUnassigned: true });
      const currentSurfaceIds = new Set(this.core.listSurfaces().map((surface) => surface.surfaceId));
      const assignedWindowIds = new Set(windowAssignments.map((surface) => surface.surfaceId));
      const acceptedPaneKeys = new Set(parsed.surfaces.flatMap((surface) => surface.panes.map((pane) =>
        this.paneClaimKey(surface.surfaceId, pane.paneId, pane.paneLineageId))));
      const requestCoversCurrentSurfaces = currentSurfaceIds.size === registrationPayload.surfaces.length &&
        registrationPayload.surfaces.every((surface) => currentSurfaceIds.has(surface.surfaceId)) &&
        [...currentSurfaceIds].every((surfaceId) => {
          const current = this.core.getSurface(surfaceId);
          return assignedWindowIds.has(surfaceId) && [...current.panes.values()].every((pane) =>
            acceptedPaneKeys.has(this.paneClaimKey(surfaceId, String(pane.paneId), pane.paneLineageId)) &&
            pane.paneLabel > 0 && (!parsed.allocationGenerationV1 || pane.allocationGeneration !== null));
        });
      if (parsed.refusedPanes.length === 0 && parsed.refusedSurfaces.length === 0 && requestCoversCurrentSurfaces) {
        this.core.completeRegistryBinding();
      }
      this.core.setRegistryEndpointLease(parsed.endpointLease);
      await this.persist();
    }));
    this.core.confirmRegistryPaneLabels(paneAssignments);
    for (const warning of warnings) this.reportWarning(warning);
    return reidentifiedCount;
  }

  private surfaceClaimKey(surfaceId: string): string {
    return `surface:${surfaceId}`;
  }

  private paneClaimKey(surfaceId: string, paneId: string, paneLineageId: string): string {
    return `pane:${surfaceId}:${paneId}:${paneLineageId}`;
  }

  private async deliverPendingReleases(
    livePayload: RegistrationPayload,
  ): Promise<boolean> {
    const paneReleases = this.core.locklessAuthority.listPendingPaneReleases();
    const windowReleases = this.core.locklessAuthority.listPendingWindowReleases();
    if (paneReleases.length === 0 && windowReleases.length === 0) return true;
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
      if (response.ok) {
        const outcomes = this.releaseResults(response, paneReleases, windowReleases);
        if (outcomes) {
          await this.applyReleaseResults(outcomes, paneReleases, windowReleases);
          return this.pendingReleasesRemain() === false;
        }
        if (this.completedReleasesMatch(response, paneReleases, windowReleases)) {
          await this.acknowledgeReleases(paneReleases, windowReleases);
          return true;
        }
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
      baselineAccepted = (await this.sendRegistration(baseline)).ok === true;
    } catch {
      // Keep unresolved release evidence pending when the no-release baseline
      // cannot establish that the registry is accepting registrations.
    }
    if (!baselineAccepted) {
      this.reportWarning(new Error("Saved release items could not be confirmed; label claims will wait"));
      return false;
    }

    let registryUnavailable = false;
    for (const [kind, release] of [
      ...paneReleases.map((release) => ["pane", release] as const),
      ...windowReleases.map((release) => ["window", release] as const),
    ]) {
      const response = await this.tryRelease(baseline, kind, release);
      if (response === "unavailable") {
        registryUnavailable = true;
        break;
      }
      if (response === "accepted") {
        await this.acknowledgeReleases(kind === "pane" ? [release as PersistentPaneRetirement] : [],
          kind === "window" ? [release as PersistentWindowRetirement] : []);
      } else if (response === "rejected") {
        await this.discardRejectedRelease(kind, release.releaseId);
      }
    }
    if (this.pendingReleasesRemain()) {
      this.reportWarning(new Error(registryUnavailable
        ? "Saved release items could not be confirmed; label claims will wait"
        : "A saved release item remains unconfirmed; continuing with registry-assigned live labels"));
      return !registryUnavailable;
    }
    return true;
  }

  private releaseResults(
    response: ControllerWireEnvelope,
    paneReleases: PersistentPaneRetirement[],
    windowReleases: PersistentWindowRetirement[],
  ): { pane: Array<{ releaseId: string; ok: boolean }>; window: Array<{ releaseId: string; ok: boolean }> } | null {
    if (!isRecord(response.payload) || response.payload.registrationResultsV1 !== true) return null;
    const parse = (value: unknown, releases: Array<{ releaseId: string }>) => {
      if (!Array.isArray(value) || value.length !== releases.length) return null;
      const result: Array<{ releaseId: string; ok: boolean }> = [];
      for (let index = 0; index < releases.length; index += 1) {
        const item = value[index];
        if (!isRecord(item) || item.index !== index || item.releaseId !== releases[index]!.releaseId ||
            typeof item.ok !== "boolean") return null;
        result.push({ releaseId: releases[index]!.releaseId, ok: item.ok });
      }
      return result;
    };
    const pane = parse(response.payload.paneReleaseResults, paneReleases);
    const window = parse(response.payload.windowReleaseResults, windowReleases);
    return pane && window ? { pane, window } : null;
  }

  private async applyReleaseResults(
    outcomes: { pane: Array<{ releaseId: string; ok: boolean }>; window: Array<{ releaseId: string; ok: boolean }> },
    paneReleases: PersistentPaneRetirement[],
    windowReleases: PersistentWindowRetirement[],
  ): Promise<void> {
    const paneById = new Map(paneReleases.map((release) => [release.releaseId, release]));
    const windowById = new Map(windowReleases.map((release) => [release.releaseId, release]));
    const acceptedPanes = outcomes.pane.filter((item) => item.ok).map((item) => paneById.get(item.releaseId)!);
    const refusedPanes = outcomes.pane.filter((item) => !item.ok).map((item) => paneById.get(item.releaseId)!);
    const acceptedWindows = outcomes.window.filter((item) => item.ok).map((item) => windowById.get(item.releaseId)!);
    const refusedWindows = outcomes.window.filter((item) => !item.ok).map((item) => windowById.get(item.releaseId)!);
    if (acceptedPanes.length || acceptedWindows.length) await this.acknowledgeReleases(acceptedPanes, acceptedWindows);
    for (const release of refusedPanes) await this.discardRejectedRelease("pane", release.releaseId);
    for (const release of refusedWindows) await this.discardRejectedRelease("window", release.releaseId);
    for (const release of [...refusedPanes, ...refusedWindows]) {
      this.reportWarning(new Error(`A saved release item was declined (${release.releaseId})`));
    }
  }

  private pendingReleasesRemain(): boolean {
    return this.core.locklessAuthority.listPendingPaneReleases().length > 0 ||
      this.core.locklessAuthority.listPendingWindowReleases().length > 0;
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
  ): Promise<"accepted" | "rejected" | "pending" | "unavailable"> {
    const payload: RegistrationPayload = {
      ...releaseOnlyPayload,
      pendingPaneReleases: kind === "pane" ? [release as PersistentPaneRetirement] : [],
      pendingWindowReleases: kind === "window" ? [release as PersistentWindowRetirement] : [],
    };
    try {
      const response = await this.sendRegistration(payload);
      if (response.ok) {
        const outcome = this.releaseOutcome(response, kind, release.releaseId);
        return outcome === "unknown" ? "pending" : outcome;
      }
      const retry = await this.sendRegistration(payload);
      if (retry.ok) {
        const outcome = this.releaseOutcome(retry, kind, release.releaseId);
        return outcome === "unknown" ? "pending" : outcome;
      }
      const baseline = await this.sendRegistration(releaseOnlyPayload);
      if (baseline.ok) return "rejected";
      return "unavailable";
    } catch {
      try {
        const baseline = await this.sendRegistration(releaseOnlyPayload);
        if (baseline.ok) return "pending";
      } catch {
        // Keep the release pending until a later attempt can isolate its outcome.
      }
      return "unavailable";
    }
  }

  private releaseOutcome(
    response: ControllerWireEnvelope,
    kind: "pane" | "window",
    releaseId: string,
  ): "accepted" | "rejected" | "unknown" {
    if (!isRecord(response.payload)) return "unknown";
    if (response.payload.registrationResultsV1 === true) {
      const results = kind === "pane" ? response.payload.paneReleaseResults : response.payload.windowReleaseResults;
      if (!Array.isArray(results) || results.length !== 1) return "unknown";
      const result = results[0];
      if (!isRecord(result) || result.index !== 0 || result.releaseId !== releaseId || typeof result.ok !== "boolean") {
        return "unknown";
      }
      return result.ok ? "accepted" : "rejected";
    }
    const completed = kind === "pane" ? response.payload.completedPaneReleaseIds : response.payload.completedWindowReleaseIds;
    return Array.isArray(completed) && completed.length === 1 && completed[0] === releaseId
      ? "accepted"
      : "unknown";
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
