import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRequest, validateResponse } from './validate.mjs';
const hex = 'a'.repeat(64);
const known = value => ({ known: true, value });
const unknown = reason => ({ known: false, reason });
function fixture() {
  const server = { uid: 501, pid: 123, birth: 'server-birth', bootId: 'boot-A',
    processEpoch: 'e'.repeat(32), clientId: 'client-A', buildSha256: hex };
  const request = { version: 1, op: 'lifecycle.inspect', requestId: 'inspection-A', nonce: hex,
    expectedServer: server, targets: ['ad', 'ae', 'af'], survivors: ['p', 'z', 'aa'], priorRequests: [], deadlineMs: 2000 };
  const peer = { uid: 501, pid: 999, birth: 'caller-birth', bootId: 'boot-A', kernelVerified: true };
  const proof = { mode: 'isolated_fixture', serverBefore: structuredClone(server), serverAfter: structuredClone(server),
    transport: 'pathname_unix_stream', endpoint: { path: `/tmp/sa-diag-501/${server.processEpoch}/s`, ownerUid: 501,
      directoryMode: '0700', socketMode: '0600', capabilityMode: '0600', noSymlinks: true,
      ownedDirectory: true, connectedServerVerified: true },
    peerBefore: structuredClone(peer), peerAfter: structuredClone(peer), capabilityVerified: true,
    capabilityEpoch: server.processEpoch, nonceFresh: true, receivedMono: 1000, nowMono: 1080,
    inFlightCount: 0, recentRequestsForUid: 0 };
  const boundary = { mutationSequence: 50, surfaceSetRevision: 11, selectorGeneration: hex };
  const response = { version: 1, requestId: request.requestId, nonce: request.nonce, server: structuredClone(server),
    effect: 'none', replayAllowed: false, startedMono: 1000, endedMono: 1070,
    collection: { before: structuredClone(boundary), after: structuredClone(boundary), status: 'stable' },
    surfaces: [...request.targets, ...request.survivors].map(surfaceId => ({ surfaceId,
      native: { status: 'observed', source: 'owned_window_map', observedMono: 1020,
        data: { present: known(true), windowCount: known(1) } },
      core: { status: 'observed', source: 'serialized_core', observedMono: 1020, data: {
        state: known('live'), epoch: known(`epoch-${surfaceId}`), topologyRevision: known(3),
        surfaceSetRevision: known(11), retainedFingerprint: known(hex) } },
      accepted: { status: 'observed', source: 'selector_accepted_bytes', observedMono: 1040, data: {
        state: known('live'), epoch: unknown('not_retained'), selectorPhase: known('committed'), acceptedSha256: known(hex),
        surfaceSetRevision: known(11), topologyRevision: known(3), retainedFingerprint: known(hex) } },
      registry: { status: 'unknown', reason: 'registry_unavailable', observedMono: 1020 },
      request: { status: 'unknown', reason: 'original_unknown', observedMono: 1020 },
      tombstone: { status: 'unknown', reason: 'not_retained', observedMono: 1020 },
    })) };
  return { request, proof, response };
}
function result(f) { return validateResponse(f.response, f.request, f.proof); }

test('valid process-bound fixture admits only safe read-only schema and preserves inputs', () => {
  const f = fixture(); const original = structuredClone(f);
  assert.equal(validateRequest(f.request, f.proof).admitted, true);
  assert.deepEqual(result(f), { admitted: true, effect: 'none', replayAllowed: false,
    collection: 'stable', unknownEvidence: true });
  assert.deepEqual(f, original);
});

const requestNegatives = [
  ['different UID', f => { f.proof.peerBefore.uid = f.proof.peerAfter.uid = 502; }, 'caller_identity_unproven'],
  ['caller PID reuse', f => { f.proof.peerAfter.birth = 'new-birth'; }, 'caller_identity_unproven'],
  ['server PID reuse', f => { f.proof.serverAfter.birth = 'new-birth'; }, 'server_identity_changed'],
  ['server executable/build changed', f => { f.proof.serverAfter.buildSha256 = 'b'.repeat(64); }, 'server_identity_changed'],
  ['unverified caller credentials', f => { f.proof.peerBefore.kernelVerified = false; }, 'caller_identity_unproven'],
  ['forged body caller identity', f => { f.request.uid = 501; }, 'invalid_request'],
  ['TCP or remote transport', f => { f.proof.transport = 'tcp'; }, 'endpoint_unproven'],
  ['abstract Unix endpoint', f => { f.proof.transport = 'abstract_unix'; }, 'endpoint_unproven'],
  ['symlink endpoint path', f => { f.proof.endpoint.noSymlinks = false; }, 'endpoint_unproven'],
  ['unowned parent directory', f => { f.proof.endpoint.ownedDirectory = false; }, 'endpoint_unproven'],
  ['wide socket permissions', f => { f.proof.endpoint.socketMode = '0666'; }, 'endpoint_unproven'],
  ['wide capability permissions', f => { f.proof.endpoint.capabilityMode = '0644'; }, 'endpoint_unproven'],
  ['connected server not verified', f => { f.proof.endpoint.connectedServerVerified = false; }, 'endpoint_unproven'],
  ['foreign capability epoch', f => { f.proof.capabilityEpoch = 'other'; }, 'capability_or_nonce_unproven'],
  ['missing capability verification', f => { f.proof.capabilityVerified = false; }, 'capability_or_nonce_unproven'],
  ['replayed nonce', f => { f.proof.nonceFresh = false; }, 'capability_or_nonce_unproven'],
  ['deadline expiration', f => { f.proof.nowMono = 3000; }, 'deadline'],
  ['excessive deadline', f => { f.request.deadlineMs = 2001; }, 'deadline'],
  ['overlapping survivor scope', f => { f.request.survivors.push('ad'); }, 'invalid_scope'],
  ['empty survivor scope', f => { f.request.survivors = []; }, 'invalid_scope'],
  ['too many targets', f => { f.request.targets = Array.from({ length: 33 }, (_, i) => `surface-${i}`); }, 'invalid_scope'],
  ['path traversal surface ID', f => { f.request.targets[0] = '../state'; }, 'invalid_scope'],
  ['mutation op', f => { f.request.op = 'surface.window.close'; }, 'invalid_request'],
  ['pairing op', f => { f.request.op = 'pair.request'; }, 'invalid_request'],
  ['production-mode use', f => { f.proof.mode = 'live'; }, 'no_runtime_provider'],
  ['parallel collector capacity', f => { f.proof.inFlightCount = 1; }, 'capacity'],
  ['rate capacity', f => { f.proof.recentRequestsForUid = 4; }, 'capacity'],
  ['foreign request lookup', f => { f.request.priorRequests = [{ surfaceId: 'outside', controllerId: 'c', requestId: 'r' }]; }, 'invalid_request_selection'],
  ['duplicate request lookup for a surface', f => { f.request.priorRequests = [1, 2].map(() => ({ surfaceId: 'ad', controllerId: 'c', requestId: 'r' })); }, 'invalid_request_selection'],
];
for (const [name, change, reason] of requestNegatives) test(name, () => {
  const f = fixture(); change(f);
  const r = validateRequest(f.request, f.proof);
  assert.equal(r.admitted, false); assert.equal(r.reason, reason);
  assert.equal(r.effect, 'none'); assert.equal(r.replayAllowed, false);
});

const responseNegatives = [
  ['response nonce mismatch', f => { f.response.nonce = 'b'.repeat(64); }, 'response_binding_or_effect'],
  ['response process mismatch', f => { f.response.server.pid++; }, 'response_binding_or_effect'],
  ['response claims mutation', f => { f.response.effect = 'close'; }, 'response_binding_or_effect'],
  ['response authorizes replay', f => { f.response.replayAllowed = true; }, 'response_binding_or_effect'],
  ['hidden collection interleaving', f => { f.response.collection.after.mutationSequence++; }, 'collection_claim_unproven'],
  ['future collection time', f => { f.response.endedMono = 1090; }, 'response_deadline'],
  ['omitted survivor evidence', f => { f.response.surfaces.pop(); }, 'response_scope'],
  ['duplicate target evidence', f => { f.response.surfaces[1] = structuredClone(f.response.surfaces[0]); }, 'response_scope'],
  ['raw annotation payload', f => { f.response.surfaces[0].core.data.strokes = 'private'; }, 'evidence_schema_or_privacy'],
  ['secret in response', f => { f.response.capability = 'secret'; }, 'response_binding_or_effect'],
  ['URL/content leakage', f => { f.response.surfaces[0].url = 'https://private.invalid'; }, 'evidence_schema_or_privacy'],
  ['accessible inventory falsely asserted exhaustive', f => { f.response.surfaces[0].native.source = 'accessible_windows'; }, 'evidence_schema_or_privacy'],
  ['unknown disguised as known value', f => { f.response.surfaces[0].accepted.data.epoch = { known: true }; }, 'evidence_schema_or_privacy'],
  ['invented missing original envelope', f => { f.response.surfaces[0].request.requestId = 'guessed'; }, 'evidence_schema_or_privacy'],
  ['native map contradiction', f => { f.response.surfaces[0].native.data.present = known(false); }, 'native_contradiction'],
];
for (const [name, change, reason] of responseNegatives) test(name, () => {
  const f = fixture(); change(f); const r = result(f);
  assert.equal(r.admitted, false); assert.equal(r.reason, reason);
});

function observedRegistry(f) {
  f.response.surfaces[0].registry = { status: 'observed', source: 'existing_registry_cache', observedMono: 1020,
    data: { state: known('live'), clientId: known('client-A'), processEpoch: known(f.request.expectedServer.processEpoch),
      surfaceSetRevision: known(11), acknowledgedSequence: known(50), receivedMono: known(1000) } };
}
test('known registry observations need causal identity and bounded freshness', () => {
  const f = fixture(); observedRegistry(f); assert.equal(result(f).admitted, true);
  f.response.surfaces[0].registry.data.processEpoch = known('foreign-process');
  assert.equal(result(f).reason, 'registry_provenance_or_age');
  observedRegistry(f); f.response.surfaces[0].registry.data.receivedMono = known(0);
  assert.equal(result(f).reason, 'registry_provenance_or_age');
});
test('missing causal registry epoch stays explicitly unknown without a guessed stamp', () => {
  const f = fixture(); observedRegistry(f);
  f.response.surfaces[0].registry.data.processEpoch = unknown('not_supported');
  const r = result(f); assert.equal(r.admitted, true); assert.equal(r.unknownEvidence, true);
  assert.equal(r.replayAllowed, false);
});
test('honest non-atomic response remains diagnostic only', () => {
  const f = fixture(); f.response.collection.after.mutationSequence++; f.response.collection.status = 'non_atomic';
  assert.equal(result(f).reason, 'non_atomic_evidence_claim');
  for (const row of f.response.surfaces) {
    for (const name of ['native', 'core', 'accepted', 'request', 'tombstone']) {
      row[name] = { status: 'unknown', reason: 'non_atomic', observedMono: 1050 };
    }
  }
  assert.equal(result(f).collection, 'non_atomic'); assert.equal(result(f).effect, 'none');
});
test('schema validation does not authorize application evidence or reconciliation', () => {
  const f = fixture(); f.response.surfaces[0].native.data = { present: known(false), windowCount: known(0) };
  const r = result(f); assert.equal(r.admitted, true); assert.equal(r.unknownEvidence, true);
  assert.equal(r.effect, 'none'); assert.equal(r.replayAllowed, false);
});

test('original request lookup is explicit; absence never triggers inferred enumeration', () => {
  const f = fixture();
  f.response.surfaces[0].request = { status: 'observed', source: 'retained_request_receipt', observedMono: 1020,
    data: { controllerId: known('controller-A'), requestId: known('prior-A'), originalFingerprint: unknown('not_retained'),
      outcome: known('still_pending'), commitSequence: unknown('not_retained'), resultFingerprint: unknown('not_retained') } };
  assert.equal(result(f).reason, 'request_selection_unproven');
  f.request.priorRequests = [{ surfaceId: 'ad', controllerId: 'controller-A', requestId: 'prior-A' }];
  assert.equal(result(f).admitted, true); assert.equal(result(f).unknownEvidence, true);
  f.response.surfaces[0].request.data.requestId = known('other');
  assert.equal(result(f).reason, 'request_selection_unproven');
});
