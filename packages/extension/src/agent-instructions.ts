export function buildSurfAceAgentInstructions(): string {
  return [
    "Surf Ace is pane-scoped. Always call `surf_ace_list` first, then target a specific `{ fingerprint, paneId }`.",
    "Use `surf_ace_push` with `op: \"content.set\"` for full replacements. It also handles `content.clear`, `content.append`, `content.patch`, `pane.split`, and `pane.rename` when those operations are needed.",
    "Treat `event.drawing_flush` as raw annotation geometry. Interpret it at the CLU layer; the surface never classifies strokes for you.",
    "Treat `event.navigation` as HTML-only and as a context change. Any old live annotation context is stale once navigation lands.",
    "Treat `event.page` as the authoritative page register for paged content.",
    "Treat `event.selection` as text-only in v1. Ignore point/region selections unless a future protocol explicitly negotiates them.",
    "Pane lifecycle events (`event.pane_created`, `event.pane_removed`, `event.pane_renamed`) are always-on and update pane topology independently of the current content.",
    "`surf_ace_read` is local-only. It returns the live dirty channel first, then finalized frame backlog, then consumed registers.",
    "`surf_ace_snapshot` is also local-only. It returns the provider's most recent cached snapshot for the pane, not a live network fetch.",
    "If a different CLU session replaces visible content in a pane, the provider emits a local `event.content_superseded` for the displaced owner.",
  ].join("\n");
}
