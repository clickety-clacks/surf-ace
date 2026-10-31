import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket, { WebSocketServer, type RawData } from "ws";
import { parseAnnotationCursor } from "@surf-ace/protocol";

import { WindowLabelAuthority } from "./authority.js";
import { AnnotationJournal } from "./annotation-journal.js";
import {
  AllocatorError,
  allocatorSurfaceId,
  canonicalJson,
  type AllocatorErrorResponse,
  type AllocatorOperation,
  type AllocatorRequest,
  type AllocatorSuccessResponse,
  type AuthorityBindPayload,
  type LabelClaimPayload,
  type LabelReconfirmPayload,
} from "./domain.js";
import { PostgresCustodyAdapter, type AdapterTestHooks, type AnnotationInfo, type PaneRetirementEvidence, type PostgresCustodyConfig, type WindowRetirementEvidence } from "./custody.js";
import { parseAllocatorRequest } from "./validation.js";
import { EndpointLeaseBook, validateDirectEndpoint, type EndpointLease } from "./endpoint-leases.js";

const DEFAULT_MAX_ENDPOINT_LEASE_MS = 15_000;

type RegisteredClientProjection = {
  clientId: string;
  directEndpoint: string | null;
  endpointLease: EndpointLease | null;
  allocationGenerationV1: boolean;
  windowGenerationV1: boolean;
  prePairDescribeV1: boolean;
  registryIdentity: { allocatorId: string; fleetId: string };
  surfaces: Array<{
    surfaceId: string;
    windowLabel: string;
    windowGeneration: number;
    panes: Array<{ allocationGeneration?: number; paneId: string; paneLineageId: string; paneLabel: number; paneAddress: string }>;
  }>;
};

export type AllocatorServerConfig = {
  custody: PostgresCustodyConfig;
  hostLockPath: string;
  listenHost: string;
  listenPort: number;
  maxEndpointLeaseMs?: number;
};

export type AllocatorDiagnostics = {
  allocatorId: string;
  assignmentCount: number;
  burnedOrdinalCount: number;
  custodyRevision: number;
  fleetId: string;
  lastSuccessfulCommitTime: string | null;
  leaseBackendPid: number;
  leaseGeneration: number;
  leaseId: string;
  leaseMode: "writer";
  lifecycle: "active" | "destroyed";
  nextOrdinalFence: number;
  nextPaneOrdinalFence: number;
  nextPaneAllocationGenerationFence: number;
  paneLabelReuseEnabled: boolean;
  primaryHeadHash: string;
  primaryHeadSeq: number;
  serveStatus: string;
  registrationReady: boolean;
  stateVersion: number;
  uptimeMs: number;
  witnessHeadHash: string;
  witnessHeadSeq: number;
  witnessPhysicalSlot: string;
  witnessServerId: string;
};

type AnnotationLease = {
  consumerId: string;
  leaseId: string;
  socket: WebSocket | null;
  epoch: string;
  nextSequence: bigint;
  acknowledged: bigint;
  delivered: Array<{ sequence: bigint; bytes: number }>;
  gap: { gapId: string; throughCursor: { epoch: string; sequence: string } } | null;
  pumping: boolean;
  pumpRequested: boolean;
};

export class AllocatorServer {
  private readonly startedAt = Date.now();
  private readonly annotationRoles = new WeakMap<WebSocket, "publisher" | "consumer">();
  private readonly annotationLeases = new Map<string, AnnotationLease>();
  private readonly registeredClients = new Map<string, RegisteredClientProjection>();
  private registrationTail: Promise<unknown> = Promise.resolve();

  private async registerClient(payload: unknown): Promise<unknown> {
    const registrationResultsV1 = isRecord(payload) ? payload.registrationResultsV1 : undefined;
    if (registrationResultsV1 !== undefined && typeof registrationResultsV1 !== "boolean") {
      throw new Error("invalid_registration");
    }
    if (registrationResultsV1 === true) return await this.registerClientWithResults(payload);

    const value = payload as {
      clientId?: unknown;
      directEndpoint?: unknown;
      allocationGenerationV1?: unknown;
      windowGenerationV1?: unknown;
      prePairDescribeV1?: unknown;
      pendingPaneReleases?: unknown;
      pendingWindowReleases?: unknown;
      surfaces?: unknown;
    };
    if (!value || typeof value.clientId !== "string" || !/^[a-f0-9]{64}$/.test(value.clientId) ||
        !Array.isArray(value.surfaces)) throw new Error("invalid_registration");
    if (value.prePairDescribeV1 !== undefined && typeof value.prePairDescribeV1 !== "boolean") {
      throw new Error("invalid_registration");
    }
    if (value.allocationGenerationV1 !== undefined && typeof value.allocationGenerationV1 !== "boolean") {
      throw new Error("invalid_registration");
    }
    if (value.windowGenerationV1 !== undefined && typeof value.windowGenerationV1 !== "boolean") {
      throw new Error("invalid_registration");
    }
    const directEndpoint = validateDirectEndpoint(value.directEndpoint);
    const allocationGenerationV1 = value.allocationGenerationV1 === true;
    const windowGenerationV1 = value.windowGenerationV1 === true;
    const prePairDescribeV1 = value.prePairDescribeV1 === true;
    const clientId = value.clientId;
    const surfaces = value.surfaces as Array<{ surfaceId: string; windowGeneration?: number | null; panes: Array<{
      allocationGeneration?: number | null; paneId: string; paneLabel: number; paneLineageId: string;
    }> }>;
    const ids = new Set<string>();
    for (const surface of surfaces) {
      if (!surface || typeof surface.surfaceId !== "string" || !/^sf_[A-Za-z0-9._:-]{3,64}$/.test(surface.surfaceId) ||
          ids.has(surface.surfaceId) || !Array.isArray(surface.panes) ||
          (surface.windowGeneration !== undefined && surface.windowGeneration !== null &&
            (!Number.isSafeInteger(surface.windowGeneration) || surface.windowGeneration < 1))) throw new Error("invalid_surface");
      ids.add(surface.surfaceId);
      const paneIds = new Set<string>();
      for (const pane of surface.panes) {
        if (!pane || typeof pane.paneId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(pane.paneId) ||
            typeof pane.paneLineageId !== "string" || !/^pl_[A-Za-z0-9._:-]{3,128}$/.test(pane.paneLineageId) ||
            !Number.isSafeInteger(pane.paneLabel) || pane.paneLabel < 0 ||
            (pane.allocationGeneration !== undefined && pane.allocationGeneration !== null &&
              (!Number.isSafeInteger(pane.allocationGeneration) || pane.allocationGeneration < 1)) ||
            paneIds.has(pane.paneId)) throw new Error("invalid_pane");
        paneIds.add(pane.paneId);
      }
    }
    const pendingPaneReleases = value.pendingPaneReleases ?? [];
    if (!Array.isArray(pendingPaneReleases) || (!allocationGenerationV1 && pendingPaneReleases.length > 0)) {
      throw new Error("invalid_pane_release");
    }
    const pendingWindowReleases = value.pendingWindowReleases ?? [];
    if (!Array.isArray(pendingWindowReleases) || (!windowGenerationV1 && pendingWindowReleases.length > 0)) {
      throw new Error("invalid_window_release");
    }
    const state = await this.custody.readAcceptedState();
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const identity = {
      authorityId: "auth_" + hash(state.allocatorId),
      ownerAnchorId: "owner_" + hash(state.fleetId),
      fleetId: state.fleetId,
      expectedAllocatorId: state.allocatorId,
      protocolVersion: 1 as const,
    };
    await this.authority.bind(identity);
    const completedWindowReleaseIds: string[] = [];
    const windowReleaseIds = new Set<string>();
    for (const rawRelease of pendingWindowReleases) {
      if (!rawRelease || typeof rawRelease !== "object" || Array.isArray(rawRelease)) {
        throw new Error("invalid_window_release");
      }
      const release = rawRelease as Record<string, unknown>;
      if (typeof release.releaseId !== "string" || !/^[a-f0-9]{64}$/.test(release.releaseId) ||
          windowReleaseIds.has(release.releaseId) || release.clientId !== clientId ||
          typeof release.surfaceId !== "string" || !/^sf_[A-Za-z0-9._:-]{3,64}$/.test(release.surfaceId) ||
          typeof release.windowLabel !== "string" || !/^[a-z]+$/.test(release.windowLabel) ||
          !Number.isSafeInteger(release.windowGeneration) || Number(release.windowGeneration) < 1 ||
          release.tombstoneKind !== "surface" || typeof release.tombstoneId !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(release.tombstoneId) ||
          !Number.isSafeInteger(release.closeRevision) || Number(release.closeRevision) < 1 ||
          !Number.isSafeInteger(release.terminalRetirementRevision) || Number(release.terminalRetirementRevision) < 1) {
        throw new Error("invalid_window_release");
      }
      const evidence: WindowRetirementEvidence = {
        clientId,
        closeRevision: Number(release.closeRevision),
        surfaceId: release.surfaceId,
        terminalRetirementRevision: Number(release.terminalRetirementRevision),
        tombstoneId: release.tombstoneId,
        tombstoneKind: "surface",
        windowGeneration: Number(release.windowGeneration),
        windowLabel: release.windowLabel,
      };
      if (release.releaseId !== windowReleaseIntentId(evidence)) throw new Error("invalid_window_release");
      await this.custody.releaseWindowGeneration(evidence);
      windowReleaseIds.add(release.releaseId);
      completedWindowReleaseIds.push(release.releaseId);
    }
    const completedPaneReleaseIds = await this.processPaneReleases(clientId, pendingPaneReleases);
    const registered = [];
    for (const surface of surfaces) {
      const assignment = await this.authority.claim({
        ...identity, surfaceId: allocatorSurfaceId(clientId, surface.surfaceId),
      }, windowGenerationV1);
      if (surface.windowGeneration !== undefined && surface.windowGeneration !== null &&
          surface.windowGeneration !== assignment.windowGeneration) {
        throw new Error("stale_window_allocation_reference");
      }
      const panes = [];
      for (const pane of surface.panes) {
        if (allocationGenerationV1) {
          const allocated = await this.custody.claimPaneWithGeneration(
            clientId, surface.surfaceId, pane.paneId, pane.paneLineageId,
          );
          if ((pane.paneLabel > 0 && pane.paneLabel !== allocated.paneLabel) ||
              (pane.allocationGeneration !== undefined && pane.allocationGeneration !== null &&
                pane.allocationGeneration !== allocated.allocationGeneration)) {
            throw new Error("stale_pane_allocation_reference");
          }
          panes.push({ ...allocated, paneId: pane.paneId, paneLineageId: pane.paneLineageId,
            paneAddress: assignment.windowLabel + allocated.paneLabel });
        } else {
          const paneLabel = await this.custody.claimPane(clientId, surface.surfaceId, pane.paneId, pane.paneLineageId);
          if (pane.paneLabel > 0 && pane.paneLabel !== paneLabel) throw new Error("stale_pane_allocation_reference");
          panes.push({ paneId: pane.paneId, paneLineageId: pane.paneLineageId,
            paneLabel, paneAddress: assignment.windowLabel + paneLabel });
        }
      }
      registered.push({
        surfaceId: surface.surfaceId,
        windowLabel: assignment.windowLabel,
        windowGeneration: assignment.windowGeneration,
        panes,
      });
    }
    const surfaceIds = surfaces.map((surface) => surface.surfaceId).sort();
    const leaseSignature = JSON.stringify({
      allocatorId: state.allocatorId,
      clientId,
      directEndpoint,
      fleetId: state.fleetId,
      prePairDescribeV1,
      windowGenerationV1,
      surfaceIds,
    });
    if (directEndpoint !== null && prePairDescribeV1 &&
        (!this.custody.registrationReady || this.authority.serveStatus !== "serving")) {
      throw new AllocatorError("writer_fence_unavailable", "endpoint lease requires a validated serving writer");
    }
    const endpointLease = this.endpointLeases.renew(
      clientId,
      leaseSignature,
      directEndpoint !== null && prePairDescribeV1,
    );
    const result: RegisteredClientProjection = {
      clientId,
      directEndpoint,
      endpointLease,
      allocationGenerationV1,
      windowGenerationV1,
      prePairDescribeV1,
      registryIdentity: { allocatorId: state.allocatorId, fleetId: state.fleetId },
      surfaces: registered,
    };
    this.registeredClients.set(clientId, result);
    return { ...result, completedPaneReleaseIds, completedWindowReleaseIds };
  }

  private async registerClientWithResults(payload: unknown): Promise<unknown> {
    const value = payload as {
      clientId?: unknown;
      directEndpoint?: unknown;
      allocationGenerationV1?: unknown;
      windowGenerationV1?: unknown;
      prePairDescribeV1?: unknown;
      pendingPaneReleases?: unknown;
      pendingWindowReleases?: unknown;
      surfaces?: unknown;
    };
    if (!value || typeof value.clientId !== "string" || !/^[a-f0-9]{64}$/.test(value.clientId) ||
        !Array.isArray(value.surfaces)) throw new Error("invalid_registration");
    if (value.prePairDescribeV1 !== undefined && typeof value.prePairDescribeV1 !== "boolean") {
      throw new Error("invalid_registration");
    }
    if (value.allocationGenerationV1 !== undefined && typeof value.allocationGenerationV1 !== "boolean") {
      throw new Error("invalid_registration");
    }
    if (value.windowGenerationV1 !== undefined && typeof value.windowGenerationV1 !== "boolean") {
      throw new Error("invalid_registration");
    }
    const directEndpoint = validateDirectEndpoint(value.directEndpoint);
    const allocationGenerationV1 = value.allocationGenerationV1 === true;
    const windowGenerationV1 = value.windowGenerationV1 === true;
    const prePairDescribeV1 = value.prePairDescribeV1 === true;
    const clientId = value.clientId;
    const surfaces = value.surfaces as unknown[];
    const pendingPaneReleases = value.pendingPaneReleases ?? [];
    const pendingWindowReleases = value.pendingWindowReleases ?? [];
    if (!Array.isArray(pendingPaneReleases)) throw new Error("invalid_pane_release");
    if (!Array.isArray(pendingWindowReleases)) throw new Error("invalid_window_release");

    const surfaceIdCounts = new Map<string, number>();
    for (const surface of surfaces) {
      const surfaceId = isRecord(surface) && isValidSurfaceId(surface.surfaceId) ? surface.surfaceId : null;
      if (surfaceId) surfaceIdCounts.set(surfaceId, (surfaceIdCounts.get(surfaceId) ?? 0) + 1);
    }

    const state = await this.custody.readAcceptedState();
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const identity = {
      authorityId: "auth_" + hash(state.allocatorId),
      ownerAnchorId: "owner_" + hash(state.fleetId),
      fleetId: state.fleetId,
      expectedAllocatorId: state.allocatorId,
      protocolVersion: 1 as const,
    };
    await this.authority.bind(identity);

    const windowReleases = await this.processWindowReleasesWithResults(
      clientId, pendingWindowReleases as unknown[], windowGenerationV1,
    );
    const paneReleases = await this.processPaneReleasesWithResults(
      clientId, pendingPaneReleases as unknown[], allocationGenerationV1,
    );

    const registered: RegisteredClientProjection["surfaces"] = [];
    const surfaceResults: Array<Record<string, unknown>> = [];
    for (let surfaceIndex = 0; surfaceIndex < surfaces.length; surfaceIndex += 1) {
      const rawSurface = surfaces[surfaceIndex];
      const requestedSurfaceId = isRecord(rawSurface) && isValidSurfaceId(rawSurface.surfaceId)
        ? rawSurface.surfaceId
        : undefined;
      const base = {
        index: surfaceIndex,
        ...(requestedSurfaceId ? { surfaceId: requestedSurfaceId } : {}),
      };
      const validationError = registrationSurfaceError(
        rawSurface,
        requestedSurfaceId ? (surfaceIdCounts.get(requestedSurfaceId) ?? 0) > 1 : false,
      );
      if (validationError) {
        surfaceResults.push({ ...base, ok: false, error: registrationFailure(validationError) });
        continue;
      }

      const surface = rawSurface as {
        surfaceId: string;
        windowGeneration?: number | null;
        panes: unknown[];
      };
      let assignment;
      try {
        assignment = await this.authority.claim({
          ...identity, surfaceId: allocatorSurfaceId(clientId, surface.surfaceId),
        }, windowGenerationV1);
      } catch (error) {
        const refusal = knownRegistrationRefusal(error);
        if (!refusal) throw error;
        surfaceResults.push({ ...base, ok: false, error: refusal });
        continue;
      }
      if (surface.windowGeneration !== undefined && surface.windowGeneration !== null &&
          surface.windowGeneration !== assignment.windowGeneration) {
        surfaceResults.push({
          ...base, ok: false, error: registrationFailure("stale_window_allocation_reference"),
        });
        continue;
      }

      const paneIdCounts = new Map<string, number>();
      for (const pane of surface.panes) {
        const paneId = isRecord(pane) && isValidPaneId(pane.paneId) ? pane.paneId : null;
        if (paneId) paneIdCounts.set(paneId, (paneIdCounts.get(paneId) ?? 0) + 1);
      }
      const panes: RegisteredClientProjection["surfaces"][number]["panes"] = [];
      const paneResults: Array<Record<string, unknown>> = [];
      for (let paneIndex = 0; paneIndex < surface.panes.length; paneIndex += 1) {
        const rawPane = surface.panes[paneIndex];
        const requestedPaneId = isRecord(rawPane) && isValidPaneId(rawPane.paneId)
          ? rawPane.paneId
          : undefined;
        const requestedLineageId = isRecord(rawPane) && isValidPaneLineageId(rawPane.paneLineageId)
          ? rawPane.paneLineageId
          : undefined;
        const paneBase = {
          index: paneIndex,
          ...(requestedPaneId ? { paneId: requestedPaneId } : {}),
          ...(requestedLineageId ? { paneLineageId: requestedLineageId } : {}),
        };
        const paneValidationError = registrationPaneError(
          rawPane,
          requestedPaneId ? (paneIdCounts.get(requestedPaneId) ?? 0) > 1 : false,
        );
        if (paneValidationError) {
          paneResults.push({ ...paneBase, ok: false, error: registrationFailure(paneValidationError) });
          continue;
        }

        const pane = rawPane as {
          allocationGeneration?: number | null;
          paneId: string;
          paneLabel: number;
          paneLineageId: string;
        };
        try {
          if (allocationGenerationV1) {
            const allocated = await this.custody.claimPaneWithGeneration(
              clientId, surface.surfaceId, pane.paneId, pane.paneLineageId,
            );
            if ((pane.paneLabel > 0 && pane.paneLabel !== allocated.paneLabel) ||
                (pane.allocationGeneration !== undefined && pane.allocationGeneration !== null &&
                  pane.allocationGeneration !== allocated.allocationGeneration)) {
              paneResults.push({
                ...paneBase, ok: false, error: registrationFailure("stale_pane_allocation_reference"),
              });
              continue;
            }
            const projection = {
              ...allocated,
              paneId: pane.paneId,
              paneLineageId: pane.paneLineageId,
              paneAddress: assignment.windowLabel + allocated.paneLabel,
            };
            panes.push(projection);
            paneResults.push({ ...paneBase, ok: true, ...projection });
          } else {
            const paneLabel = await this.custody.claimPane(
              clientId, surface.surfaceId, pane.paneId, pane.paneLineageId,
            );
            if (pane.paneLabel > 0 && pane.paneLabel !== paneLabel) {
              paneResults.push({
                ...paneBase, ok: false, error: registrationFailure("stale_pane_allocation_reference"),
              });
              continue;
            }
            const projection = {
              paneId: pane.paneId,
              paneLineageId: pane.paneLineageId,
              paneLabel,
              paneAddress: assignment.windowLabel + paneLabel,
            };
            panes.push(projection);
            paneResults.push({ ...paneBase, ok: true, ...projection });
          }
        } catch (error) {
          const refusal = knownRegistrationRefusal(error);
          if (!refusal) throw error;
          paneResults.push({ ...paneBase, ok: false, error: refusal });
        }
      }

      const projection = {
        surfaceId: surface.surfaceId,
        windowLabel: assignment.windowLabel,
        windowGeneration: assignment.windowGeneration,
        panes,
      };
      registered.push(projection);
      surfaceResults.push({
        ...base,
        ok: true,
        windowLabel: assignment.windowLabel,
        windowGeneration: assignment.windowGeneration,
        paneResults,
      });
    }

    const surfaceIds = registered.map((surface) => surface.surfaceId).sort();
    const leaseSignature = JSON.stringify({
      allocatorId: state.allocatorId,
      clientId,
      directEndpoint,
      fleetId: state.fleetId,
      prePairDescribeV1,
      windowGenerationV1,
      surfaceIds,
    });
    if (directEndpoint !== null && prePairDescribeV1 &&
        (!this.custody.registrationReady || this.authority.serveStatus !== "serving")) {
      throw new AllocatorError("writer_fence_unavailable", "endpoint lease requires a validated serving writer");
    }
    const endpointLease = this.endpointLeases.renew(
      clientId,
      leaseSignature,
      directEndpoint !== null && prePairDescribeV1,
    );
    const result: RegisteredClientProjection = {
      clientId,
      directEndpoint,
      endpointLease,
      allocationGenerationV1,
      windowGenerationV1,
      prePairDescribeV1,
      registryIdentity: { allocatorId: state.allocatorId, fleetId: state.fleetId },
      surfaces: registered,
    };
    this.registeredClients.set(clientId, result);
    return {
      ...result,
      completedPaneReleaseIds: paneReleases.completedReleaseIds,
      completedWindowReleaseIds: windowReleases.completedReleaseIds,
      registrationResultsV1: true,
      paneReleaseResults: paneReleases.results,
      surfaceResults,
      windowReleaseResults: windowReleases.results,
    };
  }

  private async processPaneReleasesWithResults(
    clientId: string,
    pendingPaneReleases: unknown[],
    allocationGenerationV1: boolean,
  ): Promise<{ completedReleaseIds: string[]; results: Array<Record<string, unknown>> }> {
    const completedReleaseIds: string[] = [];
    const results: Array<Record<string, unknown>> = [];
    const releaseIdCounts = countReleaseIds(pendingPaneReleases);
    for (let index = 0; index < pendingPaneReleases.length; index += 1) {
      const rawRelease = pendingPaneReleases[index];
      const releaseId = isRecord(rawRelease) && isValidReleaseId(rawRelease.releaseId)
        ? rawRelease.releaseId
        : undefined;
      const base = { index, ...(releaseId ? { releaseId } : {}) };
      try {
        if (!allocationGenerationV1 || (releaseId && (releaseIdCounts.get(releaseId) ?? 0) > 1)) {
          throw new Error("invalid_pane_release");
        }
        const evidence = paneRetirementEvidence(rawRelease, clientId);
        if (evidence.releaseId !== paneReleaseIntentId(evidence)) throw new Error("invalid_pane_release");
        await this.custody.releasePaneGeneration(evidence);
        completedReleaseIds.push(evidence.releaseId);
        results.push({ ...base, ok: true });
      } catch (error) {
        const refusal = knownRegistrationRefusal(error);
        if (!refusal) throw error;
        results.push({ ...base, ok: false, error: refusal });
      }
    }
    return { completedReleaseIds, results };
  }

  private async processWindowReleasesWithResults(
    clientId: string,
    pendingWindowReleases: unknown[],
    windowGenerationV1: boolean,
  ): Promise<{ completedReleaseIds: string[]; results: Array<Record<string, unknown>> }> {
    const completedReleaseIds: string[] = [];
    const results: Array<Record<string, unknown>> = [];
    const releaseIdCounts = countReleaseIds(pendingWindowReleases);
    for (let index = 0; index < pendingWindowReleases.length; index += 1) {
      const rawRelease = pendingWindowReleases[index];
      const releaseId = isRecord(rawRelease) && isValidReleaseId(rawRelease.releaseId)
        ? rawRelease.releaseId
        : undefined;
      const base = { index, ...(releaseId ? { releaseId } : {}) };
      try {
        if (!windowGenerationV1 || (releaseId && (releaseIdCounts.get(releaseId) ?? 0) > 1)) {
          throw new Error("invalid_window_release");
        }
        const evidence = windowRetirementEvidence(rawRelease, clientId);
        if (evidence.releaseId !== windowReleaseIntentId(evidence)) throw new Error("invalid_window_release");
        await this.custody.releaseWindowGeneration(evidence);
        completedReleaseIds.push(evidence.releaseId);
        results.push({ ...base, ok: true });
      } catch (error) {
        const refusal = knownRegistrationRefusal(error);
        if (!refusal) throw error;
        results.push({ ...base, ok: false, error: refusal });
      }
    }
    return { completedReleaseIds, results };
  }

  private async processPaneReleases(clientId: string, pendingPaneReleases: unknown[]): Promise<string[]> {
    const completedPaneReleaseIds: string[] = [];
    const releaseIds = new Set<string>();
    for (const rawRelease of pendingPaneReleases) {
      if (!rawRelease || typeof rawRelease !== "object" || Array.isArray(rawRelease)) {
        throw new Error("invalid_pane_release");
      }
      const release = rawRelease as Record<string, unknown>;
      if (typeof release.releaseId !== "string" || !/^[a-f0-9]{64}$/.test(release.releaseId) ||
          releaseIds.has(release.releaseId) || release.clientId !== clientId ||
          typeof release.surfaceId !== "string" || typeof release.paneId !== "string" ||
          typeof release.lineageId !== "string" || !Number.isSafeInteger(release.paneLabel) ||
          Number(release.paneLabel) < 1 || !Number.isSafeInteger(release.allocationGeneration) ||
          Number(release.allocationGeneration) < 1 ||
          (release.tombstoneKind !== "pane" && release.tombstoneKind !== "surface") ||
          typeof release.tombstoneId !== "string" ||
          !Number.isSafeInteger(release.closeRevision) || Number(release.closeRevision) < 1 ||
          !Number.isSafeInteger(release.terminalRetirementRevision) || Number(release.terminalRetirementRevision) < 1) {
        throw new Error("invalid_pane_release");
      }
      const evidence: PaneRetirementEvidence = {
        allocationGeneration: Number(release.allocationGeneration),
        clientId,
        closeRevision: Number(release.closeRevision),
        lineageId: release.lineageId,
        paneId: release.paneId,
        paneLabel: Number(release.paneLabel),
        surfaceId: release.surfaceId,
        terminalRetirementRevision: Number(release.terminalRetirementRevision),
        tombstoneId: release.tombstoneId,
        tombstoneKind: release.tombstoneKind,
      };
      if (release.releaseId !== paneReleaseIntentId(evidence)) throw new Error("invalid_pane_release");
      await this.custody.releasePaneGeneration(evidence);
      releaseIds.add(release.releaseId);
      completedPaneReleaseIds.push(release.releaseId);
    }
    return completedPaneReleaseIds;
  }

  private async claimPane(payload: unknown): Promise<{ allocationGeneration?: number; paneLabel: number }> {
    const value = payload as { clientId?: unknown; surfaceId?: unknown; paneId?: unknown; paneLineageId?: unknown };
    if (!value || typeof value.clientId !== "string" || !/^[a-f0-9]{64}$/.test(value.clientId) ||
        typeof value.surfaceId !== "string" || !/^sf_[A-Za-z0-9._:-]{3,64}$/.test(value.surfaceId) ||
        typeof value.paneId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(value.paneId) ||
        typeof value.paneLineageId !== "string" || !/^pl_[A-Za-z0-9._:-]{3,128}$/.test(value.paneLineageId)) {
      throw new Error("invalid_pane_claim");
    }
    const registered = this.registeredClients.get(value.clientId);
    if (!registered?.surfaces.some((surface) => surface.surfaceId === value.surfaceId)) {
      throw new Error("surface_not_registered");
    }
    if (registered.allocationGenerationV1) {
      return await this.custody.claimPaneWithGeneration(
        value.clientId, value.surfaceId, value.paneId, value.paneLineageId,
      );
    }
    return { paneLabel: await this.custody.claimPane(value.clientId, value.surfaceId, value.paneId, value.paneLineageId) };
  }

  private async fleetTopology(): Promise<unknown> {
    const readiness = await this.authority.refreshReadinessSnapshot();
    const state = readiness.acceptedState ?? await this.custody.readAcceptedState();
    const registryServerTimeMs = this.endpointLeases.serverTimeMs();
    return {
      clients: [...this.registeredClients.values()],
      maxEndpointLeaseMs: this.endpointLeases.maxEndpointLeaseMs,
      registrationReady: readiness.ready,
      registryIdentity: {
        allocatorId: state.allocatorId,
        fleetId: state.fleetId,
      },
      registryServerTimeMs,
    };
  }

  private constructor(
    private readonly config: AllocatorServerConfig,
    private readonly hostLock: HostLock,
    private readonly custody: PostgresCustodyAdapter<"writer">,
    private readonly authority: WindowLabelAuthority,
    private readonly webSocketServer: WebSocketServer,
    private readonly annotationVerified: boolean,
    private readonly endpointLeases: EndpointLeaseBook,
  ) {}

  static async start(
    config: AllocatorServerConfig, testHooks: AdapterTestHooks = {}, retrySignal?: AbortSignal,
  ): Promise<AllocatorServer> {
    validateServerConfig(config);
    const { hostLock, custody } = await acquireStartupOwnership(config, testHooks, retrySignal);
    try {
      try {
        const authority = new WindowLabelAuthority(custody);
        // Retry only the unfinished stage: a busy port must not repeat completed
        // journal verification or invalidate annotation consumer leases again.
        await custody.finishStartup(() => authority.recoverPreparedTransactions(), retrySignal);
        await custody.finishStartup(() => custody.validateLease(), retrySignal);
        const annotationInstalled = await custody.finishStartup(async () => {
          try {
            await custody.annotationInfo();
            return true;
          } catch (error) {
            if ((error as { code?: string }).code !== "42883") throw error;
            return false;
          }
        }, retrySignal);
        const annotationVerified = !annotationInstalled || await custody.finishStartup(async () => {
          try {
            await custody.verifyAnnotationStartup();
            return true;
          } catch (error) {
            if (asAllocatorError(error).code !== "annotation_journal_unverified") throw error;
            return false;
          }
        }, retrySignal);
        const webSocketServer = await custody.finishStartup(async () => {
          const listener = new WebSocketServer({ host: config.listenHost, port: config.listenPort });
          try {
            await new Promise<void>((resolve, reject) => {
              listener.once("listening", resolve);
              listener.once("error", reject);
            });
            return listener;
          } catch (error) {
            await new Promise<void>((resolve) => listener.close(() => resolve()));
            throw error;
          }
        }, retrySignal);
        const server = new AllocatorServer(
          config,
          hostLock,
          custody,
          authority,
          webSocketServer,
          annotationVerified,
          new EndpointLeaseBook(
            custody.token.leaseGeneration,
            config.maxEndpointLeaseMs ?? DEFAULT_MAX_ENDPOINT_LEASE_MS,
          ),
        );
        webSocketServer.on("connection", (socket) => server.accept(socket));
        return server;
      } catch (error) {
        await custody.terminate();
        throw error;
      }
    } catch (error) {
      hostLock.release();
      throw error;
    }
  }

  get address(): { host: string; port: number; url: string } {
    const address = this.webSocketServer.address();
    if (!address || typeof address === "string") {
      throw new Error("allocator listener has no TCP address");
    }
    return {
      host: this.config.listenHost,
      port: address.port,
      url: `ws://${this.config.listenHost}:${address.port}`,
    };
  }

  get connectionLost(): Promise<void> {
    return this.custody.connectionLost;
  }

  async diagnostics(): Promise<AllocatorDiagnostics> {
    const [state, witness] = await Promise.all([
      this.custody.readAcceptedState(),
      this.custody.readWitness(),
    ]);
    return {
      allocatorId: state.allocatorId,
      assignmentCount: state.mappings.length,
      burnedOrdinalCount: state.transactions.filter((entry) => entry.status === "burned").length,
      custodyRevision: state.custodyRevision,
      fleetId: state.fleetId,
      lastSuccessfulCommitTime: state.lastCommitAt,
      leaseBackendPid: state.leaseBackendPid ?? -1,
      leaseGeneration: this.custody.token.leaseGeneration,
      leaseId: this.custody.token.leaseId,
      leaseMode: "writer",
      lifecycle: state.lifecycle,
      nextOrdinalFence: state.nextOrdinalFence,
      nextPaneOrdinalFence: state.nextPaneOrdinalFence,
      nextPaneAllocationGenerationFence: state.nextPaneAllocationGenerationFence,
      paneLabelReuseEnabled: state.paneLabelReuseEnabled,
      primaryHeadHash: state.headHash,
      primaryHeadSeq: state.headSeq,
      serveStatus: this.authority.serveStatus !== "serving"
        ? this.authority.serveStatus
        : this.custody.registrationReady ? "serving" : "writer-unvalidated",
      registrationReady: this.custody.registrationReady && this.authority.serveStatus === "serving",
      stateVersion: state.stateVersion,
      uptimeMs: Date.now() - this.startedAt,
      witnessHeadHash: witness.headHash,
      witnessHeadSeq: witness.headSeq,
      witnessPhysicalSlot: witness.receiverSlotName,
      witnessServerId: witness.witnessServerId,
    };
  }

  async close(): Promise<void> {
    for (const client of this.webSocketServer.clients) {
      if (this.custody.hasLostConnection) client.terminate();
      else client.close(1001, "allocator_shutdown");
    }
    await new Promise<void>((resolve, reject) => {
      this.webSocketServer.close((error) => error ? reject(error) : resolve());
    });
    await this.registrationTail;
    try {
      if (this.custody.hasLostConnection) await this.custody.terminate();
      else await this.custody.release();
    } finally {
      this.hostLock.release();
    }
  }

  private accept(socket: WebSocket): void {
    const replay = new Map<string, { fingerprint: string; response: string }>();
    let annotationTail: Promise<unknown> = Promise.resolve();
    socket.on("message", (data) => {
      // Annotation role and append order are connection state; process their
      // messages serially so hello cannot race an immediately following ingest.
      if (toText(data).includes('"annotation.')) {
        annotationTail = annotationTail.then(() => this.handle(socket, data, replay));
        void annotationTail.catch(() => socket.close(1011, "annotation_handler_failed"));
      } else {
        void this.handle(socket, data, replay);
      }
    });
    socket.on("close", () => {
      for (const lease of this.annotationLeases.values()) {
        if (lease.socket !== socket) continue;
        lease.socket = null;
        void this.custody.disconnectAnnotationConsumer(lease.consumerId, lease.leaseId)
          .catch(() => undefined);
      }
    });
  }

  private async handle(
    socket: WebSocket,
    data: RawData,
    replay: Map<string, { fingerprint: string; response: string }>,
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(toText(data));
    } catch {
      socket.close(1008, "invalid_json");
      return;
    }
    const registration = raw as { v?: unknown; type?: unknown; id?: unknown; op?: unknown; payload?: unknown };
    if (typeof registration?.op === "string" && registration.op.startsWith("annotation.")) {
      await this.handleAnnotation(socket, registration);
      return;
    }
    if (registration && (registration.op === "client.register" || registration.op === "pane.claim" || registration.op === "fleet.topology")) {
      const run = this.registrationTail.then(async () => {
        if (registration.v !== 1 || registration.type !== "request" || typeof registration.id !== "string" || !registration.id) {
          socket.close(1008, "invalid_envelope");
          return;
        }
        try {
          if (registration.op !== "fleet.topology"
              && (!this.custody.registrationReady || this.authority.serveStatus !== "serving")) {
            // The registration queue serializes recovery with claims, independent of discovery probes.
            await this.authority.refreshReadiness();
          }
          const payload = registration.op === "client.register"
            ? await this.registerClient(registration.payload)
            : registration.op === "pane.claim"
              ? await this.claimPane(registration.payload)
              : await this.fleetTopology();
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
            v: 1, type: "response", id: registration.id, op: registration.op, ok: true, payload, sentAt: Date.now(),
          }));
        } catch (error) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
            v: 1, type: "response", id: registration.id, op: registration.op, ok: false,
            error: { code: "registration_failed", message: error instanceof Error ? error.message : "registration_failed" },
            sentAt: Date.now(),
          }));
        }
      });
      this.registrationTail = run.catch(() => undefined);
      await run;
      return;
    }
    let request: AllocatorRequest;
    try {
      request = parseAllocatorRequest(raw);
    } catch (error) {
      const correlated = correlation(raw);
      if (!correlated) {
        socket.close(1008, "invalid_envelope");
        return;
      }
      socket.send(JSON.stringify(errorResponse(correlated.id, correlated.op, asAllocatorError(error))));
      return;
    }
    const fingerprint = canonicalJson({ op: request.op, payload: request.payload } as never);
    const cached = replay.get(request.id);
    if (cached) {
      if (cached.fingerprint === fingerprint) {
        socket.send(cached.response);
      } else {
        socket.send(JSON.stringify(errorResponse(
          request.id,
          request.op,
          new AllocatorError("invalid_request_id_reuse", "request id was reused with another payload"),
        )));
      }
      return;
    }

    let response: AllocatorSuccessResponse | AllocatorErrorResponse;
    try {
      const payload = request.op === "authority.bind"
        ? await this.authority.bind(request.payload as AuthorityBindPayload)
        : request.op === "label.claim"
          ? await this.authority.claim(request.payload as LabelClaimPayload)
          : await this.authority.reconfirm(request.payload as LabelReconfirmPayload);
      response = {
        id: request.id,
        ok: true,
        op: request.op,
        payload,
        sentAt: Date.now(),
        type: "response",
        v: 1,
      };
    } catch (error) {
      response = errorResponse(request.id, request.op, asAllocatorError(error));
    }
    const encoded = JSON.stringify(response);
    replay.set(request.id, { fingerprint, response: encoded });
    if (replay.size > 1024) replay.delete(replay.keys().next().value!);
    if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
  }

  private async handleAnnotation(socket: WebSocket, request: {
    v?: unknown; type?: unknown; id?: unknown; op?: unknown; payload?: unknown;
  }): Promise<void> {
    const op = String(request.op);
    if (request.v !== 1 || request.type !== "request" || typeof request.id !== "string" ||
        request.id.length === 0 || !Number.isSafeInteger((request as { sentAt?: unknown }).sentAt) ||
        Number((request as { sentAt?: unknown }).sentAt) < 0) {
      socket.close(1008, "invalid_envelope");
      return;
    }
    const reply = (ok: boolean, value: unknown): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ v: 1, type: "response", op, id: request.id,
        ok, sentAt: Date.now(), [ok ? "payload" : "error"]: value }));
    };
    try {
      if (!this.annotationVerified) {
        throw new AllocatorError("annotation_journal_unverified", "annotation continuity could not be verified");
      }
      if (op === "annotation.hello") {
        if (this.annotationRoles.has(socket)) throw new AllocatorError("annotation_invalid_request", "hello already completed");
        const payload = request.payload as Record<string, unknown>;
        if (!payload || Object.keys(payload).sort().join(",") !== "protocolVersion,role" ||
            payload.protocolVersion !== 1 || (payload.role !== "publisher" && payload.role !== "consumer")) {
          throw new AllocatorError("annotation_invalid_request", "invalid annotation hello");
        }
        let info;
        try { info = await this.custody.annotationInfo(); }
        catch (error) {
          if ((error as { code?: string }).code === "42883") {
            throw new AllocatorError("annotation_protocol_unsupported", "annotation migration is not installed");
          }
          throw error;
        }
        const state = await this.custody.readAcceptedState();
        this.annotationRoles.set(socket, payload.role);
        reply(true, {
          registryId: state.allocatorId,
          journalEpoch: info.epoch,
          availableFromCursor: info.firstRetainedSequence === null ? null : { epoch: info.epoch, sequence: info.firstRetainedSequence },
          headCursor: info.headSequence === "0" ? null : { epoch: info.epoch, sequence: info.headSequence },
          limits: annotationLimits(info),
          usage: { journalRecords: info.journalRecords, journalCanonicalBytes: info.journalCanonicalBytes,
            sourceMetadataRows: info.sourceMetadataRows, sourceMetadataBytes: info.sourceMetadataBytes,
            sourceReceiptRows: info.sourceReceiptRows, sourceReceiptBytes: info.sourceReceiptBytes,
            consumerSlots: info.consumerSlots, activeStreams: info.activeStreams },
        });
      } else if (op === "annotation.ingest" || op === "annotation.source_gap") {
        if (this.annotationRoles.get(socket) !== "publisher") {
          throw new AllocatorError("annotation_role_operation_invalid", "publisher hello is required");
        }
        const payload = request.payload as Record<string, unknown>;
        if (!payload || Object.keys(payload).length !== 1 || !("record" in payload)) {
          throw new AllocatorError("annotation_invalid_request", "expected one record");
        }
        const isGap = typeof payload.record === "object" && payload.record !== null &&
          "reason" in payload.record;
        if (isGap !== (op === "annotation.source_gap")) {
          throw new AllocatorError("annotation_invalid_request", "record kind and operation differ");
        }
        reply(true, await new AnnotationJournal(this.custody).ingest(payload.record));
        for (const lease of this.annotationLeases.values()) void this.pumpAnnotation(lease);
      } else if (op === "annotation.watch" || op === "annotation.resume") {
        if (this.annotationRoles.get(socket) !== "consumer") {
          throw new AllocatorError("annotation_role_operation_invalid", "consumer hello is required");
        }
        const payload = request.payload as Record<string, unknown>;
        const keys = Object.keys(payload ?? {}).sort().join(",");
        if ((op === "annotation.watch" && keys !== "consumerId" && keys !== "consumerId,fromCursor") ||
            (op === "annotation.resume" && keys !== "consumerId") ||
            typeof payload.consumerId !== "string" || Buffer.byteLength(payload.consumerId, "utf8") < 1 ||
            Buffer.byteLength(payload.consumerId, "utf8") > 128) {
          throw new AllocatorError("annotation_invalid_request", "invalid consumer request");
        }
        let from;
        if (payload.fromCursor !== undefined) {
          try { from = parseAnnotationCursor(payload.fromCursor); }
          catch { throw new AllocatorError("annotation_cursor_invalid", "invalid requested cursor"); }
        }
        const prior = this.annotationLeases.get(payload.consumerId);
        if (op === "annotation.resume" && prior?.socket?.readyState === WebSocket.OPEN) {
          this.emitAnnotation(prior.socket, "annotation.lease_replaced", { consumerId: payload.consumerId, leaseId: prior.leaseId });
          await new Promise<void>((resolve) => {
            prior.socket!.once("close", resolve);
            prior.socket!.close(1000, "lease_replaced");
            setTimeout(resolve, 1000);
          });
        }
        const opened = await this.custody.openAnnotationConsumer(payload.consumerId,
          op === "annotation.watch" ? "watch" : "resume", from);
        const next = opened.ackCursor
          ? BigInt(opened.ackCursor.sequence) + 1n
          : BigInt(opened.initialFromCursor.sequence);
        const lease: AnnotationLease = { consumerId: payload.consumerId, leaseId: opened.leaseId,
          socket, epoch: opened.ackCursor?.epoch ?? opened.initialFromCursor.epoch, nextSequence: next,
          acknowledged: opened.ackCursor ? BigInt(opened.ackCursor.sequence) : 0n,
          delivered: [], gap: null, pumping: false, pumpRequested: false };
        this.annotationLeases.set(payload.consumerId, lease);
        reply(true, { ...opened, limits: annotationLimits(await this.custody.annotationInfo()) });
        void this.pumpAnnotation(lease);
      } else if (op === "annotation.ack") {
        if (this.annotationRoles.get(socket) !== "consumer") {
          throw new AllocatorError("annotation_role_operation_invalid", "consumer hello is required");
        }
        const payload = request.payload as Record<string, unknown>;
        if (!payload || Object.keys(payload).sort().join(",") !== "consumerId,leaseId,throughCursor" ||
            typeof payload.consumerId !== "string" || typeof payload.leaseId !== "string") {
          throw new AllocatorError("annotation_invalid_request", "invalid acknowledgement");
        }
        let cursor;
        try { cursor = parseAnnotationCursor(payload.throughCursor); }
        catch { throw new AllocatorError("annotation_cursor_invalid", "invalid acknowledgement cursor"); }
        const lease = this.annotationLeases.get(payload.consumerId);
        if (!lease || lease.leaseId !== payload.leaseId) {
          throw new AllocatorError("annotation_consumer_lease_stale", "lease has been replaced");
        }
        if (lease.gap) throw new AllocatorError("annotation_gap_ack_required", "history gap requires explicit acknowledgement");
        const sequence = BigInt(cursor.sequence);
        if (cursor.epoch !== lease.epoch || sequence > lease.acknowledged &&
            !lease.delivered.some((item) => item.sequence === sequence)) {
          throw new AllocatorError("annotation_ack_not_delivered", "cursor was not delivered under this lease");
        }
        const acknowledged = await this.custody.ackAnnotationConsumer(payload.consumerId, payload.leaseId, cursor);
        lease.acknowledged = sequence;
        lease.delivered = lease.delivered.filter((item) => item.sequence > sequence);
        reply(true, { ackCursor: acknowledged });
        void this.pumpAnnotation(lease);
      } else if (op === "annotation.gap.ack") {
        if (this.annotationRoles.get(socket) !== "consumer") {
          throw new AllocatorError("annotation_role_operation_invalid", "consumer hello is required");
        }
        const payload = request.payload as Record<string, unknown>;
        if (!payload || Object.keys(payload).sort().join(",") !== "consumerId,gapId,leaseId" ||
            typeof payload.consumerId !== "string" || typeof payload.leaseId !== "string" ||
            typeof payload.gapId !== "string") {
          throw new AllocatorError("annotation_invalid_request", "invalid gap acknowledgement");
        }
        const lease = this.annotationLeases.get(payload.consumerId);
        if (!lease || lease.leaseId !== payload.leaseId) {
          throw new AllocatorError("annotation_consumer_lease_stale", "lease has been replaced");
        }
        if (!lease.gap || lease.gap.gapId !== payload.gapId) {
          throw new AllocatorError("annotation_gap_id_mismatch", "gap ID does not match current gap");
        }
        const through = lease.gap.throughCursor;
        const position = await this.custody.ackAnnotationGap(payload.consumerId, payload.leaseId, through);
        lease.epoch = through.epoch;
        lease.acknowledged = BigInt(through.sequence);
        lease.nextSequence = lease.acknowledged + 1n;
        lease.delivered = [];
        lease.gap = null;
        reply(true, { ackCursor: position, gapId: payload.gapId });
        void this.pumpAnnotation(lease);
      } else if (op === "annotation.consumer.retire") {
        if (this.annotationRoles.get(socket) !== "consumer") {
          throw new AllocatorError("annotation_role_operation_invalid", "consumer hello is required");
        }
        const payload = request.payload as Record<string, unknown>;
        if (!payload || Object.keys(payload).sort().join(",") !==
            "consumerId,discardUnacknowledged,expectedAckCursor" ||
            typeof payload.consumerId !== "string") {
          throw new AllocatorError("annotation_invalid_request", "invalid retirement request");
        }
        let expected = null;
        if (payload.expectedAckCursor !== null) {
          try { expected = parseAnnotationCursor(payload.expectedAckCursor, true); }
          catch { throw new AllocatorError("annotation_cursor_invalid", "invalid expected cursor"); }
        }
        const retired = await this.custody.retireAnnotationConsumer(
          payload.consumerId, expected, payload.discardUnacknowledged === true);
        reply(true, retired);
        const lease = this.annotationLeases.get(payload.consumerId);
        if (lease) {
          this.annotationLeases.delete(payload.consumerId);
          if (lease.socket?.readyState === WebSocket.OPEN) {
            this.emitAnnotation(lease.socket, "annotation.consumer_retired", retired);
            lease.socket.close(1000, "consumer_retired");
          }
        }
      } else {
        throw new AllocatorError("annotation_protocol_unsupported", "annotation operation is not implemented");
      }
    } catch (error) {
      const failure = error instanceof AllocatorError ? error : asAllocatorError(error);
      reply(false, { code: failure.code, message: failure.message,
        ...(failure.details ? { details: failure.details } : {}) });
    }
  }

  private emitAnnotation(socket: WebSocket, op: string, payload: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ v: 1, type: "event", op,
      eventId: randomBytes(16).toString("hex"), sentAt: Date.now(), payload }));
  }

  private async pumpAnnotation(lease: AnnotationLease): Promise<void> {
    lease.pumpRequested = true;
    if (lease.pumping) return;
    lease.pumping = true;
    try {
      while (lease.pumpRequested && lease.socket?.readyState === WebSocket.OPEN &&
             this.annotationLeases.get(lease.consumerId) === lease) {
        lease.pumpRequested = false;
        if (lease.gap) break;
        const info = await this.custody.annotationInfo();
        const floor = info.firstRetainedSequence === null ? BigInt(info.headSequence) + 1n
          : BigInt(info.firstRetainedSequence);
        if (lease.epoch !== info.epoch || lease.nextSequence < floor) {
          const gapId = randomBytes(16).toString("hex");
          const throughCursor = { epoch: info.epoch, sequence: (floor - 1n).toString() };
          lease.gap = { gapId, throughCursor };
          this.emitAnnotation(lease.socket, "annotation.history_gap", {
            gapId, requestedCursor: { epoch: lease.epoch, sequence: lease.nextSequence.toString() },
            availableFromCursor: info.firstRetainedSequence === null ? null :
              { epoch: info.epoch, sequence: info.firstRetainedSequence },
            throughCursor,
            headCursor: info.headSequence === "0" ? null : { epoch: info.epoch, sequence: info.headSequence },
            reason: lease.epoch === info.epoch ? "cursor_expired" : "epoch_changed",
          });
          break;
        }
        while (lease.delivered.length < 32 && lease.socket?.readyState === WebSocket.OPEN) {
          const bytesInFlight = lease.delivered.reduce((sum, item) => sum + item.bytes, 0);
          const records = await this.custody.readAnnotationRecords(lease.nextSequence.toString(), 1);
          const record = records[0];
          if (!record || record.epoch !== lease.epoch ||
              bytesInFlight + record.bytes > 67_108_864) break;
          this.emitAnnotation(lease.socket, "annotation.record", {
            serverCursor: { epoch: record.epoch, sequence: record.sequence },
            record: record.record, committedAt: record.committedAt,
          });
          const sequence = BigInt(record.sequence);
          lease.delivered.push({ sequence, bytes: record.bytes });
          lease.nextSequence = sequence + 1n;
        }
      }
    } catch {
      lease.socket?.close(1011, "annotation_delivery_failed");
    } finally {
      lease.pumping = false;
    }
  }
}

// A dead pg Client cannot reconnect. Restart the registry instance through its
// existing acquisition path so every in-memory lease belongs to the new writer.
export async function startRecoveringAllocatorServer(
  config: AllocatorServerConfig,
  lifecycle: { unavailable?: () => void; recovered?: () => void } = {},
  testHooks: AdapterTestHooks = {},
) {
  let server = await AllocatorServer.start(config, testHooks);
  const restartConfig = { ...config, listenPort: server.address.port };
  let stopped = false;
  let stop!: () => void;
  const stopping = new Promise<void>((resolve) => { stop = resolve; });
  const retryCancellation = new AbortController();
  let serverClose: Promise<void> | undefined;
  const closeServer = () => serverClose ??= server.close();
  const recovery = (async () => {
    while (!stopped) {
      await Promise.race([server.connectionLost, stopping]);
      if (stopped) return;
      lifecycle.unavailable?.();
      await closeServer();
      while (!stopped) {
        try {
          server = await AllocatorServer.start(restartConfig, testHooks, retryCancellation.signal);
          serverClose = undefined;
          break;
        } catch {
          try { await delay(2_000, undefined, { signal: retryCancellation.signal }); }
          catch (error) { if (!stopped) throw error; }
        }
      }
      if (!stopped) lifecycle.recovered?.();
    }
  })();
  // Keep unexpected shutdown failures observable through close(), without an
  // unhandled rejection while the foreground service is still running.
  void recovery.catch(() => lifecycle.unavailable?.());
  return {
    get server() { return server; },
    async close(): Promise<void> {
      stopped = true;
      stop();
      retryCancellation.abort();
      await recovery.finally(closeServer);
    },
  };
}

function paneReleaseIntentId(evidence: PaneRetirementEvidence): string {
  return createHash("sha256").update(JSON.stringify({
    allocationGeneration: evidence.allocationGeneration,
    clientId: evidence.clientId,
    closeRevision: evidence.closeRevision,
    lineageId: evidence.lineageId,
    paneId: evidence.paneId,
    paneLabel: evidence.paneLabel,
    surfaceId: evidence.surfaceId,
    terminalRetirementRevision: evidence.terminalRetirementRevision,
    tombstoneId: evidence.tombstoneId,
    tombstoneKind: evidence.tombstoneKind,
  })).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSurfaceId(value: unknown): value is string {
  return typeof value === "string" && /^sf_[A-Za-z0-9._:-]{3,64}$/.test(value);
}

function isValidPaneId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}

function isValidPaneLineageId(value: unknown): value is string {
  return typeof value === "string" && /^pl_[A-Za-z0-9._:-]{3,128}$/.test(value);
}

function isValidReleaseId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function registrationSurfaceError(value: unknown, duplicateSurfaceId: boolean): string | null {
  if (!isRecord(value) || !isValidSurfaceId(value.surfaceId) || duplicateSurfaceId ||
      !Array.isArray(value.panes) ||
      (value.windowGeneration !== undefined && value.windowGeneration !== null &&
        (!Number.isSafeInteger(value.windowGeneration) || Number(value.windowGeneration) < 1))) {
    return "invalid_surface";
  }
  return null;
}

function registrationPaneError(value: unknown, duplicatePaneId: boolean): string | null {
  if (!isRecord(value) || !isValidPaneId(value.paneId) ||
      !isValidPaneLineageId(value.paneLineageId) || !Number.isSafeInteger(value.paneLabel) ||
      Number(value.paneLabel) < 0 ||
      (value.allocationGeneration !== undefined && value.allocationGeneration !== null &&
        (!Number.isSafeInteger(value.allocationGeneration) || Number(value.allocationGeneration) < 1)) ||
      duplicatePaneId) {
    return "invalid_pane";
  }
  return null;
}

function registrationFailure(code: string): { code: string; message: string } {
  return { code, message: code };
}

function knownRegistrationRefusal(error: unknown): { code: string; message: string } | null {
  const inputRefusals = new Set([
    "invalid_surface",
    "invalid_pane",
    "invalid_pane_release",
    "invalid_window_release",
    "stale_pane_allocation_reference",
    "stale_window_allocation_reference",
  ]);
  if (error instanceof Error && inputRefusals.has(error.message)) {
    return registrationFailure(error.message);
  }

  if (error instanceof AllocatorError &&
      (error.code === "assignment_conflict" || error.code === "authority_ownership_conflict")) {
    const itemConflictMessages = [
      "allocation transaction was terminally retired",
      "window identity is retired or lacks its active mapping",
      "terminally retired pane identity cannot be claimed",
      "pane identity conflicts with allocator history",
      "pane lineage is bound to another pane ID",
      "pane release does not match the active allocation",
      "window release does not match the active allocation",
      "pane allocation is not in allocator history",
    ];
    if (itemConflictMessages.some((message) => error.message.includes(message))) {
      return { code: "assignment_conflict", message: "item conflicts with registry allocation history" };
    }
  }
  return null;
}

function countReleaseIds(values: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const releaseId = isRecord(value) && isValidReleaseId(value.releaseId) ? value.releaseId : null;
    if (releaseId) counts.set(releaseId, (counts.get(releaseId) ?? 0) + 1);
  }
  return counts;
}

function paneRetirementEvidence(
  value: unknown,
  clientId: string,
): PaneRetirementEvidence & { releaseId: string } {
  if (!isRecord(value) || !isValidReleaseId(value.releaseId) || value.clientId !== clientId ||
      typeof value.surfaceId !== "string" || typeof value.paneId !== "string" ||
      typeof value.lineageId !== "string" || !Number.isSafeInteger(value.paneLabel) ||
      Number(value.paneLabel) < 1 || !Number.isSafeInteger(value.allocationGeneration) ||
      Number(value.allocationGeneration) < 1 ||
      (value.tombstoneKind !== "pane" && value.tombstoneKind !== "surface") ||
      typeof value.tombstoneId !== "string" || !Number.isSafeInteger(value.closeRevision) ||
      Number(value.closeRevision) < 1 || !Number.isSafeInteger(value.terminalRetirementRevision) ||
      Number(value.terminalRetirementRevision) < 1) {
    throw new Error("invalid_pane_release");
  }
  return {
    allocationGeneration: Number(value.allocationGeneration),
    clientId,
    closeRevision: Number(value.closeRevision),
    lineageId: value.lineageId,
    paneId: value.paneId,
    paneLabel: Number(value.paneLabel),
    releaseId: value.releaseId,
    surfaceId: value.surfaceId,
    terminalRetirementRevision: Number(value.terminalRetirementRevision),
    tombstoneId: value.tombstoneId,
    tombstoneKind: value.tombstoneKind,
  };
}

function windowRetirementEvidence(
  value: unknown,
  clientId: string,
): WindowRetirementEvidence & { releaseId: string } {
  if (!isRecord(value) || !isValidReleaseId(value.releaseId) || value.clientId !== clientId ||
      !isValidSurfaceId(value.surfaceId) || typeof value.windowLabel !== "string" ||
      !/^[a-z]+$/.test(value.windowLabel) || !Number.isSafeInteger(value.windowGeneration) ||
      Number(value.windowGeneration) < 1 || value.tombstoneKind !== "surface" ||
      typeof value.tombstoneId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.tombstoneId) ||
      !Number.isSafeInteger(value.closeRevision) || Number(value.closeRevision) < 1 ||
      !Number.isSafeInteger(value.terminalRetirementRevision) ||
      Number(value.terminalRetirementRevision) < 1) {
    throw new Error("invalid_window_release");
  }
  return {
    clientId,
    closeRevision: Number(value.closeRevision),
    releaseId: value.releaseId,
    surfaceId: value.surfaceId,
    terminalRetirementRevision: Number(value.terminalRetirementRevision),
    tombstoneId: value.tombstoneId,
    tombstoneKind: "surface",
    windowGeneration: Number(value.windowGeneration),
    windowLabel: value.windowLabel,
  };
}

function windowReleaseIntentId(evidence: WindowRetirementEvidence): string {
  return createHash("sha256").update(JSON.stringify({
    clientId: evidence.clientId,
    closeRevision: evidence.closeRevision,
    surfaceId: evidence.surfaceId,
    terminalRetirementRevision: evidence.terminalRetirementRevision,
    tombstoneId: evidence.tombstoneId,
    tombstoneKind: evidence.tombstoneKind,
    windowGeneration: evidence.windowGeneration,
    windowLabel: evidence.windowLabel,
  })).digest("hex");
}

function annotationLimits(info: AnnotationInfo) {
  return {
  journalRecords: info.maxJournalRecords, journalAndSourceMetadataBytes: info.maxJournalAndMetadataBytes,
  sourceMetadataRows: info.maxSourceMetadataRows, consumerIds: 64, activeStreams: 32,
  inFlightRecordsPerConsumer: 32, inFlightCanonicalBytesPerConsumer: 67_108_864,
  maxRecordBytes: 16_777_216,
  replayPolicy: { targetAcknowledgedHistoryDays: 30, pressureCompaction: true,
    requireActualConsumerAcknowledgement: true },
  };
}

class HostLock {
  private released = false;
  private constructor(
    private readonly path: string,
    private readonly descriptor: number,
    private readonly nonce: string,
  ) {}

  static acquire(path: string): HostLock {
    const nonce = randomBytes(24).toString("base64url");
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const snapshot = deadHostLockSnapshot(path);
        if (snapshot) throw new StaleHostLockError(snapshot);
      }
      throw new AllocatorError("writer_fence_unavailable", `canonical host lock is unavailable: ${path}`, undefined, error);
    }
    try {
      writeSync(descriptor, `${process.pid}:${nonce}\n`);
      fsyncSync(descriptor);
      return new HostLock(path, descriptor, nonce);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  static reclaimStale(path: string, expected: HostLockSnapshot): HostLock {
    const current = deadHostLockSnapshot(path);
    if (!current || !sameHostLockSnapshot(current, expected)) {
      throw new AllocatorError("writer_fence_unavailable", `canonical host lock changed before stale-owner recovery: ${path}`);
    }
    try {
      unlinkSync(path);
    } catch (error) {
      throw new AllocatorError("writer_fence_unavailable", `canonical host lock could not be reclaimed: ${path}`, undefined, error);
    }
    try {
      return HostLock.acquire(path);
    } catch (error) {
      if (error instanceof StaleHostLockError) {
        throw new AllocatorError("writer_fence_unavailable", `canonical host lock changed during stale-owner recovery: ${path}`, undefined, error);
      }
      throw error;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.descriptor);
    const contents = readFileSync(this.path, "utf8");
    if (contents === `${process.pid}:${this.nonce}\n`) unlinkSync(this.path);
  }
}

type HostLockSnapshot = { contents: string; device: number; inode: number; pid: number };

class StaleHostLockError extends Error {
  constructor(readonly snapshot: HostLockSnapshot) {
    super("canonical host lock is owned by a process that is no longer present");
  }
}

function deadHostLockSnapshot(path: string): HostLockSnapshot | null {
  let before: ReturnType<typeof lstatSync>;
  let contents: string;
  try {
    before = lstatSync(path);
    if (!before.isFile()) return null;
    contents = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const match = /^([1-9][0-9]*):([A-Za-z0-9_-]{32})\n$/.exec(contents);
  const pid = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(pid)) return null;
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return null;
  }
  try {
    const after = lstatSync(path);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || readFileSync(path, "utf8") !== contents) {
      return null;
    }
  } catch {
    return null;
  }
  return { contents, device: before.dev, inode: before.ino, pid };
}

function sameHostLockSnapshot(left: HostLockSnapshot, right: HostLockSnapshot): boolean {
  return left.contents === right.contents && left.device === right.device && left.inode === right.inode && left.pid === right.pid;
}

async function acquireStartupOwnership(
  config: AllocatorServerConfig,
  testHooks: AdapterTestHooks,
  retrySignal?: AbortSignal,
): Promise<{ custody: PostgresCustodyAdapter<"writer">; hostLock: HostLock }> {
  try {
    const hostLock = HostLock.acquire(config.hostLockPath);
    try {
      const custody = await PostgresCustodyAdapter.acquireWriter(config.custody, testHooks, retrySignal);
      return { custody, hostLock };
    } catch (error) {
      hostLock.release();
      throw error;
    }
  } catch (error) {
    if (!(error instanceof StaleHostLockError)) throw error;
    const custody = await PostgresCustodyAdapter.acquireWriter(config.custody, testHooks, retrySignal);
    try {
      const hostLock = HostLock.reclaimStale(config.hostLockPath, error.snapshot);
      return { custody, hostLock };
    } catch (reclaimError) {
      await custody.terminate();
      throw reclaimError;
    }
  }
}

function errorResponse(id: string, op: AllocatorOperation, error: AllocatorError): AllocatorErrorResponse {
  return {
    error: {
      code: error.code,
      ...(error.allocatorId ? { details: { allocatorId: error.allocatorId } } : {}),
      message: error.message,
    },
    id,
    ok: false,
    op,
    sentAt: Date.now(),
    type: "response",
    v: 1,
  };
}

function correlation(value: unknown): { id: string; op: AllocatorOperation } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (record.op !== "authority.bind" && record.op !== "label.claim" && record.op !== "label.reconfirm") return null;
  return { id: record.id, op: record.op };
}

function asAllocatorError(error: unknown): AllocatorError {
  return error instanceof AllocatorError
    ? error
    : new AllocatorError("internal_error", "allocator request failed", undefined, error);
}

function toText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function validateServerConfig(config: AllocatorServerConfig): void {
  if (!config.listenHost || !Number.isInteger(config.listenPort) || config.listenPort < 0 || config.listenPort > 65535) {
    throw new TypeError("allocator listenHost and listenPort must be explicit and valid");
  }
  if (!config.hostLockPath) throw new TypeError("allocator hostLockPath is required");
  const leaseLimit = config.maxEndpointLeaseMs ?? DEFAULT_MAX_ENDPOINT_LEASE_MS;
  if (!Number.isSafeInteger(leaseLimit) || leaseLimit < 1) {
    throw new TypeError("maxEndpointLeaseMs must be a positive safe integer");
  }
}
