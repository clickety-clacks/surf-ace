import { spawn } from "node:child_process";
import fs from "node:fs";

// This detached process is the owned process-group leader and remains alive until
// its parent proves all target descendants have exited. Group signals originate
// here while this exact process still owns the group; the parent never signals a
// numeric PID/PGID after a census gap.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

let ownerToken;
let target = null;
let targetClosed = false;
let shuttingDown = false;
let inputBuffer = "";
let ownerCleanupStarted = false;
// Keep the detached ownership anchor alive even on runtimes where a pipe-backed
// stdin alone does not retain the event loop.
const anchorKeepAlive = setInterval(() => {}, 60_000);

function emit(message) {
  if (!ownerToken) return;
  try { fs.writeSync(3, JSON.stringify({ ...message, ownerToken }) + "\n"); } catch {}
}

function signalOwnedGroup(signal) {
  if (!ownerToken || process.pid <= 1) return;
  // The detached supervisor remains the group leader for its lifetime. Keeping
  // this process alive pins that PGID generation until the final signal.
  try {
    process.kill(-process.pid, signal);
    emit({ type: "signal-accepted", signal, anchorPid: process.pid });
  } catch (error) {
    emit({ type: "signal-error", signal, error: String(error), anchorPid: process.pid });
  }
}

function launch(config) {
  ownerToken = config.ownerToken;
  if (!ownerToken || typeof config.command !== "string" || !config.command.startsWith("/")) {
    emit({ type: "target-error", error: "Invalid owned process launch configuration" });
    return;
  }
  try {
    target = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: config.env,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    target.stdout?.pipe(process.stdout, { end: false });
    target.stderr?.pipe(process.stderr, { end: false });
    target.once("error", (error) => emit({ type: "target-error", error: String(error.stack ?? error) }));
    target.once("spawn", () => emit({ type: "target-started", pid: target.pid, anchorPid: process.pid }));
    target.once("close", (code, signal) => {
      targetClosed = true;
      emit({ type: "target-exit", result: { code, signal }, anchorPid: process.pid });
    });
  } catch (error) {
    targetClosed = true;
    emit({ type: "target-error", error: String(error.stack ?? error), anchorPid: process.pid });
  }
}

async function onLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "launch" && !ownerToken) {
    launch(message);
    return;
  }
  if (!ownerToken || message.ownerToken !== ownerToken) {
    emit({ type: "command-rejected", reason: "owner token mismatch" });
    return;
  }
  if (message.type === "signal-group" && ["SIGTERM", "SIGKILL"].includes(message.signal)) {
    signalOwnedGroup(message.signal);
  } else if (message.type === "shutdown") {
    if (!targetClosed) {
      emit({ type: "command-rejected", reason: "target is still running" });
      return;
    }
    shuttingDown = true;
    emit({ type: "shutdown-accepted", anchorPid: process.pid });
    clearInterval(anchorKeepAlive);
    process.stdin.pause();
    setImmediate(() => process.exit(0));
  } else {
    emit({ type: "command-rejected", reason: "unsupported command" });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newline;
  while ((newline = inputBuffer.indexOf("\n")) >= 0) {
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    void onLine(line);
  }
});
process.stdin.on("end", () => {
  if (shuttingDown || ownerCleanupStarted) return;
  ownerCleanupStarted = true;
  if (!ownerToken) {
    clearInterval(anchorKeepAlive);
    setImmediate(() => process.exit(0));
    return;
  }
  // If the parent disappears unexpectedly, the exact owned anchor still cleans
  // its group. The short reserve bounds abandoned-fixture lifetime.
  signalOwnedGroup("SIGTERM");
  setTimeout(() => signalOwnedGroup("SIGKILL"), 750).unref?.();
});
process.stdin.resume();
