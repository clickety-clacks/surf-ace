---
name: surf-ace
description: Control Surf Ace through the installed general surf-ace CLI without changing agent identity.
---

# Surf Ace

Use the installed `surf-ace` executable through ordinary command execution. This skill adds a
capability; it does not select or alter an archetype and it declares no MCP
server or tools.

Supply all runtime facts explicitly:

- `--state-root` identifies one durable controller state root shared by
  sequential invocations.
- `--endpoint` is required for networked commands and must be the Surf Ace
  controller WebSocket selected by the current environment.
- `--product-label` is required for networked commands and is human-readable
  provenance, not identity or authority.
- `friendlyChatName` belongs in each `push` input when the caller has a friendly
  chat label. Never synthesize or hard-code it.
- `--input-json` contains one command input object. Treat stdout as the sole
  machine-readable result.

For `push`, send the protocol's typed JSON value; do not send a bare text string
or use `contentType: "text"`. The accepted pairs are:

- `html`: `"content":{"html":"..."}` (optional `baseUrl`)
- `image`: `"content":{"data":"...","mediaType":"..."}` (optional `alt`)
- `pdf`: `"content":{"data":"..."}`
- `terminal`: `"content":{"lines":["..."],"scrollback":0}`
- `markdown`: `"content":{"markdown":"..."}`
- `video`: a string content value
- `canvas`: `"content":""` or an object with optional `color` and `grid`

For example:

```sh
surf-ace --state-root "$STATE_ROOT" --endpoint "$SURF_ACE_ENDPOINT" \
  --product-label Clawline push --input-json \
  '{"surfaceId":"sf_1","paneId":1,"contentId":"c1","contentType":"markdown","content":{"markdown":"# Visible result"},"friendlyChatName":"OpenClaw"}'
```

Commands are exactly: `list`, `push`, `read`, `topology-intent`,
`topology-realize`, `clear`, `annotations-remove`, `capture-pane`,
`surface-intent`, `target-register`, and `target-apply`.

`read` is special: omit `--endpoint` and `--product-label`. It is a locked local
projection transaction and performs no network access. If it reports
`cacheStatus: "unsynchronized"`, use a later explicit networked command to
repair; do not replace it with a direct fetch.

For mutations, success requires the exact correlated `operationReceipt` in the
result. `outcome_unknown` means the request may have reached the client; do not
retry it. A later networked invocation resolves the durable request correlation.
`still_pending` forbids another mutation. `receipt_unavailable` with
`controller_reclaimed` is permanent and must not be inferred as success or
retried.

Never start a resident process for this capability. Do not add MCP, a dedicated
archetype, a sidecar/daemon, launchd/login-item/autostart, or another persistence
service.
