import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyBindingCandidate } from "./surf-ace-private-binding-candidate.mjs";
import { classifyRequest } from "./surf-ace-private-binding-verifier.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const clientId = "a".repeat(64);
const binding = { allocatorId: "alloc_private_owner", clientId, fleetId: "fixture_private_owner" };
const snapshot = {
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  geometryRevision: 2, selection: null, surfaceEpoch: 3,
  topologyRevision: 4, viewport: { width: 100, height: 100 },
};
const pane = {
  paneId: 2, paneLabel: 3, paneLineageId: "pl_fixture_1234", snapshot,
  history: [{ type: "text", value: "preserved" }],
};
const surface = {
  surfaceId: "sf_fixture_1234", windowLabel: "d", windowLabelConfirmed: true,
  panes: [pane],
};
const claims = [{
  surfaceId: surface.surfaceId, windowLabel: "d",
  panes: [{ paneId: "2", paneLabel: 3, paneLineageId: pane.paneLineageId }],
}];
const content = {
  geometryRevision: 2, selection: null, surfaceEpoch: 3, topologyRevision: 4,
};
const baseline = {
  clientId, confirmedClaims: claims,
  contentDigests: [{ surfaceId: surface.surfaceId, paneId: "2",
    sha256: hash(JSON.stringify({ snapshot: content, history: pane.history })) }],
};
const provisioning = { binding, confirmedClaims: claims };
const state = (registryBinding = null) => ({
  registryBinding, surfaces: [structuredClone(surface)], lockless: { tombstones: [] },
});
const bytes = (value) => Buffer.from(JSON.stringify(value));
function verify(value, overrides = {}) {
  const candidate = bytes(value);
  const pending = bytes({ version: 1, phase: "pending",
    acceptedSha256: "b".repeat(64), candidateSha256: hash(candidate) });
  return verifyBindingCandidate(candidate, overrides.pending ?? pending,
    overrides.baseline ?? baseline, overrides.provisioning ?? provisioning);
}

test("binding-free startup cycle passes without a stop claim", () => {
  assert.equal(verify(state()).bindingBearing, false);
});

test("first binding-bearing cycle is recognized without naming its caller", () => {
  assert.equal(verify(state(binding)).bindingBearing, true);
});

test("geometry changes alone preserve the protected digest", () => {
  const candidate = state(binding);
  candidate.surfaces[0].panes[0].snapshot.bounds.width = 200;
  assert.equal(verify(candidate).bindingBearing, true);
});

test("foreign identity and protected content changes fail closed", () => {
  assert.throws(() => verify(state({ ...binding, fleetId: "foreign" })), /candidate_foreign_binding/);
  const changed = state(binding);
  changed.surfaces[0].panes[0].history.push({ type: "text", value: "lost" });
  assert.throws(() => verify(changed), /candidate_protected_state_changed/);
});

test("selector hash mismatch and malformed JSON fail closed", () => {
  assert.throws(() => verify(state(binding), { pending: bytes({
    version: 1, phase: "pending", acceptedSha256: "b".repeat(64),
    candidateSha256: "c".repeat(64),
  }) }), /candidate_selector_hash_mismatch/);
  assert.throws(() => verifyBindingCandidate(Buffer.from("{"), bytes({}), baseline, provisioning),
    /candidate_json_invalid/);
});

test("provisioning must contain the original client and all claims", () => {
  assert.throws(() => verify(state(binding), { provisioning: {
    binding: { ...binding, clientId: "c".repeat(64) }, confirmedClaims: claims,
  } }), /provisioning_invalid/);
  assert.throws(() => verify(state(binding), { provisioning: {
    binding, confirmedClaims: [],
  } }), /provisioning_invalid/);
});

test("sidecar accepts only the exact disposable candidate and selector", () => {
  const fixtureRoot = "/tmp/surf-ace-private-crash-fixture-inputs";
  fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  const home = fs.mkdtempSync(path.join(fixtureRoot, "binding-source-test-"));
  try {
    const userData = path.join(home, "user-data");
    fs.mkdirSync(userData, { mode: 0o700 });
    const candidate = bytes(state(binding));
    const candidateSha256 = hash(candidate);
    const candidatePath = path.join(userData, "surface-core-state.json.1.2.abcdef.tmp");
    fs.writeFileSync(candidatePath, candidate, { mode: 0o600 });
    fs.writeFileSync(path.join(userData, "surface-core-state.json.selector"),
      bytes({ version: 1, phase: "pending", acceptedSha256: "b".repeat(64),
        candidateSha256 }), { mode: 0o600 });
    const options = { userData, baseline, provisioning };
    assert.equal(classifyRequest({ event: "candidate", path: candidatePath,
      pendingSha256: candidateSha256 }, options).bindingBearing, true);
    assert.throws(() => classifyRequest({ event: "candidate", path: "/etc/passwd",
      pendingSha256: candidateSha256 }, options), /candidate_name_invalid/);
    assert.throws(() => classifyRequest({ event: "candidate", path: candidatePath,
      pendingSha256: "c".repeat(64) }, options), /pending_sha_mismatch/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("protected digest and claims match the reviewed baseline helper on one synthetic profile", () => {
  const fixtureRoot = "/tmp/surf-ace-private-crash-fixture-inputs";
  fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  const home = fs.mkdtempSync(path.join(fixtureRoot, "binding-parity-test-"));
  try {
    const userData = path.join(home, "user-data");
    fs.mkdirSync(userData, { mode: 0o700 });
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" });
    const privateKeyPem = keys.privateKey.export({ format: "pem", type: "pkcs8" });
    fs.writeFileSync(path.join(userData, "surface-identity.json"),
      JSON.stringify({ publicKeyPem, privateKeyPem }), { mode: 0o600 });
    const original = bytes(state());
    fs.writeFileSync(path.join(userData, "surface-core-state.json"), original, { mode: 0o600 });
    fs.writeFileSync(path.join(userData, "surface-core-state.json.selector"),
      JSON.stringify({ version: 1, phase: "committed", acceptedSha256: hash(original) }), { mode: 0o600 });
    const helper = fileURLToPath(new URL("./surf-ace-private-foreign-first-claims.mjs", import.meta.url));
    const authoritative = JSON.parse(execFileSync(process.execPath,
      [helper, "inspect", userData], { encoding: "utf8" }));
    const provisioned = { binding: { ...binding, clientId: authoritative.clientId },
      confirmedClaims: authoritative.confirmedClaims };
    const candidate = state(provisioned.binding);
    candidate.surfaces[0].panes[0].snapshot.viewport.width = 250;
    const candidateBytes = bytes(candidate);
    const selectorBytes = bytes({ version: 1, phase: "pending",
      acceptedSha256: hash(original), candidateSha256: hash(candidateBytes) });
    assert.equal(verifyBindingCandidate(candidateBytes, selectorBytes,
      authoritative, provisioned).bindingBearing, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
