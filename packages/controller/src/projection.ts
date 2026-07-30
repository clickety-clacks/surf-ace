import type {
  ConsumableGap,
  ConsumableRecord,
  ConsumableRecordClass,
  ConsumableScopeSnapshot,
  LocklessConsumableAck,
  LocklessScopeId,
} from "@surf-ace/protocol";

import type { ControllerStateStore } from "./state-store.js";

export type AcknowledgementIntent = LocklessConsumableAck & {
  idempotencyKey: string;
};

type PersistedScopeProjection = {
  clientCursor: number;
  firstRetainedSequence: number;
  gap: ConsumableGap | null;
  lastRetainedSequence: number;
  projectedCursor: number;
  records: ConsumableRecord[];
  scopeId: LocklessScopeId;
  synchronized: boolean;
};

type PersistedProjectionState = {
  acknowledgementOutbox: AcknowledgementIntent[];
  scopes: Record<string, PersistedScopeProjection>;
  version: 1;
};

export type LocalConsumableRead = {
  acknowledgement: AcknowledgementIntent | null;
  cacheStatus: "current" | "unsynchronized";
  consumableLoss: ConsumableGap | null;
  gap: ConsumableGap | null;
  records: ConsumableRecord[];
  repairScheduled: boolean;
  scopeId: LocklessScopeId;
};

export type ControllerResumeState = {
  pendingAcks: LocklessConsumableAck[];
  scopes: Record<string, {
    cursor: number;
    gapGeneration: number;
  }>;
};

const EMPTY_STATE: PersistedProjectionState = {
  acknowledgementOutbox: [],
  scopes: {},
  version: 1,
};

function cloneState(state: PersistedProjectionState): PersistedProjectionState {
  return structuredClone(state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseState(value: unknown): PersistedProjectionState {
  if (value === null) {
    return cloneState(EMPTY_STATE);
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.scopes) ||
      !Array.isArray(value.acknowledgementOutbox)) {
    throw new Error("projection_desynchronized:persisted_state");
  }
  return structuredClone(value) as PersistedProjectionState;
}

function intentKey(ack: LocklessConsumableAck): string {
  return [
    ack.scopeId,
    ack.cursor,
    ack.gapGeneration ?? 0,
  ].join(":");
}

function recordBytes(records: readonly ConsumableRecord[]): number {
  return records.reduce((total, record) => total + record.bytes, 0);
}

const LATEST_WINS_RECORD_CLASSES = new Set<ConsumableRecordClass>([
  "scroll",
  "selection",
  "page",
  "playback",
  "navigation",
]);

function recordIsSuperseded(
  retained: ConsumableRecord,
  incoming: ConsumableRecord,
): boolean {
  const incomingFrameId =
    incoming.recordClass === "annotation_frame" &&
      incoming.payload &&
      typeof incoming.payload === "object" &&
      !Array.isArray(incoming.payload) &&
      typeof (incoming.payload as { flushId?: unknown }).flushId === "string"
      ? (incoming.payload as { flushId: string }).flushId
      : null;
  return (
    (
      LATEST_WINS_RECORD_CLASSES.has(incoming.recordClass) &&
      retained.recordClass === incoming.recordClass
    ) ||
    (
      incoming.recordClass === "annotation_frame" &&
      retained.recordClass === "annotation_frame" &&
      (
        retained.recordId === incoming.recordId ||
        retained.recordId === incomingFrameId
      )
    )
  );
}

export class BoundedControllerProjection {
  private mutation: Promise<void> = Promise.resolve();
  private state = cloneState(EMPTY_STATE);

  constructor(
    private readonly store: ControllerStateStore,
    readonly capacityBytes: number,
  ) {}

  async start(): Promise<void> {
    this.state = parseState(await this.store.load());
    this.assertWithinCapacity(this.state);
  }

  snapshot(): PersistedProjectionState {
    return cloneState(this.state);
  }

  async applySnapshot(snapshot: ConsumableScopeSnapshot): Promise<void> {
    await this.mutate((next) => {
      next.scopes[snapshot.scopeId] = {
        clientCursor: snapshot.cursor.cursor,
        firstRetainedSequence: snapshot.firstRetainedSequence,
        gap: structuredClone(snapshot.cursor.gap),
        lastRetainedSequence: snapshot.lastRetainedSequence,
        projectedCursor: Math.max(
          snapshot.cursor.cursor,
          next.scopes[snapshot.scopeId]?.projectedCursor ??
            snapshot.cursor.cursor,
        ),
        records: structuredClone(snapshot.records),
        scopeId: snapshot.scopeId,
        synchronized: true,
      };
      next.acknowledgementOutbox = next.acknowledgementOutbox.filter(
        (intent) => intent.scopeId !== snapshot.scopeId ||
          intent.cursor > snapshot.cursor.cursor,
      );
    });
  }

  async applyDelta(
    scopeId: LocklessScopeId,
    records: ConsumableRecord[],
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    await this.mutate((next) => {
      const scope = next.scopes[scopeId];
      if (!scope) {
        throw new Error(`projection_snapshot_required:${scopeId}`);
      }
      const ordered = [...records].sort((left, right) =>
        left.sequence - right.sequence
      );
      for (const record of ordered) {
        if (record.sequence <= scope.lastRetainedSequence) {
          const existing = scope.records.find(
            (candidate) => candidate.sequence === record.sequence,
          );
          if (existing?.recordId === record.recordId) {
            continue;
          }
          throw new Error(
            `projection_delta_conflict:${scopeId}:${record.sequence}`,
          );
        }
        if (record.sequence !== scope.lastRetainedSequence + 1) {
          throw new Error(`projection_delta_gap:${scopeId}:${record.sequence}`);
        }
        scope.records = scope.records.filter(
          (retained) => !recordIsSuperseded(retained, record),
        );
        scope.records.push(structuredClone(record));
        scope.lastRetainedSequence = record.sequence;
        scope.firstRetainedSequence =
          scope.records[0]?.sequence ?? record.sequence;
      }
    });
  }

  async applyGap(
    scopeId: LocklessScopeId,
    gap: ConsumableGap,
    firstRetainedSequence: number,
  ): Promise<void> {
    await this.mutate((next) => {
      const scope = next.scopes[scopeId];
      if (!scope) {
        throw new Error(`projection_snapshot_required:${scopeId}`);
      }
      scope.gap = structuredClone(gap);
      scope.firstRetainedSequence = firstRetainedSequence;
      scope.records = scope.records.filter(
        (record) => record.sequence >= firstRetainedSequence,
      );
      const postGapCursor = gap.lastLostSequence === null
        ? firstRetainedSequence
        : gap.lastLostSequence + 1;
      scope.clientCursor = Math.max(
        scope.clientCursor,
        postGapCursor,
      );
      scope.projectedCursor = Math.max(
        scope.projectedCursor,
        postGapCursor,
      );
    });
  }

  async readLocal(scopeId: LocklessScopeId): Promise<LocalConsumableRead> {
    return await this.mutate((next) => {
      const scope = next.scopes[scopeId];
      if (!scope) {
        return {
          acknowledgement: null,
          cacheStatus: "unsynchronized",
          consumableLoss: null,
          gap: null,
          records: [],
          repairScheduled: true,
          scopeId,
        } satisfies LocalConsumableRead;
      }
      const records = scope.records.filter(
        (record) => record.sequence >= scope.projectedCursor,
      );
      const cursor = records.at(-1)
        ? records.at(-1)!.sequence + 1
        : scope.projectedCursor;
      const gapGeneration = scope.gap?.generation;
      let acknowledgement: AcknowledgementIntent | null = null;
      if (cursor > scope.clientCursor || gapGeneration !== undefined) {
        acknowledgement = {
          cursor,
          gapGeneration,
          idempotencyKey: intentKey({ cursor, gapGeneration, scopeId }),
          scopeId,
        };
        next.acknowledgementOutbox = next.acknowledgementOutbox.filter(
          (intent) => intent.scopeId !== scopeId,
        );
        next.acknowledgementOutbox.push(acknowledgement);
      }
      scope.projectedCursor = cursor;
      return {
        acknowledgement: acknowledgement
          ? structuredClone(acknowledgement)
          : null,
        cacheStatus: scope.synchronized ? "current" : "unsynchronized",
        consumableLoss: structuredClone(scope.gap),
        gap: structuredClone(scope.gap),
        records: structuredClone(records),
        repairScheduled: !scope.synchronized,
        scopeId,
      };
    });
  }

  async markUnsynchronized(scopeIds?: readonly LocklessScopeId[]): Promise<void> {
    await this.mutate((next) => {
      const selected = scopeIds ? new Set(scopeIds) : null;
      for (const scope of Object.values(next.scopes)) {
        if (!selected || selected.has(scope.scopeId)) {
          scope.synchronized = false;
        }
      }
    });
  }

  scopeIds(): LocklessScopeId[] {
    return Object.values(this.state.scopes).map((scope) => scope.scopeId);
  }

  pendingAcknowledgements(): AcknowledgementIntent[] {
    return structuredClone(this.state.acknowledgementOutbox);
  }

  canRearmAlert(scopeId: LocklessScopeId): boolean {
    const scope = this.state.scopes[scopeId];
    return Boolean(
      scope?.synchronized &&
      scope.gap === null &&
      !scope.records.some(
        (record) => record.sequence >= scope.projectedCursor,
      ) &&
      !this.state.acknowledgementOutbox.some(
        (intent) => intent.scopeId === scopeId,
      ),
    );
  }

  resumeState(): ControllerResumeState {
    return {
      pendingAcks: this.state.acknowledgementOutbox.map((intent) => ({
        cursor: intent.cursor,
        gapGeneration: intent.gapGeneration,
        scopeId: intent.scopeId,
      })),
      scopes: Object.fromEntries(
        Object.values(this.state.scopes).map((scope) => [
          scope.scopeId,
          {
            cursor: scope.clientCursor,
            gapGeneration: scope.gap?.generation ?? 0,
          },
        ]),
      ),
    };
  }

  async confirmAcknowledgement(idempotencyKey: string): Promise<void> {
    await this.mutate((next) => {
      const intent = next.acknowledgementOutbox.find(
        (candidate) => candidate.idempotencyKey === idempotencyKey,
      );
      if (!intent) {
        return;
      }
      const scope = next.scopes[intent.scopeId];
      if (scope) {
        scope.clientCursor = Math.max(scope.clientCursor, intent.cursor);
        if (
          intent.gapGeneration !== undefined &&
          scope.gap?.generation === intent.gapGeneration
        ) {
          scope.gap = null;
        }
        scope.records = scope.records.filter(
          (record) => record.sequence >= scope.clientCursor,
        );
        scope.firstRetainedSequence =
          scope.records[0]?.sequence ?? scope.clientCursor;
      }
      next.acknowledgementOutbox = next.acknowledgementOutbox.filter(
        (candidate) => candidate.idempotencyKey !== idempotencyKey,
      );
    });
  }

  private async mutate<TResult>(
    mutation: (next: PersistedProjectionState) => TResult,
  ): Promise<TResult> {
    let result!: TResult;
    const operation = this.mutation.then(async () => {
      const next = cloneState(this.state);
      result = mutation(next);
      this.assertWithinCapacity(next);
      await this.store.save(next);
      this.state = next;
    });
    this.mutation = operation.catch(() => {});
    await operation;
    return result;
  }

  private assertWithinCapacity(state: PersistedProjectionState): void {
    const total = Buffer.byteLength(JSON.stringify(state));
    if (total > this.capacityBytes) {
      throw new Error(
        `projection_capacity:${total}:${this.capacityBytes}`,
      );
    }
  }
}
