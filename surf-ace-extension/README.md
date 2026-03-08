# Surf Ace Extension (fresh rebuild)

This folder is being rebuilt for the WebSocket protocol in `DESIGN.md`.

## Current state

- Legacy provider implementation moved to `legacy/provider-extension/`
- Fresh runtime scaffold started in `src/`
- Protocol contracts imported from `packages/protocol/`

## Next implementation steps

1. WS connection manager (provider as client)
2. Pair/reconnect lifecycle
3. Tool wiring (`surf_ace_pair`, `surf_ace_push`, `surf_ace_snapshot`, etc.)
