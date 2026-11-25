# @surf-ace/protocol

Shared Surf Ace wire types and the extracted JSON Schema from `DESIGN.md`.

## Queued operation status

A lockless controller offers `surf-ace.operation-blocked.v1` in the
`pair.request` protocol features. Supporting Electron endpoints advertise
the same feature in the pair capabilities. The offer lets the endpoint report
a queue wait even during the pair request itself.

`event.operation_blocked` is scoped to the requesting socket. Its payload
contains the original `requestId`, the `surfaceId`, a human-readable
`message`, and an ordered `openChanges` list. Each list item has `operation`
and `startedAtMs`, a Unix epoch timestamp in milliseconds. The endpoint sends
at most one event for each queued request and sends none to callers that omit
the feature. The request keeps its original queue position and terminal
reply. The event does not acknowledge or change a durable receipt.
