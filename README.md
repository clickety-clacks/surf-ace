# Surf Ace

Surf Ace is a standalone surface system for coordinating Linux, macOS, and
iPadOS clients. The v0.2.1 release assets include a Linux registry/server
package, the Rust CLI, and Linux/macOS desktop clients. The iPadOS client is
built and signed separately; it is not part of the hosted asset set.

The former OpenClaw integration has been retired. This release has no extension
or provider configuration and does not require an agent gateway.

## Components and routing

- The Linux registry/server accepts client registrations and coordinates
  shared window labels through an already-provisioned PostgreSQL 16 allocator.
  It does not relay pair or content operations.
- Electron clients run on Linux and macOS. The iPadOS client is built and
  signed separately and is not a hosted release asset.
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
documentation for the exact inputs and outputs. The Linux server archive
includes `docs/OPERATIONS.md` with PostgreSQL configuration, health checks,
backup, staged restore, and rollback guidance.

## Release assets

The v0.2.1 release contains six versioned assets, a manifest, and
`SHA256SUMS`, which covers all six assets plus the manifest:

| Asset | Platform and purpose |
|---|---|
| `surf-ace-tightbeam-server-linux-x86_64-v0.2.1.tar.gz` | Linux registry/server, CLI, schemas, and operations guide |
| `surf-ace-tightbeam-cli-linux-x86_64-v0.2.1.tar.gz` | Linux CLI |
| `surf-ace-tightbeam-electron-linux-x86_64-v0.2.1.zip` | Linux desktop client |
| `surf-ace-tightbeam-cli-macos-arm64-v0.2.1.tar.gz` | macOS arm64 CLI |
| `surf-ace-tightbeam-electron-macos-arm64-v0.2.1.zip` | macOS arm64 desktop client |
| `surf-ace-tightbeam-skill-v0.2.1.md` | Standalone Tightbeam agent skill source |
| `surf-ace-tightbeam-v0.2.1-manifest.json` | Source, tooling, dependency, and asset identity |
| `SHA256SUMS` | Checksums for the six assets and manifest |

When published, download assets from the matching Surf Ace GitHub release.
After downloading the complete asset set into one directory, verify it with
`sha256sum -c SHA256SUMS` on Linux or `shasum -a 256 -c SHA256SUMS` on macOS.
Inspect the manifest's `version`, `source`, and `tooling` fields before
installing. The CLI does not implement a `--version` switch. Verify the
downloaded CLI's version from its versioned asset name and the verified
manifest before installing; after installation, the PATH link below points
into that version-specific directory, so its target identifies the active
release.

## Testing and participant identity

Before a release smoke uses any server, CLI, or client, it records and verifies
that participant's exact v0.2.1 asset name, byte size, SHA-256, product commit,
and tooling commit. It rehashes the archive bytes before use and stops before
launch or CLI operations if any participant does not match. Checking the server
or CLI does not establish the client's identity, and vice versa. For Electron,
the packaged `@surf-ace/electron` version and the running
`electron.app.getVersion()` value must both be `0.2.1`; the runtime value is
checked before CLI operations. Server and CLI archives do not expose a separate
version command, so their identity comes from the versioned asset name, manifest
and checksum rather than inferred command output.

## Tightbeam agent skill

This repository includes the Surf Ace Tightbeam skill at
[`integrations/tightbeam/skills/surf-ace/SKILL.md`](./integrations/tightbeam/skills/surf-ace/SKILL.md).
The same file is published separately as
`surf-ace-tightbeam-skill-v0.2.1.md` and is covered by the release manifest and
`SHA256SUMS`. It teaches an agent to use the standalone `surf-ace` CLI; it is
guidance, not a plugin, a separate executable, or a resident service.

After downloading the release asset set, verify it with `SHA256SUMS` before
using any file. To enable the skill, ask a workspace administrator to register
the verified Markdown file in the served Tightbeam identity under the name
`surf-ace`, add `surf-ace` to the selected archetype's `skills` list, and apply
the updated identity to existing sessions or provision new sessions. Ask an
enabled agent to use its Surf Ace skill for these CLI operations. The skill
does not install the standalone executable; install that separately from the
platform-specific CLI asset below.

## Install and run

Extract CLI archives into a versioned user-owned directory so an older version
remains available for rollback. The example installs a bare `surf-ace` command
in `~/.local/bin` and places it on `PATH`. With the matching Linux CLI asset
and `SHA256SUMS` already downloaded and verified:

```sh
VERSION=0.2.1
INSTALL_ROOT="$HOME/.local/opt/surf-ace/$VERSION"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
tar -xzf "surf-ace-tightbeam-cli-linux-x86_64-v${VERSION}.tar.gz" -C "$INSTALL_ROOT"
ln -sfn "$INSTALL_ROOT/surf-ace-cli/bin/surf-ace" "$BIN_DIR/surf-ace"
export PATH="$BIN_DIR:$PATH"
command -v surf-ace
readlink "$(command -v surf-ace)"
surf-ace \
  --state-root "$HOME/.local/state/surf-ace" \
  --endpoint "ws://client.example:3210/ws" \
  --product-label "Surf Ace" \
  list
```

The `readlink` output should point into the selected version directory, for
example `~/.local/opt/surf-ace/0.2.1/surf-ace-cli/bin/surf-ace`. Confirm the
asset name and manifest both identify `0.2.1`; the CLI itself has no version
command, so do not use `surf-ace --version`. Add `~/.local/bin` to your shell
startup file if you want the command on `PATH` in future sessions. To roll
back, change the symlink to a previously verified version directory.

For a macOS arm64 CLI, use
`surf-ace-tightbeam-cli-macos-arm64-v0.2.1.tar.gz`; its archive has the same
`surf-ace-cli/bin/surf-ace` executable path, and use the same versioned install,
symlink, and `PATH` steps with that archive. Extract a Linux desktop ZIP to a
user-owned directory and launch `Surf Ace/surf-ace`. Extract the macOS desktop
ZIP so `Surf Ace.app` is available, then open the app with Finder or `open`.
The iPadOS client is not in the hosted release assets; build and sign it
separately for your device using the standard development-signing workflow.

The Linux server archive extracts under `surf-ace-server/`. PostgreSQL 16 must
already be provisioned and configured; the package does not install a service,
create a database, or migrate a serving database. Follow the included
`docs/OPERATIONS.md` to create a private server configuration, then validate
and start the packaged foreground server:

```sh
SERVER_ROOT="$HOME/.local/opt/surf-ace/server/0.2.1/surf-ace-server"
SERVER_CONFIG="$HOME/.config/surf-ace/server.json"
"$SERVER_ROOT/bin/surf-ace-server" validate --config "$SERVER_CONFIG"
"$SERVER_ROOT/bin/surf-ace-server" start --config "$SERVER_CONFIG"
```

`start` stays in the foreground. Stop it with Ctrl-C or send `SIGTERM` to the
owned launcher process; it closes the registry and releases its writer lease.
The packaged `health` command checks a WebSocket handshake without registering
a client or changing registry state:

```sh
REGISTRY_WS="ws://registry.example:19001/ws"
"$SERVER_ROOT/bin/surf-ace-server" health --endpoint "$REGISTRY_WS"
```

## Upgrade and rollback

There is no in-place upgrade or rollback command. Keep verified releases in
separate versioned directories. For a server upgrade, follow the packaged
operations guide's PostgreSQL backup, staged-restore, validation, and rollback
procedure before switching the foreground server to the new version. Stop the
current server cleanly before starting another owner. If validation fails,
return to the previous verified server/client assets and retain the original
database; discard only the isolated staging database. Treat a release's
allocator initialization schema as an empty-database initializer unless that
release's operations guide explicitly documents an in-place migration. Never
apply initialization SQL over an existing database.

The release tooling does not install or enable the optional Linux service-unit
template. Service-manager setup and changes to PostgreSQL remain operator-owned
actions.
