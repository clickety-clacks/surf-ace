import { createRequire } from "node:module";
import { installMainProcessFailureDiagnostics } from "../src/client-flight-recorder.js";

installMainProcessFailureDiagnostics();
const event = process.argv[2];
setImmediate(() => {
  if (process.argv.includes("electron_warning_probe")) {
    void Promise.reject(new Error("recorder-main-error"));
    void Promise.reject("recorder-main-string");
    setImmediate(() => {
      const { app } = createRequire(import.meta.url)("electron") as typeof import("electron");
      process.stdout.write(`RECORDER_PROBE_CONTINUED exitCode=${process.exitCode}\n`);
      app.exit(Number(process.exitCode ?? 0));
    });
  } else if (event === "app_unhandled_rejection") {
    void Promise.reject(new Error(event));
  } else {
    throw new Error(event);
  }
});
