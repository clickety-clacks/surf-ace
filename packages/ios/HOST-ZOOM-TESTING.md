# Isolated native host-zoom comparison

`SurfAceHostZoomViewportTests` records actual WKWebView snapshots and native/DOM geometry. The minimal fixed/percentage iframe test needs no external assets. The frozen taskboard test requires the three hash-bound inputs identified by delivery artifact `art_f847d763`; absence explicitly skips that fixture and cannot count as its verification.

Before running that test in a granted exclusive simulator window, build the exact clean revision, install its test host only on the explicitly owned disposable simulator, and stage the frozen files in that app's **data** container (not the signed application bundle):

- `Library/Caches/HostZoomFixture/host-zoom-index.html`: SHA256 `731ce9b945ee5594e162576017a2d01f31b33878fb803676e45f80fc381af809`
- `Library/Caches/HostZoomFixture/host-zoom-board.json`: SHA256 `371fa9d3c0d49c00f092ed6a8b799d8b5a8e6a5dc928d2eb615ee43293ddeb2f`
- `Library/Caches/HostZoomFixture/host-zoom-wrapper.json`: SHA256 `498c1ea9dde6f9b84e65b7c60a805e300cacef210325b770a99959ea80413537`

Resolve the container using `simctl get_app_container` for the allocated simulator and `co.clicketyclacks.SurfAce`; never use a physical device or foreign simulator. Run the exact prebuilt source with the checked-in `SurfAceUnitTests` plan, serial execution, bounded deadline and negative Bonjour/central/fixed-port assertions. Preserve source/archive hashes and owned cleanup receipts.

The test verifies all three file hashes, asserts its OS-assigned no-reuse loopback listener's identity, serves the retained index and JSON bytes without content changes, and substitutes only the frozen wrapper's iframe URL for that private origin. WK content rules block other HTTP(S) origins. No production/site CSS or background patch is applied. A DOM mutation signal waits for the board to render before capturing geometry/screenshots; native viewport coverage and inner scroller coverage remain independent assertions.

The initial simple-iframe baseline at `85d9606` exposed a 32-point automatic top inset in its owned window. It did not independently reproduce the live right-side gap, and does not establish the cause of Aleph's reported 20-point bottom band. Preserve these limits when interpreting later before/after results. Font scale and physical font sizing need their own assertions before repair acceptance.

The packet-sized native comparison uses a 1024×820-point owned window and four pane multipliers (0.5, 1, 1.5, 2). It saves both WK backing snapshots and actual host-composition captures; physical paint assertions use the latter. A red 20-CSS-pixel marker and blue text separate font/scale measurement from dark gaps. The fixed and percentage iframe probes verify native edge paint, zero redundant insets, retained 0.85 base scaling and pane-coordinate tap delivery. The frozen board loads once before in-place font changes.

The native layout gives HTML/browser content an inverse-sized logical WK viewport and scales its native presentation back into the pane. Authored document CSS remains intact. Public scroll-edge effects are hidden inside this pane-owned viewport so top-edge content remains legible. Native input/selection geometry is converted to pane coordinates; scroll metadata retains its logical document units. The browser regression uses only an identity-checked private loopback listener, blocks other origins, rotates/resizes the same mounted WK instance and checks selected-text coordinates plus production composite snapshot dimensions.

Passing isolated fixtures establish source behavior, not physical Aleph/live g24 acceptance. Preserve failed before-images and host/pixel evidence; code review, integration and any device delivery remain separate gates.
