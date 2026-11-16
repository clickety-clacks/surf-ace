import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const electron = fileURLToPath(new URL("../node_modules/.bin/electron", import.meta.url));
const fixture = fileURLToPath(new URL("../scripts/test-covered-pane-capture.mjs", import.meta.url));

async function runFixture(forceDirectCapture) {
  const args = [
    "--auto-servernum",
    "--server-args=-screen 0 1280x800x24",
    electron,
    "--no-sandbox",
    fixture,
  ];
  const child = spawn("xvfb-run", args, {
    detached: true,
    env: { ...process.env, SURF_ACE_TEST_FORCE_DIRECT_CAPTURE: forceDirectCapture ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") child.kill("SIGKILL");
      }
    }
  }, 40_000);

  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    return { ...result, output, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

function fixtureEvidence(output) {
  return output.split(/\r?\n/).filter((line) =>
    line.startsWith("FIXTURE_RUNTIME=")
    || line.startsWith("CAPTURE_CASE=")
    || line.includes("covered target capture: expected")
  );
}

test("Electron captures pane pixels while uncovered and covered, and the direct path regresses", {
  skip: process.platform !== "linux" && "covered-window pixel behavior is exercised on Linux",
  timeout: 90_000,
}, async () => {
  console.log(`CAPTURE_FIXTURE_COMMAND=${JSON.stringify(["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x800x24", electron, "--no-sandbox", fixture])}`);

  const fixed = await runFixture(false);
  console.log(`CAPTURE_FIXTURE_FIXED=${JSON.stringify(fixtureEvidence(fixed.output))}`);
  assert.equal(fixed.timedOut, false, "fixed covered-pane fixture must finish within 40 seconds");
  assert.equal(fixed.code, 0, `fixed covered-pane fixture failed (${fixed.signal}):\n${fixed.output}`);
  assert.match(fixed.output, /CAPTURE_CASE=.*"label":"uncovered"/);
  assert.match(fixed.output, /CAPTURE_CASE=.*"label":"covered"/);
  assert.match(fixed.output, /CAPTURE_CASE=.*"label":"uncovered-again"/);

  const direct = await runFixture(true);
  console.log(`CAPTURE_FIXTURE_DIRECT=${JSON.stringify(fixtureEvidence(direct.output))}`);
  assert.equal(direct.timedOut, false, "direct-path control fixture must finish within 40 seconds");
  assert.notEqual(direct.code, 0, `direct capture unexpectedly returned covered pane pixels:\n${direct.output}`);
  assert.match(direct.output, /CAPTURE_CASE=.*"label":"uncovered"/);
  assert.match(direct.output, /covered target capture: expected/);
});
