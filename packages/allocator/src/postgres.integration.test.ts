import { ServerConnection } from "../../electron/src/server-connection.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback, spawn } from "node:child_process";
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
import { AnnotationSourceCoordinator } from "../../electron/src/annotation-source-coordinator.js";
import { SurfaceWsServer } from "../../electron/src/ws-server.js";
import { AnnotationJournal } from "./annotation-journal.js";
import {
  type SurfAceDiscoveryEndpoint,
  type SurfAceDiscoveryService,
} from "../../electron/src/surf-ace-discovery.js";


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
const postgresBin = process.env.SURF_ACE_TEST_POSTGRES_BIN ?? (process.platform === "darwin"
  ? "/opt/homebrew/opt/postgresql@16/bin"
  : "/usr/lib/postgresql/16/bin");
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

    await t.test("uncertain pane claim keeps one writer and recovers its exact label", async () => {
      let injected = false;
      const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config, {
        afterCommitBeforeWitness(operation) {
          if (operation === "claim_pane" && !injected) {
            injected = true;
            throw new Error("cut-after-pane-commit");
          }
        },
      });
      const clientId = createHash("sha256").update("recovery-client").digest("hex");
      const surfaceId = "sf_recovery-pane";
      const paneId = "pane-1";
      const lineageId = "pl_recovery-pane";
      const originalWitnessId = writer.config.witnessServerId;
      try {
        const before = await writer.readAcceptedState();
        await assert.rejects(writer.claimPane(clientId, surfaceId, paneId, lineageId),
          (error) => error instanceof PersistenceOutcomeUnknownError);
        assert.equal(writer.registrationReady, false);
        await assert.rejects(PostgresCustodyAdapter.acquireWriter(cluster.config),
          (error) => error instanceof AllocatorError && error.code === "writer_fence_unavailable");

        writer.config.witnessServerId = "divergent-witness";
        assert.equal(await writer.recoverWriter(), false);
        assert.equal(writer.registrationReady, false);
        writer.config.witnessServerId = originalWitnessId;
        assert.equal(await writer.recoverWriter(), true);
        const first = (await writer.readAcceptedState()).paneMappings.find((pane) => pane.lineageId === lineageId);
        assert.ok(first);
        assert.equal(first.paneId, paneId);
        assert.equal(first.paneLabel, before.nextPaneOrdinalFence);
        assert.equal(await writer.claimPane(clientId, surfaceId, paneId, lineageId), first.paneLabel);
        await assert.rejects(writer.claimPane(clientId, surfaceId, "pane-2", lineageId),
          (error) => error instanceof AllocatorError && error.code === "assignment_conflict");
        const after = await writer.readAcceptedState();
        assert.equal(after.nextPaneOrdinalFence, before.nextPaneOrdinalFence + 1);
        assert.equal(after.paneMappings.filter((pane) => pane.lineageId === lineageId).length, 1);
      } finally {
        writer.config.witnessServerId = originalWitnessId;
        await writer.release();
      }
    });

    await t.test("lost commit acknowledgment reconciles by the original pane identity", async () => {
      let injected = false;
      const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config, {
        afterCommitBeforeAck(operation) {
          if (operation === "claim_pane" && !injected) {
            injected = true;
            throw new Error("lost-commit-ack");
          }
        },
      });
      const clientId = createHash("sha256").update("ack-client").digest("hex");
      try {
        const before = await writer.readAcceptedState();
        await assert.rejects(writer.claimPane(clientId, "sf_ack", "pane-1", "pl_ack"),
          (error) => error instanceof PersistenceOutcomeUnknownError && error.stage === "commit_ack");
        assert.equal(writer.registrationReady, false);
        assert.equal(await writer.recoverWriter(), true);
        const label = await writer.claimPane(clientId, "sf_ack", "pane-1", "pl_ack");
        assert.equal(label, before.nextPaneOrdinalFence);
        assert.equal((await writer.readAcceptedState()).nextPaneOrdinalFence, label + 1);
      } finally {
        await writer.release();
      }
    });

    await t.test("pre-commit pane failure leaves the held writer and fence usable", async () => {
      const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config, {
        beforeMutation(operation) {
          if (operation === "claim_pane") throw new Error("cut-before-pane-commit");
        },
      });
      const clientId = createHash("sha256").update("precommit-client").digest("hex");
      try {
        const before = await writer.readAcceptedState();
        await assert.rejects(writer.claimPane(clientId, "sf_precommit", "pane-1", "pl_precommit"),
          (error) => error instanceof AllocatorError && error.code === "persistence_failed");
        assert.equal(writer.registrationReady, true);
        const after = await writer.readAcceptedState();
        assert.equal(after.nextPaneOrdinalFence, before.nextPaneOrdinalFence);
      } finally {
        await writer.release();
      }
    });

    await t.test("fleet topology reports registration readiness through an uncertain claim and recovery", async () => {
      let injected = false;
      server = await AllocatorServer.start(serverConfig(cluster), {
        afterCommitBeforeWitness(operation) {
          if (operation === "claim_pane" && !injected) {
            injected = true;
            throw new Error("lost-claim-reply");
          }
        },
      });
      const wire = await WireClient.connect(server.address.url);
      const clientId = createHash("sha256").update("readiness-client").digest("hex");
      const surfaceId = "sf_readiness";
      const originalWitnessId = cluster.config.witnessServerId;
      const claim = { clientId, surfaceId, paneId: "pane-1", paneLineageId: "pl_readiness" };
      try {
        assert.equal((await wire.request("client.register", { clientId, surfaces: [{ surfaceId, panes: [] }] })).ok, true);
        assert.equal((await wire.request("fleet.topology", {})).payload?.registrationReady, true);
        assert.equal((await wire.request("pane.claim", claim)).ok, false);
        cluster.config.witnessServerId = "divergent-witness";
        const degraded = await wire.request("fleet.topology", {});
        assert.equal(degraded.ok, true);
        assert.equal(degraded.payload?.registrationReady, false);
        assert.equal((degraded.payload?.clients as unknown[]).length, 1,
          "read-only fleet inventory stays reachable while the writer is fenced");
        assert.equal((await wire.request("pane.claim", {
          clientId, surfaceId, paneId: "pane-2", paneLineageId: "pl_readiness-2",
        })).ok, false, "another pane claim cannot pass the unvalidated writer");
        cluster.config.witnessServerId = originalWitnessId;
        assert.equal((await server.diagnostics()).registrationReady, false);
        assert.equal((await server.diagnostics()).serveStatus, "writer-unvalidated");
        assert.equal((await wire.request("fleet.topology", {})).payload?.registrationReady, true);
        const recovered = await wire.request("pane.claim", claim);
        assert.equal(recovered.ok, true);
        const again = await wire.request("pane.claim", claim);
        assert.equal(again.payload?.paneLabel, recovered.payload?.paneLabel);
      } finally {
        cluster.config.witnessServerId = originalWitnessId;
        await wire.close();
        await server.close();
        server = null;
      }
    });

    await t.test("client registration recovers a fenced writer without a topology request", { timeout: 30_000 }, async () => {
      let injected = false;
      server = await AllocatorServer.start(serverConfig(cluster), {
        afterCommitBeforeWitness(operation) {
          if (operation === "claim_pane" && !injected) {
            injected = true;
            throw new Error("lost-claim-reply");
          }
        },
      });
      const wire = await WireClient.connect(server.address.url);
      const clientId = createHash("sha256").update("registration-recovery-client").digest("hex");
      const surfaceId = "sf_registration-recovery";
      const claim = { clientId, surfaceId, paneId: "pane-1", paneLineageId: "pl_registration-recovery" };
      const emptyRegistration = { clientId, surfaces: [{ surfaceId, panes: [] }] };
      const fullRegistration = { clientId, surfaces: [{ surfaceId, panes: [{
        paneId: claim.paneId, paneLineageId: claim.paneLineageId,
      }] }] };
      const originalWitnessId = cluster.config.witnessServerId;
      try {
        const first = await wire.request("client.register", emptyRegistration);
        assert.equal(first.ok, true);
        const beforeFence = (await server.diagnostics()).nextPaneOrdinalFence;
        assert.equal((await wire.request("pane.claim", claim)).ok, false);
        assert.equal((await server.diagnostics()).registrationReady, false);
        await assert.rejects(PostgresCustodyAdapter.acquireWriter(cluster.config),
          (error) => error instanceof AllocatorError && error.code === "writer_fence_unavailable");

        cluster.config.witnessServerId = "divergent-witness";
        assert.equal((await wire.request("client.register", fullRegistration)).ok, false,
          "an unvalidated writer cannot admit a registration through a divergent witness");

        cluster.config.witnessServerId = originalWitnessId;
        const startedAt = Date.now();
        const recovered = await wire.request("client.register", fullRegistration);
        assert.equal(recovered.ok, true);
        assert.ok(Date.now() - startedAt < 30_000, "registration recovers within the bounded window");
        const originalSurfaces = (first.payload as { surfaces: Array<{ windowLabel: number }> }).surfaces;
        const recoveredSurfaces = (recovered.payload as {
          surfaces: Array<{ windowLabel: number; panes: Array<{ paneLabel: number }> }>;
        }).surfaces;
        assert.equal(recoveredSurfaces[0]?.windowLabel, originalSurfaces[0]?.windowLabel);
        const paneLabel = recoveredSurfaces[0]?.panes[0]?.paneLabel;
        assert.equal(typeof paneLabel, "number");
        assert.equal((await wire.request("pane.claim", claim)).payload?.paneLabel, paneLabel);
        const after = await server.diagnostics();
        assert.equal(after.registrationReady, true);
        assert.equal(after.nextPaneOrdinalFence, beforeFence + 1, "the uncertain claim was not replayed");
      } finally {
        cluster.config.witnessServerId = originalWitnessId;
        await wire.close();
        await server.close();
        server = null;
      }
    });

    await t.test("registration clears an authority fence after a second resolution read failure", { timeout: 30_000 }, async () => {
      let cutBind = false;
      let failResolutionRead = false;
      server = await AllocatorServer.start(serverConfig(cluster), {
        afterCommitBeforeWitness(operation) {
          if (operation === "bind_authority" && !cutBind) {
            cutBind = true;
            failResolutionRead = true;
            throw new Error("cut-after-bind-commit");
          }
        },
      });
      const custody = (server as unknown as { custody: PostgresCustodyAdapter<"writer"> }).custody;
      const originalRead = custody.readAcceptedState;
      custody.readAcceptedState = async () => {
        if (failResolutionRead && custody.registrationReady) {
          failResolutionRead = false;
          throw new Error("cut-after-lease-validation");
        }
        return await originalRead.call(custody);
      };
      const wire = await WireClient.connect(server.address.url);
      const clientId = createHash("sha256").update("authority-double-fault-client").digest("hex");
      const surfaceId = "sf_authority-double-fault";
      const registration = { clientId, surfaces: [{ surfaceId, panes: [] }] };
      const originalWitnessId = cluster.config.witnessServerId;
      try {
        const before = await server.diagnostics();
        assert.equal((await wire.request("client.register", registration)).ok, false);
        assert.equal(cutBind, true);
        assert.equal(failResolutionRead, false, "the second fault followed successful lease validation");
        assert.equal(custody.registrationReady, true, "custody recovered but authority remains fenced");
        const fenced = await server.diagnostics();
        assert.equal(fenced.registrationReady, false);
        assert.match(fenced.serveStatus, /^fail-closed:unknown-persistence:/);

        cluster.config.witnessServerId = "divergent-witness";
        assert.equal((await wire.request("client.register", registration)).ok, false,
          "registration stays fenced while the witness contradicts the held writer");
        assert.equal(custody.registrationReady, false);

        cluster.config.witnessServerId = originalWitnessId;
        const startedAt = Date.now();
        const recovered = await wire.request("client.register", registration);
        assert.equal(recovered.ok, true);
        assert.ok(Date.now() - startedAt < 30_000, "a plain retry recovers without topology or discovery");
        assert.equal((await wire.request("client.register", registration)).ok, true);
        const after = await server.diagnostics();
        assert.equal(after.registrationReady, true);
        assert.equal(after.serveStatus, "serving");
        assert.equal(after.assignmentCount, before.assignmentCount + 1,
          "the uncertain binding admitted only the requested surface assignment");
      } finally {
        cluster.config.witnessServerId = originalWitnessId;
        custody.readAcceptedState = originalRead;
        await wire.close();
        await server.close();
        server = null;
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
    assert.deepEqual(await reader.readRegistryIdentity(), {
      allocatorId: "alloc_registration-test",
      fleetId: cluster.config.fleetId,
    });
    const existing = fixtures[0];
    const reconfirmed = await reader.request("client.register", {
      clientId: existing.clientId,
      surfaces: existing.core.listSurfaces().map((surface) => ({
        surfaceId: surface.surfaceId,
        panes: [...surface.panes.values()].map((pane) => ({
          paneId: String(pane.paneId), paneLabel: pane.paneLabel,
          paneLineageId: pane.paneLineageId,
        })),
      })),
    });
    assert.equal(reconfirmed.ok, true);
    assert.deepEqual((reconfirmed.payload as { registryIdentity: unknown }).registryIdentity, {
      allocatorId: "alloc_registration-test", fleetId: cluster.config.fleetId,
    });
    const topology = async () => {
      const response = await reader!.request("fleet.topology");
      assert.equal(response.ok, true);
      return response.payload as { clients: Array<{ clientId: string; surfaces: Array<{ windowLabel: string; panes: Array<{ paneAddress: string }> }> }> };
    };
    const first = await topology();
    assert.equal(first.clients.length, 2);
    const firstPaneNumbers = first.clients.flatMap((client) => client.surfaces.flatMap((surface) =>
      surface.panes.map((pane) => Number(pane.paneAddress.slice(surface.windowLabel.length)))));
    assert.equal(firstPaneNumbers.length, 3);
    assert.equal(new Set(firstPaneNumbers).size, firstPaneNumbers.length,
      "two clients connected to one registry must never display the same pane number");
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
    const recycledPaneId = "recycled-pane-id";
    const claim = async (lineage: string) => {
      const response = await reader!.request("pane.claim", {
        clientId: fixtures[0].clientId,
        surfaceId: fixtures[0].surface.surfaceId,
        paneId: recycledPaneId,
        paneLineageId: lineage,
      });
      assert.equal(response.ok, true);
      const label = (response.payload as { paneLabel: number }).paneLabel;
      assert.ok(Number.isSafeInteger(label) && label > 0);
      return label;
    };
    const firstLineageLabel = await claim("pl_first-lifetime");
    assert.equal(await claim("pl_first-lifetime"), firstLineageLabel,
      "reconnect must reuse the same durable pane claim");
    const secondLineageLabel = await claim("pl_second-lifetime");
    assert.ok(secondLineageLabel > firstLineageLabel,
      "a reused paneId with new lineage must receive a fresh fleet ordinal");
    assert.equal(await claim("pl_second-lifetime"), secondLineageLabel);
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

test("configured-first server in-process discovery fallback registers and persists clients", { timeout: 90_000 }, async () => {
  const cluster = await startCluster();
  let allocator: AllocatorServer | null = null;
  const clients: ServerConnection[] = [];
  let discoveryStarts = 0;
  let allowConfigured = true;
  let configuredAccepts = 0;
  const routeSockets = new Set<Socket>();
  const routeIdleWaiters = new Set<() => void>();
  const routeSocketClosed = () => {
    if (routeSockets.size === 0) {
      for (const ready of routeIdleWaiters) ready();
      routeIdleWaiters.clear();
    }
  };
  const waitForRouteIdle = async () => {
    if (routeSockets.size === 0) return;
    await new Promise<void>((resolve, reject) => {
      const ready = () => { clearTimeout(timeout); resolve(); };
      const timeout = setTimeout(() => {
        routeIdleWaiters.delete(ready);
        reject(new Error("configured route sockets did not close"));
      }, 2_000);
      routeIdleWaiters.add(ready);
    });
  };
  const route = createServer((socket) => {
    if (!allowConfigured || !allocator) { socket.destroy(); return; }
    configuredAccepts++;
    const upstream = createConnection({ host: "127.0.0.1", port: allocator.address.port });
    routeSockets.add(socket);
    routeSockets.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => { routeSockets.delete(socket); upstream.destroy(); routeSocketClosed(); });
    upstream.on("close", () => { routeSockets.delete(upstream); socket.destroy(); routeSocketClosed(); });
    socket.pipe(upstream).pipe(socket);
  });
  const discover = (): SurfAceDiscoveryService => ({
    getSnapshot: (): SurfAceDiscoveryEndpoint[] => allocator ? [{
      busy: false,
      capabilitiesBitmask: 0,
      endpointId: `127.0.0.1:${allocator.address.port}/ws#isolated-fixture`,
      fingerprintPrefix: "fixture",
      host: "127.0.0.1",
      instanceName: "isolated allocator fixture",
      lastSeenAt: Date.now(),
      name: "isolated allocator fixture",
      port: allocator.address.port,
      protocolVersion: 1,
      role: "server",
      transportAddresses: ["127.0.0.1"],
      viewport: { width: 800, height: 600, scale: 1 },
      wsPath: "/ws",
    }] : [],
    start: async () => { discoveryStarts++; },
    stop: async () => {},
    refreshNow: async () => {},
    subscribe: () => () => {},
  });
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
    allocator = await AllocatorServer.start(serverConfig(cluster));
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
      await client.synchronize();
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
    assert.equal(first.clients.length, 2, JSON.stringify({
      registeredClientIds: first.clients.map((client) => client.clientId),
      fixtureClientIds: fixtures.map((fixture) => fixture.clientId),
    }));
    const firstPaneNumbers = first.clients.flatMap((client) => client.surfaces.flatMap((surface) =>
      surface.panes.map((pane) => Number(pane.paneAddress.slice(surface.windowLabel.length)))));
    assert.equal(firstPaneNumbers.length, 3);
    assert.equal(new Set(firstPaneNumbers).size, firstPaneNumbers.length,
      "discovered and configured clients must have fleet-unique pane numbers");
    for (const fixture of fixtures) {
      const stored = JSON.parse(await readFile(join(fixture.stateDir, "state.json"), "utf8"));
      for (const surface of stored.surfaces) assert.equal(surface.windowLabel, fixture.core.getSurface(surface.surfaceId).windowLabel);
    }
    const before = await allocator.diagnostics();
    await clients[1].stop();
    await waitForRouteIdle();
    assert.equal(routeSockets.size, 0, "stopped configured route closes its sockets");
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
        // Registry identity confirmation now persists on both selected and
        // candidate transports. Fail the candidate's registration write, not
        // the selected fallback's unrelated confirmation write.
        if (rejectRecoveryPersistence && routeSockets.size > 0 && ++recoveryWrites === 2) {
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
    await waitForRouteIdle();
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
    await allocator?.close();
    await cluster.stop();
  }
});

test("v0.2.3 custody migrates without changing its witnessed head", { timeout: 180_000 }, async () => {
  const cluster = await startCluster("v0.2.3");
  try {
    await adminQuery(cluster.adminUrl, `
      BEGIN;
      SET ROLE surf_ace_allocator_owner;
      INSERT INTO surf_ace_allocator.fleet_tombstones(fleet_id, first_allocator_id)
        VALUES ('fleet-test', 'alloc_migration-test');
      INSERT INTO surf_ace_allocator.fleets(fleet_id, allocator_id, state_version, accepted_generation_id)
        VALUES ('fleet-test', 'alloc_migration-test', 1, 'generation_existing');
      SELECT * FROM surf_ace_allocator.append_event('fleet-test', jsonb_build_object(
        'allocatorId', 'alloc_migration-test', 'fleetId', 'fleet-test',
        'generationId', 'generation_existing', 'stateVersion', 1, 'type', 'initialized'));
      RESET ROLE;
      COMMIT;
    `);
    const before = await scalar(cluster.adminUrl,
      "SELECT head_seq::text || ':' || encode(head_hash, 'hex') FROM surf_ace_allocator.fleets WHERE fleet_id = 'fleet-test'");
    const migration = await readFile(new URL("../sql/002_fleet_panes.sql", import.meta.url), "utf8");
    await adminQuery(cluster.adminUrl, migration);
    await adminQuery(cluster.adminUrl, migration);
    const after = await scalar(cluster.adminUrl,
      "SELECT head_seq::text || ':' || encode(head_hash, 'hex') FROM surf_ace_allocator.fleets WHERE fleet_id = 'fleet-test'");
    assert.equal(after, before);
    const state = await scalar(cluster.adminUrl,
      "SELECT surf_ace_allocator.read_accepted_state('fleet-test')->>'nextPaneOrdinalFence'");
    assert.equal(state, "1");
  } finally {
    await cluster.stop();
  }
});

test("annotation migration creates a head for fleets initialized afterward", { timeout: 180_000 }, async () => {
  const cluster = await startCluster();
  let allocator: AllocatorServer | null = null;
  try {
    await adminQuery(cluster.adminUrl,
      await readFile(new URL("../sql/003_annotation_journal.sql", import.meta.url), "utf8"));
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_annotation-new-fleet");
    await recovery.release();
    assert.equal(await scalar(cluster.adminUrl,
      "SELECT count(*)::text FROM surf_ace_allocator.annotation_journal_head WHERE fleet_id = 'fleet-test'"), "1");
    allocator = await AllocatorServer.start(serverConfig(cluster));
    assert.ok(allocator.address.port > 0);
  } finally {
    await allocator?.close();
    await cluster.stop();
  }
});

test("annotation migration and append survive duplicate retry without allocating a second cursor", { timeout: 180_000 }, async () => {
  const cluster = await startCluster();
  try {
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_annotation-test");
    await recovery.release();
    const migration = await readFile(new URL("../sql/003_annotation_journal.sql", import.meta.url), "utf8");
    await adminQuery(cluster.adminUrl, migration);
    const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config);
    try {
      const journal = new AnnotationJournal(writer);
      const record = {
        protocolVersion: 1, clientId: "client-A", sourceEpoch: "a".repeat(32),
        surfaceId: "sf_A", paneId: 1, frameId: "fr_A", sourceSequence: "1",
        sourceEventId: "event-A", kind: "live_delta", contentId: "content-A",
        revision: 1, contentType: "html",
        viewport: { scrollOffset: { x: 0, y: 0 }, visibleRect: { x: 0, y: 0, width: 10, height: 10 },
          contentSize: { width: 10, height: 10 }, zoomLevel: 1 },
        sourceTimestamp: "2026-10-06T21:00:00Z", payload: { strokes: [{ strokeId: "s1" }] },
      };
      const first = await journal.ingest(record);
      const duplicate = await journal.ingest(record);
      assert.deepEqual(duplicate.serverCursor, first.serverCursor);
      assert.equal(duplicate.committedAt, first.committedAt);
      assert.equal(duplicate.duplicate, true);
      await assert.rejects(journal.ingest({ ...record, revision: 2 }),
        (error) => error instanceof AllocatorError && error.code === "annotation_source_event_conflict");
      const info = await writer.annotationInfo();
      assert.equal(info.journalRecords, 1);
      assert.equal(info.headSequence, "1");
      assert.equal(info.firstRetainedSequence, "1");
    } finally {
      await writer.release();
    }
    const server = await AllocatorServer.start(serverConfig(cluster));
    const publisher = await WireClient.connect(server.address.url);
    const firstConsumer = await WireClient.connect(server.address.url);
    const secondConsumer = await WireClient.connect(server.address.url);
    const gapConsumer = await WireClient.connect(server.address.url);
    const retireCaller = await WireClient.connect(server.address.url);
    let priorLease = "";
    let priorCursor: { epoch: string; sequence: string } = { epoch: "", sequence: "" };
    try {
      assert.equal((await publisher.request("annotation.hello", { protocolVersion: 1, role: "publisher" })).ok, true);
      assert.equal((await firstConsumer.request("annotation.hello", { protocolVersion: 1, role: "consumer" })).ok, true);
      assert.equal((await secondConsumer.request("annotation.hello", { protocolVersion: 1, role: "consumer" })).ok, true);
      const firstOpen = await firstConsumer.request("annotation.watch", { consumerId: "first" });
      const secondOpen = await secondConsumer.request("annotation.watch", { consumerId: "second" });
      assert.equal(firstOpen.ok, true);
      assert.equal(secondOpen.ok, true);
      assert.equal((await retireCaller.request("annotation.hello", { protocolVersion: 1, role: "consumer" })).ok, true);
      const headCursor = (firstOpen.payload as { headCursor: { epoch: string; sequence: string } }).headCursor;
      const undeliveredOpen = await retireCaller.request("annotation.watch", {
        consumerId: "undelivered", fromCursor: { epoch: headCursor.epoch, sequence: "2" },
      });
      assert.equal(undeliveredOpen.ok, true);
      const undeliveredAck = await retireCaller.request("annotation.ack", {
        consumerId: "undelivered", leaseId: (undeliveredOpen.payload as { leaseId: string }).leaseId,
        throughCursor: headCursor,
      });
      assert.equal((undeliveredAck.error as { code: string }).code, "annotation_ack_not_delivered");
      const firstLease = (firstOpen.payload as { leaseId: string }).leaseId;
      const secondLease = (secondOpen.payload as { leaseId: string }).leaseId;
      priorLease = secondLease;
      const deliveredA = await firstConsumer.waitEvent("annotation.record");
      const deliveredB = await secondConsumer.waitEvent("annotation.record");
      const cursor = (deliveredA.payload as { serverCursor: { epoch: string; sequence: string } }).serverCursor;
      priorCursor = cursor;
      assert.deepEqual((deliveredB.payload as { serverCursor: unknown }).serverCursor, cursor);
      const acked = await firstConsumer.request("annotation.ack", { consumerId: "first", leaseId: firstLease, throughCursor: cursor });
      assert.equal(acked.ok, true);
      const wrongLease = await secondConsumer.request("annotation.ack", {
        consumerId: "second", leaseId: firstLease, throughCursor: cursor,
      });
      assert.equal((wrongLease.error as { code: string }).code, "annotation_consumer_lease_stale");
      const secondAck = await secondConsumer.request("annotation.ack", {
        consumerId: "second", leaseId: secondLease, throughCursor: cursor,
      });
      assert.equal(secondAck.ok, true);
      assert.equal((await gapConsumer.request("annotation.hello", { protocolVersion: 1, role: "consumer" })).ok, true);
      const gapOpen = await gapConsumer.request("annotation.watch", {
        consumerId: "gap-consumer", fromCursor: { epoch: "f".repeat(32), sequence: "1" },
      });
      assert.equal(gapOpen.ok, true);
      const gapLease = (gapOpen.payload as { leaseId: string }).leaseId;
      const gap = await gapConsumer.waitEvent("annotation.history_gap");
      assert.equal((gap.payload as { reason: string }).reason, "epoch_changed");
      const wrongGap = await gapConsumer.request("annotation.gap.ack", {
        consumerId: "gap-consumer", leaseId: gapLease, gapId: "0".repeat(32),
      });
      assert.equal((wrongGap.error as { code: string }).code, "annotation_gap_id_mismatch");
      const gapAck = await gapConsumer.request("annotation.gap.ack", {
        consumerId: "gap-consumer", leaseId: gapLease, gapId: (gap.payload as { gapId: string }).gapId,
      });
      assert.equal(gapAck.ok, true);
      const afterGap = await gapConsumer.waitEvent("annotation.record");
      assert.deepEqual((afterGap.payload as { serverCursor: unknown }).serverCursor, cursor);
      const gapResumer = await WireClient.connect(server.address.url);
      try {
        assert.equal((await gapResumer.request("annotation.hello", { protocolVersion: 1, role: "consumer" })).ok, true);
        const resumedGap = await gapResumer.request("annotation.resume", { consumerId: "gap-consumer" });
        assert.equal(resumedGap.ok, true);
        assert.deepEqual((resumedGap.payload as { ackCursor: unknown }).ackCursor,
          (gapAck.payload as { ackCursor: unknown }).ackCursor);
        const replayed = await gapResumer.waitEvent("annotation.record");
        assert.deepEqual((replayed.payload as { serverCursor: unknown }).serverCursor, cursor);
        const replayAck = await gapResumer.request("annotation.ack", {
          consumerId: "gap-consumer", leaseId: (resumedGap.payload as { leaseId: string }).leaseId,
          throughCursor: cursor,
        });
        assert.equal(replayAck.ok, true);
      } finally {
        await gapResumer.close();
      }
      const retire = await retireCaller.request("annotation.consumer.retire", {
        consumerId: "first", expectedAckCursor: cursor, discardUnacknowledged: true,
      });
      assert.equal(retire.ok, true);
      assert.equal((retire.payload as { retired: boolean }).retired, true);
      assert.equal((await firstConsumer.waitEvent("annotation.consumer_retired")).op, "annotation.consumer_retired");
      assert.equal((await retireCaller.request("annotation.consumer.retire", {
        consumerId: "first", expectedAckCursor: cursor, discardUnacknowledged: true,
      })).ok, true);
      const mismatchedRetire = await retireCaller.request("annotation.consumer.retire", {
        consumerId: "first", expectedAckCursor: null, discardUnacknowledged: true,
      });
      assert.equal((mismatchedRetire.error as { code: string }).code, "annotation_ack_cursor_mismatch");
    } finally {
      await Promise.all([publisher.close(), firstConsumer.close(), secondConsumer.close(), gapConsumer.close(), retireCaller.close()]);
      await server.close();
    }
    const restarted = await AllocatorServer.start(serverConfig(cluster));
    const resumed = await WireClient.connect(restarted.address.url);
    try {
      assert.equal((await resumed.request("annotation.hello", { protocolVersion: 1, role: "consumer" })).ok, true);
      const stale = await resumed.request("annotation.ack", {
        consumerId: "second", leaseId: priorLease, throughCursor: priorCursor,
      });
      assert.equal((stale.error as { code: string }).code, "annotation_consumer_lease_stale");
      const opened = await resumed.request("annotation.resume", { consumerId: "second" });
      assert.equal(opened.ok, true);
      assert.notEqual((opened.payload as { leaseId: string }).leaseId, priorLease);
      assert.deepEqual((opened.payload as { ackCursor: unknown }).ackCursor, priorCursor);
    } finally {
      await resumed.close();
      await restarted.close();
    }
  } finally {
    await cluster.stop();
  }
});

test("annotation native CLI watch, ack, resume and retire use the PostgreSQL journal", {
  timeout: 180_000, skip: !process.env.SURF_ACE_TEST_CLI_BIN,
}, async () => {
  const binary = process.env.SURF_ACE_TEST_CLI_BIN!;
  const cluster = await startCluster();
  const stateRoot = await mkdtemp(join(cluster.root, "annotation-cli-"));
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_annotation-cli");
    await recovery.release();
    await adminQuery(cluster.adminUrl,
      await readFile(new URL("../sql/003_annotation_journal.sql", import.meta.url), "utf8"));
    const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config);
    try {
      await new AnnotationJournal(writer).ingest({
        protocolVersion: 1, clientId: "client-cli", sourceEpoch: "a".repeat(32),
        surfaceId: "sf_cli", paneId: 1, frameId: "fr_cli", sourceSequence: "1",
        sourceEventId: "event-cli", kind: "live_delta", contentId: "content-cli",
        revision: 1, contentType: "html",
        viewport: { scrollOffset: { x: 0, y: 0 }, visibleRect: { x: 0, y: 0, width: 10, height: 10 },
          contentSize: { width: 10, height: 10 }, zoomLevel: 1 },
        sourceTimestamp: "2026-10-06T21:00:00Z", payload: { strokes: [{ strokeId: "s1" }] },
      });
    } finally {
      await writer.release();
    }
    const server = await AllocatorServer.start(serverConfig(cluster));
    try {
      const args = ["--registry", server.address.url, "--state-root", stateRoot,
        "annotations"];
      const stream = (action: "watch" | "resume", count: number) => {
        const child = spawn(binary, [...args, action, "--consumer-id", "cli-consumer"],
          { stdio: ["ignore", "pipe", "pipe"] });
        children.push(child);
        const lines: Array<Record<string, any>> = [];
        let buffered = "";
        let errors = "";
        const ready = new Promise<typeof lines>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`CLI ${action} timed out: ${errors}`)), 10_000);
          child.stderr.on("data", (chunk) => { errors += String(chunk); });
          child.on("error", (error) => { clearTimeout(timer); reject(error); });
          child.on("exit", (code) => {
            if (lines.length < count) { clearTimeout(timer); reject(new Error(`CLI ${action} exited ${code}: ${errors}`)); }
          });
          child.stdout.on("data", (chunk) => {
            buffered += String(chunk);
            for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
              const line = buffered.slice(0, newline);
              buffered = buffered.slice(newline + 1);
              lines.push(JSON.parse(line));
              if (lines.length === count) { clearTimeout(timer); resolve(lines); }
            }
          });
        });
        return { child, ready };
      };
      const watched = stream("watch", 2);
      const delivered = await watched.ready;
      assert.equal(delivered[0]?.type, "annotation.subscription");
      assert.equal(delivered[1]?.op, "annotation.record");
      const cursor = delivered[1]?.payload?.serverCursor;
      assert.match(cursor, /^ann1:[0-9a-f]{32}:1$/);
      const acknowledged = await execFile(binary,
        [...args, "ack", "--consumer-id", "cli-consumer", "--cursor", cursor]);
      assert.equal(JSON.parse(acknowledged.stdout).ackCursor, cursor);
      const resumed = stream("resume", 1);
      const resumedLines = await resumed.ready;
      assert.equal(resumedLines[0]?.ackCursor, cursor);
      const retired = await execFile(binary, [...args, "retire", "--consumer-id", "cli-consumer",
        "--expect-ack", cursor, "--discard-unacknowledged"]);
      assert.equal(JSON.parse(retired.stdout).type, "annotation.consumer_retired");
    } finally {
      for (const child of children) child.kill();
      await server.close();
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await cluster.stop();
  }
});

test("annotation Electron source flush and at-open commit ingest into the real journal", { timeout: 180_000 }, async () => {
  const cluster = await startCluster();
  try {
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_annotation-electron");
    await recovery.release();
    await adminQuery(cluster.adminUrl,
      await readFile(new URL("../sql/003_annotation_journal.sql", import.meta.url), "utf8"));
    const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config);
    try {
      const core = new SurfaceCore({ annotationClientId: "c".repeat(64) });
      const surface = core.ensurePrimarySurface("Surf Ace", { width: 640, height: 480, scale: 1 });
      core.admitSurfaceToLockless(surface.surfaceId);
      const paneId = core.activePaneIds(surface.surfaceId)[0]!;
      core.locklessContentPush(surface.surfaceId, {
        content: { markdown: "fixture" }, contentId: "content-one", contentType: "markdown",
        friendlyChatName: "Fixture", paneId,
      }, "Fixture");
      let durable = core.getPersistentState();
      const source = new AnnotationSourceCoordinator(core, async () => {
        durable = core.getPersistentState();
      }, () => {}, (error) => { throw error; });
      try {
        await source.setAnnotating(surface.surfaceId, paneId, true);
        const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
        core.annotationPublisher!.openFrame(surface.surfaceId, paneId, {
          contentId: "content-one", contextKey: "content-one", image, openedAt: 100,
          scrollOffset: { x: 0, y: 0 }, viewport: { width: 640, height: 480, scale: 1 },
        });
        core.addStroke(surface.surfaceId, paneId, {
          strokeId: "stroke-one" as never, tool: "mouse",
          points: [{ x: 1, y: 2, timestamp: 110 }],
        });
        await source.flushPending(surface.surfaceId, paneId);
        await source.setAnnotating(surface.surfaceId, paneId, false);
        const restored = new SurfaceCore({ annotationClientId: "c".repeat(64), persistentState: durable });
        const fifo = restored.annotationPublisher!.snapshot().surfaces[surface.surfaceId]!.fifo;
        assert.equal(fifo.length, 2);
        const journal = new AnnotationJournal(writer);
        const live = await journal.ingest(JSON.parse(fifo[0]!.canonical));
        const commit = await journal.ingest(JSON.parse(fifo[1]!.canonical));
        assert.equal(live.serverCursor.sequence, "1");
        assert.equal(commit.serverCursor.sequence, "2");
        assert.equal(commit.duplicate, false);
        assert.deepEqual((await journal.ingest(JSON.parse(fifo[1]!.canonical))).serverCursor, commit.serverCursor);
        assert.equal((await writer.annotationInfo()).journalRecords, 2);
      } finally {
        source.stop();
      }
    } finally {
      await writer.release();
    }
  } finally {
    await cluster.stop();
  }
});

test("iOS at-open source records ingest and replay to independent PostgreSQL consumers", { timeout: 180_000 }, async () => {
  const fixture = JSON.parse(await readFile(new URL("../vectors/ios-annotation-v1.json", import.meta.url), "utf8")) as {
    records: string[];
  };
  assert.equal(fixture.records.length, 2);
  const records = fixture.records.map((bytes) => {
    const record = JSON.parse(bytes) as Record<string, unknown>;
    assert.equal(canonicalJson(record as never), bytes, "iOS persisted bytes use the registry canonical form");
    return record;
  });
  assert.deepEqual(records.map((record) => record.kind), ["live_delta", "frame_commit"]);
  assert.deepEqual(records.map((record) => record.sourceSequence), ["1", "2"]);
  const secondClient = {
    ...records[0], clientId: "client-second-fixture", sourceEpoch: "b".repeat(32),
    surfaceId: "sf_second", paneId: 2, frameId: "fr_second",
    sourceSequence: "1", sourceEventId: "event-second", contentId: "content-second",
  };
  const expectedRecords = [...records, secondClient];
  const cluster = await startCluster();
  try {
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_annotation-ios");
    await recovery.release();
    await adminQuery(cluster.adminUrl,
      await readFile(new URL("../sql/003_annotation_journal.sql", import.meta.url), "utf8"));
    const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config);
    let cursors: Array<{ epoch: string; sequence: string }>;
    try {
      const journal = new AnnotationJournal(writer);
      cursors = [];
      for (const record of expectedRecords) cursors.push((await journal.ingest(record)).serverCursor);
      assert.deepEqual(cursors.map((cursor) => cursor.sequence), ["1", "2", "3"]);
      const duplicate = await journal.ingest(records[1]);
      assert.equal(duplicate.duplicate, true);
      assert.deepEqual(duplicate.serverCursor, cursors[1]);
      assert.equal((await writer.annotationInfo()).journalRecords, 3);
    } finally {
      await writer.release();
    }
    const server = await AllocatorServer.start(serverConfig(cluster));
    const first = await WireClient.connect(server.address.url);
    const second = await WireClient.connect(server.address.url);
    try {
      for (const consumer of [first, second]) {
        assert.equal((await consumer.request("annotation.hello", { protocolVersion: 1, role: "consumer" })).ok, true);
      }
      const firstOpen = await first.request("annotation.watch", { consumerId: "ios-first" });
      const secondOpen = await second.request("annotation.watch", { consumerId: "ios-second" });
      assert.equal(firstOpen.ok, true);
      assert.equal(secondOpen.ok, true);
      const firstLease = (firstOpen.payload as { leaseId: string }).leaseId;
      const secondLease = (secondOpen.payload as { leaseId: string }).leaseId;
      for (const consumer of [first, second]) {
        for (const expected of expectedRecords) {
          const event = await consumer.waitEvent("annotation.record");
          const payload = event.payload as { record: Record<string, unknown> };
          assert.deepEqual(payload.record, expected);
        }
      }
      assert.equal((await first.request("annotation.ack", {
        consumerId: "ios-first", leaseId: firstLease, throughCursor: cursors[2],
      })).ok, true);
      const secondAck = await second.request("annotation.ack", {
        consumerId: "ios-second", leaseId: secondLease, throughCursor: cursors[0],
      });
      assert.equal(secondAck.ok, true);
      assert.deepEqual((secondAck.payload as { ackCursor: unknown }).ackCursor, cursors[0]);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await server.close();
    }
  } finally {
    await cluster.stop();
  }
});

test("annotation offline consumer replays beyond the former client queue capacity", { timeout: 180_000 }, async () => {
  const cluster = await startCluster();
  const count = 257;
  try {
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_annotation-offline");
    await recovery.release();
    await adminQuery(cluster.adminUrl,
      await readFile(new URL("../sql/003_annotation_journal.sql", import.meta.url), "utf8"));
    const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config);
    try {
      const initial = await writer.openAnnotationConsumer("offline-queue", "watch");
      assert.deepEqual(initial.initialFromCursor.sequence, "1");
      const journal = new AnnotationJournal(writer);
      for (let sequence = 1; sequence <= count; sequence++) {
        await journal.ingest({
          protocolVersion: 1, clientId: "client-offline", sourceEpoch: "d".repeat(32),
          surfaceId: "sf_offline", paneId: 1, frameId: "fr_offline",
          sourceSequence: String(sequence), sourceEventId: `event-offline-${sequence}`,
          kind: "live_delta", contentId: "content-offline", revision: 1, contentType: "html",
          viewport: { scrollOffset: { x: 0, y: 0 }, visibleRect: { x: 0, y: 0, width: 10, height: 10 },
            contentSize: { width: 10, height: 10 }, zoomLevel: 1 },
          sourceTimestamp: "2026-10-06T21:00:00Z",
          payload: { strokes: [{ strokeId: `stroke-${sequence}` }] },
        });
      }
      assert.equal((await writer.annotationInfo()).journalRecords, count);
    } finally {
      await writer.release();
    }
    const server = await AllocatorServer.start(serverConfig(cluster));
    const consumer = await WireClient.connect(server.address.url);
    try {
      assert.equal((await consumer.request("annotation.hello", { protocolVersion: 1, role: "consumer" })).ok, true);
      const opened = await consumer.request("annotation.resume", { consumerId: "offline-queue" });
      assert.equal(opened.ok, true);
      assert.equal((opened.payload as { historyCompleteSinceStart: boolean }).historyCompleteSinceStart, true);
      const leaseId = (opened.payload as { leaseId: string }).leaseId;
      for (let sequence = 1; sequence <= count; sequence++) {
        const event = await consumer.waitEvent("annotation.record");
        const payload = event.payload as {
          serverCursor: { epoch: string; sequence: string };
          record: { sourceSequence: string; sourceEventId: string };
        };
        assert.equal(payload.serverCursor.sequence, String(sequence));
        assert.equal(payload.record.sourceSequence, String(sequence));
        assert.equal(payload.record.sourceEventId, `event-offline-${sequence}`);
        if (sequence % 16 === 0 || sequence === count) {
          const ack = await consumer.request("annotation.ack", {
            consumerId: "offline-queue", leaseId, throughCursor: payload.serverCursor,
          });
          assert.equal(ack.ok, true);
        }
      }
    } finally {
      await consumer.close();
      await server.close();
    }
  } finally {
    await cluster.stop();
  }
});

test("annotation compaction protects absent and unread consumers, then retains source dedup receipts", { timeout: 180_000 }, async () => {
  const cluster = await startCluster();
  try {
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_annotation-compact");
    await recovery.release();
    await adminQuery(cluster.adminUrl,
      await readFile(new URL("../sql/003_annotation_journal.sql", import.meta.url), "utf8"));
    const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config);
    try {
      const journal = new AnnotationJournal(writer);
      const record = { protocolVersion: 1, clientId: "compactor", sourceEpoch: "c".repeat(32),
        surfaceId: "sf_compaction", sourceSequence: "1", sourceEventId: "gap-one",
        lostFromSequence: "1", lostThroughSequence: "1", reason: "source_retention_overflow" };
      const first = await journal.ingest(record);
      await adminQuery(cluster.adminUrl, `UPDATE surf_ace_allocator.annotation_journal_records
        SET committed_at = clock_timestamp() - interval '31 days'
        WHERE fleet_id = 'fleet-test' AND sequence = 1`);
      assert.equal(await writer.compactAnnotations(), 0, "no consumer cannot erase history");
      const a = await writer.openAnnotationConsumer("A", "watch");
      const b = await writer.openAnnotationConsumer("B", "watch");
      assert.equal(await writer.compactAnnotations(), 0, "unread record remains retained");
      assert.equal((await writer.readAnnotationRecords("1", 1)).length, 1);
      await writer.ackAnnotationConsumer("A", a.leaseId, first.serverCursor);
      assert.equal(await writer.compactAnnotations(), 0, "second consumer still holds its backlog");
      await writer.ackAnnotationConsumer("B", b.leaseId, first.serverCursor);
      assert.equal(await writer.compactAnnotations(), 1);
      const compacted = await writer.annotationInfo();
      assert.equal(compacted.journalRecords, 0);
      assert.equal(compacted.headSequence, "1");
      assert.equal(compacted.firstRetainedSequence, null);
      assert.equal(compacted.sourceMetadataRows, 2, "source head and receipt survive compaction");
      const emptyHistory = await writer.openAnnotationConsumer("empty-history", "watch", first.serverCursor);
      assert.equal(emptyHistory.historyCompleteSinceStart, false);
      const duplicate = await journal.ingest(record);
      assert.equal(duplicate.duplicate, true);
      assert.deepEqual(duplicate.serverCursor, first.serverCursor);
      await assert.rejects(journal.ingest({ ...record, reason: "source_record_rejected" }),
        (error) => error instanceof AllocatorError && error.code === "annotation_source_event_conflict");
      const second = await journal.ingest({ ...record, sourceSequence: "2", sourceEventId: "gap-two",
        lostFromSequence: "2", lostThroughSequence: "2" });
      assert.equal(second.serverCursor.sequence, "2");
      const after = await writer.annotationInfo();
      assert.equal(after.firstRetainedSequence, "2");
      const later = await writer.openAnnotationConsumer("later", "watch", first.serverCursor);
      assert.equal(later.initialFromCursor.sequence, "1");
      assert.equal(later.availableFromCursor?.sequence, "2");
      assert.equal(later.historyCompleteSinceStart, false);
      const foreign = await writer.openAnnotationConsumer("foreign-retire", "watch",
        { epoch: "f".repeat(32), sequence: "10" });
      assert.equal(foreign.initialFromCursor.sequence, "10");
      const foreignRetirement = await writer.retireAnnotationConsumer("foreign-retire", null, true);
      assert.deepEqual(foreignRetirement.discardedFromCursor,
        { epoch: first.serverCursor.epoch, sequence: "2" });
      assert.deepEqual(foreignRetirement.discardedThroughCursor,
        { epoch: first.serverCursor.epoch, sequence: "2" });
    } finally {
      await writer.release();
    }
    await adminQuery(cluster.adminUrl, `UPDATE surf_ace_allocator.annotation_source_heads
      SET accepted_through_sequence = 999 WHERE fleet_id = 'fleet-test'`);
    const server = await AllocatorServer.start(serverConfig(cluster));
    const direct = await WireClient.connect(server.address.url);
    try {
      assert.equal((await direct.request("fleet.topology", {})).ok, true,
        "core allocator service remains available after annotation verification fails");
      const annotation = await direct.request("annotation.hello", { protocolVersion: 1, role: "consumer" });
      assert.equal((annotation.error as { code: string }).code, "annotation_journal_unverified");
    } finally {
      await direct.close();
      await server.close();
    }
  } finally {
    await cluster.stop();
  }
});

test("annotation pressure compacts only acknowledged history and refuses when receipt capacity is exhausted", { timeout: 180_000 }, async () => {
  const cluster = await startCluster();
  try {
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(cluster.config, "alloc_annotation-pressure");
    await recovery.release();
    await adminQuery(cluster.adminUrl,
      await readFile(new URL("../sql/003_annotation_journal.sql", import.meta.url), "utf8"));
    await adminQuery(cluster.adminUrl, `UPDATE surf_ace_allocator.annotation_journal_head
      SET max_journal_records = 1 WHERE fleet_id = 'fleet-test'`);
    const writer = await PostgresCustodyAdapter.acquireWriter(cluster.config);
    try {
      const journal = new AnnotationJournal(writer);
      const firstRecord = { protocolVersion: 1, clientId: "pressure", sourceEpoch: "d".repeat(32),
        surfaceId: "sf_pressure", sourceSequence: "1", sourceEventId: "one",
        lostFromSequence: "1", lostThroughSequence: "1", reason: "source_retention_overflow" };
      const secondRecord = { ...firstRecord, sourceSequence: "2", sourceEventId: "two",
        lostFromSequence: "2", lostThroughSequence: "2" };
      const first = await journal.ingest(firstRecord);
      await assert.rejects(journal.ingest(secondRecord),
        (error) => error instanceof AllocatorError && error.code === "annotation_ingest_capacity" &&
          error.details?.journalRecords === 1 && error.details?.maxJournalRecords === 1 &&
          typeof error.details?.incomingRecordBytes === "number" &&
          error.details?.retryCondition === "oldest_required_history_acknowledged_and_compactable_or_capacity_increased");
      assert.equal((await writer.annotationInfo()).headSequence, "1");
      const consumer = await writer.openAnnotationConsumer("pressure-consumer", "watch");
      await assert.rejects(journal.ingest(secondRecord),
        (error) => error instanceof AllocatorError && error.code === "annotation_ingest_capacity");
      assert.equal((await writer.readAnnotationRecords("1", 1)).length, 1);
      await writer.ackAnnotationConsumer("pressure-consumer", consumer.leaseId, first.serverCursor);
      await adminQuery(cluster.adminUrl, `UPDATE surf_ace_allocator.annotation_journal_head
        SET max_source_metadata_rows = 1 WHERE fleet_id = 'fleet-test'`);
      await assert.rejects(journal.ingest(secondRecord),
        (error) => error instanceof AllocatorError && error.code === "annotation_ingest_capacity" &&
          error.details?.sourceMetadataRows === 1 &&
          error.details?.retryCondition === "reviewed_metadata_capacity_increase");
      assert.equal((await writer.annotationInfo()).journalRecords, 1, "receipt pressure cannot erase history");
      await adminQuery(cluster.adminUrl, `UPDATE surf_ace_allocator.annotation_journal_head
        SET max_source_metadata_rows = 1000000 WHERE fleet_id = 'fleet-test'`);
      const second = await journal.ingest(secondRecord);
      assert.equal(second.serverCursor.sequence, "2");
      const info = await writer.annotationInfo();
      assert.equal(info.journalRecords, 1);
      assert.equal(info.firstRetainedSequence, "2");
      assert.equal(info.sourceMetadataRows, 2);
      assert.equal(info.sourceReceiptRows, 1);
      assert.ok(info.sourceReceiptBytes > 0);
      assert.deepEqual((await journal.ingest(firstRecord)).serverCursor, first.serverCursor);
      const leases = [{ consumerId: "pressure-consumer", leaseId: consumer.leaseId }];
      for (let index = 1; index < 32; index += 1) {
        const consumerId = `capacity-${index}`;
        const opened = await writer.openAnnotationConsumer(consumerId, "watch");
        leases.push({ consumerId, leaseId: opened.leaseId });
      }
      await assert.rejects(writer.openAnnotationConsumer("active-overflow", "watch"),
        (error) => error instanceof AllocatorError && error.code === "annotation_consumer_capacity" &&
          error.details?.activeStreams === 32 && error.details?.maxActiveStreams === 32 &&
          error.details?.retryCondition === "active_stream_disconnected");
      for (const lease of leases) {
        await writer.disconnectAnnotationConsumer(lease.consumerId, lease.leaseId);
      }
      for (let index = 32; index < 64; index += 1) {
        const consumerId = `capacity-${index}`;
        const opened = await writer.openAnnotationConsumer(consumerId, "watch");
        await writer.disconnectAnnotationConsumer(consumerId, opened.leaseId);
      }
      await assert.rejects(writer.openAnnotationConsumer("slot-overflow", "watch"),
        (error) => error instanceof AllocatorError && error.code === "annotation_consumer_capacity" &&
          error.details?.consumerSlots === 64 && error.details?.maxConsumerSlots === 64 &&
          error.details?.retryCondition === "consumer_retired_and_30_day_replay_window_elapsed");
      await writer.retireAnnotationConsumer("capacity-63", null, true);
      await assert.rejects(writer.openAnnotationConsumer("slot-overflow", "watch"),
        (error) => error instanceof AllocatorError && error.code === "annotation_consumer_capacity");
      await adminQuery(cluster.adminUrl, `UPDATE surf_ace_allocator.annotation_consumers
        SET retired_at = clock_timestamp() - interval '31 days'
        WHERE fleet_id = 'fleet-test' AND consumer_id = 'capacity-63'`);
      const reclaimed = await writer.openAnnotationConsumer("slot-overflow", "watch");
      assert.ok(reclaimed.leaseId);
    } finally {
      await writer.release();
    }
  } finally {
    await cluster.stop();
  }
});

async function startCluster(schemaVersion: "current" | "v0.2.3" = "current"): Promise<TestCluster> {
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
    if (schemaVersion === "v0.2.3") {
      const { stdout } = await execFile("git", ["show", "b59c07f:packages/allocator/sql/001_allocator.sql"]);
      await adminQuery(adminUrl, stdout);
    } else {
      await PostgresCustodyAdapter.installSchema(adminUrl);
    }
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
  private readonly events: Array<Record<string, unknown>> = [];
  private readonly eventWaiters: Array<{ op: string; resolve: (event: Record<string, unknown>) => void }> = [];
  private readonly pending = new Map<string, {
    reject: (error: Error) => void;
    resolve: (response: Record<string, unknown>) => void;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const response = JSON.parse(data.toString()) as Record<string, unknown>;
      if (response.type === "event") {
        const waiterIndex = this.eventWaiters.findIndex((waiter) => waiter.op === response.op);
        if (waiterIndex >= 0) this.eventWaiters.splice(waiterIndex, 1)[0]!.resolve(response);
        else this.events.push(response);
        return;
      }
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

  async waitEvent(op: string): Promise<Record<string, unknown>> {
    const index = this.events.findIndex((event) => event.op === op);
    if (index >= 0) return this.events.splice(index, 1)[0]!;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`event timeout: ${op}`)), 5000);
      this.eventWaiters.push({ op, resolve: (event) => { clearTimeout(timer); resolve(event); } });
    });
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
    nextPaneOrdinalFence: state.nextPaneOrdinalFence,
    paneMappings: state.paneMappings.map((mapping) => ({ ...mapping })),
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
