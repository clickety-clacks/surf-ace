import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supervisorPath = fileURLToPath(new URL("./native-scale-process-supervisor.mjs", import.meta.url));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function processCensus({ timeoutMs = 1_000, spawnProcess = spawn } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Process census timeout is invalid");
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const child = spawnProcess("ps", ["-eo", "pid=,pgid=,args="], { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (error, rows) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(rows);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code !== 0) return finish(new Error(`Process census ps exited ${code ?? signal ?? "without status"}`));
      const rows = stdout.split("\n").flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }] : [];
      });
      finish(null, rows);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Process census exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}
export function electronProcessCensus(electronPath, census) {
  if (!Array.isArray(census)) throw new Error("A successful process census is required");
  const resolved = String(electronPath);
  return census.filter(({ command }) => command.includes(resolved) ||
    /(?:^|\/)electron(?:\s|$)/i.test(command));
}

export function processGroupCensus(pgid, census) {
  if (!Array.isArray(census)) throw new Error("A successful process census is required");
  return census.filter((entry) => entry.pgid === pgid);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function writeOwnerCommand(owner, command) {
  if (!owner || owner.child.exitCode !== null || owner.child.signalCode !== null || owner.child.stdin.destroyed) {
    throw Object.assign(new Error("Owned process-group anchor is no longer available"), { ownershipLost: true });
  }
  return new Promise((resolve, reject) => {
    const line = JSON.stringify({ ...command, ownerToken: owner.ownerToken }) + "\n";
    owner.child.stdin.write(line, (error) => error ? reject(error) : resolve());
  });
}

async function issueOwnerCommand({ child, ownerToken, beforeOwnerCommand, launchReceipt }, command, phase) {
  let accepted;
  try { accepted = await beforeOwnerCommand({ signal: command.signal ?? command.type, launchReceipt, phase, ownerChild: child }); }
  catch (error) { throw Object.assign(error, { ownershipLost: true }); }
  if (accepted === false) {
    throw Object.assign(new Error("Owned process-group generation was lost before its control command"), { ownershipLost: true });
  }
  try { await writeOwnerCommand({ child, ownerToken }, command); }
  catch (error) { throw Object.assign(error, { ownershipLost: true }); }
}

async function waitForOwnedMembers({ pgid, anchorPid, census, timeoutMs, pollMs, censusTimeoutMs, onCensusError }) {
  const deadline = performance.now() + timeoutMs;
  let lastError = null;
  let lastMembers = null;
  while (performance.now() <= deadline) {
    const remainingMs = Math.max(1, deadline - performance.now());
    try {
      const rows = await withTimeout(Promise.resolve().then(census), Math.min(censusTimeoutMs, remainingMs), "Owned process census");
      lastError = null;
      const group = processGroupCensus(pgid, rows);
      if (!group.some(({ pid }) => pid === anchorPid)) {
        throw Object.assign(new Error("Owned process-group anchor disappeared before cleanup completed"), { ownershipLost: true });
      }
      lastMembers = group.filter(({ pid }) => pid !== anchorPid);
      if (lastMembers.length === 0) return { known: true, members: [], censusError: null };
    } catch (error) {
      if (error?.ownershipLost) throw error;
      lastError = error;
      onCensusError?.(error);
    }
    if (performance.now() >= deadline) break;
    await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())));
  }
  return { known: false, members: lastMembers, censusError: lastError };
}

export async function runOwnedProcess({
  command,
  args = [],
  options = {},
  deadlineMs,
  terminateGraceMs = 2_000,
  reapTimeoutMs = 3_000,
  maxOutputBytes = 1_000_000,
  census = processCensus,
  censusTimeoutMs = 500,
  onLaunch = () => {},
  onLaunchTimeoutMs = 2_000,
  spawnProcess = spawn,
  supervisor = supervisorPath,
  ownerToken = randomUUID(),
  beforeOwnerCommand = async () => {},
}) {
  if (typeof command !== "string" || !path.isAbsolute(command)) throw new Error("Owned command must use an absolute executable path");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 50 || deadlineMs > 180_000) throw new Error("Owned command deadline is invalid");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("Owned command output bound is invalid");
  if (!Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 0 ||
      !Number.isSafeInteger(reapTimeoutMs) || reapTimeoutMs < 1 ||
      !Number.isSafeInteger(censusTimeoutMs) || censusTimeoutMs < 1 ||
      !Number.isSafeInteger(onLaunchTimeoutMs) || onLaunchTimeoutMs < 1) throw new Error("Owned command cleanup bounds are invalid");

  const startedAt = Date.now();
  const startedMonotonic = performance.now();
  const processDeadline = startedMonotonic + deadlineMs;
  const child = spawnProcess(process.execPath, [supervisor], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let controlText = "";
  let targetExit = null;
  let targetStarted = false;
  let setupError = null;
  let supervisorClosed = false;
  let closedResult = null;
  let launchReceipt = null;
  let launchSent = false;
  let timedOut = false;
  let termSent = false;
  let killSent = false;
  let ownerLost = false;
  let controlResolve;
  let targetExitResolve;
  const controlMessages = new Promise((resolve) => { controlResolve = resolve; });
  const targetExited = new Promise((resolve) => { targetExitResolve = resolve; });
  const appendBounded = (current, chunk) => {
    const combined = Buffer.concat([current, chunk]);
    return combined.length > maxOutputBytes ? combined.subarray(combined.length - maxOutputBytes) : combined;
  };
  child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
  child.stdio[3].setEncoding("utf8");
  child.stdio[3].on("data", (chunk) => {
    controlText += chunk;
    let newline;
    while ((newline = controlText.indexOf("\n")) >= 0) {
      const line = controlText.slice(0, newline);
      controlText = controlText.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.ownerToken !== ownerToken) continue;
      if (message.type === "target-started") {
        if (message.anchorPid === child.pid) targetStarted = true;
        else setupError = new Error("Owned process supervisor reported a different group anchor");
      }
      if (message.type === "target-exit" || message.type === "target-error") {
        targetExit = message.type === "target-error" ? { code: null, signal: null, error: message.error } : message.result;
        targetExitResolve(targetExit);
      }
      controlResolve(message);
    }
  });
  const supervisorClosedPromise = new Promise((resolve) => {
    child.once("error", (error) => {
      setupError = error;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      supervisorClosed = true;
      closedResult = { code, signal };
      resolve(closedResult);
    });
  });

  try {
    const spawnResult = await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve({ pid: child.pid });
      };
      const onError = (error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    const pgid = spawnResult.pid;
    if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error("Could not establish an owned process-group anchor");
    launchReceipt = Object.freeze({
      pid: pgid,
      pgid,
      ownerToken,
      startedAt,
      startedMonotonic,
      supervisorPath: supervisor,
      command,
      args: Object.freeze([...args]),
      timedOut: false,
      termSent: false,
      killSent: false,
      ownershipKnown: true,
    });
    await withTimeout(Promise.resolve().then(() => onLaunch(launchReceipt)), onLaunchTimeoutMs, "Owned launch receipt write");
    await new Promise((resolve, reject) => {
      child.stdin.write(JSON.stringify({ type: "launch", ownerToken, command, args, cwd: options.cwd, env: options.env }) + "\n",
        (error) => error ? reject(error) : resolve());
    });
    launchSent = true;

    const startDeadline = Math.min(processDeadline, performance.now() + 3_000);
    while (!targetStarted && performance.now() < startDeadline && !supervisorClosed) {
      const message = await withTimeout(controlMessages, Math.max(1, startDeadline - performance.now()), "Owned process supervisor startup");
      if (message.type === "target-error") break;
    }
    if (!targetStarted && !targetExit) throw new Error("Owned process supervisor did not start the target");

    if (!targetExit) {
      try {
        targetExit = await withTimeout(targetExited, Math.max(1, processDeadline - performance.now()), "Owned process deadline");
      } catch (error) {
        if (!String(error?.message).includes("Owned process deadline")) throw error;
        timedOut = true;
      }
    }

    let cleanupFailure = null;
    let members = null;
    if (timedOut) {
      await issueOwnerCommand({ child, ownerToken, beforeOwnerCommand, launchReceipt },
        { type: "signal-group", signal: "SIGTERM" }, "deadline");
      termSent = true;
    }

    let cleanup = await waitForOwnedMembers({ pgid: launchReceipt.pgid, anchorPid: launchReceipt.pid, census,
      timeoutMs: timedOut ? terminateGraceMs : Math.min(terminateGraceMs, 1_000), pollMs: 40, censusTimeoutMs,
      onCensusError: () => {} });
    members = cleanup.members;
    if (!cleanup.known) {
      if (performance.now() >= processDeadline && !timedOut) timedOut = true;
      if (!termSent) {
        await issueOwnerCommand({ child, ownerToken, beforeOwnerCommand, launchReceipt },
          { type: "signal-group", signal: "SIGTERM" }, "cleanup");
        termSent = true;
      }
      if (!timedOut) {
        cleanup = await waitForOwnedMembers({ pgid: launchReceipt.pgid, anchorPid: launchReceipt.pid, census,
          timeoutMs: terminateGraceMs, pollMs: 40, censusTimeoutMs, onCensusError: () => {} });
        members = cleanup.members;
      }
    }
    if (!cleanup.known) {
      await issueOwnerCommand({ child, ownerToken, beforeOwnerCommand, launchReceipt },
        { type: "signal-group", signal: "SIGKILL" }, "reap");
      killSent = true;
      // SIGKILL also ends the anchor; no numeric PID/PGID signal is used by the parent.
      await withTimeout(supervisorClosedPromise, reapTimeoutMs, "Owned process supervisor reap").catch((error) => { cleanupFailure = error; });
      if (!supervisorClosed) cleanupFailure ??= new Error("Owned process-group anchor did not close after SIGKILL");
    } else {
      await issueOwnerCommand({ child, ownerToken, beforeOwnerCommand, launchReceipt }, { type: "shutdown" }, "complete");
      await withTimeout(supervisorClosedPromise, reapTimeoutMs, "Owned process supervisor shutdown").catch((error) => { cleanupFailure = error; });
      if (!supervisorClosed) cleanupFailure ??= new Error("Owned process-group anchor did not shut down");
    }

    let afterCensus;
    try {
      afterCensus = await withTimeout(Promise.resolve().then(census), censusTimeoutMs, "Final owned process census");
    } catch (error) {
      cleanupFailure ??= error;
    }
    const finalMembers = afterCensus ? processGroupCensus(launchReceipt.pgid, afterCensus) : null;
    const receipt = {
      ...launchReceipt,
      code: targetExit?.code ?? closedResult?.code ?? null,
      signal: targetExit?.signal ?? closedResult?.signal ?? null,
      targetStarted,
      targetError: targetExit?.error ?? null,
      timedOut,
      termSent,
      killSent,
      ownershipKnown: Boolean(finalMembers && finalMembers.length === 0 && !cleanupFailure),
      remaining: finalMembers?.map(({ pid, command: processCommand }) => ({ pid, command: processCommand })) ??
        members?.map(({ pid, command: processCommand }) => ({ pid, command: processCommand })) ?? null,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      censusError: cleanupFailure ? String(cleanupFailure.stack ?? cleanupFailure) : null,
    };
    if (setupError) throw Object.assign(setupError, { receipt });
    if (cleanupFailure || !receipt.ownershipKnown) {
      throw Object.assign(new Error(`Owned process group ${launchReceipt.pgid} cleanup is unknown; preserve its evidence directory`), { receipt });
    }
    if (targetExit?.error) throw Object.assign(new Error(targetExit.error), { receipt });
    return receipt;
  } catch (error) {
    ownerLost = Boolean(error?.ownershipLost);
    const receipt = {
      ...(launchReceipt ?? {}),
      code: targetExit?.code ?? null,
      signal: targetExit?.signal ?? null,
      targetStarted,
      timedOut: timedOut || String(error?.message).includes("deadline"),
      termSent,
      killSent,
      ownershipKnown: false,
      remaining: null,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
    };
    if (!launchReceipt) {
      // No child was successfully spawned, so there is no owned group to clean.
      throw error;
    }
    if (!launchSent && !supervisorClosed) {
      child.stdin.end();
      try { await withTimeout(supervisorClosedPromise, reapTimeoutMs, "Unlaunched supervisor cleanup"); }
      catch (cleanupError) { receipt.cleanupError = String(cleanupError?.stack ?? cleanupError); }
    } else if (ownerLost && !supervisorClosed) {
      // Closing the control pipe asks the anchored supervisor to self-clean its
      // exact process group; no stale numeric PGID is ever signaled by the parent.
      child.stdin.end();
      try { await withTimeout(supervisorClosedPromise, reapTimeoutMs + 1_000, "Lost-owner self cleanup"); }
      catch (cleanupError) { receipt.cleanupError = String(cleanupError?.stack ?? cleanupError); }
    } else if (!supervisorClosed) {
      try {
        await issueOwnerCommand({ child, ownerToken, beforeOwnerCommand, launchReceipt },
          { type: "signal-group", signal: "SIGTERM" }, "error-cleanup");
        termSent = true;
        receipt.termSent = true;
        const cleanup = await waitForOwnedMembers({ pgid: launchReceipt.pgid, anchorPid: launchReceipt.pid, census,
          timeoutMs: terminateGraceMs, pollMs: 40, censusTimeoutMs });
        if (cleanup.known) await issueOwnerCommand({ child, ownerToken, beforeOwnerCommand, launchReceipt }, { type: "shutdown" }, "error-shutdown");
        else {
          await issueOwnerCommand({ child, ownerToken, beforeOwnerCommand, launchReceipt },
            { type: "signal-group", signal: "SIGKILL" }, "error-reap");
          killSent = true;
          receipt.killSent = true;
        }
        await withTimeout(supervisorClosedPromise, reapTimeoutMs, "Owned process cleanup");
      } catch (cleanupError) {
        ownerLost ||= Boolean(cleanupError?.ownershipLost);
        receipt.cleanupError = String(cleanupError?.stack ?? cleanupError);
        if (ownerLost) child.stdin.end();
      }
    }
    try {
      const rows = await withTimeout(Promise.resolve().then(census), censusTimeoutMs, "Final owned process census");
      receipt.remaining = processGroupCensus(launchReceipt.pgid, rows).map(({ pid, command: processCommand }) => ({ pid, command: processCommand }));
      receipt.ownershipKnown = receipt.remaining.length === 0 && supervisorClosed && !ownerLost;
    } catch (censusError) {
      receipt.censusError = String(censusError?.stack ?? censusError);
    }
    receipt.stdout = stdout.toString("utf8");
    receipt.stderr = stderr.toString("utf8");
    throw Object.assign(error, { receipt });
  }
}
