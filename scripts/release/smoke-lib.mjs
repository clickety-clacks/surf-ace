import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { run, sha256 } from "./release-lib.mjs";

export function start(command, args, options = {}) {
  const child = spawn(command, args, { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
  return { child, output: () => ({ stderr, stdout }) };
}

export async function stop(started) {
  const hasExited = () => started.child.exitCode !== null || started.child.signalCode !== null;
  const waitForExit = () => hasExited()
    ? Promise.resolve()
    : new Promise((resolve) => started.child.once("exit", resolve));
  const signal = (name) => {
    try {
      if (process.platform === "win32") started.child.kill(name);
      else process.kill(-started.child.pid, name);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const exited = waitForExit();
  signal("SIGTERM");
  if (!hasExited()) {
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }
  if (!hasExited()) {
    const killed = waitForExit();
    signal("SIGKILL");
    await killed;
  }
  try {
    if (process.platform === "win32") process.kill(started.child.pid, 0);
    else process.kill(-started.child.pid, 0);
    signal("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (process.platform === "win32") process.kill(started.child.pid, 0);
    else process.kill(-started.child.pid, 0);
    throw new Error(`residual_process_group:${started.child.pid}`);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function waitForCommand(command, args, options = {}, deadlineMs = 90_000) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await run(command, args, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`observable_command_never_succeeded:${command}:${lastError?.message ?? "unknown"}`);
}

export async function verifyClientAppVersion(diagnosticLogPath, expectedVersion) {
  if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error("tightbeam_client_expected_version_invalid");
  }
  const diagnostic = await fs.readFile(diagnosticLogPath, "utf8");
  const launchLines = diagnostic.split(/\r?\n/)
    .filter((line) => line.includes("[surf-ace:app] event=app_launch"));
  if (launchLines.length !== 1) throw new Error("tightbeam_client_app_launch_identity_missing_or_ambiguous");
  const match = launchLines[0].match(/(?:^|\s)app_version=([^\s]+)/);
  if (!match) throw new Error("tightbeam_client_app_version_missing");
  if (match[1] !== expectedVersion) {
    throw new Error(`tightbeam_client_app_version_mismatch:${match[1]}:${expectedVersion}`);
  }
  return {
    evidenceSha256: await sha256(diagnosticLogPath),
    source: "electron.app.getVersion",
    version: match[1],
  };
}

export function electronLaunchConfig(home, port, registryEndpoint = null, diagnosticLogPath = undefined, platform = process.platform, disableGpu = false) {
  const userDataDir = path.join(home, "user-data");
  const args = [`--user-data-dir=${userDataDir}`];
  if (platform === "linux") args.push("--disable-gpu", "--disable-dev-shm-usage");
  const env = {
    ...process.env,
    HOME: home,
    SURF_ACE_BIND: "127.0.0.1",
    SURF_ACE_DISABLE_ADVERTISING: "1",
    SURF_ACE_PORT: String(port),
  };
  // Smoke must never inherit an operator's or CI runner's registry endpoint.
  // A non-null value is supplied only for the local packaged registry test.
  delete env.SURF_ACE_SERVER;
  // The caller opts in only for hosted macOS smoke; otherwise preserve the
  // existing environment behavior for operators with an explicit override.
  if (disableGpu) env.SURF_ACE_DISABLE_GPU = "1";
  if (registryEndpoint !== null) env.SURF_ACE_SERVER = registryEndpoint;
  if (diagnosticLogPath !== undefined) env.SURF_ACE_CLIENT_DIAGNOSTIC_LOG = diagnosticLogPath;
  return {
    args,
    env,
    userDataDir,
  };
}

export function matchesRegisteredDirectTarget(expectedClientId, registration, directSurface) {
  const panes = directSurface?.topology?.panes;
  if (typeof expectedClientId !== "string" || !expectedClientId ||
      registration?.client?.clientId !== expectedClientId ||
      typeof registration?.surface?.surfaceId !== "string" ||
      registration.surface.surfaceId !== directSurface?.surfaceId ||
      !Array.isArray(panes) || panes.length === 0) return false;
  const paneIds = panes.map((pane) => Number(pane?.paneId));
  return paneIds.every((paneId) => Number.isSafeInteger(paneId) && paneId > 0) &&
    new Set(paneIds).size === paneIds.length;
}

export function hasRequiredAllocatorBackupObjects(pgRestoreList) {
  if (typeof pgRestoreList !== "string") return false;
  const tables = new Set();
  for (const line of pgRestoreList.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+;\s+\d+\s+\d+\s+TABLE\s+surf_ace_allocator\s+(custody_journal|fleets)\s/);
    if (match) tables.add(match[1]);
  }
  return tables.has("custody_journal") && tables.has("fleets");
}

export function verifyAllocatorServiceLifecycle(before, after, phase) {
  const fail = (reason) => ({ ok: false, phase, reason });
  const deltaByPhase = { active: 1, released: 1, completed: 2 };
  const expectedDelta = deltaByPhase[phase];
  if (!expectedDelta) return fail("phase_invalid");
  if (!before || !after || typeof before.databaseIdentity !== "string" ||
      !before.databaseIdentity || before.databaseIdentity !== after.databaseIdentity) {
    return fail("database_identity_changed");
  }
  if (!before.tables || !after.tables) return fail("projection_missing");

  const tableNames = [
    "fleet_tombstones", "fleets", "authority_owners", "allocation_transactions",
    "assignments", "custody_journal", "custody_revision_heads", "restore_generations",
  ];
  if (tableNames.some((name) => !Array.isArray(before.tables[name]) || !Array.isArray(after.tables[name]))) {
    return fail("projection_table_missing");
  }
  const beforeFleets = before.tables.fleets;
  const afterFleets = after.tables.fleets;
  if (beforeFleets.length !== 1 || afterFleets.length !== 1) return fail("fleet_cardinality_changed");
  const beforeFleet = beforeFleets[0];
  const afterFleet = afterFleets[0];

  const leaseBookkeeping = new Set([
    "custody_revision", "last_commit_at", "lease_backend_pid", "lease_generation", "lease_id", "lease_mode",
  ]);
  const stableFleet = (fleet) => Object.fromEntries(
    Object.entries(fleet).filter(([key]) => !leaseBookkeeping.has(key)),
  );
  for (const table of tableNames) {
    if (table === "fleets" || table === "custody_revision_heads") continue;
    if (!isDeepStrictEqual(before.tables[table], after.tables[table])) return fail(`semantic_table_changed:${table}`);
  }
  if (!isDeepStrictEqual(stableFleet(beforeFleet), stableFleet(afterFleet))) return fail("fleet_semantics_changed");

  const beforeRevision = Number(beforeFleet.custody_revision);
  const afterRevision = Number(afterFleet.custody_revision);
  const beforeLeaseGeneration = Number(beforeFleet.lease_generation);
  const afterLeaseGeneration = Number(afterFleet.lease_generation);
  if (![beforeRevision, afterRevision, beforeLeaseGeneration, afterLeaseGeneration].every(Number.isSafeInteger) ||
      afterRevision - beforeRevision !== expectedDelta ||
      afterLeaseGeneration - beforeLeaseGeneration !== expectedDelta) {
    return fail("lease_revision_delta_invalid");
  }
  if (beforeFleet.head_seq !== afterFleet.head_seq || beforeFleet.head_hash !== afterFleet.head_hash) {
    return fail("journal_head_changed");
  }
  const beforeHeads = before.tables.custody_revision_heads;
  const afterHeads = after.tables.custody_revision_heads;
  if (beforeHeads.length === 0 || Number(beforeHeads.at(-1)?.custody_revision) !== beforeRevision ||
      afterHeads.length !== beforeHeads.length + expectedDelta ||
      !isDeepStrictEqual(afterHeads.slice(0, beforeHeads.length), beforeHeads)) {
    return fail("revision_heads_not_append_only");
  }
  const suffix = afterHeads.slice(beforeHeads.length);
  for (let index = 0; index < suffix.length; index += 1) {
    if (Number(suffix[index]?.custody_revision) !== beforeRevision + index + 1 ||
        suffix[index]?.head_seq !== beforeFleet.head_seq || suffix[index]?.head_hash !== beforeFleet.head_hash) {
      return fail("revision_head_suffix_invalid");
    }
  }

  if (phase === "active") {
    if (typeof afterFleet.lease_id !== "string" || !afterFleet.lease_id ||
        afterFleet.lease_mode !== "writer" || !Number.isSafeInteger(Number(afterFleet.lease_backend_pid)) ||
        Number(afterFleet.lease_backend_pid) <= 0) return fail("writer_lease_not_active");
  } else if (afterFleet.lease_id !== null || afterFleet.lease_mode !== null || afterFleet.lease_backend_pid !== null) {
    return fail("writer_lease_not_released");
  }

  return {
    ok: true,
    phase,
    custodyRevisionDelta: expectedDelta,
    leaseGenerationDelta: expectedDelta,
    appendedRevisionHeads: suffix.length,
    semanticProjectionUnchanged: true,
    journalHeadUnchanged: true,
  };
}

export async function launchElectron(
  appExecutable,
  home,
  port,
  launchProcess = start,
  registryEndpoint = undefined,
  diagnosticLogPath = undefined,
  disableGpu = false,
) {
  const launch = electronLaunchConfig(home, port, registryEndpoint, diagnosticLogPath, process.platform, disableGpu);
  await fs.mkdir(launch.userDataDir, { recursive: true });
  return { launch, started: launchProcess(appExecutable, launch.args, { env: launch.env }) };
}

export async function electronHandshake(appExecutable, home, port) {
  const { started } = await launchElectron(appExecutable, home, port);
  try {
    const expiresAt = Date.now() + 60_000;
    let response;
    while (!response && Date.now() < expiresAt) {
      try {
        response = await new Promise((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}`);
          const attemptTimeout = setTimeout(() => {
            socket.close();
            reject(new Error("electron_handshake_attempt_timeout"));
          }, 2_000);
          socket.addEventListener("open", () => socket.send(JSON.stringify({
            id: "rq_release_smoke_pair",
            op: "pair.request",
            payload: {
              connectionId: "cn_release_smoke",
              drawingFlushConfig: { idleWindowMs: 8000, maxIntervalMs: 30000 },
              eventProfile: "minimum_deep",
              initialPaneId: 1,
              initialPaneLabel: 1,
              protocolVersion: 1,
              providerId: "pv_release_smoke",
              providerName: "release-smoke",
              surfaceId: "sf_release_smoke",
              windowLabel: "a",
            },
            sentAt: 0,
            type: "request",
            v: 1,
          })));
          socket.addEventListener("message", (event) => {
            const parsed = JSON.parse(String(event.data));
            if (parsed.id === "rq_release_smoke_pair") {
              clearTimeout(attemptTimeout);
              socket.close();
              resolve(parsed);
            }
          });
          socket.addEventListener("error", () => {
            clearTimeout(attemptTimeout);
            socket.close();
            reject(new Error("electron_handshake_connect_failed"));
          });
        });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!response) throw new Error("electron_handshake_timeout");
    if (response?.ok !== true || response?.op !== "pair.request") throw new Error("electron_handshake_rejected");
    return response;
  } finally {
    await stop(started);
  }
}
