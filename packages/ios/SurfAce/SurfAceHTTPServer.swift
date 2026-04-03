import CryptoKit
import Foundation
import Network

private func surfAceServerLog(_ message: String) {
    print("[SurfAce-Server] \(message)")
}

enum SurfAceHTTPServerError: LocalizedError {
    case startTimeout
    case listenerCancelled
    case invalidBindAddress
    case invalidRequestedPort(UInt16)
    case boundPortMismatch(requested: UInt16, actual: UInt16)

    var errorDescription: String? {
        switch self {
        case .startTimeout:
            return "Server listener timed out during startup"
        case .listenerCancelled:
            return "Server listener cancelled during startup"
        case .invalidBindAddress:
            return "Server failed to bind to 0.0.0.0"
        case .invalidRequestedPort(let port):
            return "Server requires a fixed port; invalid bind request for port \(port)"
        case .boundPortMismatch(let requested, let actual):
            return "Server bound to unexpected port \(actual); expected fixed port \(requested)"
        }
    }
}

enum SurfAceWebSocketError: LocalizedError {
    case protocolViolation(String)
    case connectionClosed
    case unsupportedFrame

    var errorDescription: String? {
        switch self {
        case .protocolViolation(let message):
            return message
        case .connectionClosed:
            return "WebSocket connection closed"
        case .unsupportedFrame:
            return "Unsupported WebSocket frame"
        }
    }
}

private final class SurfAceStartupState: @unchecked Sendable {
    private let lock = NSLock()
    nonisolated(unsafe) private var didResume = false

    nonisolated init() {}

    nonisolated func markResumedIfNeeded() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !didResume else { return false }
        didResume = true
        return true
    }
}

struct HTTPServerRequest {
    let method: String
    let path: String
    let query: String?
    let headers: [String: String]
    let body: Data
}

struct HTTPServerResponse {
    let statusCode: Int
    var headers: [String: String]
    let body: Data

    nonisolated init(statusCode: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.statusCode = statusCode
        self.headers = headers
        self.body = body
    }

    nonisolated static func empty(statusCode: Int) -> HTTPServerResponse {
        HTTPServerResponse(statusCode: statusCode)
    }

    nonisolated func serialized() -> Data {
        var data = Data()
        data.append("HTTP/1.1 \(statusCode) \(reasonPhrase(for: statusCode))\r\n")
        var allHeaders = headers
        if allHeaders["Content-Length"] == nil {
            allHeaders["Content-Length"] = "\(body.count)"
        }
        if allHeaders["Connection"] == nil {
            allHeaders["Connection"] = "close"
        }
        for (name, value) in allHeaders.sorted(by: { $0.key < $1.key }) {
            data.append("\(name): \(value)\r\n")
        }
        data.append("\r\n")
        data.append(body)
        return data
    }

    nonisolated private func reasonPhrase(for statusCode: Int) -> String {
        switch statusCode {
        case 101: return "Switching Protocols"
        case 200: return "OK"
        case 201: return "Created"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 422: return "Unprocessable Entity"
        case 429: return "Too Many Requests"
        case 500: return "Internal Server Error"
        default: return "Unknown"
        }
    }
}

actor SurfAceWebSocket {
    enum Message {
        case text(String)
        case close(code: UInt16?, reason: String?)
    }

    private let connection: NWConnection
    private let queue: DispatchQueue
    private var buffer = Data()
    private var closeHandlers: [@Sendable () -> Void] = []
    private var isClosed = false
    private let maxFrameBytes = 16 * 1024 * 1024

    init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
    }

    func setCloseHandler(_ handler: @escaping @Sendable () -> Void) {
        closeHandlers.append(handler)
        connection.stateUpdateHandler = { state in
            switch state {
            case .failed, .cancelled:
                Task {
                    await self.markClosedIfNeeded()
                }
            default:
                break
            }
        }
    }

    func receive() async throws -> Message? {
        while true {
            if let parsed = try parseNextFrame() {
                switch parsed.opcode {
                case 0x1:
                    guard let text = String(data: parsed.payload, encoding: .utf8) else {
                        throw SurfAceWebSocketError.protocolViolation("WebSocket text frame is not valid UTF-8")
                    }
                    return .text(text)
                case 0x8:
                    markClosedIfNeeded()
                    return .close(code: closeCode(from: parsed.payload), reason: closeReason(from: parsed.payload))
                case 0x9:
                    try await sendFrame(opcode: 0xA, payload: parsed.payload)
                    continue
                case 0xA:
                    continue
                default:
                    throw SurfAceWebSocketError.unsupportedFrame
                }
            }

            let chunk = try await receiveChunk()
            guard let chunk else {
                markClosedIfNeeded()
                return nil
            }
            buffer.append(chunk)
            if buffer.count > maxFrameBytes {
                throw SurfAceWebSocketError.protocolViolation("WebSocket frame exceeded max size")
            }
        }
    }

    func send(text: String) async throws {
        try await sendFrame(opcode: 0x1, payload: Data(text.utf8))
    }

    func close(code: UInt16 = 1000, reason: String = "") async {
        guard !isClosed else {
            connection.cancel()
            return
        }
        markClosedIfNeeded()
        var payload = Data()
        payload.appendUInt16(code)
        if !reason.isEmpty {
            payload.append(reason)
        }
        _ = try? await sendFrame(opcode: 0x8, payload: payload)
        connection.cancel()
    }

    private func sendFrame(opcode: UInt8, payload: Data) async throws {
        guard !isClosed else {
            throw SurfAceWebSocketError.connectionClosed
        }

        var frame = Data()
        frame.append(0x80 | (opcode & 0x0F))

        let payloadLength = payload.count
        if payloadLength <= 125 {
            frame.append(UInt8(payloadLength))
        } else if payloadLength <= 0xFFFF {
            frame.append(126)
            frame.appendUInt16(UInt16(payloadLength))
        } else {
            frame.append(127)
            frame.appendUInt64(UInt64(payloadLength))
        }

        frame.append(payload)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: frame, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    private func markClosedIfNeeded() {
        guard !isClosed else { return }
        isClosed = true
        let handlers = closeHandlers
        closeHandlers.removeAll()
        for handler in handlers {
            handler()
        }
    }

    private func receiveChunk() async throws -> Data? {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data?, Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                if isComplete, data == nil {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: data)
            }
        }
    }

    private func parseNextFrame() throws -> (opcode: UInt8, payload: Data)? {
        guard buffer.count >= 2 else {
            return nil
        }

        let first = buffer[0]
        let second = buffer[1]
        let fin = (first & 0x80) != 0
        let opcode = first & 0x0F
        guard fin else {
            throw SurfAceWebSocketError.protocolViolation("Fragmented frames are not supported")
        }

        let isMasked = (second & 0x80) != 0
        guard isMasked else {
            throw SurfAceWebSocketError.protocolViolation("Client frames must be masked")
        }

        var payloadLength = Int(second & 0x7F)
        var index = 2

        if payloadLength == 126 {
            guard buffer.count >= index + 2 else { return nil }
            payloadLength = Int(buffer.readUInt16(at: index))
            index += 2
        } else if payloadLength == 127 {
            guard buffer.count >= index + 8 else { return nil }
            let value = buffer.readUInt64(at: index)
            guard value <= UInt64(Int.max) else {
                throw SurfAceWebSocketError.protocolViolation("Frame length too large")
            }
            payloadLength = Int(value)
            index += 8
        }

        if payloadLength > maxFrameBytes {
            throw SurfAceWebSocketError.protocolViolation("WebSocket frame exceeded max size")
        }

        guard buffer.count >= index + 4 else { return nil }
        let mask = Data(buffer[index..<(index + 4)])
        index += 4

        guard buffer.count >= index + payloadLength else { return nil }
        var payload = Data(buffer[index..<(index + payloadLength)])

        for byteIndex in payload.indices {
            let key = mask[mask.startIndex + (byteIndex - payload.startIndex) % 4]
            payload[byteIndex] ^= key
        }

        buffer.removeSubrange(0..<(index + payloadLength))
        return (opcode: opcode, payload: payload)
    }

    private func closeCode(from payload: Data) -> UInt16? {
        guard payload.count >= 2 else { return nil }
        return payload.readUInt16(at: 0)
    }

    private func closeReason(from payload: Data) -> String? {
        guard payload.count > 2 else { return nil }
        return String(data: payload.dropFirst(2), encoding: .utf8)
    }
}

actor SurfAceHTTPServer {
    typealias HTTPHandler = @Sendable (HTTPServerRequest) async -> HTTPServerResponse
    typealias WebSocketHandler = @Sendable (SurfAceWebSocket) async -> Void
    static let fixedPort: UInt16 = 19_001
    static let fallbackPortOffsetLimit: UInt16 = 10

    private var listener: NWListener?
    private let listenerQueue = DispatchQueue(label: "co.clicketyclacks.SurfAce.HTTPServer")
    private var httpHandler: HTTPHandler?
    private var webSocketHandler: WebSocketHandler?
    private var webSocketPath: String = "/ws"

    func start(
        webSocketPath: String = "/ws",
        httpHandler: @escaping HTTPHandler,
        webSocketHandler: @escaping WebSocketHandler
    ) async throws -> UInt16 {
        try await startWithFallbackForTesting(
            preferredPort: Self.fixedPort,
            fallbackPortOffsetLimit: Self.fallbackPortOffsetLimit,
            webSocketPath: webSocketPath,
            httpHandler: httpHandler,
            webSocketHandler: webSocketHandler
        )
    }

    func startWithFallbackForTesting(
        preferredPort: UInt16,
        fallbackPortOffsetLimit: UInt16,
        webSocketPath: String = "/ws",
        httpHandler: @escaping HTTPHandler,
        webSocketHandler: @escaping WebSocketHandler
    ) async throws -> UInt16 {
        let maxOffset = Int(fallbackPortOffsetLimit)
        let candidatePorts = (0...maxOffset).compactMap { offset -> UInt16? in
            UInt16(Int(preferredPort) + offset)
        }
        var lastError: Error?

        for port in candidatePorts {
            do {
                let boundPort = try await startForTesting(
                    port: port,
                    webSocketPath: webSocketPath,
                    httpHandler: httpHandler,
                    webSocketHandler: webSocketHandler
                )
                if boundPort != preferredPort {
                    surfAceServerLog("listener fallback requestedPort=\(preferredPort) actualPort=\(boundPort)")
                }
                return boundPort
            } catch let nwError as NWError where nwError == .posix(.EADDRINUSE) {
                lastError = nwError
                continue
            } catch {
                lastError = error
                throw error
            }
        }

        throw lastError ?? SurfAceHTTPServerError.invalidRequestedPort(preferredPort)
    }

    func startForTesting(
        port: UInt16,
        webSocketPath: String = "/ws",
        httpHandler: @escaping HTTPHandler,
        webSocketHandler: @escaping WebSocketHandler
    ) async throws -> UInt16 {
        surfAceServerLog("listener start requested port=\(port) webSocketPath=\(webSocketPath)")
        guard port != 0 else {
            surfAceServerLog("listener rejected invalid ephemeral port request")
            throw SurfAceHTTPServerError.invalidRequestedPort(port)
        }
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
            surfAceServerLog("listener rejected unsupported port=\(port)")
            throw SurfAceHTTPServerError.invalidRequestedPort(port)
        }
        guard let bindAddress = IPv4Address("0.0.0.0") else {
            throw SurfAceHTTPServerError.invalidBindAddress
        }
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(bindAddress), port: endpointPort)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        self.httpHandler = httpHandler
        self.webSocketHandler = webSocketHandler
        self.webSocketPath = webSocketPath

        return try await withCheckedThrowingContinuation { continuation in
            let startupState = SurfAceStartupState()

            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    let boundPort = listener.port?.rawValue ?? 0
                    surfAceServerLog("listener ready requestedPort=\(port) actualPort=\(boundPort)")
                    guard startupState.markResumedIfNeeded() else { return }
                    listener.stateUpdateHandler = nil
                    guard boundPort == port else {
                        surfAceServerLog("listener bound unexpected port requested=\(port) actual=\(boundPort)")
                        listener.cancel()
                        continuation.resume(
                            throwing: SurfAceHTTPServerError.boundPortMismatch(requested: port, actual: boundPort)
                        )
                        return
                    }
                    continuation.resume(returning: boundPort)
                case .failed(let error):
                    surfAceServerLog("listener failed error=\(error.localizedDescription)")
                    guard startupState.markResumedIfNeeded() else { return }
                    listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                case .cancelled:
                    surfAceServerLog("listener cancelled")
                    guard startupState.markResumedIfNeeded() else { return }
                    listener.stateUpdateHandler = nil
                    continuation.resume(throwing: SurfAceHTTPServerError.listenerCancelled)
                default:
                    break
                }
            }

            listener.newConnectionHandler = { [weak self] connection in
                Task {
                    await self?.handle(connection: connection)
                }
            }

            listener.start(queue: self.listenerQueue)
            self.listenerQueue.asyncAfter(deadline: .now() + 5) {
                guard startupState.markResumedIfNeeded() else { return }
                surfAceServerLog("listener start timed out after 5s")
                listener.cancel()
                listener.stateUpdateHandler = nil
                continuation.resume(throwing: SurfAceHTTPServerError.startTimeout)
            }
        }
    }

    func stop() {
        surfAceServerLog("listener stop requested")
        listener?.cancel()
        listener = nil
        httpHandler = nil
        webSocketHandler = nil
    }

    private func handle(connection: NWConnection) async {
        surfAceServerLog("accepted connection endpoint=\(String(describing: connection.endpoint))")
        connection.start(queue: listenerQueue)
        do {
            guard let request = try await readHTTPRequest(from: connection) else {
                surfAceServerLog("connection closed before full HTTP request endpoint=\(String(describing: connection.endpoint))")
                connection.cancel()
                return
            }

            if shouldUpgradeToWebSocket(request: request) {
                surfAceServerLog("websocket upgrade request path=\(request.path) endpoint=\(String(describing: connection.endpoint))")
                guard let webSocketHandler else {
                    await send(response: HTTPServerResponse(statusCode: 500), to: connection)
                    connection.cancel()
                    return
                }
                guard let key = request.headers["sec-websocket-key"] else {
                    await send(response: HTTPServerResponse(statusCode: 400), to: connection)
                    connection.cancel()
                    return
                }

                let accept = websocketAcceptValue(for: key)
                let response = HTTPServerResponse(
                    statusCode: 101,
                    headers: [
                        "Upgrade": "websocket",
                        "Connection": "Upgrade",
                        "Sec-WebSocket-Accept": accept,
                        "Content-Length": "0"
                    ]
                )
                await send(response: response, to: connection)

                let socket = SurfAceWebSocket(connection: connection, queue: listenerQueue)
                await webSocketHandler(socket)
                await socket.close()
                return
            }

            guard let httpHandler else {
                await send(response: HTTPServerResponse(statusCode: 500), to: connection)
                connection.cancel()
                return
            }

            let response = await httpHandler(request)
            surfAceServerLog("http response status=\(response.statusCode) path=\(request.path) endpoint=\(String(describing: connection.endpoint))")
            await send(response: response, to: connection)
            connection.cancel()
        } catch {
            surfAceServerLog("connection handling failed endpoint=\(String(describing: connection.endpoint)) error=\(error.localizedDescription)")
            connection.cancel()
        }
    }

    private func shouldUpgradeToWebSocket(request: HTTPServerRequest) -> Bool {
        guard request.method == "GET", request.path == webSocketPath else {
            return false
        }

        let upgradeHeader = request.headers["upgrade"]?.lowercased()
        let connectionHeader = request.headers["connection"]?.lowercased() ?? ""
        let hasUpgradeToken = connectionHeader
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .contains("upgrade")

        return upgradeHeader == "websocket" && hasUpgradeToken
    }

    private func websocketAcceptValue(for key: String) -> String {
        let source = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let digest = Insecure.SHA1.hash(data: Data(source.utf8))
        return Data(digest).base64EncodedString()
    }

    private func readHTTPRequest(from connection: NWConnection) async throws -> HTTPServerRequest? {
        var buffer = Data()
        var parseState: (headerEnd: Int, contentLength: Int)?

        while true {
            let chunk = try await receiveChunk(from: connection)
            guard let chunk else {
                return nil
            }
            buffer.append(chunk)

            if parseState == nil, let headerEnd = headerTerminatorIndex(in: buffer) {
                let headerData = buffer.prefix(headerEnd)
                parseState = (headerEnd, contentLengthFromHeader(headerData))
            }

            guard let parseState else {
                continue
            }

            let expectedSize = parseState.headerEnd + parseState.contentLength
            guard buffer.count >= expectedSize else {
                continue
            }

            return parseRequest(from: buffer, parseState: parseState)
        }
    }

    private func receiveChunk(from connection: NWConnection) async throws -> Data? {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data?, Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                if isComplete, data == nil {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: data)
            }
        }
    }

    private func send(response: HTTPServerResponse, to connection: NWConnection) async {
        let payload = response.serialized()
        await withCheckedContinuation { continuation in
            connection.send(content: payload, completion: .contentProcessed { _ in
                continuation.resume()
            })
        }
    }

    private func headerTerminatorIndex(in data: Data) -> Int? {
        guard let range = data.range(of: Data([13, 10, 13, 10])) else {
            return nil
        }
        return range.upperBound
    }

    private func contentLengthFromHeader(_ headerData: Data) -> Int {
        guard let headerText = String(data: headerData, encoding: .utf8) else {
            return 0
        }
        for line in headerText.components(separatedBy: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2 else {
                continue
            }
            if parts[0].lowercased() == "content-length" {
                return Int(parts[1]) ?? 0
            }
        }
        return 0
    }

    private func parseRequest(from data: Data, parseState: (headerEnd: Int, contentLength: Int)) -> HTTPServerRequest? {
        let headerBytes = data.prefix(parseState.headerEnd)
        guard let headerText = String(data: headerBytes, encoding: .utf8) else {
            return nil
        }
        let lines = headerText.components(separatedBy: "\r\n").filter { !$0.isEmpty }
        guard let requestLine = lines.first else {
            return nil
        }
        let requestParts = requestLine.split(separator: " ")
        guard requestParts.count >= 2 else {
            return nil
        }

        let method = String(requestParts[0]).uppercased()
        let rawPath = String(requestParts[1])
        let pathSplit = rawPath.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = String(pathSplit[0])
        let query = pathSplit.count > 1 ? String(pathSplit[1]) : nil

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2 else {
                continue
            }
            headers[parts[0].lowercased()] = parts[1]
        }

        let bodyRange = parseState.headerEnd..<(parseState.headerEnd + parseState.contentLength)
        guard bodyRange.upperBound <= data.count else {
            return nil
        }
        let body = Data(data[bodyRange])

        return HTTPServerRequest(method: method, path: path, query: query, headers: headers, body: body)
    }
}

private extension Data {
    nonisolated mutating func append(_ string: String) {
        if let utf8 = string.data(using: .utf8) {
            append(utf8)
        }
    }

    nonisolated mutating func appendUInt16(_ value: UInt16) {
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8(value & 0xFF))
    }

    nonisolated mutating func appendUInt64(_ value: UInt64) {
        append(UInt8((value >> 56) & 0xFF))
        append(UInt8((value >> 48) & 0xFF))
        append(UInt8((value >> 40) & 0xFF))
        append(UInt8((value >> 32) & 0xFF))
        append(UInt8((value >> 24) & 0xFF))
        append(UInt8((value >> 16) & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8(value & 0xFF))
    }

    nonisolated func readUInt16(at offset: Int) -> UInt16 {
        let upper = UInt16(self[startIndex + offset]) << 8
        let lower = UInt16(self[startIndex + offset + 1])
        return upper | lower
    }

    nonisolated func readUInt64(at offset: Int) -> UInt64 {
        var result: UInt64 = 0
        for idx in 0..<8 {
            result = (result << 8) | UInt64(self[startIndex + offset + idx])
        }
        return result
    }
}
