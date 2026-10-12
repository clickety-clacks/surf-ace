# Isolated lifecycle evidence proposal

This directory is a source-only proposal for `asg_096dfc3b` / `wi_41ab1ecd`.
It does not change `DESIGN.md`, the public protocol, client startup, persistence,
registry, or a recovery handler. Nothing imports it from production code.
`inspectEvidence` accepts only synthetic `isolated_fixture` inputs and always
returns `effect: none` and `replayAllowed: false`, including when inspection is
complete. Do not connect it to a live collector or use its output to close a
surface. Matching fixture stamps are assertions, not proof of atomic collection.

## Source baseline and evidence boundary

Baseline main: `4edd7db5ddf599fd24824f5c51d8f0c2a4bd4e25`.
Read/hash of incident `art_0df01b30` matches
`fa40087512f50779da12cc7788e07653f172ca0ba996aa47da78d57d8bed08b0`.
PO `att_494937c3`, posture `att_a401681d`, and topology `att_3cdb779b`
authorize this isolated contract/negative-test phase only.

Current source separates the native `windows` map in Electron `main.ts`, the
in-memory `SurfaceCore`, selector-accepted bytes in `persistent-state-file.ts`,
registry advertisement, and per-controller operation receipts. An accessible
window inventory does not exhaust the native ownership map. A registry row is
not proof of native presence. An accepted disk generation is not a fresh core
projection. Unknown prior close requests cannot be reconstructed from these.

`ws-server.ts` local close traverses the client transaction, captures the full
surface and nested pane tombstones, removes the live surface, advances its set
revision, and persists before returning. Protocol `lockless.ts` close intent
requires surface-set and topology expectations. Existing receipt reservation
in `lockless-client-authority.ts` retains operation/request/status; terminal
receipt resolution returns outcome, operation receipt, and terminal response.
It does **not** retain this proposal's full original request envelope/digest.
Controller reclamation can make a receipt unavailable. The proposal must not
mistake that for a known safe retry or fabricate the lost request.

## Fixture model

The model binds collector boundaries before/after reads to the expected client,
PID plus process birth, process epoch, build, collection ID, exact set revision,
and mutation sequence. Each native/core/accepted/registry view must declare the
same boundary, complete scoped rows, per-surface epoch and topology revision.
Targets are explicitly revision-fenced. Survivors `p`, `z`, and `aa` must match
their expected retained-material fingerprints and remain live in owned native
and core state. IDs are stable synthetic identities; visible labels grant no
authority. Extra, missing, duplicate, unknown, or changed rows refuse.

Selector evidence hashes the exact UTF-8 synthetic accepted-file bytes, then
checks that its `surfaces` projection matches the declared accepted rows.
History fingerprints stand for an exhaustive retained graph including identity,
history, annotations and session lineage. Fixture rows/file shape are not the
real persisted record schema; no production adapter is implemented. Full
record-to-projection normalization must be independently specified and tested.

Registry timestamp is in the fixture collector's one clock domain. Test age20ms
is a synthetic policy, not a new product timeout. The model refuses stale/future
timestamps and mismatched process/revision projection. Actual registry messages
do not establish all these fields: a live adapter cannot truthfully fill them
by copying a current client stamp onto an old registry row.

Each target requires the retained original operation, controller/client/build/
process/surface identity, revision expectations and matching payload digest.
Outcomes distinguish pending intent, known failure/non-commit, and resolved
success. Resolved success requires a correlated durable receipt and retained
surface tombstone with the same identity, commit sequence and history hash.
Lost transport reply is not loss of those proofs. Duplicate identical receipts
are read-only idempotent; a conflicting duplicate refuses. Missing/reclaimed
receipt or original request refuses. A pending request is not a successful
close. Native absence with retained live core/state is a conflict requiring a
product decision, even with a complete synthetic native inventory.

No model outcome mutates or advances a request, history, tombstone, or cursor.
The entire input is checked for non-mutation in tests; output receipts are
cloned. Classification is only a review artifact, not an admission capability.

## Product/normative choices requiring separate approval

1. **Atomic inspection:** choose a client-owned collection seam covering native
   ownership and core/accepted-state views, including exact revalidation around
   async reads. A registry round trip cannot be assumed atomic with that seam;
   missing freshness/causal correlation must remain unknown. Decide required
   process-birth, surface-epoch, collection/revision fields and bounded validity.
2. **Read-only access:** decide how an inspection can be obtained when the target
   core surface cannot be paired. This proposal adds no unauthenticated endpoint,
   new trust route, controller, or bypass of existing direct-client authority.
3. **Orphan transition:** native absence alone does not authorize deleting live
   state or registry rows. Decide whether the intended outcome is restoration,
   repair of the live projection, a new explicit close intent, or continued
   refusal. Unknown original intent/outcome is never replay-safe. Nothing here
   grants a fresh close merely because the prior request is unknown.
4. **Commit/recovery semantics:** any authorized transition must revalidate exact
   identities/revisions at the existing serialized seam; preserve the full graph,
   create durable recoverable tombstone and correlated receipt before events;
   survive interruption without inventing success or silently reclaiming source.
   Full original-request provenance/retention bounds need a separate design
   decision if replay resolution requires fields not currently retained.
5. **Registry projection:** define client-authoritative causal removal/restore
   acknowledgement, separate from registry-only deletion. A stale row must not
   become a destructive authority. Pending, closed/restorable, conflicting and
   unknown states must remain separately visible without exposing content or
   credentials in diagnostics.

## Verification and limits

Run from repository root:

    node scripts/lifecycle/inspect-evidence.test.mjs

This uses only Node built-ins, synthetic data, no Electron startup, sockets,
discovery, GUI, files outside the checkout, or runtime state. Tests include the
incident-shaped refusal, restart with same PID, interleaving, stale registry,
selector corruption, split core/durable state, target epoch/revision mismatch,
unknown/reclaimed/missing request evidence, duplicate/lost replies and retained
tombstone/history/survivor checks. They do not prove an actual collector, actual
transaction, restart recovery or physical window outcome. Existing installed
Eezo `ad/ae/af` and survivors are untouched. Independent review and separate
normative/runtime authority remain required.
