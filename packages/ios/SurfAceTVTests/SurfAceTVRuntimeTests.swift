import XCTest
import UIKit
@testable import SurfAce

@MainActor
final class SurfAceTVRuntimeTests: XCTestCase {
    private var observedEvents: [[String: Any]] = []
    private struct Fixture {
        let runtime: SurfAceRuntime
        let surface: SurfAceSurfaceModel
        let pane: SurfAcePaneModel
        let adapter: SurfAceLocklessRuntimeAdapter
        let socket: URLSessionWebSocketTask
        let view: SurfAceTVPaneView
    }

    private func fixture() async throws -> Fixture {
        let name = "SurfAceTVRuntime-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        let runtime = SurfAceRuntime(userDefaults: defaults,
            locklessStateURL: directory.appendingPathComponent("state.json"),
            configuredRegistryURL: URL(string: "ws://127.0.0.1:1/ws")!,
            annotationClientId: name, enableFleetDiscovery: false, isolatedTestLoopback: true)
        await runtime.start()
        addTeardownBlock {
            await runtime.stop()
            UserDefaults(suiteName: name)?.removePersistentDomain(forName: name)
            try? FileManager.default.removeItem(at: directory)
        }
        let registered = await runtime.registerSurfaceForScene(sceneKey: name)
        let surface = try XCTUnwrap(registered)
        let pane = try XCTUnwrap(surface.panes.first)
        let view = SurfAceTVPaneView(frame: CGRect(x: 0, y: 0, width: 960, height: 540))
        pane.retainedHostView = view
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: view)
        let socket = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(runtime.serverPort)/ws")!)
        socket.maximumMessageSize = 12 * 1_024 * 1_024
        socket.resume()
        addTeardownBlock { socket.cancel(with: .normalClosure, reason: nil) }
        let paired = try await request(socket, op: "pair.request", payload: [
            "controllerInstanceId": "tv-test-controller", "controllerProductName": "integration-client",
            "projectionCapacityBytes": 8 * 1_024 * 1_024,
            "protocolFeatures": [surfAceLocklessCapability], "protocolVersion": 1, "surfaceId": surface.surfaceId])
        _ = try XCTUnwrap(paired["ok"] as? Bool == true ? paired : nil, "\(paired)")
        return Fixture(runtime: runtime, surface: surface, pane: pane,
                       adapter: try runtime.locklessAuthorityForLocalMutation(), socket: socket, view: view)
    }

    func testRejectedHTMLOverlayPreservesAcceptedImageAndAnnotations() async throws {
        let f = try await fixture()
        let accepted = try await push(f, type: "image", content: imageContent())
        XCTAssertEqual(accepted["ok"] as? Bool, true, "\(accepted)")
        try await annotate(f, id: "saved-stroke")
        let before = await f.adapter.snapshot()
        let previous = before.liveSurfaces[f.surface.surfaceId]?.panes[String(f.pane.paneId)]?.history
        let contentID = f.pane.currentEntry.contentId
        let screenshot = await f.view.fetchSnapshot()
        let rejected = try await push(f, type: "html", content: ["html": "<h1>Heading</h1><ul><li>Item</li></ul><script>hidden()</script><style>hidden{}</style>"])
        XCTAssertEqual(rejected["ok"] as? Bool, false)
        XCTAssertEqual((rejected["error"] as? [String: Any])?["code"] as? String, "unsupported_content_type")
        let overlay = try XCTUnwrap(f.pane.htmlDiagnostic)
        XCTAssertEqual(overlay.warning, "Shown as text. Apple TV can't display web pages.")
        XCTAssertTrue(overlay.text.contains("Heading")); XCTAssertTrue(overlay.text.contains("Item"))
        XCTAssertFalse(overlay.text.contains("hidden"))
        XCTAssertEqual(f.pane.currentEntry.contentId, contentID)
        let captured = await f.view.fetchSnapshot()
        XCTAssertEqual(captured?.imageBase64, screenshot?.imageBase64, "Capture remains accepted content, not diagnostic")
        f.runtime.setAnnotationMode(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId,
                                    enabled: true, fingerDrawEnabled: false)
        let blocked = stroke("blocked")
        f.runtime.handleNewStrokes(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId,
                                   strokes: [blocked], drawingData: Data())
        await f.runtime.awaitAnnotationStrokeCapture(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId)
        let after = await f.adapter.snapshot()
        XCTAssertEqual(after.liveSurfaces[f.surface.surfaceId]?.panes[String(f.pane.paneId)]?.history, previous)
        XCTAssertTrue(f.pane.annotationMode, "Overlay does not finalize existing annotation")
        for type in ["canvas", "video"] {
            let failed = try await push(f, type: type, content: ["url": "https://example.com/movie"])
            XCTAssertEqual(failed["ok"] as? Bool, false)
            XCTAssertNotNil(f.pane.htmlDiagnostic, "A failed later push cannot dismiss the overlay")
        }
        f.pane.htmlDiagnostic = nil
        XCTAssertEqual(f.pane.currentEntry.contentId, contentID)
        f.runtime.setAnnotationMode(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId,
                                    enabled: false, fingerDrawEnabled: false)
        await f.runtime.awaitAnnotationModeTransition(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId)
        await f.runtime.awaitAnnotationCommit(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId)
        _ = try await push(f, type: "html", content: ["html": "<p>Again</p>"])
        let terminal = try await push(f, type: "terminal", content: ["lines": ["Accepted next"], "scrollback": 200])
        XCTAssertEqual(terminal["ok"] as? Bool, true, "\(terminal)")
        XCTAssertNil(f.pane.htmlDiagnostic)
        XCTAssertEqual(f.pane.currentEntry.contentType, .terminal)
        XCTAssertTrue(f.view.visibleText.contains("Accepted next"))
    }

    func testEveryAcceptedTypeUsesExistingAnnotationAndDoneSemantics() async throws {
        let f = try await fixture()
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 400, height: 300)).pdfData { context in
            context.beginPage(); UIColor.blue.setFill(); context.cgContext.fill(CGRect(x: 0, y: 0, width: 400, height: 300))
        }
        let examples: [(String, [String: Any])] = [
            ("image", imageContent()), ("terminal", ["lines": ["A", "B"], "scrollback": 200]),
            ("markdown", ["markdown": "# Document\n\n**Readable**"]), ("pdf", ["data": pdf.base64EncodedString()])]
        for (type, content) in examples {
            let response = try await push(f, type: type, content: content)
            XCTAssertEqual(response["ok"] as? Bool, true, "\(response)")
            try await annotate(f, id: "stroke-\(type)")
            XCTAssertTrue(f.pane.annotationMode)
            XCTAssertNotNil(f.pane.currentEntry.strokesById["stroke-\(type)"])
            // Back only leaves Remote controls; retained runtime mode and stroke remain.
            let retained = await f.adapter.snapshot()
            XCTAssertNotNil(retained.annotationPublisher?.openFrame(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId))
            f.runtime.setAnnotationMode(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId,
                                        enabled: false, fingerDrawEnabled: false, source: "remote_done")
            await f.runtime.awaitAnnotationModeTransition(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId)
            await f.runtime.awaitAnnotationCommit(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId)
            await f.runtime.awaitAnnotationDirectCompletion(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId)
            _ = try await request(f.socket, op: "heartbeat.ping", payload: [:])
            XCTAssertTrue(observedEvents.contains { event in
                guard event["op"] as? String == "event.drawing_flush",
                      let payload = event["payload"] as? [String: Any],
                      let strokes = payload["strokes"] as? [[String: Any]] else { return false }
                return strokes.contains { $0["strokeId"] as? String == "stroke-\(type)" }
            }, "Existing drawing_flush delivers the Remote stroke for \(type)")
            XCTAssertFalse(f.pane.annotationMode)
            // The existing Done path clears the local drawing after staging its flush.
            XCTAssertTrue(f.view.strokes.isEmpty)
        }
    }

    func testResizePreviewDoesNotMutateAndConfirmCommitsOncePreservingContent() async throws {
        let f = try await fixture()
        _ = try await push(f, type: "terminal", content: ["lines": ["Retain me"], "scrollback": 200])
        let surfaceID = f.surface.surfaceId
        _ = try await f.adapter.commitLocalMutation(operation: "test.split") { state, _ in
            let revision = state.liveSurfaces[surfaceID]!.topologyRevision
            _ = try SurfAceLocklessTopologyOperations.paneSplit(state: &state, surfaceId: surfaceID,
                paneId: 1, count: 2, direction: "horizontal", expectedTopologyRevision: revision)
            return .null
        }
        // An ordinary request projects the latest authority into the mounted models.
        _ = try await push(f, type: "terminal", content: ["lines": ["Retain me"], "scrollback": 200])
        let before = await f.adapter.snapshot()
        let revision = try XCTUnwrap(before.liveSurfaces[surfaceID]?.topologyRevision)
        var preview = SurfAceTVArrangement(original: f.surface.paneLayout, expectedRevision: revision,
                                           paneId: f.pane.paneId, targetPaneId: 2)
        preview.action = .resize; preview.fraction = 0.7
        _ = preview.preview
        let previewState = await f.adapter.snapshot()
        XCTAssertEqual(previewState.liveSurfaces[surfaceID], before.liveSurfaces[surfaceID])
        try await f.runtime.confirmTVArrangement(surfaceId: surfaceID, preview: preview)
        let after = await f.adapter.snapshot()
        XCTAssertEqual(after.liveSurfaces[surfaceID]?.topologyRevision, revision + 1)
        XCTAssertEqual(after.liveSurfaces[surfaceID]?.panes, before.liveSurfaces[surfaceID]?.panes)
        XCTAssertNotEqual(after.liveSurfaces[surfaceID]?.topology, before.liveSurfaces[surfaceID]?.topology)
    }

    func testInvalidPDFAndBrowserTargetPreserveAcceptedContentWithWarning() async throws {
        let f = try await fixture()
        _ = try await push(f, type: "markdown", content: ["markdown": "Keep this document"])
        let before = await f.adapter.snapshot()
        let failed = try await push(f, type: "pdf", content: ["data": Data("not a PDF".utf8).base64EncodedString()])
        XCTAssertEqual(failed["ok"] as? Bool, false)
        XCTAssertEqual((failed["error"] as? [String: Any])?["code"] as? String, "render_failed")
        let browser = try await request(f.socket, op: "target.apply", payload: [
            "paneId": f.pane.paneId, "requestId": "tv-browser", "restoreReason": "initial",
            "surfaceId": f.surface.surfaceId, "targetEpoch": 1,
            "targetHeader": ["replaySemantics": "navigate", "requiredCapabilities": ["target.browser_url.v1"]],
            "targetId": "browser", "targetKind": "browser_url", "targetPayload": ["url": "https://example.com/document"]])
        let bytes = try JSONSerialization.data(withJSONObject: browser)
        XCTAssertTrue(String(decoding: bytes, as: UTF8.self).contains("capability_missing"), "\(browser)")
        XCTAssertTrue(f.pane.toast?.contains("https://example.com/document") == true)
        let after = await f.adapter.snapshot()
        XCTAssertEqual(after.liveSurfaces[f.surface.surfaceId]?.panes, before.liveSurfaces[f.surface.surfaceId]?.panes)
    }

    func testSurfaceOpenAndExplicitCloseRetainSiblingContent() async throws {
        let f = try await fixture()
        _ = try await push(f, type: "terminal", content: ["lines": ["Retained surface"], "scrollback": 200])
        let before = await f.adapter.snapshot()
        let opened = try await request(f.socket, op: "surface.window.open", payload: ["expectedSurfaceSetRevision": before.surfaceSetRevision])
        XCTAssertEqual(opened["ok"] as? Bool, true, "\(opened)")
        let afterOpen = await f.adapter.snapshot()
        XCTAssertEqual(f.runtime.surfaces.count, 2)
        XCTAssertEqual(afterOpen.liveSurfaces[f.surface.surfaceId]?.panes, before.liveSurfaces[f.surface.surfaceId]?.panes)
        let second = try XCTUnwrap(afterOpen.liveSurfaces.values.first { $0.surfaceId != f.surface.surfaceId })
        let closed = try await request(f.socket, op: "surface.window.close", payload: ["surfaceId": second.surfaceId,
            "expectedSurfaceSetRevision": afterOpen.surfaceSetRevision, "expectedTopologyRevision": second.topologyRevision])
        XCTAssertEqual(closed["ok"] as? Bool, true, "\(closed)")
        XCTAssertEqual((closed["payload"] as? [String: Any])?["recoverable"] as? Bool, false)
        XCTAssertEqual(f.runtime.surfaces.map(\.surfaceId), [f.surface.surfaceId])
        XCTAssertEqual(f.pane.currentEntry.contentType, .terminal)
    }

    func testTerminalAppendKeepsANSIOrderAndContentIdentity() async throws {
        let f = try await fixture()
        _ = try await push(f, type: "terminal", content: ["lines": ["First"], "scrollback": 200])
        let contentID = try XCTUnwrap(f.pane.currentEntry.contentId)
        let revision = f.pane.currentEntry.revision
        let result = try await request(f.socket, op: "content.append", payload: [
            "surfaceId": f.surface.surfaceId, "paneId": f.pane.paneId,
            "contentId": contentID, "expectedRevision": revision,
            "lines": ["\u{001B}[31mSecond red\u{001B}[0m", "Third"]])
        XCTAssertEqual(result["ok"] as? Bool, true, "\(result)")
        XCTAssertEqual(f.pane.currentEntry.contentId, contentID)
        XCTAssertGreaterThan(f.pane.currentEntry.revision, revision)
        XCTAssertEqual(f.view.visibleText, "First\nSecond red\nThird")
    }

    private func annotate(_ f: Fixture, id: String) async throws {
        f.view.layoutIfNeeded()
        f.runtime.setAnnotationMode(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId,
                                    enabled: true, fingerDrawEnabled: false, source: "remote")
        await f.runtime.awaitAnnotationModeTransition(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId)
        let mark = stroke(id)
        _ = f.view.restoreDrawingStrokes(f.view.strokes + [mark])
        f.runtime.handleNewStrokes(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId,
                                   strokes: [mark], drawingData: f.view.captureDrawingData())
        await f.runtime.awaitAnnotationStrokeCapture(surfaceId: f.surface.surfaceId, paneId: f.pane.paneId)
    }
    private func stroke(_ id: String) -> SurfAceStroke {
        SurfAceStroke(strokeId: id, points: [
            .init(x: 20, y: 30, pressure: nil, timestamp: 1000),
            .init(x: 70, y: 80, pressure: nil, timestamp: 1001)], tool: "pen")
    }
    private func imageContent() -> [String: Any] {
        let data = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 80)).pngData { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 80))
        }
        return ["data": data.base64EncodedString(), "mediaType": "image/png"]
    }
    private func push(_ f: Fixture, type: String, content: [String: Any]) async throws -> [String: Any] {
        try await request(f.socket, op: "content.set", payload: ["surfaceId": f.surface.surfaceId,
            "paneId": f.pane.paneId, "contentId": UUID().uuidString, "contentType": type, "content": content])
    }
    private func request(_ socket: URLSessionWebSocketTask, op: String, payload: [String: Any]) async throws -> [String: Any] {
        let id = UUID().uuidString
        let data = try JSONSerialization.data(withJSONObject: ["id": id, "op": op, "payload": payload,
                                                                "sentAt": 1, "type": "request", "v": 1])
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
        while true {
            let message = try await withThrowingTaskGroup(of: URLSessionWebSocketTask.Message.self) { group in
                group.addTask { try await socket.receive() }
                group.addTask {
                    try await Task.sleep(for: .seconds(10))
                    socket.cancel(with: .goingAway, reason: nil)
                    throw URLError(.timedOut)
                }
                let result = try await group.next()!
                group.cancelAll()
                return result
            }
            let bytes: Data
            switch message { case .data(let data): bytes = data; case .string(let string): bytes = Data(string.utf8); @unknown default: continue }
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            if object["type"] as? String == "event" { observedEvents.append(object) }
            if object["id"] as? String == id { return object }
        }
    }
}
