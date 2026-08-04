import assert from "node:assert/strict";
import test from "node:test";

import { rollbackPreflight } from "./rollback-preflight.mjs";

test("rollback preflight permits a package rollback before preparation", () => {
  assert.deepEqual(rollbackPreflight({
    locklessMigrationContinuity: { endpoints: {}, schemaVersion: 1 },
  }), { allowed: true });
});

test("rollback preflight refuses before mutation after any preparation record", () => {
  const state = {
    locklessMigrationContinuity: {
      endpoints: {
        "electron-1": {
          surfaces: { sf_1: { transaction: { phase: "prepared" } } },
        },
      },
      schemaVersion: 1,
    },
  };
  const before = structuredClone(state);
  assert.deepEqual(rollbackPreflight(state), {
    allowed: false,
    error: "rollback_requires_full_reset",
  });
  assert.deepEqual(state, before);
});
