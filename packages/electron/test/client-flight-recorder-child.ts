import { installMainProcessFailureDiagnostics } from "../src/client-flight-recorder.js";

installMainProcessFailureDiagnostics();
const event = process.argv[2];
setImmediate(() => {
  if (event === "app_unhandled_rejection") {
    void Promise.reject(new Error(event));
  } else {
    throw new Error(event);
  }
});
