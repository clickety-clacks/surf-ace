import Foundation
import XCTest
@testable import SurfAce

@MainActor
final class SurfAceRenderAndAnnotationDiagnosticsTests: XCTestCase {
    func testContentApplyRejectsWhenPaneRendererIsUnavailable() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "render-unavailable")
        let pane = try XCTUnwrap(surface.panes.first)

        let response = await runtime.contentApplyForTesting(
            id: "rq_render_unavailable",
            payload: htmlApplyPayload(paneId: pane.paneId, revision: 1),
            surfaceId: surface.surfaceId
        )
        let error = try XCTUnwrap(response["error"] as? [String: Any])

        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual(error["code"] as? String, "render_failed")
        XCTAssertEqual(pane.currentEntry.contentId, nil)
        XCTAssertEqual(pane.lastRenderDiagnostics.status, "failed")
        XCTAssertEqual(pane.lastRenderDiagnostics.bridgeAttached, false)
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
}

@MainActor
private final class RecordingPaneBridge: SurfAcePaneBridging {
    var renderedEntries: [SurfAcePaneEntry] = []
    var interactionStates: [(annotationMode: Bool, fingerDrawEnabled: Bool)] = []

    func render(entry: SurfAcePaneEntry?, restoreViewport: SurfAceViewport?) {
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
