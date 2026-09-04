import { randomBytes, randomUUID } from "node:crypto";
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
  "allocatorId" | "authorityOwners" | "fleetId" | "mappings" | "stateVersion" | "transactions"
>;

export type RestoreReady = {
  computedFence: number;
  readyHeadHash: string;
  readyHeadSeq: number;
};

export type AdapterTestHooks = {
  afterCommitBeforeWitness?: (operation: string) => Promise<void> | void;
  afterMutationBeforeCommit?: (operation: string, client: PgClient) => Promise<void> | void;
  beforeMutation?: (operation: string, client: PgClient) => Promise<void> | void;
};

export class PersistenceOutcomeUnknownError extends AllocatorError {
  constructor(readonly operation: string, cause: unknown) {
    super(
      "persistence_outcome_unknown",
      `${operation} durability is unknown; query custody by idempotency identity`,
      undefined,
      cause,
    );
    this.name = "PersistenceOutcomeUnknownError";
  }
}

export class PostgresCustodyAdapter<M extends LeaseMode> {
  private closed = false;
  private operationTail: Promise<void> = Promise.resolve();
  private validated = false;

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
    await this.enqueuePrimary(async () => {
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
      this.validated = true;
    });
  }

  private async mutate<T>(operation: string, body: () => Promise<T>): Promise<T> {
    return await this.enqueuePrimary(async () => await this.performMutation(operation, body));
  }

  private async enqueuePrimary<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    const result = previous.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async performMutation<T>(operation: string, body: () => Promise<T>): Promise<T> {
    this.assertUsable();
    let committed = false;
    try {
      const result = await transaction(this.primary, operation, this.hooks, body);
      committed = true;
      await this.hooks.afterCommitBeforeWitness?.(operation);
      const lsn = await currentWalLsn(this.primary);
      await readAndValidateWitness(this.config, this.primary, lsn);
      return result;
    } catch (error) {
      if (committed || error instanceof PersistenceOutcomeUnknownError) {
        this.validated = false;
        throw error instanceof PersistenceOutcomeUnknownError
          ? error
          : new PersistenceOutcomeUnknownError(operation, error);
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

  async bindAuthority(this: PostgresCustodyAdapter<"writer">, authorityId: string, ownerAnchorId: string): Promise<void> {
    this.assertMode("writer");
    await this.mutate("bind_authority", async () => await this.primary.query(
      "SELECT surf_ace_allocator.bind_authority($1, $2, $3, $4, $5)",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, authorityId, ownerAnchorId],
    ));
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
    ));
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
    ));
    const row = requiredRow(result.rows[0], "commit_mapping");
    return {
      authorityId: row.authority_id,
      ordinal: integer(row.ordinal),
      ownerAnchorId: row.owner_anchor_id,
      surfaceId: row.surface_id,
      windowLabel: row.window_label,
    };
  }

  async burn(this: PostgresCustodyAdapter<"writer">, transactionId: string): Promise<void> {
    this.assertMode("writer");
    await this.mutate("burn_reservation", async () => await this.primary.query(
      "SELECT surf_ace_allocator.burn_reservation($1, $2, $3, $4)",
      [this.config.fleetId, this.token.leaseGeneration, this.token.leaseId, transactionId],
    ));
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
      return result;
    } catch (error) {
      if (!commitStarted) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      if (isSqlState(error, "40001") && !commitStarted && attempt < 3) {
        continue;
      }
      if (commitStarted) {
        throw new PersistenceOutcomeUnknownError(operation, error);
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
  const result = await primary.query<StaticPrimaryRow>(`
    SELECT current_setting('server_version_num')::integer AS server_version_num,
      pg_is_in_recovery() AS in_recovery,
      (pg_control_system()).system_identifier::text AS cluster_system_id,
      current_setting('fsync') AS fsync,
      current_setting('synchronous_commit') AS synchronous_commit,
      current_setting('synchronous_standby_names') AS synchronous_standby_names
  `);
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
  const senders = await primary.query<SenderRow>(`
    SELECT r.pid, r.application_name, r.client_addr::text AS client_addr,
      r.state, r.sync_state, r.replay_lsn::text AS replay_lsn,
      s.slot_name, s.slot_type, s.active_pid
    FROM pg_stat_replication r
    LEFT JOIN pg_replication_slots s ON s.active_pid = r.pid
    WHERE r.application_name = $1
  `, [config.witnessApplicationName]);
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
  if (isSqlState(error, "23505")) {
    const message = String((error as { message?: unknown }).message ?? error);
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
