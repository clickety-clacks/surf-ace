# surf-ace

General standalone native Rust Surf Ace controller CLI. It is directly callable
by any local program, script, user, or agent and is not a daemon, sidecar, MCP
server, archetype, or persistence service.

Every invocation supplies a state root. Networked commands also supply the Surf
Ace WebSocket endpoint and product label; push supplies its friendly chat label
in the command input. Nothing about a host, surface, deployment, or provenance
label is compiled in.

```sh
surf-ace \
  --state-root /path/to/controller-state \
  --endpoint ws://surf-ace.example:3210 \
  --product-label Clawline \
  push --input-json '{"surfaceId":"sf_1","paneId":1,"contentId":"c1","contentType":"markdown","content":{"markdown":"Hello"},"friendlyChatName":"CLU"}'
```

`push` validates the protocol's discriminated content value: `html` uses
`{"html":"..."}`, `image` uses `{"data":"...","mediaType":"..."}`, `pdf`
uses `{"data":"..."}`, `terminal` uses `{"lines":["..."],"scrollback":0}`,
`markdown` uses `{"markdown":"..."}`, `video` uses a string, and `canvas`
uses `""` or an object with optional `color` and `grid` fields.

The complete command set is `list`, `push`, `read`, `topology-intent`,
`topology-realize`, `clear`, `annotations-remove`, `capture-pane`,
`surface-intent`, `target-register`, and `target-apply`. Each command accepts
one JSON object via `--input-json` or standard input and writes exactly one JSON
result to standard output. `read` is strictly local and rejects `--endpoint`.

`target-apply` returns after Surf Ace has durably committed the target intent,
before browser/native materialization. Its `operationReceipt` proves that intent
commit only. Materialization success or failure arrives later as a correlated
client-authoritative `event.target_apply_result` and append-only surface-scoped
`target_result`; a later CLI invocation reconciles that result into the bounded
local projection through the ordinary snapshot/delta path.
