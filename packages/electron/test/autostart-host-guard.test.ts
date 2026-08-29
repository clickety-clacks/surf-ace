import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAutostartHostGuard } from "../scripts/autostart-host-guard.mjs";

test("Surf Ace auto-start guard allows an explicitly configured host", () => {
  assert.deepEqual(evaluateAutostartHostGuard(["workstation-a"], {
    SURF_ACE_AUTOSTART_ALLOWED_HOSTS: "workstation-a, workstation-b.example.test",
  }), {
    allowed: true,
    hostNames: ["workstation-a"],
    reason: "configured_host",
  });
});

test("Surf Ace auto-start guard fails closed without configuration", () => {
  const result = evaluateAutostartHostGuard(["workstation-a.local"], {});

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "configuration_missing_or_invalid");
  assert.deepEqual(result.hostNames, ["workstation-a"]);
  assert.match(result.message ?? "", /SURF_ACE_AUTOSTART_ALLOWED_HOSTS is required/);
});

test("Surf Ace auto-start guard rejects invalid configuration and unlisted hosts", () => {
  const invalid = evaluateAutostartHostGuard(["workstation-a"], {
    SURF_ACE_AUTOSTART_ALLOWED_HOSTS: "ssh://workstation-a",
  });
  assert.equal(invalid.allowed, false);
  assert.equal(invalid.reason, "configuration_missing_or_invalid");

  const unlisted = evaluateAutostartHostGuard(["workstation-b"], {
    SURF_ACE_AUTOSTART_ALLOWED_HOSTS: "workstation-a",
  });
  assert.equal(unlisted.allowed, false);
  assert.equal(unlisted.reason, "host_not_allowed");
});
