import Foundation
import Darwin
import Network

struct SurfAceRegistrationSurface: Codable, Equatable, Sendable {
    struct Pane: Codable, Equatable, Sendable {
        let paneId: String
        let paneLineageId: String
        let paneLabel: Int64
    }
    let surfaceId: String
    let panes: [Pane]

    static func snapshot(_ state: SurfAceLocklessAuthorityState) -> [Self] {
        state.liveSurfaces.values.sorted { $0.surfaceId < $1.surfaceId }.map { surface in
            Self(surfaceId: surface.surfaceId, panes: surface.panes.values.sorted { $0.paneId < $1.paneId }.map {
                Pane(paneId: String($0.paneId), paneLineageId: $0.paneLineageId, paneLabel: $0.paneLabel)
            })
        }
    }
}

struct SurfAceRegistrationAssignment: Codable, Equatable, Sendable {
    let surfaceId: String
    let windowLabel: String
    let panes: [SurfAceRegistrationSurface.Pane]

    init(surfaceId: String, windowLabel: String, panes: [SurfAceRegistrationSurface.Pane] = []) {
        self.surfaceId = surfaceId
        self.windowLabel = windowLabel
        self.panes = panes
    }
}

enum SurfAceRegistrationError: Error {
    case invalidResponse
    case paneClaimRejected(code: String?, message: String?)
    case serverRejected(code: String?, message: String?)
    case noServer
    case stopped
    case topologyChanged
}

struct SurfAceCentralRegistrationFailure: Error, LocalizedError {
    let phase: String
    let endpoint: String?
    let underlying: String

    var errorDescription: String? {
        let endpointDetail = endpoint.map { " endpoint=\($0)" } ?? ""
        return "central_registration_failed phase=\(phase)\(endpointDetail): \(underlying)"
    }
}

private func surfAceRegistrationErrorDescription(_ error: Error) -> String {
    if let registrationError = error as? SurfAceRegistrationError {
        switch registrationError {
        case .invalidResponse: return "protocol_invalid_response"
        case .paneClaimRejected(let code, let message):
            return "pane_claim_rejected code=\(code ?? "missing") message=\(message ?? "missing")"
        case .serverRejected(let code, let message):
            return "server_rejected code=\(code ?? "missing") message=\(message ?? "missing")"
        case .noServer: return "no_surf_ace_server"
        case .stopped: return "registration_stopped"
        case .topologyChanged: return "registration_topology_changed"
        }
    }
    if let urlError = error as? URLError {
        return "\(urlError.code): \(urlError.localizedDescription)"
    }
    if let localized = error as? LocalizedError, let description = localized.errorDescription {
        return description
    }
    let value = error as NSError
    return "\(String(describing: error)) \(value.domain)(\(value.code)): \(error.localizedDescription)"
}

private func surfAceRegistrationEndpointLabel(_ url: URL) -> String {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        return "\(url.scheme ?? "ws")://\(url.host ?? "unknown")"
    }
    components.user = nil
    components.password = nil
    components.query = nil
    components.fragment = nil
    return components.string ?? "\(url.scheme ?? "ws")://\(url.host ?? "unknown")"
}

enum SurfAceRegistrationWire {
    struct ErrorPayload: Decodable {
        let code: String?
        let message: String?
    }

    struct PaneClaimRequest: Encodable {
        struct Payload: Encodable {
            let clientId: String
            let surfaceId: String
            let paneId: String
            let paneLineageId: String
        }
        let id: String
        let op = "pane.claim"
        let type = "request"
        let v = 1
        let sentAt = Int64(Date().timeIntervalSince1970 * 1000)
        let payload: Payload
    }

    struct PaneClaimResponse: Decodable {
        struct Payload: Decodable { let paneLabel: Int64 }
        let id: String
        let op: String
        let ok: Bool
        let payload: Payload?
        let error: ErrorPayload?
    }
    struct Payload: Codable {
        let clientId: String
        let surfaces: [SurfAceRegistrationSurface]
    }

    struct Request: Encodable {
        let id: String
        let op = "client.register"
        let type = "request"
        let v = 1
        let sentAt = Int64(Date().timeIntervalSince1970 * 1000)
        let payload: Payload
    }

    struct Response: Decodable {
        struct Payload: Decodable {
            let clientId: String
            let surfaces: [SurfAceRegistrationAssignment]
        }
        let id: String
        let op: String
        let ok: Bool
        let payload: Payload?
        let error: ErrorPayload?
    }

    static func requestData(clientId: String, surfaces: [SurfAceRegistrationSurface], id: String) throws -> Data {
        try JSONEncoder().encode(Request(id: id, payload: Payload(clientId: clientId, surfaces: surfaces)))
    }

    static func paneClaimData(clientId: String, surfaceId: String, paneId: Int64,
                              paneLineageId: String, id: String) throws -> Data {
        try JSONEncoder().encode(PaneClaimRequest(
            id: id, payload: .init(clientId: clientId, surfaceId: surfaceId,
                                  paneId: String(paneId), paneLineageId: paneLineageId)
        ))
    }

    static func paneClaimLabel(from data: Data, requestId: String) throws -> Int64 {
        let response = try JSONDecoder().decode(PaneClaimResponse.self, from: data)
        guard response.id == requestId, response.op == "pane.claim" else {
            throw SurfAceRegistrationError.invalidResponse
        }
        guard response.ok else {
            throw SurfAceRegistrationError.paneClaimRejected(
                code: response.error?.code,
                message: response.error?.message
            )
        }
        guard let label = response.payload?.paneLabel, label > 0 else {
            throw SurfAceRegistrationError.invalidResponse
        }
        return label
    }

    static func assignments(
        from data: Data,
        requestId: String,
        clientId: String,
        surfaces: [SurfAceRegistrationSurface]
    ) throws -> [SurfAceRegistrationAssignment] {
        let response = try JSONDecoder().decode(Response.self, from: data)
        guard response.id == requestId, response.op == "client.register" else {
            throw SurfAceRegistrationError.invalidResponse
        }
        guard response.ok else {
            throw SurfAceRegistrationError.serverRejected(
                code: response.error?.code,
                message: response.error?.message
            )
        }
        guard let payload = response.payload, payload.clientId == clientId,
              payload.surfaces.count == surfaces.count,
              Set(payload.surfaces.map(\.surfaceId)) == Set(surfaces.map(\.surfaceId)) else {
            throw SurfAceRegistrationError.invalidResponse
        }
        return payload.surfaces
    }
}

enum SurfAceRegistrationEndpoint {
    /// A local-use numeric endpoint selects the Network.framework WebSocket transport so ATS
    /// remains narrow. Route selection still follows the configured-first/Bonjour fallback
    /// contract; remote numeric endpoints stay on URLSession.
    static func usesLocalNumericTransport(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "ws", let host = url.host else { return false }
        return isLocalNumericAddress(host)
    }

    static func isLocalNumericAddress(_ host: String) -> Bool {
        let unscopedHost = host.split(separator: "%", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? host
        var ipv4 = in_addr()
        if unscopedHost.withCString({ inet_pton(AF_INET, $0, &ipv4) }) == 1 {
            let value = UInt32(bigEndian: ipv4.s_addr)
            let privateRange = (value & 0xff000000) == 0x0a000000
                || (value & 0xffc00000) == 0x64400000
                || (value & 0xff000000) == 0x7f000000
                || (value & 0xffff0000) == 0xa9fe0000
                || (value & 0xfff00000) == 0xac100000
                || (value & 0xffff0000) == 0xc0a80000
            return privateRange
        }

        var ipv6 = in6_addr()
        guard unscopedHost.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 else { return false }
        let bytes = withUnsafeBytes(of: ipv6) { Array($0) }
        let loopback = bytes.dropLast().allSatisfy { $0 == 0 } && bytes.last == 1
        let uniqueLocal = (bytes[0] & 0xfe) == 0xfc
        let linkLocal = bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80
        return loopback || uniqueLocal || linkLocal
    }
}

@MainActor
protocol SurfAceRegistrationTransport: AnyObject {
    func register(clientId: String, surfaces: [SurfAceRegistrationSurface]) async throws -> [SurfAceRegistrationAssignment]
    func claimPaneLabel(clientId: String, surfaceId: String, paneId: Int64, paneLineageId: String) async throws -> Int64
    func close()
}

extension SurfAceRegistrationTransport {
    func claimPaneLabel(clientId: String, surfaceId: String, paneId: Int64, paneLineageId: String) async throws -> Int64 {
        throw SurfAceRegistrationError.noServer
    }
}

@MainActor
final class SurfAceRegistrationWebSocket: SurfAceRegistrationTransport {
    private let socket: URLSessionWebSocketTask
    private let session: URLSession

    init(url: URL) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        session = URLSession(configuration: configuration)
        socket = session.webSocketTask(with: url)
        socket.resume()
    }

    func register(clientId: String, surfaces: [SurfAceRegistrationSurface]) async throws -> [SurfAceRegistrationAssignment] {
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let timeout = Task { [socket] in
            do {
                try await Task.sleep(for: .seconds(2))
                socket.cancel(with: .goingAway, reason: nil)
            } catch { }
        }
        defer { timeout.cancel() }
        try await socket.send(.data(SurfAceRegistrationWire.requestData(clientId: clientId, surfaces: surfaces, id: id)))
        let message = try await socket.receive()
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string(let value): data = Data(value.utf8)
        @unknown default: throw SurfAceRegistrationError.invalidResponse
        }
        return try SurfAceRegistrationWire.assignments(from: data, requestId: id, clientId: clientId, surfaces: surfaces)
    }

    func claimPaneLabel(clientId: String, surfaceId: String, paneId: Int64, paneLineageId: String) async throws -> Int64 {
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        try await socket.send(.data(SurfAceRegistrationWire.paneClaimData(
            clientId: clientId, surfaceId: surfaceId, paneId: paneId,
            paneLineageId: paneLineageId, id: id
        )))
        let message = try await socket.receive()
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string(let value): data = Data(value.utf8)
        @unknown default: throw SurfAceRegistrationError.invalidResponse
        }
        return try SurfAceRegistrationWire.paneClaimLabel(from: data, requestId: id)
    }

    func close() {
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}

private final class SurfAceRegistrationContinuation<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?

    init(_ continuation: CheckedContinuation<Value, Error>) {
        self.continuation = continuation
    }

    func resume(returning value: Value) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: value)
    }

    func resume(throwing error: Error) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(throwing: error)
    }
}

@MainActor
final class SurfAceLocalNumericRegistrationWebSocket: SurfAceRegistrationTransport {
    private let url: URL
    private let queue = DispatchQueue(label: "co.clicketyclacks.surface.local-registration")
    private var connection: NWConnection?
    private var ready = false

    init(url: URL) {
        self.url = url
    }

    func exchange(_ data: Data) async throws -> Data {
        let timeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { self?.close() }
        }
        defer { timeout.cancel() }
        do {
            try await connectIfNeeded()
            try await send(data)
            return try await receive()
        } catch {
            close()
            throw error
        }
    }

    func register(clientId: String, surfaces: [SurfAceRegistrationSurface]) async throws -> [SurfAceRegistrationAssignment] {
        let timeout = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(2))
                self?.connection?.cancel()
            } catch { }
        }
        defer { timeout.cancel() }

        do {
            try await connectIfNeeded()
            let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            let data = try SurfAceRegistrationWire.requestData(clientId: clientId, surfaces: surfaces, id: id)
            try await send(data)
            let response = try await receive()
            return try SurfAceRegistrationWire.assignments(from: response, requestId: id, clientId: clientId, surfaces: surfaces)
        } catch {
            close()
            throw error
        }
    }

    func claimPaneLabel(clientId: String, surfaceId: String, paneId: Int64, paneLineageId: String) async throws -> Int64 {
        do {
            try await connectIfNeeded()
            let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            try await send(SurfAceRegistrationWire.paneClaimData(
                clientId: clientId, surfaceId: surfaceId, paneId: paneId,
                paneLineageId: paneLineageId, id: id
            ))
            return try SurfAceRegistrationWire.paneClaimLabel(from: await receive(), requestId: id)
        } catch {
            close()
            throw error
        }
    }

    func close() {
        connection?.cancel()
        connection = nil
        ready = false
    }

    private func connectIfNeeded() async throws {
        if ready, connection != nil { return }
        guard SurfAceRegistrationEndpoint.usesLocalNumericTransport(url), url.port != nil else {
            throw SurfAceRegistrationError.invalidResponse
        }
        let parameters = NWParameters.tcp
        let webSocket = NWProtocolWebSocket.Options()
        webSocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(webSocket, at: 0)
        let connection = NWConnection(to: .url(url), using: parameters)
        self.connection = connection
        do {
            try await waitUntilReady(connection)
            ready = true
        } catch {
            connection.cancel()
            self.connection = nil
            throw error
        }
    }

    private func waitUntilReady(_ connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let gate = SurfAceRegistrationContinuation(continuation)
            connection.stateUpdateHandler = { [weak connection] state in
                switch state {
                case .ready:
                    connection?.stateUpdateHandler = nil
                    gate.resume(returning: ())
                case .failed, .cancelled:
                    connection?.stateUpdateHandler = nil
                    gate.resume(throwing: URLError(.cannotConnectToHost))
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }

    private func send(_ data: Data) async throws {
        guard let connection else { throw SurfAceRegistrationError.noServer }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "surf-ace-registration", metadata: [metadata])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: URLError(.cannotConnectToHost, userInfo: [NSUnderlyingErrorKey: error]))
                } else {
                    continuation.resume()
                }
            })
        }
    }

    private func receive() async throws -> Data {
        guard let connection else { throw SurfAceRegistrationError.noServer }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            connection.receiveMessage { data, _, _, error in
                if let error {
                    continuation.resume(throwing: URLError(.cannotConnectToHost, userInfo: [NSUnderlyingErrorKey: error]))
                } else if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: SurfAceRegistrationError.invalidResponse)
                }
            }
        }
    }
}

@MainActor
enum SurfAceRegistrationTransportFactory {
    static func make(url: URL) -> any SurfAceRegistrationTransport {
        if SurfAceRegistrationEndpoint.usesLocalNumericTransport(url) {
            return SurfAceLocalNumericRegistrationWebSocket(url: url)
        }
        return SurfAceRegistrationWebSocket(url: url)
    }
}

enum SurfAceCentralRegistrationStatus: Equatable {
    case disconnected
    case connecting
    case connected
}

@MainActor
final class SurfAceCentralRegistration {
    @MainActor
    private final class FailureCollector {
        var values: [String] = []
    }

    typealias Snapshot = @MainActor () async throws -> [SurfAceRegistrationSurface]
    typealias Apply = @MainActor ([SurfAceRegistrationAssignment], [SurfAceRegistrationSurface]) async throws -> Void
    private let clientId: String
    private let configured: URL?
    private let discover: @MainActor () async -> [URL]
    private let discoveryError: @MainActor () -> String?
    private let makeTransport: @MainActor (URL) -> any SurfAceRegistrationTransport
    private let transportFallbacks: @MainActor (URL) -> [URL]
    private let snapshot: Snapshot
    private let apply: Apply
    private let onError: @MainActor (Error) -> Void
    private var selected: (url: URL, transport: any SurfAceRegistrationTransport)?
    private var loop: Task<Void, Never>?
    private var stopped = false
    private let onStatusChange: @MainActor (SurfAceCentralRegistrationStatus) -> Void
    private let onConnectionError: @MainActor (String?) -> Void
    private(set) var lastError: String?
    private var lastReportedError: String?
    private(set) var status: SurfAceCentralRegistrationStatus = .disconnected

    private func setStatus(_ next: SurfAceCentralRegistrationStatus) {
        guard status != next else { return }
        status = next
        onStatusChange(next)
    }

    private func setLastError(_ message: String?) {
        guard lastError != message else { return }
        lastError = message
        onConnectionError(message)
    }

    private func reportFailure(
        phase: String,
        endpoint: URL?,
        underlying: String,
        showInStatus: Bool
    ) -> SurfAceCentralRegistrationFailure {
        let failure = SurfAceCentralRegistrationFailure(
            phase: phase,
            endpoint: endpoint.map(surfAceRegistrationEndpointLabel),
            underlying: underlying
        )
        let message = failure.errorDescription ?? underlying
        if lastReportedError != message {
            lastReportedError = message
            onError(failure)
        }
        if showInStatus { setLastError(message) }
        return failure
    }

    init(clientId: String, configured: URL?,
         discover: @escaping @MainActor () async -> [URL],
         discoveryError: @escaping @MainActor () -> String? = { nil },
         makeTransport: @escaping @MainActor (URL) -> any SurfAceRegistrationTransport = { SurfAceRegistrationTransportFactory.make(url: $0) },
         transportFallbacks: @escaping @MainActor (URL) -> [URL] = { _ in [] },
         snapshot: @escaping Snapshot, apply: @escaping Apply,
         onError: @escaping @MainActor (Error) -> Void = { _ in },
         onStatusChange: @escaping @MainActor (SurfAceCentralRegistrationStatus) -> Void = { _ in },
         onConnectionError: @escaping @MainActor (String?) -> Void = { _ in }) {
        self.clientId = clientId
        self.configured = configured
        self.discover = discover
        self.discoveryError = discoveryError
        self.makeTransport = makeTransport
        self.transportFallbacks = transportFallbacks
        self.snapshot = snapshot
        self.apply = apply
        self.onError = onError
        self.onStatusChange = onStatusChange
        self.onConnectionError = onConnectionError
    }

    func synchronize() async throws {
        guard !stopped else { throw SurfAceRegistrationError.stopped }
        if selected == nil { setStatus(.connecting) }
        defer { if status == .connecting { setStatus(.disconnected) } }
        let surfaces = try await snapshot()
        guard !stopped else { throw SurfAceRegistrationError.stopped }
        // Empty startup is not a registration of an invented display identity.
        guard !surfaces.isEmpty else { return }
        let failures = FailureCollector()
        if let selected {
            do {
                let assignments = try await selected.transport.register(clientId: clientId, surfaces: surfaces)
                guard !stopped else { throw SurfAceRegistrationError.stopped }
                try await apply(assignments, surfaces)
                guard !stopped else { throw SurfAceRegistrationError.stopped }
                setLastError(nil)
                lastReportedError = nil
                setStatus(.connected)
                if let configured, selected.url != configured {
                    _ = try await attempt(configured, surfaces: surfaces, failures: failures)
                }
                return
            } catch {
                selected.transport.close()
                self.selected = nil
                setStatus(.disconnected)
                if stopped { throw SurfAceRegistrationError.stopped }
                failures.values.append(reportFailure(
                    phase: "reconnect",
                    endpoint: selected.url,
                    underlying: surfAceRegistrationErrorDescription(error),
                    showInStatus: true
                ).errorDescription ?? "reconnect failed")
            }
        }
        if let configured, try await attempt(configured, surfaces: surfaces, failures: failures) { return }
        if selected == nil { setStatus(.connecting) }
        let discovered = await discover()
        if let reason = discoveryError() {
            failures.values.append(reportFailure(
                phase: "discovery",
                endpoint: nil,
                underlying: reason,
                showInStatus: true
            ).errorDescription ?? reason)
        } else if discovered.isEmpty {
            let reason = "Bonjour found no _surf-ace._tcp service with role=server v=1 ws=/ws"
            failures.values.append(reportFailure(
                phase: "discovery",
                endpoint: nil,
                underlying: reason,
                showInStatus: true
            ).errorDescription ?? reason)
        }
        for url in discovered {
            // NetService resolved these transport addresses for this advertised
            // service. Use them before a potentially slow dual-stack .local lookup.
            for address in transportFallbacks(url) {
                if try await attempt(address, surfaces: surfaces, failures: failures, phase: "transport_address") { return }
            }
            if try await attempt(url, surfaces: surfaces, failures: failures) { return }
        }
        let failure = SurfAceCentralRegistrationFailure(
            phase: "retry",
            endpoint: nil,
            underlying: failures.values.isEmpty
                ? "Bonjour found no _surf-ace._tcp service with role=server v=1 ws=/ws"
                : failures.values.joined(separator: "; ")
        )
        setLastError(failure.errorDescription)
        if lastReportedError != failure.errorDescription {
            lastReportedError = failure.errorDescription
            onError(failure)
        }
        throw failure
    }

    func claimPaneLabel(surfaceId: String, paneId: Int64, paneLineageId: String) async throws -> Int64 {
        guard !stopped, let selected, status == .connected else {
            throw SurfAceRegistrationError.noServer
        }
        // Use a separate socket so a periodic registration response cannot be
        // consumed by this claim while either request is suspended.
        let transport = makeTransport(selected.url)
        defer { transport.close() }
        return try await transport.claimPaneLabel(
            clientId: clientId, surfaceId: surfaceId, paneId: paneId, paneLineageId: paneLineageId
        )
    }

    private func attempt(
        _ url: URL,
        surfaces: [SurfAceRegistrationSurface],
        failures: FailureCollector,
        phase: String = "registration"
    ) async throws -> Bool {
        guard !stopped else { throw SurfAceRegistrationError.stopped }
        guard url.scheme == "ws" || url.scheme == "wss" else { return false }
        if selected == nil { setStatus(.connecting) }
        let candidate = makeTransport(url)
        do {
            let assignments = try await candidate.register(clientId: clientId, surfaces: surfaces)
            guard !stopped else { throw SurfAceRegistrationError.stopped }
            try await apply(assignments, surfaces)
            guard !stopped else { throw SurfAceRegistrationError.stopped }
            selected?.transport.close()
            selected = (url, candidate)
            setLastError(nil)
            lastReportedError = nil
            setStatus(.connected)
            return true
        } catch {
            candidate.close()
            if selected == nil { setStatus(.disconnected) }
            let failure = reportFailure(
                phase: phase,
                endpoint: url,
                underlying: surfAceRegistrationErrorDescription(error),
                showInStatus: selected == nil
            )
            failures.values.append(failure.errorDescription ?? surfAceRegistrationErrorDescription(error))
            if stopped { throw SurfAceRegistrationError.stopped }
            return false
        }
    }

    func start() {
        guard loop == nil, !stopped else { return }
        loop = Task { [weak self] in
            while let self, !self.stopped {
                do { try await self.synchronize() } catch {
                    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                    if self.lastReportedError != message {
                        self.lastReportedError = message
                        self.onError(error)
                    }
                }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
    }

    func stop() {
        stopped = true
        loop?.cancel()
        loop = nil
        selected?.transport.close()
        selected = nil
        setStatus(.disconnected)
    }
}

@MainActor
final class SurfAceCentralDiscovery: NSObject, @preconcurrency NetServiceBrowserDelegate, @preconcurrency NetServiceDelegate {
    private let makeBrowser: @MainActor () -> NetServiceBrowser
    private let sleep: @MainActor (Duration) async throws -> Void
    private let lifecycle = SurfAceCentralDiscoveryLifecycle()
    private var activeBrowser: (browser: NetServiceBrowser, generation: UInt64)?
    private var services: [ObjectIdentifier: (service: NetService, generation: UInt64)] = [:]
    private var urls: [String: URL] = [:]
    private var addresses: [URL: [URL]] = [:]
    private var runningGeneration: UInt64?
    private(set) var lastError: String?

    init(makeBrowser: @escaping @MainActor () -> NetServiceBrowser = { NetServiceBrowser() },
         sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.makeBrowser = makeBrowser
        self.sleep = sleep
        super.init()
    }

    func transportURLs(for url: URL) -> [URL] { addresses[url] ?? [] }

    func discover() async -> [URL] {
        guard runningGeneration == nil, !Task.isCancelled else { return [] }
        let generation = lifecycle.beginBrowsing()
        runningGeneration = generation
        lastError = nil
        addresses.removeAll()
        urls.removeAll()
        let browser = makeBrowser()
        activeBrowser = (browser, generation)
        browser.delegate = self
        browser.searchForServices(ofType: "_surf-ace._tcp.", inDomain: "local.")
        let browseCancelled: Bool
        do {
            try await sleep(.milliseconds(1500))
            browseCancelled = false
        } catch {
            browseCancelled = true
        }
        closeIntake(browser: browser, generation: generation)
        if browseCancelled {
            lifecycle.cancel(generation: generation)
        } else if !lifecycle.isComplete(generation: generation) {
            let timeout = Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    try await sleep(.seconds(2))
                    lifecycle.resolutionTimedOut(generation: generation)
                } catch { }
            }
            await withTaskCancellationHandler {
                await lifecycle.waitUntilComplete(generation: generation)
            } onCancel: {
                Task { @MainActor [weak self] in self?.lifecycle.cancel(generation: generation) }
            }
            timeout.cancel()
        }
        finishServices(generation: generation)
        let result = urls.sorted { $0.key < $1.key }.map(\.value)
        if result.isEmpty && lastError == nil {
            lastError = "Bonjour found no _surf-ace._tcp service with role=server v=1 ws=/ws"
        }
        urls.removeAll()
        if runningGeneration == generation { runningGeneration = nil }
        return result
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        guard let activeBrowser,
              activeBrowser.browser === browser,
              lifecycle.found(service, generation: activeBrowser.generation) else {
            service.stop()
            service.delegate = nil
            return
        }
        services[ObjectIdentifier(service)] = (service, activeBrowser.generation)
        service.delegate = self
        service.resolve(withTimeout: 1)
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        let identifier = ObjectIdentifier(sender)
        guard let owned = services[identifier],
              lifecycle.resolutionSucceeded(sender, generation: owned.generation) else { return }
        services.removeValue(forKey: identifier)
        defer {
            sender.stop()
            sender.delegate = nil
        }
        storeCandidate(from: sender)
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        let identifier = ObjectIdentifier(sender)
        guard let owned = services[identifier],
              lifecycle.resolutionFailed(sender, generation: owned.generation) else { return }
        services.removeValue(forKey: identifier)
        lastError = "Bonjour could not resolve SRV target for \(sender.name): \(diagnosticFields(errorDict))"
        // NetService can provide numeric DNS-SD addresses even when its target
        // hostname lookup fails. Registration tries those addresses first.
        storeCandidate(from: sender)
        sender.stop()
        sender.delegate = nil
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        guard let activeBrowser, activeBrowser.browser === browser else { return }
        lastError = "Bonjour browse failed: \(diagnosticFields(errorDict))"
        closeIntake(browser: browser, generation: activeBrowser.generation)
        lifecycle.cancel(generation: activeBrowser.generation)
    }

    static func localTransportURL(host: String, port: Int, path: String) -> URL? {
        SurfAceCentralDiscoveryLifecycle.localTransportURL(host: host, port: port, path: path)
    }

    private func storeCandidate(from sender: NetService) {
        guard let data = sender.txtRecordData() else {
            lastError = "Bonjour service \(sender.name) has no TXT record"
            return
        }
        let txt = NetService.dictionary(fromTXTRecord: data)
        let role = txt["role"].flatMap { String(data: $0, encoding: .utf8) }
        guard role == "server" else { return }
        let version = txt["v"].flatMap { String(data: $0, encoding: .utf8) } ?? "missing"
        let path = txt["ws"].flatMap { String(data: $0, encoding: .utf8) } ?? "missing"
        guard version == "1", path == "/ws" else {
            lastError = "Bonjour service \(sender.name) rejected: expected role=server v=1 ws=/ws, received v=\(version) ws=\(path)"
            return
        }
        guard let host = sender.hostName, sender.port > 0 else {
            lastError = "Bonjour service \(sender.name) has no resolved SRV target and port"
            return
        }
        let normalizedHost = (host.hasSuffix(".") ? String(host.dropLast()) : host).lowercased()
        guard normalizedHost != "0.0.0.0", normalizedHost != "::", normalizedHost != "0:0:0:0:0:0:0:0" else {
            lastError = "Bonjour service \(sender.name) rejected: SRV target \(host) is a wildcard address, not a client destination"
            return
        }
        guard let url = Self.localTransportURL(host: host, port: sender.port, path: path) else {
            lastError = "Bonjour service \(sender.name) has an invalid SRV target, port, or ws path"
            return
        }
        urls[sender.name] = url
        addresses[url] = numericTransportURLs(from: sender.addresses ?? [], basedOn: url)
    }

    private func numericTransportURLs(from addresses: [Data], basedOn url: URL) -> [URL] {
        addresses.compactMap { data in
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = data.withUnsafeBytes { bytes -> Int32 in
                guard let base = bytes.baseAddress, bytes.count >= MemoryLayout<sockaddr>.size else { return -1 }
                return getnameinfo(base.assumingMemoryBound(to: sockaddr.self), socklen_t(bytes.count),
                    &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            }
            guard result == 0 else { return nil }
            guard var transport = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
            transport.host = String(cString: host)
            return transport.url
        }.sorted { left, right in
            let leftIsIPv4 = left.host.map { $0.contains(":") == false } ?? false
            let rightIsIPv4 = right.host.map { $0.contains(":") == false } ?? false
            return leftIsIPv4 && !rightIsIPv4
        }
    }

    private func diagnosticFields(_ fields: [String: NSNumber]) -> String {
        fields.keys.sorted().map { "\($0)=\(fields[$0] ?? 0)" }.joined(separator: ",")
    }

    private func closeIntake(browser: NetServiceBrowser, generation: UInt64) {
        guard let activeBrowser,
              activeBrowser.browser === browser,
              activeBrowser.generation == generation else { return }
        browser.stop()
        browser.delegate = nil
        self.activeBrowser = nil
        lifecycle.endBrowsing(generation: generation)
    }

    private func finishServices(generation: UInt64) {
        let identifiers = services.compactMap { identifier, owned in
            owned.generation == generation ? identifier : nil
        }
        for identifier in identifiers {
            guard let owned = services.removeValue(forKey: identifier) else { continue }
            owned.service.stop()
            owned.service.delegate = nil
        }
    }
}
