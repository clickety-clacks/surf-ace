# Surf Ace Identity / Authority Invariant Report

Date: 2026-05-14
Worktree: `/Users/mike/src/worktrees/surf-ace-identity-hardening`

## Product Invariant Summary

Flynn's invariant set maps to one rule: stable product identity belongs to the TARS Surf Ace extension/provider install, and runtime/presentation details must not decide durable ownership. A same-install disagreement can be yellow while the client and provider reconcile, but it must not remain terminal yellow. A real ownership block requires evidence that a pane/window belongs to another Surf Ace extension installation.

## Current Distributed Identity Algorithm

### Provider / Install Identity

- The extension creates provider ids as `pv_${randomUUID}` in `packages/extension/src/surf-ace-runtime.ts:1009`.
- The durable provider identity path is `~/.openclaw/extensions/surf-ace/provider-identity.json`, resolved by `resolveDefaultProviderIdentityPath` in `packages/extension/src/surf-ace-runtime.ts:1001`.
- Runtime state load reads persisted provider state, then reconciles it with the durable provider identity in `loadState` (`packages/extension/src/surf-ace-runtime.ts:7190`). Existing durable ids win; otherwise the provider seeds from prior local state or creates a new random provider id (`packages/extension/src/surf-ace-runtime.ts:7238`).
- Durable provider id persistence uses exclusive create and re-reads on `EEXIST`, which prevents concurrent startup from rotating identity (`packages/extension/src/surf-ace-runtime.ts:7284`).
- Pairing sends stable `providerId` plus per-attempt `connectionId`; `connectionId` is generated inside `requestPair` and is not the lock identity (`packages/extension/src/surf-ace-runtime.ts:9675`).
- `DESIGN.md:354` already says `providerId` is stable product state stored in a trusted TARS path and reused across restart, branch overlay, package move, or redeploy.

Result against invariant 1: the provider/install side is aligned. PID/run identity is diagnostic/runtime state only and is not used as stable provider identity.

### Endpoint Identity

- The protocol defines endpoint as app/device host:port over mDNS (`DESIGN.md:106`) and the public-key fingerprint TXT key as endpoint identity only, not a CLU screen selector (`DESIGN.md:194`).
- Extension managed surfaces store `endpointId`, endpoint metadata, and fingerprint as discovery provenance in `createManagedSurface` (`packages/extension/src/surf-ace-runtime.ts:1428`).
- Endpoint probe keys prefer fingerprint, falling back to the WebSocket URL (`packages/extension/src/surf-ace-runtime.ts:2594`).
- Discovery removal is treated as endpoint liveness/probe state; owned or paired surfaces are preserved even if discovery no longer lists the endpoint (`packages/extension/src/surf-ace-runtime.ts:4276`).

Result against invariant 6: endpoint ids are transport/discovery details, not stable product ownership identity.

### Surface / Window Identity

- Electron surfaces use a local persisted Ed25519 identity file, `surface-identity.json`, created or loaded by `loadOrCreateIdentity` (`packages/electron/src/identity.ts:13`). That is client endpoint identity, not provider ownership.
- iOS stores the app identity key in Keychain via `SurfAceIdentityStore.loadOrCreateIdentity` (`packages/ios/SurfAce/SurfAceIdentityStore.swift:15`).
- iOS assigns a stable `surfaceId` per scene key by loading `identityMapping.surfacesBySceneKey`, or creating `sf_<hex>` once and persisting the mapping (`packages/ios/SurfAce/SurfAceRuntime.swift:438`).
- `DESIGN.md:98` defines each window as a distinct surface with stable `surfaceId`.

Result against invariant 2: client/window identities are respected best-effort. The provider targets `surfaceId`, but provider authority wins when accepted session identity matches.

### Pane Identity / Lineage

- The design states pane ids and labels are provider-assigned; surfaces do not generate pane ids independently (`DESIGN.md:171`).
- Provider pair bootstrap includes provider-assigned `initialPaneId`, `initialPaneLabel`, and `windowLabel` (`packages/extension/src/surf-ace-runtime.ts:9675`).
- Electron pane state records provider pane id/label and generates a local lineage id when the pane is created (`packages/electron/src/surface-core.ts:2283`).
- Provider `authority.state` sends each pane's `paneId`, `paneLabel`, and `paneLineageId` (`packages/extension/src/surf-ace-runtime.ts:10682`).

Result against invariants 2 and 3: pane identity is provider-owned for routing and labels, while lineage is a client-side continuity token that the provider then uses for exact authority acknowledgement.

### Session / Ownership Epoch

- `DESIGN.md:220` binds ownership to stable `providerId`, not transient socket liveness.
- Normal resume uses the same `providerId` and prior `sessionId`; foreign busy locks must not be silently reclaimed (`DESIGN.md:238` and `DESIGN.md:241`).
- Electron pair handling distinguishes fresh claim, same-provider resume, explicit takeover, and foreign busy. Same-provider resume adopts provider bootstrap label; different providers without takeover remain blocked (`packages/electron/src/ws-server.ts:1222`).
- iOS `commitPairRequest` keeps or transfers the lock and now applies the provider window label on both resumed and fresh pair paths (`packages/ios/SurfAce/SurfAceRuntime.swift:1500`).

Result against invariants 3 and 5: stable provider ownership wins once identity matches. Different provider/install ownership remains the true block.

### Labels

- `DESIGN.md:172` says window labels are provider-assigned; `DESIGN.md:173` says they are visible coordinates and not durable target authority.
- `DESIGN.md:175` says pane labels are provider-owned visible keys and not durable target authority.
- The provider repairs live duplicate/missing window labels before pair and persists the corrected allocation (`packages/extension/src/surf-ace-runtime.ts:5168`).
- The provider publishes window/pane labels through `authority.state` (`packages/extension/src/surf-ace-runtime.ts:10682`).

Result against invariant 6: labels are presentation/addressing details. They should be adopted from provider authority, not treated as a different-install ownership proof.

## Failure Points Before This Fix

### Electron Terminal `window_label_mismatch`

`handleAuthorityState` checked active `providerId`, `sessionId`, `ownershipEpoch`, and `surfaceId`, then compared `payload.windowLabel` to local `surface.windowLabel`. Before this fix, a valid same-session provider label disagreement returned `window_label_mismatch`, set the connection bar back to `connecting`, and prevented authority acceptance. That path made yellow terminal even though all stable ownership identity matched.

Fixed in `packages/electron/src/ws-server.ts:2642`: after session identity matches, a valid provider window label is adopted before pane/actionable validation. Invalid labels still reject, and provider/session mismatches still reject before adoption.

### iOS Terminal `window_label_mismatch`

`surfAceAuthorityStateRejectionReason` previously rejected any authority-state label that differed from `surface.windowLabel`, even when `providerId`, `sessionId`, `ownershipEpoch`, and lock owner matched. Resumed pair also did not adopt the provider label, so stale local label state could survive into authority acknowledgement.

Fixed in `packages/ios/SurfAce/SurfAceRuntime.swift:71` and `packages/ios/SurfAce/SurfAceRuntime.swift:2413`: valid provider labels are no longer rejection reasons once session identity matches, and the runtime applies provider window labels before validation. `commitPairRequest` now adopts provider labels on resume at `packages/ios/SurfAce/SurfAceRuntime.swift:1505`.

### Provider-Side Repair Was Insufficient Alone

The provider already repairs its live window-label invariant before pairing (`packages/extension/src/surf-ace-runtime.ts:5168`) and publishes the repaired label in `authority.state` (`packages/extension/src/surf-ace-runtime.ts:10682`). The client-side veto meant provider repair could still end in terminal yellow. That is why the live Aleph-style `window_label_mismatch` is a product bug, not expected steady state.

## Transient vs Bug Classification

- Expected transient: discovery churn, reconnect/resume while no `authority.state` has been accepted, provider topology repair in progress, or a short-lived yellow state while the client adopts provider-approved identity.
- Bug: same stable provider install, same session/epoch/surface, valid provider window label, matching pane identity, but authority remains rejected/yellow with `window_label_mismatch`.
- Correct terminal block: different stable `providerId`, foreign ownership lock, invalid session/epoch, or explicit invalid topology/pane identity.

## Design Encoding

The invariant belongs in `DESIGN.md` near the existing authority acknowledgement text in Section 6, because that is where pair identity becomes actionable state. The supporting identity material already exists in:

- `DESIGN.md:354` for stable provider/install identity.
- `DESIGN.md:172` through `DESIGN.md:179` for provider-owned labels and pane ids.
- `DESIGN.md:486` for `authority.state` fail-closed actionability.

Applied wording:

> Provider authority reconciliation invariant: after a surface has accepted matching `providerId`, `sessionId`, `ownershipEpoch`, and `surfaceId`, the provider-approved identity in `authority.state` is authoritative. Valid same-provider window/pane label disagreement is reconciliation work: the client MUST adopt the provider label/identity or wait for provider topology repair, and MUST NOT remain in terminal non-actionable/yellow state for that disagreement. The only terminal ownership block is evidence that the surface is owned by a different provider installation, such as mismatched stable `providerId` or foreign ownership lock without explicit takeover.

## Implementation Summary

- Electron `authority.state` now repairs/adopts a valid same-session provider window label and continues validation instead of rejecting terminally.
- iOS `authority.state` now adopts valid provider labels when stable session identity matches, and resumed pair commits also apply provider labels.
- Invalid provider labels still reject as `window_label_mismatch`.
- Different provider/session/epoch identity still rejects as `session_identity_mismatch` or `busy` on pair, preserving the different-install ownership block.

## Test Evidence

- Electron test added: same-session provider label disagreement is repaired and accepted; connection bar becomes connected.
- Electron test added: a second provider cannot pair while the surface is owned by another provider.
- iOS test extended: same-session valid provider relabel is not rejected; invalid label still rejects; foreign provider still rejects.

## Engram

The supplied Engram source id was queried with `engram peek 62ef3535-ff84-4d06-b347-6e57391552e3 --start 1 --lines 80`; it returned no usable transcript output, so it did not influence this implementation.
