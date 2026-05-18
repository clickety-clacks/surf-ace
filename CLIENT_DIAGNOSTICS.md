# Surf Ace Client Diagnostics

Surf Ace clients write a local flight recorder for disconnected-client triage. Entries are timestamped in ISO-8601 and include lifecycle, selected endpoint, WebSocket, pair/session, surface, pane, and topology breadcrumbs when known.

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
