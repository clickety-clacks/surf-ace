import { spawn, type ChildProcess } from "node:child_process";

export const QUIT_EXIT_DEADLINE_MS = 10_000;
export const QUIT_WATCHDOG_DELAY_MS = QUIT_EXIT_DEADLINE_MS - 1_000;
export const QUIT_WATCHDOG_FORCE_DELAY_MS = 500;

let activeQuitWatchdog: ChildProcess | null = null;

export function startQuitWatchdog(
  delayMs = QUIT_WATCHDOG_DELAY_MS,
  forceDelayMs = QUIT_WATCHDOG_FORCE_DELAY_MS,
  onSpawnError?: (error: Error) => void,
): ChildProcess {
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs >= QUIT_EXIT_DEADLINE_MS) {
    throw new RangeError("quit_watchdog_delay_out_of_range");
  }
  if (!Number.isSafeInteger(forceDelayMs) || forceDelayMs < 0 || forceDelayMs >= delayMs) {
    throw new RangeError("quit_watchdog_force_delay_out_of_range");
  }
  const watchdog = spawn(process.execPath, ["-e", `
    const parentPid = Number(process.argv[1]);
    const delayMs = Number(process.argv[2]);
    const forceDelayMs = Number(process.argv[3]);
    let termTimer;
    let forceTimer;
    const stop = () => {
      clearTimeout(termTimer);
      clearTimeout(forceTimer);
      process.exit(0);
    };
    process.on("disconnect", stop);
    const terminate = (signal) => {
      if (!process.connected) return stop();
      try { process.kill(parentPid, signal); } catch { stop(); }
    };
    termTimer = setTimeout(() => terminate("SIGTERM"), delayMs - forceDelayMs);
    forceTimer = setTimeout(() => terminate("SIGKILL"), delayMs);
  `, String(process.pid), String(delayMs), String(forceDelayMs)], {
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  activeQuitWatchdog = watchdog;
  watchdog.once("error", (error) => {
    try { onSpawnError?.(error); } catch { /* diagnostics must not block the exit bound */ }
    try { process.kill(process.pid, "SIGKILL"); } catch { /* the app is already exiting */ }
  });
  activeQuitWatchdog.unref();
  activeQuitWatchdog.channel?.unref();
  return activeQuitWatchdog;
}

export function assertWritesAllowed(isQuitting: boolean): void {
  if (isQuitting) throw new Error("application_is_quitting");
}

export type BeforeQuitEvent = { preventDefault(): void };

export type BeforeQuitLifecycle = {
  armWatchdog(): void;
  cleanup: Array<() => void | Promise<void>>;
  exit(code: number): void;
  isQuitting(): boolean;
  markQuitting(): void;
  onError(error: unknown): void;
  stopBackgroundWork(): void;
};

export function handleBeforeQuit(event: BeforeQuitEvent, lifecycle: BeforeQuitLifecycle): void {
  const report = (error: unknown): void => {
    try { lifecycle.onError(error); } catch { /* reporting must not hold process exit */ }
  };
  event.preventDefault();
  if (lifecycle.isQuitting()) {
    lifecycle.exit(0);
    return;
  }

  lifecycle.markQuitting();
  try { lifecycle.armWatchdog(); } catch (error) { report(error); }
  try { lifecycle.stopBackgroundWork(); } catch (error) { report(error); }
  for (const cleanup of lifecycle.cleanup) {
    try {
      void Promise.resolve(cleanup()).catch(report);
    } catch (error) {
      report(error);
    }
  }
  // Each acknowledged save is already durable before its caller receives an
  // acknowledgement. An in-flight uncertain save is intentionally not waited
  // on or relabeled as saved during Quit.
  lifecycle.exit(0);
}
