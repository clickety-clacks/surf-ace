# Surf Ace Ops

Use `surf_ace_list` before any pane-scoped write or read. Every pane-scoped call requires both `fingerprint` and the opaque `paneId`; user-facing labels and reports must show the authority-projected `displayId`/`paneAddress`.

## Tool summary

- `surf_ace_list`: local-only. Returns surfaces, connection state, topology/topologyRevision, panes, globally unambiguous user-facing `displayId`/`paneAddress`, active content, and pending provider-side events.
- `surf_ace_push`: write tool for `content.set`.
- `surf_ace_clear`: clears the currently visible content for the targeted pane.
- `surf_ace_launch_terminal`: launches a provider-owned process target through Surf Ace materialization. Native GUI/app proof must use this official provider path; direct compositor/native-pane hosting is diagnostic only.
- `surf_ace_realize_topology`: applies a desired root layout or pane subtree in one provider-side topology mutation.
- `surf_ace_read`: local-only. Returns the current cached content snapshot, including locally known pushed content, live dirty annotation state, finalized frame backlog, and consumed registers.
- `surf_ace_annotations_remove`: removes specific live overlay stroke ids.

## Operating rules

1. Never assume pane topology. Read it with `surf_ace_list`.
2. Treat `content.set` as immediate visible ownership for that pane.
3. Treat native GUI/app materialization as proven only when `surf_ace_launch_terminal` returns target evidence for the same actionable pane with `nativeHost` and `overlayRegions` applied, and product-approved capture shows visible rendering.
4. Never use direct compositor/native-pane hosting, demo fixtures, mocked compositor status, or manually hosted windows as Surf Ace product proof.
5. For multi-pane layout changes, prefer `surf_ace_realize_topology` with the `topologyRevision` returned by `surf_ace_list`.
6. Use `surf_ace_read` for readback and annotation interpretation. Do not expect it to make a live network call.
