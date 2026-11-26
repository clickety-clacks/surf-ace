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

In `surface.describe` v1, a pending application-state save has an ordinary
`blocked_by_saving_application_state_since_<time>` limitation, followed by
one or more `save_surface_<part>` limitations. A surface ID is encoded in
byte order, high nibble first, with letters `a` through `p` for values 0
through 15. Parts concatenate in order. `save_surface_shared` identifies
a client-wide save without a single source surface. These are valid v1
limitation codes, and the original blocker code carries the save and start
time for older clients. A pending save can appear in describe even when
there is no queued request. Describe reports the oldest active instance
of each operation and source surface.
