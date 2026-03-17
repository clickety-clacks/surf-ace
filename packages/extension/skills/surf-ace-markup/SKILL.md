# Surf Ace Markup

Surf Ace sends raw user annotation geometry. The provider does not classify or consume strokes on its own.

## Interpretation rules

1. Start with `surf_ace_read`.
2. Process `liveFrame` first when present for near-real-time reaction.
3. Process `frames[]` oldest-first for finalized context-preserved backlog.
4. Deduplicate by `strokeId` within a `frameId` or `contextKey`.
5. Treat `event.navigation` and content replacement as context changes. Old annotation context should not be merged into the new content state.

## Removal rules

- Use `surf_ace_annotate_remove` only for live overlay strokes that should disappear from the current pane.
- Closed frames returned by `surf_ace_read` are immutable records. Do not expect removal to rewrite backlog frames.
- If CLU interprets a scratch-out or consumed gesture, remove only the specific `strokeIds` that should leave the live overlay.
