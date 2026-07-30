# T1770 Implementation and Review Requirement Matrix

## Authority and evidence snapshot

- Ticket: T1770 — Tight Beam support as an additional Surf Ace provider.
- Canonical requirement authority: `/Users/mike/shared-workspace/surf-ace/specs/tight-beam-provider-support.html`.
- Canonical artifact SHA-256: `110a4a14d37fe15f7c1fca3a40bf216ac9d2bd3202ba72981bf0445a15fe9ff4`.
- Independent approval: `/Users/mike/shared-workspace/surf-ace/specs/reviews/tight-beam-provider-support-fable-review-rev10.md`.
- Parent recon: `/Users/mike/shared-workspace/surf-ace-compositor/reports/recon/T1769-surface-provider-decoupling-artifact-recon.html`; Revision 10 is authoritative wherever it differs from A1..A4 or the historical June namespace proposal.
- Worktree base: `4a8294446ee8fbfd56ec4cbe7c68218b43fb8836`.
- Janus REST item state at ingestion: `In Progress`.
- Complete Janus migration-audit snapshot at ingestion: `2911faa11c4190873d90fc076e38b1c04cff10e879f34a409f8d9315c098b6de`.
- Snapshot completeness: `complete=true`; 28 retained rows comprising 15 `ticket_history`, 13 `transition_events`, and 0 normal-visible `ticket_events`.

This document is an implementation and review checklist derived from the canonical specification. It does not amend or replace that specification.

## Current gate snapshot

- Canonical non-GUI verification is green: protocol 32/32, controller 11/11, Tightbeam adapter 3/3, Electron 307/307, OpenClaw extension 341/341, and packaged-extension verification.
- The production OpenClaw path has a correlated accepted mutation, exact client commit receipt, visible Markdown render, current local read, and accessibility capture. The supplied context produced the specified `Unknown chat — Clawline` fallback, not the exact `CLU — Clawline` example.
- The official Tightbeam path is blocked before its first Surf Ace tool call: Claude returned its weekly quota error, while the available Codex Tightbeam agent exposed no Surf Ace MCP tools.
- Pending rows remain pending until their complete named proof exists. Green omnibus/unit coverage and diagnostic harness evidence do not promote official-path or `Both` rows by themselves.
- The final independent combined-tree re-review passed with no blocking findings. No product-readiness claim is made because the official Tightbeam path and remaining named proof rows are still incomplete.

## Admitted-platform decision

The first lockless implementation slice admits Electron only. Electron must implement and prove every applicable requirement below without a semantic carve-out.

iOS, iPadOS, and visionOS remain legacy/non-admitted in this slice and must not advertise the lockless capability. There are no Apple-exclusive acceptance IDs. If a later release admits any Apple platform, `COMPAT-5` and `AC-MIG-03` activate the complete applicable 62-check contract for that platform. A platform may omit controller window lifecycle only where no such product operation exists; local-user recoverable close remains unconditional.

## Proof classes

- **Source/unit:** source inspection, deterministic unit/integration tests, or conformance review is the direct proof. These checks do not establish broader product claims.
- **Official path:** exercise the official OpenClaw and Tight Beam controller surfaces against a production Surf Ace client build. Direct protocol scripts, fake clients, mocks, fixtures, compositor-only calls, and uncorrelated logs are diagnostic only.
- **Both:** deterministic source/unit proof is required for concurrency, accounting, ordering, or atomicity, and the corresponding product behavior must also be correlated through the official path.

All statuses begin as `Pending`. A row may move only when its named proof exists. The dated official-path ledger is `docs/design/t1770-official-path-proof-2026-07-30.md`.

## Shared protocol and client-authority core

| AC ID | Primary lane | Required implementation and proof | Proof class | Status |
|---|---|---|---|---|
| AC-ID-02 | Shared protocol/core | Reject a duplicate live controller instance ID with the distinct duplicate error; preserve the incumbent connection and cursors; permit retry only after incumbent reaping. | Both | Pending |
| AC-ID-03 | Shared protocol/core | Admit duplicate human labels under distinct IDs and prove labels have no dedupe, routing, cursor, permission, ordering, or quota effect. | Official path | Pending |
| AC-ARCH-01 | Shared protocol/core | Kill, restart, and partition one controller while the other continues content and topology work against actionable client truth, without election or ownership transfer. | Official path | Pending |
| AC-SYNC-01 | Shared protocol/core | Refuse disconnected content and topology writes: nothing may be accepted, reserved, queued, merged, or replayed; reconnection requires a fresh read and new requests. | Both | Pending |
| AC-SYNC-02 | Shared protocol/core | Prove one authoritative client replica per surface, with no replicated writable surface or optimistic central copy. | Source/unit | Pending |
| AC-SYNC-03 | Shared protocol/core | Enforce the conformance tripwire: offline writes, multi-authoritative replication, or optimistic central state require a product architecture revisit before implementation. | Source/unit | Pending |
| AC-HIST-01 | Shared protocol/core | Interleave A1, B1, A2; allocate distinct ordered revisions and entry IDs; make every push visible; prove Back/Forward order and no same-controller replacement. | Both | Pending |
| AC-HIST-02 | Shared protocol/core | Keep the visible entry outside the 20-entry retained pool; update recency on navigation; evict the least-recently-visible non-visible entry across controllers. | Both | Pending |
| AC-HIST-03 | Shared protocol/core | After Back, remove Forward entries before LRU enforcement when either controller pushes, with controller-independent results. | Both | Pending |
| AC-HIST-04 | Shared protocol/core | Back/Forward must restore exact content, annotation restore state, revision, and entry-bound composite provenance without changing controller cursors. | Official path | Pending |
| AC-HIST-05 | Shared protocol/core | Prove a chatty controller can evict another controller's older entries through ordinary LRU, with diagnostics and no quota, pin, priority, or owner protection. | Both | Pending |
| AC-TOPO-01 | Shared protocol/core | Serialize same-revision competing mutations: commit exactly one; return `stale_topology` plus authoritative revision/tree to the loser; create no partial state or events. | Both | Pending |
| AC-TOPO-02 | Shared protocol/core | Require the loser to refresh, recompute intent, and submit a new request ID at the current expected revision before it can commit. | Both | Pending |
| AC-TOPO-03 | Shared protocol/core | Prove clients and controllers never rebase, merge, transform, partially apply, or silently retry stale topology payloads. | Source/unit | Pending |
| AC-TOPO-04 | Shared protocol/core | Route split, rename, resize, close, restore, and retained realization through stable IDs and the same expected-revision seam. | Both | Pending |
| AC-TOPO-05 | Shared protocol/core | Prove commit order and client allocation follow serialized client receipt, not controller identity or labels; reverse receipt order to reverse outcomes. | Both | Pending |
| AC-TOPO-06 | Shared protocol/core | Return the original response for identical request replay; reject changed-payload ID reuse; require a new ID for recomputed stale intent. | Both | Pending |
| AC-CAP-01 | Shared protocol/core | Prove `P` as the pane-creating admission cap, atomic identity-blind `pane_capacity`, no allocations/events/revision on refusal, close `T`, split back to `P`, capacity-free same-ID restores to `P + T`, `L + R` conservation, later creation refusal, and reversed-identity equivalence. | Both | Pending |
| AC-CAP-02 | Shared protocol/core | Enforce exact annotation, pane, and surface byte limits with distinct atomic `pane_state_capacity` and `surface_state_capacity`; never truncate, evict, advance cursors, or emit events; close/restore exact-at-limit state byte-identically. | Both | Pending |
| AC-CAP-03 | Shared protocol/core | Independently compute and prove the complete `SURF-12` envelope for `P + T` records, consumable scopes, and `C` cursor/gap bundles; keep close lossless and size-safe; accept valid over-`P` state; reject only actual bound violations; restore exact state after restart. | Both | Pending |
| AC-CLOSE-01 | Shared protocol/core | Atomically replace a live pane with a durable tombstone preserving visible content, mixed-controller history/provenance, annotations, unread frames, and cursors without discard or advance. | Both | Pending |
| AC-CLOSE-02 | Shared protocol/core | Let the non-closing controller restore the same pane ID and exact state/cursors; remove the tombstone atomically; repeat at and above `P` without any capacity error. | Both | Pending |
| AC-CLOSE-03 | Shared protocol/core | Reject stale-revision and invalid-placement restores without consuming or changing the tombstone; succeed after refresh, recomputation, and retry. | Both | Pending |
| AC-CLOSE-04 | Shared protocol/core | When a former pane label has been reused, restore the same pane identity/state with a newly allocated unique visible label. | Both | Pending |
| AC-CLOSE-05 | Shared protocol/core | Reject last-live-pane close identically for every controller without creating a tombstone or revision. | Both | Pending |
| AC-CLOSE-06 | Shared protocol/core | With small count and byte bounds, reclaim ascending `closedSequence` tombstones until both bounds hold, independent of controller and provenance. | Both | Pending |
| AC-CLOSE-07 | Shared protocol/core | Return `tombstone_capacity` when one pane tombstone alone exceeds the byte bound and leave the pane live and unchanged. | Both | Pending |
| AC-CLOSE-08 | Shared protocol/core | Ensure list, read, and attempted restore do not refresh reclamation order; after reclamation, reject restore without topology change. | Both | Pending |
| AC-CLOSE-09 | Shared protocol/core | Fan out every reclamation in order and persist tombstone/pane IDs, sequence, size, bounds, and reason; never use owner identity as a selection factor. | Both | Pending |
| AC-SURF-01 | Shared protocol/core | Serialize controller and local-user surface open at the endpoint; allocate client IDs/labels; fan out appeared events; grant no later authority. Without controller lifecycle capability, return `unsupported_operation` while keeping local-user close recoverable. | Both | Pending |
| AC-SURF-02 | Shared protocol/core | Commit a complete surface tombstone before removed event/socket closure and restore exact surface/pane identities, topology, content/history/provenance, annotations, nested tombstones, and unread state through fresh sockets from the other controller. | Both | Pending |
| AC-SURF-03 | Shared protocol/core | Support local-user close of the last surface, zero-live endpoint discovery, and controller/user restore even without controller lifecycle capability; close cause must affect explanation only. | Official path | Pending |
| AC-SURF-04 | Shared protocol/core | Serialize concurrent open, close, and restore; return authoritative state to stale losers with no partial tombstone/event; require fresh recomputation and prohibit automatic retry/merge. | Both | Pending |
| AC-SURF-05 | Shared protocol/core | Count nested state once during bounded surface close; create no new loss or cursor movement; reclaim globally oldest pane/surface tombstones; keep close size-safe; report nested/unread disposition; prove identity reversal yields the same victim. | Both | Pending |
| AC-SURF-06 | Shared protocol/core | Restart with zero live surfaces and a valid over-`P` retained surface; restore endpoint capability, sequences, bounds, exact distribution, scopes, cursors, and gaps before admission; restore without clamp/capacity refusal; keep pane creation refused until prospective count fits. | Both | Pending |
| AC-RET-01 | Shared protocol/core | Preserve dormant-bundle order across reads and label changes; resume exact cursors for a retained ID; allocate a new `dormantSequence` after a later disconnect; start a new ID at current tail. | Both | Pending |
| AC-RET-02 | Shared protocol/core | Enforce total, dormant-count, and dormant-byte bounds using ascending `dormantSequence`; recompute exact shared charges; emit the required event/diagnostic; prove victim choice ignores identity, labels, product, work, and unread volume. | Both | Pending |
| AC-RET-03 | Shared protocol/core | Atomically reclaim a dormant registry entry, all its live/pane-tombstone/surface-tombstone cursors, and frames retained solely for it; report exact unread disposition; preserve other cursors/frames; re-admit at current tail. | Both | Pending |
| AC-RET-04 | Shared protocol/core | Return `controller_capacity` when every admitted entry is live; once one is dormant, reclaim only the oldest eligible bundle; prove restart preserves bounds, state, sequences, and victim. | Both | Pending |
| AC-LIVEBUF-01 | Shared protocol/core | Bound each scope for a connected never-reader while the producer continues; drop oldest complete records by sequence; move only affected cursor floors; create one sticky/coalesced gap, targeted overflow event, matching structured loss, and exact durable diagnostics. | Both | Pending |
| AC-LIVEBUF-02 | Shared protocol/core | Coalesce only declared latest-wins/live state by key; never merge/truncate append or finalized records; convert oversized records to explicit gaps; keep pane/surface close control outside payload pressure and preserve retained range/gap on restore. | Both | Pending |
| AC-READ-02 | Shared protocol/core | Allow mutations and visible lag while another controller is slow/disconnected; catch up within the advertised window; use structured live-buffer loss after crossing it rather than claiming unlimited catch-up. | Official path | Pending |
| AC-OPS-02 | Shared protocol/core | Correlate every accepted mutation, overflow, and reclamation to exactly one client commit and ordered fan-out; expose stable, distinguishable capacity and failure codes. | Both | Pending |

## Electron client and product UI

Electron also owns the client realization of every shared-core row above.

| AC ID | Primary lane | Required implementation and proof | Proof class | Status |
|---|---|---|---|---|
| AC-PROV-01 | Electron client | Render the visible provenance pill exactly as `CLU — Clawline` for the specified friendly chat and product labels. | Official path | Pending |
| AC-PROV-02 | Electron client | Bind composite provenance to each history entry so Back/Forward shows captured entry metadata rather than current connection/chat metadata. | Official path | OpenClaw production path passed; Tightbeam path pending |
| AC-PROV-03 | Electron client | Implement deterministic localized two-part fallbacks for chat-only, provider-only, neither, empty, and whitespace-only inputs in two locales while preserving supplied labels verbatim. | Official path | Pending |
| AC-PROV-04 | Electron client | At every supported accessibility size, prove the composite, collapsed-ellipsis, and zero-width classes for long LTR, RTL, and mixed labels; preserve navigation and full accessible text in every class. | Both | Source/unit passed — renderer DOM and sizing suite covers three width classes, LTR/RTL/mixed labels, 1×/2× metrics, share reallocation, navigation survival, and full accessible text; official production-client proof pending |
| AC-PROV-05 | Electron client | Prove identical or changed composite labels do not affect IDs, cursors, authentication, routing, ordering, permissions, quotas, close, or restore. | Official path | Pending |
| AC-PROV-06 | Electron client | Make Back/Forward announce the full provenance reached; expose the pill as non-interactive with its full localized semantic name. | Official path | OpenClaw production path passed; Tightbeam path pending |

## Apple clients

No acceptance row is Apple-exclusive, and no Apple platform is admitted in this slice. The admission gate for a future Apple implementation is `AC-MIG-03`: the complete applicable matrix must pass on each admitted production client build, including shared core, provenance/accessibility, local-user recoverable close, persistence/restart, overflow, and live/dormant retention.

## OpenClaw controller

OpenClaw also participates in every dual-controller and official-path row that names both controllers.

| AC ID | Primary lane | Required implementation and proof | Proof class | Status |
|---|---|---|---|---|
| AC-ID-04 | OpenClaw controller | Persist the controller ID across restart/redeploy and resume its retained dormant cursor; treat regenerated or reclaimed IDs as fresh at current tail without label inheritance. | Both | Pending |
| AC-LIVEBUF-03 | OpenClaw controller | Build the bounded local projection from pair/resume snapshots and ordered deltas; present one alert per burst; keep ordinary `surf_ace_read` network-free while atomically persisting projected consumption and a background acknowledgement; reconcile cache/outbox/sequences/pending/gaps after restart; reject capability admission if the cache cannot hold the negotiated window. | Both | Pending |
| AC-READ-01 | OpenClaw controller | Read independent retained frames through each controller's local projection; advance only the matching client cursor after background acknowledgement; preserve cursor/gap continuity across reconnect inside the retained window. | Official path | Pending |

## Tight Beam agent-side adapter

Tight Beam also participates in every dual-controller and official-path row that names both controllers.

| AC ID | Primary lane | Required implementation and proof | Proof class | Status |
|---|---|---|---|---|
| AC-ID-01 | Tight Beam agent-side adapter | Concurrently admit OpenClaw and Tight Beam under distinct stable IDs; let both push and read the same pane; expose no lock, `busy`, designation, claim, takeover, or owner-only refusal. | Official path | Pending |
| AC-ARCH-02 | Tight Beam agent-side adapter | Prove through product/config/source evidence that no coordinator or hard-coded deployment topology participates, Tight Beam remains agent-side, and the compositor receives only client-resolved state without sequencing mutations. | Both | Pending |
| AC-MIG-04 | Tight Beam agent-side adapter | Exercise Tight Beam through its official agent-side surface and OpenClaw through its official controller surface; neither may read the other's private process/store or depend on a central coordinator. | Official path | Pending |

## Migration, persistence, and rollback

| AC ID | Primary lane | Required implementation and proof | Proof class | Status |
|---|---|---|---|---|
| AC-MIG-01 | Migration/persistence | Keep a legacy client in legacy single-provider behavior with no mixed mode; require an upgraded client to advertise and use the versioned lockless capability explicitly. | Official path | Pending |
| AC-MIG-02 | Migration/persistence | Convert representative legacy provider-local state to CAP-conforming recoverable client state, bounded scopes/cursors/gaps, bounds, and sequences; admit valid over-`P` state within `P + T`; prove `SURF-12` and projection capacity before admission; reject only actual count/byte/cache violations without trim, drop, clamp, or owner selection. | Both | Pending |
| AC-MIG-05 | Migration/persistence | Exercise the approved rollback on representative lockless state, preserving all representable material or reporting every unrepresentable item before transition, without silently choosing an owner. | Official path | Pending |
| AC-OPS-01 | Migration/persistence | Restart the production client and restore the complete live/tombstone distribution, CAP state, consumable scopes, controller bundles, limits, sequences, and revisions before admission; never clamp valid over-`P` state; reconcile controller cache and pending acknowledgement outbox before reporting current. | Both | Pending |

## Official-path proof and implementation-review gates

| AC ID | Primary lane | Required implementation and proof | Proof class | Status |
|---|---|---|---|---|
| AC-MIG-03 | Official-path proof | Run the complete applicable check set on every admitted platform with no D1..D5, Q5R1..Q5R5, W1, local-read, structured-overflow, close, or retention carve-out. Permit controller lifecycle omission only where no controller product operation exists; always prove local-user recoverable close. | Official path | Pending |
| AC-PROOF-01 | Official-path proof | Support every user-visible and product claim with official OpenClaw and Tight Beam paths on a production Surf Ace client build; label all harness-only evidence diagnostic. | Official path | Blocked — OpenClaw correlated production path passed; Tightbeam Claude session hit quota before first tool call and Codex session exposed no MCP tools |
| AC-PROOF-02 | Review gate | Before implementation review passes, land R6-AMD-1..8, R7-AMD-1..2, R8-AMD-1..2, and R9-AMD-1 in `DESIGN.md` and the compositor authority documents, including every specifically named section, and synchronize the canonical shared compositor artifact with its repository projection. | Source/unit | Passed — `DESIGN.md` SHA-256 `5523aa4a5c80912e2a4c99a7dbe6f2d2784c4ea7fee849312e45d92f0ef8c2c2`; canonical and repository compositor projections are byte-identical at SHA-256 `5600c9cb9b250c83330c62b4ab5156bff64c1fce8b4a82bdbdbddc6b04cefa04` |

## Count audit

| Primary lane | Unique acceptance rows |
|---|---:|
| Shared protocol/client-authority core | 43 |
| Electron client/product UI | 6 |
| Apple clients | 0 |
| OpenClaw controller | 3 |
| Tight Beam agent-side adapter | 3 |
| Migration/persistence/rollback | 4 |
| Official-path proof/review gate | 3 |
| **Total** | **62** |
