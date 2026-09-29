---
name: surf-ace
description: Control Surf Ace through the installed standalone surf-ace CLI.
---

# Surf Ace

Use the installed `surf-ace` executable through ordinary command execution.
This skill does not change agent identity, add an MCP server, or start a
resident service.

The repository source for this skill is
`integrations/tightbeam/skills/surf-ace/SKILL.md`. To enable it for a
Tightbeam agent, ask the workspace administrator to register the file in the
served identity as `surf-ace`, attach `surf-ace` to the chosen archetype, and
apply that identity to existing sessions or provision a new session. The skill
provides CLI guidance only; the standalone executable must be installed
separately.

## Install and verify the CLI

Choose the versioned CLI archive for the host: `surf-ace-tightbeam-cli-linux-x86_64-v0.2.1.tar.gz` or `surf-ace-tightbeam-cli-macos-arm64-v0.2.1.tar.gz`. Download the archive, release manifest, and checksum file from the same published release. Verify the selected asset against `SHA256SUMS` before extracting it. For example, after downloading the full release asset set:

```sh
# Linux
sha256sum -c SHA256SUMS

# macOS
shasum -a 256 -c SHA256SUMS
```

Extract into a versioned, user-owned directory and keep the prior version
available until the new copy is checked:

```sh
VERSION=0.2.1
INSTALL_ROOT="$HOME/.local/opt/surf-ace/$VERSION"
mkdir -p "$INSTALL_ROOT"
tar -xzf "surf-ace-tightbeam-cli-linux-x86_64-v${VERSION}.tar.gz" -C "$INSTALL_ROOT"
CLI="$INSTALL_ROOT/surf-ace-cli/bin/surf-ace"
```

The macOS CLI archive has the same `surf-ace-cli/bin/surf-ace` path. This CLI
does not implement a `--version` flag. Check the release manifest's `version`,
`source.tag`, `source.commit`, and `tooling.tag` fields and verify the asset
checksum to identify the installed bytes. To upgrade or roll back, select the
versioned executable path for the desired verified release; no in-place CLI
updater is provided.

## Verify release-smoke participants

Before a release smoke starts or uses any server, CLI, or client, check that
participant independently against its exact v0.2.1 asset name, byte size,
SHA-256, product commit, and tooling commit. Rehash the archive bytes and stop
before launch or CLI operations on any mismatch. For Electron, also require the
packaged version and runtime `electron.app.getVersion()` to equal `0.2.1`, with
the runtime check completed before CLI operations. Do not infer the server or
CLI version from command output; identify those archives through their
versioned names, manifest, and checksum.

## Select a client and endpoint

Electron clients register their surfaces with the standalone registry. They
can discover that registry on the local network or use an explicit registry
WebSocket URL in `SURF_ACE_SERVER`. Use the registry or your deployment's
client inventory to identify the intended client and surface. Networked CLI
operations still connect directly to that client's WebSocket `/ws` endpoint,
not to the registry. If your inventory does not provide the client's direct
address, use an explicit address supplied for that client; never guess a host
or substitute the registry URL.

Supply runtime facts explicitly:

- `--state-root` names a durable local controller state root shared by
  sequential invocations for the same working context.
- `--endpoint` is the selected client's WebSocket URL for networked commands.
- `--product-label` is required for networked commands and is descriptive
  provenance, not identity or authority.
- `--input-json` supplies one command input object. Standard input is also
  accepted. Treat stdout as the machine-readable result.
- `friendlyChatName` is optional in `push`; include it only when the caller
  provides a friendly label. Do not invent one.

For example, list the selected client's surfaces:

```sh
"$CLI" --state-root "$STATE_ROOT" \
  --endpoint "$CLIENT_WS" \
  --product-label "Surf Ace" \
  list
```

For `push`, use the protocol's typed JSON value; do not send a bare text string
or use `contentType: "text"`. Accepted pairs include:

- `html`: `"content":{"html":"..."}` (optional `baseUrl`)
- `image`: `"content":{"data":"...","mediaType":"..."}` (optional `alt`)
- `pdf`: `"content":{"data":"..."}`
- `terminal`: `"content":{"lines":["..."],"scrollback":0}`
- `markdown`: `"content":{"markdown":"..."}`
- `video`: a string content value
- `canvas`: `"content":""` or an object with optional `color` and `grid`

Example markdown push:

```sh
"$CLI" --state-root "$STATE_ROOT" \
  --endpoint "$CLIENT_WS" \
  --product-label "Surf Ace" \
  push --input-json \
  '{"surfaceId":"sf_1","paneId":1,"contentId":"c1","contentType":"markdown","content":{"markdown":"# Visible result"}}'
```

Supported commands are `list`, `push`, `read`, `topology-intent`,
`topology-realize`, `clear`, `annotations-remove`, `capture-pane`,
`surface-intent`, `target-register`, and `target-apply`. Bind mutations and
reads to the exact `surfaceId` and numeric `paneId` required by each command.

`read` is special: omit `--endpoint` and `--product-label`. It is a local,
locked projection transaction and performs no network access. If it reports
`cacheStatus: "unsynchronized"`, use a later explicit networked command to
repair synchronization; do not replace the local read with a direct fetch.

For mutations, require the correlated `operationReceipt` in the result.
`outcome_unknown` means the request may have reached the client; do not retry
the mutation. A later networked invocation resolves the durable request
correlation. `still_pending` forbids another mutation. A
`receipt_unavailable` result with `controller_reclaimed` is permanent and must
not be inferred as success or retried.
