import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOrCreateIdentity } from "../src/identity.js";

test("identity fingerprint prefix is derived from the persisted public key", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-electron-identity-"));
  try {
    const first = await loadOrCreateIdentity(stateDir);
    const second = await loadOrCreateIdentity(stateDir);

    assert.equal(first.publicKeyPem, second.publicKeyPem);
    assert.equal(first.fingerprintPrefix, second.fingerprintPrefix);
    assert.match(first.fingerprintPrefix, /^[0-9a-f]{8}$/);
  } finally {
    await fs.rm(stateDir, { force: true, recursive: true });
  }
});
