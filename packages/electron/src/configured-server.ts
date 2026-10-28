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
  endpointLease: PersistentRegistryEndpointLease | null;
  partial: boolean;
  refusedPanes: RegistrationRefusal[];
  refusedSurfaces: RegistrationRefusal[];
  surfaces: Array<{
    surfaceId: string;
    windowLabel: string;
    windowGeneration: number | null;
    panes: Array<{ allocationGeneration: number; paneId: string; paneLineageId: string; paneLabel: number }>;
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
    const result = response.payload as { clientId?: unknown; registrationResultsV1?: unknown; surfaces?: unknown };
    if (result.clientId !== this.clientId) throw new Error("invalid_registration_response");
    if (result.registrationResultsV1 === true) return response;
    const expected = new Set(payload.surfaces.map((surface) => surface.surfaceId));
    if (!Array.isArray(result.surfaces) ||
        result.surfaces.length !== expected.size ||
        result.surfaces.some((surface) => !surface || typeof surface !== "object" ||
          !expected.delete((surface as { surfaceId?: string }).surfaceId ?? "")) || expected.size !== 0) {
      throw new Error("invalid_registration_response");
    }
    return response;
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
    const responseIdentity = parseRegistryIdentity(response.payload);
    if (!sameRegistry(responseIdentity, identity)) throw new Error("foreign_registry_identity");
    if (!isRecord(response.payload)) throw new Error("invalid_registration_response");
    const responsePayload = response.payload;
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
    if (responsePayload.clientId !== this.clientId ||
        (responsePayload.windowGenerationV1 !== undefined && typeof responsePayload.windowGenerationV1 !== "boolean") ||
        (responsePayload.registrationResultsV1 !== undefined &&
          typeof responsePayload.registrationResultsV1 !== "boolean")) {
      throw new Error("invalid_registration_response");
    }
    const windowGenerationV1 = responsePayload.windowGenerationV1 === true;
    if (!Array.isArray(responsePayload.completedPaneReleaseIds) ||
        responsePayload.completedPaneReleaseIds.length !== 0 ||
        (responsePayload.completedWindowReleaseIds !== undefined &&
          (!Array.isArray(responsePayload.completedWindowReleaseIds) || responsePayload.completedWindowReleaseIds.length !== 0)) ||
        (windowGenerationV1 && !Array.isArray(responsePayload.completedWindowReleaseIds))) {
      throw new Error("invalid_registration_response");
    }

    const requestedBySurfaceId = new Map(registrationPayload.surfaces.map((surface) => [surface.surfaceId, surface]));
    if (requestedBySurfaceId.size !== registrationPayload.surfaces.length) {
      throw new Error("invalid_registration_response");
    }

    if (responsePayload.registrationResultsV1 === true) {
      const rawResults = responsePayload.surfaceResults;
      if (!Array.isArray(rawResults) || rawResults.length !== registrationPayload.surfaces.length ||
          !Array.isArray(responsePayload.surfaces)) {
        throw new Error("invalid_registration_response");
      }
      const surfaces: ParsedRegistrationResponse["surfaces"] = [];
      const refusedSurfaces: RegistrationRefusal[] = [];
      const refusedPanes: RegistrationRefusal[] = [];
      for (let index = 0; index < registrationPayload.surfaces.length; index += 1) {
        const requested = registrationPayload.surfaces[index]!;
        const result = rawResults[index];
        if (!isRecord(result) || result.index !== index || result.surfaceId !== requested.surfaceId ||
            typeof result.ok !== "boolean") {
          throw new Error("invalid_registration_response");
        }
        if (!result.ok) {
          refusedSurfaces.push({ surfaceId: requested.surfaceId, errorCode: refusalCode(result) });
          continue;
        }
        if (typeof result.windowLabel !== "string" || !/^[a-z]+$/.test(result.windowLabel) ||
            (windowGenerationV1 && (!Number.isSafeInteger(result.windowGeneration) || Number(result.windowGeneration) < 1))) {
          throw new Error("invalid_registration_response");
        }
        if (!Array.isArray(result.paneResults) || result.paneResults.length !== requested.panes.length) {
          throw new Error("invalid_registration_response");
        }
        const panes: ParsedRegistrationResponse["surfaces"][number]["panes"] = [];
        for (let paneIndex = 0; paneIndex < requested.panes.length; paneIndex += 1) {
          const requestedPane = requested.panes[paneIndex]!;
          const paneResult = result.paneResults[paneIndex];
          if (!isRecord(paneResult) || paneResult.index !== paneIndex ||
              paneResult.paneId !== requestedPane.paneId ||
              paneResult.paneLineageId !== requestedPane.paneLineageId ||
              typeof paneResult.ok !== "boolean") {
            throw new Error("invalid_registration_response");
          }
          if (!paneResult.ok) {
            refusedPanes.push({
              surfaceId: requested.surfaceId,
              paneId: requestedPane.paneId,
              paneLineageId: requestedPane.paneLineageId,
              errorCode: refusalCode(paneResult),
            });
            continue;
          }
          if (paneResult.paneId !== requestedPane.paneId ||
              paneResult.paneLineageId !== requestedPane.paneLineageId ||
              !Number.isSafeInteger(paneResult.paneLabel) || Number(paneResult.paneLabel) < 1 ||
              !Number.isSafeInteger(paneResult.allocationGeneration) || Number(paneResult.allocationGeneration) < 1) {
            throw new Error("invalid_registration_response");
          }
          panes.push({
            allocationGeneration: Number(paneResult.allocationGeneration),
            paneId: requestedPane.paneId,
            paneLineageId: requestedPane.paneLineageId,
            paneLabel: Number(paneResult.paneLabel),
          });
        }
        surfaces.push({
          surfaceId: requested.surfaceId,
          windowLabel: result.windowLabel,
          windowGeneration: windowGenerationV1 ? Number(result.windowGeneration) : null,
          panes,
        });
      }
      this.validateRegistrationProjection(responsePayload.surfaces, surfaces, windowGenerationV1);
      return {
        endpointLease,
        partial: true,
        refusedPanes,
        refusedSurfaces,
        surfaces,
        windowGenerationV1,
      };
    }

    const rawSurfaces = responsePayload.surfaces;
    if (!Array.isArray(rawSurfaces) || rawSurfaces.length !== requestedBySurfaceId.size) {
      throw new Error("invalid_registration_response");
    }
    const expectedSurfaceIds = new Set(requestedBySurfaceId.keys());
    const surfaces: ParsedRegistrationResponse["surfaces"] = [];
    for (const rawSurface of rawSurfaces) {
      if (!isRecord(rawSurface) || typeof rawSurface.surfaceId !== "string" ||
          !expectedSurfaceIds.delete(rawSurface.surfaceId) || typeof rawSurface.windowLabel !== "string" ||
          !/^[a-z]+$/.test(rawSurface.windowLabel) || !Array.isArray(rawSurface.panes)) {
        throw new Error("invalid_registration_response");
      }
      const requested = requestedBySurfaceId.get(rawSurface.surfaceId)!;
      if (rawSurface.panes.length !== requested.panes.length ||
          (windowGenerationV1 && (!Number.isSafeInteger(rawSurface.windowGeneration) || Number(rawSurface.windowGeneration) < 1))) {
        throw new Error("invalid_registration_response");
      }
      const requestedPanes = new Map(requested.panes.map((pane) => [pane.paneId, pane]));
      const panes: ParsedRegistrationResponse["surfaces"][number]["panes"] = [];
      for (const rawPane of rawSurface.panes) {
        if (!isRecord(rawPane) || typeof rawPane.paneId !== "string" ||
            typeof rawPane.paneLineageId !== "string" || !Number.isSafeInteger(rawPane.paneLabel) ||
            Number(rawPane.paneLabel) < 1 || !Number.isSafeInteger(rawPane.allocationGeneration) ||
            Number(rawPane.allocationGeneration) < 1) {
          throw new Error("invalid_registration_response");
        }
        const requestedPane = requestedPanes.get(rawPane.paneId);
        if (!requestedPane || requestedPane.paneLineageId !== rawPane.paneLineageId) {
          throw new Error("invalid_registration_response");
        }
        requestedPanes.delete(rawPane.paneId);
        panes.push({
          allocationGeneration: Number(rawPane.allocationGeneration),
          paneId: rawPane.paneId,
          paneLineageId: rawPane.paneLineageId,
          paneLabel: Number(rawPane.paneLabel),
        });
      }
      if (requestedPanes.size !== 0) throw new Error("invalid_registration_response");
      surfaces.push({
        surfaceId: rawSurface.surfaceId,
        windowLabel: rawSurface.windowLabel,
        windowGeneration: windowGenerationV1 ? Number(rawSurface.windowGeneration) : null,
        panes,
      });
    }
    if (expectedSurfaceIds.size !== 0) throw new Error("invalid_registration_response");
    return {
      endpointLease,
      partial: false,
      refusedPanes: [],
      refusedSurfaces: [],
      surfaces,
      windowGenerationV1,
    };
  }

  private validateRegistrationProjection(
    value: unknown,
    results: ParsedRegistrationResponse["surfaces"],
    windowGenerationV1: boolean,
  ): void {
    if (!Array.isArray(value)) throw new Error("invalid_registration_response");
    const expected = new Map(results.map((surface) => [surface.surfaceId, surface]));
    if (expected.size !== results.length || value.length !== results.length) {
      throw new Error("invalid_registration_response");
    }
    for (const projection of value) {
      if (!isRecord(projection) || typeof projection.surfaceId !== "string" ||
          !Array.isArray(projection.panes)) throw new Error("invalid_registration_response");
      const result = expected.get(projection.surfaceId);
      if (!result || expected.delete(projection.surfaceId) === false ||
          projection.windowLabel !== result.windowLabel ||
          (windowGenerationV1 && projection.windowGeneration !== result.windowGeneration) ||
          projection.panes.length !== result.panes.length) {
        throw new Error("invalid_registration_response");
      }
      const panes = new Map(result.panes.map((pane) => [pane.paneId, pane]));
      for (const pane of projection.panes) {
        if (!isRecord(pane) || typeof pane.paneId !== "string" || typeof pane.paneLineageId !== "string" ||
            !Number.isSafeInteger(pane.paneLabel) || !Number.isSafeInteger(pane.allocationGeneration)) {
          throw new Error("invalid_registration_response");
        }
        const expectedPane = panes.get(pane.paneId);
        if (!expectedPane || panes.delete(pane.paneId) === false ||
            pane.paneLineageId !== expectedPane.paneLineageId ||
            pane.paneLabel !== expectedPane.paneLabel ||
            pane.allocationGeneration !== expectedPane.allocationGeneration) {
          throw new Error("invalid_registration_response");
        }
      }
      if (panes.size !== 0) throw new Error("invalid_registration_response");
    }
    if (expected.size !== 0) throw new Error("invalid_registration_response");
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
      panes: Array<{ allocationGeneration: number; paneId: string; paneLineageId: string; paneLabel: number }>;
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
            pane.allocationGeneration !== null && pane.paneLabel > 0);
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
