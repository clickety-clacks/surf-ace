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

test("identity retries a transient read failure without replacing the saved client identity", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-electron-identity-"));
  const identityPath = path.join(stateDir, "surface-identity.json");
  try {
    const original = await loadOrCreateIdentity(stateDir);
    const originalReadFile = fs.readFile;
    let attempts = 0;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === identityPath && attempts++ === 0) {
        throw Object.assign(new Error("temporary read failure"), { code: "EIO" });
      }
      return await originalReadFile(...args);
    }) as typeof fs.readFile;
    let restored: Awaited<ReturnType<typeof loadOrCreateIdentity>>;
    try {
      restored = await loadOrCreateIdentity(stateDir);
    } finally {
      fs.readFile = originalReadFile;
    }

    assert.equal(attempts, 2);
    assert.deepEqual(restored, original);
  } finally {
    await fs.rm(stateDir, { force: true, recursive: true });
  }
});
