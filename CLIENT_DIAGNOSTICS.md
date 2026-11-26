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

The Electron status banner reports the blocker while a request or change
waits. It clears when no waiter remains. `surf-ace window-describe` reports
open changes and saves independently of whether a request is waiting.

A direct `surface.describe` response lists open changes and saves affecting
that surface as `blocked_by_<change>_since_<start>` entries in
`applicationReadiness.limitationCodes`, using the oldest active instance
of each operation and source surface.
Underscores in the change name represent spaces. The start value is the
decimal Unix epoch in milliseconds, with digits 0 through 9 encoded as letters
`a` through `j`. The v1 response schema is unchanged. The CLI decodes the
entries into `applicationReadiness.openChanges` and shows the oldest in
`applicationReadiness.readinessReason` with a UTC timestamp.

To reproduce in isolation, start a scratch app profile against a loopback
registry fixture. Issue `pane.split` on a registered window and hold the
registry fixture's `pane.claim` response. While it is held, query
`surface.describe` and run `surf-ace window-describe` for that window.
Send another request on the window while the claim is held, then inspect
the banner and, with the capability below, the queued request's notice.
Return the fixture's allocation and check that the banner and open changes
clear. The Electron server-connection test
`pane.split label claim reenters authority` holds and releases this request.

To isolate a pending save, launch the production Electron bundle with a
scratch profile and a loopback registry. In the test launcher, intercept
the next `node:fs/promises` rename whose destination is that profile's
`surface-core-state.json`. Let registration settle, move a local window
to save its position, and hold the intercepted rename. With no other
requests waiting, verify the absence of a blocked banner and notice.
Direct `surface.describe` and `surf-ace window-describe` identify the
save's start time and source surface. Submit a paired pane
mutation while the rename is held and observe the banner and the
negotiated notice. Release the rename and verify that the banner clears
and the request receives its normal terminal reply.

To exercise the recorder's label persistence diagnostic, hold the rename
for the save that includes the initial registry label assignment. The
`registry_label_waiting_for_local_persistence` entry names the label's
surface and the pending write even with `open_mutations=[]`. Writes without
a single source surface are listed as `shared`. The recorder logs changes
to the pending writes or open mutations while a label write is pending.

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

## Rejection recorder probe

Use a disposable Electron profile and a loopback-only test environment.
Launch the packaged desktop executable or the production Electron app with
`--inspect=127.0.0.1:0`, a fresh `--user-data-dir`, and
`SURF_ACE_CLIENT_DIAGNOSTIC_LOG` pointing to a scratch log. Keep
`ELECTRON_RUN_AS_NODE` unset. Attach to the main-process inspector URL
printed at startup and evaluate the following expression without awaiting
the promise.

```js
Promise.reject(new Error("surf-ace-rejection-probe")); "injected"
```

Check for `event=app_unhandled_rejection` with the reason and stack in the
scratch recorder. Evaluate `process.type` again to confirm the Electron
main process remains responsive. For a rejection with a non-Error reason,
the recorder includes the runtime warning stack when there is no original
error stack. The probe uses an inspector in the scratch app only.
