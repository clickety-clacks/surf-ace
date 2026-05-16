type ProviderLineageEntry = {
  providerId: string;
};

type SelfOwnedSurfaceRecord = {
  providerId: string;
  relinquishedAt?: number;
  source?: string;
};

type TargetRecord = {
  currentState?: string;
  ownerProviderId?: string;
  ownershipSessionId?: string;
  targetId?: string;
};

type PaneTargetRecord = {
  currentTargetId?: string | null;
};

type TargetStateRecord = {
  paneTargets?: Record<string, PaneTargetRecord>;
  targetRecords?: TargetRecord[];
};

export type SurfAceOwnershipRecoveryState = {
  providerId: string;
  providerLineage?: ProviderLineageEntry[];
  selfOwnedSurfaceIds?: Record<string, SelfOwnedSurfaceRecord>;
  targetStateBySurfaceId?: Record<string, TargetStateRecord>;
};

export class SurfAceOwnershipRecoveryPolicy {
  isTrustedProviderLineageId(state: SurfAceOwnershipRecoveryState, providerId: string): boolean {
    if (!providerId) {
      return false;
    }
    return providerId === state.providerId ||
      (state.providerLineage ?? []).some((entry) => entry.providerId === providerId);
  }

  isKnownSelfOwnedSurface(
    state: SurfAceOwnershipRecoveryState,
    surfaceId: string,
    hasActiveResumeSession: boolean,
  ): boolean {
    if (hasActiveResumeSession) {
      return true;
    }
    const ownership = state.selfOwnedSurfaceIds?.[surfaceId];
    return Boolean(
      ownership &&
        !ownership.relinquishedAt &&
        ownership.source !== "current_target_state" &&
        this.isTrustedProviderLineageId(state, ownership.providerId),
    );
  }

  hasTrustedForeignLineageSelfOwnership(
    state: SurfAceOwnershipRecoveryState,
    surfaceId: string,
  ): boolean {
    const ownership = state.selfOwnedSurfaceIds?.[surfaceId];
    return Boolean(
      ownership &&
        !ownership.relinquishedAt &&
        ownership.providerId !== state.providerId &&
        this.isTrustedProviderLineageId(state, ownership.providerId),
    );
  }

  hasDurableDifferentProviderOwnership(
    state: SurfAceOwnershipRecoveryState,
    surfaceId: string,
  ): boolean {
    const ownership = state.selfOwnedSurfaceIds?.[surfaceId];
    if (
      ownership &&
      !ownership.relinquishedAt &&
      !this.isTrustedProviderLineageId(state, ownership.providerId)
    ) {
      return true;
    }

    const targetState = state.targetStateBySurfaceId?.[surfaceId];
    const currentTargetIds = new Set(
      Object.values(targetState?.paneTargets ?? {})
        .map((paneTarget) => paneTarget.currentTargetId)
        .filter((targetId): targetId is string => typeof targetId === "string" && targetId.length > 0),
    );
    if (currentTargetIds.size === 0) {
      return false;
    }
    const targetRecords = Array.isArray(targetState?.targetRecords) ? targetState.targetRecords : [];
    return targetRecords.some((target) =>
      typeof target.targetId === "string" &&
      currentTargetIds.has(target.targetId) &&
      target.currentState === "current" &&
      typeof target.ownerProviderId === "string" &&
      target.ownerProviderId.length > 0 &&
      !this.isTrustedProviderLineageId(state, target.ownerProviderId)
    );
  }

  durableSelfReclaimResumeSessionId(
    state: SurfAceOwnershipRecoveryState,
    surfaceId: string,
    activeSessionId: string | null,
  ): string | null {
    if (activeSessionId) {
      return activeSessionId;
    }
    const targetState = state.targetStateBySurfaceId?.[surfaceId];
    const ownership = state.selfOwnedSurfaceIds?.[surfaceId];
    if (!targetState || !ownership || ownership.relinquishedAt || ownership.source === "current_target_state") {
      return null;
    }
    const targetRecords = Array.isArray(targetState.targetRecords) ? targetState.targetRecords : [];
    for (const target of [...targetRecords].reverse()) {
      if (
        typeof target.ownershipSessionId === "string" &&
        target.ownershipSessionId.length > 0 &&
        this.isTrustedProviderLineageId(state, target.ownerProviderId ?? "")
      ) {
        return target.ownershipSessionId;
      }
    }
    return null;
  }
}
