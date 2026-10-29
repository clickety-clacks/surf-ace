# Surf Ace Wire Protocol (WebSocket)

Status: Design draft
Depends on: `<spec-root>/clawline/specs/clawline-invariants.md`

## 1. Purpose and Goals

Surf Ace is a standalone display and annotation system that turns any screen running the Surf Ace app into an OpenClaw-managed surface. It is a purpose-built binary application — not embedded in another app — available on iOS/iPadOS, on visionOS as the Surf Ace Spatial app, and as an Electron app on Linux and macOS. Supported clients are Linux, macOS, iOS, iPadOS, and visionOS. Windows is not supported and is not a delivery or soak gate. Linux and macOS controller/server requirements remain in scope.

visionOS is a supported client with the same client, soak, delivery, and release obligations as iOS/iPadOS. Wherever this document states such an obligation for iOS or iPadOS, it applies equally to visionOS, including delivery of the Surf Ace operating skill with each release of the app. This follows Mike's October 29, 2026 product ruling that visionOS is a supported Surf Ace client.

### Actors

- **OpenClaw** — the AI orchestrator. OpenClaw discovers surfaces, pushes content to them, reads user annotations and events, and interprets surface activity.
- **Surfaces** — screens running the Surf Ace app. A surface is a render target that OpenClaw can address by stable identity. Multiple surfaces can be active simultaneously; OpenClaw manages them independently.
- **Users** — annotators and viewers. On iPad, users draw on content with a stylus (Apple Pencil) or finger. On Electron, users annotate with mouse or trackpad. User interactions are captured and reported to OpenClaw for interpretation.

### Core Goals

1. **OpenClaw-managed surface.** Any screen running the Surf Ace app becomes a surface OpenClaw can push content to and read events from.
2. **Content display.** OpenClaw pushes content to surfaces in the following types: `html`, `image`, `pdf`, `terminal`, `markdown`. `video` and `canvas` remain optional wire-level content types for forward compatibility, but OpenClaw drawing workflows do not depend on them because draw-capable HTML/SVG content already works through normal content updates. The surface renders content and keeps it displayed until OpenClaw explicitly changes it.
3. **User annotation.** Users draw and annotate on displayed content using a stylus (iPad) or input device (Electron). Annotation strokes are captured and reported to OpenClaw.
4. **OpenClaw interpretation.** OpenClaw reads user annotations and interprets them — identifying point-outs, markup gestures, written content, and spatial relationships to the displayed material.
5. **Zero-config discovery.** Surfaces advertise themselves via Bonjour/mDNS (`_surf-ace._tcp`). No manual setup, pairing codes, or configuration is required.
6. **Multi-surface and multi-pane.** OpenClaw can manage multiple surfaces simultaneously. Each surface has a stable identity and independent state. Within a surface, windows can be split into multiple panes, each with independent content and annotation context. OpenClaw can target content and read annotations at the pane level.
7. **Standalone app.** Surf Ace is its own binary on each platform. It is not a plugin, extension, or embedded view inside another application.

### Architecture Overview

All provider↔surface communication uses the public WebSocket protocol. The provider (OpenClaw's runtime component managing surface connections) is the WS client; the surface app runs the WS server. There is no REST API. OpenClaw maintains a persistent connection, handles reconnect, and buffers surface state for OpenClaw tool reads. The general standalone `surf-ace` CLI connects directly for each explicit networked invocation and durably reconciles its local projection under the caller-supplied state root before disconnecting, regardless of whether the caller is a program, script, user, or agent such as Tight Beam.

Key design decisions:
1. Provider initiates the connection (provider is WS client).
2. Surface runs a lightweight WS server (HTTP only for the mandatory upgrade handshake required by RFC 6455).
3. One active provider connection per surface at a time, with automatic reconnect.
4. All direct-client operations run over that socket: pair handshake, content push, clear, events, and snapshots. Registry-journal annotation operations in §4.10 use a separate registry WebSocket.
5. Direct surface event streaming is always on after pairing and has no surface-side subscribe/unsubscribe operation. The later registry-journal watch in §4.10 is a distinct stream and does not change that client event contract.

## 2. Scope and Non-Goals

### 2.1 In Scope
1. Discovery metadata needed to open the WS connection.
2. WS handshake, capability-scoped controller admission, session lifecycle, reconnect.
3. Wire message contracts for content operations, snapshot operations, and user interaction events.
4. JSON Schema definitions for all message types.

### 2.2 Non-Goals
1. UI design details for surface rendering.
2. OpenClaw prompt orchestration details.
3. Cloud relay transport.

### 2.3 Delivery Phasing

Implementation order is explicitly phased:

**Phase 1 — Surface topology first (before annotations):**
1. Multi-window support (already in protocol).
2. Multi-pane support inside a window (internal `paneId`, visible `paneLabel`, pane split/resize/close lifecycle).
3. Stable read/write targeting by `{surfaceId, paneId}`.
4. **Client-owned pane history routing** — when multiple controllers or OpenClaw sessions target the same pane, each accepted `content.set` creates a distinct entry and becomes visible immediately. The previously visible entry remains in the shared retained Back/Forward pool.

**Phase 2 — Annotation semantics:**
1. Annotation mode UX lock.
2. Live dirty + closed-frame delivery model.
3. Annotation interpretation workflows.

Constraint: annotation semantics in §§13–14 are normative architecture and may be implemented in parallel, but release/priority gating is: Phase 1 topology work (multi-window + multi-pane targeting) must ship before annotation-priority milestones are considered complete.

**Phase 1 done checklist (must all be true):**
1. A single window can be split into multiple panes, each with stable internal `paneId` and a registry-confirmed current visible `paneLabel`.
2. Pane lifecycle exists: create/split, resize, rename, close.
3. All screen-scoped tool operations can target `{surfaceId, paneId}` after resolving human references through `surf_ace_list`.
4. **`paneId` is required** on all pane-scoped tool calls. OpenClaw MUST always specify which pane it is targeting once it has resolved the intended pane from `windowLabel` / `paneLabel`. There is no default-pane fallback.
5. `surfaces.list` enumerates active window surfaces for an endpoint; after pair/resume, `panes.list` and `surf_ace_list` expose pane topology and active content per pane.
6. Content operations are isolated per pane (push/clear in pane A does not mutate pane B).
7. Surfaces require lockless capability, concurrent controller admission, and client-local authority.
8. At least one iOS, one visionOS, and one Electron implementation pass topology tests for pane isolation and routing.
9. History model is active: every accepted `content.set` creates a distinct entry and makes it visible. The prior visible entry enters one shared per-pane pool of at most 20 non-visible Back/Forward entries, evicted by client `lastVisibleSequence` LRU. Surface provides Back/Forward navigation.
10. Annotation reads are pane-scoped at the OpenClaw boundary; any finer-grained history bookkeeping needed for Back/Forward restore is implementation-internal to the surface/provider.

Only after these are true do annotation-priority implementation tasks move to Phase 2.

### 2.4 Extension Architecture

Surf Ace is implemented as its own extension (`extensions/surf-ace/`) within the same monorepo as Clawline. The two extensions are peers — neither imports from the other.

Rules:
1. `extensions/surf-ace/` has no imports from `extensions/clawline/` and vice versa.
2. Any functionality needed by both goes through core internals (`src/`) or a shared utility module, not through cross-extension imports.
3. Surf Ace has its own `openclaw.plugin.json` manifest and registers its own tools and services independently.
4. This boundary is enforced to prevent cross-project leakage and to keep extraction to a true standalone plugin clean if that becomes necessary.
5. Both extensions benefit from monorepo-level access to core internals (`src/`) while this boundary is maintained.

Module boundary: `extensions/surf-ace/` contains the Surf Ace controller runtime — mDNS discovery, WS connection management, local state buffers, and all `surf_ace_*` OpenClaw tools. The corresponding surface-side core module (if needed) lives in `src/surf-ace/`. Neither Clawline nor any other extension imports from these paths.

## 2a. Concepts

Before the protocol details, these terms are used consistently throughout this spec:

**Surface** — a render-target context addressable by stable identity. In v1 multi-window topology, each window is a distinct surface (`surfaceId`) even when hosted by one app instance/device endpoint.

**Window label** — the fleet-allocator-assigned user-visible identifier for a surface window (`a`, `b`, `aa`, ...). `windowLabel` is distinct from `surfaceId` and is `null` until confirmed.

**Pane** — a rendering scope nested inside a surface window. Each pane has a stable internal identity (`paneId`) and lineage. A current fleet allocation may also bind it to a visible coordinate (`paneLabel`) and an allocator-issued `allocationGeneration`; neither is a permanent identity.

**Pane label** — the fleet-allocator-assigned user-visible number for a pane (`1`, `2`, `3`, ...). `paneLabel` is distinct from the client-assigned internal `paneId`. It is unique among current fleet allocations and stays attached to one allocation generation; after that allocation is safely released under §3.1.1.1, the number may be assigned to a new pane. `windowLabel + paneLabel` is a current-topology coordinate, not durable pane identity or target authority.

**Endpoint** — the app/device WS host:port advertised via mDNS. One endpoint may host multiple surfaces (windows).

**Provider/controller capability** — a product component that uses the public Surf Ace WebSocket protocol. OpenClaw supplies a connection-holding extension. Surf Ace supplies the general standalone native `surf-ace` Rust CLI, directly callable by any local program, script, user, or agent; each explicit networked invocation connects directly while stable controller identity, bounded projection, cursors, acknowledgement intents, resume metadata, and unresolved receipt correlations live atomically under its caller-supplied state root. Tight Beam is one separate reusable-skill consumer of those identical executable bytes. Neither form is Surf Ace state, topology, cursor, or retention authority. Standalone use requires no MCP process, dedicated archetype, sidecar, daemon, login item, autostart entry, or persistent service.

**Content** — the item currently displayed in a rendering scope. Content has a type (`html`, `image`, `pdf`, `terminal`, `markdown`, `video`, `canvas`) and a stable payload identity (`contentId`). A window always has one or more panes. Each pane displays one content item independently (scoped internally by `paneId`, displayed to humans via `paneLabel`). OpenClaw pushes content to a target scope and can clear it. Content is distinct from annotations. `video` and `canvas` remain optional protocol content types for forward compatibility; draw-capable OpenClaw workflows can already use normal HTML/SVG content without depending on a dedicated `canvas` wire feature.

**Annotations** — drawing strokes the user has made on top of the current content using the stylus or finger. Annotations are layered over content and persist until an explicit controller operation removes them. Persistent visible and retained-history annotation/restore material is part of CAP-1/CAP-3 pane recoverable-state accounting. Annotations are not content and are not cleared when content changes unless the spec says so.

**Event** — a user interaction reported by the surface to admitted controllers over the WS socket (drawing flush, tap, selection, page turn, navigation, scroll, snapshot hint). Consumable records are retained authoritatively in bounded client scopes and projected asynchronously into bounded controller caches.

**Local buffer** — a bounded controller-side read projection populated from client-authoritative consumable scopes. OpenClaw maintains it asynchronously over its background connection; the standalone `surf-ace` CLI reconciles it during explicit networked invocations for every caller, including Tight Beam. Ordinary reads consume only this projection and never trigger a network call. The projection is not cursor, pending, overflow, or unread authority.

**Connection job** — OpenClaw's per-surface background process that maintains the WS connection, runs the pair handshake, handles reconnect, and syncs local state. The standalone CLI has no corresponding resident process: `surf-ace` performs pair/resume, reconciliation, requested network work, and orderly disconnect inside each explicit networked invocation while holding its cross-process state lock. This is identical for every caller, including Tight Beam. Both forms are fully opaque to OpenClaw.

**Pane history** — the client-managed Back/Forward model for a pane. The visible entry is separate from one shared per-pane pool of at most 20 retained non-visible entries across Back and Forward. Every accepted push creates a distinct client-identified entry and becomes visible. The client assigns `lastVisibleSequence` whenever an entry becomes visible and evicts the non-visible entry with the smallest sequence when the pool exceeds 20. Navigating Back then receiving a new push removes the Forward branch before LRU enforcement. Entries retain their own content revision, provenance, and annotation/restore state.

## Core Invariants

These are normative, settled statements about Surf Ace behavior. Implementations MUST conform to every invariant listed here. These statements are not subject to the open topics in `## Open Topics`.

1. **WebSocket-only transport.** All provider↔surface communication runs over the public WebSocket protocol. The provider is the WS client; the surface app runs the WS server. There is no REST API. OpenClaw holds its socket persistently; the general standalone `surf-ace` CLI connects directly only for each explicit networked invocation, regardless of caller.
2. **Lockless client-local authority.** A client advertising the required T1770 lockless capability admits multiple controllers concurrently. No provider, controller, product, chat, or identity owns a client, surface, window, pane, history entry, unread record, tombstone, mutation, or restore right. Every surface mutation traverses one client-owned ordered seam and all admission, ordering, validation, capacity, retention, close, restore, and reclamation rules are identity-independent. A client without the capability is not admitted.
3. **Continued display and local use.** Connection state or failure of an unrelated registry, discovery, writer, witness, or local listener MUST NOT clear, reload, renumber, close, or make existing client-owned content, layout, scroll, annotation, and independent local interaction unavailable. Content changes only through an accepted explicit content operation. Restored display does not wait for a network listener or registry registration. A capability that actually needs a failed dependency reports that limitation without disabling other panes or operations; no unavailable hardware, OS-suspended execution, unproved durable write, or unauthorized action is fabricated.
4. **Reads are local-only projections.** Ordinary reads use the controller's bounded local projection and never synchronously contact a surface. The client remains authoritative for bounded consumable scopes, per-controller cursor floors, pending truth, and structured gaps; a local read durably queues an idempotent acknowledgement. The existing connection job delivers it in the background; `surf-ace` delivers it during the next explicit networked CLI invocation for any standalone caller. This client-consumable acknowledgement remains separate from the server-journal consumer acknowledgement in §4.10.
5. **Panes are always present.** Every surface window has one or more panes at all times. There are no separate "single-pane mode" and "multi-pane mode" — pane routing is always active. Each pane has a stable internal `paneId`. Its visible `paneLabel`, when present, is allocated durably by the fleet registry and is unique among current fleet allocations. A label remains bound to its allocation generation until the exact allocation is safely released under §3.1.1.1; only then may that number be allocated to a new pane. Existing panes are never renumbered. Without allocator confirmation the pane shows no number. OpenClaw resolves new human references through `surf_ace_list` using the current `windowLabel` / `paneLabel`, then targets the pane explicitly by `paneId`; durable and historical references bind stable pane identity and allocation generation, not a number alone. Keyboard focus is a local input affordance only; it does not create default-pane routing or default-pane resolution.
6. **One visible entry with shared history.** Each pane shows one entry at a time. Every accepted push creates a distinct client-identified entry, becomes visible, and moves the previously visible entry into the shared retained pool. Back and Forward use one cross-controller 20-entry non-visible LRU pool; controller identity never creates replacement-in-place, quota, pinning, priority, or eviction preference.
7. **Connection-context identity.** The adapter supplies its asserted stable controller instance ID at admission and the client binds operations to that admitted socket context. OpenClaw does not pass controller/session identity on individual operation payloads, and friendly provenance is never authentication.
8. **Direct client events remain always-on.** Once paired, the surface emits the §7 event set continuously without a surface-side subscribe/unsubscribe API. The separate registry annotation journal subscription in §4.10 neither gates nor changes this direct client stream.
9. **Annotation mode locks the viewport.** When annotation mode is active, scroll is disabled and link following is disabled. The drawing layer captures all touch and stylus input until annotation mode exits.
10. **Client-allocated content revisions.** Accepted append-style content operations traverse the client mutation seam; the client allocates the next content revision and a new history-entry ID atomically. Controllers do not submit authoritative content revisions or history-owner tokens.
11. **Annotation reads are pane-scoped at the OpenClaw boundary.** `surf_ace_read` and related OpenClaw-facing operations target a pane only. Surfaces/providers may keep any additional history restore state internally, but OpenClaw does not pass or track history identifiers.
12. **Lifecycle events are always-on.** Surface lifecycle events (`event.surface_appeared`, `event.surface_removed`, `event.surface_resumed`), pane lifecycle events (`event.pane_created`, `event.pane_removed`, `event.pane_renamed`), and registry label confirmation (`event.fleet_labels_confirmed`) are never profile-gated. Lockless committed content/history/topology/lifecycle events fan out to every admitted controller for the affected surface; cursor-specific availability/overflow signals target only the affected controller without conferring authority.
13. **Platform target floor policy.** Surf Ace targets the newest released OS major version as the minimum deployment target (current decision: iOS/iPadOS 27 and visionOS 27; any native macOS surface target uses macOS 27).
14. **Portable extension packaging.** Surf Ace MUST remain buildable as a standalone OpenClaw extension bundle without requiring Clawline as a dependency or core patches. Provider startup, provider deployment, and persistent Surf Ace launchd/auto-start installation require explicit validated host configuration. Each operation fails before mutation when its configuration is absent, malformed, or excludes the current destination.
15. **Durable fleet binding that never strands a client.** A client accepts registration and label results only from a registry whose stable `(fleetId, allocatorId)` identity matches the binding it holds at that moment. Endpoint, hostname, discovery instance, or matching labels alone do not establish that identity. A client without a binding, including a fresh install and an upgraded client with saved state of any age, binds automatically to a discovered registry that reports a valid identity and registers; no saved state blocks that. A bound client reconnects automatically to its matching registry wherever it is discovered. A bound client whose registry is no longer discoverable moves to a valid discovered registry, optionally after a short wait. Saved state the client cannot reconcile is recovered automatically under §3.1.2: the content and layout the client can read are kept, labels the registry can honor are kept, and fresh registry labels are taken otherwise; a claim or release the registry will not accept is dropped without losing content. Connecting never requires a manually provisioned file, owner verification, or user action.
16. **FAST command-to-visible-client effect.** Every feature MUST keep the path from an accepted command to its visible client effect fast. Ordinary restore/recovery MUST NOT require screenshots or full-pane visual captures. Ordinary mutations MUST NOT repeatedly copy, serialize, or measure whole authority/window/pane payloads for quota admission, or refuse accepted semantic content because of fixed recoverable-state byte caps. Keep the single atomic durability commit needed for recoverable content, history, unread annotation frames, and stable identities; remove redundant captures, copies, serialization, and repeated persistence around it. Recover panes and windows lost to involuntary loss, and in 0.2.10-rc1 closed panes, from retained URL or HTML/source content and semantic state under §4.7/§4.8; in later releases an explicit close is final under §4.7.1. This invariant introduces no benchmark, timing threshold, or performance acceptance gate.


## 3. Transport and Discovery

### 3.1 Discovery

Surfaces continue advertising `_surf-ace._tcp` over Bonjour/mDNS.

**CORE INVARIANT — ADVERTISED ADDRESS REACHABILITY (Mike, ruled 2026-10-05):** Every advertised address must be reachable and work.

#### 3.1.1 Multi-Window, Multi-Pane, and History Topology (iPad + Electron)

A single app instance may host multiple surface windows simultaneously. Each window is an independent Surf Ace surface. Within each window, one or more panes provide independent content and annotation contexts. Within each pane, one or more history entries allow multiple OpenClaw sessions to coexist without overwriting each other.

**Topology hierarchy:** Surface (`surfaceId`) → Window (`windowLabel`) → Pane (`paneId` internal, `paneLabel` visible) → Content (history-stacked)

> **Phasing note:** History navigation is Phase 1 scope — it ships alongside multi-pane topology, before any annotation-semantics work (Phase 2). See §2.3 for the full phasing plan.

Window rules:
1. Each window has its own stable `surfaceId` and independent local state (capture frame queue, taps, selection, scroll, etc.).
2. The app advertises one device endpoint over mDNS (one host/port), not one mDNS record per window.
3. Windows are enumerated in-band over WS (`surfaces.list`) and can appear/disappear at runtime (`event.surface_appeared`, `event.surface_removed`).
4. Each admitted controller may maintain one active WS session per target window/surface, even when multiple windows share one endpoint.
5. Creating/removing a window does not require mDNS rebroadcast; only app endpoint lifecycle affects mDNS advertisement/goodbye.
6. On iPadOS, each Surf Ace scene MUST occupy the full device extent in landscape and portrait. The app MUST opt out of iPad multitasking/Stage Manager compatibility sizing when needed so the system does not hand Surf Ace a narrow letterboxed or resized scene. Reported viewport, visible content, pane geometry, and chrome must all derive from the same full-size scene.
7. In 0.2.10-rc1, closing a window removes it from the live projection but atomically creates a recoverable surface tombstone before `event.surface_removed` and socket closure. In later releases, an explicit window close is final under §4.7.1, and a window lost to involuntary loss stays restorable. The endpoint lifecycle seam remains discoverable with zero live surfaces, and `surfaces.list` exposes the authoritative live/tombstone state required for restore.

Pane rules (Phase 1 committed work, see §2.3):
1. Each window may contain one or more panes, each with a stable internal numeric `paneId` and a registry-confirmed current visible numeric `paneLabel`.
2. `paneId` is the internal routing key. `paneLabel` is the user-visible addressing token shown on the surface.
3. Each pane has independent content, capture frame queue, taps, selection, scroll, and annotation state.
4. All screen-scoped OpenClaw tools target `{ surfaceId, paneId }`. `paneId` is **required**. OpenClaw first resolves the intended pane from `windowLabel` / `paneLabel` via `surf_ace_list`, then keeps using internal `paneId`.
5. Pane lifecycle (create/split/resize/rename/close) is managed in-band; pane changes do not affect window-level session or mDNS state.
6. **Local divider drag:** During a native touch or pointer resize, the client MAY render intermediate split weights locally for immediate feedback. Those positions are provisional: they do not increment topology revision, become durable, or produce committed lifecycle events. One successful gesture end commits the final weights as one client-authoritative topology mutation and then emits the matching topology event; a no-op end makes no mutation or event. Gesture cancellation, interruption, or process loss before that commit restores the last committed topology. If the final commit fails, existing panes and content remain usable, the provisional layout is reconciled to committed state, and compact status truthfully indicates the unsaved change. A completed gesture must serialize behind earlier local mutations and revalidate the targeted split against current authoritative topology; a stale preview must never replace a newer split or be replayed after restart. This follows Mike's responsive iPad resize request and the product ruling on its semantics.

Naming system:

> **CORE INVARIANT — FLEET-UNIQUE WINDOW LABELS (Mike, ruled 2026-09-03).**
> A window label is unique across the ENTIRE FLEET, not merely within one
> client. Two windows on two different machines MUST NEVER both be labelled
> `a`. This is a product requirement, not an implementation preference, and it
> is not subject to the Open Topics section.
>
> Source, the original Surf Ace specification (commit 236a999, §15.1):
> "Each window is assigned a short alphabetic identifier using an
> auto-incrementing sequence: A, B, C … Z, AA, AB, …" and "The window label is
> the primary addressing handle. It MUST be visible at all times so that a user
> can tell CLU 'move content to window B' without ambiguity."
>
> These two sentences together REQUIRE a single allocator. An auto-incrementing
> sequence is one counter; N independent clients each running their own counter
> are N sequences, and N sequences over one symbol set produce duplicate labels.
> Duplicate labels make "move content to window B" ambiguous, which §15.1
> forbids. Therefore fleet-wide label allocation MUST be owned by exactly one
> authority.
>
> Consequences that are also normative:
> - Exactly one label allocator exists fleet-wide. It persists across client
>   restarts so that a window keeps its label.
> - A client that cannot obtain a label from the allocator DISPLAYS NO LABEL and
>   is not addressable. A provisional, local, or optimistic label is FORBIDDEN:
>   showing a possibly-duplicate label is worse than showing none, because the
>   user directs content at it and it lands on the wrong screen.
> - Host-qualifying the token (`studio-mac b1`) does NOT satisfy this requirement.
>   The addressing token must remain a short alphabetic label because it is
>   spoken aloud, including through a voice interface, where a hostname is far
>   more error-prone than a single letter.
> - Per-client uniqueness does NOT satisfy this requirement.
>
> Historical note. This requirement has been EXPLICIT in the specification since
> `236a999`. It was never implicit and was never merely spoken. The OpenClaw
> provider satisfied it because exactly one provider process held the surface map
> and the label counter for every client it managed. The CLI rewrite removed that
> process without replacing the allocator, and this document was then amended to
> say labels are "not globally unique" - a clause that directly contradicted
> section 15.1 while section 15.1 was still in the repository saying the opposite.
> Later reviews validated the code against the newer contradicting clause instead
> of against the original requirement, and no test asserted it, so every soak
> passed. The reduction was never authorized by anyone entitled to authorize it.

1. **Window labels** (a, b, c … z, aa, ab …) are allocated and persisted by the
   single fleet-wide label allocator, then validated and projected by the client.
   Allocation is NOT client-local; see the core invariant above.
2. `windowLabel` is a visible coordinate for users and diagnostics, not durable target authority. In 0.2.10-rc1, the client may preserve it across ordinary reconnect and recoverable close/restore when still valid and unassigned; otherwise the registry allocates a new unique live label without changing surface identity or preserved state. In later releases, a surface that has not been finally closed keeps the window letter and allocation generation confirmed under its current binding across reconnect, involuntary loss and restore (§4.7.1 FC-4), and the registry does not allocate it a new letter; only a final close releases that letter (§4.7.1 FC-3). A letter held from before a new binding follows the new-binding label exception of §3.1.2 item 4. A surface whose letter was never confirmed keeps `windowLabel` as `null` until the allocator confirms one.
3. **Pane IDs** are allocated by the **client-local authority**. They are stable internal routing identifiers. Controllers target existing stable IDs or submit pane-creating intent; they do not preallocate new pane IDs.
4. **Pane labels** are allocated and durably persisted by the single fleet-wide allocator, which also allocates window letters. Every current allocation has one fleet-unique visible pane number and one allocator-issued `allocationGeneration`. A number remains bound to that generation until exact safe release under §3.1.1.1, after which it may be allocated to a new pane. Pane labels confirmed under a client's current binding never change; labels held from before a new binding follow the new-binding label exception of §3.1.2 item 4. The client validates and projects only allocator-confirmed pane numbers. A pane without an allocator-confirmed number displays no number; it never substitutes a client-local guess. `paneLabel` and `displayId` / `paneAddress` are current-topology coordinates, not durable target authority.
5. **Pane names** are assigned by the extension via `pane.rename`. There is no user-facing rename UI. Pane names are optional metadata and MUST NOT replace `paneLabel` as the visible fleet coordinate.
6. The client is the sole authority on topology and internal pane IDs. The fleet registry is the sole authority on visible window letters and pane allocations. Controllers submit intent against stable IDs and expected revisions; the client validates and commits client-local topology and emits lifecycle events after that local commit. Allocator confirmation is a distinct monotonic identity transition: a pending visible label is not a confirmed fleet-wide coordinate. A pane label and generation confirmed under the client's current binding stay attached through disconnection, involuntary loss and restore, and in 0.2.10-rc1 through ordinary recoverable close/restore; disconnection alone never releases them, and in later releases only a final close under §4.7.1 does (labels held from before a new binding: §3.1.2 item 4). A pending `windowLabel` or `paneLabel` is represented as `null`, never as an empty string, zero, or a provisional fleet coordinate.
7. When a pane is split, the controller specifies the target, count, and layout intent. After the stale-revision and pane-creation capacity checks, the client allocates each new `paneId` and commits the local split atomically. The registry may confirm each new pane allocation before or after that local commit; without confirmation, a new pane displays no number and remains usable by stable internal identity. Reconnection of a non-retired pane under the same binding claims the same identity, label, and allocation generation once, preserves its content, and rejects a conflicting pane ID or generation for an already claimed lineage. A terminally retired identity cannot be claimed again; explicit reopen uses a new pane identity and lineage. Any operation requiring a confirmed fleet-wide coordinate reports a pending-label limitation rather than targeting another pane.
8. **Initial surface state:** A newly opened surface starts with one client-allocated internal pane identity. The fleet registry allocates its window letter and pane number. Until confirmed, the surface displays a small pending-label indication but no unassigned letter or number. OpenClaw MUST call `surf_ace_list` before any pane-scoped operation and MUST accept a valid post-restore live pane count above `maxPanesPerSurface`.
9. Labels are displayed on the surface — window identity immediately precedes the pane label as a bottom-right floating overlay within each pane. The window identity is uppercase text inside a rounded-rectangle outline, followed by the plain pane number, e.g. an outlined `A` box next to `12`. See §15.1 for visibility rules.

##### 3.1.1.1 Pane-label allocation, retirement, and safe reuse

This specification follows Mike's pane-label reuse ruling and the product rulings on label-reuse policy and terminal retirement that followed it. The terms below are conceptual durable-model names, not proposed protocol fields or CLI members. This changes no discovery, pairing, direct-endpoint selection, or no-pair behavior. It defines allocator/client behavior; it does not define a wire encoding, change the current allocator implementation, or enable reuse by itself. Any implementation must be separately reviewed and must keep reuse disabled until the compatibility and restore gates below are met. In releases after 0.2.10-rc1, Mike's explicit-close ruling makes an explicit pane or window close a terminal retirement under §4.7.1, which releases its number or letter through items 3–4 and the gates in items 7–9.

1. **Allocation identity and generation.** An allocation binds the complete stable identity `(fleetId, allocatorId, clientId, surfaceId, paneId, paneLineageId)` to a `paneLabel` and an allocator-issued `allocationGeneration`. The generation is a positive, strictly increasing fence within the allocator lineage, never reset or reused by retry, reconnect, restore, backup, or rollback. It distinguishes successive allocations of the same number and is not an authentication credential. A retry or reconnect for the same active identity returns its exact label and generation. A new pane identity receives a new generation, even when its label has never been used before.
2. **Lowest safely available number.** Under one serialized fleet allocator, a new pane receives the lowest positive number for which the complete durable allocation history proves either that the number has never been claimed in this allocator lineage, or that every earlier allocation of it has an exact durable release and no live, recoverable, offline, saved, legacy, or unknown claim reserves it. The allocator then durably records the new allocation and generation before confirmation. Existing panes keep their current labels and generations; allocation never compacts, renumbers, or moves a label between existing panes. The high-water fence remains monotonic and is not, by itself, evidence that a missing number is safe. Gaps in an incomplete journal, legacy projection, or uncertain restore remain reserved; absent proof, keep the existing monotonic allocation behavior and do not infer a free number.
3. **Interim close is recoverable; final close and retirement are terminal.** In 0.2.10-rc1, ordinary pane close creates the durable recoverable tombstone required by §4.7 and keeps that pane's label and generation reserved, and surface/window close is not a retirement trigger. In later releases, an explicit pane or window close is a terminal retirement at close commit under §4.7.1. In every release, a disconnect, hide, process quit, crash, restart, missing registry row, lease expiry, or elapsed time is never a retirement trigger. Removing retained count and encoded byte quotas removes quota-driven automatic retirement. Retained pane and surface tombstones keep their restore rights and label/generation reservations; the 0.2.10-rc1 interim contract authorizes no replacement retirement trigger. For later releases, Mike's explicit-close ruling settles closed-label reuse timing: release follows the final close commit (§4.7.1). Any independently authorized terminal retirement must still remove the final restore path and commit the exact generation-verified retirement audit and release intent atomically before allocator release. A pane is never retired merely to free a number. Each surface tombstone keeps the fresh `closedSequence` assigned when that surface closes; any nested pane tombstones preserve their original `closedSequence` as metadata and do not move the parent ahead of older unrelated tombstones. Reclaiming a retained surface tombstone retires each nested generation-verified pane identity whose sole remaining restore path is inside that surface; every such pane remains reserved while the surface tombstone is retained. An unverifiable legacy claim remains reserved under item 6 and receives no allocator release. For every retired allocation, the transaction records a durable identity audit binding the exact pane identity, label, allocation generation, source tombstone kind and ID, committed close/topology revision, and terminal-retirement revision, plus the required release intent. This audit survives removal of tombstone content and is checked on restore. Retained history follows existing retention rules; this adds no history-retention promise or separate permanent-delete operation. A same-identity reopen is refused after retirement; an explicit reopen creates a new `paneId` and `paneLineageId`. Restore and reclamation share the client FIFO: if restore commits first, the pane is live and that tombstone cannot be reclaimed or released; if reclamation commits first, same-identity restore refuses and the audit prevents stale backup replay. An unknown client commit remains pending readback and keeps the label reserved.
4. **Allocator release fence.** Only after the client has durably committed the retirement audit and release intent with tombstone removal may the allocator release that exact allocation. Release evidence and the durable release record bind the complete allocation identity, label, generation, source tombstone kind and ID, committed close/topology revision, terminal-retirement revision, and an idempotency key. The committed close/topology revision, carried as `closeRevision` in release evidence, is the surface topology revision the close commit produced (the post-close `topologyRevision`), never the revision the close was admitted against. Every final close advances the surface topology revision exactly once from a revision of at least 0 (FC-1, FC-2), so a valid committed close/topology revision is always at least 1, including the first close of a fresh surface from 0 to 1; the allocator refuses a lower value as a wrong-revision release and has no path that accepts 0. *Source:* the October 23, 2026 product ruling on the close revision: "closeRevision is the topology revision the close COMMITTED, i.e. the post-close value", "a valid closeRevision is always at least 1, including the first close of a fresh surface (0 -> 1)", and "add no zero-acceptance branch." The allocator verifies the current active allocation matches every field and appends the release atomically under fleet serialization; a release retry with identical evidence is idempotent. A delayed, duplicate-with-different-evidence, wrong-owner, wrong-lineage, wrong-generation, wrong-tombstone, wrong-tombstone-kind, or wrong-revision release is refused and cannot free a number. A transport acknowledgement is not proof of client durability. If the client reclamation transaction or allocator release persistence is unknown, the number remains reserved until authoritative durable readback resolves the exact retirement intent and release records; uncertain outcomes never authorize reuse.
5. **History and stale references.** Durable pane references MUST bind the stable identity and allocation generation; a label or `windowLabel + paneLabel` alone is not identity. A reference to an older generation continues to identify that pane's retained history when available, or resolves as closed/stale/unavailable; it MUST NOT follow the number to a later occupant. A current number-only user selection is resolved only against a fresh authoritative live topology. A saved or historical number-only link becomes ambiguous once its number has more than one generation and requires a fresh selection; it MUST NOT silently target the latest occupant. UI history distinguishes allocations by stable identity/generation and live versus closed state even when displayed numbers repeat.
6. **Offline, saved, unknown, and legacy claims.** A live pane remains reserved while its client is offline or saved for restore. A claim that might exist because of incomplete journal coverage, an unknown persistence outcome, or missing authority remains reserved. A legacy claim without an allocation generation remains reserved and cannot be released by a generation-unaware client or inferred from a missing active row. Such a claim becomes eligible only after the registry holds its exact identity and generation, for example after the owning client registers that live identity under §3.1.2, or an owner-verified terminal retirement proves that no legacy restore path can reactivate it; reclamation of an unverifiable legacy tombstone alone is not that proof. Unknown, saved, offline, or legacy state never participates in lowest-number selection as a free gap.
7. **Reconnect, backup restore, and allocator recovery.** Reconnect and ordinary restore of a non-retired identity preserve the exact label/generation pair. Allocator restore verifies allocator identity, hash-bound journal continuity, and a witnessed head, then replays every later allocation and release before exposing availability; it reconstructs per-number generations and preserves monotonic label and generation fences. A snapshot that omits a newer release/reuse record cannot be activated as allocator authority. The client keeps the terminal-retirement identity audit outside reclaimable tombstone/content state and checks it before projecting any rollback-capable backup claim. If the backup predates terminal retirement or cannot prove it is current, the stale pane is history-only and displays no current label; it cannot resurrect the retired identity or overwrite a newer generation. If the required journal or client restore fence is unavailable, reuse stays disabled and affected labels remain reserved.
8. **Mixed-version gate and rollback.** Reuse MUST remain disabled until the allocator, every client that may reconnect or restore, all supported backup readers, and every durable reference resolver can preserve and enforce allocation generations and terminal-retirement fences. For a release on final close under §4.7.1, this gate is met for one allocation when the allocator and the client that owns that allocation enforce them; an allocation binds its `clientId`, so another client's version cannot claim or revive it. Offline/saved clients and unresolved legacy claims count as potentially restorable versions and reserve their labels until migrated or retired with proof. Rollback may disable future reuse but MUST preserve the append-only allocation/release history and monotonic fences. A downgrade or snapshot that ignores generations, can revive a released identity, or truncates a later release/reuse record is forbidden. If compatibility cannot be proved, keep reuse off and use a forward fix; do not roll back past the generation fence.
9. **Implementation test gate.** The accompanying allocator reference model is a specification aid only; it does not establish production allocator, client, migration, or restore conformance. Before any release enables reuse, implementation changes MUST add release-gated positive and negative integration coverage for claim/release fencing, reconnect, client and allocator backup restore, mixed versions, and rollback. This spec-only change makes no SQL, wire, client, CLI, runtime, live-allocation, or label mutation.

#### 3.1.2 Fleet and Allocator Identity Binding

Fleet-wide labels are meaningful only within the registry and allocator lineage that issued them. This section defines the identity boundary for discovery, registration, and label confirmation, and how a client recovers when its saved state does not match the discovered registry. The binding contract has these product requirements for upgraded and freshly installed clients. An upgraded client connects to the current registry automatically, without manual provisioned-binding files. It keeps its old window labels when the registry can honor them and otherwise takes fresh labels; refusing to connect is not acceptable. No saved client state, of any age, may leave a client unable to connect: where the client cannot reconcile what it has saved with the registry, it recovers on its own and connects. A fresh install connecting cleanly is a required result. A bound client whose registry is gone moves to the valid registry it can discover. For saved state, the client drops partial, unknown or retired claims that the registry will not accept and carries on; where local state is unreadable, it keeps whatever window and pane content can be read and starts the rest fresh. Losing labels or claims is acceptable; losing the user's content is not, and the client always connects. The scope is accidental isolation between distinct fleets; these identifiers are not credentials and do not claim protection against an adversarial registry or client.

Terms. A **valid identity pair** is a registry response carrying both a well-formed `fleetId` and a well-formed `allocatorId`. A **binding** is the durable record of the pair a client registers with, stored with the client's existing client identity. **Binding** a client means durably writing that record; **rebinding** means durably replacing it. A binding is **new** from its durable write until the first registration under it succeeds; that state survives restart. **Pre-binding labels** are window letters, pane numbers, and allocation generations, wherever the client holds them (live topology, tombstones, durable references, allocation references, and release evidence), that were confirmed before the client's current binding; for a client that has never held a binding, every saved label is a pre-binding label. A **release intent** is the durable release evidence of §3.1.1.1(4) that the client delivers under §4.7.1 FC-3 and FC-6. A release intent or claim is **refused** when the registry rejects a registration that carries it and accepts the same registration without it; examples are a release for an allocation that is not the registry's active allocation or already carries different evidence, and a claim for a terminally retired identity or one that conflicts with the registry's history for that client. A rejection that also occurs without that item, such as an inactive fleet or incomplete journal, is a condition of the registry, not a refusal of the item; a rejection or lost response whose cause the client has not yet isolated is an **unknown outcome**. A **discovered registry** is a registry reached at an explicitly configured registry address, or a `_surf-ace._tcp` advertisement whose TXT record carries `role=server`, `v=1`, and `ws=/ws`, the filter client discovery already applies. An advertisement without `role=server`, such as a surface's own advertisement, is not a registry and never causes binding, rebinding, or registration. This section adds no discovery mechanism.

1. **Stable identity.** Each registry exposes a non-secret, stable `fleetId` for its configured fleet and a non-secret, stable `allocatorId` for the durable window/pane label-allocation lineage. The pair is the registry identity. Both `fleet.topology` and `client.register` responses include both identifiers. A registry restart, database restore that preserves allocator continuity, address change, or endpoint rediscovery does not by itself change either identifier. Pane `allocationGeneration` is scoped to this allocator lineage and does not replace the stable identity pair.
2. **Matching bindings.** A client with a binding accepts authoritative registration or label results only from a registry whose complete identity pair exactly matches the stored pair. It checks the read-only `fleet.topology` identity before any mutating registration or label claim, and checks the `client.register` identity before applying any returned label. Missing identity fields, a different fleet, or a different allocator is a mismatch. The client does not register or claim against a known mismatch, apply labels from a mismatched response, or infer authority from hostname, endpoint, Bonjour instance name, window letter, pane number, or label equality. A response whose identity is missing or differs is refused and leaves the binding and all client-owned state unchanged; recovery from a mismatch happens only through item 6.
3. **Automatic initial binding.** When a client has no binding and a discovered registry reports a valid identity pair, the client SHALL bind to that pair and register, whatever saved labels, confirmation markers, tombstones, or local letters it holds. A fresh install, an upgraded client whose labels were confirmed before bindings existed, and a client whose saved surfaces predate confirmation markers all follow this rule. The client does not classify its saved state to decide whether it may connect, and binding needs no provisioned file, owner verification, or user action. The client persists the binding before applying any label from that registry. *Source:* "connect to the current registry automatically without manual provisioned-binding files" and "Treat a fresh install connecting cleanly as a required result." *Acceptance:* a fresh install with one open window, and an upgraded client showing window `C` with pane `7` and no binding, each register on their first connection to a reachable registry with no provisioned file present, and each has a durable binding before its first registry label appears.
4. **Labels under a new binding.** On every registration under a new binding, the client SHALL send its stable client, surface, pane, and lineage identities and SHALL NOT send pre-binding labels or generations as allocation references. The registry returns its existing allocation for any identity it already holds for that client, so labels the registry can honor are kept, and allocates a fresh label for every other identity. The client applies the returned window letters, pane numbers, and generations as the labels confirmed under its binding. Until that registration succeeds, every surface and pane shows the pending-label indication of §3.1.1 item 8 and reports its label as `null` under §3.1.1 item 6; a pre-binding label is never displayed or reported as a fleet coordinate. *New-binding label exception:* §3.1.1 items 2, 4, 6, and 7, §4.7.1 FC-4 and non-goals, and the restore rule of §4.8 "Recoverable content and restart" preserve labels and generations confirmed under the client's current binding. Pre-binding labels are not confirmed under a new binding: the client keeps them as historical metadata only, and the labels the registry returns replace them. The exception applies only to a new binding. Once the first registration under a binding succeeds, every label it confirmed is preserved under the retained rules, and ordinary reconnect, restart, involuntary loss, and restore against the same registry never renumber. A retained restorable tombstone keeps its stable identity and restore right; a pre-binding label it holds is historical, and its restore under the new binding takes the label the registry returns for that same identity. A durable reference that binds a pre-binding generation still identifies the same stable identity and its retained history under §3.1.1.1(5); it is never a current coordinate and never follows a number to a later occupant. Content, layout, and stable identities do not change; only visible labels may. This item needs no registry change: the registry keys allocations on client and surface, pane, and lineage identity, and an allocation reference that carries no label or generation cannot be refused as stale. *Source:* "preserve old window labels when the registry can honor them, otherwise fresh labels are acceptable; refusal to connect is not." *Acceptance:* (i) a registry that already holds `c` and pane `7` for the client's surface and pane identities leaves the client showing `C 7`; (ii) a registry with no record of the client gives it fresh labels, for example `A 1`, with the same panes, content, and pane identities; (iii) neither case produces a refused registration for a stale allocation reference; (iv) until the registration answers, that window shows the pending-label indication and neither `C` nor `7`; (v) after registering as `A 1` and then crashing, the client relaunches showing `A 1`.
5. **What the registry will not accept.** Under any binding, when the registry refuses a saved release intent or claim, the client SHALL drop that intent or claim, keep the content it concerns, and register everything else. The client isolates which item was refused, for example by registering subsets, before dropping anything; a failed registration that carried several items is not a refusal of each of them. A release intent that completed during an earlier failed request completes again on its identical-evidence retry (§3.1.1.1(4)) and is not refused.
   - (a) *Refused release intent.* The client stops delivering it. The closed pane or window stays closed, no restore path returns, and the client releases nothing in its place. Release evidence from an earlier binding to a different registry is not refused and is not discarded: on rebinding the client keeps it, does not deliver it to the new registry, and never lets it block registration with that registry; it stays held without delivery, and the client adds no mechanism to deliver it later. A refused release and release evidence held this way are the only exceptions to delivery until accepted under §4.7.1 FC-3 and FC-6.
   - (b) *Refused claim for a live surface or pane.* The client keeps the surface or pane live, with its content and position, under a new identity and lineage, as an explicit reopen does (§3.1.1 item 7), and registers the new identity, which takes a fresh label. The refused identity is never claimed again. A surface that takes a new identity registers its panes under it; a pane claim that is then refused follows this same rule. The client's local terminal-retirement check of §3.1.1.1(7) still applies before any claim; this rule covers refusals the client could not foresee.
   - (c) *Unknown outcomes are retried.* A release intent or claim with an unknown outcome is not dropped. A release stays pending with its number or letter reserved and is delivered under FC-3 and FC-6; while it is pending, the client registers its other live identities whenever the registry accepts a registration without it, and otherwise retries until the registry's own condition clears. Pending release evidence from an earlier binding to a different registry follows item 5(a) instead.

   *Source:* "Partial, unknown or retired claims: drop what the registry will not accept and carry on" and "Losing labels or claims is acceptable; losing the user's content is not, and the client always connects." *Acceptance:* (i) an upgraded client holds release intent `r1` for window `b`, which matches the registry's active allocation, and `r2` for pane `9`, which the registry has no active allocation for, sent in that order. `r1` completes, `r2` is dropped, the client registers, a later registration releases nothing further, and `b` is free for the next new window. (ii) A client restored from an older backup holds window `d` live, and the registry refuses `d`'s surface identity as terminally retired. `d` stays open with its content and panes and a fresh letter, and the client's other windows keep their labels. (iii) A release whose outcome is unknown stays pending with its number reserved. Against a registry that accepts a registration without it, the client registers its live windows and keeps retrying the release; against a registry that rejects every registration because its journal is incomplete, the client retries automatically and registers once that condition clears. In both cases the release is delivered once the registry accepts it, and it is never dropped for the registry's condition.
6. **Reconnect and replacement.** (a) Discovery follows the stored binding across endpoint and address changes and process restarts. When any discovered registry matches the stored pair, the client uses that registry, reconnects automatically, and keeps its client identity, content, and each non-retired pane's exact confirmed label and generation. (b) When the client holds a binding, no discovered registry matches it, and a discovered registry reports a valid identity pair, the client SHALL rebind to that pair and register under items 4 and 5. The client MAY first wait a fixed, finite interval of its choosing from when its bound registry was last seen; if the bound registry reappears within that interval the client stays with it, and otherwise it rebinds when the interval ends. The wait is a delay, not a separate client mode. The client rebinds durably before applying any label from the new registry and does not reset content, layout, or identities. A response missing an identity field is not a valid pair and never causes rebinding. Once rebound, the client follows item 6(a) for the new binding and does not return to the earlier registry on its own. *Source:* "A bound client whose registry is gone moves to the valid registry it can discover" and "If moving on a brief outage is a practical concern, waiting a reasonable while before moving is acceptable. Do not let it become a new state machine." *Acceptance:* (a) a client bound to registry R1 whose registry moves to a new address and restarts reconnects to R1 with the same labels; (b) a client bound to R1 and showing `B 3`, with only registry R2 discoverable, registers with R2 once any wait interval ends and shows R2's labels with the same content and identities. Once rebound to R2, it stays with R2 while R2 is discoverable, even if R1 reappears. If R1 reappears before the interval ends, the client keeps R1 and its labels.
7. **No permanent refusal from saved state.** If a client's saved state cannot be reconciled with the discovered registry or with its own durable store, the client SHALL resolve the conflict itself and register; it MUST NOT stay refused until a person intervenes. An interrupted or ambiguous binding write is resolved by reading durable state: a durable binding is used under items 2 and 6, and if none is durable the client writes the binding again. Provisioned binding files, migration receipts, and confirmation markers from earlier releases are never required and never block binding. Saved state is **unreadable** when its bytes are present but cannot be decoded or validated; a read that does not complete is retried, not treated as unreadable. The client SHALL restore every window and pane it can read, with its content, layout, and identities, under the ordinary rules, and SHALL start fresh whatever it cannot read: if the client identity cannot be read, the client starts with a new client identity and binds under item 3, and if no window can be read, it opens one fresh window as a fresh install does. Labels, claims, and release intents held only in unreadable bytes may be lost. The client never loads live state or takes an identity from unreadable bytes. A claim the registry refuses afterwards follows item 5. A client stays unregistered only while local storage cannot accept the binding write, the registry rejects every registration for a condition of its own, or no discovered registry reports a valid identity pair (for a bound client, also during the wait of item 6(b)). It retries automatically when the condition clears. Local and direct use continue meanwhile. This item replaces the earlier one-time owner-verified legacy migration and owner-verified migration of unconfirmed window letters; no client path consults them. *Source:* "Where the client cannot reconcile what it has saved with the registry, it recovers on its own and connects" and "Unreadable local state: keep whatever window and pane content can be read and start the rest fresh." *Acceptance:* a client whose binding write was interrupted registers on a later connection attempt without user action. A client with three saved windows, one of whose saved records cannot be decoded, registers the other two with unchanged content, identities, and labels, and shows no window with a guessed identity. A client none of whose saved state can be decoded registers as a new client with one fresh window.

Deterministic acceptance fixtures MUST cover, on every client platform that registers with the fleet registry: (a) a fresh install with one open window and no binding or provisioned file, which binds and registers on first discovery and holds a durable binding before its first label; (b) an upgraded client with confirmed labels and content but no binding, against a registry that holds its allocations, which keeps those labels; (c) the same client against a registry with no record of it, which receives fresh labels while content, layout, and client, surface, pane, and lineage identities stay unchanged, and which shows the pending-label indication and no pre-binding label until the registry answers; (d) saved surfaces with no confirmation marker, local window letters, and retained surface and pane tombstones, which bind and register, with a later restore of such a tombstone taking the label the registry returns; (e) a discovered endpoint missing either identity field, which causes no binding or registration, followed by a valid endpoint that does bind; (f) a matching identity at a changed address and a registry restart, with binding and labels preserved; (g) a binding write interrupted before, during, and after the durable-write boundary, including an ambiguous result resolved by readback, each ending registered without user action; (h) saved state with one undecodable window record beside readable ones, and wholly undecodable saved state, each ending registered under item 7; (i) a bound client with only a different-fleet registry discoverable, and separately one with only a different-allocator registry, each of which rebinds and registers; a bound client with both a matching and a different registry discoverable, which keeps the matching one; a bound client whose registry reappears within its wait interval, which keeps it; and a bound client whose registry is gone while only a surface advertisement without `role=server` is visible, which does not rebind; (j) an accepted release followed in the same request by a refused release, which ends with the first release complete, the second dropped, the closed window still closed, and no release repeated; (k) a release whose outcome is unknown, which stays pending and reserved while the client registers its live identities with a registry that accepts registration without it, and which against a registry rejecting every registration for its own condition stays pending while the client retries, then registers and delivers the release once the condition clears; and a release whose outcome is unknown when the client rebinds to a different registry, which is held without delivery, never sent to the new registry, and does not prevent registration there; and (l) a saved live surface whose identity the registry refuses as terminally retired, and a saved live pane whose identity conflicts with the registry's history, each of which stays open with its content under a new identity and a fresh label. Assert in every fixture: that the content and layout the client can read never change; that client, surface, pane, and lineage identities never change except for state that could not be read in (h) and the refused identities in (l); that no label from a registry is applied before the binding for that registry is durable; that no pre-binding label is shown or reported as a fleet coordinate under a new binding; that no path requires a provisioned file, owner verification, or user action; and that the client ends registered whenever local storage accepts writes, the registry is not rejecting every registration for a condition of its own, and a registry with a valid identity pair is reachable (for a bound client whose registry is gone, once any wait interval ends).

**Open questions.** (1) NON-BLOCKING: if an unbound client discovers several registries with different valid identity pairs at once, it binds to the first that answers in its existing endpoint order, with an explicitly configured registry address ahead of discovered ones. The same order applies when a bound client rebinds under item 6(b). (2) NON-BLOCKING: keeping old labels on a registry that has no record of the client would require the registry to accept requested labels. That is a registry change and is not specified; such a client takes fresh labels, which this section permits.

#### 3.1.3 Registry-Leased Direct Endpoint Discovery (v1)

This is an additional explicit discovery path for a controller that has a configured registry URL and a named window. It supplements Bonjour/mDNS and does not replace app discovery, change surface advertisement, or change the existing pair-then-list flow. It follows Mike's v1 consistency-only ruling and the approved contract for this discovery path. The ruling explicitly does not require cryptographic proof of key possession.

1. **Configured endpoint.** A client may include a direct WebSocket endpoint in client.register only when that complete endpoint is supplied by deployment configuration. The endpoint is an absolute supported ws or wss URL without embedded credentials. The client also advertises prePairDescribeV1 only when it implements §3.1.4. A client or registry MUST NOT derive an endpoint from the registry URL, Bonjour name, bind address, observed source address, or an inferred port. Missing or unsupported endpoint metadata remains absent and is reported as such; it never falls back to the registry URL or an unrelated discovery result. Older clients that omit this metadata remain valid clients for existing flows.
2. **Registry lease.** For each registered client, the registry stores the configured direct endpoint with a positive safe-integer leaseGeneration, registrationObservedAtMs, and leaseExpiresAtMs, all in epoch milliseconds. The registry supplies its own registration and server times. registrationObservedAtMs is the registry time when that generation became current and remains fixed for that generation. At each fleet.topology response, leaseExpiresAtMs MUST be later than registryServerTimeMs and no farther ahead than the deployment's finite positive maxEndpointLeaseMs. The registry identity pair, clientId, endpoint, capability, and registered surface set are bound to that generation. Replacing any of them advances the generation and sets a new registrationObservedAtMs; renewing the same lease may extend expiry without changing either the generation or its registration time. Generations are never reused while an earlier lease could still be current. If restore or restart leaves generation continuity or lease freshness unknown, old endpoint rows are not current and a fresh client.register is required before they can be published as current.
3. **Registry projection.** A successful client.register response exposes the exact configured endpoint, prePairDescribeV1 capability, leaseGeneration, registrationObservedAtMs, leaseExpiresAtMs, clientId, registryIdentity, and registered surface/window labels. fleet.topology additionally exposes registryServerTimeMs and maxEndpointLeaseMs. These are registry observations, not client authentication. fleet.topology remains read-only: it does not pair, claim labels, refresh client registration, or extend a lease. A row is current only when the registry reports the supported endpoint and capability, its registryServerTimeMs is at least registrationObservedAtMs and before leaseExpiresAtMs, and the lease duration is within maxEndpointLeaseMs. Missing identity, lease, expiry, endpoint, capability, server time, or lease bound makes that row unsupported for direct discovery.

   fleet.topology has registryServerTimeMs (a non-negative safe integer) and maxEndpointLeaseMs (a positive safe integer) at the top level. Each client row adds directEndpoint (absolute WebSocket URL or null), prePairDescribeV1 (boolean), and endpointLease (object or null containing leaseGeneration, registrationObservedAtMs, and leaseExpiresAtMs). A row is current only if registrationObservedAtMs is no later than registryServerTimeMs, leaseExpiresAtMs is later than registryServerTimeMs, and leaseExpiresAtMs minus registryServerTimeMs is at most maxEndpointLeaseMs. Legacy rows may report null for endpointLease and false for prePairDescribeV1.
4. **Stable identity is consistency, not authentication.** The discovery client compares the returned clientId and complete registryIdentity pair with the selected registry row, and also compares the exact surfaceId and leaseGeneration. It reports each comparison as §6.0.1 item 4 defines; only a clientId or surfaceId difference stops a named-window result. A nonce correlates one request and response and prevents accidental reuse of a stale cached response by a conforming implementation. None of these self-reported values, including a fingerprint-shaped clientId, proves key possession or authenticates a registry or endpoint. The v1 contract prevents accidental stale or cross-client routing only; it MUST NOT claim protection against a malicious registry, malicious endpoint, or active attacker.
5. **One current window match.** A named-window lookup uses the canonical fleet windowLabel in a fresh fleet.topology result. It proceeds only for exactly one current registry row/surface match. Zero matches report not_found or stale_registration as applicable; multiple current matches report ambiguous. It never picks the first match, asks mDNS to break a tie, or guesses a direct address. Registration age, lease expiry, direct probe time, and direct probe outcome remain separate evidence.
6. **Registry recheck.** After the direct probe, the controller reads fleet.topology again. The same registryIdentity, clientId, surfaceId, windowLabel, direct endpoint, and leaseGeneration must still identify exactly one current match, and the returned registryServerTimeMs must still precede leaseExpiresAtMs. A changed, expired, absent, or ambiguous row makes the discovery result stale even if the direct endpoint answered. The two registry reads and direct probe are bounded read-only observations; they do not reserve the name or grant authority for a later mutation.

#### 3.1.4 Pre-Pair Surface Describe

surface.describe is the direct, read-only operation used by §6.0.1. It is a separate pre-pair contract, not an alternate name for panes.list, pair.response, surfaces.list, or snapshot.get.

1. The request is a v1 request envelope with a fresh request id and op surface.describe. Its payload contains the expected clientId, registryIdentity pair, surfaceId, endpointLeaseGeneration, and a fresh nonce of at least 128 random bits. It contains no controllerInstanceId, session token, resume state, admission request, registry URL, or mutation intent.
   The payload fields are:

   | Field | Type | Meaning |
   |---|---|---|
   | clientId | string | Expected client fingerprint-shaped identity; consistency only |
   | registryIdentity | object | Exact fleetId and allocatorId pair from fleet.topology |
   | surfaceId | string | Exact selected live surface id |
   | endpointLeaseGeneration | positive safe integer | Exact selected registry lease generation |
   | nonce | string | Fresh random value of at least 128 bits, used only for request/response correlation |

2. A supporting client accepts the request before pair.request and reads its own current saved surface state. This operation follows one rule: when one part is unavailable, only that part is turned off and everything else keeps working, and when a check is unsure, the client warns and lets the work continue. Accordingly:
   - When the requested clientId equals the responding client's own clientId, the requested surfaceId is live on this endpoint, and the client can read a complete saved topology observation of that surface under item 3, the client SHALL return a successful response with that observation.
   - The client SHALL return that success even while the outcome of an earlier durable write is unknown, while its application state is not confirmed ready, and while its saved registry binding or endpoint lease is missing, unreadable, or different from the request. These conditions are reported in the response; none of them is a reason to refuse the read.
   - The client SHALL report its saved registryIdentity pair and saved endpointLeaseGeneration exactly as it can read them, or null when it has no readable saved value. It SHALL NOT echo the requested value in place of its own, and SHALL NOT report a value as matching that it has not read.
   - The client does not bind itself, migrate identity, refresh its registration, or repair state from this request.

   Acceptance example: a client whose last durable write has an unknown outcome and whose saved endpoint lease is generation 6, asked to describe a live surface at generation 7, returns success with its saved layout and panes, endpointLeaseGeneration 6, status degraded, and limitationCodes containing persistence_outcome_unknown and endpoint_lease_stale. A client with no saved registry binding returns success with registryIdentity null and endpointLeaseGeneration null, status degraded, and limitationCodes containing registry_binding_unavailable and endpoint_lease_unavailable.

   A successful response uses the same v1 response envelope and request id/op, with the payload below:

   | Field | Required value |
   |---|---|
   | nonce | Exact nonce from this request |
   | clientId | Responding client's public-key fingerprint identity |
   | registryIdentity | Object containing the client's saved fleetId and allocatorId, or null when the client has no readable saved pair |
   | surfaceId | Exact requested live surface |
   | endpointLeaseGeneration | Positive safe integer registration generation saved by this client, or null when the client has no readable saved lease |
   | observedAtMs | Client observation time as a non-negative safe integer epoch millisecond value |
   | applicationReadiness | Object with status ready or degraded and a limitationCodes array |
   | surfaceSetRevision | Current non-negative safe integer endpoint lifecycle revision |
   | topologyRevision | Current non-negative safe integer surface topology revision |
   | layout | Committed tree; pane leaves are {type: pane, paneId, weight?}; split nodes are {type: split, direction: horizontal or vertical, children, weight?}; existing weight semantics apply |
   | panes | One record per live pane, as defined below |

   Each panes record contains only paneId as a non-negative safe integer; paneLabel as a positive safe integer or null; and contentObservation with revision as a non-negative safe integer or null, source equal to client-authority, and observedAtMs as a non-negative safe integer epoch millisecond value. Pane labels that are pending remain null; no local guess is permitted. A pane restored from saved state keeps its saved paneId, including 0, in both the layout and the panes list; describe never renumbers, omits, or rejects such a pane to fit a positive range. This section does not change how new pane IDs are allocated. A ready response has an empty limitationCodes array. A degraded response has at least one limitation code and returns a complete saved topology. A client that cannot read a complete saved topology observation of the requested live surface returns not_ready with no layout or pane list.

   The client SHALL include each of the following limitation codes whose condition holds when it collects the observation, and SHALL report status degraded whenever any is present:

   | Code | Condition |
   |---|---|
   | persistence_outcome_unknown | The outcome of an earlier durable write is unknown, so saved state may differ from durable state |
   | application_state_unverified | The application has not confirmed its state ready, but the saved observation is readable |
   | registry_binding_unavailable | The client has no readable saved registryIdentity pair |
   | registry_binding_stale | The saved registryIdentity pair differs from the requested pair |
   | endpoint_lease_unavailable | The client has no readable saved endpoint lease |
   | endpoint_lease_stale | The saved endpointLeaseGeneration differs from the requested generation |

   Other capability-specific limitation codes remain permitted. When the client returns a degraded response, it SHALL write a local warning log entry naming the limitation codes; how often it repeats an unchanged warning is an implementation choice.
3. The committed layout and live pane list are one topology observation at the returned topologyRevision. The layout leaves MUST reference every listed paneId exactly once and no other pane. The client compares surfaceSetRevision and topologyRevision before and after collecting the topology; if either changes, it returns revision_churn without an actionable layout or pane list. Content revisions are per-pane observations with their own source and observation times; they are not claimed to be an atomic multi-pane content transaction. The response contains no content body, URL, image, snapshot, annotation payload, or history body at any depth.
4. applicationReadiness is reported separately from transport reachability, using ready, degraded, or not_ready plus capability-specific limitation codes where applicable. A successful WebSocket connection alone means only transport reachable. An absent, malformed, unsupported, or timed-out describe response never becomes ready by inference. Uncertain application or persistence readiness is reported as degraded, never as ready, and is never by itself a reason to return not_ready while the saved observation is readable.
5. The request and response are bounded: the caller enforces a deadline no greater than 2,000 ms and a response limit no greater than 65,536 UTF-8 bytes. Exceeding either bound returns a bounded failure and no partial topology. The client performs no registry call and creates or changes no durable state for this request.
6. Repeated describe requests do not create or renew pairing, controller admission, a session, a cursor, an acknowledgement, a registration lease, a window, a pane, an allocation, or a write receipt. The operation does not append to an admission-attempt ledger. It does not perform hidden pair.request, panes.list, snapshot.get, content read, or label claim operations.
7. A conforming implementation returns operation errors using invalid_payload, unsupported_protocol_version, prepair_describe_unsupported, surface_not_found, identity_mismatch, revision_churn, not_ready, or internal_error as applicable. It never returns a partial pane list as success. identity_mismatch means only that the requested clientId is not this client's clientId; a missing, unreadable, or different saved registry binding or endpoint lease is reported under item 2 and is not identity_mismatch.
8. This operation preserves saved content, identity, and close semantics. It reads only; it never restores, reopens, retires, relabels, or rewrites a surface, pane, label, binding, or lease. A closed surface or pane is not live and is not described, and describe does not change recoverable-close or deliberate final-close semantics (§4.7, §4.7.1). A degraded or successful describe result neither relaxes nor adds any guard on a later registration, label claim, pairing, or content mutation; those operations keep their own rules in §3.1.2 and §6.

Acceptance fixtures for this section MUST cover a successful degraded response, with the complete saved layout and panes and the matching limitation codes, for each of: unknown durable-write outcome; application state not confirmed ready; no saved registry binding or lease; an unreadable saved binding or lease; and a saved pair or lease generation different from the request. They MUST also cover a ready response with matching saved values; a different requested clientId returning identity_mismatch; an unreadable saved topology returning not_ready; and a restored surface whose saved state carries paneId 0, which appears with paneId 0 in the layout and panes of a successful response. In every fixture, the client's durable state, content, labels, binding, and lease are unchanged by the request.

**Open questions.** (1) NON-BLOCKING: the shared PaneId schema in §10, annotation source records, and pane-addressed requests still require a positive paneId. A restored pane 0 is therefore reported by surface.describe but is not addressed by those operations; whether they should accept it is outside this section.


TXT keys used by WS protocol:

| Key | Type | Example | Notes |
|---|---|---|---|
| `name` | string | `Kitchen Display` | Human-readable label |
| `v` | int | `1` | Protocol major version |
| `w` | int | `1920` | Viewport width (points) |
| `h` | int | `1080` | Viewport height (points) |
| `s` | int | `2` | Scale factor |
| `cap` | int | `31` | Content type bitmask |
| `busy` | `0|1` | `0` | Reserved at `0`; controller admission is reported through lockless capability/state. |
| `pk` | hex8 | `a1b2c3d4` | Device public key fingerprint prefix (endpoint identity only; not used as screen selector in OpenClaw tools) |
| `ws` | path | `/ws` | WS upgrade path |
| `tls` | `0|1` | `0` | Reserved for future WSS profile; ignored by v1 |

Connection URL derivation:
1. Resolve host/port from SRV/A/AAAA.
2. Use path from TXT `ws` (default `/ws` if missing).
3. v1 scheme is always `ws` (WSS is out of scope in v1).

### 3.2 Surface WS Endpoint

The surface runs a WebSocket server. There is no REST HTTP API — the only HTTP traffic is the mandatory WS upgrade handshake required by RFC 6455 before the socket is established.

1. Required: WS upgrade path (`/ws` by default, or the path advertised in TXT `ws` key).
2. Optional: `GET /health` → `200 OK` for diagnostics only.
3. No REST data endpoints exist (`/pair`, `/frame`, `/watch`, `/snapshot` are not part of this protocol).

## 4. Connection and Session Lifecycle

### 4.1 Roles
1. Each admitted controller adapter is a WS client and manages its own connection/reconnect work.
2. Surface is WS server and session authority.

### 4.2 Capability-Scoped Controller Admission
1. A client advertising the T1770 lockless capability maintains one finite admitted-controller registry and may admit multiple live controller connections concurrently.
2. Each controller asserts a mandatory stable opaque controller instance ID. The ID is durable across reconnect/restart/redeploy and scopes live deconfliction, cursors, retry correlation, provenance correlation, and diagnostics only; it grants no priority, quota, veto, or restore right.
3. Missing or malformed instance identity fails admission. If the same instance ID is already live, the newcomer receives a distinct duplicate-ID error and the incumbent is preserved. Retry waits for normal liveness reaping.
4. Every controller acts through the same client-local ordered mutation and lifecycle seams. Ordering follows client serialization, never controller identity, product, label, retry count, or prior success.
5. Admission and retained controller state are bounded by the advertised CTLRET limits in §4.8. A capacity refusal never evicts a live controller or selects by identity.
6. A client that does not advertise the T1770 lockless capability is not admitted.

**Multi-controller/session routing** is settled: every accepted `content.set` creates a distinct client-identified entry and becomes visible immediately. The displaced visible entry remains in the shared retained pool, and committed content/history events fan out in client order without owner-only delivery.

### 4.3 Pair-First Rule

All operations other than `surfaces.list` and `pair.request` are invalid until pairing succeeds.

`surfaces.list` remains the pre-pair discovery operation for multi-window endpoints. It exposes client-authoritative lifecycle and capability state. Pane topology discovery follows successful controller admission through `panes.list`.

### 4.4 Reconnect and Resume

Provider reconnect policy:
1. Exponential backoff with jitter: 0.5s, 1s, 2s, 4s, 8s, 16s, max 30s.
2. Reconnect uses the same discovered surface address.
3. Lockless recovery sends `pair.request` with the same stable controller instance ID and the controller's resume/synchronization state. The client resumes the retained cursor/gap bundle only while it remains in the bounded dormant pool.
4. A regenerated ID or an ID whose dormant bundle was reclaimed is a new admission at current scope tails. Human-readable labels never recover cursor state.
5. After a duplicate-live-ID refusal, the newcomer waits for the heartbeat/liveness path to reap a dead incumbent.
6. Resume exchanges client cursor/gap generations and the controller's durable acknowledgement outbox, retransmits idempotently, and rebuilds the bounded local projection from client snapshots and ordered deltas.

**Invariant: connection state MUST NOT affect displayed content or client truth.** A controller crash, restart, disconnect, or partition does not mutate content/topology, free or transfer a right, elect a controller, or stop other admitted controllers.

Registry discovery, read-only topology, registration/write readiness, client-local endpoint availability, and durable persistence are separate capabilities. A successful read-only handshake does not establish write readiness. Foreground clients retry failed available dependencies with cancellation-aware bounded backoff and jitter: a fresh attempt begins within 30 seconds after recovery of a dependency used by the running application, and one failing candidate route cannot indefinitely starve another discovered usable route. Readiness returns within that attempt window plus the documented handshake/validation timeout while the dependency remains healthy. An OS-suspended app resumes attempts when active; it does not promise execution while suspended. Successful recovery clears the corresponding status without replacing content or confirmed identities.

An uncertain durable operation retains its stable identity and a truthful confirmed, not-committed, or unknown outcome. Before potentially duplicating replay, the client or registry reconciles that same operation against the protected durable state and fence. Persistent absence or divergence pauses only operations requiring the unproved state, within bounded resources; it does not acknowledge a write, silently overwrite state, authorize a second writer, or remove independent display and reads. Original failure category, stage, and operation correlation are retained safely for diagnosis. Acknowledged outcomes remain consistent after recovery.

An invalid content replacement is rejected before discarding existing content where validation is possible. A failed load after activation or one renderer/command failure affects only its target pane or operation, preserves recoverable prior content/state, and exposes a local retry or limitation; unaffected panes remain visible and interactive. An intentional accepted clear remains a content operation and may clear its target. An optional compositor capability failure is reported separately and cannot erase client-owned content; genuinely unavailable OS/display resources are not represented as working pixels.

### 4.5 Keepalive

Application-level keepalive is required:
1. Each controller starts heartbeat only after successful admission and initial client snapshot/capability validation.
2. Provider sends `heartbeat.ping` every 10s.
3. Surface replies with `heartbeat.pong` within 3s.
4. Surface MUST prioritize heartbeat handling above queued frame/render work and MUST NOT queue `heartbeat.pong` behind render/mutation tasks.
5. Missing 2 consecutive pong responses causes provider to close socket and reconnect.

Pair timeout:
1. Provider MUST apply a 10s pairing timeout from WS connection establishment.
2. If no `pair.response` arrives in 10s, provider closes socket and enters reconnect backoff.

**Surface UI connectivity and capability status (required):**
The surface MUST display connection state through the window ID outline/text color in the bottom-right identity overlay (§15.1). When a shared service used by the surface is degraded, a compact adjacent, accessible capability status MUST distinguish usable display from unavailable registration, synchronization, direct endpoint, or persistence without covering content. It MUST label pending/unsaved work honestly, stay stable across repeated failures, and clear on recovery; full diagnostic detail appears only on deliberate inspection. If the window letter is pending, the bottom-right identity overlay retains a neutral placeholder outline without a fabricated letter and anchors the connection color, pending-label indication, and capability status there. Required connection-color behavior:
- Connected — green window ID outline/text.
- Connecting / reconnecting — yellow window ID outline/text.
- Disconnected — red window ID outline/text.
Content is never cleared by any of these states (see §4.4 invariant).

### 4.6 iOS / iPadOS Background Behavior
1. When the app backgrounds, the OS may suspend or terminate WS sockets. The client MUST keep displayed content, pane state, authoritative consumable scopes, cursor floors, gaps, tombstones, and capability limits intact.
2. On foreground return, each controller reconnects with its stable instance ID and resumes retained state through §4.4.
3. A missing controller connection grants no other controller a new right and does not block other admitted controllers.
4. Client restart restores the complete lockless authority state described in §§4.7–4.8 before admitting controllers or mutations.

### 4.7 Runtime Window Lifecycle (Multi-Window Endpoints)

When a user opens or closes windows on iPad/Electron, surface availability changes without endpoint change.

Rules:
1. The endpoint owns a durable monotonically increasing `surfaceSetRevision` and one ordered lifecycle transaction seam for surface/window open, close, restore, and reclamation.
2. Controller lifecycle mutations carry `expectedSurfaceSetRevision`; close also carries the surface's `expectedTopologyRevision`. A mismatch returns authoritative current state and requires explicit refresh/recompute/retry with a new request ID.
3. An accepted open atomically allocates a stable client-owned surface ID and initial pane ID, initializes client revisions, advances `surfaceSetRevision`, and then emits `event.surface_appeared`. Fleet-unique live window and pane labels may be confirmed before or after this local commit; until confirmed they are absent, not guessed. An unavailable allocator does not roll back the local surface or its content. Reconciliation binds the same surface/pane/lineage identities to unique confirmed labels without replacing content.
4. Controller window lifecycle may be omitted only when it is not a product operation on that platform. In 0.2.10-rc1, local-user close is always recoverable; in later releases, every explicit close, by the local user or a controller, is final under §4.7.1. On a capable client, any admitted controller and the local user use identical identity-independent admission rules.
5. In 0.2.10-rc1, accepted close atomically creates a surface tombstone containing the surface identity, full topology, live panes, nested pane tombstones, bounded consumable scopes/cursors/gaps, and restore state before removing the live projection, advancing `surfaceSetRevision`, emitting `event.surface_removed`, and closing surface sockets. Close itself discards nothing. In later releases, explicit close follows §4.7.1 FC-2 instead.
6. Any admitted controller or the local user may restore a retained surface tombstone through the endpoint lifecycle seam even when zero surfaces are live. Restore reactivates the same surface/pane identities and state, consumes the surface tombstone, advances `surfaceSetRevision`, and emits ordered lifecycle events.
7. Pane and surface tombstones retain their semantic state and identity reservations under §4.8 without quota-driven reclamation. Each surface tombstone keeps its fresh close-time `closedSequence`; nested pane tombstones keep their original sequences as lifecycle metadata. Listing or failed restore does not rewrite this metadata. The 0.2.10-rc1 interim contract introduces no automatic retirement trigger; later releases add only final close under §4.7.1. Any independently authorized terminal retirement must preserve the ordered identity, restore-right, and exact release fences in §3.1.1.1(3); retained identities are never discarded merely to free a pane number.
8. Window lifecycle signals remain in-band and always-on; they do not require mDNS rebroadcast and do not create a permanent controller destroy path.

#### 4.7.1 Explicit close is final; involuntary loss restores (releases after 0.2.10-rc1)

This subsection applies Mike's explicit-close ruling of October 14, 2026: "When the user explicitly closes a pane or window, that close is final: tombstone it with no restore right and release its pane number or window letter for lowest-available reuse once the close commits. Panes and windows lost to app quit, crash, disconnect, or restart do restore, with their labels kept reserved." The ruling supersedes the interim close text written before it.

**Release scope.** Surf Ace 0.2.10-rc1 and earlier releases implement the interim close contract: §3.1.1 window rule 7, §3.1.1.1(3), §4.7 rules 4–7, §4.8 "Recoverable pane close and retained identities" items 1–2, and the §6.1.1 close operations, under which every close is recoverable and keeps its labels reserved. That interim text describes those releases only. It is not the intended close behavior, and 0.2.10-rc1 does not implement this subsection. Every Surf Ace client release after 0.2.10-rc1, together with the fleet allocator it uses, MUST implement this subsection on every supported client. Where interim text conflicts with this subsection, this subsection governs those releases.

**Terms.**
- **Explicit close**: a committed close of one specific pane or window, requested by the local user through a Surf Ace or platform close action for that pane or window (including removing that one window in the platform's window switcher), or by an admitted controller through `pane.close`, `surface.window.close`, or the `closeWindow` intent. Controller and local-user closes follow identical rules (Core Invariant 2).
- **Involuntary loss**: a pane or window that stops being shown without an explicit close of it, because the whole app quits or is terminated (by the user, the OS, or a crash), the client process or device restarts, or a connection drops.
- **Final close**: the committed result of an explicit close under this subsection.
- **Final-close record**: the tombstone the ruling names. It is the terminal-retirement identity audit of §3.1.1.1(3), with no restore right and no label reservation.

**Requirements.**

1. **FC-1 Pane final close.** When an explicit pane close commits, the client SHALL, in that one atomic commit, remove the pane from topology, advance the surface's topology revision exactly once, write its final-close record and the release intent for its allocation under §3.1.1.1(3)–(4), and discard its restore material (content/source, semantic history, and annotation restore state). The `pane.close` response and `event.pane_removed` carry `recoverable: false`. The final-close record and release intent bind, as their committed close/topology revision, the `topologyRevision` the `pane.close` response returns. A later restore naming that pane or its tombstone is refused and changes nothing. *Source:* "that close is final: tombstone it with no restore right"; the October 23, 2026 close-revision ruling quoted in §3.1.1.1(4). *Acceptance:* close pane 4 at topology revision 5; `pane.close` returns `recoverable: false` and `topologyRevision` 6, and pane 4's release intent binds committed close/topology revision 6; a restore of pane 4 is refused and leaves the topology revision unchanged.
2. **FC-2 Window final close.** When an explicit window close commits, the client SHALL apply FC-1 in that same atomic commit to the surface and to every pane in it, live or tombstoned, and SHALL write the release intent for its window letter. That same atomic commit SHALL advance the surface's topology revision exactly once in total, not once per pane, however many panes it closes, and every final-close record and release intent it writes, for the window letter and for each pane, SHALL bind that one advanced revision as its committed close/topology revision under §3.1.1.1(4). No response or event field is added to report it. `event.surface_removed` carries `recoverable: false`, and `surfaces.list` does not list the surface as restorable. *Source:* "When the user explicitly closes a pane or window"; the October 23, 2026 close-revision ruling quoted in §3.1.1.1(4). *Acceptance:* window `b` at topology revision 3 holds panes 7 and 8; closing `b` writes release intents for `b`, 7, and 8, each binding committed close/topology revision 4, and `surfaces.list` lists no restorable tombstone for `b`. Window `c`, opened at topology revision 0 and never split or rearranged, is closed; the release intents for `c` and its pane bind 1, and the allocator accepts them.
3. **FC-3 Release and lowest-available reuse.** After a final close commits, the client SHALL deliver each release intent to the allocator, ahead of any label claim the client commits later. The allocator SHALL release the allocation once it verifies the release evidence under §3.1.1.1(4); later pane or window creation then receives the lowest available number or letter under §3.1.1.1(2). Window letters follow the same allocation, generation, release, and reservation rules as pane numbers in §3.1.1.1, keyed by surface identity, where lowest means earliest in the sequence `a`, `b`, … `z`, `aa`, `ab`, …. While the allocator is unreachable or a release outcome is unknown, the number or letter stays reserved and the release stays pending; no label is guessed. A release the allocator refuses is dropped, and release evidence from an earlier binding to a different registry is held without delivery, under §3.1.2 item 5(a). *Source:* "release its pane number or window letter for lowest-available reuse once the close commits". *Acceptance:* with live panes 1, 2, and 3, closing pane 2 and then splitting any pane gives the new pane number 2. With live windows `a` and `b`, closing `a` and then opening a window gives it `a`. If the allocator is offline when pane 2 closes, pane 2 is still gone and 2 is not reused until the allocator accepts the release.
4. **FC-4 Involuntary loss restores.** When a pane or window is lost by involuntary loss, the client SHALL keep it restorable with the same stable identity, allocation generation, content/source, semantic history, and unread annotation state, and the allocator SHALL keep its pane number and window letter reserved. Restart restores it under §4.8 "Recoverable content and restart". This holds while the client stays bound to the same registry; labels held from before a new binding follow §3.1.2 item 4, and a claim the registry refuses follows §3.1.2 item 5(b). Closing an app's last window is an explicit window close even when the platform then exits the app; quitting the app with windows open is involuntary loss. *Source:* "Panes and windows lost to app quit, crash, disconnect, or restart do restore, with their labels kept reserved." *Acceptance:* with pane 5 live in window `a`, the app crashes or is quit; while it is down, no new pane anywhere in the fleet receives 5 and no new window receives `a`; on relaunch the same surface returns as window `a` (§3.1.1 item 2) with pane 5 labeled 5 and showing its content.
5. **FC-5 Delivered data survives final close.** A final close SHALL NOT discard data already produced for consumers. Unread consumable records and sticky gaps in the closed pane's or surface's scopes stay readable and acknowledgeable by stable ID under §4.8 until acknowledged or reclaimed there, and a closed surface's annotation publisher partition drains under §4.10 item 5. A final close commits or publishes no open, uncommitted annotation frame. *Source:* the ruling's release scope, which preserves data and identity while separating explicit close from involuntary loss. *Acceptance:* a controller with two unread frames in pane 4 reads both after pane 4's final close; a window closed with three unaccepted publisher records still delivers all three to the registry.
6. **FC-6 Mixed versions.** A 0.2.10-rc1 or earlier client sends no release, so its closes keep their labels reserved until that client upgrades under FC-7. A client implementing this subsection whose allocator cannot yet verify generation-fenced release SHALL still complete the final close locally, keep the release pending, report the pending release in client diagnostics, and deliver it once a capable allocator is reachable, subject to §3.1.2 item 5(a). The allocator SHALL accept a release only for an allocation owned by the releasing client. *Source:* the release scope above. *Acceptance:* an interim client and a final-close client share one fleet; only the final-close client's closed numbers are reused.
7. **FC-7 Upgrade from the interim contract.** When a client first starts a release implementing this subsection over persisted state from 0.2.10-rc1 or earlier, it SHALL, before admitting controllers or mutations (§4.6 rule 4), examine each retained pane and surface tombstone on its own. For each tombstone whose explicit-close origin it can prove, it SHALL apply FC-1 (pane) or FC-2 (surface) as if that close had just committed, including the release intents delivered under FC-3 and FC-6 and the data retention of FC-5, and the tombstone stops being restorable. A pane tombstone finalized on its own, outside any proven surface tombstone, binds, as its committed close/topology revision, the topology revision its interim close produced, as recorded with that close. A finalized surface tombstone binds the topology revision recorded in that tombstone advanced once, as FC-2 requires, and every pane tombstone finalized with it, whether or not that pane's own close origin is proven, binds that same single advanced revision; the pane's earlier recorded revision remains historical metadata only. A tombstone's explicit-close origin is proven only when the upgrading client can establish from persisted state that the tombstone was committed by an explicit close as defined in Terms; a tombstone that could have been committed by a path that also fires on involuntary loss is not proven. Each tombstone whose origin it cannot prove, and that no proven surface tombstone holds, stays restorable, with its identity, allocation generation, restore state, and labels reserved, exactly as under the interim contract. Live panes and windows in persisted state are involuntary losses under A3 and restore under FC-4. A proven surface tombstone is finalized whole: under FC-2 the explicit window close covers every pane the surface holds, live or tombstoned, so each nested pane tombstone is finalized with it even when that pane's own close origin is unproven. A nested pane tombstone inside an unproven surface tombstone is judged on its own: if proven, it is finalized and a later restore of that surface returns without that pane; if unproven, it stays with the surface, restorable and reserved. *Source:* the October 22, 2026 product ruling on interim-era tombstones: "finalize them at upgrade", "Panes or windows lost to quit, crash, disconnect or restart are not tombstones under A3 and keep restoring with labels reserved", and "If an upgrade cannot prove a tombstone came from explicit close, keep that one reserved and restorable." *Acceptance:* under 0.2.10-rc1, pane 4 is closed with `pane.close` and window `b` is closed with `surface.window.close`, while window `a` with pane 5 is still open when the app quits. After upgrade, neither pane 4 nor `b` is offered for restore, once the allocator accepts the releases, 4 and `b` are free again, so with no lower number or letter free the next new pane receives 4 and the next new window receives `b`, and window `a` returns with pane 5 labeled 5 and showing its content. If window `b` also held pane 9 as a tombstone whose own origin is unproven, pane 9 is finalized with `b` and 9 is released too. If `b`'s tombstone recorded topology revision 5 and pane 9's own interim close recorded revision 2, the releases for `b` and for 9 both bind revision 6. A tombstone whose persisted state cannot show it came from an explicit close, and that no proven surface tombstone holds, is still listed as restorable after upgrade, and its numbers are not reused.

**Assumptions.**
- A1. The first release after 0.2.10-rc1 includes allocator support for generation-fenced release. Without it, FC-3 reuse cannot pass acceptance.
- A2. Each supported platform reports a user's removal of one specific window separately from termination of the whole app. Where a platform cannot, that path is treated as involuntary loss on that platform until this subsection is amended.
- A3. Under the interim contract, tombstones come only from close; involuntary loss leaves panes and windows live in persisted state.

**Non-goals.** No undo, trash, grace period, or restore of a final close. No new retirement trigger for involuntary loss, hide, disconnect, lease expiry, or elapsed time. No renumbering of existing panes or windows, other than replacing labels held from before a new binding under §3.1.2 item 4. No change to the rule that the last pane in a window cannot be closed with `pane.close`. No change to 0.2.10-rc1 source, release, or behavior.

**Open questions.** None. The former question on tombstones present at upgrade from 0.2.10-rc1 or earlier is answered by FC-7.

### 4.8 T1770 Lockless Authority, Capacity, Retention, and Retired Model

This subsection is the compact canonical contract for a client advertising `surf-ace.lockless-multi-controller.v1`. A client that omits that capability is not admitted.

#### Client-local mutation and topology authority

1. Each client is the sole ordered authority for the surfaces it renders. Controllers communicate directly with the client, submit content/topology/lifecycle intent, and hold bounded read projections; no central coordinator, controller-side writable replica, CRDT, operational transform, offline write queue, or automatic stale-operation rebase exists.
2. All mutations for one surface enter one client-owned FIFO seam. Topology requests carry `expectedTopologyRevision`; endpoint lifecycle requests carry `expectedSurfaceSetRevision`. The client compares at execution time, rejects mismatch with authoritative state, and requires explicit refresh/recompute/retry with a new request ID.
3. Accepted operations validate completely, commit atomically in client order, allocate client revisions and stable IDs, and emit events after commit. Confirmed fleet labels, when available, are bound in a separate monotonic registry-backed transition; a pending label neither blocks client-local content/topology nor grants global addressability. Identity never affects validation, order, capacity, retention, or outcome.
4. The client allocates and persists stable surface/pane IDs and projects only registry-confirmed unique live labels. Controllers target existing IDs and submit intent. The compositor receives only client-resolved geometry/native-hosting state and never reconstructs, validates, sequences, or persists controller topology intent.

#### Shared content history and provenance

1. Every accepted push creates a distinct history entry, receives a client-allocated content revision and opaque entry ID, becomes visible, and moves the former visible entry into the shared retained pool.
2. The visible entry is separate from one per-pane pool of at most 20 non-visible entries shared across Back and Forward. Visibility assigns a strictly increasing `lastVisibleSequence`; overflow evicts the smallest sequence after Forward-branch removal. There are no controller partitions, owner tokens, quotas, protected slots, or same-controller replacement.
3. At acceptance the entry snapshots trimmed friendly-chat and provider/product display strings. The pill renders the visible entry as localized `{chat} — {provider}`, using localized `Unknown chat`/`Unknown provider` fallbacks. The full strings are entry-bound explanation only, never identity or authority.
4. At or above the measured width of `… — …`, both components and separator remain on one line with equal-share/unused-width reallocation and independent end truncation. From one-ellipsis width up to that composite floor it renders exactly `…`; below one-ellipsis width it occupies zero visual width. The full localized accessible name is always “Pushed by {chat}, using {provider}”; user text is trimmed, bidi-isolated, and not translated.

#### Pane creation and recoverable state

1. The client retains stable pane identity, content/source, semantic history, revisions/provenance, actual annotations, unread frames, scopes, cursor floors, and gaps. Recoverable state is not admitted by measuring or serializing complete live-or-tombstoned window/pane payloads against fixed byte limits.
2. `maxPanesPerSurface` (`P`) remains the existing pane-creating admission bound, not a live-pane or restore invariant. After stale-revision validation, creation checks its prospective pane count before allocating IDs. Exceeding this bound returns identity-independent `pane_capacity` and commits nothing. This change does not alter that separate creation rule.
3. Ordinary content, history, topology, and lifecycle mutations preserve accepted semantic state through one atomic durable commit. They do not perform recoverable-state quota measurement or return `surface_state_capacity`, `pane_state_capacity`, or `tombstone_capacity` because of pane/window payload bytes. They do not truncate accepted source content, provenance, annotations, or unread frames to satisfy a removed quota. In 0.2.10-rc1, an accepted pane or surface remains recoverably closable even after its semantic state grows beyond a former byte limit, and in every release involuntary loss under §4.7.1 retains the same state: close retains its identity, URL or HTML/source content, semantic history/provenance, and unread annotation state, and restore/restart recovers that state without ordinary whole-window byte admission. The existing shared 20-entry non-visible history policy is unchanged.
4. Retained restore reactivates the same pane/surface identity and state and consumes only the selected tombstone. Restore is not rejected or clamped by the live creation bound or former retained-state count/byte limits. Stable IDs, allocation generations, revisions, valid placement, and current live-label uniqueness still determine whether restore is valid.

#### Recoverable pane close and retained identities

Items 1–2 are the 0.2.10-rc1 interim close contract. In later releases, explicit pane close is final under §4.7.1 and creates no restorable tombstone; items 2–4 still govern any tombstone that remains restorable.

1. Accepted pane close atomically removes the pane from visible topology, creates a durable tombstone, advances topology revision once, and then emits the committed close event. The tombstone preserves stable identity/lineage and allocation generation, label hint/name, visible and retained semantic history with revisions/provenance, actual annotation/restore state and unread frames, consumable scope, retained controller cursors, and uncleared gaps. Close does not discard, truncate, or advance them.
2. Any admitted controller may restore any retained, non-retired tombstone using current topology revision and placement intent. Missing or terminally retired tombstone, stale revision, invalid placement, or a conflicting live allocation changes nothing. Accepted restore reinserts the same pane identity/state and exact valid label/generation, consumes the tombstone, advances one revision, and emits events after commit. A legacy claim without a generation or a backup that cannot prove it is newer than the terminal-retirement audit is history-only until its allocation is authoritatively verified; no replacement label is invented for an existing pane. A label held from before a new binding is replaced only by the label the registry returns under §3.1.2 item 4.
3. Pane and surface tombstones are not discarded or terminally retired because a retained count or serialized byte quota is reached. Encoded payload size is not evidence of pane identity, retirement, reservation, or safe label reuse. Retained tombstone identity and semantic restore state remain durable, including every nested pane identity inside a surface tombstone.
4. Removing quota-driven reclamation does not authorize a new retirement trigger or a replacement retention mechanism; final close under §4.7.1 is the only retirement trigger added after 0.2.10-rc1. A retained, live, offline, saved, legacy, or unknown claim reserves its allocation under §3.1.1.1. Any independently authorized terminal retirement must still commit the exact generation-fenced identity audit and release intent atomically with removal of the final restore path before allocator release. Unknown persistence keeps the label reserved. Restore and any authorized retirement share the client FIFO; whichever commits first determines whether same-identity restore remains possible. The existing release evidence and stale-backup fences remain unchanged.

#### Consumable truth, local projections, and dormant controllers

1. The client owns one durable ordered consumable scope per pane and one per surface for non-pane consumables, storing shared records once by client `consumableSequence`, with independent per-controller cursor floors and at most one sticky structured gap per scope.
2. It advertises finite positive `maxPaneConsumableRecords`, `maxPaneConsumableBytes`, `maxSurfaceConsumableRecords`, `maxSurfaceConsumableBytes`, `maxConsumableRecordBytes`, and `maxConsumableCursorStateBytesPerScope` (`G`). Bytes are exact versioned durable serialized bytes.
3. Closed frames, taps, and ordinary-read content/history/topology occurrences are append records. Scroll, selection, page, playback position/state, and last navigation are latest-wins by kind/scope. One live frame per `(paneId, frameId)` coalesces by stable stroke ID; finalization appends one immutable record.
4. At record ingress the client applies declared coalescing and removes complete oldest records by sequence until count/bytes fit; an oversized candidate becomes explicit loss. Every affected cursor moves to the retained floor with one sticky `consumableGap` containing generation, lost range/counts/bytes/classes/cause. The client sends targeted `event.consumable_overflow`, writes durable diagnostics, and preserves the gap through close/restore/disconnect/dormancy/restart until acknowledged. Close/restore never creates payload pressure or loss.
5. Pair/resume supplies a versioned scope snapshot; ordered deltas, `event.consumable_available`, and gap updates populate a bounded controller projection capable of the negotiated window. Ordinary `surf_ace_read` is one local transaction: return cached records and structured `consumableLoss`, durably advance only the projected cursor, and append an idempotent acknowledgement intent to a durable outbox. It never waits for network I/O. Only a client-accepted acknowledgement advances authoritative cursor/pending/gap truth; OpenClaw sends it through its connection job and the standalone CLI sends it during the next explicit networked invocation for every caller.
6. The controller may present one alert per unread burst from projected client pending/gap truth, but cannot invent, clear, or own unread/loss truth.
7. The client advertises finite positive `maxAdmittedControllerEntries` (`C`), `maxDormantControllerEntries`, and `maxDormantControllerBytes`. Disconnect assigns increasing `dormantSequence`; retained same-ID reconnect resumes exact cursors/gaps. Admission or dormant pressure reclaims dormant bundles by ascending sequence, never a live entry. If every admitted entry is live, new admission returns `controller_capacity`.
8. Dormant reclamation deletes that instance registry/cursor/gap state from live panes/surfaces and both tombstone kinds plus material retained solely for it, without advancing any remaining cursor. It emits `event.controller_retention_reclaimed` and durable exact diagnostics. Byte accounting includes registry/cursor/gap bytes plus unread records retained solely by dormant cursors, counting shared records once as specified by CTLRET.

#### Recoverable content and restart

Restart restores capability mode, stable surface/pane identities and allocation generations, lifecycle sequences and revisions, topology, visible and retained semantic content/history and provenance, actual annotations and unread frames, scopes, cursor floors/gaps, publisher outbox/cursor/gaps when supported, and dormant bundles before admission. Recovery of panes and surfaces lost to involuntary loss, and in 0.2.10-rc1 of closed panes and surfaces, remains available from retained URL or HTML/source content plus this semantic state. A screenshot or full-pane visual capture is not an ordinary mutation or restart prerequisite. Recovery does not reapply removed whole-pane/window byte caps or retained-tombstone count quotas, clamp valid restored live panes to the creation bound, or make a retained identity unrestorable because of those former limits. Atomic durability and generation-fenced identity/release evidence remain required; this rule changes no §4.10 publisher or consumable truth/acknowledgement contract.

#### Retired model register

Controller instance identity has only the uses allowed in §4.2. It does not partition content, history, cursors, routing, admission priority, or mutation rights. `ARCH-10` survives: hosts, addresses, runtime placement, and state roots remain external configuration, never product truth.

### 4.9 General Standalone Surf Ace CLI and Reusable Consumers

1. Surf Ace exposes one general standalone native Rust `surf-ace` CLI, directly callable by any local program, script, user, or agent. Tight Beam is one separate reusable-skill consumer of the identical installed executable through ordinary command execution; it does not own or redefine the executable, crate, package, commands, controller identity, runtime, configuration, state model, authority, or access gate. The delivered tree contains no Surf Ace MCP declaration/server/tool, MCP-only adapter, dedicated Surf Ace archetype, Tight-Beam-specific binary, or parallel fallback route. Attaching the Tight Beam skill changes neither the archetype identity nor unrelated archetype material. The only persistent foreground exception is the explicitly invoked annotation listener in §4.10; it is not installed or started automatically.
2. The existing direct-client command surface remains exactly `fleet-list`, `list`, `push`, `read`, `topology-intent`, `topology-realize`, `clear`, `annotations-remove`, `capture-pane`, `surface-intent`, `target-register`, and `target-apply`, with unchanged request, authority, and result semantics. Four separate registry-journal subcommands are added by §4.10: `annotations watch`, `annotations resume`, `annotations ack`, and `annotations retire`. `fleet-list` requires an explicit registry URL and reads registry-known inventory from the existing `fleet.topology` operation; it does not establish client reachability or supply client endpoints. It never infers registry configuration from environment or defaults. Inputs, acknowledgements, errors, and results are deterministic JSON. Endpoint, registry, state root, controller product label, and per-operation friendly chat label are external inputs; no machine, role, address, surface, topology, or provenance label is compiled in.
3. One state root atomically retains the stable controller instance ID, bounded projection, sticky gaps, projected cursors, acknowledgement outbox, resume metadata, and unresolved request/receipt correlations. Direct client-directed stateful invocations use the existing OS lock. Annotation consumer state is stored in `annotations/<lowercase SHA-256 of UTF-8 consumerId>` and records the original ID for collision/corruption checks; it has its own lock. A foreground listener never holds the ordinary client-command lock and holds the consumer lock only for local state transitions, not while waiting for network events or writing output. `fleet-list` accepts the required state-root argument for a uniform CLI invocation but does not open or mutate it. `read` instead performs one locked local transaction, opens no connection, advances only projected consumption, and atomically queues idempotent acknowledgement intent.
4. Every explicit client-directed network invocation connects directly to the public client WebSocket, pairs or resumes with the durable ID, reconciles client-ordered snapshots/deltas/gaps, flushes acknowledgements, resolves every uncertain request, performs the requested work if permitted, persists resulting state, and disconnects. `fleet-list` is separate: it makes one read-only request to the configured registry's existing `fleet.topology` operation, does not pair with a client, and reports registry-known inventory without asserting reachability or supplying endpoints. The §4.10 annotation commands instead connect directly to the configured registry WebSocket and never pair with or mutate a surface. No sidecar, daemon, resident MCP process, launchd/login item, autostart entry, or automatic persistent service participates.
5. A mutation remains connected until its exact correlated `operationReceipt` is durably stored and returned. Interruption after send and before durable receipt returns deterministic `outcome_unknown`, never success or an automatic retry. A later networked invocation must resolve all such IDs before another mutation. `target.apply` is the one asynchronous materialization seam: after pure validation and capacity checks, the client atomically persists the exact `intent_committed` response, receipt, and surface-charged work item before handing the response to the transport; browser/native materialization begins only after that send attempt. The receipt proves committed intent, never materialization success.
6. The client advertises finite positive pending-receipt count and exact serialized-byte limits per controller. It reserves capacity before mutation commit and atomically stores the exact terminal response and receipt under `(controllerInstanceId, requestId)`; overflow returns `receipt_capacity` and commits nothing. Individual receipts are never evicted.
7. Pair/resume is a barrier after the prior connection's mutation-seam work. `operation.receipt.sync` yields exactly `resolved_success`, `resolved_failure`, `not_committed`, `still_pending`, or `receipt_unavailable` with `controller_reclaimed` cause. Stored success/failure is replayed exactly without request re-execution; `not_committed` alone permits a later new request ID; `still_pending` keeps the invocation read/sync-only; unavailability is legal only after deterministic whole-controller-bundle reclamation. For `target.apply`, stored success replays the exact committed-intent response and does not infer materialization. The CLI persists replay before `operation.receipt.ack`; the client retains an accepted receipt until the CLI durably records that acceptance, and an idempotent release then deletes it. A crash on either side of the accepted-ack/local-marker boundary therefore replays the same terminal instead of converting it to `not_committed`. This cross-connection resolution is separate from connection-scoped request replay.
8. Durable target work progresses exactly `intent_committed → materializing → terminal`. Restart from `intent_committed` first persists `materializing`, then invokes the materializer once. Restart from `materializing` never invokes it again and terminalizes with `failed`/`materialization_outcome_unknown`. Terminalization emits exactly one separately correlated `event.target_apply_result` and append-only `target_result` occurrence in the percent-encoded surface scope, using normal surface snapshot, delta, gap, deduplication, and `consumable.ack` semantics without changing the intent receipt.
9. The same locked Rust source, canonical schemas/vectors, all twelve existing commands and the four §4.10 annotation subcommands, every acknowledgement/receipt/order/resume/failure path, receipt capacity/reclamation behavior, and deterministic fixtures must pass natively on macOS and Linux without caller-specific carve-outs. Direct non-Tight-Beam invocation proves the standalone product boundary. Separately, the Tight Beam skill must invoke that exact installed executable path/digest from two ordinary current archetypes and a future-archetype fixture without identity changes.

### 4.10 Durable Registry Annotation Journal and Any-Agent Subscription (Post-v0.2.5)

Mike's October 1 ruling authorizes a later-release, event-driven annotation subscription usable by any agent or script. Mike held this work until v0.2.5 shipped; that dependency is now satisfied. This section specifies the separate capability; it does not claim that a command, server journal, or client publisher is already shipped. It does not allocate a release number.

#### Authority and source records

1. The client remains authoritative for rendering, visible strokes, pane/surface topology, context, and frame lifecycle. The registry journal is authoritative only for annotation records it has durably accepted, their server cursors, and each consumer's acknowledged cursor. It cannot write, clear, navigate, or otherwise mutate client annotations or content. Client labels are display hints and never routing or authority keys.
2. The journal has exactly three record kinds: `live_delta`, `frame_commit`, and `source_gap`. A `live_delta` is emitted at the existing `event.drawing_flush` cadence; it carries the complete flush payload without adding per-stroke sends. A `frame_commit` follows the final flush for the frame and carries the exact immutable §13.2 closed-frame object, including its at-open screenshot, context, scroll offset, viewport, and full stroke set. A consumer can interpret it after the source client is offline and even if it did not receive earlier live deltas; it is not a pointer to a client-local record or a new commit-time screenshot. Frame identity and same-context re-entry follow Appendix A.8: re-entry before explicit commit continues the live frame; re-entry after commit starts a new frame ID.
3. Every source record contains `clientId`, a persisted random 128-bit `sourceEpoch` encoded as 32 lowercase hex digits, `surfaceId`, `paneId`, stable `frameId`, monotonically increasing decimal-string `sourceSequence` in `1..2^63-1`, and a stable `sourceEventId` generated and persisted before first send. The complete canonical record bytes, including timestamp and payload, are persisted before the first send and reused unchanged on retries. It also contains `kind`, `contentId`, the current non-negative `revision`, `contentType`, a viewport object from the existing surface protocol, an informational UTC RFC 3339 source timestamp, and channel payload. For a `live_delta`, `viewport` uses the content `Viewport` shape at flush. For a `frame_commit`, it uses the `SurfaceViewport` shape and exactly equals the embedded closed frame's viewport at open; `contentId` also equals the embedded frame's at-open content ID. The record's revision and content type describe that associated content without redefining the frame's coordinates. `sourceSequence` is strictly increasing within `(clientId, sourceEpoch, surfaceId)`; it starts at 1 for a new epoch/surface, and no causal order is asserted between different clients or derived from timestamps. If a source sequence reaches `2^63-1`, the publisher finishes sending all persisted records/gaps in that epoch before beginning a fresh random `sourceEpoch` at sequence 1; it never wraps or discards pending source state. Source event IDs are unique across all surfaces for one `(clientId, sourceEpoch)`. A frame commit's `imageSha256` is the SHA-256 of the Base64-decoded PNG file bytes of the existing §13.2 `frame.image`; the server verifies that image's PNG signature, dimensions, and hash before commit. Its dimensions are positive integers no larger than 16,384 per axis and no larger than 33,554,432 decoded pixels total. Image and strokes remain in viewport-at-open coordinates, with `scrollOffset` from frame open for content-space mapping.
4. The client publisher uses a separate durable per-surface partition, not the §4.8 coalesced consumable scopes. It has one source-sequence allocator, acknowledged server cursor, FIFO of exact canonical payload or sealed-gap records, and at most two reserved mutable gap states for overflow. It advertises `maxAnnotationPublisherStateBytesPerSurface` and `maxAnnotationPublisherRecordsPerSurface`; the byte limit includes all versioned durable framing and the record limit counts both payload and sealed-gap FIFO entries. These limits are enforced independently of controller admission, `surf_ace_read` acknowledgement, consumable coalescing, dormant reclamation, and pane/surface tombstone retention.
5. At each flush or frame finalization, the client allocates the next per-surface source sequence and either durably appends the complete immutable canonical record in this partition before first send, or durably records that sequence as unavailable in a sticky `source_gap`; it never claims server acceptance from a local append. The publisher reserves space for its cursor and two bounded mutable gap states before admitting payload records. When record count/bytes are full, a record exceeds the local or server maximum, or the registry is unavailable long enough to fill the partition, it does not evict a sent or unacknowledged record and does not block, clear, or alter visible annotation. Instead it advances source sequence and coalesces newly unavailable sequences into a durable trailing gap. The oldest gap is sealed to immutable canonical bytes in the FIFO before first send; new losses then coalesce only in the other reserved gap state. While a gap exists, no payload after that gap is admitted; new source events extend the unsealed trailing gap until the earlier gap has been accepted. Thus at most two mutable gap states suffice; after acceptance frees the oldest state the trailing gap can be sealed and sent. Source records and gaps are sent in source order, retried byte-identically after uncertain replies, and removed only after a durable registry acceptance response. A gap describes a surface sequence range and has no `paneId` or `frameId`; the range can cross panes or frames. Restart and surface close preserve both the FIFO and gap states. After a final surface close under §4.7.1, the partition allocates no new source sequence and is removed once every stored record and gap has a durable registry acceptance response. No §4.8 controller cursor, reclamation, or eviction can erase them; no loss is converted to empty success.
6. A definite record-specific rejection that commits nothing at the registry (including `annotation_record_too_large` after a lowered server limit or `annotation_context_image_invalid`) atomically replaces the rejected payload entry in its FIFO slot with an immutable singleton `source_gap` for the same source sequence and source event ID, reason `source_record_rejected`; the client durably records the exact rejected error code and sequence in health diagnostics. It sends that gap before later entries. An uncertain reply never permits replacement: the original canonical bytes remain for retry/deduplication. A connection-level or ambiguous failure, including `annotation_protocol_unsupported`, source-sequence conflict, or an unverified registry restore, keeps the original head and reports persistent unhealthy state until the underlying incompatibility is resolved; it neither discards the record nor claims a gap was accepted. A definitively rejected gap is likewise an unhealthy protocol fault, not empty success.
7. The v1 client advertises no more than 67,108,864 exact serialized bytes and 256 FIFO entries per surface for this partition, including all enclosing record/container bytes, source epoch/sequence, accepted cursor, two mutable gap slots, and their framing. Each mutable gap slot is at most 8,192 serialized bytes; these slots and cursor/framing are reserved inside the byte maximum before payload admission, and a payload may use only the remainder. The same cap applies during live operation, retained-surface-tombstone storage, restart restore, and configuration changes. A local limit may be lower, but must still reserve the two slots and fit one maximum permitted gap. The publisher validates record size and schema before deciding payload versus gap; a rejected or oversized source event cannot leave an unsendable record at the FIFO head. Exact state growth at the byte or record boundary creates a gap for that newly allocated sequence without disturbing already stored records. These client limits are separate from the fleet journal limits below.
8. Identity in source records is routing, ordering, and bookkeeping only. The registry does not treat `clientId`, `surfaceId`, pane IDs, labels, consumer IDs, or source-event IDs as authentication or proof of authorship. Tailnet/host configuration remains the security boundary; this section adds no relay, trust hierarchy, endpoint discovery, or security claim.
9. A persisted annotation-exit/commit intent (including an implementation flag such as `commitRequested`) is recoverable intent, not proof that the final direct `event.drawing_flush` was delivered or that `event.annotation_committed` completed. After process restart, retain the same open frame ID, context, and strokes and resume or reconcile its pending direct boundary. Interruption alone neither discards the frame, allocates a source sequence, nor creates `source_gap`. A source-journal `frame_commit` may be created only after durable boundary evidence proves that the final direct flush was delivered and the explicit commit event completed in that order. If direct delivery is ambiguous, preserve the frame, reconcile using stable event identity and existing safe deduplication, and report pending/unhealthy status truthfully; do not assume exactly-once delivery, create another logical frame, or publish a source `frame_commit`. Same-context re-entry before explicit commit is serialized with recovery and continues the same frame; recovery must not seal strokes added after re-entry. After a proven explicit commit, re-entry starts a new `frameId`. Keep visible strokes and ordinary direct-client use available while source completion is pending. If a source record was already durably appended but its reply/ack is uncertain, retry the persisted canonical bytes and same `sourceEventId` so registry deduplication returns the original cursor.

#### Durable append and delivery semantics

1. A client sends one `annotation.ingest` request per live delta or frame commit and one `annotation.source_gap` request per contiguous unavailable source range over a long-lived WebSocket to the explicitly configured registry. Both validate the exact v1 schema and byte limit, then atomically assign the next fleet journal cursor and commit the complete canonical record, source deduplication key, and journal head in PostgreSQL. Success is returned only after that transaction commits. A retry with the same `(clientId, sourceEpoch, sourceEventId)` and identical canonical bytes returns the original cursor; the same key with different bytes returns `annotation_source_event_conflict`. A reused source sequence returns `annotation_source_sequence_conflict`; a skipped sequence returns `annotation_source_gap_required` until its exact missing range is persisted as `source_gap`. A source-gap record sets `sourceSequence` to `lostThroughSequence`, and its `lostFromSequence` must equal the previous accepted sequence plus one (zero is the previous sequence before the first source record). It is followed only by records whose sequence is greater than `lostThroughSequence`. Rejections commit nothing. No source-ingestion acknowledgement is a consumer acknowledgement.
   Retained records compare exact canonical bytes for retry equality. After eligible compaction, durable source receipts compare canonical byte length and SHA-256 digest as specified in the finite-limit contract below; they still return the original cursor and commit time and never allocate another journal cursor.
2. A record cursor is `{epoch: <32 lowercase hex>, sequence: <canonical positive decimal string>}`; record sequence is in `1..2^63-1`, has no leading zero, and is allocated in the same transaction as the record. A cursor position has the same shape but may use sequence `0` to mean immediately before the first record in that epoch; zero is never a record cursor. CLI cursor spelling is exactly `ann1:<epoch>:<sequence>`; parsers reject other versions, uppercase hex, signs, whitespace, leading zeros, and overflow. A consumer with no acknowledged position has `ackCursor: null`; an empty journal has `headCursor: null` and `availableFromCursor: null`, not a fabricated record cursor. The epoch is durable for the lifetime of the journal generation. Cursors are stable across process restart and compare only within one epoch; no arithmetic successor is formed across epochs. PostgreSQL restore/migration must preserve the complete journal, deduplication rows, source-head rows, consumer cursors, and epoch from one consistent snapshot. If startup cannot prove continuity, it refuses annotation service with `annotation_journal_unverified`; it must not reuse cursors or silently report an empty history.
3. The registry cursor orders accepted records by PostgreSQL commit order for one fleet. It preserves increasing source sequence within each source surface, but it does not create causal ordering between clients. Consumers receive records at least once and deduplicate by `(epoch, sequence)`. They must not treat stdout, transport delivery, or receipt of a record as proof that their own processing completed.
4. Each `consumerId` has one independent durable acknowledgement cursor. Acknowledging for one consumer never advances, deletes, or hides another consumer's backlog. Reusing one consumer ID intentionally shares one cursor among its callers; there is at most one connected watch lease for that ID. A new resume increments/fences the lease generation, emits `annotation.lease_replaced` to the old stream, then closes it before the new lease becomes ready; an old lease cannot acknowledge. A disconnected stream releases its active-stream slot without retiring its consumer. Lease state is cursor-concurrency bookkeeping, not authentication.
5. `annotation.ack` may advance only monotonically through a contiguous prefix of records delivered under the current lease. Repeating the same acknowledgement is idempotent; regression, an undelivered cursor, a stale lease, or skipping an unresolved history gap is rejected. On registry process restart all former leases are fenced; a consumer must `annotation.resume` and receive the prefix under its new lease before acknowledging it. The consumer is responsible for making its own handling durable before it sends the acknowledgement. If it crashes before the server commits the acknowledgement, records replay; if it crashes after commit, resume begins after the acknowledged cursor. Exactly-once consumer side effects are not promised.
6. A new consumer without a requested start cursor begins at the oldest currently retained record and receives it inclusively. The successful `annotation.watch` and `annotation.resume` response payloads return `initialFromCursor`, `availableFromCursor`, `headCursor`, and `historyCompleteSinceStart`; the latter is false if prior journal history has been compacted. A new consumer stores that initial start position with `ackCursor: null`, so a restart before its first ack does not silently move its start. A never-used journal returns null for `availableFromCursor` and `headCursor` and an `initialFromCursor` at sequence 1, then waits for the next append. If the journal has a nonzero head but no retained records, `availableFromCursor` is null, `headCursor` remains the last allocated cursor, the initial position is immediately after that head, and `historyCompleteSinceStart` is false; it is not reported as a never-used journal. `annotation.watch` may include `fromCursor` to request an inclusive replay position; it must be a retained record cursor or exactly the next cursor after `headCursor`. A cursor beyond that is `annotation_cursor_invalid`. If the requested cursor predates retained history or belongs to another epoch, the registry sends `annotation.history_gap` with the requested and available ranges and pauses delivery until the consumer explicitly acknowledges that exact gap. The gap's `throughCursor` is the cursor position immediately before `availableFromCursor`; if no record is retained, it is the current `headCursor` boundary (sequence 0 only when no record has ever been appended). A gap acknowledgement advances the consumer's scan/acknowledgement position to that boundary but never acknowledges a retained record. `annotation.resume` resumes after the stored acknowledgement position, or from the original `initialFromCursor` if no record or gap has been acknowledged. Source loss is instead a durable `source_gap` journal record in source-sequence order.
7. `annotation.consumer.retire` is explicit and names the expected acknowledgement cursor plus an affirmative discard-unacknowledged field. It returns the exact discarded consumer range and releases that consumer's hold; a disconnect, absence, timeout, or lack of activity never retires a consumer or discards its cursor. Retired consumer IDs remain tombstoned for the replay window to prevent accidental reset.

#### Public wire and CLI contract

1. Annotation operations use the existing UTF-8 JSON WebSocket envelope and correlation rules in §§5.1–5.3, over the explicitly configured v1 `ws` registry URL. A request is `{v: 1, type: "request", op, id, sentAt, payload}`; a successful response is `{v: 1, type: "response", op, id, ok: true, sentAt, payload}`, and an error response has `ok: false` and `error` instead of `payload`. Server events are `{v: 1, type: "event", op, eventId, sentAt, payload}`. The new request operations are `annotation.hello`, `annotation.ingest`, `annotation.source_gap`, `annotation.watch`, `annotation.resume`, `annotation.ack`, `annotation.gap.ack`, and `annotation.consumer.retire`; server-pushed records use `annotation.record`, `annotation.history_gap`, `annotation.lease_replaced`, or `annotation.consumer_retired`. Each request has a unique ID; responses correlate to it and server events have independent event IDs. `sentAt` is the existing non-negative `EpochMs` integer and never determines source or journal order. The registry does not accept annotation operations on a client surface socket, and the surface protocol's existing request, event, receipt, and `surf_ace_read` semantics do not change.
2. The exact v1 operation payloads are: `annotation.hello {protocolVersion: 1, role: "publisher"|"consumer"}`; `annotation.ingest {record: SourceRecord}`; `annotation.source_gap {record: SourceGapRecord}`; `annotation.watch {consumerId, fromCursor?}`; `annotation.resume {consumerId}`; `annotation.ack {consumerId, leaseId, throughCursor}`; `annotation.gap.ack {consumerId, leaseId, gapId}`; and `annotation.consumer.retire {consumerId, expectedAckCursor: CursorPosition|null, discardUnacknowledged: true}`. Every object has exactly its listed properties except for the explicitly optional `fromCursor`; unknown properties fail with `annotation_invalid_request`. Publisher role may only append source records; consumer role may only watch, resume, acknowledge, gap-acknowledge, and retire; wrong-role operations fail with `annotation_role_operation_invalid`. `consumerId` and `leaseId` are opaque, case-sensitive UTF-8 strings; a lease ID is 32 lowercase hex digits, generated by the server, retained as the current lease until replaced or retired, and is not a credential. `SourceRecord` has `protocolVersion: 1`, `clientId: string`, `sourceEpoch: 32-lowercase-hex string`, `surfaceId: string`, `paneId: positive integer`, `frameId: string`, `sourceSequence: canonical positive decimal string`, `sourceEventId: string`, `kind`, `contentId: string`, `revision: non-negative integer`, `contentType` from the existing `ContentType` enum, `viewport` in the existing `Viewport` shape for `live_delta` or the existing `SurfaceViewport` shape for `frame_commit`, `sourceTimestamp: UTC RFC 3339 string`, and `payload`. `kind` is `live_delta` or `frame_commit`. `SourceGapRecord` has `protocolVersion`, `clientId`, `sourceEpoch`, `surfaceId`, `sourceEventId`, `sourceSequence` equal to `lostThroughSequence`, `lostFromSequence`, `lostThroughSequence`, and `reason: "source_retention_overflow"|"source_record_rejected"`; it deliberately omits `paneId` and `frameId` because one range can span contexts. Source string identifiers are non-empty UTF-8 strings no longer than 128 bytes; `sourceEpoch` is 32 lowercase hex digits; `sourceSequence`, `lostFromSequence`, and `lostThroughSequence` are canonical positive decimal strings no greater than `2^63-1`; and `lostFromSequence <= lostThroughSequence`. The source-gap range must start at the next expected sequence. `consumerId` is 1–128 UTF-8 bytes. A `live_delta` payload is the complete canonical flush event; a `frame_commit` payload is `{frame: ClosedFrame, imageSha256: <64 lowercase hex>}`, where `ClosedFrame` is the exact §13.2 frame object with its at-open Base64 PNG `image`, `scrollOffset`, `contextKey`, optional `url`, viewport, timestamps, and complete strokes. The hash covers Base64-decoded PNG file bytes of `frame.image`; no separate image is captured or substituted. All canonical records use RFC 8785 JSON Canonicalization Scheme bytes for deterministic duplicate comparison; numeric limits count those record bytes, not the outer request envelope. `annotation.hello` returns `registryId`, `journalEpoch`, `availableFromCursor`, `headCursor`, `limits`, and `usage: {journalRecords, journalCanonicalBytes, sourceMetadataRows, sourceMetadataBytes, consumerSlots, activeStreams}`. The `limits` object includes `replayPolicy: {targetAcknowledgedHistoryDays: 30, pressureCompaction: true, requireActualConsumerAcknowledgement: true}` and the shared 1 GiB byte cap. Publisher hello does not register a client or prove identity. It is the first registry operation on a connection and fixes that connection's role. `annotation.watch` creates a new named consumer at the available-history boundary, or at optional `fromCursor`, and fails with `annotation_consumer_exists` if that ID already exists. `annotation.resume` requires an existing ID and returns its acknowledged cursor plus a fresh lease.
3. `annotation.hello` responds with `{registryId, journalEpoch, availableFromCursor, headCursor, limits, usage}`; these boundary cursors use the same null/compacted-history rules as `annotation.watch` and `annotation.resume`. Successful `annotation.ingest` and `annotation.source_gap` responses contain `{serverCursor, duplicate, committedAt}`; a duplicate returns the original cursor and commit time. Successful `annotation.watch` and `annotation.resume` response payloads contain `consumerId`, `leaseId`, `ackCursor`, `initialFromCursor`, `availableFromCursor`, `headCursor`, `historyCompleteSinceStart`, and `limits`. A never-used journal returns null `ackCursor`, `availableFromCursor`, and `headCursor`, and an initial cursor position at sequence 1. `historyCompleteSinceStart` is true only if no earlier fleet journal prefix was compacted and every journal record at or after `initialFromCursor` through `headCursor` is available; explicit source-gap records are part of that history. If pressure compaction advanced the retained floor, it is false even for a new consumer starting at that floor. `annotation.ack` responds with the current `ackCursor`; `annotation.gap.ack` responds with the updated position and `gapId`. `annotation.consumer.retire` responds with `{consumerId, retired: true, expectedAckCursor, discardedFromCursor, discardedThroughCursor}`, with null discard bounds when there was no unacknowledged range. Retiring an already retired ID is idempotent only when the expected cursor matches its tombstone; otherwise it returns `annotation_ack_cursor_mismatch`. An active stream receives `annotation.consumer_retired` and is closed by retirement. `annotation.record` contains the server cursor, complete `SourceRecord`, and journal commit time. `annotation.history_gap` contains `gapId`, requested cursor, `availableFromCursor` (nullable), `throughCursor`, current `headCursor`, and a stable reason (`cursor_expired` or `epoch_changed`). The consumer must acknowledge that exact `gapId` through `annotation.gap.ack`; the event's `throughCursor` is the scan position after the gap, not a record cursor. The registry never uses an empty list to imply unavailable requested history was complete.
4. The exact optional foreground CLI interface is:

   ```text
   surf-ace --registry <ws-registry-url> --state-root <dir> annotations watch --consumer-id <name> [--from <ann1:epoch:sequence>]
   surf-ace --registry <ws-registry-url> --state-root <dir> annotations resume --consumer-id <name>
   surf-ace --registry <ws-registry-url> --state-root <dir> annotations ack --consumer-id <name> --cursor <ann1:epoch:sequence>
   surf-ace --registry <ws-registry-url> --state-root <dir> annotations ack --consumer-id <name> --gap-id <gap-id>
   surf-ace --registry <ws-registry-url> --state-root <dir> annotations retire --consumer-id <name> --expect-ack <none|ann1:epoch:sequence> --discard-unacknowledged
   ```

   `watch` creates a consumer once; `resume` is the explicit reconnect path. Both are foreground, event-driven commands that emit deterministic NDJSON and make no periodic polling requests. Their initial NDJSON status includes the advertised replay policy, current `availableFromCursor` and `headCursor`, and `historyCompleteSinceStart`; an earlier requested cursor produces an explicit history-gap event rather than an empty stream. Record cursor arguments and output use `ann1:<32-lowercase-hex-epoch>:<positive-decimal-sequence>`; `--expect-ack` additionally accepts `none` or the sequence-zero boundary position `ann1:<epoch>:0`. `ack --cursor` accepts only a delivered positive record cursor. `ack` is an explicit consumer assertion after durable processing; output delivery alone never causes it. Listener state stores only consumer identity, lease, and cursors under its separate namespace, not a second annotation authority or a copy of ordinary command state. No command installs a service, autostarts, or injects events into a harness conversation.
5. Stable error codes are `annotation_invalid_request`, `annotation_protocol_unsupported`, `annotation_role_operation_invalid`, `annotation_cursor_invalid`, `annotation_context_image_invalid`, `annotation_record_too_large`, `annotation_source_event_conflict`, `annotation_source_sequence_conflict`, `annotation_source_gap_required`, `annotation_source_gap_invalid`, `annotation_source_sequence_exhausted`, `annotation_ingest_capacity`, `annotation_journal_sequence_exhausted`, `annotation_consumer_capacity`, `annotation_consumer_exists`, `annotation_consumer_not_found`, `annotation_consumer_lease_stale`, `annotation_ack_regression`, `annotation_ack_not_delivered`, `annotation_ack_cursor_mismatch`, `annotation_gap_ack_required`, `annotation_gap_id_mismatch`, `annotation_consumer_retire_confirmation_required`, and `annotation_journal_unverified`. Transport unavailability is a transport failure, not an empty successful response. Every capacity error includes the relevant configured/current count or byte values and the condition that can permit retry. Journal sequence exhaustion fails closed without wrapping or changing epochs; recovery requires a separately reviewed migration that preserves or explicitly declares history loss.

#### Finite v1 limits, replay, and migration

1. These v1 limits are hard maxima and are returned by `annotation.hello` and the successful `annotation.watch` / `annotation.resume` response payloads; a server may advertise a lower configured capacity but never a higher one. Journal record byte accounting is the UTF-8 length of the complete canonical JSON record including identity and payload (including the at-open image in a frame commit). Source receipt/head byte accounting is exact versioned durable serialization. Both exclude PostgreSQL index/page overhead:

   | Limit | v1 maximum/default |
   |---|---:|
   | Consumer ID UTF-8 bytes | 128 |
   | Client/surface/frame/source-event string ID UTF-8 bytes | 128 each |
   | Source and journal epoch | 32 lowercase hex digits each |
   | Lease ID and history-gap ID | 32 lowercase hex digits each |
   | At-open frame image PNG raw bytes | 10,485,760 |
   | Complete annotation record bytes | 16,777,216 |
   | Journal records per fleet | 100,000 |
   | Journal payload plus source-metadata durable bytes per fleet | 1,073,741,824 |
   | Consumer IDs per fleet (including retained retired tombstones) | 64 |
   | Concurrent active watch streams per fleet | 32 |
   | In-flight records per consumer | 32 |
   | In-flight canonical bytes per consumer | 67,108,864 |
   | Target acknowledged-record replay window | 30 days, best effort under capacity pressure |
   | Source receipt and source-head rows per fleet | 1,000,000 |

2. The 30-day replay window is a target for acknowledged history, not a promise that overrides finite capacity. In ordinary maintenance, compact only an oldest contiguous prefix older than 30 days whose every record meets the consumer-acknowledgement eligibility rule below. Before refusing a valid new ingest for journal count or shared byte pressure, the registry compacts the oldest eligible acknowledged prefix younger than 30 days only as far as needed for the new record to fit both limits. A record is eligible only if at least one non-retired consumer whose required range covered it actually acknowledged it and every non-retired consumer whose required range covers it has acknowledged it; consumers whose requested start was later do not hold older records. An empty consumer set or no actual acknowledgement is not vacuous permission to erase history. No unacknowledged accepted record expires because a consumer is slow, disconnected, or absent. Compaction durably advances `first_retained_sequence`, preserves `head_sequence`, consumer cursors, and source deduplication receipts in the same transaction. New consumers see the truthful retained floor and `historyCompleteSinceStart: false` whenever any prior journal prefix was compacted; a requested older cursor receives `annotation.history_gap` and requires explicit gap acknowledgement. If no eligible prefix, combined byte capacity, or source-metadata row capacity permits the new append, return `annotation_ingest_capacity` and commit neither record nor success acknowledgement. The publisher retains that unaccepted source record in its bounded §4.10 partition; when that partition fills, later source events become an explicit sticky `source_gap` as specified above.
3. Compaction moves each removed record's source key, source range, canonical-record byte length and SHA-256 digest, original server cursor and commit time into a durable receipt; it does not remove deduplication history. Exact versioned receipt and source-head serialization counts against the source-metadata row cap and the same 1 GiB fleet byte cap as deliverable journal payload; compaction therefore frees only the difference between removed payload bytes and retained metadata bytes. The fleet-head transaction checks live records and receipts before assigning a cursor: a retry matching the stored length and digest returns the original cursor/commit time with `duplicate: true`, while a changed length or digest returns `annotation_source_event_conflict`. Per-source accepted-through sequence is retained in a durable source-head row, including source-gap ranges, so replay inside a compacted gap cannot be accepted as new. The implementation treats SHA-256 equality over canonical bytes as v1 retry equality after compaction and records that rule in the public interface; it never reports a compacted source event as a new append. Receipt and source-head rows do not expire automatically. When a metadata limit prevents compaction and the journal limit prevents append, the registry refuses with `annotation_ingest_capacity` rather than deleting deduplication proof or unread history. Source receipt usage is exposed with journal limits/usage and in capacity errors.
4. The in-flight limits pause delivery to that consumer until acknowledgement; they do not reject ingestion or discard journal rows. The 64-consumer and 32-active-stream limits fail with `annotation_consumer_capacity`; a caller must explicitly retire a consumer before its durable cursor can be released. A source record over the 16 MiB canonical-byte maximum returns `annotation_record_too_large`, never a truncated or accepted record.
5. The implementation adds one forward-only `packages/allocator/sql/003_annotation_journal.sql` migration in the existing allocator schema. It adds per-fleet journal head/epoch, append-only records, bounded compacted source receipts, source high-water rows, durable consumer cursor/lease generation and explicit retirement state. It does not rewrite `fleets`, pane/window allocation, `custody_journal`, client data, or existing cursor rows. Migration is transactional, validates existing 001/002 state first, and preserves all new journal, receipt, source-head and consumer rows in ordinary backup/restore. There is no destructive down migration; older binaries may leave the tables untouched but must not claim subscription support. Startup verifies a contiguous retained journal head, source high-water continuity, receipt counts and unique source keys before accepting annotation operations.
6. The migration's required logical relations are `annotation_journal_head(fleet_id, epoch, head_sequence, first_retained_sequence, retained_record_count, retained_canonical_bytes, source_metadata_rows, source_metadata_bytes)`, `annotation_journal_records(fleet_id, epoch, sequence, client_id, source_epoch, surface_id, source_sequence, source_event_id, kind, canonical_record_bytes, canonical_record_length, committed_at)`, and `annotation_consumers(fleet_id, consumer_id, initial_from_epoch, initial_from_sequence, ack_epoch, ack_sequence, lease_generation, current_lease_id, lease_connected, retired_at, retired_expected_ack_cursor, retired_discarded_from_cursor, retired_discarded_through_cursor)`. The head has one row per fleet; `first_retained_sequence` is null and internal `head_sequence` is 0 when the journal is empty. Record rows have a primary key on `(fleet_id, epoch, sequence)`, a unique key on `(fleet_id, client_id, source_epoch, source_event_id)`, and a unique key on `(fleet_id, client_id, source_epoch, surface_id, source_sequence)`. `canonical_record_bytes` is the exact RFC 8785 canonical UTF-8 JSON byte sequence used for retry equality; its measured length is counted toward fleet and in-flight byte limits. Consumer rows are keyed by `(fleet_id, consumer_id)`; `ack_epoch`/`ack_sequence` are null until a record or explicit history-gap boundary is acknowledged. The current lease ID/generation remains valid for explicit acknowledgements after disconnect until the registry process restarts; startup fences all former leases and requires a new resume/delivery before any acknowledgement. A resume atomically replaces the old lease and fences its predecessor. `lease_connected` is true only for a connected watch stream and false after its socket closes; it determines the active-stream count. Retirement stores the expected cursor and discarded range in the tombstone so a matching retry returns the original result. The transaction locks the fleet's head row `FOR UPDATE`, then allocates the next cursor and updates the record, dedupe keys, head, and retained counts atomically. A compacted prefix advances `first_retained_sequence`; retained journal sequences remain contiguous through `head_sequence`.

The migration also adds `annotation_source_receipts(fleet_id, client_id, source_epoch, surface_id, source_sequence, source_event_id, lost_from_sequence, canonical_sha256, canonical_length, original_epoch, original_sequence, committed_at)` and `annotation_source_heads(fleet_id, client_id, source_epoch, surface_id, accepted_through_sequence)`. `lost_from_sequence` is nullable except for a source gap. Receipt rows are keyed by both source event ID and source sequence/range; source-head rows reject any new record or gap overlapping an already accepted range. The fleet-head lock serializes lookup across retained journal rows and compacted receipts, so moving rows during compaction cannot create an acceptance gap. Combined receipt/source-head count and exact serialized byte totals are kept in the fleet head, validated on startup, and included in backup/restore; no compaction or append may exceed their declared limits.

#### Intended implementation path map and deterministic acceptance

This is a mapping for the later implementation review, not authorization to edit these files now. Only the current `DESIGN.md` is in scope for this specification phase.

| Concern | Intended source/schema/test paths |
|---|---|
| Wire contract and cross-language vectors | `packages/protocol/schema.json`; `packages/protocol/src/{index.ts,messages.ts,schemas.ts,schemas-manifest.ts,validate.ts}`; new `packages/protocol/vectors/annotation-subscription-v1.json`; `packages/protocol/src/validate.test.ts` |
| PostgreSQL journal, deduplication, cursors, errors, migration | `packages/allocator/sql/003_annotation_journal.sql`; `packages/allocator/src/{domain.ts,validation.ts,server.ts}`; new `packages/allocator/src/annotation-journal.ts`; `packages/allocator/src/postgres.integration.test.ts` plus a focused journal integration test |
| Electron annotation source publisher | `packages/electron/src/{surface-core.ts,ws-server.ts}` plus a focused `packages/electron/test/annotation-publisher.test.ts` |
| iOS/iPadOS annotation source publisher | `packages/ios/SurfAce/SurfAceRuntime.swift`, `packages/ios/SurfAce/SurfAceLocklessConsumableOperations.swift`, a focused publisher type, and `packages/ios/SurfAceTests/SurfAceAnnotationPublisherTests.swift` |
| Foreground Rust CLI watch/resume/ack/retire | `packages/cli/src/{command.rs,controller.rs,state.rs,wire.rs}`; `packages/cli/tests/annotations.rs`; `packages/cli/vectors/cli-conformance.json` |
| Release binding and operator/user guidance | `scripts/release/{build-tightbeam-release.mjs,tightbeam-release-config.mjs,release-tooling.test.mjs,tightbeam-state-smoke-fixture.ts}`; `docs/release/tightbeam-linux-operations.md`; `packages/cli/README.md`; `README.md`; `integrations/tightbeam/skills/surf-ace/SKILL.md` |

Acceptance fixtures must deterministically prove: source append commits before its acknowledgement; crash after commit/before reply retries to the same cursor; duplicate key with different bytes is rejected; per-surface source order and no cross-client causal claim; a frame commit is independently interpretable from its exact §13.2 at-open image, `scrollOffset`, viewport, and complete strokes even when every earlier live delta is absent; two clients and multiple panes feed two consumers with wrong-surface isolation; consumers acknowledge independently; same-ID shared cursor and lease replacement fence stale acknowledgements, including after registry restart; restart/resume and catch-up/live handoff have no race; more updates than the existing client queue capacity are retained when server ingestion is healthy and the consumer is offline; independent publisher byte/count limits hold exactly at boundary through surface close/restart while ordinary consumable coalescing, acknowledgement, and dormant reclaim cannot erase publisher state; source outage/overflow creates an explicit sticky gap, including one sealed in-flight gap and subsequent losses in the trailing gap, without altering visible annotation; a definite record-specific rejection replaces only its FIFO slot with a singleton gap and persistent diagnostic, while a lost reply or protocol-level failure retains bytes and cannot claim acceptance; journal count/byte and consumer/in-flight limits refuse at the exact boundary without silent eviction; fully acknowledged oldest-prefix records compact early under journal pressure even inside 30 days while no-consumer history and unread accepted records remain protected; compaction moves source dedup receipts atomically and exact retry after compaction returns the original cursor; metadata-capacity exhaustion refuses ingestion rather than deleting deduplication proof; the retained floor and `historyCompleteSinceStart` disclose early compaction, and a requested older cursor produces an explicit gap requiring acknowledgement; retirement is explicit; an idle stream makes no polling requests; and all four CLI commands produce identical protocol behavior on native Linux/macOS and in a packaged CLI fixture. Electron and iOS producer tests must prove commit-before-publish without changing visible strokes, content, pane labels, surface isolation, or any existing direct command. The release smoke must exercise two clients and two independent consumers against one registry and preserve the existing pane-number, label, annotation-lifecycle, and direct-command gates.

#### Interrupted frame-finalization acceptance

In addition to the general fixtures above, deterministically inject restart (a) after persisted commit intent but before final direct flush, (b) after direct flush but before explicit `event.annotation_committed`, and (c) after that explicit event but before source-journal append/ack. For (a) and (b), assert restart retains the same frame ID, context, and strokes and creates no `source_gap` solely for interruption; assert no source `frame_commit` appears before recovery proves the ordered direct boundary, then exactly one appears after completion. Assert same-context re-entry before explicit commit appends to that same frame and stale recovery cannot close newer strokes, while re-entry after a proven commit uses a new frame ID. For (c), assert a proven-but-unpublished commit resumes with stable source event identity; if append already happened but its acknowledgement is uncertain, retry the same canonical bytes and return the same cursor without a duplicate. Visible annotation and ordinary direct-client operations remain available with truthful pending status.

## 5. Message Model

### 5.1 Encoding
1. UTF-8 JSON text messages only.
2. Binary WS frames are not used by v1.

### 5.2 Envelope Types
1. `request`: provider -> surface command with correlation `id`.
2. `response`: surface -> provider reply matching request `id`.
3. `event`: surface -> provider async user interaction stream.

### 5.3 Correlation and Idempotency
1. Every request has unique `id` per connection.
2. Surface caches last 1024 request IDs for idempotent replay.
3. Duplicate request ID with identical payload must return the original response.
4. Duplicate request ID with different payload returns `invalid_request_id_reuse`.
5. The optional pane-paint diagnostic has the explicit bounded metadata-ledger
   exception in §12.1. Ordinary request replay remains governed by rules 1–4.

### 5.4 Ordering and Mutation Seam
1. On a lockless-capable surface, every accepted content operation traverses the client-owned mutation seam.
2. `content.set` is append-style: the client allocates the next content revision and a new history-entry ID and commits the new visible entry atomically. Controllers do not submit an authoritative revision or `historyOwnerToken`.
3. `content.append`, `content.patch`, and `content.clear` target current client state with the operation's required expected-state token; the client allocates the committed revision.
4. Expected-state mismatch returns the applicable stable stale error with current authoritative state and commits nothing.
6. Drawing overlay mutations are provider-controlled through `annotations.remove`; surface never autonomously deletes strokes.

### 5.5 Size Limits

Surface advertises limits in `pair.response`:
1. `maxMessageBytes` (default 12 MiB).
2. `maxFrameBytes` (default 10 MiB for `content.set` content payload).
3. `maxVisibleTextBytes` (default 4096).
4. `maxStrokePointsPerFlush` (default 8192 for `event.drawing_flush`).
5. `maxDrawingFlushBytes` (default 2 MiB).
6. Lockless pane creation field: `maxPanesPerSurface`. The former recoverable-state fields `maxSurfaceRecoverableBaseBytes`, `maxPaneRecoverableStateBytes`, `maxPaneAnnotationRestoreBytes`, `maxRetainedTombstones`, `maxRetainedTombstoneBytes`, and `maxRecoverableSurfaceBytes` may remain as legacy wire compatibility fields; they are not required capability gates and MUST NOT impose ordinary-mutation or retained-close/restore quotas.
7. Lockless LIVEBUF limits: `maxPaneConsumableRecords`, `maxPaneConsumableBytes`, `maxSurfaceConsumableRecords`, `maxSurfaceConsumableBytes`, `maxConsumableRecordBytes`, and `maxConsumableCursorStateBytesPerScope`.
8. Lockless CTLRET limits: `maxAdmittedControllerEntries`, `maxDormantControllerEntries`, and `maxDormantControllerBytes`.

A client advertising `surf-ace.lockless-multi-controller.v1` MUST return every lockless limit above as a required finite positive capability field. Omission fails lockless admission; controllers MUST NOT infer defaults.

Requests above limit return `content_too_large`; severe violations may close socket with code `4413`.
Severe violation threshold:
1. Message size > 2x `maxMessageBytes`, or
2. 3+ `content_too_large` responses on one connection within 60s.

## 6. Operations

### 6.0 Surfaces List (Multi-Window Discovery)

`surfaces.list` is an endpoint-scoped request that may be called before pairing. It returns currently active window surfaces on the endpoint.

Rules:
1. Provider MAY call `surfaces.list` immediately after WS connect.
2. After lifecycle admission, the response contains client-authoritative live surfaces with `windowLabel` (`null` while pending), restorable retained surface tombstones (a final close under §4.7.1 leaves none), `surfaceSetRevision`, capability state, admission availability, and the bounded durable admission-attempt ledger. Pre-pair and surface-scoped discovery omit the ledger.
3. `surfaces.list` is discovery-only and grants no pane/topology/lifecycle right.
4. Any controller meeting lockless identity/capacity admission may send `pair.request`; a duplicate live ID or full all-live controller registry receives its distinct stable refusal.
5. Full pane topology discovery follows admission via `panes.list`, and valid restored live pane counts above `maxPanesPerSurface` are reported without clamping.

Each admission-attempt ledger record contains the exact `surfaceId`, `controllerInstanceId`, triggering request ID, monotonic attempt sequence, start/update times, last reached stage, outcome, and failure code/message. Request and controller IDs use `[A-Za-z0-9._:-]{1,64}`; surface IDs use `sf_` followed by 3–64 characters from the same set. Failure codes use `[a-z_]{1,64}`. Failure messages retain at most 512 UTF-8 bytes in their JSON string encoding and carry `…[truncated]` when the exact message exceeds that bound.

The ledger retains at most 256 records and at most 128 KiB of JSON-encoded records. Pending records reserve the longest stage, maximum failure-code and failure-message space, and maximum update timestamp, so every later stage transition and terminalization remains within the byte bound. The client refuses a new surface admission with `surface_state_capacity` before it allocates a sequence, appends, performs surface lookup, or changes authority when either limit would be exceeded. It never evicts an admission record or rewinds the monotonic sequence. Existing persisted state outside these bounds is invalid state and causes a loud startup refusal instead of inference or repair.

Within those limits, the client persists the pending record before admission work begins. A failed attempt survives transaction rollback and restart. A successful attempt is committed atomically with the admitted authority and surface state. Lifecycle `surfaces.list` exposes the complete retained ledger; pre-pair and surface-scoped discovery omit it.

### 6.0.1 Pre-Pair Named-Window Describe

The CLI's registry-to-direct named-window flow uses the registry lease in §3.1.3 and one direct surface.describe request in §3.1.4. This contract defines future support; it does not claim that the current CLI, current client wire, or current registry implements it.

1. Read fleet.topology at the explicitly configured registry and select exactly one current surface whose canonical windowLabel equals the requested label. If the registry is unavailable, the match is absent or ambiguous, the row is stale, or the endpoint capability is unsupported, return that explicit status without connecting to a guessed endpoint.
2. Connect to the exact direct endpoint from that row and issue one fresh surface.describe request containing the selected identity, surface, lease generation, request id, and nonce. Do not call pair.request, client.register, pane.claim, or any mutating operation.
3. Accept the direct response as an observation of the named window when its v1 envelope, request id, operation, nonce, clientId, and surfaceId match the request and selected row, and its payload is well formed under §3.1.4, including a preserved paneId 0. A malformed envelope or payload, or a different request id, operation, or nonce, is unsupported_protocol or stale_response. A different clientId or surfaceId is identity_mismatch, and the observation is not presented as the named window. A null or different registryIdentity or endpointLeaseGeneration does not reject the observation; it is reported under item 4. Re-read fleet.topology and apply §3.1.3 item 6 before returning current status.
4. Report transportReachability, applicationReadiness, registry registration age/expiry, identityConsistency, surfaceSetRevision, topologyRevision, committed layout, pane ids/labels, and each pane's contentRevision/source/observation time as distinct evidence. Never call identityConsistency authenticated. A ready result is limited to the client-reported describe readiness at the reported observation; it does not promise a later mutation will succeed.
   identityConsistency is an object with members clientId, surfaceId, registryIdentity, and endpointLease. On an accepted observation, clientId and surfaceId are matched. registryIdentity and endpointLease each take one value:

   | Value | Condition |
   |---|---|
   | matched | The response value equals the selected row, and applicationReadiness lists neither persistence_outcome_unknown nor an unavailable or stale code for that member |
   | unverified | The response value equals the selected row, but matched does not hold |
   | absent | The response value is null |
   | differs | The response value is non-null and differs from the selected row |

   The CLI SHALL NOT report matched for a member it cannot establish as matched. When either member is not matched, the CLI SHALL still return the observation as a successful result; the identityConsistency values and the client's limitation codes in that result are the warning.

   Acceptance example: the registry row selects lease generation 7 and the client answers with a registryIdentity equal to the row, endpointLeaseGeneration 6, status degraded, and limitationCodes [persistence_outcome_unknown, endpoint_lease_stale]. The CLI returns a successful result containing the layout and panes, applicationReadiness degraded with those codes, and identityConsistency {clientId: matched, surfaceId: matched, registryIdentity: unverified, endpointLease: differs}.
5. Return explicit not_found, ambiguous, stale_registration, endpoint_unconfigured, registry_unavailable, unreachable, application_unresponsive, unsupported_protocol, identity_mismatch, surface_not_found, revision_churn, degraded, or not_ready outcomes as applicable. If the WebSocket connected but the describe response was absent or invalid, report transport reachable and application readiness unknown or not_ready; do not collapse these into one health bit. Do not fall back to Bonjour, a cached result, the registry endpoint, or another matching client.
6. A later mutation remains a separate explicit direct-client command and MUST use its current supported expected-revision, request-correlation, receipt, and destructive-target guards. Discovery does not pair, reserve, authorize, replay, or perform that mutation.


### 6.1 Pair Handshake

Flow:
1. Provider opens WS.
2. Provider may call `surfaces.list` to discover available surfaces.
3. Provider sends `pair.request`.
4. Surface replies `pair.response` (success or error). Success means new controller admission or same-ID retained-state resume. A surface-scoped success includes the committed admission-attempt record.
5. If success, connection enters active mode and event streaming starts immediately.

`pair.request` fields include:
1. `controllerInstanceId` (mandatory stable opaque asserted instance identity). It is persisted across restart/redeploy and scopes only deconfliction, cursors, correlation, and diagnostics.
2. `connectionId` (unique per socket attempt).
3. `surfaceId` (target window surface on multi-window endpoints).
4. `resume` (optional prior synchronization/cursor/gap generation state for the same controller instance).
6. `providerName` (required human-readable provider/product display metadata and diagnostics only; never identity, routing, or authority).
7. `eventProfile` (optional, default `minimum_deep`).
8. `drawingFlushConfig` (optional, provider-preferred idle/max interval values).
12. `protocolVersion` (`1` for this spec).

`pair.response` success includes:
1. `sessionId`.
2. `resumed` boolean.
3. Surface metadata (id/name/viewport/capabilities and `windowLabel`, `null` while pending).
4. `eventConfig` (active event profile, active event list, and effective drawing flush config).
5. Limits.
6. Current pane state summary (`panes[]` with per-pane `paneId`, `paneLabel`, `currentContentId`, `currentRevision`, and `contentType`) plus current topology/surface revisions, bounded consumable snapshot/cursor/gap state, and retained lifecycle state required by negotiated lockless capability.

A successful `pair.response` MUST include at least one topology pane. Providers MUST treat `state.panes.length < 1` as a protocol failure and MUST NOT mark that surface connected or targetable from that response. Fresh Surf Ace surfaces expose at least one targetable topology pane.

### 6.1.1 Controller Admission, Recoverable Lifecycle, and Shared History Operations (Phase 1)

These operations are post-admission and scoped to client authority. They implement §§4.2–4.8.

#### `surface.window.open`
Requests that the paired Surf Ace Spatial app endpoint create a new top-level Surf Ace Spatial surface window.

**Request fields:** `expectedSurfaceSetRevision`; optional `requestedBy` diagnostic string.

**Behavior:**
1. On a platform advertising controller window lifecycle, any admitted controller may call `surface.window.open` under the same identity-independent rules as local open.
2. The endpoint compares `expectedSurfaceSetRevision`, validates pane-creation admission and the separate surface-admission ledger in §6.0, and atomically allocates the new surface and initial pane IDs before emitting `event.surface_appeared`. Registry-confirmed labels may arrive before or after that local commit; pending labels are `null` in the event and snapshots.
3. A platform may return `unsupported_operation` only when controller window lifecycle is not a product operation there.
4. The request does not mutate pane topology inside an existing surface.

#### `surface.window.close`
Requests that the paired Surf Ace Spatial app close the currently paired top-level Spatial surface window.

**Request fields:** `expectedSurfaceSetRevision`, `expectedTopologyRevision`; optional `requestedBy` diagnostic string.

**Behavior:**
1. On a capable client, any admitted controller or the local user may close a live surface under identical identity-independent rules.
2. On success in 0.2.10-rc1, the client first commits a recoverable surface tombstone with the complete bounded state, then removes the live projection, advances `surfaceSetRevision`, emits `event.surface_removed` with recoverability metadata, and closes target-surface sockets. In later releases, success is a final close under §4.7.1 FC-2, reported with `recoverable: false`.
3. The endpoint lifecycle/restore seam remains available with zero live surfaces. Any admitted controller or the local user may restore a retained, restorable surface with the same IDs/state.
4. In 0.2.10-rc1, a client that omits controller window lifecycle still makes every local-user close recoverable. In later releases, a local-user window close is final under §4.7.1 on every client.

#### `panes.list`
Returns current pane layout for the paired surface.

**Response fields per pane:** `paneId`, `paneLabel` (integer or `null` while pending), `name` (extension-assigned or null), `activeContentId` (or null), `contentType` (or null), `viewport`.

The OpenClaw-facing `surf_ace_list` response exposes the client-owned `topologyRevision` and recursive `topology` tree. Agents plan intent operations against those fields rather than inferring structure from the flat pane list. A live count above `maxPanesPerSurface` after restore is valid state.

#### `pane.split`
Splits an existing pane into N panes.

**Request fields:** `paneId` (required — pane to split), `expectedTopologyRevision`, `count` (total pane count after split, including the source pane; min 2), and `direction` (`horizontal` | `vertical`).

**Behavior:** The source pane retains its `paneId`, confirmed `paneLabel` if any, and content. In lockless mode the client checks the expected revision, computes `currentLivePaneCount - 1 + count`, returns `pane_capacity` without mutation when that exceeds the advertised admission cap, without recoverable-state byte measurement or refusal. On success it allocates pane IDs, commits local topology and emits `event.pane_created`; labels may be confirmed separately before or after this commit.

**Response fields:** `panes` — array of `{ paneId, paneLabel }` for all panes in the window after the split (including existing panes).

#### `pane.rename`
Assigns or clears a name for a pane. This is an **extension-to-surface** operation — the extension names panes. There is no user-facing rename UI on the surface.

**Request fields:** `paneId`, `name` (string or null to clear).

**Response fields:** `paneId`, `name` (new name or null).

**Behavior:** Pane names are display metadata only. They do not replace `paneLabel`. OpenClaw resolves human pane references through `paneLabel` in `surf_ace_list`, then targets the pane by internal `paneId`.

**Surface default affordance:** The surface displays pane names as assigned by the extension. Topology is fully extension-controlled — no user-initiated rename or split UI is provided.


#### `pane.close`
Closes a pane and removes it from the live layout. In 0.2.10-rc1 the close is recoverable; in later releases it is a final close under §4.7.1 FC-1.

**Request fields:** `paneId`, `expectedTopologyRevision`. Cannot close the last remaining pane in a window (returns `invalid_operation`).

**Response fields:** `paneId` (ack echo), tombstone ID, new topology revision, `recoverable`, and `closedSequence`. In 0.2.10-rc1, `recoverable` is `true` and no accepted close discards preserved state. In later releases, `recoverable` is `false`, the tombstone ID names the final-close record, and §4.7.1 FC-5 governs what survives.


---

**Pane lifecycle events (surface → provider):**
- `event.pane_created` — `{ surfaceId, paneId, paneLabel: integer | null, parentPaneId (pane that was split, or null if created standalone), fromSplit: bool }`
- `event.fleet_labels_confirmed` — `{ surfaceId, windowLabel: string | null, panes: [{ paneId, paneLabel: integer | null }] }`; a full current label snapshot after each registry confirmation, keyed by stable IDs. The client emits it after committing the label state; `null` means still pending. On reconnect `surfaces.list`, `pair.response`, and `panes.list` provide current labels even if the event was missed.
- `event.pane_removed` — `{ surfaceId, paneId, tombstoneId, recoverable, closedSequence }` in lockless mode; `recoverable` is `true` in 0.2.10-rc1 and `false` for a final close (§4.7.1)
- `event.pane_renamed` — `{ surfaceId, paneId, name }`

These events are always-on (not profile-gated), analogous to `event.surface_appeared`/`event.surface_removed`.

---

#### Surface-owned history behavior

History is fully modeled and owned by the surface. OpenClaw does not list, target, or reason about individual history entries.

These rules are normative for the lockless shared history model:
1. `content.set` always targets one pane. The newly targeted content becomes front/visible immediately in that pane.
2. Every accepted `content.set` receives a client-allocated revision and history-entry ID, creates a distinct entry, and moves the previously visible entry into the retained pool. Lockless requests carry no authoritative `revision` or `historyOwnerToken`.
3. Previously visible content in that pane remains navigable through the surface's Back/Forward controls, with any Forward branch truncated when a new push arrives after Back navigation.
4. Back/Forward navigation changes only which previously shown pane content is visible. It never changes the `contentId` or `revision` originally written for that content.
5. Back/Forward restores both the content payload and the persisted annotation overlay for the selected pane-history state.
6. Lockless admission/state-growing operations enforce annotation/restore byte bounds before commit, so a retained history entry restores byte-identical content/overlay state; history navigation never truncates to fit.
7. The visible entry is separate from one Back/Forward pool capped at 20 non-visible states. Visibility assigns `lastVisibleSequence`; overflow evicts the non-visible state with the smallest sequence after Forward-branch truncation.
8. `content.append` / `content.patch` remain valid only against the currently visible content in that pane, enforced by `contentId` + `revision`.
9. `content.clear` clears the currently visible content for the targeted pane. Any history bookkeeping needed to preserve older pane states is internal to the surface/provider and not part of the OpenClaw call surface.

- Each pane's bottom controls are split into two side-by-side floating pills: a left navigation pill for history controls and visible entry provenance, and a right annotation pill for annotation controls.
- The navigation pill appears only when pushed content/history exists for that pane. Back/Forward controls appear in that navigation pill.
- Disabled Back/Forward controls SHOULD render at 40% opacity and SHOULD NOT show hover affordances.
- v1 SHOULD NOT display history depth counters.
- If overlay restoration fails, the surface SHOULD show a non-blocking toast plus a warning icon in the bottom controls.

---

#### `canvas` (v1 reserved, v2 required)
- `content.set` payload is optional: a background specification (`{ color, grid }`) or empty.
- There is no underlying document — annotations are the primary artifact, not an overlay.
- Snapshots do not extract or return visible text. When available, visible text
  remains part of the separate settled `event.scroll` payload.
- Navigation events do not fire (no URLs, no links).
- `content.clear` clears the background spec and ALL annotations (same global rule as all content types).
- Scroll and page registers do not apply.
- OpenClaw-originated drawing is v2-only. No v1 wire op exists for provider/model-authored strokes.
- The surface renders a blank (or gridded) background. In v1, users annotate on the canvas and OpenClaw observes those annotations via `surf_ace_read` / `snapshot.get` only.

#### `video` (v1 reserved, v2 required)
- `content.set` payload is a URL string pointing to the video source.
- Scroll and page registers do not apply.
- Two additional registers are active for `video` content (see Section 13.2): `playbackPosition` and `playbackState`.
- Strokes carry an optional `videoTimestamp` field (seconds from video start) indicating the playback position when the stroke was made. This allows annotations to be temporally anchored.
- When available, closed captions or subtitles may appear in the separate
  settled `event.scroll` payload; snapshots remain image/metadata only.
- Navigation events do not fire.
- `content.clear` clears the video and all annotations.

#### Protocol forward compatibility
The `video` and `canvas` content types are included in the `ContentType` schema enum in v1 so that implementations can reject them with `unsupported_content_type` rather than `invalid_payload`. This preserves forward compatibility: a v1 surface that does not implement these types still handles the message gracefully. A surface advertises supported content types via `cap` bitmask in mDNS TXT and in the `pair.response` capabilities field.

`surf-ace.lockless-multi-controller.v1` plus the complete client snapshot, advertised limits, revisions, stable IDs/labels, and controller-specific cursor/gap state determine actionability. A controller fails admission if any required capability or projection capacity is absent; it never sends provider-owned identity/topology for client adoption.

Authority reconciliation invariant: the client-authored stable IDs, labels, revisions, topology, lifecycle state, limits, consumable scopes, cursor floors, and gaps are authoritative. Controller caches and runtime/process/session metadata reconcile to that state and cannot create terminal non-actionability based on controller identity, provider lineage, or label disagreement.

## 7. Always-On Event Delivery

This section specifies the existing direct surface-to-controller WebSocket stream. Once paired, the surface emits this event set without a surface-side subscribe/unsubscribe API. Registry-journal watch/resume in §4.10 is a separate optional stream and does not alter these events or their profile rules.

### 7.1 Minimum Deep Event Set (Default)

Default event profile is `minimum_deep`.
`minimum_deep` is the smallest set that keeps OpenClaw useful with low noise.

Active events in `minimum_deep`:
1. `event.drawing_flush` - raw strokes accumulated locally and flushed as one batch by flush gate timing.
2. `event.tap` - resolved point-out tap/long-press. UI-navigation taps (link follows, button activations) are excluded from this event; they produce `event.navigation` instead.
3. `event.selection` - semantically complete selection event. In v1 interoperability profile, only `kind:"text"` is guaranteed; `point`/`region` are reserved for v2 unless explicitly negotiated.
4. `event.page` - full PDF page transition state.
5. `event.navigation` - surface navigated away from pushed content (user followed a link or triggered in-page navigation). Carries the new URL and signals that any open capture frame or buffered annotation state should be considered stale relative to the original content. **Applies to `html` content type only.** Surfaces MUST NOT emit `event.navigation` for any other content type (`pdf`, `image`, `markdown`, `terminal`, `canvas`, `video`). If the provider receives a `NavigationEvent` while a non-HTML content type is active, it MUST discard it silently.
6. `event.snapshot_hint` - provider-internal control-plane event (reconnect/backpressure sync). NOT exposed in the OpenClaw register model.

Drawing semantics in default mode:
1. Surface does no stroke classification, shape recognition, or gesture interpretation.
2. Surface accumulates raw strokes locally.
3. Surface emits `event.drawing_flush` only when the flush gate fires.
4. Each stroke has a stable unique `strokeId` (`stroke_<hex>`) assigned at capture time.
5. Flush payload is an ordered array of strokes; each stroke remains independently addressable by `strokeId`.
6. Surface keeps strokes rendered until explicitly removed by provider via `annotations.remove`.

Flush gate (trailing debounce model):
1. Let `dirty=true` when new strokes were added since last successful send.
2. Each new stroke resets a trailing debounce timer of `idleWindowMs`.
3. Idle gate condition: `idleWindowMs` has elapsed since the **last stroke ended** (not since pencil lift — the timer resets on every new stroke, so slow drawers with long gaps between strokes do not trigger spurious flushes mid-session).
4. Max interval condition: `maxIntervalMs` elapsed since last successful send and `dirty=true` (anti-spam backstop for continuous drawing without pause).
5. Send occurs when `dirty=true` and either idle gate or max interval condition is true.
6. Do not send when `dirty=false` (no changes since last send).
7. `lastSuccessfulSendAt` initializes to pair-success time for each connection.

Default flush timings:
1. `idleWindowMs` default 8000 (8 seconds of no new stroke activity).
2. `maxIntervalMs` default 30000.

Behavioral result:
1. A user who pauses naturally between strokes does not trigger a flush until they have been fully idle for 8s.
2. A slow drawer (long gaps between strokes) does not spam flushes — the timer resets on each new stroke.
3. Continuous drawing without pause is force-flushed at most every 30s.
4. There is intentionally no short/fast tier. Sending partial annotation batches mid-session would inundate OpenClaw and produce redundant passes. One flush per drawing session is the goal.

Provider interpretation model:
1. OpenClaw decides at interpretation time whether strokes are persistent (leave rendered) or consumed (call `annotations.remove`).
2. No user mode switch is required.
3. Surface is passive: it renders and flushes strokes, and removes only the explicit IDs requested by provider.
4. Canonical consumed example: scratch-out gesture is interpreted by OpenClaw, then OpenClaw calls `annotations.remove` for scratch stroke IDs and separately edits/deletes the scratched content.
5. Stroke visual attributes (color/width/opacity) are intentionally omitted from v1 wire schema; v1 interpretation uses stroke geometry and timing.

### 7.2 Optional Event Expansions (No Direct-Surface Watch Mode)

The direct surface stream is still always-on; expansions are negotiated at pair time, not through a runtime subscription to the surface.

1. `eventProfile=deep_plus_scroll`: adds `event.scroll` (settled viewport + visible text) to `minimum_deep`.

### 7.3 Event Audit: Deep vs Shallow

| Event | Classification | Default | Rationale |
|---|---|---|---|
| `event.drawing_flush` | Batched raw intent artifact | Yes | Carries all changed drawing input since last send at meaningful time boundaries. |
| `event.tap` | Deep semantic | Yes | Point-out taps only; UI-navigation taps excluded (see `event.navigation`). |
| `event.selection` | Deep semantic | Yes | Represents explicit user focus with interpretable payload. |
| `event.page` | Deep semantic | Yes | Complete navigation state transition for paged content. |
| `event.navigation` | Deep semantic | Yes | Surface navigated away from pushed content. Carries new URL; signals any open capture frame or buffered annotation state is stale. |
| `event.snapshot_hint` | Provider-internal control plane | Yes (internal only) | Used for reconnect/backpressure state sync. Not exposed in OpenClaw register model. Appears in `pair.response.eventConfig.activeEvents` (it is profile-controlled, part of `minimum_deep`), but the provider does not surface it to OpenClaw tooling. |
| `event.surface_appeared` | Lifecycle — **not profile-gated** | Always | Emitted on any active socket when a new window appears. Always active regardless of `eventProfile`. Does NOT appear in `pair.response.eventConfig.activeEvents` (which lists only profile-controlled events). |
| `event.surface_removed` | Lifecycle — **not profile-gated** | Always | Emitted when a window closes. Always active regardless of `eventProfile`. Does NOT appear in `pair.response.eventConfig.activeEvents`. |
| `event.surface_resumed` | Lifecycle — **not profile-gated** | Always | Emitted when a surface successfully reconnects after background/resume. Always active regardless of `eventProfile`. Does NOT appear in `pair.response.eventConfig.activeEvents`. |
| `event.consumable_available` | Targeted lockless control | Always | Client-authored pending/gap truth for one controller/scope; outside consumable payload logs. |
| `event.consumable_overflow` | Targeted lockless control | Always | Structured sticky capacity loss for one controller/scope; outside consumable payload logs. |
| `event.controller_retention_reclaimed` | Lockless lifecycle — **not profile-gated** | Always | Ordered notification that a dormant controller bundle was deterministically reclaimed. |
| `event.pane_created` | Lifecycle — **not profile-gated** | Always | Emitted when a new pane is created (split or standalone), with `paneLabel: null` if pending. Always active regardless of `eventProfile`. Does NOT appear in `pair.response.eventConfig.activeEvents`. |
| `event.fleet_labels_confirmed` | Label lifecycle — **not profile-gated** | Always | Emitted after a registry confirmation commits, with the complete current label snapshot keyed by stable surface/pane IDs. Does NOT appear in `pair.response.eventConfig.activeEvents`. Missed events are reconciled through list/pair snapshots after reconnect. |
| `event.pane_removed` | Lifecycle — **not profile-gated** | Always | Emitted after the pane-close tombstone commit in lockless mode (recoverable in 0.2.10-rc1, final under §4.7.1 later), with tombstone/recoverability metadata. Always active regardless of `eventProfile`. |
| `event.pane_renamed` | Lifecycle — **not profile-gated** | Always | Emitted when a pane name changes. Always active regardless of `eventProfile`. Does NOT appear in `activeEvents`. |
| `event.scroll` | Context-rich but high-volume | No (`deep_plus_scroll` only) | Useful but not strictly required for minimum usefulness. |

Event behavior rules:
1. Events are in-order and reliable while socket is healthy.
2. Events are not replayed across reconnect.
3. After reconnect, provider must request `snapshot.get` before acting on new events.
4. Provider MUST buffer events that arrive while this mandatory `snapshot.get` is in-flight.
5. The client-authoritative bounded scopes and structured gap rules in §4.8 define retention. A controller snapshot projection must hold the negotiated retained window; inability to do so fails admission.
6. On snapshot success, provider applies snapshot state first, then processes buffered events in receive order.
7. On snapshot failure (`internal_error` or `content_too_large`), provider MUST close socket and re-enter reconnect backoff.
8. On backpressure, surface may coalesce/delay high-rate events (`event.scroll`) and delay `event.drawing_flush` emission until sendable; if any events were dropped/coalesced, emit `event.snapshot_hint` with reason `backpressure_drop`.
9. After completing a complex render (e.g. `content.set` with large HTML), surface emits `event.snapshot_hint` with reason `after_render` to signal provider that a fresh `snapshot.get` would yield meaningful content. This is advisory; provider may ignore it.
10. After a successful reconnect and re-pair, surface emits `event.snapshot_hint` with reason `after_reconnect` immediately after sending `pair.response` and before any other post-reconnect events. This hint will be buffered by the provider per rule 4 while `snapshot.get` is in-flight, and processed in order per rule 6 after snapshot completes. It is a trailing confirmation that post-snapshot state is authoritative — not a trigger. Provider SHOULD log receipt for diagnostics but no additional action is required beyond the rules 3–6 sync model.
11. Provider deduplicates events by `eventId` (retain last 1024 IDs per surface session).
12. If a flush send fails or disconnects mid-send, surface keeps unsent dirty strokes and retries on reconnect under normal flush-gate rules.

### 7.4 Flush Send Indicator (UI Requirement)

Surface must show a subtle visual send indicator while a drawing flush is in-flight to provider. See §15.5 for the required UI treatment of this indicator.

Required behavior:
1. Indicator becomes visible when `event.drawing_flush` transmission starts.
2. Indicator remains visible while transmission is in-flight.
3. Indicator hides immediately when transmission finishes (success or terminal failure).
4. Indicator must be subtle but noticeable (for example corner badge, pulsing icon, or brief overlay).
5. Indicator is only shown for drawing flush sends; no indicator when nothing changed.

## 8. Errors and Close Codes

### 8.1 Error Codes (response-level)

| Code | Meaning |
|---|---|
| `invalid_resume` | Resume token/session is invalid for the retained controller state |
| `duplicate_controller_id` | Lockless admission found the same instance ID already live |
| `controller_capacity` | All admitted-controller entries are live and the advertised bound is full |
| `pane_capacity` | Pane-creating prospective live count exceeds the advertised admission cap |
| `surface_state_capacity` | Separate surface-admission ledger capacity (§6.0); never an ordinary mutation, content recovery, or retained-tombstone byte refusal |
| `pane_state_capacity` | Retired ordinary pane/annotation recoverable-byte refusal; retained only for legacy response compatibility |
| `tombstone_capacity` | Retired retained-tombstone byte refusal; retained only for legacy response compatibility |
| `not_paired` | Operation attempted before successful pair |
| `invalid_payload` | JSON shape/type invalid |
| `invalid_request_id_reuse` | Duplicate request ID with different payload |
| `invalid_operation` | Operation not permitted in current state (e.g. closing the last pane) |
| `prepair_describe_unsupported` | Client does not implement the pre-pair describe capability |
| `surface_not_found` | Requested surface is not live on this endpoint |
| `identity_mismatch` | Requested client identity does not match this client; for surface.describe, a missing, unreadable, or different saved registry binding or endpoint lease is reported in a successful degraded response instead (§3.1.4) |
| `revision_churn` | Surface-set or topology revision changed while a pre-pair describe snapshot was collected |
| `not_ready` | Client cannot read a complete saved pre-pair describe observation of the requested live surface |
| `unsupported_protocol_version` | Provider protocol version mismatch |
| `unsupported_content_type` | Content type unsupported by surface |
| `unsupported_operation_for_content_type` | Append/patch not valid for current type |
| `stale_revision` | Revision gap or duplicate revision |
| `stale_content` | Frame-targeted mutation references non-current content |
| `content_too_large` | Message or content exceeds limits |
| `render_failed` | Rendering/patch failed |
| `rate_limited` | Temporary event/operation throttle |
| `internal_error` | Unhandled surface error |

### 8.2 WebSocket Close Codes

| Code | Reason |
|---|---|
| `1000` + `provider_shutdown` | Controller/provider graceful shutdown. Client truth is unchanged and other controllers continue. |
| `4401` | Pair/auth failure |
| `4409` | Busy/occupied |
| `4410` | Protocol violation (malformed envelope/op mismatch) |
| `4413` | Payload too large |
| `4500` | Internal surface failure |

## 9. Security and Trust

### 9.1 Surface Identity
1. Surface holds persistent Ed25519 keypair.
2. `pk` TXT advertises fingerprint prefix.
3. v1 transport profile is `ws` on trusted LAN; WSS key/certificate profile is explicitly out of scope for v1.

### 9.2 Pairing Trust Model (v1)
1. Home-network default: auto-trust unknown surface on first successful pair.
2. Trusted surfaces auto-reconnect.
3. If pinned key changes, provider marks surface untrusted and requires re-pair approval.

### 9.3 WSS/TLS Scope
1. WSS/TLS certificate format and pinning profile is deferred to v2.
2. `tls` discovery TXT field is reserved and non-normative in v1.
3. Implementations MAY experiment with WSS privately, but v1 interoperability requirements are defined only for `ws`.

### 9.4 Session and Controller Identity
1. A stable asserted `controllerInstanceId` deconflicts live connections and scopes cursors/correlation only. It is not authentication, permission, priority, quota, or routing authority.
2. A session is bound to an individual admitted socket. Retained same-ID reconnect resumes only the bounded cursor/gap state described in §4.8.
3. No callback token model exists.
4. Direct surface event delivery has no watch subscription token. The registry journal lease in §4.10 is separate cursor-concurrency state, not authentication.

## 10. JSON Schemas (All Message Types)

The schema below defines the currently registered v1 application message types
over WS. The optional §12.1 pane-paint diagnostic contract is versioned in
`specs/pane-paint-diagnostic-v1/`; it is not a registered message until a later
reviewed implementation adds it to the production protocol unions and advertises
its capability.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://clawline.local/specs/surf-ace-ws-v1.schema.json",
  "title": "Surf Ace WS v1 Message",
  "type": "object",
  "oneOf": [
    { "$ref": "#/$defs/SurfacesListRequest" },
    { "$ref": "#/$defs/PairRequest" },
    { "$ref": "#/$defs/ContentSetRequest" },
    { "$ref": "#/$defs/ContentAppendRequest" },
    { "$ref": "#/$defs/ContentPatchRequest" },
    { "$ref": "#/$defs/ContentClearRequest" },
    { "$ref": "#/$defs/AnnotationsRemoveRequest" },
    { "$ref": "#/$defs/SnapshotGetRequest" },
    { "$ref": "#/$defs/HeartbeatPingRequest" },

    { "$ref": "#/$defs/SurfacesListResponse" },
    { "$ref": "#/$defs/PairResponse" },
    { "$ref": "#/$defs/MutationAckResponse" },
    { "$ref": "#/$defs/AnnotationsRemoveResponse" },
    { "$ref": "#/$defs/SnapshotResponse" },
    { "$ref": "#/$defs/HeartbeatPongResponse" },
    { "$ref": "#/$defs/ErrorResponse" },

    { "$ref": "#/$defs/DrawingFlushEvent" },
    { "$ref": "#/$defs/TapEvent" },
    { "$ref": "#/$defs/ScrollEvent" },
    { "$ref": "#/$defs/SelectionEvent" },
    { "$ref": "#/$defs/PageEvent" },
    { "$ref": "#/$defs/NavigationEvent" },
    { "$ref": "#/$defs/SurfaceAppearedEvent" },
    { "$ref": "#/$defs/SurfaceRemovedEvent" },
    { "$ref": "#/$defs/SurfaceResumedEvent" },
    { "$ref": "#/$defs/ConsumableAvailableEvent" },
    { "$ref": "#/$defs/ConsumableOverflowEvent" },
    { "$ref": "#/$defs/ControllerRetentionReclaimedEvent" },
    { "$ref": "#/$defs/SnapshotHintEvent" },

    { "$ref": "#/$defs/PanesListRequest" },
    { "$ref": "#/$defs/PaneSplitRequest" },
    { "$ref": "#/$defs/PaneRenameRequest" },
    { "$ref": "#/$defs/PaneCloseRequest" },

    { "$ref": "#/$defs/PanesListResponse" },
    { "$ref": "#/$defs/PaneSplitResponse" },
    { "$ref": "#/$defs/PaneRenameResponse" },
    { "$ref": "#/$defs/PaneCloseResponse" },

    { "$ref": "#/$defs/PaneCreatedEvent" },
    { "$ref": "#/$defs/PaneRemovedEvent" },
    { "$ref": "#/$defs/PaneRenamedEvent" },
    { "$ref": "#/$defs/FleetLabelsConfirmedEvent" }
  ],
  "$defs": {
    "RequestId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9._:-]{1,64}$"
    },
    "ProviderId": {
      "type": "string",
      "pattern": "^pv_[A-Za-z0-9._:-]{3,64}$"
    },
    "ConnectionId": {
      "type": "string",
      "pattern": "^cn_[A-Za-z0-9._:-]{3,64}$"
    },
    "SessionId": {
      "type": "string",
      "pattern": "^sa_[A-Za-z0-9._:-]{8,128}$"
    },
    "SurfaceId": {
      "type": "string",
      "pattern": "^sf_[A-Za-z0-9._:-]{3,64}$"
    },
    "ContentId": {
      "type": "string",
      "pattern": "^ct_[0-9a-f]{8}$"
    },
    "StrokeId": {
      "type": "string",
      "pattern": "^stroke_[0-9a-f]{6,64}$"
    },
    "EventId": {
      "type": "string",
      "pattern": "^ev_[A-Za-z0-9._:-]{3,96}$"
    },
    "FlushId": {
      "type": "string",
      "pattern": "^fl_[A-Za-z0-9._:-]{3,96}$"
    },
    "PaneId": {
      "description": "Pane identity within a surface. Normative model: globally unique numeric pane IDs scoped to the entire surface instance.",
      "type": "integer",
      "minimum": 1
    },
    "PaneLabel": {
      "description": "Fleet-unique visible pane number assigned by the fleet registry, or null while confirmation is pending. Distinct from client-local internal paneId.",
      "oneOf": [{ "type": "integer", "minimum": 1 }, { "type": "null" }]
    },
    "WindowLabel": {
      "description": "Fleet-unique visible window letter assigned by the fleet registry, or null while confirmation is pending.",
      "oneOf": [{ "type": "string", "pattern": "^[a-z]+$" }, { "type": "null" }]
    },
    "Revision": {
      "type": "integer",
      "minimum": 0
    },
    "EpochMs": {
      "type": "integer",
      "minimum": 0
    },
    "ContentType": {
      "type": "string",
      "enum": ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"]
    },
    "EventType": {
      "type": "string",
      "enum": [
        "event.drawing_flush",
        "event.tap",
        "event.scroll",
        "event.selection",
        "event.page",
        "event.navigation",
        "event.surface_appeared",
        "event.surface_removed",
        "event.surface_resumed",
        "event.consumable_available",
        "event.consumable_overflow",
        "event.controller_retention_reclaimed",
        "event.snapshot_hint",
        "event.pane_created",
        "event.pane_removed",
        "event.pane_renamed",
        "event.fleet_labels_confirmed"
      ]
    },
    "ProfileControlledEventType": {
      "type": "string",
      "description": "Event types that are governed by eventProfile. Excludes lifecycle events (surface and pane lifecycle) which are always active and never appear in activeEvents.",
      "enum": [
        "event.drawing_flush",
        "event.tap",
        "event.scroll",
        "event.selection",
        "event.page",
        "event.navigation",
        "event.snapshot_hint"
      ]
    },
    "EventProfile": {
      "type": "string",
      "enum": ["minimum_deep", "deep_plus_scroll"]
    },
    "DrawingFlushConfig": {
      "type": "object",
      "additionalProperties": false,
      "required": ["idleWindowMs", "maxIntervalMs"],
      "properties": {
        "idleWindowMs": {
          "type": "integer",
          "minimum": 5000,
          "maximum": 10000,
          "default": 8000
        },
        "maxIntervalMs": {
          "type": "integer",
          "minimum": 10000,
          "default": 30000
        }
      }
    },
    "Position": {
      "type": "object",
      "additionalProperties": false,
      "required": ["x", "y"],
      "properties": {
        "x": { "type": "number" },
        "y": { "type": "number" }
      }
    },
    "Rect": {
      "type": "object",
      "additionalProperties": false,
      "required": ["x", "y", "width", "height"],
      "properties": {
        "x": { "type": "number" },
        "y": { "type": "number" },
        "width": { "type": "number", "minimum": 0 },
        "height": { "type": "number", "minimum": 0 }
      }
    },
    "Viewport": {
      "type": "object",
      "additionalProperties": false,
      "required": ["scrollOffset", "visibleRect", "contentSize", "zoomLevel"],
      "properties": {
        "scrollOffset": {
          "type": "object",
          "additionalProperties": false,
          "required": ["x", "y"],
          "properties": {
            "x": { "type": "number" },
            "y": { "type": "number" }
          }
        },
        "visibleRect": { "$ref": "#/$defs/Rect" },
        "contentSize": {
          "type": "object",
          "additionalProperties": false,
          "required": ["width", "height"],
          "properties": {
            "width": { "type": "number", "minimum": 0 },
            "height": { "type": "number", "minimum": 0 }
          }
        },
        "zoomLevel": { "type": "number", "exclusiveMinimum": 0 }
      }
    },
    "SurfaceViewport": {
      "type": "object",
      "additionalProperties": false,
      "required": ["width", "height", "scale"],
      "properties": {
        "width": { "type": "integer", "minimum": 1 },
        "height": { "type": "integer", "minimum": 1 },
        "scale": { "type": "number", "exclusiveMinimum": 0 }
      }
    },
    "Selection": {
      "oneOf": [
        { "type": "null" },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "text"],
          "properties": {
            "kind": { "const": "text" },
            "text": { "type": "string" },
            "boundingRect": { "$ref": "#/$defs/Rect" }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "description": "Selection point variant (reserved for v2 unless explicitly negotiated). v1 providers MAY receive this but MUST ignore when no v2 selection negotiation is active.",
          "required": ["kind", "position"],
          "properties": {
            "kind": { "const": "point" },
            "position": { "$ref": "#/$defs/Position" }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "description": "Selection region variant (reserved for v2 unless explicitly negotiated). v1 providers MAY receive this but MUST ignore when no v2 selection negotiation is active.",
          "required": ["kind", "rect"],
          "properties": {
            "kind": { "const": "region" },
            "rect": { "$ref": "#/$defs/Rect" },
            "text": { "type": "string" }
          }
        }
      ]
    },
    "ErrorBody": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message"],
      "properties": {
        "code": {
          "type": "string",
          "enum": [
            "busy",
            "duplicate_controller_id",
            "missing_controller_id",
            "malformed_controller_id",
            "controller_capacity",
            "invalid_resume",
            "not_paired",
            "invalid_payload",
            "invalid_request_id_reuse",
            "invalid_operation",
            "unsupported_protocol_version",
            "unsupported_content_type",
            "unsupported_operation_for_content_type",
            "stale_revision",
            "stale_topology",
            "stale_surface_set",
            "stale_content",
            "pane_capacity",
            "surface_state_capacity",
            "pane_state_capacity",
            "tombstone_capacity",
            "content_too_large",
            "render_failed",
            "rate_limited",
            "internal_error"
          ]
        },
        "message": { "type": "string", "minLength": 1 },
        "details": { "type": "object" }
      }
    },
    "HtmlContent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["html"],
      "properties": {
        "html": { "type": "string" },
        "baseUrl": { "type": "string" }
      }
    },
    "ImageContent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["data", "mediaType"],
      "properties": {
        "data": { "type": "string" },
        "mediaType": { "type": "string" },
        "alt": { "type": "string" }
      }
    },
    "PdfContent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["data"],
      "properties": {
        "data": { "type": "string" }
      }
    },
    "TerminalContent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["lines", "scrollback"],
      "properties": {
        "lines": {
          "type": "array",
          "items": { "type": "string" }
        },
        "scrollback": { "type": "integer", "minimum": 0 }
      }
    },
    "MarkdownContent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["markdown"],
      "properties": {
        "markdown": { "type": "string" }
      }
    },
    "VideoContent": {
      "type": "string"
    },
    "CanvasContent": {
      "oneOf": [
        { "type": "string", "maxLength": 0 },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "color": { "type": "string" },
            "grid": { "type": "boolean" }
          }
        }
      ]
    },

    "SurfacesListRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "surfaces.list" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" }
      }
    },
    "SurfacesListResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": { "const": "surfaces.list" },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["surfaces"],
          "properties": {
            "surfaces": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["surfaceId", "name", "windowLabel", "viewport", "paired"],
                "properties": {
                  "surfaceId": { "$ref": "#/$defs/SurfaceId" },
                  "name": { "type": "string" },
                  "windowLabel": { "$ref": "#/$defs/WindowLabel" },
                  "viewport": { "$ref": "#/$defs/SurfaceViewport" },
                  "paired": { "type": "boolean", "description": "Deprecated discovery projection; admission is reported through negotiated capability/controller state." }
                }
              }
            }
          }
        }
      }
    },

    "PairRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "pair.request" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["controllerInstanceId", "projectionCapacityBytes", "protocolFeatures", "protocolVersion"],
          "properties": {
            "controllerInstanceId": { "type": "string", "minLength": 1, "description": "Stable opaque asserted instance identity; never an authority principal." },
            "controllerProductName": { "type": "string", "description": "Human-facing product provenance only." },
            "projectionCapacityBytes": { "type": "integer", "minimum": 1 },
            "protocolFeatures": {
              "type": "array",
              "contains": { "const": "surf-ace.lockless-multi-controller.v1" },
              "minItems": 1,
              "items": { "type": "string" }
            },
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "protocolVersion": { "const": 1 },
            "resume": {
              "type": "object",
              "description": "Bounded cursor, gap, and receipt state for the same controller instance."
            }
          }
        }
      }
    },
    "ContentSetRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "content.set" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "allOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["paneId", "contentId", "contentType", "content"],
              "properties": {
                "paneId": {
                  "$ref": "#/$defs/PaneId",
                  "description": "Target pane. Required — OpenClaw must always specify which pane to target."
                },
                "contentId": { "$ref": "#/$defs/ContentId" },
                "friendlyChatName": { "type": "string", "description": "Entry-bound human-facing provenance component." },
                "providerName": { "type": "string", "description": "Entry-bound provider/product provenance component." },
                "contentType": { "$ref": "#/$defs/ContentType" },
                "content": {},
                "display": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "title": { "type": "string" },
                    "scrollable": { "type": "boolean" },
                    "interactive": { "type": "boolean" }
                  }
                }
              }
            },
            {
              "oneOf": [
                {
                  "properties": {
                    "contentType": { "const": "html" },
                    "content": { "$ref": "#/$defs/HtmlContent" }
                  }
                },
                {
                  "properties": {
                    "contentType": { "const": "image" },
                    "content": { "$ref": "#/$defs/ImageContent" }
                  }
                },
                {
                  "properties": {
                    "contentType": { "const": "pdf" },
                    "content": { "$ref": "#/$defs/PdfContent" }
                  }
                },
                {
                  "properties": {
                    "contentType": { "const": "terminal" },
                    "content": { "$ref": "#/$defs/TerminalContent" }
                  }
                },
                {
                  "properties": {
                    "contentType": { "const": "markdown" },
                    "content": { "$ref": "#/$defs/MarkdownContent" }
                  }
                },
                {
                  "properties": {
                    "contentType": { "const": "video" },
                    "content": { "$ref": "#/$defs/VideoContent" }
                  }
                },
                {
                  "properties": {
                    "contentType": { "const": "canvas" },
                    "content": { "$ref": "#/$defs/CanvasContent" }
                  }
                }
              ]
            }
          ]
        }
      }
    },
    "ContentAppendRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "content.append" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "contentId", "revision", "lines"],
          "properties": {
            "paneId": {
              "$ref": "#/$defs/PaneId",
              "description": "Target pane. Required — OpenClaw must always specify which pane to target."
            },
            "contentId": { "$ref": "#/$defs/ContentId" },
            "revision": { "$ref": "#/$defs/Revision" },
            "lines": {
              "type": "array",
              "items": { "type": "string" }
            }
          }
        }
      }
    },
    "ContentPatchRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "content.patch" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "contentId", "revision", "patch"],
          "properties": {
            "paneId": {
              "$ref": "#/$defs/PaneId",
              "description": "Target pane. Required — OpenClaw must always specify which pane to target."
            },
            "contentId": { "$ref": "#/$defs/ContentId" },
            "revision": { "$ref": "#/$defs/Revision" },
            "patch": {
              "type": "object",
              "additionalProperties": false,
              "required": ["selector", "action"],
              "properties": {
                "selector": { "type": "string" },
                "action": {
                  "type": "string",
                  "enum": [
                    "replace_inner",
                    "replace_outer",
                    "insert_before",
                    "insert_after",
                    "remove"
                  ]
                },
                "html": { "type": "string" }
              }
            }
          }
        }
      }
    },
    "ContentClearRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "content.clear" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "revision"],
          "properties": {
            "paneId": {
              "$ref": "#/$defs/PaneId",
              "description": "Target pane. Required — OpenClaw must always specify which pane to target."
            },
            "revision": { "$ref": "#/$defs/Revision" }
          }
        }
      }
    },
    "AnnotationsRemoveRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "annotations.remove" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "contentId", "strokeIds"],
          "properties": {
            "paneId": {
              "$ref": "#/$defs/PaneId",
              "description": "Target pane. Required — OpenClaw must always specify which pane to target."
            },
            "contentId": { "$ref": "#/$defs/ContentId" },
            "strokeIds": {
              "type": "array",
              "items": { "$ref": "#/$defs/StrokeId" },
              "minItems": 1,
              "uniqueItems": true
            }
          }
        }
      }
    },
    "SnapshotGetRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "snapshot.get" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId"],
          "properties": {
            "paneId": {
              "$ref": "#/$defs/PaneId",
              "description": "Target pane. Required — OpenClaw must always specify which pane to target."
            },
            "includeDrawings": { "type": "boolean", "default": false }
          }
        }
      }
    },
    "HeartbeatPingRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "heartbeat.ping" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["nonce"],
          "properties": {
            "nonce": { "type": "string", "minLength": 1, "maxLength": 128 }
          }
        }
      }
    },

    "PairResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": { "const": "pair.request" },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "sessionId",
            "resumed",
            "surfaceId",
            "surfaceName",
            "windowLabel",
            "viewport",
            "capabilities",
            "eventConfig",
            "limits",
            "state"
          ],
          "properties": {
            "sessionId": { "$ref": "#/$defs/SessionId" },
            "resumed": { "type": "boolean" },
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "surfaceName": { "type": "string" },
            "windowLabel": { "$ref": "#/$defs/WindowLabel" },
            "viewport": {
              "type": "object",
              "additionalProperties": false,
              "required": ["width", "height", "scale"],
              "properties": {
                "width": { "type": "integer", "minimum": 1 },
                "height": { "type": "integer", "minimum": 1 },
                "scale": { "type": "number", "exclusiveMinimum": 0 }
              }
            },
            "capabilities": {
              "type": "object",
              "additionalProperties": false,
              "required": ["contentTypes", "eventTypes"],
              "properties": {
                "contentTypes": {
                  "type": "array",
                  "items": { "$ref": "#/$defs/ContentType" },
                  "uniqueItems": true
                },
                "eventTypes": {
                  "type": "array",
                  "items": { "$ref": "#/$defs/EventType" },
                  "uniqueItems": true
                },
                "protocolFeatures": {
                  "type": "array",
                  "items": { "type": "string" },
                  "uniqueItems": true,
                  "description": "Includes surf-ace.lockless-multi-controller.v1 only when every required lockless semantic and limit is supported."
                }
              }
            },
            "eventConfig": {
              "type": "object",
              "additionalProperties": false,
              "required": ["profile", "activeEvents", "drawingFlushConfig"],
              "properties": {
                "profile": { "$ref": "#/$defs/EventProfile" },
                "activeEvents": {
                  "type": "array",
                  "items": { "$ref": "#/$defs/ProfileControlledEventType" },
                  "uniqueItems": true,
                  "description": "Profile-controlled events active for this session. Surface and pane lifecycle events are excluded — they are always active regardless of profile."
                },
                "drawingFlushConfig": { "$ref": "#/$defs/DrawingFlushConfig" }
              }
            },
            "limits": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "maxMessageBytes",
                "maxFrameBytes",
                "maxVisibleTextBytes",
                "maxStrokePointsPerFlush",
                "maxDrawingFlushBytes"
              ],
              "properties": {
                "maxMessageBytes": { "type": "integer", "minimum": 1024 },
                "maxFrameBytes": { "type": "integer", "minimum": 1024 },
                "maxVisibleTextBytes": { "type": "integer", "minimum": 256 },
                "maxStrokePointsPerFlush": { "type": "integer", "minimum": 1 },
                "maxDrawingFlushBytes": { "type": "integer", "minimum": 1024 },
                "maxPanesPerSurface": { "type": "integer", "minimum": 1, "description": "Lockless pane-creating admission cap, not a post-restore live-count invariant." },
                "maxSurfaceRecoverableBaseBytes": { "type": "integer", "minimum": 1, "description": "Optional legacy field; not an ordinary-mutation or retained-recovery quota." },
                "maxPaneRecoverableStateBytes": { "type": "integer", "minimum": 1, "description": "Optional legacy field; not an ordinary-mutation or retained-recovery quota." },
                "maxPaneAnnotationRestoreBytes": { "type": "integer", "minimum": 1, "description": "Optional legacy field; not an ordinary-mutation or retained-recovery quota." },
                "maxRetainedTombstones": { "type": "integer", "minimum": 1, "description": "Optional legacy field; not an ordinary-mutation or retained-recovery quota." },
                "maxRetainedTombstoneBytes": { "type": "integer", "minimum": 1, "description": "Optional legacy field; not an ordinary-mutation or retained-recovery quota." },
                "maxRecoverableSurfaceBytes": { "type": "integer", "minimum": 1, "description": "Optional legacy field; not an ordinary-mutation or retained-recovery quota." },
                "maxPaneConsumableRecords": { "type": "integer", "minimum": 1 },
                "maxPaneConsumableBytes": { "type": "integer", "minimum": 1 },
                "maxSurfaceConsumableRecords": { "type": "integer", "minimum": 1 },
                "maxSurfaceConsumableBytes": { "type": "integer", "minimum": 1 },
                "maxConsumableRecordBytes": { "type": "integer", "minimum": 1 },
                "maxConsumableCursorStateBytesPerScope": { "type": "integer", "minimum": 1 },
                "maxAdmittedControllerEntries": { "type": "integer", "minimum": 1 },
                "maxDormantControllerEntries": { "type": "integer", "minimum": 1 },
                "maxDormantControllerBytes": { "type": "integer", "minimum": 1 }
              }
            },
            "state": {
              "type": "object",
              "additionalProperties": false,
              "required": ["panes"],
              "properties": {
                "panes": {
                  "type": "array",
                  "minItems": 1,
                  "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["paneId", "paneLabel", "currentContentId", "currentRevision", "contentType"],
                    "properties": {
                      "paneId": { "$ref": "#/$defs/PaneId" },
                      "paneLabel": { "$ref": "#/$defs/PaneLabel" },
                      "currentContentId": {
                        "oneOf": [{ "$ref": "#/$defs/ContentId" }, { "type": "null" }]
                      },
                      "currentRevision": { "$ref": "#/$defs/Revision" },
                      "contentType": {
                        "oneOf": [{ "$ref": "#/$defs/ContentType" }, { "type": "null" }]
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "MutationAckResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": {
          "type": "string",
          "enum": ["content.set", "content.append", "content.patch", "content.clear"]
        },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "currentContentId", "currentRevision", "contentId"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "currentContentId": {
              "oneOf": [{ "$ref": "#/$defs/ContentId" }, { "type": "null" }]
            },
            "currentRevision": { "$ref": "#/$defs/Revision" },
            "contentType": {
              "oneOf": [{ "$ref": "#/$defs/ContentType" }, { "type": "null" }]
            },
            "contentId": {
              "oneOf": [{ "$ref": "#/$defs/ContentId" }, { "type": "null" }],
              "description": "The content payload identity applied by this mutation. Required. Present (non-null) on content.set responses. Null on content.clear responses."
            }
          }
        }
      }
    },
    "AnnotationsRemoveResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": { "const": "annotations.remove" },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "contentId", "removedStrokeIds", "notFoundStrokeIds", "remainingStrokeCount"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "contentId": { "$ref": "#/$defs/ContentId" },
            "removedStrokeIds": {
              "type": "array",
              "items": { "$ref": "#/$defs/StrokeId" },
              "uniqueItems": true
            },
            "notFoundStrokeIds": {
              "type": "array",
              "items": { "$ref": "#/$defs/StrokeId" },
              "uniqueItems": true
            },
            "remainingStrokeCount": { "type": "integer", "minimum": 0 }
          }
        }
      }
    },
    "SnapshotResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": { "const": "snapshot.get" },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "paneId",
            "contentId",
            "revision",
            "contentType",
            "viewport",
            "selection"
          ],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "contentId": {
              "oneOf": [{ "$ref": "#/$defs/ContentId" }, { "type": "null" }]
            },
            "revision": { "$ref": "#/$defs/Revision" },
            "contentType": {
              "oneOf": [{ "$ref": "#/$defs/ContentType" }, { "type": "null" }]
            },
            "viewport": { "$ref": "#/$defs/Viewport" },
            "selection": { "$ref": "#/$defs/Selection" },
            "drawings": {
              "type": "array",
              "items": { "$ref": "#/$defs/Stroke" }
            },
            "image": {
              "type": "string",
              "contentEncoding": "base64",
              "contentMediaType": "image/png"
            }
          }
        }
      }
    },
    "HeartbeatPongResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": { "const": "heartbeat.ping" },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["nonce"],
          "properties": {
            "nonce": { "type": "string", "minLength": 1, "maxLength": 128 }
          }
        }
      }
    },
    "ErrorResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "error"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": {
          "type": "string",
          "enum": [
            "surfaces.list",
            "pair.request",
            "content.set",
            "content.append",
            "content.patch",
            "content.clear",
            "annotations.remove",
            "snapshot.get",
            "heartbeat.ping",
            "panes.list",
            "pane.split",
            "pane.rename",
            "pane.close"
          ]
        },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": false },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "error": { "$ref": "#/$defs/ErrorBody" }
      }
    },

    "StrokePoint": {
      "type": "object",
      "additionalProperties": false,
      "required": ["x", "y", "timestamp"],
      "properties": {
        "x": { "type": "number" },
        "y": { "type": "number" },
        "pressure": { "type": "number", "minimum": 0, "maximum": 1 },
        "timestamp": { "$ref": "#/$defs/EpochMs" }
      }
    },
    "Stroke": {
      "type": "object",
      "additionalProperties": false,
      "required": ["strokeId", "tool", "points"],
      "properties": {
        "strokeId": { "$ref": "#/$defs/StrokeId" },
        "tool": { "type": "string", "enum": ["pencil", "finger", "mouse"] },
        "videoTimestamp": { "type": "number", "minimum": 0 },
        "points": {
          "type": "array",
          "items": { "$ref": "#/$defs/StrokePoint" },
          "minItems": 1
        }
      }
    },

    "DrawingFlushEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.drawing_flush" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "paneId",
            "contentId",
            "revision",
            "flushId",
            "flushReason",
            "idleWindowMs",
            "maxIntervalMs",
            "strokes",
            "strokeCount",
            "pointsCount",
            "firstStrokeAt",
            "lastStrokeAt"
          ],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "contentId": { "$ref": "#/$defs/ContentId" },
            "revision": { "$ref": "#/$defs/Revision" },
            "flushId": { "$ref": "#/$defs/FlushId" },
            "flushReason": {
              "type": "string",
              "enum": ["idle_window", "max_interval"]
            },
            "idleWindowMs": { "type": "integer", "minimum": 5000, "maximum": 10000 },
            "maxIntervalMs": { "type": "integer", "minimum": 10000 },
            "strokes": {
              "type": "array",
              "items": { "$ref": "#/$defs/Stroke" },
              "minItems": 1
            },
            "strokeCount": { "type": "integer", "minimum": 1 },
            "pointsCount": { "type": "integer", "minimum": 1 },
            "firstStrokeAt": { "$ref": "#/$defs/EpochMs" },
            "lastStrokeAt": { "$ref": "#/$defs/EpochMs" }
          }
        }
      }
    },
    "TapEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.tap" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "contentId", "revision", "kind", "position"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "contentId": { "$ref": "#/$defs/ContentId" },
            "revision": { "$ref": "#/$defs/Revision" },
            "kind": { "type": "string", "enum": ["tap", "long_press"] },
            "position": { "$ref": "#/$defs/Position" },
            "nearestContent": { "type": "string" }
          }
        }
      }
    },
    "ScrollEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.scroll" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "contentId", "revision", "phase", "viewport", "visibleText"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "contentId": { "$ref": "#/$defs/ContentId" },
            "revision": { "$ref": "#/$defs/Revision" },
            "phase": { "const": "settled" },
            "viewport": { "$ref": "#/$defs/Viewport" },
            "visibleText": { "type": "string" }
          }
        }
      }
    },
    "SelectionEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.selection" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "contentId", "revision", "selection"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "contentId": { "$ref": "#/$defs/ContentId" },
            "revision": { "$ref": "#/$defs/Revision" },
            "selection": { "$ref": "#/$defs/Selection" }
          }
        }
      }
    },
    "PageEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.page" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "contentId", "revision", "page", "totalPages"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "contentId": { "$ref": "#/$defs/ContentId" },
            "revision": { "$ref": "#/$defs/Revision" },
            "page": { "type": "integer", "minimum": 1 },
            "totalPages": { "type": "integer", "minimum": 1 },
            "pageText": { "type": "string" }
          }
        }
      }
    },
    "NavigationEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.navigation" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "contentId", "revision", "url"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "contentId": { "$ref": "#/$defs/ContentId" },
            "revision": { "$ref": "#/$defs/Revision" },
            "url": { "type": "string" }
          }
        }
      }
    },
    "SurfaceAppearedEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.surface_appeared" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["surfaceId", "name", "windowLabel", "viewport"],
          "properties": {
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "name": { "type": "string" },
            "windowLabel": { "$ref": "#/$defs/WindowLabel" },
            "viewport": { "$ref": "#/$defs/SurfaceViewport" }
          }
        }
      }
    },
    "SurfaceRemovedEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.surface_removed" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["surfaceId"],
          "properties": {
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "surfaceTombstoneId": { "type": "string", "minLength": 1, "description": "Required for lockless close; names the final-close record after a final close." },
            "recoverable": { "type": "boolean", "description": "True for a 0.2.10-rc1 close; false for a final close (§4.7.1)." },
            "closedSequence": { "type": "integer", "minimum": 1 },
            "cause": { "type": "string", "enum": ["controller", "user"] }
          }
        }
      }
    },
    "SurfaceResumedEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.surface_resumed" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["surfaceId"],
          "properties": {
            "surfaceId": { "$ref": "#/$defs/SurfaceId" }
          }
        }
      }
    },
    "ConsumableAvailableEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.consumable_available" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["controllerInstanceId", "scopeId", "pending", "gapGeneration"],
          "properties": {
            "controllerInstanceId": { "type": "string", "minLength": 1 },
            "scopeId": { "type": "string", "minLength": 1 },
            "pending": { "type": "boolean" },
            "gapGeneration": { "type": "integer", "minimum": 0 }
          }
        }
      }
    },
    "ConsumableOverflowEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.consumable_overflow" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["controllerInstanceId", "scopeId", "consumableGap", "retainedRange"],
          "properties": {
            "controllerInstanceId": { "type": "string", "minLength": 1 },
            "scopeId": { "type": "string", "minLength": 1 },
            "consumableGap": { "type": "object" },
            "retainedRange": { "type": "object" }
          }
        }
      }
    },
    "ControllerRetentionReclaimedEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.controller_retention_reclaimed" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["controllerInstanceId", "dormantSequence", "reason"],
          "properties": {
            "controllerInstanceId": { "type": "string", "minLength": 1 },
            "dormantSequence": { "type": "integer", "minimum": 1 },
            "reason": { "type": "string", "minLength": 1 }
          }
        }
      }
    },
    "SnapshotHintEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.snapshot_hint" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["reason"],
          "properties": {
            "reason": {
              "type": "string",
              "enum": ["after_render", "after_reconnect", "backpressure_drop"]
            }
          }
        }
      }
    },

    "PanesListRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "panes.list" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" }
      }
    },
    "PanesListResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": { "const": "panes.list" },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["panes"],
          "properties": {
            "panes": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["paneId", "paneLabel", "name", "activeContentId", "contentType", "viewport"],
                "properties": {
                  "paneId": { "$ref": "#/$defs/PaneId" },
                  "paneLabel": { "$ref": "#/$defs/PaneLabel" },
                  "name": {
                    "oneOf": [
                      { "type": "string", "minLength": 1 },
                      { "type": "null" }
                    ],
                    "description": "Extension-assigned human-readable name for this pane, or null if none."
                  },
                  "activeContentId": {
                    "oneOf": [{ "$ref": "#/$defs/ContentId" }, { "type": "null" }]
                  },
                  "contentType": {
                    "oneOf": [{ "$ref": "#/$defs/ContentType" }, { "type": "null" }]
                  },
                  "viewport": { "$ref": "#/$defs/SurfaceViewport" }
                }
              }
            }
          }
        }
      }
    },

    "PaneSplitRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "pane.split" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "expectedTopologyRevision", "count", "direction"],
          "properties": {
            "paneId": {
              "$ref": "#/$defs/PaneId",
              "description": "Pane to split. Required."
            },
            "expectedTopologyRevision": {
              "type": "integer",
              "minimum": 0,
              "description": "Client topology revision observed by the controller."
            },
            "count": {
              "type": "integer",
              "minimum": 2,
              "description": "Total pane count after split, including the source pane."
            },
            "direction": {
              "type": "string",
              "enum": ["horizontal", "vertical"]
            }
          }
        }
      }
    },
    "PaneSplitResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": { "const": "pane.split" },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["panes"],
          "properties": {
            "panes": {
              "type": "array",
              "minItems": 1,
              "description": "All panes in the window after the split, including pre-existing panes. The source pane retains its original paneId and appears first.",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["paneId", "paneLabel"],
                "properties": {
                  "paneId": { "$ref": "#/$defs/PaneId" },
                  "paneLabel": { "$ref": "#/$defs/PaneLabel" }
                }
              }
            }
          }
        }
      }
    },

    "PaneRenameRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "pane.rename" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "name"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "name": {
              "oneOf": [
                { "type": "string", "minLength": 1 },
                { "type": "null" }
              ],
              "description": "New human-readable name for the pane, or null to clear an existing name."
            }
          }
        }
      }
    },
    "PaneRenameResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": { "const": "pane.rename" },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "name"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "name": {
              "oneOf": [
                { "type": "string", "minLength": 1 },
                { "type": "null" }
              ]
            }
          }
        }
      }
    },

    "PaneCloseRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "pane.close" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" }
          }
        }
      }
    },
    "PaneCloseResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": { "const": "pane.close" },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["paneId", "tombstoneId", "topologyRevision", "recoverable", "closedSequence"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "tombstoneId": { "type": "string", "minLength": 1 },
            "topologyRevision": { "type": "integer", "minimum": 0 },
            "recoverable": { "type": "boolean", "description": "True for a 0.2.10-rc1 close; false for a final close (§4.7.1)." },
            "closedSequence": { "type": "integer", "minimum": 1 }
          }
        }
      }
    },

    "PaneCreatedEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.pane_created" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["surfaceId", "paneId", "paneLabel", "fromSplit"],
          "properties": {
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "paneId": { "$ref": "#/$defs/PaneId" },
            "paneLabel": { "$ref": "#/$defs/PaneLabel" },
            "parentPaneId": {
              "oneOf": [{ "$ref": "#/$defs/PaneId" }, { "type": "null" }],
              "description": "The pane that was split to produce this new pane, or null if created standalone."
            },
            "fromSplit": {
              "type": "boolean",
              "description": "true when this pane was created as part of a pane.split operation."
            }
          }
        }
      }
    },
    "PaneRemovedEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.pane_removed" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["surfaceId", "paneId"],
          "properties": {
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "paneId": { "$ref": "#/$defs/PaneId" },
            "tombstoneId": { "type": "string", "minLength": 1, "description": "Required for lockless close; names the final-close record after a final close." },
            "recoverable": { "type": "boolean", "description": "True for a 0.2.10-rc1 close; false for a final close (§4.7.1)." },
            "closedSequence": { "type": "integer", "minimum": 1 }
          }
        }
      }
    },
    "FleetLabelsConfirmedEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.fleet_labels_confirmed" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["surfaceId", "windowLabel", "panes"],
          "properties": {
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "windowLabel": { "$ref": "#/$defs/WindowLabel" },
            "panes": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["paneId", "paneLabel"],
                "properties": {
                  "paneId": { "$ref": "#/$defs/PaneId" },
                  "paneLabel": { "$ref": "#/$defs/PaneLabel" }
                }
              }
            }
          }
        }
      }
    },
    "PaneRenamedEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "eventId", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "event" },
        "op": { "const": "event.pane_renamed" },
        "eventId": { "$ref": "#/$defs/EventId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["surfaceId", "paneId", "name"],
          "properties": {
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "paneId": { "$ref": "#/$defs/PaneId" },
            "name": {
              "oneOf": [
                { "type": "string", "minLength": 1 },
                { "type": "null" }
              ]
            }
          }
        }
      }
    }

  }
}
```

## 11. Adversarial Hardening Results

This section documents the hardening decisions locked into the protocol.

1. Race: duplicate sockets from reconnect overlap.
Resolution: pair includes stable asserted `controllerInstanceId`; duplicate live identity is refused deterministically, and retained same-ID resume restores only bounded cursor/gap state.

2. Out-of-order or retried content mutations.
Resolution: mandatory monotonic `revision`; strict `expectedRevision` gate; request-ID idempotency cache.

3. Event loss or event flood.
Resolution: event stream is best-effort across reconnect by design; provider must issue `snapshot.get` after reconnect; backpressure coalesces high-rate events and emits `event.snapshot_hint`; drawing flushes are dual-gated (idle + max interval) to bound send frequency.

4. Ghost occupancy after crash.
Resolution: socket loss never clears displayed content or mutates client truth. Other admitted controllers continue.

5. Payload abuse and parser risk.
Resolution: explicit max-byte limits in pair response; typed schemas; `content_too_large` and WS close `4413`; malformed envelope closes `4410`.

6. Stale content targeting (append/patch after replace).
Resolution: mutation ops require both current `contentId` and next `revision`; stale content returns `stale_content`.

7. Ambiguous state after reconnect.
Resolution: pair response always returns authoritative current pane state (`panes[]` with per-pane `currentContentId`, `currentRevision`, and `contentType`), and provider performs immediate `snapshot.get` before normal operation.

8. Short drawing pauses triggering noisy sends.
Resolution: send requires unsent changes (`dirty=true`) plus either idle-window silence or max-interval expiry; small pauses do not flush.

9. Continuous drawing never flushing.
Resolution: max interval timer forces `event.drawing_flush` at 30s (default) whenever unsent strokes exist.

10. Redundant resend with no changes.
Resolution: `dirty` gating forbids sends unless new strokes arrived since last successful send.

11. Flush transmission visibility ambiguity.
Resolution: surface shows a visible in-flight send indicator for every drawing flush attempt.

12. Surgical deletion drift (wrong strokes removed).
Resolution: every stroke carries stable `strokeId`; `annotations.remove` accepts explicit `strokeIds` and returns `removedStrokeIds` + `notFoundStrokeIds`, leaving unspecified strokes untouched.

13. Surface overreach on drawing semantics.
Resolution: surface remains passive and non-interpreting; only OpenClaw decides persistent vs consumed drawings and invokes `annotations.remove` when needed.

14. Orphaned strokes across content transitions.
Resolution: `content.set` and `content.clear` both hard-clear the drawing overlay; no cross-content carryover is allowed.

15. Snapshot bloat and recovery failure.
Resolution: extracted visible text is not part of `snapshot.get`; drawings remain
conditional on `includeDrawings` (default false).

16. Heartbeat false timeouts during heavy rendering.
Resolution: surface must prioritize pong generation over render/mutation queue work.

17. Pair handshake hang.
Resolution: provider enforces 10s `pair.request` timeout from socket establishment, then closes and reconnects.

18. Reconnect race between fresh events and state resync.
Resolution: provider buffers post-reconnect events during mandatory snapshot, applies snapshot first, then drains buffered events in order.

19. Snapshot image interoperability mismatch.
Resolution: `snapshot.get` image payload is explicitly base64-encoded PNG.

20. TLS profile ambiguity for v1.
Resolution: v1 interop scope is `ws` only; WSS/TLS profile is deferred to v2 and marked out of scope.

## 12. Implementation Readiness Checks

Protocol is ready for implementation when these checks pass in integration tests:
1. Provider can discover, connect, pair, push content, clear content, and get snapshot over WS only.
2. Default `minimum_deep` profile emits `event.drawing_flush`, `event.tap`, `event.selection`, `event.page`, `event.navigation`, and provider-internal `event.snapshot_hint` without any direct-surface watch subscription call.
3. Surface flushes drawings only under dual-gate timing (`idleWindowMs` + `maxIntervalMs`) and never flushes unchanged data.
4. Every stroke in `event.drawing_flush` and `snapshot.get` has stable `strokeId` and retains ID stability until explicitly removed.
5. `annotations.remove` removes only requested stroke IDs, reports `removedStrokeIds`/`notFoundStrokeIds`, and preserves all unspecified strokes.
6. Reconnect uses stable controller identity and bounded resume state; socket loss does not mutate client truth or block other admitted controllers.
7. Revision errors and idempotency replay behave exactly as specified.
8. Visual send indicator is visible while each drawing flush transmission is in-flight.
9. `content.set` and `content.clear` both clear drawing overlay state.
10. Heartbeat pong is emitted within SLA even while render queue is busy.
11. Pair request times out at 10s when `pair.response` is missing.
12. Reconnect path buffers events until snapshot succeeds, then replays in order; on snapshot failure provider reconnects.
13. `snapshot.get` returns a base64 PNG for `image` and conditionally includes
    drawings per `includeDrawings`; visible text is carried only by the separate
    settled `event.scroll` operation when available.
14. All messages validate against the schema in Section 10.
15. Surf Ace extension skills are present at these provider paths and load successfully:
   - `extensions/surf-ace/skills/surf-ace-ops/SKILL.md` (tool usage for list/push/read/clear/pane ops)
   - `extensions/surf-ace/skills/surf-ace-markup/SKILL.md` (annotation interpretation + markup workflow)
16. Static Surf Ace guidance is delivered only through contributed extension skills or an explicitly contributed system prompt. The extension MUST NOT attach static guidance from `before_prompt_build`, `prependContext`, `prependSystemContext`, or any other per-turn prompt-build hook.

Implementation status: ready for implementation.

### 12.1 Explicit diagnostic pane paint observation (optional; implementation gated)

`diagnostics.pane_paint.get` is a separate explicit read-only diagnostic, not an extension of `snapshot.get` or ordinary cached reads. Implementations MUST preserve existing RequestId, SurfaceId and ContentId definitions. The capability `surf-ace.pane-paint-diagnostic.v1` is advertised only after a qualified adapter is implemented; absent capability means unsupported locally, not blind old-client probing. Existing paired-controller/surface authorization applies without new pairing, trust, access or discovery scope.

Describe performs fresh fixed internal ownership/authority reads without capture, returning the exact current surface/epoch, window/host, pane/lineage/content/revision, topology/geometry and guest/frame/render/document identity and canonical §16 projection. It issues a random128bit connection-bound observationToken, expiring after5000ms; one token per admitted connection, superseding successful describe invalidates the prior token. Observe requires that entire expectation and token, validates actual ownership and canonical projection before/after each separate GUEST/HOST capture and again before publication, and refuses stale/detached/replaced/mismatched state. No caller script, debugger, arbitrary WebContents target, cached metadata or HOST crop may substitute for a fresh read or actual GUEST capture. Future generation maintenance and canonical-authority adapter wiring require review.

#### Diagnostic exception to §5.3 request replay

The generic §5.3 last1024 request response cache and identical-payload replay remain unchanged for ordinary operations. Diagnostic requests instead retain a bounded metadata-only ledger of at most1024 IDs per paired connection: RequestId, operation, payload digest, pending/completed marker and terminal reason; never image bytes or tokens. Diagnostic ledger entries are NOT evicted within a connection, expire only on disconnect/re-pair, and never replay images. A duplicate diagnostic ID (same or different payload) returns invalid_request_id_reuse without resampling; an ordinary request colliding with a retained diagnostic ID also returns that error. Diagnostic requests also check the existing ordinary1024 cache: any cross-operation collision still retained there returns invalid_request_id_reuse. After an ordinary cache eviction an otherwise unknown ID may enter the diagnostic ledger; no perpetual uniqueness promise extends beyond those bounded stores or across connections.

Under one admission turn, perform authentication/schema validation, check both ID stores, reserve the diagnostic ledger slot, check concurrency/platform/transport capacity, validate token/expectation, and only then consume an observe token and start reads/capture. Malformed/unpaired requests and duplicate IDs do not reserve or change tokens. If all1024 diagnostic slots are occupied, return busy at admission without inserting a new ID or consuming a token; retries with that unknown ID are permitted only after a new connection clears saturation, not by evicting old diagnostic IDs. An ordinary operation never inserts into this diagnostic ledger. Other pre-admission busy/unsupported/transport failures after reservation complete that metadata record but leave tokens unchanged. Describe failure leaves the previous token intact; successful describe installs its replacement atomically. Observe failure after consumption never makes that token reusable. Disconnect invalidates tokens and both connection-scoped stores; new paired connection may reuse IDs but cannot use old tokens. No concurrent/queued diagnostic request exists per connection; two may be active per app. Pending native work continues holding capacity until it safely drains even after timeout/disconnect, and disconnect cannot evade the application cap.

#### Receipt fences and partials

The versioned `specs/pane-paint-diagnostic-v1/schema.json`, `REFUSAL-MATRIX.md`, and `semantic_model.py` define the exact payload and reason/stage matrix for this optional capability. All results echo the validated request context and configuredBudgetMs. Existing ok:false envelopes apply to malformed/unpaired/duplicate requests; the production protocol must add this operation to its error-operation enum before advertising support. ok:true means handled, not successful pixels: outcome is described, observed or refused. Unsupported platforms/content/backend, busy and admission transport-limit refusals contain no images/checks. Describe never captures. No observation error authorizes recovery.

For observed pairs, checks/captures MUST interleave initial <= GUEST-before <= GUEST-start <= GUEST-end <= GUEST-after <= HOST-before <= HOST-start <= HOST-end <= HOST-after <= publish <= elapsed, with equal offsets permitted for clock resolution. All checks MUST be attached and match request binding/projection. Each image MUST match the admitted binding, target, raw PNG hash, pixel dimensions and coordinate space. Refused results retain only validated prefix captures (none, GUEST, GUEST+HOST), with request-correlated prechecks, exact timing and reason/stage exact-prefix count; bad GUEST has no HOST attempt/image, bad HOST retains exactly the prior valid GUEST. The reason/stage table defines exact image prefix counts and permitted check prefix lengths, including capture prerequisites; a later-stage failure cannot silently discard earlier validated images. Actual failed read state may be preserved, explicitly distinct from a passing fence. The versioned matrix/semantic validator is normative alongside shape validation; schema alone is insufficient.

GUEST means that exact owned guest full current viewport capture. HOST means the owning application-window canonical pane clip, retaining overlapping controls; neither image is silently trimmed/rescaled or relabeled. Projection includes canonical host/clip rect, coordinate spaces, guest viewport/scroll, affine guest-to-surface transform, DPR and scale mode/nonce/revision/sequence/visibility/opacity. Separate monotonic capture intervals, check receipts and midpoint skew label atomic:false, paintFreshness:not-established, physicalDisplay:not-observed. State may render between checks; no same-frame, fresh-painted-frame or physical display proof is promised.

#### Measured deadline, drain, privacy and support

Configured deadline is1..2000ms (describe2000). Observed/described success and retained image completion MUST be within that configured budget. Refusal elapsed/check times are actual finite monotonic offsets up to the safe-number representational bound, and MAY exceed configured budget due to scheduling/synchronous work; never clamp or fabricate them. Timer expiry emits refusal at the earliest safe JS opportunity, with nativeDrain:not-required/pending/complete as actually known then; pending drain has no invented completion time and later safe drain releases capacity without a second wire response. A completed drain receipt gives its actual completion offset, which may exceed the configured deadline but MUST NOT exceed the actual elapsed time of the receipt that reports completion. Native replies completing after deadline cannot be admitted as images. If the clock is invalid/unrepresentable, suppress the diagnostic payload and use existing internal_error/transport failure rather than report false timestamps. Synchronous PNG validation is not preemptible; adapter cancellation/drain requires separate review and no forced guest kill.

Per image bounds:2MiB compressed,8192px/dimension,32MiB decoded; pair4MiB compressed/64MiB decoded. Respect stricter existing transport limits before capture and publication, without raising them. Preflight uses the maximum bounded response size; insufficient transport capacity returns transport-limit at admission without images. If serialization nevertheless exceeds the transport limit, use the existing content_too_large error envelope without images rather than an oversized diagnostic partial result. Require PNG CRC/dimensions, singleton PLTE before IDAT, consecutive IDAT and bounded decode/scanline validation. Capacity admits no diagnostic queue. Unsupported adapters/platforms/native guests return typed unsupported without emulation; initial feature support is only separately qualified Electron HTML/browser adapters on macOS/Linux. Existing native/iOS/Spatial supported-client obligations are not waived.

These sensitive images return only to their requesting authorized controller. No automatic retry, broadcast, cached image replay, journal/history persistence, upload, URL/text collection, base64 logging or recovery mutation is permitted. Expected tuple/token memory expires after5s; diagnostic ID metadata alone remains connection-bounded. Controller artifact retention/redaction is explicit under existing operator policy. Disconnect suppresses replies and frees retained images after safe owned completion. Logs retain only correlation, reason, timing, size/hash under existing retention. Mike approved this separate specification. This contract does not register the operation in the production protocol, enable capture, authorize recovery, or establish live pane paint.

## 13. Provider → OpenClaw Event Routing

This section specifies how surface events reach OpenClaw. It is intentionally separate from the WS protocol (Sections 3–10), which covers only the provider↔surface channel. The provider↔OpenClaw channel is a different seam with different requirements.

### 13.1 Design Principles

1. **Augmentative, not invasive.** Normal Clawline message dispatch must have zero knowledge of Surf Ace. No Surf Ace logic runs in the inbound message critical path.
2. **Tool-driven.** OpenClaw interacts with surfaces exclusively via explicit tool calls. The provider never injects context into an OpenClaw turn automatically.
3. **Alerts are expensive.** Each alert fires an OpenClaw agent turn. The provider MUST minimize alerts while still ensuring OpenClaw can observe surface activity in a timely way.
4. **No live network I/O in dispatch path.** The provider MUST NOT issue live `snapshot.get` calls (or any network calls to surfaces) as part of processing an inbound OpenClaw message.

### 13.2 Client-Authoritative Consumable Scopes and Controller Read Projection

In lockless mode, the client maintains the authoritative bounded pane/surface consumable scopes, records, cursor floors, pending truth, and sticky structured gaps defined in §4.8. Each controller maintains a bounded local projection populated asynchronously by pair/resume snapshots and client-authored ordered deltas over the existing connection. The projection has a current content snapshot, **two annotation channels**, typed **non-annotation registers**, projected cursor/gap state, and a durable acknowledgement outbox.

- **Current content snapshot:** local cached readback for the currently visible pane content, populated by content pushes, pair/snapshot sync, and reconnect snapshot state. It includes the normalized pushed content payload when that payload is locally known, so readback remains useful before a renderer snapshot arrives.
- **Channel A — Live dirty channel (mutable):** near-real-time stroke deltas for the currently active context frame while the user is annotating.
- **Channel B — Closed frame projection (immutable):** finalized append records retained authoritatively by the client within advertised scope bounds and projected locally until the controller reads/acknowledges them.

OpenClaw reads from this local projection only; no ordinary `surf_ace_read` call triggers a live network call to a surface. Local consumption durably queues an idempotent acknowledgement; only client acceptance advances authoritative cursor/pending/gap truth.

**Scope:** At the OpenClaw boundary, reads are pane-scoped: `surf_ace_read(fingerprint, paneId)` targets the corresponding projected client pane scope. The client also owns one surface-level non-pane consumable scope. Per-history annotation/restore state remains CAP-bounded client state and opaque to the tool API.

---

#### Annotation Context Frame Model (Context-Keyed Until Explicit Commit)

Annotation data is keyed by **context** while its live frame remains open. A
pause/re-entry before an explicit commit continues that frame; once
`event.annotation_committed` is emitted, the frame is sealed and later
annotation in the same context starts a new live frame. Mike's Oct 1 v0.2.4
ruling makes this commit event—not a timeout or a context change—the boundary
between same-context frames.

A context key is:
- OpenClaw-pushed content: active `contentId`
- HTML user navigation context: normalized URL (fragment stripped, query preserved)
- Non-URL types: `contentId` (or equivalent stable content identity)

**Important invariants:**
1. Scroll alone does **not** create a new context frame.
2. Navigation/content change alone does **not** create a frame.
3. A new frame is created only when annotation actually occurs in that context.
4. Re-entering annotation mode in the same context before explicit commit appends to the same mutable context frame; after `event.annotation_committed`, re-entry opens a new live frame.

Current content readback is separate from annotation frames. A content push updates the local current content snapshot, but does not create a live annotation frame or a closed annotation frame by itself.

**Lifecycle (dual-channel semantics):**
1. On first stroke in a context with no open frame, the client creates/opens the bounded mutable live-frame record.
2. While annotating in that context, `event.drawing_flush` strokes coalesce deterministically by stable stroke ID into that client record and are projected through ordered deltas.
3. Exiting annotation mode via **Done** records recoverable completion intent, pauses live writes, and requests `event.annotation_committed` only after pending `event.drawing_flush` delivery. Intent alone does not close or publish the frame. On restart, §4.10's ordered boundary proof governs recovery. If the user re-enters the same context before explicit commit, serialize re-entry with recovery and continue the same open frame; no delayed completion may seal strokes added after re-entry. After the commit is proven, same-context re-entry starts a new live frame.
4. While annotation mode is active, pane content replacement and user navigation are blocked; there is no visibility switch until the user taps **Done**.
5. After **Done**, any user navigation or explicit content replacement/clear (`content.set` / `content.clear`) is a normal context switch. The provider finalizes the current open frame before applying that switch, then opens/resumes the next context as needed.

Note: This section governs **frame finalization** only. Transport flush/send cadence for `event.drawing_flush` remains governed by Section 7.1 flush-gate timing (`idleWindowMs` / `maxIntervalMs`).

This preserves context-coherent payloads while still allowing OpenClaw to react during active annotation.

**Frame structure (shared by live and closed channels):**

```
{
  frameId:       string      Stablele frame identity (fr_<hex>)
  contextKey:    string      Stablele context identity for this frame
  contentId:     string      contentId active when frame was first opened
  url?:          string      URL for HTML contexts
  scrollOffset:  { x, y }    Viewport scroll offset at frame open
  viewport:      { width, height, scale }
  openedAt:      EpochMs     First annotation timestamp for this context frame
  updatedAt:     EpochMs     Last stroke appended timestamp
  image:         string      Base64 PNG of viewport captured at frame open
  strokes: [
    {
      strokeId:   string      Stablele stroke identity (stroke_<hex>)
      points:     [{ x, y, pressure? }]
      bbox:       { x, y, width, height }
      startedAt:  EpochMs
      endedAt:    EpochMs
    }
  ]
}
```

**Coordinate space:** image and strokes are both viewport-at-open coordinates. No translation is required for in-frame geometry alignment. `scrollOffset` remains available for content-space mapping.

---

#### Channel A: Live Dirty Channel (Mutable)

The live channel exposes the currently open context frame with incremental dirty state:

- `liveFrame` — current mutable frame (or `null` if none)
- `liveDirtyStrokeIds[]` — stroke IDs appended since last `surf_ace_read`
- `liveSeq` — monotonically increasing sequence for live updates on that frame

**Live read semantics:** OpenClaw can repeatedly call `surf_ace_read` during annotation and receive the newest deltas for near-real-time reaction.

---

#### Channel B: Closed Frame Queue (Immutable)

Closed frames are immutable append records ordered by client `consumableSequence`. They remain in the authoritative bounded client scope until cursor acknowledgement or deterministic capacity loss; `frames[]` is the controller's local projection.

**Batch limits per read:**
1. Max **5** closed frames per read.
2. Pixel budget cap: approximately **4 MB** total encoded image payload across returned closed frames.
3. If next frame would exceed cap, leave it queued and return `pendingFrames`.

Returned frames are removed from the local projection transaction, the projected cursor advances, and an acknowledgement intent is durably appended before return. The client cursor advances only after acknowledgement acceptance; OpenClaw may deliver it in the background, while the standalone CLI delivers it during the next explicit networked invocation for every caller.

---

#### Anti-Dup Semantics Across Channels

The same stroke may appear in both channels:
- first via live dirty updates (Channel A)
- later inside its finalized closed frame (Channel B)

This is intentional. Closed frames are guaranteed context-preserved records and MUST remain deliverable even if OpenClaw already saw live deltas.

**Dedup guidance:** OpenClaw should dedupe by `strokeId` per `frameId` (or per `contextKey` where appropriate). Provider MUST keep stable `strokeId` across live and closed representations.

---

#### Non-Annotation Registers

The following declared record classes handle non-annotation surface events. Append/latest-wins behavior is enforced by the client before advertised scope capacity enforcement and mirrored by the projection.

**Latest-wins** — The client retains only the most recent value for that kind/scope. A local read consumes its projected value and queues acknowledgement.

**Append** — Complete records accumulate in client sequence order within advertised count/byte bounds. They never merge or partially truncate.

| Register | Rule | Type | Description |
|---|---|---|---|
| `scrollPosition` | Latest-wins | object | Latest settled scroll offset and visible rect `{ x, y, visibleRect }`. Cleared on `surf_ace_read`. |
| `selection` | Latest-wins | object? | Current text selection; `null` if none. In v1, surfaces only emit `kind: "text"` selection events. If the provider receives a `kind: "point"` or `kind: "region"` selection from the wire, it MUST discard it and leave this register unchanged. Cleared on `surf_ace_read`. |
| `page` | Latest-wins | object? | Current page state `{ pageNumber, pageCount, pageLabel }`; `null` if not a paged content type. Cleared on `surf_ace_read`. |
| `taps` | Append | array | Ordered list of point-out tap events since last read. UI-navigation taps (link follows, button activations) are NOT included here — they produce `event.navigation` instead. |
| `playbackPosition` | Latest-wins | number? | **Video only.** Current playback position in seconds. `null` for all other content types. Populated by a v2 wire event. In v1, always `null`. |
| `playbackState` | Latest-wins | string? | **Video only.** One of `"playing"`, `"paused"`, `"ended"`. `null` for all other content types. In v1, always `null`. |
| `lastNavigation` | Latest-wins | object? | **HTML only.** Most recent navigation away from OpenClaw-pushed content in the currently addressed pane. `{ url: string, navigatedAt: EpochMs }` or `null`. Populated by `event.navigation`. `navigatedAt` maps from wire `NavigationEvent.sentAt`. Cleared on `surf_ace_read`. |

#### Overflow

Each record/live-frame ingress transaction applies declared coalescing, computes exact versioned serialized count/bytes, and removes complete oldest records by `consumableSequence` until the advertised scope bounds hold. An oversized candidate or removed unread range creates or extends one bounded sticky client `consumableGap` per affected controller/scope, sends targeted `event.consumable_overflow`, and writes durable diagnostics. Local reads project that gap as structured `consumableLoss`; they cannot invent or erase it.

### 13.3 Alert Gate (Dual-Channel Activity Gate)

**Alert trigger:** the client sends targeted `event.consumable_available` when a scope transitions to pending or its gap generation changes. The controller may project one alert when unread annotation activity first appears, from either channel:
- first live-dirty update since last read, or
- first newly queued closed frame since last read.

**Alert text:** `"Surf Ace updates pending on [screen name]"` (optionally include counts: live dirty present + queue depth).

**Alert gate rules:**
1. If local projected `alertFired=false` and client-authored pending/gap truth shows new unread activity, fire one alert and set local `alertFired=true`.
2. While `alertFired=true`, suppress additional alerts for subsequent dirty deltas/frame closures.
3. On `surf_ace_read`, reset local presentation `alertFired=false`; only a client-accepted acknowledgement clears authoritative pending/gap truth.

This gives one alert per unread activity burst while still allowing live reads during annotation.

**Alert timeout:** If `alertFired=true` and no `surf_ace_read` arrives within 10 minutes, reset `alertFired=false` so future activity can re-trigger.

**Non-annotation events:** register-only updates do not independently trigger alerts in v1.

### 13.4 OpenClaw Reads the Buffer

OpenClaw uses one read tool:

**`surf_ace_read(fingerprint, paneId)`** — reads the current local content snapshot, live annotation state, closed frames (bounded), plus registers, for one pane. `paneId` is required.

Read order and behavior:
1. Return the local `contentSnapshot` for the pane's currently visible content when available, including the normalized pushed content payload when locally known.
2. Return **live channel first** (`liveFrame` + `liveDirtyStrokeIds` + `liveSeq`) if present.
3. Return closed frames from FIFO queue (up to 5 and within ~4 MB image budget).
4. Include `pendingFrames` when queue remains.
5. Return structured projected `consumableLoss`, retained range, and `cacheStatus`.
6. In one durable local transaction, clear consumed projected registers, advance the projected cursor/live dirty set, remove returned frames, reset local alert presentation, and append an idempotent acknowledgement intent.
7. Return without opening a connection, waiting for a client round trip, or invoking snapshot/network I/O.
8. OpenClaw's background sender transmits acknowledgements; the standalone CLI transmits them during the next explicit networked invocation for every caller. Reconnect reconciles the durable outbox, client cursor/gap generations, and missing projection ranges idempotently.

OpenClaw should use `contentSnapshot` for current pane content readback, prioritize interpreting `liveFrame` first when present, then process closed frames for guaranteed context-preserved completion.

**Model processing order policy (dirty vs backlog):**
1. **Live preempts backlog.** If `liveFrame` + `liveDirtyStrokeIds` is present, model should process that first for real-time responsiveness.
2. **Backlog drains when live is quiescent.** Process `frames[]` oldest-first only when no `liveSeq` increment has occurred for at least 1000 ms (recommended default).
3. **If new live arrives while draining backlog, pause backlog and return to live processing.**
4. **Closed frames are still processed even if some strokes were seen live.** Their image/context payload is authoritative for completion and auditability.
5. **Dedup by stroke identity.** A stroke may appear in both channels; dedupe by `strokeId` scoped to `frameId`/`contextKey`.

This preserves both goals: real-time reaction during active annotation and guaranteed catch-up for older context.

**Tool surface continuity:** `surf_ace_read_buffer` remains deprecated/removed. No new mandatory read tool is introduced for v1 dual-channel; the existing `surf_ace_read` response shape is extended.

### 13.5 Alert Content

The alert sent to the watcher session MUST be lightweight:
- It names the screen and indicates pending update state (live dirty and/or closed frame queue depth).
- It does NOT include frame payloads or stroke data in the alert body.
- OpenClaw retrieves payloads via the `surf_ace_read` tool call.

### 13.6 What the Provider MUST NOT Do

- **No live snapshot calls during inbound message handling.** Context injection that requires network round-trips to surfaces is forbidden in the Clawline admission/dispatch path.
- **No automatic context enrichment.** Provider must not attempt to append surface state to OpenClaw messages pre-run. If OpenClaw wants current state, it calls `surf_ace_read`, which reads from local cache only.
- **No multiple alerts per unread activity burst.** Once `alertFired = true`, the provider suppresses further alerts until OpenClaw reads (which re-arms the gate) OR the 10-minute alert timeout expires.

### 13.7 Relationship to Inbound Context Enrichment

If surface context (e.g. cached screen description) is ever added to OpenClaw's context, it must use a fail-open enricher interface:
- Reads from a local cache only — never issues live network calls.
- Has a bounded synchronous timeout (< 5ms cache read).
- Returns empty/stale context on any failure — never blocks or throws.
- Cache is populated by background refresh triggered by WS events (pair, content.set, snapshot_hint), not by inbound message handling.

This enricher, if implemented, must be incapable of affecting message delivery correctness.

## 14. OpenClaw Connection Job and Shared OpenClaw Tool Surface

### 14.1 OpenClaw Connection Job Model

OpenClaw maintains persistent WS connections to all discovered screens automatically. OpenClaw never initiates, manages, or tears down those OpenClaw connections. The general standalone `surf-ace` CLI has no connection job, daemon, sidecar, or MCP gate: for every caller, including Tight Beam, each short-lived invocation performs pair/resume, reconciliation, one explicit networked command, and orderly disconnect directly against the public client WebSocket.

Rules:
1. When a screen is discovered via mDNS, OpenClaw immediately begins connecting and runs the WS pair handshake.
2. OpenClaw owns an ongoing connection job for each discovered screen. The job runs continuously: if the socket drops, OpenClaw reconnects per the backoff policy in Section 4.4.
3. If a screen disappears from mDNS, OpenClaw stops the connection job for it.
4. If a screen reappears, OpenClaw resumes immediately.
5. The WS pair handshake (Section 6.1) is an internal protocol detail executed by the connection job. It is not exposed as an OpenClaw action.
6. OpenClaw never calls a "connect" or "pair" tool. By the time OpenClaw acts on a screen, the provider is already connected — or actively attempting to be.

Connection states visible to OpenClaw (via `surf_ace_list`):
- `connected` — WS socket established and pair handshake complete; ready for operations.
- `connecting` — provider is actively attempting to connect or reconnect.
- `unreachable` — screen was discovered but repeated connection attempts have failed (backoff limit reached or mDNS record stale).

### 14.2 Read/Write Model

OpenClaw's tool surface has a strict read/write split:

**Writes** go to the surface over the WS connection (pushing content, clearing content, removing annotations). These are explicit OpenClaw intent.

**Reads** are always local projection transactions. The client owns authoritative bounded consumable scopes, cursor floors, pending truth, and structured gaps. Pair/resume snapshots plus ordered deltas received during OpenClaw's connection job or the standalone CLI's explicit networked invocations keep the controller projection current. An ordinary read returns cached data/loss/status, durably advances the projected cursor and queues an idempotent acknowledgement intent, and never triggers synchronous network I/O. Only client acceptance of the acknowledgement advances authoritative state.

### 14.3 OpenClaw Tool Surface

OpenClaw interacts with surfaces through the tools defined in this section. All screen-scoped tools accept `fingerprint` (the window-surface stable identity, mapped from `surfaceId`) as the primary screen selector. `paneId` is **required** on all pane-scoped calls — OpenClaw resolves human references through `surf_ace_list` (`windowLabel` / `paneLabel`) when those labels are confirmed, then specifies the target pane explicitly by internal `paneId`. All pane-aware tool responses echo both the effective internal `paneId` and `paneLabel: integer | null`; all `windowLabel` result fields are `string | null`. `null` means allocator confirmation is pending and MUST NOT be treated as a confirmed coordinate. A caller already holding a stable fingerprint and pane ID may continue local pane operations during that pending period, but human-label resolution and label guards cannot use an unconfirmed label. On `event.fleet_labels_confirmed`, the provider updates its projection by stable IDs; after reconnect it refreshes `surfaces.list`, `pair.response`, and `panes.list` before exposing the latest labels through `surf_ace_list`.

---

#### `surf_ace_list`

Returns all known screens and their locally cached state. Read-only, local.

**Params:** none

**Returns:** array of screen records:
```
fingerprint       string    Stable screen identity (window-scoped; mapped from `surfaceId`)
windowLabel       string|null    Fleet-confirmed visible window label (`a`, `b`, `aa`, ...), or null while pending
name              string    Human-readable screen name
connectionState   enum      "connected" | "connecting" | "unreachable"
lastSeenAt        epochMs   When screen was last seen in mDNS or active
viewport          object    { width, height, scale }
panes             array     Full current pane topology: [{ paneId, name, activeContent, historySummary }]
                          Each pane record also includes `paneLabel: integer|null`, the confirmed visible identifier or null while pending.
                          activeContent: { contentId, contentType, revision } or null if idle
                          historySummary: { visibleContentId, backCount, forwardCount }
pendingEvents     int       Count of buffered events not yet read by OpenClaw
```

**Errors:** none (always returns current known local state, possibly empty array)

---

#### `surf_ace_authority_diagnostics`

Returns the local projection of client-authored admission, capability, revision, topology, lifecycle, capacity, cursor/gap, and cache-health truth used to decide which surfaces are actionable. Read-only and local.

**Params:** none

**Returns:** a diagnostic record containing persisted/live surfaces, runtime snapshot IDs, target/window records, pane and surface tombstones, pane counters, lockless capability/limits, admitted/dormant controller IDs and retention state, cursor/gap/cache health, blocked surface IDs/reasons, and runtime process state.

**Behavior:** This tool is available even when `surf_ace_list` is empty, so stale self-owned persisted surfaces and disabled/passive runtime state remain inspectable without first admitting a usable surface.

---

#### `surf_ace_push`

Push content to a screen, replacing whatever is currently displayed. Write.

**Params:**
```
fingerprint    string   Target screen
paneId         integer  Required.
contentType    enum     "html" | "image" | "pdf" | "terminal" | "markdown" | "video" | "canvas" | "browser_url"
content        string   Content payload. Encoding by type:
                          html/terminal/markdown: UTF-8 text
                          image/pdf: base64
                          video: URL string pointing to video source
                          canvas: optional JSON background spec { color?, grid? }, or empty string for plain white
                          browser_url: live URL to navigate; not static HTML
sourcePath     string   Optional file path for file-backed content. When present, the surface reload control re-reads this path instead of repainting pushed bytes.
```

**Returns:**
```
fingerprint    string
paneId         integer  Target pane
paneLabel      integer|null  Visible label of the target pane, or null while pending
contentId      string   Stable content payload ID assigned by provider (ct_<8hex>)
revision       int      Revision after push
```

**Errors:** `not_connected`, `screen_not_found`, `content_too_large`, `unsupported_content_type`, `render_failed`

---

#### `surf_ace_launch_native_app`

Launch a controller-requested native app/process target in a client-authoritative pane through Surf Ace native hosting. Write. This is the primitive process launch surface; terminal-shaped launches use this same API with the terminal app/process identity and argv.

**Params:**
```
fingerprint       string    Target screen
paneId            integer   Required.
appId             string    Canonical target app/process identity
args              string[]  Optional argv entries
cwd               string?   Optional working directory
env               object?   Optional string environment map
launchMode        enum      "new_instance" | "attach_or_launch"; default "new_instance"
confirmed         boolean   Must be true for process-backed target launch
idempotencyKey    string?   Optional stable caller key for repeated launch-equivalent requests
summary           string?   Optional human-readable target summary shown in diagnostics
```

**Returns:** same pane/target result shape as `surf_ace_push`, with `contentId: null`, `targetKind: "native_app"`, and target apply evidence.

**Behavior:** The controller requests a `native_app` target for a stable pane; the client validates/commits the pane content intent and projects client-resolved pane geometry to the compositor. Evidence must make launch readiness checkable: target app identity, args, pane geometry identity, client admission/revision tuple, host/overlay application state, and compositor lifecycle/input/focus diagnostics. Runtime binding readiness cannot affect admission or routing. The compositor receives resolved native-host and overlay regions and must not infer layout intent from controller payload. Without `confirmed:true`, an admitted/actionable pane, trusted runtime app binding, or `target.native_app.v1`, the operation fails closed and does not launch a process.

**Product proof gate:** Native GUI/app materialization is production-proven only when this official Surf Ace provider/tool path owns the target apply. A valid proof starts from `surf_ace_list` showing the target pane admitted/actionable, launches through `surf_ace_launch_native_app`, receives target apply evidence for the same pane with `nativeHost: "applied"` and `overlayRegions: "applied"`, and captures visible rendering in that Surf Ace pane. Direct compositor/native-pane calls such as `native_pane.host`, manually hosted windows, demo fixtures, fake WS servers, mocked compositor status, or lower-layer logs are diagnostic evidence only. They may explain a failure inside the Electron/compositor seam, but they cannot satisfy Surf Ace spec/product verification by themselves.

**Errors:** `not_connected`, `screen_not_found`, `invalid_operation`, `materialization_failed`

---

#### `surf_ace_clear`

Clear the currently visible content in the target pane. If older content exists in that pane's surface-managed history, users can still reach it via Back/Forward. Write.

**Params:**
```
fingerprint    string   Target screen
paneId         integer  Required.
```

**Returns:**
```
fingerprint    string
paneId         integer
paneLabel      integer|null
revision       int      Revision after clear
```

**Errors:** `not_connected`, `screen_not_found`

---

#### `surf_ace_reattempt_connections`

Operator-scoped control tool that resets open Surf Ace connection circuits and reattempts stopped reconnect/probe workers. It only wakes identity/capacity-eligible connection work and grants no right or priority. Write.

**Params:**
```
fingerprint    string   Optional target screen. Omit to reattempt all known surfaces and endpoint probes.
```

**Returns:**
```
surfaces        array    Per-surface reattempt result, including prior circuit state
endpointProbes  array    Per-endpoint-probe reattempt result, including prior circuit state
```

**Errors:** none

---

#### `surf_ace_split`

Compatibility helper for submitting one pane-split intent. For larger topology changes, use `surf_ace_realize_topology` so the client can validate and commit the desired layout in one topology mutation. Write.

**Params:**
```
fingerprint    string   Target screen
paneId         integer  Required source pane.
count          integer  Required total pane count after split, including the source pane. Minimum 2.
direction      enum     "horizontal" | "vertical"
```

**Behavior:** The controller sends split intent and `expectedTopologyRevision`. The client performs stale/capacity checks, allocates new internal `paneId` values and commits local topology atomically. Registry labels may be confirmed separately; the result uses null for a pending label.

**Returns:** array of pane records:
```
paneId         integer  Effective pane id after the split. Includes the source pane and each newly created pane.
paneLabel      integer|null  Visible pane label for that pane, or null while pending.
```

**Errors:** `not_connected`, `screen_not_found`, `invalid_operation`

---

#### `surf_ace_realize_topology`

Submit a desired root layout or pane subtree as one client-serialized topology intent operation. Write.

**Params:**
```
fingerprint               string   Target screen
target                    object   `{ root: true }` for the whole layout, or `{ paneId }` to replace one pane slot
expectedTopologyRevision  integer  Revision token from the latest `surf_ace_list`
allowDestroyPaneIds       array    Existing internal pane ids this call may destroy; use [] for non-destructive changes
desired                   object   Recursive desired subtree
```

**Desired subtree shape:**
```
split node: { "type": "split", "direction": "horizontal" | "vertical", "children": [...], "weight"?: number }
pane node:  { "type": "pane", "paneId"?: paneId, "name"?: string | null, "weight"?: number }
```

`weight` is an optional positive relative size within the parent split. User-driven client resizing emits `event.topology_changed` with the current weighted layout and bumped `topologyRevision`; providers adopt that visible layout so subsequent `surf_ace_list` output reports the reconciled pane geometry.

**Behavior:** The controller submits intent with `expectedTopologyRevision`; the client verifies the revision at execution time, validates omitted-pane destruction intent and CAP bounds, allocates any new internal pane IDs, and commits one atomic topology result. Registry labels may remain pending. Existing identity is preserved only for desired leaves that keep an existing stable `paneId`, plus the non-root shorthand where `{ target: { paneId }, desired: { type: "pane" } }` preserves that target pane.

**Returns:** `ok`, `target`, `topologyRevision`, current `topology`, current `panes`, `preservedPaneIds`, `createdPaneIds`, and `destroyedPaneIds`.

**Errors:** `not_connected`, `screen_not_found`, `invalid_operation`

---

#### `surf_ace_realize_topologies`

Realize desired pane topology changes and top-level Surf Ace Spatial surface-window lifecycle mutations across one or more Surf Ace surfaces/windows in one OpenClaw-facing operation. Write.

**Params:**
```
operations                array    One or more per-surface topology operations
```

Pane topology operations have the same required fields as `surf_ace_realize_topology`:
```
fingerprint               string   Target screen
windowLabel               string?  Optional current window label guard from `surf_ace_list`
operationId               string?  Optional caller id echoed in results
target                    object   `{ root: true }` for the whole layout, or `{ paneId }` to replace one pane slot
expectedTopologyRevision  integer  Revision token from the latest `surf_ace_list`
allowDestroyPaneIds       array    Existing internal pane ids this call may destroy; use [] for non-destructive changes
desired                   object   Recursive desired subtree
```

Top-level Spatial surface-window lifecycle operations use this shape:
```
fingerprint               string   Source/target screen from `surf_ace_list`
action                    enum     "openWindow" | "closeWindow"
windowLabel               string?  Optional current window label guard from `surf_ace_list`
operationId               string?  Optional caller id echoed in results
requestedBy               string?  Optional diagnostic caller label
```

**Behavior:** The controller submits pane/lifecycle intent through the same client-owned revision seams as `surf_ace_realize_topology`. For `openWindow` and `closeWindow`, the controller supplies the current endpoint/surface revisions; the client performs identity-independent open or close under §4.7 (recoverable in 0.2.10-rc1, final under §4.7.1 later). Content pushes remain pane-scoped.

**Partial failure semantics:** The provider reports unambiguous partial state. If every operation applies, the result is `{ ok: true, applied: [...] }`. If an operation fails, the result is `{ ok: false, applied, failed, skipped }`, where `applied` lists earlier operations that already committed, `failed` identifies the failed operation by index/fingerprint/windowLabel/operationId/code/message, and `skipped` lists later operations not attempted. This is not transactional across devices; callers must inspect `ok` before assuming every surface changed.

**Returns per applied pane topology operation:** `fingerprint`, `windowLabel`, `operationId?`, `target`, `topologyRevision`, current `topology`, current `panes`, `preservedPaneIds`, `createdPaneIds`, and `destroyedPaneIds`.

**Returns per applied window lifecycle operation:** `fingerprint`, `windowLabel`, `operationId?`, `action`, plus `accepted/openedSurfaceId?` for `openWindow` or `closed` for `closeWindow`.

**Errors:** `invalid_operation` for malformed empty operation lists before any per-surface apply. Per-surface failures are returned in the structured `failed` result.

---

#### `surf_ace_close_pane`

Close an existing pane and remove it from the current layout. Write.

**Params:**
```
fingerprint    string   Target screen
paneId         integer  Required pane to close.
```

**Returns:**
```
ok             bool     Always true on success.
paneId         integer  Closed pane's internal id.
paneLabel      integer|null  Closed pane's visible label at the moment it was closed, or null if pending.
```

**Errors:** `not_connected`, `screen_not_found`, `invalid_operation`

---

#### `surf_ace_read`

Read current cached content, dual-channel annotation state, registers, and structured loss from the bounded local projection for a pane. Read-only and local—no synchronous network call to the surface. `surf_ace_read` is pane-scoped at the OpenClaw boundary; the client decides which pane-history entry is visible and remains authoritative for records/cursors/gaps.

Response includes:
1. **Current content snapshot** (when locally cached),
2. **Live dirty channel** (if a frame is currently open/active),
3. **Closed frame queue batch** (up to 5 and within ~4 MB image budget),
4. **Structured non-annotation registers** (consumed on read).

In one durable local transaction, returned frames/registers are consumed from the projection, projected cursor/live dirty markers advance, local alert presentation resets, and an idempotent acknowledgement intent enters the durable outbox. Client truth changes only after client acknowledgement acceptance; OpenClaw may deliver it in the background, while the standalone CLI delivers it during the next explicit networked invocation for every caller.

**Params:**
```
fingerprint    string   Target screen
paneId         integer  Required.
```

**Returns:**
```
fingerprint       string
paneId            integer  Effective pane read by the provider
paneLabel         integer|null  Visible label for the pane returned by the provider, or null if pending

// Local current content readback
contentSnapshot   object?  Current cached pane content, or null if none is locally cached.
	                           {
	                             cachedAt      epochMs
	                             content?      object|string
	                             contentId     string?
	                             contentType   string?
                             revision      int
                             viewport      object
                             image?        string
                             drawings?     array
                             selection     object?
                           }

// Channel A: live dirty (newest / active context)
liveFrame         object?  Current mutable context frame, or null if no active frame.
                           {
                             frameId        string
                             contextKey     string
                             contentId      string
                             url?           string
                             scrollOffset   { x, y }
                             viewport       { width, height, scale }
                             openedAt       epochMs
                             updatedAt      epochMs
                             image          string      Base64 PNG captured at frame open
                             strokes: [{
                               strokeId     string
                               points       [{ x, y, pressure? }]
                               bbox         { x, y, width, height }
                               startedAt    epochMs
                               endedAt      epochMs
                             }]
                           }
liveDirtyStrokeIds array?  Stroke IDs appended since previous surf_ace_read (for incremental reaction).
liveSeq           int?     Monotonic live update sequence for this frame.

// Channel B: closed frame queue (FIFO; oldest-first)
frames            array    Finalized closed frames, up to 5 and within ~4 MB combined image budget.
                           Each frame has the same shape as liveFrame.
pendingFrames     int?     Remaining closed frames still queued beyond this batch.

// Consumed registers (cleared after this read)
taps              array    Ordered point-out tap events since last read.
                           Each: { eventId, timestamp, x, y, kind, nearestText?, elementRole? }
                           kind: "tap" | "long_press" (from wire TapEvent.kind).
                           OpenClaw-layer mapping: wire `nearestContent` → `nearestText`; `elementRole` =
                           provider-computed ARIA role of tapped element; `timestamp` from wire sentAt.
scrollPosition    object?  Latest settled scroll state: { x, y, visibleRect }. null if no scroll event since last read.
selection         object?  Latest selection: { selectedText, bounds, anchorStart?, anchorEnd? }. null if none.
                           OpenClaw-layer mapping: wire `text` → `selectedText`; wire `boundingRect` → `bounds`;
                           `kind` is implicit as text in this OpenClaw-layer shape. v1 providers preserve wire
                           `kind:"text"` selections and discard `kind:"point"`/`kind:"region"` unless explicitly
                           feature-negotiated (see §7.1 and §13.2). `anchorStart`/`anchorEnd` are provider-computed
                           DOM offsets when available (commonly HTML); otherwise null.
page              object?  Latest page state: { pageNumber, pageCount, pageLabel? }. null if not applicable.
playbackPosition  number?  Video only. null for all other content types.
playbackState     string?  Video only: "playing" | "paused" | "ended". null for all other content types.
lastNavigation    object?  HTML only: { url, navigatedAt } of most recent navigation, or null. Consumed on read.

// Projection/client health
consumableLoss    object?  Structured sticky client-authored loss/gap projected for this controller and scope.
cacheStatus       string   "current" | "stale" | "repairing"; stale data remains local and schedules background repair.
readAt            epochMs

```

**Read priority + dedupe contract:**
- OpenClaw should use `contentSnapshot` for current content readback after pushes.
- OpenClaw should interpret `liveFrame` first when present (newest/live).
- OpenClaw should process `frames[]` oldest-first for guaranteed context-preserved delivery.
- If new live dirty data appears while processing backlog, OpenClaw should pause backlog and return to live.
- Closed frames should still be processed even when some strokes were already seen live (frame image/context is authoritative).
- A stroke may appear in both channels; dedupe by `strokeId` per `frameId`/`contextKey`.

**Errors:** `screen_not_found`

`surf_ace_read` may be called regardless of connection state. It never synchronously repairs the cache; an unsynchronized projection returns explicit `cacheStatus` with available data and schedules background repair.

**Delivery notes:**
- Callers should inspect `liveFrame`/`liveDirtyStrokeIds` for near-real-time response while annotation is active.
- Dedup is required when consuming both channels: use `strokeId`.
- No new mandatory read tool was introduced; `surf_ace_read_buffer` remains deprecated.

---

#### `surf_ace_capture_pane`

Capture the actual rendered contents of one explicit Surf Ace pane. Read.

This tool is the visual topology oracle for soaks and operator checks: push a unique marker, capture the exact `fingerprint` + `paneId`, and compare the returned image and metadata against provider topology. The tool must not infer a pane from a surface-wide request or from visible labels alone.

**Params:**
```
fingerprint    string   Window-scoped Surf Ace surface identity
paneId         string   Required opaque pane id from `surf_ace_list`
```

**Returns:**
```
capture: {
  bytesBase64       string?  Base64 PNG bytes, null when blocked/unavailable
  fingerprint       string
  windowLabel       string|null
  paneId            string
  paneLabel         integer|null
  topologyRevision  integer
  visibleContentId  string?
  contentType       string?
  dimensions        { width, height }
  scale             number
  capturedAt        epochMs
  failureReason     string?
}
```

The image must come from the client-side rendered pane capture path, not from cached provider content state.

**Errors:** `screen_not_found`, `not_connected`

---

#### `surf_ace_read_buffer` (Deprecated)

This tool is deprecated and removed in the capture frame model. Frame images are now included directly in each capture frame returned by `surf_ace_read`. Do not use this tool in new code. It is documented here only for historical reference.

---

#### `surf_ace_annotations_remove`

Remove specific annotation strokes from a screen's drawing overlay by stroke ID. Write.

**Note (dual-channel frame model):** In the dual-channel model, rendered strokes persist until the provider explicitly removes them or content changes under the normal content rules. The underlying context frame remains open on same-context re-entry only until `event.annotation_committed` is emitted (§13.2). Closed frames in the queue are immutable records and cannot be modified via this tool. `surf_ace_annotations_remove` only affects strokes currently rendered in the live annotation overlay. For most OpenClaw workflows, this tool is used to remove strokes from in-progress interaction (e.g., erasing a scratch-out gesture mid-session). Post-finalization frame handling is done at OpenClaw interpretation time (dedupe/ignore/act), not by mutating closed frames.

**Params:**
```
fingerprint    string     Target screen
paneId         integer  Required.
contentId      string     Must match the currently active content
strokeIds      string[]   Stroke IDs to remove
```

**Returns:**
```
fingerprint            string
paneId                 integer
removedStrokeIds       string[]
notFoundStrokeIds      string[]
remainingStrokeCount   int
```

**Errors:** `not_connected`, `screen_not_found`, `stale_content`

---

### 14.4 Alert Routing

When unread annotation activity first appears (live dirty update and/or closed frame queue growth), the provider fires one Clawline alert if none has fired for the current unread burst. Alerts route to `agent:main:main` by default. This is opaque to OpenClaw — there is no tool to configure routing.

### 14.5 Tool Error Codes

| Code | Meaning |
|---|---|
| `screen_not_found` | Fingerprint is unknown to provider |
| `not_connected` | Screen is known but not currently connected (`connecting` or `unreachable`) |
| `content_too_large` | Content payload exceeds screen's size limit |
| `unsupported_content_type` | Screen does not support the requested content type |
| `render_failed` | Screen accepted the content but could not render it |
| `stale_content` | `contentId` param does not match currently active content |
| `internal_error` | Unhandled provider or surface error |

### 14.6 Extension Skills and Instruction Channels

Surf Ace implementation is not complete unless extension skills are present at these provider paths. Static Surf Ace guidance MUST NOT be injected by the extension through per-turn prompt-build hooks.

**Required skill files:**
- `extensions/surf-ace/skills/surf-ace-ops/SKILL.md`
- `extensions/surf-ace/skills/surf-ace-markup/SKILL.md`

**Allowed instruction channels:**
- Contributed extension skills.
- An explicitly contributed system prompt, if the host supports one.

The extension MUST NOT use `before_prompt_build`, `prependContext`, or `prependSystemContext` to attach static Surf Ace instructions. Annotation intent delivery remains a separate event-driven workflow: it may create a concrete follow-up turn for a settled annotation frame and image attachment, but it is not a static guidance channel.

Standalone-provider note: Surf Ace MAY run as a standalone extension without Clawline coupling, provided it implements gateway wake/routing plumbing comparable to existing channel extensions (for example, Discord-style wake + route behavior) rather than relying on Clawline-specific internal helpers.

## 15. Surface UI Design

**Companion flow artifact (non-normative):** `docs/design/surf-ace-ui-flows.html` (Figma-style state-flow visualization for review discussion).

This section is **normative**. Surface implementations MUST conform to the requirements described here. This section does not specify pixel sizes, exact colors, fonts, or precise layout coordinates — those are implementation details left to each platform. It specifies what must be shown and the behavioral rules governing each UI element.

---

### 15.1 Persistent Indicators

Surface implementations MUST always display the following identifiers. Labels MUST NOT be hidden based on pointer movement, touch interaction, hover state, content type, connection state, or annotation mode.

Surf Ace chrome text, including identity overlays, button labels, toast labels, and navigation/control pill text, MUST use bundled Rajdhani assets on Electron and iOS. Implementations MUST NOT depend on network font loading at runtime. The bundled font is distributed under the SIL Open Font License 1.1 and the OFL text MUST be included with app/package assets.

#### Window and pane identity overlay

Each window is assigned a short alphabetic identifier using an auto-incrementing sequence: `a`, `b`, `c` … `z`, `aa`, `ab`, … This label MUST be:
- Displayed immediately before the pane label inside each pane identity overlay as uppercase text inside the outline box. Do not render literal square brackets; `[a]12` is only protocol shorthand for an outlined `A` box followed by `12`.
- Rendered in Rajdhani Regular.
- Rendered as a rounded-rectangle outline box with no filled background. The box height is 1/2.5 (0.4x) of the pane-number height.
- Text is sized large within that fixed outline box, approximately 0.28x the pane-number height; implementations MUST NOT increase the box height to enlarge the text.
- The gap between the window box and pane number, and the window-box horizontal padding/tracking, must be tight so the two parts read as one compact identity mark.
- Bottom-aligned with the pane-number text using font metrics or baseline alignment, not manual visual offsets, so the box bottom edge and pane-number baseline / bottom visual line read as one clean baseline.
- Colored according to the window's connection state, with both outline and letters at 35% opacity.
- Rendered in the overlay layer — it does not scroll with content.

The window label is the primary visible addressing handle within the current `surf_ace_list` result. It MUST be visible when the surface is at rest so that a user can tell OpenClaw "move content to window b" without ambiguity, but OpenClaw/provider targeting authority still comes from the run-admitted `surfaceId`/`paneId` tuple rather than from the label alone.

Each pane obtains a visible numeric `paneLabel` from the fleet registry, distinct from its client-assigned internal `paneId`. Every current allocation has a fleet-unique number; a released number may later identify a different pane, while existing panes retain their assigned number. Safe release and generation rules are in §3.1.1.1. When allocator confirmation is unavailable the pane shows no number. `paneLabel` is an ephemeral user-facing coordinate and live-topology secondary key within the authoritative live projection; it is not pane identity or durable target authority. Historical references must use stable identity and allocation generation, and a number-only historical reference is ambiguous after reuse. Controllers adopt the registry-assigned label. Optional pane names do not replace it. When present, the pane label MUST be:
- Displayed as plain overlay text with no pill, background, or border.
- Displayed in the bottom-right of the pane content area, very bold, with height equal to 1/4 of the pane's shortest dimension. Electron and iOS MUST both derive this from the resolved pane rectangle, not from total window height or width.
- Rendered in Rajdhani Bold, with visually consistent heavy weight across Electron and iOS.
- Rendered with tight digit spacing; implementations SHOULD use negative Rajdhani tracking/letter-spacing of about `-0.04em`.
- Colored 50% gray at 30% opacity.
- Rendered separately from the pane control cluster. The pane label MUST NOT appear as a toolbar/control-cluster button or label unless a future explicit control need is specified separately.

The combined identity overlay is always visible and MUST be reported as an overlay region / hit-region where the platform reports chrome regions. That reported region MUST bound the visible identity glyphs/chrome (window-ID outline and pane-label text) rather than an invisible layout wrapper.

#### All platforms

- **Finger/stylus button (👆):** A single drawing-input button MUST be present in the pane control bar at all times, including when annotation mode is inactive. Tapping it enables finger/stylus input as a drawing tool — entering annotation mode if not already active, or toggling finger draw on/off within an active pencil session.
- **Apple Pencil (pencil platforms only):** Pencil contact with the screen MUST automatically enter annotation mode. No button tap is required.
- **Done button:** While annotation mode is active, a **Done** button MUST be visible in the annotation pill. Tapping it exits annotation mode. No other gesture is required to exit.

#### Annotation mode visual state (all platforms)

When annotation mode is active, the pane MUST render a 2px accent border as the sole visual indicator. No badge, label, or additional chrome is added. Pane labels MUST remain visible. The navigation pill remains governed by history/content state; annotation controls stay in the separate annotation pill.

#### Keyboard focus visual state (all platforms)


On iOS and iPadOS, the keyboard focus outline MUST be suppressed when a surface has only one pane. It is shown only when the surface has multiple panes and focus disambiguation is needed. This iOS single-pane suppression does not change pane routing, `activeKeyboardPaneId`, or explicit `paneId` targeting.
When keyboard focus is assigned to a pane, that pane MUST render a visible mid-gray focus outline or equivalent affordance at 25% opacity. The outline MUST remain legible on both white and dark-ish content backgrounds; pale white, pale blue, or otherwise low-contrast outlines are not sufficient. This affordance is separate from the pane label and from annotation mode; it MUST NOT change the pane's visible `paneLabel` or add a pane-number control to the toolbar.

#### Behavioral constraints while in annotation mode (all platforms)

These constraints are normative (duplicated here from §15.6 "While IN annotation mode" for completeness):
- Scroll is disabled. The viewport is locked.
- Link following is disabled. Taps do not navigate.
- The drawing layer captures all touch and stylus input.

---

### 15.2 Accessibility

Surface chrome defaults MUST satisfy the following accessibility requirements:
- All chrome controls MUST provide a minimum 44x44 touch target.
- All chrome labels and controls MUST meet WCAG AA contrast.

Electron keyboard defaults:
- `A` enters annotation mode.
- `D` exits annotation mode via Done.
- `Cmd-[` navigates Back.
- `Cmd-]` navigates Forward.
- `Cmd-H/J/K/L` scrolls the keyboard-focused pane left/down/up/right by one 64px line increment while annotation mode is inactive.
- Arrow keys scroll the keyboard-focused pane left/down/up/right by one 64px line increment while annotation mode is inactive.
- `PageUp` and `PageDown` scroll the keyboard-focused pane by one 85%-viewport page increment while annotation mode is inactive.
- `Cmd-Option-Shift-H/J/K/L` moves keyboard focus to the nearest pane left/down/up/right.
- On non-macOS platforms, ``Cmd-` `` cycles focus to the next Surf Ace window. macOS keeps ``Cmd-` `` platform-owned.

---

### 15.3 Pane Header Controls and Affordances

Pane controls float above content rather than occupying a fixed header bar. The pane itself is chrome-free — content fills the entire pane area.

Required defaults:
- Pane label is displayed as a large floating translucent overlay in the bottom-right of the pane (see §15.1 for visibility rules).
- On iOS and iPadOS, the bottom-right identity mark's pane-number text baseline and window-ID box bottom MUST share the same calculated bottom inset reference line as the bottom edge of the navigation and annotation toolbar pills. The pane-number text moves to the fixed screen/window-ID box reference, not the reverse, and the toolbar Y position is not changed to compensate for identity placement.
- Pane labels are not controls. The user-facing pane id is the floating pane label.
- Bottom controls are two side-by-side floating pills at the bottom-center of each pane.
- The left navigation pill appears only when pushed content/history exists. It contains Back, Forward, and the entry-bound composite provenance for the currently visible pane-history entry. Back/Forward navigation MUST update the composite from the newly visible entry.
- Composite provenance resolves trimmed entry-bound friendly-chat and provider/product values with localized `Unknown chat` / `Unknown provider` fallbacks and renders `{chat} — {provider}`. At or above measured `… — …` width both components remain with deterministic independent end truncation; between one-ellipsis and composite width it renders exactly `…`; below one-ellipsis width it occupies zero visual width. It never wraps or removes Back/Forward.
- The provenance label is non-interactive. Its full localized accessible name is “Pushed by {chat}, using {provider}”; navigation announces the full provenance reached. User labels are bidi-isolated, displayed verbatim after trimming, and not translated.
- Back/Forward controls appear only when history exists in that direction; hidden otherwise.
- The right annotation pill contains annotation controls only: 👆 and, while annotation mode is active, Done. It MUST NOT contain the pane label or window label.
- 👆 (drawing input) button is always present in the annotation pill.
- On iOS and iPadOS, the navigation and annotation pills MUST use native Liquid Glass-style capsule material/chrome for their background and border. Electron keeps its platform-specific pill styling.
- Multiple panes in a window share a background; pane boundaries are indicated by a center divider only. Keyboard focus may add the visible focus affordance from §15.1, but it does not create a default target for OpenClaw routing and does not replace explicit `paneId` targeting.

#### Pane pop-out within its surface window

Authorized by Mike's pane pop-out ruling. On supported iOS/iPadOS and Electron surfaces, each pane MUST have a toolbar toggle that expands that pane into a large, visibly bordered and inset overlay within the same surface window. The selected pane's same toggle MUST remain visible and operable in the overlay, identify the Restore action, and return it to its originating tile. This control is separate from the annotation-only pill, the navigation pill, and the bottom-right pane/window identity mark. Its touch target, contrast, accessible name and expanded/restored state MUST satisfy §15.2. Keyboard and assistive-technology focus MUST reach Restore; overlay input MUST go to the selected pane rather than click through to covered siblings.

At most one pane per surface window may be popped out; separate windows have independent presentation state. Pop-out and Restore are local, temporary presentation changes. They MUST NOT create a window or pane, allocate a number, change the split tree, sibling order or relative weights, emit a topology change, or persist a layout mutation. The original tiled layout remains mounted. The selected pane MUST retain its existing live content host, session, history and identity throughout both transitions, without a content reload or host recreation; covered sibling panes also remain live. A restart MAY discard the temporary pop-out state while restoring durable panes and content normally.

The overlay MUST retain a visible border, useful inset and reachable Restore control across supported surface sizes and rotation. Resizing or rotating the surface MUST derive overlay geometry from current window bounds; Restore MUST use the current split layout and its relative weights, not saved pixel coordinates. An independently authorized close of the selected pane or replacement of its topology MUST clear pop-out and reconcile with the new authoritative tree; Restore MUST NOT replay an old tree or resurrect a closed pane. Ordinary content updates continue in the selected pane while it is expanded. Tests MUST cover nested horizontal and vertical splits with unequal weights, repeated toggles, resize/rotation, input and accessibility focus, a reload-detecting live content session, sibling continuity, no toggle-induced topology/event change, and independent pane close or topology replacement.

#### Icon assets

- **iOS / iPadOS / macOS (native):** All control icons MUST use SF Symbols. Recommended mappings: Back → `chevron.backward`, Forward → `chevron.forward`, 👆 drawing input → `hand.draw`, Done → plain text label "Done" (no symbol needed).
- **Electron:** Control icons MUST use locally bundled Lucide SVG iconography; SF Symbols are not available on non-Apple platforms, and runtime network icon loading is forbidden.

History controls default behavior:
- Disabled Back/Forward controls render at 40% opacity.
- Disabled Back/Forward controls do not show hover affordances.
- v1 does not show history depth counters.

---

### 15.4 Degraded and Empty States

Default user-visible handling for degraded or unavailable states:
- Overlay restore failure shows a non-blocking toast plus a warning icon in the bottom controls.
- Blocked navigation or blocked content replacement during annotation mode shows a small toast: `"Finish annotation (Done) to navigate"`.
- Unsupported content renders a centered empty-state message.
- The initial no-content/ready state MUST NOT render a centered "Surface Ready" or similar empty-screen indicator; the pane may show its normal idle background plus the always-visible identity overlay and controls.
- Reconnect/resume state is shown via the window ID outline/text color in the identity overlay (see §15.7).

---

### 15.5 Drawing Flush In-Flight Indicator

See also §7.4, which defines the flush send timing requirements.

While a `drawing_flush` event is in-flight, the pane's annotation mode border MUST pulse. The pulse is a brightness/opacity oscillation on the existing 2px annotation accent border — it does not change color or add new chrome. The pulse starts when transmission begins and stops when transmission completes (success or terminal failure).

Required behavior (normative, cross-referenced from §7.4):
1. Indicator becomes visible when `event.drawing_flush` transmission starts.
2. Indicator remains visible while the transmission is in-flight.
3. Indicator hides immediately when transmission completes (success or terminal failure).
4. The indicator is shown only during active flush transmissions — not during idle or non-drawing states.

---

### 15.6 Content Area Behavior

#### General

Content MUST fill the pane. The surface renders content at native resolution. The content area is the full pane minus any chrome elements (pane label, history navigation controls).

#### While NOT in annotation mode

All of the following MUST be enabled, subject to what each content type supports:
- **Scroll**: user can scroll through content that extends beyond the viewport.
- **Link following**: taps on links navigate to the linked resource.
- **Text selection**: user can select and copy text where the content type supports it.

#### While IN annotation mode

All of the following MUST be enforced:
- **Scroll disabled**: the viewport is locked in place.
- **Link following disabled**: taps do not navigate.
- **Drawing layer active**: the drawing layer captures all touch and stylus input. Normal content interaction is suspended.
- **Pane visibility locked**: pane content replacement and user navigation are blocked until the user taps **Done**.
- **Blocked attempt feedback**: if navigation or content replacement is attempted while annotation mode is active, the surface shows a small toast: `"Finish annotation (Done) to navigate"`.

These constraints are synchronized with annotation mode state and are lifted only after the user taps **Done**. After **Done**, any user navigation or agent-driven content update is a normal context switch and follows the same pane-history rules as any other content change.

---

### 15.7 Connection State Indicator

Connection state MUST be expressed through the window ID outline/text in the bottom-right identity overlay. The app MUST NOT render a separate full-width bottom connection bar or strip, page-covering banner, repeated modal, or rapidly flickering status. When registration, synchronization, direct endpoint, or persistence used by the surface is degraded, a compact adjacent accessible affordance MUST show the capability-specific limitation without obscuring content; full diagnostic detail appears only on deliberate inspection. It MUST distinguish usable display from those shared-service limitations, honestly show pending/unsaved work, and clear the recovered limitation automatically. While the window letter or pane number is unconfirmed, the same bottom-right identity area MUST show a small pending-label indication without a fabricated coordinate. A neutral placeholder window outline anchors connection color and status if no letter exists yet.

**States and colors (Clawline design system tokens):**

| State | Color token | Hex | Behavior |
|---|---|---|---|
| Connected | `--ok` | `#22c55e` | Window ID outline/text |
| Connecting / Reconnecting | `--warn` | `#f59e0b` | Window ID outline/text |
| Disconnected | `--destructive` | `#ef4444` | Window ID outline/text |

**Platform color references:**
- iOS/iPadOS/macOS native: map tokens to `Color.green` / `Color.yellow` / `Color.red` system colors, or use exact hex values above.
- Electron: use CSS custom properties (`--ok`, `--warn`, `--destructive`) from the Clawline design system.


## UI/UX Invariants Index

This section is a consolidated copy/reference index of existing UI/UX mentions elsewhere in the document; it does not supersede the original normative or contextual locations.

**Decision record (Mike, 2026-10-01):** fleet-wide pane-number allocation and always-visible window/pane identity are restored and remain normative. The audit's other reviewed changes remain as-is and authorized: annotation mode retains its current Done-only control; Windows remains unsupported; screenshot capture does not return visible text; app-window open/close remains Spatial-only for now; internal pane IDs remain per-surface; OpenClaw-era items retain their current scope; label opacity and the single-pane iOS focus outline remain cosmetic/current behavior; and the larger history, lockless, and controller redesigns remain unchanged. None of those kept items is restored or broadened by this ruling.

Every named invariant in this index, including later single-invariant index entries, MUST have a build-failing conformance check in the release-gated Electron or Apple-native test suites; a check of Apple-native client behavior runs for both iOS/iPadOS and visionOS. `scripts/release/release-tooling.test.mjs` verifies that the index and its test-coverage map stay in one-to-one agreement and that each mapped test is present in a suite executed by the release workflow.

- **Window Letter Labels** — "Window labels (a, b, c…) are allocated by the single fleet-wide label allocator and are unique across the entire fleet; a client that cannot obtain one displays no label." Source: §3.1.1 core invariant
- **Pane Name Authority** — "Pane names are optional extension-assigned metadata. They do not replace `paneLabel` as the visible identity token." Source: §3.1.1
- **Pane Label Authority** — "Pane numbers are durably allocated by the fleet registry and unique among current allocations; a number can be reused only after exact generation-fenced terminal retirement and release, while existing panes keep their number. Until allocator confirmation a pane displays no number and never substitutes a client-local guess." Source: §3.1.1 core invariant and §3.1.1.1
- **Prominent Surface Labels** — "Window label and pane label render together as an always-visible bottom-right identity overlay in each pane." Source: §3.1.1 / §15.1
- **Displayed Content Persistence** — "The surface renders content and keeps it displayed until OpenClaw explicitly changes it." Source: §1
- **Visible Back/Forward Behavior** — "The newly targeted content becomes front/visible immediately in that pane." Source: §6.1.1
- **History Navigation Controls** — "Previously visible content in that pane remains navigable through the surface's Back/Forward controls." Source: §6.1.1
- **Floating History Controls** — "Back/Forward controls appear in the left navigation pill when history exists." Source: §6.1.1 / §15.3
- **Disabled History Controls** — "Disabled Back/Forward controls SHOULD render at 40% opacity and SHOULD NOT show hover affordances." Source: §6.1.1 / §15.3
- **No History Counters** — "v1 SHOULD NOT display history depth counters." Source: §6.1.1 / §15.3
- **Degraded Restore Safety** — "The surface MUST still show that state's content payload when available, clear the overlay for safety." Source: §6.1.1
- **Restore Failure UI** — "The surface SHOULD show a non-blocking toast plus a warning icon in the bottom controls." Source: §6.1.1 / §15.4
- **Connection State Indicator** — "Connection state is expressed through the bottom-right window-ID outline/text color; capability-specific degraded status and pending-label indication are required adjacent to it without obscuring content, including before a letter is confirmed." Source: §4.5 / §15.7
- **Connected State UI** — "Connected — green window ID outline/text." Source: §4.5 / §15.7
- **Connecting State UI** — "Connecting / reconnecting — yellow window ID outline/text." Source: §4.5 / §15.7
- **Disconnected State UI** — "Disconnected — red window ID outline/text." Source: §4.5 / §15.7
- **Window Label Placement** — "Window label precedes pane number in the bottom-right identity overlay." Source: §15.1
- **Window Label Visibility** — "Always visible as the window box preceding each confirmed pane number; never hidden by pointer movement, touch interaction, hover, content, connection state, or annotation mode." Source: §15.1
- **Primary Addressing Handle** — "The window label is the primary addressing handle. It MUST be visible when the surface is at rest." Source: §15.1
- **Pane Label Placement** — "Large floating translucent overlay in the bottom-right of the pane content area." Source: §15.1
- **Pane Label Visibility** — "Every allocator-confirmed pane number is always visible as plain translucent bottom-right overlay text; it is never hidden by pointer movement, touch interaction, hover, content, connection state, or annotation mode. An unconfirmed pane shows no number." Source: §15.1
- **Pencil Auto Entry** — "Pencil contact with the screen MUST automatically enter annotation mode." Source: §15.1
- **Drawing Input Button (👆)** — "A single drawing-input button MUST be present in the pane control bar at all times." Source: §15.1
- **Done Exit Control** — "While annotation mode is active, a Done button MUST be visible in the annotation pill." Source: §15.1 / §15.3
- **Annotation Mode Visual State** — "When annotation mode is active, the pane MUST render a 2px accent border as the sole visual indicator." Source: §15.1
- **Two-Pill Control Rule** — "Navigation controls and current visible entry provenance live in the left navigation pill; annotation controls live in the right annotation pill." Source: §15.3
- **Keyboard Focus Affordance** — "Keyboard-focused panes MUST render a visible mid-gray focus outline or equivalent affordance, legible on both white and dark-ish content backgrounds. iOS/iPadOS suppresses this outline for single-pane surfaces." Source: §15.1
- **Explicit Pane Routing** — "Keyboard focus does not create a default target for OpenClaw routing and does not replace explicit `paneId` targeting." Source: §15.3
- **Accessibility Touch Targets** — "All chrome controls MUST provide a minimum 44x44 touch target." Source: §15.2
- **Accessibility Contrast** — "All chrome labels and controls MUST meet WCAG AA contrast." Source: §15.2
- **Electron Shortcut Defaults** — "`A` enters annotation mode, `D` exits annotation mode via Done, `Cmd-[` navigates Back, `Cmd-]` navigates Forward, `Cmd-H/J/K/L` and arrow keys scroll the keyboard-focused pane by a 64px line increment, `PageUp`/`PageDown` scroll by an 85%-viewport page increment, `Cmd-Option-Shift-H/J/K/L` moves keyboard focus by pane geometry, and non-macOS Command-backtick cycles Surf Ace windows." Source: §15.2
- **Unsupported Content Empty State** — "Unsupported content renders a centered empty-state message." Source: §15.4
- **Blocked Attempt Toast** — "Blocked navigation or blocked content replacement during annotation mode shows a small toast." Source: §15.4 / §15.6
- **Flush Indicator** — "While a `drawing_flush` is in-flight, the annotation mode border pulses." Source: §7.4 / §15.5
- **Flush Indicator Completion Rule** — "The pulse starts when transmission begins and stops when transmission completes (success or terminal failure)." Source: §7.4 / §15.5
- **Content Area Fill** — "Content MUST fill the pane." Source: §15.6
- **Normal Interaction Affordances** — "Scroll, link following, and text selection are enabled while not in annotation mode." Source: §15.6
- **Annotation Interaction Suspension** — "Normal content interaction is suspended." Source: §15.6
- **Annotation Visibility Lock** — "Pane content replacement and user navigation are blocked until the user taps Done." Source: §15.6
- **Post-Done Context Switch** — "After Done, any user navigation or agent-driven content update is a normal context switch." Source: §15.6
- **Native Overlay Visual Distinction Gap** — "There is no ... visual distinction protocol for those overlay marks." Source: §OT-1
- **Viewport Overlay Positioning (iOS)** — "Position the `PKCanvasView` as a fixed overlay over the scroll view's visible area." Source: §A.1
- **Viewport Overlay Positioning (Electron)** — "Position the annotation canvas element as a fixed overlay ... over the content frame." Source: §A.1
- **No Explicit Browsing Modes** — "The surface always behaves like a real browser." Source: §A.7
- **UI-Only Mode Distinction** — "This is the only surface-level mode distinction and it is UI-only." Source: §A.7
- **Canvas Presentation** — "The surface renders a blank or gridded background." Source: §A.9
- **Native Overlay Model Markup Goal** — "Model markups render visually on the surface alongside (but distinguishable from) user strokes." Source: §A.12
- **Future Interactive Affordances** — "widgets, buttons, state displays" may become part of a future native-overlay markup model. Source: §A.12

---

## Open Topics

This section is the authoritative list of unresolved design decisions. Items here MUST NOT be implemented against until explicitly resolved and removed from this list. When a topic is resolved, the decision moves into normative sections of the spec; it is not retained here.

### OT-1: Model-Side Markup (Provider-Originated Strokes)

**Problem:** v1 has no dedicated protocol for model-originated strokes in the native annotation overlay. OpenClaw can still present draw-capable experiences by pushing normal renderable content such as HTML with `<canvas>` or SVG, but there is no native-overlay stroke op, no capture exclusion mechanism for provider-originated overlay marks, and no visual distinction protocol for those overlay marks.

**Status:** Open. Not Phase 1 or Phase 2 scope. See Appendix A.12 for background.

### OT-2: Semantic Gesture Classification — CLOSED

**Decision:** No on-device semantic classification. The surface sends raw stroke geometry in the buffer. OpenClaw receives and interprets the geometry directly, using whatever approach it sees fit. No `semanticHints` field, no wire extension, no on-device model integration. Closed; will not be revisited.

---

## 16. Common Pane Geometry Architecture

Status: normative architecture amendment, 2026-04-27. Source spec: `<spec-root>/surf-ace/specs/common-geometry-architecture.md`.

Surf Ace has one resolved geometry truth per pane. Each pane produces a canonical resolved geometry snapshot; content viewport, controls, overlays, hit regions, target materialization, capture masks, debug visuals, and protocol-reported pane viewport MUST derive from that snapshot.

### 16.1 Canonical snapshot invariant

A pane geometry snapshot is a resolved fact, not a recipe. Topology, split direction, pane count, DOM measurements, SwiftUI view hierarchy, and safe-area inputs may participate in resolving the snapshot only at the geometry authority layer. Display rotation and physical scanout mode are below the Surf Ace boundary; Surf Ace consumes the already-normalized logical surface bounds. Downstream consumers MUST NOT reconstruct pane placement from those inputs.

Every cross-boundary geometry payload MUST include coordinate-space identity. Placement payloads that can be applied asynchronously MUST also carry pane identity and sufficient revision/generation identity to reject stale writes: pane id, pane instance/binding identity, topology epoch, surface/window epoch when available, and geometry revision or an explicitly documented equivalent.

### 16.2 Required snapshot projections

The following are projections of the same pane geometry snapshot:

- content/target viewport
- native/compositor host/update geometry
- Surf Ace pane controls and floating chrome
- overlay/hit regions sent to compositor or local input routing
- annotation/capture exclusion masks when applicable
- protocol `panes.list` / pane viewport metadata
- debug borders and diagnostic geometry

If a consumer needs a new rectangle, the geometry authority adds a named projection. The consumer does not recompute from topology, split direction, physical display dimensions, or renderer-local measurements.

### 16.3 Electron requirement

Electron surfaces have explicit geometry seams between renderer UI, Electron main, native/compositor hosting, overlay reporting, hit routing, and protocol reporting. Electron MUST treat the resolved pane snapshot as the only placement authority. Renderer DOM overlay measurements may provide semantic control presence, intrinsic size, and relative offsets, but they MUST NOT define the pane placement basis once native pane geometry exists. Compositor payloads consume `panes[].geometry` and `regions[].rect` as resolved rectangles; compositor MUST NOT infer pane layout from Surf Ace topology intent.

Compositor status `panes` are native hosted/materialized pane records, not Surf Ace topology panes. Surf Ace topology panes are reported by `pair.response`, `panes.list`, and OpenClaw-facing `surf_ace_list`. A compositor status with `panes=[]` or `overlay_regions=0` means no native materialized panes or overlay regions are currently installed; it does not imply that Surf Ace topology is empty.

portrait-display tall-logical-surface remains a required fixture: Surf Ace receives a logical surface of `2160x3840` and must treat it exactly like any other `2160x3840` monitor/window. Native panes, Surf Ace controls, overlay regions, and hit regions must align in that logical coordinate space. Surf Ace must not reason from display rotation or physical scanout shape.

### 16.4 Native Host Special Cases

Native hosted targets may be special-cased only inside Surf Ace's Electron-to-compositor implementation seam. The external controller `target.apply` contract remains pane-targeted for every target kind: callers provide target identity, controller/session correlation, and stable pane target, but never native pane rectangles, coordinate spaces, pane instance IDs, topology epochs, surface epochs, or geometry revisions. Direct compositor/native-pane success is not an alternate Surf Ace product path.

Allowed internal native-host special cases are:

- Host projection: `native_app` and `compositor_app` may require a compositor `native_pane.host` plan containing `x`, `y`, `width`, `height`, `coordinateSpace`, `paneInstanceId`, `topologyEpoch`, `surfaceEpoch`, and `geometryRevision`. The client must derive that plan from its resolved pane snapshot before calling the compositor. Controllers submit only pane-targeted intent and never host rectangles, compositor coordinate spaces, pane instance IDs, topology/surface epochs, geometry revisions, or materialization plans. The compositor realizes client-resolved geometry and remains non-authoritative for topology.
- Host geometry update: a topology mutation or split that preserves an existing native-hosted pane but changes its resolved rectangle may require a compositor `native_pane.update` plan containing the same internal geometry/provenance fields as host projection. This is necessary because native content cannot be repositioned by renderer layout alone. It remains internal because callers still submit ordinary pane-targeted topology/split operations and never provide native rectangles or compositor revision fields. Web/content parity is preserved because retained native panes keep their content across layout-only changes just as renderer/web panes do; only the internal host rectangle is updated.
- Compositor status/preflight: Electron may read compositor status fields such as logical surface size, pane-geometry coordinate space, and native materialized pane count before sending a host plan. This is necessary to verify that the internally projected rectangle is in the compositor's current logical space before native process I/O. It remains internal because `target.apply.result` may expose only opaque materialization status such as applied/not_applied/released_after_failure, never the host request, host response, raw preflight status, preflight summaries, or native geometry. Web/content parity is preserved because callers observe the same pane-targeted apply success/failure contract for native and renderer targets.
- Overlay and live-instance projection: Electron may keep `nativePaneInstances` and send compositor `overlay_regions.set`/`overlay_regions.clear` requests with live compositor pane instance ids and renderer-measured chrome rectangles. This is necessary because native-hosted content cannot be clipped or hit-routed by renderer DOM alone, while Surf Ace controls still need authoritative overlay exclusion and hit regions. It remains internal because providers/callers cannot name native pane instances or overlay regions through `target.apply`; renderer measurements are converted inside Electron after the pane has already been admitted. Web/content parity is preserved because Surf Ace labels, controls, and targetability remain attached to the same visible pane identity, and non-native panes ignore native overlay instance data.
- Release before renderer replacement or pane removal: replacing a native-hosted pane with renderer-owned content, navigating renderer history, clearing content, closing a pane, or applying topology that removes a native-hosted pane may require a compositor `native_pane.release` first. This is necessary to prevent stale native surfaces from covering renderer panes or surviving removed topology. It remains internal because callers still send the normal pane-targeted `browser_url`, `content.apply`, `content.set`, `content.clear`, history, pane-close, or topology operation; they do not manage native detach. Web/content parity is preserved because the requested pane operation becomes observable only after the native host is cleared, and release failure rejects or blocks the mutation rather than exposing native controls to provider code. Layout-only topology changes that retain the native pane must update host geometry rather than release native content.
- Hosting state: Electron may track whether the current visible entry is externally native-hosted so reload, history, snapshot, and release paths do not treat a compositor-hosted process as renderer HTML. This is necessary to avoid applying renderer-only operations to native content. It remains internal state or diagnostic status, not a provider geometry contract. Targetability remains the Surf Ace pane coordinate.

Any additional native special case must defend the same three properties: why native behavior is necessary, why the behavior stays behind the Surf Ace/compositor seam, and why pane-targeted API parity with web/content targets is preserved.

Verification for native-hosted targets must preserve that boundary. A passing implementation test may assert that Surf Ace projected a valid internal `native_pane.host` request, but a product/status gate must also exercise the official controller target flow and its OpenClaw-facing result. A direct compositor-hosted window, even when visible and correctly sized, is not Surf Ace materialization proof unless it is the consequence of a live client-accepted `target.apply` for the same admitted/actionable pane.

### 16.5 iOS requirement

iOS should preserve its cleaner visual seam: pane content and controls live in one SwiftUI pane layout context. That SwiftUI-resolved pane frame is the iOS geometry authority. Protocol reporting MUST consume the resolved pane geometry from that authority; it MUST NOT independently recompute pane rectangles from topology in a way that can drift from visible layout. Split spacing, safe area, scale, and scene/window changes must be represented consistently in the resolved snapshot and protocol viewport projection.

### 16.6 Failure modes forbidden by this architecture

The architecture forbids these classes of bugs:

- native content and Surf Ace chrome disagree about pane position
- renderer overlay rectangles move chrome independently of accepted pane geometry
- protocol viewport metadata differs from visible pane layout because it recomputes split math
- stale geometry applies after resize, split, close, scene recreation, or pane id reuse
- hit regions route input under Surf Ace controls because they were derived from a different revision
- debug/capture masks use a separate measurement path from the real applied geometry

Acceptance tests MUST cover Electron, iOS, and visionOS: one snapshot revision produces content viewport, controls/chrome, overlay/hit regions, materialization geometry, and protocol viewport for that pane.

## Appendix A. Design Rationale and Decision Notes

This appendix contains rationale context, background, and historical record for design decisions. **This appendix is not normative for unresolved items.** Open topics live in `## Open Topics` (the authoritative source); entries here are rationale and reference only. Resolved entries are historical record of decisions already encoded in normative sections above.

---

### A.1 Annotation Coordinate Space

**Question:** Do annotation strokes live in screen coordinates (where the pencil touched the glass) or content coordinates (position within the scrollable document)?

**Why it matters:** If screen coordinates, strokes made before and after scrolling are spatially disconnected and cannot be composed into a meaningful region. If content coordinates, strokes retain their document position across scroll and can be correctly bounded.

**Constraint:** This is a hard implementation decision on iOS — it determines how the PencilKit overlay is positioned relative to the scroll view.

**Decision: Viewport Coordinates**

Annotation stroke points and bounding boxes are stored in **viewport coordinates** — the coordinate space of the visible surface area at the time of capture. Coordinates are NOT content coordinates (they do not account for scroll position).

**Coordinate definition:**
- Origin `(0, 0)` is the top-left corner of the visible viewport at capture time.
- X increases to the right; Y increases downward.
- Units are logical surface points, matching `SurfaceViewport.width` × `height`. The scale factor (`SurfaceViewport.scale`) is NOT applied — coordinates are in points, not physical pixels.

**Coordinate space in the capture frame model:**

In the capture frame model (see §13.2), each closed frame contains a viewport screenshot and strokes in the same viewport-at-capture-time coordinate space. Because annotation mode locks the viewport (see §15.6 "While IN annotation mode"), there is no scroll movement between screenshot and strokes — they are spatially coherent by construction. The frame-level `scrollOffset` can be used to map strokes to content-space position when needed:

```
content_x = stroke_bbox.x + frame.scrollOffset.x
content_y = stroke_bbox.y + frame.scrollOffset.y
```

Note: `surf_ace_read_buffer` (the old composite buffer read tool) is deprecated and removed. Frame images are now included directly in each capture frame returned by `surf_ace_read`.

**Wire protocol — stroke coordinate space (unchanged):**

The wire `DrawingFlushEvent` continues to carry strokes in viewport coordinates. This is unchanged from the original v1 resolution. The surface-level implementation guidance below continues to apply:

**Implementation on iOS (PencilKit):**

Position the `PKCanvasView` as a **fixed overlay** over the scroll view's visible area — not inside the scroll view. PencilKit stroke coordinates are then naturally in viewport space and do not shift when the underlying content scrolls. The canvas does not scroll with the content.

**Implementation on Electron (canvas):**

Position the annotation canvas element as a fixed overlay (`position: fixed`, or `position: absolute` within a non-scrolling container) over the content frame. Canvas `(x, y)` coordinates are directly in viewport space.

**v2 upgrade path:**

In v2, the wire `DrawingFlushEvent` payload may optionally be extended with `scrollOffsetAtFirstStroke` / `scrollOffsetAtLastStroke` for surfaces that do not implement the annotation mode lock. In the capture frame model, this is unnecessary — the frame-level `scrollOffset` is authoritative.

**Capture frame model note:** The coordinate ambiguity question is fully resolved by the frame design. Each finalized frame contains both (a) a viewport screenshot taken at frame open and (b) all strokes accumulated into that frame — both in the same viewport-at-open coordinate space. Because the surface is scroll-locked during annotation mode (see §15.6 "While IN annotation mode"), viewport motion does not occur while drawing. Image and strokes are in the same coordinate space by construction, with zero translation required. `scrollOffset` at frame open can map to content space when needed. No per-stroke `scrollOffset` capture is required — frame-level `scrollOffset` is authoritative.

---

### A.2 Multi-Scroll Annotation Image Capture

**Question:** If a user annotates the top of a long webpage, scrolls down, and annotates the bottom — how does the provider produce a meaningful image for OpenClaw?

**Decision:** Multi-scroll behavior is handled by the dual-channel context model. Because annotation mode locks the viewport (see §15.6 "While IN annotation mode"), scrolling cannot occur while actively drawing. If a user annotates at scroll position A and re-enters the **same context before `event.annotation_committed` is emitted**, strokes append to the same context frame. Once the explicit commit is emitted, later same-context annotation starts a new frame; a true context switch also finalizes the previous frame and creates one for the new context when annotation starts there.

OpenClaw may therefore receive one evolving context frame for multiple same-context sessions before commit, or multiple finalized frames after commit or across distinct contexts. `scrollOffset` at frame open remains the reference anchor for mapping to document-space.

---

### A.3 Semantic Gesture Interpretation (Brackets Problem)

**Question:** When a user draws `[` at one position and `]` far below it, their intent is "everything between these brackets." Raw stroke geometry alone cannot convey this — the provider would only see two curved strokes with a large gap. How does the system convey the user's region intent to OpenClaw?

**Related:** Same problem applies to any multi-stroke semantic gesture where the intent spans content between the strokes rather than the strokes themselves.

**Status:** Partially addressed by the capture frame model — full resolution requires on-device gesture classification (A.4).

**With dual-channel context frames:** Bracket strokes and other multi-stroke semantic gestures can be accumulated into one finalized context frame across same-context annotation sessions only while the frame remains uncommitted. OpenClaw receives the frame stroke set plus viewport screenshot, reducing partial-geometry ambiguity.

However, geometry-based inference of the "between" region still requires understanding that the strokes form brackets and that the intent is spatial span between them. This is the unresolved part. On-device classification (A.4) applied per finalized frame remains the most promising path: the surface classifies gesture intent for the frame stroke set before (or at) finalization and includes a `semanticHints` field. Design deferred to v2.

---

### A.4 On-Device Model Integration (Apple Foundation Model)

**Question:** iOS devices with Apple Intelligence have an on-device foundation model available. Should the surface use it to classify stroke gestures (lasso, bracket, circle-for-emphasis, underline, cross-out, drawn box, etc.) before reporting to the provider?

**Why it matters:**
- OpenClaw receives classified intent rather than raw geometry — dramatically reduces ambiguity
- On-device inference is fast and private
- Resolves A.3 (bracket problem) and the point-out classification ambiguity
- Raises question of confidence threshold: what does the surface report when classification is uncertain?

**Related questions:**
- Does the surface report raw strokes + classification, or classification only?
- What is the fallback when on-device model is unavailable or below confidence threshold?
- Does classification happen per-stroke, per-flush, or after a settling window?

**With context-keyed frames:** On-device classification applies naturally **per finalized frame**. At frame finalization time (explicit `event.annotation_committed`, context-switch boundary, or explicit `content.set`/`content.clear` per A.8), the surface has the complete stroke set for that finalized unit. This is the ideal classification boundary: the model sees full gesture context before delivery. Classification at flush time (mid-session live deltas) would see partial stroke sets and is not recommended. A v2 `semanticHints` field in the frame structure is the right integration point.

**Status:** Unresolved. Needs design session. The dual-channel frame model provides the right unit of analysis — classify at frame finalization, not at live-delta flush time.

---

### A.5 Point-Out vs. Passive Annotation

**Question:** Is "point-out" (user explicitly directing OpenClaw's attention) a distinct surface behavior, or is it inferred by OpenClaw from existing event types?

**Context:** Two modes of surface use were identified:
1. *Point-out* — user highlights, boxes, or selects something, meaning "look at this specifically"
2. *Passive* — user scribbles, writes, thinks on-screen; OpenClaw observes without explicit direction

**Open sub-questions:**
- Does the surface classify which mode is active, or does OpenClaw infer it?
- Are point-out gestures a distinct register, or do they arrive as ordinary stroke/selection events?
- For text selections (OS-level), the selected text is cleanly available — OpenClaw may not need an image at all. For drawn boxes or lasso regions, an image crop is needed. Should these be unified under one "attention region" concept?

**Status:** Unresolved. Depends on A.4.

---

### A.6 Image Request Scope and Cropping

**Question:** When OpenClaw requests an image of a region, how is the region specified, and what exactly is composited?

**Partially resolved:**
- Images always include the annotation overlay rendered on top of content (never content-only or strokes-only)
- OpenClaw specifies a region of interest rather than always requesting full-screen
- Provider crops from locally cached render + live annotation layer

**Still open:**
- Is the region in screen coordinates or content coordinates? (Depends on A.1)
- How current must the locally cached render be? If the user has scrolled since the last cache update, the crop is wrong.
- Does the provider maintain a rendered image cache proactively, or only on demand?
- For "full screen" requests, is the image the current viewport or the full scrollable content?

**Status:** Partially resolved. Coordinate space is settled (viewport coordinates per A.1). In the capture frame model, each frame includes a viewport screenshot — OpenClaw receives the image directly in `surf_ace_read` without needing a separate buffer crop. The region-of-interest question is moot for closed frames (each frame image is already the viewport at capture time). For live/open frame inspection, every successful `snapshot.get` response includes the viewport screenshot; there is no image-inclusion request option.

---

### A.7 Surface Interaction Model: Modes vs. No Modes

**Question:** Does the surface have explicit interaction modes (e.g. "navigation mode" vs. "markup mode"), or is it always one unified thing?

**Design direction:** No explicit modes. The surface always behaves like a real browser. Full link following is supported — if OpenClaw pushes a website, the user should be able to use it as a website including hyperlinks. Pencil always draws annotations. Finger always does finger things: scroll, select text, tap elements, follow links. Point-out is not a mode — it is the natural byproduct of ordinary finger interactions (text selection, element tap) that happen to produce structured register entries.

**Implications:**
- Link navigation must be detected and reported as a content state change (URL change → navigation event → snapshot_hint)
- Annotations should be buffered per URL (or per content hash for non-URL content) so that navigating away and back restores annotations to their previous state
- The provider tracks which annotations belong to which URL; when the user returns to a URL, the annotation register is restored from that buffer
- The model observes URL changes via the content state register and can react or ignore

**Open sub-questions:**
- Should the surface suppress link navigation when OpenClaw-pushed content is active, with an opt-in flag to allow it? Or always allow it?
- How should annotation buffering handle URL fragments (#section) vs. full URL changes?
- What happens to annotations when OpenClaw calls `surf_ace_push` with new content — are they cleared or preserved?

**Decision:** On pencil-supported devices, pencil contact automatically enters annotation mode; fingers do normal operations (scroll, select, tap, follow links) by default. A single 👆 drawing-input button is always visible and, when tapped, adds finger drawing capability to annotation mode. On non-pencil platforms (Electron), that same 👆 button is the entry point for annotation mode and enables drawing input. This is the only surface-level mode distinction and it is UI-only; the wire protocol and register model do not change based on mode.

**UI defaults alignment:** Drawing controls live in the annotation pill. The Done control appears in that pill while annotation mode is active. Blocked navigation or blocked content replacement during annotation mode produces a small toast directing the user to finish annotation first.

**Data model:** The provider MUST store surface state in a context dictionary keyed by `contextKey`, where `contextKey` is:
- For OpenClaw-pushed content: the `contentId` (e.g. `ct_a1b2c3d4`)
- For user-navigated URLs (within an HTML push): the full URL string, normalized (fragment stripped, query preserved)
- For non-URL content (images, PDFs): the content hash or `contentId`

Each context record holds: `{ contentId?, url?, liveFrame?, liveDirtyStrokeIds?, closedFrameQueue, scrollPosition, selection, page, timestamps }`, where `timestamps` is `{ createdAt: EpochMs, lastActivityAt: EpochMs }` — `createdAt` is when the context record was first established (content pushed or first navigation), `lastActivityAt` is updated on every register write. Note: the old `annotations`/`drawBuffer` fields are replaced by dual annotation channels (`liveFrame` + `closedFrameQueue`).

In v1, `content.set`, `content.clear`, and `event.navigation` still enforce hard-clear behavior at the surface rendering layer, but provider buffer retention is split:
- interactive overlay state is cleared per protocol,
- unread closed frames and live-frame bookkeeping are retained until `surf_ace_read` consumes them.

Navigation to a new URL creates a new active context candidate, but context switch for frame finalization occurs only when annotation starts in that new context. Navigation alone does not create/finalize a frame.

In v2+, restore-on-revisit will require a new wire operation (e.g. `content.restore`) or a `preserveAnnotations` flag on `content.set`. This is a **protocol change**, not a provider-side policy switch: v1 content replacement still hard-clears the drawing overlay at the surface level, and the provider cannot suppress this behavior unilaterally. The context dictionary is the right data structure for v2; the wire op to activate it is a v2 design item.

**Implementation note:** Surface implementations should keep a context dictionary from day one. v1 already uses it for dual-channel buffering/finalization boundaries; v2 restore-on-revisit can layer on without storage rewrite.

**Status:** Resolved for v1. Restore policy deferred to v2 (A.7 phase). Current UI defaults are specified normatively in §15.

---

### A.8 Frame Lifecycle When Context Never Changes (Explicit Annotation Settlement)

**Decision:** Frame finalization uses an explicit surface signal, not a provider timeout heuristic. When the user exits annotation mode for a pane, the surface MUST emit `event.annotation_committed` after the final `event.drawing_flush` for that annotation session has been delivered. That event is the authoritative settlement boundary for same-context work.

Rules:
1. Live channel remains authoritative for in-context work-in-progress while annotation mode is active.
2. Closed-frame queue exists to preserve settled annotation sessions and older contexts until `surf_ace_read` consumes them.
3. Same-context re-entry before the explicit commit continues the existing live frame.
4. Once the prior session has been explicitly committed, same-context re-entry starts a new live frame.
5. Frame finalization occurs on one of:
   - explicit `event.annotation_committed` from the surface,
   - context switch (different URL/content context with annotation starting there),
   - explicit content replacement/clear (`content.set`/`content.clear`).
6. Timeout-based finalization is not product truth. If a provider keeps a timer temporarily for backward compatibility with older surfaces, it MUST be fallback-only and MUST NOT override an explicit settle signal.
7. Process interruption is not a settlement signal. If interruption occurs after completion intent is persisted but before the ordered final flush and explicit commit are durably evidenced, the client retains the recoverable frame with its identity, context, and strokes. It resumes or reconciles that boundary before creating a source-journal `frame_commit`; interruption alone is not source loss and does not create `source_gap`. Direct-path rendering and use remain available with truthful pending status if source completion cannot yet be proven. A proven direct boundary that has not yet reached the source journal may be published after restart with stable source identity; an already-persisted source record is retried byte-identically. Same-context re-entry before explicit commit remains in the same frame and is serialized so stale recovery cannot close newer strokes. This clarification follows Mike's October 1 explicit-commit/re-entry ruling and the product ruling on the crash window.

Transport note: `event.drawing_flush` cadence remains independent. Flush events carry live stroke deltas during annotation mode; `event.annotation_committed` closes the session.

Rationale: Annotation settlement is a surface-owned state transition ("Done"/annotation exit), not something the provider should guess from silence on the wire.

---

### A.9 Content Types — Coverage and Gaps

**Covered content types** and their fundamental character:
- `html` — scrollable, navigable, links, dynamic. The full browsing case. All open questions in A.1–A.7 center on this type.
- `pdf` — paginated, not URL-navigable. Annotations per page. Simpler than HTML.
- `image` — static. No scroll. Annotations stay put. Easiest case.
- `markdown` — rendered HTML, typically no links or interactivity. Simplified HTML.
- `terminal` — live text stream, content changes continuously. Annotations on moving targets are conceptually difficult. Lower priority.

**Added to spec (v1 reserved, v2 required):**

**Video** (`video`) — fundamentally temporal rather than spatial. Annotations carry an optional `videoTimestamp` field anchoring strokes to playback position. Two additional registers: `playbackPosition` and `playbackState`. The multi-scroll / bounding-box problems from A.2/A.3 have a temporal analog here — strokes made at different playback times may span content that is no longer visible. Full semantics deferred to v2. See the `video` characteristics in §6.1.1.

**Blank canvas** (`canvas`) — an optional content type where annotations are the primary artifact and there is no underlying document. The surface renders a blank or gridded background. `content.clear` removes all annotations (same global rule as all content types). In v1, OpenClaw observes user strokes via the existing register model (read-only for the native annotation layer). OpenClaw does not need this content type in order to present draw-capable experiences, because normal HTML/SVG content can already render its own `<canvas>` or similar drawing UI. Dedicated native-overlay annotation writes remain undefined in v1 and would require a future protocol extension. Useful for whiteboard-style collaboration. See the `canvas` characteristics in §6.1.1.

**Default empty/degraded presentation:** Unsupported content should use a centered empty-state message. Blank-canvas presentations may use a blank or gridded background.

**Everything else** (slides, word documents, maps) is a variant of HTML or PDF with cosmetic differences. No new model required.

**Status:** Both types added to the protocol (schema enum, content type characteristics in §6.1.1, video registers in 13.2). Implementations may return `unsupported_content_type` for these in v1. Full behavioral spec deferred to v2.

---

### A.10 Multi-Pane Surfaces (One Window, Multiple Independent Contexts)

Multi-pane support — splitting a single Surf Ace window into multiple panes, each with separate content and annotation context — is committed phase work. Implement before annotation-priority work (see §2.3 Delivery Phasing).

**Design direction:**
1. Keep multi-window model unchanged (`surfaceId` stays window identity).
2. Add pane identity inside a surface: internal `paneId` plus visible `paneLabel`.
3. Scope all mutable state by `contextScope = { surfaceId, paneId }`.
4. Even a single-pane surface uses the same internal `paneId` model plus visible `paneLabel` model as multi-pane layouts.
5. Pane-aware operations (split/resize/close/focus) are Phase 1 committed topology operations.
6. Read/write tools become pane-aware through explicit pane targeting:
   - `paneId` required on all pane-scoped calls
   - explicit pane target for `push/read/clear/annotations_remove`.

**Why this is safe:** This adds pane orchestration via explicit `paneId` targeting. OpenClaw always specifies which pane it is addressing. No ambiguity from fallback resolution.

---

### A.11 Future Extension — Multi-Pane Enhancements Beyond Phase 1

**Goal (v2+ enhancements):** Extend one-window multi-pane behavior with richer pane layout orchestration and lifecycle semantics beyond the Phase 1 committed baseline.

**Compatibility principle:** Model mutable state as `contextScope = { surfaceId, paneId }`. `paneId` is always required. OpenClaw must read surface state to know valid `paneId` values before targeting a pane.

**Expected v2+ shape:**
1. Advanced pane lifecycle/layout operations (nested split templates, persistent layout presets, pane groups).
2. Full read/write scoping by `{ surfaceId, paneId }` across all tools and schema operations.
3. Independent live dirty channel + closed-frame queue + register state per pane, with optional cross-pane coordination events.
4. Ordering/dedupe contracts remain unchanged per pane.

**Status:** Base multi-pane topology is Phase 1 committed work (§2.3). This subsection covers additional v2+ enhancements beyond Phase 1.


### A.12 Model-Side Markup and Point-Outs (Open Topic)

**Problem:** The current spec defines the native annotation overlay as user-generated (stylus/finger strokes). OpenClaw can already present draw-capable experiences by pushing normal renderable content such as HTML with `<canvas>` or SVG, but v1 has no dedicated provider-originated stroke/markup protocol for drawing into the native annotation layer itself.

**Proposed behavior:**
1. A future protocol extension could let the model send its own point-outs and markup strokes into the native annotation overlay via a dedicated tool (e.g. `surf_ace_annotate`).
2. Model markups are tracked separately from user annotations at the provider layer.
3. Model has full CRUD over its own markups: create, read, update, delete.
4. Model markups are intended to be excluded from capture frames / screenshot buffers (they are provider-originated, not user-originated, and must not pollute the surface-observation loop). Mechanism TBD — the v1 `Stroke` schema has no `source` field; wire protocol extension required before this invariant can be enforced.
5. Model markups render visually on the surface alongside (but distinguishable from) user strokes.

**Future extension (not v1):**
Dedicated native-overlay model markups may eventually become full interactive UI affordances — widgets, buttons, state displays — that can send user actions and state back to the model. This would make native overlay markup a bidirectional communication channel, not just visual output.

**Open questions:**
- Wire protocol: how are model-originated native-overlay markups delivered to the surface? As a new op type (`markup.set`) or another dedicated overlay primitive?
- Visual distinction: how does the surface render model strokes vs user strokes? Different color, opacity, or layer?
- Scope: are native-overlay model markups pane-scoped or surface-scoped?
- Capture exclusion: how does the frame capture mechanism know to exclude model-originated strokes?
- Interactive markup v2: what protocol extensions are needed for widget → model callbacks?

**Status:** Open. This is only about dedicated native-overlay annotation primitives; it does not block OpenClaw from presenting draw-capable HTML/SVG/canvas content in v1. Not part of Phase 1 or Phase 2 scope as currently defined.

### A.13 Multi-Session OpenClaw History Routing — Rationale Context

**Background:** Each admitted controller has its own WS connection in lockless mode, and multiple OpenClaw sessions may also route through one controller. The client-owned shared history model (§3.1.1, §6.1.1) preserves every accepted push as a distinct entry while guaranteeing exactly one visible entry per pane.

**Resolved policy summary:**
1. The newest `content.set` in a pane becomes visible immediately.
2. The displaced visible entry moves into the shared retained pool regardless of controller/session identity.
3. Back/Forward navigation changes visibility only; it does not rewrite entry-bound content, revision, provenance, annotations, or controller cursors.

**Related sections:** §3.1.1 (topology), §6.1.1 (pane lifecycle, history operations, and history routing rules), §13.2 (annotation buffering), §14.3 (`surf_ace_list` occupancy).

### 15.8 Entry-Bound Composite Provenance

At accepted push, the client snapshots the controller's friendly chat name and provider/product name into the new history entry. Connection metadata changes never rewrite an entry. The navigation pill displays the currently visible entry's localized `{chat} — {provider}` composite; connection identity, latest pusher, closer, restorer, and current chat are never substitutes.

**Layout:**
- The composite appears in the left navigation pill alongside Back and Forward.
- After trimming Unicode whitespace, absent components use localized `Unknown chat` and `Unknown provider`; the separator always remains in the composite width class.
- The client measures `compositeMinimumWidth` as `… — …` and `collapsedMinimumWidth` as `…` for the current locale/font/accessibility size. At/above the composite floor it preserves both independently end-truncated components with equal shares and unused-width reallocation; between floors it renders exactly `…`; below the collapsed floor it uses zero visual width.
- The composite never wraps, removes navigation controls, or becomes interactive.
- The top-centered window title pill is not part of the MVP chrome.

**Behavior:**
- Back/Forward navigation MUST update the visible composite and announce the full provenance reached.
- The full localized accessible name is “Pushed by {chat}, using {provider}” in every width class.
- User labels are displayed verbatim after trimming, protected with bidirectional isolation, and are not machine-translated.
- The composite persists during annotation mode whenever the navigation pill is otherwise visible.

**Protocol integration:**
- Lockless pair metadata supplies friendly-chat/provider-product display values as explanation only.
- Each accepted history append stores those values in the entry; disconnect or later metadata changes do not alter them.
- Neither component nor the composite is controller identity, cursor key, routing, authentication, permission, priority, quota, topology, or restore authority.

**Invariant index entry:**
- **Entry-Bound Composite Provenance** — "The left navigation pill shows the current visible history entry's localized friendly-chat — provider/product composite; Back/Forward updates it from the visible entry and never from connection authority." Source: §15.8
