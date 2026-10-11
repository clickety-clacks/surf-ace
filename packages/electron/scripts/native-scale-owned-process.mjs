import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const result = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return result;
}

export function processCensus() {
  const output = execFileSync("ps", ["-eo", "pid=,pgid=,args="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }] : [];
  });
}

export function electronProcessCensus(electronPath, census = processCensus()) {
  const resolved = String(electronPath);
  return census.filter(({ command }) => command.includes(resolved) ||
    /(?:^|\/)electron(?:\s|$)/i.test(command));
}

export function processGroupCensus(pgid, census = processCensus()) {
  return census.filter((entry) => entry.pgid === pgid);
}

async function waitForGroupEmpty(pgid, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = processGroupCensus(pgid);
  while (remaining.length && Date.now() < deadline) {
    await delay(intervalMs);
    remaining = processGroupCensus(pgid);
  }
  return remaining;
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function runOwnedProcess({
  command,
  args = [],
  options = {},
  deadlineMs,
  terminateGraceMs = 2_000,
  reapTimeoutMs = 3_000,
  maxOutputBytes = 1_000_000,
}) {
  if (typeof command !== "string" || !command.startsWith("/")) throw new Error("Owned command must use an absolute executable path");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 50 || deadlineMs > 180_000) throw new Error("Owned command deadline is invalid");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("Owned command output bound is invalid");

  const startedAt = Date.now();
  const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
  const pgid = child.pid;
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error("Could not establish an owned process group");
  const runDeadlineMs = Math.max(1, deadlineMs - (Date.now() - startedAt));
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  const appendBounded = (current, chunk) => {
    const combined = Buffer.concat([current, chunk]);
    return combined.length > maxOutputBytes ? combined.subarray(combined.length - maxOutputBytes) : combined;
  };
  child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });

  let exitResult;
  let waitError;
  let termSent = false;
  let killSent = false;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => { waitError = error; resolve({ code: null, signal: null }); });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  let deadlineTimer;
  const deadlineReached = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), runDeadlineMs);
    deadlineTimer.unref?.();
  });
  const outcome = await Promise.race([exited.then((result) => ({ kind: "exit", result })), deadlineReached]);
  clearTimeout(deadlineTimer);
  if (outcome.kind === "exit") {
    exitResult = outcome.result;
  } else {
    timedOut = true;
    termSent = true;
    signalGroup(pgid, "SIGTERM");
    let remaining = await waitForGroupEmpty(pgid, terminateGraceMs, 40);
    if (remaining.length) {
      killSent = true;
      signalGroup(pgid, "SIGKILL");
      const stubborn = await waitForGroupEmpty(pgid, reapTimeoutMs, 40);
      if (stubborn.length) {
        throw Object.assign(new Error(`Owned process group ${pgid} did not empty after its deadline`), {
          receipt: { pid: child.pid, pgid, timedOut, termSent, killSent,
            remaining: stubborn.map(({ pid, command }) => ({ pid, command })),
            stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") },
        });
      }
    }
    exitResult = await settleWithin(exited, reapTimeoutMs);
    if (!exitResult) throw Object.assign(new Error(`Owned process ${child.pid} did not exit after its process group was reaped`), {
      receipt: { pid: child.pid, pgid, timedOut, termSent, killSent, remaining: [] },
    });
  }

  let remaining = processGroupCensus(pgid);
  if (remaining.length) {
    termSent = true;
    signalGroup(pgid, "SIGTERM");
    remaining = await waitForGroupEmpty(pgid, terminateGraceMs, 40);
  }
  if (remaining.length) {
    killSent = true;
    signalGroup(pgid, "SIGKILL");
    remaining = await waitForGroupEmpty(pgid, reapTimeoutMs, 40);
  }
  const receipt = {
    pid: child.pid,
    pgid,
    code: exitResult.code,
    signal: exitResult.signal,
    timedOut,
    termSent,
    killSent,
    remaining: remaining.map(({ pid, command }) => ({ pid, command })),
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
  };
  if (remaining.length) throw Object.assign(new Error(`Owned process group ${pgid} did not empty after SIGKILL`), { receipt });
  const closeResult = await settleWithin(closed, reapTimeoutMs);
  if (!closeResult) throw Object.assign(new Error(`Owned process ${child.pid} stdio did not close after its process group was reaped`), { receipt });
  receipt.stdout = stdout.toString("utf8");
  receipt.stderr = stderr.toString("utf8");
  if (waitError) throw Object.assign(waitError, { receipt });
  return receipt;
}
