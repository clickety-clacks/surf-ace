import Foundation

private enum SurfAceAnnotationWireError: Error {
    case invalidResponse
    case rejected(String)
}

private enum SurfAceAnnotationWire {
    static func request(op: String, canonicalRecord: String? = nil) -> (id: String, data: Data) {
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let payload = canonicalRecord.map { "{\"record\":\($0)}" }
            ?? "{\"protocolVersion\":1,\"role\":\"publisher\"}"
        let sentAt = Int64(Date().timeIntervalSince1970 * 1_000)
        return (id, Data("{\"v\":1,\"type\":\"request\",\"op\":\"\(op)\",\"id\":\"\(id)\",\"sentAt\":\(sentAt),\"payload\":\(payload)}".utf8))
    }

    static func response(_ data: Data, id: String, op: String) throws -> SurfAceAnnotationServerCursor? {
        guard let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              value["v"] as? Int == 1, value["type"] as? String == "response",
              value["id"] as? String == id, value["op"] as? String == op else {
            throw SurfAceAnnotationWireError.invalidResponse
        }
        guard value["ok"] as? Bool == true else {
            let error = value["error"] as? [String: Any]
            throw SurfAceAnnotationWireError.rejected(error?["code"] as? String ?? "unknown")
        }
        if op == "annotation.hello" { return nil }
        guard let accepted = value["payload"] as? [String: Any],
              accepted["duplicate"] is Bool,
              let committedAt = accepted["committedAt"] as? String, !committedAt.isEmpty,
              let serverCursor = accepted["serverCursor"] as? [String: Any],
              let epoch = serverCursor["epoch"] as? String, epoch.count == 32,
              epoch.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              let sequence = serverCursor["sequence"] as? String,
              Int64(sequence).map({ $0 > 0 }) == true else {
            throw SurfAceAnnotationWireError.invalidResponse
        }
        return SurfAceAnnotationServerCursor(epoch: epoch, sequence: sequence)
    }
}

@MainActor
protocol SurfAceAnnotationWireTransport: AnyObject {
    func exchange(_ data: Data) async throws -> Data
    func close()
}

@MainActor
private final class SurfAceAnnotationURLSessionTransport: SurfAceAnnotationWireTransport {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask

    init(url: URL) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        session = URLSession(configuration: configuration)
        socket = session.webSocketTask(with: url)
        socket.resume()
    }

    func exchange(_ data: Data) async throws -> Data {
        let timeout = Task { [socket] in
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { socket.cancel(with: .goingAway, reason: nil) }
        }
        defer { timeout.cancel() }
        try await socket.send(.data(data))
        switch try await socket.receive() {
        case .data(let value): return value
        case .string(let value): return Data(value.utf8)
        @unknown default: throw SurfAceAnnotationWireError.invalidResponse
        }
    }

    func close() {
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}

extension SurfAceLocalNumericRegistrationWebSocket: SurfAceAnnotationWireTransport {}

/// Drains committed authority-state records to a configured or verified selected registry.
@MainActor
final class SurfAceAnnotationPublisher {
    private let adapter: SurfAceLocklessRuntimeAdapter
    private var endpoint: URL
    private var endpointGeneration: UInt64 = 0
    private let makeTransport: @MainActor (URL) -> any SurfAceAnnotationWireTransport
    private let onError: @MainActor (Error) -> Void
    private let headAcquisitionCompletionForTesting: (@MainActor () async -> Void)?
    private let onDiagnostic: @MainActor ([String: String]) -> Void
    private var transport: (any SurfAceAnnotationWireTransport)?
    private var helloDone = false
    private var active: Task<Void, Never>?
    private var retry: Task<Void, Never>?
    private var wanted = false
    private var stopped = false
    private var lastSurfaceId: String?
    private var lastCorrelation: [String: String] = [:]

    init(adapter: SurfAceLocklessRuntimeAdapter, endpoint: URL,
         makeTransport: (@MainActor (URL) -> any SurfAceAnnotationWireTransport)? = nil,
         headAcquisitionCompletionForTesting: (@MainActor () async -> Void)? = nil,
         onDiagnostic: @escaping @MainActor ([String: String]) -> Void = { _ in },
         onError: @escaping @MainActor (Error) -> Void) throws {
        guard ["ws", "wss"].contains(endpoint.scheme?.lowercased() ?? ""), endpoint.host != nil else {
            throw SurfAceAnnotationWireError.invalidResponse
        }
        self.adapter = adapter
        self.endpoint = endpoint
        self.makeTransport = makeTransport ?? { url in
            if SurfAceRegistrationEndpoint.usesLocalNumericTransport(url) {
                return SurfAceLocalNumericRegistrationWebSocket(url: url)
            }
            return SurfAceAnnotationURLSessionTransport(url: url)
        }
        self.onError = onError
        self.onDiagnostic = onDiagnostic
        self.headAcquisitionCompletionForTesting = headAcquisitionCompletionForTesting
    }

    func reconcileEndpoint(_ endpoint: URL) throws {
        guard ["ws", "wss"].contains(endpoint.scheme?.lowercased() ?? ""), endpoint.host != nil else {
            throw SurfAceAnnotationWireError.invalidResponse
        }
        if self.endpoint != endpoint {
            self.endpoint = endpoint
            endpointGeneration &+= 1
            // Keep the same serialized drain and durable FIFO. Closing an old
            // exchange may retry its stable record identity on the selected route.
            disconnect()
        }
        emit("route_selected")
        notify()
    }

    func notify() {
        guard !stopped else { return }
        wanted = true
        guard active == nil, retry == nil else { return }
        active = Task { [weak self] in
            guard let self else { return }
            do { try await self.drain() }
            catch {
                self.disconnect()
                self.emit("retry_scheduled", errorCode: Self.safeErrorCode(error))
                self.onError(error)
                self.scheduleRetry()
            }
            self.active = nil
            if self.wanted && self.retry == nil { self.notify() }
        }
    }

    func awaitIdle() async { await active?.value }

    func stop() {
        stopped = true
        retry?.cancel()
        retry = nil
        active?.cancel()
        disconnect()
    }

    private func disconnect() {
        transport?.close()
        transport = nil
        helloDone = false
    }

    private func scheduleRetry() {
        guard !stopped, retry == nil else { return }
        retry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self else { return }
            self.retry = nil
            self.notify()
        }
    }

    static func safeEndpoint(_ endpoint: URL) -> String {
        // Never include userinfo, path, query or fragment (all may contain secrets).
        let host = endpoint.host ?? "unknown"
        return "\(endpoint.scheme ?? "unknown")://\(host)" + (endpoint.port.map { ":\($0)" } ?? "")
    }

    static func safeErrorCode(_ error: Error) -> String {
        if let error = error as? URLError { return "url_\(error.code.rawValue)" }
        if let wire = error as? SurfAceAnnotationWireError,
           case .rejected(let code) = wire,
           code.count <= 96, code.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }) {
            return code
        }
        return "publisher_error"
    }

    private func emit(_ stage: String, surfaceId: String? = nil,
                      outbox: SurfAceAnnotationOutbox? = nil,
                      head: SurfAceAnnotationOutboxEntry? = nil, errorCode: String? = nil) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var fields = ["stage": stage, "at": formatter.string(from: Date()),
                      "endpoint": Self.safeEndpoint(endpoint),
                      "connection": helloDone ? "ready" : "connecting",
                      "retry": stage == "retry_scheduled" ? "scheduled" : "none"]
        fields["surface_id"] = surfaceId
        fields["client_id"] = outbox?.clientId
        fields["source_epoch"] = outbox?.sourceEpoch
        fields["source_event_id"] = head?.sourceEventId
        fields["source_sequence"] = head?.sourceSequence
        fields["error_code"] = errorCode
        if let surfaceId, let surface = outbox?.surfaces[surfaceId] {
            fields["outbox_depth"] = String(surface.fifo.count + (surface.trailingGap == nil ? 0 : 1))
        }
        if head != nil {
            lastCorrelation = fields.filter { ["client_id", "source_epoch", "source_event_id", "source_sequence", "surface_id"].contains($0.key) }
        } else if stage == "retry_scheduled" {
            fields.merge(lastCorrelation) { current, _ in current }
        }
        onDiagnostic(fields)
    }

    private func exchange(_ op: String, canonicalRecord: String? = nil) async throws -> SurfAceAnnotationServerCursor? {
        if transport == nil { transport = makeTransport(endpoint) }
        guard let transport else { throw SurfAceAnnotationWireError.invalidResponse }
        let request = SurfAceAnnotationWire.request(op: op, canonicalRecord: canonicalRecord)
        let generation = endpointGeneration
        let response = try await transport.exchange(request.data)
        // A suspended old hello/ingest response must not establish readiness
        // for a newly selected transport. Retry the same durable head instead.
        guard generation == endpointGeneration else { throw URLError(.cancelled) }
        return try SurfAceAnnotationWire.response(response, id: request.id, op: op)
    }

    func drain() async throws {
        while !stopped && !Task.isCancelled {
            wanted = false
            let snapshot = await adapter.snapshot()
            let candidates = snapshot.annotationPublisher?.publishableSurfaceIds() ?? []
            guard let surfaceId = candidates.first(where: { lastSurfaceId == nil || $0 > lastSurfaceId! })
                ?? candidates.first else { return }
            lastSurfaceId = surfaceId
            if !helloDone {
                do {
                    _ = try await exchange("annotation.hello")
                    helloDone = true
                    emit("connected", surfaceId: surfaceId, outbox: snapshot.annotationPublisher)
                } catch SurfAceAnnotationWireError.rejected(let code) {
                    if code == "writer_fence_unavailable" { throw SurfAceAnnotationWireError.rejected(code) }
                    try await markUnhealthy(surfaceId: surfaceId, code: code)
                    continue
                } catch SurfAceAnnotationWireError.invalidResponse {
                    try await markUnhealthy(surfaceId: surfaceId, code: "annotation_protocol_invalid")
                    continue
                }
            }
            // head() may seal a trailing gap. The authority transaction finishes before the send.
            let readyGeneration = endpointGeneration
            guard let head = try await adapter.transactAnnotationPublisher(surfaceId: surfaceId, {
                try $0.head(surfaceId: surfaceId)
            }) else { continue }
            await headAcquisitionCompletionForTesting?()
            // Authority persistence yields after hello. A replacement route
            // must establish its own socket role before sending this same head.
            guard !stopped, !Task.isCancelled else { return }
            guard helloDone, readyGeneration == endpointGeneration else { continue }
            let op = head.kind == "gap" ? "annotation.source_gap" : "annotation.ingest"
            emit("sent", surfaceId: surfaceId, outbox: snapshot.annotationPublisher, head: head)
            let cursor: SurfAceAnnotationServerCursor
            do {
                guard let accepted = try await exchange(op, canonicalRecord: head.canonical) else {
                    throw SurfAceAnnotationWireError.invalidResponse
                }
                cursor = accepted
                emit("registry_accepted", surfaceId: surfaceId, outbox: snapshot.annotationPublisher, head: head)
            } catch SurfAceAnnotationWireError.rejected(let code)
                where head.kind == "payload" &&
                    (code == "annotation_record_too_large" || code == "annotation_context_image_invalid") {
                try await adapter.transactAnnotationPublisher(surfaceId: surfaceId) {
                    try $0.rejectHead(surfaceId: surfaceId, code: code)
                }
                continue
            } catch SurfAceAnnotationWireError.rejected(let code) {
                if head.kind != "gap" &&
                    (code == "annotation_ingest_capacity" || code == "writer_fence_unavailable") {
                    throw SurfAceAnnotationWireError.rejected(code)
                }
                try await markUnhealthy(surfaceId: surfaceId, code: code)
                continue
            } catch SurfAceAnnotationWireError.invalidResponse {
                try await markUnhealthy(surfaceId: surfaceId, code: "annotation_ingest_invalid_response")
                continue
            }
            do {
                try await adapter.transactAnnotationPublisher(surfaceId: surfaceId) {
                    try $0.accept(surfaceId: surfaceId, head: head, cursor: cursor)
                }
                emit("acceptance_persisted", surfaceId: surfaceId, outbox: (await adapter.snapshot()).annotationPublisher, head: head)
            } catch SurfAceAnnotationOutboxError.staleAcceptance {
                try await markUnhealthy(surfaceId: surfaceId, code: "annotation_ingest_cursor_conflict")
            }
        }
    }

    private func markUnhealthy(surfaceId: String, code: String) async throws {
        try await adapter.transactAnnotationPublisher(surfaceId: surfaceId) {
            try $0.markUnhealthy(surfaceId: surfaceId, code: code)
        }
        onError(SurfAceAnnotationWireError.rejected(code))
    }
}
