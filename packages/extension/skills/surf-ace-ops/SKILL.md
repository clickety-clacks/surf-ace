# Surf Ace Ops

Use `surf_ace_list` before any pane-scoped write or read. Every pane-scoped call requires both `fingerprint` and `paneId`.

## Tool summary

- `surf_ace_list`: local-only. Returns surfaces, connection state, window labels, panes, active content, and pending provider-side events.
- `surf_ace_push`: write tool. Defaults to `content.set` and also accepts:
  - `op: "content.clear"`
  - `op: "content.append"`
  - `op: "content.patch"`
  - `op: "pane.split"`
  - `op: "pane.rename"`
- `surf_ace_read`: local-only. Returns live dirty annotation state first, then finalized frame backlog, then consumed registers.
- `surf_ace_snapshot`: local-only. Returns the provider's cached pane snapshot.
- `surf_ace_annotate_remove`: removes specific live overlay stroke ids.

## Operating rules

1. Never assume pane topology. Read it with `surf_ace_list`.
2. Treat `content.set` as immediate visible ownership for that pane.
3. Treat `content.append` and `content.patch` as mutations against the currently visible content only.
4. Use `surf_ace_read` for annotation interpretation. Do not expect it to make a live network call.
5. Use `surf_ace_snapshot` only when the cached visual context is needed; it is not authoritative if the provider has never synced that pane yet.
