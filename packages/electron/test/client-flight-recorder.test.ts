import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const originalLogPath = process.env.SURF_ACE_CLIENT_DIAGNOSTIC_LOG;
const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-flight-recorder-"));
const logPath = path.join(logDir, "client-flight-recorder.log");
process.env.SURF_ACE_CLIENT_DIAGNOSTIC_LOG = logPath;

const {
  clientDiagnosticLine,
  clientFlightRecorderGrepCommand,
  clientFlightRecorderTailCommand,
  recordClientDiagnostic,
} = await import("../src/client-flight-recorder.js");

after(async () => {
  await fs.rm(logDir, { force: true, recursive: true });
  if (originalLogPath === undefined) delete process.env.SURF_ACE_CLIENT_DIAGNOSTIC_LOG;
  else process.env.SURF_ACE_CLIENT_DIAGNOSTIC_LOG = originalLogPath;
});

test("client flight recorder keeps its diagnostic line and collection command format", () => {
  assert.equal(
    clientDiagnosticLine("app", "selected_provider_endpoint", {
      endpoint_name: "provider-a Surf Ace",
      port: 19001,
      surface_id: "sf_1234",
    }),
    '[surf-ace:app] event=selected_provider_endpoint endpoint_name="provider-a Surf Ace" port=19001 surface_id=sf_1234',
  );
  assert.equal(clientFlightRecorderTailCommand(logPath), `tail -n 200 '${logPath}'`);
  assert.equal(
    clientFlightRecorderGrepCommand(logPath),
    `rg 'event=(app_|server_|socket_|pair_|panes_|topology_|surface_|window_)' '${logPath}'`,
  );
});

test("client flight recorder retains recent complete entries within its byte bound", async () => {
  const oldest = "2026-01-01T00:00:00.000Z [surf-ace:app] event=oldest_detail\n";
  const oversizedPriorRecord = "x".repeat(MAX_LOG_BYTES + 256);
  const recentPrior = "2026-11-15T12:00:00.000Z [surf-ace:app] event=recent_prior detail=kept\n";
  await fs.writeFile(logPath, `${oldest}${oversizedPriorRecord}\n${recentPrior}`);

  const originalError = console.error;
  console.error = () => {};
  try {
    recordClientDiagnostic("error", "app", "recent_crash_detail", {
      error_message: "websocket closed after reconnect",
    });
  } finally {
    console.error = originalError;
  }

  const retained = await fs.readFile(logPath);
  const text = retained.toString("utf8");
  assert.ok(retained.byteLength <= MAX_LOG_BYTES);
  assert.doesNotMatch(text, /oldest_detail/);
  assert.doesNotMatch(text, /x{100}/);
  assert.match(text, /recent_prior detail=kept/);
  assert.match(text, /event=recent_crash_detail error_message="websocket closed after reconnect"/);
  assert.ok(text.indexOf("recent_prior") < text.indexOf("recent_crash_detail"));
});

test("a single oversized diagnostic entry is truncated without exceeding the same bound", async () => {
  await fs.writeFile(logPath, "2026-11-15T12:00:00.000Z [surf-ace:app] event=old_detail\n");
  const originalError = console.error;
  console.error = () => {};
  try {
    recordClientDiagnostic("error", "app", "large_error", {
      error_message: "x".repeat(MAX_LOG_BYTES + 1024),
    });
  } finally {
    console.error = originalError;
  }

  const retained = await fs.readFile(logPath);
  const text = retained.toString("utf8");
  assert.ok(retained.byteLength <= MAX_LOG_BYTES);
  assert.doesNotMatch(text, /old_detail/);
  assert.match(text, /^\d{4}-\d{2}-\d{2}T[^ ]+ \[surf-ace:app\] event=large_error /);
  assert.match(text, /\.\.\.\[truncated\]\n$/);
});
