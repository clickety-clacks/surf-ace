# Surf Ace Client Diagnostics

Surf Ace clients write a local flight recorder for disconnected-client triage. Entries are timestamped in ISO-8601 and include lifecycle, selected endpoint, WebSocket, pair/session, surface, pane, and topology breadcrumbs when known.

The Electron flight recorder is bounded to 8 MiB. When it reaches the limit, it removes the oldest complete entries in place, keeping the existing log path and collection commands pointed at the most recent detail.

## macOS Electron

Default path:

```sh
~/Library/Application\ Support/@surf-ace/electron/client-flight-recorder.log
```

SSH collection:

```sh
tail -n 200 ~/Library/Application\ Support/@surf-ace/electron/client-flight-recorder.log
rg 'event=(app_|server_|socket_|pair_|topology_|surface_|window_)' ~/Library/Application\ Support/@surf-ace/electron/client-flight-recorder.log
```

Override path:

```sh
SURF_ACE_CLIENT_DIAGNOSTIC_LOG=/path/to/client-flight-recorder.log
```

## Linux Electron

Default path:

```sh
${XDG_STATE_HOME:-~/.local/state}/surf-ace/client-flight-recorder.log
```

SSH collection:

```sh
tail -n 200 "${XDG_STATE_HOME:-$HOME/.local/state}/surf-ace/client-flight-recorder.log"
rg 'event=(app_|server_|socket_|pair_|topology_|surface_|window_)' "${XDG_STATE_HOME:-$HOME/.local/state}/surf-ace/client-flight-recorder.log"
```

## iOS and visionOS

Default app-container path:

```sh
Library/Application Support/SurfAce/client-flight-recorder.log
```

Simulator collection:

```sh
APPDATA=$(xcrun simctl get_app_container booted co.clicketyclacks.SurfAce data)
tail -n 200 "$APPDATA/Library/Application Support/SurfAce/client-flight-recorder.log"
```

Physical-device collection:

```text
Xcode Devices and Simulators > select device > SurfAce > Download Container; inspect AppData/Library/Application Support/SurfAce/client-flight-recorder.log
```

## Surface blocked behind a change or save

The Electron status banner and `surf-ace window-describe` report the oldest
open change affecting the requested surface, or a save in the shared
application-state write queue. The status clears or advances to the next
blocker when that work settles.

A direct `surface.describe` response lists open changes and saves affecting
that surface as `blocked_by_<change>_since_<start>` entries in
`applicationReadiness.limitationCodes`, oldest first.
Underscores in the change name represent spaces. The start value is the
decimal Unix epoch in milliseconds, with digits 0 through 9 encoded as letters
`a` through `j`. The v1 response schema is unchanged. The CLI decodes the
entries into `applicationReadiness.openChanges` and shows the oldest in
`applicationReadiness.readinessReason` with a UTC timestamp.

To reproduce in isolation, start a scratch app profile against a loopback
registry fixture. Issue `pane.split` on a registered window and hold the
registry fixture's `pane.claim` response. While it is held, inspect the window
banner, query `surface.describe`, and run `surf-ace window-describe` for that
window. Return the fixture's label allocation and check that all three
observations clear. The Electron server-connection test
`pane.split label claim reenters authority` holds and releases this request.


### Queued controller requests

A controller can include `surf-ace.operation-blocked.v1` in the
`pair.request` protocol features. Supporting Electron surfaces send at most
one `event.operation_blocked` when that controller's request queues behind
tracked work. The event payload has `requestId`, `surfaceId`, `message` and
`openChanges`. Each open change has `operation` and `startedAtMs`, the Unix
epoch in milliseconds. The event is diagnostic, with no receipt or terminal
status. The request stays queued and retains its normal terminal response.
Controllers that omit the capability receive no event.

The native CLI offers the capability and prints the notice as one JSON line to
stderr as it arrives. Stdout still contains a single command result. An error
caused by a hold preserves its error code and includes the known blocker and
open changes in the error details.
