# Surf Ace resident controller

The resident controller is the only component that discovers Surf Ace clients,
holds WebSocket sessions, reconnects them, and persists the fleet projection.
It identifies an endpoint by its advertised fingerprint, or by its Bonjour
instance name when the fingerprint is absent. An address change therefore
replaces the connection without creating a second durable endpoint.

Each topology refresh sends `surfaces.list` first. It then sends `panes.list`
through the admitted session for every returned surface. Discovery loss marks
the endpoint unavailable but keeps the last durable topology.

The service exposes a versioned JSON-line protocol on a mode `0600` Unix
socket. The Rust `surf-ace` executable is a local client of this socket. It does
not discover clients, open WebSockets, persist controller state, or reconnect.

Required service environment:

- `SURF_ACE_STATE_DIR`: the durable controller state directory.
- `SURF_ACE_SOCKET_PATH`: the local Unix socket path.
- `SURF_ACE_PRODUCT_LABEL`: an optional controller label.

Build a reviewed Linux package from a new output path:

```sh
pnpm --filter @surf-ace/controller package:linux -- build/linux-package-reviewed
```

The package command refuses an existing output path. It produces a tar archive,
an archive SHA-256 file, and a manifest with a SHA-256 entry for every regular
file. The default target is `x86_64-unknown-linux-gnu`. A macOS build host uses
the checked-in Zig linker shim; a Linux build host uses its native linker.
