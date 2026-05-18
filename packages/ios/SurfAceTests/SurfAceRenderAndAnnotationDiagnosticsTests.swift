import Foundation
import UIKit
import XCTest
@testable import SurfAce

@MainActor
final class SurfAceRenderAndAnnotationDiagnosticsTests: XCTestCase {
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
}

@MainActor
private final class RecordingPaneBridge: SurfAcePaneBridging {
    var renderedEntries: [SurfAcePaneEntry] = []
    var renderCallEntries: [SurfAcePaneEntry?] = []
    var interactionStates: [(annotationMode: Bool, fingerDrawEnabled: Bool)] = []

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

    func restoreDrawing(from drawingData: Data, strokes: [SurfAceStroke]) -> Bool {
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

    func clearDrawings() {}
}
