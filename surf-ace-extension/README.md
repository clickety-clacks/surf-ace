# Surf Ace Extension (fresh rebuild)

This folder is being rebuilt for the WebSocket protocol in `DESIGN.md`.

Do not install or run this scaffold as an OpenClaw provider. The canonical provider package is `packages/extension`, which requires explicit validated host configuration before startup or deployment.

## Current state

The supported provider package is `packages/extension`. It uses the current
lockless controller protocol and imports its contracts from `packages/protocol`.
