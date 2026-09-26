import { execFile as execFileCallback } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import pg from "pg";
import WebSocket from "ws";

import { PostgresCustodyAdapter, type PostgresCustodyConfig } from "../../packages/allocator/src/custody.js";
import { loadOrCreateIdentity } from "../../packages/electron/src/identity.js";
import { loadPersistentStateFile, writePersistentStateFile } from "../../packages/electron/src/persistent-state-file.js";
import { SurfaceCore } from "../../packages/electron/src/surface-core.js";
import { SurfaceWsServer } from "../../packages/electron/src/ws-server.js";
import { locklessPaneScopeId } from "../../packages/protocol/src/lockless.js";

const execFile = promisify(execFileCallback);
const { Client } = pg;
const nodeRequire = createRequire(import.meta.url);

type Options = {
  baselineCommit: string;
  baselineRoot: string;
  candidateCommit: string;
  candidateRoot: string;
  output: string;
  stateRoot: string;
};

type Cluster = {
  adminUrl: string;
  config: PostgresCustodyConfig;
  databaseIdentity: string;
  primaryData: string;
  root: string;
  stop: () => Promise<void>;
  witnessData: string;
};

function argumentsObject(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || values.has(flag)) throw new Error(`invalid_argument:${flag ?? "missing"}`);
    values.set(flag, value);
  }
  const required = (name: string) => {
    const value = values.get(`--${name}`);
    if (!value) throw new Error(`missing_argument:--${name}`);
    return path.resolve(value);
  };
  const literal = (name: string) => {
    const value = values.get(`--${name}`);
    if (!value) throw new Error(`missing_argument:--${name}`);
    return value;
  };
  return {
    baselineCommit: literal("baseline-commit"),
    baselineRoot: required("baseline-root"),
    candidateCommit: literal("candidate-commit"),
    candidateRoot: required("candidate-root"),
    output: required("output"),
    stateRoot: required("state-root"),
  };
}

async function command(command: string, args: string[], options: Parameters<typeof execFile>[2] = {}) {
  return await execFile(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("free_port_unavailable");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function append(file: string, contents: string) {
  await fs.appendFile(file, contents);
}

async function postgresQuery(url: string, sql: string): Promise<unknown[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

async function waitFor(check: () => Promise<boolean>, label: string, deadlineMs = 60_000) {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label}_timeout:${lastError instanceof Error ? lastError.message : "not_ready"}`);
}

async function startCluster(root: string, schema: string): Promise<Cluster> {
  await fs.mkdir(root, { recursive: true });
  const postgresBin = (await command("pg_config", ["--bindir"])).stdout.trim();
  const binary = (name: string) => path.join(postgresBin, name);
  const primaryData = path.join(root, "primary");
  const witnessData = path.join(root, "witness");
  const primaryPort = await freePort();
  const witnessPort = await freePort();
  await command(binary("initdb"), ["-D", primaryData, "--auth=trust", "--username=postgres", "--no-instructions"]);
  await append(path.join(primaryData, "postgresql.conf"), `
listen_addresses = '127.0.0.1'
port = ${primaryPort}
unix_socket_directories = ''
wal_level = replica
max_wal_senders = 4
max_replication_slots = 4
synchronous_standby_names = 'FIRST 1 (surf_ace_witness)'
synchronous_commit = local
fsync = on
`);
  await command(binary("pg_ctl"), ["-D", primaryData, "-l", path.join(root, "primary.log"), "start"]);
  const adminUrl = `postgresql://postgres@127.0.0.1:${primaryPort}/postgres`;
  try {
    await command(binary("psql"), [adminUrl, "-v", "ON_ERROR_STOP=1", "-f", schema]);
    await postgresQuery(adminUrl, `
      CREATE ROLE allocator_writer LOGIN IN ROLE surf_ace_allocator_writer;
      CREATE ROLE allocator_recovery LOGIN IN ROLE surf_ace_allocator_recovery;
      CREATE ROLE allocator_witness LOGIN IN ROLE surf_ace_allocator_witness;
      SELECT pg_create_physical_replication_slot('surf_ace_smoke_witness_slot');
    `);
    await command(binary("pg_basebackup"), [
      "-D", witnessData, "-d", adminUrl, "-R", "-X", "stream", "-S", "surf_ace_smoke_witness_slot",
    ]);
    await append(path.join(witnessData, "postgresql.conf"), `
listen_addresses = '127.0.0.1'
port = ${witnessPort}
unix_socket_directories = ''
hot_standby = on
primary_conninfo = 'host=127.0.0.1 port=${primaryPort} user=postgres application_name=surf_ace_witness'
primary_slot_name = 'surf_ace_smoke_witness_slot'
surf_ace.witness_server_id = 'witness-smoke'
`);
    await append(path.join(witnessData, "postgresql.auto.conf"), `
primary_conninfo = 'host=127.0.0.1 port=${primaryPort} user=postgres application_name=surf_ace_witness'
primary_slot_name = 'surf_ace_smoke_witness_slot'
surf_ace.witness_server_id = 'witness-smoke'
`);
    await command(binary("pg_ctl"), ["-D", witnessData, "-l", path.join(root, "witness.log"), "start"]);
    await postgresQuery(adminUrl, "ALTER SYSTEM SET synchronous_commit = 'remote_apply'");
    await postgresQuery(adminUrl, "SELECT pg_reload_conf()");
    await waitFor(async () => {
      const rows = await postgresQuery(adminUrl, "SELECT sync_state FROM pg_stat_replication WHERE application_name='surf_ace_witness'") as Array<{ sync_state?: string }>;
      return rows.length === 1 && rows[0]?.sync_state === "sync";
    }, "postgres_witness");
    const identityRows = await postgresQuery(adminUrl, "SELECT (pg_control_system()).system_identifier::text AS id") as Array<{ id: string }>;
    const databaseIdentity = identityRows[0]?.id;
    if (!databaseIdentity) throw new Error("postgres_identity_missing");
    const config: PostgresCustodyConfig = {
      expectedClusterSystemId: databaseIdentity,
      fleetId: "fleet-release-smoke",
      primaryUrl: `postgresql://allocator_writer@127.0.0.1:${primaryPort}/postgres`,
      recoveryUrl: `postgresql://allocator_recovery@127.0.0.1:${primaryPort}/postgres`,
      witnessApplicationName: "surf_ace_witness",
      witnessPhysicalSlot: "surf_ace_smoke_witness_slot",
      witnessServerId: "witness-smoke",
      witnessUrl: `postgresql://allocator_witness@127.0.0.1:${witnessPort}/postgres`,
    };
    const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(config, "alloc_release-smoke");
    await recovery.release();
    return {
      adminUrl,
      config,
      databaseIdentity,
      primaryData,
      root,
      witnessData,
      async stop() {
        await command(binary("pg_ctl"), ["-D", witnessData, "stop", "-m", "fast"]).catch(() => undefined);
        await command(binary("pg_ctl"), ["-D", primaryData, "stop", "-m", "fast"]).catch(() => undefined);
      },
    };
  } catch (error) {
    await command(binary("pg_ctl"), ["-D", witnessData, "stop", "-m", "fast"]).catch(() => undefined);
    await command(binary("pg_ctl"), ["-D", primaryData, "stop", "-m", "fast"]).catch(() => undefined);
    throw error;
  }
}

async function cli(binary: string, stateRoot: string, commandName: string, input: unknown, endpoint?: string) {
  const args = ["--state-root", stateRoot];
  if (endpoint) args.push("--endpoint", endpoint, "--product-label", "Surf Ace release smoke");
  args.push(commandName, "--input-json", JSON.stringify(input));
  const result = await command(binary, args);
  const parsed = JSON.parse(result.stdout);
  await fs.appendFile(path.join(path.dirname(stateRoot), "raw-cli-evidence.ndjson"), `${JSON.stringify({
    args,
    command: commandName,
    input,
    output: parsed,
  })}\n`);
  if (parsed.ok !== true) throw new Error(`packaged_cli_${commandName}_failed:${result.stdout.trim()}`);
  return parsed;
}

async function centralRequest(url: string, op: string, payload: unknown) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  try {
    const id = `rq_${op.replaceAll(".", "_")}`;
    const response = new Promise<any>((resolve, reject) => {
      socket.on("message", (data) => {
        const value = JSON.parse(data.toString());
        if (value.id === id) resolve(value);
      });
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ id, op, payload, sentAt: Date.now(), type: "request", v: 1 }));
    const value = await response;
    if (value.ok !== true) throw new Error(`central_${op}_failed:${JSON.stringify(value)}`);
    return value.payload;
  } finally {
    socket.close();
  }
}

function clientId(publicKeyPem: string) {
  const der = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}

function resultPayload(output: any) {
  return output?.result?.payload ?? output?.result;
}

function resultDerivedSplitChildren(output: any, sourcePaneId: number, expectedCount: number) {
  const payload = resultPayload(output);
  const panes = Array.isArray(payload?.panes) ? payload.panes : [];
  const children = panes
    .map((pane: any) => Number(pane?.paneId))
    .filter((paneId: number) => Number.isSafeInteger(paneId) && paneId >= 1 && paneId !== sourcePaneId);
  if (children.length !== expectedCount - 1 || new Set(children).size !== children.length) {
    throw new Error("split_result_children_invalid");
  }
  return children;
}

async function readPackagedControllerState(stateRoot: string) {
  const state = JSON.parse(await fs.readFile(path.join(stateRoot, "controller-state.json"), "utf8"));
  if (state?.version !== 1 || typeof state.controllerInstanceId !== "string" || !state.controllerInstanceId) {
    throw new Error("packaged_cli_state_identity_invalid");
  }
  if (!state.scopes || typeof state.scopes !== "object" || !Array.isArray(state.acknowledgementOutbox)) {
    throw new Error("packaged_cli_state_shape_invalid");
  }
  return state;
}

function listedSurface(list: any, expectedSurfaceId?: string) {
  const surfaces = resultPayload(list)?.surfaces;
  if (!Array.isArray(surfaces)) throw new Error("packaged_cli_list_surfaces_missing");
  const surface = expectedSurfaceId
    ? surfaces.find((candidate: any) => candidate?.surfaceId === expectedSurfaceId)
    : surfaces.length === 1 ? surfaces[0] : undefined;
  if (!surface || typeof surface.surfaceId !== "string" || !Array.isArray(surface.topology?.panes)) {
    throw new Error("packaged_cli_list_surface_invalid");
  }
  if (!Number.isSafeInteger(Number(surface.topology.topologyRevision))) {
    throw new Error("packaged_cli_list_topology_revision_invalid");
  }
  return surface;
}

function contentRecordId(record: any) {
  const value = record?.payload?.contentId ?? record?.contentId;
  return typeof value === "string" && value ? value : null;
}

function contentRecords(readEvidence: any[]) {
  const records: Array<{ record: any; scopeId: string }> = [];
  for (const evidence of readEvidence) {
    const result = resultPayload(evidence.output);
    const candidates = [
      ...(Array.isArray(result?.records) ? result.records : []),
      ...(result?.currentContentRecord ? [result.currentContentRecord] : []),
    ];
    for (const record of candidates) {
      if (record?.recordClass !== "content" || !contentRecordId(record)) continue;
      records.push({ record, scopeId: evidence.scopeId });
    }
  }
  return records;
}

function latestContentRecord(readEvidence: any[]) {
  return contentRecords(readEvidence)
    .map(({ record }) => record)
    .filter((record) => Number.isSafeInteger(Number(record?.sequence)))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    .at(-1) ?? null;
}

function currentCaptureObservation(readEvidence: any[]) {
  for (const evidence of readEvidence) {
    const capture = resultPayload(evidence.captureOutput);
    if (typeof capture?.contentId === "string" && capture.contentId) {
      return {
        contentId: capture.contentId,
        contentType: capture.contentType ?? null,
        paneId: Number(capture.paneId),
        revision: Number(capture.revision),
        source: "packaged-capture-pane",
        surfaceId: evidence.surfaceId,
      };
    }
  }
  return null;
}

function semanticContentProjection(value: any, surfaceId: string | undefined) {
  const payload = value?.payload ?? value;
  return {
    contentId: payload.contentId,
    paneId: Number(payload.paneId),
    revision: Number(payload.revision),
    surfaceId: payload.surfaceId ?? surfaceId,
  };
}

function maxPackagedSequence(state: any) {
  let maximum = 0;
  for (const scope of Object.values(state.scopes) as any[]) {
    maximum = Math.max(maximum, Number(scope?.lastRetainedSequence ?? 0));
    for (const record of scope?.records ?? []) maximum = Math.max(maximum, Number(record?.sequence ?? 0));
  }
  return maximum;
}

function semanticState(list: any, reads: any[], acknowledgedOutbox: string[], tombstones: string[]) {
  const content: Record<string, unknown> = {};
  const history: Record<string, string[]> = {};
  for (const { record, scopeId } of contentRecords(reads)) {
    const contentId = contentRecordId(record)!;
    const surfaceId = reads.find((evidence) => evidence.scopeId === scopeId)?.surfaceId;
    content[contentId] = semanticContentProjection(record, surfaceId);
    const ids = history[scopeId] ?? [];
    if (!ids.includes(contentId)) ids.push(contentId);
    history[scopeId] = ids;
  }
  for (const evidence of reads) {
    const capture = currentCaptureObservation([evidence]);
    if (!capture) continue;
    content[capture.contentId] ??= semanticContentProjection(capture, evidence.surfaceId);
    const ids = history[evidence.scopeId] ?? [];
    if (!ids.includes(capture.contentId)) ids.push(capture.contentId);
    history[evidence.scopeId] = ids;
  }
  const labels: Record<string, unknown> = {};
  const panes: string[] = [];
  const surfaces = resultPayload(list)?.surfaces;
  if (!Array.isArray(surfaces)) throw new Error("packaged_cli_semantic_list_missing");
  for (const surface of surfaces) {
    const surfacePanes = surface?.topology?.panes;
    if (typeof surface?.surfaceId !== "string" || !Array.isArray(surfacePanes)) {
      throw new Error("packaged_cli_semantic_surface_invalid");
    }
    labels[surface.surfaceId] = {
      panes: Object.fromEntries(surfacePanes.map((pane: any) => [String(pane.paneId), Number(pane.paneLabel)])),
      window: surface.windowLabel ?? null,
    };
    for (const pane of surfacePanes) panes.push(`${surface.surfaceId}:${pane.paneId}`);
  }
  return {
    content,
    history,
    labels,
    outbox: [...acknowledgedOutbox],
    panes: panes.sort(),
    tombstones: [...tombstones],
  };
}

async function readPane(binary: string, stateRoot: string, endpoint: string, surfaceId: string, paneId: number) {
  const captureOutput = await cli(binary, stateRoot, "capture-pane", {
    includeDrawings: true,
    includeImage: true,
    paneId,
    surfaceId,
  }, endpoint);
  const scopeId = locklessPaneScopeId(surfaceId, paneId);
  const output = await cli(binary, stateRoot, "read", { scopeId });
  const result = resultPayload(output);
  if (result?.scopeId !== scopeId || result?.cacheStatus !== "current" || result?.consumableLoss !== null) {
    throw new Error(`packaged_cli_read_not_current:${scopeId}`);
  }
  return { captureOutput, output, paneId, scopeId, surfaceId };
}

function pendingAcknowledgementEvidence(state: any, reads: any[]) {
  const records = contentRecords(reads);
  return state.acknowledgementOutbox.map((intent: any) => {
    if (typeof intent?.scopeId !== "string" || !Number.isSafeInteger(Number(intent.cursor)) ||
        typeof intent?.idempotencyKey !== "string") {
      throw new Error("packaged_cli_acknowledgement_invalid");
    }
    return {
      cursor: Number(intent.cursor),
      idempotencyKey: intent.idempotencyKey,
      scopeId: intent.scopeId,
      writeIds: records
        .filter(({ record, scopeId }) => scopeId === intent.scopeId && Number(record.sequence ?? 0) < Number(intent.cursor))
        .map(({ record }) => contentRecordId(record))
        .filter((value): value is string => value !== null),
    };
  });
}

async function acknowledgeObservedReads(binary: string, stateRoot: string, endpoint: string, reads: any[]) {
  const controllerStateBeforeAcknowledgement = await readPackagedControllerState(stateRoot);
  const acknowledgementEvidence = pendingAcknowledgementEvidence(controllerStateBeforeAcknowledgement, reads);
  const list = await cli(binary, stateRoot, "list", {}, endpoint);
  const controllerStateAfterAcknowledgement = await readPackagedControllerState(stateRoot);
  if (controllerStateAfterAcknowledgement.controllerInstanceId !== controllerStateBeforeAcknowledgement.controllerInstanceId) {
    throw new Error("packaged_cli_identity_changed_while_acknowledging");
  }
  for (const acknowledgement of acknowledgementEvidence) {
    if (controllerStateAfterAcknowledgement.acknowledgementOutbox.some(
      (candidate: any) => candidate?.idempotencyKey === acknowledgement.idempotencyKey,
    )) throw new Error(`packaged_cli_acknowledgement_not_flushed:${acknowledgement.idempotencyKey}`);
    const scope = controllerStateAfterAcknowledgement.scopes[acknowledgement.scopeId];
    if (!scope || Number(scope.clientCursor ?? -1) < acknowledgement.cursor) {
      throw new Error(`packaged_cli_acknowledgement_cursor_stale:${acknowledgement.scopeId}`);
    }
  }
  return {
    acknowledgementEvidence,
    controllerStateAfterAcknowledgement,
    controllerStateBeforeAcknowledgement,
    list,
  };
}

async function main() {
  const options = argumentsObject(process.argv.slice(2));
  await fs.mkdir(options.stateRoot, { recursive: true });
  const clusterRoot = path.join(options.stateRoot, "postgres");
  const cluster = await startCluster(clusterRoot, path.join(options.candidateRoot, "schemas/allocator/001_allocator.sql"));
  const surfaceStateRoot = path.join(options.stateRoot, "surface");
  const cliStateRoot = path.join(options.stateRoot, "cli");
  await fs.mkdir(surfaceStateRoot, { recursive: true });
  const identity = await loadOrCreateIdentity(surfaceStateRoot);
  const loaded = await loadPersistentStateFile(surfaceStateRoot, "surface-core-state.json");
  if (loaded.writeGuard) throw loaded.error;
  const core = new SurfaceCore({ clientIdentity: identity.fingerprintPrefix, persistentState: loaded.state });
  const restored = core.restorePersistedSurfaces("Release smoke", { height: 800, scale: 1, width: 1200 });
  const surface = restored[0] ?? core.ensurePrimarySurface("Release smoke", { height: 800, scale: 1, width: 1200 });
  let persistence = Promise.resolve();
  const persist = () => {
    persistence = persistence.then(() => writePersistentStateFile(surfaceStateRoot, "surface-core-state.json", core.getPersistentState()));
    return persistence;
  };
  core.subscribe(() => { void persist(); });
  await persist();
  const surfacePort = await freePort();
  const surfaceServer = new SurfaceWsServer({
    bindAddress: "127.0.0.1",
    capturePaneImage: async () => Buffer.from("release-smoke-pixels").toString("base64"),
    core,
    endpointName: "Release smoke",
    hostName: "localhost",
    persistLocklessState: persist,
    port: surfacePort,
    viewport: () => ({ height: 800, scale: 1, width: 1200 }),
  });
  await surfaceServer.start();
  const endpoint = `ws://127.0.0.1:${surfacePort}${surfaceServer.wsPath}`;
  const stableClientId = clientId(identity.publicKeyPem);
  const acknowledgementEvidenceAll: any[] = [];
  const acknowledgedOutbox: string[] = [];
  const acknowledgedWriteIds = new Set<string>();
  const observedDatabaseIdentities: string[] = [];
  let resetCount = 0;
  const phases: Record<string, any> = {};
  const tombstones: string[] = [];
  let liveBaselinePaneId: number | null = null;
  let retainedPaneId: number | null = null;
  let retainedTombstoneId: string | null = null;
  try {
    const runPhase = async (name: string, sourceCommit: string, installRoot: string, mutate: boolean) => {
      const module = nodeRequire(path.join(installRoot, "server/central-server.cjs"));
      if (typeof module.startCentralServer !== "function") throw new Error(`${name}_callable_server_missing`);
      const central = await module.startCentralServer({
        custody: cluster.config,
        hostLockPath: path.join(cluster.root, `${name}.lock`),
        listenHost: "127.0.0.1",
        listenPort: 0,
      }, `Surf Ace release smoke ${name}`);
      try {
        const binary = path.join(installRoot, "bin/surf-ace");
        let list = await cli(binary, cliStateRoot, "list", {}, endpoint);
        let listed = listedSurface(list, surface.surfaceId);
        const paneId = Number(listed.topology.panes[0]?.paneId);
        if (!Number.isSafeInteger(paneId) || paneId < 1) throw new Error(`${name}_source_pane_missing`);
        const diagnosticsBeforeRegistration = await central.server.diagnostics();
        if (name !== "baseline" && (diagnosticsBeforeRegistration.assignmentCount < 1 || diagnosticsBeforeRegistration.nextOrdinalFence < 1)) {
          throw new Error(`${name}_persisted_registration_missing_before_reregister`);
        }
        const registration = await centralRequest(central.server.address.url, "client.register", {
          clientId: stableClientId,
          surfaces: [{
            panes: listed.topology.panes.map((pane: any) => ({ paneId: String(pane.paneId), paneLabel: Number(pane.paneLabel) })),
            surfaceId: surface.surfaceId,
          }],
        });
        const topology = await centralRequest(central.server.address.url, "fleet.topology", {});
        const diagnosticsAfterRegistration = await central.server.diagnostics();
        if (!topology.clients?.some((client: any) => client.clientId === stableClientId)) {
          throw new Error(`${name}_central_registration_missing`);
        }
        if (name !== "baseline" && (
          diagnosticsAfterRegistration.assignmentCount !== diagnosticsBeforeRegistration.assignmentCount ||
          diagnosticsAfterRegistration.nextOrdinalFence !== diagnosticsBeforeRegistration.nextOrdinalFence
        )) throw new Error(`${name}_persisted_registration_reallocated`);

        const reads: any[] = [];
        if (name === "baseline") {
          const split = await cli(binary, cliStateRoot, "topology-intent", {
            action: "split", count: 3, direction: "horizontal",
            expectedTopologyRevision: Number(listed.topology.topologyRevision), paneId, surfaceId: surface.surfaceId,
          }, endpoint);
          const children = resultDerivedSplitChildren(split, paneId, 3);
          [liveBaselinePaneId, retainedPaneId] = children;
          await cli(binary, cliStateRoot, "push", {
            content: { html: "<p>baseline live pane</p>" }, contentId: "release-smoke-baseline-live",
            contentType: "html", paneId: liveBaselinePaneId, surfaceId: surface.surfaceId,
          }, endpoint);
          await cli(binary, cliStateRoot, "push", {
            content: { html: "<p>baseline retained pane</p>" }, contentId: "release-smoke-baseline-retained",
            contentType: "html", paneId: retainedPaneId, surfaceId: surface.surfaceId,
          }, endpoint);
          reads.push(await readPane(binary, cliStateRoot, endpoint, surface.surfaceId, liveBaselinePaneId));
          reads.push(await readPane(binary, cliStateRoot, endpoint, surface.surfaceId, retainedPaneId));
          const acknowledged = await acknowledgeObservedReads(binary, cliStateRoot, endpoint, reads);
          for (const evidence of acknowledged.acknowledgementEvidence) {
            acknowledgementEvidenceAll.push(evidence);
            acknowledgedOutbox.push(evidence.idempotencyKey);
            for (const writeId of evidence.writeIds) acknowledgedWriteIds.add(writeId);
          }
          list = acknowledged.list;
          listed = listedSurface(list, surface.surfaceId);
          const closed = await cli(binary, cliStateRoot, "topology-intent", {
            action: "close", expectedTopologyRevision: Number(listed.topology.topologyRevision),
            paneId: retainedPaneId, surfaceId: surface.surfaceId,
          }, endpoint);
          retainedTombstoneId = String(resultPayload(closed)?.tombstoneId ?? "");
          if (!retainedTombstoneId) throw new Error("baseline_retained_tombstone_missing");
          tombstones.push(retainedTombstoneId);
          phases[name] = { acknowledged, reads };
        } else if (mutate) {
          if (retainedPaneId === null || retainedTombstoneId === null || liveBaselinePaneId === null) {
            throw new Error("candidate_baseline_evidence_missing");
          }
          const restored = await cli(binary, cliStateRoot, "topology-intent", {
            action: "restore", anchorPaneId: paneId, direction: "vertical",
            expectedTopologyRevision: Number(listed.topology.topologyRevision), surfaceId: surface.surfaceId,
            tombstoneId: retainedTombstoneId,
          }, endpoint);
          if (Number(resultPayload(restored)?.paneId) !== retainedPaneId) throw new Error("candidate_restored_pane_mismatch");
          reads.push(await readPane(binary, cliStateRoot, endpoint, surface.surfaceId, liveBaselinePaneId));
          reads.push(await readPane(binary, cliStateRoot, endpoint, surface.surfaceId, retainedPaneId));
          await cli(binary, cliStateRoot, "push", {
            content: { html: "<p>candidate acknowledged write</p>" }, contentId: "release-smoke-candidate-write",
            contentType: "html", paneId, surfaceId: surface.surfaceId,
          }, endpoint);
          const candidateRead = await readPane(binary, cliStateRoot, endpoint, surface.surfaceId, paneId);
          reads.push(candidateRead);
          const acknowledged = await acknowledgeObservedReads(binary, cliStateRoot, endpoint, reads);
          for (const evidence of acknowledged.acknowledgementEvidence) {
            acknowledgementEvidenceAll.push(evidence);
            acknowledgedOutbox.push(evidence.idempotencyKey);
            for (const writeId of evidence.writeIds) acknowledgedWriteIds.add(writeId);
          }
          list = acknowledged.list;
          listed = listedSurface(list, surface.surfaceId);
          const closed = await cli(binary, cliStateRoot, "topology-intent", {
            action: "close", expectedTopologyRevision: Number(listed.topology.topologyRevision),
            paneId: retainedPaneId, surfaceId: surface.surfaceId,
          }, endpoint);
          retainedTombstoneId = String(resultPayload(closed)?.tombstoneId ?? "");
          if (!retainedTombstoneId) throw new Error("candidate_retained_tombstone_missing");
          tombstones.push(retainedTombstoneId);
          phases[name] = { acknowledged, currentContentRecord: resultPayload(candidateRead.output)?.currentContentRecord ?? null, reads };
        } else {
          if (retainedPaneId === null || retainedTombstoneId === null || liveBaselinePaneId === null) {
            throw new Error("rollback_candidate_evidence_missing");
          }
          const restored = await cli(binary, cliStateRoot, "topology-intent", {
            action: "restore", anchorPaneId: paneId, direction: "vertical",
            expectedTopologyRevision: Number(listed.topology.topologyRevision), surfaceId: surface.surfaceId,
            tombstoneId: retainedTombstoneId,
          }, endpoint);
          if (Number(resultPayload(restored)?.paneId) !== retainedPaneId) throw new Error("rollback_restored_pane_mismatch");
          const observerStateRoot = path.join(options.stateRoot, "rollback-observer-cli");
          reads.push(await readPane(binary, observerStateRoot, endpoint, surface.surfaceId, liveBaselinePaneId));
          reads.push(await readPane(binary, observerStateRoot, endpoint, surface.surfaceId, retainedPaneId));
          const rollbackRead = await readPane(binary, observerStateRoot, endpoint, surface.surfaceId, paneId);
          reads.push(rollbackRead);
          await acknowledgeObservedReads(binary, observerStateRoot, endpoint, reads);
          const acknowledged = await acknowledgeObservedReads(binary, cliStateRoot, endpoint, []);
          for (const evidence of acknowledged.acknowledgementEvidence) {
            acknowledgementEvidenceAll.push(evidence);
            acknowledgedOutbox.push(evidence.idempotencyKey);
            for (const writeId of evidence.writeIds) acknowledgedWriteIds.add(writeId);
          }
          list = acknowledged.list;
          listed = listedSurface(list, surface.surfaceId);
          const closed = await cli(binary, cliStateRoot, "topology-intent", {
            action: "close", expectedTopologyRevision: Number(listed.topology.topologyRevision),
            paneId: retainedPaneId, surfaceId: surface.surfaceId,
          }, endpoint);
          retainedTombstoneId = String(resultPayload(closed)?.tombstoneId ?? "");
          if (!retainedTombstoneId) throw new Error("rollback_retained_tombstone_missing");
          tombstones.push(retainedTombstoneId);
          phases[name] = {
            acknowledged,
            currentContentObservation: currentCaptureObservation([rollbackRead]),
            currentContentRecord: latestContentRecord([rollbackRead]),
            reads,
          };
        }

        const finalList = await cli(binary, cliStateRoot, "list", {}, endpoint);
        const phaseState = phases[name];
        const controllerStateBeforeAcknowledgement = phaseState.acknowledged.controllerStateBeforeAcknowledgement;
        const databaseRows = await postgresQuery(cluster.adminUrl, "SELECT (pg_control_system()).system_identifier::text AS id") as Array<{ id?: string }>;
        const databaseIdentity = databaseRows[0]?.id;
        if (!databaseIdentity) throw new Error(`${name}_postgres_identity_missing`);
        const priorDatabaseIdentity = observedDatabaseIdentities.at(-1) ?? null;
        if (priorDatabaseIdentity !== null && priorDatabaseIdentity !== databaseIdentity) resetCount += 1;
        observedDatabaseIdentities.push(databaseIdentity);
        phases[name] = {
          acknowledgedWriteIds: [...acknowledgedWriteIds].sort(),
          acknowledgementEvidence: [...acknowledgementEvidenceAll],
          allocatorAfterRegistration: diagnosticsAfterRegistration,
          allocatorBeforeRegistration: diagnosticsBeforeRegistration,
          allocatorFence: diagnosticsAfterRegistration.nextOrdinalFence,
          allocatorHeadSeq: diagnosticsAfterRegistration.primaryHeadSeq,
          allocatorIdentity: diagnosticsAfterRegistration.allocatorId,
          allocatorStateVersion: diagnosticsAfterRegistration.stateVersion,
          centralRegistration: registration,
          clientIdentity: controllerStateBeforeAcknowledgement.controllerInstanceId,
          controllerStateAfterAcknowledgement: phaseState.acknowledged.controllerStateAfterAcknowledgement,
          controllerStateBeforeAcknowledgement,
          currentContentRecord: phaseState.currentContentRecord ?? null,
          currentContentObservation: phaseState.currentContentObservation ?? currentCaptureObservation(reads),
          databaseIdentity,
          loss: null,
          readEvidence: reads,
          readControllerIdentities: [...new Set(reads.map((evidence) => evidence?.output?.controllerInstanceId))],
          registrationIdentity: topology.clients.find((client: any) => client.clientId === stableClientId)?.clientId,
          resetCount,
          resetEvidence: { databaseIdentity, priorDatabaseIdentity },
          semanticState: semanticState(finalList, reads, acknowledgedOutbox, tombstones),
          sequence: maxPackagedSequence(controllerStateBeforeAcknowledgement),
          sourceCommit,
        };
      } finally {
        await central.close();
      }
    };
    await runPhase("baseline", options.baselineCommit, options.baselineRoot, false);
    await runPhase("candidate", options.candidateCommit, options.candidateRoot, true);
    await runPhase("rollback", options.baselineCommit, options.baselineRoot, false);
    await persistence;
    const rawCliEvidence = await fs.readFile(path.join(options.stateRoot, "raw-cli-evidence.ndjson"));
    await fs.writeFile(options.output, `${JSON.stringify({
      baselineBefore: phases.baseline,
      candidateAfter: phases.candidate,
      rawCliEvidenceSha256: createHash("sha256").update(rawCliEvidence).digest("hex"),
      rollbackAfter: phases.rollback,
    }, null, 2)}\n`);
  } finally {
    await surfaceServer.stop().catch(() => undefined);
    await cluster.stop();
  }
}

await main();
