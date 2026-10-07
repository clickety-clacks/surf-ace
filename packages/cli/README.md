# surf-ace

General standalone native Rust Surf Ace controller CLI. It is directly callable
by any local program, script, user, or agent and is not a daemon, sidecar, MCP
server, archetype, or persistence service.

Every invocation supplies a state root. Client-directed network commands also
supply that client's Surf Ace WebSocket endpoint and product label; push
supplies its friendly chat label in the command input. `fleet-list` is the
separate read-only registry inventory command and supplies a registry WebSocket
URL instead. Nothing about a host, surface, deployment, or provenance label is
compiled in.

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

The existing public command set is `fleet-list`, `list`, `push`, `read`, `topology-intent`,
`topology-realize`, `clear`, `annotations-remove`, `capture-pane`,
`surface-intent`, `target-register`, and `target-apply`. Each command accepts
one JSON object via `--input-json` or standard input and writes exactly one JSON
result to standard output. `read` is strictly local and rejects `--endpoint`.
Every successful `capture-pane` call includes its PNG screenshot; the command
has no option to suppress it.

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
