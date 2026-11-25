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

A direct `surface.describe` response carries the same observation as a
`blocked_by_<change>_since_<start>` entry in `applicationReadiness.limitationCodes`.
Underscores in the change name represent spaces. The start value is the
decimal Unix epoch in milliseconds, with digits 0 through 9 encoded as letters
`a` through `j`. The v1 response schema is unchanged. The CLI decodes the
entry into `applicationReadiness.readinessReason` with a UTC timestamp.

To reproduce in isolation, start a scratch app profile against a loopback
registry fixture. Issue `pane.split` on a registered window and hold the
registry fixture's `pane.claim` response. While it is held, inspect the window
banner, query `surface.describe`, and run `surf-ace window-describe` for that
window. Return the fixture's label allocation and check that all three
observations clear. The Electron server-connection test
`pane.split label claim reenters authority` holds and releases this request.
