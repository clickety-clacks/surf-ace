import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the standalone central server bundle loads its protocol schema", () => {
  const require = createRequire(import.meta.url);
  const entrypoint = fileURLToPath(new URL("../central-server.cjs", import.meta.url));
  assert.equal(typeof require(entrypoint).startCentralServer, "function");
});
