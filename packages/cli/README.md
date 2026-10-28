# surf-ace

General standalone native Rust Surf Ace controller CLI. It is directly callable
by any local program, script, user, or agent and is not a daemon, sidecar, MCP
server, archetype, or persistence service.

Stateful invocations supply a controller state root. Client-directed commands
also supply that client's Surf Ace WebSocket endpoint and product label; push
supplies its friendly chat label in the command input. `fleet-list` and
`window-describe` instead use an explicit registry WebSocket URL. The
`window-describe` command is stateless: it creates no controller identity or
client admission. Nothing about a host, surface, deployment, or provenance
label is compiled in.

To discover registered client and surface identities, query the configured
registry explicitly:

```sh
surf-ace \
  --state-root /path/to/controller-state \
  --registry ws://registry.example:3210 \
  fleet-list
```

The command requires the explicit `--registry` URL; it does not select a default
registry or read one from environment/configuration. The result is the
registry's current `fleet.topology` snapshot: client IDs,
registered surfaces, window labels, pane IDs, pane labels, and pane addresses.
It reports registration inventory only, not endpoint addresses, client
reachability, or live application health. An empty `clients` array is a
successful empty inventory; an invalid or unavailable registry is an error.
Do not combine `--registry` and `--endpoint`; the command never pairs with or
mutates clients.

To resolve one lowercase window label against a fresh leased registry route and
observe the client directly before pairing, use `window-describe`:

```sh
surf-ace \
  --registry "$REGISTRY_WS" \
  --input-json '{"windowLabel":"a"}' \
  window-describe
```

This command needs neither `--state-root`, `--endpoint`, nor
`--product-label`. It requires exactly one current registry candidate, probes
the registered direct endpoint with a nonce-correlated `surface.describe`, and
rechecks the same registration and lease after the response. The result keeps
registry identity and lease freshness, transport reachability, application
readiness, surface topology/layout, and each pane's content revision in
separate fields. Missing or unreadable saved registry values and per-pane label
or content-observation details are reported as unavailable with limitation
codes; different but readable registry values are retained and marked as
different. The readable topology remains available. A different client or
surface still returns an identity mismatch, and an incomplete topology is not
presented as a successful observation. The v1 identity match is a consistency
check, not authentication. The command does not pair, create controller state, or
authorize a later mutation.

`window_not_found` and `window_ambiguous` require a fresh explicit selection;
never guess an endpoint from the registry host or choose the first duplicate.
`endpoint_unconfigured` means the matching client did not register both a direct
endpoint and pre-pair capability. `stale_registration` means the row or lease
was absent, invalid, expired, or changed during observation.
`endpoint_unreachable` reports a failed direct connection. If the WebSocket
connects but does not return a valid describe response, `application_unresponsive`
reports the reachable transport separately from unknown application readiness.
`client_not_ready` and `revision_churn` are explicit evidence, not permission to
fall back to a different route. For `client_not_ready`, the command includes the
direct client's existing message as `applicationReadiness.readinessReason`,
limited to 512 characters. Other bounded errors distinguish
invalid/unsupported responses and oversized responses. A later stateful read or mutation still
needs the explicitly selected client endpoint, and every mutation retains its
own expected-revision and correlated-receipt guards.

To list one selected client's surfaces, use that client's direct WebSocket
endpoint with the existing `list` command:

```sh
surf-ace \
  --state-root /path/to/controller-state \
  --endpoint ws://client.example:3210/ws \
  --product-label Surf-Ace-CLI \
  list
```

```sh
surf-ace \
  --state-root /path/to/controller-state \
  --endpoint ws://surf-ace.example:3210 \
  --product-label Surf-Ace-CLI \
  push --input-json '{"surfaceId":"sf_1","paneId":1,"contentId":"c1","contentType":"markdown","content":{"markdown":"Hello"},"friendlyChatName":"Terminal"}'
```

`push` validates the protocol's discriminated content value: `html` uses
`{"html":"..."}`, `image` uses `{"data":"...","mediaType":"..."}`, `pdf`
uses `{"data":"..."}`, `terminal` uses `{"lines":["..."],"scrollback":0}`,
`markdown` uses `{"markdown":"..."}`, `video` uses a string, and `canvas`
uses `""` or an object with optional `color` and `grid` fields.

The existing public command set is `fleet-list`, `window-describe`, `list`,
`pane-describe`, `push`, `read`, `topology-intent`, `topology-realize`,
`clear`, `annotations-remove`, `capture-pane`, `surface-intent`,
`target-register`, and `target-apply`. Each command accepts one JSON object via
`--input-json` or standard input and writes exactly one JSON result to standard
output. `read` is strictly local and rejects `--endpoint`.
Successful stateful results may include warning codes when some saved state
cannot be read. Readable scopes remain available; unreadable rows are retained,
unresolved operations continue to guard mutations, and unreadable acknowledgement
intents are not sent.
Every successful `capture-pane` call includes its PNG screenshot; the command
has no option to suppress it.

## Help and schemas

The native CLI exposes JSON help without requiring an endpoint, registry, or
state root:

```sh
surf-ace --help
surf-ace help topology-realize
surf-ace schema clear
surf-ace help annotations watch
surf-ace schema annotations ack
```

Command help reports the route, side effects, input JSON Schema, success result
shape, and error codes. The CLI validator remains authoritative; regression
tests run the documented layout and clear examples through that validator.
`fleet-list` still reports inventory only. `window-describe` is the
registry-to-direct-endpoint read-only probe; `list`, `pane-describe`, and
`capture-pane` pair the controller before their direct request. In particular,
`pane-describe` may persist admission, synchronization, cursor, acknowledgement,
or pending-receipt state and is not a substitute for no-pair discovery.

The separate registry annotation commands also have action-specific help and
schemas. `annotations watch` requires an unused consumer ID and creates a
durable registry consumer and lease before saving local state; an existing ID
is refused. `annotations resume` requires an existing registry consumer ID,
not a locally stored lease. It replaces and fences the prior lease, saves the
new local state, and may close another live listener using that same ID. Treat
both as consumer lifecycle operations. They emit NDJSON in the foreground;
record delivery does not acknowledge a record. Use `annotations ack` only
after durable processing, with either the exact cursor or a history gap ID.
`annotations retire` requires an explicit expected acknowledgement and the
discard flag.

This fixture example replaces a root layout with three vertical panes. Here
`sf_fixture`, revision `7`, and pane IDs `1`, `2`, and `3` are test values. In a
real invocation, use the current surface ID, topology revision, and the full
explicit list of pane IDs that may be destroyed:

```sh
surf-ace \
  --state-root "$STATE_ROOT" \
  --endpoint "$CLIENT_WS" \
  --product-label "Surf Ace CLI" \
  topology-realize --input-json \
  '{"surfaceId":"sf_fixture","expectedTopologyRevision":7,"target":{"root":true},"desired":{"type":"split","direction":"vertical","children":[{"type":"pane"},{"type":"pane"},{"type":"pane"}]},"allowDestroyPaneIds":[1,2,3]}'
```

After the layout is committed, read each pane's local projection separately.
Use a revision only when `cacheStatus` is `current`,
`currentContentRecord` is present, and the record belongs to that exact pane.
The projection can be unsynchronized or have a loss gap; in either case, do
not clear from its revision. Clear examples below use different fixture
revisions to show that the value is pane-local:

```sh
surf-ace --state-root "$STATE_ROOT" read \
  --input-json '{"scopeId":"pane:sf_fixture:1"}'
surf-ace --state-root "$STATE_ROOT" read \
  --input-json '{"scopeId":"pane:sf_fixture:2"}'
surf-ace --state-root "$STATE_ROOT" read \
  --input-json '{"scopeId":"pane:sf_fixture:3"}'

surf-ace --state-root "$STATE_ROOT" --endpoint "$CLIENT_WS" \
  --product-label "Surf Ace CLI" clear \
  --input-json '{"surfaceId":"sf_fixture","paneId":1,"expectedRevision":5}'
surf-ace --state-root "$STATE_ROOT" --endpoint "$CLIENT_WS" \
  --product-label "Surf Ace CLI" clear \
  --input-json '{"surfaceId":"sf_fixture","paneId":2,"expectedRevision":2}'
surf-ace --state-root "$STATE_ROOT" --endpoint "$CLIENT_WS" \
  --product-label "Surf Ace CLI" clear \
  --input-json '{"surfaceId":"sf_fixture","paneId":3,"expectedRevision":8}'
```

Replace each example revision with the exact `currentContentRecord.payload.revision`
returned for that pane. A stale-revision refusal requires a fresh read and a
recomputed request. A mutation result of `outcome_unknown` must be reconciled
through its durable correlation, never retried as a new request.

The separate registry annotation listener uses `annotations watch`,
`annotations resume`, `annotations ack`, and `annotations retire` with an
explicit `--registry` URL and `--state-root`. `watch` and `resume` stay in the
foreground and emit NDJSON; receiving a record does not acknowledge it.
After durably processing a delivered `ann1:<epoch>:<sequence>` cursor, call
`annotations ack --consumer-id <id> --cursor <cursor>` explicitly. History gaps
require `annotations ack --consumer-id <id> --gap-id <gapId>`. A consumer is
removed only by `annotations retire --consumer-id <id> --expect-ack <none|cursor>
--discard-unacknowledged`. These commands connect to the registry journal and
never pair with a client or mutate visible annotation state.

`read` keeps unread-delta consumption and current-state inspection separate.
Its `records` array contains only records at or beyond the projected cursor;
`currentContentRecord` independently returns the newest observed `content`
record for the exact pane scope, even after its consumable record is acknowledged
and pruned. A newer content record replaces it; an explicit clear, scope close,
or consumable-loss gap invalidates it. Scroll and other non-content records never
become current content. The value is withheld while the scope is unsynchronized
or has an unresolved loss gap.

`target-apply` returns after Surf Ace has durably committed the target intent,
before browser/native materialization. Its `operationReceipt` proves that intent
commit only. Materialization success or failure arrives later as a correlated
client-authoritative `event.target_apply_result` and append-only surface-scoped
`target_result`; a later CLI invocation reconciles that result into the bounded
local projection through the ordinary snapshot/delta path.
