import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SurfaceCore, type PersistentSurfaceState } from "../src/surface-core.js";
import {
  assertWritesAllowed,
  handleBeforeQuit,
  QUIT_EXIT_DEADLINE_MS,
  QUIT_WATCHDOG_DELAY_MS,
} from "../src/quit-lifecycle.js";
import { loadPersistentStateFile, writePersistentStateFile } from "../src/persistent-state-file.js";

const helperPath = fileURLToPath(new URL("../quit-lifecycle.cjs", import.meta.url));
const electronExecutable = createRequire(import.meta.url)("electron") as string;

test("ordinary Quit preserves acknowledged state, blocks new saves, and does not wait for stalled cleanup", async () => {
  assert.equal(QUIT_EXIT_DEADLINE_MS, 10_000);
  assert.equal(QUIT_WATCHDOG_DELAY_MS, 9_000);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-quit-"));
  const core = new SurfaceCore({ persistentState: { primarySurfaceId: null, version: 1 } });
  const surface = core.ensurePrimarySurface("Quit lifecycle fixture", { height: 800, scale: 2, width: 1200 });
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# Saved before Quit" },
    contentId: "ct_quit_lifecycle" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_quit_lifecycle" as never,
    paneId: 0 as never,
    revision: 1 as never,
  });
  const state: PersistentSurfaceState = core.getPersistentState();
  try {
    await writePersistentStateFile(stateDir, "state.json", state);
    let quitting = false;
    let prevented = false;
    let exitCode: number | null = null;
    const calls: string[] = [];
    handleBeforeQuit({ preventDefault: () => { prevented = true; } }, {
      armWatchdog: () => calls.push("watchdog"),
      cleanup: [() => {
        calls.push("cleanup-started");
        return new Promise<void>(() => {});
      }],
      exit: (code) => { calls.push("exit"); exitCode = code; },
      isQuitting: () => quitting,
      markQuitting: () => { calls.push("stop-new-writes"); quitting = true; },
      onError: (error) => { throw error; },
      stopBackgroundWork: () => calls.push("stop-retries"),
    });

    assert.equal(prevented, true);
    assert.equal(exitCode, 0);
    assert.deepEqual(calls, ["stop-new-writes", "watchdog", "stop-retries", "cleanup-started", "exit"]);
    assert.doesNotThrow(() => assertWritesAllowed(false));
    assert.throws(() => assertWritesAllowed(quitting), /application_is_quitting/);
    const restored = await loadPersistentStateFile(stateDir, "state.json");
    assert.deepEqual(restored.state, JSON.parse(JSON.stringify(state)),
      "a save acknowledged before Quit remains on disk even while runtime cleanup is stuck");
    const reopened = new SurfaceCore({ persistentState: restored.state });
    const [reopenedSurface] = reopened.restorePersistedSurfaces("Quit lifecycle fixture", {
      height: 800,
      scale: 2,
      width: 1200,
    });
    assert.equal(reopenedSurface?.surfaceId, surface.surfaceId);
    assert.deepEqual(reopened.getRendererWindowState(surface.surfaceId).panes[0]?.content.content,
      { markdown: "# Saved before Quit" }, "ordinary Quit does not finalize or discard saved pane content");
  } finally {
    await fs.rm(stateDir, { force: true, recursive: true });
  }
});

test("ordinary Quit uses an external Electron watchdog and leaves acknowledged state restorable", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-quit-watchdog-"));
  const core = new SurfaceCore({ persistentState: { primarySurfaceId: null, version: 1 } });
  const surface = core.ensurePrimarySurface("Quit watchdog fixture", { height: 800, scale: 2, width: 1200 });
  core.contentSet(surface.surfaceId, {
    content: { markdown: "# State acknowledged before a stalled Quit" },
    contentId: "ct_quit_watchdog" as never,
    contentType: "markdown",
    historyOwnerToken: "hot_quit_watchdog" as never,
    paneId: 0 as never,
    revision: 1 as never,
  });
  const state: PersistentSurfaceState = core.getPersistentState();
  await writePersistentStateFile(stateDir, "state.json", state);
  const program = [
    `const { handleBeforeQuit, startQuitWatchdog } = require(${JSON.stringify(helperPath)});`,
    "let quitting = false;",
    "handleBeforeQuit({ preventDefault() {} }, {",
    "  armWatchdog: () => startQuitWatchdog(900, 250),",
    "  cleanup: [() => new Promise(() => {})],",
    "  exit: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0),",
    "  isQuitting: () => quitting,",
    "  markQuitting: () => { quitting = true; },",
    "  onError: () => {},",
    "  stopBackgroundWork: () => {},",
    "});",
  ].join("\n");
  const child = spawn(electronExecutable, ["-e", program], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("external Electron watchdog did not exit the blocked process")), 3_000);
    timer.unref();
  });
  const startedAt = Date.now();
  try {
    const result = await Promise.race([exited, timeout]);
    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGTERM");
    assert.ok(Date.now() - startedAt < 2_000);
    const restored = await loadPersistentStateFile(stateDir, "state.json");
    assert.deepEqual(restored.state, JSON.parse(JSON.stringify(state)));
    const reopened = new SurfaceCore({ persistentState: restored.state });
    const [reopenedSurface] = reopened.restorePersistedSurfaces("Quit watchdog fixture", {
      height: 800,
      scale: 2,
      width: 1200,
    });
    assert.equal(reopenedSurface?.surfaceId, surface.surfaceId);
    assert.deepEqual(reopened.getRendererWindowState(surface.surfaceId).panes[0]?.content.content,
      { markdown: "# State acknowledged before a stalled Quit" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(stateDir, { force: true, recursive: true });
  }
});

test("the external Electron watchdog force-exits when normal termination cannot finish", async () => {
  const program = [
    `const { startQuitWatchdog } = require(${JSON.stringify(helperPath)});`,
    "process.on('SIGTERM', () => {});",
    "startQuitWatchdog(450, 200);",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
  ].join("\n");
  const child = spawn(electronExecutable, ["-e", program], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("forced watchdog deadline did not exit the blocked process")), 2_000);
    timer.unref();
  });
  try {
    const result = await Promise.race([exited, timeout]);
    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
