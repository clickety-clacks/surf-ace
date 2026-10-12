---
name: surf-ace
description: "Control Surf Ace through the installed standalone surf-ace CLI. Use for Surf Ace or Surface panes and windows, including numbered pane or window references when that product context is established. Exclude ordinary operating-system windows and unrelated app panes."
---

# Surf Ace

Use the installed `surf-ace` executable through ordinary command execution.
This skill does not change agent identity, add an MCP server, or start a
resident service.

The repository source for this skill is
`integrations/tightbeam/skills/surf-ace/SKILL.md`. Install a release using the
matching skill asset, manifest, and `SHA256SUMS` from that same published
release; verify the checksum before registering the content as `surf-ace` in a
served identity. The standalone executable is a separate platform-specific
release asset. Do not copy deployment URLs, hostnames, ports, or topology into
this portable skill.

## Install and verify the CLI

Choose the Linux x86_64 or macOS arm64 CLI archive listed by the release
manifest. Download the archive, skill, manifest, and checksum file from the
same published release. Verify the selected archive and skill against
`SHA256SUMS` before extracting or installing them. For example, after
downloading the release assets:

```sh
# Linux
sha256sum -c SHA256SUMS

# macOS
shasum -a 256 -c SHA256SUMS
```

Extract into a versioned, user-owned directory and keep the prior version
available until the new copy is checked. Substitute the exact version and
asset filename from the verified manifest:

```sh
VERSION="REPLACE_WITH_MANIFEST_VERSION"
INSTALL_ROOT="$HOME/.local/opt/surf-ace/$VERSION"
mkdir -p "$INSTALL_ROOT"
tar -xzf "surf-ace-cli-linux-x86_64-v${VERSION}.tar.gz" -C "$INSTALL_ROOT"
CLI="$INSTALL_ROOT/surf-ace-cli/bin/surf-ace"
```

The macOS CLI archive has the same `surf-ace-cli/bin/surf-ace` path. Check the
release manifest's `version`, `source.tag`, `source.commit`, and `tooling.tag`
fields and verify the asset checksum to identify the installed bytes. Use
`--help` and the command schema for a local capability check. To upgrade or
roll back, select the versioned executable path for the desired verified
release; no in-place CLI updater is provided.

## Verify release-smoke participants

Before a release smoke starts or uses any server, CLI, or client, check that
participant against the exact asset name, byte size, SHA-256, product commit,
and tooling commit in its verified release manifest. Rehash the archive bytes
and stop before launch or CLI operations on any mismatch. Do not infer a
participant's version from the host, network, or command output; use its
versioned manifest and checksum.

## CLI help and schema

Use the installed CLI's help and schema before constructing an invocation:

```sh
"$CLI" --help
"$CLI" help topology-realize
"$CLI" schema clear
"$CLI" help annotations watch
"$CLI" schema annotations ack
"$CLI" help window-describe
"$CLI" schema window-describe
```

Command help reports route, side effects, input schema, success result shape,
and error behavior. The currently published v0.2.9-rc3 CLI supports help and
schema but predates `window-describe`; its schema will report that command as
unsupported. Use named-window discovery only with a verified CLI release whose
schema includes it. The examples below are fixtures; replace every identity,
revision, endpoint, and destroy list with current values from the intended
client. The CLI schema and validator tests cover the three-pane replacement
and pane-specific clear inputs.
The separate registry annotation commands use the registry journal. `watch`
requires an unused consumer ID and creates a durable registry consumer and
lease before saving local listener state. Reusing an existing consumer ID is a
registry refusal (`annotation_consumer_exists`). `resume` requires an existing
registry consumer ID; it does not require a locally stored lease. It obtains a
new lease, fences the prior lease, saves the new local state, and can terminate
another live listener using the same ID. Treat both commands as consumer
lifecycle operations, not read-only observation. They stream NDJSON until a
terminal event, and delivery does not acknowledge records. Use `ack` only after
durable processing, with the exact cursor or gap ID. `retire` requires an
explicit expected acknowledgement and the discard flag.

## Discover registered clients, then select a client

For registry-known inventory, query the registry explicitly before choosing a
client:

```sh
"$CLI" --state-root "$STATE_ROOT" \
  --registry "ws://<registry-host>:<port>" fleet-list
```

`fleet-list` reports only the registry's current registered-client and
surface/pane identity snapshot, including the assigned labels. It does not
report endpoint addresses, reachability, or live application health. An empty
`clients` array means the registry returned an empty inventory; an invalid or
unavailable registry is an error. Do not combine `--registry` and
`--endpoint`, and do not treat a registered client as proof that it is online.
Always pass the registry URL explicitly; the CLI does not infer one from
configuration or environment variables.

Registry inventory alone does not resolve a window label to a direct endpoint
or prove client reachability. Do not choose an endpoint from the registry URL
or guess a host or port. If the installed CLI schema includes
`window-describe`, use it for a read-only named-window observation:

```sh
"$CLI" --registry "$REGISTRY_WS" \
  --input-json '{"windowLabel":"a"}' \
  window-describe
```

The label must be lowercase ASCII letters. The command requires exactly one
current registry registration and a fresh endpoint lease. It sends a
nonce-correlated `surface.describe` directly to that leased endpoint before
controller pairing, then rereads the registry and refuses if the registration
or lease changed. It creates no controller state, does not send `pair.request`,
and does not authorize a later mutation. Its identity comparison is
`consistency_only_not_authentication`: neither the registry identity nor the
direct response proves cryptographic client identity.

The response keeps registry identity and lease freshness, transport
reachability, application readiness, topology/layout, and each pane's current
content revision separate. `window_not_found` and `window_ambiguous` require a
fresh explicit selection. `endpoint_unconfigured` means the matching client
did not register a direct endpoint and pre-pair capability. `stale_registration`
means the row or lease is absent, invalid, expired, or changed during the probe.
`endpoint_unreachable` reports a failed direct connection. If the WebSocket
connects but does not return a valid describe response, `application_unresponsive`
reports the reachable transport separately from unknown application readiness.
`client_not_ready`, `revision_churn`, unsupported protocol, invalid response,
and response-size errors are explicit outcomes; never guess another host or
port as fallback. A content revision is observation evidence only and
can become stale immediately. Before a later mutation, select the direct
endpoint explicitly and fetch the exact current topology/content revisions.

`pane-describe` is different: it makes a normal `pair.request` before
`panes.list` and may persist admission, synchronization, cursor, acknowledgement,
or pending-receipt reconciliation state. It is not a no-pair discovery
substitute. Use it only when that paired-controller admission is intended.

## Select a client and endpoint

Electron clients register their surfaces with the standalone registry. They
can discover that registry on the local network or use an explicit registry
WebSocket URL in `SURF_ACE_SERVER`. Use `fleet-list` or your deployment's
client inventory to identify the intended client and surface. Networked CLI
operations still connect directly to that client's WebSocket `/ws` endpoint,
not to the registry. If your inventory does not provide the client's direct
address, use an explicit address supplied for that client; never guess a host
or substitute the registry URL.

Supply runtime facts explicitly:

- `--state-root` names a durable local controller state root shared by
  sequential invocations for the same working context. `window-describe` does
  not require or create controller state; omit this option for that command.
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

Supported commands include `fleet-list`, `window-describe`, `list`,
`pane-describe`, `push`, `read`, `topology-intent`, `topology-realize`,
`clear`, `annotations-remove`, `capture-pane`, `surface-intent`,
`target-register`, and `target-apply`; availability depends on the installed
CLI's verified schema. Bind mutations and paired reads to the exact
`surfaceId` and numeric `paneId` required by each command.

To replace a root with three vertical panes, first inspect the current
topology. Name every pane that the replacement may destroy in
`allowDestroyPaneIds`, and use the current `topologyRevision`:

```sh
"$CLI" --state-root "$STATE_ROOT" --endpoint "$CLIENT_WS" \
  --product-label "Surf Ace CLI" topology-realize --input-json \
  '{"surfaceId":"sf_fixture","expectedTopologyRevision":7,"target":{"root":true},"desired":{"type":"split","direction":"vertical","children":[{"type":"pane"},{"type":"pane"},{"type":"pane"}]},"allowDestroyPaneIds":[1,2,3]}'
```

Afterward, read each intended pane's local projection. Use its revision only
when `cacheStatus` is `current`, `currentContentRecord` is present, and the
record belongs to that pane. A stale or unsynchronized projection is not
revision evidence:

```sh
"$CLI" --state-root "$STATE_ROOT" read \
  --input-json '{"scopeId":"pane:sf_fixture:1"}'
"$CLI" --state-root "$STATE_ROOT" read \
  --input-json '{"scopeId":"pane:sf_fixture:2"}'
"$CLI" --state-root "$STATE_ROOT" read \
  --input-json '{"scopeId":"pane:sf_fixture:3"}'

"$CLI" --state-root "$STATE_ROOT" --endpoint "$CLIENT_WS" \
  --product-label "Surf Ace CLI" clear \
  --input-json '{"surfaceId":"sf_fixture","paneId":1,"expectedRevision":5}'
"$CLI" --state-root "$STATE_ROOT" --endpoint "$CLIENT_WS" \
  --product-label "Surf Ace CLI" clear \
  --input-json '{"surfaceId":"sf_fixture","paneId":2,"expectedRevision":2}'
"$CLI" --state-root "$STATE_ROOT" --endpoint "$CLIENT_WS" \
  --product-label "Surf Ace CLI" clear \
  --input-json '{"surfaceId":"sf_fixture","paneId":3,"expectedRevision":8}'
```

These numbers and IDs are test fixtures only. Replace each
`expectedRevision` with the current `currentContentRecord.payload.revision`
from that same pane. On `stale_revision`, read again and recompute. On
`outcome_unknown`, resolve the durable request correlation instead of sending a
new clear.

Every successful `capture-pane` returns a PNG screenshot and capture metadata;
there is no option to suppress the screenshot, and it does not extract visible
text. Use `read` for the current content record. Settled
`event.scroll` visible text, when available, remains a separate event.

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
