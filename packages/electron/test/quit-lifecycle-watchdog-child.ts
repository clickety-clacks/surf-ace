import { writePersistentStateFile } from "../src/persistent-state-file.js";
import { handleBeforeQuit, startQuitWatchdog } from "../src/quit-lifecycle.js";
import type { PersistentSurfaceState } from "../src/surface-core.js";

const [stateDir, serializedState] = process.argv.slice(2);
if (!stateDir || !serializedState) throw new Error("quit_watchdog_test_args_missing");

const state = JSON.parse(serializedState) as PersistentSurfaceState;
await writePersistentStateFile(stateDir, "state.json", state);
process.send?.({ type: "saved" });

let quitting = false;
process.on("SIGTERM", () => {});
handleBeforeQuit({
  preventDefault: () => process.send?.({ type: "quit-start" }),
}, {
  armWatchdog: () => {
    const watchdog = startQuitWatchdog();
    // Model Electron closing the Node-owned IPC handle before native teardown.
    watchdog.disconnect();
  },
  cleanup: [() => new Promise<void>(() => {})],
  exit: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0),
  isQuitting: () => quitting,
  markQuitting: () => { quitting = true; },
  onError: () => {},
  stopBackgroundWork: () => {},
});
