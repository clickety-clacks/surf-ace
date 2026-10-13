#!/usr/bin/env node
// Source for a private qualification vehicle only. Do not run against an
// installed profile or a serving allocator. No network access is performed.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(code); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactly = (value, fields) => object(value) && fields.every((field) => Object.hasOwn(value, field));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hex64 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const windowLabel = (value) => typeof value === "string" && /^[a-z]+$/.test(value);
const paneId = (value) => Number.isSafeInteger(value) && value > 0;
const lineage = (value) => typeof value === "string" && /^pl_[A-Za-z0-9._:-]{3,128}$/.test(value);
const surfaceId = (value) => typeof value === "string" && /^sf_[A-Za-z0-9._:-]{3,64}$/.test(value);
const sortClaims = (claims) => claims.sort((a, b) => a.surfaceId.localeCompare(b.surfaceId))
  .map((claim) => ({ ...claim, panes: claim.panes.sort((a, b) => a.paneId.localeCompare(b.paneId)) }));
const snapshotFields = ["bounds", "geometryRevision", "selection", "surfaceEpoch", "topologyRevision", "viewport"];

function partitionSnapshot(snapshot) {
  if (!object(snapshot) ||
      JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify([...snapshotFields].sort())) {
    fail("snapshot_shape_invalid");
  }
  return {
    content: { geometryRevision: snapshot.geometryRevision, selection: snapshot.selection,
      surfaceEpoch: snapshot.surfaceEpoch, topologyRevision: snapshot.topologyRevision },
    displayGeometry: { bounds: snapshot.bounds, viewport: snapshot.viewport },
  };
}

function assertDisposableUserData(dir) {
  const real = fs.realpathSync(dir);
  const parent = path.dirname(real);
  if (parent !== "/tmp/surf-ace-private-crash-fixture-inputs" &&
      path.dirname(parent) !== "/tmp/surf-ace-private-crash-fixture-inputs") fail("user_data_not_disposable");
  if (path.basename(real) !== "user-data") fail("user_data_name_invalid");
  const stat = fs.lstatSync(real);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail("user_data_permissions_invalid");
  return real;
}

function profile(dir, allowBound = false) {
  const userData = assertDisposableUserData(dir);
  const identityFile = path.join(userData, "surface-identity.json");
  const stateFile = path.join(userData, "surface-core-state.json");
  const selectorFile = `${stateFile}.selector`;
  for (const file of [identityFile, stateFile, selectorFile]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("profile_file_invalid");
  }
  const identity = readJson(identityFile);
  if (!exactly(identity, ["publicKeyPem", "privateKeyPem"])) fail("identity_shape_invalid");
  const publicDer = createPublicKey(identity.publicKeyPem).export({ format: "der", type: "spki" });
  const privatePublicDer = createPublicKey(createPrivateKey(identity.privateKeyPem))
    .export({ format: "der", type: "spki" });
  if (!publicDer.equals(privatePublicDer)) fail("identity_key_mismatch");
  const clientId = hash(publicDer);
  const selector = readJson(selectorFile);
  const stateBytes = fs.readFileSync(stateFile);
  if (selector.version !== 1 || selector.phase !== "committed" ||
      !hex64(selector.acceptedSha256) || selector.acceptedSha256 !== hash(stateBytes)) {
    fail("accepted_primary_invalid");
  }
  const state = JSON.parse(stateBytes.toString("utf8"));
  if (!Array.isArray(state.surfaces) || !object(state.lockless) ||
      !Array.isArray(state.lockless.tombstones) || (!allowBound && state.registryBinding != null)) {
    fail("profile_state_invalid_or_already_bound");
  }
  const claims = new Map();
  const contentDigests = [];
  const displayGeometryDigests = [];
  const add = (record, tombstonePanes = []) => {
    if (!object(record) || !surfaceId(record.surfaceId) || !windowLabel(record.windowLabel) ||
        record.windowLabelConfirmed === false || !Array.isArray(record.panes)) fail("surface_claim_invalid");
    const existing = claims.get(record.surfaceId);
    if (existing && existing.windowLabel !== record.windowLabel) fail("duplicate_surface_conflict");
    const claim = existing ?? { surfaceId: record.surfaceId, windowLabel: record.windowLabel, panes: [] };
    for (const pane of [...record.panes, ...tombstonePanes]) {
      if (!object(pane) || !paneId(pane.paneId) || !Number.isSafeInteger(pane.paneLabel) ||
          pane.paneLabel < 1 || !lineage(pane.paneLineageId)) fail("pane_claim_invalid");
      const next = { paneId: String(pane.paneId), paneLabel: pane.paneLabel, paneLineageId: pane.paneLineageId };
      const old = claim.panes.find((item) => item.paneId === next.paneId);
      if (old && JSON.stringify(old) !== JSON.stringify(next)) fail("duplicate_pane_conflict");
      if (!old) claim.panes.push(next);
      const snapshot = partitionSnapshot(pane.snapshot);
      if (!Array.isArray(pane.history)) fail("pane_history_invalid");
      contentDigests.push({ surfaceId: record.surfaceId, paneId: next.paneId,
        sha256: hash(JSON.stringify({ snapshot: snapshot.content, history: pane.history })) });
      displayGeometryDigests.push({ surfaceId: record.surfaceId, paneId: next.paneId,
        sha256: hash(JSON.stringify(snapshot.displayGeometry)) });
    }
    claims.set(record.surfaceId, claim);
  };
  for (const surface of state.surfaces) add(surface);
  for (const tombstone of state.lockless.tombstones) {
    if (!object(tombstone) || !surfaceId(tombstone.surfaceId) || !object(tombstone.payload)) fail("tombstone_invalid");
    if (tombstone.kind === "surface") {
      const nested = tombstone.payload.paneTombstones ?? [];
      if (!Array.isArray(nested)) fail("nested_tombstones_invalid");
      add(tombstone.payload.surface, nested.map((item) => item?.payload?.pane));
    } else if (tombstone.kind === "pane") {
      const owner = state.surfaces.find((item) => item.surfaceId === tombstone.surfaceId)
        ?? state.lockless.tombstones.find((item) => item.kind === "surface" && item.surfaceId === tombstone.surfaceId)?.payload?.surface;
      if (!owner) fail("orphan_pane_tombstone");
      add({ ...owner, panes: [] }, [tombstone.payload.pane]);
    } else fail("tombstone_kind_unhandled");
  }
  const confirmedClaims = sortClaims([...claims.values()]);
  if (confirmedClaims.length === 0 || confirmedClaims.some((claim) => claim.panes.length === 0)) fail("claims_empty");
  const labels = new Set(), paneLabels = new Set();
  for (const claim of confirmedClaims) {
    if (labels.has(claim.windowLabel)) fail("duplicate_window_label");
    labels.add(claim.windowLabel);
    for (const pane of claim.panes) {
      if (paneLabels.has(pane.paneLabel)) fail("duplicate_pane_label");
      paneLabels.add(pane.paneLabel);
    }
  }
  contentDigests.sort((a, b) => `${a.surfaceId}:${a.paneId}`.localeCompare(`${b.surfaceId}:${b.paneId}`));
  displayGeometryDigests.sort((a, b) => `${a.surfaceId}:${a.paneId}`.localeCompare(`${b.surfaceId}:${b.paneId}`));
  return { userData, clientId, confirmedClaims, contentDigests, displayGeometryDigests,
    registryBinding: state.registryBinding ?? null,
    acceptedPrimarySha256: hash(stateBytes), selectorSha256: hash(fs.readFileSync(selectorFile)),
    claimsSha256: hash(JSON.stringify(confirmedClaims)) };
}

function proveAcceptedOwner(manifest, accepted) {
  if (!object(accepted) || !hex64(accepted.headHash) || !Number.isSafeInteger(accepted.headSeq) ||
      !Number.isSafeInteger(accepted.custodyRevision) || !Array.isArray(accepted.mappings) ||
      !Array.isArray(accepted.paneMappings) ||
      typeof accepted.allocatorId !== "string" || typeof accepted.fleetId !== "string") {
    fail("accepted_state_shape_invalid");
  }
  const matchedWindows = new Set(), matchedPanes = new Set();
  for (const claim of manifest.confirmedClaims) {
    const key = `sf_${hash(JSON.stringify([manifest.clientId, claim.surfaceId]))}`;
    const windows = accepted.mappings.filter((entry) => entry.surfaceId === key);
    if (windows.length !== 1 || windows[0].windowLabel !== claim.windowLabel ||
        matchedWindows.has(key)) fail("accepted_window_mismatch");
    matchedWindows.add(key);
    for (const pane of claim.panes) {
      const matches = accepted.paneMappings.filter((entry) =>
        entry.clientId === manifest.clientId && entry.surfaceId === claim.surfaceId &&
        entry.paneId === pane.paneId && entry.lineageId === pane.paneLineageId);
      if (matches.length !== 1 || matches[0].paneLabel !== pane.paneLabel) fail("accepted_pane_mismatch");
      const paneKey = `${claim.surfaceId}:${pane.paneId}:${pane.paneLineageId}`;
      if (matchedPanes.has(paneKey)) fail("accepted_pane_duplicate");
      matchedPanes.add(paneKey);
    }
  }
  const otherProfilePanes = accepted.paneMappings.filter((entry) => entry.clientId === manifest.clientId);
  if (otherProfilePanes.length !== matchedPanes.size) fail("accepted_profile_extra_pane");
  return { clientId: manifest.clientId, allocatorId: accepted.allocatorId, fleetId: accepted.fleetId,
    headHash: accepted.headHash, headSeq: accepted.headSeq, custodyRevision: accepted.custodyRevision };
}

function main(args) {
  if (!(["inspect", "inspect-bound", "provision"].includes(args[0])) || args.length < 2 || args.length > 3) {
    fail("usage: inspect|inspect-bound|provision USER_DATA [OWNER_ACCEPTED_STATE_JSON]");
  }
  const manifest = profile(args[1], args[0] === "inspect-bound");
  if (args[0] === "inspect" || args[0] === "inspect-bound") {
    if (args.length !== 2) fail("inspect_extra_argument");
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }
  if (args.length !== 3) fail("owner_accepted_state_required");
  const owner = proveAcceptedOwner(manifest, readJson(args[2]));
  const target = path.join(manifest.userData, "registry-binding.provisioned.json");
  if (fs.existsSync(target)) fail("provisioning_already_exists");
  const document = { binding: { clientId: owner.clientId, allocatorId: owner.allocatorId, fleetId: owner.fleetId },
    confirmedClaims: manifest.confirmedClaims };
  fs.writeFileSync(target, JSON.stringify(document, null, 2), { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...owner, claimsSha256: manifest.claimsSha256,
    provisionedSha256: hash(fs.readFileSync(target)) })}\n`);
}

try { main(process.argv.slice(2)); } catch (error) {
  process.stderr.write(`foreign_first_claims_failed=${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 1;
}
