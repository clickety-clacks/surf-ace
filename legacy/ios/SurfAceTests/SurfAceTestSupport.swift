import CoreGraphics
import Foundation
import Testing
import UIKit
@testable import Surf_Ace

enum SurfAceTestError: Error {
    case invalidHTTPResponse
    case invalidWebSocketResponse
    case invalidJSONShape
    case timeout
}

struct SurfAceHTTPResponse {
    let statusCode: Int
    let body: Data

    func jsonDictionary() throws -> [String: Any] {
        guard let dictionary = try JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            throw SurfAceTestError.invalidJSONShape
        }
        return dictionary
    }
}

final class SurfAceWSClient {
    private let session: URLSession
    private let url: URL
    private var task: URLSessionWebSocketTask?

    init(url: URL) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        session = URLSession(configuration: configuration)
        self.url = url
    }

    func connect() {
        let task = session.webSocketTask(with: url)
        task.resume()
        self.task = task
    }

    func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session.invalidateAndCancel()
    }

    func send(_ object: [String: Any]) async throws {
        guard let task else {
            throw SurfAceTestError.invalidWebSocketResponse
        }
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let text = String(data: data, encoding: .utf8) else {
            throw SurfAceTestError.invalidJSONShape
        }
        try await task.send(.string(text))
    }

    func receiveJSON(timeout: TimeInterval = 2.0) async throws -> [String: Any] {
        try await withThrowingTaskGroup(of: [String: Any].self) { group in
            group.addTask { [self] in
                try await self.receiveJSON()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw SurfAceTestError.timeout
            }

            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private func receiveJSON() async throws -> [String: Any] {
        guard let task else {
            throw SurfAceTestError.invalidWebSocketResponse
        }
        let message = try await task.receive()
        switch message {
        case .string(let text):
            guard let data = text.data(using: .utf8),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw SurfAceTestError.invalidJSONShape
            }
            return object
        case .data(let data):
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw SurfAceTestError.invalidJSONShape
            }
            return object
        @unknown default:
            throw SurfAceTestError.invalidWebSocketResponse
        }
    }
}

@MainActor
final class MockSurfAceSurfaceBridge: SurfAceSurfaceBridging {
    var renderedFrames: [SurfAceFrame?] = []
    var snapshotResponse: SurfAceSurfaceSnapshot?
    var patchResult: SurfAceHTMLPatchResult = .failed("patch handler not configured")
    var lastPatchRequest: SurfAceFramePatchRequest?
    var removedStrokeIDs: [[String]] = []
    var clearDrawingsCallCount = 0

    func render(frame: SurfAceFrame?) {
        renderedFrames.append(frame)
    }

    func fetchSnapshot(for frame: SurfAceFrame, includeImage: Bool) async -> SurfAceSurfaceSnapshot? {
        snapshotResponse
    }

    func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult {
        lastPatchRequest = patch
        return patchResult
    }

    func removeDrawingStrokeIDs(_ strokeIDs: [String]) {
        removedStrokeIDs.append(strokeIDs)
    }

    func clearDrawings() {
        clearDrawingsCallCount += 1
    }
}

@MainActor
final class SurfAceTestHarness {
    let runtime: SurfAceRuntime
    let bridge = MockSurfAceSurfaceBridge()

    private let httpSession: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        httpSession = URLSession(configuration: configuration)

        runtime = SurfAceRuntime()
        runtime.screenName = "Surf Ace Tests \(UUID().uuidString.prefix(8))"
        runtime.updateViewport(size: CGSize(width: 1024, height: 768), scale: 2)
        runtime.attachSurfaceBridge(bridge)
    }

    func start() async {
        await runtime.start()
    }

    func stop() async {
        await runtime.stop()
        httpSession.invalidateAndCancel()
    }

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(runtime.serverPort)")!
    }

    var wsURL: URL {
        URL(string: "ws://127.0.0.1:\(runtime.serverPort)/ws")!
    }

    func makeWSClient() -> SurfAceWSClient {
        SurfAceWSClient(url: wsURL)
    }

    func health() async throws -> SurfAceHTTPResponse {
        let request = URLRequest(url: URL(string: "/health", relativeTo: baseURL)!)
        let (data, response) = try await httpSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw SurfAceTestError.invalidHTTPResponse
        }
        return SurfAceHTTPResponse(statusCode: httpResponse.statusCode, body: data)
    }

    func sendRequest(
        _ client: SurfAceWSClient,
        op: String,
        id: String,
        payload: [String: Any]
    ) async throws {
        try await client.send([
            "v": 1,
            "type": "request",
            "op": op,
            "id": id,
            "payload": payload
        ])
    }

    func awaitResponse(
        _ client: SurfAceWSClient,
        id: String,
        timeout: TimeInterval = 2.0
    ) async throws -> [String: Any] {
        try await awaitMessage(client, timeout: timeout) { message in
            message["type"] as? String == "response" && message["id"] as? String == id
        }
    }

    func awaitEvent(
        _ client: SurfAceWSClient,
        op: String? = nil,
        timeout: TimeInterval = 2.0
    ) async throws -> [String: Any] {
        try await awaitMessage(client, timeout: timeout) { message in
            guard message["type"] as? String == "event" else {
                return false
            }
            if let op {
                return message["op"] as? String == op
            }
            return true
        }
    }

    func awaitMessage(
        _ client: SurfAceWSClient,
        timeout: TimeInterval = 2.0,
        predicate: @escaping ([String: Any]) -> Bool
    ) async throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let remaining = deadline.timeIntervalSinceNow
            let message = try await client.receiveJSON(timeout: max(0.1, remaining))
            if predicate(message) {
                return message
            }
        }
        throw SurfAceTestError.timeout
    }

    func pair(
        _ client: SurfAceWSClient,
        id: String = "pair_1",
        providerId: String = "pv_test_provider",
        connectionId: String = "cn_test_conn",
        takeover: Bool = false,
        eventProfile: String = "minimum_deep",
        drawingFlushConfig: [String: Any]? = nil,
        resumeSessionId: String? = nil
    ) async throws -> [String: Any] {
        var payload: [String: Any] = [
            "providerId": providerId,
            "connectionId": connectionId,
            "protocolVersion": 1,
            "takeover": takeover,
            "eventProfile": eventProfile
        ]
        if let drawingFlushConfig {
            payload["drawingFlushConfig"] = drawingFlushConfig
        }
        if let resumeSessionId {
            payload["resume"] = ["sessionId": resumeSessionId]
        }

        try await sendRequest(client, op: "pair.request", id: id, payload: payload)
        return try await client.receiveJSON()
    }
}

func waitUntil(
    timeout: TimeInterval = 2.0,
    pollEvery: TimeInterval = 0.02,
    condition: @escaping () async -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() {
            return true
        }
        try? await Task.sleep(nanoseconds: UInt64(pollEvery * 1_000_000_000))
    }
    return await condition()
}

@MainActor
func withHarness(_ body: @escaping (SurfAceTestHarness) async throws -> Void) async throws {
    let harness = SurfAceTestHarness()
    await harness.start()
    do {
        try await body(harness)
    } catch {
        await harness.stop()
        throw error
    }
    await harness.stop()
}

func makeFrameID() -> String {
    let hex = UUID().uuidString
        .replacingOccurrences(of: "-", with: "")
        .lowercased()
    return "fr_\(String(hex.prefix(8)))"
}

func makeHTMLFrame(frameID: String, html: String, baseURL: String? = nil) -> [String: Any] {
    var content: [String: Any] = ["html": html]
    if let baseURL {
        content["baseUrl"] = baseURL
    }
    return [
        "frameId": frameID,
        "contentType": "html",
        "content": content,
        "display": ["title": "HTML", "scrollable": true, "interactive": true]
    ]
}

func makeTerminalFrame(frameID: String, lines: [String], scrollback: Int = 2000) -> [String: Any] {
    [
        "frameId": frameID,
        "contentType": "terminal",
        "content": [
            "lines": lines,
            "scrollback": scrollback
        ]
    ]
}

func makeImageFrame(frameID: String, data: String, mediaType: String = "image/png", alt: String? = nil) -> [String: Any] {
    var content: [String: Any] = [
        "data": data,
        "mediaType": mediaType
    ]
    if let alt {
        content["alt"] = alt
    }
    return [
        "frameId": frameID,
        "contentType": "image",
        "content": content
    ]
}

func makePDFFrame(frameID: String, base64Data: String) -> [String: Any] {
    [
        "frameId": frameID,
        "contentType": "pdf",
        "content": ["data": base64Data]
    ]
}

func makeMarkdownFrame(frameID: String, markdown: String) -> [String: Any] {
    [
        "frameId": frameID,
        "contentType": "markdown",
        "content": ["markdown": markdown]
    ]
}

func makePDFBase64(linesByPage: [String]) -> String {
    let bounds = CGRect(x: 0, y: 0, width: 612, height: 792)
    let renderer = UIGraphicsPDFRenderer(bounds: bounds)
    let data = renderer.pdfData { context in
        for line in linesByPage {
            context.beginPage()
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byWordWrapping
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 24),
                .foregroundColor: UIColor.black,
                .paragraphStyle: paragraph
            ]
            let frame = CGRect(x: 48, y: 60, width: bounds.width - 96, height: bounds.height - 120)
            (line as NSString).draw(in: frame, withAttributes: attributes)
        }
    }
    return data.base64EncodedString()
}

func makeSampleStroke(strokeID: String = "stroke_a1b2c3", tool: String = "pencil", startTimestamp: Int64 = 1_700_000_000_000) -> SurfAceStroke {
    SurfAceStroke(
        strokeId: strokeID,
        points: [
            SurfAceStrokePoint(x: 10, y: 20, pressure: 0.7, timestamp: startTimestamp),
            SurfAceStrokePoint(x: 30, y: 40, pressure: 0.5, timestamp: startTimestamp + 10)
        ],
        tool: tool
    )
}
