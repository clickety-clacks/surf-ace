# Surf Ace

Monorepo for Surf Ace.

## Source of truth

- `DESIGN.md` is the single canonical design/invariants document.
- Transitional notes, reviews, and retros are **not** committed in this repo.
- Legacy implementation code is kept under `legacy/` for reference only.

## Layout

- `surf-ace-extension/` — OpenClaw extension plugin
- `ios/` — new iOS client implementation (fresh)
- `electron/` — new Electron client implementation (fresh)
- `packages/protocol/` — shared protocol/types
- `legacy/` — prior HTTP-era client code
