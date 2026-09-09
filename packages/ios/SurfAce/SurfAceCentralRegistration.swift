import Foundation
import Darwin

struct SurfAceRegistrationSurface: Codable, Equatable, Sendable {
    struct Pane: Codable, Equatable, Sendable {
        let paneId: String
        let paneLabel: Int64
    }
    let surfaceId: String
    let panes: [Pane]

    static func snapshot(_ state: SurfAceLocklessAuthorityState) -> [Self] {
        state.liveSurfaces.values.sorted { $0.surfaceId < $1.surfaceId }.map { surface in
            Self(surfaceId: surface.surfaceId, panes: surface.panes.values.sorted { $0.paneId < $1.paneId }.map {
                Pane(paneId: String($0.paneId), paneLabel: $0.paneLabel)
            })
        }
    }
}

struct SurfAceRegistrationAssignment: Codable, Equatable, Sendable {
    let surfaceId: String
    let windowLabel: String
}

enum SurfAceRegistrationError: Error {
    case invalidResponse
    case noServer
    case stopped
    case topologyChanged
}

@MainActor
protocol SurfAceRegistrationTransport: AnyObject {
    func register(clientId: String, surfaces: [SurfAceRegistrationSurface]) async throws -> [SurfAceRegistrationAssignment]
    func close()
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
        struct Payload: Encodable { let clientId: String; let surfaces: [SurfAceRegistrationSurface] }
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
        }
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let timeout = Task { [socket] in
            do {
                try await Task.sleep(for: .seconds(2))
                socket.cancel(with: .goingAway, reason: nil)
            } catch { }
        }
        defer { timeout.cancel() }
        try await socket.send(.data(JSONEncoder().encode(Request(id: id, payload: Payload(clientId: clientId, surfaces: surfaces)))))
        let message = try await socket.receive()
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string(let value): data = Data(value.utf8)
        @unknown default: throw SurfAceRegistrationError.invalidResponse
        }
        let response = try JSONDecoder().decode(Response.self, from: data)
        guard response.id == id, response.op == "client.register", response.ok,
              let payload = response.payload, payload.clientId == clientId,
              payload.surfaces.count == surfaces.count,
              Set(payload.surfaces.map(\.surfaceId)) == Set(surfaces.map(\.surfaceId)) else {
            throw SurfAceRegistrationError.invalidResponse
        }
        return payload.surfaces
    }

    func close() {
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}

@MainActor
final class SurfAceCentralRegistration {
    typealias Snapshot = @MainActor () async throws -> [SurfAceRegistrationSurface]
    typealias Apply = @MainActor ([SurfAceRegistrationAssignment], [SurfAceRegistrationSurface]) async throws -> Void
    private let clientId: String
    private let configured: URL?
    private let discover: @MainActor () async -> [URL]
    private let makeTransport: @MainActor (URL) -> any SurfAceRegistrationTransport
    private let transportFallbacks: @MainActor (URL) -> [URL]
    private var resolutionFailed = false
    private let snapshot: Snapshot
    private let apply: Apply
    private let onError: @MainActor (Error) -> Void
    private var selected: (url: URL, transport: any SurfAceRegistrationTransport)?
    private var loop: Task<Void, Never>?
    private var stopped = false

    init(clientId: String, configured: URL?,
         discover: @escaping @MainActor () async -> [URL],
         makeTransport: @escaping @MainActor (URL) -> any SurfAceRegistrationTransport = { SurfAceRegistrationWebSocket(url: $0) },
         transportFallbacks: @escaping @MainActor (URL) -> [URL] = { _ in [] },
         snapshot: @escaping Snapshot, apply: @escaping Apply,
         onError: @escaping @MainActor (Error) -> Void = { _ in }) {
        self.clientId = clientId
        self.configured = configured
        self.discover = discover
        self.makeTransport = makeTransport
        self.transportFallbacks = transportFallbacks
        self.snapshot = snapshot
        self.apply = apply
        self.onError = onError
    }

    func synchronize() async throws {
        guard !stopped else { throw SurfAceRegistrationError.stopped }
        let surfaces = try await snapshot()
        // Empty startup is not a registration of an invented display identity.
        guard !surfaces.isEmpty else { return }
        if let selected {
            do {
                let assignments = try await selected.transport.register(clientId: clientId, surfaces: surfaces)
                guard !stopped else { throw SurfAceRegistrationError.stopped }
                try await apply(assignments, surfaces)
                if let configured, selected.url != configured {
                    _ = try await attempt(configured, surfaces: surfaces)
                }
                return
            } catch {
                selected.transport.close()
                self.selected = nil
                if stopped { throw SurfAceRegistrationError.stopped }
            }
        }
        if let configured, try await attempt(configured, surfaces: surfaces) { return }
        for url in await discover() {
            if try await attempt(url, surfaces: surfaces) { return }
            if resolutionFailed {
                for address in transportFallbacks(url) {
                    if try await attempt(address, surfaces: surfaces) { return }
                }
            }
        }
        throw SurfAceRegistrationError.noServer
    }

    private func attempt(_ url: URL, surfaces: [SurfAceRegistrationSurface]) async throws -> Bool {
        guard !stopped else { throw SurfAceRegistrationError.stopped }
        guard url.scheme == "ws" || url.scheme == "wss" else { return false }
        resolutionFailed = false
        let candidate = makeTransport(url)
        do {
            let assignments = try await candidate.register(clientId: clientId, surfaces: surfaces)
            guard !stopped else { throw SurfAceRegistrationError.stopped }
            try await apply(assignments, surfaces)
            selected?.transport.close()
            selected = (url, candidate)
            return true
        } catch {
            let transportError = error as? URLError
            resolutionFailed = transportError?.code == .cannotFindHost || transportError?.code == .dnsLookupFailed
            candidate.close()
            onError(error)
            if stopped { throw SurfAceRegistrationError.stopped }
            return false
        }
    }

    func start() {
        guard loop == nil, !stopped else { return }
        loop = Task { [weak self] in
            while let self, !self.stopped {
                do { try await self.synchronize() } catch { self.onError(error) }
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
    }
}

@MainActor
final class SurfAceCentralDiscovery: NSObject, @preconcurrency NetServiceBrowserDelegate, @preconcurrency NetServiceDelegate {
    private let browser = NetServiceBrowser()
    private var services: [NetService] = []
    private var urls: [String: URL] = [:]
    private var addresses: [URL: [URL]] = [:]

    func transportURLs(for url: URL) -> [URL] { addresses[url] ?? [] }

    func discover() async -> [URL] {
        addresses.removeAll()
        browser.delegate = self
        browser.searchForServices(ofType: "_surf-ace._tcp.", inDomain: "local.")
        try? await Task.sleep(for: .milliseconds(1500))
        browser.stop()
        services.forEach { $0.stop() }
        services.removeAll()
        let result = urls.sorted { $0.key < $1.key }.map(\.value)
        urls.removeAll()
        return result
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        services.append(service)
        service.delegate = self
        service.resolve(withTimeout: 1)
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        guard let data = sender.txtRecordData(), let host = sender.hostName, sender.port > 0 else { return }
        let txt = NetService.dictionary(fromTXTRecord: data)
        guard txt["role"].flatMap({ String(data: $0, encoding: .utf8) }) == "server" else { return }
        let path = txt["ws"].flatMap { String(data: $0, encoding: .utf8) } ?? "/"
        guard path.hasPrefix("/") else { return }
        var components = URLComponents()
        components.scheme = "ws"
        components.host = host
        components.port = sender.port
        components.path = path
        if let url = components.url {
            urls[sender.name] = url
            addresses[url] = (sender.addresses ?? []).compactMap { data in
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                let result = data.withUnsafeBytes { bytes -> Int32 in
                    guard let base = bytes.baseAddress, bytes.count >= MemoryLayout<sockaddr>.size else { return -1 }
                    return getnameinfo(base.assumingMemoryBound(to: sockaddr.self), socklen_t(bytes.count),
                        &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
                }
                guard result == 0 else { return nil }
                var transport = components
                transport.host = String(cString: host)
                return transport.url
            }
        }
    }
}
