# @surf-ace/ios

Surf Ace's Apple-platform client package contains the shared iOS/iPadOS runtime
and the native visionOS SurfAceSpatial target.

The visionOS target uses the same current lockless client model as iOS. It
reuses the local HTTP/WebSocket runtime, Bonjour discovery, surface
registration, topology handling, and pane geometry snapshot reporting.

Build gates:

```bash
xcodebuild -project packages/ios/SurfAce.xcodeproj -scheme SurfAceSpatial -configuration Debug -sdk xrsimulator -destination 'generic/platform=visionOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project packages/ios/SurfAce.xcodeproj -scheme SurfAce -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.4.1' CODE_SIGNING_ALLOWED=NO test
```

Surf Ace accepts only fresh or already-valid current lockless state. It does not
ship a state translation or recovery executable.
