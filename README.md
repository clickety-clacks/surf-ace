# Surf Ace

Surf Ace is a standalone surface system for coordinating Linux, macOS, and
iPadOS clients. The v0.2.0 release includes a Linux registry/server package,
the Rust CLI, desktop clients, and a signed iPad app.

The former OpenClaw integration has been retired. This release has no extension
or provider configuration and does not require an agent gateway.

## Components and routing

- The Linux registry/server accepts client registrations and coordinates
  shared window labels through an already-provisioned PostgreSQL 16 allocator.
  It does not relay pair or content operations.
- Electron clients run on Linux and macOS. The iPadOS client is distributed as
  a signed IPA.
- The `surf-ace` CLI sends network operations directly to the selected client's
  WebSocket endpoint. The registry endpoint is not a CLI target.

Electron clients can discover a registry on their network or use an explicit
registry WebSocket URL with `SURF_ACE_SERVER`. The registry identifies
registered clients and surfaces. To operate on a surface, select the client
and surface in your deployment's inventory, then use that client's direct
`/ws` address; if the inventory does not provide the address, configure it
explicitly. Do not substitute the registry URL for the client's URL.

Every CLI invocation uses a state root. Networked commands also require the
client endpoint and a product label; `read` is a local state projection and
does not take an endpoint:

```sh
surf-ace \
  --state-root "$HOME/.local/state/surf-ace" \
  --endpoint "ws://client.example:3210/ws" \
  --product-label "Surf Ace" \
  list
```

The CLI provides `list`, `push`, `read`, `capture-pane`, topology, surface,
annotation, and target commands. See the packaged CLI README and protocol
documentation for the exact inputs and outputs.

## Release assets

The v0.2.0 release asset set is versioned and accompanied by a manifest and
`SHA256SUMS`:

| Asset | Platform and purpose |
|---|---|
| `surf-ace-tightbeam-server-linux-x86_64-v0.2.0.tar.gz` | Linux registry/server, CLI, schemas, and operations guide |
| `surf-ace-tightbeam-cli-linux-x86_64-v0.2.0.tar.gz` | Linux CLI |
| `surf-ace-tightbeam-electron-linux-x86_64-v0.2.0.zip` | Linux desktop client |
| `surf-ace-tightbeam-cli-macos-arm64-v0.2.0.tar.gz` | macOS arm64 CLI |
| `surf-ace-tightbeam-electron-macos-arm64-v0.2.0.zip` | macOS arm64 desktop client |
| `surf-ace-tightbeam-ios-ipad-v0.2.0.ipa` | Signed iPadOS client |
| `surf-ace-tightbeam-v0.2.0-manifest.json` | Source, tooling, dependency, signing, and asset identity |
| `SHA256SUMS` | Checksums for the six assets and manifest |

When published, download assets from the matching Surf Ace GitHub release.
After downloading the complete asset set into one directory, verify it with
`sha256sum -c SHA256SUMS` on Linux or `shasum -a 256 -c SHA256SUMS` on macOS.
Inspect the manifest's `version`, `source`, and `tooling` fields before installing. The CLI
does not provide a `--version` switch; use the versioned asset name, manifest,
and checksum rather than inferring a version from command output.

## Testing and participant identity

Before a release smoke uses any server, CLI, or client, it records and verifies
that participant's exact v0.2.0 asset name, byte size, SHA-256, product commit,
and tooling commit. It rehashes the archive bytes before use and stops before
launch or CLI operations if any participant does not match. Checking the server
or CLI does not establish the client's identity, and vice versa. For Electron,
the packaged `@surf-ace/electron` version and the running
`electron.app.getVersion()` value must both be `0.2.0`; the runtime value is
checked before CLI operations. Server and CLI archives do not expose a separate
version command, so their identity comes from the versioned asset name, manifest
and checksum rather than inferred command output.

## Install and run

Extract CLI archives into a versioned user-owned directory so an older version
remains available for rollback. For example, with the matching Linux CLI asset
and `SHA256SUMS` already downloaded and verified:

```sh
VERSION=0.2.0
INSTALL_ROOT="$HOME/.local/opt/surf-ace/$VERSION"
mkdir -p "$INSTALL_ROOT"
tar -xzf "surf-ace-tightbeam-cli-linux-x86_64-v${VERSION}.tar.gz" -C "$INSTALL_ROOT"
"$INSTALL_ROOT/surf-ace-cli/bin/surf-ace" \
  --state-root "$HOME/.local/state/surf-ace" \
  --endpoint "ws://client.example:3210/ws" \
  --product-label "Surf Ace" \
  list
```

For a macOS arm64 CLI, use
`surf-ace-tightbeam-cli-macos-arm64-v0.2.0.tar.gz`; its archive has the same
`surf-ace-cli/bin/surf-ace` executable path. Extract a Linux desktop ZIP to a
user-owned directory and launch `Surf Ace/surf-ace`. Extract the macOS desktop
ZIP so `Surf Ace.app` is available, then open the app with Finder or `open`.
Install the signed iPad IPA using your normal iPadOS app-distribution process.

The Linux server archive extracts under `surf-ace-server/`. PostgreSQL 16 must
already be provisioned and configured; the package does not install a service,
create a database, or migrate a serving database. Create a private server
configuration using the fields documented in
[`docs/release/tightbeam-linux-operations.md`](./docs/release/tightbeam-linux-operations.md),
then validate and start the packaged foreground server:

```sh
SERVER_ROOT="$HOME/.local/opt/surf-ace/server/0.2.0/surf-ace-server"
"$SERVER_ROOT/bin/surf-ace-server" validate --config "$SERVER_CONFIG"
"$SERVER_ROOT/bin/surf-ace-server" start --config "$SERVER_CONFIG"
```

`start` stays in the foreground. Stop it with Ctrl-C or send `SIGTERM` to the
owned launcher process; it closes the registry and releases its writer lease.
The packaged `health` command checks a WebSocket handshake without registering
a client or changing registry state:

```sh
"$SERVER_ROOT/bin/surf-ace-server" health --endpoint "$REGISTRY_WS"
```

## Upgrade and rollback

There is no in-place upgrade or rollback command. Keep verified releases in
separate versioned directories. For a server upgrade, follow the packaged
operations guide's PostgreSQL backup, staged-restore, validation, and rollback
procedure before switching the foreground server to the new version. Stop the
current server cleanly before starting another owner. If validation fails,
return to the previous verified server/client assets and retain the original
database; discard only the isolated staging database. Version 0.2.0's allocator
schema initializes an empty PostgreSQL 16 database and is not an in-place
migration. Do not apply it over an existing database.

The release tooling does not install or enable the optional Linux service-unit
template. Service-manager setup and changes to PostgreSQL remain operator-owned
actions.
