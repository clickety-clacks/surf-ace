import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAutostartHostGuard } from "../scripts/tars-autostart-guard.mjs";

test("Surf Ace auto-start guard allows TARS aliases", () => {
  assert.deepEqual(evaluateAutostartHostGuard(["tars"], {}), {
    allowed: true,
    hostNames: ["tars"],
    reason: "tars_host",
  });
  assert.deepEqual(evaluateAutostartHostGuard(["TARS.tail4105e8.ts.net."], {}), {
    allowed: true,
    hostNames: ["tars.tail4105e8.ts.net"],
    reason: "tars_host",
  });
  assert.deepEqual(evaluateAutostartHostGuard(["TARS-2.local"], {}), {
    allowed: true,
    hostNames: ["tars-2"],
    reason: "tars_host",
  });
});

test("Surf Ace auto-start guard rejects non-TARS hosts without override", () => {
  const result = evaluateAutostartHostGuard(["eezo.local"], {});

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "non_tars_host");
  assert.deepEqual(result.hostNames, ["eezo"]);
  assert.match(result.message ?? "", /TARS-only/);
  assert.match(result.message ?? "", /SURF_ACE_ALLOW_NON_TARS_AUTOSTART=1/);
});

test("Surf Ace auto-start guard allows explicit non-TARS override", () => {
  assert.deepEqual(
    evaluateAutostartHostGuard(["eezo.local"], {
      SURF_ACE_ALLOW_NON_TARS_AUTOSTART: "1",
    }),
    {
      allowed: true,
      hostNames: ["eezo"],
      reason: "override",
    },
  );
});
