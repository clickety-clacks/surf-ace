# Surf Ace Wire Protocol (WebSocket)

Status: Design draft
Depends on: `<spec-root>/clawline/specs/clawline-invariants.md`

## 1. Purpose and Goals

Surf Ace is a standalone display and annotation system that turns any screen running the Surf Ace app into an OpenClaw-managed surface. It is a purpose-built binary application — not embedded in another app — available on iOS/iPadOS and as an Electron app on macOS, Windows, and Linux.

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
4. All operations run over that socket: pair handshake, content push, clear, events, snapshots.
5. No callback URL; no explicit watch mode — event streaming is always on while connected.

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
1. A single window can be split into multiple panes, each with stable internal `paneId` and stable visible `paneLabel`.
2. Pane lifecycle exists: create/split, resize, rename, close.
3. All screen-scoped tool operations can target `{surfaceId, paneId}` after resolving human references through `surf_ace_list`.
4. **`paneId` is required** on all pane-scoped tool calls. OpenClaw MUST always specify which pane it is targeting once it has resolved the intended pane from `windowLabel` / `paneLabel`. There is no default-pane fallback.
5. `surfaces.list` enumerates active window surfaces for an endpoint; after pair/resume, `panes.list` and `surf_ace_list` expose pane topology and active content per pane.
6. Content operations are isolated per pane (push/clear in pane A does not mutate pane B).
7. Lockless-capable surfaces use concurrent controller admission and client-local authority. Ownership lock semantics remain only for explicitly negotiated legacy surfaces.
8. At least one iOS and one Electron implementation pass topology tests for pane isolation and routing.
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

Ownership: `extensions/surf-ace/` owns the Surf Ace provider runtime — mDNS discovery, WS connection management, local state buffers, and all `surf_ace_*` OpenClaw tools. The corresponding surface-side core module (if needed) lives in `src/surf-ace/`. Neither Clawline nor any other extension imports from these paths.

## 2a. Concepts

Before the protocol details, these terms are used consistently throughout this spec:

**Surface** — a render-target context addressable by stable identity. In v1 multi-window topology, each window is a distinct surface (`surfaceId`) even when hosted by one app instance/device endpoint.

**Window label** — the client-assigned user-visible identifier for a surface window (`a`, `b`, `aa`, ...). `windowLabel` is distinct from `surfaceId`.

**Pane** — a rendering scope nested inside a surface window. Each pane has a stable internal identity (`paneId`) and a separate stable visible identity (`paneLabel`).

**Pane label** — the client-assigned user-visible identifier for a pane (`1`, `2`, `3`, ...). `paneLabel` is distinct from `paneId` and is a secondary key for the live Surf Ace topology. Pane labels are scoped to one surface/window; `windowLabel + paneLabel` is the user-visible coordinate. The OpenClaw/user-facing pane token is the pane's `displayId` / `paneAddress`, which is derived from the window label plus pane label.

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
2. **Lockless client-local authority.** A client advertising the T1770 lockless capability admits multiple controllers concurrently. No provider, controller, product, chat, or identity owns a client, surface, window, pane, history entry, unread record, tombstone, mutation, or restore right. Every surface mutation traverses one client-owned ordered seam and all admission, ordering, validation, capacity, retention, close, restore, and reclamation rules are identity-independent. Clients without the lockless capability retain the explicitly scoped legacy ownership behavior in this document and MUST NOT admit multiple T1770 controllers.
3. **Content persistence through connection changes.** Connection state MUST NOT affect displayed content or mutate client truth. Content changes only through an accepted explicit content operation.
4. **Reads are local-only projections.** Ordinary OpenClaw reads use the controller's bounded local projection and never synchronously contact a surface. The client remains authoritative for bounded consumable scopes, per-controller cursor floors, pending truth, and structured gaps; a local read durably queues an idempotent acknowledgement. OpenClaw's connection job delivers it in the background; `surf-ace` delivers it during the next explicit networked CLI invocation for any standalone caller.
5. **Panes are always present.** Every surface window has one or more panes at all times. There are no separate "single-pane mode" and "multi-pane mode" — pane routing is always active. Each pane has a stable internal `paneId` and a stable visible `paneLabel`. OpenClaw resolves human references through `surf_ace_list` using `windowLabel` / `paneLabel`, then targets the pane explicitly by `paneId`. Keyboard focus is a local input affordance only; it does not create default-pane routing or default-pane resolution.
6. **One visible entry with shared history.** Each pane shows one entry at a time. Every accepted push creates a distinct client-identified entry, becomes visible, and moves the previously visible entry into the shared retained pool. Back and Forward use one cross-controller 20-entry non-visible LRU pool; controller identity never creates replacement-in-place, quota, pinning, priority, or eviction preference.
7. **Connection-context identity.** In lockless mode, the adapter supplies its asserted stable controller instance ID at admission and the client binds operations to that admitted socket context. OpenClaw does not pass controller/session identity on individual operation payloads, and friendly provenance is never authentication. Legacy `sessionId` injection remains legacy-capability behavior.
8. **Always-on event streaming.** Once paired, the surface emits events continuously. There is no subscribe/unsubscribe API — event streaming is always on while connected.
9. **Annotation mode locks the viewport.** When annotation mode is active, scroll is disabled and link following is disabled. The drawing layer captures all touch and stylus input until annotation mode exits.
10. **Client-allocated content revisions.** For lockless-capable surfaces, accepted append-style content operations traverse the client mutation seam; the client allocates the next content revision and a new history-entry ID atomically. Controllers do not submit authoritative content revisions or history-owner tokens. Legacy clients retain the caller-supplied monotonic revision gate only within legacy capability mode.
11. **Annotation reads are pane-scoped at the OpenClaw boundary.** `surf_ace_read` and related OpenClaw-facing operations target a pane only. Surfaces/providers may keep any additional history restore state internally, but OpenClaw does not pass or track history identifiers.
12. **Lifecycle events are always-on.** Surface lifecycle events (`event.surface_appeared`, `event.surface_removed`, `event.surface_resumed`) and pane lifecycle events (`event.pane_created`, `event.pane_removed`, `event.pane_renamed`) are never profile-gated. Lockless committed content/history/topology/lifecycle events fan out to every admitted controller for the affected surface; cursor-specific availability/overflow signals target only the affected controller without conferring authority.
13. **Platform target floor policy.** Surf Ace targets the newest released OS major version as the minimum deployment target (current decision: iOS/iPadOS 26 and macOS 26 for native surface builds).
14. **Portable extension packaging.** Surf Ace MUST remain buildable as a standalone OpenClaw extension bundle without requiring Clawline as a dependency or core patches. Provider startup, provider deployment, and persistent Surf Ace launchd/auto-start installation require explicit validated host configuration. Each operation fails before mutation when its configuration is absent, malformed, or excludes the current destination.

## 3. Transport and Discovery

### 3.1 Discovery

Surfaces continue advertising `_surf-ace._tcp` over Bonjour/mDNS.

#### 3.1.1 Multi-Window, Multi-Pane, and History Topology (iPad + Electron)

A single app instance may host multiple surface windows simultaneously. Each window is an independent Surf Ace surface. Within each window, one or more panes provide independent content and annotation contexts. Within each pane, one or more history entries allow multiple OpenClaw sessions to coexist without overwriting each other.

**Topology hierarchy:** Surface (`surfaceId`) → Window (`windowLabel`) → Pane (`paneId` internal, `paneLabel` visible) → Content (history-stacked)

> **Phasing note:** History navigation is Phase 1 scope — it ships alongside multi-pane topology, before any annotation-semantics work (Phase 2). See §2.3 for the full phasing plan.

Window rules:
1. Each window has its own stable `surfaceId` and independent local state (capture frame queue, taps, selection, scroll, etc.).
2. The app advertises one device endpoint over mDNS (one host/port), not one mDNS record per window.
3. Windows are enumerated in-band over WS (`surfaces.list`) and can appear/disappear at runtime (`event.surface_appeared`, `event.surface_removed`).
4. In lockless mode, each admitted controller may maintain one active WS session per target window/surface, even when multiple windows share one endpoint. Legacy mode retains one owner session.
5. Creating/removing a window does not require mDNS rebroadcast; only app endpoint lifecycle affects mDNS advertisement/goodbye.
6. On iPadOS, each Surf Ace scene MUST occupy the full device extent in landscape and portrait. The app MUST opt out of iPad multitasking/Stage Manager compatibility sizing when needed so the system does not hand Surf Ace a narrow letterboxed or resized scene. Reported viewport, visible content, pane geometry, and chrome must all derive from the same full-size scene.
7. Closing a window on a lockless-capable client removes it from the live projection but atomically creates a recoverable surface tombstone before `event.surface_removed` and socket closure. The endpoint lifecycle seam remains discoverable with zero live surfaces, and `surfaces.list` exposes the authoritative live/tombstone state required for restore. A client without lockless capability retains the legacy permanent-removal behavior.

Pane rules (Phase 1 committed work, see §2.3):
1. Each window may contain one or more panes, each with a stable internal numeric `paneId` and a stable visible numeric `paneLabel`.
2. `paneId` is the internal routing key. `paneLabel` is the user-visible addressing token shown on the surface.
3. Each pane has independent content, capture frame queue, taps, selection, scroll, and annotation state.
4. All screen-scoped OpenClaw tools target `{ surfaceId, paneId }`. `paneId` is **required**. OpenClaw first resolves the intended pane from `windowLabel` / `paneLabel` via `surf_ace_list`, then keeps using internal `paneId`.
5. Pane lifecycle (create/split/resize/rename/close) is managed in-band; pane changes do not affect window-level session or mDNS state.

Naming system:
1. **Window labels** (a, b, c … z, aa, ab …) are allocated, validated, persisted, and projected by the **client-local authority**.
2. `windowLabel` is a visible coordinate for users and diagnostics, not durable target authority. The client may preserve it across ordinary reconnect and recoverable close/restore when still valid and unassigned. Otherwise restore allocates a new unique live label without changing surface identity or preserved state.
3. **Pane IDs** are allocated by the **client-local authority**. They are stable internal routing identifiers. Controllers target existing stable IDs or submit pane-creating intent; they do not preallocate new pane IDs.
4. **Pane labels** are allocated, validated, persisted, and uniquely projected by the **client-local authority**. The OpenClaw/user-facing pane token is the `displayId` / `paneAddress`, derived from `windowLabel + paneLabel`; `paneLabel` alone is not durable target authority and is not globally unique. The client enforces unique live `windowLabel + paneLabel` coordinates and repairs invalid persisted state before lockless admission without matching or partitioning by controller identity.
5. **Pane names** are assigned by the extension via `pane.rename`. There is no user-facing rename UI. Pane names are optional metadata and MUST NOT replace `paneLabel` as the visible identity or addressing token.
6. The client is the sole authority on topology and visible labeling. Controllers submit intent against stable IDs and expected revisions; the client validates, allocates, commits, and emits lifecycle events.
7. When a pane is split, the controller specifies the target, count, and layout intent. After the stale-revision and pane-creation capacity checks, the client allocates each new `paneId` and `paneLabel`, commits atomically, and emits `event.pane_created`.
8. **Initial surface state:** A newly opened surface starts with one client-allocated window identity and one client-allocated pane identity/label, subject to pane-creation admission. OpenClaw MUST call `surf_ace_list` before any pane-scoped operation and MUST accept a valid post-restore live pane count above `maxPanesPerSurface`.
9. Labels are displayed on the surface — window identity immediately precedes the pane label as a bottom-right floating overlay within each pane. The window identity is uppercase text inside a rounded-rectangle outline, followed by the plain pane number, e.g. an outlined `A` box next to `12`. See §15.1 for visibility rules.


TXT keys used by WS protocol:

| Key | Type | Example | Notes |
|---|---|---|---|
| `name` | string | `Kitchen Display` | Human-readable label |
| `v` | int | `1` | Protocol major version |
| `w` | int | `1920` | Viewport width (points) |
| `h` | int | `1080` | Viewport height (points) |
| `s` | int | `2` | Scale factor |
| `cap` | int | `31` | Content type bitmask |
| `busy` | `0|1` | `0` | Legacy-capability ownership status only. Lockless-capable clients advertise `0`; controller admission is reported through lockless capability/state instead. |
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
2. Each controller asserts a mandatory stable opaque controller instance ID. The ID is durable across reconnect/restart/redeploy and scopes live deconfliction, cursors, retry correlation, provenance correlation, and diagnostics only; it grants no ownership, priority, quota, veto, or restore right.
3. Missing or malformed instance identity fails admission. If the same instance ID is already live, the newcomer receives a distinct duplicate-ID error and the incumbent is preserved. There is no takeover path; retry waits for normal liveness reaping.
4. Every controller acts through the same client-local ordered mutation and lifecycle seams. Ordering follows client serialization, never controller identity, product, label, retry count, or prior success.
5. Admission and retained controller state are bounded by the advertised CTLRET limits in §4.8. A capacity refusal never evicts a live controller or selects by identity.
6. A client that does not advertise T1770 lockless capability remains in legacy single-provider mode. Only in that explicitly negotiated legacy mode do `providerId`, `busy`, owner resume, relinquish, and takeover retain their historical meanings. Legacy and lockless mode are mutually exclusive for one surface.

**Multi-controller/session routing** is settled: every accepted `content.set` creates a distinct client-identified entry and becomes visible immediately. The displaced visible entry remains in the shared retained pool, and committed content/history events fan out in client order without owner-only delivery.

### 4.3 Pair-First Rule

All operations other than `surfaces.list` and `pair.request` are invalid until pairing succeeds.

`surfaces.list` remains the pre-pair discovery operation for multi-window endpoints. In lockless mode it exposes client-authoritative lifecycle/capability state without implying ownership availability. Pane topology discovery follows successful controller admission through `panes.list`. Legacy clients retain legacy lock availability semantics.

### 4.4 Reconnect, Resume, and Legacy Ownership Operations

Provider reconnect policy:
1. Exponential backoff with jitter: 0.5s, 1s, 2s, 4s, 8s, 16s, max 30s.
2. Reconnect uses the same discovered surface address.
3. Lockless recovery sends `pair.request` with the same stable controller instance ID and the controller's resume/synchronization state. The client resumes the retained cursor/gap bundle only while it remains in the bounded dormant pool.
4. A regenerated ID or an ID whose dormant bundle was reclaimed is a new admission at current scope tails. Human-readable labels never recover cursor state.
5. Duplicate-live-ID refusal is not takeover: the newcomer waits for the heartbeat/liveness path to reap a dead incumbent.
6. Resume exchanges client cursor/gap generations and the controller's durable acknowledgement outbox, retransmits idempotently, and rebuilds the bounded local projection from client snapshots and ordered deltas.

**Legacy capability only:** A non-lockless client retains the historical same-`providerId` owner resume, `busy`, explicit user-directed takeover, self-reclaim, and `ownership.relinquish` behavior. Lockless controllers MUST NOT send or interpret those operations.

**Invariant: connection state MUST NOT affect displayed content or client truth.** A controller crash, restart, disconnect, or partition does not mutate content/topology, free or transfer a right, elect a controller, or stop other admitted controllers.

### 4.5 Keepalive

Application-level keepalive is required:
1. In lockless mode, each controller starts heartbeat only after successful admission and initial client snapshot/capability validation. Legacy mode retains its provider-authority prerequisite.
2. Provider sends `heartbeat.ping` every 10s.
3. Surface replies with `heartbeat.pong` within 3s.
4. Surface MUST prioritize heartbeat handling above queued frame/render work and MUST NOT queue `heartbeat.pong` behind render/mutation tasks.
5. Missing 2 consecutive pong responses causes provider to close socket and reconnect.

Pair timeout:
1. Provider MUST apply a 10s pairing timeout from WS connection establishment.
2. If no `pair.response` arrives in 10s, provider closes socket and enters reconnect backoff.

**Surface UI connectivity indicator (required):**
The surface MUST display connection state only through the window ID outline/text color in the bottom-right identity overlay (§15.1). Required behavior:
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
1. The endpoint owns a durable monotonically increasing `surfaceSetRevision` and one ordered lifecycle transaction seam for surface/window open, recoverable close, restore, and reclamation.
2. Controller lifecycle mutations carry `expectedSurfaceSetRevision`; close also carries the surface's `expectedTopologyRevision`. A mismatch returns authoritative current state and requires explicit refresh/recompute/retry with a new request ID.
3. An accepted open atomically allocates a stable surface ID, unique live window label, one initial pane ID/label, initializes client revisions, advances `surfaceSetRevision`, and then emits `event.surface_appeared`.
4. Controller window lifecycle may be omitted only when it is not a product operation on that platform. Local-user close is always recoverable. On a capable client, any admitted controller and the local user use identical identity-independent admission rules.
5. Accepted close atomically creates a surface tombstone containing the surface identity, full topology, live panes, nested pane tombstones, bounded consumable scopes/cursors/gaps, and restore state before removing the live projection, advancing `surfaceSetRevision`, emitting `event.surface_removed`, and closing surface sockets. Close itself discards nothing.
6. Any admitted controller or the local user may restore a retained surface tombstone through the endpoint lifecycle seam even when zero surfaces are live. Restore reactivates the same surface/pane identities and state, consumes the surface tombstone, advances `surfaceSetRevision`, and emits ordered lifecycle events.
7. Pane and surface tombstones share the finite client-wide count/byte pool in §4.8 and are reclaimed only by ascending `closedSequence`. Listing or failed restore never refreshes order.
8. Window lifecycle signals remain in-band and always-on; they do not require mDNS rebroadcast and do not create a permanent controller destroy path.

### 4.8 T1770 Lockless Authority, Capacity, Retention, and Retired Model

This subsection is the compact canonical amendment for a client advertising `surf-ace.lockless-multi-controller.v1`. It does not change legacy behavior on a client that omits that capability. Legacy and lockless behavior MUST NOT be mixed for one surface.

#### Client-local mutation and topology authority

1. Each client is the sole ordered authority for the surfaces it renders. Controllers communicate directly with the client, submit content/topology/lifecycle intent, and hold bounded read projections; no central coordinator, controller-side writable replica, CRDT, operational transform, offline write queue, or automatic stale-operation rebase exists.
2. All mutations for one surface enter one client-owned FIFO seam. Topology requests carry `expectedTopologyRevision`; endpoint lifecycle requests carry `expectedSurfaceSetRevision`. The client compares at execution time, rejects mismatch with authoritative state, and requires explicit refresh/recompute/retry with a new request ID.
3. Accepted operations validate completely, commit atomically in client order, allocate client revisions/IDs/labels, and emit events after commit. Identity never affects validation, order, capacity, retention, or outcome.
4. The client allocates and persists stable surface/pane IDs and unique live labels. Controllers target existing IDs and submit intent. The compositor receives only client-resolved geometry/native-hosting state and never reconstructs, validates, sequences, or persists controller topology intent.

#### Shared content history and provenance

1. Every accepted push creates a distinct history entry, receives a client-allocated content revision and opaque entry ID, becomes visible, and moves the former visible entry into the shared retained pool.
2. The visible entry is separate from one per-pane pool of at most 20 non-visible entries shared across Back and Forward. Visibility assigns a strictly increasing `lastVisibleSequence`; overflow evicts the smallest sequence after Forward-branch removal. There are no controller partitions, owner tokens, quotas, protected slots, or same-controller replacement.
3. At acceptance the entry snapshots trimmed friendly-chat and provider/product display strings. The pill renders the visible entry as localized `{chat} — {provider}`, using localized `Unknown chat`/`Unknown provider` fallbacks. The full strings are entry-bound explanation only, never identity or authority.
4. At or above the measured width of `… — …`, both components and separator remain on one line with equal-share/unused-width reallocation and independent end truncation. From one-ellipsis width up to that composite floor it renders exactly `…`; below one-ellipsis width it occupies zero visual width. The full localized accessible name is always “Pushed by {chat}, using {provider}”; user text is trimmed, bidi-isolated, and not translated.

#### Advertised pane and recoverable-state capacity

1. The client advertises finite positive `maxPanesPerSurface` (`P`), `maxSurfaceRecoverableBaseBytes`, `maxPaneRecoverableStateBytes`, and `maxPaneAnnotationRestoreBytes`, with the annotation sublimit no greater than the pane limit. Byte values are exact lengths of versioned durable serialization. Surface base is the greater of the live-surface base and retained-surface-tombstone base representations and includes enclosing record/container framing, surface/window metadata, topology/geometry intent, revisions, label state, viewport/native-host restore material, references, and all surface-tombstone-only durable fields (representation discriminator, tombstone ID, `closedSequence`, close cause, and stored size/count/reason fields), but excludes pane records, consumable scopes, and cursor/gap records. Per-pane state is the greater of the live-pane and retained-pane-tombstone record representations for the same material and includes enclosing record framing, identity/lineage/label/name, visible entry, up to 20 retained entries, revisions/provenance, persistent annotation/restore material, and all pane-tombstone-only durable fields, but excludes the consumable scope and cursor/gap records. Annotation bytes are that exact serialized subset. Surface-base, pane, scope, and cursor/gap partitions are exhaustive and non-overlapping: field names, collection delimiters, version tags, framing, and every other durable byte are charged exactly once. Separate event/audit records are outside retained-tombstone bytes; values copied into a tombstone for later output are charged in its base or pane partition.
2. `P` is a pane-creating admission cap, not a live-pane invariant. After stale-revision validation, each pane-creating transaction computes its prospective count before ID allocation. For `pane.split`, `prospectiveLivePaneCount = currentLivePaneCount - 1 + count`; the initial pane on surface open has prospective count one. Exceeding `P` returns stable identity-independent `pane_capacity` with current/requested/maximum values and commits nothing.
3. Before any state-growing mutation, the client applies normal history LRU, computes the greater exact live-or-tombstoned representation for each affected surface base and pane, and returns `surface_state_capacity` or `pane_state_capacity` with current/prospective/maximum values if a bound would be exceeded. This reserves all tombstone-only durable bytes before close. Failure commits nothing and never truncates or silently evicts content, history, provenance, or annotations.
4. Pane/surface close and restore move already-conforming state and never perform the pane or recoverable-byte capacity refusals above. A retained pane restore reactivates the same ID; if `(L,R)` are live panes and retained pane tombstones, restore changes them to `(L + 1,R - 1)`. It may produce a valid live count above `P`, up to `P + T`, and topology/list projections MUST accept that state rather than clamp it. Pane creation remains refused until its prospective count is at most `P`.
5. Admission, migration, restart, and configuration changes prove every exact byte limit and `L + R <= P + T`; over-limit state fails with its specific capacity class without truncation or identity-based selection.

#### Recoverable pane close and shared tombstone retention

1. Accepted pane close atomically removes the pane from visible topology, creates a durable tombstone, advances topology revision once, and then emits the committed close event. The tombstone preserves stable identity/lineage, label hint/name, visible and retained history with revisions/provenance, bounded annotation/restore state, bounded consumable scope, all retained controller cursors, and uncleared gaps. Close does not read, discard, truncate, or advance any of them.
2. Any admitted controller may restore any retained tombstone using current topology revision and placement intent. Missing tombstone, stale revision, or invalid placement changes nothing. Accepted restore reinserts the same pane ID/state, consumes the tombstone, advances one revision, and emits events after commit. Current live count and retained-state size never produce `pane_capacity`, `pane_state_capacity`, or `surface_state_capacity` on restore.
3. The last live pane cannot close. Restore reuses its label only if still valid/unassigned; otherwise the client allocates a new unique live label without changing identity/state.
4. The client advertises finite positive `maxRetainedTombstones` (`T`) and `maxRetainedTombstoneBytes`, shared across pane and surface tombstones. Exact serialized bytes are used for accounting. Because admission proves the exact full recoverable surface envelope from exhaustive non-overlapping partitions whose base/pane limits include every tombstone-only durable byte, and proves `maxRecoverableSurfaceBytes <= maxRetainedTombstoneBytes`, valid controller/user close never returns `tombstone_capacity`; the close transaction instead reclaims existing tombstones by ascending client `closedSequence` until both bounds hold, rolling back reclamation if close cannot commit. `tombstone_capacity` is reserved for admission, migration, restart, or configuration state whose exact retained-tombstone aggregate already exceeds the shared byte bound; rejection preserves the source or prior durable generation without trim, reclamation, or drop.
5. Reclamation permanently deletes the selected retained state/cursors, emits an ordered reclamation event to all live admitted controllers, and writes durable exact diagnostics. Listing, reading, or failed restore never refreshes order; selection never uses controller identity, labels, provenance, creator, closer, or unread amount.

#### Consumable truth, local projections, and dormant controllers

1. The client owns one durable ordered consumable scope per pane and one per surface for non-pane consumables, storing shared records once by client `consumableSequence`, with independent per-controller cursor floors and at most one sticky structured gap per scope.
2. It advertises finite positive `maxPaneConsumableRecords`, `maxPaneConsumableBytes`, `maxSurfaceConsumableRecords`, `maxSurfaceConsumableBytes`, `maxConsumableRecordBytes`, and `maxConsumableCursorStateBytesPerScope` (`G`). Bytes are exact versioned durable serialized bytes.
3. Closed frames, taps, and ordinary-read content/history/topology occurrences are append records. Scroll, selection, page, playback position/state, and last navigation are latest-wins by kind/scope. One live frame per `(paneId, frameId)` coalesces by stable stroke ID; finalization appends one immutable record.
4. At record ingress the client applies declared coalescing and removes complete oldest records by sequence until count/bytes fit; an oversized candidate becomes explicit loss. Every affected cursor moves to the retained floor with one sticky `consumableGap` containing generation, lost range/counts/bytes/classes/cause. The client sends targeted `event.consumable_overflow`, writes durable diagnostics, and preserves the gap through close/restore/disconnect/dormancy/restart until acknowledged. Close/restore never creates payload pressure or loss.
5. Pair/resume supplies a versioned scope snapshot; ordered deltas, `event.consumable_available`, and gap updates populate a bounded controller projection capable of the negotiated window. Ordinary `surf_ace_read` is one local transaction: return cached records and structured `consumableLoss`, durably advance only the projected cursor, and append an idempotent acknowledgement intent to a durable outbox. It never waits for network I/O. Only a client-accepted acknowledgement advances authoritative cursor/pending/gap truth; OpenClaw sends it through its connection job and the standalone CLI sends it during the next explicit networked invocation for every caller.
6. The controller may present one alert per unread burst from projected client pending/gap truth, but cannot invent, clear, or own unread/loss truth.
7. The client advertises finite positive `maxAdmittedControllerEntries` (`C`), `maxDormantControllerEntries`, and `maxDormantControllerBytes`. Disconnect assigns increasing `dormantSequence`; retained same-ID reconnect resumes exact cursors/gaps. Admission or dormant pressure reclaims dormant bundles by ascending sequence, never a live entry. If every admitted entry is live, new admission returns `controller_capacity`.
8. Dormant reclamation deletes that instance registry/cursor/gap state from live panes/surfaces and both tombstone kinds plus material retained solely for it, without advancing any remaining cursor. It emits `event.controller_retention_reclaimed` and durable exact diagnostics. Byte accounting includes registry/cursor/gap bytes plus unread records retained solely by dormant cursors, counting shared records once as specified by CTLRET.

#### Recoverable surface envelope and restart

Each client advertises finite positive `maxRecoverableSurfaceBytes` no greater than `maxRetainedTombstoneBytes` and reserves it for every live surface. For each live or tombstoned surface, `L + R <= P + T`. `maxSurfaceRecoverableBaseBytes` is the maximum exact live-or-surface-tombstone base partition including every surface-tombstone-only durable byte; `maxPaneRecoverableStateBytes` is the maximum exact live-or-pane-tombstone partition including every pane-tombstone-only durable byte. Those partitions and the scope/cursor partitions are exhaustive and non-overlapping. Before lockless admission/configuration, it proves:

`maxRecoverableSurfaceBytes >= maxSurfaceRecoverableBaseBytes + maxSurfaceConsumableBytes + (C × G) + ((P + T) × (maxPaneRecoverableStateBytes + maxPaneConsumableBytes + (C × G)))`.

The first term charges the enclosing live/surface-tombstone record exactly once; each of the at most `P + T` pane slots charges one maximum live/pane-tombstone record plus its scope and `C` cursor/gap bundles. Every field name, delimiter, version tag, framing byte, and tombstone-only durable field is therefore included exactly once. Every symbol is advertised and the same partition serializers are enforced on state-growing transactions, so controller/local-user surface close switches to already-reserved representations, never drops material, and is never rejected for snapshot size, including when `maxRecoverableSurfaceBytes` equals the equation exactly. Restart restores capability mode, limits, sequences, live/tombstoned distributions, surface/topology revisions, entry state/provenance, scopes, cursor floors/gaps, and dormant bundles before admission. It never clamps valid over-`P` live state or makes retained tombstones unrestorable.

#### Retired model register

For lockless-capable surfaces, the June provider-segregation recon D1/D3/R2..R7 and all Revision 1–5 designation, claim-scope, ownership, takeover, owner-only, provider-partitioned history/cursor, and namespace requirements are superseded by T1770 client-local authority. Historical `providerId`, namespace, designation, lineage, and owner tokens MUST NOT be renamed into controller identity or retained as comparison, partitioning, priority, quota, routing, or refusal behavior. Controller instance identity has only the uses allowed in §4.2. `ARCH-10` survives: hosts, addresses, runtime placement, and state roots remain external configuration, never product truth.

### 4.9 General Standalone Surf Ace CLI and Reusable Consumers

1. Surf Ace exposes one general standalone native Rust `surf-ace` CLI, directly callable by any local program, script, user, or agent. Tight Beam is one separate reusable-skill consumer of the identical installed executable through ordinary command execution; it does not own or redefine the executable, crate, package, commands, controller identity, runtime, configuration, state model, authority, or access gate. The delivered tree contains no Surf Ace MCP declaration/server/tool, MCP-only adapter, dedicated Surf Ace archetype, Tight-Beam-specific binary, or parallel fallback route. Attaching the Tight Beam skill changes neither the archetype identity nor unrelated archetype material.
2. The supported surface is exactly `list`, `push`, `read`, `topology-intent`, `topology-realize`, `clear`, `annotations-remove`, `capture-pane`, `surface-mode-convert`, `surface-intent`, `target-register`, and `target-apply`. Inputs, acknowledgements, errors, and results are deterministic JSON. Endpoint, state root, controller product label, and per-operation friendly chat label are external inputs; no machine, role, address, surface, topology, or provenance label is compiled in.
3. One state root atomically retains the stable controller instance ID, bounded projection, sticky gaps, projected cursors, acknowledgement outbox, resume metadata, and unresolved request/receipt correlations. An OS lock covers each complete networked invocation. `read` instead performs one locked local transaction, opens no connection, advances only projected consumption, and atomically queues idempotent acknowledgement intent.
4. Every explicit networked invocation connects directly to the public client WebSocket, pairs or resumes with the durable ID, reconciles client-ordered snapshots/deltas/gaps, flushes acknowledgements, resolves every uncertain request, performs the requested work if permitted, persists resulting state, and disconnects. No sidecar, daemon, resident MCP process, launchd/login item, autostart entry, or persistent service participates.
5. A mutation remains connected until its exact correlated `operationReceipt` is durably stored and returned. Interruption after send and before durable receipt returns deterministic `outcome_unknown`, never success or an automatic retry. A later networked invocation must resolve all such IDs before another mutation. `target.apply` is the one asynchronous materialization seam: after pure validation and capacity checks, the client atomically persists the exact `intent_committed` response, receipt, and surface-charged work item before handing the response to the transport; browser/native materialization begins only after that send attempt. The receipt proves committed intent, never materialization success.
6. The client advertises finite positive pending-receipt count and exact serialized-byte limits per controller. It reserves capacity before mutation commit and atomically stores the exact terminal response and receipt under `(controllerInstanceId, requestId)`; overflow returns `receipt_capacity` and commits nothing. Individual receipts are never evicted.
7. Pair/resume is a barrier after the prior connection's mutation-seam work. `operation.receipt.sync` yields exactly `resolved_success`, `resolved_failure`, `not_committed`, `still_pending`, or `receipt_unavailable` with `controller_reclaimed` cause. Stored success/failure is replayed exactly without request re-execution; `not_committed` alone permits a later new request ID; `still_pending` keeps the invocation read/sync-only; unavailability is legal only after deterministic whole-controller-bundle reclamation. For `target.apply`, stored success replays the exact committed-intent response and does not infer materialization. The CLI persists replay before `operation.receipt.ack`; the client retains an accepted receipt until the CLI durably records that acceptance, and an idempotent release then deletes it. A crash on either side of the accepted-ack/local-marker boundary therefore replays the same terminal instead of converting it to `not_committed`. This cross-connection resolution is separate from connection-scoped request replay.
8. Durable target work progresses exactly `intent_committed → materializing → terminal`. Restart from `intent_committed` first persists `materializing`, then invokes the materializer once. Restart from `materializing` never invokes it again and terminalizes with `failed`/`materialization_outcome_unknown`. Terminalization emits exactly one separately correlated `event.target_apply_result` and append-only `target_result` occurrence in the percent-encoded surface scope, using normal surface snapshot, delta, gap, deduplication, and `consumable.ack` semantics without changing the intent receipt.
9. The same locked Rust source, canonical schemas/vectors, all twelve commands, every acknowledgement/receipt/order/resume/failure path, receipt capacity/reclamation behavior, and deterministic fixtures must pass natively on macOS and Linux without caller-specific carve-outs. Direct non-Tight-Beam invocation proves the standalone product boundary. Separately, the Tight Beam skill must invoke that exact installed executable path/digest from two ordinary current archetypes and a future-archetype fixture without identity changes.

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

### 5.4 Ordering and Mutation Seam
1. On a lockless-capable surface, every accepted content operation traverses the client-owned mutation seam.
2. `content.set` is append-style: the client allocates the next content revision and a new history-entry ID and commits the new visible entry atomically. Controllers do not submit an authoritative revision or `historyOwnerToken`.
3. `content.append`, `content.patch`, and `content.clear` target current client state with the operation's required expected-state token; the client allocates the committed revision.
4. Expected-state mismatch returns the applicable stable stale error with current authoritative state and commits nothing.
5. A legacy-capability client retains the historical caller-supplied monotonic `revision == currentRevision + 1` gate only in legacy mode.
6. Drawing overlay mutations are provider-controlled through `annotations.remove`; surface never autonomously deletes strokes.

### 5.5 Size Limits

Surface advertises limits in `pair.response`:
1. `maxMessageBytes` (default 12 MiB).
2. `maxFrameBytes` (default 10 MiB for `content.set` content payload).
3. `maxVisibleTextBytes` (default 4096).
4. `maxStrokePointsPerFlush` (default 8192 for `event.drawing_flush`).
5. `maxDrawingFlushBytes` (default 2 MiB).
6. Lockless CAP limits: `maxPanesPerSurface`, `maxSurfaceRecoverableBaseBytes`, `maxPaneRecoverableStateBytes`, `maxPaneAnnotationRestoreBytes`, `maxRetainedTombstones`, `maxRetainedTombstoneBytes`, and `maxRecoverableSurfaceBytes`.
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
2. After lifecycle admission, the lockless response contains client-authoritative live surfaces, retained surface tombstones, `surfaceSetRevision`, capability state, admission availability, and the bounded durable admission-attempt ledger without ownership fields. `paired` is legacy capability state only. Pre-pair and surface-scoped discovery omit the ledger.
3. `surfaces.list` is discovery-only and grants no pane/topology/lifecycle right.
4. Any controller meeting lockless identity/capacity admission may send `pair.request`; a duplicate live ID or full all-live controller registry receives its distinct stable refusal.
5. Full pane topology discovery follows admission via `panes.list`, and valid restored live pane counts above `maxPanesPerSurface` are reported without clamping.
6. Legacy clients retain the historical `paired`/claim/owner-resume/takeover behavior only in legacy mode.

Each admission-attempt ledger record contains the exact `surfaceId`, `controllerInstanceId`, triggering request ID, monotonic attempt sequence, start/update times, last reached stage, outcome, and failure code/message. Request and controller IDs use `[A-Za-z0-9._:-]{1,64}`; surface IDs use `sf_` followed by 3–64 characters from the same set. Failure codes use `[a-z_]{1,64}`. Failure messages retain at most 512 UTF-8 bytes in their JSON string encoding and carry `…[truncated]` when the exact message exceeds that bound.

The ledger retains at most 256 records and at most 128 KiB of JSON-encoded records. Pending records reserve the longest stage, maximum failure-code and failure-message space, and maximum update timestamp, so every later stage transition and terminalization remains within the byte bound. The client refuses a new surface admission with `surface_state_capacity` before it allocates a sequence, appends, performs surface lookup, or changes authority when either limit would be exceeded. It never evicts an admission record or rewinds the monotonic sequence. Existing persisted state outside these bounds is invalid state and causes a loud startup refusal instead of inference or repair.

Within those limits, the client persists the pending record before admission work begins. A failed attempt survives transaction rollback and restart. A successful attempt is committed atomically with the admitted authority and surface state. Lifecycle `surfaces.list` exposes the complete retained ledger; pre-pair and surface-scoped discovery omit it.

### 6.0.1 Surface Admission Mode Conversion

`surface.mode.convert` is an explicit endpoint-lifecycle mutation. It runs only on an admitted lifecycle connection with no target surface bound to the connection. The standalone CLI exposes this operation as `surface-mode-convert`; no connection, pair, resume, or ordinary operation converts a surface implicitly.

**Request fields:** exact non-empty `surfaceId`; `currentMode` equal to the caller's observed `legacy`, `lockless`, or `unknown` admission mode.

**Behavior:**
1. The client reads the exact surface's persisted admission mode at execution. A supplied `currentMode` that differs from the observed mode returns `capability_mismatch`, names the observed current mode and required `lockless` mode, supplies the exact `surface-mode-convert` remedy for that surface, and commits nothing.
2. An observed `unknown` mode returns `invalid_operation`, names `unknown` as current and `legacy` as the required conversion source mode, supplies the exact command to run after an explicit legacy admission stamp is restored, and commits nothing. The client never infers or repairs a missing mode stamp.
3. An observed `legacy` mode with an active or in-flight legacy transport returns `invalid_operation`, names the current and required modes and the exact command remedy, and commits nothing. The operator must wait for in-flight admission to finish or disconnect an active legacy transport before retrying.
4. For an inactive observed `legacy` surface, the client atomically clears legacy provider ownership, prepares the existing surface for lockless authority, and stamps the same exact surface `lockless`. Success returns `surfaceId`, `previousMode: "legacy"`, `currentMode: "lockless"`, `changed: true`, and the exact correlated `operationReceipt`.
5. For an already `lockless` surface, the operation is idempotent: it leaves the surface unchanged and returns `surfaceId`, both modes as `lockless`, `changed: false`, and the exact correlated `operationReceipt`.

The success receipt contains `requestId` equal to the request envelope ID and the client-allocated positive `commitSequence`. The ordinary mutation receipt, persistence, replay, and uncertain-outcome rules in §4.9 apply.

### 6.1 Pair Handshake

Flow:
1. Provider opens WS.
2. Provider may call `surfaces.list` to discover available surfaces.
3. Provider sends `pair.request`.
4. Surface replies `pair.response` (success or error). In lockless mode success means new controller admission or same-ID retained-state resume; it never means ownership acquisition or transfer. A surface-scoped success includes the committed admission-attempt record.
5. If success, connection enters active mode and event streaming starts immediately.

`pair.request` fields include:
1. `controllerInstanceId` (mandatory stable opaque asserted instance identity in lockless mode). It is persisted across restart/redeploy and scopes only deconfliction, cursors, correlation, and diagnostics. `providerId` remains a legacy ownership field only.
2. `connectionId` (unique per socket attempt).
3. `surfaceId` (target window surface on multi-window endpoints).
4. `resume` (optional prior synchronization/cursor/gap generation state for the same controller instance; legacy `sessionId` owner resume is legacy-mode only).
5. `takeover` (legacy capability only; prohibited in lockless mode).
6. `providerName` (required human-readable provider/product display metadata and diagnostics only; never identity, routing, or authority).
7. `eventProfile` (optional, default `minimum_deep`).
8. `drawingFlushConfig` (optional, provider-preferred idle/max interval values).
9. `windowLabel` (legacy capability bootstrap only; lockless labels are client-allocated).
10. `initialPaneId` (legacy capability bootstrap only; lockless pane IDs are client-allocated).
11. `initialPaneLabel` (legacy capability bootstrap only; lockless pane labels are client-allocated).
12. `protocolVersion` (`1` for this spec).

`pair.response` success includes:
1. `sessionId`.
2. `resumed` boolean.
3. Surface metadata (id/name/viewport/capabilities).
4. `eventConfig` (active event profile, active event list, and effective drawing flush config).
5. Limits.
6. Current pane state summary (`panes[]` with per-pane `paneId`, `paneLabel`, `currentContentId`, `currentRevision`, and `contentType`) plus current topology/surface revisions, bounded consumable snapshot/cursor/gap state, and retained lifecycle state required by negotiated lockless capability.

A successful `pair.response` MUST include at least one topology pane. Providers MUST treat `state.panes.length < 1` as a protocol failure and MUST NOT mark that surface connected or targetable from that response. Fresh Surf Ace surfaces expose at least one targetable topology pane.

For a surface with legacy provider state but no persisted lockless admission, `pair.request` without migration material returns `admission_failed`, not `capability_mismatch`. The error names the current and required modes, exact surface, and exact `surface-mode-convert` command. The caller may retry with valid migration material to preserve legacy state, or an admitted lifecycle controller may run the explicit conversion command to discard legacy provider ownership. Conversion is safe only under the current/unknown/active refusals in §6.0.1. After conversion, the same surface accepts a new recorded pair attempt. Repeating conversion on an already-lockless surface is idempotent.

### 6.1.1 Controller Admission, Recoverable Lifecycle, and Shared History Operations (Phase 1)

These operations are post-admission and scoped to client authority. Lockless operations implement §§4.2–4.8; explicitly negotiated legacy clients retain the historical ownership behavior.

#### `surface.window.open`
Requests that the paired Surf Ace Spatial app endpoint create a new top-level Surf Ace Spatial surface window.

**Request fields:** `expectedSurfaceSetRevision`; optional `requestedBy` diagnostic string.

**Behavior:**
1. On a platform advertising controller window lifecycle, any admitted controller may call `surface.window.open` under the same identity-independent rules as local open.
2. The endpoint compares `expectedSurfaceSetRevision`, validates pane-creation and recoverable-state capacity, and atomically allocates the new surface/window and initial pane identities/labels before emitting `event.surface_appeared`.
3. A platform may return `unsupported_operation` only when controller window lifecycle is not a product operation there.
4. The request does not mutate pane topology inside an existing surface.

#### `surface.window.close`
Requests that the paired Surf Ace Spatial app close the currently paired top-level Spatial surface window.

**Request fields:** `expectedSurfaceSetRevision`, `expectedTopologyRevision`; optional `requestedBy` diagnostic string.

**Behavior:**
1. On a capable client, any admitted controller or the local user may close a live surface under identical identity-independent rules.
2. On success, the client first commits a recoverable surface tombstone with the complete bounded state, then removes the live projection, advances `surfaceSetRevision`, emits `event.surface_removed` with recoverability metadata, and closes target-surface sockets.
3. The endpoint lifecycle/restore seam remains available with zero live surfaces. Any admitted controller or the local user may restore the retained surface with the same IDs/state.
4. A client that omits controller window lifecycle still makes every local-user close recoverable.

#### `ownership.relinquish` (legacy capability only)
Voluntarily clears ownership for a legacy-mode paired surface. Lockless controllers MUST NOT send this operation.

**Request fields:** none.

**Behavior:**
1. Only the current lock owner may call `ownership.relinquish`. Non-owners receive `not_lock_owner`.
2. On success, the surface clears ownership immediately but preserves displayed content, pane topology, and annotations.
3. After success, the relinquishing provider MUST disable auto-retry for that surface. Reconnect after relinquish requires a new fresh claim, not owner resume.
4. `ownership.relinquish` is the normal, voluntary way to make a surface available for another provider later. It is distinct from `takeover`, which is an explicit transfer initiated by another provider.

**Response fields:** `relinquished: true`.

#### `panes.list`
Returns current pane layout for the paired surface.

**Response fields per pane:** `paneId`, `paneLabel`, `name` (extension-assigned or null), `activeContentId` (or null), `contentType` (or null), `viewport`.

The OpenClaw-facing `surf_ace_list` response exposes the client-owned `topologyRevision` and recursive `topology` tree. Agents plan intent operations against those fields rather than inferring structure from the flat pane list. A live count above `maxPanesPerSurface` after restore is valid state.

#### `pane.split`
Splits an existing pane into N panes.

**Request fields:** `paneId` (required — pane to split), `expectedTopologyRevision`, `count` (total pane count after split, including the source pane; min 2), and `direction` (`horizontal` | `vertical`). `newPaneIds`/`newPaneLabels` are legacy-capability fields only.

**Behavior:** The source pane retains its `paneId`, `paneLabel`, and content. In lockless mode the client checks the expected revision, computes `currentLivePaneCount - 1 + count`, returns `pane_capacity` without mutation when that exceeds the advertised admission cap, then performs exact recoverable-state byte checks. On success it allocates IDs/labels and emits `event.pane_created` after atomic commit.

**Response fields:** `panes` — array of `{ paneId, paneLabel }` for all panes in the window after the split (including existing panes).

#### `pane.rename`
Assigns or clears a name for a pane. This is an **extension-to-surface** operation — the extension names panes. There is no user-facing rename UI on the surface.

**Request fields:** `paneId`, `name` (string or null to clear).

**Response fields:** `paneId`, `name` (new name or null).

**Behavior:** Pane names are display metadata only. They do not replace `paneLabel`. OpenClaw resolves human pane references through `paneLabel` in `surf_ace_list`, then targets the pane by internal `paneId`.

**Surface default affordance:** The surface displays pane names as assigned by the extension. Topology is fully extension-controlled — no user-initiated rename or split UI is provided.


#### `pane.close`
Recoverably closes a pane and removes it from the live layout.

**Request fields:** `paneId`, `expectedTopologyRevision`. Cannot close the last remaining pane in a window (returns `invalid_operation`).

**Response fields:** `paneId` (ack echo), tombstone ID, new topology revision, `recoverable: true`, and `closedSequence`. No accepted close discards preserved state.


---

**Pane lifecycle events (surface → provider):**
- `event.pane_created` — `{ surfaceId, paneId, paneLabel, parentPaneId (pane that was split, or null if created standalone), fromSplit: bool }`
- `event.pane_removed` — `{ surfaceId, paneId, tombstoneId, recoverable: true, closedSequence }` in lockless mode
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
- `visibleText` in snapshot is always empty.
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
- `visibleText` reflects any closed captions or subtitles visible at the current playback position, if available.
- Navigation events do not fire.
- `content.clear` clears the video and all annotations.

#### Protocol forward compatibility
The `video` and `canvas` content types are included in the `ContentType` schema enum in v1 so that implementations can reject them with `unsupported_content_type` rather than `invalid_payload`. This preserves forward compatibility: a v1 surface that does not implement these types still handles the message gracefully. A surface advertises supported content types via `cap` bitmask in mDNS TXT and in the `pair.response` capabilities field.

`authority.state.v1` is a legacy capability only. In lockless mode, `surf-ace.lockless-multi-controller.v1` plus the complete client snapshot, advertised limits, revisions, stable IDs/labels, and controller-specific cursor/gap state determine actionability. A controller fails lockless admission if any required capability or projection capacity is absent; it never sends provider-owned identity/topology for client adoption.

Lockless authority reconciliation invariant: the client-authored stable IDs, labels, revisions, topology, lifecycle state, limits, consumable scopes, cursor floors, and gaps are authoritative. Controller caches and runtime/process/session metadata reconcile to that state and cannot create terminal non-actionability based on controller identity, ownership epoch, provider lineage, or label disagreement. The historical `authority.state`/stable-`providerId` ownership reconciliation invariant applies only to explicitly negotiated legacy clients.

## 7. Always-On Event Delivery

Once paired, surface emits events without any subscribe/unsubscribe API.

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

### 7.2 Optional Event Expansions (Still No Watch Mode)

The stream is still always-on; expansions are negotiated at pair time, not through runtime watch subscriptions.

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
| `event.pane_created` | Lifecycle — **not profile-gated** | Always | Emitted when a new pane is created (split or standalone). Always active regardless of `eventProfile`. Does NOT appear in `pair.response.eventConfig.activeEvents`. |
| `event.pane_removed` | Lifecycle — **not profile-gated** | Always | Emitted after recoverable pane-close tombstone commit in lockless mode, with tombstone/recoverability metadata. Always active regardless of `eventProfile`. |
| `event.pane_renamed` | Lifecycle — **not profile-gated** | Always | Emitted when a pane name changes. Always active regardless of `eventProfile`. Does NOT appear in `activeEvents`. |
| `event.scroll` | Context-rich but high-volume | No (`deep_plus_scroll` only) | Useful but not strictly required for minimum usefulness. |

Event behavior rules:
1. Events are in-order and reliable while socket is healthy.
2. Events are not replayed across reconnect.
3. After reconnect, provider must request `snapshot.get` before acting on new events.
4. Provider MUST buffer events that arrive while this mandatory `snapshot.get` is in-flight.
5. In lockless mode, the client-authoritative bounded scopes and structured gap rules in §4.8 replace the legacy 128-event snapshot buffer and local warning. A controller snapshot projection must hold the negotiated retained window; inability to do so fails lockless admission. The 128-event rule remains legacy capability behavior only.
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
| `busy` | Legacy capability only: surface ownership lock is held by another provider and no takeover was granted |
| `invalid_resume` | Resume token/session is invalid for the current ownership state |
| `not_lock_owner` | Legacy capability only: ownership-changing operation attempted by a non-owner provider |
| `duplicate_controller_id` | Lockless admission found the same instance ID already live |
| `controller_capacity` | All admitted-controller entries are live and the advertised bound is full |
| `pane_capacity` | Pane-creating prospective live count exceeds the advertised admission cap |
| `surface_state_capacity` | Exact prospective serialized surface base bytes exceed the advertised bound |
| `pane_state_capacity` | Exact prospective pane/annotation recoverable bytes exceed an advertised bound |
| `tombstone_capacity` | Admission, migration, restart, or configuration retained-tombstone aggregate exceeds the advertised shared byte bound; never returned by valid close |
| `not_paired` | Operation attempted before successful pair |
| `invalid_payload` | JSON shape/type invalid |
| `invalid_request_id_reuse` | Duplicate request ID with different payload |
| `invalid_operation` | Operation not permitted in current state (e.g. closing the last pane) |
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
| `1000` + `provider_shutdown` | Controller/provider graceful shutdown. In lockless mode client truth is unchanged and other controllers continue; the historical retained lock meaning is legacy-only. |
| `1000` + `superseded` | Legacy capability only: explicit takeover accepted. |
| `1000` + `relinquished` | Legacy capability only: current owner voluntarily cleared ownership. |
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
1. In lockless mode, a stable asserted `controllerInstanceId` deconflicts live connections and scopes cursors/correlation only. It is not authentication, ownership, permission, priority, quota, or routing authority.
2. A session is bound to an individual admitted socket. Retained same-ID reconnect resumes only the bounded cursor/gap state described in §4.8; there is no owner resume or takeover.
3. No callback token model exists.
4. No watch subscription tokens exist.
5. On explicitly negotiated legacy clients only, the historical `surfaceId + providerId` ownership lock and owner-resume behavior remain in force.

## 10. JSON Schemas (All Message Types)

The schema below defines every v1 application message type over WS.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://clawline.local/specs/surf-ace-ws-v1.schema.json",
  "title": "Surf Ace WS v1 Message",
  "type": "object",
  "oneOf": [
    { "$ref": "#/$defs/SurfacesListRequest" },
    { "$ref": "#/$defs/PairRequest" },
    { "$ref": "#/$defs/RelinquishRequest" },
    { "$ref": "#/$defs/ContentSetRequest" },
    { "$ref": "#/$defs/ContentAppendRequest" },
    { "$ref": "#/$defs/ContentPatchRequest" },
    { "$ref": "#/$defs/ContentClearRequest" },
    { "$ref": "#/$defs/AnnotationsRemoveRequest" },
    { "$ref": "#/$defs/SnapshotGetRequest" },
    { "$ref": "#/$defs/HeartbeatPingRequest" },

    { "$ref": "#/$defs/SurfacesListResponse" },
    { "$ref": "#/$defs/PairResponse" },
    { "$ref": "#/$defs/RelinquishResponse" },
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
    { "$ref": "#/$defs/PaneRenamedEvent" }
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
      "description": "Visible pane label assigned by the client-local authority. Distinct from internal paneId and used for human-facing pane identity.",
      "type": "integer",
      "minimum": 1
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
        "event.pane_renamed"
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
            "not_lock_owner",
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
                "required": ["surfaceId", "name", "viewport", "paired"],
                "properties": {
                  "surfaceId": { "$ref": "#/$defs/SurfaceId" },
                  "name": { "type": "string" },
                  "viewport": { "$ref": "#/$defs/SurfaceViewport" },
                  "paired": { "type": "boolean", "description": "Legacy capability ownership status only. Lockless admission is reported through negotiated capability/controller state." }
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
          "required": ["connectionId", "protocolVersion", "surfaceId"],
          "properties": {
            "controllerInstanceId": { "type": "string", "minLength": 1, "description": "Required for lockless capability. Stable opaque asserted instance identity; never an authority principal." },
            "providerId": { "$ref": "#/$defs/ProviderId", "description": "Legacy capability ownership identity only." },
            "connectionId": { "$ref": "#/$defs/ConnectionId" },
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "windowLabel": { "type": "string", "minLength": 1, "description": "Legacy capability bootstrap only; lockless labels are client allocated." },
            "initialPaneId": { "$ref": "#/$defs/PaneId", "description": "Legacy capability bootstrap only." },
            "initialPaneLabel": { "$ref": "#/$defs/PaneLabel", "description": "Legacy capability bootstrap only." },
            "friendlyChatName": { "type": "string", "description": "Human-facing provenance metadata only." },
            "providerName": { "type": "string", "description": "Human-facing provider/product provenance and diagnostics only; never identity or authority." },
            "protocolVersion": { "const": 1 },
            "takeover": { "type": "boolean", "description": "Legacy capability ownership transfer only; prohibited in lockless mode." },
            "eventProfile": { "$ref": "#/$defs/EventProfile" },
            "drawingFlushConfig": { "$ref": "#/$defs/DrawingFlushConfig" },
            "resume": {
              "type": "object",
              "additionalProperties": false,
              "required": ["sessionId"],
              "properties": {
                "sessionId": { "$ref": "#/$defs/SessionId" }
              }
            }
          }
        }
      }
    },
    "RelinquishRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "sentAt"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "request" },
        "op": { "const": "ownership.relinquish" },
        "id": { "$ref": "#/$defs/RequestId" },
        "sentAt": { "$ref": "#/$defs/EpochMs" }
      }
    },
    "RelinquishResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "op", "id", "ok", "sentAt", "payload"],
      "properties": {
        "v": { "const": 1 },
        "type": { "const": "response" },
        "op": { "const": "ownership.relinquish" },
        "id": { "$ref": "#/$defs/RequestId" },
        "ok": { "const": true },
        "sentAt": { "$ref": "#/$defs/EpochMs" },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["relinquished"],
          "properties": {
            "relinquished": { "const": true }
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
                "historyOwnerToken": { "type": "string", "minLength": 1, "description": "Legacy capability replacement token only; prohibited in lockless mode." },
                "revision": { "$ref": "#/$defs/Revision", "description": "Legacy capability caller revision only; lockless clients allocate the committed revision." },
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
            "includeImage": { "type": "boolean", "default": false },
            "includeVisibleText": { "type": "boolean", "default": true },
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
                "resumeGraceMs": { "type": "integer", "minimum": 5000, "default": 20000, "description": "Legacy capability owner-resume field only." },
                "maxPanesPerSurface": { "type": "integer", "minimum": 1, "description": "Lockless pane-creating admission cap, not a post-restore live-count invariant." },
                "maxSurfaceRecoverableBaseBytes": { "type": "integer", "minimum": 1 },
                "maxPaneRecoverableStateBytes": { "type": "integer", "minimum": 1 },
                "maxPaneAnnotationRestoreBytes": { "type": "integer", "minimum": 1 },
                "maxRetainedTombstones": { "type": "integer", "minimum": 1 },
                "maxRetainedTombstoneBytes": { "type": "integer", "minimum": 1 },
                "maxRecoverableSurfaceBytes": { "type": "integer", "minimum": 1 },
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
            "visibleText": { "type": "string" },
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
          "required": ["surfaceId", "name", "viewport"],
          "properties": {
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "name": { "type": "string" },
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
            "surfaceTombstoneId": { "type": "string", "minLength": 1, "description": "Required for lockless recoverable close." },
            "recoverable": { "type": "boolean", "description": "True for every lockless close." },
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
            },
            "newPaneIds": {
              "type": "array",
              "items": { "$ref": "#/$defs/PaneId" },
              "minItems": 1,
              "uniqueItems": true,
              "description": "Legacy capability only. Lockless clients allocate new pane IDs."
            },
            "newPaneLabels": {
              "type": "array",
              "items": { "$ref": "#/$defs/PaneLabel" },
              "minItems": 1,
              "uniqueItems": true,
              "description": "Legacy capability only. Lockless clients allocate new pane labels."
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
            "recoverable": { "const": true },
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
            "tombstoneId": { "type": "string", "minLength": 1, "description": "Required for lockless recoverable close." },
            "recoverable": { "type": "boolean", "description": "True for every lockless close." },
            "closedSequence": { "type": "integer", "minimum": 1 }
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
Resolution: lockless pair includes stable asserted `controllerInstanceId` plus per-attempt `connectionId`; duplicate live identity is refused deterministically, retained same-ID resume restores only bounded cursor/gap state, and there is no ownership/takeover path. The historical `providerId` ownership resolution applies only to explicitly negotiated legacy clients.

2. Out-of-order or retried content mutations.
Resolution: mandatory monotonic `revision`; strict `expectedRevision` gate; request-ID idempotency cache.

3. Event loss or event flood.
Resolution: event stream is best-effort across reconnect by design; provider must issue `snapshot.get` after reconnect; backpressure coalesces high-rate events and emits `event.snapshot_hint`; drawing flushes are dual-gated (idle + max interval) to bound send frequency.

4. Ghost occupancy after crash.
Resolution: socket loss never clears displayed content or mutates client truth. Lockless clients retain no ownership to release and other admitted controllers continue. The historical retained lock until relinquish/takeover applies only to explicitly negotiated legacy clients.

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
Resolution: `visibleText` and `drawings` are conditional fields governed by request flags (`includeVisibleText` default true, `includeDrawings` default false).

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
2. Default `minimum_deep` profile emits `event.drawing_flush`, `event.tap`, `event.selection`, `event.page`, `event.navigation`, and provider-internal `event.snapshot_hint` without any watch subscription call.
3. Surface flushes drawings only under dual-gate timing (`idleWindowMs` + `maxIntervalMs`) and never flushes unchanged data.
4. Every stroke in `event.drawing_flush` and `snapshot.get` has stable `strokeId` and retains ID stability until explicitly removed.
5. `annotations.remove` removes only requested stroke IDs, reports `removedStrokeIds`/`notFoundStrokeIds`, and preserves all unspecified strokes.
6. Lockless reconnect uses stable controller identity and bounded resume state; socket loss does not mutate client truth or block other admitted controllers. The historical owner-only reconnect/relinquish/takeover rule applies only to explicitly negotiated legacy clients.
7. Revision errors and idempotency replay behave exactly as specified.
8. Visual send indicator is visible while each drawing flush transmission is in-flight.
9. `content.set` and `content.clear` both clear drawing overlay state.
10. Heartbeat pong is emitted within SLA even while render queue is busy.
11. Pair request times out at 10s when `pair.response` is missing.
12. Reconnect path buffers events until snapshot succeeds, then replays in order; on snapshot failure provider reconnects.
13. `snapshot.get` returns base64 PNG for `image` and conditionally includes `visibleText`/`drawings` per request flags.
14. All messages validate against the schema in Section 10.
15. Surf Ace extension skills are present at these provider paths and load successfully:
   - `extensions/surf-ace/skills/surf-ace-ops/SKILL.md` (tool usage for list/push/read/clear/pane ops)
   - `extensions/surf-ace/skills/surf-ace-markup/SKILL.md` (annotation interpretation + markup workflow)
16. Static Surf Ace guidance is delivered only through contributed extension skills or an explicitly contributed system prompt. The extension MUST NOT attach static guidance from `before_prompt_build`, `prependContext`, `prependSystemContext`, or any other per-turn prompt-build hook.

Implementation status: ready for implementation.

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

#### Annotation Context Frame Model (Context-Keyed, Not Session-Keyed)

Annotation data is keyed by **context**, not by annotation session.

A context key is:
- OpenClaw-pushed content: active `contentId`
- HTML user navigation context: normalized URL (fragment stripped, query preserved)
- Non-URL types: `contentId` (or equivalent stable content identity)

**Important invariants:**
1. Scroll alone does **not** create a new context frame.
2. Navigation/content change alone does **not** create a frame.
3. A new frame is created only when annotation actually occurs in that context.
4. Re-entering annotation mode in the same context appends to the same mutable context frame.

Current content readback is separate from annotation frames. A content push updates the local current content snapshot, but does not create a live annotation frame or a closed annotation frame by itself.

**Lifecycle (dual-channel semantics):**
1. On first stroke in a context with no open frame, the client creates/opens the bounded mutable live-frame record.
2. While annotating in that context, `event.drawing_flush` strokes coalesce deterministically by stable stroke ID into that client record and are projected through ordered deltas.
3. Exiting annotation mode via **Done** does **not** force frame finalization by itself; it only pauses live writes. Re-entry in the same context resumes appending to the same frame.
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

The legacy 512-entry taps cap and next-read `overflowed` boolean do not apply in lockless mode. Each record/live-frame ingress transaction applies declared coalescing, computes exact versioned serialized count/bytes, and removes complete oldest records by `consumableSequence` until the advertised scope bounds hold. An oversized candidate or removed unread range creates/extends one bounded sticky client `consumableGap` per affected controller/scope, sends targeted `event.consumable_overflow`, and writes durable diagnostics. Local reads project that gap as structured `consumableLoss`; they cannot invent or erase it.

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

**Writes** either go to the surface over the WS connection (pushing content, clearing content, removing annotations) or, for the explicit legacy-to-lockless cutover preparation action, durably freeze a local migration boundary without network I/O. These are explicit OpenClaw intent.

**Reads** are always local projection transactions. The client owns authoritative bounded consumable scopes, cursor floors, pending truth, and structured gaps. Pair/resume snapshots plus ordered deltas received during OpenClaw's connection job or the standalone CLI's explicit networked invocations keep the controller projection current. An ordinary read returns cached data/loss/status, durably advances the projected cursor and queues an idempotent acknowledgement intent, and never triggers synchronous network I/O. Only client acceptance of the acknowledgement advances authoritative state.

### 14.3 OpenClaw Tool Surface

OpenClaw interacts with surfaces through the tools defined in this section. All screen-scoped tools accept `fingerprint` (the window-surface stable identity, mapped from `surfaceId`) as the primary screen selector. `paneId` is **required** on all pane-scoped calls — OpenClaw resolves human references through `surf_ace_list` (`windowLabel` / `paneLabel`), then specifies the target pane explicitly by internal `paneId`. All pane-aware tool responses echo both the effective internal `paneId` and the visible `paneLabel`.

---

#### `surf_ace_list`

Returns all known screens and their locally cached state. Read-only, local.

**Params:** none

**Returns:** array of screen records:
```
fingerprint       string    Stable screen identity (window-scoped; mapped from `surfaceId`)
windowLabel       string    Client-assigned visible window label (`a`, `b`, `aa`, ...)
name              string    Human-readable screen name
connectionState   enum      "connected" | "connecting" | "unreachable"
lastSeenAt        epochMs   When screen was last seen in mDNS or active
viewport          object    { width, height, scale }
panes             array     Full current pane topology: [{ paneId, name, activeContent, historySummary }]
                          Each pane record also includes `paneLabel`, the visible human-facing pane identifier.
                          activeContent: { contentId, contentType, revision } or null if idle
                          historySummary: { visibleContentId, backCount, forwardCount }
pendingEvents     int       Count of buffered events not yet read by OpenClaw
```

**Errors:** none (always returns current known local state, possibly empty array)

---

#### `surf_ace_authority_diagnostics`

Returns the local projection of client-authored admission, capability, revision, topology, lifecycle, capacity, cursor/gap, and cache-health truth used to decide which surfaces are actionable. Read-only and local. Legacy clients may additionally expose legacy provider authority.

**Params:** none

**Returns:** a diagnostic record containing persisted/live surfaces, runtime snapshot IDs, target/window records, pane and surface tombstones, pane counters, lockless capability/limits, admitted/dormant controller IDs and retention state, cursor/gap/cache health, blocked surface IDs/reasons, and runtime process state. Legacy mode may additionally report provider ownership diagnostics.

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
paneLabel      integer  Visible label of the target pane
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

**Behavior:** The controller requests a `native_app` target for a stable pane; the client validates/commits the pane content intent and projects client-resolved pane geometry to the compositor. Evidence must make launch readiness checkable: target app identity, args, pane geometry identity, client admission/revision tuple, host/overlay application state, and compositor lifecycle/input/focus diagnostics. Runtime binding readiness is not controller authority and cannot become ownership/takeover behavior. The compositor receives resolved native-host and overlay regions and must not infer layout intent from controller payload. Without `confirmed:true`, an admitted/actionable pane, trusted runtime app binding, or `target.native_app.v1`, the operation fails closed and does not launch a process.

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
paneLabel      integer
revision       int      Revision after clear
```

**Errors:** `not_connected`, `screen_not_found`

---

#### `surf_ace_reattempt_connections`

Operator-scoped control tool that resets open Surf Ace connection circuits and reattempts stopped reconnect/probe workers. In lockless mode it only wakes identity/capacity-eligible connection work and grants no right or priority. Legacy mode retains its ownership constraints. Write.

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

**Behavior:** The controller sends split intent and `expectedTopologyRevision`. The client performs stale/capacity checks, allocates new internal `paneId` and visible `paneLabel` values, commits atomically, and returns the authoritative result.

**Returns:** array of pane records:
```
paneId         integer  Effective pane id after the split. Includes the source pane and each newly created pane.
paneLabel      integer  Visible pane label for that pane.
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

**Behavior:** The controller submits intent with `expectedTopologyRevision`; the client verifies the revision at execution time, validates omitted-pane destruction intent and CAP bounds, allocates any new internal pane IDs/labels, and commits one atomic topology result. Existing identity is preserved only for desired leaves that keep an existing stable `paneId`, plus the non-root shorthand where `{ target: { paneId }, desired: { type: "pane" } }` preserves that target pane.

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

**Behavior:** The controller submits pane/lifecycle intent through the same client-owned revision seams as `surf_ace_realize_topology`. For `openWindow` and `closeWindow`, the controller supplies the current endpoint/surface revisions; the client performs identity-independent open or recoverable close. Content pushes remain pane-scoped.

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
paneLabel      integer  Closed pane's visible label at the moment it was closed.
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
paneLabel         integer  Visible label for the pane returned by the provider

// Local current content readback
contentSnapshot   object?  Current cached pane content, or null if none is locally cached.
	                           {
	                             cachedAt      epochMs
	                             content?      object|string
	                             contentId     string?
	                             contentType   string?
                             revision      int
                             viewport      object
                             visibleText?  string
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

// Legacy-mode migration-read proof; omitted in lockless mode
legacyCompatibilityReadBoundary object? {
  schemaVersion                    1
  endpointId                       string
  surfaceId                        string
  paneInventorySha256              string
  requiredPaneIds                  string[]  Canonically sorted complete pane set.
  completedPaneIds                 string[]  Canonically sorted panes with no compatibility-readable pending material after durable consumption.
  panePostReadSha256               object    Map from completed pane id to canonical post-read source SHA-256.
  complete                         bool      True only when completedPaneIds exactly equals requiredPaneIds.
  compatibilityReadBoundarySha256 string    SHA-256 of the canonical fields above, excluding this digest.
}
```

**Read priority + dedupe contract:**
- OpenClaw should use `contentSnapshot` for current content readback after pushes.
- OpenClaw should interpret `liveFrame` first when present (newest/live).
- OpenClaw should process `frames[]` oldest-first for guaranteed context-preserved delivery.
- If new live dirty data appears while processing backlog, OpenClaw should pause backlog and return to live.
- Closed frames should still be processed even when some strokes were already seen live (frame image/context is authoritative).
- A stroke may appear in both channels; dedupe by `strokeId` per `frameId`/`contextKey`.

**Errors:** `screen_not_found`, `migration_already_prepared`

`surf_ace_read` may be called regardless of connection state. It never synchronously repairs the cache; an unsynchronized projection returns explicit `cacheStatus` with available data and schedules background repair.

In legacy mode, the read's consumptive update and
`legacyCompatibilityReadBoundary` update are one durable transaction. When a
non-complete migration transaction exists for the surface,
`migration_already_prepared` returns before consumption so prepared material
cannot later be consumed and replayed.

**Migration notes (frame-queue-only → dual-channel):**
- Existing callers that only read `frames[]` continue to work unchanged.
- New callers should also inspect `liveFrame`/`liveDirtyStrokeIds` for near-real-time response while annotation is active.
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
  windowLabel       string
  paneId            string
  paneLabel         integer
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

**Note (dual-channel frame model):** In the dual-channel model, rendered strokes persist until the provider explicitly removes them or content changes under the normal content rules. The underlying context frame may remain open and continue on later same-context re-entry (§13.2). Closed frames in the queue are immutable records and cannot be modified via this tool. `surf_ace_annotations_remove` only affects strokes currently rendered in the live annotation overlay. For most OpenClaw workflows, this tool is used to remove strokes from in-progress interaction (e.g., erasing a scratch-out gesture mid-session). Post-finalization frame handling is done at OpenClaw interpretation time (dedupe/ignore/act), not by mutating closed frames.

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

Each pane is assigned by the client-local authority a stable visible numeric `paneLabel` distinct from its internal `paneId`. `paneLabel` is the user-facing pane identifier and live-topology secondary key within the authoritative live projection; it is not durable target authority. Controllers adopt the client-assigned label. Optional pane names do not replace it. The pane label MUST be:
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

Connection state MUST be expressed only through the window ID outline/text in the bottom-right identity overlay. The app MUST NOT render a separate full-width bottom connection bar or strip.

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

- **Window Letter Labels** — "Window labels (a, b, c…) are allocated and uniquely projected by the client-local authority." Source: §3.1.1
- **Pane Name Authority** — "Pane names are optional extension-assigned metadata. They do not replace `paneLabel` as the visible identity token." Source: §3.1.1
- **Pane Label Authority** — "Pane labels are client-assigned visible numeric identifiers distinct from internal `paneId`." Source: §3.1.1
- **Prominent Surface Labels** — "Window label and pane label render together as an always-visible bottom-right identity overlay in each pane." Source: §3.1.1 / §15.1
- **Displayed Content Persistence** — "The surface renders content and keeps it displayed until OpenClaw explicitly changes it." Source: §1
- **Visible Back/Forward Behavior** — "The newly targeted content becomes front/visible immediately in that pane." Source: §6.1.1
- **History Navigation Controls** — "Previously visible content in that pane remains navigable through the surface's Back/Forward controls." Source: §6.1.1
- **Floating History Controls** — "Back/Forward controls appear in the left navigation pill when history exists." Source: §6.1.1 / §15.3
- **Disabled History Controls** — "Disabled Back/Forward controls SHOULD render at 40% opacity and SHOULD NOT show hover affordances." Source: §6.1.1 / §15.3
- **No History Counters** — "v1 SHOULD NOT display history depth counters." Source: §6.1.1 / §15.3
- **Degraded Restore Safety** — "The surface MUST still show that state's content payload when available, clear the overlay for safety." Source: §6.1.1
- **Restore Failure UI** — "The surface SHOULD show a non-blocking toast plus a warning icon in the bottom controls." Source: §6.1.1 / §15.4
- **Connection State Indicator** — "Connection state is expressed only through the window ID outline/text color in the bottom-right identity overlay." Source: §4.5 / §15.7
- **Connected State UI** — "Connected — green window ID outline/text." Source: §4.5 / §15.7
- **Connecting State UI** — "Connecting / reconnecting — yellow window ID outline/text." Source: §4.5 / §15.7
- **Disconnected State UI** — "Disconnected — red window ID outline/text." Source: §4.5 / §15.7
- **Window Label Placement** — "Window label precedes pane number in the bottom-right identity overlay." Source: §15.1
- **Window Label Visibility** — "Always visible as the window box preceding each pane number; never hidden by pointer/touch movement, content, connection state, or annotation mode." Source: §15.1
- **Primary Addressing Handle** — "The window label is the primary addressing handle. It MUST be visible when the surface is at rest." Source: §15.1
- **Pane Label Placement** — "Large floating translucent overlay in the bottom-right of the pane content area." Source: §15.1
- **Pane Label Visibility** — "Always visible as plain translucent bottom-right overlay text; never hidden by pointer/touch movement." Source: §15.1
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
- **Legacy Canvas Presentation** — "The surface renders a blank or gridded background." Source: §A.9
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

Acceptance tests MUST cover both Electron and iOS: one snapshot revision produces content viewport, controls/chrome, overlay/hit regions, materialization geometry, and protocol viewport for that pane.

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

**Decision:** Multi-scroll behavior is handled by the dual-channel context model. Because annotation mode locks the viewport (see §15.6 "While IN annotation mode"), scrolling cannot occur while actively drawing. If a user annotates at scroll position A, exits annotation mode, scrolls, and re-enters annotation in the **same context**, strokes append to the same context frame (not a new context frame). If annotation resumes only after a true context switch (e.g., different URL/content context and annotation starts there), the previous context frame is finalized and the new context gets its own frame.

OpenClaw may therefore receive either one evolving context frame (same context, multiple annotation sessions) or multiple finalized frames (annotation across distinct contexts). `scrollOffset` at frame open remains the reference anchor for mapping to document-space.

---

### A.3 Semantic Gesture Interpretation (Brackets Problem)

**Question:** When a user draws `[` at one position and `]` far below it, their intent is "everything between these brackets." Raw stroke geometry alone cannot convey this — the provider would only see two curved strokes with a large gap. How does the system convey the user's region intent to OpenClaw?

**Related:** Same problem applies to any multi-stroke semantic gesture where the intent spans content between the strokes rather than the strokes themselves.

**Status:** Partially addressed by the capture frame model — full resolution requires on-device gesture classification (A.4).

**With dual-channel context frames:** Bracket strokes and other multi-stroke semantic gestures can be accumulated into one finalized context frame (even across multiple same-context annotation sessions). OpenClaw receives the frame stroke set plus viewport screenshot, reducing partial-geometry ambiguity.

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

**With context-keyed frames:** On-device classification applies naturally **per finalized frame**. At frame finalization time (context-switch boundary, or explicit `content.set`/`content.clear` per A.8), the surface has the complete stroke set for that finalized unit. This is the ideal classification boundary: the model sees full gesture context before delivery. Classification at flush time (mid-session live deltas) would see partial stroke sets and is not recommended. A v2 `semanticHints` field in the frame structure is the right integration point.

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

**Status:** Partially resolved. Coordinate space is settled (viewport coordinates per A.1). In the capture frame model, each frame includes a viewport screenshot — OpenClaw receives the image directly in `surf_ace_read` without needing a separate buffer crop. The region-of-interest question is moot for closed frames (each frame image is already the viewport at capture time). For live/open frame inspection, `snapshot.get` with `includeImage=true` remains available over the WS protocol.

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
3. Same-context annotation re-entry starts a new live frame after the prior session has been explicitly committed.
4. Frame finalization occurs on one of:
   - explicit `event.annotation_committed` from the surface,
   - context switch (different URL/content context with annotation starting there),
   - explicit content replacement/clear (`content.set`/`content.clear`).
5. Timeout-based finalization is not product truth. If a provider keeps a timer temporarily for backward compatibility with older surfaces, it MUST be fallback-only and MUST NOT override an explicit settle signal.

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

**Blank canvas** (`canvas`) — an optional/legacy content type where annotations are the primary artifact and there is no underlying document. The surface renders a blank or gridded background. `content.clear` removes all annotations (same global rule as all content types). In v1, OpenClaw observes user strokes via the existing register model (read-only for the native annotation layer). OpenClaw does not need this content type in order to present draw-capable experiences, because normal HTML/SVG content can already render its own `<canvas>` or similar drawing UI. Dedicated native-overlay annotation writes remain undefined in v1 and would require a future protocol extension. Useful for whiteboard-style collaboration. See the `canvas` characteristics in §6.1.1.

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
- Neither component nor the composite is controller identity, cursor key, routing, authentication, permission, priority, quota, ownership, topology, or restore authority.

**Invariant index entry:**
- **Entry-Bound Composite Provenance** — "The left navigation pill shows the current visible history entry's localized friendly-chat — provider/product composite; Back/Forward updates it from the visible entry and never from connection authority." Source: §15.8
