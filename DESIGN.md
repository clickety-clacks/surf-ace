# Surf Ace Wire Protocol (WebSocket)

Status: Design draft
Depends on: `/Users/mike/shared-workspace/clawline/specs/clawline-invariants.md`

## 1. Purpose and Goals

Surf Ace is a standalone display and annotation system that turns any screen running the Surf Ace app into a CLU-managed surface. It is a purpose-built binary application — not embedded in another app — available on iOS/iPadOS and as an Electron app on macOS, Windows, and Linux.

### Actors

- **CLU** — the AI orchestrator. CLU discovers surfaces, pushes content to them, reads user annotations and events, and interprets surface activity.
- **Surfaces** — screens running the Surf Ace app. A surface is a render target that CLU can address by stable identity. Multiple surfaces can be active simultaneously; CLU manages them independently.
- **Users** — annotators and viewers. On iPad, users draw on content with a stylus (Apple Pencil) or finger. On Electron, users annotate with mouse or trackpad. User interactions are captured and reported to CLU for interpretation.

### Core Goals

1. **CLU-managed surface.** Any screen running the Surf Ace app becomes a surface CLU can push content to and read events from.
2. **Content display.** CLU pushes content to surfaces in the following types: `html`, `image`, `pdf`, `terminal`, `markdown`. `video` and `canvas` remain optional wire-level content types for forward compatibility, but CLU drawing workflows do not depend on them because draw-capable HTML/SVG content already works through normal content updates. The surface renders content and keeps it displayed until CLU explicitly changes it.
3. **User annotation.** Users draw and annotate on displayed content using a stylus (iPad) or input device (Electron). Annotation strokes are captured and reported to CLU.
4. **CLU interpretation.** CLU reads user annotations and interprets them — identifying point-outs, markup gestures, written content, and spatial relationships to the displayed material.
5. **Zero-config discovery.** Surfaces advertise themselves via Bonjour/mDNS (`_surf-ace._tcp`). No manual setup, pairing codes, or configuration is required.
6. **Multi-surface and multi-pane.** CLU can manage multiple surfaces simultaneously. Each surface has a stable identity and independent state. Within a surface, windows can be split into multiple panes, each with independent content and annotation context. CLU can target content and read annotations at the pane level.
7. **Standalone app.** Surf Ace is its own binary on each platform. It is not a plugin, extension, or embedded view inside another application.

### Architecture Overview

All provider↔surface communication runs over a persistent WebSocket connection per surface. The provider (CLU's runtime component managing surface connections) is the WS client; the surface app runs the WS server. There is no REST API. The provider maintains the connection, handles reconnect, and buffers surface state for CLU tool reads.

Key design decisions:
1. Provider initiates the connection (provider is WS client).
2. Surface runs a lightweight WS server (HTTP only for the mandatory upgrade handshake required by RFC 6455).
3. One active provider connection per surface at a time, with automatic reconnect.
4. All operations run over that socket: pair handshake, content push, clear, events, snapshots.
5. No callback URL; no explicit watch mode — event streaming is always on while connected.

## 2. Scope and Non-Goals

### 2.1 In Scope
1. Discovery metadata needed to open the WS connection.
2. WS handshake, pairing, session ownership, reconnect.
3. Wire message contracts for content operations, snapshot operations, and user interaction events.
4. JSON Schema definitions for all message types.

### 2.2 Non-Goals
1. UI design details for surface rendering.
2. CLU prompt orchestration details.
3. Cloud relay transport.

### 2.3 Delivery Phasing

Implementation order is explicitly phased:

**Phase 1 — Surface topology first (before annotations):**
1. Multi-window support (already in protocol).
2. Multi-pane support inside a window (internal `paneId`, visible `paneLabel`, pane split/resize/close lifecycle).
3. Stable read/write targeting by `{surfaceId, paneId}`.
4. **Surface-owned pane history routing** — when multiple CLU sessions target the same pane, the newest `content.set` becomes visible immediately. The previously visible pane content remains navigable via the surface's Back stack, and the displaced session receives a provider-generated `event.content_superseded`.

**Phase 2 — Annotation semantics:**
1. Annotation mode UX lock.
2. Live dirty + closed-frame delivery model.
3. Annotation interpretation workflows.

Constraint: annotation semantics in §§13–14 are normative architecture and may be implemented in parallel, but release/priority gating is: Phase 1 topology work (multi-window + multi-pane targeting) must ship before annotation-priority milestones are considered complete.

**Phase 1 done checklist (must all be true):**
1. A single window can be split into multiple panes, each with stable internal `paneId` and stable visible `paneLabel`.
2. Pane lifecycle exists: create/split, resize, rename, close.
3. All screen-scoped tool operations can target `{surfaceId, paneId}` after resolving human references through `surf_ace_list`.
4. **`paneId` is required** on all pane-scoped tool calls. CLU MUST always specify which pane it is targeting once it has resolved the intended pane from `windowLabel` / `paneLabel`. There is no default-pane fallback.
5. `surfaces.list` (or equivalent pane-aware listing) can enumerate panes and active content per pane.
6. Content operations are isolated per pane (push/clear in pane A does not mutate pane B).
7. Ownership lock semantics are defined at the window/surface level (`surfaceId`), with pane routing handled inside the lock owner's paired session.
8. At least one iOS and one Electron implementation pass topology tests for pane isolation and routing.
9. History model is active: `content.set` makes content immediately visible (single-visible-owner). Prior visible content enters a per-pane Back stack (max 20, LRU eviction). Surface provides Back/Forward navigation. `event.content_superseded` is provider-generated when a new session displaces visible content.
10. Annotation reads are pane-scoped at the CLU boundary; any finer-grained history bookkeeping needed for Back/Forward restore is implementation-internal to the surface/provider.

Only after these are true do annotation-priority implementation tasks move to Phase 2.

### 2.4 Extension Architecture

Surf Ace is implemented as its own extension (`extensions/surf-ace/`) within the same monorepo as Clawline. The two extensions are peers — neither imports from the other.

Rules:
1. `extensions/surf-ace/` has no imports from `extensions/clawline/` and vice versa.
2. Any functionality needed by both goes through core internals (`src/`) or a shared utility module, not through cross-extension imports.
3. Surf Ace has its own `openclaw.plugin.json` manifest and registers its own tools and services independently.
4. This boundary is enforced to prevent cross-project leakage and to keep extraction to a true standalone plugin clean if that becomes necessary.
5. Both extensions benefit from monorepo-level access to core internals (`src/`) while this boundary is maintained.

Ownership: `extensions/surf-ace/` owns the Surf Ace provider runtime — mDNS discovery, WS connection management, local state buffers, and all `surf_ace_*` CLU tools. The corresponding surface-side core module (if needed) lives in `src/surf-ace/`. Neither Clawline nor any other extension imports from these paths.

## 2a. Concepts

Before the protocol details, these terms are used consistently throughout this spec:

**Surface** — a render-target context addressable by stable identity. In v1 multi-window topology, each window is a distinct surface (`surfaceId`) even when hosted by one app instance/device endpoint.

**Window label** — the provider-assigned user-visible identifier for a surface window (`a`, `b`, `aa`, ...). `windowLabel` is distinct from `surfaceId`.

**Pane** — a rendering scope nested inside a surface window. Each pane has a stable internal identity (`paneId`) and a separate stable visible identity (`paneLabel`).

**Pane label** — the provider-assigned user-visible identifier for a pane (`1`, `2`, `3`, ...). `paneLabel` is distinct from `paneId`.

**Endpoint** — the app/device WS host:port advertised via mDNS. One endpoint may host multiple surfaces (windows).

**Provider** — the Clawline server-side component that manages connections to surfaces. It is the WS client and reconnect owner. It maintains local state for each surface.

**Content** — the item currently displayed in a rendering scope. Content has a type (`html`, `image`, `pdf`, `terminal`, `markdown`, `video`, `canvas`) and a stable payload identity (`contentId`). A window always has one or more panes. Each pane displays one content item independently (scoped internally by `paneId`, displayed to humans via `paneLabel`). CLU pushes content to a target scope and can clear it. Content is distinct from annotations. `video` and `canvas` remain optional protocol content types for forward compatibility; draw-capable CLU workflows can already use normal HTML/SVG content without depending on a dedicated `canvas` wire feature.

**Annotations** — drawing strokes the user has made on top of the current content using the stylus or finger. Annotations are layered over content and persist until the provider explicitly removes them. Annotations are not content and are not cleared when content changes unless the spec says so.

**Event** — a user interaction reported by the surface to the provider over the WS socket (drawing flush, tap, selection, page turn, navigation, scroll, snapshot hint). Events are buffered locally by the provider.

**Local buffer** — the provider's in-memory store of events and annotation state for each surface. CLU reads from this buffer only; it never triggers live network calls to a surface for reads.

**Connection job** — the provider's per-surface background process that maintains the WS connection, runs the pair handshake, handles reconnect, and syncs local state. Fully opaque to CLU.

**Pane history** — the surface-managed Back/Forward model for a pane. The currently visible content is always the front entry for that pane. When new content is targeted to the pane, it becomes visible immediately and prior pane content remains navigable via Back/Forward. History data structures and identifiers are implementation-internal to the surface/provider. Max depth: 20 entries per pane; oldest entry evicted first. Navigating Back then receiving a new push truncates the Forward branch.

## Core Invariants

These are normative, settled statements about Surf Ace behavior. Implementations MUST conform to every invariant listed here. These statements are not subject to the open topics in `## Open Topics`.

1. **WebSocket-only transport.** All provider↔surface communication runs over a persistent WebSocket connection. The provider is the WS client; the surface app runs the WS server. There is no REST API.
2. **One ownership lock per surface.** Each surface is either unlocked or locked to exactly one `providerId`. While locked, only the lock owner may pair or resume normally; other providers are rejected with `busy` unless they explicitly request a user-directed takeover.
3. **Content persistence through reconnect.** Connection state MUST NOT affect displayed content or release ownership. Content is never cleared by a disconnect, restart, relinquish, or takeover. Ownership lock changes only through explicit relinquish or explicit takeover; content changes only when CLU explicitly calls `content.set` or `content.clear`.
4. **Reads are local-only.** CLU reads exclusively from the provider's local buffer. No `surf_ace_*` read operation triggers a live network call to a surface.
5. **Panes are always present.** Every surface window has one or more panes at all times. There are no separate "single-pane mode" and "multi-pane mode" — pane routing is always active. Each pane has a stable internal `paneId` and a stable visible `paneLabel`. CLU resolves human references through `surf_ace_list` using `windowLabel` / `paneLabel`, then targets the pane explicitly by `paneId`. Keyboard focus is a local input affordance only; it does not create default-pane routing or default-pane resolution.
6. **Single-visible-owner with history.** Each pane shows one piece of content at a time (the most recent `content.set`). Prior content enters the Back stack. The user can navigate Back/Forward. Subsequent pushes from the same session update the current view in-place. A push from a different session displaces the current view (supersede).
7. **Provider-injected session identity.** `sessionId` is injected by the provider from the authenticated WS session context. CLU MUST NOT pass `sessionId` as a wire field on any operation. Surface implementations MUST NOT accept `sessionId` from the wire payload.
8. **Always-on event streaming.** Once paired, the surface emits events continuously. There is no subscribe/unsubscribe API — event streaming is always on while connected.
9. **Annotation mode locks the viewport.** When annotation mode is active, scroll is disabled and link following is disabled. The drawing layer captures all touch and stylus input until annotation mode exits.
10. **Monotonic revision gate.** Content mutations (`content.set`, `content.clear`, `content.append`, `content.patch`) carry a monotonic `revision`. The surface applies mutations only when `revision == currentRevision + 1`. Out-of-order mutations are rejected with `stale_revision`.
11. **Annotation reads are pane-scoped at the CLU boundary.** `surf_ace_read` and related CLU-facing operations target a pane only. Surfaces/providers may keep any additional history restore state internally, but CLU does not pass or track history identifiers.
12. **Lifecycle events are always-on.** Surface lifecycle events (`event.surface_appeared`, `event.surface_removed`, `event.surface_resumed`) and pane lifecycle events (`event.pane_created`, `event.pane_removed`, `event.pane_renamed`) are never profile-gated. They fire regardless of `eventProfile` setting and do not appear in `pair.response.eventConfig.activeEvents`. `event.content_superseded` is provider-generated (not a surface wire event).
13. **Platform target floor policy.** Surf Ace targets the newest released OS major version as the minimum deployment target (current decision: iOS/iPadOS 26 and macOS 26 for native surface builds).
14. **Portable extension packaging.** Surf Ace MUST remain installable as a standalone OpenClaw extension bundle that can be dropped into any compatible OpenClaw installation (without requiring Clawline as a dependency and without requiring core patches). Any needed wake/routing behavior must be implemented through extension-local code and published SDK surfaces.

## 3. Transport and Discovery

### 3.1 Discovery

Surfaces continue advertising `_surf-ace._tcp` over Bonjour/mDNS.

#### 3.1.1 Multi-Window, Multi-Pane, and History Topology (iPad + Electron)

A single app instance may host multiple surface windows simultaneously. Each window is an independent Surf Ace surface. Within each window, one or more panes provide independent content and annotation contexts. Within each pane, one or more history entries allow multiple CLU sessions to coexist without overwriting each other.

**Topology hierarchy:** Surface (`surfaceId`) → Window (`windowLabel`) → Pane (`paneId` internal, `paneLabel` visible) → Content (history-stacked)

> **Phasing note:** History navigation is Phase 1 scope — it ships alongside multi-pane topology, before any annotation-semantics work (Phase 2). See §2.3 for the full phasing plan.

Window rules:
1. Each window has its own stable `surfaceId` and independent local state (capture frame queue, taps, selection, scroll, etc.).
2. The app advertises one device endpoint over mDNS (one host/port), not one mDNS record per window.
3. Windows are enumerated in-band over WS (`surfaces.list`) and can appear/disappear at runtime (`event.surface_appeared`, `event.surface_removed`).
4. Provider maintains one paired WS session per active window/surface, even when multiple windows share the same device endpoint.
5. Creating/removing a window does not require mDNS rebroadcast; only app endpoint lifecycle affects mDNS advertisement/goodbye.
6. On iPadOS, each Surf Ace scene MUST occupy the full device extent in landscape and portrait. The app MUST opt out of iPad multitasking/Stage Manager compatibility sizing when needed so the system does not hand Surf Ace a narrow letterboxed or resized scene. Reported viewport, visible content, pane geometry, and chrome must all derive from the same full-size scene.

Pane rules (Phase 1 committed work, see §2.3):
1. Each window may contain one or more panes, each with a stable internal numeric `paneId` and a stable visible numeric `paneLabel`.
2. `paneId` is the internal routing key. `paneLabel` is the user-visible addressing token shown on the surface.
3. Each pane has independent content, capture frame queue, taps, selection, scroll, and annotation state.
4. All screen-scoped CLU tools target `{ surfaceId, paneId }`. `paneId` is **required**. CLU first resolves the intended pane from `windowLabel` / `paneLabel` via `surf_ace_list`, then keeps using internal `paneId`.
5. Pane lifecycle (create/split/resize/rename/close) is managed in-band; pane changes do not affect window-level session or mDNS state.

Naming system:
1. **Window labels** (a, b, c … z, aa, ab …) are assigned by the **provider/extension**, not the surface.
2. `windowLabel` allocation is monotonic and provider-owned. It is persisted by `surfaceId`, survives reconnect/remap, and MUST NOT be recycled while the provider's persisted Surf Ace state remains intact. It resets only when that persisted label state is explicitly reset.
3. **Pane IDs** are assigned by the **provider/extension** and sent to the surface in topology commands. They are stable internal routing identifiers. The surface never generates pane IDs independently.
4. **Pane labels** are assigned by the **provider/extension** and are the user-visible pane identifiers. They use a monotonic numeric sequence (`1`, `2`, `3`, ...), are persisted by internal `paneId`, and MUST NOT be recycled while the provider's persisted Surf Ace state remains intact. Closing a pane retires its `paneLabel`; a newly created pane consumes the next label.
5. **Pane names** are assigned by the extension via `pane.rename`. There is no user-facing rename UI. Pane names are optional metadata and MUST NOT replace `paneLabel` as the visible identity or addressing token.
6. The extension is the sole authority on topology and visible labeling. It creates and splits panes by issuing commands over the wire; the surface executes and emits lifecycle events to confirm.
7. When a pane is split, the extension specifies the new pane identities in the request: internal `paneId` plus visible `paneLabel` for each created pane. The surface creates the panes as directed and emits `event.pane_created` for each.
8. **Initial surface state:** A freshly launched surface starts with one window and one pane. The extension assigns the `windowLabel`, initial internal `paneId`, and initial visible `paneLabel`. CLU MUST call `surf_ace_list` before any pane-scoped operation. CLU MUST NOT assume pane topology without reading it first.
9. Labels are displayed on the surface — window label as a centered-top floating overlay, pane label as a bottom-right floating overlay within the pane. See §15.1 for visibility rules.


TXT keys used by WS protocol:

| Key | Type | Example | Notes |
|---|---|---|---|
| `name` | string | `Kitchen Display` | Human-readable label |
| `v` | int | `1` | Protocol major version |
| `w` | int | `1920` | Viewport width (points) |
| `h` | int | `1080` | Viewport height (points) |
| `s` | int | `2` | Scale factor |
| `cap` | int | `31` | Content type bitmask |
| `busy` | `0|1` | `0` | Ownership lock currently held by some provider |
| `pk` | hex8 | `a1b2c3d4` | Device public key fingerprint prefix (endpoint identity only; not used as screen selector in CLU tools) |
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
1. Provider is WS client and reconnect owner.
2. Surface is WS server and session authority.

### 4.2 Ownership Lock Model
1. Each surface has exactly one ownership state: `unlocked`, `locked + connected`, or `locked + disconnected`.
2. In the normal product path, one OpenClaw/provider starts, discovers available surfaces, and claims each desired surface by sending `pair.request`. That provider becomes the lock owner for each claimed `surfaceId`.
3. Ownership is bound to `providerId`, not to transient socket liveness. A dropped socket does not release the lock.
4. While a surface is locked, only the lock owner may hold the active paired socket. Other providers receive `busy` unless they explicitly request takeover.
5. The surface MUST preserve displayed content, pane topology, annotations, and provider-visible state across transitions between `locked + connected` and `locked + disconnected`.
6. `takeover=true` is an explicit ownership-transfer request. Providers MUST NOT use it as routine reconnect or stale-socket recovery.

**Multi-session CLU routing** is settled in v1: the newest `content.set` for a pane becomes visible immediately. If that write comes from a different session than the currently visible pane content, the displaced content remains available through the pane's Back stack and the provider emits `event.content_superseded` locally for the displaced session.

### 4.3 Pair-First Rule

All operations other than `surfaces.list` and `pair.request` are invalid until pairing succeeds.

`surfaces.list` remains the pre-pair discovery operation for multi-window endpoints. It is always allowed, even when a surface is already locked, so providers can discover which surfaces exist and whether ownership is available before attempting to claim them. Pane topology discovery still follows successful pair/resume: once the lock owner is paired, it uses `panes.list` to learn the authoritative pane layout for that surface.

### 4.4 Reconnect, Resume, Relinquish, and Takeover

Provider reconnect policy:
1. Exponential backoff with jitter: 0.5s, 1s, 2s, 4s, 8s, 16s, max 30s.
2. Reconnect uses the same discovered surface address.
3. Normal recovery sends `pair.request` again with the same `providerId` and, when available, `resume.sessionId` from the prior paired session.
4. Providers MUST treat foreign-owner `takeover=true` as a user-directed escalation path, not as standard reconnect logic. Routine owner recovery is always resume/reconnect by the current lock owner.
5. In the normal single-user network model, a provider that can identify the surface as previously self-owned MAY perform an automatic self-reclaim with the same stable `providerId` when the surface is reachable but returns `busy` or rejects a stale resume session. Self-reclaim is not provider-id rotation and is not a silent foreign takeover; it is recovery of the provider's own stale/orphaned lock.
6. If the provider cannot classify the busy lock as self-owned, it MUST NOT silently reclaim it. Busy owned by an unknown or different provider remains an explicit operator reclaim/relinquish scenario.

Surface ownership behavior:
1. On any disconnect (abnormal or normal close), the surface keeps displayed content, pane topology, annotations, and ownership lock intact indefinitely. Socket death does not free the surface for another provider.
2. Only the lock owner may reconnect and resume normal control without takeover. A successful owner resume restores the active session and MAY emit `event.surface_resumed`.
3. A different provider connecting without `takeover=true` receives `busy` while the lock is held, regardless of whether the owner socket is currently live.
4. A different provider connecting with `takeover=true` is requesting explicit ownership transfer. The surface MUST treat this as exceptional control transfer, not routine recovery semantics.
5. On accepted takeover or self-reclaim, the surface transfers the lock to the requesting stable `providerId`, closes any still-live old owner socket with `1000` reason `superseded`, and preserves displayed content/state until the owner changes it.
6. On accepted `ownership.relinquish`, the surface clears the lock immediately, preserves displayed content/state, and becomes available for a later fresh claim by any provider. The relinquishing provider MUST disable its auto-retry loop for that surface after success.

**Invariant: connection state MUST NOT affect displayed content.** Content is never cleared by a disconnect, restart, relinquish, or takeover. Content changes only when CLU explicitly calls `content.set` or `content.clear`. A surface showing content will continue showing that content indefinitely until told otherwise.

### 4.5 Keepalive

Application-level keepalive is required:
1. Provider starts heartbeat only after successful `pair.response`.
2. Provider sends `heartbeat.ping` every 10s.
3. Surface replies with `heartbeat.pong` within 3s.
4. Surface MUST prioritize heartbeat handling above queued frame/render work and MUST NOT queue `heartbeat.pong` behind render/mutation tasks.
5. Missing 2 consecutive pong responses causes provider to close socket and reconnect.

Pair timeout:
1. Provider MUST apply a 10s pairing timeout from WS connection establishment.
2. If no `pair.response` arrives in 10s, provider closes socket and enters reconnect backoff.

**Surface UI connectivity indicator (required):**
The surface MUST display a persistent visual indicator of connection state via the connection state bar (§15.7). Required behavior:
- Connected — green: render the persistent 2px connection state bar as a solid green line.
- Connecting / reconnecting — yellow: render the same bar in the warning state with the animated sweep defined in §15.7.
- Disconnected — red: render the same bar as a solid red line.
Content is never cleared by any of these states (see §4.4 invariant).

### 4.6 iOS / iPadOS Background Behavior
1. When the app backgrounds, the OS may suspend or terminate the WS socket. The surface MUST keep the ownership lock, displayed content, pane state, and provider-visible registers intact.
2. On foreground return, the lock owner reconnects and resumes using the normal owner-reconnect path (§4.4).
3. If the prior socket is gone, the surface still treats the same `providerId` as the owner. Another provider may not claim the surface unless the owner relinquishes or a user-directed takeover occurs.
4. If the surface app process itself restarts, it SHOULD restore persisted ownership metadata when available so the lock still reflects the prior owner; if persistence is unavailable, the implementation MUST document that restart as a lock-loss boundary.

### 4.7 Runtime Window Lifecycle (Multi-Window Endpoints)

When a user opens or closes windows on iPad/Electron, surface availability changes without endpoint change.

Rules:
1. On window create, surface emits `event.surface_appeared` with `{ surfaceId, name, viewport }` on any active provider socket for that endpoint.
2. On window close, surface emits `event.surface_removed` with `{ surfaceId }` and closes any paired socket for that surface.
3. Provider may call `surfaces.list` at any time to reconcile active windows.
4. Window lifecycle changes are in-band WS signals; they do not require mDNS rebroadcast.
5. Surface identity is window-scoped and stable across app restarts when restoration metadata exists; otherwise new windows receive new `surfaceId`s.
6. `event.surface_appeared` and `event.surface_removed` are **not profile-gated** — they are always emitted regardless of `eventProfile` setting. Providers MUST handle these events on any active socket.

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
1. Provider is the only writer of content state.
2. Mutating content operations (`content.set`, `content.append`, `content.patch`, `content.clear`) carry monotonic `revision`.
3. Surface applies mutation only when `revision == currentRevision + 1`.
4. Revision mismatch returns `stale_revision` with `expectedRevision`.
5. This revision gate is the single mutation seam for content state.
6. Drawing overlay mutations are provider-controlled through `annotations.remove`; surface never autonomously deletes strokes.

### 5.5 Size Limits

Surface advertises limits in `pair.response`:
1. `maxMessageBytes` (default 12 MiB).
2. `maxFrameBytes` (default 10 MiB for `content.set` content payload).
3. `maxVisibleTextBytes` (default 4096).
4. `maxStrokePointsPerFlush` (default 8192 for `event.drawing_flush`).
5. `maxDrawingFlushBytes` (default 2 MiB).

Requests above limit return `content_too_large`; severe violations may close socket with code `4413`.
Severe violation threshold:
1. Message size > 2x `maxMessageBytes`, or
2. 3+ `content_too_large` responses on one connection within 60s.

## 6. Operations

### 6.0 Surfaces List (Multi-Window Discovery)

`surfaces.list` is an endpoint-scoped request that may be called before pairing. It returns currently active window surfaces on the endpoint.

Rules:
1. Provider MAY call `surfaces.list` immediately after WS connect.
2. Response contains `{ surfaceId, name, viewport, paired }[]`. `paired: true` means the surface currently has an ownership lock, whether or not the owner's socket is currently live. `paired: false` means the surface is unlocked and available to be claimed.
3. `surfaces.list` is discovery-only. It allows any provider to learn what windows exist and whether they appear locked, but it does not grant pane control or topology mutation rights.
4. When `paired: false`, any provider may send `pair.request` to claim the surface.
5. When `paired: true`, only the current lock owner may pair/resume normally. Other providers require explicit `takeover=true`.
6. Full pane topology discovery still happens after successful pair/resume via `panes.list`; pre-pair callers do not receive pane state from `surfaces.list`.

### 6.1 Pair Handshake

Flow:
1. Provider opens WS.
2. Provider may call `surfaces.list` to discover available surfaces.
3. Provider sends `pair.request`.
4. Surface replies `pair.response` (success or error). Success means one of: fresh claim of an unlocked surface, resume by the existing lock owner, or explicit takeover accepted.
5. If success, connection enters active mode and event streaming starts immediately.

`pair.request` fields include:
1. `providerId` (stable ownership identity).
2. `connectionId` (unique per socket attempt).
3. `surfaceId` (target window surface on multi-window endpoints).
4. `resume` (optional prior `sessionId`, owner-only reconnect path).
5. `takeover` (optional bool, explicit ownership transfer request; MUST only be used for user-directed takeover, not routine recovery).
6. `providerName` (required human-readable session/chat label for UI indicators). Surfaces MUST reject `pair.request` with `missing_provider_name` if absent.
7. `eventProfile` (optional, default `minimum_deep`).
8. `drawingFlushConfig` (optional, provider-preferred idle/max interval values).
9. `windowLabel` (required provider-assigned window label for this surface bootstrap).
10. `initialPaneId` (required provider-assigned initial pane id for this surface bootstrap).
11. `initialPaneLabel` (required provider-assigned initial visible pane label for this surface bootstrap).
12. `protocolVersion` (`1` for this spec).

`pair.response` success includes:
1. `sessionId`.
2. `resumed` boolean.
3. Surface metadata (id/name/viewport/capabilities).
4. `eventConfig` (active event profile, active event list, and effective drawing flush config).
5. Limits.
6. Current pane state summary (`panes[]` with per-pane `paneId`, `paneLabel`, `currentContentId`, `currentRevision`, and `contentType`).

### 6.1.1 Ownership, Pane Lifecycle, and History Operations (Phase 1)

These operations are post-pair and scoped to a paired `surfaceId`. They implement the ownership model in §4 and the pane topology committed in §2.3 Phase 1 and §3.1.1.

#### `ownership.relinquish`
Voluntarily clears ownership for the currently paired surface.

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

#### `pane.split`
Splits an existing pane into N panes.

**Request fields:** `paneId` (required — pane to split), `count` (total pane count after split, including the source pane; min 2), `direction` (`horizontal` | `vertical`), `newPaneIds` (required array of extension-assigned internal pane IDs for the newly created panes, length `count - 1`), `newPaneLabels` (required array of extension-assigned visible pane labels for the newly created panes, length `count - 1`).

**Behavior:** The source pane retains its `paneId`, `paneLabel`, and content. The extension specifies the `paneId` and `paneLabel` values for each new pane in the request. The surface creates the panes as directed and emits `event.pane_created` for each.

**Response fields:** `panes` — array of `{ paneId, paneLabel }` for all panes in the window after the split (including existing panes).

#### `pane.rename`
Assigns or clears a name for a pane. This is an **extension-to-surface** operation — the extension names panes. There is no user-facing rename UI on the surface.

**Request fields:** `paneId`, `name` (string or null to clear).

**Response fields:** `paneId`, `name` (new name or null).

**Behavior:** Pane names are display metadata only. They do not replace `paneLabel`. CLU resolves human pane references through `paneLabel` in `surf_ace_list`, then targets the pane by internal `paneId`.

**Surface default affordance:** The surface displays pane names as assigned by the extension. Topology is fully extension-controlled — no user-initiated rename or split UI is provided.


#### `pane.close`
Closes a pane and removes it from the layout.

**Request fields:** `paneId`. Cannot close the last remaining pane in a window (returns `invalid_operation`).

**Response fields:** `paneId` (ack echo), `closedFramesDiscarded` (count of unread closed frames dropped from provider buffer for this pane).


---

**Pane lifecycle events (surface → provider):**
- `event.pane_created` — `{ surfaceId, paneId, paneLabel, parentPaneId (pane that was split, or null if created standalone), fromSplit: bool }`
- `event.pane_removed` — `{ surfaceId, paneId }`
- `event.pane_renamed` — `{ surfaceId, paneId, name }`

These events are always-on (not profile-gated), analogous to `event.surface_appeared`/`event.surface_removed`.

---

#### Surface-owned history behavior

History is fully modeled and owned by the surface. CLU does not list, target, or reason about individual history entries.

These rules are normative for the single-visible-owner history model:
1. `content.set` always targets one pane. The newly targeted content becomes front/visible immediately in that pane.
2. Each `content.set` carries a provider-injected opaque `historyOwnerToken`. Surfaces use this token to decide whether the visible entry should be replaced in place (same token) or pushed onto Back history (different token). CLU never provides this token directly.
3. Previously visible content in that pane remains navigable through the surface's Back/Forward controls, with any Forward branch truncated when a new push arrives after Back navigation.
4. Back/Forward navigation changes only which previously shown pane content is visible. It never changes the `contentId` or `revision` originally written for that content.
5. Back/Forward restores both the content payload and the persisted annotation overlay for the selected pane-history state.
6. If annotation-overlay restoration fails for the selected pane-history state, the surface MUST still show that state's content payload when available, clear the overlay for safety, and emit a degraded-state warning locally. The failure MUST NOT silently show a different pane-history state.
7. The Back stack is capped at 20 pane-history states. When a new state would exceed the limit, the oldest non-visible state is evicted together with any internal restore bookkeeping.
8. `content.append` / `content.patch` remain valid only against the currently visible content in that pane, enforced by `contentId` + `revision`.
9. `content.clear` clears the currently visible content for the targeted pane. Any history bookkeeping needed to preserve older pane states is internal to the surface/provider and not part of the CLU call surface.

**Surface default affordances:**
- Back/Forward controls SHOULD appear in the bottom-center floating control cluster.
- Disabled Back/Forward controls SHOULD render at 40% opacity and SHOULD NOT show hover affordances.
- v1 SHOULD NOT display history depth counters.
- If overlay restoration fails, the surface SHOULD show a non-blocking toast plus a warning icon in the bottom-center floating control cluster.

---

#### `canvas` (v1 reserved, v2 required)
- `content.set` payload is optional: a background specification (`{ color, grid }`) or empty.
- There is no underlying document — annotations are the primary artifact, not an overlay.
- `visibleText` in snapshot is always empty.
- Navigation events do not fire (no URLs, no links).
- `content.clear` clears the background spec and ALL annotations (same global rule as all content types).
- Scroll and page registers do not apply.
- CLU-originated drawing is v2-only. No v1 wire op exists for provider/model-authored strokes.
- The surface renders a blank (or gridded) background. In v1, users annotate on the canvas and CLU observes those annotations via `surf_ace_read` / `snapshot.get` only.

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

## 7. Always-On Event Delivery

Once paired, surface emits events without any subscribe/unsubscribe API.

### 7.1 Minimum Deep Event Set (Default)

Default event profile is `minimum_deep`.
`minimum_deep` is the smallest set that keeps CLU useful with low noise.

Active events in `minimum_deep`:
1. `event.drawing_flush` - raw strokes accumulated locally and flushed as one batch by flush gate timing.
2. `event.tap` - resolved point-out tap/long-press. UI-navigation taps (link follows, button activations) are excluded from this event; they produce `event.navigation` instead.
3. `event.selection` - semantically complete selection event. In v1 interoperability profile, only `kind:"text"` is guaranteed; `point`/`region` are reserved for v2 unless explicitly negotiated.
4. `event.page` - full PDF page transition state.
5. `event.navigation` - surface navigated away from pushed content (user followed a link or triggered in-page navigation). Carries the new URL and signals that any open capture frame or buffered annotation state should be considered stale relative to the original content. **Applies to `html` content type only.** Surfaces MUST NOT emit `event.navigation` for any other content type (`pdf`, `image`, `markdown`, `terminal`, `canvas`, `video`). If the provider receives a `NavigationEvent` while a non-HTML content type is active, it MUST discard it silently.
6. `event.snapshot_hint` - provider-internal control-plane event (reconnect/backpressure sync). NOT exposed in the CLU register model.

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
4. There is intentionally no short/fast tier. Sending partial annotation batches mid-session would inundate CLU and produce redundant passes. One flush per drawing session is the goal.

Provider interpretation model:
1. CLU decides at interpretation time whether strokes are persistent (leave rendered) or consumed (call `annotations.remove`).
2. No user mode switch is required.
3. Surface is passive: it renders and flushes strokes, and removes only the explicit IDs requested by provider.
4. Canonical consumed example: scratch-out gesture is interpreted by CLU, then CLU calls `annotations.remove` for scratch stroke IDs and separately edits/deletes the scratched content.
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
| `event.snapshot_hint` | Provider-internal control plane | Yes (internal only) | Used for reconnect/backpressure state sync. Not exposed in CLU register model. Appears in `pair.response.eventConfig.activeEvents` (it is profile-controlled, part of `minimum_deep`), but the provider does not surface it to CLU tooling. |
| `event.surface_appeared` | Lifecycle — **not profile-gated** | Always | Emitted on any active socket when a new window appears. Always active regardless of `eventProfile`. Does NOT appear in `pair.response.eventConfig.activeEvents` (which lists only profile-controlled events). |
| `event.surface_removed` | Lifecycle — **not profile-gated** | Always | Emitted when a window closes. Always active regardless of `eventProfile`. Does NOT appear in `pair.response.eventConfig.activeEvents`. |
| `event.surface_resumed` | Lifecycle — **not profile-gated** | Always | Emitted when a surface successfully reconnects after background/resume. Always active regardless of `eventProfile`. Does NOT appear in `pair.response.eventConfig.activeEvents`. |
| `event.pane_created` | Lifecycle — **not profile-gated** | Always | Emitted when a new pane is created (split or standalone). Always active regardless of `eventProfile`. Does NOT appear in `pair.response.eventConfig.activeEvents`. |
| `event.pane_removed` | Lifecycle — **not profile-gated** | Always | Emitted when a pane is closed. Always active regardless of `eventProfile`. Does NOT appear in `activeEvents`. |
| `event.pane_renamed` | Lifecycle — **not profile-gated** | Always | Emitted when a pane name changes. Always active regardless of `eventProfile`. Does NOT appear in `activeEvents`. |
| `event.scroll` | Context-rich but high-volume | No (`deep_plus_scroll` only) | Useful but not strictly required for minimum usefulness. |

Event behavior rules:
1. Events are in-order and reliable while socket is healthy.
2. Events are not replayed across reconnect.
3. After reconnect, provider must request `snapshot.get` before acting on new events.
4. Provider MUST buffer events that arrive while this mandatory `snapshot.get` is in-flight.
5. Provider event buffer during snapshot is bounded to 128 events. On overflow, oldest events are dropped and provider emits a local warning.
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
| `busy` | Surface ownership lock is held by another provider and no takeover was granted |
| `invalid_resume` | Resume token/session is invalid for the current ownership state |
| `not_lock_owner` | Ownership-changing operation attempted by a non-owner provider |
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
| `1000` + `provider_shutdown` | Provider-initiated graceful shutdown. Content is preserved indefinitely and the ownership lock remains with the same `providerId` until explicit relinquish or explicit takeover. |
| `1000` + `superseded` | Explicit takeover accepted. Prior owner socket closed; displayed content preserved. New owner decides what to show next. |
| `1000` + `relinquished` | Current owner voluntarily cleared ownership. Surface becomes claimable without clearing displayed content. |
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

### 9.4 Session and Ownership
1. Ownership lock is bound to `surfaceId` + `providerId` and survives socket loss until explicit relinquish or explicit takeover.
2. Session is bound to an individual paired socket and may be resumed only by the current lock owner.
3. No callback token model exists.
4. No watch subscription tokens exist.

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
      "description": "Visible pane label assigned by the provider/extension. Distinct from internal paneId and used for human-facing pane identity.",
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
            "stale_content",
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
                  "paired": { "type": "boolean", "description": "true if the surface currently has an ownership lock, whether or not the owner socket is presently live. New providers need explicit takeover while locked." }
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
          "required": ["providerId", "connectionId", "protocolVersion", "surfaceId", "windowLabel", "initialPaneId", "initialPaneLabel"],
          "properties": {
            "providerId": { "$ref": "#/$defs/ProviderId" },
            "connectionId": { "$ref": "#/$defs/ConnectionId" },
            "surfaceId": { "$ref": "#/$defs/SurfaceId" },
            "windowLabel": { "type": "string", "minLength": 1 },
            "initialPaneId": { "$ref": "#/$defs/PaneId" },
            "initialPaneLabel": { "$ref": "#/$defs/PaneLabel" },
            "providerName": { "type": "string" },
            "protocolVersion": { "const": 1 },
            "takeover": { "type": "boolean", "description": "Explicit ownership transfer request. Normal reconnect/resume by the current owner MUST NOT rely on takeover." },
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
              "required": ["paneId", "contentId", "historyOwnerToken", "revision", "contentType", "content"],
              "properties": {
                "paneId": {
                  "$ref": "#/$defs/PaneId",
                  "description": "Target pane. Required — CLU must always specify which pane to target."
                },
                "contentId": { "$ref": "#/$defs/ContentId" },
                "historyOwnerToken": { "type": "string", "minLength": 1 },
                "revision": { "$ref": "#/$defs/Revision" },
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
              "description": "Target pane. Required — CLU must always specify which pane to target."
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
              "description": "Target pane. Required — CLU must always specify which pane to target."
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
              "description": "Target pane. Required — CLU must always specify which pane to target."
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
              "description": "Target pane. Required — CLU must always specify which pane to target."
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
              "description": "Target pane. Required — CLU must always specify which pane to target."
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
                "maxDrawingFlushBytes",
                "resumeGraceMs"
              ],
              "properties": {
                "maxMessageBytes": { "type": "integer", "minimum": 1024 },
                "maxFrameBytes": { "type": "integer", "minimum": 1024 },
                "maxVisibleTextBytes": { "type": "integer", "minimum": 256 },
                "maxStrokePointsPerFlush": { "type": "integer", "minimum": 1 },
                "maxDrawingFlushBytes": { "type": "integer", "minimum": 1024 },
                "resumeGraceMs": { "type": "integer", "minimum": 5000, "default": 20000, "description": "Deprecated compatibility field. Implementations MAY advertise a preferred owner-resume retry budget in ms, but ownership lock itself does not auto-expire; another provider still requires explicit takeover or prior relinquish." }
              }
            },
            "state": {
              "type": "object",
              "additionalProperties": false,
              "required": ["panes"],
              "properties": {
                "panes": {
                  "type": "array",
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
            "surfaceId": { "$ref": "#/$defs/SurfaceId" }
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
          "required": ["paneId", "count", "direction", "newPaneIds", "newPaneLabels"],
          "properties": {
            "paneId": {
              "$ref": "#/$defs/PaneId",
              "description": "Pane to split. Required."
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
              "description": "Extension-assigned pane IDs for the newly created panes. Must contain exactly count - 1 entries."
            },
            "newPaneLabels": {
              "type": "array",
              "items": { "$ref": "#/$defs/PaneLabel" },
              "minItems": 1,
              "uniqueItems": true,
              "description": "Extension-assigned visible pane labels for the newly created panes. Must contain exactly count - 1 entries."
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
          "required": ["paneId", "closedFramesDiscarded"],
          "properties": {
            "paneId": { "$ref": "#/$defs/PaneId" },
            "closedFramesDiscarded": {
              "type": "integer",
              "minimum": 0,
              "description": "Count of unread closed annotation frames dropped from the provider buffer for this pane. CLU can use this to know what was lost."
            }
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
            "paneId": { "$ref": "#/$defs/PaneId" }
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
Resolution: pair handshake includes `providerId` + per-attempt `connectionId`; ownership is bound to `providerId`, not the old socket; owner resume is the normal recovery path; takeover is reserved for explicit control transfer and is not routine stale-socket cleanup.

2. Out-of-order or retried content mutations.
Resolution: mandatory monotonic `revision`; strict `expectedRevision` gate; request-ID idempotency cache.

3. Event loss or event flood.
Resolution: event stream is best-effort across reconnect by design; provider must issue `snapshot.get` after reconnect; backpressure coalesces high-rate events and emits `event.snapshot_hint`; drawing flushes are dual-gated (idle + max interval) to bound send frequency.

4. Ghost occupancy after crash.
Resolution: socket loss does not release ownership. The surface remains locked to the same provider until explicit relinquish or explicit takeover, and displayed content is NEVER cleared by disconnect.

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
Resolution: surface remains passive and non-interpreting; only CLU decides persistent vs consumed drawings and invokes `annotations.remove` when needed.

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
6. Reconnect path allows only the current lock owner to resume normal control; socket loss does not clear content or release ownership, and another provider can gain control only after relinquish or explicit takeover.
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
16. Surf Ace agent-instruction injection is present and wired from these provider paths:
   - `extensions/surf-ace/src/agent-instructions.ts` (builds Surf Ace instruction snippet)
   - `extensions/surf-ace/index.ts` (registers/injects Surf Ace instruction snippet into agent runtime prompt)
   The injected instructions MUST cover event semantics (`event.drawing_flush`, pane lifecycle events, navigation/page/selection handling) so agents can correctly interpret Surf Ace alerts.

Implementation status: ready for implementation.

## 13. Provider → CLU Event Routing

This section specifies how surface events reach CLU. It is intentionally separate from the WS protocol (Sections 3–10), which covers only the provider↔surface channel. The provider↔CLU channel is a different seam with different requirements.

### 13.1 Design Principles

1. **Augmentative, not invasive.** Normal Clawline message dispatch must have zero knowledge of Surf Ace. No Surf Ace logic runs in the inbound message critical path.
2. **Tool-driven.** CLU interacts with surfaces exclusively via explicit tool calls. The provider never injects context into a CLU turn automatically.
3. **Alerts are expensive.** Each alert fires a CLU agent turn. The provider MUST minimize alerts while still ensuring CLU can observe surface activity in a timely way.
4. **No live network I/O in dispatch path.** The provider MUST NOT issue live `snapshot.get` calls (or any network calls to surfaces) as part of processing an inbound CLU message.

### 13.2 Per-Screen Local Buffer (Dual Channel: Live Dirty + Closed Frames + Registers)

The provider maintains a structured local buffer for each surface. The buffer has **two annotation channels** plus typed **non-annotation registers**.

- **Channel A — Live dirty channel (mutable):** near-real-time stroke deltas for the currently active context frame while the user is annotating.
- **Channel B — Closed frame queue (immutable):** finalized context frames that must remain deliverable until CLU consumes them.

CLU reads from this local buffer only; no `surf_ace_read` call triggers a live network call to a surface.

**Buffer scoping:** At the CLU boundary, annotation reads are pane-scoped: `surf_ace_read(fingerprint, paneId)` targets a pane and returns the currently visible annotation state for that pane. Surfaces/providers may keep additional per-history restore data internally so Back/Forward can restore prior content + overlay states, but that bookkeeping is opaque to CLU and not part of the tool API.

---

#### Annotation Context Frame Model (Context-Keyed, Not Session-Keyed)

Annotation data is keyed by **context**, not by annotation session.

A context key is:
- CLU-pushed content: active `contentId`
- HTML user navigation context: normalized URL (fragment stripped, query preserved)
- Non-URL types: `contentId` (or equivalent stable content identity)

**Important invariants:**
1. Scroll alone does **not** create a new context frame.
2. Navigation/content change alone does **not** create a frame.
3. A new frame is created only when annotation actually occurs in that context.
4. Re-entering annotation mode in the same context appends to the same mutable context frame.

**Lifecycle (dual-channel semantics):**
1. On first stroke in a context with no open frame, provider creates/opens a mutable context frame.
2. While annotating in that context, incoming `event.drawing_flush` strokes are appended to that open frame and exposed through the live dirty channel.
3. Exiting annotation mode via **Done** does **not** force frame finalization by itself; it only pauses live writes. Re-entry in the same context resumes appending to the same frame.
4. While annotation mode is active, pane content replacement and user navigation are blocked; there is no visibility switch until the user taps **Done**.
5. After **Done**, any user navigation or explicit content replacement/clear (`content.set` / `content.clear`) is a normal context switch. The provider finalizes the current open frame before applying that switch, then opens/resumes the next context as needed.

Note: This section governs **frame finalization** only. Transport flush/send cadence for `event.drawing_flush` remains governed by Section 7.1 flush-gate timing (`idleWindowMs` / `maxIntervalMs`).

This preserves context-coherent payloads while still allowing CLU to react during active annotation.

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

**Live read semantics:** CLU can repeatedly call `surf_ace_read` during annotation and receive the newest deltas for near-real-time reaction.

---

#### Channel B: Closed Frame Queue (Immutable)

Closed frames are appended to FIFO `frames[]` and remain deliverable until consumed by `surf_ace_read`.

**Batch limits per read:**
1. Max **5** closed frames per read.
2. Pixel budget cap: approximately **4 MB** total encoded image payload across returned closed frames.
3. If next frame would exceed cap, leave it queued and return `pendingFrames`.

Closed frames are consumed-on-read (dequeued immediately after inclusion in response).

---

#### Anti-Dup Semantics Across Channels

The same stroke may appear in both channels:
- first via live dirty updates (Channel A)
- later inside its finalized closed frame (Channel B)

This is intentional. Closed frames are guaranteed context-preserved records and MUST remain deliverable even if CLU already saw live deltas.

**Dedup guidance:** CLU should dedupe by `strokeId` per `frameId` (or per `contextKey` where appropriate). Provider MUST keep stable `strokeId` across live and closed representations.

---

#### Non-Annotation Registers

The following registers handle non-annotation surface events.

**Latest-wins** — Only the most recent value is stored. Overwrites previous on each new event. Cleared on `surf_ace_read`.

**Append** — Values accumulate in arrival order since last read. Cleared on `surf_ace_read`.

| Register | Rule | Type | Description |
|---|---|---|---|
| `scrollPosition` | Latest-wins | object | Latest settled scroll offset and visible rect `{ x, y, visibleRect }`. Cleared on `surf_ace_read`. |
| `selection` | Latest-wins | object? | Current text selection; `null` if none. In v1, surfaces only emit `kind: "text"` selection events. If the provider receives a `kind: "point"` or `kind: "region"` selection from the wire, it MUST discard it and leave this register unchanged. Cleared on `surf_ace_read`. |
| `page` | Latest-wins | object? | Current page state `{ pageNumber, pageCount, pageLabel }`; `null` if not a paged content type. Cleared on `surf_ace_read`. |
| `taps` | Append | array | Ordered list of point-out tap events since last read. UI-navigation taps (link follows, button activations) are NOT included here — they produce `event.navigation` instead. |
| `playbackPosition` | Latest-wins | number? | **Video only.** Current playback position in seconds. `null` for all other content types. Populated by a v2 wire event. In v1, always `null`. |
| `playbackState` | Latest-wins | string? | **Video only.** One of `"playing"`, `"paused"`, `"ended"`. `null` for all other content types. In v1, always `null`. |
| `lastNavigation` | Latest-wins | object? | **HTML only.** Most recent navigation away from CLU-pushed content in the currently addressed pane. `{ url: string, navigatedAt: EpochMs }` or `null`. Populated by `event.navigation`. `navigatedAt` maps from wire `NavigationEvent.sentAt`. Cleared on `surf_ace_read`. |

#### Overflow

The `taps` append register is capped at 512 entries. On overflow, oldest entries are dropped and `overflowed = true` is set on the next `surf_ace_read` response.

### 13.3 Alert Gate (Dual-Channel Activity Gate)

**Alert trigger:** fire an alert when unread annotation activity first appears, from either channel:
- first live-dirty update since last read, or
- first newly queued closed frame since last read.

**Alert text:** `"Surf Ace updates pending on [screen name]"` (optionally include counts: live dirty present + queue depth).

**Alert gate rules:**
1. If `alertFired=false` and new unread annotation activity appears, fire one alert and set `alertFired=true`.
2. While `alertFired=true`, suppress additional alerts for subsequent dirty deltas/frame closures.
3. On `surf_ace_read`, reset `alertFired=false`.

This gives one alert per unread activity burst while still allowing live reads during annotation.

**Alert timeout:** If `alertFired=true` and no `surf_ace_read` arrives within 10 minutes, reset `alertFired=false` so future activity can re-trigger.

**Non-annotation events:** register-only updates do not independently trigger alerts in v1.

### 13.4 CLU Reads the Buffer

CLU uses one read tool:

**`surf_ace_read(fingerprint, paneId)`** — reads live annotation state first, then closed frames (bounded), plus registers, for one pane. `paneId` is required.

Read order and behavior:
1. Return **live channel first** (`liveFrame` + `liveDirtyStrokeIds` + `liveSeq`) if present.
2. Return closed frames from FIFO queue (up to 5 and within ~4 MB image budget).
3. Include `pendingFrames` when queue remains.
4. Clear consumed register values (`taps[]` to `[]`; latest-wins to `null`).
5. Mark current live dirty set as read (`liveDirtyStrokeIds` reset).
6. Dequeue returned closed frames.
7. Reset `alertFired=false`.

CLU should prioritize interpreting `liveFrame` first when present, then process closed frames for guaranteed context-preserved completion.

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
- CLU retrieves payloads via the `surf_ace_read` tool call.

### 13.6 What the Provider MUST NOT Do

- **No live snapshot calls during inbound message handling.** Context injection that requires network round-trips to surfaces is forbidden in the Clawline admission/dispatch path.
- **No automatic context enrichment.** Provider must not attempt to append surface state to CLU messages pre-run. If CLU wants current state, it calls `surf_ace_read`, which reads from local cache only.
- **No multiple alerts per unread activity burst.** Once `alertFired = true`, the provider suppresses further alerts until CLU reads (which re-arms the gate) OR the 10-minute alert timeout expires.

### 13.7 Relationship to Inbound Context Enrichment

If surface context (e.g. cached screen description) is ever added to CLU's context, it must use a fail-open enricher interface:
- Reads from a local cache only — never issues live network calls.
- Has a bounded synchronous timeout (< 5ms cache read).
- Returns empty/stale context on any failure — never blocks or throws.
- Cache is populated by background refresh triggered by WS events (pair, content.set, snapshot_hint), not by inbound message handling.

This enricher, if implemented, must be incapable of affecting message delivery correctness.

## 14. Provider Connection Daemon and CLU Tool Surface

### 14.1 Connection Daemon Model

The provider maintains persistent WS connections to all discovered screens automatically. CLU never initiates, manages, or tears down connections.

Rules:
1. When a screen is discovered via mDNS, the provider immediately begins connecting and runs the WS pair handshake.
2. The provider owns an ongoing connection job for each discovered screen. The job runs continuously: if the socket drops, the provider reconnects per the backoff policy in Section 4.4.
3. If a screen disappears from mDNS, the provider stops the connection job for it.
4. If a screen reappears, the provider resumes immediately.
5. The WS pair handshake (Section 6.1) is an internal protocol detail executed by the connection job. It is not exposed as a CLU action.
6. CLU never calls a "connect" or "pair" tool. By the time CLU acts on a screen, the provider is already connected — or actively attempting to be.

Connection states visible to CLU (via `surf_ace_list`):
- `connected` — WS socket established and pair handshake complete; ready for operations.
- `connecting` — provider is actively attempting to connect or reconnect.
- `unreachable` — screen was discovered but repeated connection attempts have failed (backoff limit reached or mDNS record stale).

### 14.2 Read/Write Model

CLU's tool surface has a strict read/write split:

**Writes** go to the surface over the WS connection: pushing content, clearing content, removing annotations. These are explicit CLU intent.

**Reads** are always local. CLU reads from the provider's local buffers only. CLU never triggers a live network call to a surface for any read operation. The provider is responsible for keeping local state current — via snapshot fetches on reconnect, snapshot_hint handling, annotation sync — all opaque to CLU.

### 14.3 CLU Tool Surface

CLU interacts with surfaces through the tools defined in this section. All screen-scoped tools accept `fingerprint` (the window-surface stable identity, mapped from `surfaceId`) as the primary screen selector. `paneId` is **required** on all pane-scoped calls — CLU resolves human references through `surf_ace_list` (`windowLabel` / `paneLabel`), then specifies the target pane explicitly by internal `paneId`. All pane-aware tool responses echo both the effective internal `paneId` and the visible `paneLabel`.

---

#### `surf_ace_list`

Returns all known screens and their locally cached state. Read-only, local.

**Params:** none

**Returns:** array of screen records:
```
fingerprint       string    Stable screen identity (window-scoped; mapped from `surfaceId`)
windowLabel       string    Provider-assigned visible window label (`a`, `b`, `aa`, ...)
name              string    Human-readable screen name
connectionState   enum      "connected" | "connecting" | "unreachable"
lastSeenAt        epochMs   When screen was last seen in mDNS or active
viewport          object    { width, height, scale }
panes             array     Full current pane topology: [{ paneId, name, activeContent, historySummary }]
                          Each pane record also includes `paneLabel`, the visible human-facing pane identifier.
                          activeContent: { contentId, contentType, revision } or null if idle
                          historySummary: { visibleContentId, backCount, forwardCount }
pendingEvents     int       Count of buffered events not yet read by CLU
```

**Errors:** none (always returns current known local state, possibly empty array)

---

#### `surf_ace_push`

Push content to a screen, replacing whatever is currently displayed. Write.

**Params:**
```
fingerprint    string   Target screen
paneId         integer  Required.
contentType    enum     "html" | "image" | "pdf" | "terminal" | "markdown" | "video" | "canvas"
content        string   Content payload. Encoding by type:
                          html/terminal/markdown: UTF-8 text
                          image/pdf: base64
                          video: URL string pointing to video source
                          canvas: optional JSON background spec { color?, grid? }, or empty string for plain white
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

#### `surf_ace_split`

Split an existing pane into `count` total panes. Write.

**Params:**
```
fingerprint    string   Target screen
paneId         integer  Required source pane.
count          integer  Required total pane count after split, including the source pane. Minimum 2.
direction      enum     "horizontal" | "vertical"
```

**Behavior:** The provider sends `pane.split` to the surface and assigns both the internal `paneId` values and the visible `paneLabel` values for the newly created panes.

**Returns:** array of pane records:
```
paneId         integer  Effective pane id after the split. Includes the source pane and each newly created pane.
paneLabel      integer  Visible pane label for that pane.
```

**Errors:** `not_connected`, `screen_not_found`, `invalid_operation`

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

Read dual-channel annotation state plus register values from the local buffer for a pane. Read-only, local — no network call to the surface. `surf_ace_read` is pane-scoped at the CLU boundary: CLU targets a pane only, and the surface/provider decides internally which pane-history state is currently visible. If the pane is idle, `surf_ace_read` returns empty channels for that pane.

Response includes:
1. **Live dirty channel first** (if a frame is currently open/active),
2. **Closed frame queue batch** (up to 5 and within ~4 MB image budget),
3. **Structured non-annotation registers** (consumed on read).

Closed frames are dequeued on read. Register values are cleared. Live dirty markers are advanced. Alert gate is reset.

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
                           CLU-layer mapping: wire `nearestContent` → `nearestText`; `elementRole` =
                           provider-computed ARIA role of tapped element; `timestamp` from wire sentAt.
scrollPosition    object?  Latest settled scroll state: { x, y, visibleRect }. null if no scroll event since last read.
selection         object?  Latest selection: { selectedText, bounds, anchorStart?, anchorEnd? }. null if none.
                           CLU-layer mapping: wire `text` → `selectedText`; wire `boundingRect` → `bounds`;
                           `kind` is implicit as text in this CLU-layer shape. v1 providers preserve wire
                           `kind:"text"` selections and discard `kind:"point"`/`kind:"region"` unless explicitly
                           feature-negotiated (see §7.1 and §13.2). `anchorStart`/`anchorEnd` are provider-computed
                           DOM offsets when available (commonly HTML); otherwise null.
page              object?  Latest page state: { pageNumber, pageCount, pageLabel? }. null if not applicable.
playbackPosition  number?  Video only. null for all other content types.
playbackState     string?  Video only: "playing" | "paused" | "ended". null for all other content types.
lastNavigation    object?  HTML only: { url, navigatedAt } of most recent navigation, or null. Consumed on read.

// Buffer health
overflowed        bool     True if taps register dropped entries due to 512-entry cap.
readAt            epochMs
```

**Read priority + dedupe contract:**
- CLU should interpret `liveFrame` first when present (newest/live).
- CLU should process `frames[]` oldest-first for guaranteed context-preserved delivery.
- If new live dirty data appears while processing backlog, CLU should pause backlog and return to live.
- Closed frames should still be processed even when some strokes were already seen live (frame image/context is authoritative).
- A stroke may appear in both channels; dedupe by `strokeId` per `frameId`/`contextKey`.

**Errors:** `screen_not_found`

`surf_ace_read` may be called regardless of connection state.

**Migration notes (frame-queue-only → dual-channel):**
- Existing callers that only read `frames[]` continue to work unchanged.
- New callers should also inspect `liveFrame`/`liveDirtyStrokeIds` for near-real-time response while annotation is active.
- Dedup is required when consuming both channels: use `strokeId`.
- No new mandatory tool was introduced; `surf_ace_read_buffer` remains deprecated.

---

#### `surf_ace_read_buffer` (Deprecated)

This tool is deprecated and removed in the capture frame model. Frame images are now included directly in each capture frame returned by `surf_ace_read`. Do not use this tool in new code. It is documented here only for historical reference.

---

#### `surf_ace_annotations_remove`

Remove specific annotation strokes from a screen's drawing overlay by stroke ID. Write.

**Note (dual-channel frame model):** In the dual-channel model, rendered strokes persist until the provider explicitly removes them or content changes under the normal content rules. The underlying context frame may remain open and continue on later same-context re-entry (§13.2). Closed frames in the queue are immutable records and cannot be modified via this tool. `surf_ace_annotations_remove` only affects strokes currently rendered in the live annotation overlay. For most CLU workflows, this tool is used to remove strokes from in-progress interaction (e.g., erasing a scratch-out gesture mid-session). Post-finalization frame handling is done at CLU interpretation time (dedupe/ignore/act), not by mutating closed frames.

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

When unread annotation activity first appears (live dirty update and/or closed frame queue growth), the provider fires one Clawline alert if none has fired for the current unread burst. Alerts route to `agent:main:main` by default. This is opaque to CLU — there is no tool to configure routing.

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

### 14.6 Extension Skills and Agent Instruction Injection (Required Paths)

Surf Ace implementation is not complete unless both extension skills and agent instruction injection are present at these provider paths.

**Required skill files:**
- `extensions/surf-ace/skills/surf-ace-ops/SKILL.md`
- `extensions/surf-ace/skills/surf-ace-markup/SKILL.md`

**Required instruction-injection files:**
- `extensions/surf-ace/src/agent-instructions.ts`
- `extensions/surf-ace/index.ts` (wires instruction injection into extension registration)

The injected Surf Ace instruction text MUST teach agents how to interpret surface-originated events, including at minimum:
- `event.drawing_flush`
- `event.navigation`
- `event.page`
- `event.selection` (v1 text-only handling)
- `event.pane_created` / `event.pane_removed` / `event.pane_renamed`

Standalone-provider note: Surf Ace MAY run as a standalone extension without Clawline coupling, provided it implements gateway wake/routing plumbing comparable to existing channel extensions (for example, Discord-style wake + route behavior) rather than relying on Clawline-specific internal helpers.

## 15. Surface UI Design

**Companion flow artifact (non-normative):** `docs/design/surf-ace-ui-flows.html` (Figma-style state-flow visualization for review discussion).

This section is **normative**. Surface implementations MUST conform to the requirements described here. This section does not specify pixel sizes, exact colors, fonts, or precise layout coordinates — those are implementation details left to each platform. It specifies what must be shown and the behavioral rules governing each UI element.

---

### 15.1 Persistent Indicators

Surface implementations MUST display the following identifiers. Labels are visible by default and hidden only during active pointer movement or touch interaction — they are always visible at rest, which satisfies the core requirement of readability from across the room. Labels MUST NOT be hidden based on content type, connection state, or annotation mode.

#### Window label

Each window is assigned a short alphabetic identifier using an auto-incrementing sequence: `a`, `b`, `c` … `z`, `aa`, `ab`, … This label MUST be:
- Displayed prominently, centered at the top of the window, as a floating translucent overlay above all pane content.
- Visible by default (at rest); hidden on active pointer movement or multitouch interaction; restored on pointer/interaction idle.
- Rendered in the overlay layer — it does not scroll with content.

The window label is the primary addressing handle. It MUST be visible when the surface is at rest so that a user can tell CLU "move content to window b" without ambiguity.

#### Pane label

Each pane is assigned a stable visible numeric `paneLabel` that is distinct from its internal `paneId`. `paneLabel` is the user-facing pane identifier. Optional pane names do not replace it. The pane label MUST be:
- Displayed as a large floating translucent overlay in the bottom-right of the pane content area, with toolbar-matched border styling, very bold type around 20vh, and low opacity.
- Visible by default (at rest); hidden on active pointer movement or multitouch interaction; restored on pointer/interaction idle.
- Rendered separately from the pane control cluster. The pane label MUST NOT appear as a toolbar/control-cluster button or label unless a future explicit control need is specified separately.
- On touch interfaces: tapping pane chrome or content while labels are hidden MAY re-show labels, and any tap while labels are visible MAY hide them again. This must not require a pane-number toolbar control.
- On pointer interfaces: moving the pointer hides labels; hovering the pane control bar restores them.

#### All platforms

- **Finger/stylus button (👆):** A single drawing-input button MUST be present in the pane control bar at all times, including when annotation mode is inactive. Tapping it enables finger/stylus input as a drawing tool — entering annotation mode if not already active, or toggling finger draw on/off within an active pencil session.
- **Apple Pencil (pencil platforms only):** Pencil contact with the screen MUST automatically enter annotation mode. No button tap is required.
- **Done button:** While annotation mode is active, a **Done** button MUST be visible in the bottom-center floating control cluster. Tapping it exits annotation mode. No other gesture is required to exit.

#### Annotation mode visual state (all platforms)

When annotation mode is active, the pane MUST render a 2px accent border as the sole visual indicator. No badge, label, or additional chrome is added. Pane labels MUST remain visible. While annotation mode is active, Back and Forward are hidden; the 👆 control and Done button remain in the control cluster.

#### Keyboard focus visual state (all platforms)

When keyboard focus is assigned to a pane, that pane MUST render a visible mid-gray focus outline or equivalent affordance. The outline MUST remain legible on both white and dark-ish content backgrounds; pale white, pale blue, or otherwise low-contrast outlines are not sufficient. This affordance is separate from the pane label and from annotation mode; it MUST NOT change the pane's visible `paneLabel` or add a pane-number control to the toolbar.

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

---

### 15.3 Pane Header Controls and Affordances

Pane controls float above content rather than occupying a fixed header bar. The pane itself is chrome-free — content fills the entire pane area.

Required defaults:
- Pane label is displayed as a large floating translucent overlay in the bottom-right of the pane (see §15.1 for visibility rules).
- Pane labels are not controls. The user-facing pane id is the floating pane label.
- All pane controls (Back, Forward, 👆, Done, and degraded-state warning icons) live in a single floating control cluster at the bottom-center of the pane.
- Back/Forward controls appear only when history exists in that direction; hidden otherwise.
- Done appears only while annotation mode is active; hidden otherwise.
- 👆 (drawing input) button is always present in the control cluster.
- Multiple panes in a window share a background; pane boundaries are indicated by a center divider only. Keyboard focus may add the visible focus affordance from §15.1, but it does not create a default target for CLU routing and does not replace explicit `paneId` targeting.

#### Icon assets

- **iOS / iPadOS / macOS (native):** All control icons MUST use SF Symbols. Recommended mappings: Back → `chevron.backward`, Forward → `chevron.forward`, 👆 drawing input → `hand.draw`, Done → plain text label "Done" (no symbol needed).
- **Electron:** Platform-appropriate icon set (e.g. Lucide, Phosphor, or equivalent); SF Symbols are not available on non-Apple platforms.

History controls default behavior:
- Disabled Back/Forward controls render at 40% opacity.
- Disabled Back/Forward controls do not show hover affordances.
- v1 does not show history depth counters.

---

### 15.4 Degraded and Empty States

Default user-visible handling for degraded or unavailable states:
- Overlay restore failure shows a non-blocking toast plus a warning icon in the bottom-center floating control cluster.
- Blocked navigation or blocked content replacement during annotation mode shows a small toast: `"Finish annotation (Done) to navigate"`.
- Unsupported content renders a centered empty-state message.
- Reconnect/resume state is shown via the connection state bar (see §15.7).

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

### 15.7 Connection State Bar

A 2px overlay line MUST be rendered at the bottom edge of each window, spanning the full window width. It sits as an overlay above pane content at 80% opacity. It MUST persist during annotation mode.

**States and colors (Clawline design system tokens):**

| State | Color token | Hex | Behavior |
|---|---|---|---|
| Connected | `--ok` | `#22c55e` | Solid line |
| Connecting / Reconnecting | `--warn` | `#f59e0b` | Animated: a bright highlight sweeps left↔right continuously (KITT/Cylon-style bounce), repeating until connected |
| Disconnected | `--destructive` | `#ef4444` | Solid line |

**Platform color references:**
- iOS/iPadOS/macOS native: map tokens to `Color.green` / `Color.yellow` / `Color.red` system colors, or use exact hex values above.
- Electron: use CSS custom properties (`--ok`, `--warn`, `--destructive`) from the Clawline design system.


## UI/UX Invariants Index

This section is a consolidated copy/reference index of existing UI/UX mentions elsewhere in the document; it does not supersede the original normative or contextual locations.

- **Window Letter Labels** — "Window labels (a, b, c…) are assigned by provider/extension, not the surface." Source: §3.1.1
- **Pane Name Authority** — "Pane names are optional extension-assigned metadata. They do not replace `paneLabel` as the visible identity token." Source: §3.1.1
- **Pane Label Authority** — "Pane labels are provider-assigned visible numeric identifiers distinct from internal `paneId`." Source: §3.1.1
- **Prominent Surface Labels** — "Window label: centered-top floating overlay. Pane label: bottom-right floating overlay within pane. Visibility rules: visible at rest, hidden on active interaction." Source: §3.1.1 / §15.1
- **Displayed Content Persistence** — "The surface renders content and keeps it displayed until CLU explicitly changes it." Source: §1
- **Visible Back/Forward Behavior** — "The newly targeted content becomes front/visible immediately in that pane." Source: §6.1.1
- **History Navigation Controls** — "Previously visible content in that pane remains navigable through the surface's Back/Forward controls." Source: §6.1.1
- **Floating History Controls** — "Back/Forward controls SHOULD appear in the bottom-center floating control cluster." Source: §6.1.1 / §15.3
- **Disabled History Controls** — "Disabled Back/Forward controls SHOULD render at 40% opacity and SHOULD NOT show hover affordances." Source: §6.1.1 / §15.3
- **No History Counters** — "v1 SHOULD NOT display history depth counters." Source: §6.1.1 / §15.3
- **Degraded Restore Safety** — "The surface MUST still show that state's content payload when available, clear the overlay for safety." Source: §6.1.1
- **Restore Failure UI** — "The surface SHOULD show a non-blocking toast plus a warning icon in the bottom-center floating control cluster." Source: §6.1.1 / §15.4
- **Connection State Bar** — "The surface MUST display a persistent visual indicator of connection state via the connection state bar." Source: §4.5 / §15.7
- **Connected State UI** — "Connected — green: render the persistent 2px connection state bar as a solid green line." Source: §4.5 / §15.7
- **Connecting State UI** — "Connecting / reconnecting — yellow: render the same bar in the warning state with the animated sweep defined in §15.7." Source: §4.5 / §15.7
- **Disconnected State UI** — "Disconnected — red: render the same bar as a solid red line." Source: §4.5 / §15.7
- **Window Label Placement** — "Floating translucent overlay, centered top of window, above all pane content." Source: §15.1
- **Window Label Visibility** — "Visible by default at rest; hidden during active pointer movement or touch; never hidden by content or connection state." Source: §15.1
- **Primary Addressing Handle** — "The window label is the primary addressing handle. It MUST be visible when the surface is at rest." Source: §15.1
- **Pane Label Placement** — "Large floating translucent overlay in the bottom-right of the pane content area." Source: §15.1
- **Pane Label Visibility** — "Visible by default at rest; hidden during active pointer movement or touch; restored on idle." Source: §15.1
- **Pencil Auto Entry** — "Pencil contact with the screen MUST automatically enter annotation mode." Source: §15.1
- **Drawing Input Button (👆)** — "A single drawing-input button MUST be present in the pane control bar at all times." Source: §15.1
- **Done Exit Control** — "While annotation mode is active, a Done button MUST be visible in the bottom-center floating control cluster." Source: §15.1 / §15.3
- **Annotation Mode Visual State** — "When annotation mode is active, the pane MUST render a 2px accent border as the sole visual indicator." Source: §15.1
- **Control Cluster Rule** — "All pane controls (Back, Forward, 👆, Done, and degraded-state warning icons) live in a single floating control cluster at the bottom-center of the pane." Source: §15.3
- **Keyboard Focus Affordance** — "Keyboard-focused panes MUST render a visible mid-gray focus outline or equivalent affordance, legible on both white and dark-ish content backgrounds." Source: §15.1
- **Explicit Pane Routing** — "Keyboard focus does not create a default target for CLU routing and does not replace explicit `paneId` targeting." Source: §15.3
- **Accessibility Touch Targets** — "All chrome controls MUST provide a minimum 44x44 touch target." Source: §15.2
- **Accessibility Contrast** — "All chrome labels and controls MUST meet WCAG AA contrast." Source: §15.2
- **Electron Shortcut Defaults** — "`A` enters annotation mode, `D` exits annotation mode via Done, `Cmd-[` navigates Back, `Cmd-]` navigates Forward." Source: §15.2
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

**Problem:** v1 has no dedicated protocol for model-originated strokes in the native annotation overlay. CLU can still present draw-capable experiences by pushing normal renderable content such as HTML with `<canvas>` or SVG, but there is no native-overlay stroke op, no capture exclusion mechanism for provider-originated overlay marks, and no visual distinction protocol for those overlay marks.

**Status:** Open. Not Phase 1 or Phase 2 scope. See Appendix A.12 for background.

### OT-2: Semantic Gesture Classification — CLOSED

**Decision:** No on-device semantic classification. The surface sends raw stroke geometry in the buffer. CLU receives and interprets the geometry directly, using whatever approach it sees fit. No `semanticHints` field, no wire extension, no on-device model integration. Closed; will not be revisited.

---

## 16. Common Pane Geometry Architecture

Status: normative architecture amendment, 2026-04-27. Source spec: `/Users/mike/shared-workspace/surf-ace/specs/common-geometry-architecture.md`.

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

Racter tall-logical-surface remains a required fixture: Surf Ace receives a logical surface of `2160x3840` and must treat it exactly like any other `2160x3840` monitor/window. Native panes, Surf Ace controls, overlay regions, and hit regions must align in that logical coordinate space. Surf Ace must not reason from display rotation or physical scanout shape.

### 16.4 iOS requirement

iOS should preserve its cleaner visual seam: pane content and controls live in one SwiftUI pane layout context. That SwiftUI-resolved pane frame is the iOS geometry authority. Protocol reporting MUST consume the resolved pane geometry from that authority; it MUST NOT independently recompute pane rectangles from topology in a way that can drift from visible layout. Split spacing, safe area, scale, and scene/window changes must be represented consistently in the resolved snapshot and protocol viewport projection.

### 16.5 Failure modes forbidden by this architecture

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

**Question:** If a user annotates the top of a long webpage, scrolls down, and annotates the bottom — how does the provider produce a meaningful image for CLU?

**Decision:** Multi-scroll behavior is handled by the dual-channel context model. Because annotation mode locks the viewport (see §15.6 "While IN annotation mode"), scrolling cannot occur while actively drawing. If a user annotates at scroll position A, exits annotation mode, scrolls, and re-enters annotation in the **same context**, strokes append to the same context frame (not a new context frame). If annotation resumes only after a true context switch (e.g., different URL/content context and annotation starts there), the previous context frame is finalized and the new context gets its own frame.

CLU may therefore receive either one evolving context frame (same context, multiple annotation sessions) or multiple finalized frames (annotation across distinct contexts). `scrollOffset` at frame open remains the reference anchor for mapping to document-space.

---

### A.3 Semantic Gesture Interpretation (Brackets Problem)

**Question:** When a user draws `[` at one position and `]` far below it, their intent is "everything between these brackets." Raw stroke geometry alone cannot convey this — the provider would only see two curved strokes with a large gap. How does the system convey the user's region intent to CLU?

**Related:** Same problem applies to any multi-stroke semantic gesture where the intent spans content between the strokes rather than the strokes themselves.

**Status:** Partially addressed by the capture frame model — full resolution requires on-device gesture classification (A.4).

**With dual-channel context frames:** Bracket strokes and other multi-stroke semantic gestures can be accumulated into one finalized context frame (even across multiple same-context annotation sessions). CLU receives the frame stroke set plus viewport screenshot, reducing partial-geometry ambiguity.

However, geometry-based inference of the "between" region still requires understanding that the strokes form brackets and that the intent is spatial span between them. This is the unresolved part. On-device classification (A.4) applied per finalized frame remains the most promising path: the surface classifies gesture intent for the frame stroke set before (or at) finalization and includes a `semanticHints` field. Design deferred to v2.

---

### A.4 On-Device Model Integration (Apple Foundation Model)

**Question:** iOS devices with Apple Intelligence have an on-device foundation model available. Should the surface use it to classify stroke gestures (lasso, bracket, circle-for-emphasis, underline, cross-out, drawn box, etc.) before reporting to the provider?

**Why it matters:**
- CLU receives classified intent rather than raw geometry — dramatically reduces ambiguity
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

**Question:** Is "point-out" (user explicitly directing CLU's attention) a distinct surface behavior, or is it inferred by CLU from existing event types?

**Context:** Two modes of surface use were identified:
1. *Point-out* — user highlights, boxes, or selects something, meaning "look at this specifically"
2. *Passive* — user scribbles, writes, thinks on-screen; CLU observes without explicit direction

**Open sub-questions:**
- Does the surface classify which mode is active, or does CLU infer it?
- Are point-out gestures a distinct register, or do they arrive as ordinary stroke/selection events?
- For text selections (OS-level), the selected text is cleanly available — CLU may not need an image at all. For drawn boxes or lasso regions, an image crop is needed. Should these be unified under one "attention region" concept?

**Status:** Unresolved. Depends on A.4.

---

### A.6 Image Request Scope and Cropping

**Question:** When CLU requests an image of a region, how is the region specified, and what exactly is composited?

**Partially resolved:**
- Images always include the annotation overlay rendered on top of content (never content-only or strokes-only)
- CLU specifies a region of interest rather than always requesting full-screen
- Provider crops from locally cached render + live annotation layer

**Still open:**
- Is the region in screen coordinates or content coordinates? (Depends on A.1)
- How current must the locally cached render be? If the user has scrolled since the last cache update, the crop is wrong.
- Does the provider maintain a rendered image cache proactively, or only on demand?
- For "full screen" requests, is the image the current viewport or the full scrollable content?

**Status:** Partially resolved. Coordinate space is settled (viewport coordinates per A.1). In the capture frame model, each frame includes a viewport screenshot — CLU receives the image directly in `surf_ace_read` without needing a separate buffer crop. The region-of-interest question is moot for closed frames (each frame image is already the viewport at capture time). For live/open frame inspection, `snapshot.get` with `includeImage=true` remains available over the WS protocol.

---

### A.7 Surface Interaction Model: Modes vs. No Modes

**Question:** Does the surface have explicit interaction modes (e.g. "navigation mode" vs. "markup mode"), or is it always one unified thing?

**Design direction:** No explicit modes. The surface always behaves like a real browser. Full link following is supported — if CLU pushes a website, the user should be able to use it as a website including hyperlinks. Pencil always draws annotations. Finger always does finger things: scroll, select text, tap elements, follow links. Point-out is not a mode — it is the natural byproduct of ordinary finger interactions (text selection, element tap) that happen to produce structured register entries.

**Implications:**
- Link navigation must be detected and reported as a content state change (URL change → navigation event → snapshot_hint)
- Annotations should be buffered per URL (or per content hash for non-URL content) so that navigating away and back restores annotations to their previous state
- The provider tracks which annotations belong to which URL; when the user returns to a URL, the annotation register is restored from that buffer
- The model observes URL changes via the content state register and can react or ignore

**Open sub-questions:**
- Should the surface suppress link navigation when CLU-pushed content is active, with an opt-in flag to allow it? Or always allow it?
- How should annotation buffering handle URL fragments (#section) vs. full URL changes?
- What happens to annotations when CLU calls `surf_ace_push` with new content — are they cleared or preserved?

**Decision:** On pencil-supported devices, pencil contact automatically enters annotation mode; fingers do normal operations (scroll, select, tap, follow links) by default. A single 👆 drawing-input button is always visible and, when tapped, adds finger drawing capability to annotation mode. On non-pencil platforms (Electron), that same 👆 button is the entry point for annotation mode and enables drawing input. This is the only surface-level mode distinction and it is UI-only; the wire protocol and register model do not change based on mode.

**UI defaults alignment:** Drawing controls live in the bottom-center floating control cluster. The Done control appears in that cluster while annotation mode is active. Blocked navigation or blocked content replacement during annotation mode produces a small toast directing the user to finish annotation first.

**Data model:** The provider MUST store surface state in a context dictionary keyed by `contextKey`, where `contextKey` is:
- For CLU-pushed content: the `contentId` (e.g. `ct_a1b2c3d4`)
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

**Blank canvas** (`canvas`) — an optional/legacy content type where annotations are the primary artifact and there is no underlying document. The surface renders a blank or gridded background. `content.clear` removes all annotations (same global rule as all content types). In v1, CLU observes user strokes via the existing register model (read-only for the native annotation layer). CLU does not need this content type in order to present draw-capable experiences, because normal HTML/SVG content can already render its own `<canvas>` or similar drawing UI. Dedicated native-overlay annotation writes remain undefined in v1 and would require a future protocol extension. Useful for whiteboard-style collaboration. See the `canvas` characteristics in §6.1.1.

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

**Why this is safe:** This adds pane orchestration via explicit `paneId` targeting. CLU always specifies which pane it is addressing. No ambiguity from fallback resolution.

---

### A.11 Future Extension — Multi-Pane Enhancements Beyond Phase 1

**Goal (v2+ enhancements):** Extend one-window multi-pane behavior with richer pane layout orchestration and lifecycle semantics beyond the Phase 1 committed baseline.

**Compatibility principle:** Model mutable state as `contextScope = { surfaceId, paneId }`. `paneId` is always required. CLU must read surface state to know valid `paneId` values before targeting a pane.

**Expected v2+ shape:**
1. Advanced pane lifecycle/layout operations (nested split templates, persistent layout presets, pane groups).
2. Full read/write scoping by `{ surfaceId, paneId }` across all tools and schema operations.
3. Independent live dirty channel + closed-frame queue + register state per pane, with optional cross-pane coordination events.
4. Ordering/dedupe contracts remain unchanged per pane.

**Status:** Base multi-pane topology is Phase 1 committed work (§2.3). This subsection covers additional v2+ enhancements beyond Phase 1.


### A.12 Model-Side Markup and Point-Outs (Open Topic)

**Problem:** The current spec defines the native annotation overlay as user-generated (stylus/finger strokes). CLU can already present draw-capable experiences by pushing normal renderable content such as HTML with `<canvas>` or SVG, but v1 has no dedicated provider-originated stroke/markup protocol for drawing into the native annotation layer itself.

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

**Status:** Open. This is only about dedicated native-overlay annotation primitives; it does not block CLU from presenting draw-capable HTML/SVG/canvas content in v1. Not part of Phase 1 or Phase 2 scope as currently defined.

### A.13 Multi-Session CLU History Routing — Rationale Context

**Background:** The WS single-connection rule governs provider-level connections. At the CLU tool layer, multiple CLU sessions route through the same provider. The surface-owned history model (§3.1.1, §6.1.1) prevents sessions from overwriting each other's content while still guaranteeing a single visible owner per pane.

**Resolved policy summary:**
1. The newest `content.set` in a pane becomes visible immediately.
2. If the displaced visible content belongs to another session, that prior pane content moves to the Back stack and the provider emits `event.content_superseded` locally for the displaced session.
3. Back/Forward navigation changes visibility only; it does not rewrite session-owned history entries.

**Related sections:** §3.1.1 (topology), §6.1.1 (pane lifecycle, history operations, and history routing rules), §13.2 (annotation buffering), §14.3 (`surf_ace_list` occupancy).

### 15.8 Provider Name Display

When the paired provider sends a `providerName` in `pair.request`, the surface MUST display it in the window title area. `providerName` is required for successful pairing, so every paired surface has one. The subtitle text MUST follow the current connection state instead of collapsing all missing-name cases into `not connected`.

**Layout — Liquid Glass pill (iOS/iPadOS/macOS):**
The window title area renders as a Liquid Glass pill containing two lines:
1. **Window name** — large font, primary weight. This is the surface own display name (e.g. "Surf Ace - Emanator (host)").
2. **Connected agent name** (`providerName`) — smaller font, secondary/muted weight, below the window name.

The subtitle row is always present.

**Behavior:**
- Subtitle line is always visible.
- Disconnected -> subtitle shows `not connected`.
- Connecting / reconnecting -> subtitle shows `connecting…`.
- Connected -> subtitle shows the paired `providerName` value.
- Truncated with ellipsis if text is too long to fit; MUST NOT wrap.
- MUST NOT be interactive (no tap target).
- MUST persist during annotation mode.
- If the provider name changes mid-session (e.g. reconnect with different name), update immediately.

**Protocol integration:**
- Surface stores the most recently received required `providerName` from `pair.request`.
- Clears stored name on ownership relinquish or socket disconnect.
- Re-applies name on next successful `pair.request`.

**Invariant index entry:**
- **Provider Name Display** — "Window title pill: large window name + smaller subtitle below. Subtitle always visible; `not connected` when disconnected, `connecting…` while reconnecting, and the required paired `providerName` when connected. Cleared on disconnect/relinquish." Source: §15.8
