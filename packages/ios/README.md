# @surf-ace/ios

Surf Ace's Apple-platform client package contains the shared iOS/iPadOS runtime and the native visionOS SurfAceSpatial target.

The visionOS target is intentionally the same Surf Ace client model as iOS: it reuses the existing local HTTP/WebSocket runtime, Bonjour discovery, surface registration, topology handling, and pane geometry snapshot reporting. It is not a separate provider or product.

Build gates:

```bash
xcodebuild -project packages/ios/SurfAce.xcodeproj -scheme SurfAceSpatial -configuration Debug -sdk xrsimulator -destination 'generic/platform=visionOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project packages/ios/SurfAce.xcodeproj -scheme SurfAce -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.4.1' CODE_SIGNING_ALLOWED=NO test
```

## Stopped-app legacy rollback

`SurfAceLegacyRollback` is a repo-owned macOS command-line target. It is an
operator-invoked migration executable only: it is not bundled into SurfAce and
does not add a service, daemon, launch item, startup hook, or device-side
helper. The tool never connects to or mutates a device. It operates only on
explicit host paths supplied by the operator.

Build and test it through XcodeBuildMCP from the reviewed merged source:

```bash
xcodebuildmcp macos test --scheme SurfAceLegacyRollback --project-path packages/ios/SurfAce.xcodeproj --derived-data-path "$RUN_DIR/DerivedData"
ROLLBACK="$RUN_DIR/DerivedData/Build/Products/Debug/SurfAceLegacyRollback"
```

Rollback has a hard precondition: `$PRIOR_APP` is the retained exact product-
approved legacy `.app` artifact from deployment history. It must exist before
preview and its deterministic digest is bound into the preview. Never recreate
it or extract installed application bytes from the device.

Resolve the physical device through `xcodebuildmcp device list`, record the live
device ID and SurfAce process ID, and stop the app before container extraction:

```bash
xcodebuildmcp device stop --device-id "$DEVICE_ID" --process-id "$SURF_ACE_PID"
xcrun devicectl device copy from \
  --device "$DEVICE_ID" \
  --source . \
  --destination "$ORIGINAL_CONTAINER" \
  --domain-type appDataContainer \
  --domain-identifier co.clicketyclacks.SurfAce \
  --json-output "$RUN_DIR/container-extract.json"
```

Keep `$ORIGINAL_CONTAINER` untouched. Preview binds its complete file-byte
manifest, exact lockless generation/hash, deterministic omissions, projected
legacy UserDefaults, and `$PRIOR_APP` digest without changing the container:

```bash
"$ROLLBACK" preview \
  --source-container "$ORIGINAL_CONTAINER" \
  --prior-app-artifact "$PRIOR_APP" \
  --output "$RUN_DIR/rollback-preview.json"
```

Create a separate exact host copy. `apply` refuses the source path, a changed
copy, changed source bytes, changed lockless generation, or a different prior
app artifact. It modifies only the two existing SurfAce legacy UserDefaults
data keys in the supplied copy and preserves unrelated preferences and the
authority generation bytes:

```bash
/usr/bin/ditto "$ORIGINAL_CONTAINER" "$LEGACY_CONTAINER_COPY"
"$ROLLBACK" apply \
  --source-container "$ORIGINAL_CONTAINER" \
  --container-copy "$LEGACY_CONTAINER_COPY" \
  --prior-app-artifact "$PRIOR_APP" \
  --preview "$RUN_DIR/rollback-preview.json" \
  --output "$RUN_DIR/rollback-apply.json"
```

Only after reviewing the preview/apply reports may the operator install the
captured legacy artifact and restore the transformed copy through the existing
device path:

```bash
xcodebuildmcp device install --device-id "$DEVICE_ID" --app-path "$PRIOR_APP"
xcrun devicectl device copy to \
  --device "$DEVICE_ID" \
  --source "$LEGACY_CONTAINER_COPY/." \
  --destination . \
  --domain-type appDataContainer \
  --domain-identifier co.clicketyclacks.SurfAce \
  --remove-existing-content true \
  --json-output "$RUN_DIR/container-legacy-restore.json"
xcodebuildmcp device launch --device-id "$DEVICE_ID" --bundle-id co.clicketyclacks.SurfAce
```

`restore` reconstructs the host copy from the retained untouched original and
fails unless the resulting file-byte manifest is exact. This is the restoration
proof used before any later operator-directed device restoration:

```bash
"$ROLLBACK" restore \
  --source-container "$ORIGINAL_CONTAINER" \
  --container-copy "$LEGACY_CONTAINER_COPY" \
  --prior-app-artifact "$PRIOR_APP" \
  --preview "$RUN_DIR/rollback-preview.json" \
  --output "$RUN_DIR/rollback-restored-manifest.json"
```
