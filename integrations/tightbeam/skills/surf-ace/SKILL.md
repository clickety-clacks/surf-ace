---
name: surf-ace
description: "Control Surf Ace through the installed standalone surf-ace CLI. Use for Surf Ace or Surface panes and windows, including numbered pane or window references when that product context is established. Exclude ordinary operating-system windows and unrelated app panes."
---

# Surf Ace

Use the installed `surf-ace` executable through ordinary command execution.
This guide documents CLI usage; it does not install the executable or start a
resident service.

The canonical source for this guide is
`integrations/tightbeam/skills/surf-ace/SKILL.md`. Each Surf Ace CLI release
includes a versioned copy of the guide alongside the standalone CLI. Use the
CLI and guide from the same release, and verify both against that release's
manifest and checksum file. Configure an agent to load the verified Markdown
as its `surf-ace` skill. Do not copy deployment URLs, hostnames, ports, or
topology into this portable guide.

## Install and verify the CLI

Choose the Linux x86_64 or macOS arm64 CLI archive listed by the release
manifest. Download the archive, skill, supplement manifest, and versioned
checksum file from the same published release. Set the version from the
manifest's top-level `version` field; the checksum file is named
`surf-ace-cli-v${VERSION}-SHA256SUMS`. Verify the selected assets before
extracting or installing them. For example, after downloading the release
assets:

```sh
VERSION="REPLACE_WITH_MANIFEST_VERSION"
CHECKSUMS="surf-ace-cli-v${VERSION}-SHA256SUMS"

# Linux
sha256sum -c "$CHECKSUMS"

# macOS
shasum -a 256 -c "$CHECKSUMS"
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
supplement manifest's top-level `version`, `releaseTag`, `sourceCommit`, and
`sourceTree` fields, plus the selected artifact's `file`, `target`, `bytes`,
`sha256`, `binaryBytes`, and `binarySha256` fields. Verify the asset checksum
to identify the installed bytes. Use `--help` and the command schema for a
local capability check. To upgrade or roll back, select the versioned
executable path for the desired verified release; no in-place CLI updater is
provided.

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
and error behavior. Capabilities vary by CLI release; check the installed
version's `--help` and schema output before using a command. The examples below
are fixtures; replace every identity, revision, endpoint, and destroy list
with current values from the intended client. The CLI schema and validator
tests cover the three-pane replacement and pane-specific clear inputs.
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

Start with registry inventory before choosing a client or window:

```sh
"$CLI" --state-root "$STATE_ROOT" \
  --registry "ws://<registry-host>:<port>" fleet-list
```

`fleet-list` reports the registry's current client, surface, and pane snapshot,
including labels and any configured direct endpoint and lease. Endpoint and
lease values may be absent; their presence does not prove reachability or live
application health. An empty `clients` array means the registry returned an
empty inventory; an invalid or unavailable registry is an error. Do not
combine `--registry` and `--endpoint`, and do not treat a registered client as
proof that it is online. Pass the registry URL explicitly; the CLI does not
infer one from configuration or environment variables.

Use `window-describe` when the installed CLI schema includes it, to resolve a
named window through the registry and make a read-only observation:

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
fresh explicit selection. `endpoint_unconfigured` means the registry row has no
configured direct endpoint with pre-pair describe support; it does not prove
that the client cannot be reached on the local network. If no direct endpoint
is otherwise available, continue with Bonjour/DNS-SD browse and resolve for
the Surf Ace service (`_surf-ace._tcp`). Use the resolved service host, port,
and advertised WebSocket path to form `--endpoint`; do not guess an address or
derive one from the registry URL. A resolved iOS service may therefore remain
usable even after `window-describe` reports `endpoint_unconfigured`. One
resolved iOS example advertised port `19001` and path `/ws`; these are
discovery results, not defaults.
`stale_registration` means the row or lease is absent, invalid, expired, or
changed during the probe.
`endpoint_unreachable` reports a failed direct connection. If the WebSocket
connects but does not return a valid describe response, `application_unresponsive`
reports the reachable transport separately from unknown application readiness.
`client_not_ready`, `revision_churn`, unsupported protocol, invalid response,
and response-size errors are explicit outcomes. A content revision from a
read-only observation is evidence only and can become stale immediately.
Before a later mutation, select the direct endpoint explicitly and fetch the
current state required by that command's schema.

`pane-describe` is different: it makes a normal `pair.request` before
`panes.list` and may persist admission, synchronization, cursor, acknowledgement,
or pending-receipt reconciliation state. It is not a no-pair discovery
substitute. Use it only when that paired-controller admission is intended.

## Select a client and endpoint

Use the direct endpoint reported by the registry when available. Otherwise,
resolve the client's Bonjour/DNS-SD service and use its advertised WebSocket
endpoint. Networked CLI operations connect directly to that client, not to
the registry. Never substitute the registry URL for a client endpoint.

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

Before an ordinary pane operation, use this live `list` result to match the
stable `surfaceId` and `paneId`. Treat the surface name and `paneLabel` as
human-facing confirmation only; never target by a label or pane number alone.
If either stable ID does not match or is ambiguous, stop and re-identify. A
lineage check is optional when comparing a durable prior reference with a
possible reopened replacement: `list` does not return `paneLineageId`, so use
`pane-describe` for the same stable IDs and compare its lineage with the prior
reference. `pane-describe` sends `pair.request` before `panes.list` and may
persist admission, synchronization, cursor, acknowledgement, or pending-receipt
state; it is not a free read and is not required before ordinary content
mutations.

For `push`, use the protocol's typed JSON value; do not send a bare text string
or use `contentType: "text"`. Accepted pairs include:

- `html`: `"content":{"html":"..."}` (optional `baseUrl`)
- `image`: `"content":{"data":"...","mediaType":"..."}` (optional `alt`)
- `pdf`: `"content":{"data":"..."}`
- `terminal`: `"content":{"lines":["..."],"scrollback":0}`
- `markdown`: `"content":{"markdown":"..."}`
- `video`: a string content value
- `canvas`: `"content":""` or an object with optional `color` and `grid`

`push` sends `content.set`. It takes no controller-supplied revision: the
client allocates the revision and makes each accepted push a new visible
history entry, retaining the replaced entry in Back/Forward history under the
normal history limit. At the protocol level, `content.append` and
`content.patch` use their required expected-state tokens; this CLI does not
expose those operations. The CLI's `clear` command requires
`expectedRevision` for the selected pane's current content. Other commands use
the guards shown in their own schemas, such as topology or surface-set
revisions where applicable.

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

When a command's result schema specifies an `operationReceipt`, require the
receipt correlated to that request before treating the mutation as confirmed.
`outcome_unknown` means the request may have reached the client; do not retry
the mutation. A later networked invocation resolves the durable request
correlation. `still_pending` forbids another mutation. A
`receipt_unavailable` result with `controller_reclaimed` is permanent and must
not be inferred as success or retried.
