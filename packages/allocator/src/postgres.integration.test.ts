import { ServerConnection } from "../../electron/src/server-connection.js";
import { startCentralServer } from "../../electron/src/central-server.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";

import pg from "pg";
import WebSocket from "ws";

import { ConfiguredServerRegistration, registrationClientId } from "../../electron/src/configured-server.js";
import { loadOrCreateIdentity } from "../../electron/src/identity.js";
import { mkdir } from "node:fs/promises";
import { PublicControllerWireClient } from "../../controller/src/wire.js";
import { writePersistentStateFile } from "../../electron/src/persistent-state-file.js";
import { SURF_ACE_LOCKLESS_V1_CAPABILITY } from "../../protocol/src/lockless.js";
import { SurfaceCore } from "../../electron/src/surface-core.js";
import { SurfaceWsServer } from "../../electron/src/ws-server.js";
import { BonjourAdvertiser } from "../../electron/src/bonjour-advertiser.js";
import { OpenClawLocklessController } from "../../extension/src/openclaw-lockless-controller.js";
import {
  createBonjourSurfAceDiscoveryService,
  type SurfAceDiscoveryService,
} from "../../extension/src/surf-ace-discovery.js";


import {
  AllocatorError,
  canonicalJson,
  AllocatorServer,
  PersistenceOutcomeUnknownError,
  PostgresCustodyAdapter,
  WindowLabelAuthority,
  revokeWriter,
  type AcceptedState,
  type AllocatorServerConfig,
  type Assignment,
  type PostgresCustodyConfig,
  type RestoreSnapshot,
} from "./index.js";

const execFile = promisify(execFileCallback);
const postgresBin = process.platform === "darwin"
  ? "/opt/homebrew/opt/postgresql@16/bin"
  : "/usr/lib/postgresql/16/bin";
const { Client } = pg;

type TestCluster = {
  adminUrl: string;
  config: PostgresCustodyConfig;
  recoveryUrl: string;
  root: string;
  stop: () => Promise<void>;
  writerUrl: string;
};

test("real PostgreSQL allocator authority", { timeout: 180_000 }, async (t) => {
  const cluster = await startCluster();
  const allocatorId = "alloc_test-primary";
  let server: AllocatorServer | null = null;
  try {
    await t.test("brand-new fleet initialization is synchronous and permanently one-shot", async () => {
      const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, allocatorId);
      const state = await recovery.readAcceptedState();
      assert.equal(state.nextOrdinalFence, 0);
      assert.equal(state.allocatorId, allocatorId);
      await recovery.release();
      await assert.rejects(
        PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_forbidden"),
        (error) => error instanceof AllocatorError && error.code === "assignment_conflict",
      );
    });

    await t.test("runtime roles cannot bypass security-definer authority", async () => {
      const writer = new Client({ connectionString: cluster.writerUrl });
      const recovery = new Client({ connectionString: cluster.recoveryUrl });
      const witness = new Client({ connectionString: cluster.config.witnessUrl });
      await Promise.all([writer.connect(), recovery.connect(), witness.connect()]);
      const permissionDenied = (error: unknown) => typeof error === "object" && error !== null
        && "code" in error && error.code === "42501";
      try {
        await assert.rejects(
          writer.query("SELECT * FROM surf_ace_allocator.fleets"),
          permissionDenied,
        );
        await assert.rejects(
          recovery.query("SELECT surf_ace_allocator.bind_authority(null, null, null, null, null)"),
          permissionDenied,
        );
        await assert.rejects(
          witness.query("SELECT surf_ace_allocator.read_accepted_state(null)"),
          permissionDenied,
        );
        await assert.rejects(
          witness.query("SELECT * FROM pg_control_system()"),
          permissionDenied,
        );
        const allowed = await witness.query(
          "SELECT fleet_id FROM surf_ace_allocator.read_head_witness(null)",
        );
        assert.equal(allowed.rowCount, 0);
        const memberships = await Promise.all([
          writer.query<{ allowed: boolean }>(
            "SELECT pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS allowed",
          ),
          recovery.query<{ allowed: boolean }>(
            "SELECT pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS allowed",
          ),
        ]);
        assert.equal(memberships[0].rows[0]?.allowed, false);
        assert.equal(memberships[1].rows[0]?.allowed, false);
      } finally {
        await Promise.all([writer.end(), recovery.end(), witness.end()]);
      }
    });

    await t.test("two WebSocket clients with colliding surfaceIds never receive a duplicate label", async () => {
      server = await AllocatorServer.start(serverConfig(cluster));
      const clientA = await WireClient.connect(server.address.url);
      const clientB = await WireClient.connect(server.address.url);
      try {
        const a = identity("a");
        const b = identity("b");
        await Promise.all([
          clientA.request("authority.bind", bindPayload(cluster.config.fleetId, a)),
          clientB.request("authority.bind", bindPayload(cluster.config.fleetId, b)),
        ]);
        const claims = [];
        for (let index = 1; index <= 20; index += 1) {
          const surfaceId = `sf_${String(index).padStart(16, "0")}`;
          claims.push(clientA.request("label.claim", claimPayload(cluster.config.fleetId, allocatorId, a, surfaceId)));
          claims.push(clientB.request("label.claim", claimPayload(cluster.config.fleetId, allocatorId, b, surfaceId)));
        }
        const responses = await Promise.all(claims);
        const labels = responses.map(successLabel);
        assert.equal(labels.length, 40);
        assert.equal(new Set(labels).size, labels.length, `DUPLICATE WINDOW LABEL: ${labels.join(",")}`);
        const diagnostics = await server.diagnostics();
        assert.equal(diagnostics.assignmentCount, 40);
        assert.equal(diagnostics.nextOrdinalFence, 40);
      } finally {
        await Promise.all([clientA.close(), clientB.close()]);
      }
    });

    await t.test("controller connection claims two labels and preserves identity on reconnect", async () => {
      assert.ok(server);
      const clientA = new PublicControllerWireClient(server.address.url);
      const clientB = new PublicControllerWireClient(server.address.url);
      const a = {
        ...claimPayload(cluster.config.fleetId, allocatorId, identity("c"), "sf_client-shared"),
      };
      const b = {
        ...claimPayload(cluster.config.fleetId, allocatorId, identity("d"), "sf_client-shared"),
      };
      try {
        const [first, second] = await Promise.all([
          clientA.connectAllocatorSurface(a),
          clientB.connectAllocatorSurface(b),
        ]);
        assert.notEqual(first.windowLabel, second.windowLabel);
        assert.equal(first.authorityId, a.authorityId);
        assert.equal(second.authorityId, b.authorityId);
        assert.equal(first.surfaceId, second.surfaceId);
        const before = await server.diagnostics();
        await clientA.close();
        const resumed = await clientA.connectAllocatorSurface(a, first);
        for (const key of Object.keys(first) as (keyof typeof first)[]) {
          assert.equal(resumed[key], first[key]);
        }
        assert.equal((await server.diagnostics()).assignmentCount, before.assignmentCount);
        assert.equal((await server.diagnostics()).nextOrdinalFence, before.nextOrdinalFence);
        await assert.rejects(
          clientA.connectAllocatorSurface({ ...a, expectedAllocatorId: "alloc_wrong" }),
          /allocator_request_rejected:authority.bind:allocator_identity_mismatch/,
        );
        await assert.rejects(
          clientA.connectAllocatorSurface({ ...a, ownerAnchorId: b.ownerAnchorId }),
          /allocator_request_rejected:authority.bind:authority_ownership_conflict/,
        );
        await assert.rejects(
          clientA.connectAllocatorSurface(a, {
            committed: true,
            ordinal: second.ordinal,
            windowLabel: second.windowLabel,
          }),
          /allocator_request_rejected:label.reconfirm:assignment_conflict/,
        );
        t.diagnostic(JSON.stringify({ first, second, resumed }));
      } finally {
        await Promise.all([clientA.close(), clientB.close()]);
        // A contradictory reconfirm deliberately closes the authority to claims.
        // Restart the fixture before the next independent allocator scenario.
        await server.close();
        server = await AllocatorServer.start(serverConfig(cluster));
      }
    });

    await t.test("concurrent same-key claims and request replay are idempotent", async () => {
      assert.ok(server);
      const client = await WireClient.connect(server.address.url);
      try {
        const owner = identity("a");
        const payload = claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_same-key");
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, index) => client.request("label.claim", payload, `rq_same_${index}`)),
        );
        assert.equal(new Set(results.map(successLabel)).size, 1);
        const assigned = results[0]!.payload as Record<string, unknown>;
        const reconfirmed = await client.request("label.reconfirm", {
          ...payload,
          expectedAssignment: {
            committed: true,
            ordinal: assigned.ordinal,
            windowLabel: assigned.windowLabel,
          },
        });
        assert.equal((reconfirmed.payload as Record<string, unknown>).confirmation, "confirmed");
        const replay = await client.request("label.claim", payload, "rq_replay");
        const replayAgain = await client.request("label.claim", payload, "rq_replay");
        assert.deepEqual(replayAgain, replay);
        const misuse = await client.request("label.claim", { ...payload, surfaceId: "sf_other" }, "rq_replay");
        assert.equal(errorCode(misuse), "invalid_request_id_reuse");
      } finally {
        await client.close();
      }
    });

    await t.test("restart preserves mappings and continues above the durable fence", async () => {
      assert.ok(server);
      const before = await server.diagnostics();
      await server.close();
      server = await AllocatorServer.start(serverConfig(cluster));
      const client = await WireClient.connect(server.address.url);
      try {
        const owner = identity("a");
        const repeated = await client.request(
          "label.claim",
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_same-key"),
        );
        const fresh = await client.request(
          "label.claim",
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_after-restart"),
        );
        assert.ok(successOrdinal(fresh) >= before.nextOrdinalFence);
        assert.notEqual(successLabel(repeated), successLabel(fresh));
      } finally {
        await client.close();
      }
    });

    await t.test("journal bytes are canonical and every SHA-256 head link verifies", async () => {
      const client = new Client({ connectionString: cluster.adminUrl });
      await client.connect();
      try {
        const result = await client.query<{
          event: never;
          event_bytes: Buffer;
          head_hash: Buffer;
          previous_head_hash: Buffer;
        }>("SELECT event, event_bytes, head_hash, previous_head_hash FROM surf_ace_allocator.custody_journal ORDER BY head_seq");
        assert.ok(result.rows.length > 0);
        let prior = Buffer.alloc(32);
        for (const row of result.rows) {
          assert.deepEqual(row.previous_head_hash, prior);
          assert.equal(row.event_bytes.toString("utf8"), canonicalJson(row.event));
          const computed = createHash("sha256").update(prior).update(row.event_bytes).digest();
          assert.deepEqual(row.head_hash, computed);
          prior = row.head_hash;
        }
      } finally {
        await client.end();
      }
    });

    await t.test("live WebSocket bind and claim resolve post-commit unknown outcomes", async () => {
      assert.ok(server);
      await server.close();
      server = null;
      let bindCut = false;
      let reserveCut = false;
      let mappingCut = false;
      server = await AllocatorServer.start(serverConfig(cluster), {
        afterCommitBeforeWitness(operation) {
          if (operation === "bind_authority" && !bindCut) {
            bindCut = true;
            throw new Error("cut-after-bind-commit");
          }
          if (operation === "reserve_ordinal" && !reserveCut) {
            reserveCut = true;
            throw new Error("cut-after-reserve-commit");
          }
          if (operation === "commit_mapping" && !mappingCut) {
            mappingCut = true;
            throw new Error("cut-after-mapping-commit");
          }
        },
      });
      const client = await WireClient.connect(server.address.url);
      const owner = identity("c");
      try {
        const bound = await client.request(
          "authority.bind",
          bindPayload(cluster.config.fleetId, owner),
          "rq_unknown_bind",
        );
        assert.equal(bound.ok, true, JSON.stringify(bound));
        assert.equal(bindCut, true);
        const claimed = await client.request(
          "label.claim",
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_ws_reserved_unknown_mapping"),
          "rq_reserved_unknown_mapping",
        );
        const ordinal = successOrdinal(claimed);
        assert.equal(reserveCut, true);
        assert.equal(mappingCut, true);
        const repeated = await client.request(
          "label.claim",
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_ws_reserved_unknown_mapping"),
          "rq_reserved_unknown_mapping_repeat",
        );
        assert.equal(successOrdinal(repeated), ordinal);
        const diagnostics = await server.diagnostics();
        assert.equal(diagnostics.serveStatus, "serving");
      } finally {
        await client.close();
      }
    });

    await t.test("live WebSocket burns a reserved recovery after clear mapping failure", async () => {
      assert.ok(server);
      await server.close();
      server = null;
      let reserveCut = false;
      let mappingFailed = false;
      server = await AllocatorServer.start(serverConfig(cluster), {
        afterCommitBeforeWitness(operation) {
          if (operation === "reserve_ordinal" && !reserveCut) {
            reserveCut = true;
            throw new Error("cut-after-reserve-commit");
          }
        },
        beforeMutation(operation) {
          if (operation === "commit_mapping" && !mappingFailed) {
            mappingFailed = true;
            throw new Error("clear-before-recovery-mapping");
          }
        },
      });
      const client = await WireClient.connect(server.address.url);
      const owner = identity("c");
      try {
        const before = await server.diagnostics();
        const failed = await client.request(
          "label.claim",
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_ws_recovery_burn"),
          "rq_recovery_burn",
        );
        assert.equal(errorCode(failed), "persistence_failed");
        assert.equal(reserveCut, true);
        assert.equal(mappingFailed, true);
        const after = await server.diagnostics();
        assert.equal(after.burnedOrdinalCount, before.burnedOrdinalCount + 1);
        assert.equal(after.nextOrdinalFence, before.nextOrdinalFence + 1);
        assert.equal(after.serveStatus, "serving");
        assert.equal(
          await scalar(cluster.adminUrl,
            "SELECT status FROM surf_ace_allocator.allocation_transactions WHERE surface_id = 'sf_ws_recovery_burn' ORDER BY ordinal DESC LIMIT 1"),
          "burned",
        );
        const next = await client.request(
          "label.claim",
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_ws_after_recovery_burn"),
          "rq_after_recovery_burn",
        );
        assert.ok(successOrdinal(next) >= after.nextOrdinalFence);
      } finally {
        await client.close();
      }
    });

    await t.test("clear reserve failure changes neither ledger nor fence", async () => {
      assert.ok(server);
      await server.close();
      server = null;
      let injected = false;
      const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config, {
        beforeMutation(operation) {
          if (operation === "reserve_ordinal" && !injected) {
            injected = true;
            throw new Error("clear-before-reserve");
          }
        },
      });
      try {
        const before = await writer.readAcceptedState();
        const owner = identity("a");
        await assert.rejects(
          writer.reserve("tx_clear_reserve", owner.authorityId, owner.ownerAnchorId, "sf_clear-reserve"),
          (error) => error instanceof AllocatorError && error.code === "persistence_failed",
        );
        const after = await writer.readAcceptedState();
        assert.equal(after.nextOrdinalFence, before.nextOrdinalFence);
        assert.equal(await writer.queryTransaction("tx_clear_reserve"), null);
      } finally {
        await writer.release();
      }
    });

    await t.test("unknown reserve is resolved by transactionId without ordinal reuse", async () => {
      let injected = false;
      const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config, {
        afterCommitBeforeWitness(operation) {
          if (operation === "reserve_ordinal" && !injected) {
            injected = true;
            throw new Error("cut-after-reserve-commit");
          }
        },
      });
      const owner = identity("a");
      await assert.rejects(
        writer.reserve("tx_unknown_reserve", owner.authorityId, owner.ownerAnchorId, "sf_unknown-reserve"),
        (error) => error instanceof PersistenceOutcomeUnknownError,
      );
      await writer.terminate();
      const resumed = await PostgresCustodyAdapter.acquireWriter(cluster.config);
      try {
        const transaction = await resumed.queryTransaction("tx_unknown_reserve");
        assert.equal(transaction?.status, "reserved");
        const mapping = await resumed.commitMapping("tx_unknown_reserve");
        const next = await resumed.reserve(
          "tx_after_unknown",
          owner.authorityId,
          owner.ownerAnchorId,
          "sf_after-unknown",
        );
        assert.ok(next.ordinal > mapping.ordinal);
      } finally {
        await resumed.release();
      }
    });

    await t.test("unknown mapping commit resolves to the one durable assignment", async () => {
      let injected = false;
      const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config, {
        afterCommitBeforeWitness(operation) {
          if (operation === "commit_mapping" && !injected) {
            injected = true;
            throw new Error("cut-after-mapping-commit");
          }
        },
      });
      const owner = identity("a");
      const authority = new WindowLabelAuthority(writer);
      const resolved = await authority.claim(
        claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_unknown-mapping"),
      );
      try {
        const unknownState = await writer.readAcceptedState();
        const transaction = unknownState.transactions.find((entry) => entry.surfaceId === "sf_unknown-mapping");
        assert.equal(transaction?.status, "committed");
        assert.ok(transaction);
        assert.equal(resolved.ordinal, transaction.ordinal);
        assert.equal(authority.serveStatus, "serving");
        const repeated = await authority.claim(
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_unknown-mapping"),
        );
        assert.equal(repeated.ordinal, resolved.ordinal);
        const later = await authority.claim(
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_after-resolved-mapping"),
        );
        assert.ok(later.ordinal > resolved.ordinal);
      } finally {
        await writer.release();
      }
    });

    await t.test("clear mapping failure burns the reservation before failure", async () => {
      let injected = false;
      const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config, {
        beforeMutation(operation) {
          if (operation === "commit_mapping" && !injected) {
            injected = true;
            throw new Error("clear-before-mapping");
          }
        },
      });
      const authority = new WindowLabelAuthority(writer);
      const owner = identity("a");
      try {
        const before = await writer.readAcceptedState();
        await assert.rejects(
          authority.claim(claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_burned")),
          (error) => error instanceof AllocatorError && error.code === "persistence_failed",
        );
        const after = await writer.readAcceptedState();
        const burned = after.transactions.find((entry) => entry.surfaceId === "sf_burned");
        assert.equal(burned?.status, "burned");
        assert.equal(after.nextOrdinalFence, before.nextOrdinalFence + 1);
        assert.equal(after.mappings.some((entry) => entry.ordinal === burned?.ordinal), false);
        const next = await authority.claim(
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_after-burn"),
        );
        assert.ok(burned && next.ordinal > burned.ordinal);
      } finally {
        await writer.release();
      }
    });

    await t.test("writer/recovery exclusion, exact-generation revocation, and stale token rejection", async () => {
      const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config);
      await assert.rejects(
        PostgresCustodyAdapter.acquireRecovery(cluster.config),
        (error) => error instanceof AllocatorError && error.code === "writer_fence_unavailable",
      );
      await assert.rejects(
        revokeWriter(cluster.recoveryUrl, cluster.config.fleetId, writer.token.leaseGeneration + 1),
        (error) => error instanceof AllocatorError && error.code === "writer_fence_unavailable",
      );
      const terminatedPid = await revokeWriter(
        cluster.recoveryUrl,
        cluster.config.fleetId,
        writer.token.leaseGeneration,
      );
      assert.ok(terminatedPid > 0);
      await assert.rejects(writer.readAcceptedState());
      const recovery = await PostgresCustodyAdapter.acquireRecovery(cluster.config);
      await recovery.release();
      await writer.terminate();
    });

    await t.test("older snapshot is validated, replayed, and activated atomically", async () => {
      const owner = identity("a");
      const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config);
      let snapshotState: AcceptedState;
      let laterState: AcceptedState;
      let replayedMapping: Assignment;
      try {
        snapshotState = await writer.readAcceptedState();
        replayedMapping = await new WindowLabelAuthority(writer).claim(
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_after_snapshot"),
        );
        laterState = await writer.readAcceptedState();
        assert.ok(laterState.headSeq > snapshotState.headSeq);
        assert.ok(laterState.nextOrdinalFence > snapshotState.nextOrdinalFence);
      } finally {
        await writer.release();
      }

      const recovery = await PostgresCustodyAdapter.acquireRecovery(cluster.config);
      try {
        const snapshot = restoreSnapshot(snapshotState);
        const tamperedGeneration = "restore_tampered_" + Date.now();
        const tampered = {
          ...snapshot,
          mappings: snapshot.mappings.map((mapping, index) => index === 0
            ? { ...mapping, windowLabel: mapping.windowLabel + "z" }
            : mapping),
        };
        let witness = await recovery.readWitness();
        await recovery.stageRestore(
          tamperedGeneration,
          "restore_tampered_idem_" + Date.now(),
          tampered,
          witness,
        );
        await assert.rejects(recovery.markRestoreReady(tamperedGeneration));
        await recovery.discardRestore(tamperedGeneration);

        const revisionGeneration = "restore_revision_tampered_" + Date.now();
        const revisionTampered = {
          ...snapshot,
          custodyRevision: snapshot.custodyRevision + 1,
        };
        witness = await recovery.readWitness();
        await recovery.stageRestore(
          revisionGeneration,
          "restore_revision_tampered_idem_" + Date.now(),
          revisionTampered,
          witness,
        );
        await assert.rejects(recovery.markRestoreReady(revisionGeneration));
        await recovery.discardRestore(revisionGeneration);

        witness = await recovery.readWitness();
        const generationId = "restore_" + Date.now();
        await recovery.stageRestore(
          generationId,
          "restore_idem_" + Date.now(),
          snapshot,
          witness,
        );
        const preparing = await recovery.readAcceptedState();
        assert.equal(preparing.acceptedGenerationId, snapshotState.acceptedGenerationId);
        const ready = await recovery.markRestoreReady(generationId);
        assert.equal(ready.computedFence, laterState.nextOrdinalFence);
        const stillPrior = await recovery.readAcceptedState();
        assert.equal(stillPrior.acceptedGenerationId, snapshotState.acceptedGenerationId);
        await recovery.activateRestore(generationId, ready);
        const activated = await recovery.readAcceptedState();
        assert.equal(activated.acceptedGenerationId, generationId);
        assert.equal(activated.nextOrdinalFence, laterState.nextOrdinalFence);
        const restored = activated.mappings.find(
          (mapping) => mapping.surfaceId === replayedMapping.surfaceId,
        );
        assert.equal(restored?.ordinal, replayedMapping.ordinal);
        assert.equal(restored?.windowLabel, replayedMapping.windowLabel);
        assert.ok(restored?.recoveredAtCustodyRevision !== null);
        assert.deepEqual(
          activated.mappings.map(({ authorityId, ordinal, surfaceId, windowLabel }) => ({ authorityId, ordinal, surfaceId, windowLabel })),
          laterState.mappings.map(({ authorityId, ordinal, surfaceId, windowLabel }) => ({ authorityId, ordinal, surfaceId, windowLabel })),
        );
      } finally {
        await recovery.release();
      }
      const resumed = await PostgresCustodyAdapter.acquireWriter(cluster.config);
      try {
        const authority = new WindowLabelAuthority(resumed);
        const confirmation = await authority.reconfirm({
          ...claimPayload(cluster.config.fleetId, allocatorId, owner, replayedMapping.surfaceId),
          expectedAssignment: {
            committed: true,
            ordinal: replayedMapping.ordinal,
            windowLabel: replayedMapping.windowLabel,
          },
        });
        assert.equal(confirmation.confirmation, "recovered");
        const next = await authority.claim(
          claimPayload(cluster.config.fleetId, allocatorId, owner, "sf_after_restore"),
        );
        assert.ok(next.ordinal >= laterState.nextOrdinalFence);
      } finally {
        await resumed.release();
      }
    });

    await t.test("duplicate application_name and wrong witness endpoint fail closed", async () => {
      const duplicate = await addStandby(cluster, "duplicate_slot", "witness-duplicate", "surf_ace_witness");
      try {
        await waitFor(async () => await senderCount(cluster.adminUrl, "surf_ace_witness") === 2);
        await assert.rejects(
          PostgresCustodyAdapter.acquireWriter(cluster.config),
          (error) => error instanceof AllocatorError && error.code === "writer_fence_unavailable",
        );
      } finally {
        await duplicate.stop();
      }
      await waitFor(async () => await senderCount(cluster.adminUrl, "surf_ace_witness") === 1);
      const wrong = await addStandby(cluster, "wrong_endpoint_slot", "witness-wrong", "other_witness");
      try {
        await waitFor(async () => await senderCount(cluster.adminUrl, "other_witness") === 1);
        await assert.rejects(
          PostgresCustodyAdapter.acquireWriter({ ...cluster.config, witnessUrl: wrong.url }),
          (error) => error instanceof AllocatorError && error.code === "writer_fence_unavailable",
        );
      } finally {
        await wrong.stop();
      }
    });
  } finally {
    if (server) await server.close().catch(() => undefined);
    await cluster.stop();
  }
});

test("central provider assigns discovered clients, persists labels and reconnects", { timeout: 90_000 }, async (t) => {
  const cluster = await startCluster();
  const prefix = `surf-ace-fixture-${randomUUID()}`;
  const allocatorId = "alloc_discovery-test";
  const servers: SurfaceWsServer[] = [];
  const publishers: BonjourAdvertiser[] = [];
  const wires: PublicControllerWireClient[] = [];
  const fixtures: Array<{ core: SurfaceCore; stateDir: string; port: number; surfaceId: string }> = [];
  const discovery = createBonjourSurfAceDiscoveryService({ timeoutMs: 1500 });
  // Only admit this test's advertisements. Endpoint host/port/path still come
  // exclusively from the production Bonjour browser, never from the fixture.
  const select = () => discovery.getSnapshot().filter((endpoint) =>
    endpoint.instanceName.startsWith(prefix));
  const isolatedDiscovery: SurfAceDiscoveryService = {
    getSnapshot: select,
    refreshNow: () => discovery.refreshNow(),
    start: () => discovery.start(),
    stop: () => discovery.stop(),
    subscribe: (listener) => discovery.subscribe(() => listener(select())),
  };
  let controller: OpenClawLocklessController | null = null;
  let allocator: AllocatorServer | null = null;
  try {
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, allocatorId);
    await recovery.release();
    allocator = await AllocatorServer.start(serverConfig(cluster));
    const binding = {
      url: allocator.address.url,
      fleetId: (await allocator.diagnostics()).fleetId,
      expectedAllocatorId: (await allocator.diagnostics()).allocatorId,
    };
    controller = new OpenClawLocklessController({
      allocator: binding, discovery: isolatedDiscovery,
      stateDir: join(cluster.root, "controller"),
    });
    await controller.start();
    assert.deepEqual(await controller.listScreens(), []);

    for (const character of ["e", "f"]) {
      const core = new SurfaceCore();
      const name = `${prefix}-${character}`;
      const viewport = { height: 800, scale: 1, width: 1200 };
      const surface = core.ensurePrimarySurface(name, viewport);
      const port = await freePort();
      const stateDir = join(cluster.root, `surface-${character}`);
      fixtures.push({ core, stateDir, port, surfaceId: surface.surfaceId });
      const server = new SurfaceWsServer({
        persistLocklessState: () => writePersistentStateFile(stateDir, "state.json", core.getPersistentState()),
        bindAddress: "0.0.0.0",
        capturePaneImage: async () => null,
        compositorSocketPath: null,
        core,
        endpointName: name,
        hostName: "localhost",
        port,
        viewport: () => viewport,
      });
      servers.push(server);
      await server.start();
      const publisher = new BonjourAdvertiser({
        name,
        port,
        txtProvider: () => ({
          v: "1", cap: "31", name, pk: character.repeat(16),
          ws: server.wsPath, w: "1200", h: "800", s: "1", busy: "0",
        }),
      });
      publishers.push(publisher);
      publisher.start();
    }
    const deadline = Date.now() + 25_000;
    while (select().length !== 2 && Date.now() < deadline) {
      await discovery.refreshNow();
    }
    assert.equal(select().length, 2, "both real Bonjour advertisements must resolve");
    const screens = await controller.listScreens();
    assert.equal(screens.length, 2);
    assert.equal(new Set(screens.map((screen) => screen.endpointId)).size, 2);
    assert.equal(new Set(screens.map((screen) => screen.windowLabel)).size, 2);
    const addresses: string[] = [];
    for (const screen of screens) {
      const fixture = fixtures.find((entry) => entry.surfaceId === screen.fingerprint)!;
      const persisted = JSON.parse(await readFile(join(fixture.stateDir, "state.json"), "utf8"));
      assert.equal(persisted.surfaces.find((entry: any) => entry.surfaceId === screen.fingerprint).windowLabel, screen.windowLabel);
      assert.equal(fixture.core.getRendererWindowState(screen.fingerprint).windowLabel, screen.windowLabel);
      assert.ok(screen.topology);
      assert.ok(screen.panes.length > 0);
      for (const pane of screen.panes) {
        assert.equal(pane.paneAddress, `${screen.windowLabel}${pane.paneLabel}`);
        assert.equal(pane.displayId, pane.paneAddress);
        addresses.push(pane.paneAddress);
      }
    }
    assert.equal(new Set(addresses).size, addresses.length);
    const before = await allocator.diagnostics();
    // Same provider reconnect retains committed receipts and reconfirms them.
    await controller.stop();
    await controller.start();
    assert.deepEqual((await controller.listScreens()).map((screen) => screen.windowLabel).sort(),
      screens.map((screen) => screen.windowLabel).sort());
    assert.equal((await allocator.diagnostics()).nextOrdinalFence, before.nextOrdinalFence);
    const identityBefore = await readFile(join(cluster.root, "controller", "lockless-controller-identity.json"), "utf8");
    // Restart the allocator transport and provider using their existing durable
    // stores. Claim replay must recover the same assignments without new labels.
    await controller.stop();
    await allocator.close();
    allocator = await AllocatorServer.start(serverConfig(cluster));
    controller = new OpenClawLocklessController({
      allocator: { ...binding, url: allocator.address.url },
      discovery: isolatedDiscovery, stateDir: join(cluster.root, "controller"),
    });
    await controller.start();
    const resumed = await controller.listScreens();
    assert.deepEqual(resumed.map(({ fingerprint, windowLabel }) => ({ fingerprint, windowLabel })).sort((a,b) => a.fingerprint.localeCompare(b.fingerprint)),
      screens.map(({ fingerprint, windowLabel }) => ({ fingerprint, windowLabel })).sort((a,b) => a.fingerprint.localeCompare(b.fingerprint)));
    assert.equal(await readFile(join(cluster.root, "controller", "lockless-controller-identity.json"), "utf8"), identityBefore);
    assert.equal((await allocator.diagnostics()).assignmentCount, before.assignmentCount);
    assert.equal((await allocator.diagnostics()).nextOrdinalFence, before.nextOrdinalFence);

    const fixture = fixtures[0]!;
    const wire = new PublicControllerWireClient(`ws://127.0.0.1:${fixture.port}/ws`);
    wires.push(wire);
    await wire.connect();
    assert.equal((await wire.request("pair.request", {
      controllerInstanceId: "ci_fixture-rejection", controllerProductName: "Clawline",
      protocolFeatures: [SURF_ACE_LOCKLESS_V1_CAPABILITY], protocolVersion: 1,
      projectionCapacityBytes: 5 * 1024 * 1024, surfaceId: fixture.surfaceId,
    })).ok, true);
    const priorLabel = fixture.core.getRendererWindowState(fixture.surfaceId).windowLabel;
    assert.equal((await wire.request("surface.window.label.apply", {
      surfaceId: fixture.surfaceId, windowLabel: "BAD",
    })).ok, false);
    const wrongSurface = await wire.request("surface.window.label.apply", {
      surfaceId: fixtures[1]!.surfaceId, windowLabel: "z",
    });
    assert.equal(wrongSurface.ok, false);
    assert.equal(fixture.core.getRendererWindowState(fixture.surfaceId).windowLabel, priorLabel);
    const persistedAfter = JSON.parse(await readFile(join(fixture.stateDir, "state.json"), "utf8"));
    assert.equal(persistedAfter.surfaces.find((entry: any) => entry.surfaceId === fixture.surfaceId).windowLabel, priorLabel);
    await controller.stop();
    controller = new OpenClawLocklessController({
      allocator: { ...binding, url: allocator.address.url, expectedAllocatorId: "alloc_wrong" },
      discovery: isolatedDiscovery, stateDir: join(cluster.root, "controller"),
    });
    await controller.start();
    assert.deepEqual(await controller.listScreens(), [], "mismatched allocator cannot expose admitted fleet topology");
    assert.equal((await allocator.diagnostics()).assignmentCount, before.assignmentCount);
    t.diagnostic(JSON.stringify({ assignments: before.assignmentCount, fence: before.nextOrdinalFence, reconnect: "same provider identity, labels and fence" }));
    t.diagnostic(JSON.stringify({ discovered: select().map(({ endpointId }) => endpointId),
      topology: screens.map(({ fingerprint, windowLabel, topology, panes }) => ({
        fingerprint, windowLabel, topology,
        panes: panes.map(({ paneId, paneAddress }) => ({ paneId, paneAddress })),
      })) }));
  } finally {
    await controller?.stop();
    await Promise.all(publishers.map((publisher) => publisher.stop()));
    await Promise.all(wires.map((wire) => wire.close()));
    await Promise.all(servers.map((server) => server.stop()));
    if (allocator) await allocator.close();
    await cluster.stop();
  }
});

test("configured server registers two stable clients and deduplicates reconnect", { timeout: 90_000 }, async () => {
  const cluster = await startCluster();
  let allocator: AllocatorServer | null = null;
  const clients: ConfiguredServerRegistration[] = [];
  let reader: PublicControllerWireClient | null = null;
  try {
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_registration-test");
    await recovery.release();
    allocator = await AllocatorServer.start(serverConfig(cluster));
    const fixtures = [];
    for (const name of ["one", "two"]) {
      const stateDir = join(cluster.root, name);
      await mkdir(stateDir);
      const identity = await loadOrCreateIdentity(stateDir);
      const clientId = registrationClientId(identity.publicKeyPem);
      const core = new SurfaceCore();
      const surface = core.ensurePrimarySurface(name, { width: 800, height: 600 });
      if (name === "two") core.createAdditionalSurface("second window", { width: 800, height: 600 });
      const persist = () => writePersistentStateFile(stateDir, "state.json", core.getPersistentState());
      const client = new ConfiguredServerRegistration(allocator.address.url, clientId, core, persist);
      clients.push(client);
      await client.synchronize();
      fixtures.push({ stateDir, clientId, core, surface, persist });
    }
    reader = new PublicControllerWireClient(allocator.address.url);
    await reader.connect();
    const topology = async () => {
      const response = await reader!.request("fleet.topology");
      assert.equal(response.ok, true);
      return response.payload as { clients: Array<{ clientId: string; surfaces: Array<{ windowLabel: string; panes: Array<{ paneAddress: string }> }> }> };
    };
    const first = await topology();
    assert.equal(first.clients.length, 2);
    assert.deepEqual(first.clients.flatMap((client) => client.surfaces.map((surface) => surface.panes[0].paneAddress)).sort(), ["a1", "b1", "c1"]);
    for (const fixture of fixtures) {
      const stored = JSON.parse(await readFile(join(fixture.stateDir, "state.json"), "utf8"));
      for (const surface of stored.surfaces) assert.equal(surface.windowLabel, fixture.core.getSurface(surface.surfaceId).windowLabel);
    }
    const before = await allocator.diagnostics();
    await clients[0].stop();
    const restoredIdentity = await loadOrCreateIdentity(fixtures[0].stateDir);
    assert.equal(registrationClientId(restoredIdentity.publicKeyPem), fixtures[0].clientId);
    const reconnect = new ConfiguredServerRegistration(
      allocator.address.url, fixtures[0].clientId, fixtures[0].core, fixtures[0].persist,
    );
    clients.push(reconnect);
    await reconnect.synchronize();
    await reconnect.synchronize();
    assert.deepEqual(await topology(), first);
    assert.equal((await allocator.diagnostics()).assignmentCount, before.assignmentCount);
    assert.equal((await allocator.diagnostics()).nextOrdinalFence, before.nextOrdinalFence);
    await Promise.all([reconnect.synchronize(), clients[1].synchronize()]);
    assert.deepEqual(await topology(), first);
    const rejected = await reader.request("client.register", { clientId: "", surfaces: [] });
    assert.equal(rejected.ok, false);
    assert.deepEqual(await topology(), first);
  } finally {
    for (const client of clients) await client.stop();
    await reader?.close();
    await allocator?.close();
    await cluster.stop();
  }
});

test("configured-first server Bonjour fallback registers and persists clients", { timeout: 90_000 }, async () => {
  const cluster = await startCluster();
  let allocator: AllocatorServer | null = null;
  const clients: ServerConnection[] = [];
  let central: Awaited<ReturnType<typeof startCentralServer>> | null = null;
  const prefix = "surf-ace-server-fixture-" + randomUUID();
  const browsers: SurfAceDiscoveryService[] = [];
  let discoveryStarts = 0;
  let allowConfigured = true;
  let configuredAccepts = 0;
  const routeSockets = new Set<Socket>();
  const route = createServer((socket) => {
    if (!allowConfigured || !allocator) { socket.destroy(); return; }
    configuredAccepts++;
    const upstream = createConnection({ host: "127.0.0.1", port: allocator.address.port });
    routeSockets.add(socket);
    routeSockets.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => { routeSockets.delete(socket); upstream.destroy(); });
    upstream.on("close", () => { routeSockets.delete(upstream); socket.destroy(); });
    socket.pipe(upstream).pipe(socket);
  });
  const discover = (): SurfAceDiscoveryService => {
    const service = createBonjourSurfAceDiscoveryService({ timeoutMs: 2000 });
    browsers.push(service);
    return {
      getSnapshot: () => service.getSnapshot().filter((endpoint) => endpoint.instanceName === prefix),
      start: async () => { discoveryStarts++; await service.start(); },
      stop: () => service.stop(),
      refreshNow: () => service.refreshNow(),
      subscribe: (listener) => service.subscribe(() => listener(service.getSnapshot().filter((endpoint) => endpoint.instanceName === prefix))),
    };
  };
  let reader: PublicControllerWireClient | null = null;
  try {
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_registration-test");
    await recovery.release();
    const missing = new ServerConnection({
      clientId: "a".repeat(64), core: new SurfaceCore(), persist: async () => {},
      discovery: discover(), requestTimeoutMs: 500,
    });
    clients.push(missing);
    await assert.rejects(missing.synchronize(), /no_surf_ace_server/);
    await missing.stop();
    central = await startCentralServer({ ...serverConfig(cluster), listenHost: "0.0.0.0" }, prefix);
    allocator = central.server;
    await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
    const routeAddress = route.address();
    assert.ok(routeAddress && typeof routeAddress !== "string");
    const configuredUrl = `ws://127.0.0.1:${routeAddress.port}`;
    const fixtures = [];
    for (const name of ["one", "two"]) {
      const stateDir = join(cluster.root, name);
      await mkdir(stateDir);
      const identity = await loadOrCreateIdentity(stateDir);
      const clientId = registrationClientId(identity.publicKeyPem);
      const core = new SurfaceCore();
      const surface = core.ensurePrimarySurface(name, { width: 800, height: 600 });
      if (name === "two") core.createAdditionalSurface("second window", { width: 800, height: 600 });
      const persist = () => writePersistentStateFile(stateDir, "state.json", core.getPersistentState());
      const beforeDiscovery = discoveryStarts;
      const client = new ServerConnection({
        configuredAddress: name === "one" ? configuredUrl : undefined,
        clientId, core, persist, discovery: discover(),
      });
      clients.push(client);
      // Publisher and DNS-SD may settle over more than one bounded refresh.
      for (let attempt = 0; ; attempt++) {
        try { await client.synchronize(); break; }
        catch (error) { if (attempt >= 5) throw error; }
      }
      if (name === "one") assert.equal(discoveryStarts, beforeDiscovery);
      else assert.ok(discoveryStarts > beforeDiscovery);
      fixtures.push({ stateDir, clientId, core, surface, persist });
    }
    reader = new PublicControllerWireClient(allocator.address.url);
    await reader.connect();
    const topology = async () => {
      const response = await reader!.request("fleet.topology");
      assert.equal(response.ok, true);
      return response.payload as { clients: Array<{ clientId: string; surfaces: Array<{ windowLabel: string; panes: Array<{ paneAddress: string }> }> }> };
    };
    const first = await topology();
    assert.equal(first.clients.length, 2);
    assert.deepEqual(first.clients.flatMap((client) => client.surfaces.map((surface) => surface.panes[0].paneAddress)).sort(), ["a1", "b1", "c1"]);
    for (const fixture of fixtures) {
      const stored = JSON.parse(await readFile(join(fixture.stateDir, "state.json"), "utf8"));
      for (const surface of stored.surfaces) assert.equal(surface.windowLabel, fixture.core.getSurface(surface.surfaceId).windowLabel);
    }
    const before = await allocator.diagnostics();
    await clients[1].stop();
    const restoredIdentity = await loadOrCreateIdentity(fixtures[0].stateDir);
    assert.equal(registrationClientId(restoredIdentity.publicKeyPem), fixtures[0].clientId);
    allowConfigured = false;
    let rejectRecoveryPersistence = false;
    let recoveryWrites = 0;
    let recoveryPersistenceEntered = () => {};
    let releaseRecoveryPersistence = () => {};
    let heldRecoveryPersistence: Promise<void> = Promise.resolve();
    const reconnect = new ServerConnection({
      configuredAddress: configuredUrl,
      clientId: fixtures[0].clientId, core: fixtures[0].core,
      persist: async () => {
        if (rejectRecoveryPersistence && ++recoveryWrites === 2) {
          recoveryPersistenceEntered();
          await heldRecoveryPersistence;
          throw new Error("recovery_persist_failed");
        }
        await fixtures[0].persist();
      },
      discovery: discover(), requestTimeoutMs: 500,
    });
    clients.push(reconnect);
    await reconnect.synchronize();
    await reconnect.synchronize();
    assert.deepEqual(await topology(), first);
    assert.equal((await allocator.diagnostics()).assignmentCount, before.assignmentCount);
    assert.equal((await allocator.diagnostics()).nextOrdinalFence, before.nextOrdinalFence);
    await Promise.all([reconnect.synchronize(), clients[2].synchronize()]);
    assert.deepEqual(await topology(), first);
    const initialAccepts = configuredAccepts;
    // Failed probes leave healthy fallback usable and do not consume labels.
    await reconnect.synchronize();
    assert.equal(configuredAccepts, initialAccepts);
    assert.deepEqual(await topology(), first);
    allowConfigured = true;
    rejectRecoveryPersistence = true;
    recoveryWrites = 0;
    const persistenceEntered = new Promise<void>((resolve) => { recoveryPersistenceEntered = resolve; });
    heldRecoveryPersistence = new Promise<void>((resolve) => { releaseRecoveryPersistence = resolve; });
    const recovering = reconnect.synchronize();
    await persistenceEntered;
    const mutationCore = fixtures[0].core;
    const mutationSurfaceId = fixtures[0].surface.surfaceId;
    const mutationPaneId = [...mutationCore.getSurface(mutationSurfaceId).panes.keys()][0];
    let mutationEntered = false;
    const concurrentMutation = mutationCore.locklessAuthority.transactionAsync(() =>
      mutationCore.transactionAsync(async () => {
        mutationEntered = true;
        mutationCore.paneRename(mutationSurfaceId, mutationPaneId, "concurrent-accepted-name");
        await fixtures[0].persist();
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const enteredBeforeRollback = mutationEntered;
    releaseRecoveryPersistence();
    await Promise.all([recovering, concurrentMutation]);
    assert.equal(enteredBeforeRollback, false, "accepted mutation serializes after recovery rollback");
    assert.equal(mutationCore.getSurface(mutationSurfaceId).panes.get(mutationPaneId)!.name, "concurrent-accepted-name");
    const acceptedDisk = JSON.parse(await readFile(join(fixtures[0].stateDir, "state.json"), "utf8"));
    assert.match(JSON.stringify(acceptedDisk), /concurrent-accepted-name/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(routeSockets.size, 0, "failed persistence does not promote the configured route");
    assert.deepEqual(await topology(), first);
    rejectRecoveryPersistence = false;
    allowConfigured = false;
    await reconnect.synchronize();
    assert.deepEqual(await topology(), first);
    for (let cycle = 0; cycle < 2; cycle++) {
      allowConfigured = true;
      await reconnect.synchronize();
      assert.ok(configuredAccepts > initialAccepts);
      const promotedAccepts = configuredAccepts;
      await reconnect.synchronize();
      assert.equal(configuredAccepts, promotedAccepts, "healthy configured socket is reused");
      assert.deepEqual(await topology(), first);
      assert.equal((await allocator.diagnostics()).nextOrdinalFence, before.nextOrdinalFence);
      allowConfigured = false;
      for (const socket of routeSockets) socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await reconnect.synchronize();
      assert.deepEqual(await topology(), first);
    }
    allowConfigured = true;
    await reconnect.synchronize();
    await reconnect.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(routeSockets.size, 0, "shutdown closes configured route sockets");
    const rejected = await reader.request("client.register", { clientId: "", surfaces: [] });
    assert.equal(rejected.ok, false);
    assert.deepEqual(await topology(), first);
  } finally {
    for (const client of clients) await client.stop();
    await reader?.close();
    for (const socket of routeSockets) socket.destroy();
    await new Promise<void>((resolve) => route.close(() => resolve()));
    for (const browser of browsers) await browser.stop();
    await central?.close();
    await cluster.stop();
  }
});

async function startCluster(): Promise<TestCluster> {
  const root = await mkdtemp(join(process.cwd(), ".allocator-pg-"));
  const primaryData = join(root, "primary");
  const witnessData = join(root, "witness");
  const primaryPort = await freePort();
  const witnessPort = await freePort();
  const primaryLog = join(root, "primary.log");
  const witnessLog = join(root, "witness.log");
  await run("initdb", ["-D", primaryData, "--auth=trust", "--username=postgres", "--no-instructions"]);
  await appendFile(join(primaryData, "postgresql.conf"), `
listen_addresses = '127.0.0.1'
port = ${primaryPort}
unix_socket_directories = ''
wal_level = replica
max_wal_senders = 10
max_replication_slots = 10
synchronous_standby_names = 'FIRST 1 (surf_ace_witness)'
synchronous_commit = local
fsync = on
`);
  await pgCtl(primaryData, ["-l", primaryLog, "start"]);
  const adminUrl = `postgresql://postgres@127.0.0.1:${primaryPort}/postgres`;
  try {
    await PostgresCustodyAdapter.installSchema(adminUrl);
    await adminQuery(adminUrl, `
      CREATE ROLE allocator_writer LOGIN IN ROLE surf_ace_allocator_writer;
      CREATE ROLE allocator_recovery LOGIN IN ROLE surf_ace_allocator_recovery;
      CREATE ROLE allocator_witness LOGIN IN ROLE surf_ace_allocator_witness;
      SELECT pg_create_physical_replication_slot('surf_ace_witness_slot');
    `);
    await run("pg_basebackup", [
      "-D", witnessData,
      "-d", adminUrl,
      "-R",
      "-X", "stream",
      "-S", "surf_ace_witness_slot",
    ]);
    await appendFile(join(witnessData, "postgresql.conf"), `
listen_addresses = '127.0.0.1'
port = ${witnessPort}
unix_socket_directories = ''
hot_standby = on
primary_conninfo = 'host=127.0.0.1 port=${primaryPort} user=postgres application_name=surf_ace_witness'
primary_slot_name = 'surf_ace_witness_slot'
surf_ace.witness_server_id = 'witness-primary'
`);
    await appendFile(join(witnessData, "postgresql.auto.conf"), `
primary_conninfo = 'host=127.0.0.1 port=${primaryPort} user=postgres application_name=surf_ace_witness'
primary_slot_name = 'surf_ace_witness_slot'
surf_ace.witness_server_id = 'witness-primary'
`);
    await pgCtl(witnessData, ["-l", witnessLog, "start"]);
    await adminQuery(adminUrl, "ALTER SYSTEM SET synchronous_commit = 'remote_apply'");
    await adminQuery(adminUrl, "SELECT pg_reload_conf()");
    await waitFor(async () => {
      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        const result = await client.query<{ sync_state: string }>(
          "SELECT sync_state FROM pg_stat_replication WHERE application_name = 'surf_ace_witness'",
        );
        return result.rows.length === 1 && result.rows[0]?.sync_state === "sync";
      } finally {
        await client.end();
      }
    });
    const clusterId = await scalar(adminUrl, "SELECT (pg_control_system()).system_identifier::text");
    const config: PostgresCustodyConfig = {
      expectedClusterSystemId: clusterId,
      fleetId: "fleet-test",
      primaryUrl: `postgresql://allocator_writer@127.0.0.1:${primaryPort}/postgres`,
      recoveryUrl: `postgresql://allocator_recovery@127.0.0.1:${primaryPort}/postgres`,
      witnessApplicationName: "surf_ace_witness",
      witnessPhysicalSlot: "surf_ace_witness_slot",
      witnessServerId: "witness-primary",
      witnessUrl: `postgresql://allocator_witness@127.0.0.1:${witnessPort}/postgres`,
    };
    return {
      adminUrl,
      config,
      recoveryUrl: `postgresql://allocator_recovery@127.0.0.1:${primaryPort}/postgres`,
      root,
      writerUrl: config.primaryUrl,
      async stop() {
        await pgCtl(witnessData, ["stop", "-m", "fast"]).catch(() => undefined);
        await pgCtl(primaryData, ["stop", "-m", "fast"]).catch(() => undefined);
        await rm(root, { force: true, recursive: true });
      },
    };
  } catch (error) {
    await pgCtl(witnessData, ["stop", "-m", "fast"]).catch(() => undefined);
    await pgCtl(primaryData, ["stop", "-m", "fast"]).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

async function addStandby(
  cluster: TestCluster,
  slot: string,
  serverId: string,
  applicationName: string,
): Promise<{ stop: () => Promise<void>; url: string }> {
  const data = join(cluster.root, slot);
  const log = join(cluster.root, `${slot}.log`);
  const port = await freePort();
  const primary = new URL(cluster.adminUrl);
  await adminQuery(cluster.adminUrl, `SELECT pg_create_physical_replication_slot('${slot}')`);
  await run("pg_basebackup", ["-D", data, "-d", cluster.adminUrl, "-R", "-X", "stream", "-S", slot]);
  await appendFile(join(data, "postgresql.conf"), `
listen_addresses = '127.0.0.1'
port = ${port}
unix_socket_directories = ''
hot_standby = on
primary_conninfo = 'host=127.0.0.1 port=${primary.port} user=postgres application_name=${applicationName}'
primary_slot_name = '${slot}'
surf_ace.witness_server_id = '${serverId}'
`);
  await appendFile(join(data, "postgresql.auto.conf"), `
primary_conninfo = 'host=127.0.0.1 port=${primary.port} user=postgres application_name=${applicationName}'
primary_slot_name = '${slot}'
surf_ace.witness_server_id = '${serverId}'
`);
  await pgCtl(data, ["-l", log, "start"]);
  return {
    async stop() { await pgCtl(data, ["stop", "-m", "fast"]); },
    url: `postgresql://allocator_witness@127.0.0.1:${port}/postgres`,
  };
}

function serverConfig(cluster: TestCluster): AllocatorServerConfig {
  return {
    custody: cluster.config,
    hostLockPath: join(cluster.root, "fleet-test.lock"),
    listenHost: "127.0.0.1",
    listenPort: 0,
  };
}

class WireClient {
  private counter = 0;
  private readonly pending = new Map<string, {
    reject: (error: Error) => void;
    resolve: (response: Record<string, unknown>) => void;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const response = JSON.parse(data.toString()) as Record<string, unknown>;
      const id = typeof response.id === "string" ? response.id : "";
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.resolve(response);
    });
    socket.on("error", (error) => {
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.reject(error);
      }
    });
  }

  static async connect(url: string): Promise<WireClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new WireClient(socket);
  }

  async request(op: string, payload: Record<string, unknown>, id = "rq_" + (++this.counter)): Promise<Record<string, unknown>> {
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });
    this.socket.send(JSON.stringify({ id, op, payload, sentAt: Date.now(), type: "request", v: 1 }));
    return await response;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

function restoreSnapshot(state: AcceptedState): RestoreSnapshot {
  return {
    allocatorId: state.allocatorId,
    authorityOwners: state.authorityOwners.map((owner) => ({ ...owner })),
    custodyRevision: state.custodyRevision,
    fleetId: state.fleetId,
    headHash: state.headHash,
    headSeq: state.headSeq,
    mappings: state.mappings.map((mapping) => ({ ...mapping })),
    nextOrdinalFence: state.nextOrdinalFence,
    stateVersion: state.stateVersion,
    transactions: state.transactions.map((transaction) => ({ ...transaction })),
  };
}

function identity(character: string) {
  return {
    authorityId: `auth_${character.repeat(22)}`,
    ownerAnchorId: `owner_${character.repeat(22)}`,
  };
}

function bindPayload(fleetId: string, owner: ReturnType<typeof identity>) {
  return { ...owner, fleetId, protocolVersion: 1 };
}

function claimPayload(
  fleetId: string,
  allocatorId: string,
  owner: ReturnType<typeof identity>,
  surfaceId: string,
) {
  return { ...bindPayload(fleetId, owner), expectedAllocatorId: allocatorId, surfaceId };
}

function successLabel(response: Record<string, unknown>): string {
  assert.equal(response.ok, true, JSON.stringify(response));
  const payload = response.payload as Record<string, unknown>;
  assert.equal(typeof payload.windowLabel, "string");
  return payload.windowLabel as string;
}

function successOrdinal(response: Record<string, unknown>): number {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response.payload as Record<string, unknown>).ordinal as number;
}

function errorCode(response: Record<string, unknown>): string {
  assert.equal(response.ok, false, JSON.stringify(response));
  return ((response.error as Record<string, unknown>).code as string);
}

async function senderCount(url: string, applicationName: string): Promise<number> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_stat_replication WHERE application_name = $1",
      [applicationName],
    );
    return Number(result.rows[0]?.count);
  } finally {
    await client.end();
  }
}

async function scalar(url: string, sql: string): Promise<string> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(sql);
    return String(Object.values(result.rows[0] as Record<string, unknown>)[0]);
  } finally {
    await client.end();
  }
}

async function adminQuery(url: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

async function run(command: string, args: string[]): Promise<void> {
  await execFile(join(postgresBin, command), args, { maxBuffer: 10 * 1024 * 1024 });
}

async function pgCtl(data: string, args: string[]): Promise<void> {
  await run("pg_ctl", ["-D", data, ...args]);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for PostgreSQL replication state");
}
