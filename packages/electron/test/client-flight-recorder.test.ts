import assert from "node:assert/strict";
import test from "node:test";

import {
  clientDiagnosticLine,
  clientFlightRecorderGrepCommand,
  clientFlightRecorderTailCommand,
  formatClientDiagnosticValue,
} from "../src/client-flight-recorder.js";

test("client flight recorder formats SSH-readable diagnostic lines and commands", () => {
  assert.equal(formatClientDiagnosticValue("plain_value-1"), "plain_value-1");
  assert.equal(formatClientDiagnosticValue("value with spaces"), "\"value with spaces\"");

  assert.equal(
    clientDiagnosticLine("app", "selected_provider_endpoint", {
      endpoint_name: "provider-a Surf Ace",
      port: 19001,
      surface_id: "sf_1234",
    }),
    "[surf-ace:app] event=selected_provider_endpoint endpoint_name=\"provider-a Surf Ace\" port=19001 surface_id=sf_1234",
  );

  assert.equal(clientFlightRecorderTailCommand("/tmp/surf ace/client.log"), "tail -n 200 '/tmp/surf ace/client.log'");
  assert.equal(
    clientFlightRecorderGrepCommand("/tmp/surf ace/client.log"),
    "rg 'event=(app_|server_|socket_|pair_|panes_|topology_|surface_|window_)' '/tmp/surf ace/client.log'",
  );
});
