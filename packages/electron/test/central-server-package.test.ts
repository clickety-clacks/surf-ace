import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the standalone central server bundle loads its protocol schema", () => {
  const require = createRequire(import.meta.url);
  const entrypoint = fileURLToPath(new URL("../central-server.cjs", import.meta.url));
  assert.equal(typeof require(entrypoint).startCentralServer, "function");
});

test("the packaged server layout loads its protocol schema", async () => {
  const require = createRequire(import.meta.url);
  const bundle = fileURLToPath(new URL("../central-server.cjs", import.meta.url));
  const schema = fileURLToPath(new URL("../schema.json", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "surf-ace-packaged-server-"));
  try {
    await mkdir(join(root, "server"));
    await mkdir(join(root, "schemas", "protocol"), { recursive: true });
    await copyFile(bundle, join(root, "server", "central-server.cjs"));
    await copyFile(schema, join(root, "schemas", "protocol", "schema.json"));
    assert.equal(typeof require(join(root, "server", "central-server.cjs")).startCentralServer, "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
