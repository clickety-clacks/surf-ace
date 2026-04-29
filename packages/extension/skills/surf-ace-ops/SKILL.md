# Surf Ace Ops

Use `surf_ace_list` before any pane-scoped write or read. Every pane-scoped call requires both `fingerprint` and `paneId`.

## Tool summary

- `surf_ace_list`: local-only. Returns surfaces, connection state, topology/topologyRevision, panes, active content, and pending provider-side events.
- `surf_ace_push`: write tool for `content.set`.
- `surf_ace_clear`: clears the currently visible content for the targeted pane.
- `surf_ace_realize_topology`: applies a desired root layout or pane subtree in one provider-side topology mutation.
- `surf_ace_read`: local-only. Returns live dirty annotation state first, then finalized frame backlog, then consumed registers.
- `surf_ace_annotations_remove`: removes specific live overlay stroke ids.

## Operating rules

1. Never assume pane topology. Read it with `surf_ace_list`.
2. Treat `content.set` as immediate visible ownership for that pane.
3. For multi-pane layout changes, prefer `surf_ace_realize_topology` with the `topologyRevision` returned by `surf_ace_list`.
4. Use `surf_ace_read` for annotation interpretation. Do not expect it to make a live network call.
