type ProviderLineageEntry = {
  providerId: string;
};

type SelfOwnedSurfaceRecord = {
  providerId: string;
  relinquishedAt?: number;
  source?: string;
};

type TargetRecord = {
  ownerProviderId?: string;
  ownershipSessionId?: string;
};

type TargetStateRecord = {
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
