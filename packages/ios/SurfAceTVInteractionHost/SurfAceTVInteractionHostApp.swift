import SwiftUI
import Observation
import UIKit

/// This executable belongs only to the Remote test scheme. It never starts the
/// shipping app or connects to discovery/registry services.
@main
struct SurfAceTVInteractionHostApp: App {
    @State private var fixture = RemoteInteractionFixture()

    var body: some Scene {
        WindowGroup {
            RemoteInteractionContent(fixture: fixture)
                .task { await fixture.run() }
        }
    }
}

private struct RemoteInteractionContent: View {
    let fixture: RemoteInteractionFixture

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if fixture.ready, let runtime = fixture.runtime {
                SurfAceTVRoot(runtime: runtime)
            } else {
                Text(verbatim: fixture.status)
                    .accessibilityIdentifier("remote-fixture-status")
            }
            // Passive test-only readback; never participates in Remote focus.
            Text("Interaction telemetry")
                .font(.system(size: 10))
                .accessibilityLabel(Text(verbatim: fixture.telemetry))
                .accessibilityIdentifier("remote-fixture-telemetry")
                .allowsHitTesting(false)
        }
    }
}

@MainActor
@Observable
private final class RemoteInteractionFixture {
    var runtime: SurfAceRuntime?
    var ready = false
    var status = "Preparing isolated Remote fixture"
    var telemetry = "{}"

    func run() async {
        guard runtime == nil else { return }
        let name = "SurfAceTVRemote-\(UUID().uuidString)"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        guard let defaults = UserDefaults(suiteName: name) else {
            status = "Fixture failed: cannot create isolated defaults"
            return
        }
        let runtime = SurfAceRuntime(userDefaults: defaults,
            locklessStateURL: directory.appendingPathComponent("state.json"),
            configuredRegistryURL: URL(string: "ws://127.0.0.1:1/ws")!,
            annotationClientId: name, enableFleetDiscovery: false, isolatedTestLoopback: true)
        self.runtime = runtime
        var socket: URLSessionWebSocketTask?
        do {
            await runtime.start()
            guard let surface = await runtime.registerSurfaceForScene(sceneKey: name),
                  let firstPane = surface.panes.first else { throw FixtureError.failed("No initial pane") }
            let adapter = try runtime.locklessAuthorityForLocalMutation()
            if ProcessInfo.processInfo.environment["REMOTE_FIXTURE_SCENARIO"] == "arrangement" {
                let surfaceID = surface.surfaceId
                let paneID = Int64(firstPane.paneId)
                _ = try await adapter.commitLocalMutation(operation: "test.remote.setup") { state, _ in
                    guard let revision = state.liveSurfaces[surfaceID]?.topologyRevision else {
                        throw FixtureError.failed("No authority surface")
                    }
                    _ = try SurfAceLocklessTopologyOperations.paneSplit(state: &state,
                        surfaceId: surfaceID, paneId: paneID, count: 2, direction: "horizontal",
                        expectedTopologyRevision: revision)
                    return .null
                }
            }
            let connection = URLSession.shared.webSocketTask(with:
                URL(string: "ws://127.0.0.1:\(runtime.serverPort)/ws")!)
            connection.maximumMessageSize = 12 * 1_024 * 1_024
            connection.resume()
            socket = connection
            _ = try await request(connection, op: "pair.request", payload: [
                "controllerInstanceId": name, "controllerProductName": "remote-test",
                "projectionCapacityBytes": 8 * 1_024 * 1_024,
                "protocolFeatures": [surfAceLocklessCapability], "protocolVersion": 1,
                "surfaceId": surface.surfaceId])
            let type = ProcessInfo.processInfo.environment["REMOTE_FIXTURE_CONTENT"] ?? "terminal"
            let state = await adapter.snapshot()
            guard let authoritySurface = state.liveSurfaces[surface.surfaceId] else {
                throw FixtureError.failed("No seeded authority surface")
            }
            for paneID in authoritySurface.panes.keys.sorted() {
                guard let number = Int(paneID) else { throw FixtureError.failed("Invalid pane identity") }
                _ = try await request(connection, op: "content.set", payload: [
                    "surfaceId": surface.surfaceId, "paneId": number,
                    "contentId": UUID().uuidString, "contentType": type,
                    "content": try content(type)])
            }
            surface.name = "Remote test surface"
            if ProcessInfo.processInfo.environment["REMOTE_FIXTURE_SCENARIO"] == "diagnostic" {
                _ = try await request(connection, op: "content.set", payload: [
                    "surfaceId": surface.surfaceId, "paneId": firstPane.paneId,
                    "contentId": "rejected-html", "contentType": "html",
                    "content": ["html": "<h1>Readable diagnostic</h1><p>Previous image stays accepted.</p><script>notShown()</script>"]], expectSuccess: false)
            }
            let scenario = ProcessInfo.processInfo.environment["REMOTE_FIXTURE_SCENARIO"]
            if scenario == "history" {
                _ = try await request(connection, op: "content.set", payload: [
                    "surfaceId": surface.surfaceId, "paneId": firstPane.paneId,
                    "contentId": "history-second", "contentType": "terminal",
                    "content": ["lines": (1...80).map { "Scrollable line \($0)" }, "scrollback": 200]])
            }
            if scenario == "surfaces" {
                let snapshot = await adapter.snapshot()
                _ = try await request(connection, op: "surface.window.open", payload: [
                    "expectedSurfaceSetRevision": snapshot.surfaceSetRevision])
                guard let second = runtime.surfaces.first(where: { $0.surfaceId != surface.surfaceId }),
                      let secondPane = second.panes.first else { throw FixtureError.failed("No second surface") }
                _ = try await request(connection, op: "content.set", payload: [
                    "surfaceId": second.surfaceId, "paneId": secondPane.paneId,
                    "contentId": "second-surface", "contentType": "markdown",
                    "content": ["markdown": "# Second surface"]])
            }
            ready = true
            while !Task.isCancelled {
                let current = await adapter.snapshot()
                let revision = current.liveSurfaces[surface.surfaceId]?.topologyRevision ?? -1
                let points = surface.panes.flatMap { $0.currentEntry.strokesById.values.flatMap(\.points) }
                let values: [String: Any] = [
                    "ready": true,
                    "revision": revision,
                    "surfaceNames": runtime.surfaces.map(\.name),
                    "surfaceIDs": runtime.surfaces.map(\.surfaceId),
                    "mountedSurfaces": runtime.surfaces.filter { $0.panes.contains { $0.retainedHostView?.window != nil } }.map(\.surfaceId),
                    "allContentIDs": runtime.surfaces.flatMap { $0.panes.compactMap { $0.currentEntry.contentId } },
                    "scrollY": firstPane.retainedHostView?.scroll.contentOffset.y ?? 0,
                    "layout": String(describing: surface.paneLayout),
                    "paneIDs": surface.panes.map(\.paneId),
                    "contentIDs": surface.panes.compactMap { $0.currentEntry.contentId }.sorted(),
                    "annotationMode": surface.panes.contains { $0.annotationMode },
                    "strokeCount": surface.panes.reduce(0) { $0 + $1.currentEntry.strokesById.count },
                    "pointCount": points.count,
                    "distinctPointCount": Set(points.map { "\($0.x),\($0.y)" }).count,
                    "scale": firstPane.contentScale,
                    "page": firstPane.lastPage?.page ?? 0,
                    "viewportWidth": firstPane.retainedHostView?.bounds.width ?? 0,
                    "viewportHeight": firstPane.retainedHostView?.bounds.height ?? 0,
                    "diagnostic": firstPane.htmlDiagnostic != nil,
                    "nativeStrokeCount": surface.panes.reduce(0) { $0 + ($1.retainedHostView?.strokes.count ?? 0) }
                ]
                telemetry = String(decoding: try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]), as: UTF8.self)
                try await Task.sleep(for: .milliseconds(100))
            }
        } catch is CancellationError {
            // Normal host teardown.
        } catch {
            status = "Fixture failed: \(error)"
            ready = false
            telemetry = "{}"
        }
        socket?.cancel(with: .normalClosure, reason: nil)
        await runtime.stop()
        defaults.removePersistentDomain(forName: name)
        try? FileManager.default.removeItem(at: directory)
    }

    private func content(_ type: String) throws -> [String: Any] {
        switch type {
        case "terminal": return ["lines": ["Remote annotation fixture", "Second line"], "scrollback": 200]
        case "markdown": return ["markdown": "# Remote annotation\n\n**Readable content** and `code`."]
        case "image":
            let data = UIGraphicsImageRenderer(size: CGSize(width: 160, height: 320)).pngData { context in
                UIColor.systemBlue.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 160, height: 320))
            }
            return ["data": data.base64EncodedString(), "mediaType": "image/png"]
        case "pdf":
            let data = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 300, height: 400)).pdfData { context in
                for color in [UIColor.systemBlue, UIColor.systemRed] {
                    context.beginPage()
                    color.setFill()
                    context.cgContext.fill(CGRect(x: 0, y: 0, width: 300, height: 400))
                }
            }
            return ["data": data.base64EncodedString()]
        default: throw FixtureError.failed("Unsupported fixture content")
        }
    }

    private func request(_ socket: URLSessionWebSocketTask, op: String,
                         payload: [String: Any], expectSuccess: Bool = true) async throws -> [String: Any] {
        let id = UUID().uuidString
        let data = try JSONSerialization.data(withJSONObject: ["id": id, "op": op,
            "payload": payload, "sentAt": 1, "type": "request", "v": 1])
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
            switch message {
            case .data(let data): bytes = data
            case .string(let value): bytes = Data(value.utf8)
            @unknown default: continue
            }
            guard let response = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  response["id"] as? String == id else { continue }
            guard response["ok"] as? Bool == expectSuccess else { throw FixtureError.failed("\(op): \(response)") }
            return response
        }
    }

    private enum FixtureError: Error { case failed(String) }
}
