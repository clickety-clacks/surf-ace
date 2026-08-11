# surf-ace

`surf-ace` is the thin local Linux client for the resident Surf Ace controller.
It validates one command and sends one versioned JSON-line request over a Unix
socket. It does not discover Surf Ace clients, open WebSockets, persist
controller state, or reconnect remote clients.

Supply the controller socket with `--socket` or
`SURF_ACE_CONTROLLER_SOCKET`:

```sh
surf-ace \
  --socket /run/user/1000/surf-ace/controller.sock \
  list --input-json '{}'
```

The complete command set remains `list`, `push`, `read`, `topology-intent`,
`topology-realize`, `clear`, `annotations-remove`, `capture-pane`,
`surface-intent`, `target-register`, and `target-apply`. Each command accepts
one JSON object through `--input-json` or standard input and writes exactly one
JSON result to standard output.

The resident controller supplies endpoint selection. `surface-intent` open and
restore operations can include `endpointId` when the fleet has multiple
endpoints. Other operations select the endpoint through the durable `surfaceId`
mapping returned by `list`.
