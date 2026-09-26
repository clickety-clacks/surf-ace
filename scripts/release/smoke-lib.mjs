import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { run } from "./release-lib.mjs";

export function start(command, args, options = {}) {
  const child = spawn(command, args, { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
  return { child, output: () => ({ stderr, stdout }) };
}

export async function stop(started) {
  const signal = (name) => {
    try {
      if (process.platform === "win32") started.child.kill(name);
      else process.kill(-started.child.pid, name);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const exited = started.child.exitCode === null
    ? new Promise((resolve) => started.child.once("exit", resolve))
    : Promise.resolve();
  signal("SIGTERM");
  if (started.child.exitCode === null) {
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }
  if (started.child.exitCode === null) {
    const killed = new Promise((resolve) => started.child.once("exit", resolve));
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

export async function electronHandshake(appExecutable, home, port) {
  const stateDir = path.join(home, "electron-state");
  await fs.mkdir(stateDir, { recursive: true });
  const started = start(appExecutable, [], {
    env: {
      ...process.env,
      HOME: home,
      SURF_ACE_BIND: "127.0.0.1",
      SURF_ACE_DISABLE_ADVERTISING: "1",
      SURF_ACE_PORT: String(port),
      SURF_ACE_STATE_DIR: stateDir,
    },
  });
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
