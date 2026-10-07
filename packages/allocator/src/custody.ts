import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg, { type Client as PgClient, type QueryResultRow } from "pg";

import {
  AllocatorError,
  ordinalToWindowLabel,
  STATE_VERSION,
  type Assignment,
  type LeaseMode,
  type LeaseToken,
} from "./domain.js";

const { Client } = pg;

export type PostgresCustodyConfig = {
  expectedClusterSystemId: string;
  fleetId: string;
  primaryUrl: string;
  recoveryUrl: string;
  witnessApplicationName: "surf_ace_witness";
  witnessPhysicalSlot: string;
  witnessServerId: string;
  witnessUrl: string;
};

export type HeadWitness = {
  allocatorId: string;
  clusterSystemId: string;
  custodyRevision: number;
  fleetId: string;
  headHash: string;
  headSeq: number;
  receiverSlotName: string;
  replayLsn: string;
  senderHost: string;
  senderPort: number;
  timelineId: number;
  witnessServerId: string;
};

export type AnnotationInfo = {
  epoch: string;
  headSequence: string;
  firstRetainedSequence: string | null;
  maxJournalRecords: number;
  maxJournalAndMetadataBytes: number;
  maxSourceMetadataRows: number;
  journalRecords: number;
  journalCanonicalBytes: number;
  sourceMetadataRows: number;
  sourceMetadataBytes: number;
  consumerSlots: number;
  activeStreams: number;
};

export type AnnotationConsumerOpen = {
  consumerId: string;
  leaseId: string;
  ackCursor: { epoch: string; sequence: string } | null;
  initialFromCursor: { epoch: string; sequence: string };
  availableFromCursor: { epoch: string; sequence: string } | null;
  headCursor: { epoch: string; sequence: string } | null;
  historyCompleteSinceStart: boolean;
};

export type AnnotationRetirement = {
  consumerId: string;
  retired: true;
  expectedAckCursor: { epoch: string; sequence: string } | null;
  discardedFromCursor: { epoch: string; sequence: string } | null;
  discardedThroughCursor: { epoch: string; sequence: string } | null;
};

export type AcceptedState = {
  acceptedGenerationId: string;
  allocatorId: string;
  authorityOwners: Array<{ authorityId: string; ownerAnchorId: string }>;
  custodyRevision: number;
  fleetId: string;
  headHash: string;
  headSeq: number;
  lastCommitAt: string | null;
  leaseBackendPid: number | null;
  leaseGeneration: number;
  leaseId: string | null;
  leaseMode: LeaseMode | null;
  lifecycle: "active" | "destroyed";
  mappings: Array<{
    authorityId: string;
    ordinal: number;
    ownerAnchorId: string;
    recoveredAtCustodyRevision: number | null;
    surfaceId: string;
    windowLabel: string;
  }>;
  nextOrdinalFence: number;
  nextPaneOrdinalFence: number;
  paneMappings: Array<{ clientId: string; surfaceId: string; paneId: string; lineageId: string; paneLabel: number }>;
  stateVersion: number;
  transactions: Array<{
    authorityId: string;
    ordinal: number;
    ownerAnchorId: string;
    status: "burned" | "committed" | "reserved";
    surfaceId: string;
    transactionId: string;
  }>;
};

export type TransactionRecord = {
  allocatorId: string;
  authorityId: string;
  fleetId: string;
  ordinal: number;
  ownerAnchorId: string;
  status: "burned" | "committed" | "reserved";
  surfaceId: string;
  transactionId: string;
  windowLabel: string | null;
};

export type ReserveResult = {
  ordinal: number;
  status: "burned" | "committed" | "reserved";
  windowLabel: string | null;
};

export type RestoreSnapshot = Pick<
  AcceptedState,
  "allocatorId" | "authorityOwners" | "custodyRevision" | "fleetId" | "headHash" | "headSeq" | "mappings" | "nextOrdinalFence" | "nextPaneOrdinalFence" | "paneMappings" | "stateVersion" | "transactions"
>;

export type RestoreReady = {
  computedFence: number;
  readyHeadHash: string;
  readyHeadSeq: number;
};

export type AdapterTestHooks = {
  afterCommitBeforeAck?: (operation: string) => Promise<void> | void;
  afterCommitBeforeWitness?: (operation: string) => Promise<void> | void;
  afterMutationBeforeCommit?: (operation: string, client: PgClient) => Promise<void> | void;
  beforeMutation?: (operation: string, client: PgClient) => Promise<void> | void;
};

export class PersistenceOutcomeUnknownError extends AllocatorError {
  constructor(
    readonly operation: string,
    cause: unknown,
    readonly stage: "commit_ack" | "post_commit_verification" | "reconciliation" = "reconciliation",
  ) {
    super(
      "persistence_outcome_unknown",
      `${operation} durability is unknown; query custody by idempotency identity`,
      undefined,
      cause,
    );
    this.name = "PersistenceOutcomeUnknownError";
  }
}

export function custodyUncertaintyDiagnostic(error: PersistenceOutcomeUnknownError): {
  causeCode: string | null;
  causeMessageSha256: string;
  causeName: string;
  operation: string;
  stage: PersistenceOutcomeUnknownError["stage"];
} {
  const cause = error.cause;
  const causeRecord = typeof cause === "object" && cause !== null
    ? cause as { code?: unknown; message?: unknown; name?: unknown }
    : null;
  const token = (value: unknown): string | null =>
    typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : null;
  const causeCode = causeRecord?.code;
  return {
    causeCode: typeof causeCode === "string" && /^[0-9A-Z]{5}$/.test(causeCode)
      ? causeCode
      : token(causeCode),
    causeMessageSha256: createHash("sha256")
      .update(String(causeRecord?.message ?? cause ?? ""))
      .digest("hex"),
    causeName: token(causeRecord?.name) ?? "unknown",
    operation: error.operation,
    stage: error.stage,
  };
}

function recordCustodyDiagnostic(event: string, fields: Record<string, unknown>): void {
  try {
    console.error(`[surf-ace:server] event=${event} ${JSON.stringify(fields)}`);
  } catch {
    // A diagnostic sink must not change a durable-write outcome.
  }
}

export class PostgresCustodyAdapter<M extends LeaseMode> {
  private closed = false;
  private operationTail: Promise<void> = Promise.resolve();
  private validated = false;
  private uncertain: { operation: string; before: AcceptedState; matches: (state: AcceptedState) => boolean } | null = null;

  private constructor(
    readonly config: PostgresCustodyConfig,
    private readonly primary: PgClient,
    readonly token: LeaseToken<M>,
    private readonly hooks: AdapterTestHooks = {},
  ) {}

  static async installSchema(adminUrl: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const sql = await readFile(new URL("../sql/001_allocator.sql", import.meta.url), "utf8");
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  static async initializeAbsentFleet(
    config: PostgresCustodyConfig,
    allocatorId: string,
    options: { generationId?: string; hooks?: AdapterTestHooks } = {},
  ): Promise<PostgresCustodyAdapter<"recovery">> {
    validateCustodyConfig(config);
    const primary = await connect(config.recoveryUrl);
    try {
      await validateStaticTopology(config, primary);
      await acquireAdvisoryLock(primary, config.fleetId);
      const leaseId = newLeaseId();
      const generationId = options.generationId ?? `generation_${randomUUID().replaceAll("-", "")}`;
      const rows = await transaction(
        primary,
        "initialize_fleet",
        options.hooks,
        async () => await primary.query<TokenRow>(
          "SELECT * FROM surf_ace_allocator.initialize_fleet($1, $2, $3, $4)",
          [config.fleetId, allocatorId, generationId, leaseId],
        ),
      );
      const adapter = new PostgresCustodyAdapter(
        config,
        primary,
        tokenFromRow(rows.rows[0], "recovery"),
        options.hooks,
      );
      await adapter.validateLease();
      return adapter;
    } catch (error) {
      await primary.end().catch(() => undefined);
      throw mapDatabaseError(error);
    }
  }

  static async acquireWriter(
    config: PostgresCustodyConfig,
    hooks: AdapterTestHooks = {},
  ): Promise<PostgresCustodyAdapter<"writer">> {
    return await PostgresCustodyAdapter.acquire(config, "writer", hooks);
  }

  static async acquireRecovery(
    config: PostgresCustodyConfig,
    hooks: AdapterTestHooks = {},
  ): Promise<PostgresCustodyAdapter<"recovery">> {
    return await PostgresCustodyAdapter.acquire(config, "recovery", hooks);
  }

  private static async acquire<T extends LeaseMode>(
    config: PostgresCustodyConfig,
    mode: T,
    hooks: AdapterTestHooks,
  ): Promise<PostgresCustodyAdapter<T>> {
    validateCustodyConfig(config);
    const primary = await connect(mode === "recovery" ? config.recoveryUrl : config.primaryUrl);
    try {
      await validateStaticTopology(config, primary);
      await acquireAdvisoryLock(primary, config.fleetId);
      const leaseId = newLeaseId();
      const result = await transaction(
        primary,
        `acquire_${mode}`,
        hooks,
        async () => await primary.query<TokenRow>(
          "SELECT * FROM surf_ace_allocator.acquire_lease($1, $2, $3)",
          [config.fleetId, leaseId, mode],
        ),
      );
      const adapter = new PostgresCustodyAdapter(
        config,
        primary,
        tokenFromRow(result.rows[0], mode),
        hooks,
      );
      await adapter.validateLease();
      return adapter;
    } catch (error) {
      await primary.end().catch(() => undefined);
      throw mapDatabaseError(error);
    }
  }

  async release(): Promise<void> {
    if (this.closed) return;
    try {
      await this.mutate("release_lease", async () => await this.primary.query(
        "SELECT surf_ace_allocator.release_lease($1, $2, $3, $4)",
        [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, this.token.mode],
      ));
      await this.primary.query(
        "SELECT pg_advisory_unlock(key1, key2) FROM surf_ace_allocator.advisory_keys($1)",
        [this.config.fleetId],
      );
    } finally {
      this.closed = true;
      await this.primary.end().catch(() => undefined);
    }
  }

  async terminate(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.primary.end().catch(() => undefined);
  }

  async readAcceptedState(): Promise<AcceptedState> {
    return await this.enqueuePrimary(async () => await this.readAcceptedStateNow());
  }

  private async readAcceptedStateNow(): Promise<AcceptedState> {
    const result = await this.primary.query<{ state: AcceptedState | null }>(
      "SELECT surf_ace_allocator.read_accepted_state($1) AS state",
      [this.config.fleetId],
    );
    const state = result.rows[0]?.state;
    if (!state) {
      throw new AllocatorError("allocator_uninitialized", "fleet custody is absent");
    }
    validateAcceptedState(state, this.config);
    return state;
  }

  async readWitness(requiredReplayLsn?: string): Promise<HeadWitness> {
    return await this.enqueuePrimary(
      async () => await readAndValidateWitness(this.config, this.primary, requiredReplayLsn),
    );
  }

  async validateLease(): Promise<void> {
    await this.enqueuePrimary(async () => await this.validateLeaseNow());
  }

  get registrationReady(): boolean {
    return !this.closed && this.validated && this.uncertain === null;
  }

  private async validateLeaseNow(): Promise<void> {
    this.validated = false;
    try {
      const state = await this.readAcceptedStateNow();
      const journal = await this.primary.query<{ valid: boolean }>(
        "SELECT surf_ace_allocator.validate_journal($1) AS valid",
        [this.config.fleetId],
      );
      const backend = await this.primary.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      if (journal.rows[0]?.valid !== true) {
        throw new AllocatorError("allocator_state_corrupt", "custody journal chain does not match the fleet head");
      }
      if (
        state.leaseGeneration !== this.token.leaseGeneration
        || state.leaseId !== this.token.leaseId
        || state.leaseMode !== this.token.mode
        || state.leaseBackendPid !== integer(requiredRow(backend.rows[0], "pg_backend_pid").pid)
      ) {
        throw new AllocatorError("writer_fence_unavailable", "custody lease does not match the session token");
      }
      const witness = await readAndValidateWitness(this.config, this.primary);
      assertMatchingHead(state, witness);
      if (this.uncertain) {
        const { before, matches, operation } = this.uncertain;
        const unchanged = state.headSeq === before.headSeq
          && state.headHash === before.headHash
          && state.custodyRevision === before.custodyRevision;
        if (!matches(state) && !unchanged) {
          throw new AllocatorError("allocator_state_corrupt", `${operation} outcome contradicts the held writer's accepted head`);
        }
        this.uncertain = null;
      }
      this.validated = true;
    } catch (error) {
      this.validated = false;
      throw error;
    }
  }

  async recoverWriter(): Promise<boolean> {
    try {
      await this.validateLease();
      return this.registrationReady;
    } catch {
      return false;
    }
  }

  private async mutate<T>(
    operation: string,
    body: () => Promise<T>,
    matches: (state: AcceptedState) => boolean = () => false,
    precheck?: (state: AcceptedState) => void,
  ): Promise<T> {
    return await this.enqueuePrimary(async () => await this.performMutation(operation, body, matches, precheck));
  }

  private async enqueuePrimary<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    const result = previous.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async performMutation<T>(
    operation: string,
    body: () => Promise<T>,
    matches: (state: AcceptedState) => boolean,
    precheck?: (state: AcceptedState) => void,
  ): Promise<T> {
    this.assertUsable();
    let before: AcceptedState;
    try {
      before = await this.readAcceptedStateNow();
    } catch (error) {
      this.validated = false;
      throw error;
    }
    precheck?.(before);
    let committed = false;
    try {
      const result = await transaction(this.primary, operation, this.hooks, body);
      committed = true;
      await this.hooks.afterCommitBeforeWitness?.(operation);
      const lsn = await currentWalLsn(this.primary);
      const verifyWitness = async () => await readAndValidateWitness(this.config, this.primary, lsn);
      if (operation === "release_lease") {
        // The release is already committed. Recheck only the witness; never replay the mutation.
        await verifyReleaseWitnessWithRetry(verifyWitness, undefined, (event, error) => {
          const reason = error ? releaseWitnessFenceReason(error) : "verified";
          // The packaged launcher accepts these fixed tokens; the release fixture retains them.
          console.log(`[surf-ace:server] event=release_witness_${event}_${reason}`);
        });
      } else {
        await verifyWitness();
      }
      return result;
    } catch (error) {
      if (committed || error instanceof PersistenceOutcomeUnknownError) {
        this.validated = false;
        this.uncertain = { operation, before, matches };
        const unknown = error instanceof PersistenceOutcomeUnknownError
          ? error
          : new PersistenceOutcomeUnknownError(operation, error, "post_commit_verification");
        try {
          recordCustodyDiagnostic("custody_outcome_unknown", custodyUncertaintyDiagnostic(unknown));
        } catch {
          // Neither diagnostic formatting nor output may change the unknown outcome.
        }
        throw unknown;
      }
      throw mapDatabaseError(error);
    }
  }

  private assertUsable(): void {
    if (this.closed || !this.validated) {
      throw new AllocatorError("writer_fence_unavailable", "custody lease is closed or unvalidated");
    }
  }

  private assertMode(expected: M): void {
    if (this.token.mode !== expected) {
      throw new AllocatorError("writer_fence_unavailable", `operation requires ${expected} mode`);
    }
  }

  async appendAnnotation(
    this: PostgresCustodyAdapter<"writer">,
    record: {
      clientId: string; sourceEpoch: string; surfaceId: string;
      sourceSequence: string; sourceEventId: string;
      lostFromSequence?: string; kind: string;
    },
    canonicalBytes: Buffer,
  ): Promise<{ serverEpoch: string; serverSequence: string; duplicate: boolean; committedAt: string }> {
    this.assertMode("writer");
    const result = await this.mutate("annotation_append", async () => await this.primary.query<{
      server_epoch: string; server_sequence: string; duplicate: boolean; committed_at: Date;
    }>(
      "SELECT * FROM surf_ace_allocator.annotation_append($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId,
        record.clientId, record.sourceEpoch, record.surfaceId, record.sourceSequence,
        record.sourceEventId, record.lostFromSequence ?? null, record.kind, canonicalBytes],
    ));
    const row = result.rows[0];
    if (!row) throw new AllocatorError("persistence_failed", "annotation append returned no cursor");
    return {
      serverEpoch: row.server_epoch,
      serverSequence: String(row.server_sequence),
      duplicate: row.duplicate,
      committedAt: row.committed_at.toISOString(),
    };
  }

  async compactAnnotations(this: PostgresCustodyAdapter<"writer">): Promise<number> {
    this.assertMode("writer");
    const result = await this.mutate("annotation_compact", async () => await this.primary.query<{
      compacted: number;
    }>("SELECT surf_ace_allocator.annotation_compact($1,$2,$3,0,true) AS compacted",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId]));
    return result.rows[0]?.compacted ?? 0;
  }

  async annotationInfo(this: PostgresCustodyAdapter<"writer">): Promise<AnnotationInfo> {
    this.assertMode("writer");
    return await this.enqueuePrimary(async () => {
      this.assertUsable();
      const result = await transaction(this.primary, "annotation_info", undefined,
        async () => await this.primary.query<{ info: AnnotationInfo }>(
          "SELECT surf_ace_allocator.annotation_info($1,$2,$3) AS info",
          [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId],
        ));
      return result.rows[0]!.info;
    });
  }

  async verifyAnnotationStartup(this: PostgresCustodyAdapter<"writer">): Promise<void> {
    this.assertMode("writer");
    await this.mutate("annotation_verify_startup", async () => await this.primary.query(
      "SELECT surf_ace_allocator.annotation_verify_startup($1,$2,$3)",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId],
    ));
  }

  async openAnnotationConsumer(
    this: PostgresCustodyAdapter<"writer">,
    consumerId: string, mode: "watch" | "resume",
    from?: { epoch: string; sequence: string },
  ): Promise<AnnotationConsumerOpen> {
    this.assertMode("writer");
    const result = await this.mutate("annotation_consumer_open", async () => await this.primary.query<{
      opened: AnnotationConsumerOpen;
    }>("SELECT surf_ace_allocator.annotation_consumer_open($1,$2,$3,$4,$5,$6,$7) AS opened",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId,
        consumerId, mode, from?.epoch ?? null, from?.sequence ?? null]));
    return result.rows[0]!.opened;
  }

  async readAnnotationRecords(
    this: PostgresCustodyAdapter<"writer">, fromSequence: string, limit: number,
  ): Promise<Array<{ epoch: string; sequence: string; record: unknown; committedAt: string; bytes: number }>> {
    this.assertMode("writer");
    return await this.enqueuePrimary(async () => {
      this.assertUsable();
      const result = await transaction(this.primary, "annotation_read", undefined,
        async () => await this.primary.query<{
          epoch: string; sequence: string; canonical_record_bytes: Buffer;
          canonical_record_length: number; committed_at: Date;
        }>("SELECT * FROM surf_ace_allocator.annotation_read($1,$2,$3,$4,$5)",
          [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, fromSequence, limit]));
      return result.rows.map((row) => ({ epoch: row.epoch, sequence: String(row.sequence),
        record: JSON.parse(row.canonical_record_bytes.toString("utf8")) as unknown,
        committedAt: row.committed_at.toISOString(), bytes: row.canonical_record_length }));
    });
  }

  async ackAnnotationConsumer(
    this: PostgresCustodyAdapter<"writer">, consumerId: string, consumerLeaseId: string,
    cursor: { epoch: string; sequence: string },
  ): Promise<{ epoch: string; sequence: string }> {
    this.assertMode("writer");
    const result = await this.mutate("annotation_consumer_ack", async () => await this.primary.query<{
      cursor: { epoch: string; sequence: string };
    }>("SELECT surf_ace_allocator.annotation_consumer_ack($1,$2,$3,$4,$5,$6,$7) AS cursor",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId,
        consumerId, consumerLeaseId, cursor.epoch, cursor.sequence]));
    return result.rows[0]!.cursor;
  }

  async disconnectAnnotationConsumer(
    this: PostgresCustodyAdapter<"writer">, consumerId: string, consumerLeaseId: string,
  ): Promise<void> {
    this.assertMode("writer");
    await this.mutate("annotation_consumer_disconnect", async () => await this.primary.query(
      "SELECT surf_ace_allocator.annotation_consumer_disconnect($1,$2,$3,$4,$5)",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, consumerId, consumerLeaseId],
    ));
  }

  async ackAnnotationGap(
    this: PostgresCustodyAdapter<"writer">, consumerId: string, consumerLeaseId: string,
    through: { epoch: string; sequence: string },
  ): Promise<{ epoch: string; sequence: string }> {
    this.assertMode("writer");
    const result = await this.mutate("annotation_consumer_gap_ack", async () => await this.primary.query<{
      cursor: { epoch: string; sequence: string };
    }>("SELECT surf_ace_allocator.annotation_consumer_gap_ack($1,$2,$3,$4,$5,$6,$7) AS cursor",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId,
        consumerId, consumerLeaseId, through.epoch, through.sequence]));
    return result.rows[0]!.cursor;
  }

  async retireAnnotationConsumer(
    this: PostgresCustodyAdapter<"writer">, consumerId: string,
    expectedAckCursor: { epoch: string; sequence: string } | null,
    discardUnacknowledged: boolean,
  ): Promise<AnnotationRetirement> {
    this.assertMode("writer");
    const result = await this.mutate("annotation_consumer_retire", async () => await this.primary.query<{
      retired: AnnotationRetirement;
    }>("SELECT surf_ace_allocator.annotation_consumer_retire($1,$2,$3,$4,$5,$6,$7) AS retired",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId,
        consumerId, expectedAckCursor?.epoch ?? null, expectedAckCursor?.sequence ?? null,
        discardUnacknowledged]));
    return result.rows[0]!.retired;
  }

  async bindAuthority(this: PostgresCustodyAdapter<"writer">, authorityId: string, ownerAnchorId: string): Promise<void> {
    this.assertMode("writer");
    await this.mutate("bind_authority", async () => await this.primary.query(
      "SELECT surf_ace_allocator.bind_authority($1, $2, $3, $4, $5)",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, authorityId, ownerAnchorId],
    ), (state) => state.authorityOwners.some((owner) =>
      owner.authorityId === authorityId && owner.ownerAnchorId === ownerAnchorId));
  }

  async reserve(
    this: PostgresCustodyAdapter<"writer">,
    transactionId: string,
    authorityId: string,
    ownerAnchorId: string,
    surfaceId: string,
  ): Promise<ReserveResult> {
    this.assertMode("writer");
    const result = await this.mutate("reserve_ordinal", async () => await this.primary.query<ReserveRow>(
      "SELECT * FROM surf_ace_allocator.reserve_ordinal($1, $2, $3, $4, $5, $6, $7)",
      [
        this.config.fleetId,
        this.token.leaseGeneration,
        this.token.leaseId,
        transactionId,
        authorityId,
        ownerAnchorId,
        surfaceId,
      ],
    ), (state) => state.transactions.some((tx) => tx.transactionId === transactionId
      && tx.authorityId === authorityId && tx.ownerAnchorId === ownerAnchorId && tx.surfaceId === surfaceId));
    return reserveFromRow(requiredRow(result.rows[0], "reserve_ordinal"));
  }

  async commitMapping(
    this: PostgresCustodyAdapter<"writer">,
    transactionId: string,
  ): Promise<Omit<Assignment, "allocatorId" | "committed" | "fleetId" | "stateVersion">> {
    this.assertMode("writer");
    const result = await this.mutate("commit_mapping", async () => await this.primary.query<MappingRow>(
      "SELECT * FROM surf_ace_allocator.commit_mapping($1, $2, $3, $4)",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, transactionId],
    ), (state) => state.transactions.some((tx) => tx.transactionId === transactionId
      && tx.status === "committed" && state.mappings.some((mapping) => mapping.ordinal === tx.ordinal
        && mapping.authorityId === tx.authorityId && mapping.surfaceId === tx.surfaceId)));
    const row = requiredRow(result.rows[0], "commit_mapping");
    return {
      authorityId: row.authority_id,
      ordinal: integer(row.ordinal),
      ownerAnchorId: row.owner_anchor_id,
      surfaceId: row.surface_id,
      windowLabel: row.window_label,
    };
  }

  async claimPane(
    this: PostgresCustodyAdapter<"writer">,
    clientId: string,
    surfaceId: string,
    paneId: string,
    lineageId: string,
  ): Promise<number> {
    this.assertMode("writer");
    try {
      const result = await this.mutate("claim_pane", async () => await this.primary.query<{ pane_label: number | string }>(
        "SELECT surf_ace_allocator.claim_pane($1, $2, $3, $4, $5, $6, $7) AS pane_label",
        [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, clientId, surfaceId, paneId, lineageId],
      ), (state) => state.paneMappings.some((pane) => pane.clientId === clientId
        && pane.surfaceId === surfaceId && pane.paneId === paneId && pane.lineageId === lineageId),
      (state) => {
        const existing = state.paneMappings.find((pane) => pane.clientId === clientId
          && pane.surfaceId === surfaceId && pane.lineageId === lineageId);
        if (existing && existing.paneId !== paneId) {
          throw new AllocatorError("assignment_conflict", "pane lineage is bound to another pane ID");
        }
      });
      return integer(requiredRow(result.rows[0], "claim_pane").pane_label);
    } catch (error) {
      if (error instanceof PersistenceOutcomeUnknownError) {
        const identitySha256 = createHash("sha256")
          .update(JSON.stringify([clientId, surfaceId, paneId, lineageId]))
          .digest("hex");
        recordCustodyDiagnostic("custody_claim_unknown", { identitySha256 });
      }
      throw error;
    }
  }

  async burn(this: PostgresCustodyAdapter<"writer">, transactionId: string): Promise<void> {
    this.assertMode("writer");
    await this.mutate("burn_reservation", async () => await this.primary.query(
      "SELECT surf_ace_allocator.burn_reservation($1, $2, $3, $4)",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, transactionId],
    ), (state) => state.transactions.some((tx) => tx.transactionId === transactionId && tx.status === "burned"));
  }

  async queryTransaction(transactionId: string): Promise<TransactionRecord | null> {
    return await this.enqueuePrimary(async () => {
      const result = await this.primary.query<TransactionRow>(
        "SELECT * FROM surf_ace_allocator.query_transaction($1)",
        [transactionId],
      );
      const row = result.rows[0];
      return row ? transactionFromRow(row, transactionId) : null;
    });
  }

  async stageRestore(
    this: PostgresCustodyAdapter<"recovery">,
    generationId: string,
    idempotencyId: string,
    snapshot: RestoreSnapshot,
    base: Pick<HeadWitness, "headHash" | "headSeq">,
  ): Promise<void> {
    this.assertMode("recovery");
    const liveWitness = await this.readWitness();
    if (liveWitness.headSeq !== base.headSeq || liveWitness.headHash !== base.headHash) {
      throw new AllocatorError("allocator_state_corrupt", "restore base is not the current live witness head");
    }
    await this.mutate("stage_restore", async () => await this.primary.query(
      "SELECT surf_ace_allocator.stage_restore($1, $2, $3, $4, $5, $6::jsonb, $7, decode($8, 'hex'))",
      [
        this.config.fleetId,
        this.token.leaseGeneration,
        this.token.leaseId,
        generationId,
        idempotencyId,
        JSON.stringify(snapshot),
        base.headSeq,
        base.headHash,
      ],
    ));
  }

  async markRestoreReady(
    this: PostgresCustodyAdapter<"recovery">,
    generationId: string,
  ): Promise<RestoreReady> {
    this.assertMode("recovery");
    const result = await this.mutate("mark_restore_ready", async () => await this.primary.query<ReadyRow>(
      "SELECT * FROM surf_ace_allocator.mark_restore_ready($1, $2, $3, $4)",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, generationId],
    ));
    const row = requiredRow(result.rows[0], "mark_restore_ready");
    return {
      computedFence: integer(row.computed_fence),
      readyHeadHash: row.ready_head_hash,
      readyHeadSeq: integer(row.ready_head_seq),
    };
  }

  async activateRestore(
    this: PostgresCustodyAdapter<"recovery">,
    generationId: string,
    ready: Pick<RestoreReady, "readyHeadHash" | "readyHeadSeq">,
  ): Promise<void> {
    this.assertMode("recovery");
    const witness = await this.readWitness();
    if (witness.headSeq !== ready.readyHeadSeq || witness.headHash !== ready.readyHeadHash) {
      throw new AllocatorError("allocator_state_corrupt", "live witness does not equal the ready restore head");
    }
    await this.mutate("activate_restore", async () => await this.primary.query(
      "SELECT surf_ace_allocator.activate_restore($1, $2, $3, $4, $5, decode($6, 'hex'))",
      [
        this.config.fleetId,
        this.token.leaseGeneration,
        this.token.leaseId,
        generationId,
        ready.readyHeadSeq,
        ready.readyHeadHash,
      ],
    ));
  }

  async discardRestore(this: PostgresCustodyAdapter<"recovery">, generationId: string): Promise<void> {
    this.assertMode("recovery");
    await this.mutate("discard_restore", async () => await this.primary.query(
      "SELECT surf_ace_allocator.discard_restore($1, $2, $3, $4)",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, generationId],
    ));
  }

  async revokeWriter(
    this: PostgresCustodyAdapter<"recovery">,
    expectedLeaseGeneration: number,
  ): Promise<number> {
    this.assertMode("recovery");
    return await this.enqueuePrimary(async () => {
      const result = await this.primary.query<{ pid: number }>(
        "SELECT surf_ace_allocator.revoke_writer($1, $2) AS pid",
        [this.config.fleetId, expectedLeaseGeneration],
      );
      return integer(requiredRow(result.rows[0], "revoke_writer").pid);
    });
  }
}

const RELEASE_WITNESS_RECHECK_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

const RELEASE_WITNESS_FENCE_REASONS: Readonly<Record<string, string>> = {
  "primary must run PostgreSQL 16.x": "primary_version",
  "primary recovery mode or cluster system identifier is invalid": "primary_identity",
  "primary must enable fsync and remote_apply": "primary_durability",
  "synchronous_standby_names must be exactly FIRST 1 (surf_ace_witness)": "primary_sync_config",
  "exactly one WAL sender may use the witness application name": "sender_count",
  "the sole synchronous WAL sender is not bound to the configured physical slot": "sender_slot",
  "witness URL is not the configured standby server and physical WAL receiver": "witness_endpoint",
  "witness WAL receiver is connected to the wrong primary endpoint": "receiver_primary",
  "witness endpoint replay position trails its bound primary WAL sender row": "receiver_sender_replay",
  "bound witness has not replayed the required commit LSN": "required_commit_replay",
};

function releaseWitnessFenceReason(error: AllocatorError): string {
  return RELEASE_WITNESS_FENCE_REASONS[error.message] ?? "other_fence";
}

export async function verifyReleaseWitnessWithRetry<T>(
  verify: () => Promise<T>,
  wait: (ms: number) => Promise<void> = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  report?: (event: "retry" | "recovered" | "exhausted", error?: AllocatorError) => void,
): Promise<T> {
  for (const delay of RELEASE_WITNESS_RECHECK_DELAYS_MS) {
    try {
      const result = await verify();
      if (delay !== RELEASE_WITNESS_RECHECK_DELAYS_MS[0]) report?.("recovered");
      return result;
    } catch (error) {
      if (!(error instanceof AllocatorError) || error.code !== "writer_fence_unavailable") throw error;
      report?.("retry", error);
      await wait(delay);
    }
  }
  try {
    const result = await verify();
    report?.("recovered");
    return result;
  } catch (error) {
    if (error instanceof AllocatorError && error.code === "writer_fence_unavailable") {
      report?.("exhausted", error);
    }
    throw error;
  }
}

export async function revokeWriter(
  recoveryUrl: string,
  fleetId: string,
  expectedLeaseGeneration: number,
): Promise<number> {
  const client = await connect(recoveryUrl);
  try {
    const result = await client.query<{ pid: number }>(
      "SELECT surf_ace_allocator.revoke_writer($1, $2) AS pid",
      [fleetId, expectedLeaseGeneration],
    );
    return integer(requiredRow(result.rows[0], "revoke_writer").pid);
  } catch (error) {
    throw mapDatabaseError(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function connect(connectionString: string): Promise<PgClient> {
  const client = new Client({ connectionString });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

async function acquireAdvisoryLock(client: PgClient, fleetId: string): Promise<void> {
  const result = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(key1, key2) AS acquired FROM surf_ace_allocator.advisory_keys($1)",
    [fleetId],
  );
  if (result.rows[0]?.acquired !== true) {
    throw new AllocatorError("writer_fence_unavailable", "fleet advisory lock is held by another session");
  }
}

async function transaction<T>(
  client: PgClient,
  operation: string,
  hooks: AdapterTestHooks | undefined,
  body: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let commitStarted = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL synchronous_commit = 'remote_apply'");
      await hooks?.beforeMutation?.(operation, client);
      const result = await body();
      await hooks?.afterMutationBeforeCommit?.(operation, client);
      commitStarted = true;
      await client.query("COMMIT");
      await hooks?.afterCommitBeforeAck?.(operation);
      return result;
    } catch (error) {
      if (!commitStarted) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      if (isSqlState(error, "40001") && !commitStarted && attempt < 3) {
        continue;
      }
      if (commitStarted) {
        throw new PersistenceOutcomeUnknownError(operation, error, "commit_ack");
      }
      throw error;
    }
  }
  throw new AllocatorError("persistence_failed", `${operation} exceeded serialization retries`);
}

function validateCustodyConfig(config: PostgresCustodyConfig): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(config.fleetId)) {
    throw new TypeError("fleetId is missing or malformed");
  }
  if (!/^[a-z0-9_]{1,63}$/.test(config.witnessPhysicalSlot)) {
    throw new TypeError("witnessPhysicalSlot is missing or malformed");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(config.witnessServerId)) {
    throw new TypeError("witnessServerId is missing or malformed");
  }
  if (!/^[0-9]+$/.test(config.expectedClusterSystemId)) {
    throw new TypeError("expectedClusterSystemId is missing or malformed");
  }
  const primary = new URL(config.primaryUrl);
  const recovery = new URL(config.recoveryUrl);
  const witness = new URL(config.witnessUrl);
  if (primary.protocol !== "postgresql:" || recovery.protocol !== "postgresql:" || witness.protocol !== "postgresql:") {
    throw new TypeError("custody URLs must use postgresql");
  }
  if (primary.hostname === witness.hostname && (primary.port || "5432") === (witness.port || "5432")) {
    throw new TypeError("primaryUrl and witnessUrl must be different endpoints");
  }
}

async function validateStaticTopology(config: PostgresCustodyConfig, primary: PgClient): Promise<void> {
  if (config.witnessApplicationName !== "surf_ace_witness") {
    throw new AllocatorError("allocator_state_corrupt", "witness application name must be surf_ace_witness");
  }
  const result = await primary.query<StaticPrimaryRow>(
    "SELECT * FROM surf_ace_allocator.read_primary_topology()",
  );
  const row = requiredRow(result.rows[0], "primary validation");
  if (row.server_version_num < 160000 || row.server_version_num > 169999) {
    topologyError("primary must run PostgreSQL 16.x");
  }
  if (row.in_recovery || row.cluster_system_id !== config.expectedClusterSystemId) {
    topologyError("primary recovery mode or cluster system identifier is invalid");
  }
  if (row.fsync !== "on" || row.synchronous_commit !== "remote_apply") {
    topologyError("primary must enable fsync and remote_apply");
  }
  if (row.synchronous_standby_names !== "FIRST 1 (surf_ace_witness)") {
    topologyError("synchronous_standby_names must be exactly FIRST 1 (surf_ace_witness)");
  }
}

async function readAndValidateWitness(
  config: PostgresCustodyConfig,
  primary: PgClient,
  requiredReplayLsn?: string,
): Promise<HeadWitness> {
  await validateStaticTopology(config, primary);
  const senders = await primary.query<SenderRow>(
    "SELECT * FROM surf_ace_allocator.read_wal_senders()",
  );
  if (senders.rowCount !== 1) {
    topologyError("exactly one WAL sender may use the witness application name");
  }
  const sender = requiredRow(senders.rows[0], "witness WAL sender");
  if (
    sender.state !== "streaming"
    || sender.sync_state !== "sync"
    || sender.slot_name !== config.witnessPhysicalSlot
    || sender.slot_type !== "physical"
    || sender.active_pid !== sender.pid
    || !sender.replay_lsn
  ) {
    topologyError("the sole synchronous WAL sender is not bound to the configured physical slot");
  }

  const witnessClient = await connect(config.witnessUrl);
  try {
    const endpoint = await witnessClient.query<WitnessEndpointRow>(`
      SELECT current_setting('server_version_num')::integer AS server_version_num,
        pg_is_in_recovery() AS in_recovery,
        inet_server_addr()::text AS server_addr
    `);
    const endpointRow = requiredRow(endpoint.rows[0], "witness endpoint");
    const result = await witnessClient.query<WitnessRow>(
      "SELECT * FROM surf_ace_allocator.read_head_witness($1)",
      [config.fleetId],
    );
    const row = requiredRow(result.rows[0], "head witness");
    if (
      endpointRow.server_version_num < 160000
      || endpointRow.server_version_num > 169999
      || !endpointRow.in_recovery
      || row.cluster_system_id !== config.expectedClusterSystemId
      || row.witness_server_id !== config.witnessServerId
      || row.receiver_slot_name !== config.witnessPhysicalSlot
      || sender.client_addr !== endpointRow.server_addr
    ) {
      topologyError("witness URL is not the configured standby server and physical WAL receiver");
    }
    const primaryEndpoint = new URL(config.primaryUrl);
    const configuredPrimaryPort = Number(primaryEndpoint.port || 5432);
    if (row.sender_host !== primaryEndpoint.hostname || row.sender_port !== configuredPrimaryPort) {
      topologyError("witness WAL receiver is connected to the wrong primary endpoint");
    }
    if (compareLsn(row.replay_lsn, sender.replay_lsn) < 0) {
      topologyError("witness endpoint replay position trails its bound primary WAL sender row");
    }
    if (
      requiredReplayLsn
      && (compareLsn(row.replay_lsn, requiredReplayLsn) < 0
        || compareLsn(sender.replay_lsn, requiredReplayLsn) < 0)
    ) {
      topologyError("bound witness has not replayed the required commit LSN");
    }
    return {
      allocatorId: row.allocator_id,
      clusterSystemId: row.cluster_system_id,
      custodyRevision: integer(row.custody_revision),
      fleetId: row.fleet_id,
      headHash: row.head_hash,
      headSeq: integer(row.head_seq),
      receiverSlotName: row.receiver_slot_name,
      replayLsn: row.replay_lsn,
      senderHost: row.sender_host,
      senderPort: row.sender_port,
      timelineId: row.timeline_id,
      witnessServerId: row.witness_server_id,
    };
  } finally {
    await witnessClient.end().catch(() => undefined);
  }
}

async function currentWalLsn(client: PgClient): Promise<string> {
  const result = await client.query<{ lsn: string }>("SELECT pg_current_wal_lsn()::text AS lsn");
  return requiredRow(result.rows[0], "current WAL LSN").lsn;
}

function assertMatchingHead(state: AcceptedState, witness: HeadWitness): void {
  if (
    state.fleetId !== witness.fleetId
    || state.allocatorId !== witness.allocatorId
    || state.headSeq !== witness.headSeq
    || state.headHash !== witness.headHash
    || state.custodyRevision !== witness.custodyRevision
  ) {
    throw new AllocatorError("allocator_state_corrupt", "primary and live witness head tuples differ");
  }
}

function validateAcceptedState(state: AcceptedState, config: PostgresCustodyConfig): void {
  if (state.fleetId !== config.fleetId) {
    throw new AllocatorError("fleet_identity_mismatch", "custody returned another fleet");
  }
  if (state.stateVersion !== STATE_VERSION) {
    throw new AllocatorError(
      "allocator_state_unsupported_version",
      `unsupported state version ${String(state.stateVersion)}`,
      state.allocatorId,
    );
  }
  if (!Number.isSafeInteger(state.nextPaneOrdinalFence) || state.nextPaneOrdinalFence < 1 ||
      !Array.isArray(state.paneMappings)) {
    throw new AllocatorError("allocator_state_corrupt", "pane allocator fence or mappings are invalid");
  }
  const paneKeys = new Set<string>();
  const paneLabels = new Set<number>();
  for (const pane of state.paneMappings) {
    const key = `${pane.clientId}\0${pane.surfaceId}\0${pane.lineageId}`;
    if (!/^[a-f0-9]{64}$/.test(pane.clientId) ||
        !/^sf_[A-Za-z0-9._:-]{3,64}$/.test(pane.surfaceId) ||
        !/^[A-Za-z0-9._:-]{1,64}$/.test(pane.paneId) ||
        !/^pl_[A-Za-z0-9._:-]{3,128}$/.test(pane.lineageId) ||
        !Number.isSafeInteger(pane.paneLabel) || pane.paneLabel < 1 ||
        pane.paneLabel >= state.nextPaneOrdinalFence ||
        paneKeys.has(key) || paneLabels.has(pane.paneLabel)) {
      throw new AllocatorError("allocator_state_corrupt", "pane assignments violate uniqueness or fence invariants");
    }
    paneKeys.add(key);
    paneLabels.add(pane.paneLabel);
  }
  const ownerByAuthority = new Map(state.authorityOwners.map((owner) => [owner.authorityId, owner.ownerAnchorId]));
  const ordinals = new Set<number>();
  const labels = new Set<string>();
  const mappings = new Map<string, AcceptedState["mappings"][number]>();
  for (const mapping of state.mappings) {
    const key = `${mapping.authorityId}\0${mapping.surfaceId}`;
    if (
      mappings.has(key)
      || ordinals.has(mapping.ordinal)
      || labels.has(mapping.windowLabel)
      || mapping.ordinal >= state.nextOrdinalFence
      || ordinalToWindowLabel(mapping.ordinal) !== mapping.windowLabel
      || ownerByAuthority.get(mapping.authorityId) !== mapping.ownerAnchorId
    ) {
      throw new AllocatorError("allocator_state_corrupt", "accepted assignment set violates uniqueness or fence invariants");
    }
    mappings.set(key, mapping);
    ordinals.add(mapping.ordinal);
    labels.add(mapping.windowLabel);
  }
  for (const tx of state.transactions) {
    if (tx.ordinal >= state.nextOrdinalFence || ownerByAuthority.get(tx.authorityId) !== tx.ownerAnchorId) {
      throw new AllocatorError("allocator_state_corrupt", "transaction ledger violates binding or fence invariants");
    }
    const mapping = mappings.get(`${tx.authorityId}\0${tx.surfaceId}`);
    if (tx.status === "committed" && (!mapping || mapping.ordinal !== tx.ordinal)) {
      throw new AllocatorError("allocator_state_corrupt", "committed transaction lacks its exact immutable mapping");
    }
    if (tx.status !== "committed" && mapping?.ordinal === tx.ordinal) {
      throw new AllocatorError("allocator_state_corrupt", "uncommitted transaction owns a mapping");
    }
  }
}

function mapDatabaseError(error: unknown): AllocatorError {
  if (error instanceof AllocatorError) return error;
  const message = String((error as { message?: unknown })?.message ?? error);
  if (isSqlState(error, "P0001") && /^(annotation_invalid_request|annotation_journal_unverified|annotation_record_too_large|annotation_source_event_conflict|annotation_source_sequence_conflict|annotation_source_gap_required|annotation_source_gap_invalid|annotation_ingest_capacity|annotation_journal_sequence_exhausted|annotation_consumer_capacity|annotation_consumer_exists|annotation_consumer_not_found|annotation_consumer_lease_stale|annotation_cursor_invalid|annotation_ack_regression|annotation_gap_id_mismatch|annotation_consumer_retire_confirmation_required|annotation_ack_cursor_mismatch)$/.test(message)) {
    let details: Record<string, unknown> | undefined;
    if (message === "annotation_ingest_capacity" || message === "annotation_consumer_capacity") {
      try {
        const parsed: unknown = JSON.parse(String((error as { detail?: unknown }).detail));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          details = parsed as Record<string, unknown>;
        }
      } catch { /* A missing or malformed database detail cannot turn a refusal into success. */ }
    }
    return new AllocatorError(message as AllocatorError["code"], message, undefined, error, details);
  }
  if (isSqlState(error, "23505")) {
    return new AllocatorError(
      message.includes("ownership") ? "authority_ownership_conflict" : "assignment_conflict",
      message,
      undefined,
      error,
    );
  }
  if (isSqlState(error, "55000")) {
    return new AllocatorError("writer_fence_unavailable", String((error as Error).message), undefined, error);
  }
  if (isSqlState(error, "23503")) {
    return new AllocatorError("authority_ownership_conflict", String((error as Error).message), undefined, error);
  }
  return new AllocatorError("persistence_failed", String((error as Error)?.message ?? error), undefined, error);
}

function topologyError(message: string): never {
  throw new AllocatorError("writer_fence_unavailable", message);
}

function isSqlState(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function compareLsn(left: string, right: string): number {
  const parse = (value: string): bigint => {
    const [high, low] = value.split("/");
    if (!high || !low) throw new TypeError(`invalid PostgreSQL LSN: ${value}`);
    return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
  };
  const a = parse(left);
  const b = parse(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function newLeaseId(): string {
  return `lease_${randomBytes(16).toString("base64url")}`;
}

function tokenFromRow<M extends LeaseMode>(row: TokenRow | undefined, mode: M): LeaseToken<M> {
  const value = requiredRow(row, `acquire ${mode}`);
  if (value.mode !== mode || value.lease_id.length === 0) {
    throw new AllocatorError("writer_fence_unavailable", `custody returned an invalid ${mode} token`);
  }
  return { leaseGeneration: integer(value.lease_generation), leaseId: value.lease_id, mode };
}

function reserveFromRow(row: ReserveRow): ReserveResult {
  if (row.status !== "reserved" && row.status !== "burned" && row.status !== "committed") {
    throw new AllocatorError("allocator_state_corrupt", "custody returned an invalid transaction status");
  }
  return { ordinal: integer(row.ordinal), status: row.status, windowLabel: row.window_label };
}

function transactionFromRow(row: TransactionRow, transactionId: string): TransactionRecord {
  const reserve = reserveFromRow(row);
  return {
    allocatorId: row.allocator_id,
    authorityId: row.authority_id,
    fleetId: row.fleet_id,
    ordinal: reserve.ordinal,
    ownerAnchorId: row.owner_anchor_id,
    status: reserve.status,
    surfaceId: row.surface_id,
    transactionId,
    windowLabel: reserve.windowLabel,
  };
}

function integer(value: number | string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new AllocatorError("allocator_state_corrupt", `custody integer is not safe: ${String(value)}`);
  }
  return result;
}

function requiredRow<T extends QueryResultRow>(row: T | undefined, operation: string): T {
  if (!row) throw new AllocatorError("allocator_state_corrupt", `${operation} returned no row`);
  return row;
}

type TokenRow = { lease_generation: number | string; lease_id: string; mode: string } & QueryResultRow;
type ReserveRow = { ordinal: number | string; status: string; window_label: string | null } & QueryResultRow;
type MappingRow = {
  authority_id: string;
  ordinal: number | string;
  owner_anchor_id: string;
  recovered_at_custody_revision: number | string | null;
  surface_id: string;
  window_label: string;
} & QueryResultRow;
type TransactionRow = ReserveRow & {
  allocator_id: string;
  authority_id: string;
  fleet_id: string;
  owner_anchor_id: string;
  surface_id: string;
} & QueryResultRow;
type ReadyRow = {
  computed_fence: number | string;
  ready_head_hash: string;
  ready_head_seq: number | string;
} & QueryResultRow;
type StaticPrimaryRow = {
  cluster_system_id: string;
  fsync: string;
  in_recovery: boolean;
  server_version_num: number;
  synchronous_commit: string;
  synchronous_standby_names: string;
} & QueryResultRow;
type SenderRow = {
  active_pid: number | null;
  application_name: string;
  client_addr: string | null;
  pid: number;
  replay_lsn: string | null;
  slot_name: string | null;
  slot_type: string | null;
  state: string;
  sync_state: string;
} & QueryResultRow;
type WitnessEndpointRow = {
  in_recovery: boolean;
  server_addr: string | null;
  server_version_num: number;
} & QueryResultRow;
type WitnessRow = {
  cluster_system_id: string;
  allocator_id: string;
  custody_revision: number | string;
  fleet_id: string;
  head_hash: string;
  head_seq: number | string;
  receiver_slot_name: string;
  replay_lsn: string;
  sender_host: string;
  sender_port: number;
  timeline_id: number;
  witness_server_id: string;
} & QueryResultRow;
