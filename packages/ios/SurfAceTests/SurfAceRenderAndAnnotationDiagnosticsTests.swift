import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import SurfAce

@MainActor
final class SurfAceRenderAndAnnotationDiagnosticsTests: XCTestCase {
    func testRootContentFillIgnoresBottomSafeAreaButKeepsTopStatusBarSafeArea() {
        let ignoredEdges = surfAceRootContentIgnoredSafeAreaEdges()

        XCTAssertTrue(ignoredEdges.contains(.bottom))
        XCTAssertTrue(ignoredEdges.contains(.leading))
        XCTAssertTrue(ignoredEdges.contains(.trailing))
        XCTAssertFalse(ignoredEdges.contains(.top))
    }

    func testContentApplyReportsPendingRendererAndRendersOnAttach() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "render-pending")
        let pane = try XCTUnwrap(surface.panes.first)

        let response = await runtime.contentApplyForTesting(
            id: "rq_render_pending",
            payload: htmlApplyPayload(paneId: pane.paneId, revision: 1),
            surfaceId: surface.surfaceId
        )
        let payload = try XCTUnwrap(response["payload"] as? [String: Any])
        let render = try XCTUnwrap(payload["render"] as? [String: Any])

        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual(pane.currentEntry.contentId, "ct_1234abcd")
        XCTAssertEqual(render["status"] as? String, "pending_renderer")
        XCTAssertEqual(pane.lastRenderDiagnostics.bridgeAttached, false)
        XCTAssertEqual(render["bridgeAttached"] as? Bool, false)

        let bridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        XCTAssertEqual(bridge.renderedEntries.map(\.contentId), ["ct_1234abcd"])
        XCTAssertEqual(pane.lastRenderDiagnostics.status, "render_requested")
        XCTAssertTrue(pane.lastRenderDiagnostics.bridgeAttached)
    }

    func testPendingNonHTMLRendererDefersSnapshotHintUntilAttach() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "render-pending-image")
        let pane = try XCTUnwrap(surface.panes.first)

        let response = await runtime.contentApplyForTesting(
            id: "rq_render_pending_image",
            payload: imageApplyPayload(paneId: pane.paneId, revision: 1),
            surfaceId: surface.surfaceId
        )

        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual(pane.lastRenderDiagnostics.status, "pending_renderer")
        XCTAssertEqual(pane.pendingSnapshotHintReason, "after_render")

        let bridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        XCTAssertEqual(bridge.renderedEntries.map(\.contentId), ["ct_1234abce"])
        XCTAssertNil(pane.pendingSnapshotHintReason)
    }

    func testContentApplyReportsRenderDiagnosticsAndOwnerTitle() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "render-diagnostics")
        let pane = try XCTUnwrap(surface.panes.first)
        let bridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        let response = await runtime.contentApplyForTesting(
            id: "rq_render_diagnostics",
            payload: htmlApplyPayload(paneId: pane.paneId, revision: 1, title: "flynn"),
            surfaceId: surface.surfaceId
        )
        let payload = try XCTUnwrap(response["payload"] as? [String: Any])
        let render = try XCTUnwrap(payload["render"] as? [String: Any])

        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual(bridge.renderedEntries.map(\.contentId), ["ct_1234abcd"])
        XCTAssertEqual(pane.currentOwnerDisplayName(), "flynn")
        XCTAssertEqual(render["bridgeAttached"] as? Bool, true)
        XCTAssertEqual(render["status"] as? String, "render_requested")
        XCTAssertEqual(render["contentId"] as? String, "ct_1234abcd")
    }

    func testNativeContentScaleShortcutsRouteToActiveScalablePane() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "content-scale")
        let pane = try XCTUnwrap(surface.panes.first)
        let bridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        _ = await runtime.contentApplyForTesting(
            id: "rq_content_scale",
            payload: htmlApplyPayload(paneId: pane.paneId, revision: 1),
            surfaceId: surface.surfaceId
        )

        runtime.scaleActivePaneContent(.increase)
        runtime.scaleActivePaneContent(.decrease)
        runtime.scaleActivePaneContent(.reset)

        XCTAssertEqual(bridge.contentScales, [1, 1.1, 1, 1])
        XCTAssertEqual(pane.contentScale, 1)
    }

    func testNativeContentScaleRoutesToFocusedSurfacePane() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let firstSurface = runtime.registerSurface(sceneKey: "content-scale-first")
        let firstPane = try XCTUnwrap(firstSurface.panes.first)
        let firstBridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: firstSurface.surfaceId, paneId: firstPane.paneId, bridge: firstBridge)
        _ = await runtime.contentApplyForTesting(
            id: "rq_content_scale_first",
            payload: htmlApplyPayload(paneId: firstPane.paneId, revision: 1),
            surfaceId: firstSurface.surfaceId
        )

        let focusedSurface = runtime.registerSurface(sceneKey: "content-scale-focused")
        let focusedPane = try XCTUnwrap(focusedSurface.panes.first)
        let focusedBridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: focusedSurface.surfaceId, paneId: focusedPane.paneId, bridge: focusedBridge)
        _ = await runtime.contentApplyForTesting(
            id: "rq_content_scale_focused",
            payload: htmlApplyPayload(paneId: focusedPane.paneId, revision: 1),
            surfaceId: focusedSurface.surfaceId
        )

        runtime.scaleActivePaneContent(surfaceId: focusedSurface.surfaceId, action: .increase)
        runtime.scaleActivePaneContent(surfaceId: "missing-surface", action: .increase)

        XCTAssertEqual(firstBridge.contentScales, [1])
        XCTAssertEqual(firstPane.contentScale, 1)
        XCTAssertEqual(focusedBridge.contentScales, [1, 1.1])
        XCTAssertEqual(focusedPane.contentScale, 1.1)
    }

    func testNativeContentScaleIgnoresAnnotationModeAndUnscalableContent() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "content-scale-ignored")
        let pane = try XCTUnwrap(surface.panes.first)
        let bridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        runtime.scaleActivePaneContent(.increase)
        XCTAssertEqual(bridge.contentScales, [1])
        XCTAssertEqual(pane.contentScale, 1)

        _ = await runtime.contentApplyForTesting(
            id: "rq_content_scale_annotation",
            payload: htmlApplyPayload(paneId: pane.paneId, revision: 1),
            surfaceId: surface.surfaceId
        )
        runtime.setAnnotationMode(surfaceId: surface.surfaceId, paneId: pane.paneId, enabled: true, fingerDrawEnabled: false)
        runtime.scaleActivePaneContent(.increase)

        XCTAssertEqual(bridge.contentScales, [1])
        XCTAssertEqual(pane.contentScale, 1)
    }

    func testNativeContentScaleCommandShortcutsAreSurfAceOwned() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("SurfAce/SurfAceApp.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let commandIndex = try XCTUnwrap(source.range(of: "private struct SurfAceWindowCommands")?.lowerBound)
        let commandSource = source[commandIndex...]

        XCTAssertTrue(commandSource.contains("runtime.scaleActivePaneContent(surfaceId: commandSurfaceId, action: .increase)"))
        XCTAssertTrue(commandSource.contains(".keyboardShortcut(\"=\", modifiers: .command)"))
        XCTAssertTrue(commandSource.contains("runtime.scaleActivePaneContent(surfaceId: commandSurfaceId, action: .decrease)"))
        XCTAssertTrue(commandSource.contains(".keyboardShortcut(\"-\", modifiers: .command)"))
        XCTAssertTrue(commandSource.contains("runtime.scaleActivePaneContent(surfaceId: commandSurfaceId, action: .reset)"))
        XCTAssertTrue(commandSource.contains(".keyboardShortcut(\"0\", modifiers: .command)"))
        XCTAssertTrue(commandSource.contains("@FocusedValue(\\.surfAceCommandTargetSurfaceId)"))
    }

    func testNativeScalableContentTypeMatrix() {
        let scalablePayloads: [(SurfAceContentType, SurfAceFramePayload)] = [
            (.html, .html(html: "<p>hello</p>", baseURL: nil)),
            (.image, .image(data: "", mediaType: "image/png", alt: nil)),
            (.pdf, .pdf(data: "")),
            (.terminal, .terminal(lines: ["hello"], scrollback: 0)),
            (.markdown, .markdown(markdown: "# hello")),
            (.html, .browserURL(url: "https://example.com", allowedSnapshotFallback: nil, fallbackSnapshotTargetId: nil))
        ]
        for (index, payload) in scalablePayloads.enumerated() {
            XCTAssertTrue(surfAcePaneContentCanScale(contentScaleEntry(index: index, contentType: payload.0, payload: payload.1)))
        }

        XCTAssertFalse(surfAcePaneContentCanScale(.empty()))
        XCTAssertFalse(surfAcePaneContentCanScale(contentScaleEntry(
            index: 100,
            contentType: .canvas,
            payload: .canvas(color: nil, grid: false)
        )))
        XCTAssertFalse(surfAcePaneContentCanScale(contentScaleEntry(
            index: 101,
            contentType: .video,
            payload: .video(url: "https://example.com/video.mp4")
        )))
    }

    func testStalePaneBridgeDetachDoesNotClearReplacementBridge() throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "stale-bridge-detach")
        let pane = try XCTUnwrap(surface.panes.first)
        let staleBridge = RecordingPaneBridge()
        let replacementBridge = RecordingPaneBridge()

        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: staleBridge)
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: replacementBridge)
        runtime.detachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: staleBridge)

        XCTAssertTrue(pane.bridge === replacementBridge)
        runtime.detachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: replacementBridge)
        XCTAssertNil(pane.bridge)
    }

    func testMarkdownRenderMarksWebContentPendingUntilLoaded() throws {
        let frame = CGRect(x: 0, y: 0, width: 320, height: 240)
        let hostView = SurfAceSurfaceHostView(frame: frame)
        defer {
            hostView.render(
                entry: SurfAcePaneEntry.from(
                    frame: SurfAceFrame(
                        contentId: "ct_cleanup",
                        revision: 3,
                        contentType: .pdf,
                        payload: .pdf(data: ""),
                        reloadSource: nil,
                        title: nil,
                        scrollable: true,
                        interactive: true
                    ),
                    historyOwnerToken: "hot_test"
                ),
                restoreViewport: nil
            )
        }

        hostView.render(
            entry: SurfAcePaneEntry.from(
                frame: SurfAceFrame(
                    contentId: "ct_aaaabbbb",
                    revision: 1,
                    contentType: .html,
                    payload: .html(html: "<html><body style='margin:0;background:#f00;height:100vh'>T272-ALEPH-RETRY-1 pane capture visual oracle</body></html>", baseURL: nil),
                    reloadSource: nil,
                    title: nil,
                    scrollable: true,
                    interactive: true
                ),
                historyOwnerToken: "hot_test"
            ),
            restoreViewport: nil
        )

        XCTAssertTrue(hostView.hasPendingWebContentRenderForTesting)

        hostView.render(
            entry: SurfAcePaneEntry.from(
                frame: SurfAceFrame(
                    contentId: "ct_ccccdddd",
                    revision: 2,
                    contentType: .markdown,
                    payload: .markdown(markdown: "# Argus wrapped markdown\n\nThis is the currently visible markdown pane."),
                    reloadSource: nil,
                    title: nil,
                    scrollable: true,
                    interactive: true
                ),
                historyOwnerToken: "hot_test"
            ),
            restoreViewport: nil
        )

        XCTAssertTrue(hostView.hasPendingWebContentRenderForTesting)
    }

    func testPencilStrokeTransitionsAnnotationModeAndRecordsTool() {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "pencil-annotation")
        let pane = surface.panes.first!
        let bridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)
        pane.currentEntry = SurfAcePaneEntry.from(
            frame: SurfAceFrame(
                contentId: "ct_1234abcd",
                revision: 1,
                contentType: .html,
                payload: .html(html: "<p>Annotate</p>", baseURL: nil),
                reloadSource: nil,
                title: nil,
                scrollable: true,
                interactive: true
            ),
            historyOwnerToken: "hot_test"
        )

        runtime.handleNewStrokes(
            surfaceId: surface.surfaceId,
            paneId: pane.paneId,
            strokes: [
                SurfAceStroke(
                    strokeId: "stroke_test",
                    points: [SurfAceStrokePoint(x: 1, y: 2, pressure: 0.7, timestamp: 100)],
                    tool: "pencil"
                ),
            ],
            drawingData: Data([1, 2, 3])
        )

        XCTAssertTrue(pane.annotationMode)
        XCTAssertFalse(pane.fingerDrawEnabled)
        XCTAssertEqual(bridge.interactionStates.last?.annotationMode, true)
        XCTAssertEqual(pane.pendingFlushStrokes.first?.tool, "pencil")
    }

    func testPencilContactTransitionsAnnotationModeBeforeStroke() {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "pencil-contact")
        let pane = surface.panes.first!
        let bridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        runtime.handlePencilContact(surfaceId: surface.surfaceId, paneId: pane.paneId)

        XCTAssertTrue(pane.annotationMode)
        XCTAssertFalse(pane.fingerDrawEnabled)
        XCTAssertEqual(surface.activeKeyboardPaneId, pane.paneId)
        XCTAssertEqual(bridge.interactionStates.last?.annotationMode, true)
        XCTAssertEqual(bridge.interactionStates.last?.fingerDrawEnabled, false)
    }

    func testAnnotationBorderIsDrivenByAnnotationMode() {
        XCTAssertTrue(surfAceShowsAnnotationBorder(annotationMode: true))
        XCTAssertFalse(surfAceShowsAnnotationBorder(annotationMode: false))
    }

    func testDoneExitsAnnotationModeAndClearsRenderedAndStoredMarks() {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "annotation-done-clears")
        let pane = surface.panes.first!
        let bridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)
        pane.currentEntry = SurfAcePaneEntry.from(
            frame: SurfAceFrame(
                contentId: "ct_done_clears",
                revision: 1,
                contentType: .html,
                payload: .html(html: "<p>Annotate</p>", baseURL: nil),
                reloadSource: nil,
                title: nil,
                scrollable: true,
                interactive: true
            ),
            historyOwnerToken: "hot_test"
        )
        runtime.setAnnotationMode(surfaceId: surface.surfaceId, paneId: pane.paneId, enabled: true, fingerDrawEnabled: true)
        runtime.handleNewStrokes(
            surfaceId: surface.surfaceId,
            paneId: pane.paneId,
            strokes: [
                SurfAceStroke(
                    strokeId: "stroke_done",
                    points: [SurfAceStrokePoint(x: 10, y: 20, pressure: 1, timestamp: 100)],
                    tool: "finger"
                ),
            ],
            drawingData: Data([9, 8, 7])
        )

        runtime.setAnnotationMode(surfaceId: surface.surfaceId, paneId: pane.paneId, enabled: false, fingerDrawEnabled: false)

        XCTAssertFalse(pane.annotationMode)
        XCTAssertFalse(pane.fingerDrawEnabled)
        XCTAssertTrue(pane.currentEntry.drawingData.isEmpty)
        XCTAssertTrue(pane.currentEntry.strokesById.isEmpty)
        XCTAssertTrue(pane.pendingFlushStrokes.isEmpty)
        XCTAssertEqual(bridge.interactionStates.last?.annotationMode, false)
        XCTAssertEqual(bridge.clearDrawingsCallCount, 1)
    }

    func testVisibleEmptyEntryTracksPushedBrowserAndClearedStates() {
        let emptyEntry = SurfAcePaneEntry.empty()
        XCTAssertTrue(surfAceEntryIsVisibleEmpty(emptyEntry))

        let pushedEntry = SurfAcePaneEntry.from(
            frame: SurfAceFrame(
                contentId: "ct_visible",
                revision: 1,
                contentType: .html,
                payload: .html(html: "<p>Visible</p>", baseURL: nil),
                reloadSource: nil,
                title: nil,
                scrollable: true,
                interactive: true
            ),
            historyOwnerToken: "hot_visible"
        )
        XCTAssertFalse(surfAceEntryIsVisibleEmpty(pushedEntry))

        let browserEntry = SurfAcePaneEntry.browserURL(
            targetId: "target-browser",
            targetEpoch: 2,
            url: "https://example.com"
        )
        XCTAssertFalse(surfAceEntryIsVisibleEmpty(browserEntry))

        let clearedEntry = SurfAcePaneEntry.empty(revision: 3)
        XCTAssertTrue(surfAceEntryIsVisibleEmpty(clearedEntry))
    }

    func testSpatialEmptyPaneChromeGateTracksVisibleEmptyState() {
        let emptyEntry = SurfAcePaneEntry.empty()
        let pushedEntry = SurfAcePaneEntry.from(
            frame: SurfAceFrame(
                contentId: "ct_visible",
                revision: 1,
                contentType: .html,
                payload: .html(html: "<p>Visible</p>", baseURL: nil),
                reloadSource: nil,
                title: nil,
                scrollable: true,
                interactive: true
            ),
            historyOwnerToken: "hot_visible"
        )
        let browserEntry = SurfAcePaneEntry.browserURL(
            targetId: "target-browser",
            targetEpoch: 2,
            url: "https://example.com"
        )
        let clearedEntry = SurfAcePaneEntry.empty(revision: 3)

#if os(visionOS)
        XCTAssertTrue(surfAceShowsSpatialEmptyPaneChrome(entry: emptyEntry))
        XCTAssertFalse(surfAceShowsSpatialEmptyPaneChrome(entry: pushedEntry))
        XCTAssertFalse(surfAceShowsSpatialEmptyPaneChrome(entry: browserEntry))
        XCTAssertTrue(surfAceShowsSpatialEmptyPaneChrome(entry: clearedEntry))
#else
        XCTAssertFalse(surfAceShowsSpatialEmptyPaneChrome(entry: emptyEntry))
        XCTAssertFalse(surfAceShowsSpatialEmptyPaneChrome(entry: pushedEntry))
        XCTAssertFalse(surfAceShowsSpatialEmptyPaneChrome(entry: browserEntry))
        XCTAssertFalse(surfAceShowsSpatialEmptyPaneChrome(entry: clearedEntry))
#endif
    }

    func testSpatialWindowContentCornerMaskUsesResolvedPaneAndSurfaceGeometry() {
        let surfaceBounds = CGRect(x: 0, y: 0, width: 1000, height: 700)

        XCTAssertEqual(
            surfAceSpatialWindowContentCorners(
                paneFrame: CGRect(x: 0, y: 0, width: 400, height: 300),
                surfaceBounds: surfaceBounds,
                tolerance: 0.5
            ),
            SurfAceSpatialWindowContentCorners(
                topLeading: true,
                topTrailing: false,
                bottomLeading: false,
                bottomTrailing: false
            )
        )
        XCTAssertEqual(
            surfAceSpatialWindowContentCorners(
                paneFrame: CGRect(x: 400, y: 0, width: 600, height: 700),
                surfaceBounds: surfaceBounds,
                tolerance: 0.5
            ),
            SurfAceSpatialWindowContentCorners(
                topLeading: false,
                topTrailing: true,
                bottomLeading: false,
                bottomTrailing: true
            )
        )
        XCTAssertEqual(
            surfAceSpatialWindowContentCorners(
                paneFrame: CGRect(x: 100, y: 100, width: 500, height: 300),
                surfaceBounds: surfaceBounds,
                tolerance: 0.5
            ),
            SurfAceSpatialWindowContentCorners(
                topLeading: false,
                topTrailing: false,
                bottomLeading: false,
                bottomTrailing: false
            )
        )
    }

    func testSpatialEmptyPaneMarkerFramesOffsetOutwardFromContentBounds() throws {
        let paneSize = CGSize(width: 300, height: 200)
        let markerSize: CGFloat = 48
        let cornerInset = surfAceSpatialEmptyPaneCornerInset()
        let outwardOffset: CGFloat = 32
        let lineWidth: CGFloat = 3
        let paneBounds = CGRect(origin: .zero, size: paneSize)
        let expandedChromeBounds = CGRect(
            x: 0,
            y: 0,
            width: paneSize.width + outwardOffset * 2,
            height: paneSize.height + outwardOffset * 2
        )

        let topLeading = try XCTUnwrap(surfAceSpatialEmptyPaneMarkerFrame(
            size: paneSize,
            markerSize: markerSize,
            cornerInset: cornerInset,
            outwardOffset: outwardOffset,
            lineWidth: lineWidth,
            corner: .topLeading
        ))
        XCTAssertEqual(topLeading.origin, CGPoint(x: -32, y: -32))
        XCTAssertEqual(paneBounds.intersection(topLeading).size, CGSize(width: 16, height: 16))
        XCTAssertTrue(expandedChromeBounds.contains(topLeading.offsetBy(dx: outwardOffset, dy: outwardOffset)))

        let topTrailing = try XCTUnwrap(surfAceSpatialEmptyPaneMarkerFrame(
            size: paneSize,
            markerSize: markerSize,
            cornerInset: cornerInset,
            outwardOffset: outwardOffset,
            lineWidth: lineWidth,
            corner: .topTrailing
        ))
        XCTAssertEqual(topTrailing.origin, CGPoint(x: 284, y: -32))
        XCTAssertGreaterThan(topTrailing.maxX, paneSize.width)
        XCTAssertEqual(paneBounds.intersection(topTrailing).size, CGSize(width: 16, height: 16))
        XCTAssertTrue(expandedChromeBounds.contains(topTrailing.offsetBy(dx: outwardOffset, dy: outwardOffset)))

        let bottomLeading = try XCTUnwrap(surfAceSpatialEmptyPaneMarkerFrame(
            size: paneSize,
            markerSize: markerSize,
            cornerInset: cornerInset,
            outwardOffset: outwardOffset,
            lineWidth: lineWidth,
            corner: .bottomLeading
        ))
        XCTAssertEqual(bottomLeading.origin, CGPoint(x: -32, y: 184))
        XCTAssertGreaterThan(bottomLeading.maxY, paneSize.height)
        XCTAssertEqual(paneBounds.intersection(bottomLeading).size, CGSize(width: 16, height: 16))
        XCTAssertTrue(expandedChromeBounds.contains(bottomLeading.offsetBy(dx: outwardOffset, dy: outwardOffset)))

        let bottomTrailing = try XCTUnwrap(surfAceSpatialEmptyPaneMarkerFrame(
            size: paneSize,
            markerSize: markerSize,
            cornerInset: cornerInset,
            outwardOffset: outwardOffset,
            lineWidth: lineWidth,
            corner: .bottomTrailing
        ))
        XCTAssertEqual(bottomTrailing.origin, CGPoint(x: 284, y: 184))
        XCTAssertGreaterThan(bottomTrailing.maxX, paneSize.width)
        XCTAssertGreaterThan(bottomTrailing.maxY, paneSize.height)
        XCTAssertEqual(paneBounds.intersection(bottomTrailing).size, CGSize(width: 16, height: 16))
        XCTAssertTrue(expandedChromeBounds.contains(bottomTrailing.offsetBy(dx: outwardOffset, dy: outwardOffset)))
    }

    func testSpatialEmptyPaneMarkerFrameStaysVisibleInSmallPanes() throws {
        let paneSize = CGSize(width: 40, height: 32)
        let paneBounds = CGRect(origin: .zero, size: paneSize)

        for corner in SurfAceSpatialPaneChromeCorner.allCases {
            let frame = try XCTUnwrap(surfAceSpatialEmptyPaneMarkerFrame(
                size: paneSize,
                markerSize: 58,
                cornerInset: surfAceSpatialEmptyPaneCornerInset(),
                outwardOffset: 32,
                lineWidth: 3,
                corner: corner
            ))
            let visibleFrame = paneBounds.intersection(frame)
            XCTAssertGreaterThanOrEqual(visibleFrame.width, 16)
            XCTAssertGreaterThanOrEqual(visibleFrame.height, 16)
        }
    }

    func testProviderFreshAdmissionPreservesVisiblePaneContentUntilExplicitMutation() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "provider-absence-retains-content")
        let pane = try XCTUnwrap(surface.panes.first)
        let originalPaneId = pane.paneId
        let bridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        let pushResponse = await runtime.contentApplyForTesting(
            id: "rq_t1206_initial_content",
            payload: htmlApplyPayload(paneId: pane.paneId, revision: 1, title: "Still visible"),
            surfaceId: surface.surfaceId
        )
        XCTAssertEqual(pushResponse["ok"] as? Bool, true)
        XCTAssertEqual(pane.currentEntry.contentId, "ct_1234abcd")
        XCTAssertEqual(bridge.renderedEntries.map(\.contentId), ["ct_1234abcd"])

        runtime.freshProviderAdmissionTopologyForTesting(
            surfaceId: surface.surfaceId,
            windowLabel: "b",
            initialPaneId: 77,
            initialPaneLabel: 77
        )

        XCTAssertEqual(surface.windowLabel, "b")
        XCTAssertEqual(pane.paneId, originalPaneId)
        XCTAssertEqual(surface.panes.map(\.paneId), [originalPaneId])
        XCTAssertEqual(pane.currentEntry.contentId, "ct_1234abcd")
        XCTAssertEqual(pane.currentEntry.contentType, .html)
        XCTAssertEqual(bridge.renderedEntries.map(\.contentId), ["ct_1234abcd"])

        let replacementResponse = await runtime.contentApplyForTesting(
            id: "rq_t1206_replacement",
            payload: imageApplyPayload(paneId: pane.paneId, revision: 2),
            surfaceId: surface.surfaceId
        )
        XCTAssertEqual(replacementResponse["ok"] as? Bool, true)
        XCTAssertEqual(pane.currentEntry.contentId, "ct_1234abce")
        XCTAssertEqual(pane.currentEntry.contentType, .image)
        XCTAssertEqual(bridge.renderedEntries.map(\.contentId), ["ct_1234abcd", "ct_1234abce"])

        let clearResponse = await runtime.contentApplyForTesting(
            id: "rq_t1206_clear",
            payload: [
                "clear": true,
                "paneId": pane.paneId,
                "revision": 3,
            ],
            surfaceId: surface.surfaceId
        )
        XCTAssertEqual(clearResponse["ok"] as? Bool, true)
        XCTAssertTrue(surfAceEntryIsVisibleEmpty(pane.currentEntry))
        let lastRenderCall = try XCTUnwrap(bridge.renderCallEntries.last)
        XCTAssertNil(lastRenderCall)
    }

    func testClearAfterPushedContentRendersEmptyPaneState() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "pushed-clear-empty-pane")
        let pane = try XCTUnwrap(surface.panes.first)
        let bridge = RecordingPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        let pushResponse = await runtime.contentApplyForTesting(
            id: "rq_push_then_clear",
            payload: htmlApplyPayload(paneId: pane.paneId, revision: 1),
            surfaceId: surface.surfaceId
        )
        XCTAssertEqual(pushResponse["ok"] as? Bool, true)
        XCTAssertFalse(surfAceEntryIsVisibleEmpty(pane.currentEntry))
        XCTAssertEqual(bridge.renderedEntries.map(\.contentId), ["ct_1234abcd"])

        let clearResponse = await runtime.contentApplyForTesting(
            id: "rq_clear_after_push",
            payload: [
                "clear": true,
                "paneId": pane.paneId,
                "revision": 2,
            ],
            surfaceId: surface.surfaceId
        )
        XCTAssertEqual(clearResponse["ok"] as? Bool, true)
        XCTAssertTrue(surfAceEntryIsVisibleEmpty(pane.currentEntry))
        XCTAssertTrue(bridge.renderCallEntries.contains { $0?.contentId == "ct_1234abcd" })
        let lastRenderCall = try XCTUnwrap(bridge.renderCallEntries.last)
        XCTAssertNil(lastRenderCall)
    }

    private func isolatedUserDefaults() -> UserDefaults {
        let suiteName = "SurfAceRenderAndAnnotationDiagnosticsTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    private func htmlApplyPayload(paneId: Int, revision: Int, title: String? = nil) -> [String: Any] {
        var payload: [String: Any] = [
            "content": ["html": "<p>Hello render</p>"],
            "contentId": "ct_1234abcd",
            "contentType": "html",
            "historyOwnerToken": "hot_test",
            "paneId": paneId,
            "revision": revision,
        ]
        if let title {
            payload["display"] = ["title": title]
        }
        return payload
    }

    private func imageApplyPayload(paneId: Int, revision: Int) -> [String: Any] {
        [
            "content": [
                "data": "iVBORw0KGgo=",
                "mediaType": "image/png",
            ],
            "contentId": "ct_1234abce",
            "contentType": "image",
            "historyOwnerToken": "hot_test",
            "paneId": paneId,
            "revision": revision,
        ]
    }

    private func contentScaleEntry(
        index: Int,
        contentType: SurfAceContentType,
        payload: SurfAceFramePayload
    ) -> SurfAcePaneEntry {
        .from(frame: SurfAceFrame(
            contentId: String(format: "ct_%08x", index + 1),
            revision: 1,
            contentType: contentType,
            payload: payload,
            reloadSource: nil,
            title: nil,
            scrollable: true,
            interactive: true
        ))
    }
}

@MainActor
private final class RecordingPaneBridge: SurfAcePaneBridging {
    var renderedEntries: [SurfAcePaneEntry] = []
    var renderCallEntries: [SurfAcePaneEntry?] = []
    var interactionStates: [(annotationMode: Bool, fingerDrawEnabled: Bool)] = []
    var contentScales: [CGFloat] = []
    var clearDrawingsCallCount = 0

    func render(entry: SurfAcePaneEntry?, restoreViewport: SurfAceViewport?) {
        renderCallEntries.append(entry)
        if let entry {
            renderedEntries.append(entry)
        }
    }

    func renderBrowserURL(entry: SurfAcePaneEntry) async -> SurfAceBrowserNavigationResult {
        SurfAceBrowserNavigationResult(errorMessage: nil, status: "applied", url: entry.url ?? "")
    }

    func setInteraction(annotationMode: Bool, fingerDrawEnabled: Bool) {
        interactionStates.append((annotationMode: annotationMode, fingerDrawEnabled: fingerDrawEnabled))
    }

    func setContentScale(_ scale: CGFloat) {
        contentScales.append(scale)
    }

    func restoreDrawing(from drawingData: Data, strokes: [SurfAceStroke]) -> Bool {
        true
    }

    func restoreDrawingStrokes(_ strokes: [SurfAceStroke]) -> Bool {
        true
    }

    func captureDrawingData() -> Data {
        Data()
    }

    func fetchSnapshot(includeImage: Bool) async -> SurfAceSurfaceSnapshot? {
        nil
    }

    func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult {
        .failed("not implemented")
    }

    func removeDrawingStrokeIDs(_ strokeIDs: [String]) {}

    func clearDrawings() {
        clearDrawingsCallCount += 1
    }
}
