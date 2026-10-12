// Proposal-only validators. No socket, authentication provider, collector or client import.
import { evidenceDigest } from '../../scripts/lifecycle/inspect-evidence.mjs';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const processEpoch = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const same = (a, b) => evidenceDigest(a) === evidenceDigest(b);
const identityKeys = ['uid', 'pid', 'birth', 'bootId', 'processEpoch', 'clientId', 'buildSha256'];
const identity = value => exact(value, identityKeys) && integer(value.uid) && value.uid > 0 &&
  integer(value.pid) && value.pid > 0 && ['birth', 'bootId', 'clientId'].every(key => text(value[key])) &&
  processEpoch(value.processEpoch) &&
  hex(value.buildSha256);
const refuse = reason => Object.freeze({ admitted: false, reason, effect: 'none', replayAllowed: false });

export function validateRequest(request, proof) {
  try {
    if (proof?.mode !== 'isolated_fixture') return refuse('no_runtime_provider');
    if (Buffer.byteLength(JSON.stringify(request)) > 8192 ||
        !exact(request, ['version', 'op', 'requestId', 'nonce', 'expectedServer', 'targets', 'survivors', 'priorRequests', 'deadlineMs']) ||
        request.version !== 1 || request.op !== 'lifecycle.inspect' || !text(request.requestId) || !hex(request.nonce) ||
        !identity(request.expectedServer)) return refuse('invalid_request');
    if (!Array.isArray(request.targets) || !request.targets.length || !Array.isArray(request.survivors) ||
        !request.survivors.length || request.targets.length + request.survivors.length > 32 ||
        ![...request.targets, ...request.survivors].every(text) ||
        new Set([...request.targets, ...request.survivors]).size !== request.targets.length + request.survivors.length) {
      return refuse('invalid_scope');
    }
    if (!Array.isArray(request.priorRequests) || request.priorRequests.length > 32 ||
        new Set(request.priorRequests.map(item => item.surfaceId)).size !== request.priorRequests.length ||
        !request.priorRequests.every(item => exact(item, ['surfaceId', 'controllerId', 'requestId']) &&
          [...request.targets, ...request.survivors].includes(item.surfaceId) && text(item.controllerId) && text(item.requestId))) {
      return refuse('invalid_request_selection');
    }
    if (!integer(request.deadlineMs) || request.deadlineMs < 1 || request.deadlineMs > 2000 ||
        !integer(proof.receivedMono) || !integer(proof.nowMono) || proof.nowMono < proof.receivedMono ||
        proof.nowMono - proof.receivedMono >= request.deadlineMs) return refuse('deadline');
    if (!identity(proof.serverBefore) || !same(proof.serverBefore, proof.serverAfter) ||
        !same(request.expectedServer, proof.serverBefore)) return refuse('server_identity_changed');
    const server = request.expectedServer;
    const endpoint = proof.endpoint;
    if (proof.transport !== 'pathname_unix_stream' || !exact(endpoint, ['path', 'ownerUid', 'directoryMode',
      'socketMode', 'capabilityMode', 'noSymlinks', 'ownedDirectory', 'connectedServerVerified']) ||
      endpoint.path !== `/tmp/sa-diag-${server.uid}/${server.processEpoch}/s` ||
      Buffer.byteLength(endpoint.path) > 100 || endpoint.ownerUid !== server.uid ||
      endpoint.directoryMode !== '0700' || endpoint.socketMode !== '0600' || endpoint.capabilityMode !== '0600' ||
      endpoint.noSymlinks !== true || endpoint.ownedDirectory !== true || endpoint.connectedServerVerified !== true) {
      return refuse('endpoint_unproven');
    }
    const peer = proof.peerBefore;
    if (!exact(peer, ['uid', 'pid', 'birth', 'bootId', 'kernelVerified']) || peer.kernelVerified !== true ||
        peer.uid !== server.uid || !integer(peer.pid) || peer.pid < 1 || !text(peer.birth) ||
        peer.bootId !== server.bootId || !same(peer, proof.peerAfter)) return refuse('caller_identity_unproven');
    if (proof.capabilityVerified !== true || proof.capabilityEpoch !== server.processEpoch ||
        proof.nonceFresh !== true) return refuse('capability_or_nonce_unproven');
    if (proof.inFlightCount !== 0 || !integer(proof.recentRequestsForUid) || proof.recentRequestsForUid >= 4) {
      return refuse('capacity');
    }
    return Object.freeze({ admitted: true, effect: 'none', replayAllowed: false,
      requestFingerprint: evidenceDigest(request) });
  } catch { return refuse('malformed'); }
}

const unavailableReasons = new Set(['not_supplied', 'not_retained', 'not_supported', 'not_observable',
  'original_unknown', 'controller_reclaimed', 'registry_unavailable', 'stale', 'non_atomic', 'deadline']);
const boundary = value => exact(value, ['mutationSequence', 'surfaceSetRevision', 'selectorGeneration']) &&
  integer(value.mutationSequence) && integer(value.surfaceSetRevision) && hex(value.selectorGeneration);
const schemas = {
  native: { source: 'owned_window_map', fields: { present: 'boolean', windowCount: 'integer' } },
  core: { source: 'serialized_core', fields: { state: 'state', epoch: 'text', topologyRevision: 'integer',
    surfaceSetRevision: 'integer', retainedFingerprint: 'hex' } },
  accepted: { source: 'selector_accepted_bytes', fields: { state: 'state', epoch: 'text', selectorPhase: 'phase',
    acceptedSha256: 'hex', surfaceSetRevision: 'integer', topologyRevision: 'integer', retainedFingerprint: 'hex' } },
  registry: { source: 'existing_registry_cache', fields: { state: 'registryState', clientId: 'text',
    processEpoch: 'text', surfaceSetRevision: 'integer', acknowledgedSequence: 'integer', receivedMono: 'integer' } },
  request: { source: 'retained_request_receipt', fields: { controllerId: 'text', requestId: 'text',
    originalFingerprint: 'hex', outcome: 'outcome', commitSequence: 'integer', resultFingerprint: 'hex' } },
  tombstone: { source: 'retained_surface_tombstone', fields: { tombstoneId: 'text', epoch: 'text',
    closedSequence: 'integer', postSetRevision: 'integer', retainedFingerprint: 'hex' } },
};
function field(value, type) {
  if (exact(value, ['known', 'reason']) && value.known === false) return unavailableReasons.has(value.reason);
  if (!exact(value, ['known', 'value']) || value.known !== true) return false;
  value = value.value;
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return integer(value);
  if (type === 'text') return text(value);
  if (type === 'hex') return hex(value);
  const values = { state: ['live', 'absent', 'tombstoned'], registryState: ['live', 'absent'],
    phase: ['committed', 'pending'], outcome: ['still_pending', 'not_committed', 'resolved_success', 'resolved_failure'] };
  return values[type]?.includes(value) ?? false;
}
function observation(value, schema, response) {
  if (!value || !integer(value.observedMono) || value.observedMono < response.startedMono ||
      value.observedMono > response.endedMono) return false;
  if (value.status === 'unknown') return exact(value, ['status', 'reason', 'observedMono']) && unavailableReasons.has(value.reason);
  return value.status === 'observed' && exact(value, ['status', 'source', 'observedMono', 'data']) &&
    value.source === schema.source && exact(value.data, Object.keys(schema.fields)) &&
    Object.entries(schema.fields).every(([key, type]) => field(value.data[key], type));
}

/** Checks proposed safe envelope/schema only; not a live evidence authenticity or recovery validator. */
export function validateResponse(response, request, proof) {
  const admission = validateRequest(request, proof);
  if (!admission.admitted) return admission;
  try {
    if (!exact(response, ['version', 'requestId', 'nonce', 'server', 'effect', 'replayAllowed', 'startedMono',
      'endedMono', 'collection', 'surfaces']) || response.version !== 1 || response.requestId !== request.requestId ||
      response.nonce !== request.nonce || !same(response.server, request.expectedServer) ||
      response.effect !== 'none' || response.replayAllowed !== false) return refuse('response_binding_or_effect');
    if (!integer(response.startedMono) || !integer(response.endedMono) ||
        response.startedMono < proof.receivedMono || response.endedMono < response.startedMono ||
        response.endedMono > proof.nowMono ||
        response.endedMono - proof.receivedMono >= request.deadlineMs) return refuse('response_deadline');
    if (!exact(response.collection, ['before', 'after', 'status']) || !boundary(response.collection.before) ||
        !boundary(response.collection.after) || !['stable', 'non_atomic'].includes(response.collection.status) ||
        (response.collection.status === 'stable' && !same(response.collection.before, response.collection.after))) {
      return refuse('collection_claim_unproven');
    }
    const scope = [...request.targets, ...request.survivors].sort();
    if (!Array.isArray(response.surfaces) || response.surfaces.length > 32 ||
        !same(response.surfaces.map(row => row.surfaceId).sort(), scope)) return refuse('response_scope');
    for (const row of response.surfaces) {
      if (!exact(row, ['surfaceId', ...Object.keys(schemas)]) ||
          !Object.entries(schemas).every(([name, schema]) => observation(row[name], schema, response))) {
        return refuse('evidence_schema_or_privacy');
      }
      if (response.collection.status === 'non_atomic' &&
          ['native', 'core', 'accepted', 'request', 'tombstone'].some(name =>
            row[name].status !== 'unknown' || row[name].reason !== 'non_atomic')) {
        return refuse('non_atomic_evidence_claim');
      }
      if (row.native.status === 'observed' && row.native.data.present.known && row.native.data.windowCount.known &&
          row.native.data.present.value !== (row.native.data.windowCount.value > 0)) {
        return refuse('native_contradiction');
      }
      if (row.registry.status === 'observed') {
        const data = row.registry.data;
        if ((data.clientId.known && data.clientId.value !== request.expectedServer.clientId) ||
            (data.processEpoch.known && data.processEpoch.value !== request.expectedServer.processEpoch) ||
            (data.receivedMono.known && (data.receivedMono.value > row.registry.observedMono ||
              row.registry.observedMono - data.receivedMono.value > 1000))) return refuse('registry_provenance_or_age');
      }
      if (row.request.status === 'observed' && row.tombstone.status === 'observed' &&
          row.request.data.outcome.known && row.request.data.outcome.value !== 'resolved_success' &&
          row.tombstone.data.tombstoneId.known) return refuse('request_tombstone_conflict');
      if (row.request.status === 'observed') {
        const selection = request.priorRequests.find(item => item.surfaceId === row.surfaceId);
        if (!selection || (row.request.data.controllerId.known && row.request.data.controllerId.value !== selection.controllerId) ||
            (row.request.data.requestId.known && row.request.data.requestId.value !== selection.requestId)) {
          return refuse('request_selection_unproven');
        }
      }
    }
    if (Buffer.byteLength(JSON.stringify(response)) > 262144) return refuse('response_size');
    return Object.freeze({ admitted: true, effect: 'none', replayAllowed: false,
      collection: response.collection.status, unknownEvidence: response.surfaces.some(row =>
        Object.keys(schemas).some(name => row[name].status === 'unknown' ||
          Object.values(row[name].data).some(value => value.known === false))) });
  } catch { return refuse('malformed'); }
}
