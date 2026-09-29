# Protocol extraction status

Source: `DESIGN.md`

This folder contains the canonical protocol schema and message definitions used by
the standalone Rust CLI and the Surf Ace client applications:
- `packages/cli/` (direct controller client)
- `packages/ios/` (surface client)
- `packages/electron/` (surface client)

The registry and allocator provide pairing and topology authority; the CLI
connects directly to the selected surface client for each explicit operation.
