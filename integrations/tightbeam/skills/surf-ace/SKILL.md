---
name: surf-ace
description: Control Surf Ace through the installed general surf-ace CLI without changing agent identity.
---

# Surf Ace

Use the installed `surf-ace` executable through ordinary command execution. This skill adds a
capability; it does not select or alter an archetype and it declares no MCP
server or tools.

Supply the local controller socket explicitly:

- `--socket` or `SURF_ACE_CONTROLLER_SOCKET` identifies the resident
  controller's local Unix socket.
- The resident controller owns discovery, controller identity, durable
  projection state, WebSocket connections, and reconnects.
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
surf-ace --socket "$SURF_ACE_CONTROLLER_SOCKET" push --input-json \
  '{"surfaceId":"sf_1","paneId":1,"contentId":"c1","contentType":"markdown","content":{"markdown":"# Visible result"},"friendlyChatName":"CLU"}'
```

Commands are exactly: `list`, `push`, `read`, `topology-intent`,
`topology-realize`, `clear`, `annotations-remove`, `capture-pane`,
`surface-intent`, `target-register`, and `target-apply`.

`read` is a local controller projection transaction and performs no surface
network access. If it reports `cacheStatus: "unsynchronized"`, wait for the
resident controller to repair the projection; do not replace it with a direct
fetch.

For mutations, success requires the exact correlated `operationReceipt` in the
result. `outcome_unknown` means the request may have reached the client; do not
retry it. The resident controller resolves the durable request correlation.
`still_pending` forbids another mutation. `receipt_unavailable` with
`controller_reclaimed` is permanent and must not be inferred as success or
retried. The resident controller resolves durable request correlations.

Do not start another resident controller for this capability. Do not add MCP, a
dedicated archetype, a second sidecar/daemon, or another persistence service.
