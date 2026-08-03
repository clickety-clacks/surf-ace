# T1770 Implementation and Review Requirement Matrix

## Authority and evidence snapshot

- Ticket: T1770 — Tight Beam support as an additional Surf Ace provider.
- Canonical requirement authority: `/Users/mike/shared-workspace/surf-ace/specs/tight-beam-provider-support.html`.
- Canonical Revision 11 + DEC-TA-01A + FLYNN-1770-02 SHA-256: `97a49241d4991a7e96bfe89bff720cbe2acb0742c9781d0d0bb697c2319ecafb`.
- Independent approvals include `scratch/tight-beam-provider-support-codex-review-rev11-flynn-1770-02-delta.md` (SHA-256 `11c79d10a3d772258c1047378f636a97dddc427a155b0435587340af28488a6a`) for the general standalone CLI correction.
- Accepted architecture bounceback: `scratch/T1770-whole-ticket-bounceback-report.md`, SHA-256 `007f741cddc6a74fda0826481e8b2a143ed6f013123bdf7c2ef23eaacae1b364`.
- Parent recon: `/Users/mike/shared-workspace/surf-ace-compositor/reports/recon/T1769-surface-provider-decoupling-artifact-recon.html`; Revision 10 is authoritative wherever it differs from A1..A4 or the historical June namespace proposal.
- Worktree base: `4a8294446ee8fbfd56ec4cbe7c68218b43fb8836`.
- Janus REST item state at ingestion: `In Progress`.
- Complete Janus migration-audit snapshot used by the Revision 11 reviewer: 36/36 retained rows, `has_more=false`, including accepted bounceback `PP006813` and resume proof `PP006814`.

This document is an implementation and review checklist derived from the canonical specification. It does not amend or replace that specification.

## Current gate snapshot

- The verified T1770 Revision 11 source is acceptance input to T1778. T1778 expands production admission to the native iPhone and iPad client; the native candidate now implements the complete shared authority and passes the iPhone/iPad source gates, but it does not inherit Electron review, deployment, or product proof.
- The independently approved T1778 Apple amendment is `/Users/mike/shared-workspace/surf-ace/specs/native-apple-lockless-client-authority.md`, SHA-256 `04b9e412f23f84a33b54825b8d09ac1763879a552e671d3fd50c72465fe5cc22`. The approved R1-R11 rollout plan is `/Users/mike/shared-workspace/surf-ace/specs/lockless-multi-controller-production-rollout.md`, SHA-256 `ffb6e9d388e6021db846b48fd5187e9b2d4d449a50c42582754309414ce412f4`.
- The production OpenClaw path has a correlated accepted mutation, exact client commit receipt, visible Markdown render, current local read, and accessibility capture. The supplied context produced the specified `Unknown chat — Clawline` fallback, not the exact `CLU — Clawline` example.
- The earlier dedicated-archetype/MCP Tight Beam proof is rejected architecture evidence only. It does not block the corrected CLI route and supports no product claim.
- Pending rows remain pending until their complete named proof exists. Green omnibus/unit coverage and diagnostic harness evidence do not promote official-path or `Both` rows by themselves.
- The temporary Shrdlu proof remains acceptance evidence only and is not T1778 deployment or fleet-soak evidence. T1778 R7/R8 actions and evidence must come exclusively from the shipped Rust CLI; the resident OpenClaw extension stays connected but passive.

## Admitted-platform decision

The T1778 production slice admits Electron and the native `SurfAce` target on iPhone and iPad. Each must implement and prove every applicable requirement below without a semantic carve-out. The exact native candidate advertises the capability only from the complete iOS target and keeps `SurfAceSpatial` non-capable; independent combined review, canonical-main promotion, physical-device deployment, and CLI-only product proof remain separate gates.

`SurfAceSpatial` remains legacy/non-admitted in T1778 and must not advertise the lockless capability. There are no Apple-exclusive T1770 acceptance IDs; `APPLE-AC-01..10` below are an implementation/proof crosswalk, not replacement semantics or added wire requirements. `COMPAT-5` and `AC-MIG-03` activate the complete applicable T1770 check set separately for the iPhone and iPad production build. A platform may omit controller window lifecycle only where no such product operation exists; local-user recoverable close remains unconditional.

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

The shared iOS/iPadOS source set is admitted by T1778. Its candidate authority is mapped to all applicable shared-core rows above, `AC-PROV-01..06` through native presentation/accessibility, `AC-MIG-01..03`, `AC-MIG-05`, and `AC-OPS-01`; only the source/unit boundary is claimed below, and only where the named candidate gate passed. Controller-product rows remain obligations of their named controllers rather than native-client implementation. The canonical TypeScript/Rust/Swift vector is `packages/protocol/vectors/authority-conformance.json`; Swift consumes that exact resource through `SurfAceAuthorityConformanceVectorTests`, not an Apple copy. Full simulator results are 140/140 on iPhone 17 and 140/140 on iPad Pro 13-inch (M5); `SurfAceSpatial` builds without lockless admission, and the stopped-app rollback target passes 3/3. These results are candidate evidence pending the exact combined review and merged-source rerun.

| T1778 crosswalk | Native implementation/proof mapping | Current status |
|---|---|---|
| APPLE-AC-01 | Explicit target admission gate; complete capability/finite limits on `SurfAce`; unchanged legacy on `SurfAceSpatial` and unupgraded binaries. | Candidate source/platform gate passed — exact capability discovery, finite limits, projection admission, persisted per-surface mode exclusion, and non-capable Spatial build; combined review and product proof pending |
| APPLE-AC-02 | Pure-Foundation controller registry with distinct live IDs, duplicate-live rejection, dormant resume, and identity-blind reclamation. | Candidate source/unit passed — exact count/byte/cursor bounds, deterministic oldest-dormant reclamation, retained resume, and fresh-tail readmission; combined review and product proof pending |
| APPLE-AC-03 | One FIFO transaction seam for remote and local mutations, client allocations, exact receipts, history/provenance, persistence-before-response, and ordered fan-out. | Candidate source/unit passed — transactional local/remote commits, exact bounded receipts, and ordered fan-out covered in both simulator suites; combined review and product proof pending |
| APPLE-AC-04 | Stable-ID topology stale/retry, exact pane/surface capacity, recoverable close/tombstones, restoration, and local-user close. | Candidate source/unit passed — topology/capacity/close/restore matrices pass on iPhone and iPad; combined review and product proof pending |
| APPLE-AC-05 | Controller-local snapshots, cursors, acknowledgements, retained records/live frames, structured gaps, ordering, and bounds. | Candidate source/unit passed — pair/resume snapshots, queued acknowledgements, scope replay, gaps, retention, and strict wire parity covered; combined review and product proof pending |
| APPLE-AC-06 | Complete generation restore before admission across scene/background/foreground/process restart and zero-live discovery. | Candidate source/unit passed — startup target recovery, lifecycle restoration, readiness gating, and zero-live tombstone/capability discovery covered; combined review and product proof pending |
| APPLE-AC-07 | Durable target work `intent_committed -> materializing -> terminal`, crash-window recovery, and separately correlated result truth. | Candidate source/unit passed — exact work-item capacity, startup recovery, no duplicate materialization, and record ID/consumable sequence correlation covered; combined review and product proof pending |
| APPLE-AC-08 | Exact legacy migration plus stopped-app host rollback preview/apply and byte-exact original-container restoration. | Candidate source/unit passed — migration validation plus rollback preview/apply/exact restoration 3/3; retained legacy artifact and physical-device execution remain deployment gates |
| APPLE-AC-09 | Exact reviewed/merged source, artifacts, device IDs, install/container/process chain, and executable rollback on Ansible and Aleph. | Pending — production proof gate |
| APPLE-AC-10 | One canonical cross-language vector, iPhone/iPad tests, and a `SurfAceSpatial` regression build prevent semantic drift or premature advertisement. | Candidate platform gate passed — canonical vector plus iPhone 140/140, iPad 140/140, and Spatial build; exact combined review and merged-source rerun pending |

R8 proof uses only the byte-identical shipped Rust `surf-ace` CLI as actor and evidence surface on Ansible and Aleph. XcodeBuildMCP device logs, screenshots, and container hashes may corroborate the CLI result but do not drive protocol actions. No OpenClaw tool, MCP adapter, direct WebSocket/provider call, fixture, test harness, or temporary proof client can satisfy these rows.

## OpenClaw controller

OpenClaw also participates in every dual-controller and official-path row that names both controllers.

| AC ID | Primary lane | Required implementation and proof | Proof class | Status |
|---|---|---|---|---|
| AC-ID-04 | OpenClaw controller | Persist the controller ID across restart/redeploy and resume its retained dormant cursor; treat regenerated or reclaimed IDs as fresh at current tail without label inheritance. | Both | Pending |
| AC-LIVEBUF-03 | OpenClaw controller | Build the bounded local projection from pair/resume snapshots and ordered deltas; present one alert per burst; keep ordinary `surf_ace_read` network-free while atomically persisting projected consumption and a background acknowledgement; reconcile cache/outbox/sequences/pending/gaps after restart; reject capability admission if the cache cannot hold the negotiated window. | Both | Pending |
| AC-READ-01 | OpenClaw controller | Read independent retained frames through each controller's local projection; advance only the matching client cursor after background acknowledgement; preserve cursor/gap continuity across reconnect inside the retained window. | Official path | Pending |

## General standalone Surf Ace CLI and Tight Beam consumer skill

Tight Beam also participates in every dual-controller and official-path row that names both controllers.

| AC ID | Primary lane | Required implementation and proof | Proof class | Status |
|---|---|---|---|---|
| AC-ID-01 | Standalone CLI + Tight Beam consumer | Concurrently admit OpenClaw and Tight Beam under distinct stable IDs; let both push and read the same pane; expose no lock, `busy`, designation, claim, takeover, or owner-only refusal. | Official path | Pending |
| AC-ARCH-02 | Standalone CLI + Tight Beam consumer | Prove no coordinator or hard-coded deployment topology participates, the CLI remains caller-neutral Surf Ace infrastructure, Tight Beam remains a separate consumer, and the compositor receives only client-resolved state. | Both | Pending |
| AC-MIG-04 | Standalone CLI + Tight Beam consumer | Exercise `surf-ace` directly from a non-Tight-Beam caller, then the identical executable through an unchanged ordinary Tight Beam archetype and reusable skill, plus OpenClaw's official surface. | Official path | Pending |
| AC-CLI-01 | General standalone CLI | Build and run the same locked Rust source and complete test suite natively on macOS and Linux; canonical schema/conformance vectors and deterministic output fixtures match. | Source/unit | Pending |
| AC-CLI-02 | General standalone CLI | Prove one `surf-ace` executable / `surf-ace-cli` crate and package, exactly eleven commands, no Tight-Beam-specific CLI identity or path, and no MCP/adapter/dedicated-archetype/parallel route. | Source/unit | Pending |
| AC-CLI-03 | Standalone CLI + Tight Beam consumer | Invoke installed `surf-ace` directly without any skill/agent runtime, then prove the Tight Beam skill and fixtures use the exact same executable semantics without changing archetype identity or unrelated material. | Source/unit | Pending |
| AC-CLI-04 | General standalone CLI | Reuse one durable controller ID across sequential processes and serialize concurrent processes over each complete networked invocation. | Source/unit | Pending |
| AC-CLI-05 | General standalone CLI | Prove every specified crash window, exact committed success/failure replay, proven `not_committed`, blocking `still_pending`, duplicate-safe receipt replay, and deterministic `intent_committed → materializing → terminal` target work recovery. | Source/unit | Pending |
| AC-CLI-06 | General standalone CLI | Instrument zero Surf Ace network access for locked local-only `read`, including atomic projected consumption and acknowledgement intent. | Source/unit | Pending |
| AC-CLI-07 | General standalone CLI | Reconcile ordered projection/outbox state and all unresolved receipt IDs; apply response events durably before ack/outbox cleanup; clear client receipts only after accepted ack. | Source/unit | Pending |
| AC-CLI-08 | General standalone CLI | Prove deterministic JSON for every networked command, exact receipt correlation, count/byte capacity, admission after ack, reclamation unavailability, zero target materialization on precommit refusal, committed-intent response before callback, separately correlated append-only target result, and external provenance. | Both | Pending |
| AC-CLI-09 | Corrected-source review | Independently adjudicate the complete CORR-09 authority and invariant set against corrected source and native platform evidence before any Shrdlu installation. | Source/unit | Pending |
| AC-CLI-10 | Official-path proof | Through the reversible Shrdlu test path, prove unchanged ordinary-archetype mutation, correlated receipt, exact `CLU — Clawline`, preserved OpenClaw, and no competing client/service/persistence path. | Official path | Pending |

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
| AC-PROOF-01 | Official-path proof | Support every user-visible and product claim with official OpenClaw and Tight Beam paths on a production Surf Ace client build; label all harness-only evidence diagnostic. | Official path | Pending — corrected source review must pass before Shrdlu proof |
| AC-PROOF-02 | Review gate | Before implementation review passes, land R6-AMD-1..8, R7-AMD-1..2, R8-AMD-1..2, and R9-AMD-1 in `DESIGN.md` and the compositor authority documents, including every specifically named section, and synchronize the canonical shared compositor artifact with its repository projection. | Source/unit | Passed — `DESIGN.md` SHA-256 `5523aa4a5c80912e2a4c99a7dbe6f2d2784c4ea7fee849312e45d92f0ef8c2c2`; canonical and repository compositor projections are byte-identical at SHA-256 `5600c9cb9b250c83330c62b4ab5156bff64c1fce8b4a82bdbdbddc6b04cefa04` |

## Count audit

| Primary lane | Unique acceptance rows |
|---|---:|
| Shared protocol/client-authority core | 43 |
| Electron client/product UI | 6 |
| Apple clients | 0 |
| OpenClaw controller | 3 |
| General standalone CLI + Tight Beam consumer skill (including AC-CLI-01..08) | 11 |
| Migration/persistence/rollback | 4 |
| Official-path proof/review gate (including AC-CLI-09..10) | 5 |
| **Total** | **72** |

The ten `APPLE-AC` entries are crosswalk rows over the existing applicable T1770 acceptance set and therefore do not increase the 72-row count.
