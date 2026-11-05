import XCTest
import SwiftUI
import UIKit
@testable import SurfAce

/// Optional integration with an explicitly supplied, disposable loopback registry
/// and an external companion running the actual shipped CLI.
@MainActor
final class SurfAceTVShippedInteropTests: XCTestCase {
    func testShippedCLIAndRegistryPreserveNativeContentHistoryAndIdentity() async throws {
        guard let address = ProcessInfo.processInfo.environment["SURF_ACE_TEST_ALLOCATOR"],
              let registry = URL(string: address), registry.scheme == "ws",
              registry.host == "127.0.0.1", let port = registry.port,
              (1...65535).contains(port), registry.user == nil, registry.password == nil else {
            throw XCTSkip("requires an explicitly supplied isolated loopback registry")
        }
        continueAfterFailure = false
        let name = "SurfAceTVShippedInterop-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Keep the runtime's actual client identity. No test identity override,
        // discovery, fixed listener port, or production registry is used.
        let runtime = SurfAceRuntime(userDefaults: defaults,
            locklessStateURL: directory.appendingPathComponent("state.json"),
            configuredRegistryURL: registry, enableFleetDiscovery: false, isolatedTestLoopback: true)
        await runtime.start()
        addTeardownBlock {
            await runtime.stop()
            UserDefaults(suiteName: name)?.removePersistentDomain(forName: name)
            try? FileManager.default.removeItem(at: directory)
        }
        let registered = await runtime.registerSurfaceForScene(sceneKey: name)
        let surface = try XCTUnwrap(registered)
        let originalPane = try XCTUnwrap(surface.panes.first)
        let adapter = try runtime.locklessAuthorityForLocalMutation()
        let initialState = await adapter.snapshot()
        let clientID = try XCTUnwrap(initialState.annotationPublisher?.clientId)
        XCTAssertEqual(clientID.count, 64, "Use the real persisted native client identity")
        let surfaceID = surface.surfaceId

        // Mount the shipping root so panes introduced by actual CLI topology
        // mutations acquire the same native renderer bridge as the app.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1920, height: 1080))
        window.rootViewController = UIHostingController(rootView: SurfAceTVRoot(runtime: runtime))
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }

        let endpoint = "ws://127.0.0.1:\(runtime.serverPort)/ws"
        let seedSocket = URLSession.shared.webSocketTask(with: try XCTUnwrap(URL(string: endpoint)))
        seedSocket.maximumMessageSize = 12 * 1_024 * 1_024
        seedSocket.resume()
        defer { seedSocket.cancel(with: .normalClosure, reason: nil) }
        _ = try await request(seedSocket, op: "pair.request", payload: [
            "controllerInstanceId": name, "controllerProductName": "native-interop-fixture",
            "projectionCapacityBytes": 8 * 1_024 * 1_024,
            "protocolFeatures": [surfAceLocklessCapability], "protocolVersion": 1,
            "surfaceId": surfaceID])
        _ = try await request(seedSocket, op: "content.set", payload: [
            "surfaceId": surfaceID, "paneId": originalPane.paneId,
            "contentId": "retained-\(UUID().uuidString)", "contentType": "terminal",
            "content": ["lines": ["Original pane survives shipped CLI operations"], "scrollback": 200]])
        let initialRegistration = try await register(runtime: runtime, adapter: adapter,
            registry: registry, clientID: clientID, sceneKey: name, surfaceID: surfaceID)
        let originalMaterial = try XCTUnwrap(initialRegistration.panes[String(originalPane.paneId)])
        let initialRevision = initialRegistration.topologyRevision
        _ = try await mountedRenderer(for: originalPane, in: window)

        let completion = directory.appendingPathComponent("result.json")
        let refresh = completion.appendingPathExtension("register")
        let refreshed = completion.appendingPathExtension("registered")
        let ready: [String: Any] = ["endpoint": endpoint, "surfaceId": surfaceID,
            "completionPath": completion.path, "registryURL": address]
        let line = "TV_INTEROP_READY " + String(decoding:
            try JSONSerialization.data(withJSONObject: ready, options: [.sortedKeys]), as: UTF8.self) + "\n"
        FileHandle.standardOutput.write(Data(line.utf8))
        var refreshedRegistration: SurfAceLocklessSurfaceMaterial?
        let deadline = Date().addingTimeInterval(240)
        while !FileManager.default.fileExists(atPath: completion.path), Date() < deadline {
            if refreshedRegistration == nil, FileManager.default.fileExists(atPath: refresh.path) {
                let instruction = try JSONDecoder().decode(RefreshInstruction.self, from: Data(contentsOf: refresh))
                XCTAssertEqual(instruction.surfaceId, surfaceID)
                let snapshot = await adapter.snapshot()
                let material = try XCTUnwrap(snapshot.liveSurfaces[surfaceID])
                XCTAssertEqual(material.topologyRevision, initialRevision + 1)
                XCTAssertEqual(material.panes.values.map(\.paneId).sorted(), instruction.paneIds.sorted())
                refreshedRegistration = try await register(runtime: runtime, adapter: adapter,
                    registry: registry, clientID: clientID, sceneKey: name, surfaceID: surfaceID)
                try Data("{\"ok\":true}".utf8).write(to: refreshed, options: .atomic)
            }
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(50))
        }
        let bytes = try XCTUnwrap(try? Data(contentsOf: completion), "Actual shipped CLI companion did not return")
        let attachment = XCTAttachment(data: bytes, uniformTypeIdentifier: "public.json")
        attachment.name = "shipped-cli-registry-results"
        attachment.lifetime = .keepAlways
        add(attachment)
        let report = try JSONDecoder().decode(CompanionReport.self, from: bytes)
        guard report.ok else { throw FixtureError.failed(report.error ?? String(decoding: bytes, as: UTF8.self)) }
        let selectedID = try XCTUnwrap(report.selectedPaneId)
        let accepted = try XCTUnwrap(report.accepted)
        XCTAssertEqual(accepted.map(\.contentType), ["image", "terminal", "markdown", "pdf"])
        XCTAssertEqual(report.initialTopologyRevision, initialRevision)
        XCTAssertEqual(report.finalTopologyRevision, initialRevision + 1)
        let refreshedMaterial = try XCTUnwrap(refreshedRegistration)
        let after = await adapter.snapshot()
        let finalSurface = try XCTUnwrap(after.liveSurfaces[surfaceID])
        let finalPane = try XCTUnwrap(finalSurface.panes[String(selectedID)])
        XCTAssertEqual(after.annotationPublisher?.clientId, clientID)
        XCTAssertEqual(after.registryBinding?.clientId, clientID)
        XCTAssertEqual(finalSurface.topologyRevision, initialRevision + 1)
        XCTAssertEqual(finalSurface.panes.count, initialRegistration.panes.count + 1)
        XCTAssertEqual(finalSurface.panes[String(originalPane.paneId)]?.history, originalMaterial.history)
        XCTAssertEqual(finalSurface.panes[String(originalPane.paneId)]?.paneLineageId, originalMaterial.paneLineageId)
        XCTAssertEqual(finalSurface.windowLabel, initialRegistration.windowLabel)
        XCTAssertEqual(finalSurface.panes.mapValues(\.paneLabel), refreshedMaterial.panes.mapValues(\.paneLabel))
        let history = (finalPane.history.back + [finalPane.history.visible]).filter { $0.contentId != nil }
        XCTAssertEqual(history.compactMap(\.contentId), accepted.map(\.contentId))
        XCTAssertEqual(history.compactMap(\.contentType), accepted.map(\.contentType))
        XCTAssertTrue(finalPane.history.forward.isEmpty)
        XCTAssertEqual(finalPane.history.visible.contentId, accepted.last?.contentId)
        XCTAssertEqual(finalPane.history.visible.contentType, "pdf")
        XCTAssertFalse(history.contains { ["html", "canvas", "video"].contains($0.contentType ?? "") })

        let selectedPane = try XCTUnwrap(surface.panes.first { $0.paneId == selectedID })
        let diagnostic = try XCTUnwrap(selectedPane.htmlDiagnostic)
        XCTAssertEqual(diagnostic.warning, "Shown as text. Apple TV can't display web pages.")
        XCTAssertTrue(diagnostic.text.contains("Diagnostic"))
        XCTAssertFalse(diagnostic.text.contains("hidden"))
        XCTAssertEqual(selectedPane.currentEntry.contentId, accepted.last?.contentId)
        let renderer = try await mountedRenderer(for: selectedPane, in: window)
        let firstCapture = await renderer.fetchSnapshot()
        let firstImage = try image(firstCapture)
        renderer.changePage(1)
        _ = try await mountedRenderer(for: selectedPane, in: window)
        let secondCapture = await renderer.fetchSnapshot()
        let secondImage = try image(secondCapture)
        XCTAssertNotEqual(firstCapture?.imageBase64, secondCapture?.imageBase64,
                          "Actual accepted PDF has two different native rendered pages")
        for (name, image) in [("accepted-pdf-page-one", firstImage), ("accepted-pdf-page-two", secondImage)] {
            let capture = XCTAttachment(image: image)
            capture.name = name; capture.lifetime = .keepAlways; add(capture)
        }

        // A fresh real registry connection confirms the same allocation/identity.
        let reconnected = try await register(runtime: runtime, adapter: adapter,
            registry: registry, clientID: clientID, sceneKey: name, surfaceID: surfaceID)
        XCTAssertEqual(reconnected.windowLabel, finalSurface.windowLabel)
        XCTAssertEqual(reconnected.allocationGeneration, finalSurface.allocationGeneration)
        XCTAssertEqual(reconnected.panes.mapValues(\.paneLabel), finalSurface.panes.mapValues(\.paneLabel))
        XCTAssertEqual(reconnected.panes.mapValues(\.history), finalSurface.panes.mapValues(\.history))
    }

    private func register(runtime: SurfAceRuntime, adapter: SurfAceLocklessRuntimeAdapter,
                          registry: URL, clientID: String, sceneKey: String,
                          surfaceID: String) async throws -> SurfAceLocklessSurfaceMaterial {
        let transport = SurfAceRegistrationWebSocket(url: registry)
        defer { transport.close() }
        let identity = try await transport.readRegistryIdentity()
        let before = await adapter.snapshot()
        _ = try await adapter.bindRegistryIdentity(identity, clientId: clientID,
            expectedSurfaces: SurfAceRegistrationSurface.snapshot(before), allowRebinding: false)
        let input = try SurfAceRegistrationInput(state: await adapter.snapshot(), clientId: clientID)
        let reply = try await transport.register(clientId: clientID, input: input, expectedIdentity: identity)
        guard !reply.discarded, !reply.needsRetry else {
            throw FixtureError.failed("Registry reply unusable: \(reply.warnings)")
        }
        let applied = try await adapter.applyRegistration(reply, expectedInput: input,
            requestInput: input, clientId: clientID)
        guard !applied.needsRetry else { throw FixtureError.failed("Registration requires retry: \(applied.warnings)") }
        let projected = await runtime.registerSurfaceForScene(sceneKey: sceneKey)
        XCTAssertEqual(projected?.surfaceId, surfaceID)
        let snapshot = await adapter.snapshot()
        let material = try XCTUnwrap(snapshot.liveSurfaces[surfaceID])
        let assignment = try XCTUnwrap(reply.assignments.first { $0.surfaceId == surfaceID })
        XCTAssertFalse(material.windowLabel.isEmpty)
        XCTAssertEqual(material.windowLabel, assignment.windowLabel)
        XCTAssertEqual(material.windowLabelConfirmed, true)
        XCTAssertEqual(material.allocationGeneration, assignment.windowAllocationGeneration)
        XCTAssertEqual(Set(assignment.panes.map(\.paneId)), Set(material.panes.keys))
        for claim in assignment.panes {
            let pane = try XCTUnwrap(material.panes[claim.paneId])
            XCTAssertGreaterThan(claim.paneLabel, 0)
            XCTAssertEqual(pane.paneLabel, claim.paneLabel)
            XCTAssertEqual(pane.paneLineageId, claim.paneLineageId)
            XCTAssertEqual(pane.allocationGeneration, claim.allocationGeneration)
        }
        return material
    }

    private func mountedRenderer(for pane: SurfAcePaneModel, in window: UIWindow) async throws -> SurfAceTVPaneView {
        // A retained bridge may exist before SwiftUI has inserted and sized it,
        // especially for the new leaf from the companion's topology mutation.
        // Let the real hosting hierarchy finish; never assign renderer bounds
        // or move it to an artificial container to make capture succeed.
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            window.setNeedsLayout()
            window.rootViewController?.view.setNeedsLayout()
            window.layoutIfNeeded()
            window.rootViewController?.view.layoutIfNeeded()
            if let renderer = pane.retainedHostView,
               let host = window.rootViewController?.view,
               renderer.window === window, renderer.isDescendant(of: host),
               renderer.bounds.width.isFinite, renderer.bounds.height.isFinite,
               renderer.bounds.width > 0, renderer.bounds.height > 0 {
                renderer.layoutIfNeeded()
                return renderer
            }
            // Yield MainActor so pending SwiftUI view insertion/layout executes.
            try await Task.sleep(for: .milliseconds(50))
        }
        var details = ["pane=\(pane.paneId) content=\(pane.currentEntry.contentId ?? "nil")",
                       "window=\(window.bounds) hidden=\(window.isHidden)",
                       "host=\(String(describing: window.rootViewController?.view.bounds))"]
        var ancestor: UIView? = pane.retainedHostView
        while let view = ancestor {
            details.append("\(type(of: view)) frame=\(view.frame) bounds=\(view.bounds) hidden=\(view.isHidden) inOwnedWindow=\(view.window === window)")
            ancestor = view.superview
        }
        let diagnostic = XCTAttachment(string: details.joined(separator: "\n"))
        diagnostic.name = "pane-\(pane.paneId)-mount-timeout"
        diagnostic.lifetime = .keepAlways
        add(diagnostic)
        throw FixtureError.failed("Pane \(pane.paneId) did not mount with positive width and height within five seconds")
    }

    private func image(_ snapshot: SurfAceSurfaceSnapshot?) throws -> UIImage {
        let encoded = try XCTUnwrap(snapshot?.imageBase64)
        return try XCTUnwrap(UIImage(data: try XCTUnwrap(Data(base64Encoded: encoded))))
    }

    private func request(_ socket: URLSessionWebSocketTask, op: String,
                         payload: [String: Any]) async throws -> [String: Any] {
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
            case .string(let string): bytes = Data(string.utf8)
            @unknown default: continue
            }
            guard let response = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  response["id"] as? String == id else { continue }
            guard response["ok"] as? Bool == true else { throw FixtureError.failed("\(op): \(response)") }
            return response
        }
    }

    private struct RefreshInstruction: Decodable { let surfaceId: String; let paneIds: [Int64] }
    private struct AcceptedContent: Decodable { let contentId: String; let contentType: String }
    private struct CompanionReport: Decodable {
        let ok: Bool
        let error: String?
        let selectedPaneId: Int?
        let initialTopologyRevision: Int64?
        let finalTopologyRevision: Int64?
        let accepted: [AcceptedContent]?
    }
    private enum FixtureError: Error { case failed(String) }
}
