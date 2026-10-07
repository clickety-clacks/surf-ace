import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import type { PostgresCustodyConfig } from "../../packages/allocator/src/custody.js";
import { electronLaunchConfig, hasRequiredAllocatorBackupObjects, launchElectron, matchesRegisteredDirectTarget, stop as stopElectron, verifyAllocatorServiceLifecycle, verifyClientAppVersion } from "./smoke-lib.mjs";
import { TIGHTBEAM } from "./tightbeam-release-config.mjs";
import tightbeamServerLauncher from "./tightbeam-server-launcher.cjs";
import { waitForScreenshotPixels } from "./wait-for-screenshot-pixels.mjs";
import { waitForWebSocketOpen } from "./wait-for-websocket-open.mjs";

const { inspectScreenshotPixels } = createRequire(import.meta.url)("./png-pixel-evidence.cjs") as {
  inspectScreenshotPixels: (imageBase64: unknown, expectedColors: string[]) => {
    height: number; matchedRgbHex: string[]; pngBytes: number; sha256: string; width: number;
  };
};
const expectedScreenshotColors = ["246bce", "d93636"];

const execFile = promisify(execFileCallback);
let Client: any;
let PostgresCustodyAdapter: any;
let WebSocket: any;
let locklessPaneScopeId: any;
let cliAttemptSequence = 0;

type Options = {
  mode: "fresh-install";
  candidateCommit: string;
  expectedVersion: string;
  candidateElectron: string;
  candidateRoot: string;
  cliBinary: string;
  productSourceDir: string;
  output: string;
  stateRoot: string;
};

type Cluster = {
  adminUrl: string;
  config: PostgresCustodyConfig;
  databaseIdentity: string;
  postgresBin: string;
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
    if (["--baseline-commit", "--baseline-electron", "--baseline-root"].includes(flag)) {
      throw new Error("old_version_smoke_inputs_forbidden");
    }
    if (!new Set(["--mode", "--candidate-commit", "--expected-version", "--candidate-electron", "--candidate-root", "--cli-binary", "--product-source", "--output", "--state-root"]).has(flag)) {
      throw new Error(`unknown_argument:${flag}`);
    }
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
  const mode = values.get("--mode") ?? "fresh-install";
  if (mode !== "fresh-install") throw new Error("old_version_smoke_mode_forbidden");
  return {
    mode: "fresh-install",
    candidateCommit: literal("candidate-commit"),
    expectedVersion: literal("expected-version"),
    candidateElectron: required("candidate-electron"),
    candidateRoot: required("candidate-root"),
    cliBinary: required("cli-binary"),
    productSourceDir: required("product-source"),
    output: required("output"),
    stateRoot: required("state-root"),
  };
}

async function loadProductRuntime(productSourceDir: string) {
  const allocatorPackage = path.join(productSourceDir, "packages/allocator/package.json");
  const allocatorRequire = createRequire(allocatorPackage);
  const allocatorUrl = pathToFileURL(path.join(productSourceDir, "packages/allocator/src/custody.ts"));
  const protocolUrl = pathToFileURL(path.join(productSourceDir, "packages/protocol/src/lockless.ts"));
  const [allocator, protocol] = await Promise.all([import(allocatorUrl.href), import(protocolUrl.href)]);
  Client = allocatorRequire("pg").Client;
  WebSocket = allocatorRequire("ws");
  PostgresCustodyAdapter = allocator.PostgresCustodyAdapter;
  locklessPaneScopeId = protocol.locklessPaneScopeId;
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

async function postgresQuery(url: string, sql: string, values: unknown[] = []): Promise<unknown[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows;
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

async function directWebSocketReady(endpoint: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(endpoint, { handshakeTimeout: 1_000 });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ready) socket.close(1000, "release_smoke_readiness");
      else socket.terminate();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    socket.once("open", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function verifyDisplayReady() {
  const display = process.env.DISPLAY;
  if (typeof display !== "string" || !display) throw new Error("fresh_install_display_not_configured");
  const probe = await command("xdpyinfo", ["-display", display]);
  if (!probe.stdout.includes("dimensions:") || !probe.stdout.includes("vendor string:")) {
    throw new Error("fresh_install_display_probe_invalid");
  }
  return {
    display,
    probeSha256: createHash("sha256").update(probe.stdout).digest("hex"),
    status: "verified",
    tool: "xdpyinfo",
  };
}

async function startPackagedElectronClient(
  executable: string,
  home: string,
  port: number,
  registryEndpoint: string,
  diagnosticLogPath: string,
  label: string,
  expectedVersion: string,
) {
  let started: any;
  try {
    const launch = await launchElectron(
      executable,
      home,
      port,
      undefined,
      registryEndpoint,
      diagnosticLogPath,
    );
    started = launch.started;
    const endpoint = `ws://127.0.0.1:${port}/ws`;
    await waitFor(() => directWebSocketReady(endpoint), `${label}_direct_client_endpoint`);
    const appVersionIdentity = await verifyClientAppVersion(diagnosticLogPath, expectedVersion);
    if (process.platform === "linux") {
      const diagnostic = await fs.readFile(diagnosticLogPath, "utf8");
      if (!diagnostic.includes("[surf-ace:app] event=gpu_disable_requested")) {
        throw new Error(`${label}_linux_software_capture_not_enabled`);
      }
    }
    const userData = electronLaunchConfig(home, port, registryEndpoint).userDataDir;
    const identityPath = path.join(userData, "surface-identity.json");
    const identity = JSON.parse(await fs.readFile(identityPath, "utf8"));
    if (typeof identity.publicKeyPem !== "string" || typeof identity.privateKeyPem !== "string" ||
        typeof identity.fingerprintPrefix !== "string") {
      throw new Error(`${label}_electron_identity_invalid`);
    }
    const expectedFingerprint = createHash("sha256")
      .update(createPublicKey(identity.publicKeyPem).export({ format: "der", type: "spki" }))
      .digest("hex").slice(0, 8);
    if (identity.fingerprintPrefix !== expectedFingerprint) throw new Error(`${label}_electron_identity_fingerprint_mismatch`);
    return {
      endpoint,
      appVersion: appVersionIdentity.version,
      appVersionEvidenceSha256: appVersionIdentity.evidenceSha256,
      home,
      identity,
      identityPath,
      async stop() { return await stopElectron(started); },
    };
  } catch (error) {
    if (started) await stopElectron(started).catch(() => undefined);
    throw error;
  }
}

async function startCluster(root: string, schema: string, initializeFleet = true): Promise<Cluster> {
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
dynamic_shared_memory_type = 'mmap'
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
    if (initializeFleet) {
      const recovery = await PostgresCustodyAdapter.initializeAbsentFleet(config, "alloc_release-smoke");
      await recovery.release();
    }
    return {
      adminUrl,
      config,
      databaseIdentity,
      postgresBin,
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

async function postgresPid(dataDir: string) {
  const pid = Number((await fs.readFile(path.join(dataDir, "postmaster.pid"), "utf8")).split(/\r?\n/, 1)[0]);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("postgres_postmaster_pid_invalid");
  return pid;
}

async function restartPostgresCluster(
  cluster: Cluster,
  expectedProjectionBefore?: Awaited<ReturnType<typeof allocatorDatabaseProjection>>,
) {
  const primaryPidBefore = await postgresPid(cluster.primaryData);
  const witnessPidBefore = await postgresPid(cluster.witnessData);
  const projectionBefore = expectedProjectionBefore ?? await allocatorDatabaseProjection(cluster.adminUrl, cluster.config.fleetId);
  if (projectionBefore.databaseIdentity !== cluster.databaseIdentity) {
    throw new Error("postgres_restart_database_identity_changed_before_restart");
  }
  const pgCtl = path.join(cluster.postgresBin, "pg_ctl");
  const witnessStop = await command(pgCtl, ["-D", cluster.witnessData, "stop", "-m", "fast"]);
  const primaryStop = await command(pgCtl, ["-D", cluster.primaryData, "stop", "-m", "fast"]);
  const primaryStart = await command(pgCtl, ["-D", cluster.primaryData, "-l", path.join(cluster.root, "primary.log"), "start"]);
  const witnessStart = await command(pgCtl, ["-D", cluster.witnessData, "-l", path.join(cluster.root, "witness.log"), "start"]);
  await waitFor(async () => {
    const rows = await postgresQuery(cluster.adminUrl,
      "SELECT sync_state FROM pg_stat_replication WHERE application_name='surf_ace_witness'") as Array<{ sync_state?: string }>;
    return rows.length === 1 && rows[0]?.sync_state === "sync";
  }, "postgres_witness_after_restart");
  const projectionAfter = await allocatorDatabaseProjection(cluster.adminUrl, cluster.config.fleetId);
  if (projectionAfter.databaseIdentity !== cluster.databaseIdentity ||
      projectionAfter.projectionSha256 !== projectionBefore.projectionSha256) {
    throw new Error(`postgres_restart_changed_identity_or_allocator_projection:${JSON.stringify({
      databaseIdentityAfter: projectionAfter.databaseIdentity,
      databaseIdentityBefore: projectionBefore.databaseIdentity,
      projectionAfterSha256: projectionAfter.projectionSha256,
      projectionBeforeSha256: projectionBefore.projectionSha256,
    })}`);
  }
  return {
    databaseIdentity: projectionAfter.databaseIdentity,
    lifecycle: {
      primary: {
        pidAfter: await postgresPid(cluster.primaryData),
        pidBefore: primaryPidBefore,
        startExitCode: 0,
        startStdout: primaryStart.stdout,
        stopExitCode: 0,
        stopStdout: primaryStop.stdout,
      },
      witness: {
        pidAfter: await postgresPid(cluster.witnessData),
        pidBefore: witnessPidBefore,
        startExitCode: 0,
        startStdout: witnessStart.stdout,
        stopExitCode: 0,
        stopStdout: witnessStop.stdout,
      },
    },
    projectionAfterSha256: projectionAfter.projectionSha256,
    projectionBeforeSha256: projectionBefore.projectionSha256,
    status: "verified",
    witnessSynchronized: true,
  };
}

async function cli(binary: string, stateRoot: string, commandName: string, input: unknown, endpoint?: string) {
  const args = ["--state-root", stateRoot];
  if (endpoint) args.push("--endpoint", endpoint, "--product-label", "Surf Ace release smoke");
  args.push(commandName, "--input-json", JSON.stringify(input));
  const progressPath = path.join(path.dirname(stateRoot), "raw-cli-progress.ndjson");
  const attempt = ++cliAttemptSequence;
  const startedAt = Date.now();
  const route = endpoint ? "direct-client-websocket" : "endpointless-local-read";
  await fs.appendFile(progressPath, `${JSON.stringify({ attempt, command: commandName, phase: "started", route, startedAt })}\n`);
  let result: { stdout: string; stderr: string };
  try {
    result = await command(binary, args, { timeout: 120_000, killSignal: "SIGTERM" });
  } catch (error) {
    const failure = error as Error & { code?: number | string; killed?: boolean; signal?: string; stderr?: string; stdout?: string };
    const elapsedMs = Date.now() - startedAt;
    const timedOut = failure.killed === true && elapsedMs >= 120_000;
    await fs.appendFile(progressPath, `${JSON.stringify({
      attempt, command: commandName, elapsedMs, phase: timedOut ? "timed_out" : "failed",
      route, status: failure.code ?? null, signal: failure.signal ?? null,
    })}\n`);
    await fs.appendFile(path.join(path.dirname(stateRoot), "raw-cli-evidence.ndjson"), `${JSON.stringify({
      args,
      command: commandName,
      endpoint: endpoint ?? null,
      input,
      inputJson: JSON.stringify(input),
      route: endpoint ? "direct-client-websocket" : "endpointless-local-read",
      status: failure.code ?? "launch-failed",
      stderr: failure.stderr ?? "",
      stdout: failure.stdout ?? "",
    })}\n`);
    if (timedOut) throw new Error(`packaged_cli_${commandName}_timeout_120s`, { cause: error });
    throw error;
  }
  await fs.appendFile(progressPath, `${JSON.stringify({
    attempt, command: commandName, elapsedMs: Date.now() - startedAt, phase: "exited", route, status: 0,
  })}\n`);
  const parsed = JSON.parse(result.stdout);
  await fs.appendFile(path.join(path.dirname(stateRoot), "raw-cli-evidence.ndjson"), `${JSON.stringify({
    args,
    command: commandName,
    endpoint: endpoint ?? null,
    input,
    inputJson: JSON.stringify(input),
    route: endpoint ? "direct-client-websocket" : "endpointless-local-read",
    status: 0,
    stderr: result.stderr,
    output: parsed,
    stdout: result.stdout,
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

async function packagedAnnotationJournalSmoke(
  registryEndpoint: string,
  cliBinary: string,
  stateRoot: string,
  clientIdValue: string,
  surfaceId: string,
  paneId: number,
  contentId: string,
) {
  const consumerId = `release-${randomUUID()}`;
  const cliArgs = ["--registry", registryEndpoint, "--state-root", stateRoot, "annotations"];
  const listeners: Array<ReturnType<typeof spawn>> = [];
  const progressPath = path.join(path.dirname(stateRoot), "annotation-journal-progress.ndjson");
  let stageSequence = 0;
  const stage = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const sequence = ++stageSequence;
    const startedAt = Date.now();
    await fs.appendFile(progressPath, `${JSON.stringify({ sequence, name, phase: "started", startedAt })}\n`);
    try {
      const result = await operation();
      await fs.appendFile(progressPath, `${JSON.stringify({ sequence, name, phase: "exited", elapsedMs: Date.now() - startedAt })}\n`);
      return result;
    } catch (error) {
      await fs.appendFile(progressPath, `${JSON.stringify({
        sequence, name, phase: "failed", elapsedMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "unknown",
      })}\n`);
      throw error;
    }
  };
  const stream = (action: "watch" | "resume") => {
    const child = spawn(cliBinary, [...cliArgs, action, "--consumer-id", consumerId],
      { stdio: ["ignore", "pipe", "pipe"] });
    listeners.push(child);
    const lines: any[] = [];
    let buffer = "";
    let stderr = "";
    let exited: string | null = null;
    let parseError: string | null = null;
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { lines.push(JSON.parse(line)); }
        catch (error) { parseError = String(error); }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { exited = String(error); });
    child.on("exit", (code, signal) => { exited = `${code ?? signal ?? "unknown"}`; });
    const waitLines = async (count: number) => {
      await waitFor(async () => {
        if (parseError) throw new Error(`annotation_${action}_invalid_ndjson:${parseError}`);
        if (exited && lines.length < count) throw new Error(`annotation_${action}_exited:${exited}:${stderr}`);
        return lines.length >= count;
      }, `annotation_${action}_${count}_lines`, 10_000);
      return lines;
    };
    return { waitLines };
  };
  let socket: any;
  try {
    const watch = stream("watch");
    const subscription = (await stage("watch_subscription", () => watch.waitLines(1)))[0];
    if (subscription?.type !== "annotation.subscription" || subscription.consumerId !== consumerId) {
      throw new Error("annotation_packaged_watch_subscription_invalid");
    }
    // Open after the watch subscription; otherwise a fast local connection can emit
    // "open" before the listener is installed and leave this smoke waiting forever.
    await stage("registry_websocket_open", () => {
      socket = new WebSocket(registryEndpoint, { handshakeTimeout: 10_000 });
      return waitForWebSocketOpen(socket, 10_000);
    });
    const request = async (op: string, payload: unknown) => {
      const id = `annotation_release_${randomUUID()}`;
      return await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => { socket.off("message", onMessage); reject(new Error(`${op}_timeout`)); }, 10_000);
        const onMessage = (data: any) => {
          const value = JSON.parse(data.toString());
          if (value.id !== id) return;
          clearTimeout(timeout);
          socket.off("message", onMessage);
          if (value.ok !== true) reject(new Error(`${op}_failed:${JSON.stringify(value.error)}`));
          else resolve(value.payload);
        };
        socket.on("message", onMessage);
        socket.send(JSON.stringify({ id, op, payload, sentAt: Date.now(), type: "request", v: 1 }));
      });
    };
    const hello = await stage("hello", () => request("annotation.hello", { protocolVersion: 1, role: "publisher" }));
    if (!/^[0-9a-f]{32}$/.test(hello?.journalEpoch ?? "")) throw new Error("annotation_packaged_hello_invalid");
    const sourceEventId = `event-${randomUUID()}`;
    const record = {
      protocolVersion: 1, clientId: clientIdValue, sourceEpoch: randomBytes(16).toString("hex"),
      surfaceId, paneId, frameId: `frame-${randomUUID()}`, sourceSequence: "1",
      sourceEventId, kind: "live_delta", contentId, revision: 1, contentType: "html",
      viewport: { scrollOffset: { x: 0, y: 0 }, visibleRect: { x: 0, y: 0, width: 10, height: 10 },
        contentSize: { width: 10, height: 10 }, zoomLevel: 1 },
      sourceTimestamp: new Date().toISOString(), payload: { strokes: [{ strokeId: `stroke-${randomUUID()}` }] },
    };
    const accepted = await stage("ingest", () => request("annotation.ingest", { record }));
    const delivered = (await stage("watch_delivery", () => watch.waitLines(2)))[1];
    const cursor = delivered?.payload?.serverCursor;
    if (delivered?.op !== "annotation.record" ||
        delivered?.payload?.record?.sourceEventId !== sourceEventId ||
        typeof cursor !== "string" || !/^ann1:[0-9a-f]{32}:1$/.test(cursor)) {
      throw new Error("annotation_packaged_watch_delivery_invalid");
    }
    const acknowledged = JSON.parse((await stage("ack", () => command(cliBinary,
      [...cliArgs, "ack", "--consumer-id", consumerId, "--cursor", cursor],
      { timeout: 120_000, killSignal: "SIGTERM" }))).stdout);
    if (acknowledged?.ackCursor !== cursor) throw new Error("annotation_packaged_ack_invalid");
    const resumed = stream("resume");
    const resumeSubscription = (await stage("resume_subscription", () => resumed.waitLines(1)))[0];
    if (resumeSubscription?.type !== "annotation.subscription" || resumeSubscription?.ackCursor !== cursor) {
      throw new Error("annotation_packaged_resume_invalid");
    }
    const retired = JSON.parse((await stage("retire", () => command(cliBinary,
      [...cliArgs, "retire", "--consumer-id", consumerId, "--expect-ack", cursor,
        "--discard-unacknowledged"], { timeout: 120_000, killSignal: "SIGTERM" }))).stdout);
    if (retired?.type !== "annotation.consumer_retired") throw new Error("annotation_packaged_retire_invalid");
    return { ackCursor: cursor, consumerId, journalEpoch: hello.journalEpoch,
      recordSourceEventId: sourceEventId, acceptedCursor: accepted?.serverCursor ?? null,
      status: "verified" };
  } finally {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    else socket?.terminate();
    for (const child of listeners) child.kill();
  }
}

async function waitForRegisteredSurface(endpoint: string, clientIdValue: string, surfaceId: string, label: string) {
  let topology: any;
  let client: any;
  let registeredSurface: any;
  await waitFor(async () => {
    topology = await centralRequest(endpoint, "fleet.topology", {});
    client = topology?.clients?.find((candidate: any) => candidate?.clientId === clientIdValue);
    registeredSurface = client?.surfaces?.find((candidate: any) => candidate?.surfaceId === surfaceId);
    return Boolean(registeredSurface);
  }, `${label}_registry_registration`);
  if (typeof client?.clientId !== "string" || !Array.isArray(registeredSurface?.panes) ||
      typeof registeredSurface?.windowLabel !== "string") {
    throw new Error(`${label}_registry_registration_shape_invalid`);
  }
  return { client, surface: registeredSurface, topology };
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

function matchesFreshInstallCurrentContent(record: any, contentId: string, surfaceId: string, paneId: number) {
  const payload = record?.payload;
  return record?.recordClass === "content" && payload && typeof payload === "object" && !Array.isArray(payload) &&
    payload.contentId === contentId && payload.surfaceId === surfaceId &&
    Number.isSafeInteger(payload.paneId) && payload.paneId === paneId &&
    typeof payload.historyEntryId === "string" && payload.historyEntryId.length > 0 &&
    Number.isSafeInteger(payload.revision) && payload.revision > 0;
}

async function readPane(binary: string, stateRoot: string, endpoint: string, surfaceId: string, paneId: number) {
  const captureOutput = await cli(binary, stateRoot, "capture-pane", {
    includeDrawings: true,
    paneId,
    surfaceId,
  }, endpoint);
  const scopeId = locklessPaneScopeId(surfaceId, paneId);
  const output = await cli(binary, stateRoot, "read", { scopeId });
  const result = resultPayload(output);
  if (result?.scopeId !== scopeId || result?.cacheStatus !== "current" || result?.consumableLoss !== null) {
    throw new Error(`packaged_cli_read_not_current:${scopeId}`);
  }
  return { captureOutput, endpoint, output, paneId, scopeId, surfaceId };
}

const allocatorProjectionTables = [
  ["fleet_tombstones", "fleet_id"],
  ["fleets", "fleet_id"],
  ["authority_owners", "allocator_id, generation_id, authority_id, owner_anchor_id"],
  ["allocation_transactions", "generation_id, transaction_id"],
  ["assignments", "generation_id, ordinal, surface_id"],
  ["custody_journal", "head_seq"],
  ["custody_revision_heads", "custody_revision"],
  ["restore_generations", "generation_id"],
] as const;

async function allocatorDatabaseProjection(adminUrl: string, fleetId: string) {
  const identityRows = await postgresQuery(adminUrl, "SELECT (pg_control_system()).system_identifier::text AS id") as Array<{ id?: string }>;
  const databaseIdentity = identityRows[0]?.id;
  if (!databaseIdentity) throw new Error("postgres_projection_identity_missing");
  const tables: Record<string, unknown[]> = {};
  for (const [table, order] of allocatorProjectionTables) {
    const rows = await postgresQuery(
      adminUrl,
      `SELECT to_jsonb(t) AS value FROM surf_ace_allocator.${table} AS t WHERE t.fleet_id = $1 ORDER BY ${order}`,
      [fleetId],
    ) as Array<{ value: unknown }>;
    tables[table] = rows.map(({ value }) => value);
  }
  const bytes = JSON.stringify(tables);
  return {
    databaseIdentity,
    projectionSha256: createHash("sha256").update(bytes).digest("hex"),
    tables,
  };
}

async function allocatorDiagnostics(adminUrl: string, fleetId: string) {
  const rows = await postgresQuery(adminUrl, `
    SELECT f.allocator_id AS "allocatorId",
           f.state_version AS "stateVersion",
           f.next_ordinal_fence::text AS "nextOrdinalFence",
           f.head_seq::text AS "primaryHeadSeq",
           encode(f.head_hash, 'hex') AS "primaryHeadHash",
           f.lifecycle,
           (SELECT count(*) FROM surf_ace_allocator.assignments AS a
             WHERE a.fleet_id = f.fleet_id AND a.allocator_id = f.allocator_id)::text AS "assignmentCount"
    FROM surf_ace_allocator.fleets AS f
    WHERE f.fleet_id = $1
  `, [fleetId]) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw new Error("allocator_diagnostics_fleet_missing");
  return {
    allocatorId: String(row.allocatorId),
    assignmentCount: Number(row.assignmentCount),
    lifecycle: String(row.lifecycle),
    nextOrdinalFence: Number(row.nextOrdinalFence),
    primaryHeadHash: String(row.primaryHeadHash),
    primaryHeadSeq: Number(row.primaryHeadSeq),
    stateVersion: Number(row.stateVersion),
  };
}

async function startPackagedServer(launcher: string, config: unknown, root: string, label: string) {
  const configPath = path.join(root, `${label}.server.json`);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  const validation = JSON.parse((await command(process.execPath, [launcher, "validate", "--config", configPath])).stdout);
  if (validation.event !== "config-valid") throw new Error(`${label}_packaged_server_config_rejected`);

  const child = spawn(process.execPath, [launcher, "start", "--config", configPath], {
    cwd: path.dirname(launcher),
    env: {
      ...process.env,
      SURF_ACE_CLIENT_DIAGNOSTIC_LOG: path.join(root, `${label}.client-flight-recorder.log`),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events: any[] = [];
  const diagnosticEvents: string[] = [];
  let lastSelfCheckError: string | undefined;
  const diagnosticDigest = createHash("sha256");
  let diagnosticLineCount = 0;
  let pending = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderrTail = "";
  let readyResolve!: (value: any) => void;
  let readyReject!: (error: Error) => void;
  const readyPromise = new Promise<any>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    pending += chunk.toString("utf8");
    while (pending.includes("\n")) {
      const newline = pending.indexOf("\n");
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const parsed = tightbeamServerLauncher.parseForegroundOutputLine(line);
        if (parsed.kind === "diagnostic") {
          diagnosticLineCount += 1;
          diagnosticEvents.push(parsed.event);
          diagnosticDigest.update(`${line}\n`);
          if (parsed.event === "self_check_unhealthy") {
            const encoded = line.match(/\berror=("(?:[^"\\]|\\.)*")/);
            if (encoded) {
              try { lastSelfCheckError = String(JSON.parse(encoded[1])).slice(0, 256); } catch { /* Keep the prior valid diagnostic. */ }
            }
          }
          continue;
        }
        const event = parsed.event;
        events.push(event);
        if (event.event === "ready") readyResolve(event);
      } catch (error) {
        // Only framed launcher events and the packaged server diagnostic vocabulary may share stdout.
        const reason = typeof (error as any)?.publicCode === "string"
          ? (error as any).publicCode
          : error instanceof Error ? error.name : "unknown";
        const outputIssue = typeof (error as any)?.outputIssue === "string" ? (error as any).outputIssue : "unknown";
        readyReject(new Error(`${label}_packaged_server_output_invalid:${reason}:${outputIssue}`));
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-16_384);
  });
  child.once("close", (code, signal) => {
    if (!events.some((event) => event.event === "ready")) {
      const diagnosticTokens = stderrTail.split("\n").flatMap((line) => {
        try {
          const diagnostic = JSON.parse(line) as Record<string, unknown>;
          return [diagnostic.event, diagnostic.code, diagnostic.name, diagnostic.causeCode]
            .filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value));
        } catch { return []; }
      }).slice(-8);
      readyReject(new Error(`${label}_packaged_server_exited_before_ready:${code ?? signal ?? "unknown"}:stderr_events=${diagnosticTokens.join(",") || "none"}:stderr_sha256=${createHash("sha256").update(stderrTail).digest("hex")}`));
    }
  });

  let ready: any;
  let readyTimeout: NodeJS.Timeout | undefined;
  try {
    ready = await Promise.race([
      readyPromise,
      new Promise((_, reject) => {
        readyTimeout = setTimeout(() => reject(new Error(
          `${label}_packaged_server_ready_timeout:${lastSelfCheckError ?? "no_self_check_error"}`,
        )), 30_000);
      }),
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    throw error;
  } finally {
    if (readyTimeout) clearTimeout(readyTimeout);
  }
  if (ready.pid !== child.pid || typeof ready.endpoint !== "string" || !ready.endpoint.endsWith("/ws")) {
    child.kill("SIGTERM");
    await closePromise;
    throw new Error(`${label}_packaged_server_ready_binding_invalid`);
  }
  const health = JSON.parse((await command(process.execPath, [launcher, "health", "--endpoint", ready.endpoint])).stdout);
  if (health.event !== "health" || health.status !== "healthy" || health.transport !== "fleet.topology") {
    child.kill("SIGTERM");
    await closePromise;
    throw new Error(`${label}_packaged_server_health_failed`);
  }
  return {
    endpoint: ready.endpoint as string,
    health,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const closed = await Promise.race([
        closePromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label}_packaged_server_shutdown_timeout`)), 30_000)),
      ]);
      const stopped = events.find((event) => event.event === "stopped");
      if (closed.code !== 0 || stopped?.status !== "clean" || stopped?.pid !== child.pid) {
        const diagnostics = stderrTail.split("\n").flatMap((line) => {
          try {
            const event = JSON.parse(line);
            return event?.event === "shutdown_error" ? [event] : [];
          } catch { return []; }
        });
        const diagnostic = diagnostics.at(-1);
        const witnessEvents = diagnosticEvents.filter((event) => event.startsWith("release_witness_")).slice(-6);
        const detail = diagnostic
          ? [diagnostic.name, diagnostic.code, diagnostic.causeCode, diagnostic.frames?.[0]]
            .filter((value) => typeof value === "string" && value.length > 0).join("|")
          : "missing_shutdown_diagnostic";
        throw new Error(`${label}_packaged_server_shutdown_invalid:${closed.code ?? closed.signal ?? "unknown"}:${detail}|witness_events=${witnessEvents.join(",") || "none"}`);
      }
      return {
        exitCode: closed.code,
        pid: child.pid,
        ready,
        packagedDiagnostics: {
          events: [...diagnosticEvents],
          releaseWitnessEvents: diagnosticEvents.filter((event) => event.startsWith("release_witness_")),
          lineCount: diagnosticLineCount,
          sha256: diagnosticDigest.digest("hex"),
        },
        signal: closed.signal,
        stderrBytes,
        stdoutBytes,
        stopped,
      };
    },
  };
}

async function stagedPostgresRestore(options: {
  candidateAfter: any;
  candidateInstallRoot: string;
  cluster: Cluster;
  stateRoot: string;
}) {
  const recoveryRoot = path.join(options.stateRoot, "postgres-staged-restore");
  await fs.mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
  const lifecycleEvidencePath = path.join(recoveryRoot, "staged-server-lifecycle.json");
  const lifecycleEvidence: Record<string, any> = { snapshots: {}, checks: {} };
  const persistLifecycleEvidence = async () => {
    await fs.writeFile(lifecycleEvidencePath, `${JSON.stringify(lifecycleEvidence, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(lifecycleEvidencePath, 0o600);
  };
  const backupPath = path.join(recoveryRoot, "candidate-before-staged-restore.dump");
  const backupListPath = path.join(recoveryRoot, "candidate-before-staged-restore.list");
  const sourceBefore = await allocatorDatabaseProjection(options.cluster.adminUrl, options.cluster.config.fleetId);
  lifecycleEvidence.snapshots.sourceBefore = sourceBefore;
  await persistLifecycleEvidence();
  await command(path.join(options.cluster.postgresBin, "pg_dump"), [
    "--format=custom", "--file", backupPath, options.cluster.adminUrl,
  ]);
  await fs.chmod(backupPath, 0o600);
  const backupStat = await fs.stat(backupPath);
  if (backupStat.size < 1) throw new Error("postgres_backup_empty");
  const backupList = await command(path.join(options.cluster.postgresBin, "pg_restore"), ["--list", backupPath]);
  await fs.writeFile(backupListPath, backupList.stdout, { mode: 0o600 });
  await fs.chmod(backupListPath, 0o600);
  if (!hasRequiredAllocatorBackupObjects(backupList.stdout)) {
    throw new Error("postgres_backup_allocator_objects_missing");
  }
  const backupBytes = await fs.readFile(backupPath);
  const backupSha256 = createHash("sha256").update(backupBytes).digest("hex");
  const backupListSha256 = createHash("sha256").update(backupList.stdout).digest("hex");

  const stage = await startCluster(
    path.join(recoveryRoot, "staging-cluster"),
    path.join(options.candidateInstallRoot, "schemas/allocator/001_allocator.sql"),
    false,
  );
  let serverProcess: Awaited<ReturnType<typeof startPackagedServer>> | undefined;
  try {
    await command(path.join(stage.postgresBin, "pg_restore"), [
      "--clean", "--if-exists", "--exit-on-error", "--dbname", stage.adminUrl, backupPath,
    ]);
    const stagedBeforeStart = await allocatorDatabaseProjection(stage.adminUrl, stage.config.fleetId);
    lifecycleEvidence.snapshots.stagedBeforeStart = stagedBeforeStart;
    await persistLifecycleEvidence();
    if (stagedBeforeStart.projectionSha256 !== sourceBefore.projectionSha256) {
      throw new Error("postgres_staged_restore_projection_mismatch");
    }
    const schemaChecks = await postgresQuery(stage.adminUrl, `
      SELECT
        to_regclass('surf_ace_allocator.fleets') IS NOT NULL AS has_fleets,
        to_regclass('surf_ace_allocator.custody_journal') IS NOT NULL AS has_journal,
        to_regprocedure('surf_ace_allocator.read_accepted_state(text)') IS NOT NULL AS has_read_state,
        to_regprocedure('surf_ace_allocator.validate_journal(text)') IS NOT NULL AS has_journal_validator
    `) as Array<Record<string, boolean>>;
    const schema = schemaChecks[0];
    if (!schema?.has_fleets || !schema.has_journal || !schema.has_read_state || !schema.has_journal_validator) {
      throw new Error("postgres_staged_restore_schema_contract_mismatch");
    }

    const serverConfig = {
      custody: stage.config,
      hostLockPath: path.join(recoveryRoot, "staging-server.lock"),
      listenHost: "0.0.0.0",
      listenPort: await freePort(),
      name: "Surf Ace PG16 staged restore smoke",
    };
    const launcher = path.join(options.candidateInstallRoot, "bin/surf-ace-server");
    serverProcess = await startPackagedServer(launcher, serverConfig, recoveryRoot, "staged");
    const stagedAfterService = await allocatorDatabaseProjection(stage.adminUrl, stage.config.fleetId);
    lifecycleEvidence.snapshots.stagedAfterService = stagedAfterService;
    await persistLifecycleEvidence();
    const activeCheck = verifyAllocatorServiceLifecycle(stagedBeforeStart, stagedAfterService, "active");
    lifecycleEvidence.checks.serviceStart = activeCheck;
    await persistLifecycleEvidence();
    if (!activeCheck.ok) throw new Error(`postgres_staged_service_start_mutated_semantics:${activeCheck.reason}`);

    const explicitHealth = JSON.parse((await command(process.execPath, [
      launcher, "health", "--endpoint", serverProcess.endpoint,
    ])).stdout);
    const stagedAfterHealth = await allocatorDatabaseProjection(stage.adminUrl, stage.config.fleetId);
    lifecycleEvidence.health = explicitHealth;
    lifecycleEvidence.snapshots.stagedAfterHealth = stagedAfterHealth;
    lifecycleEvidence.checks.healthRead = {
      afterProjectionSha256: stagedAfterHealth.projectionSha256,
      beforeProjectionSha256: stagedAfterService.projectionSha256,
      ok: stagedAfterHealth.projectionSha256 === stagedAfterService.projectionSha256 &&
        explicitHealth.event === "health" && explicitHealth.status === "healthy" &&
        explicitHealth.transport === "fleet.topology",
    };
    await persistLifecycleEvidence();
    if (!lifecycleEvidence.checks.healthRead.ok) {
      throw new Error("postgres_staged_packaged_health_changed_projection");
    }

    const health = serverProcess.health;
    const lifecycle = await serverProcess.stop();
    serverProcess = undefined;
    const stagedAfterRelease = await allocatorDatabaseProjection(stage.adminUrl, stage.config.fleetId);
    lifecycleEvidence.lifecycle = lifecycle;
    lifecycleEvidence.snapshots.stagedAfterRelease = stagedAfterRelease;
    lifecycleEvidence.checks.serviceRelease = verifyAllocatorServiceLifecycle(stagedAfterHealth, stagedAfterRelease, "released");
    lifecycleEvidence.checks.completeCycle = verifyAllocatorServiceLifecycle(stagedBeforeStart, stagedAfterRelease, "completed");
    await persistLifecycleEvidence();
    if (!lifecycleEvidence.checks.serviceRelease.ok) {
      throw new Error(`postgres_staged_service_release_mutated_semantics:${lifecycleEvidence.checks.serviceRelease.reason}`);
    }
    if (!lifecycleEvidence.checks.completeCycle.ok) {
      throw new Error(`postgres_staged_service_cycle_mutated_semantics:${lifecycleEvidence.checks.completeCycle.reason}`);
    }

    const originalAfterStage = await allocatorDatabaseProjection(options.cluster.adminUrl, options.cluster.config.fleetId);
    lifecycleEvidence.snapshots.originalAfterStage = originalAfterStage;
    await persistLifecycleEvidence();
    if (originalAfterStage.projectionSha256 !== sourceBefore.projectionSha256) {
      throw new Error("postgres_staged_restore_changed_rollback_source");
    }
    const candidateContentId = contentRecordId(options.candidateAfter.currentContentRecord);
    const directRead = options.candidateAfter.readEvidence?.find((read: any) =>
      contentRecordId(resultPayload(read.output)?.currentContentRecord) === candidateContentId,
    );
    if (!candidateContentId || !directRead || resultPayload(directRead.output)?.cacheStatus !== "current" ||
        resultPayload(directRead.output)?.consumableLoss !== null) {
      throw new Error("postgres_recovery_direct_client_evidence_missing");
    }
    return {
      backup: { bytes: backupStat.size, format: "custom", listSha256: backupListSha256, sha256: backupSha256 },
      clientObservation: {
        endpoint: directRead.endpoint,
        paneId: directRead.paneId,
        route: "packaged-cli-direct-client",
        surfaceId: directRead.surfaceId,
      },
      rollback: {
        originalProjectionAfterStageSha256: originalAfterStage.projectionSha256,
        originalProjectionBeforeStageSha256: sourceBefore.projectionSha256,
        strategy: "discard-staging-and-retain-original",
        verified: originalAfterStage.projectionSha256 === sourceBefore.projectionSha256,
      },
      schema,
      sourceDatabaseIdentity: sourceBefore.databaseIdentity,
      stagedDatabaseIdentity: stagedBeforeStart.databaseIdentity,
      stagedServer: { health, lifecycle },
      stagedLifecycleEvidence: {
        checks: lifecycleEvidence.checks,
        health,
        path: lifecycleEvidencePath,
        sha256: createHash("sha256").update(await fs.readFile(lifecycleEvidencePath)).digest("hex"),
      },
      stagedProjectionAfterReleaseSha256: stagedAfterRelease.projectionSha256,
      stagedProjectionAfterServiceSha256: stagedAfterService.projectionSha256,
      stagedProjectionBeforeServiceSha256: stagedBeforeStart.projectionSha256,
    };
  } finally {
    if (serverProcess) await serverProcess.stop().catch(() => undefined);
    await stage.stop();
  }
}

async function rejectedWrongSurfacePush(binary: string, stateRoot: string, endpoint: string, input: any) {
  const { expectedSurfaceId, ...request } = input;
  if (typeof expectedSurfaceId !== "string" || !expectedSurfaceId || expectedSurfaceId === request.surfaceId) {
    throw new Error("fresh_install_wrong_surface_expectation_invalid");
  }
  const inputJson = JSON.stringify(request);
  const args = [
    "--state-root", stateRoot,
    "--endpoint", endpoint,
    "--product-label", "Surf Ace release smoke",
    "push", "--input-json", inputJson,
  ];
  let exitStatus: number | string = 0;
  let stdout = "";
  let stderr = "";
  let output: any;
  try {
    const result = await command(binary, args);
    stdout = result.stdout;
    stderr = result.stderr;
    try { output = JSON.parse(stdout); } catch { output = undefined; }
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    exitStatus = Number.isSafeInteger(failure.code) ? failure.code! : "launch-failed";
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
    try { output = JSON.parse(stdout); } catch { output = undefined; }
  }
  const expectedDenial = `unknown_surface:${request.surfaceId}`;
  const expectedRejection = {
    code: "unknown_surface",
    expectedSurfaceId,
    requestedSurfaceId: request.surfaceId,
  };
  const evidence = {
    args,
    command: "push",
    endpoint,
    expectedRejection,
    input: request,
    inputJson,
    output,
    route: "direct-client-websocket",
    status: exitStatus,
    stderr,
    stdout,
  };
  await fs.appendFile(path.join(path.dirname(stateRoot), "raw-cli-evidence.ndjson"), `${JSON.stringify(evidence)}\n`);
  if (!Number.isSafeInteger(exitStatus) || exitStatus < 1 || !(stdout + stderr).includes(expectedDenial)) {
    throw new Error(`fresh_install_wrong_surface_unexpected_result:${stdout || stderr || exitStatus}`);
  }
  return {
    args,
    directClientEndpoint: endpoint,
    errorCode: "unknown_surface",
    endpoint,
    expectedSurfaceId,
    exitStatus,
    inputJson,
    request,
    rawOutput: stdout,
    rawStderr: stderr,
    requestedSurfaceId: request.surfaceId,
    route: "direct-client-websocket",
    status: "rejected",
  };
}

function summarizeFreshInstallPhase(options: {
  app: Awaited<ReturnType<typeof startPackagedElectronClient>>;
  databaseIdentity: string;
  diagnosticsAfterRegistration: Record<string, any>;
  directList: any;
  read: any;
  registration: any;
  registryEndpoint: string;
  sourceCommit: string;
}) {
  const listed = listedSurface(options.directList, options.read.surfaceId);
  const pane = listed.topology.panes.find((candidate: any) => Number(candidate.paneId) === options.read.paneId);
  const registeredPane = options.registration.surface.panes.find((candidate: any) => Number(candidate.paneId) === options.read.paneId);
  const capture = resultPayload(options.read.captureOutput);
  const read = resultPayload(options.read.output);
  const currentContentRecord = read?.currentContentRecord ?? null;
  return {
    clientAppVersion: options.app.appVersion,
    clientAppVersionEvidenceSha256: options.app.appVersionEvidenceSha256,
    capture: {
      contentId: capture?.contentId ?? null,
      paneId: Number(capture?.paneId),
      pixelEvidence: inspectScreenshotPixels(capture?.image, expectedScreenshotColors),
      requestSurfaceId: options.read.surfaceId,
      responseSurfaceId: capture?.surfaceId ?? null,
    },
    clientIdentity: options.app.identity.fingerprintPrefix,
    commandRoute: "direct-client-websocket",
    controllerIdentity: options.read.output?.controllerInstanceId ?? null,
    currentRead: {
      cacheStatus: read?.cacheStatus ?? null,
      consumableLoss: read?.consumableLoss ?? null,
      content: currentContentRecord,
      contentId: contentRecordId(currentContentRecord),
      scopeId: read?.scopeId ?? null,
    },
    databaseIdentity: options.databaseIdentity,
    directClientEndpoint: options.app.endpoint,
    paneId: Number(options.read.paneId),
    paneLabel: Number(pane?.paneLabel),
    registeredClientId: options.registration.client.clientId,
    registeredPaneIds: options.registration.surface.panes.map((candidate: any) => Number(candidate.paneId)).sort((left: number, right: number) => left - right),
    registeredPaneLabel: Number(registeredPane?.paneLabel),
    registeredSurfaceId: options.registration.surface.surfaceId,
    registeredWindowLabel: options.registration.surface.windowLabel,
    registrationIdentity: options.registration.client.clientId,
    registryEndpoint: options.registryEndpoint,
    sourceCommit: options.sourceCommit,
    surfaceId: listed.surfaceId,
    allocatorAfterRegistration: options.diagnosticsAfterRegistration,
    windowLabel: listed.topology.windowLabel ?? null,
  };
}

async function packagedV023MigrationSmoke(options: Options) {
  const baselineSchema = path.join(options.productSourceDir, "scripts/release/fixtures/001_allocator_v023.sql");
  const migration = path.join(options.candidateRoot, "schemas/allocator/002_fleet_panes.sql");
  const annotationMigration = path.join(options.candidateRoot, "schemas/allocator/003_annotation_journal.sql");
  const cluster = await startCluster(path.join(options.stateRoot, "v023-migration-primary"), baselineSchema, false);
  const backup = path.join(options.stateRoot, "v023-pre-migration.dump");
  let stage: Cluster | undefined;
  try {
    const recovery = new Client({ connectionString: cluster.config.recoveryUrl });
    await recovery.connect();
    try {
      const leaseId = `lease_${randomBytes(16).toString("base64url")}`;
      const generationId = `generation_${randomUUID().replaceAll("-", "")}`;
      await recovery.query(
        "SELECT pg_advisory_lock(key1, key2) FROM surf_ace_allocator.advisory_keys($1)",
        [cluster.config.fleetId],
      );
      await recovery.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await recovery.query("SET LOCAL synchronous_commit = 'remote_apply'");
      await recovery.query("SELECT * FROM surf_ace_allocator.initialize_fleet($1, $2, $3, $4)",
        [cluster.config.fleetId, "alloc_release-smoke", generationId, leaseId]);
      await recovery.query("COMMIT");
      await recovery.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await recovery.query("SET LOCAL synchronous_commit = 'remote_apply'");
      await recovery.query("SELECT surf_ace_allocator.release_lease($1, $2, $3, $4)",
        [cluster.config.fleetId, 1, leaseId, "recovery"]);
      await recovery.query("COMMIT");
    } finally {
      await recovery.end();
    }
    const before = await allocatorDiagnostics(cluster.adminUrl, cluster.config.fleetId);
    if (before.primaryHeadSeq < 1) throw new Error("v023_migration_fixture_not_populated");
    await command(path.join(cluster.postgresBin, "pg_dump"), [
      "--format=custom", "--file", backup, cluster.adminUrl,
    ]);
    const backupBytes = await fs.readFile(backup);
    const backupList = (await command(path.join(cluster.postgresBin, "pg_restore"), ["--list", backup])).stdout;
    if (backupBytes.length < 1 || !hasRequiredAllocatorBackupObjects(backupList)) {
      throw new Error("v023_migration_backup_unverified");
    }
    await command(path.join(cluster.postgresBin, "psql"), [cluster.adminUrl, "-v", "ON_ERROR_STOP=1", "-f", migration]);
    await command(path.join(cluster.postgresBin, "psql"), [cluster.adminUrl, "-v", "ON_ERROR_STOP=1", "-f", migration]);
    await command(path.join(cluster.postgresBin, "psql"), [cluster.adminUrl, "-v", "ON_ERROR_STOP=1", "-f", annotationMigration]);
    const annotationRows = await postgresQuery(cluster.adminUrl, `
      SELECT epoch, head_sequence::text AS "headSequence"
      FROM surf_ace_allocator.annotation_journal_head WHERE fleet_id = $1
    `, [cluster.config.fleetId]) as Array<{ epoch: string; headSequence: string }>;
    if (!/^[0-9a-f]{32}$/.test(annotationRows[0]?.epoch ?? "") || annotationRows[0]?.headSequence !== "0") {
      throw new Error("v023_migration_annotation_head_invalid");
    }
    const after = await allocatorDiagnostics(cluster.adminUrl, cluster.config.fleetId);
    if (after.primaryHeadSeq !== before.primaryHeadSeq ||
        after.primaryHeadHash !== before.primaryHeadHash ||
        after.nextOrdinalFence !== before.nextOrdinalFence ||
        after.assignmentCount !== before.assignmentCount) {
      throw new Error("v023_migration_changed_accepted_journal_head");
    }
    const contract = await postgresQuery(cluster.adminUrl, `
      SELECT next_pane_ordinal_fence::text AS "paneFence",
        has_function_privilege('allocator_writer',
          'surf_ace_allocator.claim_pane(text,bigint,text,text,text,text,text)', 'EXECUTE') AS "writerCanClaim",
        (surf_ace_allocator.read_accepted_state(fleet_id) ? 'paneMappings') AS "stateHasPanes"
      FROM surf_ace_allocator.fleets WHERE fleet_id = $1
    `, [cluster.config.fleetId]) as Array<{ paneFence: string; writerCanClaim: boolean; stateHasPanes: boolean }>;
    if (contract[0]?.paneFence !== "1" || contract[0]?.writerCanClaim !== true ||
        contract[0]?.stateHasPanes !== true) {
      throw new Error("v023_migration_pane_custody_contract_invalid");
    }
    stage = await startCluster(path.join(options.stateRoot, "v023-backup-restore"), baselineSchema, false);
    await command(path.join(stage.postgresBin, "pg_restore"), [
      "--clean", "--if-exists", "--exit-on-error", "--dbname", stage.adminUrl, backup,
    ]);
    const restored = await allocatorDiagnostics(stage.adminUrl, cluster.config.fleetId);
    if (restored.primaryHeadSeq !== before.primaryHeadSeq ||
        restored.primaryHeadHash !== before.primaryHeadHash) {
      throw new Error("v023_migration_backup_restore_head_mismatch");
    }
    return {
      backupSha256: createHash("sha256").update(backupBytes).digest("hex"),
      headHashBefore: before.primaryHeadHash,
      headHashAfter: after.primaryHeadHash,
      headSeqBefore: before.primaryHeadSeq,
      headSeqAfter: after.primaryHeadSeq,
      restoredHeadHash: restored.primaryHeadHash,
      annotationEpoch: annotationRows[0].epoch,
      writerCanClaim: true,
      witnessSynchronized: true,
    };
  } finally {
    if (stage) await stage.stop();
    await cluster.stop();
  }
}

async function freshInstallMain(options: Options) {
  if (options.candidateCommit !== TIGHTBEAM.candidateCommit || options.expectedVersion !== TIGHTBEAM.version) {
    throw new Error("fresh_install_participant_identity_binding_invalid");
  }
  await fs.mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
  const migrationEvidence = await packagedV023MigrationSmoke(options);
  const clusterRoot = path.join(options.stateRoot, "postgres");
  const cluster = await startCluster(clusterRoot, path.join(options.candidateRoot, "schemas/allocator/001_allocator.sql"));
  const cliStateRoot = path.join(options.stateRoot, "cli");
  const clientHome = path.join(options.stateRoot, "client-home");
  const registryLauncher = path.join(options.candidateRoot, "bin/surf-ace-server");
  const registryConfig = {
    custody: cluster.config,
    hostLockPath: path.join(cluster.root, "registry.lock"),
    listenHost: "0.0.0.0",
    listenPort: await freePort(),
    name: "Surf Ace Linux fresh-install qualification",
  };
  let registryProcess: Awaited<ReturnType<typeof startPackagedServer>> | undefined;
  let app: Awaited<ReturnType<typeof startPackagedElectronClient>> | undefined;
  let secondApp: Awaited<ReturnType<typeof startPackagedElectronClient>> | undefined;
  let clusterStopped = false;
  let clientStopped = false;
  let registryStopped = false;
  let lastCaptureImage: string | undefined;
  const readVisiblePane = (endpoint: string, surfaceId: string, paneId: number) =>
    waitForScreenshotPixels(
      () => readPane(options.cliBinary, cliStateRoot, endpoint, surfaceId, paneId),
      (read) => inspectScreenshotPixels(resultPayload(read.captureOutput)?.image, expectedScreenshotColors),
      { onAttempt: (read) => { lastCaptureImage = resultPayload(read.captureOutput)?.image; } },
    );
  try {
    await command(path.join(cluster.postgresBin, "psql"), [cluster.adminUrl, "-v", "ON_ERROR_STOP=1", "-f",
      path.join(options.candidateRoot, "schemas/allocator/003_annotation_journal.sql")]);
    registryProcess = await startPackagedServer(registryLauncher, registryConfig, cluster.root, "fresh-install-registry");
    const registryEndpoint = registryProcess.endpoint;
    const initialRegistryHealth = registryProcess.health;
    const displayReady = await verifyDisplayReady();
    const clientPort = await freePort();
    app = await startPackagedElectronClient(
      options.candidateElectron,
      clientHome,
      clientPort,
      registryEndpoint,
      path.join(options.stateRoot, "fresh-install.client-flight-recorder.log"),
      "fresh-install",
      options.expectedVersion,
    );
    secondApp = await startPackagedElectronClient(
      options.candidateElectron,
      path.join(options.stateRoot, "second-client-home"),
      await freePort(),
      registryEndpoint,
      path.join(options.stateRoot, "fresh-install.second-client-flight-recorder.log"),
      "fresh-install-second-client",
      options.expectedVersion,
    );
    if (app.endpoint === registryEndpoint) throw new Error("fresh_install_registry_and_client_endpoints_collide");

    const diagnosticsBeforeRegistration = await allocatorDiagnostics(cluster.adminUrl, cluster.config.fleetId);
    const schemaRows = await postgresQuery(cluster.adminUrl, `
      SELECT
        to_regclass('surf_ace_allocator.fleets') IS NOT NULL AS has_fleets,
        to_regclass('surf_ace_allocator.custody_journal') IS NOT NULL AS has_journal,
        to_regclass('surf_ace_allocator.annotation_journal_head') IS NOT NULL AS has_annotation_head,
        to_regprocedure('surf_ace_allocator.read_accepted_state(text)') IS NOT NULL AS has_read_state,
        to_regprocedure('surf_ace_allocator.validate_journal(text)') IS NOT NULL AS has_journal_validator
    `) as Array<Record<string, boolean>>;
    const schema = schemaRows[0];
    if (!schema?.has_fleets || !schema.has_journal || !schema.has_annotation_head ||
        !schema.has_read_state || !schema.has_journal_validator) {
      throw new Error("fresh_install_postgres_schema_contract_mismatch");
    }
    const directList = await cli(options.cliBinary, cliStateRoot, "list", {}, app.endpoint);
    const listed = listedSurface(directList);
    const surfaceId = listed.surfaceId;
    const paneId = Number(listed.topology.panes[0]?.paneId);
    if (!Number.isSafeInteger(paneId) || paneId < 1) throw new Error("fresh_install_source_pane_missing");
    const electronClientId = clientId(app.identity.publicKeyPem);
    const registration = await waitForRegisteredSurface(registryEndpoint, electronClientId, surfaceId, "fresh-install");
    const secondList = await cli(options.cliBinary, path.join(options.stateRoot, "second-cli"), "list", {}, secondApp.endpoint);
    const secondSurface = listedSurface(secondList);
    const secondClientId = clientId(secondApp.identity.publicKeyPem);
    if (secondClientId === electronClientId || secondSurface.surfaceId === surfaceId) {
      throw new Error("fresh_install_two_clients_not_distinct");
    }
    const secondRegistration = await waitForRegisteredSurface(
      registryEndpoint, secondClientId, secondSurface.surfaceId, "fresh-install-second-client",
    );
    const confirmedFirstList = await cli(options.cliBinary, cliStateRoot, "list", {}, app.endpoint);
    const confirmedSecondList = await cli(options.cliBinary, path.join(options.stateRoot, "second-cli"), "list", {}, secondApp.endpoint);
    const firstVisible = listedSurface(confirmedFirstList, surfaceId);
    const secondVisible = listedSurface(confirmedSecondList, secondSurface.surfaceId);
    const firstPaneNumber = Number(firstVisible.topology.panes[0]?.paneLabel);
    const secondPaneNumber = Number(secondVisible.topology.panes[0]?.paneLabel);
    if (!Number.isSafeInteger(firstPaneNumber) || firstPaneNumber < 1 ||
        !Number.isSafeInteger(secondPaneNumber) || secondPaneNumber < 1 ||
        firstPaneNumber === secondPaneNumber ||
        Number(registration.surface.panes[0]?.paneLabel) !== firstPaneNumber ||
        Number(secondRegistration.surface.panes[0]?.paneLabel) !== secondPaneNumber) {
      throw new Error("fresh_install_fleet_pane_numbers_not_unique_or_unconfirmed");
    }
    const fleetPaneUniqueness = {
      firstClientId: electronClientId, firstPaneNumber, firstSurfaceId: surfaceId,
      secondClientId, secondPaneNumber, secondSurfaceId: secondSurface.surfaceId,
      secondDirectClientEndpoint: secondApp.endpoint,
      sharedRegistryEndpoint: registryEndpoint,
    };
    if (!matchesRegisteredDirectTarget(electronClientId, registration, firstVisible)) {
      throw new Error("fresh_install_direct_client_registry_target_mismatch");
    }
    if (!matchesRegisteredDirectTarget(secondClientId, secondRegistration, secondVisible)) {
      throw new Error("fresh_install_second_direct_client_registry_target_mismatch");
    }
    const diagnosticsAfterRegistration = await allocatorDiagnostics(cluster.adminUrl, cluster.config.fleetId);
    if (diagnosticsAfterRegistration.assignmentCount < diagnosticsBeforeRegistration.assignmentCount ||
        diagnosticsAfterRegistration.nextOrdinalFence < diagnosticsBeforeRegistration.nextOrdinalFence) {
      throw new Error("fresh_install_registry_allocation_not_persisted");
    }

    const contentId = "linux-fresh-install-content";
    const html = [
      "<style>",
      "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}",
      ".left,.right{position:absolute;top:0;bottom:0;width:50%}",
      ".left{left:0;background:#d93636}",
      ".right{right:0;background:#246bce}",
      "</style><div class=left></div><div class=right></div>",
    ].join("");
    const pushOutput = await cli(options.cliBinary, cliStateRoot, "push", {
      content: { html },
      contentId,
      contentType: "html",
      paneId,
      surfaceId,
    }, app.endpoint);
    if (pushOutput.command !== "push" || pushOutput.ok !== true) {
      throw new Error("fresh_install_direct_push_not_accepted");
    }
    const firstRead = await readVisiblePane(app.endpoint, surfaceId, paneId);
    const firstCapture = resultPayload(firstRead.captureOutput);
    const firstRecord = resultPayload(firstRead.output)?.currentContentRecord;
    inspectScreenshotPixels(firstCapture?.image, expectedScreenshotColors);
    if (firstRead.surfaceId !== surfaceId || firstRead.paneId !== paneId ||
        firstCapture?.contentId !== contentId ||
        (firstCapture?.surfaceId != null && firstCapture.surfaceId !== surfaceId) ||
        Number(firstCapture?.paneId) !== paneId ||
        !matchesFreshInstallCurrentContent(firstRecord, contentId, surfaceId, paneId)) {
      throw new Error("fresh_install_initial_capture_target_or_read_mismatch");
    }

    const wrongSurfaceId = `${surfaceId}-wrong-target`;
    const wrongSurfaceRejection = await rejectedWrongSurfacePush(options.cliBinary, cliStateRoot, app.endpoint, {
      content: { html: "<main>must not apply</main>" },
      contentId: `${contentId}-wrong-surface`,
      contentType: "html",
      expectedSurfaceId: surfaceId,
      paneId,
      surfaceId: wrongSurfaceId,
    });
    const afterWrongSurfaceRead = await readVisiblePane(app.endpoint, surfaceId, paneId);
    const afterWrongCapture = resultPayload(afterWrongSurfaceRead.captureOutput);
    const afterWrongRecord = resultPayload(afterWrongSurfaceRead.output)?.currentContentRecord;
    inspectScreenshotPixels(afterWrongCapture?.image, expectedScreenshotColors);
    if (afterWrongSurfaceRead.surfaceId !== surfaceId || afterWrongSurfaceRead.paneId !== paneId ||
        afterWrongCapture?.contentId !== contentId ||
        (afterWrongCapture?.surfaceId != null && afterWrongCapture.surfaceId !== surfaceId) ||
        !matchesFreshInstallCurrentContent(afterWrongRecord, contentId, surfaceId, paneId)) {
      throw new Error("fresh_install_wrong_surface_changed_valid_target");
    }
    const initial = summarizeFreshInstallPhase({
      app,
      databaseIdentity: cluster.databaseIdentity,
      diagnosticsAfterRegistration,
      directList: confirmedFirstList,
      read: afterWrongSurfaceRead,
      registration,
      registryEndpoint,
      sourceCommit: options.candidateCommit,
    });
    const annotationJournal = await packagedAnnotationJournalSmoke(
      registryEndpoint, options.cliBinary, path.join(options.stateRoot, "annotation-cli"),
      electronClientId, surfaceId, paneId, contentId,
    );
    const allocatorProjectionBeforeRestart = await allocatorDatabaseProjection(cluster.adminUrl, cluster.config.fleetId);

    const registryShutdownBeforeRestart = await registryProcess.stop();
    registryProcess = undefined;
    const allocatorProjectionAfterRegistryShutdown = await allocatorDatabaseProjection(cluster.adminUrl, cluster.config.fleetId);
    const registryShutdownContinuity = verifyAllocatorServiceLifecycle(
      allocatorProjectionBeforeRestart,
      allocatorProjectionAfterRegistryShutdown,
      "released",
    );
    if (!registryShutdownContinuity.ok) {
      throw new Error(`fresh_install_registry_shutdown_semantics_changed:${JSON.stringify({
        activeProjectionSha256: allocatorProjectionBeforeRestart.projectionSha256,
        continuity: registryShutdownContinuity,
        databaseIdentityAfter: allocatorProjectionAfterRegistryShutdown.databaseIdentity,
        databaseIdentityBefore: allocatorProjectionBeforeRestart.databaseIdentity,
        releasedProjectionSha256: allocatorProjectionAfterRegistryShutdown.projectionSha256,
      })}`);
    }
    if (await directWebSocketReady(registryEndpoint) || !await directWebSocketReady(app.endpoint)) {
      throw new Error("fresh_install_offline_registry_or_local_endpoint_invalid");
    }
    const offlineBefore = await cli(options.cliBinary, cliStateRoot, "list", {}, app.endpoint);
    const offlineOriginal = listedSurface(offlineBefore, surfaceId);
    const opened = await cli(options.cliBinary, cliStateRoot, "surface-intent", {
      action: "open",
      expectedSurfaceSetRevision: Number(resultPayload(offlineBefore)?.surfaceSetRevision),
    }, app.endpoint);
    const offlineSurfaceId = resultPayload(opened)?.surfaceId;
    if (typeof offlineSurfaceId !== "string" || !offlineSurfaceId || offlineSurfaceId === surfaceId) {
      throw new Error("fresh_install_offline_surface_open_missing_stable_id");
    }
    const offlineOpened = listedSurface(await cli(options.cliBinary, cliStateRoot, "list", {}, app.endpoint), offlineSurfaceId);
    const offlineInitialPaneId = Number(offlineOpened.topology.panes[0]?.paneId);
    if (!Number.isSafeInteger(offlineInitialPaneId) || offlineInitialPaneId < 1 ||
        offlineOpened.topology.windowLabel !== null || offlineOpened.topology.panes[0]?.paneLabel !== null) {
      throw new Error("fresh_install_offline_open_labels_not_pending");
    }
    await cli(options.cliBinary, cliStateRoot, "topology-intent", {
      action: "split", count: 2, direction: "horizontal",
      expectedTopologyRevision: Number(offlineOpened.topology.topologyRevision),
      paneId: offlineInitialPaneId, surfaceId: offlineSurfaceId,
    }, app.endpoint);
    const offlineAfterList = await cli(options.cliBinary, cliStateRoot, "list", {}, app.endpoint);
    const offlineSplit = listedSurface(offlineAfterList, offlineSurfaceId);
    const offlinePaneIds = offlineSplit.topology.panes.map((pane: any) => Number(pane.paneId));
    if (offlinePaneIds.length !== 2 || new Set(offlinePaneIds).size !== 2 ||
        !offlinePaneIds.includes(offlineInitialPaneId) ||
        offlineSplit.topology.windowLabel !== null ||
        offlineSplit.topology.panes.some((pane: any) => pane.paneLabel !== null) ||
        listedSurface(offlineAfterList, surfaceId).topology.windowLabel !== offlineOriginal.topology.windowLabel) {
      throw new Error("fresh_install_offline_split_identity_or_pending_labels_invalid");
    }
    const offlineRead = await readVisiblePane(app.endpoint, surfaceId, paneId);
    if (!matchesFreshInstallCurrentContent(resultPayload(offlineRead.output)?.currentContentRecord,
      contentId, surfaceId, paneId)) {
      throw new Error("fresh_install_offline_content_lost");
    }
    const offlineLocal = {
      directClientEndpoint: app.endpoint,
      existingSurfaceId: surfaceId,
      existingWindowLabel: offlineOriginal.topology.windowLabel,
      newSurfaceId: offlineSurfaceId,
      newPaneIds: offlinePaneIds,
      pendingWindowLabel: offlineSplit.topology.windowLabel,
      pendingPaneLabels: offlineSplit.topology.panes.map((pane: any) => pane.paneLabel),
      preservedContentId: contentRecordId(resultPayload(offlineRead.output)?.currentContentRecord),
      registryEndpointUnavailable: true,
    };
    const postgresRestart = await restartPostgresCluster(cluster, allocatorProjectionAfterRegistryShutdown);
    if (postgresRestart.databaseIdentity !== allocatorProjectionAfterRegistryShutdown.databaseIdentity ||
        postgresRestart.projectionBeforeSha256 !== allocatorProjectionAfterRegistryShutdown.projectionSha256 ||
        postgresRestart.projectionAfterSha256 !== allocatorProjectionAfterRegistryShutdown.projectionSha256) {
      throw new Error(`fresh_install_postgres_restart_projection_mismatch:${JSON.stringify({
        databaseIdentityAfter: postgresRestart.databaseIdentity,
        databaseIdentityBeforeRegistryShutdown: allocatorProjectionAfterRegistryShutdown.databaseIdentity,
        projectionAfterSha256: postgresRestart.projectionAfterSha256,
        projectionBeforeSha256: postgresRestart.projectionBeforeSha256,
        projectionAfterRegistryShutdownSha256: allocatorProjectionAfterRegistryShutdown.projectionSha256,
      })}`);
    }
    registryProcess = await startPackagedServer(registryLauncher, registryConfig, cluster.root, "fresh-install-registry-after-restart");
    const registryHealthAfterRestart = registryProcess.health;
    if (registryProcess.endpoint !== registryEndpoint) throw new Error("fresh_install_registry_endpoint_changed_after_restart");

    const registrationAfterRestart = await waitForRegisteredSurface(
      registryEndpoint,
      electronClientId,
      surfaceId,
      "fresh-install-after-restart",
    );
    const offlineRegistration = await waitForRegisteredSurface(
      registryEndpoint, electronClientId, offlineSurfaceId, "fresh-install-offline-surface-after-restart",
    );
    if (offlineRegistration.surface.panes.length !== 2 ||
        new Set(offlineRegistration.surface.panes.map((pane: any) => Number(pane.paneId))).size !== 2 ||
        offlineRegistration.surface.panes.some((pane: any) => !offlinePaneIds.includes(Number(pane.paneId)))) {
      throw new Error("fresh_install_offline_split_not_registered_once");
    }
    const secondRegistrationAfterRestart = await waitForRegisteredSurface(
      registryEndpoint, secondClientId, secondSurface.surfaceId, "fresh-install-second-client-after-restart",
    );
    const secondListAfterRestart = await cli(
      options.cliBinary, path.join(options.stateRoot, "second-cli"), "list", {}, secondApp.endpoint,
    );
    const secondVisibleAfterRestart = listedSurface(secondListAfterRestart, secondSurface.surfaceId);
    if (Number(secondVisibleAfterRestart.topology.panes[0]?.paneLabel) !== secondPaneNumber ||
        Number(secondRegistrationAfterRestart.surface.panes[0]?.paneLabel) !== secondPaneNumber) {
      throw new Error("fresh_install_second_client_pane_number_changed_after_restart");
    }
    const listAfterRestart = await cli(options.cliBinary, cliStateRoot, "list", {}, app.endpoint);
    const listedAfterRestart = listedSurface(listAfterRestart, surfaceId);
    const offlineListedAfterRestart = listedSurface(listAfterRestart, offlineSurfaceId);
    if (offlineListedAfterRestart.topology.windowLabel !== offlineRegistration.surface.windowLabel ||
        offlineListedAfterRestart.topology.panes.length !== 2 ||
        offlineListedAfterRestart.topology.panes.some((pane: any) =>
          !offlinePaneIds.includes(Number(pane.paneId)) ||
          !Number.isSafeInteger(Number(pane.paneLabel)) || Number(pane.paneLabel) < 1)) {
      throw new Error("fresh_install_offline_split_reconnect_labels_invalid");
    }
    if (!matchesRegisteredDirectTarget(electronClientId, registrationAfterRestart, listedAfterRestart)) {
      throw new Error("fresh_install_reconnected_target_mismatch");
    }
    const diagnosticsAfterRestart = await allocatorDiagnostics(cluster.adminUrl, cluster.config.fleetId);
    if (diagnosticsAfterRestart.allocatorId !== diagnosticsAfterRegistration.allocatorId ||
        diagnosticsAfterRestart.assignmentCount < diagnosticsAfterRegistration.assignmentCount ||
        diagnosticsAfterRestart.nextOrdinalFence < diagnosticsAfterRegistration.nextOrdinalFence) {
      throw new Error("fresh_install_restart_allocator_identity_or_fence_regressed");
    }
    const afterRestartRead = await readVisiblePane(app.endpoint, surfaceId, paneId);
    const resumedCapture = resultPayload(afterRestartRead.captureOutput);
    const resumedRecord = resultPayload(afterRestartRead.output)?.currentContentRecord;
    inspectScreenshotPixels(resumedCapture?.image, expectedScreenshotColors);
    if (afterRestartRead.surfaceId !== surfaceId || afterRestartRead.paneId !== paneId ||
        resumedCapture?.contentId !== contentId ||
        (resumedCapture?.surfaceId != null && resumedCapture.surfaceId !== surfaceId) ||
        Number(resumedCapture?.paneId) !== paneId ||
        !matchesFreshInstallCurrentContent(resumedRecord, contentId, surfaceId, paneId) ||
        resultPayload(afterRestartRead.output)?.cacheStatus !== "current" ||
        resultPayload(afterRestartRead.output)?.consumableLoss !== null) {
      throw new Error("fresh_install_after_restart_current_content_or_no_loss_mismatch");
    }
    const afterRestart = summarizeFreshInstallPhase({
      app,
      databaseIdentity: cluster.databaseIdentity,
      diagnosticsAfterRegistration: diagnosticsAfterRestart,
      directList: listAfterRestart,
      read: afterRestartRead,
      registration: registrationAfterRestart,
      registryEndpoint,
      sourceCommit: options.candidateCommit,
    });
    if (app.endpoint !== initial.directClientEndpoint || app.identity.fingerprintPrefix !== initial.clientIdentity) {
      throw new Error("fresh_install_client_identity_or_endpoint_changed");
    }

    await app.stop();
    app = undefined;
    await secondApp.stop();
    secondApp = undefined;
    clientStopped = true;
    const registryStop = await registryProcess.stop();
    registryProcess = undefined;
    registryStopped = registryStop.stopped?.status === "clean";
    if (!registryStopped) throw new Error("fresh_install_registry_cleanup_unverified");
    await cluster.stop();
    for (const dataDir of [cluster.primaryData, cluster.witnessData]) {
      try {
        await fs.access(path.join(dataDir, "postmaster.pid"));
        throw new Error(`fresh_install_postgres_process_not_stopped:${dataDir}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
    }
    clusterStopped = true;
    const rawCliEvidence = await fs.readFile(path.join(options.stateRoot, "raw-cli-evidence.ndjson"));
    const postgresEvidence = {
      databaseIdentity: postgresRestart.databaseIdentity,
      initialRegistryHealth,
      lifecycle: postgresRestart.lifecycle,
      projectionAfterSha256: postgresRestart.projectionAfterSha256,
      projectionBeforeSha256: postgresRestart.projectionBeforeSha256,
      registryShutdown: {
        activeProjectionSha256: allocatorProjectionBeforeRestart.projectionSha256,
        continuity: registryShutdownContinuity,
        releasedProjectionSha256: allocatorProjectionAfterRegistryShutdown.projectionSha256,
        releaseWitnessEventsBeforeRestart: registryShutdownBeforeRestart.packagedDiagnostics.releaseWitnessEvents,
        releaseWitnessEventsAfterRestart: registryStop.packagedDiagnostics.releaseWitnessEvents,
      },
      registryHealth: registryHealthAfterRestart,
      registryShutdownClean: registryShutdownBeforeRestart.stopped?.status === "clean" && registryStop.stopped?.status === "clean",
      schema,
      status: postgresRestart.status,
      witnessSynchronized: postgresRestart.witnessSynchronized,
    };
    const stateSequence = {
      afterRestart,
      annotationJournal,
      expectedContentId: contentId,
      expectedScreenshotColors,
      expectedVersion: options.expectedVersion,
      displayReady,
      initial,
      offlineLocal: {
        ...offlineLocal,
        confirmedWindowLabel: offlineListedAfterRestart.topology.windowLabel,
        confirmedPaneLabels: offlineListedAfterRestart.topology.panes.map((pane: any) => pane.paneLabel),
      },
      fleetPaneUniqueness,
      migrationEvidence,
      mode: "fresh-install",
      postgresRestart: postgresEvidence,
      rawCliEvidenceBase64: rawCliEvidence.toString("base64"),
      rawCliEvidenceBytes: rawCliEvidence.byteLength,
      rawCliEvidenceSha256: createHash("sha256").update(rawCliEvidence).digest("hex"),
      sourceCommit: options.candidateCommit,
      wrongSurfaceRejection,
      cleanup: { clientStopped, postgresStopped: clusterStopped, registryStopped },
    };
    await fs.writeFile(options.output, `${JSON.stringify(stateSequence, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    if (typeof lastCaptureImage === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(lastCaptureImage)) {
      await fs.writeFile(`${options.output}.capture.png`, Buffer.from(lastCaptureImage, "base64"), { mode: 0o600 })
        .catch(() => undefined);
    }
    await fs.writeFile(options.output, `${JSON.stringify({
      mode: "fresh-install",
      sourceCommit: options.candidateCommit,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
    throw error;
  } finally {
    if (app) await app.stop().catch(() => undefined);
    if (secondApp) await secondApp.stop().catch(() => undefined);
    if (registryProcess) await registryProcess.stop().catch(() => undefined);
    if (!clusterStopped) {
      await cluster.stop();
      for (const dataDir of [cluster.primaryData, cluster.witnessData]) {
        try {
          await fs.access(path.join(dataDir, "postmaster.pid"));
          throw new Error(`fresh_install_postgres_process_not_stopped:${dataDir}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
      }
    }
  }
}

async function main() {
  const options = argumentsObject(process.argv.slice(2));
  await loadProductRuntime(options.productSourceDir);
  await freshInstallMain(options);
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
