# @surf-ace/ios

Surf Ace's Apple-platform client package contains the shared iOS/iPadOS runtime
and the native visionOS SurfAceSpatial target.

The visionOS target uses the same current lockless client model as iOS. It
reuses the local HTTP/WebSocket runtime, Bonjour discovery, surface
registration, topology handling, and pane geometry snapshot reporting.

The client uses `SURF_ACE_SERVER` (a `ws://` or `wss://` URL) first for
central registration, then discovers `_surf-ace._tcp` advertisements with
`role=server`. Registration uses the persisted signing identity and stores
allocated window labels in the lockless authority generation. Direct controller
pairing remains on the client WebSocket endpoint.

Transport security is narrow by design: hostname URLs, all `wss://` URLs, and
non-local numeric URLs continue through URLSession and ATS. A user-configured
local-use numeric `ws://` URL uses Network.framework's WebSocket transport to
avoid the numeric-host ATS rejection, remains pinned to that exact URL, and
never falls through to an unrelated Bonjour controller when unavailable. No
arbitrary-loads exception, LAN scan, or remote transport weakening is used.

Build gates:

```bash
xcodebuild -project packages/ios/SurfAce.xcodeproj -scheme SurfAceSpatial -configuration Debug -sdk xrsimulator -destination 'generic/platform=visionOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project packages/ios/SurfAce.xcodeproj -scheme SurfAce -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.4.1' CODE_SIGNING_ALLOWED=NO test
```

Surf Ace accepts only fresh or already-valid current lockless state. It does not
ship a state translation or recovery executable.
