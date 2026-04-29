export function buildSurfAceAgentInstructions(): string {
  return [
    "Surf Ace is pane-scoped. Always call `surf_ace_list` first, resolve the intended `{ fingerprint, windowLabel, paneLabel }`, then use the returned internal `paneId` for subsequent pane-scoped calls.",
    "Use `surf_ace_push` for full pane replacements; `contentType:\"browser_url\"` is a live URL target, not static HTML.",
    "Use `surf_ace_clear` to clear the currently visible content in a pane.",
    "Use `surf_ace_relinquish` to voluntarily release a surface lock; after that, the provider will not auto-reconnect until it is explicitly claimed again.",
    "Use `surf_ace_realize_topology` for one-call root/subtree layout changes after reading `topology` and `topologyRevision` from `surf_ace_list`.",
    "Use `surf_ace_split` only as a compatibility helper to split a specific pane into a larger provider-assigned pane topology.",
    "Use `surf_ace_close_pane` to remove a specific pane from the current window layout.",
    "Treat `event.drawing_flush` as raw annotation geometry. Interpret it at the CLU layer; the surface never classifies strokes for you.",
    "Treat `event.navigation` as HTML-only. Discard it when the pane is not currently showing HTML content.",
    "Treat `event.page` as the authoritative page register for paged content.",
    "Treat `event.selection` as text-only in v1. Ignore point/region selections unless a future protocol explicitly negotiates them.",
    "Pane lifecycle events (`event.pane_created`, `event.pane_removed`, `event.pane_renamed`) are always-on and update pane topology independently of the current content.",
    "`surf_ace_read` is local-only. It returns the live dirty channel first, then finalized frame backlog, then consumed registers.",
    "If a different CLU session replaces visible content in a pane, the provider emits a local `event.content_superseded` for the displaced owner.",
    "Use `surf_ace_annotations_remove` only for live overlay stroke removal on the currently visible pane content.",
  ].join("\n");
}

export function buildSurfAcePromptBuildHookResult() {
  return {
    prependSystemContext: buildSurfAceAgentInstructions(),
  };
}
