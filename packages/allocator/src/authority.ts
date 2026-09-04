import { randomUUID } from "node:crypto";

import {
  AllocatorError,
  STATE_VERSION,
  type Assignment,
  type AuthorityBindPayload,
  type LabelClaimPayload,
  type LabelReconfirmPayload,
} from "./domain.js";
import {
  PersistenceOutcomeUnknownError,
  PostgresCustodyAdapter,
  type AcceptedState,
} from "./custody.js";

export class WindowLabelAuthority {
  private failClosedReason: string | null = null;
  private readonly claimTails = new Map<string, Promise<void>>();

  constructor(private readonly custody: PostgresCustodyAdapter<"writer">) {}

  async recoverPreparedTransactions(): Promise<void> {
    const state = await this.custody.readAcceptedState();
    for (const transaction of state.transactions) {
      if (transaction.status === "reserved") {
        await this.custody.commitMapping(transaction.transactionId);
      }
    }
  }

  async bind(payload: AuthorityBindPayload): Promise<{
    allocatorId: string;
    authorityId: string;
    bound: true;
    fleetId: string;
    ownerAnchorId: string;
    stateVersion: number;
  }> {
    const state = await this.accepted(payload.fleetId, payload.expectedAllocatorId);
    this.assertServing(state);
    try {
      await this.custody.bindAuthority(payload.authorityId, payload.ownerAnchorId);
    } catch (error) {
      this.observeFailure(error);
      if (error instanceof PersistenceOutcomeUnknownError) {
        await this.resolveUnknownBind(payload);
      } else {
        throw error;
      }
    }
    return {
      allocatorId: state.allocatorId,
      authorityId: payload.authorityId,
      bound: true,
      fleetId: state.fleetId,
      ownerAnchorId: payload.ownerAnchorId,
      stateVersion: STATE_VERSION,
    };
  }

  private async resolveUnknownBind(payload: AuthorityBindPayload): Promise<void> {
    let state: AcceptedState;
    try {
      await this.custody.validateLease();
      state = await this.custody.readAcceptedState();
    } catch (error) {
      const unknown = error instanceof PersistenceOutcomeUnknownError
        ? error
        : new PersistenceOutcomeUnknownError("query_binding", error);
      this.observeFailure(unknown);
      throw unknown;
    }
    const owner = state.authorityOwners.find((entry) => entry.authorityId === payload.authorityId);
    if (!owner) {
      this.failClosedReason = null;
      throw new AllocatorError("persistence_failed", "authority binding did not commit", state.allocatorId);
    }
    if (owner.ownerAnchorId !== payload.ownerAnchorId) {
      this.failClosedReason = null;
      throw new AllocatorError(
        "authority_ownership_conflict",
        "authority is durably bound to another owner anchor",
        state.allocatorId,
      );
    }
    this.failClosedReason = null;
  }

  async claim(payload: LabelClaimPayload): Promise<Assignment> {
    const key = `${payload.authorityId}\0${payload.surfaceId}`;
    const previous = this.claimTails.get(key) ?? Promise.resolve();
    const result = previous.then(
      async () => await this.claimNow(payload),
      async () => await this.claimNow(payload),
    );
    const tail = result.then(() => undefined, () => undefined);
    this.claimTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.claimTails.get(key) === tail) this.claimTails.delete(key);
    }
  }

  private async claimNow(payload: LabelClaimPayload): Promise<Assignment> {
    const state = await this.accepted(payload.fleetId, payload.expectedAllocatorId);
    this.assertServing(state);
    assertBound(state, payload.authorityId, payload.ownerAnchorId);
    const existing = findMapping(state, payload.authorityId, payload.surfaceId);
    if (existing) return assignmentFrom(state, existing);

    const transactionId = `tx_${randomUUID().replaceAll("-", "")}`;
    let reserved;
    try {
      reserved = await this.custody.reserve(
        transactionId,
        payload.authorityId,
        payload.ownerAnchorId,
        payload.surfaceId,
      );
    } catch (error) {
      this.observeFailure(error);
      if (error instanceof PersistenceOutcomeUnknownError) {
        return await this.resolveUnknownClaim(transactionId);
      }
      throw error;
    }
    if (reserved.status === "burned") {
      throw new AllocatorError("persistence_failed", "the allocation transaction is durably burned", state.allocatorId);
    }
    if (reserved.status === "committed") {
      const refreshed = await this.custody.readAcceptedState();
      const mapping = findMapping(refreshed, payload.authorityId, payload.surfaceId);
      if (!mapping) {
        this.failClosedReason = "committed transaction lacks its mapping";
        throw new AllocatorError("assignment_conflict", this.failClosedReason, state.allocatorId);
      }
      return assignmentFrom(refreshed, mapping);
    }

    try {
      const mapping = await this.custody.commitMapping(transactionId);
      return {
        ...mapping,
        allocatorId: state.allocatorId,
        committed: true,
        fleetId: state.fleetId,
        stateVersion: state.stateVersion,
      };
    } catch (error) {
      this.observeFailure(error);
      if (error instanceof PersistenceOutcomeUnknownError) {
        return await this.resolveUnknownClaim(transactionId);
      }
      if (error instanceof AllocatorError && error.code === "persistence_failed") {
        try {
          await this.custody.burn(transactionId);
        } catch (burnError) {
          const unknown = burnError instanceof PersistenceOutcomeUnknownError
            ? burnError
            : new PersistenceOutcomeUnknownError("burn_reservation", burnError);
          this.observeFailure(unknown);
          return await this.resolveUnknownClaim(transactionId);
        }
      }
      throw error;
    }
  }

  async resolveUnknownClaim(transactionId: string): Promise<Assignment> {
    while (true) {
      let transaction;
      try {
        transaction = await this.custody.queryTransaction(transactionId);
        await this.custody.validateLease();
      } catch (error) {
        const unknown = error instanceof PersistenceOutcomeUnknownError
          ? error
          : new PersistenceOutcomeUnknownError("query_transaction", error);
        this.observeFailure(unknown);
        throw unknown;
      }
      if (!transaction || transaction.status === "burned") {
        this.failClosedReason = null;
        throw new AllocatorError("persistence_failed", "allocation transaction did not commit");
      }
      if (transaction.status === "reserved") {
        try {
          await this.custody.commitMapping(transactionId);
        } catch (error) {
          this.observeFailure(error);
          if (error instanceof PersistenceOutcomeUnknownError) {
            continue;
          }
          if (error instanceof AllocatorError && error.code === "persistence_failed") {
            try {
              await this.custody.burn(transactionId);
              this.failClosedReason = null;
            } catch (burnError) {
              const unknown = burnError instanceof PersistenceOutcomeUnknownError
                ? burnError
                : new PersistenceOutcomeUnknownError("burn_reservation", burnError);
              this.observeFailure(unknown);
              continue;
            }
          }
          throw error;
        }
      }
      const state = await this.custody.readAcceptedState();
      const mapping = findMapping(state, transaction.authorityId, transaction.surfaceId);
      if (!mapping || mapping.ordinal !== transaction.ordinal) {
        this.failClosedReason = "transaction resolution contradicted the immutable assignment";
        throw new AllocatorError("assignment_conflict", this.failClosedReason, state.allocatorId);
      }
      this.failClosedReason = null;
      return assignmentFrom(state, mapping);
    }
  }

  async reconfirm(payload: LabelReconfirmPayload): Promise<Assignment & { confirmation: "confirmed" | "recovered" }> {
    const state = await this.accepted(payload.fleetId, payload.expectedAllocatorId);
    this.assertServing(state);
    assertBound(state, payload.authorityId, payload.ownerAnchorId);
    const mapping = findMapping(state, payload.authorityId, payload.surfaceId);
    if (
      !mapping
      || mapping.ordinal !== payload.expectedAssignment.ordinal
      || mapping.windowLabel !== payload.expectedAssignment.windowLabel
      || payload.expectedAssignment.committed !== true
    ) {
      this.failClosedReason = "client assignment contradicts accepted custody";
      throw new AllocatorError("assignment_conflict", this.failClosedReason, state.allocatorId);
    }
    return {
      ...assignmentFrom(state, mapping),
      confirmation: mapping.recoveredAtCustodyRevision === null ? "confirmed" : "recovered",
    };
  }

  get serveStatus(): string {
    return this.failClosedReason ? `fail-closed:${this.failClosedReason}` : "serving";
  }

  private async accepted(fleetId: string, expectedAllocatorId?: string): Promise<AcceptedState> {
    const state = await this.custody.readAcceptedState();
    if (fleetId !== state.fleetId) {
      throw new AllocatorError("fleet_identity_mismatch", "request fleet does not match this authority", state.allocatorId);
    }
    if (expectedAllocatorId !== undefined && expectedAllocatorId !== state.allocatorId) {
      throw new AllocatorError("allocator_identity_mismatch", "request allocator does not match this authority", state.allocatorId);
    }
    return state;
  }

  private assertServing(state: AcceptedState): void {
    if (this.failClosedReason) {
      throw new AllocatorError("allocator_state_corrupt", this.failClosedReason, state.allocatorId);
    }
    if (state.lifecycle === "destroyed") {
      throw new AllocatorError("fleet_destroyed", "fleet is permanently destroyed", state.allocatorId);
    }
  }

  private observeFailure(error: unknown): void {
    if (error instanceof PersistenceOutcomeUnknownError) {
      this.failClosedReason = `unknown-persistence:${error.operation}`;
    } else if (error instanceof AllocatorError
      && (error.code === "assignment_conflict" || error.code === "allocator_state_corrupt")) {
      this.failClosedReason = error.message;
    }
  }
}

function assertBound(state: AcceptedState, authorityId: string, ownerAnchorId: string): void {
  const owner = state.authorityOwners.find((entry) => entry.authorityId === authorityId);
  if (!owner || owner.ownerAnchorId !== ownerAnchorId) {
    throw new AllocatorError(
      "authority_ownership_conflict",
      "authority is not bound to the supplied owner anchor",
      state.allocatorId,
    );
  }
}

function findMapping(state: AcceptedState, authorityId: string, surfaceId: string) {
  return state.mappings.find((mapping) => mapping.authorityId === authorityId && mapping.surfaceId === surfaceId);
}

function assignmentFrom(
  state: AcceptedState,
  mapping: AcceptedState["mappings"][number],
): Assignment {
  return {
    allocatorId: state.allocatorId,
    authorityId: mapping.authorityId,
    committed: true,
    fleetId: state.fleetId,
    ordinal: mapping.ordinal,
    ownerAnchorId: mapping.ownerAnchorId,
    stateVersion: state.stateVersion,
    surfaceId: mapping.surfaceId,
    windowLabel: mapping.windowLabel,
  };
}
