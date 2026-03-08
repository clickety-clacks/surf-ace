# Surf Ace Rebuild Workplan (post-redesign)

Source of truth: `DESIGN.md`

## Phase 1 — Protocol/Core
- [ ] Extract wire message schemas from DESIGN.md into `packages/protocol/`
- [ ] Define pair/content/event payload typings (provider <-> surface)
- [ ] Add conformance fixtures for required messages

## Phase 2 — Provider Extension (`surf-ace-extension/`)
- [ ] Rebuild runtime around persistent WebSocket model
- [ ] Implement discovery + pair + push + clear + snapshot tool surface
- [ ] Remove any callback/REST-era assumptions

## Phase 3 — iOS Client (`ios/`)
- [ ] SwiftUI app shell
- [ ] WS server endpoint + pair handshake
- [ ] Render path + annotation event stream

## Phase 4 — Electron Client (`electron/`)
- [ ] Electron app shell
- [ ] WS server endpoint + pair handshake
- [ ] Render path + annotation event stream

## Acceptance gate
- [ ] Provider can discover, pair, and push to both iOS and Electron against DESIGN.md semantics.
