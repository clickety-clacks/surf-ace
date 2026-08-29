import assert from "node:assert/strict";
import test from "node:test";

import { validateDeployHost } from "./validate-deploy-host.mjs";

test("deployment host validation accepts portable host names", () => {
  assert.deepEqual(validateDeployHost("provider-a.example.test."), {
    host: "provider-a.example.test",
    ok: true,
  });
});

test("deployment host validation fails closed for missing or unsafe values", () => {
  assert.equal(validateDeployHost("").ok, false);
  assert.equal(validateDeployHost("ssh://provider-a").ok, false);
  assert.equal(validateDeployHost("user@provider-a").ok, false);
  assert.equal(validateDeployHost("provider-a:22").ok, false);
  assert.equal(validateDeployHost("provider-a/path").ok, false);
});
