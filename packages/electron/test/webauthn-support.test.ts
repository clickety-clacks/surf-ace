import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const keychainAccessGroup = "Z7R59J7QV8.ai.surf-ace.electron.webauthn";

test("Surf Ace enables Electron platform WebAuthn before app readiness", async () => {
  const mainSource = await fs.readFile(new URL("../../src/main.ts", import.meta.url), "utf8");
  const configureIndex = mainSource.indexOf("app.configureWebAuthn({");
  const readyIndex = mainSource.indexOf("app.whenReady()");

  assert.notEqual(configureIndex, -1);
  assert.notEqual(readyIndex, -1);
  assert.ok(configureIndex < readyIndex);
  assert.match(mainSource, /touchID:\s*\{\s*keychainAccessGroup: SURF_ACE_WEBAUTHN_KEYCHAIN_ACCESS_GROUP/s);
  assert.match(mainSource, /session\.defaultSession\.on\("select-webauthn-account"/);
});

test("mac package entitlements remain launchable without an embedded provisioning profile", async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    build?: { mac?: { entitlements?: string } };
  };
  const mainSource = await fs.readFile(new URL("../../src/main.ts", import.meta.url), "utf8");
  const entitlements = await fs.readFile(new URL("../../build/entitlements.mac.plist", import.meta.url), "utf8");

  assert.equal(packageJson.build?.mac?.entitlements, "build/entitlements.mac.plist");
  assert.ok(mainSource.includes(keychainAccessGroup));
  assert.ok(!entitlements.includes("keychain-access-groups"));
  assert.ok(!entitlements.includes(`<string>${keychainAccessGroup}</string>`));
});
