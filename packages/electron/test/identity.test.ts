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

test("an unreadable identity is left untouched and does not create a replacement key", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-electron-identity-"));
  const identityPath = path.join(stateDir, "surface-identity.json");
  try {
    const original = await loadOrCreateIdentity(stateDir);
    assert(original);
    const originalReadFile = fs.readFile;
    const originalContents = await originalReadFile(identityPath, "utf8");
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

    assert.equal(attempts, 1);
    assert.equal(restored, null);
    assert.equal(await originalReadFile(identityPath, "utf8"), originalContents);
    assert.deepEqual(await loadOrCreateIdentity(stateDir), original);
  } finally {
    await fs.rm(stateDir, { force: true, recursive: true });
  }
});

test("malformed saved identity bytes remain untouched", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-electron-identity-"));
  const identityPath = path.join(stateDir, "surface-identity.json");
  const malformed = "{saved key cannot be decoded";
  try {
    await fs.writeFile(identityPath, malformed);
    assert.equal(await loadOrCreateIdentity(stateDir), null);
    assert.equal(await fs.readFile(identityPath, "utf8"), malformed);
  } finally {
    await fs.rm(stateDir, { force: true, recursive: true });
  }
});

test("a missing identity is not created when saved state exists", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-electron-identity-"));
  const identityPath = path.join(stateDir, "surface-identity.json");
  try {
    assert.equal(await loadOrCreateIdentity(stateDir, { allowCreate: false }), null);
    await assert.rejects(fs.access(identityPath));
  } finally {
    await fs.rm(stateDir, { force: true, recursive: true });
  }
});
