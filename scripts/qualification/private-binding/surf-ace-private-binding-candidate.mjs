#!/usr/bin/env node
// Pure verifier for an unrun, disposable Surf Ace binding-crash fixture.
// This file neither launches a client nor changes a profile or registry.
import { createHash } from "node:crypto";
import fs from "node:fs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (reason) => { throw new Error(reason); };
const hex64 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function boundedJson(bytes, limit, reason) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > limit) fail(reason);
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail(reason); }
}

function bindingExactly(value, expected) {
  if (!object(value) || !object(expected)) return false;
  const fields = ["allocatorId", "clientId", "fleetId"];
  return same(Object.keys(value).sort(), fields) &&
    fields.every((field) => typeof value[field] === "string" && value[field] === expected[field]);
}

function contentAndClaims(state) {
  if (!object(state) || !Array.isArray(state.surfaces) ||
      !object(state.lockless) || !Array.isArray(state.lockless.tombstones)) fail("candidate_shape_invalid");
  const claims = new Map();
  const contentDigests = [];
  const add = (surface, extraPanes = []) => {
    if (!object(surface) || typeof surface.surfaceId !== "string" ||
        typeof surface.windowLabel !== "string" || surface.windowLabelConfirmed === false ||
        !Array.isArray(surface.panes)) fail("candidate_surface_invalid");
    let claim = claims.get(surface.surfaceId);
    if (claim && claim.windowLabel !== surface.windowLabel) fail("candidate_surface_conflict");
    if (!claim) {
      claim = { surfaceId: surface.surfaceId, windowLabel: surface.windowLabel, panes: [] };
      claims.set(surface.surfaceId, claim);
    }
    for (const pane of [...surface.panes, ...extraPanes]) {
      if (!object(pane) || !Number.isSafeInteger(pane.paneId) || pane.paneId < 1 ||
          !Number.isSafeInteger(pane.paneLabel) || pane.paneLabel < 1 ||
          typeof pane.paneLineageId !== "string" || !object(pane.snapshot) ||
          !Array.isArray(pane.history)) fail("candidate_pane_invalid");
      const paneClaim = {
        paneId: String(pane.paneId), paneLabel: pane.paneLabel,
        paneLineageId: pane.paneLineageId,
      };
      const old = claim.panes.find((entry) => entry.paneId === paneClaim.paneId);
      if (old && !same(old, paneClaim)) fail("candidate_pane_conflict");
      if (!old) claim.panes.push(paneClaim);
      const snapshot = pane.snapshot;
      const fields = ["bounds", "geometryRevision", "selection", "surfaceEpoch", "topologyRevision", "viewport"];
      if (!same(Object.keys(snapshot).sort(), [...fields].sort())) fail("candidate_snapshot_shape_invalid");
      const content = {
        geometryRevision: snapshot.geometryRevision,
        selection: snapshot.selection,
        surfaceEpoch: snapshot.surfaceEpoch,
        topologyRevision: snapshot.topologyRevision,
      };
      contentDigests.push({
        surfaceId: surface.surfaceId, paneId: paneClaim.paneId,
        sha256: sha256(JSON.stringify({ snapshot: content, history: pane.history })),
      });
    }
  };
  for (const surface of state.surfaces) add(surface);
  for (const tombstone of state.lockless.tombstones) {
    if (!object(tombstone) || typeof tombstone.surfaceId !== "string" ||
        !object(tombstone.payload)) fail("candidate_tombstone_invalid");
    if (tombstone.kind === "surface") {
      const nested = tombstone.payload.paneTombstones ?? [];
      if (!Array.isArray(nested)) fail("candidate_tombstone_invalid");
      add(tombstone.payload.surface, nested.map((item) => item?.payload?.pane));
    } else if (tombstone.kind === "pane") {
      const owner = state.surfaces.find((item) => item.surfaceId === tombstone.surfaceId)
        ?? state.lockless.tombstones.find((item) =>
          item.kind === "surface" && item.surfaceId === tombstone.surfaceId)?.payload?.surface;
      if (!owner) fail("candidate_orphan_pane_tombstone");
      add({ ...owner, panes: [] }, [tombstone.payload.pane]);
    } else fail("candidate_tombstone_kind_invalid");
  }
  const confirmedClaims = [...claims.values()]
    .sort((a, b) => a.surfaceId.localeCompare(b.surfaceId))
    .map((claim) => ({ ...claim, panes: claim.panes.sort((a, b) => a.paneId.localeCompare(b.paneId)) }));
  contentDigests.sort((a, b) => `${a.surfaceId}:${a.paneId}`.localeCompare(`${b.surfaceId}:${b.paneId}`));
  return { confirmedClaims, contentDigests };
}

export function verifyBindingCandidate(candidateBytes, pendingBytes, baseline, provisioning) {
  const candidate = boundedJson(candidateBytes, 16 * 1024 * 1024, "candidate_json_invalid");
  const pending = boundedJson(pendingBytes, 4096, "pending_selector_invalid");
  if (!object(pending) || pending.version !== 1 || pending.phase !== "pending" ||
      !hex64(pending.candidateSha256) || !hex64(pending.acceptedSha256)) {
    fail("pending_selector_invalid");
  }
  const candidateSha256 = sha256(candidateBytes);
  if (candidateSha256 !== pending.candidateSha256) fail("candidate_selector_hash_mismatch");
  if (!object(baseline) || !Array.isArray(baseline.confirmedClaims) ||
      !Array.isArray(baseline.contentDigests) || !hex64(baseline.clientId)) fail("baseline_invalid");
  if (!object(provisioning) || !bindingExactly(provisioning.binding,
      { ...provisioning.binding, clientId: baseline.clientId }) ||
      !same(provisioning.confirmedClaims, baseline.confirmedClaims)) fail("provisioning_invalid");
  const protectedState = contentAndClaims(candidate);
  if (!same(protectedState.confirmedClaims, baseline.confirmedClaims) ||
      !same(protectedState.contentDigests, baseline.contentDigests)) fail("candidate_protected_state_changed");
  if (candidate.registryBinding == null) return { bindingBearing: false, candidateSha256 };
  if (!bindingExactly(candidate.registryBinding, provisioning.binding)) fail("candidate_foreign_binding");
  return { bindingBearing: true, candidateSha256 };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    if (process.argv.length !== 6) fail("usage_invalid");
    const [candidate, selector, baseline, provisioning] = process.argv.slice(2);
    const result = verifyBindingCandidate(
      fs.readFileSync(candidate), fs.readFileSync(selector),
      JSON.parse(fs.readFileSync(baseline, "utf8")),
      JSON.parse(fs.readFileSync(provisioning, "utf8")),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`binding_candidate_failed=${error instanceof Error ? error.message : "unknown"}\n`);
    process.exitCode = 1;
  }
}
