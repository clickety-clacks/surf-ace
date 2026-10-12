// Isolated proposal model: deliberately not imported by a client or wire handler.
// All collector claims below are fixture inputs, not proof of a live atomic read.
import { createHash } from 'node:crypto';

export function evidenceDigest(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]));
    }
    return item;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && value.length > 0;
const revision = value => Number.isSafeInteger(value) && value >= 0;
const equal = (a, b) => evidenceDigest(a) === evidenceDigest(b);
const requiredViews = ['native', 'core', 'accepted', 'registry'];

function validBoundary(value) {
  return value && ['clientId', 'processBirth', 'processEpoch', 'build', 'collectionId'].every(key => id(value[key])) &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    revision(value.surfaceSetRevision) && revision(value.mutationSequence);
}

/** Classifies synthetic evidence only. Never authorizes replay or mutation. */
export function inspectEvidence(input, expectation) {
  const refuse = reason => Object.freeze({ status: 'refused', reason, effect: 'none', replayAllowed: false });
  try {
    if (!input || !expectation || input.mode !== 'isolated_fixture') return refuse('non_fixture_input');
    if (!validBoundary(input.before) || !validBoundary(input.after) ||
        !validBoundary(expectation.boundary)) return refuse('missing_boundary');
    if (!equal(input.before, input.after) || !equal(input.before, expectation.boundary)) {
      return refuse('boundary_changed');
    }
    if (!Array.isArray(expectation.targets) || !expectation.targets.length ||
        !Array.isArray(expectation.survivors) || !expectation.survivors.length) return refuse('missing_scope');
    const ids = [...expectation.targets.map(row => row.surfaceId), ...expectation.survivors.map(row => row.surfaceId)];
    if (!ids.every(id) || new Set(ids).size !== ids.length) return refuse('ambiguous_scope');
    if (!revision(input.now) || !Number.isSafeInteger(expectation.maxRegistryAgeMs) ||
        expectation.maxRegistryAgeMs < 0) return refuse('missing_freshness_policy');
    const views = input.views;
    for (const name of requiredViews) {
      const view = views?.[name];
      if (!view || !equal(view.boundary, input.before) || view.complete !== true ||
          !Array.isArray(view.rows)) return refuse('non_atomic_or_incomplete_view');
      if (name === 'native' && view.inventory !== 'owned_window_map') return refuse('native_inventory_unproven');
      if (name === 'registry' && (!revision(view.receivedAt) || view.receivedAt > input.now ||
          input.now - view.receivedAt > expectation.maxRegistryAgeMs)) return refuse('stale_registry');
      if (new Set(view.rows.map(row => row.surfaceId)).size !== view.rows.length ||
          !equal([...view.rows.map(row => row.surfaceId)].sort(), [...ids].sort())) return refuse('scope_mismatch');
      for (const row of view.rows) {
        if (!id(row.surfaceEpoch) || !revision(row.topologyRevision) ||
            !['live', 'absent', 'tombstoned'].includes(row.state)) return refuse('unknown_surface_evidence');
        if (name !== 'native' && !hash(row.historySha256)) return refuse('missing_retained_material');
      }
    }
    const acceptedBytes = views.accepted.fileBytesUtf8;
    if (input.selector?.phase !== 'committed' || !hash(input.selector.acceptedSha256) ||
        typeof acceptedBytes !== 'string' ||
        input.selector.acceptedSha256 !== createHash('sha256').update(acceptedBytes).digest('hex') ||
        !equal(JSON.parse(acceptedBytes).surfaces, views.accepted.rows)) return refuse('unproven_selector');
    const rows = surfaceId => Object.fromEntries(requiredViews.map(name =>
      [name, views[name].rows.find(row => row.surfaceId === surfaceId)]));
    for (const surfaceId of ids) {
      const current = rows(surfaceId);
      if (!requiredViews.every(name => current[name].surfaceEpoch === current.core.surfaceEpoch &&
          current[name].topologyRevision === current.core.topologyRevision)) return refuse('surface_epoch_or_revision_split');
      if (!equal(current.core, current.accepted)) return refuse('core_accepted_split');
      if (!equal(current.registry, current.core)) return refuse('registry_projection_split');
    }
    for (const target of expectation.targets) {
      const current = rows(target.surfaceId).core;
      if (current.surfaceEpoch !== target.surfaceEpoch || current.topologyRevision !== target.topologyRevision) {
        return refuse('target_fence_changed');
      }
    }
    for (const survivor of expectation.survivors) {
      const current = rows(survivor.surfaceId);
      if (current.native.state !== 'live' || current.core.state !== 'live' ||
          !equal(current.core, survivor)) return refuse('survivor_changed');
    }
    const findings = [];
    const successfulCloses = [];
    for (const { surfaceId } of expectation.targets) {
      const current = rows(surfaceId);
      const request = input.requests?.[surfaceId];
      const original = request?.original;
      if (!original || !['requestId', 'controllerInstanceId', 'clientId', 'build', 'surfaceId', 'surfaceEpoch', 'processEpoch'].every(key => id(original[key])) ||
          !hash(original.payloadSha256) || !revision(original.surfaceSetRevision) ||
          !revision(original.topologyRevision)) return refuse('original_request_unknown');
      if (original.surfaceId !== surfaceId || original.surfaceEpoch !== current.core.surfaceEpoch ||
          original.clientId !== input.before.clientId || original.build !== input.before.build ||
          original.processEpoch !== input.before.processEpoch ||
          original.surfaceSetRevision > input.before.surfaceSetRevision ||
          original.topologyRevision > current.core.topologyRevision) return refuse('request_identity_or_revision_mismatch');
      if (original.operation !== 'surface.window.close' || !original.payload ||
          original.payloadSha256 !== evidenceDigest(original.payload) ||
          original.payload.surfaceId !== original.surfaceId ||
          original.payload.surfaceSetRevision !== original.surfaceSetRevision ||
          original.payload.topologyRevision !== original.topologyRevision) return refuse('original_payload_unproven');
      if (!['not_committed', 'still_pending', 'resolved_success', 'resolved_failure'].includes(request.outcome)) {
        return refuse('request_outcome_unknown');
      }
      if (['not_committed', 'still_pending'].includes(request.outcome) &&
          (request.receipt != null || request.tombstone != null || request.duplicateReceipts?.length)) {
        return refuse('request_outcome_evidence_conflict');
      }
      if (request.outcome === 'resolved_failure' && request.tombstone != null) {
        return refuse('request_outcome_evidence_conflict');
      }
      if (request.outcome.startsWith('resolved_')) {
        const receipt = request.receipt;
        if (!receipt || receipt.requestId !== original.requestId ||
            receipt.originalSha256 !== evidenceDigest(original) || !revision(receipt.commitSequence) ||
            receipt.commitSequence > input.before.mutationSequence ||
            !hash(receipt.terminalResponseSha256)) return refuse('uncorrelated_receipt');
        if (request.duplicateReceipts && !request.duplicateReceipts.every(other => equal(other, receipt))) {
          return refuse('duplicate_receipt_conflict');
        }
      }
      if (request.outcome === 'resolved_success') {
        const tombstone = request.tombstone;
        if (!tombstone) return refuse('close_commit_unproven');
        const postRevision = request.receipt.surfaceSetRevision;
        if (!revision(postRevision) || postRevision !== original.surfaceSetRevision + 1 ||
            postRevision > input.before.surfaceSetRevision ||
            tombstone?.surfaceSetRevision !== postRevision) return refuse('close_revision_unproven');
        if (current.native.state !== 'absent' || current.core.state !== 'tombstoned' ||
            !tombstone || tombstone.surfaceId !== surfaceId || tombstone.surfaceEpoch !== original.surfaceEpoch ||
            tombstone.requestId !== original.requestId || !id(tombstone.tombstoneId) ||
            tombstone.commitSequence !== request.receipt.commitSequence ||
            tombstone.historySha256 !== current.core.historySha256) return refuse('close_commit_unproven');
        findings.push({ surfaceId, state: 'closed_restorable', receipt: structuredClone(request.receipt),
          tombstoneId: tombstone.tombstoneId });
        successfulCloses.push({ commitSequence: request.receipt.commitSequence, postRevision });
      } else if (request.outcome === 'still_pending' && current.core.state === 'live' && current.native.state === 'live') {
        findings.push({ surfaceId, state: 'pending_intent' });
      } else if (current.core.state === 'live' && current.native.state === 'live') {
        findings.push({ surfaceId, state: 'live' });
      } else {
        // Even exhaustive native absence is a conflict to inspect, not permission to delete.
        findings.push({ surfaceId, state: 'conflicting', productDecisionRequired: true });
      }
    }
    successfulCloses.sort((a, b) => a.commitSequence - b.commitSequence);
    for (let i = 1; i < successfulCloses.length; i++) {
      if (successfulCloses[i].commitSequence <= successfulCloses[i - 1].commitSequence ||
          successfulCloses[i].postRevision <= successfulCloses[i - 1].postRevision) {
        return refuse('close_revision_sequence_conflict');
      }
    }
    return Object.freeze({ status: 'inspection_complete', effect: 'none', replayAllowed: false,
      boundary: structuredClone(input.before), findings,
      survivorsSha256: evidenceDigest(expectation.survivors) });
  } catch {
    return refuse('malformed_or_missing_evidence');
  }
}
