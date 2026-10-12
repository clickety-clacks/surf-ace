import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { evidenceDigest, inspectEvidence } from './inspect-evidence.mjs';

function fixture() {
  const boundary = { clientId: 'client-A', pid: 123, processBirth: 'birth-A', processEpoch: 'process-A',
    build: 'fixture-build', collectionId: 'collection-A', surfaceSetRevision: 11, mutationSequence: 50 };
  const row = surfaceId => ({ surfaceId, surfaceEpoch: `epoch-${surfaceId}`, topologyRevision: 3,
    state: 'live', historySha256: evidenceDigest({ surfaceId, panes: [1, 2], back: ['old'], visible: 'now',
      annotations: ['retained'], session: 'existing' }) });
  const rows = ['ad', 'ae', 'af', 'p', 'z', 'aa'].map(row);
  const views = Object.fromEntries(['native', 'core', 'accepted', 'registry'].map(name => [name, {
    boundary: structuredClone(boundary), complete: true, rows: structuredClone(rows),
    ...(name === 'native' ? { inventory: 'owned_window_map' } : {}),
    ...(name === 'registry' ? { receivedAt: 990 } : {}),
  }]));
  const requests = Object.fromEntries(['ad', 'ae', 'af'].map(surfaceId => [surfaceId, {
    original: { requestId: `request-${surfaceId}`, controllerInstanceId: 'controller-A',
      clientId: boundary.clientId, build: boundary.build, surfaceId, surfaceEpoch: `epoch-${surfaceId}`,
      processEpoch: boundary.processEpoch, surfaceSetRevision: 11, topologyRevision: 3,
      operation: 'surface.window.close', payload: { surfaceId, surfaceSetRevision: 11, topologyRevision: 3 },
      payloadSha256: evidenceDigest({ surfaceId, surfaceSetRevision: 11, topologyRevision: 3 }) }, outcome: 'not_committed',
  }]));
  const input = { mode: 'isolated_fixture', before: structuredClone(boundary), after: structuredClone(boundary),
    now: 1000, views, requests, selector: { phase: 'committed', acceptedSha256: evidenceDigest(views.accepted.rows) } };
  const expectation = { boundary, targets: rows.slice(0, 3).map(({ surfaceId, surfaceEpoch, topologyRevision }) =>
    ({ surfaceId, surfaceEpoch, topologyRevision })), survivors: rows.slice(3), maxRegistryAgeMs: 20 };
  const f = { input, expectation }; seal(f); return f;
}
function inspect(f) { return inspectEvidence(f.input, f.expectation); }
function seal(f) {
  f.input.views.accepted.fileBytesUtf8 = JSON.stringify({ version: 1, surfaces: f.input.views.accepted.rows });
  f.input.selector.acceptedSha256 = createHash('sha256').update(f.input.views.accepted.fileBytesUtf8).digest('hex');
}
function closeEvidence(f) {
  // Three distinct serialized closes consume revisions11,12,13 and produce12,13,14.
  for (const boundary of [f.input.before, f.input.after, f.expectation.boundary,
    ...Object.values(f.input.views).map(view => view.boundary)]) boundary.surfaceSetRevision = 14;
  for (const [index, id] of ['ad', 'ae', 'af'].entries()) {
    for (const name of ['core', 'accepted', 'registry']) {
      f.input.views[name].rows.find(row => row.surfaceId === id).state = 'tombstoned';
    }
    f.input.views.native.rows.find(row => row.surfaceId === id).state = 'absent';
    const request = f.input.requests[id];
    request.original.surfaceSetRevision = 11 + index;
    request.original.payload.surfaceSetRevision = 11 + index;
    request.original.payloadSha256 = evidenceDigest(request.original.payload);
    request.outcome = 'resolved_success';
    request.receipt = { requestId: request.original.requestId, commitSequence: 48 + index, surfaceSetRevision: 12 + index,
      originalSha256: evidenceDigest(request.original), terminalResponseSha256: evidenceDigest({ result: 'closed', id }) };
    request.tombstone = { surfaceId: id, surfaceEpoch: `epoch-${id}`, requestId: request.original.requestId,
      tombstoneId: `tombstone-${id}`, commitSequence: 48 + index, surfaceSetRevision: 12 + index,
      historySha256: f.input.views.core.rows.find(row => row.surfaceId === id).historySha256 };
  }
  seal(f);
}

test('complete live inspection has no executable recovery or replay capability', () => {
  const f = fixture(); const before = structuredClone(f);
  const result = inspect(f);
  assert.equal(result.status, 'inspection_complete');
  assert.deepEqual(result.findings.map(x => x.state), ['live', 'live', 'live']);
  assert.equal(result.effect, 'none'); assert.equal(result.replayAllowed, false);
  assert.deepEqual(f, before);
});

test('incident-shaped accessible-window inventory and missing original request cannot justify deletion', () => {
  const f = fixture(); f.input.views.native.inventory = 'accessible_window_inventory';
  for (const row of f.input.views.native.rows.slice(0, 3)) row.state = 'absent';
  f.input.requests = {};
  assert.equal(inspect(f).reason, 'native_inventory_unproven');
  f.input.views.native.inventory = 'owned_window_map';
  assert.equal(inspect(f).reason, 'original_request_unknown');
});

test('exhaustive absent native window remains a conflict, not a close authorization', () => {
  const f = fixture(); f.input.views.native.rows[0].state = 'absent';
  const result = inspect(f);
  assert.equal(result.findings[0].state, 'conflicting');
  assert.equal(result.findings[0].productDecisionRequired, true);
  assert.equal(result.effect, 'none'); assert.equal(result.replayAllowed, false);
});

const negatives = [
  ['stale registry', f => { f.input.views.registry.receivedAt = 900; }, 'stale_registry'],
  ['future registry clock', f => { f.input.views.registry.receivedAt = 1001; }, 'stale_registry'],
  ['registry-only absence', f => { f.input.views.registry.rows[0].state = 'absent'; }, 'registry_projection_split'],
  ['split core and accepted material', f => { f.input.views.core.rows[0].historySha256 = evidenceDigest('changed'); }, 'core_accepted_split'],
  ['selector pending', f => { f.input.selector.phase = 'pending'; }, 'unproven_selector'],
  ['selector digest mismatch', f => { f.input.selector.acceptedSha256 = evidenceDigest('other-generation'); }, 'unproven_selector'],
  ['restart same PID', f => { f.input.after.processBirth = 'different-birth'; }, 'boundary_changed'],
  ['process epoch changed', f => { f.input.views.native.boundary.processEpoch = 'new'; }, 'non_atomic_or_incomplete_view'],
  ['collection interleaving', f => { f.input.after.mutationSequence++; }, 'boundary_changed'],
  ['stale requested set revision', f => { f.expectation.boundary.surfaceSetRevision--; }, 'boundary_changed'],
  ['target topology changed', f => { f.expectation.targets[0].topologyRevision--; }, 'target_fence_changed'],
  ['surface reincarnation', f => { f.input.views.native.rows[0].surfaceEpoch = 'reused-id-new-epoch'; }, 'surface_epoch_or_revision_split'],
  ['unknown native evidence', f => { f.input.views.native.rows[0].state = 'unknown'; }, 'unknown_surface_evidence'],
  ['missing core rows', f => { f.input.views.core.rows.pop(); }, 'scope_mismatch'],
  ['duplicate surface identity', f => { f.input.views.core.rows.push(f.input.views.core.rows[0]); }, 'scope_mismatch'],
  ['non-atomic collector', f => { f.input.views.accepted.complete = false; }, 'non_atomic_or_incomplete_view'],
  ['unknown request outcome', f => { f.input.requests.ad.outcome = 'unknown'; }, 'request_outcome_unknown'],
  ['reclaimed request receipt', f => { f.input.requests.ad.outcome = 'receipt_unavailable'; }, 'request_outcome_unknown'],
  ['foreign controller request correlation', f => { f.input.requests.ad.original.clientId = 'foreign'; }, 'request_identity_or_revision_mismatch'],
  ['original payload missing', f => { delete f.input.requests.ad.original.payload; }, 'original_payload_unproven'],
  ['original payload changed', f => { f.input.requests.ad.original.payload.surfaceId = 'p'; }, 'original_payload_unproven'],
  ['selector bytes changed', f => { f.input.views.accepted.fileBytesUtf8 += ' '; }, 'unproven_selector'],
  ['unbound runtime input', f => { f.input.mode = 'live'; }, 'non_fixture_input'],
];
for (const [name, change, reason] of negatives) test(name, () => {
  const f = fixture(); change(f); const before = structuredClone(f);
  const result = inspect(f); assert.equal(result.status, 'refused'); assert.equal(result.reason, reason);
  assert.equal(result.effect, 'none'); assert.equal(result.replayAllowed, false); assert.deepEqual(f, before);
});

test('lost reply resolves only to a read-only correlated durable receipt and restorable tombstone', () => {
  const f = fixture(); closeEvidence(f); const before = structuredClone(f);
  // No transport reply input is needed; this does not reconstruct an absent request.
  const result = inspect(f);
  assert.equal(result.status, 'inspection_complete');
  assert.deepEqual(result.findings.map(x => x.state), ['closed_restorable', 'closed_restorable', 'closed_restorable']);
  assert.equal(result.survivorsSha256, evidenceDigest(f.expectation.survivors));
  assert.deepEqual(f, before);
  assert.equal(result.replayAllowed, false);
});

test('duplicate durable receipts are read-only idempotent; conflicting duplicates refuse', () => {
  const f = fixture(); closeEvidence(f);
  f.input.requests.ad.duplicateReceipts = [structuredClone(f.input.requests.ad.receipt)];
  assert.deepEqual(inspect(f), inspect(f));
  f.input.requests.ad.duplicateReceipts[0].terminalResponseSha256 = evidenceDigest('different-result');
  assert.equal(inspect(f).reason, 'duplicate_receipt_conflict');
});

test('success without correlated retained tombstone or with history loss refuses', () => {
  const f = fixture(); closeEvidence(f);
  f.input.requests.ad.tombstone.historySha256 = evidenceDigest('lost-history');
  assert.equal(inspect(f).reason, 'close_commit_unproven');
  delete f.input.requests.ad.tombstone;
  assert.equal(inspect(f).reason, 'close_commit_unproven');
});

test('foreign or future durable receipt cannot settle an original request', () => {
  const f = fixture(); closeEvidence(f);
  f.input.requests.ad.receipt.requestId = 'other-request';
  assert.equal(inspect(f).reason, 'uncorrelated_receipt');
  f.input.requests.ad.receipt.requestId = f.input.requests.ad.original.requestId;
  f.input.requests.ad.receipt.commitSequence = 51;
  assert.equal(inspect(f).reason, 'uncorrelated_receipt');
});

test('pending close intent is distinct from success and still cannot replay', () => {
  const f = fixture(); f.input.requests.ad.outcome = 'still_pending';
  const result = inspect(f); assert.equal(result.findings[0].state, 'pending_intent');
  assert.equal(result.replayAllowed, false);
});

test('pending native absence is a conflict, never ordinary pending intent', () => {
  const f = fixture(); f.input.requests.ad.outcome = 'still_pending';
  f.input.views.native.rows[0].state = 'absent';
  const result = inspect(f);
  assert.equal(result.findings[0].state, 'conflicting');
  assert.equal(result.findings[0].productDecisionRequired, true);
  assert.equal(result.replayAllowed, false);
});

for (const outcome of ['not_committed', 'still_pending']) {
  for (const evidence of ['receipt', 'tombstone', 'duplicateReceipts']) {
    test(`${outcome} with unexpected ${evidence} refuses contradictory evidence`, () => {
      const f = fixture(); const closed = fixture(); closeEvidence(closed);
      f.input.requests.ad.outcome = outcome;
      f.input.requests.ad[evidence] = evidence === 'duplicateReceipts'
        ? [closed.input.requests.ad.receipt] : closed.input.requests.ad[evidence];
      assert.equal(inspect(f).reason, 'request_outcome_evidence_conflict');
    });
  }
}

test('success must advance its original set revision exactly once and correlate tombstone', () => {
  for (const delta of [0, 2]) {
    const f = fixture(); closeEvidence(f);
    f.input.requests.ad.receipt.surfaceSetRevision = 11 + delta;
    f.input.requests.ad.tombstone.surfaceSetRevision = 11 + delta;
    assert.equal(inspect(f).reason, 'close_revision_unproven');
  }
  const f = fixture(); closeEvidence(f);
  f.input.requests.ad.tombstone.surfaceSetRevision++;
  assert.equal(inspect(f).reason, 'close_revision_unproven');
});

test('multiple successful closes cannot consume the same expected revision', () => {
  const f = fixture(); closeEvidence(f);
  const request = f.input.requests.ae;
  request.original.surfaceSetRevision = request.original.payload.surfaceSetRevision = 11;
  request.original.payloadSha256 = evidenceDigest(request.original.payload);
  request.receipt.originalSha256 = evidenceDigest(request.original);
  request.receipt.surfaceSetRevision = request.tombstone.surfaceSetRevision = 12;
  assert.equal(inspect(f).reason, 'close_revision_sequence_conflict');
});

test('collected set revision cannot predate a proven successful close', () => {
  const f = fixture(); closeEvidence(f);
  for (const boundary of [f.input.before, f.input.after, f.expectation.boundary,
    ...Object.values(f.input.views).map(view => view.boundary)]) boundary.surfaceSetRevision = 11;
  assert.equal(inspect(f).reason, 'close_revision_unproven');
});

test('successful revision ordering follows distinct commit sequence, not target iteration order', () => {
  const f = fixture(); closeEvidence(f); f.expectation.targets.reverse();
  assert.equal(inspect(f).status, 'inspection_complete');
  f.input.requests.ae.receipt.commitSequence = f.input.requests.ae.tombstone.commitSequence = 48;
  assert.equal(inspect(f).reason, 'close_revision_sequence_conflict');
});

for (const surfaceId of ['p', 'z', 'aa']) test(`survivor ${surfaceId} history/session fingerprint change refuses`, () => {
  const f = fixture(); closeEvidence(f);
  for (const name of ['core', 'accepted', 'registry']) {
    f.input.views[name].rows.find(row => row.surfaceId === surfaceId).historySha256 = evidenceDigest('altered-history-session');
  }
  seal(f); assert.equal(inspect(f).reason, 'survivor_changed');
});

test('malformed and incomplete inputs refuse without exposing recovery effects', () => {
  for (const value of [null, {}, { mode: 'isolated_fixture' }]) {
    const result = inspectEvidence(value, {});
    assert.equal(result.status, 'refused'); assert.equal(result.effect, 'none');
  }
});
